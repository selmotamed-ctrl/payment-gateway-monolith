import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { ApiError } from "../../lib/error";
import { writeAudit } from "../../lib/audit/writeAudit";
import { LEDGER_SUBJECT_KEYS, inTransaction } from "./ledgerAlerts";

type Any = Record<string, any>;

/**
 * Repair of a ledger shard that fails its checkpoint proof.
 *
 * A shard (`gl_account_shards`) is a PROJECTION of the immutable journal. When the projection disagrees with the
 * journal, the journal is right by definition, so the repair recomputes the projection from the journal. It never
 * posts a ledger entry to "fix" a shard: an adjusting entry changes the journal too, which leaves the shard exactly
 * as wrong as before (and records a false economic event).
 *
 * Two kinds of repair, decided by whether the shard's SEQUENCE is intact:
 *
 *   RECOMPUTE   the lines of the shard are exactly 1..line_seq (above the baseline), each once: nothing is missing or
 *               duplicated, only the stored balance or checkpoint disagrees with the journal. The shard balance becomes
 *               the sum of ALL its journal lines and the checkpoint is set to (that sum, line_seq). Safe to automate.
 *
 *   REBASELINE  the sequence is damaged (a line is missing or a number is used twice). Recomputing from the journal
 *               would DROP money the shard held if the journal lost a line, so a human must decide. The shard is
 *               re-baselined at its highest sequence: balance := journal sum, `line_seq := max(line_seq, highest
 *               sequence found)` (a number is never reused), checkpoint := that point, and `baseline_seq` is set so
 *               the damaged history before it is exempt from the gapless proof. Never automatic; needs approval.
 *
 * Everything is decided from one deep read of the shard's journal lines, taken WITHOUT the shard row lock (AUTO-10):
 * a deep read covers the shard's whole history and can take seconds, and every posting to the shard waits on that
 * row lock with a ~4.75 s budget, so holding the lock during the deep read made payments fail.
 *
 * The apply step therefore works in two parts:
 *
 *   1. outside the lock: the deep read. Besides the totals over every line it records the aggregates of the lines
 *      with `shard_seq <= line_seq` as of that snapshot (the FROZEN part). A posting reserves its sequence numbers
 *      from `line_seq` under the row lock, so every line committed later has a sequence ABOVE the snapshot's
 *      `line_seq`: the frozen part can never change again (the journal is append-only).
 *   2. under the lock: re-read only the shard row and its checkpoint, and the lines ABOVE the snapshot's `line_seq`
 *      (the tail: what was posted since the snapshot, an index range scan bounded by `maxTailLines`). Frozen + tail is
 *      exactly what a deep read at that instant would return, so the plan and its `planHash` are identical to the old
 *      under-the-lock re-plan.
 *
 * When the checkpoint moved between the two parts, or the tail is longer than the bound, the repair is not applied:
 * an automatic repair simply tries again on the next tick, a previewed repair answers `SHARD_REPAIR_PLAN_CHANGED`.
 * The apply refuses to proceed when the plan no longer matches the plan the caller saw (`planHash`).
 */

export type ShardRepairKind = "RECOMPUTE" | "REBASELINE";
export type ShardRepairMode = "AUTO" | "MANUAL" | "APPROVED";

export interface ShardRepairPlan {
  glAccountId: string;
  shardId: number;
  /** Nothing to do: the shard already matches its journal and its checkpoint is proven. */
  needsRepair: boolean;
  kind: ShardRepairKind | null;
  sequenceIntact: boolean;
  status: string;
  consecutiveFailures: number;
  before: { balance: Decimal; lineSeq: bigint; checkpointBalance: Decimal; checkpointSeq: bigint; baselineSeq: bigint };
  truth: {
    /** Signed (debit positive) sum of EVERY journal line of the shard. */
    total: Decimal;
    /** Sum of the lines up to the stored checkpoint sequence. */
    uptoCheckpoint: Decimal;
    linesAfterBaseline: bigint;
    distinctAfterBaseline: bigint;
    maxSeq: bigint;
  };
  after: { balance: Decimal; lineSeq: bigint; checkpointBalance: Decimal; checkpointSeq: bigint; baselineSeq: bigint };
  /** after.balance - before.balance: how far the stored balance moves. */
  delta: Decimal;
  planHash: string;
  /**
   * The FROZEN part of the deep read: the aggregates of the lines with `shard_seq <= snapshot.lineSeq` (and the
   * checkpoint they were computed against). Present on a plan from `planShardRepair`; `applyShardRepair` combines it
   * with the tail read under the lock instead of re-reading the shard's whole history while holding the lock.
   */
  snapshot?: ShardFrozenPart;
}

