-- ============================================================================
-- Schema version 41: the version both branches agree on after the 2026-11-16
-- merge of origin/master into claude-fixes.
--
-- Two migrations already set version 40 on their own branches and neither may
-- be edited (each may already be applied somewhere):
--   20261116090000_merchant_chrome_tenant_integrity  (claude-fixes)
--   20261116120000_route_health_automation           (master)
-- A database that applied only one of them reports 40, so 40 alone no longer
-- says which schema is present. This migration is new to every database, runs
-- after both, and sets 41: 41 means both are applied.
--
-- It changes no structure on purpose. Both migrations above must already be
-- applied (they run first in name order), or prisma applies them now, so a
-- database at any earlier point ends at 41 with the whole chain.
-- ============================================================================

UPDATE "schema_versions" SET "version" = 41;
