-- ============================================================================
-- ensure_journal_line_partitions: restore fillfactor = 100 and survive concurrent callers
-- (schema version 35: no table shape change; the newest migration sets the required version,
-- so the seeders' version guard refuses a database that has not applied it).
--
-- 1. The 2026-11-10 revision of this function (20261109210000 as revised, and
--    20261110090000) set only the insert-autovacuum parameters on a new partition and
--    dropped the explicit fillfactor = 100 of the original body, so every partition
--    created since lacks it (journal lines are append-only: pages are filled
--    completely). Restored here, and set once on the partitions created without it.
-- 2. The same revision replaced CREATE TABLE IF NOT EXISTS with a to_regclass check
--    and a plain CREATE TABLE. Two callers at once (the 6-hourly JournalPartitionWorker
--    on two nodes, or the worker and a deploy) both saw the month missing; the second
--    then failed with duplicate_table (or a unique violation on the catalog) and
--    aborted the whole call. A partition another caller created is now accepted.
-- ============================================================================

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION ensure_journal_line_partitions(months_ahead INT DEFAULT 18)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
SET timezone = 'UTC'
AS $$
DECLARE
  v_offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
  part_name TEXT;
BEGIN
  -- The application role may call this function from JournalPartitionWorker; keep the bound so a
  -- compromised caller cannot create thousands of tables (AUTO-01).
  IF months_ahead IS NULL OR months_ahead < 1 OR months_ahead > 60 THEN
    RAISE EXCEPTION 'ensure_journal_line_partitions: months_ahead must be between 1 and 60 (got %)', months_ahead
      USING ERRCODE = '22023';
  END IF;
  FOR v_offset IN 0..months_ahead - 1 LOOP
    start_date := (date_trunc('month', now())::date + (v_offset || ' months')::interval)::date;
    end_date := (start_date + interval '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    part_name := format('journal_lines_%s', suffix);

    IF to_regclass(format('%I', part_name)) IS NULL THEN
      BEGIN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF "journal_lines" FOR VALUES FROM (%L) TO (%L)',
          part_name, start_date, end_date
        );
        -- Storage parameters only on a partition THIS call creates: the 6-hourly run never takes
        -- a SHARE UPDATE EXCLUSIVE lock on an existing (possibly hot) partition.
        EXECUTE format(
          'ALTER TABLE %I SET (fillfactor = 100, autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_insert_threshold = 1000, autovacuum_analyze_scale_factor = 0.02)',
          part_name
        );
      EXCEPTION
        WHEN duplicate_table OR unique_violation THEN
          -- Another caller created this month between the check and the CREATE (it also sets the
          -- storage parameters). Nothing to do but the guard below.
          NULL;
        WHEN check_violation THEN
          -- journal_lines_default already holds rows of this month: creating the partition would
          -- have to move them. The rows stay correct where they are; an operator moves them.
          RAISE WARNING 'ensure_journal_line_partitions: % not created, journal_lines_default holds rows in [%, %); move them out of the default partition first',
            part_name, start_date, end_date;
          CONTINUE;
        WHEN lock_not_available THEN
          RAISE WARNING 'ensure_journal_line_partitions: % not created, lock wait timed out; the next run retries', part_name;
          CONTINUE;
      END;
    END IF;

    BEGIN
      PERFORM pgw_guard_journal_line_partition(format('%I', part_name)::regclass);
    EXCEPTION
      WHEN duplicate_object THEN
        NULL; -- a concurrent caller installed the truncate guard first
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION ensure_journal_line_partitions(INT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgw_app') THEN
    GRANT EXECUTE ON FUNCTION ensure_journal_line_partitions(INT) TO pgw_app;
  END IF;
END $$;

-- The monthly partitions created without fillfactor since the 2026-11-10 revision. Setting it
-- takes SHARE UPDATE EXCLUSIVE (it does not block reads or writes) and applies to pages written
-- from now on; it is skipped for a partition that already carries it.
DO $$
DECLARE
  part RECORD;
BEGIN
  FOR part IN
    SELECT c.oid::regclass AS rel
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'journal_lines'::regclass
      AND c.relname ~ '^journal_lines_[0-9]{4}_[0-9]{2}$'
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(c.reloptions, '{}'::text[])) AS o(opt) WHERE o.opt LIKE 'fillfactor=%')
  LOOP
    EXECUTE format('ALTER TABLE %s SET (fillfactor = 100)', part.rel);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Schema version 35
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 35, "updated_at" = now()
WHERE "id" = 1;

RESET lock_timeout;
