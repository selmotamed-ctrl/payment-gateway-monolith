-- Type-aware operator case management (schema version 41).
--
-- `kind` remains the compatibility queue bucket. `case_type` is the stable
-- condition taxonomy, `source`/`domain` route ownership, and the title/summary/
-- subject fields make a case readable without decoding its UUID. The original
-- finding moves out of the overloaded `resolution_notes` column into structured
-- fields and an append-only case timeline.

ALTER TABLE "operator_cases"
  ADD COLUMN "case_number" SERIAL,
  ADD COLUMN "case_type" VARCHAR(64),
  ADD COLUMN "source" VARCHAR(32),
  ADD COLUMN "domain" VARCHAR(32),
  ADD COLUMN "confidentiality" VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "title_key" VARCHAR(96),
  ADD COLUMN "title_params" JSONB,
  ADD COLUMN "title_text" TEXT,
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "details_json" JSONB,
  ADD COLUMN "subject_type" VARCHAR(48),
  ADD COLUMN "subject_id" TEXT,
  ADD COLUMN "subject_label" TEXT,
  ADD COLUMN "resolution_code" VARCHAR(48),
  ADD COLUMN "resolution_summary" TEXT,
  ADD COLUMN "resolved_at" TIMESTAMP(3),
  ADD COLUMN "resolved_by_user_id" UUID;

CREATE UNIQUE INDEX "operator_cases_case_number_key" ON "operator_cases"("case_number");
CREATE INDEX "operator_cases_case_type_state_idx" ON "operator_cases"("case_type", "state");
CREATE INDEX "operator_cases_domain_state_idx" ON "operator_cases"("domain", "state");
CREATE INDEX "operator_cases_subject_type_subject_id_idx" ON "operator_cases"("subject_type", "subject_id");

ALTER TABLE "operator_cases"
  ADD CONSTRAINT "operator_cases_resolved_by_user_id_fkey"
  FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "operator_case_events" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" VARCHAR(48) NOT NULL,
    "actor_type" VARCHAR(16) NOT NULL DEFAULT 'SYSTEM',
    "actor_user_id" UUID,
    "actor_email" TEXT,
    "summary" TEXT NOT NULL,
    "details_json" JSONB,
    CONSTRAINT "operator_case_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "operator_case_events_case_id_created_at_idx" ON "operator_case_events"("case_id", "created_at");

ALTER TABLE "operator_case_events"
  ADD CONSTRAINT "operator_case_events_case_id_fkey"
  FOREIGN KEY ("case_id") REFERENCES "operator_cases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "operator_case_links" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "link_type" VARCHAR(48) NOT NULL,
    "target_id" TEXT,
    "label_key" VARCHAR(96),
    "label_text" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "operator_case_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_case_links_case_id_link_type_target_id_key"
  ON "operator_case_links"("case_id", "link_type", "target_id");
CREATE INDEX "operator_case_links_case_id_idx" ON "operator_case_links"("case_id");

ALTER TABLE "operator_case_links"
  ADD CONSTRAINT "operator_case_links_case_id_fkey"
  FOREIGN KEY ("case_id") REFERENCES "operator_cases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "schema_versions" SET "version" = 41;
