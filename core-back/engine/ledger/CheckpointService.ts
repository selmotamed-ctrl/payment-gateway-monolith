import { Decimal } from "decimal.js";
import { decimal } from "./LedgerPoster";

/**
 * Per-shard ledger checkpoints.
 *
 * A checkpoint is a (balance, sequence) pair of ONE shard (`gl_shard_checkpoints`). The boundary is the
 * shard's own gapless line sequence, never a timestamp: the poster reserves each line's sequence number
 * under the shard row lock (see `ledgerShardWriter.ts`), so a snapshot that sees the shard at
 * (balance B, line_seq S) also sees every line with `shard_seq <= S`.
 *
 * Capturing a shard is ONE statement (one snapshot) that reads the shard and the checkpoint and sums the
 * lines in `(checkpoint_seq, line_seq]`. It proves two things before the checkpoint moves:
 *   * GAPLESS   the number of lines found equals `line_seq - checkpoint_seq` (a missing, duplicate or
 *               misattributed line is detected), and
 *   * PARITY    `checkpoint_balance + SUM(lines) = shard balance` (the shard balance matches the journal).
 * Only then is the checkpoint advanced, in a second tiny, monotonic upsert. It is O(lines since the last
 * checkpoint), takes no lock on the shard or the account, and never blocks a posting.
 */

export type ShardCaptureStatus = "ADVANCED" | "NOOP" | "GAP" | "PARITY";

export interface ShardCaptureResult {
  glAccountId: string;
  shardId: number;
  status: ShardCaptureStatus;
  /** Shard balance and high-water at the snapshot (debit-positive). */
  balance: Decimal;
  lineSeq: bigint;
  /** The checkpoint before and after this capture. */
  previousSeq: bigint;
  checkpointSeq: bigint;
  checkpointBalance: Decimal;
  /** Lines folded in by this capture (0 for NOOP and failures). */
  linesCovered: bigint;
  /** Lines actually found in (previousSeq, lineSeq]. */
  linesFound: bigint;
  /** shard balance minus (previous checkpoint + found lines); zero when they agree. */
  drift: Decimal;
  /** True when this was the first failure of the shard (consecutive_failures became 1). */
  firstFailure: boolean;
}

export class ShardParityError extends Error {
  readonly code = "LEDGER_SHARD_PARITY_MISMATCH";
  readonly result: ShardCaptureResult;
  constructor(result: ShardCaptureResult) {
    super(
      result.status === "GAP"
        ? `GL account '${result.glAccountId}' shard ${result.shardId}: ${result.linesFound} line(s) found for sequence range ` +
            `(${result.previousSeq}, ${result.lineSeq}] which holds ${result.lineSeq - result.previousSeq}`
        : `GL account '${result.glAccountId}' shard ${result.shardId}: shard balance ${result.balance.toFixed(4)} differs from ` +
            `checkpoint + journal by ${result.drift.toFixed(4)}`,
    );
    this.name = "ShardParityError";
    this.result = result;
  }
}

export interface CheckpointDb {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
}

export interface CheckpointServiceOptions {
  /**
   * Partition-pruning hint: lines with sequence above the checkpoint cannot be much older than the
   * checkpoint itself. `journal_lines.created_at` is stamped by the app process, so the margin is generous.
   * When a capture finds a gap WITH the hint it is retried once without it before a failure is recorded.
   */
  createdAtMarginSeconds?: number;
}

const DEFAULT_MARGIN_SECONDS = 2 * 86_400;

interface ShardSnapshotRow {
  balance: string;
  line_seq: string;
  cp_balance: string;
  cp_seq: string;
  found: string;
  delta: string;
}

