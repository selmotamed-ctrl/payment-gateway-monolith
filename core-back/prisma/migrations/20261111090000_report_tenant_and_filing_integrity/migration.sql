-- ============================================================================
-- Schema version 34: tenant-safe merchant report references, a consistent
-- append-only execution audit, and one open filing per report and adapter.
--
-- Found by the 2026-11-11 review of 20261110180000 and 20261110190000.
--
-- 1. The merchant report tables referenced each other by id only, so nothing at
--    the database level stopped merchant A's spec from pointing at merchant B's
--    asset bundle (whose storage key and manifest then render into A's report),
--    or an audit row from carrying B's spec under A's merchant_id. Each
--    reference now also carries merchant_id (composite foreign keys onto
--    UNIQUE (id, merchant_id)), and every table's merchant_id is a real foreign
--    key. MATCH SIMPLE: a NULL asset_bundle_id / merchant_spec_id is not checked.
--
-- 2. merchant_report_execution_audit.merchant_spec_id was ON DELETE SET NULL,
--    which issues an UPDATE, and the table's append-only trigger rejects every
--    UPDATE: deleting a spec that audit rows reference failed, and bypassing the
--    trigger to get around it would have mutated the audit trail. It is now
--    RESTRICT (specs are archived, never deleted). The table also gets the
--    TRUNCATE guard the staff execution audit already has.
--
-- 3. external_submissions had only non-unique indexes: two requests (a retry, a
--    double click, two nodes) could both insert a PENDING row and POST the same
--    filing to the regulator twice. At most one submission per report and
--    adapter may now be open or done (PENDING, SUBMITTED, ACKNOWLEDGED); a
--    FAILED or REJECTED one can be retried. The route that creates the row maps
--    the violation to its existing 409.
--
-- Running this on a database that already holds two open submissions for the
-- same report and adapter fails with a duplicate-key error: resolve them first.
-- ============================================================================

-- 1. Tenant-safe references --------------------------------------------------

ALTER TABLE "merchant_report_asset_bundles"
    ADD CONSTRAINT "merchant_report_asset_bundles_id_merchant_key" UNIQUE ("id", "merchant_id");
ALTER TABLE "merchant_report_specs"
    ADD CONSTRAINT "merchant_report_specs_id_merchant_key" UNIQUE ("id", "merchant_id");

-- A spec may only use an asset bundle of its own merchant. Deleting the bundle
-- clears the reference exactly like the single-column foreign key does.
ALTER TABLE "merchant_report_specs"
    ADD CONSTRAINT "merchant_report_specs_asset_bundle_tenant_fkey"
    FOREIGN KEY ("asset_bundle_id", "merchant_id")
    REFERENCES "merchant_report_asset_bundles" ("id", "merchant_id")
    ON DELETE SET NULL ("asset_bundle_id") ON UPDATE CASCADE;

-- An audit row may only reference a spec of its own merchant.
ALTER TABLE "merchant_report_execution_audit"
    ADD CONSTRAINT "merchant_report_execution_audit_spec_tenant_fkey"
    FOREIGN KEY ("merchant_spec_id", "merchant_id")
    REFERENCES "merchant_report_specs" ("id", "merchant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "merchant_report_asset_bundles"
    ADD CONSTRAINT "merchant_report_asset_bundles_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "merchant_report_specs"
    ADD CONSTRAINT "merchant_report_specs_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "merchant_report_execution_audit"
    ADD CONSTRAINT "merchant_report_execution_audit_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "merchant_report_rate_events"
    ADD CONSTRAINT "merchant_report_rate_events_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "merchant_report_studio_status"
    ADD CONSTRAINT "merchant_report_studio_status_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Append-only audit: no SET NULL, no TRUNCATE ------------------------------

ALTER TABLE "merchant_report_execution_audit"
    DROP CONSTRAINT "merchant_report_execution_audit_merchant_spec_id_fkey";
ALTER TABLE "merchant_report_execution_audit"
    ADD CONSTRAINT "merchant_report_execution_audit_merchant_spec_id_fkey"
    FOREIGN KEY ("merchant_spec_id") REFERENCES "merchant_report_specs" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS "merchant_report_execution_audit_no_truncate" ON "merchant_report_execution_audit";
CREATE TRIGGER "merchant_report_execution_audit_no_truncate"
    BEFORE TRUNCATE ON "merchant_report_execution_audit"
    FOR EACH STATEMENT EXECUTE FUNCTION "prevent_merchant_report_audit_mutation"();

-- 3. One open or completed filing per report and adapter ----------------------

CREATE UNIQUE INDEX "external_submissions_open_report_adapter_key"
    ON "external_submissions" ("report_id", "adapter_id")
    WHERE "status" IN ('PENDING', 'SUBMITTED', 'ACKNOWLEDGED');

UPDATE "schema_versions" SET "version" = 34, "updated_at" = now() WHERE "id" = 1;
