-- ============================================================================
-- PostgreSQL 18 storage engine: partial, covering, BRIN and trigram indexes.
-- The tables themselves are part of the Prisma baseline migration.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ----------------------------------------------------------------------------
-- 1. Transactional outbox / audit outbox: partial indexes only index work
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS "outbox_events_unprocessed_idx";
CREATE INDEX IF NOT EXISTS "outbox_events_unprocessed_idx"
  ON "outbox_events" ("id" ASC)
  WHERE "processed_at" IS NULL;

DROP INDEX IF EXISTS "outbox_events_created_idx";
CREATE INDEX IF NOT EXISTS "outbox_events_created_brin_idx"
  ON "outbox_events" USING brin ("created_at");

DROP INDEX IF EXISTS "audit_outbox_unshipped_idx";
CREATE INDEX IF NOT EXISTS "audit_outbox_unshipped_idx"
  ON "audit_outbox" ("created_at" ASC, "id" ASC)
  WHERE "shipped_at" IS NULL;

-- ----------------------------------------------------------------------------
-- 2. Lean append-only ledger: covering + BRIN
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "journal_lines_account_id_cov_idx"
  ON "journal_lines" ("gl_account_id", "id" ASC)
  INCLUDE ("direction", "amount", "created_at");

CREATE INDEX IF NOT EXISTS "journal_lines_created_brin_idx"
  ON "journal_lines" USING brin ("created_at");

-- ----------------------------------------------------------------------------
-- 3. Partial indexes for worker claim loops
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "payment_attempts_active_expiry_partial_idx"
  ON "payment_attempts" ("expires_at" ASC, "status")
  INCLUDE ("id", "substatus")
  WHERE "terminal_at" IS NULL;

CREATE INDEX IF NOT EXISTS "payment_attempts_active_poll_partial_idx"
  ON "payment_attempts" ("next_check_at" ASC)
  INCLUDE ("id", "status", "route_id")
  WHERE "next_check_at" IS NOT NULL AND "terminal_at" IS NULL;

CREATE INDEX IF NOT EXISTS "inbound_events_unprocessed_partial_idx"
  ON "inbound_events" ("received_at" ASC)
  INCLUDE ("id", "channel_id", "gateway_id", "attempt_id")
  WHERE "processed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "background_jobs_queued_partial_idx"
  ON "background_jobs" ("available_at" ASC)
  INCLUDE ("id", "job_type", "reference_type", "reference_id")
  WHERE "state" = 'QUEUED';

CREATE INDEX IF NOT EXISTS "notifications_queued_partial_idx"
  ON "notifications" ("next_attempt_at" ASC)
  INCLUDE ("id", "channel", "template_code")
  WHERE "status" = 'QUEUED';

-- ----------------------------------------------------------------------------
-- 4. Covering + external reference indexes on payment_attempts
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "payment_attempts_provider_ref_idx"
  ON "payment_attempts" ("provider_reference")
  WHERE "provider_reference" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "payment_attempts_gateway_ref_idx"
  ON "payment_attempts" ("gateway_reference")
  WHERE "gateway_reference" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "payment_attempts_network_ref_idx"
  ON "payment_attempts" ("network_reference")
  WHERE "network_reference" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "payment_attempts_merchant_keyset_cov_idx"
  ON "payment_attempts" ("merchant_id", "created_at" DESC, "id" DESC)
  INCLUDE ("reference", "status", "total_charged_amount", "net_merchant_amount", "currency", "rail_id");

CREATE INDEX IF NOT EXISTS "payment_attempts_created_brin_idx"
  ON "payment_attempts" USING brin ("created_at");

-- ----------------------------------------------------------------------------
-- 5. pg_trgm GIN indexes for the 20-group deep search
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "merchants_trgm_search_idx"
  ON "merchants" USING gin (
    "legal_name" gin_trgm_ops,
    "trade_name" gin_trgm_ops,
    "contact_email" gin_trgm_ops,
    "contact_phone" gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS "join_requests_trgm_search_idx"
  ON "join_requests" USING gin ("decision_reason_code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_trgm_search_idx"
  ON "users" USING gin ("email" gin_trgm_ops, "phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "payment_attempts_trgm_search_idx"
  ON "payment_attempts" USING gin (
    "reference" gin_trgm_ops,
    "provider_reference" gin_trgm_ops,
    "gateway_reference" gin_trgm_ops,
    "network_reference" gin_trgm_ops
  );

-- ----------------------------------------------------------------------------
-- 6. Audit hash-chain ordering helper
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "audit_outbox_shipped_brin_idx"
  ON "audit_outbox" USING brin ("shipped_at");
