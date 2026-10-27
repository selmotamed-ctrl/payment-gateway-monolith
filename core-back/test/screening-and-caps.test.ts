import { describe, expect, test } from "bun:test";
import type {
  BeneficialOwnerRow,
  JoinRequestRow,
  MerchantRow,
  Tx,
} from "../engine/db/ports";
import { dayWindowInTimeZone, resolveGatewayTimezone } from "../engine/flow/DailyRouteVolume";
import { loadRailCatalog } from "../engine/flow/VisibleRailsCatalog";
import { VisibleRailsResolver } from "../engine/flow/VisibleRailsResolver";
import {
  MerchantScreeningService,
} from "../engine/guards/MerchantScreeningService";
import {
  CachedScreeningProvider,
  InternalWatchlistProvider,
  buildScreeningSubject,
  type ScreeningOptions,
  type ScreeningProvider,
  type ScreeningSubject,
} from "../engine/guards/ScreeningProvider";
import { PeriodicScreeningWorker } from "../engine/workers/PeriodicScreeningWorker";
import {
  createFakeDb,
  createScreeningRepositories,
  createScreeningState,
} from "./helpers/fakeRepositories";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const TX = {} as Tx;

const merchantRow = (overrides: Partial<MerchantRow> = {}): MerchantRow => ({
  id: "merchant-1",
  legalName: "مؤسسة النور للتجارة",
  tradeName: null,
  taxId: null,
  registrationNo: null,
  businessCategory: null,
  status: "PENDING",
  kybStatus: "UNVERIFIED",
  riskTier: "STANDARD",
  onboardingChannel: "SELF_SERVICE",
  country: "LY",
  contactPhone: null,
  contactEmail: null,
  activatedAt: null,
  suspendedAt: null,
  suspensionReasonCode: null,
  negativeBalanceCeiling: 0,
  payoutBankDetailsJson: null,
  ...overrides,
});

const ownerRow = (overrides: Partial<BeneficialOwnerRow> = {}): BeneficialOwnerRow => ({
  id: "owner-1",
  merchantId: "merchant-1",
  fullNameAr: "سالم الصالح",
  fullNameEn: null,
  nationalIdCiphertext: "",
  dateOfBirth: new Date("1980-01-01T00:00:00.000Z"),
  nationality: "LY",
  ownershipPercent: 100,
  role: "OWNER",
  pepDeclared: false,
  screeningStatus: "NOT_SCREENED",
  active: true,
  ...overrides,
});

const joinRequestRow = (overrides: Partial<JoinRequestRow> = {}): JoinRequestRow => ({
  id: "join-1",
  merchantId: "merchant-1",
  submittedByUserId: "user-1",
  status: "DRAFT",
  onboardingChannel: "SELF_SERVICE",
  submittedAt: null,
  assignedReviewerId: null,
  slaDueAt: new Date("2026-03-05T00:00:00.000Z"),
  screeningId: null,
  proposedRiskTier: "STANDARD",
  fourEyesRequired: true,
  fourEyesReasons: [],
  decision: null,
  decisionReasonCode: null,
  decisionNotes: null,
  infoRequestJson: null,
  resubmissionOfId: null,
  approvalRequestId: null,
  ...overrides,
});

/**
 * The watch list of the tests.
 *
 * The confirmed threshold is 95, so the exact name of the entry is a
 * confirmed match while a name that only shares its tokens is a potential
 * match.
 */
const watchlist = (): InternalWatchlistProvider =>
  new InternalWatchlistProvider({
    entries: [
      {
        entryRef: "SAN-1",
        listType: "SANCTIONS",
        listName: "Test sanctions list",
        names: ["محمد علي"],
      },
    ],
    potentialScoreThreshold: 75,
    confirmedScoreThreshold: 95,
    listVersions: { SANCTIONS: "sanctions-v1" },
  });

