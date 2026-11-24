-- Schema version 43: close the remaining append-only gaps (GAP-075).
--
-- `operator_case_events` and `gl_shard_repairs` are audit histories, and the
-- storage access log / audit-chain anchor tables already refused UPDATE and
-- DELETE at the row level. This migration adds the missing row guards and
-- TRUNCATE guards so an accidental or malicious bulk operation cannot erase
-- those histories. `storage_objects` is mutable by design (status, locks,
-- quarantine), but TRUNCATE is never a valid application operation.
--
-- Maintenance is deliberately explicit: the bypass needs BOTH the
-- `pgw.append_only_maintenance` transaction setting AND membership in the
-- owner/maintenance role (the same principle as the ledger guard).

CREATE OR REPLACE FUNCTION pgw_append_only_maintenance_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('pgw.append_only_maintenance', true), '') = 'on'
    AND (
      EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = session_user AND r.rolsuper)
      OR EXISTS (
        SELECT 1
        FROM pg_roles m
        WHERE m.rolname IN ('pgw_app', 'pgw_migrator')
          AND pg_has_role(session_user, m.oid, 'MEMBER')
      )
    )
$$;

CREATE OR REPLACE FUNCTION pgw_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pgw_append_only_maintenance_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END $$;

CREATE OR REPLACE FUNCTION pgw_append_only_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pgw_append_only_maintenance_allowed() THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'append-only table %: TRUNCATE is not allowed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS pgw_operator_case_events_append_only ON "operator_case_events";
CREATE TRIGGER pgw_operator_case_events_append_only
  BEFORE UPDATE OR DELETE ON "operator_case_events"
  FOR EACH ROW EXECUTE FUNCTION pgw_append_only_mutation();
DROP TRIGGER IF EXISTS pgw_operator_case_events_no_truncate ON "operator_case_events";
CREATE TRIGGER pgw_operator_case_events_no_truncate
  BEFORE TRUNCATE ON "operator_case_events"
  FOR EACH STATEMENT EXECUTE FUNCTION pgw_append_only_truncate();

DROP TRIGGER IF EXISTS pgw_gl_shard_repairs_append_only ON "gl_shard_repairs";
CREATE TRIGGER pgw_gl_shard_repairs_append_only
  BEFORE UPDATE OR DELETE ON "gl_shard_repairs"
  FOR EACH ROW EXECUTE FUNCTION pgw_append_only_mutation();
DROP TRIGGER IF EXISTS pgw_gl_shard_repairs_no_truncate ON "gl_shard_repairs";
CREATE TRIGGER pgw_gl_shard_repairs_no_truncate
  BEFORE TRUNCATE ON "gl_shard_repairs"
  FOR EACH STATEMENT EXECUTE FUNCTION pgw_append_only_truncate();

DROP TRIGGER IF EXISTS pgw_storage_object_access_logs_no_truncate ON "storage_object_access_logs";
CREATE TRIGGER pgw_storage_object_access_logs_no_truncate
  BEFORE TRUNCATE ON "storage_object_access_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION pgw_append_only_truncate();

DROP TRIGGER IF EXISTS pgw_audit_chain_anchors_no_truncate ON "audit_chain_anchors";
CREATE TRIGGER pgw_audit_chain_anchors_no_truncate
  BEFORE TRUNCATE ON "audit_chain_anchors"
  FOR EACH STATEMENT EXECUTE FUNCTION pgw_append_only_truncate();

DROP TRIGGER IF EXISTS pgw_storage_objects_no_truncate ON "storage_objects";
CREATE TRIGGER pgw_storage_objects_no_truncate
  BEFORE TRUNCATE ON "storage_objects"
  FOR EACH STATEMENT EXECUTE FUNCTION pgw_append_only_truncate();

UPDATE "schema_versions" SET "version" = 43, "updated_at" = now() WHERE "id" = 1;
