import { ensureLedgerSystemActor, writeSystemAudit } from "../ledger/ledgerAlerts";
import {
  DEFAULT_SCALER_CONFIG,
  INITIAL_SCALER_STATE,
  decideShardWidth,
  type ScalerConfig,
  type ScalerState,
} from "../ledger/ShardScaler";
import { applyShardWidth } from "../ledger/shardScaling";
import { BaseWorker, type WorkerOptions } from "./workerRuntime";

export interface LedgerShardScalerWorkerDeps extends WorkerOptions {
  config?: Partial<ScalerConfig>;
  /** Detect and audit what would be scaled, without changing anything (the default until the thresholds are calibrated). */
  dryRun?: boolean;
}

interface ShardRow {
  id: string;
  accountType: string;
  width: number;
  scaledAt: Date | null;
  shard_id: number;
  seq: string;
}

/**
 * Detects hot GL accounts and routes them over more shards.
 *
 * Each tick reads every shard's `line_seq` (one statement, O(shards)), turns the difference to the previous tick
 * into a lines-per-second rate per shard, and asks the pure policy (`decideShardWidth`) what to do. The previous
 * sample lives in this leader's memory (the first tick after a failover only warms the baseline); the cooldown is
 * persisted on the account (`shard_scaled_at`).
 *
 * In dry-run mode a scale-up is only logged and audited as a proposal (once per proposed width). Otherwise
 * `applyShardWidth` widens the account and creates the shard rows in one transaction.
 */
export class LedgerShardScalerWorker extends BaseWorker {
  protected override get singleton(): boolean {
    return true;
  }

  private readonly config: ScalerConfig;
  private readonly dryRun: boolean;
  private lastTickAt: number | null = null;
  private readonly lastSeq = new Map<string, bigint>();
  private readonly states = new Map<string, ScalerState>();
  private readonly proposed = new Map<string, number>();

  constructor(deps: LedgerShardScalerWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 30_000 });
    this.config = { ...DEFAULT_SCALER_CONFIG, ...(deps.config ?? {}) };
    this.dryRun = deps.dryRun ?? true;
  }

  protected async tick(): Promise<void> {
    const now = this.clock().getTime();
    const rows = (await (this.db as never as { $queryRawUnsafe: (q: string) => Promise<ShardRow[]> }).$queryRawUnsafe(
      `SELECT s.gl_account_id::text AS id, g.account_type::text AS "accountType", g.shard_count AS width,
              g.shard_scaled_at AS "scaledAt", s.shard_id, s.line_seq::text AS seq
       FROM gl_account_shards s
       INNER JOIN gl_accounts g ON g.id = s.gl_account_id
       WHERE s.line_seq > 0`,
    )) as ShardRow[];
    const previousAt = this.lastTickAt;
    this.lastTickAt = now;
    const seconds = previousAt === null ? 0 : (now - previousAt) / 1000;

    const byAccount = new Map<string, ShardRow[]>();
    for (const row of rows) {
      const list = byAccount.get(row.id);
      if (list) list.push(row);
      else byAccount.set(row.id, [row]);
    }

    for (const [accountId, shards] of byAccount) {
      const rates = new Map<number, number>();
      for (const shard of shards) {
        const key = `${accountId}:${shard.shard_id}`;
        const seq = BigInt(shard.seq);
        const before = this.lastSeq.get(key);
        this.lastSeq.set(key, seq);
        rates.set(Number(shard.shard_id), before !== undefined && seconds > 0 ? Number(seq - before) / seconds : 0);
      }
      if (seconds === 0) continue; // baseline only
      const head = shards[0]!;
      const width = Number(head.width);
      const others = [...Array(Math.max(0, width - 1)).keys()].map((index) => rates.get(index + 1) ?? 0);
      const decision = decideShardWidth(
        {
          accountType: head.accountType,
          width,
          hotRate: Math.max(0, ...rates.values()),
          totalRate: [...rates.values()].reduce((sum, rate) => sum + rate, 0),
          shard0Rate: rates.get(0) ?? 0,
          otherShardsMeanRate: others.length === 0 ? 0 : others.reduce((sum, rate) => sum + rate, 0) / others.length,
          lastScaledAtMs: head.scaledAt ? new Date(head.scaledAt).getTime() : null,
          nowMs: now,
        },
        this.states.get(accountId) ?? INITIAL_SCALER_STATE,
        this.config,
      );
      this.states.set(accountId, decision.state);
      if (decision.action !== "SCALE_UP") continue;
      await this.scaleUp(accountId, head.accountType, width, decision.newWidth, decision.reason, decision.state);
    }
  }

  private async scaleUp(accountId: string, accountType: string, width: number, newWidth: number, reason: string, state: ScalerState): Promise<void> {
    const extra = {
      accountType,
      reason,
      hottestShardLinesPerSec: Math.round(state.hotRate),
      accountLinesPerSec: Math.round(state.totalRate),
      automatic: true,
    };
    if (this.dryRun) {
      if (this.proposed.get(accountId) === newWidth) return;
      this.proposed.set(accountId, newWidth);
      this.logger.warn("Ledger shard scaler (dry run): account would be widened", { accountId, from: width, to: newWidth, reason });
      await writeSystemAudit(this.db as never, {
        action: "GL_ACCOUNT_SHARDS_SCALE_PROPOSED",
        entityType: "GL_ACCOUNT",
        entityId: accountId,
        before: { shardCount: width },
        after: { shardCount: newWidth, dryRun: true, ...extra },
      });
      return;
    }
    const outcome = await (this.db as never as { $transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T> }).$transaction(async (tx) => {
      const actorId = await ensureLedgerSystemActor(tx);
      return applyShardWidth(tx as never, {
        glAccountId: accountId,
        newWidth,
        expectedOldWidth: width,
        audit: { actorId, role: "SYSTEM", action: "GL_ACCOUNT_SHARDS_SCALED", extra },
      });
    });
    if (outcome.changed) {
      this.logger.warn("Ledger shard scaler: account widened", { accountId, from: outcome.oldWidth, to: outcome.newWidth, reason });
    }
  }
}