/** Aggregates of a set of journal lines of one shard (signed: debit positive). */
interface LineAggregates {
  total: Decimal;
  uptoCheckpoint: Decimal;
  linesAfterBaseline: bigint;
  distinctAfterBaseline: bigint;
  maxSeq: bigint;
}

export interface ShardFrozenPart extends LineAggregates {
  /** `line_seq` of the shard when the deep read ran: no later line can have a sequence at or below it. */
  lineSeq: bigint;
  /** The checkpoint and baseline the aggregates were computed against. */
  checkpointBalance: Decimal;
  checkpointSeq: bigint;
  baselineSeq: bigint;
}

interface ShardHead {
  balance: Decimal;
  lineSeq: bigint;
  checkpointBalance: Decimal;
  checkpointSeq: bigint;
  baselineSeq: bigint;
  status: string;
  failures: number;
}

interface DeepRow {
  balance: string;
  line_seq: string;
  cp_balance: string;
  cp_seq: string;
  baseline_seq: string;
  status: string;
  failures: number;
  total: string;
  upto_cp: string;
  after_baseline: string;
  distinct_after: string;
  max_seq: string;
  f_total: string;
  f_upto_cp: string;
  f_after_baseline: string;
  f_distinct_after: string;
  f_max_seq: string;
}

/**
 * The deep read: the shard row, its checkpoint and the aggregates of ALL its journal lines, plus the same aggregates
 * restricted to `shard_seq <= line_seq` (the frozen part). One statement, so everything comes from one snapshot.
 */
const DEEP_SQL = `
  SELECT sh.current_balance::text AS balance, sh.line_seq::text AS line_seq,
         COALESCE(c.checkpoint_balance, 0)::text AS cp_balance, COALESCE(c.checkpoint_seq, 0)::text AS cp_seq,
         COALESCE(c.baseline_seq, 0)::text AS baseline_seq, COALESCE(c.status, 'OK') AS status,
         COALESCE(c.consecutive_failures, 0)::int AS failures,
         j.total::text AS total, j.upto_cp::text AS upto_cp, j.after_baseline::text AS after_baseline,
         j.distinct_after::text AS distinct_after, j.max_seq::text AS max_seq,
         j.f_total::text AS f_total, j.f_upto_cp::text AS f_upto_cp, j.f_after_baseline::text AS f_after_baseline,
         j.f_distinct_after::text AS f_distinct_after, j.f_max_seq::text AS f_max_seq
  FROM gl_account_shards sh
  LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(x.signed), 0) AS total,
           COALESCE(SUM(x.signed) FILTER (WHERE x.seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS upto_cp,
           COUNT(*) FILTER (WHERE x.seq > COALESCE(c.baseline_seq, 0)) AS after_baseline,
           COUNT(DISTINCT x.seq) FILTER (WHERE x.seq > COALESCE(c.baseline_seq, 0)) AS distinct_after,
           COALESCE(MAX(x.seq), 0) AS max_seq,
           COALESCE(SUM(x.signed) FILTER (WHERE x.seq <= sh.line_seq), 0) AS f_total,
           COALESCE(SUM(x.signed) FILTER (WHERE x.seq <= sh.line_seq AND x.seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS f_upto_cp,
           COUNT(*) FILTER (WHERE x.seq <= sh.line_seq AND x.seq > COALESCE(c.baseline_seq, 0)) AS f_after_baseline,
           COUNT(DISTINCT x.seq) FILTER (WHERE x.seq <= sh.line_seq AND x.seq > COALESCE(c.baseline_seq, 0)) AS f_distinct_after,
           COALESCE(MAX(x.seq) FILTER (WHERE x.seq <= sh.line_seq), 0) AS f_max_seq
    FROM (
      SELECT l.shard_seq AS seq, CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed
      FROM journal_lines l
      WHERE l.gl_account_id = sh.gl_account_id AND l.shard_id = sh.shard_id
    ) x
  ) j
  WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint`;

