-- ============================================================================
-- AUTO-23 reconciliation exceptions, automatic dispute intake and UNKNOWN evidence.
--
-- A statement row has a type (SETTLEMENT, CHARGEBACK, FEE, REVERSAL, UNKNOWN) that the ingestor parses but never stored,
-- so a chargeback row was indistinguishable from a settlement row after ingestion. The reconciliation follow-up needs it
-- to open a dispute for a chargeback row. Nullable: items written before this migration have no type.
-- ============================================================================

ALTER TABLE "reconciliation_items" ADD COLUMN IF NOT EXISTS "row_type" TEXT;

-- ---------------------------------------------------------------------------
-- Schema version 20
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 20, "updated_at" = now()
WHERE "id" = 1;
