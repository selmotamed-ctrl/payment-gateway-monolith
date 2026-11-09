-- ============================================================================
-- AUTO-01 journal partition maintenance worker.
--
-- `ensure_journal_line_partitions` was callable only by the deploy cron (a superuser), so a database provisioned any
-- other way never got new months, and the non-owner application role could not call it at all. The core now runs the
-- same function from a worker (JournalPartitionWorker), so the function is:
--
--   * SECURITY DEFINER with a pinned search_path: the application role (pgw_app) may CALL it but it still creates the
--     partitions with the owner's rights (a plain function would fail with "must be owner of table journal_lines"),
--     and it can do nothing else: the only statements are CREATE TABLE ... PARTITION OF for whole months and the
--     guard/grant helper;
--   * bounded: months_ahead outside 1..60 is refused, so a compromised caller cannot create thousands of tables;
--   * EXECUTE is revoked from PUBLIC and granted to the application role only.
--
-- Rows that already sit in journal_lines_default block creating their month (PostgreSQL re-checks the default
-- partition's constraint). The worker reports that condition; moving the rows is an operator action under the ledger
-- maintenance flag (core-back/scripts/repair-journal-default-partition.ts), never an application-role action.
-- ============================================================================

CREATE OR REPLACE FUNCTION ensure_journal_line_partitions(months_ahead INT DEFAULT 6)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
BEGIN
  IF months_ahead IS NULL OR months_ahead < 1 OR months_ahead > 60 THEN
    RAISE EXCEPTION 'ensure_journal_line_partitions: months_ahead must be between 1 and 60 (got %)', months_ahead
      USING ERRCODE = '22023';
  END IF;
  FOR v_offset IN 0..months_ahead - 1 LOOP
    start_date := (date_trunc('month', now())::date + (v_offset || ' months')::interval)::date;
    end_date := (start_date + interval '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS "journal_lines_%s" PARTITION OF "journal_lines" FOR VALUES FROM (%L) TO (%L)',
      suffix, start_date, end_date
    );
    PERFORM pgw_guard_journal_line_partition(format('"journal_lines_%s"', suffix)::regclass);
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

-- ---------------------------------------------------------------------------
-- Schema version 17
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 17, "updated_at" = now()
WHERE "id" = 1;
