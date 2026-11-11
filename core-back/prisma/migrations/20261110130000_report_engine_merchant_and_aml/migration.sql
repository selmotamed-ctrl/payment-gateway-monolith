-- ============================================================================
-- Schema version 27: report-engine hardening and merchant execution.
--
-- 1. A confidential-AML authority override must be explicit and approved by a
--    second MLRO / Security Admin; the flag is stored on the report spec.
-- 2. Only one version per report code may be the latest published version.
-- 3. Report execution audit rows are append-only.
-- ============================================================================

ALTER TABLE "report_definition_specs"
    ADD COLUMN "allow_confidential_aml_bypass" BOOLEAN NOT NULL DEFAULT false;

-- A concurrent publish must not leave two latest-published rows for one code.
CREATE UNIQUE INDEX "report_definition_specs_one_latest_published_idx"
    ON "report_definition_specs" ("code")
    WHERE "is_latest_published" = true;

CREATE OR REPLACE FUNCTION "pgw_report_execution_audit_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'report_execution_audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS "report_execution_audit_no_update_delete" ON "report_execution_audit";
CREATE TRIGGER "report_execution_audit_no_update_delete"
    BEFORE UPDATE OR DELETE ON "report_execution_audit"
    FOR EACH ROW
    EXECUTE FUNCTION "pgw_report_execution_audit_append_only"();

DROP TRIGGER IF EXISTS "report_execution_audit_no_truncate" ON "report_execution_audit";
CREATE TRIGGER "report_execution_audit_no_truncate"
    BEFORE TRUNCATE ON "report_execution_audit"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "pgw_report_execution_audit_append_only"();

UPDATE "schema_versions"
SET "version" = 27, "updated_at" = now()
WHERE "id" = 1;
