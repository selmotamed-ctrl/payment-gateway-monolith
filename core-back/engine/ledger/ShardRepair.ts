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
 * Everything is decided from one deep read of the shard's journal lines. The apply step re-plans UNDER THE SHARD ROW
 * LOCK (every line insert needs that lock first, so the lines of the shard cannot change while it is held) and refuses
 * to proceed when the plan no longer matches the plan the caller saw (`planHash`).
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
}

const DEEP_SQL = `
  SELECT sh.current_balance::text AS balance, sh.line_seq::text AS line_seq,
         COALESCE(c.checkpoint_balance, 0)::text AS cp_balance, COALESCE(c.checkpoint_seq, 0)::text AS cp_seq,
         COALESCE(c.baseline_seq, 0)::text AS baseline_seq, COALESCE(c.status, 'OK') AS status,
         COALESCE(c.consecutive_failures, 0)::int AS failures,
         j.total::text AS total, j.upto_cp::text AS upto_cp, j.after_baseline::text AS after_baseline,
         j.distinct_after::text AS distinct_after, j.max_seq::text AS max_seq
  FROM gl_account_shards sh
  LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END), 0) AS total,
           COALESCE(SUM(CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END)
                    FILTER (WHERE l.shard_seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS upto_cp,
           COUNT(*) FILTER (WHERE l.shard_seq > COALESCE(c.baseline_seq, 0)) AS after_baseline,
           COUNT(DISTINCT l.shard_seq) FILTER (WHERE l.shard_seq > COALESCE(c.baseline_seq, 0)) AS distinct_after,
           COALESCE(MAX(l.shard_seq), 0) AS max_seq
    FROM journal_lines l
    WHERE l.gl_account_id = sh.gl_account_id AND l.shard_id = sh.shard_id
  ) j
  WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint`;

const dec = (value: string): Decimal => new Decimal(value);

/** Reads the shard and ALL its journal lines and decides what a repair would do. Pure of side effects. */
export const planShardRepair = async (db: Any, glAccountId: string, shardId: number): Promise<ShardRepairPlan> => {
  const rows = (await db.$queryRawUnsafe(DEEP_SQL, glAccountId, shardId)) as DeepRow[];
  const row = rows[0];
  if (!row) throw new ApiError(404, "GL_SHARD_NOT_FOUND", "The shard does not exist");

  const balance = dec(row.balance);
  const lineSeq = BigInt(row.line_seq);
  const checkpointBalance = dec(row.cp_balance);
  const checkpointSeq = BigInt(row.cp_seq);
  const baselineSeq = BigInt(row.baseline_seq);
  const total = dec(row.total);
  const uptoCheckpoint = dec(row.upto_cp);
  const linesAfterBaseline = BigInt(row.after_baseline);
  const distinctAfterBaseline = BigInt(row.distinct_after);
  const maxSeq = BigInt(row.max_seq);

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

// ---------------------------------------------------------------------------------------------
// Automatic repair policy
// ---------------------------------------------------------------------------------------------

export interface AutoRepairPolicy {
  enabled: boolean;
  /** The proof must have failed this many consecutive times (a transient read or a race is never repaired). */
  minConsecutiveFailures: number;
  /** The balance may move by at most this much (absolute); a larger correction is left to a human. */
  maxAbsDelta: Decimal;
}

export interface AutoRepairVerdict {
  allowed: boolean;
  reason: string;
}

/** Only a RECOMPUTE of a PARITY failure that persisted, within the amount cap, is ever repaired by the system. */
export const shouldAutoRepair = (plan: ShardRepairPlan, policy: AutoRepairPolicy): AutoRepairVerdict => {
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
}

export interface ApplyShardRepairResult {
  repaired: boolean;
  plan: ShardRepairPlan;
  repairId: string | null;
}

export const applyShardRepair = async (db: Any, input: ApplyShardRepairInput): Promise<ApplyShardRepairResult> =>
  inTransaction(db, async (tx): Promise<ApplyShardRepairResult> => {
    // A repair is rare and reads the shard's whole history: bound how long it may wait for, or hold, the lock.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120s'`);
    const locked = (await tx.$queryRawUnsafe(
      `SELECT 1 AS locked FROM gl_account_shards WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint FOR UPDATE`,
      input.glAccountId,
      input.shardId,
    )) as unknown[];
    if (locked.length === 0) throw new ApiError(404, "GL_SHARD_NOT_FOUND", "The shard does not exist");

    // Every journal line insert for this shard needs the lock we now hold, so this read is stable until commit.
    const plan = await planShardRepair(tx, input.glAccountId, input.shardId);
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
