import type { BeneficialOwnerRow, MerchantRow, Tx } from "../db/ports";
import {
  MerchantScreeningService,
  merchantScreeningSubjects,
  type MerchantScreeningReport,
} from "../guards/MerchantScreeningService";
import { listVersionsFingerprint, type ScreeningProvider } from "../guards/ScreeningProvider";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { SqlWorkerCursorStore, type WorkerCursorStore } from "./workerCursorStore";
import { BaseWorker, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";

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
  /** Where the list fingerprint and the list-update sweep cursor are persisted (default: `worker_cursors`). */
  cursors?: WorkerCursorStore;
}

/** `worker_cursors` keys of the event-driven re-screening (AUTO-24). */
export const AML_LIST_FINGERPRINT_KEY = "aml.list_fingerprint";
export const AML_LIST_SWEEP_KEY = "aml.list_sweep";

interface ListSweepState {
  /** The list fingerprint that started the sweep. */
  fingerprint: string;
  /** Last merchant id screened (merchants are walked in id order). */
  afterId: string | null;
  screened: number;
  startedAt: string;
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
  "  WHERE s.subject_type = 'MERCHANT' AND s.subject_id = m.id::text)," +
  " $1" +
  " ) <= $2" +
  " ORDER BY m.id" +
  " LIMIT $3" +
  " FOR UPDATE SKIP LOCKED";

const OPEN_CASE_STATUSES = ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "FROZEN", "ESCALATED_STR"];

