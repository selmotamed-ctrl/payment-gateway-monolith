-- ============================================================================
-- Schema version 33: separate merchant report authoring line.
--
-- Merchant-authored specs, merchant-owned asset bundles and merchant execution
-- audit are physically separate from the staff report registry. A merchant can
-- never read or write another merchant's authoring rows.
-- ============================================================================

CREATE TABLE "merchant_report_asset_bundles" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "bundle_sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "total_bytes" INTEGER NOT NULL,
    "file_count" INTEGER NOT NULL,
    "manifest_json" JSONB NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_report_asset_bundles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "merchant_report_asset_bundles_merchant_sha_key"
    ON "merchant_report_asset_bundles" ("merchant_id", "bundle_sha256");
CREATE INDEX "merchant_report_asset_bundles_merchant_created_idx"
    ON "merchant_report_asset_bundles" ("merchant_id", "created_at" DESC);

CREATE TABLE "merchant_report_specs" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "category" VARCHAR(48) NOT NULL,
    "status" "ReportSpecStatus" NOT NULL DEFAULT 'DRAFT',
    "is_latest_published" BOOLEAN NOT NULL DEFAULT false,
    "supported_locales" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "default_locale" VARCHAR(16) NOT NULL DEFAULT 'en',
    "spec_json" JSONB NOT NULL,
    "spec_sha256" VARCHAR(64) NOT NULL,
    "verification_report_json" JSONB,
    "asset_bundle_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "merchant_report_specs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "merchant_report_specs_merchant_code_version_key"
    ON "merchant_report_specs" ("merchant_id", "code", "version");
CREATE UNIQUE INDEX "merchant_report_specs_merchant_latest_key"
    ON "merchant_report_specs" ("merchant_id", "code")
    WHERE "is_latest_published" = true;
CREATE INDEX "merchant_report_specs_merchant_published_idx"
    ON "merchant_report_specs" ("merchant_id", "status", "is_latest_published");
ALTER TABLE "merchant_report_specs"
    ADD CONSTRAINT "merchant_report_specs_asset_bundle_id_fkey"
    FOREIGN KEY ("asset_bundle_id") REFERENCES "merchant_report_asset_bundles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "merchant_report_execution_audit" (
    "id" UUID NOT NULL,
    "merchant_spec_id" UUID,
    "merchant_id" UUID NOT NULL,
    "report_code" VARCHAR(64) NOT NULL,
    "report_version" INTEGER NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_role" VARCHAR(48) NOT NULL,
    "selected_locale" VARCHAR(16) NOT NULL,
    "inputs_redacted_json" JSONB NOT NULL,
    "row_count_total" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "served_by_node" VARCHAR(64) NOT NULL,
    "verification_sha256" VARCHAR(64) NOT NULL,
    "render_target" VARCHAR(32) NOT NULL DEFAULT 'CLIENT_PAGED_VECTOR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_report_execution_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "merchant_report_execution_audit_merchant_created_idx"
    ON "merchant_report_execution_audit" ("merchant_id", "created_at" DESC);
CREATE INDEX "merchant_report_execution_audit_spec_created_idx"
    ON "merchant_report_execution_audit" ("merchant_spec_id", "created_at" DESC);
ALTER TABLE "merchant_report_execution_audit"
    ADD CONSTRAINT "merchant_report_execution_audit_merchant_spec_id_fkey"
    FOREIGN KEY ("merchant_spec_id") REFERENCES "merchant_report_specs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "merchant_report_rate_events" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_report_rate_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "merchant_report_rate_events_merchant_action_created_idx"
    ON "merchant_report_rate_events" ("merchant_id", "action", "created_at" DESC);

CREATE TABLE "merchant_report_studio_status" (
    "merchant_id" UUID NOT NULL,
    "suspended_at" TIMESTAMPTZ(3),
    "suspended_by_user_id" UUID,
    "reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "merchant_report_studio_status_pkey" PRIMARY KEY ("merchant_id")
);

-- Append-only execution audit (merchant line): blocks UPDATE/DELETE through the
-- application role, matching the staff execution audit protections.
CREATE OR REPLACE FUNCTION "prevent_merchant_report_audit_mutation"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'merchant_report_execution_audit is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "merchant_report_execution_audit_append_only"
    BEFORE UPDATE OR DELETE ON "merchant_report_execution_audit"
    FOR EACH ROW EXECUTE FUNCTION "prevent_merchant_report_audit_mutation"();

UPDATE "schema_versions" SET "version" = 33;
