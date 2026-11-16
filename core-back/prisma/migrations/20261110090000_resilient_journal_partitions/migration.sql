-- ============================================================================
-- A resilient ensure_journal_line_partitions (functions only; the schema version is left to
-- the neighbouring migrations, like 20261108090000_partition_truncate_guard).
--
-- 20261109210000 now defines this function, but a database that applied that
-- migration before it was revised (2026-11-10) keeps the earlier body, because
-- `prisma migrate deploy` never re-runs an applied migration. This redefines it
-- everywhere. Differences from the earlier body:
--
--   * a month that cannot be created no longer aborts the whole call: when
--     journal_lines_default already holds rows of that month (check_violation)
--     or the lock wait times out (lock_not_available), the month is skipped
--     with a WARNING and every other month is still ensured;
--   * storage parameters are set only on a partition this call creates, so the
--     6-hourly JournalPartitionWorker run no longer takes a SHARE UPDATE
--     EXCLUSIVE lock on every existing partition, including the hot one;
--   * lock_timeout = 5s bounds every lock wait (creating a partition locks the
--     parent), and timezone = UTC makes the month boundaries deterministic.
--
-- The SECURITY DEFINER hardening of AUTO-01 (bounded months_ahead, pinned
-- search_path, EXECUTE only for pgw_app) is unchanged.
-- ============================================================================

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
        EXECUTE format(
          'ALTER TABLE %I SET (autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_insert_threshold = 1000, autovacuum_analyze_scale_factor = 0.02)',
          part_name
        );
      EXCEPTION
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

    PERFORM pgw_guard_journal_line_partition(format('%I', part_name)::regclass);
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
