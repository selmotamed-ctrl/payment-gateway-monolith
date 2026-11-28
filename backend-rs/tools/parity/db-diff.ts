/**
 * Semantic PostgreSQL differ for dual-database write parity runs.
 *
 * Scenario: restore the same dump into database A (TS writes) and database B (Rust writes), run
 * the same scripted write scenario against each implementation, then compare the two databases by
 * meaning rather than by physical bytes.
 *
 * What it compares
 * ----------------
 * 1. Every base table in `public`:
 *    - `count(*)`
 *    - a row-set checksum: each row is hashed from `jsonb_build_array(<non-ignored columns>)`
 *      in column order; rows are sorted by that hash before aggregation, so physical order and
 *      insertion order do not matter.
 * 2. Ledger balances (exact): `gl_account_shards.current_balance` and `line_seq` per business
 *    account, joined to `gl_accounts` and ordered by account type/currency/owner/gateway/env/
 *    credential/shard. Newly generated account ids are therefore irrelevant.
 * 3. Journal control totals (exact): debit and credit sums and line counts per currency.
 * 4. Outbox counts (exact): per topic, split by processed and parked, plus the total.
 *
 * Driver: Bun's built-in SQL client (`Bun.SQL`). No new dependency. If the runtime has no
 * `Bun.SQL`, the tool prints `PG_DRIVER_MISSING` and exits 2; run it with Bun >= 1.2. `pg` is
 * deliberately not required and is not silently substituted.
 *
 * Volatile columns
 * ----------------
 * Generated primary keys and clock/claim columns are ignored by default (see
 * `DEFAULT_IGNORE_COLUMNS`). A FK column that points at a generated id is NOT ignored
 * automatically: a scenario with new parents must list its ids/FKs in a rules file, and should
 * compare the child relationship through business keys instead.
 *
 * Run:
 *   DATABASE_URL=postgres://.../parity_a DATABASE_URL_B=postgres://.../parity_b \
 *     bun backend-rs/tools/parity/db-diff.ts
 *
 * Options:
 *   --a <url> | --b <url>        Override DATABASE_URL / DATABASE_URL_B.
 *   --tables t1,t2               Only these tables (base tables still filtered by pg_class).
 *   --ignore-columns c1,c2       Extra global ignored columns.
 *   --strict-ids                 Keep `id` in the checksum (the two databases must share ids).
 *   --rules <file>               JSON rules: { ignoreColumns, tables: { <table>: { ignoreColumns, skip } } }
 *   --json <file>                Write the full report as JSON.
 *   --verbose                    Print each table as it is compared.
 *   --help
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORE_COLUMNS = [
  "id",
  "claimed_by",
  "request_id",
  "trace_id",
  "webhook_id",
  "nonce",
];

/** Any `*_at` / `*At` column is a clock reading: volatile by definition (design ch.8 §3.4). */
export const isTimestampColumn = (column: string): boolean =>
  column.endsWith("_at") || /[a-z]At$/.test(column) || column === "timestamp";

export interface DbDiffRules {
  ignoreColumns?: string[];
  tables?: Record<string, { ignoreColumns?: string[]; skip?: boolean; note?: string }>;
}

export interface TableDiffResult {
  table: string;
  status: "equal" | "diff" | "skipped";
  aCount?: string;
  bCount?: string;
  aChecksum?: string;
  bChecksum?: string;
  columnsCompared?: number;
  reason?: string;
}

export interface ExactCheck {
  name: string;
  equal: boolean;
  aRows: number;
  bRows: number;
  /** First differing row pair, bounded, for a readable failure. */
  sample?: { index: number; a: string[]; b: string[] };
  note?: string;
}

export interface DbDiffReport {
  databases: { a: string; b: string };
  tables: TableDiffResult[];
  exact: ExactCheck[];
  summary: {
    tables: number;
    equal: number;
    diff: number;
    skipped: number;
    exactChecks: number;
    exactFailed: number;
  };
}

interface SqlClient {
  unsafe: (query: string) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

const bunSql = (): unknown => {
  const bun = (globalThis as { Bun?: { SQL?: unknown } }).Bun;
  return bun?.SQL;
};

const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<invalid url>";
  }
};

const withUtc = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("options")) {
      parsed.searchParams.set("options", "-c timezone=UTC");
    }
    return parsed.toString();
  } catch {
    return url;
  }
};

