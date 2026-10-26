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

export interface VisibleRailsResult {
  rails: readonly VisibleRail[];
  evaluatedAt: Date;
}

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

    for (const rail of input.rails) {
      if (rail.blocked === true || rail.currency !== input.link.currency) {
        continue;
      }
      if (allowedRailCodes !== null && !allowedRailCodes.has(rail.code)) {
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
        continue;
      }
      const candidates = input.routes
        .filter((route) => route.railId === rail.id)
        .flatMap((route) => {
          const credentialSet = this.resolveCredentialSet(input, route);
          if (!credentialSet) {
            return [];
          }
          if (!this.isRouteEligible(route, input, amount, now)) {
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
    return { rails: visible, evaluatedAt: now };
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

  private isRouteEligible(
    route: RailRouteRecord,
    input: VisibleRailsInput,
    amount: Decimal,
    now: Date,
  ): boolean {
    if (route.status !== "ACTIVE" || route.healthState !== "HEALTHY") {
      return false;
    }
    if (amount.lt(decimal(route.minAmount))) {
      return false;
    }
    if (route.maxAmount !== null && route.maxAmount !== undefined && amount.gt(decimal(route.maxAmount))) {
      return false;
    }
    if (route.dailyCapAmount !== null && route.dailyCapAmount !== undefined) {
      const processed = decimal(route.dailyProcessedAmount ?? 0);
      if (processed.plus(amount).gt(decimal(route.dailyCapAmount))) {
        return false;
      }
    }
    const windows = route.maintenanceWindows ?? [];
    if (windows.some((window) => {
      const start = new Date(window.start).getTime();
      const end = new Date(window.end).getTime();
      return now.getTime() >= start && now.getTime() < end;
    })) {
      return false;
    }
    return this.isInScope(route.scope, input);
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
