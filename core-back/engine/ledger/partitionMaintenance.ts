import type { PrismaLike } from "../db/ports";

/**
 * Journal partition maintenance (AUTO-01).
 *
 * `journal_lines` is partitioned by month on `created_at`. A line whose month has no partition lands in
 * `journal_lines_default`, and PostgreSQL then REFUSES to create that month ("updated partition constraint for default
 * partition would be violated by some row"). The worker keeps the next N months ahead of the clock; this module holds
 * the three things it and the operator tooling need: inspect, ensure, and the guarded repair of stranded rows.
 */

type Any = Record<string, any>;

export const MAX_PARTITION_MONTHS_AHEAD = 60;

export interface DefaultPartitionMonth {
  /** `YYYY_MM` (the suffix a partition of that month would have). */
  month: string;
  rows: number;
}

export interface PartitionInspection {
  monthsAhead: number;
  /** Months (`YYYY_MM`) among the next `monthsAhead` that have no partition yet. */
  missing: string[];
  /** Partitions named `journal_lines_YYYY_MM` that exist. */
  monthlyPartitions: number;
  /** Rows in `journal_lines_default`, counted up to `cap` (a partition without the default table reports 0). */
  defaultRows: number;
  defaultRowsCapped: boolean;
  defaultMonths: DefaultPartitionMonth[];
}

const isMissingRelation = (error: unknown): boolean => {
  const code = (error as { code?: unknown; meta?: { code?: unknown } } | null)?.code;
  const metaCode = (error as { meta?: { code?: unknown } } | null)?.meta?.code;
  return code === "42P01" || metaCode === "42P01" || /journal_lines_default.*does not exist/i.test(String((error as Error | null)?.message));
};

const rows = async <T>(db: Any, sql: string, ...values: unknown[]): Promise<T[]> => ((await db.$queryRawUnsafe(sql, ...values)) ?? []) as T[];

