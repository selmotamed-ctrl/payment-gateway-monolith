import { moneyFromDecimal, moneyToString } from "../../engine/db/money";
import type { PrismaLike, Tx } from "../../engine/db/ports";
import { toCamelRows } from "../../engine/db/rawRows";
import {
  DEFAULT_GATEWAY_TIMEZONE,
  dayWindowInTimeZone,
} from "../../engine/flow/DailyRouteVolume";
import { businessDayBucket } from "./routeDailyVolume";

const SUCCESS_STATUSES = "('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED')";

export interface MerchantDailyStatRebuildOptions {
  dayBucket: string;
  since?: Date;
  until?: Date;
  timeZone?: string;
}

const dayWindowForBucket = (
  dayBucket: string,
  timeZone: string,
): { since: Date; until: Date } => {
  const noon = new Date(`${dayBucket}T12:00:00.000Z`);
  return Number.isNaN(noon.getTime())
    ? dayWindowInTimeZone(new Date(), timeZone)
    : dayWindowInTimeZone(noon, timeZone);
};

export const rebuildMerchantDailyStatsForDay = async (
  db: PrismaLike,
  options: MerchantDailyStatRebuildOptions,
): Promise<number> => {
  const timeZone = options.timeZone ?? DEFAULT_GATEWAY_TIMEZONE;
  const window = dayWindowForBucket(options.dayBucket, timeZone);
  const since = options.since ?? window.since;
  const until = options.until ?? window.until;
  const rows = toCamelRows<Record<string, unknown>>(await db.$queryRawUnsafe(
    `SELECT pa.merchant_id,
            r.code AS rail_code,
            COUNT(*) AS initiated_count,
            SUM(CASE WHEN pa.status IN ${SUCCESS_STATUSES} THEN 1 ELSE 0 END) AS succeeded_count,
            SUM(CASE WHEN pa.status = 'FAILED' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN pa.status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired_count,
            SUM(CASE WHEN pa.status IN ('REFUNDED', 'PARTIALLY_REFUNDED') THEN 1 ELSE 0 END) AS refunded_count,
            SUM(CASE WHEN pa.status = 'DISPUTED' THEN 1 ELSE 0 END) AS disputed_count,
            COALESCE(SUM(CASE WHEN pa.status IN ${SUCCESS_STATUSES} THEN pa.total_charged_amount ELSE 0 END), 0) AS gross_succeeded_amount,
            COALESCE(SUM(CASE WHEN pa.status IN ${SUCCESS_STATUSES} THEN pa.platform_commission_amount ELSE 0 END), 0) AS platform_commission_amount,
            COALESCE(SUM(CASE WHEN pa.status IN ${SUCCESS_STATUSES} THEN pa.net_merchant_amount ELSE 0 END), 0) AS net_merchant_amount
       FROM payment_attempts pa
       INNER JOIN rails r ON r.id = pa.rail_id
      WHERE COALESCE(pa.terminal_at, pa.created_at) >= ?
        AND COALESCE(pa.terminal_at, pa.created_at) < ?
      GROUP BY pa.merchant_id, r.code`,
    since,
    until,
  ));

  await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe(
      "DELETE FROM merchant_daily_stats WHERE day_bucket = ?",
      options.dayBucket,
    );
    for (const row of rows) {
      const merchantId = String(row.merchantId ?? "");
      const railCode = String(row.railCode ?? "");
      if (!merchantId || !railCode) {
        continue;
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO merchant_daily_stats
          (merchant_id, day_bucket, rail_code, initiated_count, succeeded_count,
           failed_count, expired_count, refunded_count, disputed_count,
           gross_succeeded_amount, platform_commission_amount, net_merchant_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE initiated_count = VALUES(initiated_count),
                                 succeeded_count = VALUES(succeeded_count),
                                 failed_count = VALUES(failed_count),
                                 expired_count = VALUES(expired_count),
                                 refunded_count = VALUES(refunded_count),
                                 disputed_count = VALUES(disputed_count),
                                 gross_succeeded_amount = VALUES(gross_succeeded_amount),
                                 platform_commission_amount = VALUES(platform_commission_amount),
                                 net_merchant_amount = VALUES(net_merchant_amount)`,
        merchantId,
        options.dayBucket,
        railCode,
        Number(row.initiatedCount ?? 0),
        Number(row.succeededCount ?? 0),
        Number(row.failedCount ?? 0),
        Number(row.expiredCount ?? 0),
        Number(row.refundedCount ?? 0),
        Number(row.disputedCount ?? 0),
        moneyToString(moneyFromDecimal(row.grossSucceededAmount ?? 0)),
        moneyToString(moneyFromDecimal(row.platformCommissionAmount ?? 0)),
        moneyToString(moneyFromDecimal(row.netMerchantAmount ?? 0)),
      );
    }
  });
  return rows.length;
};

export const rebuildMerchantDailyStats = async (
  db: PrismaLike,
  options: { now?: Date; timeZone?: string; dayBucket?: string } = {},
): Promise<number> => {
  if (options.dayBucket) {
    return rebuildMerchantDailyStatsForDay(db, {
      dayBucket: options.dayBucket,
      timeZone: options.timeZone,
    });
  }
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_GATEWAY_TIMEZONE;
  const current = dayWindowInTimeZone(now, timeZone);
  const previous = dayWindowInTimeZone(new Date(current.since.getTime() - 1), timeZone);
  const currentCount = await rebuildMerchantDailyStatsForDay(db, {
    dayBucket: businessDayBucket(now, timeZone),
    since: current.since,
    until: current.until,
  });
  const previousCount = await rebuildMerchantDailyStatsForDay(db, {
    dayBucket: businessDayBucket(new Date(current.since.getTime() - 1), timeZone),
    since: previous.since,
    until: previous.until,
  });
  return currentCount + previousCount;
};

export const rollupMerchantDailyStats = rebuildMerchantDailyStats;
