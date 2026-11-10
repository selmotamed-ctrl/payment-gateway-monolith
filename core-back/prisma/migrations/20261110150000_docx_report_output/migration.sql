ALTER TYPE "ReportOutputFormat" ADD VALUE IF NOT EXISTS 'DOCX';

UPDATE "schema_versions" SET "version" = 29;
