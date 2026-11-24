-- Opaque, revocable Academy certificates (schema version 42).
--
-- Replaces the HMAC token-in-URL verification with a durable issuance row. The
-- public ID is an unguessable capability; the display ID is the short value a
-- holder may print or share. Existing badges are backfilled from the per-user
-- Academy progress JSON so no issued certificate disappears on upgrade.

CREATE TYPE "AcademyCertificateStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'REVOKED');

CREATE TABLE "academy_certificates" (
  "id" UUID NOT NULL,
  "public_id" VARCHAR(64) NOT NULL,
  "display_id" VARCHAR(32) NOT NULL,
  "user_id" UUID NOT NULL,
  "track_id" VARCHAR(64) NOT NULL,
  "badge_code" VARCHAR(64) NOT NULL,
  "holder_name" VARCHAR(120) NOT NULL,
  "earned_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "content_version" VARCHAR(20) NOT NULL,
  "status" "AcademyCertificateStatus" NOT NULL DEFAULT 'ACTIVE',
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by_user_id" UUID,
  "revocation_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "academy_certificates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "academy_certificates_public_id_key" UNIQUE ("public_id"),
  CONSTRAINT "academy_certificates_display_id_key" UNIQUE ("display_id"),
  CONSTRAINT "academy_certificates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "academy_certificates_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "academy_certificates_issuance_key" ON "academy_certificates"("user_id", "track_id", "earned_at");
CREATE UNIQUE INDEX "academy_certificates_one_active_key" ON "academy_certificates"("user_id", "track_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "idx_academy_certificates_user_track" ON "academy_certificates"("user_id", "track_id");
CREATE INDEX "idx_academy_certificates_status_expiry" ON "academy_certificates"("status", "expires_at");

ALTER TABLE "report_execution_audit" ADD COLUMN "checklist_json" JSONB;

-- Backfill the current one-badge-per-track progress shape. The public and
-- display identifiers are derived from gen_random_uuid(); collisions are
-- negligible and the unique indexes reject them if they ever occur.
INSERT INTO "academy_certificates" (
  "id", "public_id", "display_id", "user_id", "track_id", "badge_code",
  "holder_name", "earned_at", "expires_at", "content_version", "status"
)
SELECT
  gen_random_uuid(),
  replace(gen_random_uuid()::text, '-', ''),
  'PG-AC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  u."id",
  badge->>'track',
  COALESCE(badge->>'id', badge->>'track'),
  left(split_part(u."email", '@', 1), 120),
  (badge->>'earnedAt')::timestamptz,
  (badge->>'expiresAt')::timestamptz,
  left(COALESCE(badge->>'v', '1.0.0'), 20),
  'ACTIVE'::"AcademyCertificateStatus"
FROM "users" u
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(u."academy_progress_json"->'badges') = 'array' THEN u."academy_progress_json"->'badges'
    ELSE '[]'::jsonb
  END
) AS badge
WHERE u."academy_progress_json" IS NOT NULL
  AND badge->>'track' IS NOT NULL
  AND badge->>'earnedAt' IS NOT NULL
  AND badge->>'expiresAt' IS NOT NULL
  AND pg_input_is_valid(badge->>'earnedAt', 'timestamptz')
  AND pg_input_is_valid(badge->>'expiresAt', 'timestamptz')
ON CONFLICT ("user_id", "track_id", "earned_at") DO NOTHING;

UPDATE "schema_versions" SET "version" = 42;

-- MFA resend suppression scans queued LOGIN_MFA notifications for one user.
CREATE INDEX IF NOT EXISTS "idx_notifications_queued_login_mfa_user"
  ON "notifications" ("recipient_user_id")
  WHERE "status" = 'QUEUED' AND "template_code" = 'LOGIN_MFA';