/** The shard row and its checkpoint, locked. Taken only for the short apply step. */
const LOCK_HEAD_SQL = `
  SELECT sh.current_balance::text AS balance, sh.line_seq::text AS line_seq,
         COALESCE(c.checkpoint_balance, 0)::text AS cp_balance, COALESCE(c.checkpoint_seq, 0)::text AS cp_seq,
         COALESCE(c.baseline_seq, 0)::text AS baseline_seq, COALESCE(c.status, 'OK') AS status,
         COALESCE(c.consecutive_failures, 0)::int AS failures
  FROM gl_account_shards sh
  LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id
  WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint
  FOR UPDATE OF sh`;

/**
 * The tail: the lines ABOVE a sequence number (an index range scan on `journal_lines_shard_seq_idx`). $4 is the
 * checkpoint sequence and $5 the baseline the aggregates are computed against.
 */
const TAIL_SQL = `
  SELECT COALESCE(SUM(x.signed), 0)::text AS total,
         COALESCE(SUM(x.signed) FILTER (WHERE x.seq <= $4::bigint), 0)::text AS upto_cp,
         COUNT(*) FILTER (WHERE x.seq > $5::bigint)::text AS after_baseline,
         COUNT(DISTINCT x.seq) FILTER (WHERE x.seq > $5::bigint)::text AS distinct_after,
         COALESCE(MAX(x.seq), 0)::text AS max_seq
  FROM (
    SELECT l.shard_seq AS seq, CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed
    FROM journal_lines l
    WHERE l.gl_account_id = $1::uuid AND l.shard_id = $2::smallint AND l.shard_seq > $3::bigint
  ) x`;

const dec = (value: string): Decimal => new Decimal(value);

interface HeadRow {
  balance: string;
  line_seq: string;
  cp_balance: string;
  cp_seq: string;
  baseline_seq: string;
  status: string;
  failures: number;
}

const headOf = (row: HeadRow): ShardHead => ({
  balance: dec(row.balance),
  lineSeq: BigInt(row.line_seq),
  checkpointBalance: dec(row.cp_balance),
  checkpointSeq: BigInt(row.cp_seq),
  baselineSeq: BigInt(row.baseline_seq),
  status: row.status,
  failures: Number(row.failures),
});

/** Reads the shard and ALL its journal lines and decides what a repair would do. Pure of side effects; takes no lock. */
export const planShardRepair = async (db: Any, glAccountId: string, shardId: number): Promise<ShardRepairPlan> => {
  const rows = (await db.$queryRawUnsafe(DEEP_SQL, glAccountId, shardId)) as DeepRow[];
  const row = rows[0];
  if (!row) throw new ApiError(404, "GL_SHARD_NOT_FOUND", "The shard does not exist");
  const head = headOf(row);
  const plan = buildPlan(glAccountId, shardId, head, {
    total: dec(row.total),
    uptoCheckpoint: dec(row.upto_cp),
    linesAfterBaseline: BigInt(row.after_baseline),
    distinctAfterBaseline: BigInt(row.distinct_after),
    maxSeq: BigInt(row.max_seq),
  });
  // Older test doubles answer the deep read without the frozen columns: such a plan simply has no snapshot and the
  // apply step falls back to a fresh deep read.
  if (row.f_total !== undefined && row.f_total !== null) {
    plan.snapshot = {
      lineSeq: head.lineSeq,
      checkpointBalance: head.checkpointBalance,
      checkpointSeq: head.checkpointSeq,
      baselineSeq: head.baselineSeq,
      total: dec(row.f_total),
      uptoCheckpoint: dec(row.f_upto_cp),
      linesAfterBaseline: BigInt(row.f_after_baseline),
      distinctAfterBaseline: BigInt(row.f_distinct_after),
      maxSeq: BigInt(row.f_max_seq),
    };
  }
  return plan;
};

