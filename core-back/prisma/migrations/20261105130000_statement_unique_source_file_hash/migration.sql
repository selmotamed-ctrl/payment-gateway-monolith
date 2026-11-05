-- GAP-018: statement file hashes are unique per statement source, not globally.
-- The same bytes may be uploaded for two sources; one source never gets two runs.
DROP INDEX IF EXISTS "reconciliation_runs_file_hash_key";

CREATE UNIQUE INDEX "reconciliation_runs_statement_source_id_file_hash_key"
    ON "reconciliation_runs"("statement_source_id", "file_hash");

CREATE INDEX "reconciliation_runs_file_hash_idx" ON "reconciliation_runs"("file_hash");

-- ---------------------------------------------------------------------------
-- Callback replay-window compatibility: a keyed channel with no signed
-- timestamp source cannot satisfy the (now fail-closed) timestamp check. Set
-- the tolerance to 0 explicitly for those legacy rows instead of rejecting
-- every delivery; TIMESTAMP_DOT_RAW_BODY channels still use the signed header.
-- ---------------------------------------------------------------------------
UPDATE "confirmation_channels" cc
SET "timestamp_tolerance_sec" = 0
WHERE cc."timestamp_selector" IS NULL
  AND cc."timestamp_tolerance_sec" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "crypto_profiles" cp
    WHERE cp."id" = cc."crypto_profile_id"
      AND cp."canonicalization_mode" = 'TIMESTAMP_DOT_RAW_BODY'
  );

-- ---------------------------------------------------------------------------
-- Schema version 11: append-only ledger guards and source-scoped statement
-- hashes (the MFA migration set version 10).
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 11, "updated_at" = now()
WHERE "id" = 1;
