import type { AttemptMeta, MerchantInfo, SeederContext } from "../context";
import { metaOf } from "../context";
import { addMinutes, between, sha256Like } from "../builders";
import { businessHour, iterateDays, tripoliDateTime } from "../timelineClock";
import { buildBreakdown, D, feeAccrualOf, gatewayFeeForRoute, pricePoint, wireAmount, type CommissionProfileLike } from "../money";
import { SETTLED_STATUSES } from "../lifecycle";
import type { CommissionProfileRef, CredentialRef, RouteRef } from "../context";

/**
 * The attempt-state variables the gateway's flows read, as INITIATE would have stored them. Fake Rails resolves an
 * inquiry by our, provider or network reference, so an id-like variable carries the provider reference; the reference
 * and amount variables carry the real ones. Without them the inquiry URL cannot be built.
 */
const gatewayStateFor = (
  ctx: SeederContext,
  gatewayCode: string,
  attemptId: string,
  reference: string,
  providerReference: string,
  wireAmount: string,
): Record<string, string> => {
  const state: Record<string, string> = {};
  for (const key of ctx.refs.gatewayStateKeys?.[gatewayCode] ?? []) {
    if (/^merchantreference$/i.test(key)) state[key] = reference;
    else if (/^amounttrxn$/i.test(key)) state[key] = wireAmount;
    else if (/hash|signature/i.test(key)) state[key] = sha256Like(ctx, `hash:${attemptId}`);
    else state[key] = providerReference; // order_id, payment_id, payment_uuid, transfer_uuid, request_id, session_id, ...
  }
  return state;
};


/**
 * Payment links, attempt groups, attempts, step logs and inbound events.
 *
 * Every attempt is built from a LIFECYCLE PATH that the engine can really
 * take (`lifecycle.ts`), with one monotonic timestamp per step, never after
 * the simulation clock. Money fields come from the same pricing functions the
 * checkout uses (`money.ts`): commission profile hierarchy, fee-bearer
 * breakdown, route cost model, gateway wire rounding.
 */

type Kind =
  | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELLED" | "BLOCKED"
  | "REFUNDED" | "PARTIALLY_REFUNDED" | "DISPUTED" | "LATE_SUCCESS"
  | "AML_RELEASED" | "AML_VOIDED"
  | "AML_HELD" | "INITIATING" | "AWAITING_CUSTOMER" | "AUTHORIZING" | "VERIFYING" | "UNKNOWN" | "CONFLICT";

const SETTLED_KIND_WEIGHTS = {
  SUCCEEDED: 6700, FAILED: 1100, EXPIRED: 650, CANCELLED: 330, BLOCKED: 250,
  REFUNDED: 150, PARTIALLY_REFUNDED: 100, DISPUTED: 150, LATE_SUCCESS: 80, AML_RELEASED: 70, AML_VOIDED: 30,
} as const;
const RETRY_WEIGHTS = { FAILED: 55, EXPIRED: 25, CANCELLED: 12, BLOCKED: 8 } as const;
const LIVE_KIND_WEIGHTS = {
  AML_HELD: 10, INITIATING: 40, AWAITING_CUSTOMER: 120, AUTHORIZING: 30, VERIFYING: 40, UNKNOWN: 60, CONFLICT: 20,
} as const;
const LIVE_SHARE = 0.041;
export const AML_HOLD_THRESHOLD = 20000;

/** Share of traffic per rail code (Libyan market weights); unknown rails get 2. */
const RAIL_POPULARITY: Record<string, number> = {
  edfali: 14, sadad: 14, moamalat: 12, ly_pay: 8, tlync: 8, onepay: 6, mpgs: 5, neompay: 6, mobicash: 4,
};
/** Decline / abandonment pressure per rail family. */
const RAIL_PRESSURE: Record<string, { fail: number; expire: number }> = {
  moamalat: { fail: 1.3, expire: 0.8 },
  mpgs: { fail: 1.5, expire: 0.8 },
  ly_pay: { fail: 0.6, expire: 0.6 },
  onepay: { fail: 0.6, expire: 0.6 },
  neompay: { fail: 0.5, expire: 0.5 },
  edfali: { fail: 1.0, expire: 1.2 },
  sadad: { fail: 1.0, expire: 1.2 },
};
const FAILURE_CODES = {
  INSUFFICIENT_FUNDS: 34, WRONG_OTP: 22, LIMIT_EXCEEDED: 10, CARD_DECLINED: 12, TIMEOUT: 8, GATEWAY_FAULT: 8, RATE_LIMITED: 3, MALFORMED_RESPONSE: 3,
} as const;
const BLOCK_REASONS = { VELOCITY_END_CLIENT_IP: 30, VELOCITY_END_CLIENT_PHONE: 30, AML_WATCHLIST: 20, AML_RULE: 15, SELF_PAYMENT_NOT_ALLOWED: 5 } as const;
const TTL_CEILING: Record<string, number> = {
  OTP_PULL: 1200, REDIRECT: 1800, QR_DISPLAY: 900, PUSH_APPROVAL: 900, PAY_CODE: 900, DEEP_LINK: 900, EMBEDDED: 1800, HYBRID: 1200, MANUAL: 86_400,
};
const SUBSTATUS_BY_MODE: Record<string, string> = {
  OTP_PULL: "OTP_REQUIRED", REDIRECT: "REDIRECT_PENDING", EMBEDDED: "WIDGET_OPEN", QR_DISPLAY: "QR_PENDING",
  PUSH_APPROVAL: "PUSH_PENDING", PAY_CODE: "CODE_PENDING", DEEP_LINK: "REDIRECT_PENDING", MANUAL: "TRANSFER_PENDING", HYBRID: "OTP_REQUIRED",
};
const USER_AGENTS = [
  "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
];

const seconds = (date: Date, value: number): Date => new Date(date.getTime() + Math.round(value * 1000));

interface Plan {
  status: string;
  substatus: string | null;
  path: string[];
  times: Date[];
  terminalAt: Date | null;
}

