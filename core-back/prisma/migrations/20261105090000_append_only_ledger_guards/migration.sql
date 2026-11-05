-- ============================================================================
-- Append-only protection for the ledger and the audit trail (GAP-013).
--
--   * journal_entries, journal_lines (partitioned) and audit_log reject
--     UPDATE, DELETE and TRUNCATE at the database, whoever the caller is.
--   * The only bypasses are explicit and narrow:
--       - maintenance: a transaction that sets pgw.ledger_maintenance = 'on'
--         AND whose session user is a superuser or a member of the role
--         pgw_ledger_maintenance. The application role is NOT a member.
--       - retention: DELETE on audit_log only, in a transaction that sets
--         pgw.audit_retention = 'on' (the RetentionWorker purge). The journal
--         is never purged by retention.
--   * A non-owner application role pgw_app is provisioned with the DML it
--     needs and with UPDATE/DELETE/TRUNCATE revoked on the three tables.
--     REVOKE alone is ineffective against the table owner, which is why the
--     triggers exist. Production must connect as pgw_app (or another
--     non-owner member of it), never as the owner that ran the migrations.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Roles (best effort: a managed PostgreSQL may forbid CREATE ROLE).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgw_ledger_maintenance') THEN
    CREATE ROLE pgw_ledger_maintenance NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgw_app') THEN
    CREATE ROLE pgw_app NOLOGIN;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'append-only: cannot create roles pgw_app / pgw_ledger_maintenance (%); provision them manually', SQLERRM;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Guard functions.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pgw_ledger_maintenance_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('pgw.ledger_maintenance', true), '') = 'on'
     AND (
       EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = session_user AND r.rolsuper)
       OR EXISTS (
         SELECT 1 FROM pg_roles m
         WHERE m.rolname = 'pgw_ledger_maintenance' AND pg_has_role(session_user, m.oid, 'MEMBER')
       )
     )
$$;

CREATE OR REPLACE FUNCTION pgw_reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pgw_ledger_maintenance_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END $$;

CREATE OR REPLACE FUNCTION pgw_reject_ledger_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pgw_ledger_maintenance_allowed() THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'append-only table %: TRUNCATE is not allowed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END $$;

CREATE OR REPLACE FUNCTION pgw_reject_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('pgw.audit_retention', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  IF pgw_ledger_maintenance_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END $$;

-- ----------------------------------------------------------------------------
-- 3. Triggers.
--    Row triggers on the partitioned journal_lines parent are cloned to every
--    existing and future partition. TRUNCATE statement triggers are not, so
--    they are installed on the parent and on each existing partition.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS pgw_journal_entries_append_only ON "journal_entries";
CREATE TRIGGER pgw_journal_entries_append_only
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION pgw_reject_ledger_mutation();
DROP TRIGGER IF EXISTS pgw_journal_entries_no_truncate ON "journal_entries";
CREATE TRIGGER pgw_journal_entries_no_truncate
  BEFORE TRUNCATE ON "journal_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION pgw_reject_ledger_truncate();

DROP TRIGGER IF EXISTS pgw_journal_lines_append_only ON "journal_lines";
CREATE TRIGGER pgw_journal_lines_append_only
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION pgw_reject_ledger_mutation();

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT 'journal_lines'::regclass
    UNION ALL
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'journal_lines'::regclass
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pgw_journal_lines_no_truncate ON %s', part);
    EXECUTE format(
      'CREATE TRIGGER pgw_journal_lines_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pgw_reject_ledger_truncate()',
      part
    );
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS pgw_audit_log_append_only ON "audit_log";
CREATE TRIGGER pgw_audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION pgw_reject_audit_log_mutation();
DROP TRIGGER IF EXISTS pgw_audit_log_no_truncate ON "audit_log";
CREATE TRIGGER pgw_audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION pgw_reject_ledger_truncate();

-- ----------------------------------------------------------------------------
-- 4. Non-owner application role grants (best effort, see section 1).
--    audit_log keeps DELETE because the retention purge removes expired rows
--    (the trigger still requires pgw.audit_retention = 'on').
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  part regclass;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgw_app') THEN
    GRANT USAGE ON SCHEMA public TO pgw_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pgw_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pgw_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pgw_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pgw_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pgw_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, journal_lines FROM pgw_app;
    REVOKE UPDATE, TRUNCATE ON audit_log FROM pgw_app;
    FOR part IN SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'journal_lines'::regclass LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM pgw_app', part);
    END LOOP;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'append-only: cannot grant/revoke for pgw_app (%); apply the REVOKE statements manually', SQLERRM;
END $$;