const connect = (url: string): SqlClient => {
  const SQL = bunSql();
  if (typeof SQL !== "function") {
    throw new Error(
      "PG_DRIVER_MISSING: this Bun runtime has no built-in SQL client (Bun.SQL). " +
        "Run db-diff with Bun >= 1.2, or install `pg` in the workspace and swap the driver.",
    );
  }
  const sql = new (SQL as new (url: string, options?: Record<string, unknown>) => {
    unsafe: (query: string) => Promise<Record<string, unknown>[]>;
    close: () => Promise<void>;
  })(withUtc(url), { max: 2 });
  return {
    unsafe: (query) => sql.unsafe(query),
    close: () => sql.close(),
  };
};

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const text = (value: unknown): string => {
  if (value === null || value === undefined) return "<null>";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const tableExists = async (sql: SqlClient, table: string): Promise<boolean> => {
  const rows = await sql.unsafe(
    `select to_regclass('public.${table.replaceAll("'", "''")}') is not null as present`,
  );
  return rows[0]?.present === true;
};

const listTables = async (sql: SqlClient): Promise<string[]> => {
  const rows = await sql.unsafe(
    `select c.relname as table_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
      order by c.relname`,
  );
  return rows.map((row) => String(row.table_name));
};

const listColumns = async (sql: SqlClient): Promise<Map<string, string[]>> => {
  const rows = await sql.unsafe(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
  );
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    const table = String(row.table_name);
    const bucket = byTable.get(table) ?? [];
    bucket.push(String(row.column_name));
    byTable.set(table, bucket);
  }
  return byTable;
};

const tableRowset = async (
  sql: SqlClient,
  table: string,
  columns: string[],
): Promise<{ count: string; checksum: string }> => {
  const expressions = columns.map((column) => quoteIdent(column)).join(", ");
  const query =
    `select count(*)::text as n, coalesce(md5(string_agg(h, '|' order by h)), '') as checksum ` +
    `from (select md5(jsonb_build_array(${expressions})::text) as h from ${quoteIdent(table)}) s`;
  const rows = await sql.unsafe(query);
  return {
    count: text(rows[0]?.n),
    checksum: text(rows[0]?.checksum),
  };
};

const exactLedgerBalances = async (sql: SqlClient): Promise<string[][]> => {
  const rows = await sql.unsafe(
    `select ga.account_type::text as account_type,
            ga.currency::text as currency,
            coalesce(ga.env, '') as env,
            coalesce(ga.owner_id::text, '') as owner_id,
            coalesce(ga.gateway_id::text, '') as gateway_id,
            coalesce(ga.credential_set_id::text, '') as credential_set_id,
            gs.shard_id::text as shard_id,
            gs.current_balance::text as balance,
            gs.line_seq::text as line_seq
       from gl_account_shards gs
       join gl_accounts ga on ga.id = gs.gl_account_id
      order by 1, 2, 3, 4, 5, 6, 7`,
  );
  return rows.map((row) => Object.values(row).map(text));
};

const exactJournalControlTotals = async (sql: SqlClient): Promise<string[][]> => {
  const rows = await sql.unsafe(
    `select ga.currency::text as currency,
            jl.direction::text as direction,
            count(*)::text as lines,
            sum(jl.amount)::text as total
       from journal_lines jl
       join gl_accounts ga on ga.id = jl.gl_account_id
      group by 1, 2
      order by 1, 2`,
  );
  return rows.map((row) => Object.values(row).map(text));
};

const exactOutboxCounts = async (sql: SqlClient): Promise<string[][]> => {
  const rows = await sql.unsafe(
    `select topic,
            (processed_at is not null)::text as processed,
            (parked_at is not null)::text as parked,
            count(*)::text as events
       from outbox_events
      group by 1, 2, 3
      order by 1, 2, 3`,
  );
  return rows.map((row) => Object.values(row).map(text));
};

const exactTotal = async (sql: SqlClient, table: string): Promise<string> => {
  if (!(await tableExists(sql, table))) return "<table missing>";
  const rows = await sql.unsafe(`select count(*)::text as n from ${quoteIdent(table)}`);
  return text(rows[0]?.n);
};

const compareRows = (
  name: string,
  a: string[][],
  b: string[][],
  note?: string,
): ExactCheck => {
  if (a.length !== b.length) {
    return {
      name,
      equal: false,
      aRows: a.length,
      bRows: b.length,
      note: `${note ? `${note}; ` : ""}row count differs`,
    };
  }
  for (let index = 0; index < a.length; index += 1) {
    if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) {
      return {
        name,
        equal: false,
        aRows: a.length,
        bRows: b.length,
        sample: { index, a: a[index]!, b: b[index]! },
        ...(note ? { note } : {}),
      };
    }
  }
  return { name, equal: true, aRows: a.length, bRows: b.length, ...(note ? { note } : {}) };
};

