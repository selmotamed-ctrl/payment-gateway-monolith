-- GAP-018: statement file hashes are unique per statement source, not globally.
-- The same bytes may be uploaded for two sources; one source never gets two runs.
DROP INDEX IF EXISTS "reconciliation_runs_file_hash_key";

CREATE UNIQUE INDEX "reconciliation_runs_statement_source_id_file_hash_key"
    ON "reconciliation_runs"("statement_source_id", "file_hash");

CREATE INDEX "reconciliation_runs_file_hash_idx" ON "reconciliation_runs"("file_hash");
