import { moneyToString } from "../db/money";
import { PrismaRepositories } from "../db/repositories";
import type { PrismaLike } from "../db/ports";
import { dailyProcessedAmountByRoute } from "./DailyRouteVolume";
import {
  VisibleRailsResolver,
  type CommissionProfileRecord,
  type CredentialSetRecord,
  type RailChannel,
  type RailRecord,
  type RailRouteRecord,
  type VisibleRailsResult,
} from "./VisibleRailsResolver";
import type { DecimalInput } from "../ledger/LedgerPoster";

export interface RailCatalog {
  rails: RailRecord[];
  routes: RailRouteRecord[];
  credentialSets: CredentialSetRecord[];
  commissionProfiles: CommissionProfileRecord[];
}

/**
 * Reads a JSON array of strings, whatever shape the column was written in.
 */
export const asStringArray = (value: unknown): string[] | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => String(entry));
};

export interface VisibleRailsQuery {
  application: {
    id: string;
    merchantId: string;
    riskTier: string;
    railWhitelist?: readonly string[] | null;
  };
  link: {
    amount: DecimalInput;
    currency: string;
    railWhitelist?: readonly string[] | null;
  };
  channel: RailChannel;
  env: "SANDBOX" | "LIVE";
  now?: Date;
}

/**
 * The catalog of the rails, the routes, the credential sets and the
 * commission profiles.
 *
 * Every route carries the processed volume of the current business day. The
 * volume is derived from the succeeded attempts, so the daily cap is always
 * evaluated against the attempts it actually books.
 */
export const loadRailCatalog = async (
  db: PrismaLike,
  options: { now?: Date } = {},
): Promise<RailCatalog> => {
  const now = options.now ?? new Date();
  const repositories = new PrismaRepositories(db);
  const processed = await dailyProcessedAmountByRoute(repositories.payments, db, { now });
  const [rails, routes, credentialSets, commissionProfiles] = await Promise.all([
    db.rail.findMany({ orderBy: { displayOrder: "asc" } }),
    db.railRoute.findMany(),
    db.credentialSet.findMany(),
    db.commissionProfile.findMany(),
  ]);

  return {
    rails: rails.map((rail: Record<string, unknown>) => ({
      id: String(rail.id),
      code: String(rail.code),
      nameAr: (rail.nameAr as string | null) ?? undefined,
      nameEn: (rail.nameEn as string | null) ?? undefined,
      currency: String(rail.currency),
      blocked: Boolean(rail.blocked),
      displayOrder: (rail.displayOrder as number | null) ?? undefined,
      collectionMode: (rail.collectionMode as string | null) ?? undefined,
      helpGuideJson: (rail.helpGuideJson ?? undefined) as unknown,
    })),
    routes: routes.map((entry: Record<string, unknown>) => ({
      id: String(entry.id),
      railId: String(entry.railId),
      gatewayId: String(entry.gatewayId),
      credentialPolicy: entry.credentialPolicy as RailRouteRecord["credentialPolicy"],
      priority: Number(entry.priority ?? 0),
      routingStrategy: entry.routingStrategy as RailRouteRecord["routingStrategy"],
      weight: (entry.weight as number | null) ?? undefined,
      costModel: (entry.costModel ?? undefined) as RailRouteRecord["costModel"],
      minAmount: entry.minAmount as RailRouteRecord["minAmount"],
      maxAmount: (entry.maxAmount ?? null) as RailRouteRecord["maxAmount"],
      dailyCapAmount: (entry.dailyCapAmount ?? null) as RailRouteRecord["dailyCapAmount"],
      status: entry.status as RailRouteRecord["status"],
      healthState: entry.healthState as RailRouteRecord["healthState"],
      maintenanceWindows: (entry.maintenanceWindows ?? undefined) as RailRouteRecord["maintenanceWindows"],
      scope: (entry.scope ?? undefined) as RailRouteRecord["scope"],
      dailyProcessedAmount: moneyToString(processed.get(String(entry.id)) ?? 0n),
    })),
    credentialSets: credentialSets.map((entry: Record<string, unknown>) => ({
      id: String(entry.id),
      gatewayId: String(entry.gatewayId),
      env: entry.env as CredentialSetRecord["env"],
      ownerType: entry.ownerType as CredentialSetRecord["ownerType"],
      ownerMerchantId: (entry.ownerMerchantId as string | null) ?? null,
      settlementTarget: entry.settlementTarget as CredentialSetRecord["settlementTarget"],
      status: entry.status as CredentialSetRecord["status"],
    })),
    commissionProfiles: commissionProfiles.map((entry: Record<string, unknown>) => ({
      id: String(entry.id),
      merchantId: (entry.merchantId as string | null) ?? undefined,
      applicationId: (entry.applicationId as string | null) ?? undefined,
      railCode: String(entry.railCode),
      effectiveFrom: entry.effectiveFrom as Date,
      effectiveTo: (entry.effectiveTo ?? null) as Date | null,
    })),
  };
};

/**
 * Resolves the visible rails of a link.
 *
 * The resolution is the one of the visible rails formula of the design: the
 * whitelists, the commission profile, the route limits, the daily cap, the
 * maintenance windows, the scope and the credential sets.
 */
export const resolveVisibleRails = async (
  db: PrismaLike,
  query: VisibleRailsQuery,
): Promise<VisibleRailsResult> => {
  const catalog = await loadRailCatalog(db, { now: query.now });
  const resolver = new VisibleRailsResolver();
  return resolver.resolve({
    application: query.application,
    link: query.link,
    channel: query.channel,
    env: query.env,
    rails: catalog.rails,
    routes: catalog.routes,
    credentialSets: catalog.credentialSets,
    commissionProfiles: catalog.commissionProfiles,
    now: query.now,
  });
};