describe("L1 - the onboarding screening", () => {
  test("a confirmed screening match blocks the submission and raises an AML case", async () => {
    const state = createScreeningState();
    const merchant = merchantRow({ legalName: "محمد علي" });
    state.merchants.push(merchant);
    state.joinRequests.push(joinRequestRow());
    state.owners.push(ownerRow());
    const repositories = createScreeningRepositories(state, NOW);
    const service = new MerchantScreeningService({
      repositories,
      screening: watchlist(),
      clock: () => NOW,
    });

    const outcome = await service.submitOnboarding(TX, {
      merchant,
      joinRequestId: "join-1",
      owners: state.owners,
    });

    expect(outcome.result).toBe("CONFIRMED_MATCH");
    expect(outcome.blocked).toBe(true);
    expect(outcome.screeningId).not.toBeNull();

    // The screening record and its match records are persisted.
    expect(state.screenings.length).toBeGreaterThan(0);
    expect(state.screenings[0]?.trigger).toBe("ONBOARDING");
    expect(state.screenings[0]?.result).toBe("CONFIRMED_MATCH");
    expect(state.matches.length).toBeGreaterThan(0);
    expect(state.matches[0]?.listType).toBe("SANCTIONS");

    // The AML case is raised with the severity of a confirmed sanctions hit.
    expect(state.cases).toHaveLength(1);
    expect(state.cases[0]?.severity).toBe("CRITICAL");
    expect(state.cases[0]?.triggerReason).toBe("SCREENING_CONFIRMED_MATCH:SANCTIONS");
    expect(state.cases[0]?.screeningId).toBe(outcome.screeningId);
    expect(state.cases[0]?.status).toBe("OPEN");

    // The screening is linked to the join request and the activation is
    // blocked.
    expect(state.joinRequests[0]?.screeningId).toBe(outcome.screeningId);
    expect(state.joinRequests[0]?.status).toBe("REJECTED");
    expect(state.joinRequests[0]?.decisionReasonCode).toBe("AML_CONFIRMED_MATCH");
    expect(merchant.status).toBe("REJECTED");
  });

  test("a potential screening match does not block the submission", async () => {
    const state = createScreeningState();
    const merchant = merchantRow({ legalName: "محمد" });
    state.merchants.push(merchant);
    state.joinRequests.push(joinRequestRow());
    state.owners.push(ownerRow());
    const repositories = createScreeningRepositories(state, NOW);
    const service = new MerchantScreeningService({
      repositories,
      screening: watchlist(),
      clock: () => NOW,
    });

    const outcome = await service.submitOnboarding(TX, {
      merchant,
      joinRequestId: "join-1",
      owners: state.owners,
    });

    expect(outcome.result).toBe("POTENTIAL_MATCH");
    expect(outcome.blocked).toBe(false);
    expect(outcome.amlCaseId).toBeNull();
    expect(state.cases).toHaveLength(0);

    // The screening is still recorded and linked to the join request.
    expect(outcome.screeningId).not.toBeNull();
    expect(state.screenings.length).toBeGreaterThan(0);
    expect(state.joinRequests[0]?.screeningId).toBe(outcome.screeningId);
    expect(state.joinRequests[0]?.status).toBe("SUBMITTED");
    expect(merchant.status).toBe("PENDING");
  });

  test("a confirmed match on a beneficial owner blocks the submission as well", async () => {
    const state = createScreeningState();
    const merchant = merchantRow({ legalName: "مؤسسة النور للتجارة" });
    state.merchants.push(merchant);
    state.joinRequests.push(joinRequestRow());
    state.owners.push(ownerRow({ fullNameAr: "محمد علي" }));
    const repositories = createScreeningRepositories(state, NOW);
    const service = new MerchantScreeningService({
      repositories,
      screening: watchlist(),
      clock: () => NOW,
    });

    const outcome = await service.submitOnboarding(TX, {
      merchant,
      joinRequestId: "join-1",
      owners: state.owners,
    });

    expect(outcome.result).toBe("CONFIRMED_MATCH");
    expect(outcome.blocked).toBe(true);
    expect(state.cases).toHaveLength(1);
    // The owner is screened as its own subject.
    const ownerScreening = state.screenings.find(
      (row) => row.subjectType === "BENEFICIAL_OWNER",
    );
    expect(ownerScreening?.result).toBe("CONFIRMED_MATCH");
    expect(state.owners[0]?.screeningStatus).toBe("CONFIRMED_MATCH");
  });
});