/** Decides the repair from the shard head and the aggregates of all its lines. Pure. */
const buildPlan = (glAccountId: string, shardId: number, head: ShardHead, lines: LineAggregates): ShardRepairPlan => {
  const { balance, lineSeq, checkpointBalance, checkpointSeq, baselineSeq } = head;
  const { total, uptoCheckpoint, linesAfterBaseline, distinctAfterBaseline, maxSeq } = lines;
  const row = { status: head.status, failures: head.failures };

  // Intact: above the baseline the sequence numbers are exactly baseline+1 .. line_seq, each used once.
  const expectedLines = lineSeq - baselineSeq;
  const sequenceIntact =
    linesAfterBaseline === expectedLines &&
    distinctAfterBaseline === linesAfterBaseline &&
    (expectedLines === 0n ? maxSeq <= baselineSeq : maxSeq === lineSeq);

  const checkpointProven = checkpointBalance.equals(uptoCheckpoint);
  const needsRepair = !(sequenceIntact && balance.equals(total) && checkpointProven && row.status === "OK");

  const newLineSeq = sequenceIntact ? lineSeq : lineSeq > maxSeq ? lineSeq : maxSeq;
  const after = {
    balance: total,
    lineSeq: newLineSeq,
    checkpointBalance: total,
    checkpointSeq: newLineSeq,
    baselineSeq: sequenceIntact ? baselineSeq : newLineSeq,
  };
  const kind: ShardRepairKind | null = !needsRepair ? null : sequenceIntact ? "RECOMPUTE" : "REBASELINE";
  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        glAccountId,
        shardId,
        balance: balance.toFixed(4),
        lineSeq: lineSeq.toString(),
        cp: checkpointBalance.toFixed(4),
        cpSeq: checkpointSeq.toString(),
        baselineSeq: baselineSeq.toString(),
        total: total.toFixed(4),
        uptoCheckpoint: uptoCheckpoint.toFixed(4),
        linesAfterBaseline: linesAfterBaseline.toString(),
        distinctAfterBaseline: distinctAfterBaseline.toString(),
        maxSeq: maxSeq.toString(),
        status: row.status,
      }),
    )
    .digest("hex");

  return {
    glAccountId,
    shardId,
    needsRepair,
    kind,
    sequenceIntact,
    status: row.status,
    consecutiveFailures: Number(row.failures),
    before: { balance, lineSeq, checkpointBalance, checkpointSeq, baselineSeq },
    truth: { total, uptoCheckpoint, linesAfterBaseline, distinctAfterBaseline, maxSeq },
    after,
    delta: total.minus(balance),
    planHash,
  };
};

export type ShardRepairStaleReason = "SHARD_MOVED" | "TAIL_TOO_LONG";

/**
 * Combines the frozen part of an earlier deep read with the shard head read UNDER THE LOCK and the tail of lines
 * above the snapshot's `line_seq` (also read under the lock). Returns the plan a full deep read would return at this
 * instant, or a stale reason when the frozen part can no longer be reused (the checkpoint or baseline moved) or the
 * tail would take too long to read while holding the lock.
 */
