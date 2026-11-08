-- ============================================================================
-- Schema version 14: ledger shard repair history and the re-baseline marker
--
-- A shard is a PROJECTION of the immutable journal. When a shard fails its checkpoint proof it is repaired by
-- recomputing the projection from the journal (never by posting a ledger entry: that would change the journal,
-- which was right). Two kinds exist:
--   * RECOMPUTE  the sequence of the shard is intact (gapless, no duplicates): only the stored balance/checkpoint
--                disagrees with the journal. Automatic (guarded) or manual.
--   * REBASELINE the sequence itself is damaged (lines missing or duplicated): the shard is re-baselined at its
--                highest sequence and the damaged history before it is exempted from the gapless proof through
--                `baseline_seq`. Always manual and approved by a second person.
--
-- `gl_shard_repairs` is the append-only history of every repair (who, why, before/after, plan hash).
-- ============================================================================

ALTER TABLE "gl_shard_checkpoints" ADD COLUMN "baseline_seq" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "gl_shard_repairs" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "gl_account_id" UUID NOT NULL,
  "shard_id" SMALLINT NOT NULL,
  "kind" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "plan_hash" TEXT NOT NULL,
  "before_balance" DECIMAL(18, 4) NOT NULL,
  "after_balance" DECIMAL(18, 4) NOT NULL,
  "delta" DECIMAL(18, 4) NOT NULL,
  "before_line_seq" BIGINT NOT NULL,
  "after_line_seq" BIGINT NOT NULL,
  "before_checkpoint_seq" BIGINT NOT NULL,
  "after_checkpoint_seq" BIGINT NOT NULL,
  "baseline_seq_after" BIGINT NOT NULL,
  "actor_id" UUID,
  "reason" TEXT NOT NULL,
  "approval_request_id" UUID,
  "details_json" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "gl_shard_repairs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gl_shard_repairs_kind_check" CHECK ("kind" IN ('RECOMPUTE', 'REBASELINE')),
  CONSTRAINT "gl_shard_repairs_mode_check" CHECK ("mode" IN ('AUTO', 'MANUAL', 'APPROVED')),
  CONSTRAINT "gl_shard_repairs_shard_fkey"
    FOREIGN KEY ("gl_account_id", "shard_id") REFERENCES "gl_account_shards" ("gl_account_id", "shard_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "gl_shard_repairs_shard_idx" ON "gl_shard_repairs" ("gl_account_id", "shard_id", "created_at");

-- ---------------------------------------------------------------------------
-- Schema version 14
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 14, "updated_at" = now()
WHERE "id" = 1;
