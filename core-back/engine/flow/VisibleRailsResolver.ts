import { Decimal } from "decimal.js";
import { decimal, type DecimalInput } from "../ledger/LedgerPoster";

export type RouteStatus = "ACTIVE" | "PAUSED" | "DRAINING";
export type RouteHealthState = "HEALTHY" | "DEGRADED" | "OPEN_BREAKER";
export type RoutingStrategy = "EFFECTIVE_COST" | "STRICT_PRIORITY" | "WEIGHTED";
export type RailChannel = "WEB" | "API" | "POS";
export type CredentialPolicy = "PLATFORM" | "MERCHANT_REQUIRED" | "MERCHANT_OR_PLATFORM";

export interface MaintenanceWindow {
  start: Date | string;
  end: Date | string;
}

export interface RouteScope {
  merchant_ids?: readonly string[];
  application_ids?: readonly string[];
  risk_tiers?: readonly string[];
  channels?: readonly RailChannel[];
  merchantIds?: readonly string[];
  applicationIds?: readonly string[];
  riskTiers?: readonly string[];
}

export interface RouteCostModel {
  calc_type?: "FLAT" | "PERCENTAGE" | "TIERED" | "HYBRID";
  flat?: DecimalInput;
  percent?: DecimalInput;
  min?: DecimalInput;
  max?: DecimalInput;
  tiers?: readonly {
    up_to?: DecimalInput;
    flat?: DecimalInput;
    percent?: DecimalInput;
  }[];
}

export interface RailRouteRecord {
  id: string;
  railId: string;
  gatewayId: string;
  credentialPolicy: CredentialPolicy;
  priority: number;
  routingStrategy?: RoutingStrategy;
  weight?: number;
  costModel?: RouteCostModel;
  minAmount: DecimalInput;
  maxAmount?: DecimalInput | null;
  dailyCapAmount?: DecimalInput | null;
  status: RouteStatus;
  healthState: RouteHealthState;
  maintenanceWindows?: readonly MaintenanceWindow[] | null;
  scope?: RouteScope | null;
  dailyProcessedAmount?: DecimalInput;
}

export interface RailRecord {
  id: string;
  code: string;
  nameAr?: string;
  nameEn?: string;
  currency: string;
  blocked?: boolean;
  displayOrder?: number;
  collectionMode?: string;
}

export interface CredentialSetRecord {
  id: string;
  gatewayId: string;
  env: "SANDBOX" | "LIVE";
  ownerType: "PLATFORM" | "MERCHANT";
  ownerMerchantId?: string | null;
  settlementTarget: "PLATFORM_CLEARING" | "MERCHANT_DIRECT" | "PROVIDER_HELD";
  status: "UNTESTED" | "VERIFIED" | "FAILING" | "REVOKED";
}

export interface CommissionProfileRecord {
  id: string;
  merchantId?: string | null;
  applicationId?: string | null;
  railCode: string;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  status?: "DRAFT" | "ACTIVE" | "LIVE" | "SUPERSEDED";
}

export interface VisibleRailsInput {
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
  rails: readonly RailRecord[];
  routes: readonly RailRouteRecord[];
  credentialSets: readonly CredentialSetRecord[];
  commissionProfiles: readonly CommissionProfileRecord[];
  now?: Date;
}

export interface RankedRoute {
  route: RailRouteRecord;
  credentialSet: CredentialSetRecord;
  effectiveCost: Decimal;
  rank: number;
}

export interface VisibleRail {
  rail: RailRecord;
  commissionProfile: CommissionProfileRecord;
  routes: readonly RankedRoute[];
}

/**
 * Why a rail or a route did not make it into the visible set. The reason is
 * part of the resolution result, so the daily cap guard is observable
 * instead of being an invisible filter.
 */
export type RouteExclusionReason =
  | "RAIL_BLOCKED"
  | "CURRENCY_MISMATCH"
  | "RAIL_NOT_WHITELISTED"
  | "NO_COMMISSION_PROFILE"
  | "NO_VERIFIED_CREDENTIAL_SET"
  | "ROUTE_NOT_ACTIVE"
  | "ROUTE_NOT_HEALTHY"
  | "AMOUNT_BELOW_MINIMUM"
  | "AMOUNT_ABOVE_MAXIMUM"
  | "DAILY_CAP_EXCEEDED"
  | "MAINTENANCE_WINDOW"
  | "OUT_OF_SCOPE";

