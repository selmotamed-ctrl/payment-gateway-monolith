import { Decimal } from "decimal.js";
import {
  netMerchantReceivable,
  parseDailyCron,
  prismaCommissionNettingStore,
  zonedDayClock,
  type CommissionNettingStore,
  type NetReceivableResult,
  type NettingAuditFn,
  type ReceivableBucket,
} from "../ledger/commissionNetting";
import type { LedgerPoster } from "../ledger/LedgerPoster";
import { raiseLedgerCase, writeSystemAudit } from "../ledger/ledgerAlerts";
import { queueCommissionNotification } from "../../lib/commissionNotifications";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

type Any = Record<string, any>;

export type CommissionNotifyFn = (
  db: Any,
  input: { merchantId: string; code: "COMMISSION_RECEIVABLE_SETTLEMENT_DUE"; payload: Record<string, unknown>; eventKey: string },
) => Promise<void>;

export type CommissionCaseFn = (db: Any, input: { subjectKey: string; notes: string; slaHours?: number; now?: Date }) => Promise<boolean>;

export interface CommissionNettingWorkerDeps extends WorkerOptions {
  /** The ledger poster: netting is posted ONLY through the existing NETTING stage of MERCHANT_DIRECT_CONFIRMATION. */
  ledgerPoster: Pick<LedgerPoster, "post" | "lockShardsFor">;
  /** Audit what would be netted without posting or notifying (decision: dry run for the first release). Default true. */
  dryRun?: boolean;
  /** Daily run time as `M H * * *` in `timeZone`. Default "30 0 * * *" (00:30, after the Tripoli day close). */
  dailyCron?: string;
  /** Default "Africa/Tripoli". */
  timeZone?: string;
  /** Receivable older than this many days (FIFO) opens a finance case. Default 30. */
  agingDays?: number;
  /** Most receivable buckets one daily run loads. Default 10,000. */
  maxCandidates?: number;
  /** Time budget of one tick in milliseconds; the run continues on the next tick. Default 20,000. */
  tickBudgetMs?: number;
  /** SLA of the aged-receivable case in hours. Default 72. */
  agingCaseSlaHours?: number;
  store?: CommissionNettingStore;
  audit?: NettingAuditFn;
  raiseCase?: CommissionCaseFn;
  notify?: CommissionNotifyFn;
}

/** De-duplication key of the aged-receivable finance case (one open case per merchant). */
export const commissionAgedCaseKey = (merchantId: string): string => `commission.receivable.aged:${merchantId}`;

interface DailyRun {
  date: string;
  runKey: string;
  merchants: Array<{ merchantId: string; buckets: ReceivableBucket[] }>;
  next: number;
  stats: { merchants: number; netted: Decimal; proposed: Decimal; nettings: number; overCeiling: number; aged: number; errors: number };
}

/**
 * Daily merchant-direct commission netting (AUTO-21, decision D8). Cluster singleton.
 *
 * Once per local day, at or after `dailyCron` in `timeZone` (default 00:30 Africa/Tripoli), it loads every merchant
 * with a positive commission receivable (one grouped read), then works through them in batches of `batchSize` per
 * tick within `tickBudgetMs`:
 *
 *   1. nets each receivable account against the merchant's ACTIVE wallet of the same currency:
 *      min(receivable, wallet balance - open cash-outs), never below zero, partial when short; the rest is carried
 *      forward (`netMerchantReceivable`, keyed per day, so a repeated run never nets twice);
 *   2. receivable still older than `agingDays` after netting (FIFO against the recognitions in the window) opens one
 *      P1 finance case per merchant (`commission.receivable.aged:<merchantId>`);
 *   3. when the merchant's remaining receivable is above its `commissionReceivableCeiling`, the attempt guard's PAUSE
 *      decision stops new merchant-direct attempts (it resumes by itself once the receivable is back under the
 *      ceiling); the merchant is told to settle once per day.
 *
 * In dry run (the default) step 1 only audits `COMMISSION_NETTING_PROPOSED` and step 3 queues no notice; the case of
 * step 2 is raised either way (it is an internal alert). A summary `COMMISSION_NETTING_RUN` audit row closes each run.
 */
