-- ============================================================================
-- AUTO-04 / AUTO-22 deadline stages.
--
-- The deadline worker fires reminders, escalations and deadline outcomes at fixed stages of a subject's life (an
-- operator case, an AML case, a dispute, a cash-out, an emergency approval). One row per (subject, stage) is the
-- exactly-once marker: the worker claims a stage with INSERT ... ON CONFLICT DO NOTHING in the SAME transaction as the
-- action, so a restart, a repeated tick or a second node can never send a reminder or revert an action twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "deadline_stages" (
  "subject_type" VARCHAR(32)    NOT NULL,
  "subject_id"   VARCHAR(64)    NOT NULL,
  "stage"        VARCHAR(48)    NOT NULL,
  "fired_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "detail_json"  JSONB,
  CONSTRAINT "deadline_stages_pkey" PRIMARY KEY ("subject_type", "subject_id", "stage")
);

CREATE INDEX IF NOT EXISTS "deadline_stages_fired_idx" ON "deadline_stages" ("fired_at");

-- ---------------------------------------------------------------------------
-- Schema version 19
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 19, "updated_at" = now()
WHERE "id" = 1;