export interface ExcludedRoute {
  railCode: string;
  railId: string;
  routeId: string | null;
  reason: RouteExclusionReason;
  detail?: Record<string, unknown>;
}

export interface VisibleRailsResult {
  rails: readonly VisibleRail[];
  excluded: readonly ExcludedRoute[];
  evaluatedAt: Date;
}

export interface DailyCapEvaluation {
  /** True when the route may still take the requested amount. */
  withinCap: boolean;
  /** The processed volume of the current business day. */
  processed: Decimal;
  /** The daily cap of the route, when it has one. */
  cap: Decimal | null;
  /** The headroom that is left for the requested amount. */
  remaining: Decimal | null;
}

/**
 * The daily cap condition of the visible rails formula:
 * `(route.daily_processed_amount + link.amount) <= route.daily_cap_amount`.
 *
 * It is exported so that the operational reporting evaluates the cap with
 * exactly the same semantics as the checkout resolution.
 */
export const evaluateRouteDailyCap = (
  route: { dailyCapAmount?: DecimalInput | null; dailyProcessedAmount?: DecimalInput },
  amount: DecimalInput,
): DailyCapEvaluation => {
  const processed = decimal(route.dailyProcessedAmount ?? 0);
  const cap = route.dailyCapAmount === null || route.dailyCapAmount === undefined
    ? null
    : decimal(route.dailyCapAmount);
  if (cap === null) {
    return { withinCap: true, processed, cap: null, remaining: null };
  }
  const requested = decimal(amount);
  const remaining = cap.minus(processed);
  return {
    withinCap: processed.plus(requested).lte(cap),
    processed,
    cap,
    remaining,
  };
};

const scopeValue = <T>(scope: RouteScope, snakeKey: keyof RouteScope, camelKey: keyof RouteScope): T[] | undefined => {
  const snake = scope[snakeKey] as T[] | undefined;
  if (snake !== undefined) {
    return snake;
  }
  return scope[camelKey] as T[] | undefined;
};

export class VisibleRailsResolver {
  resolve(input: VisibleRailsInput): VisibleRailsResult {
    const now = input.now ?? new Date();
    const amount = decimal(input.link.amount);
    const applicationWhitelist = this.normalizeWhitelist(input.application.railWhitelist);
    const linkWhitelist = this.normalizeWhitelist(input.link.railWhitelist);
    const allowedRailCodes = applicationWhitelist === null
      ? linkWhitelist
      : linkWhitelist === null
        ? applicationWhitelist
        : new Set([...applicationWhitelist].filter((railCode) => linkWhitelist.has(railCode)));
    const visible: VisibleRail[] = [];
    const excluded: ExcludedRoute[] = [];

    for (const rail of input.rails) {
      if (rail.blocked === true) {
        excluded.push({
          railCode: rail.code,
          railId: rail.id,
          routeId: null,
          reason: "RAIL_BLOCKED",
        });
        continue;
      }
      if (rail.currency !== input.link.currency) {
        excluded.push({
          railCode: rail.code,
          railId: rail.id,
          routeId: null,
          reason: "CURRENCY_MISMATCH",
          detail: { railCurrency: rail.currency, linkCurrency: input.link.currency },
        });
        continue;
      }
      if (allowedRailCodes !== null && !allowedRailCodes.has(rail.code)) {
        excluded.push({
          railCode: rail.code,
          railId: rail.id,
          routeId: null,
          reason: "RAIL_NOT_WHITELISTED",
        });
        continue;
      }
      const commissionProfile = this.resolveCommissionProfile(
        input.commissionProfiles,
        input.application.merchantId,
        input.application.id,
        rail.code,
        now,
      );
      if (!commissionProfile) {
        excluded.push({
          railCode: rail.code,
          railId: rail.id,
          routeId: null,
          reason: "NO_COMMISSION_PROFILE",
        });
        continue;
      }
      const candidates = input.routes
        .filter((route) => route.railId === rail.id)
        .flatMap((route) => {
          const credentialSet = this.resolveCredentialSet(input, route);
          if (!credentialSet) {
            excluded.push({
              railCode: rail.code,
              railId: rail.id,
              routeId: route.id,
              reason: "NO_VERIFIED_CREDENTIAL_SET",
            });
            return [];
          }
          const exclusion = this.routeExclusion(route, input, amount, now);
          if (exclusion) {
            excluded.push({
              railCode: rail.code,
              railId: rail.id,
              routeId: route.id,
              reason: exclusion.reason,
              detail: exclusion.detail,
            });
            return [];
          }
          return [{ route, credentialSet }];
        });
      if (candidates.length === 0) {
        continue;
      }
      const ranked = this.rankRoutes(candidates, amount);
      visible.push({ rail, commissionProfile, routes: ranked });
    }

    visible.sort((left, right) => {
      const displayOrder = (left.rail.displayOrder ?? 0) - (right.rail.displayOrder ?? 0);
      return displayOrder !== 0 ? displayOrder : left.rail.code.localeCompare(right.rail.code);
    });
    return { rails: visible, excluded, evaluatedAt: now };
  }

