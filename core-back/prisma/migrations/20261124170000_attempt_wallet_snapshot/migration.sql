-- Schema version 45: snapshot the settlement wallet on each attempt.
--
-- A refund/chargeback must credit the wallet the payment was made into, even
-- if the merchant later creates another wallet of the same currency. New
-- attempts copy the link wallet; existing rows are backfilled where the link
-- still identifies an unambiguous wallet.

ALTER TABLE "payment_attempts"
  ADD COLUMN "wallet_id" UUID,
  ADD COLUMN "wallet_gl_account_id" UUID;

UPDATE "payment_attempts" pa
SET "wallet_id" = pl."wallet_id",
    "wallet_gl_account_id" = w."gl_account_id"
FROM "payment_links" pl
JOIN "wallets" w ON w."id" = pl."wallet_id"
WHERE pa."link_id" = pl."id"
  AND (pa."wallet_id" IS NULL OR pa."wallet_gl_account_id" IS NULL);

CREATE INDEX "payment_attempts_wallet_id_idx" ON "payment_attempts"("wallet_id");

UPDATE "schema_versions" SET "version" = 45, "updated_at" = now() WHERE "id" = 1;
