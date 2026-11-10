CREATE TYPE "ReportOutputFormat" AS ENUM ('XML', 'XLSX');
CREATE TYPE "RegulatorySchemaStatus" AS ENUM ('DRAFT', 'PROVISIONAL', 'PENDING_APPROVAL', 'CONFIRMED', 'SUPERSEDED', 'ARCHIVED');
CREATE TYPE "ReportOutputValidationStatus" AS ENUM ('NOT_GENERATED', 'PROVISIONAL_SCHEMA', 'VALIDATED', 'INVALID');

ALTER TABLE "reporting_rules"
  ADD COLUMN "required_output_formats" "ReportOutputFormat"[] NOT NULL DEFAULT ARRAY[]::"ReportOutputFormat"[],
  ADD COLUMN "primary_output_format" "ReportOutputFormat";

ALTER TABLE "regulatory_reports"
  ADD COLUMN "required_output_formats" "ReportOutputFormat"[] NOT NULL DEFAULT ARRAY[]::"ReportOutputFormat"[],
  ADD COLUMN "filing_channel" TEXT,
  ADD COLUMN "acknowledged_at" TIMESTAMP(3),
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "supersedes_id" UUID;

CREATE INDEX "regulatory_reports_due_at_idx" ON "regulatory_reports"("due_at");
DROP INDEX IF EXISTS "regulatory_reports_aml_case_id_key";
CREATE INDEX "regulatory_reports_aml_case_id_idx" ON "regulatory_reports"("aml_case_id");

UPDATE "reporting_rules"
SET "required_output_formats" = CASE
  WHEN "conditions"->>'returnCode' = 'STR' THEN ARRAY['XML']::"ReportOutputFormat"[]
  WHEN "conditions"->>'returnCode' = 'LTR' THEN ARRAY['XML', 'XLSX']::"ReportOutputFormat"[]
  WHEN "conditions"->>'returnCode' = 'PSP-M' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  WHEN "conditions"->>'returnCode' = 'AML-Q' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  WHEN "conditions"->>'returnCode' = 'AML-A' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  WHEN "conditions"->>'returnCode' = 'INC' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  ELSE "required_output_formats"
END
WHERE "required_output_formats" = ARRAY[]::"ReportOutputFormat"[];

UPDATE "reporting_rules"
SET "primary_output_format" = "required_output_formats"[1]
WHERE "primary_output_format" IS NULL AND array_length("required_output_formats", 1) > 0;

UPDATE "reporting_rules"
SET "effective_to" = now()
WHERE "source_reference" = 'CBL-LARGE-TRANSACTION-CONFIRMED-001'
  AND "effective_to" IS NULL;

UPDATE "regulatory_reports"
SET "required_output_formats" = CASE
  WHEN "report_code" = 'STR' THEN ARRAY['XML']::"ReportOutputFormat"[]
  WHEN "report_code" = 'LTR' THEN ARRAY['XML', 'XLSX']::"ReportOutputFormat"[]
  WHEN "report_code" = 'PSP-M' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  WHEN "report_code" = 'AML-Q' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  WHEN "report_code" = 'AML-A' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  WHEN "report_code" = 'INC' THEN ARRAY['XLSX']::"ReportOutputFormat"[]
  ELSE "required_output_formats"
END
WHERE "required_output_formats" = ARRAY[]::"ReportOutputFormat"[];

CREATE TABLE "regulatory_report_schemas" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "authority" TEXT NOT NULL,
  "report_type" "ReportingType" NOT NULL,
  "report_code" TEXT NOT NULL DEFAULT '',
  "format" "ReportOutputFormat" NOT NULL,
  "schema_code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "cloned_from_schema_id" UUID,
  "status" "RegulatorySchemaStatus" NOT NULL DEFAULT 'DRAFT',
  "definition_text" TEXT,
  "definition_sha256" CHAR(64),
  "mapping_sha256" CHAR(64),
  "compiled_from_sha256" CHAR(64),
  "template_ciphertext" TEXT,
  "template_sha256" CHAR(64),
  "compiled_definition_json" JSONB NOT NULL,
  "mapping_blueprint_json" JSONB NOT NULL,
  "sample_context_json" JSONB,
  "notes" TEXT,
  "created_by_user_id" UUID,
  "approved_by_user_id" UUID,
  "approved_at" TIMESTAMP(3),
  "approval_request_id" UUID,
  "seed_key" TEXT,
  CONSTRAINT "regulatory_report_schemas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "regulatory_report_schemas_seed_key_key" ON "regulatory_report_schemas"("seed_key");
