-- ============================================================================
-- AUTO-27 daily audit-chain anchors.
--
-- The hash chain of the dedicated audit database was only verified on a restored copy during a drill. The
-- AuditChainAnchorWorker now verifies the live chain incrementally every day and stores a signed anchor
-- (the last verified sequence number and row hash, HMAC-SHA256 under a vault key) here, in the core database: a
-- later rewrite or truncation of the audit database no longer matches its anchor, and a forged anchor does not
-- verify without the key. Append-only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "audit_chain_anchors" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seq_no" BIGINT NOT NULL,
  "last_row_hash" CHAR(64) NOT NULL,
  "rows_verified_total" BIGINT NOT NULL,
  "rows_verified_this_run" INTEGER NOT NULL,
  "key_id" TEXT NOT NULL,
  "signature" CHAR(64) NOT NULL,
  CONSTRAINT "audit_chain_anchors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "audit_chain_anchors_last_seq_no_key" ON "audit_chain_anchors" ("last_seq_no");

CREATE OR REPLACE FUNCTION audit_chain_anchors_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_chain_anchors is append-only' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_chain_anchors_append_only ON "audit_chain_anchors";
CREATE TRIGGER trg_audit_chain_anchors_append_only
  BEFORE UPDATE OR DELETE ON "audit_chain_anchors"
  FOR EACH ROW EXECUTE FUNCTION audit_chain_anchors_append_only();

-- ---------------------------------------------------------------------------
-- Schema version 22
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 22, "updated_at" = now()
WHERE "id" = 1;
