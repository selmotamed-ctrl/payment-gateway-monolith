-- ============================================================================
-- Migration: 20261112000000_v36_enterprise_object_storage_engine
-- Shared Object & Asset Storage Engine (control plane + domain links + guards)
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "StorageBucketTier" AS ENUM ('HOT', 'COLD', 'QUARANTINE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StorageNamespace" AS ENUM (
    'KYB_DOCUMENTS',
    'RECON_STATEMENTS',
    'REGULATORY_REPORTS',
    'REPORT_STUDIO_ASSETS',
    'MERCHANT_STATEMENTS',
    'DISPUTE_EVIDENCE',
    'AML_CASE_ATTACHMENTS',
    'SYSTEM_BRAND_ASSETS',
    'BACKUP_ARTIFACTS'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StorageObjectStatus" AS ENUM (
    'STAGING',
    'QUARANTINE_PENDING_AV',
    'QUARANTINE_REJECTED',
    'ACTIVE',
    'PURGED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StorageAvScanStatus" AS ENUM (
    'NOT_REQUIRED',
    'PENDING',
    'CLEAN',
    'INFECTED',
    'SCAN_ERROR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "storage_objects" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "bucket"                 "StorageBucketTier" NOT NULL DEFAULT 'HOT',
  "namespace"              "StorageNamespace" NOT NULL,
  "storage_key"            VARCHAR(512) NOT NULL,
  "status"                 "StorageObjectStatus" NOT NULL DEFAULT 'STAGING',
  "sha256_hex"             CHAR(64) NOT NULL,
  "byte_size"              BIGINT NOT NULL CHECK ("byte_size" > 0),
  "chunk_size_bytes"       INTEGER NOT NULL DEFAULT 65536 CHECK ("chunk_size_bytes" >= 4096),
  "chunk_count"            INTEGER NOT NULL CHECK ("chunk_count" >= 1),
  "detected_mime_type"     VARCHAR(127) NOT NULL,
  "original_filename"      VARCHAR(255),
  "kek_key_version"        INTEGER NOT NULL DEFAULT 1,
  "wrapped_dek"            BYTEA NOT NULL,
  "dek_nonce"              BYTEA NOT NULL,
  "stream_nonce_prefix"    BYTEA NOT NULL,
  "owner_merchant_id"      UUID,
  "uploaded_by_actor_type" VARCHAR(32) NOT NULL,
  "uploaded_by_actor_id"   VARCHAR(128) NOT NULL,
  "required_authority"     VARCHAR(128) NOT NULL,
  "confidentiality_tier"   VARCHAR(32) NOT NULL DEFAULT 'CONFIDENTIAL',
  "retain_until"           TIMESTAMPTZ(3),
  "legal_hold"             BOOLEAN NOT NULL DEFAULT FALSE,
  "legal_hold_reason"      VARCHAR(512),
  "legal_hold_by_admin_id" UUID,
  "legal_hold_placed_at"   TIMESTAMPTZ(3),
  "gc_eligible_at"         TIMESTAMPTZ(3),
  "av_scan_status"         "StorageAvScanStatus" NOT NULL DEFAULT 'PENDING',
  "av_scanned_at"          TIMESTAMPTZ(3),
  "av_signature"           VARCHAR(255),
  "last_scrubbed_at"       TIMESTAMPTZ(3),
  "scrub_error_count"      INTEGER NOT NULL DEFAULT 0,
  "metadata"               JSONB DEFAULT '{}'::jsonb,
  "staging_expires_at"     TIMESTAMPTZ(3) NOT NULL,
  "activated_at"           TIMESTAMPTZ(3),
  "purged_at"              TIMESTAMPTZ(3),
  "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  "updated_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_storage_objects_bucket_key" UNIQUE ("bucket", "storage_key")
);