const snapshotSql = (withHint: boolean): string => `
  WITH s AS (
    SELECT sh.current_balance AS balance, sh.line_seq AS line_seq,
           COALESCE(c.checkpoint_balance, 0) AS cp_balance, COALESCE(c.checkpoint_seq, 0) AS cp_seq,
           c.checkpoint_at AS cp_at
    FROM gl_account_shards sh
    LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id
    WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint
  ), d AS (
    SELECT COUNT(jl.shard_seq)::bigint AS found,
           COALESCE(SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS delta
    FROM s
    LEFT JOIN journal_lines jl
      ON jl.gl_account_id = $1::uuid AND jl.shard_id = $2::smallint
     AND jl.shard_seq > s.cp_seq AND jl.shard_seq <= s.line_seq
     ${withHint ? "AND (s.cp_at IS NULL OR jl.created_at >= (s.cp_at AT TIME ZONE 'UTC') - make_interval(secs => $3::double precision))" : ""}
  )
  SELECT s.balance::text AS balance, s.line_seq::text AS line_seq, s.cp_balance::text AS cp_balance,
         s.cp_seq::text AS cp_seq, (CASE WHEN s.line_seq > s.cp_seq THEN d.found ELSE 0 END)::text AS found, d.delta::text AS delta
  FROM s, d`;

export class CheckpointService {
  private readonly margin: number;

  constructor(
    private readonly db: CheckpointDb,
    options: CheckpointServiceOptions = {},
  ) {
    this.margin = options.createdAtMarginSeconds ?? DEFAULT_MARGIN_SECONDS;
  }

  /** Reads and verifies one shard against its checkpoint WITHOUT moving it. */
  async inspectShard(glAccountId: string, shardId: number): Promise<ShardCaptureResult> {
    const read = async (withHint: boolean): Promise<ShardSnapshotRow | undefined> => {
      const rows = await this.db.$queryRawUnsafe<ShardSnapshotRow[]>(
        snapshotSql(withHint),
        glAccountId,
        shardId,
        ...(withHint ? [this.margin] : []),
      );
      return rows[0];
    };
    let row = await read(true);
    if (!row) {
      throw new Error(`GL account '${glAccountId}' has no shard ${shardId}`);
    }
    let verdict = this.judge(glAccountId, shardId, row);
    if (verdict.status === "GAP") {
      // The hint may have hidden a legitimately old line; look at the whole range before alarming.
      const full = await read(false);
      if (full) {
        row = full;
        verdict = this.judge(glAccountId, shardId, row);
      }
    }
    return verdict;
  }

  private judge(glAccountId: string, shardId: number, row: ShardSnapshotRow): ShardCaptureResult {
    const lineSeq = BigInt(row.line_seq);
    const previousSeq = BigInt(row.cp_seq);
    const found = BigInt(row.found);
    const balance = decimal(row.balance);
    const expected = decimal(row.cp_balance).plus(decimal(row.delta));
    const drift = balance.minus(expected);
    const base = {
      glAccountId,
      shardId,
      balance,
      lineSeq,
      previousSeq,
      linesFound: found,
      drift,
      firstFailure: false,
    };
    const expectedLines = lineSeq - previousSeq;
    if (found !== expectedLines) {
      return { ...base, status: "GAP", checkpointSeq: previousSeq, checkpointBalance: decimal(row.cp_balance), linesCovered: 0n };
    }
    if (!drift.isZero()) {
      return { ...base, status: "PARITY", checkpointSeq: previousSeq, checkpointBalance: decimal(row.cp_balance), linesCovered: 0n };
    }
    if (expectedLines === 0n) {
      return { ...base, status: "NOOP", checkpointSeq: previousSeq, checkpointBalance: decimal(row.cp_balance), linesCovered: 0n };
    }
    return { ...base, status: "ADVANCED", checkpointSeq: lineSeq, checkpointBalance: balance, linesCovered: expectedLines };
  }

