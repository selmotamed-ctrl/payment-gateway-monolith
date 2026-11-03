import { Prisma } from "../../generated/prisma/client";
import type { PrismaClient } from "../../generated/prisma/client";
import { isLsnGreaterOrEqual } from "./lsn";
import type { ReadConsistency, ReadStorePort } from "./ports";

export interface ReplicaNodeHandle {
  id: string;
  client: PrismaClient;
  healthy: boolean;
  lastReplayLsn: string;
  lagMs: number;
  consecutiveFailures: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class PostgresReplicaReadStore implements ReadStorePort {
  private rrIndex = 0;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly primaryDb: PrismaClient,
    private readonly replicas: ReplicaNodeHandle[],
    private readonly maxAcceptableLagMs = 2_000,
  ) {}

  public startLsnMonitor(intervalMs = 150): void {
    if (this.replicas.length === 0 || this.monitorTimer) {
      return;
    }
    this.monitorTimer = setInterval(() => {
      void this.refreshReplicaWatermarks();
    }, intervalMs);
    this.monitorTimer.unref?.();
  }

  public stopLsnMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  public async refreshReplicaWatermarks(): Promise<void> {
    await Promise.allSettled(
      this.replicas.map(async (replica) => {
        try {
          const rows = await replica.client.$queryRaw<
            Array<{ replay_lsn: string | null; lag_ms: number | null }>
          >(
            Prisma.sql`
              SELECT
                pg_last_wal_replay_lsn()::text AS replay_lsn,
                EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms
            `,
          );
          const row = rows[0];
          if (row?.replay_lsn) {
            replica.lastReplayLsn = row.replay_lsn;
            replica.lagMs = Math.max(0, Math.round(Number(row.lag_ms ?? 0)));
          }
          replica.healthy = true;
          replica.consecutiveFailures = 0;
        } catch {
          replica.consecutiveFailures += 1;
          if (replica.consecutiveFailures >= 2) {
            replica.healthy = false;
          }
        }
      }),
    );
  }

  private pickReplica(consistency: ReadConsistency): ReplicaNodeHandle | null {
    if (consistency === "primary" || this.replicas.length === 0) {
      return null;
    }

    const total = this.replicas.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.rrIndex + i) % total;
      const candidate = this.replicas[idx];
      if (!candidate || !candidate.healthy) {
        continue;
      }

      if (typeof consistency === "object" && consistency.atLeastLsn) {
        if (isLsnGreaterOrEqual(candidate.lastReplayLsn, consistency.atLeastLsn)) {
          this.rrIndex = (idx + 1) % total;
          return candidate;
        }
        continue;
      }

      if (candidate.lagMs <= this.maxAcceptableLagMs) {
        this.rrIndex = (idx + 1) % total;
        return candidate;
      }
    }

    return null;
  }

  private async waitForReplica(
    consistency: Extract<ReadConsistency, { atLeastLsn: string }>,
  ): Promise<ReplicaNodeHandle | null> {
    const maxWaitMs = consistency.maxWaitMs ?? 0;
    const deadline = Date.now() + maxWaitMs;
    let candidate = this.pickReplica(consistency);
    while (!candidate && Date.now() < deadline) {
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
      await this.refreshReplicaWatermarks();
      candidate = this.pickReplica(consistency);
    }
    return candidate;
  }

  private async withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return work;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`READ_STORE_TIMEOUT after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  public pickHealthyReplica(consistency: ReadConsistency = "replica"): string | null {
    return this.pickReplica(consistency)?.id ?? null;
  }

  public getReplicaStates(): Array<{
    id: string;
    healthy: boolean;
    lagMs: number;
    lastReplayLsn: string;
    consecutiveFailures: number;
  }> {
    return this.replicas.map((replica) => ({
      id: replica.id,
      healthy: replica.healthy,
      lagMs: replica.lagMs,
      lastReplayLsn: replica.lastReplayLsn,
      consecutiveFailures: replica.consecutiveFailures,
    }));
  }

  public async execute<T>(
    consistency: ReadConsistency,
    fn: (reader: PrismaClient) => Promise<T>,
    options?: { timeoutMs?: number; queryName?: string },
  ): Promise<{ data: T; servedBy: "primary" | string; replicaLagMs?: number }> {
    const chosenReplica =
      typeof consistency === "object" && consistency.atLeastLsn
        ? await this.waitForReplica(consistency)
        : this.pickReplica(consistency);
    const timeoutMs = options?.timeoutMs ?? 0;

    if (chosenReplica) {
      try {
        const data = await this.withTimeout(fn(chosenReplica.client), timeoutMs);
        return {
          data,
          servedBy: chosenReplica.id,
          replicaLagMs: chosenReplica.lagMs,
        };
      } catch {
        chosenReplica.healthy = false;
        chosenReplica.consecutiveFailures += 1;
      }
    }

    const data = await this.withTimeout(fn(this.primaryDb), timeoutMs);
    return { data, servedBy: "primary" };
  }
}
