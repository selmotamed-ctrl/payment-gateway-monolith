import type { PrismaClient } from "../../../generated/prisma/client";
import { moneyFromString, moneyToString } from "../../../engine/db/money";
import type { SeederContext } from "../context";

export interface MerchantDailyStat { merchantId: string; day: string; currency: string; attemptCount: number; successCount: number; failureCount: number; gross: bigint; net: bigint }
export interface RouteDailyVolume { routeId: string; day: string; currency: string; attemptCount: number; successCount: number; volume: bigint }

const day = (value: Date): string => value.toISOString().slice(0, 10);
const FAILURE = new Set(["FAILED", "EXPIRED", "CANCELLED"]);

/**
 * The CQRS read models (`rm_merchant_daily_stats`, `rm_route_daily_volumes`)
 * exactly as `projectAttemptTransition` (lib/storageEngine/outboxWorkers.ts)
 * builds them from the outbox: the `created` event counts the attempt and its
 * gross/net money on the creation day; the transition into a success or a
 * failure status adds one success/failure count (no money) on the day of that
 * transition. Settled statuses count as a success (the refund/dispute step
 * that follows does not take the success back).
 *
 * The outbox itself is NOT seeded: the OutboxRelayWorker would project every
 * synthetic row a second time and double the read models.
 */
export const buildReadModels = (ctx: SeederContext): { merchants: MerchantDailyStat[]; routes: RouteDailyVolume[] } => {
  const merchants = new Map<string, MerchantDailyStat>();
  const routes = new Map<string, RouteDailyVolume>();
  const merchantRow = (merchantId: string, at: Date, currency: string): MerchantDailyStat => {
    const key = `${merchantId}:${day(at)}:${currency}`;
    let row = merchants.get(key);
    if (!row) merchants.set(key, (row = { merchantId, day: day(at), currency, attemptCount: 0, successCount: 0, failureCount: 0, gross: 0n, net: 0n }));
    return row;
  };
  const routeRow = (routeId: string, at: Date, currency: string): RouteDailyVolume => {
    const key = `${routeId}:${day(at)}:${currency}`;
    let row = routes.get(key);
    if (!row) routes.set(key, (row = { routeId, day: day(at), currency, attemptCount: 0, successCount: 0, volume: 0n }));
    return row;
  };
  for (const attempt of ctx.dataset.paymentAttempts) {
    const currency = String(attempt.currency);
    const created = merchantRow(String(attempt.merchantId), attempt.createdAt as Date, currency);
    created.attemptCount += 1;
    created.gross += moneyFromString(String(attempt.totalChargedAmount));
    created.net += moneyFromString(String(attempt.netMerchantAmount));
    const createdRoute = routeRow(String(attempt.routeId), attempt.createdAt as Date, currency);
    createdRoute.attemptCount += 1;
    createdRoute.volume += moneyFromString(String(attempt.totalChargedAmount));
    const status = String(attempt.status);
    const settled = ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"].includes(status);
    if (settled && attempt.terminalAt) {
      merchantRow(String(attempt.merchantId), attempt.terminalAt as Date, currency).successCount += 1;
      routeRow(String(attempt.routeId), attempt.terminalAt as Date, currency).successCount += 1;
    } else if (FAILURE.has(status) && attempt.terminalAt) {
      merchantRow(String(attempt.merchantId), attempt.terminalAt as Date, currency).failureCount += 1;
    }
  }
  return { merchants: [...merchants.values()], routes: [...routes.values()] };
};

export const writeReadModels = async (prisma: PrismaClient, ctx: SeederContext): Promise<{ merchantDays: number; routeDays: number }> => {
  const { merchants, routes } = buildReadModels(ctx);
  for (const row of merchants) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO rm_merchant_daily_stats (merchant_id, day, currency, attempt_count, success_count, failure_count, gross_amount, net_amount, updated_at)
       VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7::numeric, $8::numeric, now())
       ON CONFLICT (merchant_id, day, currency) DO UPDATE SET
         attempt_count = rm_merchant_daily_stats.attempt_count + EXCLUDED.attempt_count,
         success_count = rm_merchant_daily_stats.success_count + EXCLUDED.success_count,
         failure_count = rm_merchant_daily_stats.failure_count + EXCLUDED.failure_count,
         gross_amount = rm_merchant_daily_stats.gross_amount + EXCLUDED.gross_amount,
         net_amount = rm_merchant_daily_stats.net_amount + EXCLUDED.net_amount, updated_at = now()`,
      row.merchantId, row.day, row.currency, row.attemptCount, row.successCount, row.failureCount, moneyToString(row.gross), moneyToString(row.net),
    );
  }
  for (const row of routes) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO rm_route_daily_volumes (route_id, day, currency, attempt_count, success_count, volume_amount, updated_at)
       VALUES ($1::uuid, $2::date, $3, $4, $5, $6::numeric, now())
       ON CONFLICT (route_id, day, currency) DO UPDATE SET
         attempt_count = rm_route_daily_volumes.attempt_count + EXCLUDED.attempt_count,
         success_count = rm_route_daily_volumes.success_count + EXCLUDED.success_count,
         volume_amount = rm_route_daily_volumes.volume_amount + EXCLUDED.volume_amount, updated_at = now()`,
      row.routeId, row.day, row.currency, row.attemptCount, row.successCount, moneyToString(row.volume),
    );
  }
  return { merchantDays: merchants.length, routeDays: routes.length };
};