const planUnderLock = async (
  tx: Any,
  glAccountId: string,
  shardId: number,
  frozen: ShardFrozenPart,
  head: ShardHead,
  maxTailLines: number,
): Promise<ShardRepairPlan | ShardRepairStaleReason> => {
  const moved =
    head.lineSeq < frozen.lineSeq ||
    head.checkpointSeq !== frozen.checkpointSeq ||
    head.baselineSeq !== frozen.baselineSeq ||
    !head.checkpointBalance.equals(frozen.checkpointBalance);
  if (moved) return "SHARD_MOVED";
  // Every line posted since the snapshot took a sequence in (frozen.lineSeq, head.lineSeq]: that bounds the tail
  // without reading it. (A damaged shard can also hold lines above its line_seq; they are few by nature.)
  if (head.lineSeq - frozen.lineSeq > BigInt(Math.max(0, Math.trunc(maxTailLines)))) return "TAIL_TOO_LONG";
  const rows = (await tx.$queryRawUnsafe(
    TAIL_SQL,
    glAccountId,
    shardId,
    frozen.lineSeq.toString(),
    frozen.checkpointSeq.toString(),
    frozen.baselineSeq.toString(),
  )) as Array<{ total: string; upto_cp: string; after_baseline: string; distinct_after: string; max_seq: string }>;
  const tail = rows[0] ?? { total: "0", upto_cp: "0", after_baseline: "0", distinct_after: "0", max_seq: "0" };
  const tailMax = BigInt(tail.max_seq);
  return buildPlan(glAccountId, shardId, head, {
    total: frozen.total.plus(dec(tail.total)),
    uptoCheckpoint: frozen.uptoCheckpoint.plus(dec(tail.upto_cp)),
    linesAfterBaseline: frozen.linesAfterBaseline + BigInt(tail.after_baseline),
    // The frozen part (seq <= snapshot line_seq) and the tail (seq > it) never share a sequence number.
    distinctAfterBaseline: frozen.distinctAfterBaseline + BigInt(tail.distinct_after),
    maxSeq: tailMax > frozen.maxSeq ? tailMax : frozen.maxSeq,
  });
};

// ---------------------------------------------------------------------------------------------
// Automatic repair policy
// ---------------------------------------------------------------------------------------------

export interface AutoRepairPolicy {
  enabled: boolean;
  /** The proof must have failed this many consecutive times (a transient read or a race is never repaired). */
  minConsecutiveFailures: number;
  /** The balance may move by at most this much (absolute); a larger correction is left to a human. */
  maxAbsDelta: Decimal;
  /**
   * A shard with more lines than this above its baseline is repaired automatically only inside the maintenance
   * window (its deep read is heavy). Unset: no size limit.
   */
  maxLinesOutsideWindow?: number;
  /** The maintenance window in UTC hours, `[startHour, endHour)`, may wrap midnight. Unset: there is no window. */
  maintenanceWindowUtc?: { startHour: number; endHour: number };
}

/** True when `now` falls inside the UTC window `[startHour, endHour)` (wrapping midnight when start > end). */
export const inMaintenanceWindow = (now: Date, window: { startHour: number; endHour: number } | undefined): boolean => {
  if (!window) return false;
  const hour = now.getUTCHours();
  const start = ((Math.trunc(window.startHour) % 24) + 24) % 24;
  const end = ((Math.trunc(window.endHour) % 24) + 24) % 24;
  if (start === end) return true; // a full-day window
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
};

/** The size check alone (usable before the deep read, with an approximate line count). */
export const repairSizeAllowed = (lines: bigint, policy: AutoRepairPolicy, now: Date): boolean =>
  policy.maxLinesOutsideWindow === undefined ||
  lines <= BigInt(Math.max(0, Math.trunc(policy.maxLinesOutsideWindow))) ||
  inMaintenanceWindow(now, policy.maintenanceWindowUtc);

export interface AutoRepairVerdict {
  allowed: boolean;
  reason: string;
}