CREATE UNIQUE INDEX "regulatory_report_schemas_authority_schema_code_version_key" ON "regulatory_report_schemas"("authority", "schema_code", "version");
CREATE INDEX "regulatory_report_schemas_authority_report_type_format_status_idx" ON "regulatory_report_schemas"("authority", "report_type", "format", "status");
CREATE INDEX "regulatory_report_schemas_schema_code_version_idx" ON "regulatory_report_schemas"("schema_code", "version");

CREATE TABLE "regulatory_schema_default_bindings" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "authority" TEXT NOT NULL,
  "report_type" "ReportingType" NOT NULL,
  "report_code" TEXT NOT NULL DEFAULT '',
  "format" "ReportOutputFormat" NOT NULL,
  "schema_id" UUID NOT NULL,
  "updated_by_user_id" UUID,
  "approval_request_id" UUID,
  CONSTRAINT "regulatory_schema_default_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "regulatory_schema_default_bindings_authority_report_type_report_code_format_key" ON "regulatory_schema_default_bindings"("authority", "report_type", "report_code", "format");

CREATE TABLE "regulatory_rule_schema_bindings" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "format" "ReportOutputFormat" NOT NULL,
  "schema_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "regulatory_rule_schema_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "regulatory_rule_schema_bindings_rule_id_format_key" ON "regulatory_rule_schema_bindings"("rule_id", "format");

CREATE TABLE "regulatory_report_outputs" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "report_id" UUID NOT NULL,
  "format" "ReportOutputFormat" NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "schema_id" UUID,
  "schema_version" INTEGER,
  "content_ciphertext" TEXT NOT NULL,
  "content_sha256" CHAR(64) NOT NULL,
  "payload_sha256" CHAR(64),
  "validation_status" "ReportOutputValidationStatus" NOT NULL DEFAULT 'NOT_GENERATED',
  "validation_errors_json" JSONB,
  "generated_at" TIMESTAMP(3),
  "generated_by_user_id" UUID,
  "superseded_at" TIMESTAMP(3),
  "submitted_at" TIMESTAMP(3),
  CONSTRAINT "regulatory_report_outputs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "regulatory_report_outputs_report_id_format_revision_key" ON "regulatory_report_outputs"("report_id", "format", "revision");
CREATE INDEX "regulatory_report_outputs_report_id_format_superseded_at_idx" ON "regulatory_report_outputs"("report_id", "format", "superseded_at");
CREATE UNIQUE INDEX "regulatory_report_outputs_current_key" ON "regulatory_report_outputs"("report_id", "format") WHERE "superseded_at" IS NULL;

ALTER TABLE "regulatory_report_schemas"
  ADD CONSTRAINT "regulatory_report_schemas_approval_request_id_fkey"
  FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "regulatory_schema_default_bindings"
  ADD CONSTRAINT "regulatory_schema_default_bindings_schema_id_fkey"
  FOREIGN KEY ("schema_id") REFERENCES "regulatory_report_schemas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "regulatory_rule_schema_bindings"
  ADD CONSTRAINT "regulatory_rule_schema_bindings_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "reporting_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "regulatory_rule_schema_bindings"
  ADD CONSTRAINT "regulatory_rule_schema_bindings_schema_id_fkey"
  FOREIGN KEY ("schema_id") REFERENCES "regulatory_report_schemas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "regulatory_report_outputs"
  ADD CONSTRAINT "regulatory_report_outputs_report_id_fkey"
  FOREIGN KEY ("report_id") REFERENCES "regulatory_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "regulatory_report_outputs"
  ADD CONSTRAINT "regulatory_report_outputs_schema_id_fkey"
  FOREIGN KEY ("schema_id") REFERENCES "regulatory_report_schemas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION regulatory_schema_definition_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
    NEW.definition_text IS DISTINCT FROM OLD.definition_text
    OR NEW.mapping_blueprint_json IS DISTINCT FROM OLD.mapping_blueprint_json
    OR NEW.compiled_definition_json IS DISTINCT FROM OLD.compiled_definition_json
    OR NEW.template_ciphertext IS DISTINCT FROM OLD.template_ciphertext
  ) THEN
    RAISE EXCEPTION 'confirmed regulatory schema definitions are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_regulatory_schema_definition_guard ON "regulatory_report_schemas";
CREATE TRIGGER trg_regulatory_schema_definition_guard
  BEFORE UPDATE ON "regulatory_report_schemas"
  FOR EACH ROW EXECUTE FUNCTION regulatory_schema_definition_guard();

UPDATE "schema_versions"
SET "version" = 26, "updated_at" = now()
WHERE "id" = 1;
