import { CheckpointService } from "../ledger/CheckpointService";
import { LEDGER_SUBJECT_KEYS, ensureLedgerSystemActor, raiseLedgerCase, writeSystemAudit } from "../ledger/ledgerAlerts";
import { applyShardRepair, planShardRepair, shouldAutoRepair, type AutoRepairPolicy } from "../ledger/ShardRepair";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

export interface LedgerCheckpointWorkerDeps extends WorkerOptions {
  /** Checkpoint a shard once this many lines were posted since its last checkpoint. */
  minLines?: number;
  /** ... or once it has pending lines and its checkpoint is older than this. */
  maxAgeMs?: number;
  /** How long a shard that failed verification waits before it is looked at again. */
  retryFailedMs?: number;
  /** How often the aggregated sweep audit row is written. */
  sweepAuditEveryMs?: number;
  /**
   * Automatic repair of a shard that keeps failing its proof. Only a persistent PARITY failure whose sequence is
   * intact, within the amount limit, is repaired (recomputed from the journal); anything else is left to a person.
   */
  autoRepair?: AutoRepairPolicy;
  /** How many failed shards one tick may repair. */
  autoRepairPerTick?: number;
}

/**
 * Keeps every shard's checkpoint close to its head.
 *
 * Each tick takes the shards with the most lines since their checkpoint (bounded by `batchSize`) and captures them
 * one at a time with the verified O(delta) routine of `CheckpointService`: it proves the lines in the sequence range
 * are gapless and add up to the shard balance, and only then moves the checkpoint. No lock is taken on the shard or
 * the account, so payments are never delayed, and a capture is idempotent, so a duplicate run is harmless.
 *
 * A shard that fails the proof is NOT advanced. The first failure opens a P1 operator case (keyed per shard, so it
 * is raised once) and writes an audit row; the shard is retried only every `retryFailedMs`. Routine successes
 * update the checkpoint row only; one aggregated `LEDGER_CHECKPOINT_SWEEP` audit row per interval summarises them.
 */
export class LedgerCheckpointWorker extends BaseWorker {
  /** Cluster singleton: only the advisory-lock leader ticks (GAP-012). */
  protected override get singleton(): boolean {
    return true;
  }

  private readonly minLines: number;
  private readonly maxAgeMs: number;
  private readonly retryFailedMs: number;
  private readonly sweepAuditEveryMs: number;
  private readonly autoRepair: AutoRepairPolicy | undefined;
  private readonly autoRepairPerTick: number;
  private readonly declined = new Set<string>();
  private lastSweepAt = 0;
  private sweep = { shards: 0, lines: 0n, failures: 0 };