export class CommissionNettingWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly poster: Pick<LedgerPoster, "post" | "lockShardsFor">;
  private readonly dryRun: boolean;
  private readonly runAtMinutes: number;
  private readonly timeZone: string;
  private readonly agingDays: number;
  private readonly maxCandidates: number;
  private readonly tickBudgetMs: number;
  private readonly agingCaseSlaHours: number;
  private readonly store: CommissionNettingStore;
  private readonly audit: NettingAuditFn;
  private readonly raiseCase: CommissionCaseFn;
  private readonly notify: CommissionNotifyFn;
  private run: DailyRun | null = null;
  private lastCompletedDate: string | null = null;

  constructor(deps: CommissionNettingWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 60_000, batchSize: deps.batchSize ?? 100 });
    this.poster = deps.ledgerPoster;
    this.dryRun = deps.dryRun ?? true;
    this.runAtMinutes = parseDailyCron(deps.dailyCron ?? "30 0 * * *");
    this.timeZone = deps.timeZone ?? "Africa/Tripoli";
    this.agingDays = Math.max(1, Math.trunc(deps.agingDays ?? 30));
    this.maxCandidates = Math.max(1, Math.trunc(deps.maxCandidates ?? 10_000));
    this.tickBudgetMs = Math.max(1, Math.trunc(deps.tickBudgetMs ?? 20_000));
    this.agingCaseSlaHours = deps.agingCaseSlaHours ?? 72;
    this.store = deps.store ?? prismaCommissionNettingStore;
    this.audit = deps.audit ?? writeSystemAudit;
    this.raiseCase = deps.raiseCase ?? raiseLedgerCase;
    this.notify = deps.notify ?? queueCommissionNotification;
  }

  /** The local date of the last completed run (observability and tests). */
  get lastRunDate(): string | null {
    return this.lastCompletedDate;
  }

  protected async tick(): Promise<void> {
    const startedAt = Date.now();
    const now = this.clock();
    if (!this.run) {
      const local = zonedDayClock(now, this.timeZone);
      if (local.minutes < this.runAtMinutes || local.date === this.lastCompletedDate) return;
      this.run = await this.startRun(local.date, now);
    }
    const run = this.run;
    let processed = 0;
    while (run.next < run.merchants.length && processed < this.batchSize && Date.now() - startedAt < this.tickBudgetMs) {
      const item = run.merchants[run.next]!;
      run.next += 1;
      processed += 1;
      try {
        await this.processMerchant(run, item.merchantId, item.buckets, now);
      } catch (error) {
        run.stats.errors += 1;
        this.logger.error("CommissionNettingWorker: merchant failed", { merchantId: item.merchantId, error: (error as Error).message });
      }
    }
    if (run.next >= run.merchants.length) await this.finishRun(run);
  }

  private async startRun(date: string, now: Date): Promise<DailyRun> {
    const agingCutoff = new Date(now.getTime() - this.agingDays * 24 * 60 * 60 * 1000);
    const buckets = await this.store.listReceivables(this.db, { agingCutoff, limit: this.maxCandidates });
    if (buckets.length >= this.maxCandidates) {
      this.logger.warn("CommissionNettingWorker: candidate limit reached, the rest is netted on the next run", { limit: this.maxCandidates });
    }
    const byMerchant = new Map<string, ReceivableBucket[]>();
    for (const bucket of buckets) {
      const list = byMerchant.get(bucket.merchantId) ?? [];
      list.push(bucket);
      byMerchant.set(bucket.merchantId, list);
    }
    return {
      date,
      runKey: `daily:${date}`,
      merchants: [...byMerchant.entries()].map(([merchantId, list]) => ({ merchantId, buckets: list })),
      next: 0,
      stats: { merchants: 0, netted: new Decimal(0), proposed: new Decimal(0), nettings: 0, overCeiling: 0, aged: 0, errors: 0 },
    };
  }

  private async processMerchant(run: DailyRun, merchantId: string, buckets: ReceivableBucket[], now: Date): Promise<void> {
    run.stats.merchants += 1;
    let proposed = new Decimal(0);
    let aged = new Decimal(0);
    let agedCurrency = buckets[0]?.currency ?? "";
    for (const bucket of buckets) {
      let result: NetReceivableResult;
      try {
        result = await this.inTransaction((tx) =>
          netMerchantReceivable(tx, { poster: this.poster, store: this.store, audit: this.audit }, {
            merchantId,
            receivableAccountId: bucket.receivableAccountId,
            currency: bucket.currency,
            runKey: run.runKey,
            trigger: "DAILY",
            dryRun: this.dryRun,
          }),
        );
      } catch (error) {
        run.stats.errors += 1;
        this.logger.error("CommissionNettingWorker: netting failed", {
          merchantId,
          receivableAccountId: bucket.receivableAccountId,
          error: (error as Error).message,
        });
        result = { status: "NOTHING_OWED", receivable: bucket.receivable, amount: new Decimal(0), remainder: bucket.receivable };
      }
      if (result.status === "NETTED") {
        run.stats.netted = run.stats.netted.plus(result.amount);
        run.stats.nettings += 1;
      } else if (result.status === "PROPOSED") {
        run.stats.proposed = run.stats.proposed.plus(result.amount);
        proposed = proposed.plus(result.amount);
      }
      // FIFO: what is still owed beyond the commission recognised inside the aging window is older than the window.
      const remaining = result.status === "ALREADY_NETTED" ? bucket.receivable : result.remainder;
      const bucketAged = Decimal.max(0, remaining.minus(bucket.recentRecognised));
      if (bucketAged.gt(aged)) agedCurrency = bucket.currency;
      aged = aged.plus(bucketAged);
    }

    if (aged.gt(0)) {
      const raised = await this.raiseCase(this.db, {
        subjectKey: commissionAgedCaseKey(merchantId),
        notes:
          `Merchant ${merchantId} owes ${aged.toFixed(4)} ${agedCurrency} of merchant-direct commission older than ${this.agingDays} days ` +
          `that the wallet could not cover. Collect it from the merchant or decide a write-off.`,
        slaHours: this.agingCaseSlaHours,
        now,
      });
      if (raised) run.stats.aged += 1;
    }

    const merchant = await this.store.merchantCeiling(this.db, merchantId);
    if (!merchant || merchant.ceiling === null) return;
    // In dry run nothing was posted: judge the ceiling on what the receivable WOULD be after the proposed netting.
    const receivable = (await this.store.merchantReceivable(this.db, merchantId)).minus(this.dryRun ? proposed : 0);
    if (!receivable.gt(merchant.ceiling)) return;
    run.stats.overCeiling += 1;
    await this.audit(this.db, {
      action: "COMMISSION_RECEIVABLE_OVER_CEILING",
      entityType: "MERCHANT",
      entityId: merchantId,
      after: {
        receivable: receivable.toFixed(4),
        ceiling: merchant.ceiling.toFixed(4),
        runKey: run.runKey,
        decision: "PAUSE",
        dryRun: this.dryRun,
      },
    });
    if (!this.dryRun) {
      await this.notify(this.db, {
        merchantId,
        code: "COMMISSION_RECEIVABLE_SETTLEMENT_DUE",
        payload: { receivable: receivable.toFixed(4), ceiling: merchant.ceiling.toFixed(4), currency: agedCurrency || buckets[0]?.currency || "" },
        eventKey: `${merchantId}:${run.date}`,
      });
    }
  }

  private async finishRun(run: DailyRun): Promise<void> {
    this.run = null;
    this.lastCompletedDate = run.date;
    await this.audit(this.db, {
      action: "COMMISSION_NETTING_RUN",
      entityType: "LEDGER",
      entityId: run.runKey,
      after: {
        merchants: run.stats.merchants,
        nettings: run.stats.nettings,
        netted: run.stats.netted.toFixed(4),
        proposed: run.stats.proposed.toFixed(4),
        overCeiling: run.stats.overCeiling,
        agedCasesOpened: run.stats.aged,
        errors: run.stats.errors,
        dryRun: this.dryRun,
      },
    });
    this.logger.info("CommissionNettingWorker: daily run finished", { runKey: run.runKey, merchants: run.stats.merchants, errors: run.stats.errors });
  }
}
