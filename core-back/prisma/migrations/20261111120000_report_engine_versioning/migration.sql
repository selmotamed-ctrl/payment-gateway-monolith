-- Schema version 34: report/chrome compatibility provenance and default revocation.
ALTER TABLE "report_chrome_specs"
    ADD COLUMN "default_revoked_at" TIMESTAMPTZ(3),
    ADD COLUMN "default_revoked_reason" VARCHAR(64),
    ADD COLUMN "engine_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    ADD COLUMN "spec_schema_version" VARCHAR(16) NOT NULL DEFAULT '1.0',
    ADD COLUMN "authoring_transcript_version" VARCHAR(16);

ALTER TABLE "report_definition_specs"
    ADD COLUMN "engine_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    ADD COLUMN "spec_schema_version" VARCHAR(16) NOT NULL DEFAULT '1.0',
    ADD COLUMN "authoring_transcript_version" VARCHAR(16);

ALTER TABLE "merchant_report_specs"
    ADD COLUMN "engine_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    ADD COLUMN "spec_schema_version" VARCHAR(16) NOT NULL DEFAULT '1.0',
    ADD COLUMN "authoring_transcript_version" VARCHAR(16);

ALTER TABLE "report_execution_audit"
    ADD COLUMN "engine_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    ADD COLUMN "spec_schema_version" VARCHAR(16) NOT NULL DEFAULT '1.0';

ALTER TABLE "merchant_report_execution_audit"
    ADD COLUMN "engine_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    ADD COLUMN "spec_schema_version" VARCHAR(16) NOT NULL DEFAULT '1.0';

UPDATE "report_definition_specs"
SET "spec_schema_version" = COALESCE(NULLIF("spec_json"->>'spec_version', ''), '1.0')
WHERE "spec_schema_version" = '1.0';

UPDATE "merchant_report_specs"
SET "spec_schema_version" = COALESCE(NULLIF("spec_json"->>'spec_version', ''), '1.0')
WHERE "spec_schema_version" = '1.0';

UPDATE "report_chrome_specs"
SET "spec_schema_version" = COALESCE(NULLIF("spec_json"->>'spec_version', ''), '1.0')
WHERE "spec_schema_version" = '1.0';

UPDATE "schema_versions" SET "version" = 34;
