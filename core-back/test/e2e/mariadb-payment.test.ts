/**
 * End-to-end proof that a complete, declarative payment works against the
 * live MariaDB instance.
 *
 * The suite builds a throw-away catalog (merchant, application, wallet, GL
 * accounts, gateway, rail, route, credential set, commission profile, payment
 * link, flows and status rules), points a local HTTP mock at the declarative
 * flow and drives the *production* runtime (`createPlatformRuntime`) through
 * `initiate` -> `confirm`. It then proves that
 *
 *   - the declarative flow really executed (the mock gateway was called),
 *   - the attempt reached `SUCCEEDED` and carries its journal entry,
 *   - the double-entry journal entry balances and hits the accounts that the
 *     design prescribes (TREASURY / PROVIDER_FEE_EXPENSE debited,
 *     MERCHANT_WALLET / PLATFORM_INCOME credited),
 *   - the link slot accounting is correct (`confirmed_count = 1`,
 *     `active_locked_count = 0`) and the MySQL `CHECK` invariant holds,
 *   - the system-wide ledger invariant reports a drift of `0.0000`,
 *   - the slot reservation is atomic: a second attempt on the exhausted link
 *     fails with a slot error and never books a second journal entry,
 *   - the MariaDB `BEFORE INSERT` trigger refuses an approval request whose
 *     checker is the maker.
 *
 * The suite never fails because MariaDB is down: the connection is probed
 * before the tests are registered and every test is skipped when the server
 * cannot be reached.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { createPlatformRuntime } from "../../engine/runtime/platform";
import { InvariantVerifier } from "../../engine/ledger/InvariantVerifier";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { seedSystemGlAccounts } from "../../prisma/seedGlAccounts";
import type { DynamicAttempt } from "../../engine/flow/DynamicRailEngine";

/**
 * The test runs against its own database. The override has to happen before
 * the Prisma client is instantiated; the client of `prisma/client` is created
 * lazily on the first property access, so a module level assignment is enough.
 */
const DATABASE_URL =
  process.env.MARIADB_TEST_DATABASE_URL
  ?? "mysql://admin:admin@127.0.0.1:3306/payment_gateway_monolith_test";
process.env.DATABASE_URL = DATABASE_URL;

/** Every run uses its own ids so the suite can be repeated on the same server. */
const RUN = randomUUID().replace(/-/g, "").slice(0, 12);

/**
 * The gateway environment points at a public address. The outbound path of
 * the platform refuses plain HTTP and refuses private / loopback addresses
 * (SSRF safeguard 10), so the mock gateway is reached through a public
 * address that the test harness redirects to the local mock server.
 */
const GATEWAY_HOST = "93.184.216.34";

const AMOUNT = "100.0000";
const COMMISSION = "3.0000";
const PROVIDER_FEE = "1.0000";
const MERCHANT_AMOUNT = "97.0000";
const CURRENCY = "LYD";
const ENVIRONMENT = "SANDBOX";

interface Catalog {
  userId: string;
  merchantId: string;
  applicationId: string;
  walletId: string;
  glAccountIds: Record<string, string>;
  gatewayId: string;
  gatewayVersionId: string;
  credentialSetId: string;
  railId: string;
  routeId: string;
  commissionProfileId: string;
  linkId: string;
  linkKey: string;
  attemptGroupId: string;
  attemptId: string;
  secondAttemptId: string;
  reference: string;
  secondReference: string;
}

let reachable = false;
let unreachableReason = "";

const probeDatabase = async (): Promise<boolean> => {
  try {
    await client.$queryRawUnsafe("SELECT 1 AS ok");
    return true;
  } catch (error) {
    unreachableReason = error instanceof Error ? error.message : String(error);
    return false;
  }
};

/**
 * `test.skipIf()` captures its condition when the test is registered, so the
 * probe has to run before the tests are declared.
 */
reachable = await probeDatabase();

let catalog: Catalog | undefined;
let runtime: ReturnType<typeof createPlatformRuntime> | undefined;
let mockServer: ReturnType<typeof Bun.serve> | undefined;
let originalFetch: typeof fetch | undefined;
const gatewayCalls: Array<{ path: string; body: Record<string, unknown> }> = [];

