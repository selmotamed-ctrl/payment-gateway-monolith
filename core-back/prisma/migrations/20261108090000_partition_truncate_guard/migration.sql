-- Partitions created after 20261105090000_append_only_ledger_guards had no TRUNCATE guard.
--
-- PostgreSQL clones ROW triggers from a partitioned parent to every new partition, so UPDATE and
-- DELETE stayed blocked, but TRUNCATE statement triggers are not cloned. The guard migration only
-- installed `pgw_journal_lines_no_truncate` on the partitions that existed at that moment, and
-- `ensure_journal_line_partitions` (run daily by the deploy cron) created every later month without
-- it, so an owner or superuser could `TRUNCATE journal_lines_<month>` and erase ledger history
-- without meeting the guard (truncating the parent was always blocked).
--
-- `ensure_journal_line_partitions` now installs the guard on every partition it covers, creating
-- the trigger only when it is missing so the daily run never takes a lock on a hot partition, and
-- this migration backfills every partition that exists today.

CREATE OR REPLACE FUNCTION pgw_guard_journal_line_partition(part regclass)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = part AND tgname = 'pgw_journal_lines_no_truncate' AND NOT tgisinternal
  ) THEN
    EXECUTE format(
      'CREATE TRIGGER pgw_journal_lines_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pgw_reject_ledger_truncate()',
      part
    );
    -- Privileges of the non-owner application role on a NEW partition. Default privileges only follow the role that
    -- creates an object, and the daily cron creates partitions as the superuser, not as the owner that ran the
    -- migrations: without this the application role could not read or write a partition created after the migration
    -- (the first ledger posting of a new month would fail). It gets what the migrations give it on every other
    -- ledger partition: read and insert, never UPDATE, DELETE or TRUNCATE. Done once per partition (this branch), so
    -- the daily run never takes a lock on a hot partition.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgw_app') THEN
      EXECUTE format('GRANT SELECT, INSERT ON %s TO pgw_app', part);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM pgw_app', part);
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_journal_line_partitions(months_ahead INT DEFAULT 6)
RETURNS void AS $$
DECLARE
  v_offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
BEGIN
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
$$ LANGUAGE plpgsql;

-- Backfill: every existing partition (monthly and default) and the parent. The privileges are applied to every
-- existing partition too (idempotent), including partitions the cron already created as the superuser before this
-- migration, which the application role could not use at all.
DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT 'journal_lines'::regclass
    UNION ALL
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'journal_lines'::regclass
  LOOP
    PERFORM pgw_guard_journal_line_partition(part);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgw_app') THEN
      EXECUTE format('GRANT SELECT, INSERT ON %s TO pgw_app', part);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM pgw_app', part);
    END IF;
  END LOOP;
END $$;

SELECT ensure_journal_line_partitions(18);
