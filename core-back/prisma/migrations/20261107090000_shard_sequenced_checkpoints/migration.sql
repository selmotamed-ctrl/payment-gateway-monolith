-- ============================================================================
-- Schema version 12: sequenced per-shard checkpoints and per-account shard width
--
-- Why
--   * The account-level checkpoint was a TIME boundary (`created_at > checkpoint_at`)
--     but `journal_lines.created_at` is stamped by the app process, so a line
--     stamped before the checkpoint could commit after it and be missed forever.
--   * Capturing it was O(all history) under a row lock that blocked postings.
--   * `journal_lines` carried no shard attribution, so history could not be
--     attributed to shards and the shard width was one global env value.
--
-- What
--   * `gl_account_shards.line_seq`: a per-shard high-water counter. The poster bumps
--     it in the same statement that updates the shard balance (row lock held to
--     commit), and stamps each line with `shard_id` + `shard_seq`. Commit order
--     therefore equals sequence order: a snapshot that sees (balance, line_seq)
--     also sees every line with `shard_seq <= line_seq`, and committed sequences
--     are gapless.
--   * `gl_shard_checkpoints`: one checkpoint per shard, a (balance, seq) pair.
--   * `gl_accounts.shard_count`: the routing width of an account (1..256), so a hot
--     account can be widened without remapping history (each line stores its shard).
--   * The account-level checkpoint columns are dropped; the account checkpoint is
--     derived (sum of its shard checkpoints).
--
-- Genesis (no rewrite of the append-only journal): existing lines keep
-- (shard_id 0, shard_seq 0) = "pre-genesis". Every account is collapsed to shard 0
-- whose balance is the journal truth, with a checkpoint at (balance, seq 0). New
-- lines start at seq 1, so a pre-genesis line is never counted twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Part A: columns, constraints, indexes
-- ----------------------------------------------------------------------------

ALTER TABLE "gl_accounts"
  ADD COLUMN "shard_count" SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN "shard_scaled_at" TIMESTAMPTZ(3);

ALTER TABLE "gl_accounts"
  ADD CONSTRAINT "gl_accounts_shard_count_range" CHECK ("shard_count" >= 1 AND "shard_count" <= 256);

ALTER TABLE "gl_account_shards"
  ADD COLUMN "line_seq" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "gl_account_shards"
  DROP CONSTRAINT IF EXISTS "gl_account_shards_shard_id_range";
ALTER TABLE "gl_account_shards"
  ADD CONSTRAINT "gl_account_shards_shard_id_range" CHECK ("shard_id" >= 0 AND "shard_id" < 256);

-- Hot rows are updated in place on every posting: leave room for HOT updates and
-- vacuum them aggressively (the table is tiny, the churn is high).
ALTER TABLE "gl_account_shards" SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 50);

-- journal_lines is range-partitioned: ADD COLUMN with a constant default is a
-- metadata-only change, existing rows read the default. The defaults are dropped
-- right after, so any INSERT that forgets the shard columns fails loudly.
ALTER TABLE "journal_lines"
  ADD COLUMN "shard_id" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "shard_seq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "journal_lines" ALTER COLUMN "shard_id" DROP DEFAULT;
ALTER TABLE "journal_lines" ALTER COLUMN "shard_seq" DROP DEFAULT;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_shard_id_range" CHECK ("shard_id" >= 0 AND "shard_id" < 256);

-- NOT VALID: pre-genesis rows (shard_seq = 0) are exempt and never validated; every
-- new row must carry a real sequence. (Uniqueness of the sequence cannot be a unique
-- index on a partitioned table without the partition key; the checkpointer proves
-- "gapless and duplicate free" for every range it advances over.)
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_shard_seq_positive" CHECK ("shard_seq" > 0) NOT VALID;

CREATE INDEX "journal_lines_shard_seq_idx"
  ON "journal_lines" ("gl_account_id", "shard_id", "shard_seq")
  INCLUDE ("direction", "amount");

