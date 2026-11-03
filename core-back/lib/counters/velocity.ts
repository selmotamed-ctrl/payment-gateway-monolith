import { createHmac, hkdfSync } from "node:crypto";
import { moneyFromDecimal, moneyToString, type Money } from "../../engine/db/money";
import type { PrismaLike } from "../../engine/db/ports";
import { env } from "../env";

export type VelocityScope = "END_CLIENT_IP" | "END_CLIENT_PHONE" | "END_CLIENT_CARD" | "MERCHANT" | "APPLICATION" | "RAIL" | "LINK";

export interface VelocityBucket {
  granularity: 1 | 2;
  bucket: number;
}

export interface VelocityWindowStats {
  count: number;
  totalAmount: Money;
  rows: number;
}

export interface VelocityCounterIncrement {
  scopeType: VelocityScope;
  scopeKey: string;
  amount: Money;
  now: Date;
  succeeded?: number;
}

export interface VelocityWindowQuery {
  scopeType: VelocityScope;
  scopeKey: string;
  now: Date;
  windowSeconds: number;
}

export const VELOCITY_PURGE_HOURS = 25;
/**
 * Merchant / application / rail / link counters are buffered in-process and
 * flushed every second. A rule on those scopes may therefore overshoot by at
 * most one second of traffic; payer scopes are incremented first and read back
 * inside the checkout transaction.
 */
export const VELOCITY_SOFT_TOLERANCE_MS = 1_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MINUTE_BUCKETS_PER_HOUR = 60;
const MAX_WINDOW_SECONDS = 24 * 60 * 60;
const HMAC_KEY_INFO = Buffer.from("payment-gateway:velocity-counter:hmac:v1", "utf8");
const HMAC_KEY_SALT = Buffer.from("velocity-counter", "utf8");

const keyCache = new Map<string, Buffer>();

export const velocityCountersFeatureEnabled = (): boolean =>
  process.env.VELOCITY_COUNTERS_ENABLED !== "false";

const velocityHmacKey = (secret: string): Buffer => {
  const cached = keyCache.get(secret);
  if (cached) {
    return cached;
  }
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), HMAC_KEY_SALT, HMAC_KEY_INFO, 32));
  keyCache.set(secret, key);
  return key;
};

export const hashVelocityScopeValue = (value: string, secret: string = env.KMS_MASTER_KEY): string => {
  return createHmac("sha256", velocityHmacKey(secret))
    .update(value.trim(), "utf8")
    .digest("hex");
};

const range = (from: number, to: number): number[] => {
  const output: number[] = [];
  for (let value = from; value <= to; value += 1) {
    output.push(value);
  }
  return output;
};

export const velocityBuckets = (now: Date, windowSeconds: number): VelocityBucket[] => {
  const window = Math.max(60, Math.min(MAX_WINDOW_SECONDS, Math.trunc(windowSeconds)));
  const minuteNow = Math.floor(now.getTime() / MINUTE_MS);
  if (window <= 3600) {
    const minuteStart = minuteNow - Math.ceil(window / 60) + 1;
    return range(minuteStart, minuteNow).map((bucket) => ({ granularity: 1, bucket }));
  }
  const hourNow = Math.floor(now.getTime() / HOUR_MS);
  const hourStart = Math.floor((now.getTime() - window * 1000) / HOUR_MS);
  const buckets: VelocityBucket[] = range(hourStart, hourNow - 1)
    .filter((bucket) => bucket < hourNow)
    .map((bucket) => ({ granularity: 2, bucket }));
  for (let bucket = minuteNow - MINUTE_BUCKETS_PER_HOUR + 1; bucket <= minuteNow; bucket += 1) {
    buckets.push({ granularity: 1, bucket });
  }
  return buckets;
};

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ");

