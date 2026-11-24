/**
 * Read-only report of historical postings whose GL account currency does not
 * match the business object they settle. It never edits the append-only ledger;
 * corrections must go through the approved adjustment workflow.
 *
 * Usage: bun run currency:mismatch-report
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const pool = new Pool({ connectionString: url, max: 1 });
const query = `
WITH entry_currencies AS (
  SELECT je.id, je.ref_type, je.ref_id,
         array_agg(DISTINCT a.currency ORDER BY a.currency) AS currencies
  FROM journal_entries je
  JOIN journal_lines jl ON jl.entry_id = je.id
  JOIN gl_accounts a ON a.id = jl.gl_account_id
  WHERE je.ref_type IN ('SETTLEMENT_SWEEP', 'FEE_VARIANCE', 'ADJUSTMENT')
  GROUP BY je.id, je.ref_type, je.ref_id
), expected AS (
  SELECT ec.*,
    CASE
      WHEN ec.ref_type = 'ADJUSTMENT' THEN (
        SELECT w.currency::text FROM cashout_requests c JOIN wallets w ON w.id = c.wallet_id WHERE c.id::text = ec.ref_id
      )
      WHEN ec.ref_type = 'FEE_VARIANCE' THEN (
        SELECT pa.currency::text FROM payment_attempts pa
        WHERE ec.ref_id = 'fee-variance:' || pa.id::text
           OR ec.ref_id LIKE 'fee-variance:' || pa.id::text || ':%'
        LIMIT 1
      )
      WHEN ec.ref_type = 'SETTLEMENT_SWEEP' THEN (
        SELECT ri.currency::text FROM reconciliation_items ri WHERE ec.ref_id = 'settlement:' || ri.id::text LIMIT 1
      )
    END AS expected_currency
  FROM entry_currencies ec
)
SELECT * FROM expected
WHERE expected_currency IS NOT NULL AND NOT (expected_currency = ANY(currencies))
ORDER BY ref_type, ref_id
LIMIT 500;`;
const unmapped = `
SELECT je.ref_type, count(*)::int AS entries
FROM journal_entries je
WHERE je.ref_type IN ('SETTLEMENT_SWEEP', 'FEE_VARIANCE', 'ADJUSTMENT')
  AND je.ref_id NOT LIKE 'settlement:%'
  AND je.ref_id NOT LIKE 'fee-variance:%'
  AND je.ref_id NOT LIKE 'cashout:%'
  AND NOT EXISTS (SELECT 1 FROM cashout_requests c WHERE c.id::text = je.ref_id)
GROUP BY je.ref_type ORDER BY je.ref_type;`;
try {
  const mismatches = await pool.query(query);
  console.log(`Currency mismatches found: ${mismatches.rowCount}`);
  for (const row of mismatches.rows) {
    console.log(`${row.ref_type} ${row.ref_id}: expected ${row.expected_currency}, actual ${row.currencies.join(",")}`);
  }
  if ((mismatches.rowCount ?? 0) > 0) {
    console.log("Review each entry and correct it only through an approved adjustment; the ledger is append-only.");
  }
  const ambiguous = await pool.query(unmapped);
  if ((ambiguous.rowCount ?? 0) > 0) {
    console.log("Postings whose ref cannot be mapped to a business object (review separately):");
    for (const row of ambiguous.rows) console.log(`  ${row.ref_type}: ${row.entries}`);
  }
} finally {
  await pool.end();
}
