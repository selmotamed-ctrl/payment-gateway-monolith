// Usage: cd core-back && TZ=UTC bun scripts/rehearse-migrations-pglite.ts
//
// Applies core-back's real migration chain to an embedded PostgreSQL (PGlite) through the real
// `prisma migrate deploy`, then exercises the partition function and the index guard.
import { cpSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


const CORE = join(import.meta.dir, "..").split("\\").join("/");
const { PGlite } = await import(`${CORE}/node_modules/@electric-sql/pglite/dist/index.js`);
const { PGLiteSocketServer } = await import(`${CORE}/node_modules/@electric-sql/pglite-socket/dist/index.js`);
const { pg_trgm } = await import(`${CORE}/node_modules/@electric-sql/pglite/dist/contrib/pg_trgm.js`);
const { btree_gin } = await import(`${CORE}/node_modules/@electric-sql/pglite/dist/contrib/btree_gin.js`);

const work = join(tmpdir(), `pgw-migration-rehearsal-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "prisma"), { recursive: true });
cpSync(join(CORE, "prisma/migrations"), join(work, "prisma/migrations"), { recursive: true });
cpSync(join(CORE, "prisma/schema.prisma"), join(work, "prisma/schema.prisma"));
// Test-only: PGlite has no pg_stat_statements (a monitoring extension).
for (const dir of readdirSync(join(work, "prisma/migrations"))) {
  const file = join(work, "prisma/migrations", dir, "migration.sql");
  try {
    const sql = readFileSync(file, "utf8");
    if (sql.includes("pg_stat_statements")) {
      writeFileSync(file, sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_stat_statements[^;]*;/g, "-- (test) pg_stat_statements skipped"));
    }
  } catch { /* migration_lock.toml */ }
}
writeFileSync(join(work, "prisma.config.ts"),
  `export default { schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" }, datasource: { url: process.env.DATABASE_URL } };\n`);

const db = await PGlite.create({ extensions: { pg_trgm, btree_gin } });
const port = 55500 + Math.floor(Math.random() * 300);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); };

try {
  // Async: the socket server runs in this process, so the event loop must keep serving it.
  const child = Bun.spawn(["bun", join(CORE, "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    cwd: work,
    env: { ...process.env, DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable&connection_limit=1` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const deploy = { status };
  const deployOut = `${stdout}${stderr}`;
  check("full migration chain applies via prisma migrate deploy", deploy.status === 0, deploy.status === 0 ? "" : deployOut.slice(-2500));
  await server.stop();
  if (deploy.status !== 0) throw new Error("deploy failed");
  // PGlite takes the host's zone name ("GMT+0200"), which PostgreSQL rejects; the app runs in UTC.
  await db.exec(`SET TimeZone = 'UTC'`);

  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as Record<string, unknown>;

  const version = await one(`SELECT version FROM schema_versions WHERE id = 1`);
  const required = Number(/REQUIRED_SCHEMA_VERSION = (\d+)/.exec(readFileSync(join(CORE, "prisma/schemaVersion.ts"), "utf8"))?.[1]);
  check("schema version equals REQUIRED_SCHEMA_VERSION", Number(version.version) === required, `${version.version} vs ${required}`);

  const targets: { journal_lines_entry_id_created_at_idx: string; journal_lines_account_id_cov_idx: string } = {
    journal_lines_entry_id_created_at_idx: "USING btree (entry_id, created_at) INCLUDE (gl_account_id, direction, amount, id)",
    journal_lines_account_id_cov_idx: "USING btree (gl_account_id, created_at) INCLUDE (direction, amount, entry_id, id)",
  };
  const defOf = async (name: string) => String((await one(`SELECT pg_get_indexdef($1::regclass) AS d`, [name])).d);
  for (const [name, tail] of Object.entries(targets)) {
    const def = await defOf(name);
    check(`${name} has its exact target definition after the chain`, def.endsWith(tail), def);
  }

  const proc = await one(`SELECT proconfig FROM pg_proc WHERE proname = 'ensure_journal_line_partitions'`);
  const config = String(proc.proconfig);
  check("function pins lock_timeout and UTC", /lock_timeout=5s/.test(config) && /TimeZone=UTC|timezone=UTC/i.test(config), config);

  // Re-running the function leaves existing partitions alone.
  const current = await one(`SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY_MM') AS m`);
  const hot = `journal_lines_${current.m}`;
  await db.exec(`ALTER TABLE "${hot}" SET (autovacuum_analyze_scale_factor = 0.5)`);
  await db.exec(`SELECT ensure_journal_line_partitions(24)`);
  const opts = await one(`SELECT reloptions FROM pg_class WHERE relname = $1`, [hot]);
  check("re-run does not reset an existing partition's storage options", String(opts.reloptions).includes("autovacuum_analyze_scale_factor=0.5"), String(opts.reloptions));

  // A month whose rows sit in journal_lines_default is skipped, the rest are still created.
  const far = await one(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '30 months')::date::text AS d, to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '30 months', 'YYYY_MM') AS m, to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '31 months', 'YYYY_MM') AS next`);
  const hasDefault = await one(`SELECT to_regclass('journal_lines_default') IS NOT NULL AS ok`);
  check("journal_lines_default exists", hasDefault.ok === true);
  const cols = (await db.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'journal_lines' ORDER BY ordinal_position`)).rows as Array<Record<string, string>>;
  const values: Record<string, string> = {};
  for (const col of cols) {
    const name = col.column_name ?? "";
    const dataType = col.data_type ?? "";
    if (!name || col.is_nullable === "YES" || col.column_default) continue;
    values[name] =
      name === "created_at" ? `'${far.d} 12:00:00'` :
      name === "direction" ? `'DEBIT'` :
      name === "amount" ? `1` :
      /int/.test(dataType) ? `1` :
      dataType === "uuid" ? `gen_random_uuid()` :
      /timestamp/.test(dataType) ? `now()` :
      `'x'`;
  }
  if (!values.created_at) values.created_at = `'${far.d} 12:00:00'`;
  await db.exec(`SET session_replication_role = replica; INSERT INTO journal_lines (${Object.keys(values).join(", ")}) VALUES (${Object.values(values).join(", ")}); SET session_replication_role = origin;`);
  const inDefault = await one(`SELECT count(*)::int AS n FROM journal_lines_default`);
  check("a far-future row landed in journal_lines_default", Number(inDefault.n) === 1, String(inDefault.n));

  const warnings: string[] = [];
  let threw: string | null = null;
  try {
    const res = await db.query(`SELECT ensure_journal_line_partitions(40)`, [], { onNotice: (n: { message: string }) => warnings.push(n.message) } as never);
    void res;
  } catch (error) {
    threw = (error as Error).message;
  }
  check("ensure_journal_line_partitions(40) does not abort on the conflicting month", threw === null, threw ?? "");
  const skipped = await one(`SELECT to_regclass($1) IS NULL AS missing`, [`journal_lines_${far.m}`]);
  const later = await one(`SELECT to_regclass($1) IS NOT NULL AS made`, [`journal_lines_${far.next}`]);
  check("the conflicting month is skipped (its rows stay in default)", skipped.missing === true);
  check("later months are still created", later.made === true);
  check("a WARNING names the skipped month", warnings.some((w) => w.includes(`journal_lines_${far.m}`)), warnings.join(" | ").slice(0, 300));

  // The pre-fix behaviour, for contrast: a plain CREATE ... PARTITION OF aborts with check_violation.
  let sqlstate = "";
  try {
    await db.exec(`CREATE TABLE "journal_lines_${far.m}" PARTITION OF journal_lines FOR VALUES FROM ('${far.d}') TO ('${far.d}'::date + interval '1 month')`);
  } catch (error) {
    sqlstate = String((error as { code?: string }).code ?? (error as Error).message);
  }
  check("plain partition creation raises check_violation (23514), the code the function now handles", sqlstate === "23514", sqlstate);

  // The index guard of 20261109210000 does not rebuild an index that already covers its payload.
  const before = await one(`SELECT 'journal_lines_entry_id_created_at_idx'::regclass::oid AS oid`);
  const migration = readFileSync(join(work, "prisma/migrations/20261109210000_ledger_query_and_index_optimization/migration.sql"), "utf8").split("\r\n").join("\n");
  const doStart = migration.indexOf("DO $$\nDECLARE\n  spec RECORD;");
  if (doStart < 0) throw new Error("index guard DO block not found in the migration");
  const doBlock = migration.slice(doStart, migration.indexOf("END $$;", doStart) + "END $$;".length);
  await db.exec(doBlock);
  const after = await one(`SELECT 'journal_lines_entry_id_created_at_idx'::regclass::oid AS oid`);
  check("index guard skips an index that already has its INCLUDE payload", String(before.oid) === String(after.oid), `${before.oid} -> ${after.oid}`);

  // ... and does rebuild one that lacks it.
  // ... and does rebuild the narrower shape left by 20261103180000_storage_hardening.
  await db.exec(`DROP INDEX journal_lines_account_id_cov_idx; CREATE INDEX journal_lines_account_id_cov_idx ON journal_lines (gl_account_id, created_at) INCLUDE (direction, amount);`);
  const narrow = await defOf("journal_lines_account_id_cov_idx");
  await db.exec(doBlock);
  const rebuilt = await defOf("journal_lines_account_id_cov_idx");
  check("index guard upgrades the narrower INCLUDE (direction, amount) to the target", !narrow.endsWith(targets.journal_lines_account_id_cov_idx) && rebuilt.endsWith(targets.journal_lines_account_id_cov_idx), `${narrow} -> ${rebuilt}`);
  // The runbook: pre-build the target indexes online on a populated database, then the migration's
  // guard must skip the blocking rebuild. Start from the old (pre-v25) shapes.
  await db.exec(`
    DROP INDEX journal_lines_entry_id_created_at_idx;
    CREATE INDEX journal_lines_entry_id_created_at_idx ON journal_lines (entry_id, created_at);
    DROP INDEX journal_lines_account_id_cov_idx;
    CREATE INDEX journal_lines_account_id_cov_idx ON journal_lines (gl_account_id, created_at) INCLUDE (direction, amount);
  `);
  const runbook = [
    { old: "journal_lines_entry_id_created_at_idx", tmp: "journal_lines_entry_cov_new", cols: "(entry_id, created_at) INCLUDE (gl_account_id, direction, amount, id)" },
    { old: "journal_lines_account_id_cov_idx", tmp: "journal_lines_account_cov_new", cols: "(gl_account_id, created_at) INCLUDE (direction, amount, entry_id, id)" },
  ];
  const partitions = (await db.query(`SELECT inhrelid::regclass::text AS p FROM pg_inherits WHERE inhparent = 'journal_lines'::regclass ORDER BY 1`)).rows as Array<{ p: string }>;
  let concurrentNote = "CONCURRENTLY";
  for (const spec of runbook) {
    await db.exec(`CREATE INDEX ${spec.tmp} ON ONLY journal_lines ${spec.cols}`);
    for (const { p } of partitions) {
      const child = `${p}_${spec.tmp.replace("journal_lines_", "")}`.replace(/"/g, "").slice(0, 63);
      try {
        await db.exec(`CREATE INDEX CONCURRENTLY ${child} ON ${p} ${spec.cols}`);
      } catch {
        concurrentNote = "plain (PGlite refused CONCURRENTLY)";
        await db.exec(`CREATE INDEX ${child} ON ${p} ${spec.cols}`);
      }
      await db.exec(`ALTER INDEX ${spec.tmp} ATTACH PARTITION ${child}`);
    }
    const valid = await one(`SELECT indisvalid FROM pg_index WHERE indexrelid = $1::regclass`, [spec.tmp]);
    check(`runbook: ${spec.tmp} is valid once every partition is attached`, valid.indisvalid === true, String(valid.indisvalid));
    await db.exec(`DROP INDEX ${spec.old}; ALTER INDEX ${spec.tmp} RENAME TO ${spec.old};`);
  }
  const prebuilt = await one(`SELECT 'journal_lines_account_id_cov_idx'::regclass::oid AS oid`);
  await db.exec(doBlock);
  const afterGuard = await one(`SELECT 'journal_lines_account_id_cov_idx'::regclass::oid AS oid`);
  check(`runbook: the migration guard skips the pre-built indexes (built ${concurrentNote})`,
    String(prebuilt.oid) === String(afterGuard.oid) && (await defOf("journal_lines_account_id_cov_idx")).endsWith(targets.journal_lines_account_id_cov_idx)
      && (await defOf("journal_lines_entry_id_created_at_idx")).endsWith(targets.journal_lines_entry_id_created_at_idx),
    `${prebuilt.oid} -> ${afterGuard.oid}`);
} catch (error) {
  if (!results.some(([, ok]) => !ok)) check("harness", false, (error as Error).stack ?? String(error));
} finally {
  try { await server.stop(); } catch { /* already stopped */ }
  for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : detail ? `  (${detail})` : ""}`);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
