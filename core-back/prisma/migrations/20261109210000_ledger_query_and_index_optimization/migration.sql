-- ============================================================================
-- Schema version 25: ledger index-only scan coverage, journal_entries indexing,
-- and PostgreSQL 18 visibility-map autovacuum tuning for append-only partitions.
--
-- Applied after the automation migrations (2026110911..2026110920): its
-- ensure_journal_line_partitions keeps the AUTO-01 security hardening
-- (SECURITY DEFINER, bounded, app-role EXECUTE) and adds the append-only
-- autovacuum settings for future monthly partitions.
--
-- journal_lines is monthly range-partitioned by created_at. Every query that
-- addresses it must bound created_at (see the ledger part, "Query & Indexing
-- Rules for journal_entries, journal_lines and gl_account_shards"), otherwise
-- PostgreSQL probes every monthly partition. The two hot lookups are given a
-- covering INCLUDE payload so they can run as Index-Only Scans once the
-- Visibility Map is current; insert autovacuum is tuned because append-only
-- tables never receive the UPDATEs that normally refresh the map.
--
-- On a populated ledger (2026-11-10): the index builds below are plain CREATE
-- INDEX (a migration runs as one transaction, and CONCURRENTLY is refused both
-- in a transaction and on a partitioned parent), so they block ledger writes
-- while they run. Every build is therefore skipped when the index already has
-- its final shape: build them online first (CREATE INDEX CONCURRENTLY on
-- journal_entries; per partition + ATTACH PARTITION on journal_lines, see the
-- ledger part) and this migration only finishes the bookkeeping. lock_timeout
-- makes it fail fast instead of queueing every posting behind its locks.
-- ============================================================================

SET lock_timeout = '10s';

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
--    Each is rebuilt only when its definition differs from the target (keys AND the
--    exact INCLUDE list, read back with pg_get_indexdef), so a database that built
--    them online beforehand never takes the blocking DROP/CREATE here, while the
--    narrower INCLUDE ("direction", "amount") of 20261103180000 is still upgraded.
DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('journal_lines_entry_id_created_at_idx',
       'CREATE INDEX "journal_lines_entry_id_created_at_idx" ON "journal_lines" ("entry_id", "created_at") INCLUDE ("gl_account_id", "direction", "amount", "id")',
       'USING btree (entry_id, created_at) INCLUDE (gl_account_id, direction, amount, id)'),
      ('journal_lines_account_id_cov_idx',
       'CREATE INDEX "journal_lines_account_id_cov_idx" ON "journal_lines" ("gl_account_id", "created_at") INCLUDE ("direction", "amount", "entry_id", "id")',
       'USING btree (gl_account_id, created_at) INCLUDE (direction, amount, entry_id, id)')
    ) AS t(index_name, create_sql, target_tail)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = spec.index_name AND c.relkind IN ('i', 'I')
        AND right(pg_get_indexdef(c.oid), length(spec.target_tail)) = spec.target_tail
    ) THEN
      RAISE NOTICE '% already has its target definition; not rebuilt', spec.index_name;
    ELSE
      EXECUTE format('DROP INDEX IF EXISTS %I', spec.index_name);
      EXECUTE spec.create_sql;
    END IF;
  END LOOP;
END $$;

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
-- Resilient since 2026-11-10 (also redefined by 20261110090000 for databases that already ran this
-- migration): a month that cannot be created is skipped with a WARNING instead of aborting the
-- whole call, storage parameters are set only on a partition this call creates (re-running never
-- locks an existing hot partition), lock waits are bounded, and months are computed in UTC.
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

SELECT ensure_journal_line_partitions(24);

-- ---------------------------------------------------------------------------
-- Schema version 25
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 25, "updated_at" = now()
WHERE "id" = 1;

RESET lock_timeout;
