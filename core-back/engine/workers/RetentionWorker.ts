import { mysqlPlaceholders } from "../db/rawRows";
import type { Tx } from "../db/ports";
import { env } from "../../lib/env";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

/**
 * The management decision that carries the record retention period.
 *
 * The design (OD-4) keeps the regulatory evidence of the platform for five
 * years. The period is a platform setting, so the compliance officer can
 * change it without a deployment.
 */
export const RETENTION_SETTING_KEY = "OD-4";

/** The number of days of a retention year. */
export const DAYS_PER_YEAR = 365;

/** The default retention period of OD-4: five years. */
export const DEFAULT_RETENTION_DAYS = 5 * DAYS_PER_YEAR;

/** The milliseconds of a retention day. */
export const RETENTION_MS_PER_DAY = 86_400_000;

/**
 * The number of batches a single table is purged in during one tick. The
 * bound keeps a tick short when a table holds a lot of expired rows: the
 * remaining rows are purged by the next tick.
 */
const MAX_BATCHES_PER_TABLE = 100;

/**
 * What a retention pass purged.
 *
 * Every counter is the number of rows the pass removed (or, in the dry run,
 * the number of rows it would have removed).
 */
export interface RetentionSummary {
  notifications: number;
  inboundEvents: number;
  attemptStepLogs: number;
  auditLog: number;
  detailChangeLogs: number;
  paymentAttempts: number;
  journalEntries: number;
  journalLines: number;
  adjustments: number;
  disputes: number;
  operatorCases: number;
  attemptGroups: number;
}

const emptySummary = (): RetentionSummary => ({
  notifications: 0,
  inboundEvents: 0,
  attemptStepLogs: 0,
  auditLog: 0,
  detailChangeLogs: 0,
  paymentAttempts: 0,
  journalEntries: 0,
  journalLines: 0,
  adjustments: 0,
  disputes: 0,
  operatorCases: 0,
  attemptGroups: 0,
});

/**
 * A table whose expired rows are purged on their own.
 *
 * The predicate selects the rows that passed the retention period, the
 * parameters are bound to the placeholders of the predicate.
 */
interface RetentionTable {
  table: string;
  summaryKey: keyof RetentionSummary;
  predicate: string;
  params: unknown[];
  orderBy: string;
}

/**
 * Reads the retention period out of the value of a platform setting.
 *
 * The setting of OD-4 carries the period in years (`kybYears`), but a
 * deployment may also state the period in days (`retentionDays`). A value
 * that is not a positive whole number is ignored, so the default applies.
 */
export const retentionDaysFromSetting = (value: unknown): number | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const days = positiveInteger(record.retentionDays);
  if (days !== null) {
    return days;
  }
  const years =
    positiveInteger(record.kybYears)
    ?? positiveInteger(record.retentionYears)
    ?? positiveInteger(record.years);
  if (years !== null) {
    return years * DAYS_PER_YEAR;
  }
  return null;
};

const positiveInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
};

export interface RetentionWorkerDeps extends WorkerOptions {
  /**
   * The retention period in days. When it is not given, the period is read
   * from the platform setting `OD-4` and falls back to five years.
   */
  retentionDays?: number;
  /**
   * The dry run: the worker reports what it would purge without deleting
   * anything. The environment variable `RETENTION_DRY_RUN` turns it on.
   */
  dryRun?: boolean;
}

/**
 * The record retention worker (OD-4).
 *
 * The platform has to keep its regulatory evidence for five years and must
 * not purge anything before that. This worker is the only place where the
 * evidence is removed, and it removes it in bounded batches, in dependency
 * order and inside a transaction per batch.
 *
 * The rules:
 *
 *  - `notifications`     : the rows that are older than the period.
 *  - `inbound_events`   : the rows that were received before the period.
 *  - `attempt_step_logs`: the rows that are older than the period and that
 *                          belong to an attempt that is older than the
 *                          period. The log of a live attempt is never purged.
 *  - `audit_log`        : the rows that are older than the period.
 *  - `detail_change_logs`: the rows that are older than the period.
 *  - `payment_attempts` : the terminal attempts that are older than the
 *                          period, together with their dependent rows. An
 *                          attempt only goes when its journal entry is
 *                          retained (or when it never had one).
 *
 * The ledger (`journal_entries` / `journal_lines`) is deliberately OUT of the
 * retention scope. The GL account balances are derived from the journal lines
 * (`checkpoint_balance + SUM(lines since the checkpoint)`) and a merchant holds
 * no mutable balance of its own (design §7.1). Deleting a journal line without
 * first folding its amount into `gl_accounts.checkpoint_balance` would make a
 * merchant balance silently drop to zero while the system-wide invariant still
 * looks balanced (design §11.2). The ledger is the immutable audit evidence of
 * money that really moved, so the purger never removes it. The non-ledger
 * evidence of an attempt (step logs, inbound events, disputes, operator cases)
 * is still purged, and the attempt row may go once its ledger entry is
 * retained.
 *
 * The worker is a dry run when `RETENTION_DRY_RUN` is set: it then reports
 * what it would purge and deletes nothing.
 */
