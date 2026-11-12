-- ============================================================================
-- Migration: 20261114000000_v38_parallel_sandbox_plane_and_ledger_fence
-- Schema Version: 38
--
-- Parallel Sandbox Plane:
--   1. plane tags on applications / wallets / access tokens / payment links /
--      journal entries;
--   2. the application-level Sandbox Checkout Inspector posture;
--   3. the singleton `sandbox_sync_watermarks` plane marker;
--   4. a defense-in-depth PostgreSQL fence that forbids SANDBOX rows (and
--      Fake Rails `FK-%` provider references) on the LIVE database, and LIVE
--      rows on the SANDBOX database.
--
-- The fence is intentionally opt-in at the connection/database level:
-- `pgw.strict_plane_fence = 'on'` enables it. Deploy-managed parallel
-- installations set the GUC on both databases; a single-database development
-- stack keeps it off so the pre-v38 SANDBOX behaviour continues to work.
-- The plane itself is read from `pgw.execution_plane` when set (deploy sets it
-- per database) and otherwise from the `sandbox_sync_watermarks` row.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "SandboxCheckoutInspectorMode" AS ENUM ('OPEN_IN_SANDBOX', 'PIN_PROTECTED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "applications"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE',
  ADD COLUMN IF NOT EXISTS "sandbox_inspector_mode" "SandboxCheckoutInspectorMode" NOT NULL DEFAULT 'OPEN_IN_SANDBOX',
  ADD COLUMN IF NOT EXISTS "sandbox_inspector_pin" VARCHAR(16);

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

ALTER TABLE "access_tokens"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

ALTER TABLE "payment_links"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

ALTER TABLE "journal_entries"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

CREATE TABLE IF NOT EXISTS "sandbox_sync_watermarks" (
  "id"                    VARCHAR(32) PRIMARY KEY,
  "execution_plane"       "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE',
  "last_catalog_sync_at"  TIMESTAMPTZ(3),
  "last_merchant_sync_at" TIMESTAMPTZ(3),
  "catalog_version_hash"  CHAR(64),
  "updated_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);

INSERT INTO "sandbox_sync_watermarks" ("id", "execution_plane", "updated_at")
VALUES ('singleton', 'LIVE', NOW())
ON CONFLICT ("id") DO NOTHING;

-- Pre-v38 payment links of merchants that were not ACTIVE were the existing
-- sandbox links (checkout derived the environment from the merchant status).
-- Preserve that behaviour after the migration: an ACTIVE merchant's links stay
-- LIVE and every other merchant's links become SANDBOX.
UPDATE "payment_links" AS pl
   SET "env" = 'SANDBOX'
  FROM "applications" AS a
  JOIN "merchants" AS m ON m."id" = a."merchant_id"
 WHERE pl."application_id" = a."id"
   AND m."status" <> 'ACTIVE'
   AND pl."env" = 'LIVE';

CREATE INDEX IF NOT EXISTS "applications_env_merchant_id_idx"
  ON "applications" ("env", "merchant_id");
CREATE INDEX IF NOT EXISTS "wallets_env_merchant_id_idx"
  ON "wallets" ("env", "merchant_id");
CREATE INDEX IF NOT EXISTS "access_tokens_env_merchant_id_idx"
  ON "access_tokens" ("env", "merchant_id");
CREATE INDEX IF NOT EXISTS "payment_links_env_application_id_idx"
  ON "payment_links" ("env", "application_id");
CREATE INDEX IF NOT EXISTS "journal_entries_env_created_at_idx"
  ON "journal_entries" ("env", "created_at");

CREATE OR REPLACE FUNCTION enforce_execution_plane_fence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_plane "GatewayEnvironmentType";
  v_guc TEXT;
  v_strict TEXT;
BEGIN
  v_guc := NULLIF(current_setting('pgw.execution_plane', true), '');
  IF v_guc IS NOT NULL AND upper(v_guc) IN ('LIVE', 'SANDBOX') THEN
    v_plane := upper(v_guc)::"GatewayEnvironmentType";
  ELSE
    SELECT "execution_plane" INTO v_plane
      FROM "sandbox_sync_watermarks"
     WHERE "id" = 'singleton';
  END IF;

  v_strict := lower(COALESCE(NULLIF(current_setting('pgw.strict_plane_fence', true), ''), 'off'));

  IF v_plane = 'SANDBOX' THEN
    IF NEW.env IS DISTINCT FROM 'SANDBOX' AND v_strict = 'on' THEN
      RAISE EXCEPTION 'SANDBOX_LEDGER_LIVE_POST_FORBIDDEN: cannot write LIVE row into SANDBOX database (table=%)', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
    NEW.env := 'SANDBOX';
    RETURN NEW;
  END IF;

  IF v_plane = 'LIVE' AND v_strict = 'on' THEN
    IF NEW.env = 'SANDBOX' THEN
      RAISE EXCEPTION 'LIVE_LEDGER_SANDBOX_POST_FORBIDDEN: SANDBOX row rejected by LIVE database fence (table=%)', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'payment_attempts'
       AND (to_jsonb(NEW) ->> 'provider_reference') IS NOT NULL
       AND (to_jsonb(NEW) ->> 'provider_reference') LIKE 'FK-%' THEN
      RAISE EXCEPTION 'LIVE_LEDGER_FAKE_RAILS_POST_FORBIDDEN: Fake Rails provider_reference (%) is forbidden on the LIVE database', (to_jsonb(NEW) ->> 'provider_reference')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_fence_journal_entries" ON "journal_entries";
CREATE TRIGGER "trg_fence_journal_entries"
BEFORE INSERT OR UPDATE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_payment_attempts" ON "payment_attempts";
CREATE TRIGGER "trg_fence_payment_attempts"
BEFORE INSERT OR UPDATE ON "payment_attempts"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_wallets" ON "wallets";
CREATE TRIGGER "trg_fence_wallets"
BEFORE INSERT OR UPDATE ON "wallets"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_applications" ON "applications";
CREATE TRIGGER "trg_fence_applications"
BEFORE INSERT OR UPDATE ON "applications"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

DROP TRIGGER IF EXISTS "trg_fence_payment_links" ON "payment_links";
CREATE TRIGGER "trg_fence_payment_links"
BEFORE INSERT OR UPDATE ON "payment_links"
FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_fence();

UPDATE "schema_versions" SET "version" = 38 WHERE "id" = 1;
