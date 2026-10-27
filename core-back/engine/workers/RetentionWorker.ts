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
 *                          period, together with their dependent rows.
 *  - `journal_entries`  : the entries that are older than the period and that
 *                          no attempt references any more, together with
 *                          their lines.
 *
 * Two invariants hold for every purge:
 *
 *  - an attempt is never purged while its journal entry survives, and
 *  - a journal entry is never purged while an attempt references it.
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
    await this.purgeOrphanJournalEntries(cutoff, summary);

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
   * The attempt and its journal entry go together: an attempt is only
   * purged when its journal entry is purged in the very same transaction,
   * and a journal entry is only purged when no attempt references it any
   * more. The dependent rows are removed first, in the order the foreign
   * keys demand:
   *
   *   journal lines -> adjustments -> disputes -> operator cases ->
   *   inbound events -> step logs -> the attempt -> the attempt groups ->
   *   the journal entries
   */
  private async purgeAttempts(cutoff: Date, summary: RetentionSummary): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
      const result = await this.db.$transaction(async (tx: Tx) => {
        const candidates = await this.lockExpiredAttempts(tx, cutoff);
        if (candidates.length === 0) {
          return { selected: 0, purged: 0, entries: 0 };
        }

        const verdict = await this.journalEntryVerdict(tx, cutoff, candidates);
        const attempts = candidates.filter(
          (candidate) =>
            candidate.ledgerEntryId === null || verdict.purgeable.includes(candidate.ledgerEntryId),
        );
        if (attempts.length === 0) {
          return { selected: candidates.length, purged: 0, entries: 0 };
        }

        const attemptIds = attempts.map((attempt) => attempt.id);
        const entryIds = verdict.purgeable.filter((entry) =>
          attempts.some((attempt) => attempt.ledgerEntryId === entry),
        );
        const disputeIds = await this.disputeIdsOf(tx, attemptIds);

        // The dependents go first: the journal lines and the adjustments
        // point at the journal entries and at the disputes, so they have to
        // be gone before their parents are removed.
        summary.journalLines += await this.purgeRows(
          tx,
          "journal_lines",
          "`entry_id` IN (" + mysqlPlaceholders(entryIds.length) + ")",
          entryIds,
        );
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

        const purgedEntries = await this.purgeRows(
          tx,
          "journal_entries",
          "`id` IN (" + mysqlPlaceholders(entryIds.length) + ")",
          entryIds,
        );
        summary.journalEntries += purgedEntries;

        return { selected: candidates.length, purged: purgedAttempts, entries: purgedEntries };
      });

      if (result.purged > 0) {
        this.logger.info("RetentionWorker: purged the expired attempts", {
          attempts: result.purged,
          journalEntries: result.entries,
          dryRun: this.dryRun,
        });
      }
      if (this.dryRun) {
        // The dry run reports the first batch and deletes nothing.
        return;
      }
      if (result.purged === 0) {
        // Nothing could be purged: the remaining attempts wait for the entry
        // they reference, so the pass stops here.
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
   * Purges the journal entries that passed the retention period and that no
   * attempt references any more.
   *
   * The entries of the purged attempts are already gone, so this step is
   * about the entries of the other references (an adjustment, an AML hold,
   * a settlement sweep).
   */
  private async purgeOrphanJournalEntries(cutoff: Date, summary: RetentionSummary): Promise<void> {
    const table: RetentionTable = {
      table: "journal_entries",
      summaryKey: "journalEntries",
      predicate:
        "`created_at` < ?" +
        " AND `id` NOT IN (SELECT `ledger_entry_id` FROM `payment_attempts` WHERE `ledger_entry_id` IS NOT NULL)" +
        " AND `id` NOT IN (SELECT `hold_journal_entry_id` FROM `aml_cases` WHERE `hold_journal_entry_id` IS NOT NULL)",
      params: [cutoff],
      orderBy: "`created_at` ASC",
    };
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
          return { entries: total, drained: true };
        }
        const ids = await this.selectIds(tx, selectSql, [...table.params, this.batchSize]);
        if (ids.length === 0) {
          return { entries: 0, drained: true };
        }
        const lines = await this.purgeRows(
          tx,
          "journal_lines",
          "`entry_id` IN (" + mysqlPlaceholders(ids.length) + ")",
          ids,
        );
        const entries = await this.purgeRows(
          tx,
          "journal_entries",
          "`id` IN (" + mysqlPlaceholders(ids.length) + ")",
          ids,
        );
        summary.journalLines += lines;
        return { entries, drained: ids.length < this.batchSize };
      });

      summary.journalEntries += purged.entries;
      if (purged.entries > 0) {
        this.logger.info("RetentionWorker: purged the expired journal entries", {
          journalEntries: purged.entries,
          dryRun: this.dryRun,
        });
      }
      if (purged.drained) {
        return;
      }
    }
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
   * The verdict on the journal entries of the candidates.
   *
   * An entry may be purged with its attempt when it passed the retention
   * period, when no attempt outside the batch references it and when no AML
   * case holds it. An entry that does not exist any more protects nothing,
   * so its attempt may go. Every other entry blocks the purge of its
   * attempt, so an attempt never outlives the evidence of its entry.
   */
  private async journalEntryVerdict(
    tx: Tx,
    cutoff: Date,
    candidates: Array<{ id: string; ledgerEntryId: string | null }>,
  ): Promise<{ purgeable: string[]; blocked: string[] }> {
    const entryIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.ledgerEntryId)
          .filter((entryId): entryId is string => entryId !== null && entryId.length > 0),
      ),
    ];
    if (entryIds.length === 0) {
      return { purgeable: [], blocked: [] };
    }

    const existing = await this.selectIds(
      tx,
      "SELECT `id` FROM `journal_entries`" +
      " WHERE `id` IN (" + mysqlPlaceholders(entryIds.length) + ")",
      entryIds,
    );
    const existingSet = new Set(existing);
    const missing = entryIds.filter((entryId) => !existingSet.has(entryId));
    if (existing.length === 0) {
      // Every entry of the candidates is already gone, so nothing protects
      // the attempts.
      return { purgeable: missing, blocked: [] };
    }

    const expired = await this.selectIds(
      tx,
      "SELECT `id` FROM `journal_entries`" +
      " WHERE `id` IN (" + mysqlPlaceholders(existing.length) + ")" +
      " AND `created_at` < ?",
      [...existing, cutoff],
    );
    if (expired.length === 0) {
      return { purgeable: missing, blocked: existing };
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const referrers = await tx.$queryRawUnsafe(
      "SELECT `id`, `ledger_entry_id` FROM `payment_attempts`" +
      " WHERE `ledger_entry_id` IN (" + mysqlPlaceholders(expired.length) + ")",
      ...expired,
    );
    const referencedOutside = new Set<string>();
    for (const referrer of referrers) {
      const record = referrer as { id?: unknown; ledger_entry_id?: unknown };
      const id = String(record.id ?? "");
      const entryId = String(record.ledger_entry_id ?? "");
      if (!candidateIds.has(id)) {
        referencedOutside.add(entryId);
      }
    }

    const held = await this.selectIds(
      tx,
      "SELECT `id` FROM `aml_cases`" +
      " WHERE `hold_journal_entry_id` IN (" + mysqlPlaceholders(expired.length) + ")",
      expired,
    );

    const blocked = [
      ...existing.filter((entryId) => !expired.includes(entryId)),
      ...expired.filter((entryId) => referencedOutside.has(entryId) || held.includes(entryId)),
    ];
    const purgeable = [
      ...missing,
      ...expired.filter((entryId) => !referencedOutside.has(entryId) && !held.includes(entryId)),
    ];
    return { purgeable, blocked };
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
