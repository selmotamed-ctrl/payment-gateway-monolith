-- ============================================================================
-- AUTO-34 outbound merchant webhooks.
--
-- A merchant registers an HTTPS endpoint per application, receives a `whsec_` signing secret (stored encrypted with the
-- vault, with a second secret accepted during a rotation overlap) and the event types it wants (empty = all). Events
-- come from the transactional outbox; the fan-out writes one delivery per matching endpoint, the MerchantWebhookWorker
-- sends it (Standard Webhooks signature) with exponential backoff and parks it after the last attempt.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "merchant_webhook_endpoints" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "merchant_id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "url" TEXT NOT NULL,
  "description" TEXT,
  "event_types" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "disabled_reason" TEXT,
  "disabled_at" TIMESTAMP(3),
  "secret_ciphertext" TEXT NOT NULL,
  "previous_secret_ciphertext" TEXT,
  "previous_secret_expires_at" TIMESTAMP(3),
  "secret_rotated_at" TIMESTAMP(3),
  "failing_since" TIMESTAMP(3),
  "last_success_at" TIMESTAMP(3),
  "last_failure_at" TIMESTAMP(3),
  CONSTRAINT "merchant_webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_webhook_endpoints_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "merchant_webhook_endpoints_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "merchant_webhook_endpoints_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "merchant_webhook_endpoints_application_id_status_idx" ON "merchant_webhook_endpoints" ("application_id", "status");
CREATE INDEX IF NOT EXISTS "merchant_webhook_endpoints_merchant_id_idx" ON "merchant_webhook_endpoints" ("merchant_id");

CREATE TABLE IF NOT EXISTS "merchant_webhook_deliveries" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "endpoint_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "last_attempt_at" TIMESTAMP(3),
  "last_status_code" INTEGER,
  "last_latency_ms" INTEGER,
  "last_error" TEXT,
  "delivered_at" TIMESTAMP(3),
  "parked_at" TIMESTAMP(3),
  "park_reason" TEXT,
  CONSTRAINT "merchant_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_webhook_deliveries_status_check" CHECK ("status" IN ('PENDING', 'DELIVERED', 'PARKED')),
  CONSTRAINT "merchant_webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "merchant_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "merchant_webhook_deliveries_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- One delivery per event and endpoint, however many relay nodes or retries produce it.
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_webhook_deliveries_endpoint_id_event_id_key" ON "merchant_webhook_deliveries" ("endpoint_id", "event_id");
-- The worker's claim query: due PENDING rows.
CREATE INDEX IF NOT EXISTS "merchant_webhook_deliveries_due_idx" ON "merchant_webhook_deliveries" ("next_attempt_at") WHERE "status" = 'PENDING';
CREATE INDEX IF NOT EXISTS "merchant_webhook_deliveries_endpoint_id_created_at_idx" ON "merchant_webhook_deliveries" ("endpoint_id", "created_at");
CREATE INDEX IF NOT EXISTS "merchant_webhook_deliveries_merchant_id_status_created_at_idx" ON "merchant_webhook_deliveries" ("merchant_id", "status", "created_at");

-- ---------------------------------------------------------------------------
-- Schema version 24
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 24, "updated_at" = now()
WHERE "id" = 1;