/** Only a RECOMPUTE of a PARITY failure that persisted, within the amount cap, is ever repaired by the system. */
export const shouldAutoRepair = (plan: ShardRepairPlan, policy: AutoRepairPolicy, now: Date = new Date()): AutoRepairVerdict => {
  if (!policy.enabled) return { allowed: false, reason: "automatic repair is disabled" };
  if (!plan.needsRepair || plan.kind === null) return { allowed: false, reason: "the shard needs no repair" };
  if (plan.kind !== "RECOMPUTE") return { allowed: false, reason: "the sequence is damaged: a person must decide (re-baseline needs approval)" };
  if (plan.status !== "PARITY") return { allowed: false, reason: `the failure kind is ${plan.status}, not PARITY` };
  if (plan.consecutiveFailures < policy.minConsecutiveFailures) {
    return { allowed: false, reason: `only ${plan.consecutiveFailures} of ${policy.minConsecutiveFailures} consecutive failures seen` };
  }
  if (plan.delta.abs().gt(policy.maxAbsDelta)) {
    return { allowed: false, reason: `the correction ${plan.delta.toFixed(4)} exceeds the automatic limit ${policy.maxAbsDelta.toFixed(4)}` };
  }
  if (!repairSizeAllowed(plan.truth.linesAfterBaseline, policy, now)) {
    return {
      allowed: false,
      reason: `the shard holds ${plan.truth.linesAfterBaseline} lines, above the ${policy.maxLinesOutsideWindow} allowed outside the maintenance window`,
    };
  }
  return { allowed: true, reason: "persistent PARITY drift within the automatic limit, sequence intact" };
};

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

export interface ApplyShardRepairInput {
  glAccountId: string;
  shardId: number;
  mode: ShardRepairMode;
  /** The repair kinds this caller may perform (automation and the single-user path: RECOMPUTE only). */
  allowedKinds: readonly ShardRepairKind[];
  /** Refuse to apply unless the plan under the lock still hashes to this (what the caller previewed or approved). */
  expectedPlanHash?: string;
  reason: string;
  actor: { actorId: string; role: string; requestFields?: Record<string, unknown> };
  approvalRequestId?: string | null;
  /** Policy check evaluated against the plan UNDER THE LOCK (the automation passes its guard here). */
  guard?: (plan: ShardRepairPlan) => AutoRepairVerdict;
  /**
   * A plan the caller already computed with `planShardRepair` (outside any lock). Its frozen part is reused, so the
   * apply does not read the shard's history again. Without it the apply runs the deep read itself, still before it
   * takes the shard lock.
   */
  basePlan?: ShardRepairPlan;
  /** The most lines the apply may read while holding the shard lock (the tail posted since the deep read). */
  maxTailLines?: number;
  /** `statement_timeout` while the shard lock is held, in milliseconds. */
  lockedStatementTimeoutMs?: number;
}

export interface ApplyShardRepairResult {
  repaired: boolean;
  plan: ShardRepairPlan;
  repairId: string | null;
  /** Set when nothing was applied because the deep read could not be reused under the lock (retry later). */
  stale?: ShardRepairStaleReason;
}

export const DEFAULT_REPAIR_MAX_TAIL_LINES = 5_000;
export const DEFAULT_REPAIR_LOCKED_STATEMENT_TIMEOUT_MS = 5_000;

