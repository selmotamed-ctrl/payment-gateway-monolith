-- ============================================================================
-- Storage hardening for PostgreSQL 18.
--
-- This migration closes the remaining DDL gaps of the storage blueprint:
--   * pg_stat_statements for the query observability the tuning relies on;
--   * the shard-range invariant on gl_account_shards;
--   * monthly range partitioning of the append-only journal_lines table;
--   * pg_trgm indexes for every direct text field used by the 20 search groups.
--
-- The development database is recreated from this migration history; the copy
-- step keeps existing local rows and the DEFAULT partition keeps writes safe
-- while the monthly partition maintenance cron is being installed.
-- ============================================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_stat_statements is not available in this PostgreSQL installation: %', SQLERRM;
END $$;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ----------------------------------------------------------------------------
-- 1. Sharded balances: the blueprint allows shard ids 0..15 only.
-- ----------------------------------------------------------------------------
ALTER TABLE "gl_account_shards"
  ALTER COLUMN "shard_id" SET DEFAULT 0;

ALTER TABLE "gl_account_shards"
  DROP CONSTRAINT IF EXISTS "gl_account_shards_shard_id_range";
ALTER TABLE "gl_account_shards"
  ADD CONSTRAINT "gl_account_shards_shard_id_range"
  CHECK ("shard_id" >= 0 AND "shard_id" < 16);

-- ----------------------------------------------------------------------------
-- 2. Monthly range partitioning of journal_lines.
--
-- A partitioned table must include the partition key in every unique/primary
-- key. The journal line id remains globally unique because the application
-- generates UUIDv7 values; the composite primary key is the PostgreSQL
-- requirement, not a change of the ledger identity.
-- ----------------------------------------------------------------------------

ALTER TABLE "journal_lines" RENAME TO "journal_lines_unpartitioned";
ALTER TABLE "journal_lines_unpartitioned"
  RENAME CONSTRAINT "journal_lines_pkey" TO "journal_lines_unpartitioned_pkey";
DROP INDEX IF EXISTS "journal_lines_account_id_cov_idx";
DROP INDEX IF EXISTS "journal_lines_created_brin_idx";
DROP INDEX IF EXISTS "journal_lines_entry_id_idx";
DROP INDEX IF EXISTS "journal_lines_gl_account_id_idx";

CREATE TABLE "journal_lines" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "entry_id" UUID NOT NULL,
  "gl_account_id" UUID NOT NULL,
  "direction" "JournalDirection" NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");

-- Create the historical and near-future monthly partitions. The DEFAULT
-- partition prevents an insert from failing if an old row or a clock jump
-- arrives before the maintenance cron has created its month.
DO $$
DECLARE
  start_date DATE := DATE '2023-01-01';
  end_date DATE := DATE '2028-12-01';
  next_date DATE;
  suffix TEXT;
BEGIN
  WHILE start_date < end_date LOOP
    next_date := (start_date + INTERVAL '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS "journal_lines_%s" PARTITION OF "journal_lines" FOR VALUES FROM (%L) TO (%L)',
      suffix, start_date, next_date
    );
    start_date := next_date;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS "journal_lines_default"
  PARTITION OF "journal_lines" DEFAULT;

INSERT INTO "journal_lines" (
  "id", "created_at", "updated_at", "entry_id", "gl_account_id", "direction", "amount"
)
SELECT
  "id", "created_at", "updated_at", "entry_id", "gl_account_id", "direction", "amount"
FROM "journal_lines_unpartitioned";

DROP TABLE "journal_lines_unpartitioned";

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_entry_id_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_gl_account_id_fkey"
  FOREIGN KEY ("gl_account_id") REFERENCES "gl_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amount_positive"
  CHECK ("amount" > 0);

CREATE INDEX "journal_lines_entry_id_created_at_idx"
  ON "journal_lines" ("entry_id", "created_at");

CREATE INDEX "journal_lines_account_id_cov_idx"
  ON "journal_lines" ("gl_account_id", "created_at")
  INCLUDE ("direction", "amount");

CREATE INDEX "journal_lines_created_brin_idx"
  ON "journal_lines" USING brin ("created_at");

