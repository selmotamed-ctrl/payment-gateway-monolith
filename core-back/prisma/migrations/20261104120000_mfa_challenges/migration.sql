-- ============================================================================
-- 2026-11-04 server-side single-use MFA challenges (security review C2).
--
-- The challenge used to be a signed, replayable JWT with no attempt counter.
-- It is now a row: the code is stored as an HMAC, every wrong guess counts,
-- and the row dies on success, lockout or expiry.
-- ============================================================================

-- AlterTable: API token expiry (previously accepted by the API but never stored).
ALTER TABLE "access_tokens" ADD COLUMN "expires_at" TIMESTAMP(3);

-- AlterTable: cash-out idempotency key and requesting merchant user (security review H4).
ALTER TABLE "cashout_requests" ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "requested_by_user_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "cashout_requests_merchant_id_idempotency_key_key" ON "cashout_requests"("merchant_id", "idempotency_key");

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "consumed_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mfa_challenges_user_id_created_at_idx" ON "mfa_challenges"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "mfa_challenges_expires_at_idx" ON "mfa_challenges"("expires_at");

-- AddForeignKey
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Schema version 10: mfa_challenges, cash-out idempotency, token expiry.
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 10, "updated_at" = now()
WHERE "id" = 1;
