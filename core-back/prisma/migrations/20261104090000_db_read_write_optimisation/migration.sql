-- ============================================================================
-- 2026-11-04 database read/write optimisation (core.storage / core.data).
--
-- Part A is exactly what prisma migrate diff generates from the schema
-- change (keep it in sync with schema.prisma). Part B holds the indexes that
-- Prisma cannot express (partial / expression / INCLUDE); they are owned by
-- raw SQL like the earlier storage-engine indexes. Review any future
-- migrate dev output so it does not drop Part B indexes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Part A: Prisma datamodel diff
-- ---------------------------------------------------------------------------
-- DropIndex
DROP INDEX "payment_attempts_link_id_idx";

-- DropIndex
DROP INDEX "payment_attempts_merchant_id_idx";

-- DropIndex
DROP INDEX "attempt_step_logs_attempt_id_idx";

-- DropIndex
DROP INDEX "reconciliation_items_run_id_idx";

-- DropIndex
DROP INDEX "audit_log_entity_type_entity_id_idx";

-- AlterTable
ALTER TABLE "audit_outbox" ADD COLUMN     "lease_until" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "rm_merchant_daily_stats" ADD COLUMN     "success_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "success_net_amount" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "approval_requests_subject_type_subject_id_state_idx" ON "approval_requests"("subject_type", "subject_id", "state");

-- CreateIndex
CREATE INDEX "payment_attempts_link_id_created_at_idx" ON "payment_attempts"("link_id", "created_at");

-- CreateIndex
CREATE INDEX "attempt_step_logs_attempt_id_created_at_idx" ON "attempt_step_logs"("attempt_id", "created_at");

-- CreateIndex
CREATE INDEX "inbound_events_attempt_id_received_at_idx" ON "inbound_events"("attempt_id", "received_at");

-- CreateIndex
CREATE INDEX "reconciliation_items_run_id_created_at_idx" ON "reconciliation_items"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "reconciliation_items_created_at_idx" ON "reconciliation_items"("created_at");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");


-- ---------------------------------------------------------------------------
-- Part B: raw-SQL indexes
-- ---------------------------------------------------------------------------

-- B1. Daily processed volume per route (rail resolution on EVERY checkout
-- page load / initiate and the admin route-caps view). The query filters on
-- status = 'SUCCEEDED' and the expression COALESCE(terminal_at, created_at);
-- without this index PostgreSQL walked every SUCCEEDED attempt ever made.
-- Partial + expression + INCLUDE gives an index-only range scan of one day.
CREATE INDEX IF NOT EXISTS "payment_attempts_succeeded_settled_at_idx"
  ON "payment_attempts" ((COALESCE("terminal_at", "created_at")))
  INCLUDE ("route_id", "total_charged_amount")
  WHERE "status" = 'SUCCEEDED';

-- B2. Audit shipper lease claim: unshipped rows that are not leased, oldest
-- first. Replaces the plain unshipped index so the lease predicate is cheap.
DROP INDEX IF EXISTS "audit_outbox_unshipped_idx";
CREATE INDEX "audit_outbox_unshipped_idx"
  ON "audit_outbox" ("created_at" ASC, "id" ASC)
  INCLUDE ("lease_until")
  WHERE "shipped_at" IS NULL;

-- B3. Audit outbox retention: shipped rows are pruned oldest first. A partial
-- btree replaces the BRIN index (BRIN cannot return rows in order and the
-- table is now bounded by the retention window).
DROP INDEX IF EXISTS "audit_outbox_shipped_brin_idx";
CREATE INDEX IF NOT EXISTS "audit_outbox_shipped_idx"
  ON "audit_outbox" ("shipped_at" ASC)
  WHERE "shipped_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Schema version 9: new read-model columns and the audit lease column.
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 9, "updated_at" = now()
WHERE "id" = 1;