CREATE OR REPLACE FUNCTION ensure_journal_line_partitions(months_ahead INT DEFAULT 6)
RETURNS void AS $$
DECLARE
  offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
BEGIN
  FOR offset IN 0..months_ahead - 1 LOOP
    start_date := (date_trunc('month', now())::date + (offset || ' months')::interval)::date;
    end_date := (start_date + interval '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS "journal_lines_%s" PARTITION OF "journal_lines" FOR VALUES FROM (%L) TO (%L)',
      suffix, start_date, end_date
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_journal_line_partitions(18);

-- ----------------------------------------------------------------------------
-- 3. pg_trgm GIN indexes for every direct text field used by Global Search.
-- ----------------------------------------------------------------------------

DROP INDEX IF EXISTS "merchants_trgm_search_idx";
CREATE INDEX "merchants_trgm_search_idx"
  ON "merchants" USING gin (
    "legal_name" gin_trgm_ops,
    "trade_name" gin_trgm_ops,
    "display_name" gin_trgm_ops,
    "contact_email" gin_trgm_ops,
    "contact_phone" gin_trgm_ops,
    "tax_id" gin_trgm_ops,
    "registration_no" gin_trgm_ops
  );

DROP INDEX IF EXISTS "payment_attempts_trgm_search_idx";
CREATE INDEX "payment_attempts_trgm_search_idx"
  ON "payment_attempts" USING gin (
    "reference" gin_trgm_ops,
    "provider_reference" gin_trgm_ops,
    "gateway_reference" gin_trgm_ops,
    "network_reference" gin_trgm_ops,
    "idempotency_key" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "gateway_inquiry_schedules_trgm_reason_idx"
  ON "gateway_inquiry_schedules" USING gin ("reason" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "approval_requests_trgm_subject_idx"
  ON "approval_requests" USING gin (
    "subject_id" gin_trgm_ops,
    "subject_type" gin_trgm_ops
  );

DROP INDEX IF EXISTS "join_requests_trgm_search_idx";
CREATE INDEX "join_requests_trgm_search_idx"
  ON "join_requests" USING gin (
    "decision_reason_code" gin_trgm_ops,
    "decision_notes" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "kyb_documents_trgm_file_name_idx"
  ON "kyb_documents" USING gin ("original_file_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "disputes_trgm_search_idx"
  ON "disputes" USING gin (
    "external_dispute_ref" gin_trgm_ops,
    "reason_code" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "adjustments_trgm_search_idx"
  ON "adjustments" USING gin (
    "reason" gin_trgm_ops,
    "external_dispute_ref" gin_trgm_ops,
    "provider_refund_ref" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "reconciliation_runs_trgm_file_name_idx"
  ON "reconciliation_runs" USING gin ("file_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "aml_cases_trgm_search_idx"
  ON "aml_cases" USING gin (
    "subject_id" gin_trgm_ops,
    "trigger_reason" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "aml_screenings_trgm_search_idx"
  ON "aml_screenings" USING gin (
    "subject_id" gin_trgm_ops,
    "provider_code" gin_trgm_ops,
    "provider_request_ref" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "aml_rules_trgm_search_idx"
  ON "aml_rules" USING gin ("code" gin_trgm_ops, "name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "regulatory_reports_trgm_search_idx"
  ON "regulatory_reports" USING gin (
    "subject_id" gin_trgm_ops,
    "submission_ref" gin_trgm_ops,
    "authority" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "gateways_trgm_search_idx"
  ON "gateways" USING gin (
    "code" gin_trgm_ops,
    "name" gin_trgm_ops,
    "operator" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "rails_trgm_search_idx"
  ON "rails" USING gin (
    "code" gin_trgm_ops,
    "name_en" gin_trgm_ops,
    "name_ar" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "audit_log_trgm_search_idx"
  ON "audit_log" USING gin (
    "action" gin_trgm_ops,
    "entity_type" gin_trgm_ops,
    "entity_id" gin_trgm_ops,
    "role" gin_trgm_ops
  );

-- ----------------------------------------------------------------------------
-- 4. Schema version.
-- ----------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 8, "updated_at" = now()
WHERE "id" = 1;
