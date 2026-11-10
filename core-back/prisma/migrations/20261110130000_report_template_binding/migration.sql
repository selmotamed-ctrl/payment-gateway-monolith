ALTER TABLE "regulatory_report_schemas" ADD COLUMN "template_binding_json" JSONB;

UPDATE "schema_versions" SET "version" = 27;