-- One row per shard that has a checkpoint. A shard without a row is (0, seq 0).
CREATE TABLE "gl_shard_checkpoints" (
  "gl_account_id" UUID NOT NULL,
  "shard_id" SMALLINT NOT NULL,
  "checkpoint_balance" DECIMAL(18, 4) NOT NULL DEFAULT 0,
  "checkpoint_seq" BIGINT NOT NULL DEFAULT 0,
  "checkpoint_at" TIMESTAMPTZ(3),
  "verified_at" TIMESTAMPTZ(3),
  "status" TEXT NOT NULL DEFAULT 'OK',
  "failure_kind" TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_failure_at" TIMESTAMPTZ(3),
  CONSTRAINT "gl_shard_checkpoints_pkey" PRIMARY KEY ("gl_account_id", "shard_id"),
  CONSTRAINT "gl_shard_checkpoints_status_check" CHECK ("status" IN ('OK', 'GAP', 'PARITY')),
  CONSTRAINT "gl_shard_checkpoints_shard_fkey"
    FOREIGN KEY ("gl_account_id", "shard_id") REFERENCES "gl_account_shards" ("gl_account_id", "shard_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "gl_shard_checkpoints_status_idx" ON "gl_shard_checkpoints" ("status") WHERE "status" <> 'OK';

-- Operator cases get a subject key so independent ledger alerts (global invariant
-- drift versus one shard's parity) do not suppress each other.
ALTER TABLE "operator_cases" ADD COLUMN "subject_key" TEXT;
CREATE UNIQUE INDEX "operator_cases_open_subject_key_uniq"
  ON "operator_cases" ("kind", "subject_key")
  WHERE "subject_key" IS NOT NULL AND "state" <> 'RESOLVED';

-- ----------------------------------------------------------------------------
-- Part B: genesis. The journal is the truth.
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE "_genesis_totals" ON COMMIT DROP AS
SELECT a."id" AS "gl_account_id",
       COALESCE(SUM(CASE WHEN jl."direction" = 'DEBIT' THEN jl."amount" ELSE -jl."amount" END), 0)::NUMERIC(18, 4) AS "total",
       (SELECT COALESCE(SUM(s."current_balance"), 0) FROM "gl_account_shards" s WHERE s."gl_account_id" = a."id") AS "old_shard_total",
       EXISTS (SELECT 1 FROM "gl_account_shards" s WHERE s."gl_account_id" = a."id") AS "had_shards"
FROM "gl_accounts" a
LEFT JOIN "journal_lines" jl ON jl."gl_account_id" = a."id"
GROUP BY a."id";

DO $$
DECLARE repaired integer;
BEGIN
  SELECT COUNT(*) INTO repaired FROM "_genesis_totals" WHERE "had_shards" AND "total" <> "old_shard_total";
  IF repaired > 0 THEN
    RAISE NOTICE 'sequenced checkpoints genesis: % account(s) had shard totals that differed from the journal; the journal was used', repaired;
  END IF;
END $$;

-- Width: every account that was sharded before keeps its 16-way spread, wallets stay at 1.
UPDATE "gl_accounts" SET "shard_count" = 16 WHERE "account_type" <> 'MERCHANT_WALLET';

DELETE FROM "gl_account_shards";

INSERT INTO "gl_account_shards" ("gl_account_id", "shard_id", "current_balance", "line_seq", "updated_at")
SELECT a."id", g."shard_id", CASE WHEN g."shard_id" = 0 THEN t."total" ELSE 0 END, 0, now()
FROM "gl_accounts" a
JOIN "_genesis_totals" t ON t."gl_account_id" = a."id"
CROSS JOIN LATERAL generate_series(0, a."shard_count" - 1) AS g("shard_id");

INSERT INTO "gl_shard_checkpoints" ("gl_account_id", "shard_id", "checkpoint_balance", "checkpoint_seq", "checkpoint_at", "verified_at")
SELECT a."id", g."shard_id", CASE WHEN g."shard_id" = 0 THEN t."total" ELSE 0 END, 0, now(), now()
FROM "gl_accounts" a
JOIN "_genesis_totals" t ON t."gl_account_id" = a."id"
CROSS JOIN LATERAL generate_series(0, a."shard_count" - 1) AS g("shard_id");

-- The account-level checkpoint is derived from its shards from now on.
ALTER TABLE "gl_accounts"
  DROP COLUMN "checkpoint_balance",
  DROP COLUMN "checkpoint_at",
  DROP COLUMN "last_checkpoint_id";

-- ----------------------------------------------------------------------------
-- Part C: every account always has its shard rows (0 .. shard_count - 1)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "pgw_gl_account_create_shards"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO "gl_account_shards" ("gl_account_id", "shard_id")
  SELECT NEW."id", g."shard_id" FROM generate_series(0, NEW."shard_count" - 1) AS g("shard_id")
  ON CONFLICT ("gl_account_id", "shard_id") DO NOTHING;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS "gl_accounts_create_shards" ON "gl_accounts";
CREATE TRIGGER "gl_accounts_create_shards"
  AFTER INSERT ON "gl_accounts"
  FOR EACH ROW EXECUTE FUNCTION "pgw_gl_account_create_shards"();

-- ---------------------------------------------------------------------------
-- Schema version 12
-- ---------------------------------------------------------------------------
UPDATE "schema_versions"
SET "version" = 12, "updated_at" = now()
WHERE "id" = 1;
