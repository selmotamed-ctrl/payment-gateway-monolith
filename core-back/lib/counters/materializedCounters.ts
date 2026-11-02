import { createHash } from "node:crypto";
import { moneyFromDecimal, moneyToString, type Money } from "../../engine/db/money";
import type { PrismaLike } from "../../engine/db/ports";

/**
 * Materialized counter maintenance.
 *
 * The tables are written with single atomic `INSERT ... ON DUPLICATE KEY
 * UPDATE` statements. Callers that change the authoritative row (the payment
 * attempt) keep the counter write in the same transaction, so a rolled back
 * transition never leaves a counter behind. Lifecycle hooks are only invoked
 * after the conditional status transition actually won, which makes a replay
 * of the same transition a no-op.
 */

export const DEFAULT_COUNTER_TIMEZONE = "Africa/Tripoli";
export const MATERIALIZED_COUNTERS_SETTING_KEY = "high_scale.materialized_counters";
export const VELOCITY_BUCKET_SECONDS = 5 * 60;
export const VELOCITY_BUCKET_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export type VelocityScopeTypeName =
  | "END_CLIENT_IP"
  | "END_CLIENT_PHONE"
  | "END_CLIENT_CARD"
  | "MERCHANT"
  | "APPLICATION"
  | "RAIL"
  | "LINK";

export type AttemptLifecycleEvent =
  | "INITIATED"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "REFUNDED";

export interface VelocityScopeKey {
  scopeType: VelocityScopeTypeName;
  scopeHash: string;
}

export interface VelocityWindowTotals {
  attemptCount: number;
  succeededCount: number;
  totalAmount: Money;
}

export interface MerchantDailyStatDelta {
  initiated?: number;
  succeeded?: number;
  failed?: number;
  expired?: number;
  refunded?: number;
  disputed?: number;
  grossSucceededAmount?: Money;
  platformCommissionAmount?: Money;
  netMerchantAmount?: Money;
}

export interface MerchantDailyStatSnapshot {
  merchantId: string;
  dayBucket: string;
  railCode: string;
  initiatedCount: number;
  succeededCount: number;
  failedCount: number;
  expiredCount: number;
  refundedCount: number;
  disputedCount: number;
  grossSucceededAmount: Money;
  platformCommissionAmount: Money;
  netMerchantAmount: Money;
}

interface CounterAttempt {
  id: string;
  merchantId: string | null;
  applicationId: string | null;
  linkId: string | null;
  railId: string | null;
  routeId: string | null;
  status: string | null;
  createdAt: Date | null;
  totalChargedAmount: unknown;
  platformCommissionAmount: unknown;
  netMerchantAmount: unknown;
  clientIp: string | null;
  endClientIp: string | null;
  endClientPhoneHash: string | null;
  endClientCardAlias: string | null;
  customerFieldsMasked: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asRows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];

const safeMoney = (value: unknown): Money => {
  if (value === null || value === undefined) {
    return 0n;
  }
  try {
    return moneyFromDecimal(value);
  } catch {
    return 0n;
  }
};

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolValue = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  }
  return fallback;
};

const modelOf = (tx: PrismaLike, name: string): Record<string, any> | null => {
  const client = tx as Record<string, any>;
  const candidates = [name, `${name.charAt(0).toUpperCase()}${name.slice(1)}`];
  for (const candidate of candidates) {
    if (client[candidate]) {
      return client[candidate] as Record<string, any>;
    }
  }
  return null;
};

const countersSettingEnabled = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return boolValue(value, true);
  }
  const record = asRecord(value);
  for (const key of ["enabled", "materializedCounters", "materialized_counters", "counters"]) {
    if (record[key] !== undefined) {
      return boolValue(record[key], true);
    }
  }
  return true;
};

export const materializedCountersEnabled = async (tx: PrismaLike): Promise<boolean> => {
  try {
    const settings = modelOf(tx, "platformSetting");
    if (!settings?.findFirst) {
      return true;
    }
    const row = await settings.findFirst({
      where: { key: MATERIALIZED_COUNTERS_SETTING_KEY },
      orderBy: { version: "desc" },
    });
    if (!row) {
      return true;
    }
    return countersSettingEnabled(row.valueJson ?? row.value_json);
  } catch {
    return true;
  }
};