CREATE INDEX IF NOT EXISTS "idx_storage_objects_ns_merchant_status"
  ON "storage_objects" ("namespace", "owner_merchant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_storage_objects_staging_gc"
  ON "storage_objects" ("status", "staging_expires_at")
  WHERE "status" IN ('STAGING', 'QUARANTINE_REJECTED');
CREATE INDEX IF NOT EXISTS "idx_storage_objects_active_gc"
  ON "storage_objects" ("status", "gc_eligible_at")
  WHERE "status" = 'ACTIVE' AND "gc_eligible_at" IS NOT NULL AND "legal_hold" = FALSE;
CREATE INDEX IF NOT EXISTS "idx_storage_objects_scrub_queue"
  ON "storage_objects" ("status", "last_scrubbed_at" NULLS FIRST)
  WHERE "status" = 'ACTIVE';
CREATE INDEX IF NOT EXISTS "idx_storage_objects_kek_rotation"
  ON "storage_objects" ("kek_key_version", "status")
  WHERE "status" != 'PURGED';

CREATE TABLE IF NOT EXISTS "storage_object_locks" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "object_id"             UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "holder_type"           VARCHAR(64) NOT NULL,
  "holder_id"             VARCHAR(128) NOT NULL,
  "retention_floor_until" TIMESTAMPTZ(3),
  "acquired_by_actor_id"  VARCHAR(128) NOT NULL,
  "acquired_reason"       VARCHAR(255) NOT NULL,
  "acquired_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  "released_at"           TIMESTAMPTZ(3),
  "released_by_actor_id"  VARCHAR(128),
  "release_reason"        VARCHAR(255),
  CONSTRAINT "uq_storage_object_locks_holder" UNIQUE ("object_id", "holder_type", "holder_id")
);

CREATE INDEX IF NOT EXISTS "idx_storage_object_locks_active"
  ON "storage_object_locks" ("object_id")
  WHERE "released_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_storage_object_locks_lookup"
  ON "storage_object_locks" ("holder_type", "holder_id")
  WHERE "released_at" IS NULL;

CREATE TABLE IF NOT EXISTS "storage_object_access_logs" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "object_id"     UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actor_type"    VARCHAR(32) NOT NULL,
  "actor_id"      VARCHAR(128) NOT NULL,
  "action"        VARCHAR(48) NOT NULL,
  "allowed"       BOOLEAN NOT NULL,
  "denial_reason" VARCHAR(255),
  "holder_type"   VARCHAR(64),
  "holder_id"     VARCHAR(128),
  "ip_address"    VARCHAR(64),
  "request_id"    VARCHAR(128),
  "bytes_served"  BIGINT,
  "occurred_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_storage_access_logs_object_time"
  ON "storage_object_access_logs" ("object_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_access_logs_actor_time"
  ON "storage_object_access_logs" ("actor_id", "occurred_at" DESC);

CREATE TABLE IF NOT EXISTS "dispute_attachments" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dispute_id"        UUID NOT NULL REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "merchant_id"       UUID NOT NULL REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "storage_object_id" UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "label"             VARCHAR(255) NOT NULL,
  "uploaded_by_id"    VARCHAR(128) NOT NULL,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_dispute_attachments_dispute" ON "dispute_attachments" ("dispute_id");
CREATE INDEX IF NOT EXISTS "idx_dispute_attachments_object"  ON "dispute_attachments" ("storage_object_id");

CREATE TABLE IF NOT EXISTS "aml_case_evidence" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "aml_case_id"       UUID NOT NULL REFERENCES "aml_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "storage_object_id" UUID NOT NULL REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "evidence_type"     VARCHAR(64) NOT NULL,
  "notes"             TEXT,
  "uploaded_by_id"    VARCHAR(128) NOT NULL,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_aml_case_evidence_case"   ON "aml_case_evidence" ("aml_case_id");
CREATE INDEX IF NOT EXISTS "idx_aml_case_evidence_object" ON "aml_case_evidence" ("storage_object_id");

CREATE TABLE IF NOT EXISTS "report_asset_bundle_entries" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "bundle_id"         UUID NOT NULL REFERENCES "report_asset_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "relative_path"     VARCHAR(255) NOT NULL,
  "mime_type"         VARCHAR(127) NOT NULL,
  "sha256"            CHAR(64) NOT NULL,
  "byte_size"         INTEGER NOT NULL CHECK ("byte_size" > 0),
  "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_report_asset_entries_bundle_path" UNIQUE ("bundle_id", "relative_path")
);
CREATE INDEX IF NOT EXISTS "idx_report_asset_entries_object" ON "report_asset_bundle_entries" ("storage_object_id");

-- Domain table FK links to storage_objects (matching exact @map table names in schema.prisma)
ALTER TABLE "kyb_documents"
  DROP COLUMN IF EXISTS "content_ciphertext",
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "idx_kyb_documents_storage_object" ON "kyb_documents" ("storage_object_id");

ALTER TABLE "reconciliation_runs"
  DROP COLUMN IF EXISTS "file_content",
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "idx_reconciliation_runs_storage_object" ON "reconciliation_runs" ("storage_object_id");

ALTER TABLE "regulatory_report_schemas"
  ADD COLUMN IF NOT EXISTS "template_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "idx_reg_report_schemas_template_object" ON "regulatory_report_schemas" ("template_object_id");

ALTER TABLE "regulatory_report_outputs"
  ALTER COLUMN "content_ciphertext" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "idx_reg_report_outputs_storage_object" ON "regulatory_report_outputs" ("storage_object_id");

