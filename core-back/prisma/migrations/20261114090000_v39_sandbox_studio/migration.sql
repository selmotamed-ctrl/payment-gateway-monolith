-- v39: Sandbox Studio parity fields.
--
-- Wallet labels and payment-link titles/descriptions were already accepted by
-- the portal contracts but silently discarded. They are nullable so existing
-- rows and the Live flow are unaffected.

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "name" VARCHAR(120);

ALTER TABLE "payment_links"
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(160);

ALTER TABLE "payment_links"
  ADD COLUMN IF NOT EXISTS "description" TEXT;

UPDATE "schema_versions" SET "version" = 39;