const zoneFormatterCache = new Map<string, Intl.DateTimeFormat>();

const zoneFormatter = (timeZone: string): Intl.DateTimeFormat | null => {
  const cached = zoneFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
};

export const counterTimezoneOffsetMs = (date: Date, timeZone: string): number => {
  const formatter = zoneFormatter(timeZone);
  if (!formatter) {
    return 0;
  }
  const parts = formatter.formatToParts(date);
  const read = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    return part ? Number(part.value) : 0;
  };
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  return asUtc - date.getTime();
};

export const counterDayBucket = (at: Date, timeZone: string): string => {
  const offset = counterTimezoneOffsetMs(at, timeZone);
  const local = new Date(at.getTime() + offset);
  return [
    local.getUTCFullYear().toString().padStart(4, "0"),
    (local.getUTCMonth() + 1).toString().padStart(2, "0"),
    local.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
};

export const resolveCounterTimezone = async (tx: PrismaLike): Promise<string> => {
  try {
    const settings = modelOf(tx, "gatewaySetting");
    if (!settings?.findMany) {
      return DEFAULT_COUNTER_TIMEZONE;
    }
    const rows = await settings.findMany({
      select: { gatewayTimezone: true },
      orderBy: { createdAt: "asc" },
      take: 1,
    });
    const timezone = Array.isArray(rows)
      ? (rows[0] as Record<string, unknown> | undefined)?.gatewayTimezone
      : null;
    return typeof timezone === "string" && timezone.trim().length > 0
      ? timezone.trim()
      : DEFAULT_COUNTER_TIMEZONE;
  } catch {
    return DEFAULT_COUNTER_TIMEZONE;
  }
};

export const velocityBucketEpoch = (at: Date): number =>
  Math.floor(at.getTime() / 1000 / VELOCITY_BUCKET_SECONDS) * VELOCITY_BUCKET_SECONDS;

const isScopedHash = (scopeType: VelocityScopeTypeName): boolean =>
  scopeType === "END_CLIENT_IP"
  || scopeType === "END_CLIENT_PHONE"
  || scopeType === "END_CLIENT_CARD";

export const velocityScopeHash = (scopeType: VelocityScopeTypeName, value: string): string => {
  const normalized = value.trim();
  if (!isScopedHash(scopeType)) {
    return normalized.slice(0, 64);
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
};

const storedHash = (value: unknown, scopeType: VelocityScopeTypeName): string | null => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  if (scopeType === "END_CLIENT_PHONE" && /^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return velocityScopeHash(scopeType, trimmed);
};

export const velocityScopesForAttempt = (attempt: {
  merchantId?: string | null;
  applicationId?: string | null;
  railId?: string | null;
  linkId?: string | null;
  clientIp?: string | null;
  endClientIp?: string | null;
  endClientPhoneHash?: string | null;
  endClientCardAlias?: string | null;
  customerFieldsMasked?: unknown;
}): VelocityScopeKey[] => {
  const masked = asRecord(attempt.customerFieldsMasked);
  const ip = attempt.endClientIp ?? attempt.clientIp ?? null;
  const phone = attempt.endClientPhoneHash ?? masked.phone ?? null;
  const cardAlias = attempt.endClientCardAlias ?? masked.card_alias ?? masked.cardAlias ?? null;
  const scopes: VelocityScopeKey[] = [];
  const ipHash = storedHash(ip, "END_CLIENT_IP");
  const phoneHash = storedHash(phone, "END_CLIENT_PHONE");
  const cardHash = storedHash(cardAlias, "END_CLIENT_CARD");
  if (ipHash) scopes.push({ scopeType: "END_CLIENT_IP", scopeHash: ipHash });
  if (phoneHash) scopes.push({ scopeType: "END_CLIENT_PHONE", scopeHash: phoneHash });
  if (cardHash) scopes.push({ scopeType: "END_CLIENT_CARD", scopeHash: cardHash });
  if (attempt.merchantId) {
    scopes.push({ scopeType: "MERCHANT", scopeHash: velocityScopeHash("MERCHANT", attempt.merchantId) });
  }
  if (attempt.applicationId) {
    scopes.push({
      scopeType: "APPLICATION",
      scopeHash: velocityScopeHash("APPLICATION", attempt.applicationId),
    });
  }
  if (attempt.railId) {
    scopes.push({ scopeType: "RAIL", scopeHash: velocityScopeHash("RAIL", attempt.railId) });
  }
  if (attempt.linkId) {
    scopes.push({ scopeType: "LINK", scopeHash: velocityScopeHash("LINK", attempt.linkId) });
  }
  return scopes;
};

/**
 * Claims one slot with a single conditional UPDATE. The row lock is held for
 * the duration of that one statement only; there is no preceding
 * `SELECT ... FOR UPDATE`.
 */
export const claimPaymentLinkSlotAtomic = async (
  tx: PrismaLike,
  params: { linkId: string; now: Date },
): Promise<boolean> => {
  let affected = 0;
  if (typeof tx.$executeRawUnsafe === "function") {
    affected = Number(await tx.$executeRawUnsafe(
      `UPDATE payment_links
          SET active_locked_count = active_locked_count + 1,
              updated_at = ?
        WHERE id = ?
          AND state = 'PENDING'
          AND (expires_at IS NULL OR expires_at > ?)
          AND (infinite_use = 1 OR (confirmed_count + active_locked_count) < use_count)`,
      params.now,
      params.linkId,
      params.now,
    ) ?? 0);
  }
  if (affected > 0) {
    return true;
  }
  // A client that does not track the raw affected-row count (some in-memory
  // doubles return 0 unconditionally) still exposes the tagged raw API. The
  // retry is the same conditional statement: on a real database it can only
  // succeed if the slot became free between the two statements, so it never
  // overbooks.
  try {
    const retried = await tx.$executeRaw`
      UPDATE payment_links
         SET active_locked_count = active_locked_count + ${1},
             updated_at = ${params.now}
       WHERE id = ${params.linkId}
         AND state = 'PENDING'
         AND (expires_at IS NULL OR expires_at > ${params.now})
         AND (infinite_use = 1 OR (confirmed_count + active_locked_count) < use_count)
    `;
    return Number(retried ?? 0) > 0;
  } catch {
    return false;
  }
};

export const readRouteDailyVolumeTotals = async (
  tx: PrismaLike,
  dayBucket: string,
): Promise<Map<string, Money> | null> => {
  if (!(await materializedCountersEnabled(tx))) {
    return null;
  }
  try {
    const result = await tx.$queryRawUnsafe(
      "SELECT route_id, total_charged_amount FROM route_daily_volumes WHERE day_bucket = ?",
      dayBucket,
    );
    const rows = asRows(result);
    if (rows.length === 0) {
      // An empty materialized table means the day has not been backfilled (or
      // no success has been recorded yet), so the caller keeps the old SUM as
      // the fallback until the counters are trusted.
      return null;
    }
    const totals = new Map<string, Money>();
    for (const row of rows) {
      const routeId = String(row.route_id ?? row.routeId ?? "");
      if (!routeId) continue;
      const amount = safeMoney(row.total_charged_amount ?? row.totalChargedAmount ?? 0);
      totals.set(routeId, (totals.get(routeId) ?? 0n) + amount);
    }
    return totals;
  } catch {
    return null;
  }
};

export const incrementRouteDailyVolume = async (
  tx: PrismaLike,
  input: { routeId: string | null | undefined; amount: Money; at?: Date; timeZone?: string },
): Promise<void> => {
  if (!input.routeId) {
    return;
  }
  const at = input.at ?? new Date();
  const timeZone = input.timeZone ?? await resolveCounterTimezone(tx);
  const dayBucket = counterDayBucket(at, timeZone);
  const amount = moneyToString(input.amount);
  if (typeof tx.$executeRawUnsafe === "function") {
    await tx.$executeRawUnsafe(
      `INSERT INTO route_daily_volumes
         (route_id, day_bucket, succeeded_count, total_charged_amount, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         succeeded_count = succeeded_count + VALUES(succeeded_count),
         total_charged_amount = total_charged_amount + VALUES(total_charged_amount),
         updated_at = VALUES(updated_at)`,
      input.routeId,
      dayBucket,
      1,
      amount,
      at,
    );
    return;
  }
  const delegate = modelOf(tx, "routeDailyVolume");
  if (!delegate?.upsert) {
    return;
  }
  await delegate.upsert({
    where: { routeId_dayBucket: { routeId: input.routeId, dayBucket } },
    create: {
      routeId: input.routeId,
      dayBucket,
      succeededCount: 1,
      totalChargedAmount: amount,
      updatedAt: at,
    },
    update: {
      succeededCount: { increment: 1 },
      totalChargedAmount: { increment: amount },
      updatedAt: at,
    },
  });
};

const MERCHANT_STAT_COLUMNS: Array<[keyof MerchantDailyStatDelta, string, "int" | "money"]> = [
  ["initiated", "initiated_count", "int"],
  ["succeeded", "succeeded_count", "int"],
  ["failed", "failed_count", "int"],
  ["expired", "expired_count", "int"],
  ["refunded", "refunded_count", "int"],
  ["disputed", "disputed_count", "int"],
  ["grossSucceededAmount", "gross_succeeded_amount", "money"],
  ["platformCommissionAmount", "platform_commission_amount", "money"],
  ["netMerchantAmount", "net_merchant_amount", "money"],
];

const mergeMerchantDelta = (
  ...deltas: Array<MerchantDailyStatDelta | null | undefined>
): MerchantDailyStatDelta => {
  const merged: MerchantDailyStatDelta = {};
  for (const delta of deltas) {
    if (!delta) continue;
    merged.initiated = (merged.initiated ?? 0) + (delta.initiated ?? 0);
    merged.succeeded = (merged.succeeded ?? 0) + (delta.succeeded ?? 0);
    merged.failed = (merged.failed ?? 0) + (delta.failed ?? 0);
    merged.expired = (merged.expired ?? 0) + (delta.expired ?? 0);
    merged.refunded = (merged.refunded ?? 0) + (delta.refunded ?? 0);
    merged.disputed = (merged.disputed ?? 0) + (delta.disputed ?? 0);
    merged.grossSucceededAmount = (merged.grossSucceededAmount ?? 0n) + (delta.grossSucceededAmount ?? 0n);
    merged.platformCommissionAmount =
      (merged.platformCommissionAmount ?? 0n) + (delta.platformCommissionAmount ?? 0n);
    merged.netMerchantAmount = (merged.netMerchantAmount ?? 0n) + (delta.netMerchantAmount ?? 0n);
  }
  return merged;
};

export const applyMerchantDailyStatDelta = async (
  tx: PrismaLike,
  input: {
    merchantId: string | null | undefined;
    railCode: string | null | undefined;
    delta: MerchantDailyStatDelta;
    at?: Date;
    dayBucket?: string;
    timeZone?: string;
  },
): Promise<void> => {
  if (!input.merchantId) {
    return;
  }
  const at = input.at ?? new Date();
  const timeZone = input.timeZone ?? await resolveCounterTimezone(tx);
  const dayBucket = input.dayBucket ?? counterDayBucket(at, timeZone);
  const railCode = (input.railCode ?? "UNKNOWN").slice(0, 64);
  const entries = MERCHANT_STAT_COLUMNS
    .map(([key, column, kind]) => {
      const raw = input.delta[key];
      const value = kind === "money" ? safeMoney(raw) : numberValue(raw);
      return { key, column, kind, value };
    })
    .filter((entry) => (
      entry.kind === "money"
        ? (entry.value as Money) !== 0n
        : (entry.value as number) !== 0
    ));
  if (entries.length === 0) {
    return;
  }
  if (typeof tx.$executeRawUnsafe === "function") {
    const columns = ["merchant_id", "day_bucket", "rail_code", ...entries.map((entry) => entry.column), "updated_at"];
    const placeholders = columns.map(() => "?").join(", ");
    const updates = entries
      .map((entry) => `\`${entry.column}\` = GREATEST(0, \`${entry.column}\` + ?)`)
      .concat("`updated_at` = VALUES(`updated_at`)");
    const insertValues = entries.map((entry) => (
      entry.kind === "money"
        ? moneyToString((entry.value as Money) > 0n ? entry.value as Money : 0n)
        : Math.max(0, entry.value as number)
    ));
    const updateValues = entries.map((entry) => (
      entry.kind === "money" ? moneyToString(entry.value as Money) : entry.value
    ));
    await tx.$executeRawUnsafe(
      `INSERT INTO merchant_daily_stats (${columns.map((column) => `\`${column}\``).join(", ")})
       VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates.join(", ")}`,
      input.merchantId,
      dayBucket,
      railCode,
      ...insertValues,
      at,
      ...updateValues,
    );
    return;
  }
  const delegate = modelOf(tx, "merchantDailyStat");
  if (!delegate?.upsert) {
    return;
  }
  const create: Record<string, unknown> = {
    merchantId: input.merchantId,
    dayBucket,
    railCode,
    updatedAt: at,
  };
  const update: Record<string, unknown> = { updatedAt: at };
  const camel = (column: string): string =>
    column.replace(/_([a-z])/g, (_match, character: string) => character.toUpperCase());
  for (const entry of entries) {
    const value = entry.kind === "money" ? moneyToString(entry.value as Money) : entry.value;
    const createValue = entry.kind === "money"
      ? moneyToString((entry.value as Money) > 0n ? entry.value as Money : 0n)
      : Math.max(0, entry.value as number);
    create[camel(entry.column)] = createValue;
    update[camel(entry.column)] = { increment: value };
  }
  await delegate.upsert({
    where: {
      merchantId_dayBucket_railCode: {
        merchantId: input.merchantId,
        dayBucket,
        railCode,
      },
    },
    create,
    update,
  });
};

export const readMerchantDailyStats = async (
  tx: PrismaLike,
  filter: { merchantId?: string; dayBucket?: string; railCode?: string } = {},
): Promise<MerchantDailyStatSnapshot[]> => {
  const delegate = modelOf(tx, "merchantDailyStat");
  if (!delegate?.findMany) {
    return [];
  }
  const where: Record<string, unknown> = {};
  if (filter.merchantId) where.merchantId = filter.merchantId;
  if (filter.dayBucket) where.dayBucket = filter.dayBucket;
  if (filter.railCode) where.railCode = filter.railCode;
  try {
    const rows = await delegate.findMany({ where });
    return asRows(rows).map((row) => ({
      merchantId: String(row.merchantId ?? row.merchant_id ?? ""),
      dayBucket: String(row.dayBucket ?? row.day_bucket ?? ""),
      railCode: String(row.railCode ?? row.rail_code ?? ""),
      initiatedCount: numberValue(row.initiatedCount ?? row.initiated_count),
      succeededCount: numberValue(row.succeededCount ?? row.succeeded_count),
      failedCount: numberValue(row.failedCount ?? row.failed_count),
      expiredCount: numberValue(row.expiredCount ?? row.expired_count),
      refundedCount: numberValue(row.refundedCount ?? row.refunded_count),
      disputedCount: numberValue(row.disputedCount ?? row.disputed_count),
      grossSucceededAmount: safeMoney(row.grossSucceededAmount ?? row.gross_succeeded_amount),
      platformCommissionAmount: safeMoney(
        row.platformCommissionAmount ?? row.platform_commission_amount,
      ),
      netMerchantAmount: safeMoney(row.netMerchantAmount ?? row.net_merchant_amount),
    }));
  } catch {
    return [];
  }
};

export const readVelocityWindowTotals = async (
  tx: PrismaLike,
  filter: { scopeType: VelocityScopeTypeName; scopeHash: string; sinceBucketEpoch: number },
): Promise<VelocityWindowTotals | null> => {
  if (!(await materializedCountersEnabled(tx))) {
    return null;
  }
  try {
    const result = await tx.$queryRawUnsafe(
      `SELECT COUNT(*) AS bucket_count,
              COALESCE(SUM(attempt_count), 0) AS attempt_count,
              COALESCE(SUM(succeeded_count), 0) AS succeeded_count,
              COALESCE(SUM(total_amount), 0) AS total_amount
         FROM velocity_window_buckets
        WHERE scope_type = ?
          AND scope_hash = ?
          AND bucket_epoch >= ?`,
      filter.scopeType,
      filter.scopeHash,
      filter.sinceBucketEpoch,
    );
    const row = asRows(result)[0];
    if (!row) {
      return null;
    }
    const bucketCount = numberValue(row.bucket_count ?? row.bucketCount);
    if (bucketCount <= 0) {
      // No bucket row in the range: the caller keeps the exact SQL scan as
      // the fallback while the counters are still being backfilled.
      return null;
    }
    return {
      attemptCount: numberValue(row.attempt_count ?? row.attemptCount),
      succeededCount: numberValue(row.succeeded_count ?? row.succeededCount),
      totalAmount: safeMoney(row.total_amount ?? row.totalAmount),
    };
  } catch {
    return null;
  }
};

export const applyVelocityWindowDelta = async (
  tx: PrismaLike,
  input: {
    scopes: VelocityScopeKey[];
    bucketEpoch: number;
    attemptCountDelta?: number;
    succeededCountDelta?: number;
    totalAmountDelta?: Money;
    now?: Date;
  },
): Promise<void> => {
  if (input.scopes.length === 0) {
    return;
  }
  const attemptDelta = input.attemptCountDelta ?? 0;
  const succeededDelta = input.succeededCountDelta ?? 0;
  const amountDelta = input.totalAmountDelta ?? 0n;
  if (attemptDelta === 0 && succeededDelta === 0 && amountDelta === 0n) {
    return;
  }
  const expiresAt = new Date(
    (input.bucketEpoch + VELOCITY_BUCKET_RETENTION_SECONDS) * 1000,
  );
  if (typeof tx.$executeRawUnsafe === "function") {
    // The insert values are clamped at zero so a compensation for an attempt
    // whose bucket is missing can never create a negative row. The update
    // clause applies the real (possibly negative) delta to an existing row.
    const insertAttempt = attemptDelta > 0 ? attemptDelta : 0;
    const insertSucceeded = succeededDelta > 0 ? succeededDelta : 0;
    const insertAmount = amountDelta > 0n ? moneyToString(amountDelta) : "0.0000";
    const rows = input.scopes.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const args: unknown[] = [];
    for (const scope of input.scopes) {
      args.push(
        scope.scopeType,
        scope.scopeHash,
        input.bucketEpoch,
        insertAttempt,
        insertSucceeded,
        insertAmount,
        expiresAt,
      );
    }
    args.push(attemptDelta, succeededDelta, moneyToString(amountDelta), expiresAt);
    await tx.$executeRawUnsafe(
      `INSERT INTO velocity_window_buckets
         (scope_type, scope_hash, bucket_epoch, attempt_count, succeeded_count, total_amount, expires_at)
       VALUES ${rows}
       ON DUPLICATE KEY UPDATE
         attempt_count = GREATEST(0, attempt_count + ?),
         succeeded_count = GREATEST(0, succeeded_count + ?),
         total_amount = GREATEST(0, total_amount + ?),
         expires_at = GREATEST(expires_at, ?)`,
      ...args,
    );
    return;
  }
  const delegate = modelOf(tx, "velocityWindowBucket");
  if (!delegate?.upsert) {
    return;
  }
  for (const scope of input.scopes) {
    await delegate.upsert({
      where: {
        scopeType_scopeHash_bucketEpoch: {
          scopeType: scope.scopeType,
          scopeHash: scope.scopeHash,
          bucketEpoch: input.bucketEpoch,
        },
      },
      create: {
        scopeType: scope.scopeType,
        scopeHash: scope.scopeHash,
        bucketEpoch: input.bucketEpoch,
        attemptCount: Math.max(0, attemptDelta),
        succeededCount: Math.max(0, succeededDelta),
        totalAmount: moneyToString(amountDelta > 0n ? amountDelta : 0n),
        expiresAt,
      },
      update: {
        attemptCount: { increment: attemptDelta },
        succeededCount: { increment: succeededDelta },
        totalAmount: { increment: moneyToString(amountDelta) },
        expiresAt,
      },
    });
  }
};

const counterAttemptSelect = {
  id: true,
  merchantId: true,
  applicationId: true,
  linkId: true,
  railId: true,
  routeId: true,
  status: true,
  createdAt: true,
  totalChargedAmount: true,
  platformCommissionAmount: true,
  netMerchantAmount: true,
  clientIp: true,
  endClientIp: true,
  endClientPhoneHash: true,
  endClientCardAlias: true,
  customerFieldsMasked: true,
};

const loadCounterAttempt = async (tx: PrismaLike, attemptId: string): Promise<CounterAttempt | null> => {
  const delegate = modelOf(tx, "paymentAttempt");
  if (!delegate?.findUnique) {
    return null;
  }
  try {
    const row = await delegate.findUnique({
      where: { id: attemptId },
      select: counterAttemptSelect,
    });
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      merchantId: row.merchantId ? String(row.merchantId) : null,
      applicationId: row.applicationId ? String(row.applicationId) : null,
      linkId: row.linkId ? String(row.linkId) : null,
      railId: row.railId ? String(row.railId) : null,
      routeId: row.routeId ? String(row.routeId) : null,
      status: row.status ? String(row.status) : null,
      createdAt: row.createdAt instanceof Date ? row.createdAt : null,
      totalChargedAmount: row.totalChargedAmount,
      platformCommissionAmount: row.platformCommissionAmount,
      netMerchantAmount: row.netMerchantAmount,
      clientIp: row.clientIp ? String(row.clientIp) : null,
      endClientIp: row.endClientIp ? String(row.endClientIp) : null,
      endClientPhoneHash: row.endClientPhoneHash ? String(row.endClientPhoneHash) : null,
      endClientCardAlias: row.endClientCardAlias ? String(row.endClientCardAlias) : null,
      customerFieldsMasked: row.customerFieldsMasked,
    };
  } catch {
    return null;
  }
};

const resolveRailCode = async (tx: PrismaLike, railId: string | null): Promise<string | null> => {
  if (!railId) {
    return null;
  }
  const delegate = modelOf(tx, "rail");
  if (!delegate?.findUnique) {
    return railId;
  }
  try {
    const row = await delegate.findUnique({ where: { id: railId }, select: { code: true } });
    const code = row?.code ?? row?.railCode;
    return typeof code === "string" && code.length > 0 ? code : railId;
  } catch {
    return railId;
  }
};

const terminalFailureStatuses = new Set(["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"]);
const successfulStatuses = new Set(["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"]);

/**
 * Applies the counter effects of one attempt lifecycle transition.
 *
 * Idempotency is derived from the status transition itself:
 *  - a replay of the same terminal status is ignored,
 *  - a late success (FAILED/EXPIRED -> SUCCEEDED) reverses the failure counter
 *    and restores the attempt to the velocity window it was created in,
 *  - an initiated attempt is counted once, in the creation transaction.
 *
 * Merchant statistics are attributed to the business day the attempt was
 * created, so terminal events of an attempt that crosses midnight still land
 * on the same row as its `initiated_count`.
 *
 * `merchant_daily_stats` has no `cancelled_count` column (the schema is
 * frozen for this change), so CANCELLED is folded into `failed_count` to keep
 * the terminal total complete.
 *
 * A status change made directly by a path that does not call this hook (for
 * example an out-of-module administrative cancellation) is not compensated;
 * the exact SQL fallback remains the safety net until that path is wired.
 */
export const recordAttemptLifecycle = async (
  tx: PrismaLike,
  input: {
    attemptId: string;
    event: AttemptLifecycleEvent;
    previousStatus?: string | null;
    at?: Date;
    timeZone?: string;
    countVelocity?: boolean;
  },
): Promise<void> => {
  const attempt = await loadCounterAttempt(tx, input.attemptId);
  if (!attempt) {
    return;
  }
  const at = input.at ?? new Date();
  const timeZone = input.timeZone ?? await resolveCounterTimezone(tx);
  const attemptAt = attempt.createdAt ?? at;
  const attemptDayBucket = counterDayBucket(attemptAt, timeZone);
  const totalAmount = safeMoney(attempt.totalChargedAmount);
  const commission = safeMoney(attempt.platformCommissionAmount);
  const net = safeMoney(attempt.netMerchantAmount);
  const railCode = await resolveRailCode(tx, attempt.railId);
  const previousStatus = input.previousStatus ?? null;
  const scopes = velocityScopesForAttempt(attempt);
  const bucketEpoch = velocityBucketEpoch(attemptAt);

  if (input.event === "INITIATED") {
    await applyMerchantDailyStatDelta(tx, {
      merchantId: attempt.merchantId,
      railCode,
      dayBucket: attemptDayBucket,
      at,
      timeZone,
      delta: { initiated: 1 },
    });
    if (input.countVelocity !== false) {
      await applyVelocityWindowDelta(tx, {
        scopes,
        bucketEpoch,
        attemptCountDelta: 1,
        totalAmountDelta: totalAmount,
        now: at,
      });
    }
    return;
  }

  if (input.event === "SUCCEEDED") {
    if (previousStatus === "SUCCEEDED") {
      return;
    }
    await incrementRouteDailyVolume(tx, {
      routeId: attempt.routeId,
      amount: totalAmount,
      at,
      timeZone,
    });
    const reversal: MerchantDailyStatDelta = {};
    if (previousStatus === "FAILED" || previousStatus === "CANCELLED") reversal.failed = -1;
    if (previousStatus === "EXPIRED") reversal.expired = -1;
    await applyMerchantDailyStatDelta(tx, {
      merchantId: attempt.merchantId,
      railCode,
      dayBucket: attemptDayBucket,
      at,
      timeZone,
      delta: mergeMerchantDelta(reversal, {
        succeeded: 1,
        grossSucceededAmount: totalAmount,
        platformCommissionAmount: commission,
        netMerchantAmount: net,
      }),
    });
    if (previousStatus && terminalFailureStatuses.has(previousStatus)) {
      // The failure path removed the attempt from its window; restore it
      // before recording the success. The bucket is keyed by the creation
      // time, not by the (late) success time.
      await applyVelocityWindowDelta(tx, {
        scopes,
        bucketEpoch,
        attemptCountDelta: 1,
        succeededCountDelta: 1,
        totalAmountDelta: totalAmount,
        now: at,
      });
    } else {
      await applyVelocityWindowDelta(tx, {
        scopes,
        bucketEpoch,
        succeededCountDelta: 1,
        now: at,
      });
    }
    return;
  }

  if (input.event === "REFUNDED") {
    if (previousStatus === "REFUNDED" || previousStatus === "PARTIALLY_REFUNDED") {
      return;
    }
    await applyMerchantDailyStatDelta(tx, {
      merchantId: attempt.merchantId,
      railCode,
      dayBucket: attemptDayBucket,
      at,
      timeZone,
      delta: { refunded: 1 },
    });
    return;
  }

  // FAILED / EXPIRED / CANCELLED
  if (previousStatus === input.event || (previousStatus && terminalFailureStatuses.has(previousStatus))) {
    return;
  }
  if (previousStatus && successfulStatuses.has(previousStatus)) {
    return;
  }
  const delta: MerchantDailyStatDelta = input.event === "EXPIRED"
    ? { expired: 1 }
    : { failed: 1 };
  await applyMerchantDailyStatDelta(tx, {
    merchantId: attempt.merchantId,
    railCode,
    dayBucket: attemptDayBucket,
    at,
    timeZone,
    delta,
  });
  await applyVelocityWindowDelta(tx, {
    scopes,
    bucketEpoch,
    attemptCountDelta: -1,
    totalAmountDelta: -totalAmount,
    now: at,
  });
};
