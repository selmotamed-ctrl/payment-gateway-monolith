-- Route health automation, canary traffic and admin overrides (schema version 40).
--
-- `health_state` remains the effective column used by routing. `health_computed_state`
-- is what the background sampler last measured; `health_override_state` is an
-- explicit admin override. The application derives effective health as override ??
-- computed and writes both in one transaction.

ALTER TABLE "rail_routes"
  ADD COLUMN "health_computed_state" "HealthState" NOT NULL DEFAULT 'HEALTHY',
  ADD COLUMN "health_computed_reason" TEXT,
  ADD COLUMN "health_computed_at" TIMESTAMP(3),
  ADD COLUMN "health_override_state" "HealthState",
  ADD COLUMN "health_override_reason" TEXT,
  ADD COLUMN "health_override_set_at" TIMESTAMP(3),
  ADD COLUMN "health_override_set_by" UUID,
  ADD COLUMN "health_override_expires_at" TIMESTAMP(3),
  ADD COLUMN "health_override_approval_id" UUID,
  ADD COLUMN "health_reason" TEXT,
  ADD COLUMN "health_changed_at" TIMESTAMP(3),
  ADD COLUMN "health_consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "health_probe_successes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "health_probe_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "health_last_probe_at" TIMESTAMP(3),
  ADD COLUMN "health_next_probe_at" TIMESTAMP(3);

UPDATE "rail_routes"
SET "health_computed_state" = "health_state",
    "health_computed_at" = "updated_at",
    "health_next_probe_at" = CASE WHEN "health_state" = 'HEALTHY' THEN NULL ELSE now() END
WHERE "health_computed_state" IS NULL OR "health_computed_at" IS NULL;

ALTER TABLE "payment_attempts"
  ADD COLUMN "first_terminal_at" TIMESTAMP(3),
  ADD COLUMN "first_unknown_at" TIMESTAMP(3),
  ADD COLUMN "canonical_error" TEXT;

UPDATE "payment_attempts"
SET "first_terminal_at" = COALESCE("terminal_at", "updated_at")
WHERE "status" IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED')
  AND "first_terminal_at" IS NULL;

UPDATE "payment_attempts"
SET "first_unknown_at" = "updated_at"
WHERE "status" = 'UNKNOWN' AND "terminal_at" IS NULL AND "first_unknown_at" IS NULL;

UPDATE "payment_attempts"
SET "canonical_error" = "substatus"
WHERE "canonical_error" IS NULL AND "status" IN ('FAILED', 'UNKNOWN') AND "substatus" IS NOT NULL;

ALTER TABLE "gateway_health_samples"
  ADD COLUMN "ignored_outcomes" INTEGER NOT NULL DEFAULT 0;

-- Seed history may contain duplicates per route/window. Keep one row before the
-- unique index is installed; the worker upserts on (route_id, window_start).
DELETE FROM "gateway_health_samples" a
USING "gateway_health_samples" b
WHERE a.ctid < b.ctid
  AND a."route_id" = b."route_id"
  AND a."window_start" = b."window_start";

DROP INDEX IF EXISTS "gateway_health_samples_route_id_window_start_idx";
CREATE UNIQUE INDEX "gateway_health_samples_route_id_window_start_key"
  ON "gateway_health_samples"("route_id", "window_start");

CREATE INDEX "rail_routes_health_override_state_idx"
  ON "rail_routes"("health_override_state");
CREATE INDEX "rail_routes_health_next_probe_at_idx"
  ON "rail_routes"("health_next_probe_at");
CREATE INDEX "payment_attempts_first_terminal_at_route_id_idx"
  ON "payment_attempts"("first_terminal_at", "route_id");
CREATE INDEX "payment_attempts_first_unknown_at_route_id_idx"
  ON "payment_attempts"("first_unknown_at", "route_id");

CREATE TYPE "RouteHealthEventSource" AS ENUM (
  'TRAFFIC', 'PROBE', 'CREDENTIAL', 'OVERRIDE', 'EXPIRY', 'SHADOW', 'INITIAL', 'MIGRATION'
);
CREATE TYPE "RouteHealthProbeMethod" AS ENUM ('CREDENTIAL_CHECK', 'BASE_URL', 'NONE');
CREATE TYPE "RouteHealthProbeStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED');

CREATE TABLE "route_health_events" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "route_id" UUID NOT NULL,
  "from_state" "HealthState",
  "to_state" "HealthState" NOT NULL,
  "source" "RouteHealthEventSource" NOT NULL,
  "reason" TEXT,
  "evidence_json" JSONB,
  "actor_user_id" UUID,
  "approval_request_id" UUID,
  CONSTRAINT "route_health_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "route_health_probes" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "route_id" UUID NOT NULL,
  "credential_set_id" UUID,
  "gateway_version_id" UUID,
  "method" "RouteHealthProbeMethod" NOT NULL,
  "status" "RouteHealthProbeStatus" NOT NULL,
  "reason" TEXT,
  "http_status" INTEGER,
  "latency_ms" INTEGER,
  CONSTRAINT "route_health_probes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "route_health_events_route_id_created_at_idx"
  ON "route_health_events"("route_id", "created_at");
CREATE INDEX "route_health_probes_route_id_created_at_idx"
  ON "route_health_probes"("route_id", "created_at");

ALTER TABLE "route_health_events"
  ADD CONSTRAINT "route_health_events_route_id_fkey"
  FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_health_probes"
  ADD CONSTRAINT "route_health_probes_route_id_fkey"
  FOREIGN KEY ("route_id") REFERENCES "rail_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "route_health_events" ("id", "route_id", "from_state", "to_state", "source", "reason")
SELECT gen_random_uuid(), "id", NULL, "health_state", 'MIGRATION', 'INITIAL_STATE'
FROM "rail_routes";


-- Every writer (Prisma, raw SQL, poll/expiry workers, governance, sandbox and
-- the seeder) must maintain the same first-transition markers. A trigger keeps
-- the route-health sample query correct even when a future writer forgets them.
CREATE OR REPLACE FUNCTION set_payment_attempt_health_markers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status::text = 'UNKNOWN' THEN
    NEW.first_unknown_at := COALESCE(NEW.first_unknown_at, now());
  END IF;
  IF NEW.status::text IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED') THEN
    NEW.first_terminal_at := COALESCE(NEW.first_terminal_at, NEW.terminal_at, now());
  END IF;
  IF NEW.canonical_error IS NULL
     AND NEW.substatus IS NOT NULL
     AND NEW.substatus NOT IN ('FINALIZING', 'FAILED', 'INQUIRY_FAILED')
     AND NEW.status::text IN ('FAILED', 'UNKNOWN') THEN
    NEW.canonical_error := NEW.substatus;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_attempts_health_markers ON "payment_attempts";
CREATE TRIGGER payment_attempts_health_markers
  BEFORE INSERT OR UPDATE ON "payment_attempts"
  FOR EACH ROW
  EXECUTE FUNCTION set_payment_attempt_health_markers();

UPDATE "schema_versions" SET "version" = 40;
