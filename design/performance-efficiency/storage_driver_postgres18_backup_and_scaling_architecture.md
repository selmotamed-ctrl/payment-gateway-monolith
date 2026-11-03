# DISTRIBUTED STORAGE DRIVER ENGINE, POSTGRESQL 18 CQRS/REPLICA CORE, DEDICATED AUDIT & LOG DATABASES, ADMIN-MANAGED BACKUP ORCHESTRATOR & HORIZONTAL MULTI-NODE DEPLOYMENT ARCHITECTURE

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith`

**Target Workspaces:** `core-back` · `admin-back` · `admin-front` · `merchant-back` · `checkout-back` · `deploy`

**Target Scale:** **50M–500M+ Financial Records**, **1,000+ TPS Sustained Write Throughput**, **Sub-5ms Read Latency**, **Zero-Downtime Horizontal Node Scaling (`1..N` Nodes per Tier)**

**Target Implementation Agent:** OpenCode (`DeepSeek V4.1 Flash Max`) — Complete, Verbatim Architectural & Code Specification

## 1. Executive Summary & Architectural Philosophy

To scale a national multi-rail payment switch to tens or hundreds of millions of records without sacrificing write speed, read speed, or the richness of the 20-group Global Deep Search, **we must stop forcing a single database instance and a single connection pool to do everything on the synchronous request path.**

This specification designs a **five-pillar distributed storage and deployment architecture** tailored specifically for `payment-gateway-monolith`:

1. **PostgreSQL 18 + PgBouncer (Transaction Mode) as the Unified Relational Core:**

   * Standardizes on **PostgreSQL 18** (`io_uring` async I/O subsystem, B-Tree Skip Scans, built-in `uuidv7()`, native 16-byte `UUID` storage, Partial Indexes `WHERE ...`, Covering Indexes `INCLUDE (...)`, BRIN time-series indexes, and `pg_trgm` GIN trigram indexes).

   * **Keep the Write Path Razor-Thin:** A checkout or ledger write touches **only** the core operational row, a **16-way Sub-Account Sharded Balance row** (eliminating hot-row lock contention on `TREASURY`, `PLATFORM_INCOME`, and `GATEWAY_CLEARING`), a local transactional `outbox_events` row, and a local `audit_outbox` row inside one ACID transaction (`synchronous_commit = on`).

   * **Move Read Cost Off the Write Path:** Asynchronous outbox projectors maintain read-optimized models (`rm_merchant_dashboard_stats`, `rm_wallet_statements`), while **Streaming Read Replicas** serve all dashboards, lists, exports, and **full 20-group `pg_trgm` + Full-Text Deep Search** with **LSN-Aware Read-Your-Own-Writes routing** (`pg_current_wal_lsn()` / `pg_last_wal_replay_lsn()`).

2. **The `core-back` Multi-Backend Storage Driver Engine (`core-back/lib/storageEngine/`):**

   * Every `core-back` node boots a unified, port-and-adapter **Storage Driver Engine** (`StorageEngine`) with strict timeouts, circuit breakers, and automatic failover across **5 purpose-built storage ports**:

     * `UnitOfWork` / `Tx` -> **PgBouncer -> Postgres 18 Primary** (transactional ledger, attempts, outbox, and audit-outbox).

     * `ReadStore` -> **PgBouncer -> Postgres 18 Streaming Replicas + Primary Fallback** (per-call consistency: `'primary'`, `'replica'`, or `{ atLeastLsn: string }`).

     * `CacheStore` & `VelocityStore` -> **Redis 7.4+** (L1 in-memory + L2 Redis config cache, cross-node invalidation pub/sub, and atomic Lua `EVALSHA` sliding-window velocity & rate-limit counters—never authoritative for money).

     * `AuditStore` -> **Dedicated Tamper-Evident Audit Database (`pg_audit_db`)** (fed asynchronously from `audit_outbox` with SHA-256 cryptographic hash chaining and `REVOKE UPDATE, DELETE` immutability, queried directly for all Admin Audit views & Deep Search).

     * `LogSink` -> **Dedicated High-Volume Operational & Step Log Database (`pg_logs_db`)** (non-blocking bounded in-memory ring buffer flushing batches of `attempt_step_logs`, `http_access_logs`, and `gateway_wire_logs` every 250ms into monthly time-partitioned tables—dropping or spooling to disk under pressure so logging can **never** slow down or fail a payment).

3. **Admin-Accessible Backup & PITR Verification Engine (`pg-backup-daemon` + `admin-front`):**

   * Runs either on a **Dedicated Backup Host (`BACKUP_HOST`)** (using **Barman** + streaming WAL receive from Replica/Primary) or directly on a **DB Host** (using **WAL-G** pushing `zstd`-compressed, AES-256-GCM encrypted base backups and continuous WAL archives to external S3/MinIO/R2 buckets + secondary remote SFTP/SSH servers).

   * Exposes an mTLS control plane (`:4090`) to `core-back` so administrators can monitor RPO/WAL lag, trigger on-demand backups, inspect storage targets, and run **Automated Weekly Scratch-Restore & Ledger Invariant Verification Drills** directly from **`admin-front` (`/system/backups`)**.

4. **Horizontal Multi-Node & Multi-Storage Orchestration in `deploy/deploy.env` & `deploy/deploy.ts`:**

   * Upgrades `deploy/deploy.env` so every compute tier (`CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES`, `CHECKOUT_NODES`) and every storage solution (`PG_PRIMARY_HOST`, `PG_REPLICA_NODES`, `PGBOUNCER`, `REDIS_NODES`, `AUDIT_DB_HOST`, `LOG_DB_HOST`, `BACKUP_HOST`) is configured declaratively.

   * `deploy/deploy.ts` provisions each storage engine on its assigned host(s), generates multi-IP SAN mTLS certificates across all horizontal nodes, configures UFW firewall matrices automatically, wires Edge-to-Core mTLS upstream load balancing, and performs zero-downtime rolling updates.

### 1.1 High-Level System & Storage Topology Diagram

```
                        ┌──────────────────────────────────────────────────────┐
                        │   PUBLIC & LAN EDGE TIERS (Horizontally Scalable)    │
                        │  • checkout-back [1..N]   • merchant-back [1..N]     │
                        │  • admin-back    [1..N]   (Nginx SSL + mTLS Client)  │
                        └──────────────────────────┬───────────────────────────┘
                                                   │ mTLS 1.3 (Round-Robin + Health Failover)
                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        HORIZONTALLY SCALED CORE-BACK NODES (CORE_NODES 1..N)                     │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                     CORE-BACK UNIFIED STORAGE DRIVER ENGINE (StorageEngine)                │  │
│  │  ┌──────────────┐  ┌───────────────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐  │  │
│  │  │ UnitOfWork   │  │ ReadStore Router  │  │ Cache & Lua  │  │ AuditStore │  │ LogSink   │  │  │
│  │  │ (Write Tx +  │  │ ('primary' |      │  │ VelocityPort │  │ (Shipper + │  │ (Bounded  │  │  │
│  │  │ Outbox/Audit)│  │  'replica' | LSN) │  │ (L1 + Redis) │  │  Reader)   │  │  Buffer)  │  │  │
│  │  └──────┬───────┘  └─────────┬─────────┘  └──────┬───────┘  └─────┬──────┘  └─────┬─────┘  │  │
│  └─────────┼────────────────────┼───────────────────┼────────────────┼───────────────┼────────┘  │
└────────────┼────────────────────┼───────────────────┼────────────────┼───────────────┼───────────┘
             │                    │                   │                │               │
             ▼                    ▼                   ▼                ▼               ▼
   ┌──────────────────┐ ┌───────────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │ PgBouncer (Tx)   │ │ PgBouncer (Read)  │ │ Redis 7.4+   │ │ pg_audit_db  │ │ pg_logs_db   │
   │        │         │ │        │          │ │ (Config Cache│ │ (Append-Only │ │ (Partitioned │
   │        ▼         │ │        ▼          │ │  Pub/Sub Bus │ │  Hash-Chain  │ │  Step Logs & │
   │ Postgres 18      │ │ Postgres 18       │ │  Lua Windows)│ │  Audit Store)│ │  Access Logs)│
   │ PRIMARY DB       ├►│ STREAMING REPLICAS│ └──────────────┘ └──────┬───────┘ └──────────────┘
   │ (Ledger, Outbox) │ │ [1..M] (Lists,    │                         │
   └────────┬─────────┘ │  Deep Search, RM) │                         │
            │           └─────────┬─────────┘                         │
            └──────────┬──────────┴───────────────────────────────────┘
                       │ Continuous WAL Archiving + Base Backups (WAL-G / Barman)
                       ▼
        ┌─────────────────────────────────────────────────────────────────────────┐
        │ BACKUP & PITR VERIFICATION ENGINE (BACKUP_HOST or DB_HOST :4090 mTLS)   │
        │  • Weekly Full + Daily Delta + Continuous WAL -> S3/MinIO + Remote SSH  │
        │  • Automated Scratch Postgres 18 Restore Drill + Ledger Invariant Audit │
        │  • Controlled & Monitored from Admin Portal (/system/backups)           │
        └─────────────────────────────────────────────────────────────────────────┘

