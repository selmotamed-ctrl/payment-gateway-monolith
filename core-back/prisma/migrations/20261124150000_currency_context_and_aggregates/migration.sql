-- Schema version 44: explicit reconciliation context for settlement sweeps.
--
-- A settlement sweep needs currency for TREASURY/FEE_ACCRUAL/CLEARING and
-- gateway/env/credential-set for the clearing leg. The context exists on the
-- matched attempt and its route; persist it on the item so a retried job does
-- not depend on re-deriving it (and so unmatched source-pinned rows can carry
-- the context explicitly).

ALTER TABLE "statement_sources"
  ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "env" VARCHAR(16),
  ADD COLUMN "credential_set_id" UUID;

ALTER TABLE "reconciliation_runs"
  ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "auto_post" BOOLEAN;

ALTER TABLE "reconciliation_items"
  ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "gateway_id" UUID,
  ADD COLUMN "env" VARCHAR(16),
  ADD COLUMN "credential_set_id" UUID;

CREATE INDEX "statement_sources_currency_idx" ON "statement_sources"("currency");
CREATE INDEX "reconciliation_runs_currency_idx" ON "reconciliation_runs"("currency");
CREATE INDEX "reconciliation_items_run_currency_idx" ON "reconciliation_items"("run_id", "currency");
CREATE INDEX "reconciliation_items_gateway_currency_idx" ON "reconciliation_items"("gateway_id", "currency");

-- Matched items: copy the authoritative attempt/route context.
UPDATE "reconciliation_items" i
SET "currency" = pa."currency",
    "env" = pa."env"::text,
    "credential_set_id" = pa."credential_set_id",
    "gateway_id" = rr."gateway_id"
FROM "payment_attempts" pa
LEFT JOIN "rail_routes" rr ON rr."id" = pa."route_id"
WHERE i."attempt_id" = pa."id"
  AND (i."currency" IS NULL OR i."gateway_id" IS NULL OR i."env" IS NULL OR i."credential_set_id" IS NULL);

-- Unmatched items may still inherit the source gateway (never a guessed currency).
UPDATE "reconciliation_items" i
SET "gateway_id" = s."gateway_id"
FROM "reconciliation_runs" r
JOIN "statement_sources" s ON s."id" = r."statement_source_id"
WHERE i."run_id" = r."id" AND i."gateway_id" IS NULL;

-- A run's display currency is the dominant matched currency, when unambiguous.
UPDATE "reconciliation_runs" r
SET "currency" = dominant."currency"
FROM (
  SELECT "run_id", "currency"
  FROM (
    SELECT "run_id", "currency", ROW_NUMBER() OVER (PARTITION BY "run_id" ORDER BY COUNT(*) DESC, "currency" ASC) AS rn
    FROM "reconciliation_items"
    WHERE "currency" IS NOT NULL
    GROUP BY "run_id", "currency"
  ) ranked
  WHERE rn = 1
) dominant
WHERE r."id" = dominant."run_id" AND r."currency" IS NULL;

-- Legacy source parser config may already carry a currency; only accept a 3-letter code.
UPDATE "statement_sources"
SET "currency" = UPPER("parser_config"->>'currency')
WHERE "currency" IS NULL
  AND COALESCE("parser_config"->>'currency', '') ~ '^[A-Za-z]{3}$';

UPDATE "schema_versions" SET "version" = 44, "updated_at" = now() WHERE "id" = 1;
