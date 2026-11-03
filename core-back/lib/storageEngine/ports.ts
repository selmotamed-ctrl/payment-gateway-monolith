import type { Prisma, PrismaClient } from "../../generated/prisma/client";

export type ReadConsistency =
  | "primary"
  | "replica"
  | { atLeastLsn: string; maxWaitMs?: number };

export type OutboxTopic =
  | "attempt.transitioned"
  | "ledger.entry_posted"
  | "merchant.updated"
  | "kyb.document_uploaded"
  | "reconciliation.completed"
  | "config.invalidated";

export interface OutboxEnvelope {
  topic: OutboxTopic;
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
  enqueue(event: OutboxEnvelope): Promise<void>;
  enqueueMany(events: OutboxEnvelope[]): Promise<void>;
}

export interface TransactionalAuditWriter {
  record(entry: AuditEnvelope): Promise<string>;
}

export interface StorageTx {
  readonly db: Prisma.TransactionClient;
  readonly outbox: OutboxWriter;
  readonly audit: TransactionalAuditWriter;
  lockGlAccountShardsSorted(
    targets: Array<{ glAccountId: string; shardId: number }>,
  ): Promise<Map<string, { currentBalance: Prisma.Decimal }>>;
}

export interface UnitOfWorkResult<T> {
  data: T;
  commitLsn: string;
  durationMs: number;
}

export interface UnitOfWorkOptions {
  timeoutMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  operationName?: string;
}

export interface UnitOfWorkPort {
  run<T>(
    fn: (tx: StorageTx) => Promise<T>,
    options?: UnitOfWorkOptions,
  ): Promise<UnitOfWorkResult<T>>;
}

export interface ReadStorePort {
  execute<T>(
    consistency: ReadConsistency,
    fn: (reader: PrismaClient) => Promise<T>,
    options?: { timeoutMs?: number; queryName?: string },
  ): Promise<{ data: T; servedBy: "primary" | string; replicaLagMs?: number }>;
  startLsnMonitor?(intervalMs?: number): void;
  stopLsnMonitor?(): void;
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
  getOrLoad<T>(
    key: string,
    ttlSec: number,
    loader: () => Promise<T>,
    options?: { l1TtlMs?: number },
  ): Promise<T>;
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
  del(keyOrPrefix: string): Promise<void>;
  incrWindowCounter(
    descriptors: VelocityCheckDescriptor[],
    incrementAmountMinor: bigint,
    nowEpochMs: number,
  ): Promise<VelocityEvaluationResult>;
  publishInvalidation?(channel: string, key: string): Promise<void>;
  close?(): Promise<void>;
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
  channel: "admin" | "merchant" | "checkout" | "webhook";
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
  writeStepLog(record: StepLogRecord): void;
  writeAccessLog(record: HttpAccessLogRecord): void;
  queryStepLogsForAttempt(attemptId: string): Promise<StepLogRecord[]>;
  flush(): Promise<void>;
  close?(): Promise<void>;
}

export interface AuditRecordRow extends AuditEnvelope {
  id: string;
  createdAt: Date;
  prevHash: string;
  rowHash: string;
  seqNo?: number;
}

export interface AuditQueryParams {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  role?: string;
  action?: string;
  searchPrefix?: string;
  createdFrom?: Date;
  createdTo?: Date;
  cursorCreatedAt?: Date;
  cursorId?: string;
  offset?: number;
  limit: number;
}

export interface AuditStorePort {
  queryAuditLogs(params: AuditQueryParams): Promise<{
    items: AuditRecordRow[];
    nextCursor: string | null;
  }>;
  getAuditLogById(id: string): Promise<AuditRecordRow | null>;
  countAuditLogs?(params: AuditQueryParams): Promise<number>;
  verifyHashChainIntegrity(limit?: number): Promise<{
    verifiedCount: number;
    valid: boolean;
    firstBrokenId?: string;
  }>;
}

export interface StorageHealth {
  primary: { ok: boolean; latencyMs: number; detail?: string };
  replicas: Array<{
    id: string;
    ok: boolean;
    healthy: boolean;
    lagMs: number;
    lastReplayLsn: string;
    detail?: string;
  }>;
  cache: { ok: boolean; driver: "redis" | "memory"; detail?: string };
  audit: { ok: boolean; configured: boolean; detail?: string };
  logs: { ok: boolean; configured: boolean; detail?: string };
}

export interface StorageEngine {
  uow: UnitOfWorkPort;
  readStore: ReadStorePort;
  cache: CachePort;
  auditStore: AuditStorePort | null;
  logSink: LogSinkPort;
  primary: PrismaClient;
  health(): Promise<StorageHealth>;
  shutdown(): Promise<void>;
}