export class RetentionWorker extends BaseWorker {
  private readonly retentionDaysOverride: number | undefined;
  private readonly dryRun: boolean;

  constructor(deps: RetentionWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 3_600_000 });
    this.retentionDaysOverride = deps.retentionDays;
    this.dryRun = deps.dryRun ?? env.RETENTION_DRY_RUN;
  }

  protected async tick(): Promise<void> {
    const now = this.clock();
    const retentionDays = await this.resolveRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * RETENTION_MS_PER_DAY);
    const summary = emptySummary();

    await this.purgeStandaloneTables(cutoff, summary);
    await this.purgeAttempts(cutoff, summary);

    this.logger.info("RetentionWorker: the retention pass is over", {
      dryRun: this.dryRun,
      retentionDays,
      cutoff: cutoff.toISOString(),
      purged: summary,
    });
  }

  /**
   * The retention period of the pass.
   *
   * The platform setting wins over the default, and an explicit
   * configuration wins over the platform setting.
   */
  private async resolveRetentionDays(): Promise<number> {
    if (this.retentionDaysOverride !== undefined) {
      return this.retentionDaysOverride;
    }
    try {
      const value = await this.repositories.governance.getPlatformSetting(
        this.db as Tx,
        RETENTION_SETTING_KEY,
      );
      const days = retentionDaysFromSetting(value);
      if (days !== null) {
        this.logger.info("RetentionWorker: the retention period comes from the platform settings", {
          key: RETENTION_SETTING_KEY,
          retentionDays: days,
        });
        return days;
      }
    } catch (error) {
      this.logger.warn("RetentionWorker: unable to read the retention period, the default is used", {
        key: RETENTION_SETTING_KEY,
        error: (error as Error).message,
      });
    }
    return DEFAULT_RETENTION_DAYS;
  }

  /**
   * The tables whose expired rows are purged on their own.
   *
   * The order follows the dependency graph: the notifications and the
   * inbound events carry no reference to a payment attempt, the step logs
   * only point at an attempt that is itself expired, and the two log tables
   * stand alone.
   */
  private async purgeStandaloneTables(cutoff: Date, summary: RetentionSummary): Promise<void> {
    const tables: RetentionTable[] = [
      {
        table: "notifications",
        summaryKey: "notifications",
        predicate: "`created_at` < ?",
        params: [cutoff],
        orderBy: "`created_at` ASC",
      },
      {
        table: "inbound_events",
        summaryKey: "inboundEvents",
        predicate: "`received_at` < ?",
        params: [cutoff],
        orderBy: "`received_at` ASC",
      },
      {
        table: "attempt_step_logs",
        summaryKey: "attemptStepLogs",
        // The log of a live attempt is evidence of a running payment, so it
        // only goes when the attempt itself is expired.
        predicate:
          "`created_at` < ? AND `attempt_id` IN (SELECT `id` FROM `payment_attempts` WHERE `created_at` < ?)",
        params: [cutoff, cutoff],
        orderBy: "`created_at` ASC",
      },
      {
        table: "audit_log",
        summaryKey: "auditLog",
        predicate: "`created_at` < ?",
        params: [cutoff],
        orderBy: "`created_at` ASC",
      },
      {
        table: "detail_change_logs",
        summaryKey: "detailChangeLogs",
        predicate: "`created_at` < ?",
        params: [cutoff],
        orderBy: "`created_at` ASC",
      },
    ];

    for (const table of tables) {
      await this.purgeTable(table, summary);
    }
  }

  /**
   * Purges the expired rows of a table in bounded batches.
   *
   * Every batch runs in its own transaction: a batch is either completely
   * purged or not purged at all.
   */
  private async purgeTable(table: RetentionTable, summary: RetentionSummary): Promise<void> {
    const selectSql =
      `SELECT \`id\` FROM \`${table.table}\`` +
      ` WHERE ${table.predicate}` +
      ` ORDER BY ${table.orderBy}` +
      " LIMIT ?";
    const countSql = `SELECT COUNT(*) AS \`total\` FROM \`${table.table}\` WHERE ${table.predicate}`;

    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
      const purged = await this.db.$transaction(async (tx: Tx) => {
        if (this.dryRun) {
          const total = await this.countRows(tx, countSql, table.params);
          return { purged: total, drained: true };
        }
        const ids = await this.selectIds(tx, selectSql, [...table.params, this.batchSize]);
        if (ids.length === 0) {
          return { purged: 0, drained: true };
        }
        const affected = Number(
          await tx.$executeRawUnsafe(
            `DELETE FROM \`${table.table}\` WHERE \`id\` IN (${mysqlPlaceholders(ids.length)})`,
            ...ids,
          ) ?? 0,
        );
        return { purged: affected, drained: ids.length < this.batchSize };
      });

      summary[table.summaryKey] += purged.purged;
      if (purged.purged > 0) {
        this.logger.info(`RetentionWorker: purged the expired rows of ${table.table}`, {
          table: table.table,
          rows: purged.purged,
          dryRun: this.dryRun,
        });
      }
      if (purged.drained) {
        return;
      }
    }
    this.logger.warn("RetentionWorker: the batch bound of the tick is reached", {
      table: table.table,
    });
  }

  /**
   * Purges the terminal attempts that passed the retention period.
   *
   * The journal entries and their lines are NEVER removed here. An attempt
   * only goes when its ledger entry is retained (or when it never had one), so
   * the ledger evidence of the money and the GL balances stay intact. The
   * dependent rows are removed first, in the order the foreign keys demand:
   *
   *   adjustments -> disputes -> operator cases -> inbound events ->
   *   step logs -> the attempt -> the attempt groups
   */
  private async purgeAttempts(cutoff: Date, summary: RetentionSummary): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
      const result = await this.db.$transaction(async (tx: Tx) => {
        const candidates = await this.lockExpiredAttempts(tx, cutoff);
        if (candidates.length === 0) {
          return { selected: 0, purged: 0 };
        }

        // The ledger entries are retained, so an attempt may only be deleted
        // when the entry it points at is still there. An attempt without an
        // entry has no ledger evidence to protect and may go as usual.
        const retainedEntries = await this.retainedJournalEntries(tx, candidates);
        const attempts = candidates.filter(
          (candidate) =>
            candidate.ledgerEntryId === null || retainedEntries.has(candidate.ledgerEntryId),
        );
        if (attempts.length === 0) {
          return { selected: candidates.length, purged: 0 };
        }

        const attemptIds = attempts.map((attempt) => attempt.id);
        const entryIds = [
          ...new Set(
            attempts
              .map((attempt) => attempt.ledgerEntryId)
              .filter((entryId): entryId is string => entryId !== null),
          ),
        ];
        const disputeIds = await this.disputeIdsOf(tx, attemptIds);

        // The dependents go first: the adjustments point at the journal
        // entries and at the disputes, so they have to be gone before their
        // parents are removed. The journal entries themselves stay.
        summary.adjustments += await this.purgeAdjustments(tx, attemptIds, disputeIds, entryIds);
        summary.disputes += await this.purgeRows(
          tx,
          "disputes",
          "`attempt_id` IN (" + mysqlPlaceholders(attemptIds.length) + ")",
          attemptIds,
        );
        summary.operatorCases += await this.purgeRows(
          tx,
          "operator_cases",
          "`attempt_id` IN (" + mysqlPlaceholders(attemptIds.length) + ")",
          attemptIds,
        );
        summary.inboundEvents += await this.purgeRows(
          tx,
          "inbound_events",
          "`attempt_id` IN (" + mysqlPlaceholders(attemptIds.length) + ")",
          attemptIds,
        );
        summary.attemptStepLogs += await this.purgeRows(
          tx,
          "attempt_step_logs",
          "`attempt_id` IN (" + mysqlPlaceholders(attemptIds.length) + ")",
          attemptIds,
        );

        const purgedAttempts = await this.purgeRows(
          tx,
          "payment_attempts",
          "`id` IN (" + mysqlPlaceholders(attemptIds.length) + ")",
          attemptIds,
        );
        summary.paymentAttempts += purgedAttempts;

        // The attempt groups are only free once the attempts that used them
        // are gone.
        const groupIds = [...new Set(attempts.map((attempt) => attempt.attemptGroupId))];
        const freeGroups = await this.freeAttemptGroups(tx, cutoff, groupIds, attemptIds);
        if (freeGroups.length > 0) {
          summary.attemptGroups += await this.purgeRows(
            tx,
            "attempt_groups",
            "`id` IN (" + mysqlPlaceholders(freeGroups.length) + ")",
            freeGroups,
          );
        }

        return { selected: candidates.length, purged: purgedAttempts };
      });

      if (result.purged > 0) {
        this.logger.info("RetentionWorker: purged the expired attempts", {
          attempts: result.purged,
          dryRun: this.dryRun,
        });
      }
      if (this.dryRun) {
        // The dry run reports the first batch and deletes nothing.
        return;
      }
      if (result.purged === 0) {
        // Nothing could be purged: the remaining attempts wait for the ledger
        // entry that protects them, so the pass stops here.
        if (result.selected > 0) {
          this.logger.warn("RetentionWorker: an expired attempt waits for its journal entry", {
            selected: result.selected,
          });
        }
        return;
      }
      if (result.selected < this.batchSize) {
        return;
      }
    }
    this.logger.warn("RetentionWorker: the batch bound of the tick is reached", {
      table: "payment_attempts",
    });
  }

  /**
   * The terminal attempts that passed the retention period.
   *
   * An attempt is terminal when it carries a `terminal_at` stamp, which is
   * the stamp the platform writes when the attempt reaches a terminal
   * status.
   */
  private async lockExpiredAttempts(
    tx: Tx,
    cutoff: Date,
  ): Promise<Array<{ id: string; ledgerEntryId: string | null; attemptGroupId: string }>> {
    const rows = await tx.$queryRawUnsafe(
      "SELECT `id`, `ledger_entry_id`, `attempt_group_id` FROM `payment_attempts`" +
      " WHERE `terminal_at` IS NOT NULL AND `created_at` < ?" +
      " ORDER BY `created_at` ASC" +
      " LIMIT ?",
      cutoff,
      this.batchSize,
    );
    return (rows as Array<Record<string, unknown>>).map((row) => {
      const record = row as { id?: unknown; ledger_entry_id?: unknown; attempt_group_id?: unknown };
      return {
        id: String(record.id ?? ""),
        ledgerEntryId:
          record.ledger_entry_id === null || record.ledger_entry_id === undefined
            ? null
            : String(record.ledger_entry_id),
        attemptGroupId: String(record.attempt_group_id ?? ""),
      };
    });
  }

  /**
   * The journal entries of the candidates that are retained.
   *
   * A missing entry is not "retained": the attempt is left in place rather
   * than risk deleting evidence that a legacy pass already removed.
   */
  private async retainedJournalEntries(
    tx: Tx,
    candidates: Array<{ id: string; ledgerEntryId: string | null }>,
  ): Promise<Set<string>> {
    const entryIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.ledgerEntryId)
          .filter((entryId): entryId is string => entryId !== null && entryId.length > 0),
      ),
    ];
    if (entryIds.length === 0) {
      return new Set();
    }
    const existing = await this.selectIds(
      tx,
      "SELECT `id` FROM `journal_entries`" +
      " WHERE `id` IN (" + mysqlPlaceholders(entryIds.length) + ")",
      entryIds,
    );
    return new Set(existing);
  }

  /**
   * The disputes of the purged attempts.
   *
   * The disputes are collected before the adjustments are purged, because
   * the adjustments point at the disputes.
   */
  private async disputeIdsOf(tx: Tx, attemptIds: string[]): Promise<string[]> {
    if (attemptIds.length === 0) {
      return [];
    }
    return this.selectIds(
      tx,
      "SELECT `id` FROM `disputes` WHERE `attempt_id` IN (" + mysqlPlaceholders(attemptIds.length) + ")",
      attemptIds,
    );
  }

  /**
   * The adjustments of the purged attempts, of their disputes and of their
   * journal entries.
   */
  private async purgeAdjustments(
    tx: Tx,
    attemptIds: string[],
    disputeIds: string[],
    entryIds: string[],
  ): Promise<number> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (attemptIds.length > 0) {
      clauses.push("`source_attempt_id` IN (" + mysqlPlaceholders(attemptIds.length) + ")");
      params.push(...attemptIds);
    }
    if (disputeIds.length > 0) {
      clauses.push("`dispute_id` IN (" + mysqlPlaceholders(disputeIds.length) + ")");
      params.push(...disputeIds);
    }
    if (entryIds.length > 0) {
      clauses.push("`journal_entry_id` IN (" + mysqlPlaceholders(entryIds.length) + ")");
      params.push(...entryIds);
    }
    if (clauses.length === 0) {
      return 0;
    }
    return this.purgeRows(tx, "adjustments", clauses.join(" OR "), params);
  }

  /**
   * The attempt groups that no attempt references any more.
   *
   * The purged attempts are excluded from the lookup, because they are
   * already gone in a real pass while the dry run still sees them.
   */
  private async freeAttemptGroups(
    tx: Tx,
    cutoff: Date,
    groupIds: string[],
    purgedAttemptIds: string[],
  ): Promise<string[]> {
    if (groupIds.length === 0) {
      return [];
    }
    const referenced = await tx.$queryRawUnsafe(
      "SELECT `attempt_group_id` FROM `payment_attempts`" +
      " WHERE `attempt_group_id` IN (" + mysqlPlaceholders(groupIds.length) + ")" +
      " AND `id` NOT IN (" + mysqlPlaceholders(purgedAttemptIds.length) + ")",
      ...groupIds,
      ...purgedAttemptIds,
    );
    const stillUsed = new Set(
      (referenced as Array<Record<string, unknown>>).map((row) =>
        String((row as { attempt_group_id?: unknown }).attempt_group_id ?? ""),
      ),
    );
    const groups = await this.selectIds(
      tx,
      "SELECT `id` FROM `attempt_groups`" +
      " WHERE `id` IN (" + mysqlPlaceholders(groupIds.length) + ")" +
      " AND `created_at` < ?",
      [...groupIds, cutoff],
    );
    return groups.filter((groupId) => !stillUsed.has(groupId));
  }

  /**
   * Removes the rows of a table that match the predicate.
   *
   * The removal happens in bounded chunks, so a table with a lot of expired
   * rows never locks itself in one statement. In the dry run the rows are
   * only counted.
   */
  private async purgeRows(
    tx: Tx,
    table: string,
    predicate: string,
    params: unknown[],
  ): Promise<number> {
    if (params.length === 0) {
      // An empty list would build an invalid `IN ()` clause.
      return 0;
    }
    if (this.dryRun) {
      return this.countRows(tx, `SELECT COUNT(*) AS \`total\` FROM \`${table}\` WHERE ${predicate}`, params);
    }
    let total = 0;
    for (;;) {
      const affected = Number(
        await tx.$executeRawUnsafe(
          `DELETE FROM \`${table}\` WHERE ${predicate} LIMIT ?`,
          ...params,
          this.batchSize,
        ) ?? 0,
      );
      total += affected;
      if (affected < this.batchSize) {
        return total;
      }
    }
  }

  /**
   * The number of rows that match the predicate.
   */
  private async countRows(tx: Tx, sql: string, params: unknown[]): Promise<number> {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    const first = rows[0] as { total?: unknown } | undefined;
    return Number(first?.total ?? 0);
  }

  /**
   * The identifiers of the rows the statement selects.
   */
  private async selectIds(tx: Tx, sql: string, params: unknown[]): Promise<string[]> {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    return (rows as Array<Record<string, unknown>>)
      .map((row) => String((row as { id?: unknown }).id ?? ""))
      .filter((id) => id.length > 0);
  }
}