describe("L2 - the periodic screening worker", () => {
  const dueMerchant = {
    id: "merchant-1",
    legal_name: "محمد علي",
    trade_name: null,
    tax_id: null,
    registration_no: null,
    status: "ACTIVE",
  };

  test("re-screens a due merchant and raises a case when it became a confirmed match", async () => {
    const state = createScreeningState();
    const merchant = merchantRow({ legalName: "محمد علي", status: "ACTIVE" });
    state.merchants.push(merchant);
    const repositories = createScreeningRepositories(state, NOW);
    const worker = new PeriodicScreeningWorker({
      db: createFakeDb({ dueMerchants: [dueMerchant] }),
      repositories,
      screening: watchlist(),
      clock: () => NOW,
      rescreenIntervalMs: 24 * 60 * 60 * 1000,
      screenBatchSize: 10,
    });

    await worker.runOnce();

    // A new screening record is written for the merchant.
    const screening = state.screenings.find((row) => row.trigger === "PERIODIC");
    expect(screening).toBeDefined();
    expect(screening?.result).toBe("CONFIRMED_MATCH");
    expect(screening?.subjectId).toBe("merchant-1");
    expect(state.matches.length).toBeGreaterThan(0);

    // The case is raised and the merchant is stopped.
    expect(state.cases).toHaveLength(1);
    expect(state.cases[0]?.severity).toBe("CRITICAL");
    expect(state.cases[0]?.triggerReason).toBe("SCREENING_CONFIRMED_MATCH:SANCTIONS");
    expect(state.cases[0]?.subjectId).toBe("merchant-1");
    expect(merchant.status).toBe("SUSPENDED");
    expect(merchant.suspensionReasonCode).toBe("AML_CONFIRMED_MATCH");
    expect(state.auditLogs.some((entry) => entry.action === "AML_CASE_OPENED")).toBe(true);
  });

  test("skips a merchant that was screened after the re-screening interval", async () => {
    const state = createScreeningState();
    const merchant = merchantRow({ legalName: "محمد علي", status: "ACTIVE" });
    state.merchants.push(merchant);
    state.screenings.push({
      id: "screening-previous",
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      trigger: "PERIODIC",
      providerCode: "INTERNAL_WATCHLIST",
      providerRequestRef: null,
      listVersionsJson: {},
      inputHash: "hash",
      result: "CLEAR",
      matchCount: 0,
      highestScore: null,
      requestedAt: new Date(NOW.getTime() - 60 * 1000),
      completedAt: new Date(NOW.getTime() - 60 * 1000),
    });
    const repositories = createScreeningRepositories(state, NOW);
    const worker = new PeriodicScreeningWorker({
      db: createFakeDb({ dueMerchants: [dueMerchant] }),
      repositories,
      screening: watchlist(),
      clock: () => NOW,
      rescreenIntervalMs: 24 * 60 * 60 * 1000,
      screenBatchSize: 10,
    });

    await worker.runOnce();

    expect(state.screenings).toHaveLength(1);
    expect(state.cases).toHaveLength(0);
    expect(merchant.status).toBe("ACTIVE");
  });
});