```

## 2. Segment 1 — The `core-back` Storage Driver Engine (`core-back/lib/storageEngine/`)

### 2.1 Core Port Interfaces (`core-back/lib/storageEngine/ports.ts`)

Every module in `core-back` interacts with persistence strictly through these purpose-built ports—never through raw unrouted connections:

```
// core-back/lib/storageEngine/ports.ts
import type { Prisma, PrismaClient } from '../../generated/prisma';

export type ReadConsistency =
  | 'primary'
  | 'replica'
  | { atLeastLsn: string; maxWaitMs?: number };

export interface OutboxEnvelope {
  topic:
    | 'attempt.transitioned'
    | 'ledger.entry_posted'
    | 'merchant.updated'
    | 'kyb.document_uploaded'
    | 'reconciliation.completed'
    | 'config.invalidated';
  aggregateType: string;
  aggregateId: string;
  merchantId?: string | null;
  payload: Record<string, unknown>;
}

export interface AuditEnvelope {
  actorId: string;
  actorEmail?: string | null;
  role: string;
  action: string;
  entityType: string;
  entityId: string;
  merchantId?: string | null;
  approvalRequestId?: string | null;
  requestId?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  beforeJson: Record<string, unknown>;
  afterJson: Record<string, unknown>;
}

export interface OutboxWriter {
  /** Enqueues an event in the local `outbox_events` table within the active DB transaction */
  enqueue(event: OutboxEnvelope): Promise<void>;
  enqueueMany(events: OutboxEnvelope[]): Promise<void>;
}

export interface TransactionalAuditWriter {
  /** Writes to `audit_outbox` inside the active DB transaction so audit is atomic with the mutation */
  record(entry: AuditEnvelope): Promise<string>;
}

export interface StorageTx {
  /** Prisma TransactionClient bound to the PgBouncer Primary connection */
  readonly db: Prisma.TransactionClient;
  /** Atomic outbox writer in the same transaction */
  readonly outbox: OutboxWriter;
  /** Atomic audit writer in the same transaction */
  readonly audit: TransactionalAuditWriter;
  /**
   * Acquires row-level FOR UPDATE locks on GL account shards in deterministic sorted order
   * to prevent AB-BA deadlocks across concurrent financial postings.
   */
  lockGlAccountShardsSorted(
    targets: Array<{ glAccountId: string; shardId: number }>
  ): Promise<Map<string, { currentBalance: Prisma.Decimal }>>;
}

export interface UnitOfWorkResult<T> {
  data: T;
  /** PostgreSQL WAL LSN at transaction commit (`pg_current_wal_lsn()`) for Read-Your-Own-Writes */
  commitLsn: string;
  durationMs: number;
}

export interface UnitOfWorkPort {
  run<T>(
    fn: (tx: StorageTx) => Promise<T>,
    options?: {
      timeoutMs?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
      operationName?: string;
    }
  ): Promise<UnitOfWorkResult<T>>;
}

export interface ReadStorePort {
  /**
   * Executes a read operation against either the Primary or a healthy Streaming Read Replica
   * based on the declared consistency requirement.
   */
  execute<T>(
    consistency: ReadConsistency,
    fn: (reader: PrismaClient) => Promise<T>,
    options?: { timeoutMs?: number; queryName?: string }
  ): Promise<{ data: T; servedBy: 'primary' | string; replicaLagMs?: number }>;
}

export interface VelocityCheckDescriptor {
  ruleId: string;
  scopeKey: string;
  windowSeconds: number;
  maxCount: number;
  maxAmountMinor: bigint | null;
}

export interface VelocityEvaluationResult {
  allowed: boolean;
  violatedRuleIds: string[];
  flaggedRuleIds: string[];
  windowStats: Record<string, { count: number; amountMinor: bigint }>;
}

export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  /** Single-flight L1 + L2 Redis cache loader */
  getOrLoad<T>(
    key: string,
    ttlSec: number,
    loader: () => Promise<T>,
    options?: { l1TtlMs?: number }
  ): Promise<T>;
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
  del(keyOrPrefix: string): Promise<void>;
  incrWindowCounter(
    descriptors: VelocityCheckDescriptor[],
    incrementAmountMinor: bigint,
    nowEpochMs: number
  ): Promise<VelocityEvaluationResult>;
}

export interface StepLogRecord {
  id?: string;
  attemptId: string;
  gatewayVersionId: string;
  phase: string;
  stepId?: string | null;
  stepOrder: number;
  redactedRequestJson: Record<string, unknown>;
  redactedResponseText: string;
  httpStatus?: number | null;
  durationMs?: number | null;
  outcome: string;
  createdAt?: Date;
}

export interface HttpAccessLogRecord {
  requestId: string;
  channel: 'admin' | 'merchant' | 'checkout' | 'webhook';
  method: string;
  routePattern: string;
  statusCode: number;
  durationMs: number;
  dbQueries: number;
  dbDurationMs: number;
  actorId?: string | null;
  clientIp?: string | null;
  createdAt?: Date;
}

export interface LogSinkPort {
  /** Non-blocking buffered write: never awaits network I/O on the payment request path */
  writeStepLog(record: StepLogRecord): void;
  writeAccessLog(record: HttpAccessLogRecord): void;
  queryStepLogsForAttempt(attemptId: string): Promise<StepLogRecord[]>;
  flush(): Promise<void>;
}

export interface AuditRecordRow extends AuditEnvelope {
  id: string;
  createdAt: Date;
  prevHash: string;
  rowHash: string;
}

export interface AuditStorePort {
  queryAuditLogs(params: {
    entityType?: string;
    entityId?: string;
    actorId?: string;
    action?: string;
    searchPrefix?: string;
    cursorCreatedAt?: Date;
    cursorId?: string;
    limit: number;
  }): Promise<{ items: AuditRecordRow[]; nextCursor: string | null }>;
  getAuditLogById(id: string): Promise<AuditRecordRow | null>;
  verifyHashChainIntegrity(limit?: number): Promise<{
    verifiedCount: number;
    valid: boolean;
    firstBrokenId?: string;
  }>;
}

```

### 2.2 `UnitOfWork` & LSN-Capturing Write Adapter (`core-back/lib/storageEngine/uowAdapter.ts`)

Enforces **Rule 1 (Single Atomic Transaction for Ledger + Outbox + Audit)**, **Rule 3 (Sorted Account Shard Locking)**, **Rule 4 (Strict Statement Timeout)**, and **Rule 5 (Commit LSN Capture)**:

```
// core-back/lib/storageEngine/uowAdapter.ts
import { Prisma, type PrismaClient } from '../../generated/prisma';
import { uuidv7 } from 'uuidv7';
import type {
  AuditEnvelope,
  OutboxEnvelope,
  StorageTx,
  UnitOfWorkPort,
  UnitOfWorkResult,
} from './ports';

export class PostgresUnitOfWorkAdapter implements UnitOfWorkPort {
  constructor(
    private readonly primaryDb: PrismaClient,
    private readonly onAfterCommitTrigger?: () => void
  ) {}

