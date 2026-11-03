import { createHash } from "node:crypto";
import { moneyFromDecimal, moneyToString, type Money } from "../db/money";
import type { PaymentRepository, PrismaLike, Tx } from "../db/ports";
import { toCamelRows } from "../db/rawRows";

/**
 * The timezone the gateway books its business day in. It is the timezone
 * configured on the gateway settings (`gateway_settings.gateway_timezone`).
 */
export const DEFAULT_GATEWAY_TIMEZONE = "Africa/Tripoli";

export interface DayWindow {
  since: Date;
  until: Date;
}

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

/**
 * The offset of a timezone at a given instant, in milliseconds.
 *
 * The offset is derived from the wall clock the timezone shows for that
 * instant, so a daylight saving transition is honoured without a hardcoded
 * table of rules.
 */
export const timezoneOffsetMs = (date: Date, timeZone: string): number => {
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

/**
 * The first instant of the business day of `now` in the given timezone.
 */
export const startOfDayInTimeZone = (now: Date, timeZone: string): Date => {
  const offset = timezoneOffsetMs(now, timeZone);
  const local = new Date(now.getTime() + offset);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // The offset is re-read at the candidate instant: the offset in force at
  // midnight can differ from the offset in force right now.
  const candidate = new Date(localMidnight - offset);
  const correctedOffset = timezoneOffsetMs(candidate, timeZone);
  return new Date(localMidnight - correctedOffset);
};

/**
 * The business day of `now` in the given timezone, as a half open window.
 */
export const dayWindowInTimeZone = (now: Date, timeZone: string): DayWindow => {
  const since = startOfDayInTimeZone(now, timeZone);
  const until = startOfDayInTimeZone(new Date(since.getTime() + 36 * 60 * 60 * 1000), timeZone);
  return { since, until };
};

/**
 * The timezone the gateway books its business day in. It is read from the
 * gateway settings, so an operator can move the business day without a code
 * change.
 */
export const resolveGatewayTimezone = async (tx: Tx): Promise<string> => {
  try {
    const rows = await tx.gatewaySetting.findMany({
      select: { gatewayTimezone: true },
      orderBy: { createdAt: "asc" },
      take: 1,
    });
    const timezone = rows[0]?.gatewayTimezone;
    return typeof timezone === "string" && timezone.trim().length > 0
      ? timezone.trim()
      : DEFAULT_GATEWAY_TIMEZONE;
  } catch {
    return DEFAULT_GATEWAY_TIMEZONE;
  }
};

/**
 * The processed volume of the current business day, per route.
 *
 * The volume is derived from the succeeded attempts themselves: there is no
 * denormalised counter that could drift away from the attempts it claims to
 * summarise.
 */
export const dailyProcessedAmountByRoute = async (
  payments: Pick<PaymentRepository, "sumSucceededAmountByRouteInWindow">,
  tx: Tx,
  options: { now?: Date; timeZone?: string } = {},
): Promise<Map<string, Money>> => {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? (await resolveGatewayTimezone(tx));
  const window = dayWindowInTimeZone(now, timeZone);
  return payments.sumSucceededAmountByRouteInWindow(tx, window);
};

/**
 * The daily processed amount of every route, keyed by route id.
 */
export const dailyProcessedAmountsByRouteId = (
  totals: ReadonlyMap<string, Money>,
): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [routeId, amount] of totals.entries()) {
    output[routeId] = moneyToString(amount);
  }
  return output;
};

export const ROUTE_DAILY_VOLUME_SHARDS = 16;
export const ROUTE_DAILY_VOLUME_CACHE_MS = 5_000;

interface RouteVolumeCacheEntry {
  expiresAt: number;
  values: Map<string, Money>;
}

const volumeCache = new Map<string, RouteVolumeCacheEntry>();

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();

const dayFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = dayFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dayFormatterCache.set(timeZone, formatter);
  return formatter;
};

