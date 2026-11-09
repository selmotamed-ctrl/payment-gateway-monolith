-- ============================================================================
-- AUTO-02 outbox relay dead-lettering and AUTO-25 persisted worker cursors.
--
-- Safe on a populated database:
--  * ADD COLUMN with a constant default (or no default) is a catalogue-only
--    change in PostgreSQL 11+; the table is not rewritten and the brief
--    ACCESS EXCLUSIVE lock is held only for the catalogue update.
--  * No index is built here. Parked rows keep `processed_at` NULL, so they
--    stay in the existing partial index `outbox_events_unprocessed_idx`
--    (WHERE processed_at IS NULL); the relay claim, the parked count and the
--    oldest-pending lookup all read through it. Parked rows are bounded by
--    operator handling (each parked topic opens an operator case).
--  * `worker_cursors` is a new, empty table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. outbox_events: delivery attempts, last error, parked marker
-- ----------------------------------------------------------------------------
ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_error" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "parked_at" TIMESTAMPTZ(3);

-- ----------------------------------------------------------------------------
-- 2. worker_cursors: keyset cursors that singleton workers persist between
--    ticks, so a leader change or a restart resumes where the last tick
--    stopped (first user: KybExpiryWorker grace-suspension pass).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "worker_cursors" (
  "name"         VARCHAR(96)    NOT NULL,
  "cursor_value" TEXT,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "worker_cursors_pkey" PRIMARY KEY ("name")
);

-- ---------------------------------------------------------------------------
-- Schema version 16
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 16, "updated_at" = now()
WHERE "id" = 1;