  public async run<T>(
    fn: (tx: StorageTx) => Promise<T>,
    options?: {
      timeoutMs?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
      operationName?: string;
    }
  ): Promise<UnitOfWorkResult<T>> {
    const startMs = performance.now();
    const timeoutMs = options?.timeoutMs ?? 5_000;

    const result = await this.primaryDb.$transaction(
      async (prismaTx) => {
        // Enforce Postgres statement_timeout inside this transaction so hung locks fail fast
        await prismaTx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${Math.max(1000, timeoutMs - 250)}ms'`
        );

        const pendingOutbox: OutboxEnvelope[] = [];
        const pendingAudit: Array<AuditEnvelope & { id: string }> = [];

        const storageTx: StorageTx = {
          db: prismaTx,
          outbox: {
            enqueue: async (event) => {
              pendingOutbox.push(event);
            },
            enqueueMany: async (events) => {
              pendingOutbox.push(...events);
            },
          },
          audit: {
            record: async (entry) => {
              const id = uuidv7();
              pendingAudit.push({ ...entry, id });
              return id;
            },
          },
          lockGlAccountShardsSorted: async (targets) => {
            if (targets.length === 0) return new Map();
            // Sort strictly by (glAccountId ASC, shardId ASC) to prevent AB-BA deadlocks
            const uniqueSorted = Array.from(
              new Map(
                targets.map((t) => [`${t.glAccountId}:${t.shardId}`, t])
              ).values()
            ).sort((a, b) =>
              a.glAccountId !== b.glAccountId
                ? a.glAccountId.localeCompare(b.glAccountId)
                : a.shardId - b.shardId
            );

            const tuples = uniqueSorted.map(
              (t) => Prisma.sql`(${t.glAccountId}::uuid, ${t.shardId}::smallint)`
            );

            const rows = await prismaTx.$queryRaw<
              Array<{ gl_account_id: string; shard_id: number; current_balance: Prisma.Decimal }>
            >`
              SELECT gl_account_id, shard_id, current_balance
              FROM gl_account_shards
              WHERE (gl_account_id, shard_id) IN (${Prisma.join(tuples, ', ')})
              ORDER BY gl_account_id ASC, shard_id ASC
              FOR UPDATE
            `;

            const map = new Map<string, { currentBalance: Prisma.Decimal }>();
            for (const r of rows) {
              map.set(`${r.gl_account_id}:${r.shard_id}`, {
                currentBalance: new Prisma.Decimal(r.current_balance),
              });
            }
            return map;
          },
        };

        const data = await fn(storageTx);

        // Flush Outbox rows inside the SAME transaction before commit
        if (pendingOutbox.length > 0) {
          const now = new Date();
          await prismaTx.outboxEvent.createMany({
            data: pendingOutbox.map((ev) => ({
              topic: ev.topic,
              aggregateType: ev.aggregateType,
              aggregateId: ev.aggregateId,
              merchantId: ev.merchantId ?? null,
              payloadJson: ev.payload as Prisma.InputJsonValue,
              createdAt: now,
            })),
          });
        }

        // Flush Transactional Audit Outbox rows inside the SAME transaction before commit
        if (pendingAudit.length > 0) {
          const now = new Date();
          await prismaTx.auditOutbox.createMany({
            data: pendingAudit.map((au) => ({
              id: au.id,
              actorId: au.actorId,
              actorEmail: au.actorEmail ?? null,
              role: au.role,
              action: au.action,
              entityType: au.entityType,
              entityId: au.entityId,
              merchantId: au.merchantId ?? null,
              approvalRequestId: au.approvalRequestId ?? null,
              requestId: au.requestId ?? null,
              clientIp: au.clientIp ?? null,
              userAgent: au.userAgent ?? null,
              beforeJson: au.beforeJson as Prisma.InputJsonValue,
              afterJson: au.afterJson as Prisma.InputJsonValue,
              createdAt: now,
            })),
          });
        }

        // Capture PostgreSQL WAL LSN for Read-Your-Own-Writes routing on replicas
        const lsnRows = await prismaTx.$queryRaw<Array<{ lsn: string }>>`
          SELECT pg_current_wal_lsn()::text AS lsn
        `;
        const commitLsn = lsnRows[0]?.lsn ?? '0/0';

        return { data, commitLsn };
      },
      {
        maxWait: 2_500,
        timeout: timeoutMs,
        isolationLevel:
          options?.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
      }
    );

    // Wake up local Outbox & Audit shippers asynchronously without blocking the caller
    this.onAfterCommitTrigger?.();

    return {
      data: result.data,
      commitLsn: result.commitLsn,
      durationMs: Math.round(performance.now() - startMs),
    };
  }
}

```

### 2.3 LSN-Aware Replica Read Router (`core-back/lib/storageEngine/readStoreAdapter.ts`)

Routes read queries across **1..M Streaming Read Replicas** while guaranteeing **Read-Your-Own-Writes** consistency whenever a client supplies `{ atLeastLsn }`:

```
// core-back/lib/storageEngine/readStoreAdapter.ts
import type { PrismaClient } from '../../generated/prisma';
import type { ReadConsistency, ReadStorePort } from './ports';

export interface ReplicaNodeHandle {
  id: string;
  client: PrismaClient;
  healthy: boolean;
  lastReplayLsn: string;
  lagMs: number;
  consecutiveFailures: number;
}

/**
 * Compares two PostgreSQL WAL LSN strings (e.g. "0/16B3748" >= "0/16B3700")
 */
export function isLsnGreaterOrEqual(candidateLsn: string, targetLsn: string): boolean {
  const parseLsn = (lsn: string): bigint => {
    const [hi, lo] = lsn.split('/');
    if (!hi || !lo) return 0n;
    return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
  };
  try {
    return parseLsn(candidateLsn) >= parseLsn(targetLsn);
  } catch {
    return false;
  }
}

export class PostgresReplicaReadStore implements ReadStorePort {
  private rrIndex = 0;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly primaryDb: PrismaClient,
    private readonly replicas: ReplicaNodeHandle[],
    private readonly maxAcceptableLagMs = 2_000
  ) {}

  public startLsnMonitor(intervalMs = 150): void {
    if (this.replicas.length === 0 || this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      void this.refreshReplicaWatermarks();
    }, intervalMs);
  }

  public stopLsnMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private async refreshReplicaWatermarks(): Promise<void> {
    await Promise.allSettled(
      this.replicas.map(async (rep) => {
        try {
          const rows = await rep.client.$queryRaw<
            Array<{ replay_lsn: string | null; lag_ms: number | null }>
          >`
            SELECT
              pg_last_wal_replay_lsn()::text AS replay_lsn,
              EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms
          `;
          const row = rows[0];
          if (row?.replay_lsn) {
            rep.lastReplayLsn = row.replay_lsn;
            rep.lagMs = Math.max(0, Math.round(Number(row.lag_ms ?? 0)));
          }
          rep.healthy = true;
          rep.consecutiveFailures = 0;
        } catch {
          rep.consecutiveFailures += 1;
          if (rep.consecutiveFailures >= 2) {
            rep.healthy = false;
          }
        }
      })
    );
  }

  private pickReplica(consistency: ReadConsistency): ReplicaNodeHandle | null {
    if (consistency === 'primary' || this.replicas.length === 0) return null;

    const total = this.replicas.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.rrIndex + i) % total;
      const candidate = this.replicas[idx];
      if (!candidate.healthy) continue;

      if (typeof consistency === 'object' && consistency.atLeastLsn) {
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

  public async execute<T>(
    consistency: ReadConsistency,
    fn: (reader: PrismaClient) => Promise<T>
  ): Promise<{ data: T; servedBy: 'primary' | string; replicaLagMs?: number }> {
    const chosenReplica = this.pickReplica(consistency);

    if (chosenReplica) {
      try {
        const data = await fn(chosenReplica.client);
        return {
          data,
          servedBy: chosenReplica.id,
          replicaLagMs: chosenReplica.lagMs,
        };
      } catch {
        // Circuit-breaker fallback: if a replica query fails mid-flight, transparently retry on Primary!
        chosenReplica.healthy = false;
      }
    }

    const data = await fn(this.primaryDb);
    return { data, servedBy: 'primary' };
  }
}

```

### 2.4 Non-Blocking Buffered Log Sink & Dedicated Audit Shipper (`core-back/lib/storageEngine/auditAndLogAdapters.ts`)

Separates **Audit Logs (`pg_audit_db`)** and **Step / Operational Logs (`pg_logs_db`)** into their own physical databases so they never bloat the primary financial database or slow down payment writes:

```
// core-back/lib/storageEngine/auditAndLogAdapters.ts
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { PrismaClient } from '../../generated/prisma';
import type {
  AuditRecordRow,
  AuditStorePort,
  HttpAccessLogRecord,
  LogSinkPort,
  StepLogRecord,
} from './ports';
import { uuidv7 } from 'uuidv7';

/**
 * 1. Dedicated Log Sink (pg_logs_db)
 * Buffers attempt_step_logs and http_access_logs in memory and flushes in batches
 * every 250ms. Drops low-priority access logs if queue exceeds capacity so logging
 * can NEVER block or fail a payment!
 */