export const generateLinksAndAttempts = (ctx: SeederContext): void => {
  const meta = metaOf(ctx);
  const end = ctx.timeline.end;
  const volumes = ctx.config.volumes;
  const days = iterateDays(ctx.timeline);
  const cumulative: number[] = [];
  let running = 0;
  for (const day of days) {
    running += day.multiplier;
    cumulative.push(running);
  }
  const sampleDay = (): Date => {
    const roll = ctx.rng.next() * running;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid]! < roll) low = mid + 1;
      else high = mid;
    }
    return days[low]!.date;
  };

  // -------------------------------------------------------------- catalog
  const operating = [...meta.merchants.values()].filter((merchant) =>
    merchant.activatedAt && merchant.applicationIds.length > 0 && ["ACTIVE", "SUSPENDED", "CLOSED"].includes(merchant.status));
  if (operating.length === 0) return;
  const appsById = new Map(ctx.dataset.applications.map((app) => [String(app.id), app]));
  const usableApps = (merchant: MerchantInfo) =>
    merchant.applicationIds.map((id) => appsById.get(id)!).filter((app) => app && app.status !== "DRAFT" && app.status !== "PENDING");
  const merchantsWithApps = operating.filter((merchant) => usableApps(merchant).length > 0);
  if (merchantsWithApps.length === 0) return;
  // Heavy-tailed merchant sizes: a few large merchants dominate volume.
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - ctx.rng.next())) * Math.cos(2 * Math.PI * ctx.rng.next());
  const merchantWeights = merchantsWithApps.map(() => Math.exp(1.1 * gauss()));
  const merchantCumulative: number[] = [];
  merchantWeights.reduce((sum, weight, index) => (merchantCumulative[index] = sum + weight), 0);
  const merchantTotal = merchantCumulative[merchantCumulative.length - 1]!;
  const pickMerchant = (): MerchantInfo => {
    const roll = ctx.rng.next() * merchantTotal;
    let low = 0;
    let high = merchantCumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (merchantCumulative[mid]! < roll) low = mid + 1;
      else high = mid;
    }
    return merchantsWithApps[low]!;
  };

  const railById = new Map(ctx.refs.rails.map((rail) => [rail.id, rail]));
  const gatewayById = new Map(ctx.refs.gateways.map((gateway) => [gateway.id, gateway]));
  const routes = ctx.refs.routes.filter((route) => (route.status ?? "ACTIVE") === "ACTIVE");
  const platformCredentials = ctx.refs.credentials.filter((credential) => credential.ownerType === "PLATFORM" && (credential.status ?? "VERIFIED") !== "REVOKED");
  if (routes.length === 0 || platformCredentials.length === 0) return;
  const merchantCredentials = new Map<string, CredentialRef[]>();
  for (const credential of ctx.refs.credentials) {
    if (credential.ownerType === "MERCHANT" && credential.ownerMerchantId && credential.status === "VERIFIED") {
      const list = merchantCredentials.get(credential.ownerMerchantId) ?? [];
      list.push(credential);
      merchantCredentials.set(credential.ownerMerchantId, list);
    }
  }
  const versionByGateway = new Map<string, string>();
  for (const gateway of ctx.refs.gateways) {
    const live = ctx.refs.versions.find((version) => version.id === gateway.activeVersionId)
      ?? ctx.refs.versions.find((version) => version.gatewayId === gateway.id && version.state === "LIVE");
    if (live) versionByGateway.set(gateway.id, live.id);
  }
  const channelByVersion = new Map<string, string>();
  for (const channel of [...(ctx.refs.confirmationChannels ?? []), ...ctx.dataset.confirmationChannels]) {
    if (channel.type === "WEBHOOK" && !channelByVersion.has(channel.gatewayVersionId)) channelByVersion.set(channel.gatewayVersionId, channel.id);
  }
  const profilesByMerchantRail = new Map<string, CommissionProfileRef[]>();
  const platformProfiles = new Map<string, CommissionProfileRef[]>();
  const allProfiles: CommissionProfileRef[] = [
    ...(ctx.refs.commissionProfiles ?? []),
    ...ctx.dataset.commissionProfiles.map((row) => ({
      id: String(row.id), merchantId: row.merchantId as string | null, applicationId: row.applicationId as string | null,
      railCode: String(row.railCode), calcType: String(row.calcType), flatFee: String(row.flatFee), percentageRate: String(row.percentageRate),
      tiersJson: row.tiersJson, minFee: String(row.minFee), maxFee: row.maxFee === null ? null : String(row.maxFee),
      effectiveFrom: row.effectiveFrom as Date, effectiveTo: (row.effectiveTo as Date | null) ?? null,
    })),
  ];
  for (const profile of allProfiles) {
    const bucket = profile.merchantId ? profilesByMerchantRail : platformProfiles;
    const key = profile.merchantId ? `${profile.merchantId}:${profile.railCode}` : profile.railCode;
    const list = bucket.get(key) ?? [];
    list.push(profile);
    bucket.set(key, list);
  }
  const effective = (list: CommissionProfileRef[] | undefined, at: Date): CommissionProfileRef | undefined =>
    (list ?? [])
      .filter((profile) => profile.effectiveFrom <= at && (!profile.effectiveTo || profile.effectiveTo > at))
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  /** Mirror of `VisibleRailsResolver.resolveCommissionProfile` (merchant+rail, platform+rail, default). */
  const resolveProfile = (merchantId: string, railCode: string, at: Date): CommissionProfileRef | undefined =>
    effective(profilesByMerchantRail.get(`${merchantId}:${railCode}`), at)
    ?? effective(platformProfiles.get(railCode), at)
    ?? effective(platformProfiles.get("default"), at);

  const routesByRail = new Map<string, RouteRef[]>();
  for (const route of routes) {
    const list = routesByRail.get(route.railId) ?? [];
    list.push(route);
    routesByRail.set(route.railId, list);
  }
  const railIds = [...routesByRail.keys()];
  const railWeights = railIds.map((id) => RAIL_POPULARITY[railById.get(id)?.code ?? ""] ?? 2);
  const railTotal = railWeights.reduce((a, b) => a + b, 0);
  const pickRoute = (amount: string, merchant: MerchantInfo, platformClearingOnly = false): { route: RouteRef; credential: CredentialRef } | null => {
    for (let tries = 0; tries < 40; tries += 1) {
      let roll = ctx.rng.next() * railTotal;
      let railId = railIds[railIds.length - 1]!;
      for (let index = 0; index < railIds.length; index += 1) {
        roll -= railWeights[index]!;
        if (roll <= 0) {
          railId = railIds[index]!;
          break;
        }
      }
      const candidates = (routesByRail.get(railId) ?? []).filter((route) => {
        const min = route.minAmount ? D(route.minAmount) : D(0);
        const max = route.maxAmount ? D(route.maxAmount) : null;
        return D(amount).gte(min) && (!max || D(amount).lte(max));
      });
      if (candidates.length === 0) continue;
      const route = candidates[Math.floor(ctx.rng.next() * candidates.length)]!;
      if (platformClearingOnly && (gatewayById.get(route.gatewayId)?.kind === "INTERNAL" || route.credentialPolicy === "MERCHANT_REQUIRED")) continue;
      const own = (merchantCredentials.get(merchant.id) ?? []).find((credential) => credential.gatewayId === route.gatewayId);
      if (route.credentialPolicy === "MERCHANT_REQUIRED" && !own) continue;
      if (!platformClearingOnly && own && route.credentialPolicy !== "PLATFORM" && ctx.rng.chance(60)) return { route, credential: own };
      if (route.credentialPolicy === "MERCHANT_REQUIRED") continue;
      const env = ctx.rng.chance(92) ? "LIVE" : "SANDBOX";
      const credential = platformCredentials.find((candidate) => candidate.gatewayId === route.gatewayId && candidate.env === env)
        ?? platformCredentials.find((candidate) => candidate.gatewayId === route.gatewayId);
      if (!credential || !versionByGateway.has(route.gatewayId)) continue;
      if (platformClearingOnly && credential.settlementTarget === "MERCHANT_DIRECT") continue;
      return { route, credential };
    }
    return null;
  };

  // ----------------------------------------------------------- volumes
  const attemptTotal = volumes.paymentAttempts;
  const tailCount = Math.min(attemptTotal, Math.max(attemptTotal >= 50 ? 1 : 0, Math.round(attemptTotal * LIVE_SHARE)));
  const normalAttempts = attemptTotal - tailCount;
  const normalLinks = Math.max(1, volumes.paymentLinks - tailCount);

  // --------------------------------------------------------------- link plan
  interface LinkPlan {
    id: string;
    row: Record<string, unknown>;
    merchant: MerchantInfo;
    appId: string;
    walletId: string;
    walletGlAccountId: string;
    infinite: boolean;
    attempts: number;
    tail: boolean;
    windowStart: Date;
    windowEnd: Date;
  }
  const plans: LinkPlan[] = [];
  const linkWindow = (merchant: MerchantInfo, at: Date): boolean =>
    at.getTime() >= merchant.activatedAt!.getTime() && (!merchant.stoppedAt || at.getTime() < merchant.stoppedAt.getTime() - 3 * 3_600_000)
    && at.getTime() <= end.getTime() - 4 * 3_600_000;
  const holdThreshold = D(15000);
  const makeLink = (index: number, tail: boolean, forceHigh = false): LinkPlan | null => {
    for (let tries = 0; tries < 40; tries += 1) {
      const merchant = tail ? (forceHigh ? pickHighTicketMerchant() : pickLiveMerchant()) : pickMerchant();
      const apps = usableApps(merchant);
      const app = apps[Math.floor(ctx.rng.next() * apps.length)]!;
      let createdAt: Date;
      if (tail) {
        createdAt = new Date(end.getTime() - ctx.rng.int(20, 36 * 60) * 60_000);
      } else {
        const day = sampleDay();
        createdAt = tripoliDateTime(day, businessHour(ctx.rng, day), ctx.rng.int(0, 59), ctx.rng.int(0, 59));
        if (!linkWindow(merchant, createdAt)) {
          if (tries < 30) continue;
          const lo = merchant.activatedAt!;
          const hi = new Date(Math.min((merchant.stoppedAt ?? end).getTime() - 3 * 3_600_000, end.getTime() - 4 * 3_600_000));
          if (hi <= lo) continue;
          createdAt = between(ctx, lo, hi);
        }
      }
      if (createdAt < app.createdAt) createdAt = new Date(Math.min(end.getTime() - 4 * 3_600_000, new Date(app.createdAt).getTime() + ctx.rng.int(1, 60) * 60_000));
      if (!tail && !linkWindow(merchant, createdAt)) continue;
      if (tail && (merchant.status !== "ACTIVE" || app.status !== "ACTIVE")) continue;
      const wallet = merchant.wallets.find((candidate) => candidate.id === app.assignedWalletId) ?? merchant.wallets[0]!;
      const infinite = !tail && ctx.rng.chance(9);
      const feeBearer = ctx.rng.weighted({ MERCHANT_ABSORBS: 70, PAYER_SURCHARGE: 20, SPLIT: 10 }) as string;
      const linkId = ctx.nextId("link");
      const row: Record<string, unknown> = {
        id: linkId,
        createdAt,
        updatedAt: createdAt,
        key: `PL${ctx.config.namespace.slice(0, 6).toUpperCase()}${index.toString(36).toUpperCase().padStart(7, "0")}`,
        applicationId: app.id,
        walletId: wallet.id,
        amount: forceHigh
          ? pricePoint(ctx.rng.next(), 15000, Math.max(15500, merchant.ticketMax))
          : pricePoint(ctx.rng.next(), merchant.ticketMin, tail ? Math.min(merchant.ticketMax, 14000) : merchant.ticketMax),
        currency: "LYD",
        feeBearer,
        splitRatioJson: feeBearer === "SPLIT" ? { platformShare: "0.5" } : null,
        infiniteUse: infinite,
        useCount: infinite ? 1 : ctx.rng.chance(88) ? 1 : ctx.rng.int(2, 5),
        confirmedCount: 0,
        activeLockedCount: 0,
        redirectUrl: ctx.rng.chance(50) ? `https://${ctx.config.namespace}.example.ly/thanks` : null,
        railWhitelist: null,
        state: "PENDING",
        expiresAt: null,
      };
      return {
        id: linkId, row, merchant, appId: String(app.id), walletId: wallet.id, walletGlAccountId: wallet.glAccountId,
        infinite, attempts: 0, tail,
        windowStart: createdAt,
        windowEnd: new Date(Math.min(end.getTime() - 4 * 3_600_000, (merchant.stoppedAt ?? end).getTime() - 3_600_000, createdAt.getTime() + 180 * 86_400_000)),
      };
    }
    return null;
  };
  const liveMerchants = merchantsWithApps.filter((merchant) => merchant.status === "ACTIVE");
  const pickHighTicketMerchant = (): MerchantInfo => {
    const pool = liveMerchants.filter((merchant) => merchant.ticketMax >= 20000);
    return pool.length > 0 ? pool[Math.floor(ctx.rng.next() * pool.length)]! : pickLiveMerchant();
  };
  const pickLiveMerchant = (): MerchantInfo =>
    liveMerchants.length > 0 ? liveMerchants[Math.floor(ctx.rng.next() * liveMerchants.length)]! : pickMerchant();

  for (let index = 0; index < normalLinks; index += 1) {
    const plan = makeLink(index, false);
    if (plan) plans.push(plan);
  }
  const mainLinks = plans.length;
  const tailKindsDrawn = Array.from({ length: tailCount }, () => ctx.rng.weighted(LIVE_KIND_WEIGHTS) as Kind);
  const tailKinds: Kind[] = [];
  for (let index = 0; index < tailCount; index += 1) {
    const plan = makeLink(normalLinks + index, true, tailKindsDrawn[index] === "AML_HELD");
    if (plan) {
      plans.push(plan);
      tailKinds.push(tailKindsDrawn[index]!);
    }
  }
  if (mainLinks === 0) return;

  // attempts per link: one each, extras to retries (35%) or reusable links (65%).
  const reusable = plans.slice(0, mainLinks).filter((plan) => plan.infinite);
  for (let index = 0; index < mainLinks && index < normalAttempts; index += 1) plans[index]!.attempts = 1;
  for (let extra = Math.max(0, normalAttempts - mainLinks); extra > 0; extra -= 1) {
    if (reusable.length > 0 && ctx.rng.chance(65)) {
      reusable[Math.floor(ctx.rng.next() * reusable.length)]!.attempts += 1;
    } else {
      const plan = plans[Math.floor(ctx.rng.next() * mainLinks)]!;
      if (plan.infinite || plan.attempts >= 4) {
        const alt = plans[Math.floor(ctx.rng.next() * mainLinks)]!;
        alt.attempts += 1;
      } else plan.attempts += 1;
    }
  }
  for (let index = mainLinks; index < plans.length; index += 1) plans[index]!.attempts = 1;

  // ------------------------------------------------------------ attempts
  const linkCounters = new Map<string, { confirmed: number; active: number; last: Date; cancelled: boolean }>();
  const groupsByLink = new Map<string, Array<{ id: string; fingerprint: string; row: Record<string, unknown> }>>();
  let attemptSequence = 0;

  const buildAttempt = (
    plan: LinkPlan,
    kind: Kind,
    createdAt: Date,
    previous: { ids: string[] },
  ): { terminalAt: Date; status: string; settled: boolean } | null => {
    const merchant = plan.merchant;
    const pick = pickRoute(String(plan.row.amount), merchant, kind.startsWith("AML_"));
    if (!pick) return null;
    const { route, credential } = pick;
    const gateway = gatewayById.get(route.gatewayId);
    const rail = railById.get(route.railId);
    const versionId = versionByGateway.get(route.gatewayId);
    if (!gateway || !rail || !versionId) return null;
    const profile = resolveProfile(merchant.id, rail.code, createdAt);
    if (!profile) return null;
    const ownership: AttemptMeta["ownershipMode"] = gateway.kind === "INTERNAL" ? "INTERNAL"
      : credential.settlementTarget === "MERCHANT_DIRECT" ? "MERCHANT_DIRECT" : "PLATFORM_CLEARING";
    // The INTERNAL (NeomPay) and MERCHANT_DIRECT templates book the requested
    // amount only, so a payer surcharge would not balance: those rails run
    // MERCHANT_ABSORBS (the engine would reject the posting otherwise).
    const feeBearer = ownership === "PLATFORM_CLEARING" ? String(plan.row.feeBearer) : "MERCHANT_ABSORBS";
    const link = { amount: String(plan.row.amount), feeBearer, splitRatioJson: feeBearer === "SPLIT" ? plan.row.splitRatioJson : null };
    const breakdown = buildBreakdown(link, profile as CommissionProfileLike);
    const costModel = route.costModel ?? null;
    const gatewayFee = ownership === "INTERNAL" ? "0.0000" : gatewayFeeForRoute(costModel, breakdown.totalCharged);
    const wire = wireAmount(gateway.code, breakdown.totalCharged);
    const mode = rail.collectionMode;
    const attemptId = ctx.nextId("attempt");
    const idx = attemptSequence;
    attemptSequence += 1;
    const reference = `PA-${createdAt.getTime().toString(36).toUpperCase()}-${sha256Like(ctx, attemptId).slice(0, 10).toUpperCase()}`;
    const ttl = Math.min(TTL_CEILING[mode] ?? 1200, 1200);
    const expiresAt = seconds(createdAt, ttl);
    const graceExpiresAt = seconds(createdAt, 24 * 3600);
    const env = credential.env;
    const providerReference = `FK-${gateway.code.toUpperCase().replace(/[^A-Z0-9]/g, "")}-${createdAt.getTime()}-${String(idx % 10000).padStart(4, "0")}`;
    const networkReference = ["moamalat", "ly_pay", "onepay", "mpgs"].includes(gateway.code)
      ? `NET-${sha256Like(ctx, `net:${attemptId}`).slice(0, 10).toUpperCase()}`
      : null;

    // ------------------------------------------------ the lifecycle path
    let status = "SUCCEEDED";
    let substatus: string | null = null;
    let path: string[] = [];
    let times: Date[] = [];
    let failureCode: string | undefined;
    let metaKind: AttemptMeta["kind"] = "NORMAL";
    let reachedGateway = true;
    let gatewayTruth: AttemptMeta["gatewayTruth"] = "PAID";
    let otpAttempts = 0;
    const pressure = RAIL_PRESSURE[rail.code] ?? { fail: 1, expire: 1 };
    // Per-rail decline / abandonment pressure re-rolls a plain success.
    if (kind === "SUCCEEDED" && ctx.rng.next() < 0.12 * (pressure.fail - 1) + 0.06 * (pressure.expire - 1)) {
      kind = ctx.rng.chance(60) ? "FAILED" : "EXPIRED";
    }
    const t = (offset: number): Date => seconds(createdAt, offset);
    const started: [Date, Date, Date] = [t(0), t(ctx.rng.next() * 2 + 0.2), t(ctx.rng.next() * 6 + 2.5)]; // CREATED, INITIATING, AWAITING_CUSTOMER
    const payerThinks = ctx.rng.next() * 270 + 25; // seconds until the payer submits
    const confirm = (from: Date): [Date, Date] => {
      const verifying = seconds(from, ctx.rng.next() * 3 + 0.5);
      return [verifying, seconds(verifying, ctx.rng.next() * 15 + 1)];
    };
    const submitAt = seconds(started[2]!, payerThinks);

    switch (kind) {
      case "SUCCEEDED":
      case "REFUNDED":
      case "PARTIALLY_REFUNDED":
      case "DISPUTED": {
        const [verifying, done] = confirm(submitAt);
        if (ctx.rng.chance(20)) {
          const authorizing = seconds(submitAt, 0.4);
          path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "SUCCEEDED"];
          times = [...started, authorizing, seconds(authorizing, 1), done];
        } else {
          path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "SUCCEEDED"];
          times = [...started, verifying, done];
        }
        otpAttempts = mode === "OTP_PULL" || mode === "HYBRID" ? (ctx.rng.chance(12) ? 1 : 0) : 0;
        break;
      }
      case "LATE_SUCCESS": {
        const expired = seconds(expiresAt, ctx.rng.next() * 120);
        const webhook = seconds(expired, ctx.rng.int(60, 6 * 3600));
        path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "EXPIRED", "SUCCEEDED"];
        times = [...started, expired, webhook];
        metaKind = "LATE_SUCCESS";
        break;
      }
      case "FAILED": {
        const code = ctx.rng.weighted(FAILURE_CODES) as string;
        const wrongOtp = (mode === "OTP_PULL" || mode === "HYBRID") && ctx.rng.chance(30);
        failureCode = wrongOtp ? "WRONG_OTP" : code === "WRONG_OTP" ? "INSUFFICIENT_FUNDS" : code;
        otpAttempts = failureCode === "WRONG_OTP" ? 3 : 0;
        const [verifying, done] = confirm(submitAt);
        const prePoNr = failureCode === "GATEWAY_FAULT" && ctx.rng.chance(40);
        path = prePoNr ? ["CREATED", "INITIATING", "FAILED"] : ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "FAILED"];
        times = prePoNr ? [started[0]!, started[1]!, seconds(started[1]!, ctx.rng.next() * 20 + 2)] : [...started, verifying, done];
        gatewayTruth = "FAILED";
        break;
      }
      case "EXPIRED": {
        path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "EXPIRED"];
        times = [...started, seconds(expiresAt, ctx.rng.next() * 150)];
        gatewayTruth = "PENDING";
        break;
      }
      case "CANCELLED": {
        path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "CANCELLED"];
        times = [...started, seconds(started[2]!, ctx.rng.next() * Math.max(10, ttl - 30) + 8)];
        gatewayTruth = "PENDING";
        break;
      }
      case "BLOCKED": {
        path = ["BLOCKED"];
        times = [t(0)];
        substatus = ctx.rng.weighted(BLOCK_REASONS) as string;
        reachedGateway = false;
        gatewayTruth = undefined;
        break;
      }
      case "AML_RELEASED":
      case "AML_VOIDED": {
        const reviewed = seconds(createdAt, ctx.rng.int(3 * 3600, 3 * 86_400));
        path = ["CREATED", kind === "AML_RELEASED" ? "SUCCEEDED" : "FAILED"];
        times = [t(0), reviewed];
        substatus = null;
        metaKind = kind === "AML_RELEASED" ? "AML_RELEASED" : "AML_VOIDED";
        reachedGateway = false;
        gatewayTruth = undefined;
        break;
      }
      // ---- live tail (createdAt is within the last 36 hours)
      case "AML_HELD": {
        path = ["CREATED"];
        times = [t(0)];
        substatus = "AML_HOLD";
        metaKind = "AML_HELD";
        reachedGateway = false;
        gatewayTruth = undefined;
        break;
      }
      case "INITIATING": {
        path = ["CREATED", "INITIATING"];
        times = [t(0), started[1]!];
        gatewayTruth = undefined;
        break;
      }
      case "AWAITING_CUSTOMER": {
        path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER"];
        times = started;
        substatus = SUBSTATUS_BY_MODE[mode] ?? "OTP_REQUIRED";
        otpAttempts = mode === "OTP_PULL" ? ctx.rng.int(0, 2) : 0;
        gatewayTruth = "PENDING";
        break;
      }
      case "AUTHORIZING": {
        path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING"];
        times = [...started, seconds(submitAt, 0.4)];
        gatewayTruth = "PENDING";
        break;
      }
      case "VERIFYING": {
        path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "VERIFYING"];
        times = [...started, seconds(submitAt, 1)];
        gatewayTruth = "PENDING";
        break;
      }
      case "UNKNOWN":
      case "CONFLICT": {
        path = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "UNKNOWN"];
        times = [...started, seconds(submitAt, 1), seconds(submitAt, ctx.rng.int(15, 35))];
        substatus = kind === "CONFLICT" ? "CONFLICTING_TRUSTED_SIGNALS" : null;
        metaKind = kind === "CONFLICT" ? "CONFLICT" : "STUCK_UNKNOWN";
        gatewayTruth = kind === "CONFLICT" ? "FAILED" : ctx.rng.chance(70) ? "PAID" : "FAILED";
        break;
      }
      default:
        return null;
    }
    // The base kind of a refund/dispute outcome ends as SUCCEEDED here; 07
    // appends the post-settlement step (REFUNDED / PARTIALLY_REFUNDED / DISPUTED).
    status = path[path.length - 1]!;
    const lastTime = times[times.length - 1]!;
    if (lastTime.getTime() > end.getTime()) return null;
    const settled = SETTLED_STATUSES.has(status);
    const inFlight = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"].includes(status);
    const terminalAt = inFlight ? null : lastTime;
    const liveWindow = (offsetMinutes: number) => addMinutes(end, offsetMinutes);

    // ---- attempt group (customer retries share a group)
    const groups = groupsByLink.get(plan.id) ?? [];
    let group = groups.length > 0 && previous.ids.length > 0 && ctx.rng.chance(85) ? groups[groups.length - 1]! : undefined;
    // `attempt_groups_single_success` (CHECK success_count <= 1): a payer who already paid on this
    // link has had their one success, so a further success belongs to a different payer/group.
    if (group && status === "SUCCEEDED" && Number(group.row.successCount) >= 1) group = undefined;
    if (!group) {
      const fingerprint = sha256Like(ctx, `fingerprint:${plan.id}:${groups.length}:${attemptId}`);
      group = {
        id: ctx.nextId("attempt-group"),
        fingerprint,
        row: { id: "", createdAt, updatedAt: createdAt, linkId: plan.id, customerFingerprint: fingerprint, successCount: 0 },
      };
      group.row.id = group.id;
      groups.push(group);
      groupsByLink.set(plan.id, groups);
      ctx.dataset.attemptGroups.push(group.row);
    }
    if (status === "SUCCEEDED") group.row.successCount = Number(group.row.successCount) + 1;
    group.row.updatedAt = lastTime;

    const phone = `09${ctx.rng.int(1, 5)}${String(ctx.rng.int(0, 9_999_999)).padStart(7, "0")}`;
    const maskedPhone = `${phone.slice(0, 3)}****${phone.slice(-3)}`;
    const ip = `203.0.113.${ctx.rng.int(1, 250)}`;
    const blocked = status === "BLOCKED";
    const row = {
      id: attemptId,
      createdAt,
      updatedAt: lastTime,
      reference,
      idempotencyKey: `idem-${sha256Like(ctx, `idem:${attemptId}`).slice(0, 20)}`,
      linkId: plan.id,
      attemptGroupId: group.id,
      applicationId: plan.appId,
      merchantId: merchant.id,
      railId: route.railId,
      routeId: route.id,
      credentialSetId: credential.id,
      gatewayVersionId: versionId,
      commissionProfileId: profile.id,
      env,
      mode,
      subMode: null,
      status,
      substatus,
      gatewayReference: reachedGateway && !blocked ? providerReference : null,
      providerReference: reachedGateway && !blocked ? providerReference : null,
      networkReference: reachedGateway && !blocked ? networkReference : null,
      requestedAmount: D(link.amount).toFixed(4),
      surchargeAmount: breakdown.payerSurcharge,
      totalChargedAmount: breakdown.totalCharged,
      gatewayAmountWire: blocked ? null : wire.wire,
      settledAmount: settled ? wire.settled : null,
      gatewayFeeAmount: blocked ? null : gatewayFee,
      platformCommissionAmount: breakdown.commission,
      netMerchantAmount: breakdown.merchantCredited,
      feeBearer: breakdown.feeBearer,
      settlementTarget: credential.settlementTarget,
      currency: "LYD",
      customerFieldsMasked: blocked ? {} : { phone: maskedPhone, ip, device_fingerprint: group.fingerprint.slice(0, 16) },
      publicOutputs: { reference, status },
      contextCiphertext: "",
      pointOfNoReturn: path.includes("VERIFYING") || path.includes("AUTHORIZING") || (status === "SUCCEEDED" && reachedGateway),
      otpAttempts,
      lastOtpSentAt: mode === "OTP_PULL" && path.includes("AWAITING_CUSTOMER") ? times[path.indexOf("AWAITING_CUSTOMER")]! : null,
      clientIp: ip,
      userAgent: USER_AGENTS[idx % USER_AGENTS.length],
      expiresAt: inFlight && status !== "CREATED" ? (expiresAt > end ? expiresAt : liveWindow(ctx.rng.int(2, 15))) : expiresAt,
      graceExpiresAt: inFlight && graceExpiresAt <= end ? liveWindow(60 * 20) : graceExpiresAt,
      nextCheckAt: status === "AUTHORIZING" || status === "VERIFYING" ? liveWindow(ctx.rng.int(1, 5)) : status === "UNKNOWN" ? liveWindow(ctx.rng.int(5, 30)) : null,
      ledgerEntryId: null,
      terminalAt,
    };
    // An in-flight attempt must still be inside its TTL (the sweeper expires it otherwise).
    if (["INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING"].includes(status) && (row.expiresAt as Date) <= end) {
      row.expiresAt = liveWindow(ctx.rng.int(2, 15));
    }
    ctx.dataset.paymentAttempts.push(row);
    meta.pendingSecrets.push({
      row,
      field: "contextCiphertext",
      plaintext: JSON.stringify(
        blocked
          ? {}
          : {
              process_id: sha256Like(ctx, `proc:${attemptId}`).slice(0, 16),
              phase: path[path.length - 1],
              ...(reachedGateway ? gatewayStateFor(ctx, gateway.code, attemptId, reference, providerReference, wire.wire) : {}),
            },
      ),
      keyId: "attempt-context",
      mode: "context",
    });
    meta.attempts.set(attemptId, {
      path, times, kind: metaKind, ownershipMode: ownership, feeAccrual: feeAccrualOf(costModel) && ownership === "PLATFORM_CLEARING",
      gatewayId: route.gatewayId, gatewayCode: gateway.code,
      walletGlAccountId: plan.walletGlAccountId, walletId: plan.walletId, railMode: mode, reachedGateway, gatewayTruth,
      failureCode,
      postSettlement: kind === "REFUNDED" || kind === "PARTIALLY_REFUNDED" || kind === "DISPUTED" ? kind : undefined,
    });

    // ---- step logs: one per remote call the path implies
    const calls: Array<{ phase: string; at: Date; outcome: string; http: number | null; response: string; duration: number }> = [];
    const has = (name: string) => path.indexOf(name);
    if (reachedGateway && !blocked) {
      if (has("INITIATING") >= 0) {
        calls.push({ phase: "INITIATE", at: times[has("INITIATING")]!, outcome: "AWAITING_CUSTOMER", http: 200, response: JSON.stringify({ status: "PENDING", provider_reference: providerReference }), duration: ctx.rng.int(180, 1800) });
      }
      if (has("VERIFYING") >= 0 || has("AUTHORIZING") >= 0) {
        const at = times[Math.max(has("AUTHORIZING"), has("VERIFYING"))]!;
        const terminal = path[path.length - 1]!;
        const failed = terminal === "FAILED";
        const unknown = terminal === "UNKNOWN";
        calls.push({
          phase: "SUBMIT", at, outcome: failed ? (failureCode ?? "TERMINAL_DECLINE") : unknown ? "TIMEOUT" : "ACCEPTED",
          http: unknown ? (ctx.rng.chance(60) ? 504 : null) : failed && failureCode === "GATEWAY_FAULT" ? 502 : 200,
          response: unknown ? JSON.stringify({ error: "gateway did not return a definitive status" }) : JSON.stringify({ status: failed ? "FAILED" : "PENDING", code: failed ? failureCode : "00" }),
          duration: unknown ? 15_000 : ctx.rng.int(250, 2600),
        });
        if (settled || failed || kind === "CONFLICT" || kind === "UNKNOWN") {
          calls.push({
            phase: "VERIFY", at: seconds(at, 1.5),
            outcome: kind === "CONFLICT" ? "FAILED" : failed ? "FAILED" : settled ? "SUCCEEDED" : "UNKNOWN",
            http: 200,
            response: JSON.stringify({ status: kind === "CONFLICT" ? "FAILED" : failed ? "FAILED" : settled ? "PAID" : "PENDING", amount: wire.settled }),
            duration: ctx.rng.int(120, 900),
          });
        }
      }
    } else if (blocked) {
      calls.length = 0;
    }
    const hardCeiling = lastTime.getTime();
    calls.forEach((call, order) => {
      const at = new Date(Math.min(call.at.getTime(), hardCeiling > call.at.getTime() ? call.at.getTime() : hardCeiling));
      ctx.dataset.attemptStepLogs.push({
        id: ctx.nextId("step-log"),
        createdAt: at,
        updatedAt: at,
        attemptId,
        gatewayVersionId: versionId,
        phase: call.phase,
        stepId: null,
        stepOrder: order,
        redactedRequestJson: { reference, amount: wire.wire, currency: "LYD", customer: maskedPhone },
        redactedResponseText: call.response,
        httpStatus: call.http,
        durationMs: call.duration,
        outcome: call.outcome,
      });
    });

    // ---- inbound webhook evidence
    const channelId = channelByVersion.get(versionId);
    const pushInbound = (at: Date, verified: boolean, processingResult: string, eventStatus: string, verificationError: string | null = null): void => {
      if (!channelId || at.getTime() > end.getTime()) return;
      const eventId = ctx.nextId("inbound-event");
      const body = {
        event_id: eventId, our_reference: reference, provider_reference: providerReference, status: eventStatus,
        amount: wire.wire, currency: "LYD", environment: env, timestamp: at.toISOString(),
      };
      ctx.dataset.inboundEvents.push({
        id: eventId,
        createdAt: at,
        updatedAt: at,
        channelId,
        gatewayId: route.gatewayId,
        env,
        rawBodyBytes: Buffer.from(JSON.stringify(body)),
        redactedHeadersJson: { "content-type": "application/json", "x-fake-rails-signature": "******" },
        sourceIp: "127.0.0.1",
        verified,
        verificationError,
        dedupeKey: sha256Like(ctx, `inbound:${eventId}`),
        attemptId,
        receivedAt: at,
        processedAt: seconds(at, ctx.rng.next() * 2),
        processingResult,
      });
    };
    if (kind === "CONFLICT") pushInbound(seconds(lastTime, 2), true, "CONFLICTING_TRUSTED_SIGNALS", "PAID");
    else if (kind === "LATE_SUCCESS") pushInbound(lastTime, true, "LATE_SUCCESS", "PAID");
    else if (settled && ctx.rng.chance(55) && status === "SUCCEEDED") pushInbound(seconds(times[times.length - 2]!, 0.5), true, "PAID", "PAID");
    else if (kind === "FAILED" && ctx.rng.chance(6)) pushInbound(seconds(lastTime, 1), false, "REJECTED_UNVERIFIED", "PAID", "SIGNATURE_MISMATCH");

    // ---- link counters
    const counters = linkCounters.get(plan.id) ?? { confirmed: 0, active: 0, last: createdAt, cancelled: false };
    if (settled) counters.confirmed += 1;
    if (inFlight) counters.active += 1;
    if (status === "CANCELLED") counters.cancelled = true;
    if (lastTime > counters.last) counters.last = lastTime;
    linkCounters.set(plan.id, counters);
    previous.ids.push(attemptId);
    return { terminalAt: lastTime, status, settled };
  };

  /** Every payment at or above the SINGLE_AMOUNT HOLD rule is escrowed by the guard. */
  const holdAdjusted = (plan: LinkPlan, kind: Kind, at: Date): Kind => {
    if (D(String(plan.row.amount)).lt(holdThreshold) || kind === "BLOCKED" || kind === "CANCELLED" && false) return kind;
    if (at.getTime() > end.getTime() - 5 * 86_400_000) return "AML_HELD";
    return ctx.rng.chance(82) ? "AML_RELEASED" : "AML_VOIDED";
  };

  // Main links: sequential retries for single-use, free-form for reusable links.
  for (let index = 0; index < mainLinks; index += 1) {
    const plan = plans[index]!;
    const created = plan.windowStart;
    const history = { ids: [] as string[] };
    if (plan.infinite) {
      // Reusable links are paid at business hours like everything else.
      const businessTime = (): number => {
        for (let tries = 0; tries < 25; tries += 1) {
          const day = sampleDay();
          const at = tripoliDateTime(day, businessHour(ctx.rng, day), ctx.rng.int(0, 59), ctx.rng.int(0, 59)).getTime();
          if (at >= created.getTime() && at <= plan.windowEnd.getTime()) return at;
        }
        return between(ctx, created, plan.windowEnd).getTime();
      };
      const times = Array.from({ length: plan.attempts }, businessTime).sort((a, b) => a - b);
      for (const at of times) {
        buildAttempt(plan, holdAdjusted(plan, ctx.rng.weighted(SETTLED_KIND_WEIGHTS) as Kind, new Date(at)), new Date(at), history);
      }
      continue;
    }
    let next = seconds(created, ctx.rng.int(5, 600));
    for (let attempt = 0; attempt < plan.attempts; attempt += 1) {
      const last = attempt === plan.attempts - 1;
      let kind = (last ? ctx.rng.weighted(SETTLED_KIND_WEIGHTS) : ctx.rng.weighted(RETRY_WEIGHTS)) as Kind;
      if (kind === "LATE_SUCCESS" && next.getTime() > end.getTime() - 26 * 3600_000) kind = "EXPIRED";
      if (["REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"].includes(kind) && next.getTime() > end.getTime() - 3 * 86_400_000) kind = "SUCCEEDED";
      if (kind.startsWith("AML_") && next.getTime() > end.getTime() - 5 * 86_400_000 && kind !== "AML_HELD") kind = "AML_HELD";
      if (next.getTime() > Math.min(plan.windowEnd.getTime(), end.getTime() - 4 * 3_600_000)) break;
      kind = holdAdjusted(plan, kind, next);
      const result = buildAttempt(plan, kind, next, history);
      if (!result) break;
      next = seconds(result.terminalAt, ctx.rng.int(30, 20 * 60));
    }
  }
  // Tail links: a single live attempt each.
  for (let index = mainLinks; index < plans.length; index += 1) {
    const plan = plans[index]!;
    const kind = tailKinds[index - mainLinks]!;
    const age = kind === "AML_HELD" ? ctx.rng.int(20, 9 * 24 * 60) : kind === "UNKNOWN" || kind === "CONFLICT" ? ctx.rng.int(20, 5 * 24 * 60) : ctx.rng.int(1, 8);
    const createdAt = new Date(end.getTime() - age * 60_000);
    const linkCreated = plan.windowStart;
    const at = new Date(Math.max(createdAt.getTime(), linkCreated.getTime() + 60_000));
    if (at.getTime() > end.getTime() - 2 * 60_000) {
      continue;
    }
    // The live attempt's link must exist before the attempt.
    const row = plan.row;
    if ((row.createdAt as Date).getTime() > at.getTime() - 60_000) row.createdAt = new Date(at.getTime() - 60_000 - ctx.rng.int(0, 600) * 1000);
    row.updatedAt = row.createdAt;
    plan.windowStart = row.createdAt as Date;
    buildAttempt(plan, kind, at, { ids: [] });
  }

  // The late-success-after-winner SUSPENSE case: an expired first attempt of a
  // single-use link whose retry already settled gets its (verified) late
  // success after the slot is gone.
  const attemptsByLink = new Map<string, Array<Record<string, unknown>>>();
  for (const attempt of ctx.dataset.paymentAttempts) {
    const list = attemptsByLink.get(String(attempt.linkId)) ?? [];
    list.push(attempt);
    attemptsByLink.set(String(attempt.linkId), list);
  }
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  for (const [linkId, list] of attemptsByLink) {
    const plan = planById.get(linkId);
    if (!plan || plan.infinite || list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
    const winner = sorted.find((attempt) => attempt.status === "SUCCEEDED" && meta.attempts.get(String(attempt.id))!.kind === "NORMAL");
    const loser = sorted[0]!;
    if (!winner || winner === loser || loser.status !== "EXPIRED" || Number(plan.row.useCount) !== 1) continue;
    if (!ctx.rng.chance(8)) continue;
    const lateAt = seconds(winner.terminalAt as Date, ctx.rng.int(300, 2 * 3600));
    if (lateAt.getTime() > end.getTime() || lateAt.getTime() > (loser.graceExpiresAt as Date).getTime()) continue;
    const info = meta.attempts.get(String(loser.id))!;
    info.kind = "SUSPENSE";
    info.path = [...info.path, "SUCCEEDED"];
    info.times = [...info.times, lateAt];
    loser.status = "SUCCEEDED";
    loser.substatus = "SUSPENSE_SETTLEMENT";
    loser.updatedAt = lateAt;
    loser.terminalAt = lateAt;
    loser.settledAmount = wireAmount(info.gatewayCode, loser.totalChargedAmount as string).settled;
    loser.pointOfNoReturn = true;
    info.gatewayTruth = "PAID";
    const counters = linkCounters.get(linkId)!;
    // The slot of a SUSPENSE settlement is NOT committed (engine commitSlot).
    if (lateAt > counters.last) counters.last = lateAt;
    // The late webhook that carried the payment.
    const channelId = channelByVersion.get(String(loser.gatewayVersionId));
    if (channelId) {
      const eventId = ctx.nextId("inbound-event");
      ctx.dataset.inboundEvents.push({
        id: eventId, createdAt: lateAt, updatedAt: lateAt, channelId, gatewayId: info.gatewayId, env: loser.env,
        rawBodyBytes: Buffer.from(JSON.stringify({ event_id: eventId, our_reference: loser.reference, provider_reference: loser.providerReference, status: "PAID", amount: loser.gatewayAmountWire, currency: "LYD", timestamp: lateAt.toISOString() })),
        redactedHeadersJson: { "content-type": "application/json", "x-fake-rails-signature": "******" },
        sourceIp: "127.0.0.1", verified: true, verificationError: null, dedupeKey: sha256Like(ctx, `inbound:${eventId}`),
        attemptId: loser.id, receivedAt: lateAt, processedAt: seconds(lateAt, 1), processingResult: "SUSPENSE_SETTLEMENT",
      });
    }
  }

  // ------------------------------------------------------ link finalisation
  for (const plan of plans) {
    const row = plan.row;
    const counters = linkCounters.get(plan.id);
    const attemptsOfLink = attemptsByLink.get(plan.id) ?? [];
    if (!counters) {
      // A link nobody paid: it simply expired (or was cancelled by the merchant).
      row.expiresAt = new Date(Math.min(end.getTime(), (row.createdAt as Date).getTime() + ctx.rng.int(2, 72) * 3_600_000));
      row.state = (row.expiresAt as Date) > end ? "PENDING" : ctx.rng.chance(8) ? "CANCELLED" : "EXPIRED";
      row.updatedAt = row.state === "PENDING" ? row.createdAt : row.expiresAt;
      continue;
    }
    // Suspense settlements do not count as confirmations.
    const suspenseCount = attemptsOfLink.filter((attempt) => meta.attempts.get(String(attempt.id))?.kind === "SUSPENSE").length;
    const confirmed = counters.confirmed;
    void suspenseCount;
    const stillActive = counters.active;
    row.confirmedCount = confirmed;
    row.activeLockedCount = stillActive;
    row.useCount = Math.max(Number(row.useCount), confirmed + stillActive);
    const lastEvent = counters.last;
    row.updatedAt = lastEvent;
    if (plan.infinite) {
      row.expiresAt = ctx.rng.chance(40) ? null : new Date(Math.max(lastEvent.getTime() + 3_600_000, (row.createdAt as Date).getTime() + 90 * 86_400_000));
      row.state = row.expiresAt && (row.expiresAt as Date) <= end ? "EXPIRED" : "PENDING";
    } else {
      const lifetime = (row.createdAt as Date).getTime() + ctx.rng.int(1, 48) * 3_600_000;
      const expiresAt = new Date(Math.max(lifetime, lastEvent.getTime() + 15 * 60_000));
      row.expiresAt = expiresAt;
      if (confirmed >= Number(row.useCount)) {
        row.state = "COMPLETED";
      } else if (stillActive === 0 && confirmed === 0 && counters.cancelled && ctx.rng.chance(50)) {
        row.state = "CANCELLED";
      } else if (expiresAt <= end && stillActive === 0) {
        row.state = "EXPIRED";
      } else {
        row.state = "PENDING";
      }
      if (stillActive > 0 && expiresAt <= end) row.expiresAt = new Date(end.getTime() + 24 * 3_600_000);
    }
    // The link key is created before any attempt (already guaranteed by windowStart).
    ctx.dataset.paymentLinks.push(row);
  }
  for (const plan of plans) {
    if (!linkCounters.get(plan.id)) ctx.dataset.paymentLinks.push(plan.row);
  }
};
