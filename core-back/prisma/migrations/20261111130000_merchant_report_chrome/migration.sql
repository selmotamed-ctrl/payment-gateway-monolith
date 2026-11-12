-- Schema version 35: merchant-owned report headers and footers.
CREATE TABLE "merchant_report_chrome_specs" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(120) NOT NULL,
    "chrome_type" "ReportChromeType" NOT NULL,
    "status" "ReportSpecStatus" NOT NULL DEFAULT 'DRAFT',
    "is_default_for_merchant" BOOLEAN NOT NULL DEFAULT false,
    "default_revoked_at" TIMESTAMPTZ(3),
    "default_revoked_reason" VARCHAR(64),
    "engine_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    "spec_schema_version" VARCHAR(16) NOT NULL DEFAULT '1.0',
    "authoring_transcript_version" VARCHAR(16),
    "supported_locales" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "spec_json" JSONB NOT NULL,
    "spec_sha256" VARCHAR(64) NOT NULL,
    "asset_bundle_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "merchant_report_chrome_specs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "merchant_report_chrome_specs_merchant_code_version_key"
    ON "merchant_report_chrome_specs" ("merchant_id", "code", "version");
CREATE UNIQUE INDEX "merchant_report_chrome_specs_one_default_per_merchant_type_idx"
    ON "merchant_report_chrome_specs" ("merchant_id", "chrome_type")
    WHERE "is_default_for_merchant" = true AND "status" = 'PUBLISHED';
CREATE INDEX "merchant_report_chrome_specs_merchant_type_status_idx"
    ON "merchant_report_chrome_specs" ("merchant_id", "chrome_type", "status", "is_default_for_merchant");
ALTER TABLE "merchant_report_chrome_specs"
    ADD CONSTRAINT "merchant_report_chrome_specs_asset_bundle_id_fkey"
    FOREIGN KEY ("asset_bundle_id") REFERENCES "merchant_report_asset_bundles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "schema_versions" SET "version" = 35;
