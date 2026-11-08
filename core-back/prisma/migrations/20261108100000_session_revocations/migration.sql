-- Durable copy of the session revoke list.
--
-- The revoke list lived only in Redis, which the deploy runs with a size limit and an eviction policy and (until
-- this change) no append-only file, so a revoked session could come back after an eviction or a restart and the
-- fail-open fallback only protected the node that processed the logout. The Redis flag stays the fast path; this
-- table is what a Redis miss falls back to, and it is bounded by the 12h session lifetime (rows are pruned once the
-- token would have expired anyway).

CREATE TABLE "session_revocations" (
    "jti" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_revocations_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "session_revocations_expires_at_idx" ON "session_revocations" ("expires_at");

-- ---------------------------------------------------------------------------
-- Schema version 15
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 15, "updated_at" = now()
WHERE "id" = 1;