export const applyShardRepair = async (db: Any, input: ApplyShardRepairInput): Promise<ApplyShardRepairResult> =>
  inTransaction(db, async (tx): Promise<ApplyShardRepairResult> => {
    // Part 1, WITHOUT the shard lock: the deep read over the shard's whole history (it may take a while).
    let base = input.basePlan?.snapshot ? input.basePlan : undefined;
    if (!base) {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120s'`);
      base = await planShardRepair(tx, input.glAccountId, input.shardId);
    }

    // Part 2, UNDER the shard lock: only the head and the short tail. Bound how long it may wait for, or hold, it.
    const lockedTimeoutMs = Math.max(100, Math.trunc(input.lockedStatementTimeoutMs ?? DEFAULT_REPAIR_LOCKED_STATEMENT_TIMEOUT_MS));
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${lockedTimeoutMs}ms'`);
    const heads = (await tx.$queryRawUnsafe(LOCK_HEAD_SQL, input.glAccountId, input.shardId)) as HeadRow[];
    if (heads.length === 0) throw new ApiError(404, "GL_SHARD_NOT_FOUND", "The shard does not exist");

    let plan: ShardRepairPlan;
    if (base.snapshot) {
      // Every journal line insert for this shard needs the lock we now hold, so the tail is stable until commit.
      const merged = await planUnderLock(
        tx,
        input.glAccountId,
        input.shardId,
        base.snapshot,
        headOf(heads[0]!),
        input.maxTailLines ?? DEFAULT_REPAIR_MAX_TAIL_LINES,
      );
      if (typeof merged === "string") {
        if (input.expectedPlanHash !== undefined) {
          throw new ApiError(409, "SHARD_REPAIR_PLAN_CHANGED", "The shard changed since the repair was previewed; preview it again", {
            planHash: base.planHash,
            stale: merged,
          });
        }
        return { repaired: false, plan: base, repairId: null, stale: merged };
      }
      plan = merged;
    } else {
      // A reader without the frozen columns (a test double): re-plan under the lock as before.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120s'`);
      plan = await planShardRepair(tx, input.glAccountId, input.shardId);
    }
    if (input.expectedPlanHash !== undefined && input.expectedPlanHash !== plan.planHash) {
      throw new ApiError(409, "SHARD_REPAIR_PLAN_CHANGED", "The shard changed since the repair was previewed; preview it again", {
        planHash: plan.planHash,
      });
    }
    if (!plan.needsRepair || plan.kind === null) return { repaired: false, plan, repairId: null };
    if (!input.allowedKinds.includes(plan.kind)) {
      throw new ApiError(
        409,
        "SHARD_REPAIR_NEEDS_APPROVAL",
        "The shard's sequence is damaged: re-baselining it needs a second person's approval",
        { kind: plan.kind },
      );
    }
    if (input.guard) {
      const verdict = input.guard(plan);
      if (!verdict.allowed) return { repaired: false, plan, repairId: null };
    }

    await tx.$executeRawUnsafe(
      `UPDATE gl_account_shards SET current_balance = $3::numeric, line_seq = $4::bigint, updated_at = now()
       WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint`,
      input.glAccountId,
      input.shardId,
      plan.after.balance.toFixed(4),
      plan.after.lineSeq.toString(),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO gl_shard_checkpoints AS c
         (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, verified_at, status, failure_kind,
          consecutive_failures, last_failure_at, baseline_seq)
       VALUES ($1::uuid, $2::smallint, $3::numeric, $4::bigint, now(), now(), 'OK', NULL, 0, NULL, $5::bigint)
       ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
         checkpoint_balance = EXCLUDED.checkpoint_balance, checkpoint_seq = EXCLUDED.checkpoint_seq,
         checkpoint_at = now(), verified_at = now(), status = 'OK', failure_kind = NULL,
         consecutive_failures = 0, last_failure_at = NULL, baseline_seq = EXCLUDED.baseline_seq`,
      input.glAccountId,
      input.shardId,
      plan.after.checkpointBalance.toFixed(4),
      plan.after.checkpointSeq.toString(),
      plan.after.baselineSeq.toString(),
    );
    const inserted = (await tx.$queryRawUnsafe(
      `INSERT INTO gl_shard_repairs
         (id, gl_account_id, shard_id, kind, mode, plan_hash, before_balance, after_balance, delta, before_line_seq,
          after_line_seq, before_checkpoint_seq, after_checkpoint_seq, baseline_seq_after, actor_id, reason,
          approval_request_id, details_json)
       VALUES (gen_random_uuid(), $1::uuid, $2::smallint, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::bigint,
               $10::bigint, $11::bigint, $12::bigint, $13::bigint, $14::uuid, $15, $16::uuid, $17::jsonb)
       RETURNING id::text AS id`,
      input.glAccountId,
      input.shardId,
      plan.kind,
      input.mode,
      plan.planHash,
      plan.before.balance.toFixed(4),
      plan.after.balance.toFixed(4),
      plan.delta.toFixed(4),
      plan.before.lineSeq.toString(),
      plan.after.lineSeq.toString(),
      plan.before.checkpointSeq.toString(),
      plan.after.checkpointSeq.toString(),
      plan.after.baselineSeq.toString(),
      input.actor.actorId,
      input.reason.slice(0, 1000),
      input.approvalRequestId ?? null,
      JSON.stringify({
        status: plan.status,
        consecutiveFailures: plan.consecutiveFailures,
        sequenceIntact: plan.sequenceIntact,
        linesAfterBaseline: plan.truth.linesAfterBaseline.toString(),
        distinctAfterBaseline: plan.truth.distinctAfterBaseline.toString(),
        maxSeq: plan.truth.maxSeq.toString(),
      }),
    )) as Array<{ id: string }>;
    const repairId = inserted[0]?.id ?? null;

    await writeAudit(tx, {
      data: {
        ...(input.actor.requestFields ?? {}),
        actorId: input.actor.actorId,
        role: input.actor.role,
        action: "GL_SHARD_REPAIRED",
        entityType: "GL_ACCOUNT",
        entityId: input.glAccountId,
        approvalRequestId: input.approvalRequestId ?? null,
        beforeJson: {
          shardId: input.shardId,
          balance: plan.before.balance.toFixed(4),
          lineSeq: plan.before.lineSeq.toString(),
          checkpointSeq: plan.before.checkpointSeq.toString(),
          status: plan.status,
        },
        afterJson: {
          shardId: input.shardId,
          kind: plan.kind,
          mode: input.mode,
          balance: plan.after.balance.toFixed(4),
          delta: plan.delta.toFixed(4),
          lineSeq: plan.after.lineSeq.toString(),
          baselineSeq: plan.after.baselineSeq.toString(),
          planHash: plan.planHash,
          repairId,
          reason: input.reason,
        },
      },
    });

    // The per-shard operator case stays OPEN for a person to review and resolve; it is annotated with what was done.
    const openCase = await tx.operatorCase.findFirst({
      where: { kind: "MISMATCH", subjectKey: LEDGER_SUBJECT_KEYS.shard(input.glAccountId, input.shardId), state: { not: "RESOLVED" } },
      select: { id: true, resolutionNotes: true },
    });
    if (openCase) {
      const note = `[${input.mode}] ${plan.kind} applied: balance ${plan.before.balance.toFixed(4)} -> ${plan.after.balance.toFixed(4)} (delta ${plan.delta.toFixed(4)}). Review and resolve this case.`;
      await tx.operatorCase.update({
        where: { id: openCase.id },
        data: { resolutionNotes: `${openCase.resolutionNotes ?? ""}\n${note}`.trim().slice(0, 4000) },
      });
    }
    return { repaired: true, plan, repairId };
  });

/** The plan as JSON for APIs: money as 4-decimal strings, sequence numbers as strings. */
export const serializeRepairPlan = (plan: ShardRepairPlan) => ({
  glAccountId: plan.glAccountId,
  shardId: plan.shardId,
  needsRepair: plan.needsRepair,
  kind: plan.kind,
  sequenceIntact: plan.sequenceIntact,
  status: plan.status,
  consecutiveFailures: plan.consecutiveFailures,
  before: {
    balance: plan.before.balance.toFixed(4),
    lineSeq: plan.before.lineSeq.toString(),
    checkpointBalance: plan.before.checkpointBalance.toFixed(4),
    checkpointSeq: plan.before.checkpointSeq.toString(),
    baselineSeq: plan.before.baselineSeq.toString(),
  },
  journal: {
    total: plan.truth.total.toFixed(4),
    uptoCheckpoint: plan.truth.uptoCheckpoint.toFixed(4),
    linesAfterBaseline: plan.truth.linesAfterBaseline.toString(),
    distinctAfterBaseline: plan.truth.distinctAfterBaseline.toString(),
    highestSequence: plan.truth.maxSeq.toString(),
  },
  after: {
    balance: plan.after.balance.toFixed(4),
    lineSeq: plan.after.lineSeq.toString(),
    checkpointBalance: plan.after.checkpointBalance.toFixed(4),
    checkpointSeq: plan.after.checkpointSeq.toString(),
    baselineSeq: plan.after.baselineSeq.toString(),
  },
  delta: plan.delta.toFixed(4),
  planHash: plan.planHash,
});
