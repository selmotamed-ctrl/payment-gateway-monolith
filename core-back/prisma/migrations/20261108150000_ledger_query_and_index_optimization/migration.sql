-- ============================================================================
-- Schema version 16: ledger index-only scan coverage, journal_entries indexing,
-- and PostgreSQL 18 visibility-map autovacuum tuning for append-only partitions.
--
-- journal_lines is monthly range-partitioned by created_at. Every query that
-- addresses it must bound created_at (see the ledger part, "Query & Indexing
-- Rules for journal_entries, journal_lines and gl_account_shards"), otherwise
-- PostgreSQL probes every monthly partition. The two hot lookups are given a
-- covering INCLUDE payload so they can run as Index-Only Scans once the
-- Visibility Map is current; insert autovacuum is tuned because append-only
-- tables never receive the UPDATEs that normally refresh the map.
-- ============================================================================

-- 1. journal_entries(created_at) for O(log N) pagination and the 24h summary
--    counts, plus pg_trgm GIN for instant search on ref_id and description.
CREATE INDEX IF NOT EXISTS "journal_entries_created_at_idx"
  ON "journal_entries" ("created_at")
  INCLUDE ("id", "ref_type", "ref_id");

CREATE INDEX IF NOT EXISTS "journal_entries_trgm_search_idx"
  ON "journal_entries" USING gin (
    "ref_id" gin_trgm_ops,
    "description" gin_trgm_ops
  );

-- 2. Upgrade the two journal_lines lookups with INCLUDE payload columns so the
--    batch entry lookup and the account statement run without heap fetches.
--    Key columns stay ("entry_id", "created_at") and ("gl_account_id",
--    "created_at"), so the declared @@index parity in Suite 01.4 is unchanged.
DROP INDEX IF EXISTS "journal_lines_entry_id_created_at_idx";
CREATE INDEX "journal_lines_entry_id_created_at_idx"
  ON "journal_lines" ("entry_id", "created_at")
  INCLUDE ("gl_account_id", "direction", "amount", "id");

DROP INDEX IF EXISTS "journal_lines_account_id_cov_idx";
CREATE INDEX "journal_lines_account_id_cov_idx"
  ON "journal_lines" ("gl_account_id", "created_at")
  INCLUDE ("direction", "amount", "entry_id", "id");

-- 3. Tune insert-triggered autovacuum on the append-only ledger tables. An
--    INSERT-only table is never vacuumed by the update/delete thresholds, so
--    PostgreSQL 18's insert autovacuum is what marks heap pages all-visible in
--    the Visibility Map (required for Index-Only Scans to skip heap fetches).
ALTER TABLE "journal_entries" SET (
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);

-- A partitioned table cannot carry storage parameters itself (PostgreSQL 18 rejects it with
-- "cannot specify storage parameters for a partitioned table"), so the settings go on every
-- leaf partition.
DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'journal_lines'::regclass
  LOOP
    EXECUTE format(
      'ALTER TABLE %s SET (fillfactor = 100, autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_insert_threshold = 1000, autovacuum_analyze_scale_factor = 0.02)',
      part
    );
  END LOOP;
END $$;

-- 4. Future monthly partitions inherit the same append-only settings. The
--    no-truncate guard and the pgw_app grants/revokes stay in
--    pgw_guard_journal_line_partition (20261108090000_partition_truncate_guard),
--    because statement triggers are not cloned from the partitioned parent and
--    partitions created by the daily cron run as the superuser.
CREATE OR REPLACE FUNCTION ensure_journal_line_partitions(months_ahead INT DEFAULT 18)
RETURNS void AS $$
DECLARE
  v_offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
  part_name TEXT;
BEGIN
  FOR v_offset IN 0..months_ahead - 1 LOOP
    start_date := (date_trunc('month', now())::date + (v_offset || ' months')::interval)::date;
    end_date := (start_date + interval '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    part_name := format('journal_lines_%s', suffix);

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "journal_lines" FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date
    );

    EXECUTE format(
      'ALTER TABLE %I SET (fillfactor = 100, autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_insert_threshold = 1000, autovacuum_analyze_scale_factor = 0.02)',
      part_name
    );

    PERFORM pgw_guard_journal_line_partition(format('"journal_lines_%s"', suffix)::regclass);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_journal_line_partitions(24);

-- ---------------------------------------------------------------------------
-- Schema version 16
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 16, "updated_at" = now()
WHERE "id" = 1;