const exactCheck = async (
  name: string,
  a: SqlClient,
  b: SqlClient,
  query: (sql: SqlClient) => Promise<string[][]>,
  note?: string,
): Promise<ExactCheck> => {
  try {
    return compareRows(name, await query(a), await query(b), note);
  } catch (error) {
    return {
      name,
      equal: false,
      aRows: 0,
      bRows: 0,
      note: `query failed: ${(error as Error).message}`,
    };
  }
};

const loadRules = (file: string | undefined): DbDiffRules => {
  if (!file) return {};
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as DbDiffRules;
  if (parsed && typeof parsed === "object") return parsed;
  throw new Error(`${file} must contain a JSON object`);
};

export const diffDatabases = async (options: {
  a: string;
  b: string;
  tables?: string[];
  ignoreColumns?: string[];
  strictIds?: boolean;
  rules?: DbDiffRules;
  verbose?: boolean;
}): Promise<DbDiffReport> => {
  const a = connect(options.a);
  const b = connect(options.b);
  try {
    const globalIgnore = new Set([
      ...DEFAULT_IGNORE_COLUMNS.filter((column) => !(options.strictIds && column === "id")),
      ...(options.ignoreColumns ?? []),
      ...(options.rules?.ignoreColumns ?? []),
    ]);
    const columnsByTable = await listColumns(a);
    const available = new Set(await listTables(a));
    const bTables = new Set(await listTables(b));
    const requested = options.tables
      ? options.tables.map((table) => table.trim()).filter((table) => table.length > 0)
      : [...new Set([...available, ...bTables])].sort();

    const tables: TableDiffResult[] = [];
    for (const table of requested) {
      if (!available.has(table) || !bTables.has(table)) {
        tables.push({
          table,
          status: "skipped",
          reason: !available.has(table) ? "missing in database A" : "missing in database B",
        });
        continue;
      }
      const tableRules = options.rules?.tables?.[table];
      if (tableRules?.skip) {
        tables.push({ table, status: "skipped", reason: tableRules.note ?? "skipped by rules file" });
        continue;
      }
      const ignore = new Set([...globalIgnore, ...(tableRules?.ignoreColumns ?? [])]);
      const columns = (columnsByTable.get(table) ?? []).filter(
        (column) => !ignore.has(column) && !isTimestampColumn(column),
      );
      try {
        const [left, right] = await Promise.all([
          tableRowset(a, table, columns),
          tableRowset(b, table, columns),
        ]);
        const equal = left.count === right.count && left.checksum === right.checksum;
        tables.push({
          table,
          status: equal ? "equal" : "diff",
          aCount: left.count,
          bCount: right.count,
          aChecksum: left.checksum,
          bChecksum: right.checksum,
          columnsCompared: columns.length,
        });
        if (options.verbose) {
          console.error(`${equal ? "=" : "≠"} ${table} (${left.count}/${right.count}, ${columns.length} columns)`);
        }
      } catch (error) {
        tables.push({ table, status: "skipped", reason: `query failed: ${(error as Error).message}` });
      }
    }

    const exact: ExactCheck[] = [];
    const ledgerPresent = (await tableExists(a, "gl_account_shards")) &&
      (await tableExists(b, "gl_account_shards"));
    if (ledgerPresent) {
      exact.push(
        await exactCheck(
          "ledger.balances",
          a,
          b,
          exactLedgerBalances,
          "gl_account_shards.current_balance and line_seq per business account",
        ),
      );
    } else {
      exact.push({
        name: "ledger.balances",
        equal: false,
        aRows: 0,
        bRows: 0,
        note: "gl_account_shards is missing in one database",
      });
    }
    if ((await tableExists(a, "journal_lines")) && (await tableExists(b, "journal_lines"))) {
      exact.push(
        await exactCheck(
          "ledger.journal_totals",
          a,
          b,
          exactJournalControlTotals,
          "debit/credit sums and line counts per currency",
        ),
      );
    }
    if ((await tableExists(a, "outbox_events")) && (await tableExists(b, "outbox_events"))) {
      exact.push(await exactCheck("outbox.by_topic", a, b, exactOutboxCounts));
      exact.push(
        compareRows(
          "outbox.total",
          [[await exactTotal(a, "outbox_events")]],
          [[await exactTotal(b, "outbox_events")]],
        ),
      );
    }

    const summary = {
      tables: tables.length,
      equal: tables.filter((table) => table.status === "equal").length,
      diff: tables.filter((table) => table.status === "diff").length,
      skipped: tables.filter((table) => table.status === "skipped").length,
      exactChecks: exact.length,
      exactFailed: exact.filter((check) => !check.equal).length,
    };
    return {
      databases: { a: redactUrl(options.a), b: redactUrl(options.b) },
      tables,
      exact,
      summary,
    };
  } finally {
    await a.close();
    await b.close();
  }
};

