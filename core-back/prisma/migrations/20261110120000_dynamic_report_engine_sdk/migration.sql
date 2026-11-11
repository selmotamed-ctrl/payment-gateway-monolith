-- ============================================================================
-- Schema version 26: Dynamic AI-Transcript Report Engine SDK.
--
-- Four append-oriented registry tables: partnered asset bundles, reusable
-- header/footer chrome specs, versioned report descriptor specs (with inferred
-- authorities and Security Admin overrides) and an immutable execution audit.
-- Report specs are declarative JSON; no report query is ever stored as raw SQL.
-- ============================================================================

CREATE TYPE "ReportSpecStatus" AS ENUM ('DRAFT', 'VERIFIED', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "ReportChromeType" AS ENUM ('HEADER', 'FOOTER');
CREATE TYPE "ReportAudienceScope" AS ENUM ('BACKOFFICE_INTERNAL', 'MERCHANT_FACING', 'BOTH');
CREATE TYPE "ReportAuthorityMode" AS ENUM ('INFERRED_STRICT', 'SECURITY_ADMIN_OVERRIDE');

CREATE TABLE "report_asset_bundles" (
    "id" UUID NOT NULL,
    "bundle_sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "total_bytes" INTEGER NOT NULL,
    "file_count" INTEGER NOT NULL,
    "manifest_json" JSONB NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "report_asset_bundles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_asset_bundles_bundle_sha256_key"
    ON "report_asset_bundles" ("bundle_sha256");
CREATE INDEX "report_asset_bundles_uploader_created_idx"
    ON "report_asset_bundles" ("uploaded_by_user_id", "created_at" DESC);

CREATE TABLE "report_chrome_specs" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(120) NOT NULL,
    "chrome_type" "ReportChromeType" NOT NULL,
    "status" "ReportSpecStatus" NOT NULL DEFAULT 'DRAFT',
    "is_default_global" BOOLEAN NOT NULL DEFAULT false,
    "supported_locales" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "spec_json" JSONB NOT NULL,
    "spec_sha256" VARCHAR(64) NOT NULL,
    "asset_bundle_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "report_chrome_specs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_chrome_specs_code_version_key"
    ON "report_chrome_specs" ("code", "version");
CREATE INDEX "report_chrome_specs_type_status_default_idx"
    ON "report_chrome_specs" ("chrome_type", "status", "is_default_global");
-- At most one published global default header and one footer.
CREATE UNIQUE INDEX "report_chrome_specs_one_default_per_type_idx"
    ON "report_chrome_specs" ("chrome_type")
    WHERE "is_default_global" = true AND "status" = 'PUBLISHED';

CREATE TABLE "report_definition_specs" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "category" VARCHAR(48) NOT NULL,
    "audience_scope" "ReportAudienceScope" NOT NULL,
    "status" "ReportSpecStatus" NOT NULL DEFAULT 'DRAFT',
    "is_latest_published" BOOLEAN NOT NULL DEFAULT false,
    "supported_locales" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "default_locale" VARCHAR(16) NOT NULL DEFAULT 'en',
    "spec_json" JSONB NOT NULL,
    "spec_sha256" VARCHAR(64) NOT NULL,
    "verification_report_json" JSONB NOT NULL,
    "asset_bundle_id" UUID,
    "authority_mode" "ReportAuthorityMode" NOT NULL DEFAULT 'INFERRED_STRICT',
    "inferred_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "inferred_authorities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "conflict_status" VARCHAR(48) NOT NULL DEFAULT 'NONE',
    "requires_confidential_aml" BOOLEAN NOT NULL DEFAULT false,
    "override_allowed_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "override_allowed_authorities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "override_justification" TEXT,
    "overridden_by_user_id" UUID,
    "overridden_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "report_definition_specs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_definition_specs_code_version_key"
    ON "report_definition_specs" ("code", "version");
CREATE INDEX "report_definition_specs_published_cat_idx"
    ON "report_definition_specs" ("status", "is_latest_published", "category");
CREATE INDEX "report_definition_specs_audience_status_idx"
    ON "report_definition_specs" ("audience_scope", "status");

CREATE TABLE "report_execution_audit" (
    "id" UUID NOT NULL,
    "report_spec_id" UUID NOT NULL,
    "report_code" VARCHAR(64) NOT NULL,
    "report_version" INTEGER NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_role" VARCHAR(48) NOT NULL,
    "selected_locale" VARCHAR(16) NOT NULL,
    "scoped_merchant_id" UUID,
    "inputs_redacted_json" JSONB NOT NULL,
    "row_count_total" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "served_by_node" VARCHAR(64) NOT NULL,
    "verification_sha256" VARCHAR(64) NOT NULL,
    "render_target" VARCHAR(32) NOT NULL DEFAULT 'CLIENT_PAGED_VECTOR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "report_execution_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_execution_audit_actor_created_idx"
    ON "report_execution_audit" ("actor_user_id", "created_at" DESC);
CREATE INDEX "report_execution_audit_merchant_created_idx"
    ON "report_execution_audit" ("scoped_merchant_id", "created_at" DESC);
CREATE INDEX "report_execution_audit_spec_created_idx"
    ON "report_execution_audit" ("report_spec_id", "created_at" DESC);

ALTER TABLE "report_chrome_specs"
    ADD CONSTRAINT "report_chrome_specs_asset_bundle_id_fkey"
    FOREIGN KEY ("asset_bundle_id") REFERENCES "report_asset_bundles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "report_definition_specs"
    ADD CONSTRAINT "report_definition_specs_asset_bundle_id_fkey"
    FOREIGN KEY ("asset_bundle_id") REFERENCES "report_asset_bundles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "report_execution_audit"
    ADD CONSTRAINT "report_execution_audit_report_spec_id_fkey"
    FOREIGN KEY ("report_spec_id") REFERENCES "report_definition_specs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Schema version 26
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 26, "updated_at" = now()
WHERE "id" = 1;