  constructor(deps: LedgerCheckpointWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 30_000, batchSize: deps.batchSize ?? 50 });
    this.minLines = deps.minLines ?? 5000;
    this.maxAgeMs = deps.maxAgeMs ?? 15 * 60 * 1000;
    this.retryFailedMs = deps.retryFailedMs ?? 10 * 60 * 1000;
    this.sweepAuditEveryMs = deps.sweepAuditEveryMs ?? 60 * 60 * 1000;
    this.autoRepair = deps.autoRepair;
    this.autoRepairPerTick = deps.autoRepairPerTick ?? 5;
  }

  protected async tick(): Promise<void> {
    const service = new CheckpointService(this.db as never);
    const candidates = await service.findCandidates({
      minLines: this.minLines,
      maxAgeSeconds: Math.ceil(this.maxAgeMs / 1000),
      retryFailedSeconds: Math.ceil(this.retryFailedMs / 1000),
      limit: this.batchSize,
    });
    for (const candidate of candidates) {
      const result = await service.captureShard(candidate.glAccountId, candidate.shardId);
      if (result.status === "ADVANCED") {
        this.sweep.shards += 1;
        this.sweep.lines += result.linesCovered;
      } else if (result.status === "GAP" || result.status === "PARITY") {
        this.sweep.failures += 1;
        this.logger.error("Ledger shard checkpoint refused", {
          glAccountId: result.glAccountId,
          shardId: result.shardId,
          kind: result.status,
          drift: result.drift.toFixed(4),
          found: result.linesFound.toString(),
          expected: (result.lineSeq - result.previousSeq).toString(),
        });
        if (result.firstFailure) {
          await raiseLedgerCase(this.db as never, {
            subjectKey: LEDGER_SUBJECT_KEYS.shard(result.glAccountId, result.shardId),
            notes:
              `Shard ${result.shardId} of GL account ${result.glAccountId} failed its checkpoint proof (${result.status}): ` +
              `${result.linesFound} of ${result.lineSeq - result.previousSeq} lines found, drift ${result.drift.toFixed(4)}. ` +
              `The checkpoint was not moved.`,
            now: this.clock(),
          });
          await writeSystemAudit(this.db as never, {
            action: "LEDGER_SHARD_CHECKPOINT_FAILED",
            entityType: "GL_ACCOUNT",
            entityId: result.glAccountId,
            after: {
              shardId: result.shardId,
              kind: result.status,
              drift: result.drift.toFixed(4),
              linesFound: result.linesFound.toString(),
              linesExpected: (result.lineSeq - result.previousSeq).toString(),
            },
          });
        }
      }
    }
    await this.repairPersistentFailures(service);
    await this.flushSweepAudit();
  }

  /**
   * A shard that has failed its proof `minConsecutiveFailures` times in a row (the retry interval makes that about 30
   * minutes) is repaired when the policy allows it. The plan is re-evaluated UNDER the shard lock, so the decision is
   * made on the journal as it is at that instant. A declined shard is logged once per distinct plan, never repaired.
   */
  private async repairPersistentFailures(service: CheckpointService): Promise<void> {
    const policy = this.autoRepair;
    if (!policy?.enabled) return;
    const failing = (await (this.db as never as { $queryRawUnsafe: (q: string, ...v: unknown[]) => Promise<Array<{ id: string; shard_id: number }>> }).$queryRawUnsafe(
      `SELECT gl_account_id::text AS id, shard_id FROM gl_shard_checkpoints
       WHERE status = 'PARITY' AND consecutive_failures >= $1::int
       ORDER BY last_failure_at ASC NULLS FIRST LIMIT $2::int`,
      policy.minConsecutiveFailures,
      this.autoRepairPerTick,
    )) as Array<{ id: string; shard_id: number }>;
    for (const row of failing) {
      const shardId = Number(row.shard_id);
      const plan = await planShardRepair(this.db as never, row.id, shardId);
      const verdict = shouldAutoRepair(plan, policy);
      if (!verdict.allowed) {
        const key = `${row.id}:${shardId}:${plan.planHash}`;
        if (!this.declined.has(key)) {
          this.declined.add(key);
          this.logger.warn("Ledger shard repair left to a person", { glAccountId: row.id, shardId, reason: verdict.reason, delta: plan.delta.toFixed(4) });
        }
        continue;
      }
      const result = await (this.db as never as { $transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T> }).$transaction(async (tx) => {
        const actorId = await ensureLedgerSystemActor(tx as never);
        return applyShardRepair(tx as never, {
          glAccountId: row.id,
          shardId,
          mode: "AUTO",
          allowedKinds: ["RECOMPUTE"],
          guard: (current) => shouldAutoRepair(current, policy),
          reason: `Automatic repair: ${verdict.reason}`,
          actor: { actorId, role: "SYSTEM" },
        });
      });
      if (result.repaired) {
        this.logger.warn("Ledger shard repaired automatically from the journal", {
          glAccountId: row.id,
          shardId,
          delta: result.plan.delta.toFixed(4),
          repairId: result.repairId,
        });
        // prove it: the next capture must now pass
        await service.captureShard(row.id, shardId);
      }
    }
  }

  private async flushSweepAudit(): Promise<void> {
    const now = this.clock().getTime();
    if (this.lastSweepAt === 0) this.lastSweepAt = now;
    if (now - this.lastSweepAt < this.sweepAuditEveryMs) return;
    const { shards, lines, failures } = this.sweep;
    this.lastSweepAt = now;
    this.sweep = { shards: 0, lines: 0n, failures: 0 };
    if (shards === 0 && failures === 0) return;
    await writeSystemAudit(this.db as never, {
      action: "LEDGER_CHECKPOINT_SWEEP",
      entityType: "LEDGER",
      entityId: "checkpoint-worker",
      after: { shardsCheckpointed: shards, linesCovered: lines.toString(), failures, windowMs: this.sweepAuditEveryMs },
    });
  }
}