const printReport = (report: DbDiffReport): void => {
  console.log(`DB parity: A=${report.databases.a}`);
  console.log(`           B=${report.databases.b}`);
  const diffs = report.tables.filter((table) => table.status === "diff");
  for (const table of report.tables) {
    if (table.status === "equal") continue;
    if (table.status === "skipped") {
      console.log(`SKIP  ${table.table}: ${table.reason ?? "skipped"}`);
      continue;
    }
    console.log(
      `DIFF  ${table.table}: count ${table.aCount}/${table.bCount}, ` +
        `checksum ${table.aChecksum}/${table.bChecksum}`,
    );
  }
  for (const check of report.exact) {
    if (check.equal) {
      console.log(`OK    ${check.name} (${check.aRows} rows)`);
      continue;
    }
    console.log(`DIFF  ${check.name}: ${check.note ?? "rows differ"} (${check.aRows}/${check.bRows} rows)`);
    if (check.sample) {
      console.log(`      first difference at row ${check.sample.index}`);
      console.log(`      A: ${JSON.stringify(check.sample.a)}`);
      console.log(`      B: ${JSON.stringify(check.sample.b)}`);
    }
  }
  const { summary } = report;
  const verdict = summary.diff === 0 && summary.exactFailed === 0 ? "PASS" : "DIFFS";
  console.log(
    `\nRESULT: ${verdict} — ${summary.equal}/${summary.tables} tables equal, ${summary.diff} table diff(s), ` +
      `${summary.skipped} skipped; ${summary.exactChecks - summary.exactFailed}/${summary.exactChecks} exact checks passed`,
  );
  if (diffs.length > 0) {
    console.log("Run with --verbose to stream each table while it is compared.");
  }
};

const HELP = `Usage: DATABASE_URL=... DATABASE_URL_B=... bun backend-rs/tools/parity/db-diff.ts [options]

Options:
  --a <url>                 Database A (TS implementation). Default: DATABASE_URL.
  --b <url>                 Database B (Rust implementation). Default: DATABASE_URL_B.
  --tables <list>           Only these tables (comma separated).
  --ignore-columns <list>   Extra globally ignored columns.
  --strict-ids              Keep "id" in the table checksum.
  --rules <file>            JSON rules file (ignoreColumns, tables.<name>.ignoreColumns/skip).
  --json <file>             Write the full report as JSON.
  --verbose                 Stream table progress to stderr.
  --help

Exit codes: 0 equal, 1 differences, 2 harness/driver/connection error.
`;

interface CliOptions {
  a?: string;
  b?: string;
  tables?: string[];
  ignoreColumns?: string[];
  strictIds?: boolean;
  rules?: string;
  json?: string;
  verbose?: boolean;
  help?: boolean;
}

export const parseCli = (argv: string[]): CliOptions => {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const [flag, inline] = raw.startsWith("--") ? raw.split("=", 2) : [raw, undefined];
    const next = (): string => {
      if (inline !== undefined) return inline;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--a":
        options.a = next();
        break;
      case "--b":
        options.b = next();
        break;
      case "--tables":
        options.tables = next().split(",").map((entry) => entry.trim()).filter(Boolean);
        break;
      case "--ignore-columns":
        options.ignoreColumns = next().split(",").map((entry) => entry.trim()).filter(Boolean);
        break;
      case "--strict-ids":
        options.strictIds = true;
        break;
      case "--rules":
        options.rules = next();
        break;
      case "--json":
        options.json = next();
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${raw}`);
    }
  }
  return options;
};

const main = async (): Promise<number> => {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error(HELP);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const urlA = options.a ?? process.env.DATABASE_URL;
  const urlB = options.b ?? process.env.DATABASE_URL_B;
  if (!urlA || !urlB) {
    console.error(
      "DATABASE_URL and DATABASE_URL_B are required (or pass --a/--b). " +
        "Point A at the TS-written database and B at the Rust-written database.",
    );
    return 2;
  }
  try {
    const report = await diffDatabases({
      a: urlA,
      b: urlB,
      tables: options.tables,
      ignoreColumns: options.ignoreColumns,
      strictIds: options.strictIds === true,
      rules: loadRules(options.rules),
      verbose: options.verbose === true,
    });
    printReport(report);
    if (options.json) {
      const target = path.resolve(options.json);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`JSON report: ${target}`);
    }
    return report.summary.diff === 0 && report.summary.exactFailed === 0 ? 0 : 1;
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
};

if (import.meta.main) {
  process.exitCode = await main();
}