const buildCatalog = async (): Promise<Catalog> => {
  const suffix = RUN;
  const fingerprint = createHash("sha256").update(`e2e:${suffix}`).digest("hex");

  const user = await client.user.create({
    data: {
      email: `e2e-maker-${suffix}@gateway.test`,
      role: "GATEWAY_ADMIN",
      status: "ACTIVE",
      authoritiesMap: { payments: ["read", "write"], ledger: ["read"] },
      appScopeIds: [],
      isMaker: true,
      isChecker: true,
      mfaRequired: false,
    },
  });

  const merchant = await client.merchant.create({
    data: {
      legalName: `E2E Merchant ${suffix}`,
      tradeName: `E2E ${suffix}`,
      onboardingChannel: "E2E",
      country: "LY",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "LOW",
      activatedAt: new Date(),
      contactEmail: `e2e-merchant-${suffix}@gateway.test`,
      contactPhone: "+218910000000",
      negativeBalanceCeiling: new Prisma.Decimal(0),
    },
  });

  const gateway = await client.gateway.create({
    data: {
      code: `e2e-gateway-${suffix}`,
      name: `E2E Gateway ${suffix}`,
      operator: "E2E Operator",
      country: "LY",
      aliases: [],
      kind: "DIRECT",
      status: "LIVE",
      verificationState: "VERIFIED",
      riskClass: "NORMAL",
    },
  });

  const gatewayVersion = await client.gatewayVersion.create({
    data: {
      gatewayId: gateway.id,
      versionNumber: 1,
      snapshotCiphertext: JSON.stringify({ environment: ENVIRONMENT }),
      contentHash: createHash("sha256").update(`e2e-version:${suffix}`).digest("hex"),
      state: "LIVE",
      createdById: user.id,
      changeNote: "e2e",
    },
  });

  await client.gateway.update({
    where: { id: gateway.id },
    data: { activeVersionId: gatewayVersion.id },
  });

  const credentialSet = await client.credentialSet.create({
    data: {
      gatewayId: gateway.id,
      env: ENVIRONMENT,
      ownerType: "PLATFORM",
      externalMerchantId: `e2e-${suffix}`,
      settlementTarget: "PLATFORM_CLEARING",
      entriesCiphertext: [],
      status: "VERIFIED",
      lastVerifiedAt: new Date(),
    },
  });

  /**
   * The ledger resolves a GL account by (account type, owner, gateway,
   * credential set, environment, currency). The platform accounts of the
   * posting are therefore merchant scoped, credential set scoped and
   * environment scoped, exactly as the posting context demands.
   */
  const createAccount = async (accountType: string): Promise<string> => {
    const account = await client.glAccount.create({
      data: {
        accountType: accountType as Prisma.GlAccountCreateInput["accountType"],
        ownerId: merchant.id,
        credentialSetId: credentialSet.id,
        env: ENVIRONMENT,
        currency: CURRENCY,
        checkpointBalance: new Prisma.Decimal(0),
      },
    });
    return account.id;
  };

  const glAccountIds: Record<string, string> = {
    TREASURY: await createAccount("TREASURY"),
    PROVIDER_FEE_EXPENSE: await createAccount("PROVIDER_FEE_EXPENSE"),
    PLATFORM_INCOME: await createAccount("PLATFORM_INCOME"),
    MERCHANT_WALLET: await createAccount("MERCHANT_WALLET"),
  };

  const wallet = await client.wallet.create({
    data: {
      merchantId: merchant.id,
      glAccountId: glAccountIds.MERCHANT_WALLET ?? "",
      currency: CURRENCY,
      status: "ACTIVE",
    },
  });

  const application = await client.application.create({
    data: {
      merchantId: merchant.id,
      name: `E2E Application ${suffix}`,
      expectedMonthlyVolume: new Prisma.Decimal(0),
      assignedWalletId: wallet.id,
      status: "ACTIVE",
    },
  });

  const rail = await client.rail.create({
    data: {
      code: `e2e-rail-${suffix}`,
      nameAr: `سكة اختبار ${suffix}`,
      nameEn: `E2E Rail ${suffix}`,
      collectionMode: "OTP_PULL",
      subModes: [],
      currency: CURRENCY,
      minAmount: new Prisma.Decimal(0),
      maxAmount: new Prisma.Decimal(100000),
      capabilities: { refund: true, partial_refund: true, void: true, capture: true },
      metadata: { e2e: true },
    },
  });

  const route = await client.railRoute.create({
    data: {
      railId: rail.id,
      gatewayId: gateway.id,
      credentialPolicy: "PLATFORM",
      priority: 0,
      routingStrategy: "EFFECTIVE_COST",
      weight: 100,
      costModel: { flat: PROVIDER_FEE, percent: "0" },
      mismatchPolicy: { tolerance_amount: "0.0100" },
      minAmount: new Prisma.Decimal(0),
      maxAmount: new Prisma.Decimal(100000),
      status: "ACTIVE",
      healthState: "HEALTHY",
      scope: { merchant_ids: [merchant.id], application_ids: [application.id], risk_tiers: ["LOW"], channels: ["WEB"] },
    },
  });

  const commissionProfile = await client.commissionProfile.create({
    data: {
      merchantId: merchant.id,
      applicationId: application.id,
      railCode: rail.code,
      calcType: "PERCENTAGE",
      flatFee: new Prisma.Decimal(0),
      percentageRate: new Prisma.Decimal("0.030000"),
      minFee: new Prisma.Decimal(0),
      feeBearerDefault: "MERCHANT_ABSORBS",
      roundingMode: "HALF_UP",
      effectiveFrom: new Date(Date.now() - 60_000),
    },
  });

  const link = await client.paymentLink.create({
    data: {
      key: `e2e-link-${suffix}`,
      applicationId: application.id,
      walletId: wallet.id,
      amount: new Prisma.Decimal(AMOUNT),
      currency: CURRENCY,
      feeBearer: "MERCHANT_ABSORBS",
      useCount: 1,
      state: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });

  const attemptGroup = await client.attemptGroup.create({
    data: {
      linkId: link.id,
      customerFingerprint: fingerprint,
    },
  });

  const reference = `PA-E2E-${suffix}`;
  const attempt = await client.paymentAttempt.create({
    data: {
      reference,
      linkId: link.id,
      attemptGroupId: attemptGroup.id,
      applicationId: application.id,
      merchantId: merchant.id,
      railId: rail.id,
      routeId: route.id,
      credentialSetId: credentialSet.id,
      gatewayVersionId: gatewayVersion.id,
      commissionProfileId: commissionProfile.id,
      env: ENVIRONMENT,
      mode: "OTP_PULL",
      status: "CREATED",
      requestedAmount: new Prisma.Decimal(AMOUNT),
      surchargeAmount: new Prisma.Decimal(0),
      totalChargedAmount: new Prisma.Decimal(AMOUNT),
      gatewayFeeAmount: new Prisma.Decimal(PROVIDER_FEE),
      platformCommissionAmount: new Prisma.Decimal(COMMISSION),
      netMerchantAmount: new Prisma.Decimal(MERCHANT_AMOUNT),
      feeBearer: "MERCHANT_ABSORBS",
      settlementTarget: "PLATFORM_CLEARING",
      currency: CURRENCY,
      customerFieldsMasked: {
        fingerprint,
        fields: { phone: "+21891000000" },
      },
      contextCiphertext: "",
      expiresAt: new Date(Date.now() + 1_800_000),
      graceExpiresAt: new Date(Date.now() + 86_400_000),
      clientIp: "127.0.0.1",
      userAgent: "core-back-e2e",
    },
  });

  const secondAttempt = await client.paymentAttempt.create({
    data: {
      reference: `PA-E2E2-${suffix}`,
      linkId: link.id,
      attemptGroupId: attemptGroup.id,
      applicationId: application.id,
      merchantId: merchant.id,
      railId: rail.id,
      routeId: route.id,
      credentialSetId: credentialSet.id,
      gatewayVersionId: gatewayVersion.id,
      commissionProfileId: commissionProfile.id,
      env: ENVIRONMENT,
      mode: "OTP_PULL",
      status: "CREATED",
      requestedAmount: new Prisma.Decimal(AMOUNT),
      surchargeAmount: new Prisma.Decimal(0),
      totalChargedAmount: new Prisma.Decimal(AMOUNT),
      gatewayFeeAmount: new Prisma.Decimal(PROVIDER_FEE),
      platformCommissionAmount: new Prisma.Decimal(COMMISSION),
      netMerchantAmount: new Prisma.Decimal(MERCHANT_AMOUNT),
      feeBearer: "MERCHANT_ABSORBS",
      settlementTarget: "PLATFORM_CLEARING",
      currency: CURRENCY,
      customerFieldsMasked: { fingerprint, fields: { phone: "+21891000000" } },
      contextCiphertext: "",
      expiresAt: new Date(Date.now() + 1_800_000),
      graceExpiresAt: new Date(Date.now() + 86_400_000),
      clientIp: "127.0.0.1",
      userAgent: "core-back-e2e",
    },
  });

  return {
    userId: user.id,
    merchantId: merchant.id,
    applicationId: application.id,
    walletId: wallet.id,
    glAccountIds,
    gatewayId: gateway.id,
    gatewayVersionId: gatewayVersion.id,
    credentialSetId: credentialSet.id,
    railId: rail.id,
    routeId: route.id,
    commissionProfileId: commissionProfile.id,
    linkId: link.id,
    linkKey: link.key,
    attemptGroupId: attemptGroup.id,
    attemptId: attempt.id,
    secondAttemptId: secondAttempt.id,
    reference,
    secondReference: secondAttempt.reference,
  };
};

/**
 * The declarative flow of the gateway version.
 *
 *  - `INITIATE` opens the collection session (a notification, never money) and
 *    captures the provider reference of the session.
 *  - `SUBMIT` moves the money. It is the point of no return: it never retries
 *    and the outcome is only trusted when the gateway confirms the status,
 *    the reference, the amount, the currency and the environment.
 */
const buildFlows = async (catalog: Catalog, baseUrl: string): Promise<void> => {
  const initiateFlow = await client.flow.create({
    data: {
      gatewayVersionId: catalog.gatewayVersionId,
      railId: catalog.railId,
      phase: "INITIATE",
    },
  });

  const initiateStep = await client.flowStep.create({
    data: {
      flowId: initiateFlow.id,
      orderIndex: 0,
      type: "HTTP",
      method: "POST",
      urlTemplate: "{api}/initiate",
      contentType: "APPLICATION_JSON",
      timeoutMs: 5_000,
      sideEffect: "SENDS_NOTIFICATION",
      retryPolicy: "SAFE",
      idempotencyConfig: { mode: "NONE" },
      pointOfNoReturn: false,
    },
  });

  await client.stepParameter.createMany({
    data: [
      {
        stepId: initiateStep.id,
        place: "BODY",
        key: "amount",
        source: "ATTEMPT",
        selector: "totalChargedAmount",
        transforms: [],
      },
      {
        stepId: initiateStep.id,
        place: "BODY",
        key: "reference",
        source: "ATTEMPT",
        selector: "reference",
        transforms: [],
      },
      {
        stepId: initiateStep.id,
        place: "BODY",
        key: "currency",
        source: "ATTEMPT",
        selector: "currency",
        transforms: [],
      },
      {
        stepId: initiateStep.id,
        place: "BODY",
        key: "customer_phone",
        source: "CUSTOMER_FIELD",
        selector: "phone",
        transforms: [],
      },
    ],
  });

  await client.stepOutput.create({
    data: {
      stepId: initiateStep.id,
      name: "provider_reference",
      selector: "provider_reference",
      transforms: [],
      storeAs: "PROVIDER_REF",
      required: false,
    },
  });

  const submitFlow = await client.flow.create({
    data: {
      gatewayVersionId: catalog.gatewayVersionId,
      railId: catalog.railId,
      phase: "SUBMIT",
    },
  });

  const submitStep = await client.flowStep.create({
    data: {
      flowId: submitFlow.id,
      orderIndex: 0,
      type: "HTTP",
      method: "POST",
      urlTemplate: "{api}/submit",
      contentType: "APPLICATION_JSON",
      timeoutMs: 5_000,
      sideEffect: "MOVES_MONEY",
      retryPolicy: "NEVER",
      idempotencyConfig: { mode: "NONE" },
      pointOfNoReturn: true,
    },
  });

  await client.stepParameter.createMany({
    data: [
      {
        stepId: submitStep.id,
        place: "BODY",
        key: "amount",
        source: "ATTEMPT",
        selector: "totalChargedAmount",
        transforms: [],
      },
      {
        stepId: submitStep.id,
        place: "BODY",
        key: "reference",
        source: "ATTEMPT",
        selector: "reference",
        transforms: [],
      },
      {
        stepId: submitStep.id,
        place: "BODY",
        key: "currency",
        source: "ATTEMPT",
        selector: "currency",
        transforms: [],
      },
      {
        stepId: submitStep.id,
        place: "BODY",
        key: "session_reference",
        source: "ATTEMPT",
        selector: "providerReference",
        transforms: [],
      },
      {
        stepId: submitStep.id,
        place: "BODY",
        key: "otp",
        source: "CUSTOMER_FIELD",
        selector: "otp",
        transforms: [],
      },
    ],
  });

  await client.stepOutput.create({
    data: {
      stepId: submitStep.id,
      name: "provider_reference",
      selector: "provider_reference",
      transforms: [],
      storeAs: "PROVIDER_REF",
      required: false,
    },
  });

  await client.statusRule.createMany({
    data: [
      {
        gatewayVersionId: catalog.gatewayVersionId,
        phase: "INITIATE",
        orderIndex: 0,
        selector: "status",
        op: "EQUALS",
        valueJson: "PENDING",
        canonicalStatus: "AWAITING_CUSTOMER",
      },
      {
        gatewayVersionId: catalog.gatewayVersionId,
        phase: "INITIATE",
        orderIndex: 1,
        selector: "status",
        op: "EQUALS",
        valueJson: "FAILED",
        canonicalStatus: "FAILED",
        canonicalError: "GATEWAY_REJECTED",
      },
      {
        gatewayVersionId: catalog.gatewayVersionId,
        phase: "SUBMIT",
        orderIndex: 0,
        selector: "status",
        op: "EQUALS",
        valueJson: "SUCCESS",
        canonicalStatus: "SUCCEEDED",
      },
      {
        gatewayVersionId: catalog.gatewayVersionId,
        phase: "SUBMIT",
        orderIndex: 1,
        selector: "status",
        op: "EQUALS",
        valueJson: "FAILED",
        canonicalStatus: "FAILED",
        canonicalError: "GATEWAY_REJECTED",
      },
    ],
  });

  // The base URL of the environment is what the `{api}` placeholder resolves to.
  await client.gatewayEnvironment.create({
    data: {
      gatewayVersionId: catalog.gatewayVersionId,
      env: ENVIRONMENT,
      baseUrls: { api: baseUrl },
      allowedHosts: [GATEWAY_HOST],
      inboundIpAllowlist: [],
      outboundEgressIps: [],
      enabled: true,
    },
  });

  await client.gatewayAuth.create({
    data: {
      gatewayVersionId: catalog.gatewayVersionId,
      env: ENVIRONMENT,
      method: "NONE",
      authApply: "HEADER",
    },
  });

  await client.gatewaySetting.create({
    data: {
      gatewayVersionId: catalog.gatewayVersionId,
      amountScale: 1,
      amountPrecision: 4,
      amountRounding: "HALF_UP",
      amountFormat: "STRING_DECIMAL",
      referenceFormat: { charset: "ALNUM", maxLength: 64, prefix: "E2E" },
      sessionTtlSeconds: 1_800,
      otpTtlSeconds: 300,
      otpResendCooldownSeconds: 30,
      maxOtpAttempts: 3,
      supportsStatusCheck: false,
      supportsIdempotencyKey: false,
      supportsCancel: false,
      timeoutMs: 5_000,
      maxResponseBytes: 2_097_152,
      gatewayTimezone: "Africa/Tripoli",
    },
  });
};

/**
 * The mock gateway. It answers the two steps of the declarative flow with the
 * canonical body the status rules of the flow expect.
 */
const startMockGateway = (): { baseUrl: string; port: number } => {
  mockServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
      gatewayCalls.push({ path: url.pathname, body });
      const reference = String(body.reference ?? "");
      const amount = String(body.amount ?? AMOUNT);
      const currency = String(body.currency ?? CURRENCY);
      if (url.pathname === "/initiate") {
        return Response.json({
          status: "PENDING",
          reference,
          provider_reference: `PROV-${RUN}-SESSION`,
          amount,
          currency,
          environment: ENVIRONMENT,
        });
      }
      if (url.pathname === "/submit") {
        return Response.json({
          status: "SUCCESS",
          reference,
          provider_reference: `PROV-${RUN}-PAYMENT`,
          amount,
          currency,
          environment: ENVIRONMENT,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const port = mockServer.port;
  if (port === undefined) {
    throw new Error("The gateway mock server did not bind to a port");
  }
  return {
    baseUrl: `https://${GATEWAY_HOST}:${port}`,
    port,
  };
};

/**
 * The platform only talks to HTTPS gateways on public addresses. The mock
 * gateway listens on the loopback interface, so the harness redirects the
 * socket to it. Everything above the socket (URL compilation, the SSRF
 * guard, the host pinning, the authentication and the response parsing) stays
 * the production code path.
 */
const installFetchRedirect = (port: number): void => {
  originalFetch = globalThis.fetch;
  const passthrough = originalFetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const parsed = new URL(raw);
    if (parsed.hostname === GATEWAY_HOST) {
      const target = new URL(`${parsed.pathname}${parsed.search}`, `http://127.0.0.1:${port}`);
      return passthrough(target.toString(), init);
    }
    return passthrough(input, init);
  }) as typeof fetch;
};

const removeFetchRedirect = (): void => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
};

const cleanup = async (): Promise<void> => {
  if (!catalog) {
    return;
  }
  const steps = await client.flowStep.findMany({
    where: { flow: { gatewayVersionId: catalog.gatewayVersionId } },
    select: { id: true },
  });
  const stepIds = steps.map((step) => step.id);
  await client.stepOutput.deleteMany({ where: { stepId: { in: stepIds } } });
  await client.stepParameter.deleteMany({ where: { stepId: { in: stepIds } } });
  await client.flowStep.deleteMany({ where: { id: { in: stepIds } } });
  await client.flow.deleteMany({ where: { gatewayVersionId: catalog.gatewayVersionId } });
  await client.statusRule.deleteMany({ where: { gatewayVersionId: catalog.gatewayVersionId } });
  await client.gatewaySetting.deleteMany({ where: { gatewayVersionId: catalog.gatewayVersionId } });
  await client.gatewayAuth.deleteMany({ where: { gatewayVersionId: catalog.gatewayVersionId } });
  await client.gatewayEnvironment.deleteMany({ where: { gatewayVersionId: catalog.gatewayVersionId } });
  // The attempts and their journal entries reference the gateway version, so
  // they have to go first.
  await client.paymentAttempt.deleteMany({ where: { id: { in: [catalog.attemptId, catalog.secondAttemptId] } } });
  await client.journalLine.deleteMany({
    where: { entry: { refType: "PAYMENT_ATTEMPT", refId: { in: [catalog.attemptId, catalog.secondAttemptId] } } },
  });
  await client.journalEntry.deleteMany({
    where: { refType: "PAYMENT_ATTEMPT", refId: { in: [catalog.attemptId, catalog.secondAttemptId] } },
  });
  await client.gateway.update({ where: { id: catalog.gatewayId }, data: { activeVersionId: null } });
  await client.gatewayVersion.deleteMany({ where: { id: catalog.gatewayVersionId } });
  await client.attemptGroup.deleteMany({ where: { id: catalog.attemptGroupId } });
  await client.paymentLink.deleteMany({ where: { id: catalog.linkId } });
  await client.commissionProfile.deleteMany({ where: { id: catalog.commissionProfileId } });
  // The application references its assigned wallet, so it goes first.
  await client.application.deleteMany({ where: { id: catalog.applicationId } });
  await client.wallet.deleteMany({ where: { id: catalog.walletId } });
  await client.glAccount.deleteMany({ where: { id: { in: Object.values(catalog.glAccountIds) } } });
  await client.railRoute.deleteMany({ where: { id: catalog.routeId } });
  await client.rail.deleteMany({ where: { id: catalog.railId } });
  await client.credentialSet.deleteMany({ where: { id: catalog.credentialSetId } });
  await client.gateway.deleteMany({ where: { id: catalog.gatewayId } });
  await client.merchant.deleteMany({ where: { id: catalog.merchantId } });
  await client.user.deleteMany({ where: { id: catalog.userId } });
};

describe("mariadb payment (live MariaDB)", () => {
  beforeAll(async () => {
    if (!reachable) {
      console.log(
        `[mariadb-payment] MariaDB is not reachable at ${DATABASE_URL} (${unreachableReason}) - the suite is skipped.`,
      );
      return;
    }
    // The system GL accounts of the platform (idempotent seed).
    await seedSystemGlAccounts(client);
    const mock = startMockGateway();
    installFetchRedirect(mock.port);
    catalog = await buildCatalog();
    await buildFlows(catalog, mock.baseUrl);
    runtime = createPlatformRuntime(client as never);
  });

  afterAll(async () => {
    removeFetchRedirect();
    mockServer?.stop(true);
    if (reachable) {
      await cleanup();
    }
    await client.$disconnect();
  });

  test.skipIf(!reachable)("executes the declarative INITIATE phase and locks the link slot", async () => {
    const current = catalog;
    expect(current).toBeDefined();
    const attemptRow = await client.paymentAttempt.findUnique({ where: { id: current?.attemptId } });
    const result = await runtime?.engine.initiate(attemptRow as unknown as DynamicAttempt, {
      phone: "+21891000000",
    });

    expect(result?.status).toBe("AWAITING_CUSTOMER");
    expect(gatewayCalls.map((call) => call.path)).toEqual(["/initiate"]);

    const link = await client.paymentLink.findUnique({ where: { id: current?.linkId } });
    expect(link?.activeLockedCount).toBe(1);
    expect(link?.confirmedCount).toBe(0);

    const attempt = await client.paymentAttempt.findUnique({ where: { id: current?.attemptId } });
    expect(attempt?.status).toBe("AWAITING_CUSTOMER");
    expect(attempt?.providerReference).toBe(`PROV-${RUN}-SESSION`);
  });

  test.skipIf(!reachable)("executes the declarative SUBMIT phase and reaches SUCCEEDED", async () => {
    const current = catalog;
    const attemptRow = await client.paymentAttempt.findUnique({ where: { id: current?.attemptId } });
    const result = await runtime?.engine.confirm(attemptRow as unknown as DynamicAttempt, {
      otp: "123456",
    });

    expect(result?.status).toBe("SUCCEEDED");
    expect(gatewayCalls.map((call) => call.path)).toEqual(["/initiate", "/submit"]);

    const attempt = await client.paymentAttempt.findUnique({ where: { id: current?.attemptId } });
    expect(attempt?.status).toBe("SUCCEEDED");
    expect(attempt?.ledgerEntryId).toBeTruthy();
    expect(attempt?.terminalAt).toBeTruthy();
  });

  test.skipIf(!reachable)("books a balanced journal entry on the accounts of the design", async () => {
    const current = catalog;
    const entry = await client.journalEntry.findFirst({
      where: { refType: "PAYMENT_ATTEMPT", refId: current?.attemptId },
    });
    expect(entry).toBeTruthy();

    const lines = await client.journalLine.findMany({
      where: { entryId: entry?.id },
      include: { glAccount: true },
    });
    expect(lines.length).toBeGreaterThanOrEqual(4);

    const debits = lines
      .filter((line) => line.direction === "DEBIT")
      .reduce((total, line) => total.plus(decimal(line.amount)), decimal(0));
    const credits = lines
      .filter((line) => line.direction === "CREDIT")
      .reduce((total, line) => total.plus(decimal(line.amount)), decimal(0));
    expect(debits.toFixed(4)).toBe(credits.toFixed(4));
    expect(debits.gt(0)).toBe(true);

    const legs = lines.map((line) => ({
      type: line.glAccount.accountType,
      direction: line.direction,
      amount: decimal(line.amount).toFixed(4),
    }));
    const leg = (type: string, direction: "DEBIT" | "CREDIT"): string | undefined =>
      legs.find((entry) => entry.type === type && entry.direction === direction)?.amount;

    expect(leg("TREASURY", "DEBIT")).toBe(decimal(AMOUNT).minus(PROVIDER_FEE).toFixed(4));
    expect(leg("PROVIDER_FEE_EXPENSE", "DEBIT")).toBe(PROVIDER_FEE);
    expect(leg("MERCHANT_WALLET", "CREDIT")).toBe(MERCHANT_AMOUNT);
    expect(leg("PLATFORM_INCOME", "CREDIT")).toBe(COMMISSION);
  });

  test.skipIf(!reachable)("commits the link slot and keeps the payment_links CHECK invariant", async () => {
    const current = catalog;
    const link = await client.paymentLink.findUnique({ where: { id: current?.linkId } });
    expect(link?.confirmedCount).toBe(1);
    expect(link?.activeLockedCount).toBe(0);
    expect(link?.state).toBe("COMPLETED");

    const rows = await client.$queryRawUnsafe(
      "SELECT confirmed_count + active_locked_count AS used, use_count AS total FROM payment_links WHERE id = ?",
      current?.linkId,
    );
    const used = Number((rows as Array<{ used: number | bigint }>)[0]?.used ?? 0);
    const total = Number((rows as Array<{ used: number | bigint; total: number | bigint }>)[0]?.total ?? 0);
    expect(used).toBeLessThanOrEqual(total);
  });

  test.skipIf(!reachable)("reports a zero system-wide ledger drift", async () => {
    const result = await new InvariantVerifier(client as never).verify();
    expect(result.ok).toBe(true);
    expect(result.drift.toFixed(4)).toBe("0.0000");
  });

  test.skipIf(!reachable)("refuses a second attempt on the exhausted link", async () => {
    const current = catalog;
    const attemptRow = await client.paymentAttempt.findUnique({ where: { id: current?.secondAttemptId } });
    let failure: unknown;
    try {
      await runtime?.engine.initiate(attemptRow as unknown as DynamicAttempt, { phone: "+21891000000" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const code = (failure as { code?: string }).code;
    expect(code).toBe("SLOT_RESERVATION_FAILED");

    const entries = await client.journalEntry.count({
      where: { refType: "PAYMENT_ATTEMPT", refId: { in: [current?.attemptId ?? "", current?.secondAttemptId ?? ""] } },
    });
    expect(entries).toBe(1);

    const link = await client.paymentLink.findUnique({ where: { id: current?.linkId } });
    expect(link?.activeLockedCount).toBe(0);
    expect(link?.confirmedCount).toBe(1);
  });

  test.skipIf(!reachable)("lets MariaDB refuse a second slot on the exhausted link", async () => {
    const current = catalog;
    let rejected = false;
    let message = "";
    try {
      await client.$executeRawUnsafe(
        "UPDATE payment_links SET active_locked_count = active_locked_count + 1 WHERE id = ?",
        current?.linkId,
      );
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    expect(rejected).toBe(true);
    expect(message).toContain("payment_links_slot_reservation_invariant");
  });

  test.skipIf(!reachable)("lets MariaDB refuse an approval request whose checker is the maker", async () => {
    const current = catalog;
    let rejected = false;
    let message = "";
    try {
      await client.approvalRequest.create({
        data: {
          subjectType: "MERCHANT",
          subjectId: current?.merchantId ?? "",
          payloadDiffJson: { e2e: true },
          makerUserId: current?.userId ?? "",
          checkerUserId: current?.userId ?? "",
          state: "PENDING_REVIEW",
        },
      });
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    expect(rejected).toBe(true);
    expect(message).toContain("checker_user_id must differ from maker_user_id");

    const leftovers = await client.approvalRequest.count({ where: { makerUserId: current?.userId } });
    expect(leftovers).toBe(0);
  });
});
