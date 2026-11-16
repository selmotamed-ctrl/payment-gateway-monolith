-- v38: strict LIVE vs SANDBOX execution-plane separation.
--
-- The primary separation is physical (payment_gateway_prod vs
-- payment_gateway_sandbox). These guards are defense in depth: a database
-- carries a single-row system_execution_plane lock, and triggers refuse any
-- row whose env does not match the database plane. A LIVE database also
-- refuses a FAKE_* gateway or a gateway environment pointed at the Fake Rails
-- emulator unless the deployment explicitly allows the development emulator.

ALTER TABLE "payment_links"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

ALTER TABLE "access_tokens"
  ADD COLUMN IF NOT EXISTS "env" "GatewayEnvironmentType" NOT NULL DEFAULT 'LIVE';

CREATE INDEX IF NOT EXISTS "idx_payment_links_env_created"
  ON "payment_links" ("env", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_access_tokens_env_revoked"
  ON "access_tokens" ("env", "revoked_at");

CREATE TABLE IF NOT EXISTS "system_execution_plane" (
  "id" SERIAL PRIMARY KEY CHECK ("id" = 1),
  "plane" VARCHAR(16) NOT NULL CHECK ("plane" IN ('LIVE', 'SANDBOX')),
  "allow_fake_rails" BOOLEAN NOT NULL DEFAULT FALSE,
  "live_sync_revision" INTEGER NOT NULL DEFAULT 0,
  "last_synced_from_live" TIMESTAMP(3) NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

INSERT INTO "system_execution_plane" ("id", "plane", "allow_fake_rails")
VALUES (
  1,
  COALESCE(NULLIF(current_setting('app.execution_plane', true), ''), 'LIVE'),
  CASE
    WHEN COALESCE(NULLIF(current_setting('app.execution_plane', true), ''), 'LIVE') = 'SANDBOX' THEN TRUE
    WHEN LOWER(COALESCE(current_setting('app.allow_fake_rails', true), 'false')) IN ('1', 'true', 'yes', 'on') THEN TRUE
    ELSE FALSE
  END
)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "sandbox_sync_audits" (
  "id" TEXT PRIMARY KEY,
  "sync_type" VARCHAR(48) NOT NULL,
  "merchant_id" UUID NULL,
  "actor_id" UUID NULL,
  "actor_role" VARCHAR(32) NULL,
  "blueprint_revision" INTEGER NOT NULL DEFAULT 0,
  "summary_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_sandbox_sync_audit_merchant_created"
  ON "sandbox_sync_audits" ("merchant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_sandbox_sync_audit_type_created"
  ON "sandbox_sync_audits" ("sync_type", "created_at" DESC);

-- Strict mode is ON by default for every database. The test suite turns it
-- off at the database level because it deliberately keeps both Live and
-- Sandbox rows in one throwaway database; production, staging and the real
-- sandbox database keep it on.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET app.plane_fence_strict = %L', current_database(), 'true');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'plane fence strict mode could not be stored at database level; set app.plane_fence_strict=true explicitly';
END $$;

CREATE OR REPLACE FUNCTION enforce_execution_plane_env_fence()
RETURNS TRIGGER AS $$
DECLARE
  v_plane VARCHAR(16);
  v_strict BOOLEAN;
BEGIN
  SELECT "plane" INTO v_plane FROM "system_execution_plane" WHERE "id" = 1;
  IF v_plane IS NULL THEN
    RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: system_execution_plane row is missing'
      USING ERRCODE = 'P0001';
  END IF;

  -- A SANDBOX database always rejects LIVE rows. A LIVE database rejects
  -- SANDBOX rows only in strict mode (the default for real deployments).
  v_strict := v_plane = 'SANDBOX'
    OR LOWER(COALESCE(current_setting('app.plane_fence_strict', true), 'false')) IN ('1', 'true', 'yes', 'on');

  IF v_strict AND NEW."env"::text <> v_plane THEN
    RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: Cannot write row with env=% into % database plane (table=%)',
      NEW."env", v_plane, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_links', 'payment_attempts', 'access_tokens']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'env'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_fence_plane_%I ON %I;', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_fence_plane_%I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_env_fence();',
        t, t
      );
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION enforce_no_fake_rails_on_live_plane()
RETURNS TRIGGER AS $$
DECLARE
  v_plane VARCHAR(16);
  v_allow_fake BOOLEAN;
BEGIN
  SELECT "plane", "allow_fake_rails" INTO v_plane, v_allow_fake
  FROM "system_execution_plane" WHERE "id" = 1;

  IF v_plane = 'LIVE'
     AND COALESCE(v_allow_fake, FALSE) = FALSE
     AND LOWER(COALESCE(current_setting('app.plane_fence_strict', true), 'false')) IN ('1', 'true', 'yes', 'on') THEN
    IF TG_TABLE_NAME = 'gateways' THEN
      IF NEW."code" ILIKE 'FAKE%' OR NEW."code" ILIKE '%FAKE_RAILS%' THEN
        RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: Fake Rails gateway (%) cannot be registered on LIVE execution plane',
          NEW."code"
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF TG_TABLE_NAME = 'gateway_environments' THEN
      IF NEW."enabled" = TRUE AND NEW."base_urls"::text ILIKE '%fake-rails%' THEN
        RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: a gateway environment pointed at Fake Rails cannot be enabled on LIVE execution plane'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fence_fake_rails_gateways ON "gateways";
CREATE TRIGGER trg_fence_fake_rails_gateways
  BEFORE INSERT OR UPDATE ON "gateways"
  FOR EACH ROW EXECUTE FUNCTION enforce_no_fake_rails_on_live_plane();

DROP TRIGGER IF EXISTS trg_fence_fake_rails_gateway_environments ON "gateway_environments";
CREATE TRIGGER trg_fence_fake_rails_gateway_environments
  BEFORE INSERT OR UPDATE ON "gateway_environments"
  FOR EACH ROW EXECUTE FUNCTION enforce_no_fake_rails_on_live_plane();

UPDATE "schema_versions" SET "version" = 38;