describe("the daily cap of the visible rails formula", () => {
  const railRow = {
    id: "rail-1",
    code: "edfali",
    nameAr: null,
    nameEn: "Edfali",
    currency: "LYD",
    blocked: false,
    displayOrder: 1,
    collectionMode: "OTP_PULL",
  };
  const routeRow = {
    id: "route-1",
    railId: "rail-1",
    gatewayId: "gw-1",
    credentialPolicy: "PLATFORM",
    priority: 10,
    routingStrategy: "EFFECTIVE_COST",
    weight: 100,
    costModel: {},
    minAmount: "1.0000",
    maxAmount: "1000.0000",
    dailyCapAmount: "5000.0000",
    status: "ACTIVE",
    healthState: "HEALTHY",
    maintenanceWindows: null,
    scope: null,
  };
  const credentialRow = {
    id: "cs-1",
    gatewayId: "gw-1",
    env: "LIVE",
    ownerType: "PLATFORM",
    ownerMerchantId: null,
    settlementTarget: "PLATFORM_CLEARING",
    status: "VERIFIED",
  };
  const profileRow = {
    id: "cp-1",
    merchantId: null,
    applicationId: null,
    railCode: "edfali",
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
  };

  const catalogDb = (processedAmount: string) =>
    createFakeDb({
      dailyVolume: [{ route_id: "route-1", processed_amount: processedAmount }],
      models: {
        rail: [railRow],
        railRoute: [routeRow],
        credentialSet: [credentialRow],
        commissionProfile: [profileRow],
      },
    });

  const resolve = (catalog: Awaited<ReturnType<typeof loadRailCatalog>>, amount: string) =>
    new VisibleRailsResolver().resolve({
      application: {
        id: "app-1",
        merchantId: "merchant-1",
        riskTier: "STANDARD",
        railWhitelist: null,
      },
      link: { amount, currency: "LYD", railWhitelist: null },
      channel: "WEB",
      env: "LIVE",
      rails: catalog.rails,
      routes: catalog.routes,
      credentialSets: catalog.credentialSets,
      commissionProfiles: catalog.commissionProfiles,
      now: NOW,
    });

  test("the processed volume of the business day is derived from the attempts", async () => {
    const catalog = await loadRailCatalog(catalogDb("4500.0000"), { now: NOW });
    expect(catalog.routes[0]?.dailyProcessedAmount).toBe("4500.0000");
  });

  test("excludes a route once the processed volume plus the link amount exceeds the cap", async () => {
    const catalog = await loadRailCatalog(catalogDb("4500.0000"), { now: NOW });
    const result = resolve(catalog, "600.0000");
    expect(result.rails).toHaveLength(0);
    const exclusion = result.excluded.find((entry) => entry.routeId === "route-1");
    expect(exclusion?.reason).toBe("DAILY_CAP_EXCEEDED");
    expect(exclusion?.detail?.dailyProcessedAmount).toBe("4500.0000");
    expect(exclusion?.detail?.dailyCapAmount).toBe("5000.0000");
  });

  test("includes a route while the processed volume plus the link amount stays under the cap", async () => {
    const catalog = await loadRailCatalog(catalogDb("4500.0000"), { now: NOW });
    const result = resolve(catalog, "400.0000");
    expect(result.rails.map((entry) => entry.rail.code)).toEqual(["edfali"]);
    expect(result.rails[0]?.routes[0]?.route.id).toBe("route-1");
  });

  test("the business day is the day of the gateway timezone", async () => {
    const window = dayWindowInTimeZone(NOW, "Africa/Tripoli");
    expect(window.since.toISOString()).toBe("2026-02-28T22:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-03-01T22:00:00.000Z");
  });

  test("the gateway timezone is read from the gateway settings", async () => {
    const db = createFakeDb({
      models: { gatewaySetting: [{ gatewayTimezone: "Africa/Tripoli" }] },
    });
    expect(await resolveGatewayTimezone(db as never)).toBe("Africa/Tripoli");
  });
});

describe("the cached watch list", () => {
  const countingProvider = (inner: ScreeningProvider): ScreeningProvider & { calls: number } => {
    const wrapper = {
      code: inner.code,
      calls: 0,
      capabilities: () => inner.capabilities(),
      listVersions: () => inner.listVersions(),
      subscribeListUpdates: async (callbackUrl: string) => {
        await inner.subscribeListUpdates?.(callbackUrl);
      },
      screenLocal: (subject: ScreeningSubject) => inner.screenLocal!(subject),
      screenSubject: async (subject: ScreeningSubject, options?: ScreeningOptions) => {
        wrapper.calls += 1;
        return inner.screenSubject(subject, options);
      },
      getResult: (providerRequestRef: string) => inner.getResult(providerRequestRef),
    };
    return wrapper;
  };

  test("subscribeListUpdates invalidates the cached watch list when a list version changes", async () => {
    const delegate = watchlist();
    const counting = countingProvider(delegate);
    const cached = new CachedScreeningProvider(counting);
    const subject = buildScreeningSubject({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      names: ["محمد علي"],
    });

    const first = await cached.screenSubject(subject);
    expect(first.result).toBe("CONFIRMED_MATCH");
    expect(counting.calls).toBe(1);

    // The second screening is served from the cache.
    await cached.screenSubject(subject);
    expect(counting.calls).toBe(1);

    // The watch list is published in a new version.
    delegate.setListVersions({ SANCTIONS: "sanctions-v2" });
    await cached.subscribeListUpdates("https://core-back.internal/screening/list-updates");

    // The cached result was dropped, so the merchant is screened again.
    const third = await cached.screenSubject(subject);
    expect(counting.calls).toBe(2);
    expect(third.listVersions.SANCTIONS).toBe("sanctions-v2");
  });

  test("the cache is kept while the list version does not change", async () => {
    const delegate = watchlist();
    const counting = countingProvider(delegate);
    const cached = new CachedScreeningProvider(counting);
    const subject = buildScreeningSubject({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      names: ["محمد علي"],
    });

    await cached.screenSubject(subject);
    await cached.subscribeListUpdates("https://core-back.internal/screening/list-updates");
    await cached.screenSubject(subject);

    expect(counting.calls).toBe(1);
  });
});
