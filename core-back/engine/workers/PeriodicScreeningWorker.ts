import type { BeneficialOwnerRow, MerchantRow, Tx } from "../db/ports";
import {
  MerchantScreeningService,
  merchantScreeningSubjects,
  type MerchantScreeningReport,
} from "../guards/MerchantScreeningService";
import type { ScreeningProvider } from "../guards/ScreeningProvider";
import { toCamelRows } from "../db/rawRows";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

export interface PeriodicScreeningWorkerDeps extends WorkerOptions {
  screening: ScreeningProvider;
  /**
   * How long a merchant stays screened before it is screened again. It is
   * the re-screening interval of the ongoing screening layer (L2).
   */
  rescreenIntervalMs?: number;
  /**
   * How many merchants are screened in one tick. It bounds the batch so that
   * a large merchant book cannot monopolise the worker.
   */
  screenBatchSize?: number;
}

/**
 * The merchants that are due for a re-screening.
 *
 * A merchant is due when it is active and when its last merchant screening
 * is older than the re-screening interval. The rows are locked with
 * `FOR UPDATE SKIP LOCKED`, so several worker nodes spread the work over the
 * merchant book instead of screening the same merchant twice.
 *
 * The placeholders are bound in the order they appear in the statement: the
 * epoch of the `COALESCE` fallback, then the cut-off, then the batch size.
 */
export const DUE_MERCHANTS_SQL =
  "SELECT m.* FROM merchants m" +
  " WHERE m.status = 'ACTIVE'" +
  " AND COALESCE(" +
  " (SELECT MAX(s.requested_at) FROM aml_screenings s" +
  "  WHERE s.subject_type = 'MERCHANT' AND s.subject_id = m.id)," +
  " ?" +
  " ) <= ?" +
  " ORDER BY m.id" +
  " LIMIT ?" +
  " FOR UPDATE SKIP LOCKED";

const OPEN_CASE_STATUSES = ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "FROZEN", "ESCALATED_STR"];

