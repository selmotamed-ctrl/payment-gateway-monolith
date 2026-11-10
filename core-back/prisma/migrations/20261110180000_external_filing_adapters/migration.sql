CREATE TYPE "FilingAdapterKind" AS ENUM ('MANUAL', 'HTTP');
CREATE TYPE "FilingAdapterStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "ExternalSubmissionStatus" AS ENUM ('PENDING', 'SUBMITTED', 'FAILED', 'ACKNOWLEDGED', 'REJECTED');

CREATE TABLE "external_filing_adapters" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "name" TEXT NOT NULL,
  "authority" TEXT NOT NULL,
  "kind" "FilingAdapterKind" NOT NULL DEFAULT 'MANUAL',
  "status" "FilingAdapterStatus" NOT NULL DEFAULT 'ACTIVE',
  "endpoint_url" TEXT,
  "auth_header_name" TEXT,
  "auth_secret_ciphertext" TEXT,
  "timeout_seconds" INTEGER NOT NULL DEFAULT 30,
  "config_json" JSONB,
  "created_by_user_id" UUID,
  "last_used_at" TIMESTAMP(3),
  CONSTRAINT "external_filing_adapters_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_submissions" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "report_id" UUID NOT NULL,
  "adapter_id" UUID NOT NULL,
  "status" "ExternalSubmissionStatus" NOT NULL DEFAULT 'PENDING',
  "request_sha256" CHAR(64) NOT NULL,
  "external_ref" TEXT,
  "response_code" INTEGER,
  "response_body" TEXT,
  "submitted_at" TIMESTAMP(3),
  "error_message" TEXT,
  CONSTRAINT "external_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_filing_adapters_name_key" ON "external_filing_adapters"("name");
CREATE INDEX "external_filing_adapters_authority_status_idx" ON "external_filing_adapters"("authority", "status");
CREATE INDEX "external_submissions_report_id_created_at_idx" ON "external_submissions"("report_id", "created_at");
CREATE INDEX "external_submissions_adapter_id_status_idx" ON "external_submissions"("adapter_id", "status");
ALTER TABLE "external_submissions" ADD CONSTRAINT "external_submissions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "regulatory_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_submissions" ADD CONSTRAINT "external_submissions_adapter_id_fkey" FOREIGN KEY ("adapter_id") REFERENCES "external_filing_adapters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "schema_versions" SET "version" = 32;