  resolveCommissionProfile(
    profiles: readonly CommissionProfileRecord[],
    merchantId: string,
    applicationId: string,
    railCode: string,
    now = new Date(),
  ): CommissionProfileRecord | undefined {
    const hierarchy = [
      profiles.filter((profile) => profile.merchantId === merchantId && profile.applicationId === applicationId && profile.railCode === railCode),
      profiles.filter((profile) => profile.merchantId === merchantId && !profile.applicationId && profile.railCode === railCode),
      profiles.filter((profile) => !profile.merchantId && !profile.applicationId && profile.railCode === railCode),
      profiles.filter((profile) => !profile.merchantId && !profile.applicationId && profile.railCode === "default"),
    ];
    for (const candidates of hierarchy) {
      const effective = candidates
        .filter((profile) => this.isEffective(profile, now))
        .sort((left, right) => new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime())[0];
      if (effective) {
        return effective;
      }
    }
    return undefined;
  }

  private normalizeWhitelist(values: readonly string[] | null | undefined): Set<string> | null {
    return values === null || values === undefined ? null : new Set(values);
  }

  private isEffective(profile: CommissionProfileRecord, now: Date): boolean {
    if (profile.status && !["ACTIVE", "LIVE"].includes(profile.status)) {
      return false;
    }
    const from = new Date(profile.effectiveFrom).getTime();
    const to = profile.effectiveTo ? new Date(profile.effectiveTo).getTime() : undefined;
    return from <= now.getTime() && (to === undefined || to > now.getTime());
  }

  private resolveCredentialSet(
    input: VisibleRailsInput,
    route: RailRouteRecord,
  ): CredentialSetRecord | undefined {
    const matching = input.credentialSets.filter((credentialSet) => {
      if (credentialSet.gatewayId !== route.gatewayId || credentialSet.env !== input.env) {
        return false;
      }
      if (credentialSet.status !== "VERIFIED") {
        return false;
      }
      if (route.credentialPolicy === "PLATFORM") {
        return credentialSet.ownerType === "PLATFORM";
      }
      if (route.credentialPolicy === "MERCHANT_REQUIRED") {
        return credentialSet.ownerType === "MERCHANT" && credentialSet.ownerMerchantId === input.application.merchantId;
      }
      return credentialSet.ownerType === "PLATFORM"
        || (credentialSet.ownerType === "MERCHANT" && credentialSet.ownerMerchantId === input.application.merchantId);
    });
    const platform = matching.find((credentialSet) => credentialSet.ownerType === "PLATFORM");
    return platform ?? matching[0];
  }

  private routeExclusion(
    route: RailRouteRecord,
    input: VisibleRailsInput,
    amount: Decimal,
    now: Date,
  ): { reason: RouteExclusionReason; detail?: Record<string, unknown> } | null {
    if (route.status !== "ACTIVE") {
      return { reason: "ROUTE_NOT_ACTIVE", detail: { status: route.status } };
    }
    if (route.healthState !== "HEALTHY") {
      return { reason: "ROUTE_NOT_HEALTHY", detail: { healthState: route.healthState } };
    }
    if (amount.lt(decimal(route.minAmount))) {
      return {
        reason: "AMOUNT_BELOW_MINIMUM",
        detail: { amount: amount.toFixed(4), minAmount: decimal(route.minAmount).toFixed(4) },
      };
    }
    if (route.maxAmount !== null && route.maxAmount !== undefined && amount.gt(decimal(route.maxAmount))) {
      return {
        reason: "AMOUNT_ABOVE_MAXIMUM",
        detail: { amount: amount.toFixed(4), maxAmount: decimal(route.maxAmount).toFixed(4) },
      };
    }
    const cap = evaluateRouteDailyCap(route, amount);
    if (!cap.withinCap) {
      return {
        reason: "DAILY_CAP_EXCEEDED",
        detail: {
          amount: amount.toFixed(4),
          dailyProcessedAmount: cap.processed.toFixed(4),
          dailyCapAmount: cap.cap?.toFixed(4) ?? null,
          remaining: cap.remaining?.toFixed(4) ?? null,
        },
      };
    }
    const windows = route.maintenanceWindows ?? [];
    if (windows.some((window) => {
      const start = new Date(window.start).getTime();
      const end = new Date(window.end).getTime();
      return now.getTime() >= start && now.getTime() < end;
    })) {
      return { reason: "MAINTENANCE_WINDOW" };
    }
    if (!this.isInScope(route.scope, input)) {
      return { reason: "OUT_OF_SCOPE" };
    }
    return null;
  }