export class DedicatedPostgresLogSink implements LogSinkPort {
  private stepLogBuffer: Required<StepLogRecord>[] = [];
  private accessLogBuffer: Required<HttpAccessLogRecord>[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;

  constructor(
    private readonly logDbPool: Pool,
    private readonly maxBufferSize = 5_000,
    private readonly flushIntervalMs = 250
  ) {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  public writeStepLog(record: StepLogRecord): void {
    if (this.stepLogBuffer.length >= this.maxBufferSize) {
      // Drop oldest step log only if buffer is completely full during an extreme outage
      this.stepLogBuffer.shift();
    }
    this.stepLogBuffer.push({
      id: record.id ?? uuidv7(),
      attemptId: record.attemptId,
      gatewayVersionId: record.gatewayVersionId,
      phase: record.phase,
      stepId: record.stepId ?? null,
      stepOrder: record.stepOrder,
      redactedRequestJson: record.redactedRequestJson,
      redactedResponseText: record.redactedResponseText,
      httpStatus: record.httpStatus ?? null,
      durationMs: record.durationMs ?? null,
      outcome: record.outcome,
      createdAt: record.createdAt ?? new Date(),
    });

    if (this.stepLogBuffer.length >= 250 && !this.isFlushing) {
      void this.flush();
    }
  }

  public writeAccessLog(record: HttpAccessLogRecord): void {
    // Under backpressure, drop access logs first to preserve 100% of payment step logs
    if (this.accessLogBuffer.length >= this.maxBufferSize) return;
    this.accessLogBuffer.push({
      ...record,
      actorId: record.actorId ?? null,
      clientIp: record.clientIp ?? null,
      createdAt: record.createdAt ?? new Date(),
    });
  }

  public async flush(): Promise<void> {
    if (this.isFlushing) return;
    if (this.stepLogBuffer.length === 0 && this.accessLogBuffer.length === 0) return;

    this.isFlushing = true;
    const stepBatch = this.stepLogBuffer.splice(0, 500);
    const accessBatch = this.accessLogBuffer.splice(0, 500);

    try {
      if (stepBatch.length > 0) {
        const values: unknown[] = [];
        const placeholders = stepBatch.map((row, i) => {
          const base = i * 12;
          values.push(
            row.id,
            row.attemptId,
            row.gatewayVersionId,
            row.phase,
            row.stepId,
            row.stepOrder,
            JSON.stringify(row.redactedRequestJson),
            row.redactedResponseText,
            row.httpStatus,
            row.durationMs,
            row.outcome,
            row.createdAt
          );
          return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}::uuid, $${base + 6}, $${base + 7}::jsonb, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}::timestamptz)`;
        });

        await this.logDbPool.query(
          `INSERT INTO attempt_step_logs (
             id, attempt_id, gateway_version_id, phase, step_id, step_order,
             redacted_request_json, redacted_response_text, http_status, duration_ms, outcome, created_at
           ) VALUES ${placeholders.join(', ')}
           ON CONFLICT (id, created_at) DO NOTHING`,
          values
        );
      }

      if (accessBatch.length > 0) {
        const values: unknown[] = [];
        const placeholders = accessBatch.map((row, i) => {
          const base = i * 10;
          values.push(
            row.requestId,
            row.channel,
            row.method,
            row.routePattern,
            row.statusCode,
            row.durationMs,
            row.dbQueries,
            row.dbDurationMs,
            row.actorId,
            row.createdAt
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::timestamptz)`;
        });

        await this.logDbPool.query(
          `INSERT INTO http_access_logs (
             request_id, channel, method, route_pattern, status_code,
             duration_ms, db_queries, db_duration_ms, actor_id, created_at
           ) VALUES ${placeholders.join(', ')}`,
          values
        );
      }
    } catch {
      // Re-queue step logs at the front if capacity permits; never throw into request path
      if (this.stepLogBuffer.length + stepBatch.length <= this.maxBufferSize) {
        this.stepLogBuffer.unshift(...stepBatch);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  public async queryStepLogsForAttempt(attemptId: string): Promise<StepLogRecord[]> {
    const res = await this.logDbPool.query(
      `SELECT id, attempt_id AS "attemptId", gateway_version_id AS "gatewayVersionId",
              phase, step_id AS "stepId", step_order AS "stepOrder",
              redacted_request_json AS "redactedRequestJson",
              redacted_response_text AS "redactedResponseText",
              http_status AS "httpStatus", duration_ms AS "durationMs",
              outcome, created_at AS "createdAt"
       FROM attempt_step_logs
       WHERE attempt_id = $1::uuid
       ORDER BY step_order ASC, created_at ASC`,
      [attemptId]
    );
    return res.rows;
  }
}

/**
 * 2. Dedicated Tamper-Evident Audit Database Adapter & Shipper (pg_audit_db)
 * Reads committed rows from primary `audit_outbox`, computes a continuous SHA-256 hash chain,
 * writes them to the append-only `pg_audit_db.audit_records` table, and deletes from `audit_outbox`.
 */
export function computeAuditRowHash(prevHash: string, row: {
  id: string;
  createdAt: Date;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
}): string {
  const canonical = [
    prevHash,
    row.id,
    row.createdAt.toISOString(),
    row.actorId,
    row.action,
    row.entityType,
    row.entityId,
    JSON.stringify(row.beforeJson),
    JSON.stringify(row.afterJson),
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

```

## 3. Segment 2 — Fast Reads Without Slowing Writes (PostgreSQL 18 Ledger, Sharded Sub-Accounts & Outbox Read Models)

### 3.1 Solving Hot-Account Row Lock Contention (`gl_account_shards`)

In any payment gateway, merchant wallet GL accounts are low-contention (each merchant has their own wallet), **but platform system GL accounts (`TREASURY`, `PLATFORM_INCOME`, `GATEWAY_CLEARING`, `GATEWAY_FEE_ACCRUAL`, `AML_HOLD`) are touched by almost every transaction!**
If 300 customers confirm payments concurrently on Sadad or Moamalat, updating a single `gl_accounts` row for `PLATFORM_INCOME` or `GATEWAY_CLEARING` forces all 300 transactions to queue on one row lock.

**The Sub-Account Sharding Solution (`gl_account_shards`):**

1. Each `GlAccount` is backed by `N` rows in `gl_account_shards (gl_account_id UUID, shard_id SMALLINT, current_balance NUMERIC(18,4), updated_at TIMESTAMPTZ, PRIMARY KEY (gl_account_id, shard_id))`:

   * **Merchant Wallet GL Accounts (`MERCHANT_WALLET`):** Use `1` shard (`shard_id = 0`) so before-cashout balance locks (`FOR UPDATE`) lock the exact single merchant balance row.

   * **High-Throughput System GL Accounts (`TREASURY`, `GATEWAY_CLEARING`, `PLATFORM_INCOME`, `PROVIDER_FEE_EXPENSE`, `GATEWAY_FEE_EXPENSE`, `GATEWAY_FEE_ACCRUAL`):** Pre-seeded with **`16` shards (`shard_id = 0..15`)**!

2. **Write Path (`LedgerPoster.ts`):**

   * When posting a journal entry for `attemptId`, the poster selects `shard_id = fnv1aHash(attemptId) & 15` (`0..15`) for system GL accounts and `0` for `MERCHANT_WALLET`.

   * Concurrent payments distribute evenly across 16 independent rows—increasing write concurrency by **16×** with **zero row-lock bottlenecks**!

   * Meanwhile, `journal_lines` remains **100% append-only** and monthly time-partitioned (`PARTITION BY RANGE (created_at)`) with only **3 indexes**:

     1. `PRIMARY KEY (id, created_at)` (`uuidv7` time-ordered),

     2. `(entry_id, created_at)`,

     3. `(gl_account_id, created_at) INCLUDE (direction, amount)` (Covering Index!).

3. **Read Path (`getGlAccountBalance`):**

   ```
   SELECT COALESCE(SUM(current_balance), 0)::numeric(18,4) AS balance
   FROM gl_account_shards
   WHERE gl_account_id = $1::uuid;

   ```

   Summing 1 row (for a merchant wallet) or 16 contiguous primary-key rows (for a system account) takes **`< 0.08ms`**!

### 3.2 Outbox-Driven Read Models & Uncompromised 20-Group Deep Search on Replicas

Because read models and search indexes are maintained **asynchronously by `OutboxRelayWorker`** and queried on **Streaming Read Replicas**, the checkout write path pays **zero** overhead while read queries fly:

| Read Workload | How It Executes Without Touching Write Speed |
| ----- | ----- |
| **Global Deep Search (`core-back/lib/globalSearch.ts` — All 20 Plugin Groups)** | 1\. Routed via `storage.readStore.execute('replica', ...)` so all 20 parallel plugin queries run against **Streaming Read Replicas** (never touching Primary writer CPU/IO).  2\. Uses PostgreSQL **`pg_trgm` GIN Trigram Indexes (`USING gin (legal_name gin_trgm_ops, trade_name gin_trgm_ops)`)** so `ILIKE '%term%'` substring matches across Arabic and English names, reasons, and references use an **index scan (`< 3ms` at 50M rows)** instead of a full table scan!  3\. Preserves **100% of the two-sided plugin registry (`SearchProviderRegistry` + `ClientSearchTargetRegistry`)** from `deep_search_plugin_architecture_plan.md` without compromising a single match field or ranking rule! |
| **Merchant & Admin Dashboards (`/stats/overview`)** | `OutboxRelayWorker` consumes `attempt.transitioned` and `ledger.entry_posted` events from `outbox_events` and updates `rm_merchant_daily_stats` and `rm_route_daily_volumes` asynchronously within `< 100ms` of commit. |
| **Worker Claim Loops (`ExpirySweeper`, `InboundInbox`, `PollWorker`)** | Uses **PostgreSQL Partial Indexes** (`WHERE terminal_at IS NULL`, `WHERE processed_at IS NULL`, `WHERE state = 'QUEUED'`). Completed historical rows are automatically excluded from the index tree, keeping worker claim scans at `< 0.1ms` even when the table holds 100M historical rows! |
| **Time-Series Append Tables (`payment_attempts`, `journal_lines`)** | Uses **BRIN Indexes (`USING brin (created_at)`)** (which consume `< 1MB` for 100M rows!) for date-range reporting plus **Keyset Cursor Pagination (`(created_at, id) < ($1, $2)`)** with Covering `INCLUDE` columns. |
| **Velocity & Rate-Limit Checks (`AttemptGuardPipeline.ts`)** | Executed via `storage.cache.incrWindowCounter()` in **Redis** using a single atomic Lua script (`EVALSHA`) before the database transaction opens (`< 0.3ms`, zero SQL scans on `payment_attempts`). |

## 4. Segment 3 — PostgreSQL 18 DDL, Partial/Covering/GIN Indexes & Dedicated Audit/Log Schemas

### 4.1 Primary Relational Core DDL (`payment_gateway_prod` on PostgreSQL 18)

Below is the exact PostgreSQL 18 migration (`core-back/prisma/migrations/20261103120000_postgres18_storage_engine/migration.sql`) leveraging the PostgreSQL-native features used throughout this design:

```
-- ============================================================================
-- 1. EXTENSIONS (PostgreSQL 18)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- ============================================================================
-- 2. SUB-ACCOUNT SHARDED BALANCES & TRANSACTIONAL OUTBOXES
-- ============================================================================

CREATE TABLE IF NOT EXISTS gl_account_shards (
  gl_account_id   UUID           NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  shard_id        SMALLINT       NOT NULL DEFAULT 0 CHECK (shard_id >= 0 AND shard_id < 16),
  current_balance NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (gl_account_id, shard_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic          VARCHAR(64)  NOT NULL,
  aggregate_type VARCHAR(64)  NOT NULL,
  aggregate_id   VARCHAR(64)  NOT NULL,
  merchant_id    UUID         NULL,
  payload_json   JSONB        NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ  NULL
);

-- Partial index: ONLY indexes unprocessed outbox events! Processed rows cost 0 B-Tree space.
CREATE INDEX IF NOT EXISTS outbox_events_unprocessed_idx
  ON outbox_events (id ASC)
  WHERE processed_at IS NULL;

-- BRIN index for cheap time-based retention purge of processed outbox events
CREATE INDEX IF NOT EXISTS outbox_events_created_brin_idx
  ON outbox_events USING brin (created_at);

CREATE TABLE IF NOT EXISTS audit_outbox (
  id                  UUID         PRIMARY KEY DEFAULT uuidv7(),
  actor_id            UUID         NOT NULL,
  actor_email         VARCHAR(191) NULL,
  role                VARCHAR(64)  NOT NULL,
  action              VARCHAR(96)  NOT NULL,
  entity_type         VARCHAR(64)  NOT NULL,
  entity_id           VARCHAR(64)  NOT NULL,
  merchant_id         UUID         NULL,
  approval_request_id UUID         NULL,
  request_id          VARCHAR(64)  NULL,
  client_ip           VARCHAR(45)  NULL,
  user_agent          TEXT         NULL,
  before_json         JSONB        NOT NULL,
  after_json          JSONB        NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  shipped_at          TIMESTAMPTZ  NULL
);

CREATE INDEX IF NOT EXISTS audit_outbox_unshipped_idx
  ON audit_outbox (created_at ASC, id ASC)
  WHERE shipped_at IS NULL;

-- ============================================================================
-- 3. LEAN APPEND-ONLY LEDGER & PARTIAL / COVERING / BRIN INDEXES
-- ============================================================================

-- Covering index on journal_lines: answers balance & checkpoint verification straight from leaf pages!
CREATE INDEX IF NOT EXISTS journal_lines_account_id_cov_idx
  ON journal_lines (gl_account_id, id ASC)
  INCLUDE (direction, amount, created_at);

CREATE INDEX IF NOT EXISTS journal_lines_created_brin_idx
  ON journal_lines USING brin (created_at);

-- ============================================================================
-- 4. PARTIAL INDEXES FOR WORKER CLAIM LOOPS (TINY, ULTRA-FAST B-TREES)
-- ============================================================================

-- ExpirySweeperWorker: only indexes non-terminal attempts!
CREATE INDEX IF NOT EXISTS payment_attempts_active_expiry_partial_idx
  ON payment_attempts (expires_at ASC, status)
  INCLUDE (id, substatus)
  WHERE terminal_at IS NULL;

-- PollWorker: only indexes attempts actively awaiting a status check!
CREATE INDEX IF NOT EXISTS payment_attempts_active_poll_partial_idx
  ON payment_attempts (next_check_at ASC)
  INCLUDE (id, status, route_id)
  WHERE next_check_at IS NOT NULL AND terminal_at IS NULL;

-- InboundInboxWorker: only indexes unprocessed webhook events!
CREATE INDEX IF NOT EXISTS inbound_events_unprocessed_partial_idx
  ON inbound_events (received_at ASC)
  INCLUDE (id, channel_id, gateway_id, attempt_id)
  WHERE processed_at IS NULL;

-- BackgroundJobWorker: only indexes QUEUED jobs!
CREATE INDEX IF NOT EXISTS background_jobs_queued_partial_idx
  ON background_jobs (available_at ASC)
  INCLUDE (id, job_type, reference_type, reference_id)
  WHERE state = 'QUEUED';

-- OutboxNotificationWorker: only indexes QUEUED notifications!
CREATE INDEX IF NOT EXISTS notifications_queued_partial_idx
  ON notifications (next_attempt_at ASC)
  INCLUDE (id, channel, template_code)
  WHERE status = 'QUEUED';

-- ============================================================================
-- 5. COVERING & EXTERNAL REFERENCE INDEXES ON payment_attempts
-- ============================================================================

CREATE INDEX IF NOT EXISTS payment_attempts_provider_ref_idx
  ON payment_attempts (provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_attempts_gateway_ref_idx
  ON payment_attempts (gateway_reference)
  WHERE gateway_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_attempts_network_ref_idx
  ON payment_attempts (network_reference)
  WHERE network_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_attempts_merchant_keyset_cov_idx
  ON payment_attempts (merchant_id, created_at DESC, id DESC)
  INCLUDE (reference, status, total_charged_amount, net_merchant_amount, currency, rail_id);

CREATE INDEX IF NOT EXISTS payment_attempts_created_brin_idx
  ON payment_attempts USING brin (created_at);

-- ============================================================================
-- 6. pg_trgm GIN INDEXES FOR UNCOMPROMISED 20-GROUP GLOBAL DEEP SEARCH
-- ============================================================================

CREATE INDEX IF NOT EXISTS merchants_trgm_search_idx
  ON merchants USING gin (
    legal_name gin_trgm_ops,
    trade_name gin_trgm_ops,
    contact_email gin_trgm_ops,
    contact_phone gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS join_requests_trgm_search_idx
  ON join_requests USING gin (
    decision_reason_code gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS kyb_documents_sha256_idx
  ON kyb_documents (sha256);

CREATE INDEX IF NOT EXISTS users_trgm_search_idx
  ON users USING gin (
    email gin_trgm_ops,
    phone gin_trgm_ops
  );

```

### 4.2 Dedicated Audit Database DDL (`pg_audit_db` — Append-Only + Hash Chain)

Provisioned on `AUDIT_DB_HOST` (`pg_audit_db`):

```
-- Provisioned on pg_audit_db
CREATE TABLE IF NOT EXISTS audit_records (
  seq_no              BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id                  UUID         PRIMARY KEY,
  created_at          TIMESTAMPTZ  NOT NULL,
  ingested_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor_id            UUID         NOT NULL,
  actor_email         VARCHAR(191) NULL,
  role                VARCHAR(64)  NOT NULL,
  action              VARCHAR(96)  NOT NULL,
  entity_type         VARCHAR(64)  NOT NULL,
  entity_id           VARCHAR(64)  NOT NULL,
  merchant_id         UUID         NULL,
  approval_request_id UUID         NULL,
  request_id          VARCHAR(64)  NULL,
  client_ip           VARCHAR(45)  NULL,
  user_agent          TEXT         NULL,
  before_json         JSONB        NOT NULL,
  after_json          JSONB        NOT NULL,
  prev_hash           CHAR(64)     NOT NULL,
  row_hash            CHAR(64)     NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_records_entity_idx
  ON audit_records (entity_type, entity_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_records_actor_idx
  ON audit_records (actor_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_records_created_brin_idx
  ON audit_records USING brin (created_at);

CREATE INDEX IF NOT EXISTS audit_records_trgm_search_idx
  ON audit_records USING gin (
    action gin_trgm_ops,
    entity_type gin_trgm_ops,
    entity_id gin_trgm_ops,
    actor_email gin_trgm_ops
  );

-- Immutability trigger: forbid UPDATE and DELETE even by table owner unless superuser maintenance
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_TAMPER_PROHIBITED: audit_records is strictly append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_records;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

-- Least-privilege runtime privileges for pg_audit_writer
REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM PUBLIC;

```

### 4.3 Dedicated Operational & Step Logs Database DDL (`pg_logs_db` — Monthly Partitioned)

Provisioned on `LOG_DB_HOST` (`pg_logs_db`):

```
-- Provisioned on pg_logs_db
CREATE TABLE IF NOT EXISTS attempt_step_logs (
  id                     UUID         NOT NULL,
  attempt_id             UUID         NOT NULL,
  gateway_version_id     UUID         NOT NULL,
  phase                  VARCHAR(32)  NOT NULL,
  step_id                UUID         NULL,
  step_order             INT          NOT NULL,
  redacted_request_json  JSONB        NOT NULL,
  redacted_response_text TEXT         NOT NULL,
  http_status            INT          NULL,
  duration_ms            INT          NULL,
  outcome                VARCHAR(64)  NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS attempt_step_logs_attempt_idx
  ON attempt_step_logs (attempt_id, step_order ASC);

CREATE INDEX IF NOT EXISTS attempt_step_logs_created_brin_idx
  ON attempt_step_logs USING brin (created_at);

CREATE TABLE IF NOT EXISTS http_access_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY,
  request_id     VARCHAR(64)  NOT NULL,
  channel        VARCHAR(24)  NOT NULL,
  method         VARCHAR(10)  NOT NULL,
  route_pattern  VARCHAR(191) NOT NULL,
  status_code    SMALLINT     NOT NULL,
  duration_ms    INT          NOT NULL,
  db_queries     SMALLINT     NOT NULL DEFAULT 0,
  db_duration_ms INT          NOT NULL DEFAULT 0,
  actor_id       UUID         NULL,
  client_ip      VARCHAR(45)  NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS http_access_logs_created_brin_idx
  ON http_access_logs USING brin (created_at);

```

## 5. Segment 4 — Backup Management Orchestrator & Admin Control Plane (`pg-backup-daemon` + `core-back` + `admin-front`)

### 5.1 Architecture: Wrapping WAL-G & Barman with an Admin-Accessible Control Plane

We do not reinvent binary WAL streaming or block-level delta compression; instead, we wrap **WAL-G** (when running on the DB host) and **Barman** (when running on a dedicated `BACKUP_HOST`) inside a lightweight Bun service **`pg-backup-daemon`** (`deploy/backup-daemon/`), controlled over mTLS (`:4090`) by `core-back` and surfaced in `admin-front` (`/system/backups`):

1. **Dual-Mode Engine Selection (`BACKUP_ENGINE_MODE` in `deploy.env`):**

   * **`"wal-g"` (Single DB Host or Cloud-Resident):**

     * PostgreSQL `archive_command = 'wal-g wal-push %p'` streams every closed 16MB WAL segment continuously with **`zstd` compression** and **libsodium / OpenPGP client-side encryption** to the primary S3/MinIO/R2 bucket (`BACKUP_PRIMARY_BUCKET_URL`).

     * A post-push hook mirrors archives to the secondary target (`BACKUP_SECONDARY_SSH_TARGET` or secondary S3 bucket in a second provider).

   * **`"barman"` (Dedicated `BACKUP_HOST` Server):**

     * `BACKUP_HOST` runs `pg_receivewal` (zero-data-loss synchronous or async WAL streaming slot from `PG_REPLICA_1` or `PG_PRIMARY_HOST`) + `barman backup --jobs 4` over SSH/PostgreSQL protocol, then syncs compressed archives to the external S3 bucket (`barman-cloud-backup`).

2. **Multi-Store Coverage:**

   * **PostgreSQL 18 Relational Core (`payment_gateway_prod`):** Weekly full base backup + daily delta backup (`WAL-G delta` / `Barman incremental`) + continuous WAL archiving (RPO < 5 seconds, full Point-in-Time Recovery).

   * **Dedicated Audit Database (`pg_audit_db`):** Daily base backup + continuous WAL archiving + cryptographic chain anchor checkpoint (`last_seq_no` + `last_row_hash` signed and stored in bucket metadata).

   * **Redis (`redis`):** Hourly `BGSAVE` `dump.rdb` snapshot compressed and uploaded for fast warm-cache recovery.

3. **Automated Weekly Restore & Ledger Invariant Drill (`RestoreDrillRunner.ts`):**

   * An untested backup is not a backup. Every Sunday at `03:00 Africa/Tripoli` (or whenever an admin clicks **"Run Restore & Invariant Drill Now"** in `admin-front`):

     1. `pg-backup-daemon` launches an isolated temporary PostgreSQL 18 instance on port `55432` (`/var/lib/pg-backup-scratch`).

     2. Pulls and decrypts the latest base backup from the external bucket and replays WAL up to `target_time = now() - 5 minutes`.

     3. Runs three mandatory verification queries on the restored scratch database:

        * **Check 1 (Double-Entry Zero-Drift Invariant):** `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) FROM journal_lines` MUST equal `0.0000`.

        * **Check 2 (Sharded Balance Parity):** `SELECT COUNT(*) FROM gl_accounts g WHERE (SELECT SUM(current_balance) FROM gl_account_shards s WHERE s.gl_account_id = g.id) <> (g.checkpoint_balance + COALESCE((SELECT SUM(CASE WHEN l.direction='DEBIT' THEN l.amount ELSE -l.amount END) FROM journal_lines l WHERE l.gl_account_id = g.id AND (g.last_checkpoint_id IS NULL OR l.id > g.last_checkpoint_id)), 0))` MUST equal `0`.

        * **Check 3 (Audit Hash Chain Verification):** Verifies the restored `pg_audit_db` hash chain has `0` broken links.

     4. Writes the signed `BackupDrillReport` (`PASSED` / `FAILED`, restore duration, replayed LSN, row counts, invariant status) back to `core-back` and destroys the scratch instance.

### 5.2 `core-back` & `admin-front` Backup Management API Contract

| Endpoint | Authority Required | Description |
| ----- | ----- | ----- |
| `GET /api/v1/admin/system/backups/overview` | `security:read` or `gateway:read` | Returns live WAL archive lag (seconds & LSN delta), storage target health (Primary S3 Bucket + Secondary Remote Server), schedule config, last 30 backups, and latest Restore Drill report. |
| `POST /api/v1/admin/system/backups/trigger` | `security:write` | Triggers an immediate on-demand backup (`target: 'all' | 'postgres_core' | 'audit_db' | 'redis'`, `kind: 'full' | 'delta'`) via `pg-backup-daemon` and returns the `backupJobId`. |
| `POST /api/v1/admin/system/backups/drill` | `security:write` | Triggers an immediate scratch-instance PITR Restore & Ledger Invariant Verification Drill. |
| `PUT /api/v1/admin/system/backups/policy` | `security:write` (Maker-Checker four-eyes approval) | Updates schedule cron, retention days (`fullRetentionDays`, `walRetentionDays`), and alert thresholds. |

## 6. Segment 5 — Horizontal Node Scaling & Multi-Host Storage Orchestration in `deploy/deploy.env` & `deploy/deploy.ts`

### 6.1 Upgraded `deploy/deploy.env.example` (Horizontal Node Arrays + Individual Storage Solutions)

To scale any service horizontally or move any storage solution to its own dedicated host(s), the operator simply edits `deploy/deploy.env` and runs `./deploy/deploy.sh`:

```
# ==============================================================================
# MULTI-RAIL PAYMENT GATEWAY — HORIZONTAL & MULTI-STORAGE DEPLOYMENT (deploy.env)
# ==============================================================================
# Every compute tier and storage engine can share a single host (Dev/Staging)
# or be distributed across 5 to 30+ dedicated hosts (National Switch Production).
# Format for multi-node arrays: "nodeId@sshHost:sshPort:privateIp:servicePort"

DEPLOY_MODE="auto"                  # "auto" | "fresh" | "rolling_update"
ROLLING_BATCH_SIZE="1"              # Deploy 1 node at a time for zero downtime
KEEP_RELEASES="5"
LAN_ALLOWED_CIDRS="10.0.0.0/8,192.168.0.0/16"

# --- 1. HORIZONTALLY SCALED COMPUTE TIERS (Add/Remove Nodes Freely!) ----------
# Core-Back Nodes (mTLS 1.3 Server + Storage Engine Owner):
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.12:22:10.10.1.12:4000"
CORE_SSH_USER="ubuntu"
CORE_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_core"
CORE_SUDO_PASSWORD="core-sudo-password"
CORE_REMOTE_DIR="/var/www/pg-core"

# Admin Edge Nodes (LAN-Only 8443):
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
ADMIN_SSH_USER="ubuntu"
ADMIN_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_admin"
ADMIN_SUDO_PASSWORD="admin-sudo-password"
ADMIN_NGINX_LAN_PORT="8443"
ADMIN_DOMAIN="admin.internal"
ADMIN_REMOTE_DIR="/var/www/pg-admin"

# Merchant Edge Nodes (Public 80/443 SSL):
MERCHANT_NODES="merch-1@203.0.113.11:22:10.10.3.11:4102,merch-2@203.0.113.12:22:10.10.3.12:4102"
MERCHANT_SSH_USER="ubuntu"
MERCHANT_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_merchant"
MERCHANT_SUDO_PASSWORD="merchant-sudo-password"
MERCHANT_DOMAIN="merchant.yourdomain.ly"
MERCHANT_SSL_MODE="certbot"
MERCHANT_REMOTE_DIR="/var/www/pg-merchant"

# Checkout Edge Nodes (Public 80/443 SSL — Scale to N nodes for high traffic!):
CHECKOUT_NODES="chk-1@203.0.113.21:22:10.10.4.11:4103,chk-2@203.0.113.22:22:10.10.4.12:4103"
CHECKOUT_SSH_USER="ubuntu"
CHECKOUT_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_checkout"
CHECKOUT_SUDO_PASSWORD="checkout-sudo-password"
CHECKOUT_DOMAIN="pay.yourdomain.ly"
CHECKOUT_SSL_MODE="certbot"
CHECKOUT_REMOTE_DIR="/var/www/pg-checkout"

# --- 2. POSTGRESQL 18 RELATIONAL CORE + PGBOUNCER + STREAMING REPLICAS --------
PG_MANAGE_VIA_SSH="true"
PG_VERSION="18"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
# Streaming Read Replicas (0, 1, or N replicas; deploy.ts auto-runs pg_basebackup -R!):
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432,pg-rep-2@10.10.10.12:22:10.10.10.12:5432"
PG_SSH_USER="ubuntu"
PG_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_db"
PG_SUDO_PASSWORD="pg-sudo-password"
PG_DB_NAME="payment_gateway_prod"
PG_DB_USER="pg_core_user"
PG_DB_PASSWORD="ultra-strong-pg-password"
PG_REPLICATION_USER="pg_replicator"
PG_REPLICATION_PASSWORD="ultra-strong-repl-password"

# PgBouncer Connection Pooler (Transaction Mode, max_prepared_statements = 256):
PGBOUNCER_ENABLED="true"
PGBOUNCER_PORT="6432"
PGBOUNCER_DEFAULT_POOL_SIZE="50"
PGBOUNCER_MAX_CLIENT_CONN="2000"
PGBOUNCER_MAX_PREPARED_STATEMENTS="256"

# --- 3. REDIS 7.4+ CACHE & VELOCITY ENGINE ------------------------------------
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
REDIS_SSH_USER="ubuntu"
REDIS_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_redis"
REDIS_SUDO_PASSWORD="redis-sudo-password"
REDIS_PASSWORD="ultra-strong-redis-password"
REDIS_MAXMEMORY="4gb"

# --- 4. DEDICATED TAMPER-EVIDENT AUDIT DB & HIGH-VOLUME LOG DB ----------------
# Can point to dedicated servers OR share PG_PRIMARY_NODE / PG_REPLICA_NODES:
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@10.10.12.10:22:10.10.12.10:5432"
AUDIT_DB_SSH_USER="ubuntu"
AUDIT_DB_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_audit"
AUDIT_DB_SUDO_PASSWORD="audit-sudo-password"
AUDIT_DB_NAME="pg_audit_db"
AUDIT_DB_USER="pg_audit_writer"
AUDIT_DB_PASSWORD="ultra-strong-audit-password"

LOG_DB_MANAGE_VIA_SSH="true"
LOG_DB_NODE="log-db@10.10.12.20:22:10.10.12.20:5432"
LOG_DB_SSH_USER="ubuntu"
LOG_DB_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_log"
LOG_DB_SUDO_PASSWORD="log-sudo-password"
LOG_DB_NAME="pg_logs_db"
LOG_DB_USER="pg_log_writer"
LOG_DB_PASSWORD="ultra-strong-log-password"
LOG_RETENTION_MONTHS="12"

# --- 5. BACKUP ORCHESTRATOR & PITR DRILL ENGINE -------------------------------
BACKUP_ENABLED="true"
# Can be a dedicated server OR share PG_REPLICA_NODES[0] / PG_PRIMARY_NODE:
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_SSH_USER="ubuntu"
BACKUP_SSH_KEY_PATH="~/.ssh/id_ed25519_pg_backup"
BACKUP_SUDO_PASSWORD="backup-sudo-password"
BACKUP_ENGINE_MODE="barman"         # "wal-g" (on DB host) | "barman" (on dedicated backup host)
BACKUP_COMPRESSION="zstd"
BACKUP_ENCRYPTION_KEY_HEX="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
BACKUP_PRIMARY_S3_ENDPOINT="https://s3.eu-central-1.amazonaws.com"
BACKUP_PRIMARY_S3_BUCKET="s3://libya-pg-backups-primary/prod"
BACKUP_PRIMARY_S3_ACCESS_KEY="AKIA..."
BACKUP_PRIMARY_S3_SECRET_KEY="secret..."
BACKUP_SECONDARY_SSH_TARGET="backup-vault@198.51.100.99:/mnt/offsite-vault/pg"
BACKUP_FULL_CRON="0 2 * * 0"        # Weekly Sunday 02:00 Full Backup
BACKUP_DELTA_CRON="0 2 * * 1-6"     # Daily Mon-Sat 02:00 Delta Backup
BACKUP_DRILL_CRON="0 4 * * 0"       # Weekly Sunday 04:00 Automated Restore + Ledger Invariant Drill
BACKUP_RETENTION_FULL_COUNT="8"     # Keep 8 weeks of full backups + PITR WALs

```

### 6.2 Edge-to-Core mTLS Upstream Load Balancer & Health Failover (`admin-back`, `merchant-back`, `checkout-back`)

When `CORE_NODES` has multiple horizontal nodes (`core-1`, `core-2`, ..., `core-N`), `deploy/deploy.ts` injects `CORE_BACK_URLS="https://10.10.1.11:4000,https://10.10.1.12:4000"` into every edge service.
Create the shared mTLS Upstream Pool (`admin-back/lib/coreInternalClient.ts`, `merchant-back/lib/coreInternalClient.ts`, `checkout-back/lib/coreInternalClient.ts`):

* Maintains persistent HTTPS/mTLS keep-alive agents to every `core-back` node.

* Uses **Least-In-Flight + Round-Robin** selection across healthy `core-back` nodes.

* Passively marks a node unhealthy on `ECONNREFUSED` / `ETIMEDOUT` / `502` / `503` and immediately retries idempotent requests (and passes along `x-pg-min-lsn` headers for LSN-aware replica consistency!) on the next healthy `core-back` node—enabling **zero-downtime rolling restarts** as `deploy.ts` updates `core-1`, then `core-2`!

### 6.3 Individual Storage Solution Provisioners in `deploy/provisioners/`

Add four modular provisioners under `deploy/provisioners/` invoked by `deploy/deploy.ts`:

1. **`deploy/provisioners/postgres18Provisioner.ts`:**

   * Provisions **PostgreSQL 18** on `PG_PRIMARY_NODE` with tuned `/etc/postgresql/18/main/conf.d/zz-pg-switch.conf`:

     ```
     listen_addresses = '*'
     max_connections = 300
     shared_buffers = 8GB
     effective_cache_size = 24GB
     work_mem = 32MB
     maintenance_work_mem = 1GB
     io_method = 'io_uring'
     synchronous_commit = on
     wal_level = replica
     max_wal_senders = 16
     max_replication_slots = 16
     max_wal_size = 16GB
     min_wal_size = 2GB
     checkpoint_completion_target = 0.9
     random_page_cost = 1.1
     shared_preload_libraries = 'pg_stat_statements'
     track_io_timing = on

     ```

   * For each node in `PG_REPLICA_NODES`: creates a dedicated replication slot on Primary, runs `pg_basebackup -h <PRI_IP> -U pg_replicator -D /var/lib/postgresql/18/main -Fp -Xs -P -R` if uninitialized, and starts the hot-standby streaming replica!

   * Installs **PgBouncer 1.23+** on `PG_PRIMARY_NODE` and `PG_REPLICA_NODES` on port `6432`:

     ```
     [pgbouncer]
     listen_port = 6432
     pool_mode = transaction
     max_client_conn = 2000
     default_pool_size = 50
     reserve_pool_size = 10
     max_prepared_statements = 256
     server_reset_query_always = 0
     ignore_startup_parameters = extra_float_digits,search_path

     ```

2. **`deploy/provisioners/redisProvisioner.ts`:**

   * Provisions **Redis 7.4+** on `REDIS_NODES`, binds strictly to the node's private LAN IP, sets `requirepass`, enables hourly RDB snapshot (`save 3600 1`), and restricts UFW port `6379` exclusively to `CORE_NODES` + `BACKUP_NODE`.

3. **`deploy/provisioners/auditAndLogDbProvisioner.ts`:**

   * Provisions `pg_audit_db` on `AUDIT_DB_NODE` (applying the immutable trigger and `REVOKE UPDATE, DELETE` permissions) and `pg_logs_db` on `LOG_DB_NODE` (creating monthly partitions for `attempt_step_logs` and `http_access_logs` 6 months ahead via `pg_partman` or a lightweight partition maintenance cron).

4. **`deploy/provisioners/backupEngineProvisioner.ts`:**

   * Installs `wal-g` / `barman`, `zstd`, `rclone`, and `pg-backup-daemon` (`:4090` bound with `backup-daemon.crt` signed by `internal-ca.crt`), configures `archive_command` on `PG_PRIMARY_NODE` and `AUDIT_DB_NODE`, verifies write/read access to `BACKUP_PRIMARY_S3_BUCKET` and `BACKUP_SECONDARY_SSH_TARGET`, and installs the cron schedules + scratch-restore verifier.

## 7. Step-by-Step OpenCode Execution Plan

Execute this architecture in **7 ordered milestones**:

* \[ \] **Milestone 1 — Migrate Prisma & Schema Core to PostgreSQL 18 (`core-back/prisma/`):**

  * Switch `datasource db` in `schema.prisma` to `provider = "postgresql"`, annotate UUID columns with `@db.Uuid`, convert `@db.Text` identifier columns to `@db.VarChar(N)`, add `GlAccountShard`, `OutboxEvent`, `AuditOutbox`, `BackupCatalogRun`, and `BackupRestoreDrill`, and add the PostgreSQL 18 migration (`20261103120000_postgres18_storage_engine/migration.sql`) with Partial Indexes, `INCLUDE` Covering Indexes, BRIN Indexes, and `pg_trgm` GIN Indexes.

* \[ \] **Milestone 2 — Implement the `core-back` Storage Driver Engine (`core-back/lib/storageEngine/`):**

  * Build `ports.ts`, `uowAdapter.ts` (atomic transaction + outbox + audit-outbox + commit LSN capture + sorted shard locking), `readStoreAdapter.ts` (LSN-aware replica routing + automatic primary fallback), `redisCacheAndVelocityAdapter.ts` (L1+L2 config cache + Lua `EVALSHA` sliding-window velocity counters), and `auditAndLogAdapters.ts` (`DedicatedPostgresLogSink` ring buffer + `DedicatedAuditDatabaseDriver` with SHA-256 hash chaining).

* \[ \] **Milestone 3 — Wire the Lean Write Path & Outbox Read Models (`core-back/engine/` & `lib/`):**

  * Update `LedgerPoster.ts` to post against `gl_account_shards` (`0..15` for system accounts, `0` for merchant wallets) inside `storage.uow.run()`.

  * Build `OutboxRelayWorker.ts` and `AuditShipperWorker.ts` (`FOR UPDATE SKIP LOCKED` batch relays).

  * Route `lib/listQuery.ts` (keyset pagination) and `lib/globalSearch.ts` (all 20 plugin groups preserved 100%) through `storage.readStore.execute('replica' | { atLeastLsn })` and `storage.auditStore`.

* \[ \] **Milestone 4 — Build the Backup Daemon & Admin Portal Disaster Recovery UI (`deploy/backup-daemon/`, `core-back`, `admin-front`):**

  * Implement `deploy/backup-daemon/index.ts` (mTLS `:4090` wrapping WAL-G / Barman + `RestoreDrillRunner.ts` scratch-Postgres PITR & Ledger Invariant verifier).

  * Add `/internal/admin/system/backups/*` in `core-back`, proxy in `admin-back`, and build `admin-front/src/pages/system/backups/index.tsx` showing live WAL lag, bucket status, 1-click backup trigger, and weekly restore drill verification cards.

* \[ \] **Milestone 5 — Upgrade `deploy/` for Horizontal Multi-Node & Multi-Storage Provisioning:**

  * Upgrade `deploy/lib/configSchema.ts` and `deploy/lib/hostPlanner.ts` to parse `CORE_NODES`, `ADMIN_NODES`, `MERCHANT_NODES`, `CHECKOUT_NODES`, `PG_PRIMARY_NODE`, `PG_REPLICA_NODES`, `REDIS_NODES`, `AUDIT_DB_NODE`, `LOG_DB_NODE`, and `BACKUP_NODE`.

  * Update `deploy/lib/pkiManager.ts` for multi-node SAN generation and `deploy/lib/firewallConfigurator.ts` for multi-node UFW sets.

  * Add `postgres18Provisioner.ts`, `redisProvisioner.ts`, `auditAndLogDbProvisioner.ts`, and `backupEngineProvisioner.ts`, and implement rolling batch deployment in `deploy/deploy.ts`.

* \[ \] **Milestone 6 — Edge-to-Core mTLS Upstream Load Balancing:**

  * Upgrade `coreInternalClient.ts` in `admin-back`, `merchant-back`, and `checkout-back` to load-balance across `CORE_BACK_URLS` with active/passive failover and `x-pg-min-lsn` header propagation.

* \[ \] **Milestone 7 — End-to-End Verification & Load Benchmark Gates:**

  * Verify `UnitOfWork` atomicity, LSN-aware replica Read-Your-Own-Writes routing, `gl_account_shards` 16-way concurrency under parallel checkouts, `pg_audit_db` tamper-rejection trigger and hash-chain verification, `pg_logs_db` non-blocking backpressure drop/spool behavior, all 20 Deep Search groups on replica `pg_trgm` indexes, and an end-to-end Scratch Restore + Ledger Invariant Verification Drill.