export const businessDayBucket = (
  now: Date,
  timeZone: string = DEFAULT_GATEWAY_TIMEZONE,
): string => {
  const parts = dayFormatter(timeZone).formatToParts(now);
  const read = (type: string): string =>
    parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${read("year")}-${read("month")}-${read("day")}`;
};

export const clearRouteDailyVolumeCache = (): void => {
  volumeCache.clear();
};

export const shardForRouteVolume = (seed: string): number => {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return digest.readUInt32BE(0) % ROUTE_DAILY_VOLUME_SHARDS;
};

export const readRouteDailyVolumes = async (
  db: PrismaLike,
  options: { now?: Date; timeZone?: string; dayBucket?: string } = {},
): Promise<Map<string, Money>> => {
  const now = options.now ?? new Date();
  const dayBucket = options.dayBucket
    ?? businessDayBucket(now, options.timeZone ?? DEFAULT_GATEWAY_TIMEZONE);
  const cached = volumeCache.get(dayBucket);
  if (cached && cached.expiresAt > Date.now()) {
    return new Map(cached.values);
  }
  const result = await db.$queryRawUnsafe(
    `SELECT route_id, SUM(total_charged_amount) AS total_charged_amount
       FROM route_daily_volumes
      WHERE day_bucket = ?
      GROUP BY route_id`,
    dayBucket,
  );
  const values = new Map<string, Money>();
  for (const row of toCamelRows<Record<string, unknown>>(result)) {
    const routeId = String(row.routeId ?? "");
    if (!routeId) {
      continue;
    }
    values.set(routeId, moneyFromDecimal(row.totalChargedAmount ?? 0));
  }
  volumeCache.set(dayBucket, {
    expiresAt: Date.now() + ROUTE_DAILY_VOLUME_CACHE_MS,
    values,
  });
  return new Map(values);
};

export interface RouteDailyVolumeRecord {
  routeId: string;
  amount: unknown;
  now?: Date;
  timeZone?: string;
  dayBucket?: string;
  shardSeed?: string;
  hardCap?: boolean;
  dailyCapAmount?: unknown;
}

export interface RouteDailyVolumeRecordResult {
  accepted: boolean;
  shardNo: number;
  dayBucket: string;
  hardCap: boolean;
}

export const recordRouteDailyVolume = async (
  tx: PrismaLike,
  input: RouteDailyVolumeRecord,
): Promise<RouteDailyVolumeRecordResult> => {
  const routeId = input.routeId;
  if (!routeId) {
    return { accepted: false, shardNo: 0, dayBucket: "", hardCap: false };
  }
  const now = input.now ?? new Date();
  const dayBucket = input.dayBucket
    ?? businessDayBucket(now, input.timeZone ?? DEFAULT_GATEWAY_TIMEZONE);
  let hardCap = input.hardCap;
  let dailyCapAmount = input.dailyCapAmount;
  if (hardCap === undefined || (hardCap && dailyCapAmount === undefined)) {
    const rows = toCamelRows<Record<string, unknown>>(await tx.$queryRawUnsafe(
      "SELECT hard_cap, daily_cap_amount FROM rail_routes WHERE id = ? LIMIT 1",
      routeId,
    ));
    const route = rows[0];
    hardCap = hardCap ?? Boolean(route?.hardCap);
    dailyCapAmount = dailyCapAmount ?? route?.dailyCapAmount ?? null;
  }
  // A soft route may overshoot by the 5 s read-cache TTL. A hard-capped
  // route keeps its day on one row so the conditional UPDATE is a true global
  // cap; soft routes spread the writes over the 16 shards.
  const shardNo = hardCap
    ? 0
    : shardForRouteVolume(input.shardSeed ?? `${routeId}:${dayBucket}:${now.getTime()}`);
  const amount = moneyToString(moneyFromDecimal(input.amount ?? 0));

  if (hardCap && dailyCapAmount !== null && dailyCapAmount !== undefined) {
    const cap = moneyToString(moneyFromDecimal(dailyCapAmount));
    await tx.$executeRawUnsafe(
      `INSERT IGNORE INTO route_daily_volumes
        (route_id, day_bucket, shard_no, succeeded_count, total_charged_amount)
       VALUES (?, ?, ?, 0, 0)`,
      routeId,
      dayBucket,
      shardNo,
    );
    const updated = Number(await tx.$executeRawUnsafe(
      `UPDATE route_daily_volumes
          SET succeeded_count = succeeded_count + 1,
              total_charged_amount = total_charged_amount + ?
        WHERE route_id = ? AND day_bucket = ? AND shard_no = ?
          AND total_charged_amount + ? <= ?`,
      amount,
      routeId,
      dayBucket,
      shardNo,
      amount,
      cap,
    ) ?? 0);
    volumeCache.delete(dayBucket);
    return { accepted: updated > 0, shardNo, dayBucket, hardCap: true };
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO route_daily_volumes
      (route_id, day_bucket, shard_no, succeeded_count, total_charged_amount)
     VALUES (?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE succeeded_count = succeeded_count + 1,
                             total_charged_amount = total_charged_amount + VALUES(total_charged_amount)`,
    routeId,
    dayBucket,
    shardNo,
    amount,
  );
  volumeCache.delete(dayBucket);
  return { accepted: true, shardNo, dayBucket, hardCap: false };
};

export const rebuildRouteDailyVolumesForDay = async (
  db: PrismaLike,
  options: { dayBucket: string; since?: Date; until?: Date; timeZone?: string },
): Promise<number> => {
  const timeZone = options.timeZone ?? DEFAULT_GATEWAY_TIMEZONE;
  const noon = new Date(`${options.dayBucket}T12:00:00.000Z`);
  const window = dayWindowInTimeZone(Number.isNaN(noon.getTime()) ? new Date() : noon, timeZone);
  const since = options.since ?? window.since;
  const until = options.until ?? window.until;
  const rows = toCamelRows<Record<string, unknown>>(await db.$queryRawUnsafe(
    `SELECT route_id, COUNT(*) AS succeeded_count,
            COALESCE(SUM(total_charged_amount), 0) AS total_charged_amount
       FROM payment_attempts
      WHERE status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED')
        AND route_id IS NOT NULL
        AND COALESCE(terminal_at, created_at) >= ?
        AND COALESCE(terminal_at, created_at) < ?
      GROUP BY route_id`,
    since,
    until,
  ));
  await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe("DELETE FROM route_daily_volumes WHERE day_bucket = ?", options.dayBucket);
    for (const row of rows) {
      const routeId = String(row.routeId ?? "");
      if (!routeId) {
        continue;
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO route_daily_volumes
          (route_id, day_bucket, shard_no, succeeded_count, total_charged_amount)
         VALUES (?, ?, 0, ?, ?)`,
        routeId,
        options.dayBucket,
        Number(row.succeededCount ?? 0),
        moneyToString(moneyFromDecimal(row.totalChargedAmount ?? 0)),
      );
    }
  });
  volumeCache.delete(options.dayBucket);
  return rows.length;
};

export const rebuildRouteDailyVolumes = async (
  db: PrismaLike,
  now: Date = new Date(),
  timeZone: string = DEFAULT_GATEWAY_TIMEZONE,
): Promise<number> => {
  const window = dayWindowInTimeZone(now, timeZone);
  return rebuildRouteDailyVolumesForDay(db, {
    dayBucket: businessDayBucket(now, timeZone),
    since: window.since,
    until: window.until,
  });
};