const readVelocityBuckets = async (
  tx: PrismaLike,
  scopeType: VelocityScope,
  scopeKey: string,
  buckets: readonly VelocityBucket[],
): Promise<VelocityWindowStats> => {
  if (buckets.length === 0) {
    return { count: 0, totalAmount: 0n, rows: 0 };
  }
  const minutes = buckets.filter((entry) => entry.granularity === 1).map((entry) => entry.bucket);
  const hours = buckets.filter((entry) => entry.granularity === 2).map((entry) => entry.bucket);
  const clauses: string[] = [];
  if (minutes.length > 0) {
    clauses.push(`(granularity = 1 AND bucket IN (${placeholders(minutes.length)}))`);
  }
  if (hours.length > 0) {
    clauses.push(`(granularity = 2 AND bucket IN (${placeholders(hours.length)}))`);
  }
  const rows = (await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(attempts), 0) AS attempts,
            COALESCE(SUM(amount), 0) AS amount,
            COUNT(*) AS row_count
       FROM velocity_counters
      WHERE scope_type = ? AND scope_key = ? AND (${clauses.join(" OR ")})`,
    scopeType,
    scopeKey,
    ...minutes,
    ...hours,
  )) as Array<Record<string, unknown>>;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return {
    count: Number(row?.attempts ?? 0),
    totalAmount: moneyFromDecimal(row?.amount ?? 0),
    rows: Number(row?.row_count ?? 0),
  };
};

export const readVelocityWindow = async (
  tx: PrismaLike,
  query: VelocityWindowQuery,
): Promise<VelocityWindowStats> =>
  readVelocityBuckets(tx, query.scopeType, query.scopeKey, velocityBuckets(query.now, query.windowSeconds));

export const incrementVelocityCounter = async (
  tx: PrismaLike,
  input: VelocityCounterIncrement,
): Promise<void> => {
  const succeeded = input.succeeded ?? 0;
  const minute = Math.floor(input.now.getTime() / MINUTE_MS);
  const hour = Math.floor(input.now.getTime() / HOUR_MS);
  const amount = moneyToString(input.amount);
  for (const entry of [
    { granularity: 1, bucket: minute },
    { granularity: 2, bucket: hour },
  ]) {
    await tx.$executeRawUnsafe(
      `INSERT INTO velocity_counters (scope_type, scope_key, granularity, bucket, attempts, succeeded, amount)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE attempts = attempts + 1,
                               succeeded = succeeded + VALUES(succeeded),
                               amount = amount + VALUES(amount)`,
      input.scopeType,
      input.scopeKey,
      entry.granularity,
      entry.bucket,
      succeeded,
      amount,
    );
  }
};

interface BufferedCounter {
  scopeType: VelocityScope;
  scopeKey: string;
  granularity: 1 | 2;
  bucket: number;
  attempts: number;
  succeeded: number;
  amount: Money;
}

const bufferedCounters = new Map<string, BufferedCounter>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushDb: PrismaLike | null = null;
let flushing = false;

const bufferKey = (entry: Pick<BufferedCounter, "scopeType" | "scopeKey" | "granularity" | "bucket">): string =>
  `${entry.scopeType}|${entry.scopeKey}|${entry.granularity}|${entry.bucket}`;

const addBuffered = (entry: BufferedCounter): void => {
  const key = bufferKey(entry);
  const existing = bufferedCounters.get(key);
  if (existing) {
    existing.attempts += entry.attempts;
    existing.succeeded += entry.succeeded;
    existing.amount += entry.amount;
    return;
  }
  bufferedCounters.set(key, { ...entry });
};

const ensureFlushTimer = (db: PrismaLike): void => {
  flushDb = db;
  if (flushTimer) {
    return;
  }
  flushTimer = setInterval(() => {
    void flushVelocityBuffer().catch(() => undefined);
  }, VELOCITY_SOFT_TOLERANCE_MS);
  if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
    (flushTimer as { unref: () => void }).unref();
  }
};

export const bufferVelocityCounter = (
  db: PrismaLike,
  input: VelocityCounterIncrement,
): void => {
  const succeeded = input.succeeded ?? 0;
  const minute = Math.floor(input.now.getTime() / MINUTE_MS);
  const hour = Math.floor(input.now.getTime() / HOUR_MS);
  addBuffered({
    scopeType: input.scopeType,
    scopeKey: input.scopeKey,
    granularity: 1,
    bucket: minute,
    attempts: 1,
    succeeded,
    amount: input.amount,
  });
  addBuffered({
    scopeType: input.scopeType,
    scopeKey: input.scopeKey,
    granularity: 2,
    bucket: hour,
    attempts: 1,
    succeeded,
    amount: input.amount,
  });
  ensureFlushTimer(db);
};

const mergeSnapshot = (snapshot: BufferedCounter[]): void => {
  for (const entry of snapshot) {
    addBuffered(entry);
  }
};

export const flushVelocityBuffer = async (db?: PrismaLike): Promise<number> => {
  const target = db ?? flushDb;
  if (!target || flushing || bufferedCounters.size === 0) {
    return 0;
  }
  flushing = true;
  const snapshot = Array.from(bufferedCounters.values());
  bufferedCounters.clear();
  try {
    const values: unknown[] = [];
    const tuples = snapshot.map((entry) => {
      values.push(
        entry.scopeType,
        entry.scopeKey,
        entry.granularity,
        entry.bucket,
        entry.attempts,
        entry.succeeded,
        moneyToString(entry.amount),
      );
      return "(?, ?, ?, ?, ?, ?, ?)";
    });
    await target.$executeRawUnsafe(
      `INSERT INTO velocity_counters (scope_type, scope_key, granularity, bucket, attempts, succeeded, amount)
       VALUES ${tuples.join(", ")}
       ON DUPLICATE KEY UPDATE attempts = attempts + VALUES(attempts),
                               succeeded = succeeded + VALUES(succeeded),
                               amount = amount + VALUES(amount)`,
      ...values,
    );
    return snapshot.length;
  } catch (error) {
    mergeSnapshot(snapshot);
    throw error;
  } finally {
    flushing = false;
  }
};

export const readVelocityWindowWithBuffer = async (
  tx: PrismaLike,
  query: VelocityWindowQuery,
): Promise<VelocityWindowStats> => {
  const persisted = await readVelocityWindow(tx, query);
  const buckets = new Set(velocityBuckets(query.now, query.windowSeconds).map((entry) => bufferKey({
    scopeType: query.scopeType,
    scopeKey: query.scopeKey,
    granularity: entry.granularity,
    bucket: entry.bucket,
  })));
  let count = persisted.count;
  let totalAmount = persisted.totalAmount;
  let pendingRows = 0;
  for (const entry of bufferedCounters.values()) {
    if (!buckets.has(bufferKey(entry))) {
      continue;
    }
    pendingRows += 1;
    count += entry.attempts;
    totalAmount += entry.amount;
  }
  return { count, totalAmount, rows: persisted.rows + pendingRows };
};

export const purgeVelocityCounters = async (
  db: PrismaLike,
  now: Date = new Date(),
  batchSize = 5_000,
): Promise<number> => {
  const cutoff = now.getTime() - VELOCITY_PURGE_HOURS * HOUR_MS;
  const minuteCutoff = Math.floor(cutoff / MINUTE_MS);
  const hourCutoff = Math.floor(cutoff / HOUR_MS);
  const limit = Math.max(1, Math.trunc(batchSize));
  const minutes = Number(await db.$executeRawUnsafe(
    "DELETE FROM velocity_counters WHERE granularity = 1 AND bucket < ? LIMIT ?",
    minuteCutoff,
    limit,
  ) ?? 0);
  const hours = Number(await db.$executeRawUnsafe(
    "DELETE FROM velocity_counters WHERE granularity = 2 AND bucket < ? LIMIT ?",
    hourCutoff,
    limit,
  ) ?? 0);
  return minutes + hours;
};
