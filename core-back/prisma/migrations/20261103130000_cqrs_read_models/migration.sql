-- CQRS read models maintained asynchronously by OutboxRelayWorker.
CREATE TABLE IF NOT EXISTS "rm_merchant_daily_stats" (
  "merchant_id"   UUID           NOT NULL,
  "day"           DATE           NOT NULL,
  "currency"      CHAR(3)        NOT NULL,
  "attempt_count" INTEGER        NOT NULL DEFAULT 0,
  "success_count" INTEGER        NOT NULL DEFAULT 0,
  "failure_count" INTEGER        NOT NULL DEFAULT 0,
  "gross_amount"  NUMERIC(18, 4) NOT NULL DEFAULT 0,
  "net_amount"    NUMERIC(18, 4) NOT NULL DEFAULT 0,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "rm_merchant_daily_stats_pkey" PRIMARY KEY ("merchant_id", "day", "currency")
);
CREATE INDEX IF NOT EXISTS "rm_merchant_daily_stats_day_idx" ON "rm_merchant_daily_stats" ("day");

CREATE TABLE IF NOT EXISTS "rm_route_daily_volumes" (
  "route_id"      UUID           NOT NULL,
  "day"           DATE           NOT NULL,
  "currency"      CHAR(3)        NOT NULL,
  "attempt_count" INTEGER        NOT NULL DEFAULT 0,
  "success_count" INTEGER        NOT NULL DEFAULT 0,
  "volume_amount" NUMERIC(18, 4) NOT NULL DEFAULT 0,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "rm_route_daily_volumes_pkey" PRIMARY KEY ("route_id", "day", "currency")
);
CREATE INDEX IF NOT EXISTS "rm_route_daily_volumes_day_idx" ON "rm_route_daily_volumes" ("day");