  /**
   * Captures one shard. Returns the verdict; on ADVANCED the checkpoint row has been moved (monotonically:
   * a concurrent capture that got further wins and this one reports NOOP). On GAP or PARITY nothing moves, the
   * failure is recorded on the checkpoint row and `firstFailure` tells the caller whether to raise an alert.
   */
  async captureShard(glAccountId: string, shardId: number): Promise<ShardCaptureResult> {
    const verdict = await this.inspectShard(glAccountId, shardId);
    if (verdict.status === "ADVANCED") {
      const moved = await this.db.$queryRawUnsafe<Array<{ moved: number }>>(
        `INSERT INTO gl_shard_checkpoints AS c
           (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, verified_at, status, failure_kind, consecutive_failures)
         VALUES ($1::uuid, $2::smallint, $3::numeric, $4::bigint, now(), now(), 'OK', NULL, 0)
         ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
           checkpoint_balance = EXCLUDED.checkpoint_balance,
           checkpoint_seq = EXCLUDED.checkpoint_seq,
           checkpoint_at = now(), verified_at = now(),
           status = 'OK', failure_kind = NULL, consecutive_failures = 0
         WHERE c.checkpoint_seq < EXCLUDED.checkpoint_seq
         RETURNING 1 AS moved`,
        glAccountId,
        shardId,
        verdict.checkpointBalance.toFixed(4),
        verdict.checkpointSeq.toString(),
      );
      if (moved.length === 0) {
        return { ...verdict, status: "NOOP", checkpointSeq: verdict.previousSeq, linesCovered: 0n };
      }
      return verdict;
    }
    if (verdict.status === "NOOP") {
      // Proven consistent with nothing to fold in: refresh `verified_at`, and clear an old failure.
      await this.db.$queryRawUnsafe(
        `UPDATE gl_shard_checkpoints SET verified_at = now(), status = 'OK', failure_kind = NULL, consecutive_failures = 0
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint AND (status <> 'OK' OR verified_at IS NULL OR verified_at < now() - interval '1 minute')`,
        glAccountId,
        shardId,
      );
      return verdict;
    }
    const recorded = await this.db.$queryRawUnsafe<Array<{ consecutive_failures: number }>>(
      `INSERT INTO gl_shard_checkpoints AS c
         (gl_account_id, shard_id, status, failure_kind, consecutive_failures, last_failure_at)
       VALUES ($1::uuid, $2::smallint, $3, $4, 1, now())
       ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
         status = EXCLUDED.status, failure_kind = EXCLUDED.failure_kind,
         consecutive_failures = c.consecutive_failures + 1, last_failure_at = now()
       RETURNING consecutive_failures`,
      glAccountId,
      shardId,
      verdict.status,
      verdict.status === "GAP"
        ? `found ${verdict.linesFound} of ${verdict.lineSeq - verdict.previousSeq} lines`
        : `drift ${verdict.drift.toFixed(4)}`,
    );
    return { ...verdict, firstFailure: Number(recorded[0]?.consecutive_failures ?? 0) === 1 };
  }

  /** Captures every shard row of an account (the manual "checkpoint now" action). */
  async captureAccount(glAccountId: string): Promise<ShardCaptureResult[]> {
    const shards = await this.db.$queryRawUnsafe<Array<{ shard_id: number }>>(
      `SELECT shard_id FROM gl_account_shards WHERE gl_account_id = $1::uuid ORDER BY shard_id`,
      glAccountId,
    );
    const results: ShardCaptureResult[] = [];
    for (const shard of shards) {
      results.push(await this.captureShard(glAccountId, Number(shard.shard_id)));
    }
    return results;
  }

  /**
   * Shards that deserve a checkpoint: enough new lines, or any new line and an old (or missing) checkpoint.
   * Shards in a failed state are retried at most every `retryFailedSeconds`.
   */
  async findCandidates(options: {
    minLines: number;
    maxAgeSeconds: number;
    retryFailedSeconds?: number;
    limit: number;
  }): Promise<Array<{ glAccountId: string; shardId: number; pendingLines: bigint }>> {
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string; shard_id: number; pending: string }>>(
      `SELECT s.gl_account_id::text AS id, s.shard_id, (s.line_seq - COALESCE(c.checkpoint_seq, 0))::text AS pending
       FROM gl_account_shards s
       LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
       WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0)
         AND (s.line_seq - COALESCE(c.checkpoint_seq, 0) >= $1::bigint
              OR c.checkpoint_at IS NULL
              OR c.checkpoint_at < now() - make_interval(secs => $2::double precision))
         AND (COALESCE(c.status, 'OK') = 'OK'
              OR c.last_failure_at IS NULL
              OR c.last_failure_at < now() - make_interval(secs => $3::double precision))
       ORDER BY (s.line_seq - COALESCE(c.checkpoint_seq, 0)) DESC
       LIMIT $4::int`,
      options.minLines,
      options.maxAgeSeconds,
      options.retryFailedSeconds ?? 600,
      options.limit,
    );
    return rows.map((row) => ({ glAccountId: row.id, shardId: Number(row.shard_id), pendingLines: BigInt(row.pending) }));
  }
}
