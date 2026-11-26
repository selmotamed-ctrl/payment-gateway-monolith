-- Schema v46: email-primary communication, encrypted platform-setting secrets,
-- Google OAuth state/tickets and password-reset session invalidation.

ALTER TABLE "users" ADD COLUMN "sessions_invalid_before" TIMESTAMPTZ(3);

ALTER TABLE "mfa_challenges"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'LOGIN_MFA',
  ADD COLUMN "delivery_channels" JSONB,
  ADD COLUMN "destination_masked" JSONB;

CREATE INDEX "mfa_challenges_purpose_idx" ON "mfa_challenges" ("purpose");

ALTER TABLE "notifications"
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "sent_at" TIMESTAMPTZ(3),
  ADD COLUMN "delivered_at" TIMESTAMPTZ(3);

ALTER TABLE "platform_settings" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ADMIN';

CREATE TABLE "platform_setting_secrets" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "key" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'PLATFORM',
  "version" INTEGER NOT NULL,
  "field" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  CONSTRAINT "platform_setting_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_setting_secrets_key_scope_version_field_key"
  ON "platform_setting_secrets" ("key", "scope", "version", "field");
CREATE INDEX "platform_setting_secrets_key_scope_idx"
  ON "platform_setting_secrets" ("key", "scope");

ALTER TABLE "platform_setting_secrets"
  ADD CONSTRAINT "platform_setting_secrets_setting_fkey"
  FOREIGN KEY ("key", "scope", "version")
  REFERENCES "platform_settings" ("key", "scope", "version")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "communication_channel_status" (
  "channel" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "last_test_at" TIMESTAMPTZ(3),
  "last_test_status" TEXT,
  "last_test_error" TEXT,
  "last_delivery_at" TIMESTAMPTZ(3),
  "last_delivery_status" TEXT,
  "last_delivery_error" TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_alert_at" TIMESTAMPTZ(3),
  CONSTRAINT "communication_channel_status_pkey" PRIMARY KEY ("channel")
);

CREATE TABLE "oauth_states" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "state_hash" CHAR(64) NOT NULL,
  "mode" TEXT NOT NULL,
  "return_path" TEXT NOT NULL,
  "redirect_uri" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "code_verifier_ciphertext" TEXT NOT NULL,
  "ip" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states" ("state_hash");
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" ("expires_at");

CREATE TABLE "oauth_login_tickets" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "token_hash" CHAR(64) NOT NULL,
  "user_id" UUID NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  CONSTRAINT "oauth_login_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_login_tickets_token_hash_key" ON "oauth_login_tickets" ("token_hash");
CREATE INDEX "oauth_login_tickets_expires_at_idx" ON "oauth_login_tickets" ("expires_at");

ALTER TABLE "oauth_login_tickets"
  ADD CONSTRAINT "oauth_login_tickets_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing active users already proved ownership of their mailbox operationally (or were invited by e-mail).
-- Do not lock them out when e-mail verification becomes mandatory. Synthetic placeholder addresses are skipped.
INSERT INTO "user_identities" ("id", "created_at", "updated_at", "user_id", "kind", "identifier_normalized", "verified_at", "is_primary")
SELECT gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, u."id", 'EMAIL', lower(u."email"), CURRENT_TIMESTAMP,
       NOT EXISTS (SELECT 1 FROM "user_identities" i WHERE i."user_id" = u."id" AND i."kind" = 'EMAIL')
FROM "users" u
WHERE u."email" IS NOT NULL
  AND u."status" = 'ACTIVE'
  AND u."email" NOT LIKE '%@pending.payment-gateway.local'
  AND u."email" NOT LIKE '%@invited.payment-gateway.local'
  AND NOT EXISTS (
    SELECT 1 FROM "user_identities" i
    WHERE i."kind" = 'EMAIL' AND i."identifier_normalized" = lower(u."email")
  )
ON CONFLICT ("kind", "identifier_normalized") DO NOTHING;

UPDATE "user_identities" i
SET "verified_at" = CURRENT_TIMESTAMP
FROM "users" u
WHERE i."user_id" = u."id"
  AND i."kind" = 'EMAIL'
  AND i."verified_at" IS NULL
  AND u."status" = 'ACTIVE'
  AND i."identifier_normalized" NOT LIKE '%@pending.payment-gateway.local'
  AND i."identifier_normalized" NOT LIKE '%@invited.payment-gateway.local';

-- Google identities are always verified by Google.
UPDATE "user_identities" SET "verified_at" = COALESCE("verified_at", CURRENT_TIMESTAMP) WHERE "kind" = 'GOOGLE';

UPDATE "schema_versions" SET "version" = 46;
