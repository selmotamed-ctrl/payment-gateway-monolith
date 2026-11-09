import {
  ensureJournalPartitions,
  inspectJournalPartitions,
  type PartitionInspection,
} from "../ledger/partitionMaintenance";
import { raiseLedgerCase, writeSystemAudit } from "../ledger/ledgerAlerts";
import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";

type Any = Record<string, any>;

export const JOURNAL_PARTITION_CASE_KEYS = {
  defaultRows: "ledger.partition.default_rows",
  ensureFailed: "ledger.partition.ensure_failed",
} as const;

export interface JournalPartitionWorkerDeps extends WorkerOptions {
  /** How many months (counting the current one) must exist ahead of the clock. Default 6, 1..60. */
  monthsAhead?: number;
  /** SLA of the cases in hours (these are the most urgent cases the platform raises). Default 2. */
  caseSlaHours?: number;
  inspect?: (db: Any, options: { monthsAhead: number }) => Promise<PartitionInspection>;
  ensure?: (db: Any, monthsAhead: number) => Promise<void>;
  raiseCase?: (db: Any, input: { subjectKey: string; notes: string; slaHours?: number; now?: Date }) => Promise<boolean>;
  audit?: (db: Any, input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }) => Promise<void>;
}

/**
 * Journal partition maintenance (AUTO-01). Cluster singleton, every 6 hours.
 *
 * `journal_lines` has one partition per month. The deploy cron calls `ensure_journal_line_partitions`, but a database
 * provisioned any other way, or a cron that stopped, would get no new months, and the first posting of a missing month
 * lands in `journal_lines_default`, after which that month can no longer be created. This worker:
 *
 *   1. keeps the next `monthsAhead` months in existence by calling the SAME database function the cron calls (so the
 *      TRUNCATE guard and the role privileges are installed identically);
 *   2. raises one most-urgent case `ledger.partition.default_rows` while the default partition holds rows (repairing
 *      them edits ledger rows, so it is an operator action: `scripts/repair-journal-default-partition.ts`);
 *   3. raises one case `ledger.partition.ensure_failed` when creating the months fails (for example because of rows in
 *      the default partition, or missing privileges), with the database's own error.
 *
 * Cases are never resolved here; a person closes them after the repair. An audit row `JOURNAL_PARTITIONS_ENSURED`
 * records the months this worker created.
 */
export class JournalPartitionWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly monthsAhead: number;
  private readonly caseSlaHours: number;
  private readonly inspect: NonNullable<JournalPartitionWorkerDeps["inspect"]>;
  private readonly ensure: NonNullable<JournalPartitionWorkerDeps["ensure"]>;
  private readonly raiseCase: NonNullable<JournalPartitionWorkerDeps["raiseCase"]>;
  private readonly audit: NonNullable<JournalPartitionWorkerDeps["audit"]>;
  lastInspection: PartitionInspection | null = null;

  constructor(deps: JournalPartitionWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 6 * 60 * 60 * 1000 });
    const months = Math.floor(deps.monthsAhead ?? 6);
    if (!(months >= 1 && months <= 60)) throw new Error(`JournalPartitionWorker: monthsAhead must be 1..60 (got ${deps.monthsAhead})`);
    this.monthsAhead = months;
    this.caseSlaHours = deps.caseSlaHours ?? 2;
    this.inspect = deps.inspect ?? ((db, options) => inspectJournalPartitions(db as never, options));
    this.ensure = deps.ensure ?? ((db, monthsAhead) => ensureJournalPartitions(db as never, monthsAhead));
    this.raiseCase = deps.raiseCase ?? raiseLedgerCase;
    this.audit = deps.audit ?? writeSystemAudit;
  }

  protected async tick(): Promise<WorkerTickResult> {
    const now = this.clock();
    const before = await this.inspect(this.db, { monthsAhead: this.monthsAhead });
    let ensureError: string | null = null;
    if (before.missing.length > 0) {
      try {
        await this.ensure(this.db, this.monthsAhead);
      } catch (error) {
        ensureError = sanitizeWorkerError(error);
        this.logger.error("JournalPartitionWorker: creating the monthly partitions failed", { missing: before.missing, error: ensureError });
      }
    }
    const after = before.missing.length > 0 ? await this.inspect(this.db, { monthsAhead: this.monthsAhead }) : before;
    this.lastInspection = after;
    const created = before.missing.filter((month) => !after.missing.includes(month));

    if (created.length > 0) {
      await this.audit(this.db, {
        action: "JOURNAL_PARTITIONS_ENSURED",
        entityType: "LEDGER",
        entityId: "journal_lines",
        after: { created, monthsAhead: this.monthsAhead, stillMissing: after.missing },
      });
      this.logger.info("JournalPartitionWorker: monthly partitions created", { created });
    }
    if (ensureError !== null || after.missing.length > 0) {
      await this.raiseCase(this.db, {
        subjectKey: JOURNAL_PARTITION_CASE_KEYS.ensureFailed,
        notes:
          `The monthly journal partitions ${after.missing.join(", ")} could not be created${ensureError ? `: ${ensureError}` : ""}. ` +
          `Until they exist, lines of those months land in journal_lines_default and block creating the month. ` +
          `${after.defaultRows > 0 ? "Rows are already in the default partition: run scripts/repair-journal-default-partition.ts with ledger maintenance privileges. " : ""}` +
          `Check the privileges on ensure_journal_line_partitions and the deploy cron.`,
        slaHours: this.caseSlaHours,
        now,
      });
    }
    if (after.defaultRows > 0) {
      await this.raiseCase(this.db, {
        subjectKey: JOURNAL_PARTITION_CASE_KEYS.defaultRows,
        notes:
          `${after.defaultRowsCapped ? "At least " : ""}${after.defaultRows} journal line(s) are in journal_lines_default ` +
          `(months: ${after.defaultMonths.map((entry) => `${entry.month}=${entry.rows}`).join(", ")}). ` +
          `Their months have no partition. Run scripts/repair-journal-default-partition.ts (dry run first) with a ledger maintenance connection.`,
        slaHours: this.caseSlaHours,
        now,
      });
    }
    return { processed: created.length, backlog: after.defaultRows };
  }
}
