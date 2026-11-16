-- ============================================================================
-- Schema version 40: tenant-safe merchant report headers and footers, and one
-- agreed schema version after the branches were merged.
--
-- 1. merchant_report_chrome_specs (20261111130000) referenced an asset bundle
--    by id only and its merchant_id was not a foreign key: the gap that
--    20261111090000 closed for merchant_report_specs. Nothing at the database
--    level stopped merchant A's header from pointing at merchant B's asset
--    bundle. The reference now also carries merchant_id (composite foreign key
--    onto UNIQUE (id, merchant_id), MATCH SIMPLE: a NULL asset_bundle_id is not
--    checked), and merchant_id references merchants.
--
-- 2. The branches numbered their migrations independently:
--      20261111090000 = 34   (claude-fixes)
--      20261111120000 = 34   (plan branch)
--      20261111130000 = 35   (plan branch)
--      20261112000000 = 36   (master)
--      20261112090000 = 35   (claude-fixes)
--      20261113090000 = 37, 20261113120000 = 38, 20261114090000 = 39 (master)
--    None of them is edited, because each may already be applied somewhere.
--    `prisma migrate deploy` applies whatever is missing in name order, so the
--    value they leave behind depends on which branch a database saw first: a
--    database that followed master (39) and then receives the claude-fixes
--    migrations would be left at 35. This migration is new to every database,
--    runs last, and sets the version all branches agree on.
--
--    (It was first written as 20261112100000 with version 36 while only the
--    plan branch had been merged. That name was never pushed or deployed; it
--    was renamed so that it also runs after master's migrations.)
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

UPDATE "schema_versions" SET "version" = 40;