ALTER TABLE "report_asset_bundles"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "idx_report_asset_bundles_storage_object" ON "report_asset_bundles" ("storage_object_id");

ALTER TABLE "merchant_report_asset_bundles"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "idx_merchant_report_asset_bundles_storage_object" ON "merchant_report_asset_bundles" ("storage_object_id");

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "storage_object_id" UUID REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "idx_assets_storage_object" ON "assets" ("storage_object_id");

-- ============================================================================
-- TRIGGER 1: storage_objects_guard_trg (No GUC backdoors)
-- ============================================================================
CREATE OR REPLACE FUNCTION enforce_storage_object_invariants()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_active_locks INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_DELETE_FORBIDDEN: storage_objects rows cannot be deleted (object_id=%). Transition to PURGED instead.', OLD.id
      USING ERRCODE = '23503';
  END IF;

  -- Immutable identity & content-integrity columns (kek_key_version, wrapped_dek, dek_nonce may rotate via RewrapWorker)
  IF NEW.id != OLD.id
     OR NEW.namespace != OLD.namespace
     OR NEW.storage_key != OLD.storage_key
     OR NEW.sha256_hex != OLD.sha256_hex
     OR NEW.byte_size != OLD.byte_size
     OR NEW.chunk_size_bytes != OLD.chunk_size_bytes
     OR NEW.chunk_count != OLD.chunk_count
     OR NEW.stream_nonce_prefix != OLD.stream_nonce_prefix THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_IMMUTABLE_FIELD: cannot mutate cryptographic identity of object_id=%', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- Monotonic retention_until (never shortened once set)
  IF OLD.retain_until IS NOT NULL AND (NEW.retain_until IS NULL OR NEW.retain_until < OLD.retain_until) THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_RETENTION_SHORTEN_FORBIDDEN: cannot shorten retain_until from % to % on object_id=%',
      OLD.retain_until, NEW.retain_until, OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- Transition to PURGED or QUARANTINE_REJECTED requires zero active locks, legal_hold = false, and expired retention
  IF NEW.status IN ('PURGED', 'QUARANTINE_REJECTED') AND OLD.status != NEW.status THEN
    IF NEW.legal_hold = TRUE OR OLD.legal_hold = TRUE THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LEGAL_HOLD_ACTIVE: cannot purge/reject object_id=% while legal_hold is true', OLD.id
        USING ERRCODE = '23503';
    END IF;

    SELECT COUNT(*) INTO v_active_locks
      FROM "storage_object_locks"
     WHERE "object_id" = OLD.id
       AND "released_at" IS NULL;

    IF v_active_locks > 0 THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LOCKED: cannot transition object_id=% to % while % active lock(s) exist',
        OLD.id, NEW.status, v_active_locks
        USING ERRCODE = '23503';
    END IF;

    IF NEW.status = 'PURGED' AND OLD.retain_until IS NOT NULL AND OLD.retain_until > NOW() THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_RETENTION_ACTIVE: cannot purge object_id=% before retain_until=%',
        OLD.id, OLD.retain_until
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "storage_objects_guard_trg" ON "storage_objects";
CREATE TRIGGER "storage_objects_guard_trg"
BEFORE UPDATE OR DELETE ON "storage_objects"
FOR EACH ROW EXECUTE FUNCTION enforce_storage_object_invariants();

-- ============================================================================
-- TRIGGER 2: storage_object_locks_guard_trg (Append-Only Lock Ledger)
-- ============================================================================
CREATE OR REPLACE FUNCTION enforce_storage_lock_invariants()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'STORAGE_LOCK_DELETE_FORBIDDEN: storage_object_locks is append-only (lock_id=%). Set released_at instead.', OLD.id
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id != OLD.id
       OR NEW.object_id != OLD.object_id
       OR NEW.holder_type != OLD.holder_type
       OR NEW.holder_id != OLD.holder_id THEN
      RAISE EXCEPTION 'STORAGE_LOCK_IMMUTABLE_IDENTITY: cannot alter lock identity columns on lock_id=%', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "storage_object_locks_guard_trg" ON "storage_object_locks";
CREATE TRIGGER "storage_object_locks_guard_trg"
BEFORE UPDATE OR DELETE ON "storage_object_locks"
FOR EACH ROW EXECUTE FUNCTION enforce_storage_lock_invariants();

-- Bump singleton schema_versions row to 36 (checked by ensureSchemaVersion in core-back/prisma/client/index.ts)
UPDATE "schema_versions" SET "version" = 36 WHERE "id" = 1;
