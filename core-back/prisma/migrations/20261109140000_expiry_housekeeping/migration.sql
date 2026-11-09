-- ============================================================================
-- AUTO-05 / AUTO-11 expiry housekeeping.
--
--  * ApprovalState.EXPIRED: an approval request that nobody decided before `expires_at` was only treated as expired
--    lazily, when somebody opened it, so the approvals queue showed stale items and, worse, their subject stayed
--    locked behind them. The housekeeping worker now closes them (and releases the subject exactly like a rejection).
--    The value is only added here; nothing in this migration uses it.
--  * notifications_secret_payload_idx: PARTIAL index over the finished notifications that still carry a sealed MFA code
--    or invitation token, so the scrub pass is index-backed and the index shrinks to nothing once they are scrubbed.
--    (Building it takes a brief write lock on `notifications`.)
--  * payment_links_pending_expiry_idx: PARTIAL index over the links that can still expire, for the same reason.
-- ============================================================================

ALTER TYPE "ApprovalState" ADD VALUE IF NOT EXISTS 'EXPIRED';

CREATE INDEX IF NOT EXISTS "notifications_secret_payload_idx"
  ON "notifications" ("updated_at")
  WHERE "status" <> 'QUEUED' AND ("payload_json" ? 'codeCiphertext' OR "payload_json" ? 'tokenCiphertext');

CREATE INDEX IF NOT EXISTS "payment_links_pending_expiry_idx"
  ON "payment_links" ("expires_at")
  WHERE "state" = 'PENDING' AND "expires_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Schema version 18
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 18, "updated_at" = now()
WHERE "id" = 1;
