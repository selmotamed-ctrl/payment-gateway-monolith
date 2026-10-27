import { moneyToString, type Money } from "../db/money";
import type { PaymentRepository, Tx } from "../db/ports";

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