  private isInScope(scope: RouteScope | null | undefined, input: VisibleRailsInput): boolean {
    if (!scope) {
      return true;
    }
    const merchantIds = scopeValue<string>(scope, "merchant_ids", "merchantIds");
    const applicationIds = scopeValue<string>(scope, "application_ids", "applicationIds");
    const riskTiers = scopeValue<string>(scope, "risk_tiers", "riskTiers");
    const channels = scopeValue<RailChannel>(scope, "channels", "channels");
    if (merchantIds !== undefined && !merchantIds.includes(input.application.merchantId)) {
      return false;
    }
    if (applicationIds !== undefined && !applicationIds.includes(input.application.id)) {
      return false;
    }
    if (riskTiers !== undefined && !riskTiers.includes(input.application.riskTier)) {
      return false;
    }
    if (channels !== undefined && !channels.includes(input.channel)) {
      return false;
    }
    return true;
  }

  rankRoutes(
    routes: readonly { route: RailRouteRecord; credentialSet: CredentialSetRecord }[],
    amount: Decimal,
  ): RankedRoute[] {
    const scored = routes.map((entry) => ({
      route: entry.route,
      credentialSet: entry.credentialSet,
      effectiveCost: this.effectiveCost(entry.route, amount),
    }));
    scored.sort((left, right) => {
      const strategy = left.route.routingStrategy ?? "EFFECTIVE_COST";
      if (strategy === "STRICT_PRIORITY") {
        const priority = right.route.priority - left.route.priority;
        if (priority !== 0) {
          return priority;
        }
      } else if (strategy === "WEIGHTED") {
        const weight = (right.route.weight ?? 100) - (left.route.weight ?? 100);
        if (weight !== 0) {
          return weight;
        }
      } else {
        const cost = left.effectiveCost.comparedTo(right.effectiveCost);
        if (cost !== 0) {
          return cost;
        }
        const priority = right.route.priority - left.route.priority;
        if (priority !== 0) {
          return priority;
        }
      }
      const gateway = left.route.gatewayId.localeCompare(right.route.gatewayId);
      if (gateway !== 0) {
        return gateway;
      }
      const credential = left.credentialSet.id.localeCompare(right.credentialSet.id);
      return credential !== 0 ? credential : left.route.id.localeCompare(right.route.id);
    });
    return scored.map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  private effectiveCost(route: RailRouteRecord, amount: Decimal): Decimal {
    const model = route.costModel;
    if (!model) {
      return new Decimal(0);
    }
    let cost = new Decimal(0);
    if (model.flat !== undefined) {
      cost = cost.plus(decimal(model.flat));
    }
    if (model.percent !== undefined) {
      cost = cost.plus(amount.mul(decimal(model.percent)).div(100));
    }
    if (model.calc_type === "TIERED" || model.calc_type === "HYBRID") {
      for (const tier of model.tiers ?? []) {
        if (tier.up_to === undefined || amount.lte(decimal(tier.up_to))) {
          if (tier.flat !== undefined) {
            cost = cost.plus(decimal(tier.flat));
          }
          if (tier.percent !== undefined) {
            cost = cost.plus(amount.mul(decimal(tier.percent)).div(100));
          }
          break;
        }
      }
    }
    if (model.min !== undefined) {
      cost = Decimal.max(cost, decimal(model.min));
    }
    if (model.max !== undefined) {
      cost = Decimal.min(cost, decimal(model.max));
    }
    return cost;
  }
}
