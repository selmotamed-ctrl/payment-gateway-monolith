-- Lease-based claim for the inbound webhook inbox.
--
-- `InboundInboxWorker` previously held `FOR UPDATE SKIP LOCKED` only until the
-- claim transaction committed, then processed the event outside a transaction
-- on the strength of the leader election alone. A brief dual-leadership window
-- could therefore handle the same webhook twice. `claimed_at`/`claimed_by`
-- make the claim durable and let a crashed node's rows be reclaimed after the
-- lease expires.

ALTER TABLE "inbound_events" ADD COLUMN "claimed_at" TIMESTAMPTZ(3);
ALTER TABLE "inbound_events" ADD COLUMN "claimed_by" TEXT;

CREATE INDEX "inbound_events_processed_at_claimed_at_idx"
  ON "inbound_events" ("processed_at", "claimed_at");

-- ---------------------------------------------------------------------------
-- Schema version 13
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 13, "updated_at" = now()
WHERE "id" = 1;