const DEFAULT_RESCREEN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class PeriodicScreeningWorker extends BaseWorker {
  private readonly screening: ScreeningProvider;
  private readonly rescreenIntervalMs: number;
  private readonly screenBatchSize: number;

  constructor(deps: PeriodicScreeningWorkerDeps) {
    super(deps);
    this.screening = deps.screening;
    this.rescreenIntervalMs = deps.rescreenIntervalMs ?? DEFAULT_RESCREEN_INTERVAL_MS;
    this.screenBatchSize = deps.screenBatchSize ?? deps.batchSize ?? 50;
  }

  protected async tick(): Promise<void> {
    await this.refreshWatchList();
    const now = this.clock();
    const cutoff = new Date(now.getTime() - this.rescreenIntervalMs);
    const due = await this.lockDueMerchants(cutoff);
    if (due.length === 0) {
      return;
    }
    for (const merchant of due) {
      try {
        await this.rescreenMerchant(merchant, cutoff, now);
      } catch (error) {
        this.logger.error("PeriodicScreeningWorker: unable to screen the merchant", {
          merchantId: merchant.id,
          error: (error as Error).message,
        });
      }
    }
  }

  /**
   * A published watch list invalidates the cached screening results. The
   * worker refreshes the list versions before it screens, so a list update is
   * picked up by the very next tick.
   */
  private async refreshWatchList(): Promise<void> {
    if (!this.screening.refreshListVersions) {
      return;
    }
    try {
      const invalidated = await this.screening.refreshListVersions();
      if (invalidated) {
        this.logger.info("PeriodicScreeningWorker: the watch list changed, the cached results were dropped");
      }
    } catch (error) {
      this.logger.warn("PeriodicScreeningWorker: unable to refresh the watch list versions", {
        error: (error as Error).message,
      });
    }
  }

  private async lockDueMerchants(cutoff: Date): Promise<MerchantRow[]> {
    const result = await this.db.$queryRawUnsafe(
      DUE_MERCHANTS_SQL,
      new Date(0),
      cutoff,
      this.screenBatchSize,
    );
    return toCamelRows<MerchantRow>(result);
  }

  private async rescreenMerchant(merchant: MerchantRow, cutoff: Date, now: Date): Promise<void> {
    await this.db.$transaction(async (tx: Tx) => {
      const locked = await this.repositories.merchants.lockMerchantById(tx, merchant.id);
      if (!locked) {
        return;
      }
      // The due condition is re-checked under the row lock: another node may
      // have screened the merchant between the batch selection and now.
      const latest = await this.repositories.risk.listScreenings(tx, {
        subjectId: locked.id,
        limit: 1,
        offset: 0,
      });
      const lastRequestedAt = latest[0]?.requestedAt;
      if (lastRequestedAt && lastRequestedAt.getTime() > cutoff.getTime()) {
        return;
      }

      const owners = await this.repositories.onboarding.listBeneficialOwners(tx, locked.id);
      const report = await this.screenMerchant(tx, locked, owners, now);
      if (report.result !== "CONFIRMED_MATCH") {
        return;
      }
      await this.handleConfirmedMatch(tx, locked, owners, report, now);
    });
  }

  private async screenMerchant(
    tx: Tx,
    merchant: MerchantRow,
    owners: readonly BeneficialOwnerRow[],
    now: Date,
  ): Promise<MerchantScreeningReport> {
    const service = new MerchantScreeningService({
      repositories: this.repositories,
      screening: this.screening,
      clock: () => now,
    });
    const report = await service.screenMerchant(tx, {
      merchantId: merchant.id,
      trigger: "PERIODIC",
      subjects: merchantScreeningSubjects(merchant, owners),
    });
    await service.applyOwnerScreeningStatuses(tx, owners, report);
    return report;
  }

  /**
   * A merchant that became a confirmed match after its onboarding is stopped
   * and reported: the case is raised once, the merchant is suspended and the
   * decision is written to the audit log.
   */
  private async handleConfirmedMatch(
    tx: Tx,
    merchant: MerchantRow,
    owners: readonly BeneficialOwnerRow[],
    report: MerchantScreeningReport,
    now: Date,
  ): Promise<void> {
    const existing = await this.repositories.risk.listAmlCases(tx, {
      subjectId: merchant.id,
      limit: 50,
      offset: 0,
    });
    const alreadyRaised = existing.some(
      (amlCase) =>
        OPEN_CASE_STATUSES.includes(amlCase.status) &&
        amlCase.triggerReason.startsWith("SCREENING_CONFIRMED_MATCH"),
    );

    if (!alreadyRaised) {
      const service = new MerchantScreeningService({
        repositories: this.repositories,
        screening: this.screening,
        clock: () => now,
      });
      const amlCase = await service.raiseConfirmedMatchCase(tx, report, {
        now,
        triggerReasonPrefix: "SCREENING_CONFIRMED_MATCH",
      });
      if (amlCase) {
        await this.repositories.governance.writeAuditLog(tx, {
          actorId: null,
          role: "SYSTEM",
          action: "AML_CASE_OPENED",
          entityType: "AML_CASE",
          entityId: amlCase.id,
          afterJson: {
            merchantId: merchant.id,
            trigger_reason: amlCase.triggerReason,
            severity: amlCase.severity,
            source: "PERIODIC_SCREENING",
          },
        });
      }
    }

    if (merchant.status === "ACTIVE") {
      await this.repositories.merchants.updateMerchant(tx, merchant.id, {
        status: "SUSPENDED",
        suspendedAt: now,
        suspensionReasonCode: "AML_CONFIRMED_MATCH",
      });
      await this.repositories.governance.writeAuditLog(tx, {
        actorId: null,
        role: "SYSTEM",
        action: "MERCHANT_SUSPENDED",
        entityType: "MERCHANT",
        entityId: merchant.id,
        afterJson: {
          reason_code: "AML_CONFIRMED_MATCH",
          source: "PERIODIC_SCREENING",
          owners: owners.map((owner) => owner.id),
        },
      });
    }
  }
}
