-- Shared object & asset storage hardening (schema version 37).
--
-- * GC/discard claims the row before moving the blob so a concurrent legal
--   hold, bind or retention boundary can never leave a readable row without a
--   blob (or a held blob in .trash).
-- * A strict status-transition matrix prevents rejected/purged resurrection.
-- * Authorization/tenant/confidentiality context becomes immutable.
-- * Access logs become append-only and their admin filters get indexes.
-- * Admin object-search filters get the indexes they actually use.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "storage_objects"
  ADD COLUMN IF NOT EXISTS "gc_claim_token" UUID,
  ADD COLUMN IF NOT EXISTS "gc_claimed_at" TIMESTAMPTZ(3);

CREATE INDEX IF NOT EXISTS "idx_storage_objects_created_at"
  ON "storage_objects" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_objects_status_created"
  ON "storage_objects" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_objects_owner_created"
  ON "storage_objects" ("owner_merchant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_objects_bucket_created"
  ON "storage_objects" ("bucket", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_objects_legal_hold_created"
  ON "storage_objects" ("legal_hold", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_objects_sha256"
  ON "storage_objects" ("sha256_hex");
CREATE INDEX IF NOT EXISTS "idx_storage_objects_key_trgm"
  ON "storage_objects" USING gin ("storage_key" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_storage_objects_filename_trgm"
  ON "storage_objects" USING gin ("original_filename" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_storage_access_logs_allowed_time"
  ON "storage_object_access_logs" ("allowed", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_storage_access_logs_action_time"
  ON "storage_object_access_logs" ("action", "occurred_at" DESC);

CREATE OR REPLACE FUNCTION enforce_storage_object_invariants()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_active_locks INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_DELETE_FORBIDDEN: storage_objects rows cannot be deleted (object_id=%). Transition to PURGED instead.', OLD.id
      USING ERRCODE = '23503';
  END IF;

  -- Immutable identity, content-integrity and authorization/tenant context.
  -- The KEK envelope fields and retention/GC/AV fields remain mutable only
  -- through the controlled worker paths.
  IF NEW.id != OLD.id
     OR NEW.namespace != OLD.namespace
     OR NEW.storage_key != OLD.storage_key
     OR NEW.sha256_hex != OLD.sha256_hex
     OR NEW.byte_size != OLD.byte_size
     OR NEW.chunk_size_bytes != OLD.chunk_size_bytes
     OR NEW.chunk_count != OLD.chunk_count
     OR NEW.stream_nonce_prefix != OLD.stream_nonce_prefix
     OR NEW.owner_merchant_id IS DISTINCT FROM OLD.owner_merchant_id
     OR NEW.uploaded_by_actor_type != OLD.uploaded_by_actor_type
     OR NEW.uploaded_by_actor_id != OLD.uploaded_by_actor_id
     OR NEW.required_authority != OLD.required_authority
     OR NEW.confidentiality_tier != OLD.confidentiality_tier
     OR NEW.detected_mime_type != OLD.detected_mime_type THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_IMMUTABLE_FIELD: cannot mutate identity, authority or tenant context of object_id=%', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- Monotonic retention_until (never shortened once set).
  IF OLD.retain_until IS NOT NULL AND (NEW.retain_until IS NULL OR NEW.retain_until < OLD.retain_until) THEN
    RAISE EXCEPTION 'STORAGE_OBJECT_RETENTION_SHORTEN_FORBIDDEN: cannot shorten retain_until from % to % on object_id=%',
      OLD.retain_until, NEW.retain_until, OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- No resurrection. The only legal status moves are the lifecycle edges.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'STAGING' AND NEW.status IN ('QUARANTINE_PENDING_AV', 'QUARANTINE_REJECTED', 'ACTIVE', 'PURGED'))
      OR (OLD.status = 'QUARANTINE_PENDING_AV' AND NEW.status IN ('ACTIVE', 'QUARANTINE_REJECTED', 'PURGED'))
      OR (OLD.status = 'QUARANTINE_REJECTED' AND NEW.status = 'PURGED')
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('QUARANTINE_REJECTED', 'PURGED'))
    ) THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_STATUS_TRANSITION_FORBIDDEN: object_id=% cannot move from % to %',
        OLD.id, OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A claim is the only path that may move a blob. It is taken while the row
  -- is still readable and is cleared if the filesystem move fails.
  IF NEW.gc_claim_token IS NOT NULL
     AND (OLD.gc_claim_token IS NULL OR NEW.gc_claim_token <> OLD.gc_claim_token) THEN
    IF NEW.status NOT IN ('STAGING', 'QUARANTINE_PENDING_AV', 'QUARANTINE_REJECTED', 'ACTIVE') THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_GC_CLAIM_FORBIDDEN: object_id=% is in status %', OLD.id, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.legal_hold = TRUE OR OLD.legal_hold = TRUE THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LEGAL_HOLD_ACTIVE: cannot claim held object_id=%', OLD.id
        USING ERRCODE = '23503';
    END IF;
    SELECT COUNT(*) INTO v_active_locks
      FROM "storage_object_locks"
     WHERE "object_id" = OLD.id
       AND "released_at" IS NULL;
    IF v_active_locks > 0 THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LOCKED: cannot claim object_id=% while % active lock(s) exist',
        OLD.id, v_active_locks
        USING ERRCODE = '23503';
    END IF;
    IF OLD.retain_until IS NOT NULL AND OLD.retain_until > NOW() THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_RETENTION_ACTIVE: cannot claim object_id=% before retain_until=%',
        OLD.id, OLD.retain_until
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.status = 'PURGED' THEN
    IF NEW.legal_hold = TRUE OR OLD.legal_hold = TRUE THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LEGAL_HOLD_ACTIVE: cannot purge held object_id=%', OLD.id
        USING ERRCODE = '23503';
    END IF;
    SELECT COUNT(*) INTO v_active_locks
      FROM "storage_object_locks"
     WHERE "object_id" = OLD.id
       AND "released_at" IS NULL;
    IF v_active_locks > 0 THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LOCKED: cannot transition object_id=% to PURGED while % active lock(s) exist',
        OLD.id, v_active_locks
        USING ERRCODE = '23503';
    END IF;
    IF OLD.retain_until IS NOT NULL AND OLD.retain_until > NOW() THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_RETENTION_ACTIVE: cannot purge object_id=% before retain_until=%',
        OLD.id, OLD.retain_until
        USING ERRCODE = '23503';
    END IF;
    IF OLD.gc_claim_token IS NULL OR NEW.gc_claim_token IS NULL OR NEW.gc_claim_token <> OLD.gc_claim_token THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_GC_CLAIM_REQUIRED: object_id=% must be claimed before it is purged', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'QUARANTINE_REJECTED' AND OLD.status != NEW.status THEN
    IF NEW.legal_hold = TRUE OR OLD.legal_hold = TRUE THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LEGAL_HOLD_ACTIVE: cannot reject held object_id=%', OLD.id
        USING ERRCODE = '23503';
    END IF;
    SELECT COUNT(*) INTO v_active_locks
      FROM "storage_object_locks"
     WHERE "object_id" = OLD.id
       AND "released_at" IS NULL;
    IF v_active_locks > 0 THEN
      RAISE EXCEPTION 'STORAGE_OBJECT_LOCKED: cannot reject object_id=% while % active lock(s) exist',
        OLD.id, v_active_locks
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

CREATE OR REPLACE FUNCTION enforce_storage_access_log_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'STORAGE_ACCESS_LOG_APPEND_ONLY: storage_object_access_logs rows cannot be changed or deleted'
    USING ERRCODE = '23503';
END;
$$;

DROP TRIGGER IF EXISTS "storage_object_access_logs_append_only_trg" ON "storage_object_access_logs";
CREATE TRIGGER "storage_object_access_logs_append_only_trg"
BEFORE UPDATE OR DELETE ON "storage_object_access_logs"
FOR EACH ROW EXECUTE FUNCTION enforce_storage_access_log_append_only();

UPDATE "schema_versions" SET "version" = 37 WHERE "id" = 1;
