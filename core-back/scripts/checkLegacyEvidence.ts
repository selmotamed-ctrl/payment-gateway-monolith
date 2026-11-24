/**
 * Pre-v36 upgrade guard (GAP-074).
 *
 * v36 moved KYB documents and reconciliation files into the object vault and
 * dropped the legacy ciphertext columns. Bytes that existed before v36 cannot
 * be recreated after the drop, so an operator must export/backfill them first.
 * This check refuses an upgrade when those columns still exist and hold rows.
 *
 * Run before applying migrations on a database that predates v36:
 *   bun run legacy-evidence:check
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const pool = new Pool({ connectionString: url, max: 1 });

const LEGACY = [
  { table: "kyb_documents", column: "content_ciphertext" },
  { table: "reconciliation_runs", column: "file_content" },
] as const;

let failed = false;
for (const item of LEGACY) {
  const present = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [item.table, item.column],
  );
  if (present.rowCount === 0) continue;
  const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM "${item.table}" WHERE "${item.column}" IS NOT NULL`);
  const count = Number(rows.rows[0]?.count ?? 0);
  if (count > 0) {
    failed = true;
    console.error(
      `${item.table}.${item.column} still holds ${count} non-null row(s). `
      + "Export/backfill this evidence into the object vault BEFORE applying migration 20261112000000_v36_enterprise_object_storage_engine.",
    );
  }
}
await pool.end();
if (failed) process.exit(1);
console.log("No pre-v36 legacy evidence remains in the dropped-column tables.");
