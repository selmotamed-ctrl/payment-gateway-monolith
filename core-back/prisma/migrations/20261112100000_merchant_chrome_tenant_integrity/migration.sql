-- ============================================================================
-- Schema version 36: tenant-safe merchant report headers and footers, and one
-- agreed schema version after two branches were merged.
--
-- 1. merchant_report_chrome_specs (20261111130000) referenced an asset bundle
--    by id only and its merchant_id was not a foreign key: the gap that
--    20261111090000 closed for merchant_report_specs. Nothing at the database
--    level stopped merchant A's header from pointing at merchant B's asset
--    bundle. The reference now also carries merchant_id (composite foreign key
--    onto UNIQUE (id, merchant_id), MATCH SIMPLE: a NULL asset_bundle_id is not
--    checked), and merchant_id references merchants.
--
-- 2. Two branches each added migrations numbered 34 and 35
--    (20261111090000 = 34, 20261111120000 = 34, 20261111130000 = 35,
--    20261112090000 = 35). None of the four is edited, because each may already
--    be applied somewhere and `prisma migrate deploy` applies whatever is
--    missing in name order, so the value they leave behind depends on which
--    branch a database saw first. This migration is new to every database, runs
--    last, and sets the version both branches agree on.
--
-- Running this on a database where a merchant header or footer already uses
-- another merchant's asset bundle fails with a foreign-key error: fix the row
-- first.
-- ============================================================================

ALTER TABLE "merchant_report_chrome_specs"
    ADD CONSTRAINT "merchant_report_chrome_specs_asset_bundle_tenant_fkey"
    FOREIGN KEY ("asset_bundle_id", "merchant_id")
    REFERENCES "merchant_report_asset_bundles" ("id", "merchant_id")
    ON DELETE SET NULL ("asset_bundle_id") ON UPDATE CASCADE;

ALTER TABLE "merchant_report_chrome_specs"
    ADD CONSTRAINT "merchant_report_chrome_specs_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "schema_versions" SET "version" = 36;