export const inspectJournalPartitions = async (
  db: PrismaLike,
  options: { monthsAhead: number; cap?: number },
): Promise<PartitionInspection> => {
  const cap = Math.max(1, Math.floor(options.cap ?? 10_000));
  const monthsAhead = Math.floor(options.monthsAhead);
  const missing = await rows<{ suffix: string }>(
    db,
    `WITH want AS (
       SELECT to_char(date_trunc('month', now())::date + (g || ' months')::interval, 'YYYY_MM') AS suffix
       FROM generate_series(0, $1::int - 1) AS g
     )
     SELECT suffix FROM want WHERE to_regclass('"journal_lines_' || suffix || '"') IS NULL ORDER BY suffix`,
    monthsAhead,
  );
  const monthly = await rows<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'journal_lines'::regclass AND c.relname ~ '^journal_lines_[0-9]{4}_[0-9]{2}$'`,
  );
  let defaultMonths: DefaultPartitionMonth[] = [];
  try {
    const found = await rows<{ month: string; n: number }>(
      db,
      `SELECT to_char(date_trunc('month', created_at), 'YYYY_MM') AS month, count(*)::int AS n
       FROM (SELECT created_at FROM journal_lines_default LIMIT $1::int) AS capped
       GROUP BY 1 ORDER BY 1`,
      cap,
    );
    defaultMonths = found.map((row) => ({ month: String(row.month), rows: Number(row.n) }));
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
  }
  const defaultRows = defaultMonths.reduce((total, entry) => total + entry.rows, 0);
  return {
    monthsAhead,
    missing: missing.map((row) => String(row.suffix)),
    monthlyPartitions: Number(monthly[0]?.n ?? 0),
    defaultRows,
    defaultRowsCapped: defaultRows >= cap,
    defaultMonths,
  };
};

/**
 * Calls the database function the deploy cron also calls, so both produce the same partitions with the same guards
 * (the TRUNCATE trigger and the role privileges). The function returns void, which Prisma cannot deserialize, so the
 * result is projected through a subquery.
 */
export const ensureJournalPartitions = async (db: PrismaLike, monthsAhead: number): Promise<void> => {
  const months = Math.floor(monthsAhead);
  if (!(months >= 1 && months <= MAX_PARTITION_MONTHS_AHEAD)) {
    throw new Error(`monthsAhead must be between 1 and ${MAX_PARTITION_MONTHS_AHEAD} (got ${monthsAhead})`);
  }
  await db.$queryRawUnsafe("SELECT 1 AS ok FROM (SELECT ensure_journal_line_partitions($1::int)) AS ensured", months);
};

export interface DefaultPartitionRepairMonth {
  month: string;
  /** Rows found in the default partition for the month. */
  found: number;
  /** Rows now in the month's partition (equals `found` after a successful repair; 0 in a dry run). */
  moved: number;
}

export interface DefaultPartitionRepairResult {
  dryRun: boolean;
  months: DefaultPartitionRepairMonth[];
  totalRows: number;
}

const MONTH_RE = /^\d{4}_(0[1-9]|1[0-2])$/;

/**
 * Moves the rows stranded in `journal_lines_default` into their own monthly partitions, in ONE transaction.
 *
 * This edits ledger rows, so it is an operator action: it needs the ledger maintenance flag
 * (`pgw.ledger_maintenance`), which the append-only guard honours only for a superuser or a member of
 * `pgw_ledger_maintenance`. The application role is neither, so the guard refuses the DELETE and the whole
 * transaction rolls back; run it with a privileged `DATABASE_URL` (`scripts/repair-journal-default-partition.ts`).
 *
 * Per month: copy the rows into a temporary table, delete them from the default partition (it must be empty of that
 * month before the partition can be created), create and guard the partition, insert the rows back (they route to the
 * new partition with their ids and `created_at` unchanged, so every shard sequence and balance stays valid), and
 * verify the counts. Any mismatch throws and rolls everything back. The default partition is locked ACCESS EXCLUSIVE
 * for the duration, with a short lock timeout, so a posting that needs it fails fast instead of queueing.
 */
export const repairDefaultPartition = async (
  db: Any,
  options: { dryRun?: boolean; lockTimeoutMs?: number } = {},
): Promise<DefaultPartitionRepairResult> => {
  const dryRun = options.dryRun !== false;
  if (dryRun) {
    const inspection = await inspectJournalPartitions(db as PrismaLike, { monthsAhead: 1, cap: 1_000_000 });
    return {
      dryRun: true,
      months: inspection.defaultMonths.map((entry) => ({ month: entry.month, found: entry.rows, moved: 0 })),
      totalRows: inspection.defaultRows,
    };
  }
  const lockTimeoutMs = Math.max(100, Math.floor(options.lockTimeoutMs ?? 5_000));
  return db.$transaction(
    async (tx: Any): Promise<DefaultPartitionRepairResult> => {
      await tx.$queryRawUnsafe("SELECT set_config('pgw.ledger_maintenance', 'on', true)");
      await tx.$queryRawUnsafe(`SELECT set_config('lock_timeout', '${lockTimeoutMs}ms', true)`);
      await tx.$executeRawUnsafe("LOCK TABLE journal_lines_default IN ACCESS EXCLUSIVE MODE");
      // Explicit, parent-ordered column list: a partition's physical column order can differ from the parent's, and a
      // positional `SELECT *` into `INSERT` would then put values into the wrong columns.
      const columns = String(
        (
          await rows<{ cols: string }>(
            tx,
            `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS cols
             FROM pg_attribute WHERE attrelid = 'journal_lines'::regclass AND attnum > 0 AND NOT attisdropped`,
          )
        )[0]?.cols ?? "",
      );
      if (!columns) throw new Error("cannot read the journal_lines columns");
      const found = await rows<{ month: string; first_day: string; next_day: string; n: number }>(
        tx,
        `SELECT to_char(date_trunc('month', created_at), 'YYYY_MM') AS month,
                to_char(date_trunc('month', created_at), 'YYYY-MM-DD') AS first_day,
                to_char(date_trunc('month', created_at) + interval '1 month', 'YYYY-MM-DD') AS next_day,
                count(*)::int AS n
         FROM journal_lines_default GROUP BY 1, 2, 3 ORDER BY 1`,
      );
      const months: DefaultPartitionRepairMonth[] = [];
      for (const entry of found) {
        const month = String(entry.month);
        if (!MONTH_RE.test(month)) throw new Error(`unexpected partition month '${month}'`);
        const count = Number(entry.n);
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE pgw_moved_lines ON COMMIT DROP AS
           SELECT ${columns} FROM journal_lines_default WHERE created_at >= $1::timestamp AND created_at < $2::timestamp`,
          entry.first_day,
          entry.next_day,
        );
        const copied = Number((await rows<{ n: number }>(tx, "SELECT count(*)::int AS n FROM pgw_moved_lines"))[0]?.n ?? 0);
        if (copied !== count) throw new Error(`month ${month}: copied ${copied} rows, expected ${count}`);
        const deleted = await tx.$executeRawUnsafe(
          "DELETE FROM journal_lines_default WHERE created_at >= $1::timestamp AND created_at < $2::timestamp",
          entry.first_day,
          entry.next_day,
        );
        if (Number(deleted) !== count) throw new Error(`month ${month}: deleted ${deleted} rows, expected ${count}`);
        await tx.$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS "journal_lines_${month}" PARTITION OF "journal_lines" FOR VALUES FROM ('${entry.first_day}') TO ('${entry.next_day}')`,
        );
        await tx.$queryRawUnsafe("SELECT 1 AS ok FROM (SELECT pgw_guard_journal_line_partition($1::regclass)) AS guarded", `"journal_lines_${month}"`);
        const inserted = await tx.$executeRawUnsafe(`INSERT INTO journal_lines (${columns}) SELECT ${columns} FROM pgw_moved_lines`);
        if (Number(inserted) !== count) throw new Error(`month ${month}: inserted ${inserted} rows, expected ${count}`);
        const landed = Number(
          (await rows<{ n: number }>(tx, `SELECT count(*)::int AS n FROM "journal_lines_${month}"`))[0]?.n ?? 0,
        );
        if (landed < count) throw new Error(`month ${month}: only ${landed} of ${count} rows reached the partition`);
        await tx.$executeRawUnsafe("DROP TABLE pgw_moved_lines");
        months.push({ month, found: count, moved: count });
      }
      const left = Number((await rows<{ n: number }>(tx, "SELECT count(*)::int AS n FROM journal_lines_default"))[0]?.n ?? 0);
      if (left !== 0) throw new Error(`${left} rows are still in the default partition`);
      return { dryRun: false, months, totalRows: months.reduce((total, entry) => total + entry.moved, 0) };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
};