const DEFAULT_RESCREEN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class PeriodicScreeningWorker extends BaseWorker {
  /** Cluster singleton: only the advisory-lock leader ticks (GAP-012). */
  protected override get singleton(): boolean {
    return true;
  }

  private readonly screening: ScreeningProvider;
  private readonly rescreenIntervalMs: number;
  private readonly screenBatchSize: number;
  private readonly cursors: WorkerCursorStore;

  constructor(deps: PeriodicScreeningWorkerDeps) {
    super(deps);
    this.screening = deps.screening;
    this.rescreenIntervalMs = deps.rescreenIntervalMs ?? DEFAULT_RESCREEN_INTERVAL_MS;
    this.screenBatchSize = deps.screenBatchSize ?? deps.batchSize ?? 50;
    this.cursors = deps.cursors ?? new SqlWorkerCursorStore(deps.db, this.logger);
  }

  protected async tick(): Promise<WorkerTickResult> {
    await this.refreshWatchList();
    const now = this.clock();
    // Event-driven re-screening (AUTO-24): a new watch list version re-screens EVERY active merchant now (not within a
    // day), and an owner added after onboarding is screened as soon as it is seen.
    let processed = await this.listUpdateSweep(now);
    processed += await this.screenNewOwners(now);
    const cutoff = new Date(now.getTime() - this.rescreenIntervalMs);
    const due = await this.lockDueMerchants(cutoff);
    for (const merchant of due) {
      try {
        await this.rescreenMerchant(merchant, now, { trigger: "PERIODIC", cutoff });
        processed += 1;
      } catch (error) {
        this.logger.error("PeriodicScreeningWorker: unable to screen the merchant", {
          merchantId: merchant.id,
          error: (error as Error).message,
        });
      }
    }
    return { processed };
  }

  // ---- AUTO-24: event-driven re-screening -----------------------------------------------------------------------

  /**
   * The list-update trigger. The fingerprint of the published list versions is persisted; when it differs from the one
   * seen last (including across a restart or a leader change) a sweep starts that walks the ACTIVE merchants in id
   * order, `screenBatchSize` per tick, with the trigger `LIST_UPDATE`, and its cursor is persisted so the sweep resumes
   * where it stopped. A further list change while a sweep runs restarts it. The first fingerprint ever seen only seeds
   * the baseline (a new database is not swept).
   */
  private async listUpdateSweep(now: Date): Promise<number> {
    let fingerprint: string;
    try {
      fingerprint = listVersionsFingerprint(await this.screening.listVersions());
    } catch (error) {
      this.logger.warn("PeriodicScreeningWorker: cannot read the list versions", { error: (error as Error).message });
      return 0;
    }
    const known = await this.cursors.read(AML_LIST_FINGERPRINT_KEY);
    let state = this.parseSweep(await this.cursors.read(AML_LIST_SWEEP_KEY));
    if (known === null) {
      await this.cursors.write(AML_LIST_FINGERPRINT_KEY, fingerprint);
    } else if (known !== fingerprint) {
      await this.cursors.write(AML_LIST_FINGERPRINT_KEY, fingerprint);
      state = { fingerprint, afterId: null, screened: 0, startedAt: now.toISOString() };
      await this.cursors.write(AML_LIST_SWEEP_KEY, JSON.stringify(state));
      await this.auditSweep("AML_LIST_UPDATE_SWEEP_STARTED", { fingerprint });
      this.logger.info("PeriodicScreeningWorker: the watch list changed, every active merchant is re-screened", { fingerprint });
    }
    if (!state) return 0;

    const rows = toCamelRows<MerchantRow>(
      await this.db.$queryRawUnsafe(
        "SELECT m.* FROM merchants m WHERE m.status = 'ACTIVE' AND ($1::text IS NULL OR m.id::text > $1) ORDER BY m.id LIMIT $2",
        state.afterId,
        this.screenBatchSize,
      ),
    );
    let screened = 0;
    for (const merchant of rows) {
      try {
        await this.rescreenMerchant(merchant, now, { trigger: "LIST_UPDATE" });
        screened += 1;
      } catch (error) {
        this.logger.error("PeriodicScreeningWorker: unable to re-screen the merchant after a list update", {
          merchantId: merchant.id,
          error: (error as Error).message,
        });
      }
    }
    const last = rows.at(-1);
    const next: ListSweepState = { ...state, afterId: last ? String(last.id) : state.afterId, screened: state.screened + screened };
    if (rows.length < this.screenBatchSize) {
      await this.cursors.write(AML_LIST_SWEEP_KEY, null);
      await this.auditSweep("AML_LIST_UPDATE_SWEEP_FINISHED", { fingerprint: state.fingerprint, screened: next.screened, startedAt: state.startedAt });
    } else {
      await this.cursors.write(AML_LIST_SWEEP_KEY, JSON.stringify(next));
    }
    return screened;
  }

  private parseSweep(raw: string | null): ListSweepState | null {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<ListSweepState>;
      if (typeof value.fingerprint !== "string") return null;
      return {
        fingerprint: value.fingerprint,
        afterId: typeof value.afterId === "string" ? value.afterId : null,
        screened: Number(value.screened ?? 0),
        startedAt: String(value.startedAt ?? new Date(0).toISOString()),
      };
    } catch {
      return null;
    }
  }

  private async auditSweep(action: string, after: Record<string, unknown>): Promise<void> {
    try {
      await writeSystemAudit(this.db as never, { action, entityType: "AML_SCREENING", entityId: "watchlist", after });
    } catch (error) {
      this.logger.warn("PeriodicScreeningWorker: cannot audit the sweep", { action, error: (error as Error).message });
    }
  }

  /**
   * The owner-change trigger. A beneficial owner added to an ACTIVE merchant starts as NOT_SCREENED; the merchant and all
   * its owners are screened with the trigger `OWNER_CHANGE` as soon as the worker sees it, which also sets the owner's
   * screening status, so each new owner is screened once. (An edit of an existing owner's details is not detected: only
   * additions are.)
   */
  private async screenNewOwners(now: Date): Promise<number> {
    const rows = toCamelRows<{ merchantId: string }>(
      await this.db.$queryRawUnsafe(
        `SELECT DISTINCT o.merchant_id::text AS merchant_id FROM beneficial_owners o JOIN merchants m ON m.id = o.merchant_id
         WHERE o.active = true AND o.screening_status = 'NOT_SCREENED' AND m.status = 'ACTIVE' LIMIT $1`,
        this.screenBatchSize,
      ),
    );
    let screened = 0;
    for (const row of rows) {
      try {
        const merchants = toCamelRows<MerchantRow>(
          await this.db.$queryRawUnsafe("SELECT m.* FROM merchants m WHERE m.id = $1::uuid", row.merchantId),
        );
        const merchant = merchants[0];
        if (!merchant) continue;
        await this.rescreenMerchant(merchant, now, { trigger: "OWNER_CHANGE" });
        screened += 1;
      } catch (error) {
        this.logger.error("PeriodicScreeningWorker: unable to screen the merchant of a new owner", {
          merchantId: row.merchantId,
          error: (error as Error).message,
        });
      }
    }
    return screened;
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

  private async rescreenMerchant(
    merchant: MerchantRow,
    now: Date,
    options: { trigger: "PERIODIC" | "LIST_UPDATE" | "OWNER_CHANGE"; cutoff?: Date },
  ): Promise<void> {
    await this.db.$transaction(async (tx: Tx) => {
      const locked = await this.repositories.merchants.lockMerchantById(tx, merchant.id);
      if (!locked) {
        return;
      }
      if (locked.status !== "ACTIVE") {
        return; // suspended or closed in the meantime
      }
      if (options.cutoff) {
        // The due condition is re-checked under the row lock: another node may
        // have screened the merchant between the batch selection and now.
        const latest = await this.repositories.risk.listScreenings(tx, {
          subjectId: locked.id,
          limit: 1,
          offset: 0,
        });
        const lastRequestedAt = latest[0]?.requestedAt;
        if (lastRequestedAt && lastRequestedAt.getTime() > options.cutoff.getTime()) {
          return;
        }
      }

      const owners = await this.repositories.onboarding.listBeneficialOwners(tx, locked.id);
      const report = await this.screenMerchant(tx, locked, owners, now, options.trigger);
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
    trigger: "PERIODIC" | "LIST_UPDATE" | "OWNER_CHANGE" = "PERIODIC",
  ): Promise<MerchantScreeningReport> {
    const service = new MerchantScreeningService({
      repositories: this.repositories,
      screening: this.screening,
      clock: () => now,
    });
    const report = await service.screenMerchant(tx, {
      merchantId: merchant.id,
      trigger,
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
