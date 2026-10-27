import { describe, expect, test } from "bun:test";
import express, { type NextFunction, type Request, type Response } from "express";
import { Decimal } from "decimal.js";
import { EDGE_CASE_CATALOG, EDGE_CASE_GROUPS, type EdgeCaseGroup } from "./catalog";
import {
  amountOf,
  createCallbackHarness,
  createEngineHarness,
  createGovernanceFixture,
  createReconciliationHarness,
  createRecordingDb,
  createSlotHarness,
  makeAttempt,
  readMigrationSql,
  readSource,
  seedAdjustment,
  signCallback,
  succeeded,
  vaultWith,
  type Executor,
} from "./helpers";
import { assertNoControlCharacters, compileUrl, encodeForDestination, validateFinalUrl } from "../../engine/apiConsumer/compileUrl";
import { ApiConsumer, ApiConsumerError, isPublicIpAddress } from "../../engine/apiConsumer/ApiConsumer";
import { canonicalize } from "../../engine/crypto/CryptoEngine";
import { TransformPipeline } from "../../engine/transforms/TransformPipeline";
import { Vault, REDACTED_VALUE } from "../../engine/crypto/Vault";
import { DetailChangeService } from "../../engine/governance/DetailChangeService";
import {
  VisibleRailsResolver,
  type CommissionProfileRecord,
  type CredentialSetRecord,
  type RailRecord,
  type RailRouteRecord,
} from "../../engine/flow/VisibleRailsResolver";
import { dayWindowInTimeZone, timezoneOffsetMs } from "../../engine/flow/DailyRouteVolume";
import { PrismaFlowProvider } from "../../engine/runtime/flowProvider";
import { PrismaAttemptRepository } from "../../engine/runtime/attemptRepository";
import { PrismaSlotReservationStore } from "../../engine/runtime/slotStore";
import { PrismaCallbackVerifier } from "../../engine/runtime/callbackVerifier";
import { CredentialCheckService } from "../../engine/runtime/platform";
import { createComputeRegistry } from "../../engine/runtime/computeRegistry";
import { evaluateAmlRules, slaDueAt, type AmlRuleDefinition } from "../../engine/guards/AmlRuleEngine";
import { moneyFromDecimal } from "../../engine/db/money";
import {
  CachedScreeningProvider,
  InternalWatchlistProvider,
  MockScreeningProvider,
  nameSimilarity,
  normalizeArabicName,
  normalizeIdentifier,
  publishWatchlist,
  type ScreeningMatch,
} from "../../engine/guards/ScreeningProvider";
import { MerchantScreeningService } from "../../engine/guards/MerchantScreeningService";
import { StatementIngestor, parseCsvRows, parseStatementDate } from "../../engine/reconciliation/StatementIngestor";
import { computeBackoffDelaySeconds, PollWorker } from "../../engine/workers/PollWorker";
import { ExpirySweeperWorker } from "../../engine/workers/ExpirySweeperWorker";
import { InboundInboxWorker, RetryableInboundError } from "../../engine/workers/InboundInboxWorker";
import { BackgroundJobWorker } from "../../engine/workers/BackgroundJobWorker";
import { DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS, JoinRequestExpiryWorker } from "../../engine/workers/JoinRequestExpiryWorker";
import {
  buildLedgerTemplate,
  buildPaymentConfirmationTemplate,
  decimal,
  LedgerPoster,
  type LedgerPrismaClient,
} from "../../engine/ledger/LedgerPoster";
import { CheckpointService } from "../../engine/ledger/CheckpointService";
import { InvariantVerifier } from "../../engine/ledger/InvariantVerifier";
import { ApprovalService, SYSTEM_AUTOMATION } from "../../engine/governance/ApprovalService";
import {
  SYSTEM_AUTOMATION_USER_ID,
  evaluateCommissionReceivableCeiling,
  executeAdjustment,
  executeAmlCaseResolution,
  openDisputeWithDraftedAdjustment,
} from "../../engine/governance/GovernanceExecution";
import { GoLiveGateValidator, type GoLiveEvidence } from "../../engine/flow/GoLiveGateValidator";
import { NativeAdapterRegistry, type NativeAdapter } from "../../engine/flow/NativeAdapterRegistry";
import { StepExecutor, type FlowStep } from "../../engine/flow/StepExecutor";
import { MOCK_SCENARIOS } from "../../engine/mockGateway/MockGatewayServer";
import { ApiError, toErrorEnvelope } from "../../lib/error";
import { ipAllowed, ipWithinCidr } from "../../api/middleware/authDoubleCheck";
import { assertCheckerIsNotMaker } from "../../api/middleware/makerCheckerGuard";
import { InvalidationBus } from "../../lib/invalidationBus";
import { assertNoTippingOff } from "../../engine/compliance/tippingOff";
import { NOTIFICATION_SIGNATURE_HEADER, WebhookNotificationTransport } from "../../engine/notifications/NotificationTransport";
import { BLUEPRINT_CATALOG } from "../../prisma/seedBlueprints";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { createGuardFixture, existingAttempt, linkRow, merchantRow, velocityRule } from "../helpers/guardsFake";
import { checkoutInternalRouter, checkoutInternals } from "../../api/internal/checkout";
import { assertUploadSignature, merchantInternalRouter } from "../../api/internal/merchant";
import { PrismaRepositories } from "../../engine/db/repositories";
import type { PrismaLike, Tx } from "../../engine/db/ports";

const pipeline = new TransformPipeline();

const rail: RailRecord = {
  id: "rail-1",
  code: "edfali",
  nameAr: "إدفالي",
  nameEn: "Edfali",
  currency: "LYD",
  blocked: false,
  displayOrder: 1,
  collectionMode: "OTP_PULL",
};

const credentialSet: CredentialSetRecord = {
  id: "cred-1",
  gatewayId: "gw-1",
  env: "LIVE",
  ownerType: "PLATFORM",
  ownerMerchantId: null,
  settlementTarget: "PLATFORM_CLEARING",
  status: "VERIFIED",
};

const profile: CommissionProfileRecord = {
  id: "cp-1",
  merchantId: null,
  applicationId: null,
  railCode: "edfali",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
};

const route: RailRouteRecord = {
  id: "route-1",
  railId: rail.id,
  gatewayId: "gw-1",
  credentialPolicy: "PLATFORM",
  priority: 10,
  routingStrategy: "EFFECTIVE_COST",
  weight: 100,
  costModel: { calc_type: "PERCENTAGE", percent: "1.5" },
  minAmount: "1.0000",
  maxAmount: "5000.0000",
  dailyCapAmount: "100000.0000",
  status: "ACTIVE",
  healthState: "HEALTHY",
  maintenanceWindows: [],
  scope: { merchantIds: ["merchant-1"], channels: ["WEB"] },
};

const visibleRails = (overrides: Partial<Parameters<VisibleRailsResolver["resolve"]>[0]> = {}) =>
  new VisibleRailsResolver().resolve({
    application: { id: "app-1", merchantId: "merchant-1", riskTier: "STANDARD", railWhitelist: null },
    link: { amount: "100.0000", currency: "LYD", railWhitelist: null },
    channel: "WEB",
    env: "LIVE",
    rails: [rail],
    routes: [route],
    credentialSets: [credentialSet],
    commissionProfiles: [profile],
    ...overrides,
  });

const baseAmountRule: AmlRuleDefinition = {
  id: "rule-1",
  code: "SINGLE_AMOUNT_LARGE",
  name: "Large single transaction",
  ruleType: "SINGLE_AMOUNT",
  scope: {},
  params: { min_amount: "10000.0000", currency: "LYD" },
  action: "HOLD",
  baseSeverity: "HIGH",
  active: true,
  version: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
};

const amlContext = {
  subjectType: "PAYMENT_ATTEMPT" as const,
  subjectId: "attempt-1",
  merchantId: "merchant-1",
  amount: moneyFromDecimal("25000.0000"),
  currency: "LYD",
  railCode: "edfali",
  riskTier: "STANDARD" as const,
  settlementTarget: "PLATFORM_CLEARING" as const,
  counterpartyCountry: "LY",
  windowStats: { count: 0, totalAmount: moneyFromDecimal(0), amounts: [] },
  expectedMonthlyVolume: null,
  openCaseCount: 0,
  velocityFlagged: false,
  screeningResult: null,
  screeningListType: null,
  now: new Date("2026-06-01T00:00:00.000Z"),
};

const greenEvidence = (): GoLiveEvidence => ({
  makerUserId: "maker-1",
  checkerUserId: "checker-1",
  scenarioResults: MOCK_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
  amountPipelineContractPassed: true,
  referenceFormatContractPassed: true,
  cryptographicSignatureContractPassed: true,
  channels: [{ type: "WEBHOOK", verificationMethod: "HMAC_BODY", mustInquire: false }],
  rollbackVersionId: "version-1",
  routeLimitsPreviewed: true,
  commissionProfilePreviewed: true,
  statementParserPreviewed: true,
  evidenceLevel: "VERIFIED",
  panFieldCount: 0,
  canaryTrafficPlanConfigured: true,
  routeAlertsConfigured: true,
  runbooksConfigured: true,
});

const successEvidence = (attempt: { gatewayReference?: string; currency: string; env: string; totalChargedAmount: unknown }) => ({
  status: "SUCCESS",
  reference: attempt.gatewayReference ?? "PA-1",
  amount: String(attempt.totalChargedAmount),
  currency: attempt.currency,
  environment: attempt.env,
});

const honestExecutor = (
  attempt: { gatewayReference?: string; currency: string; env: string; totalChargedAmount: unknown },
  output: Partial<Awaited<ReturnType<StepExecutor["execute"]>>["output"]> = {},
): Executor => (step) => ({
  ...succeeded(step, output),
  response: successEvidence(attempt),
});

const expectApiCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected the promise to reject with '${code}'`);
};

const inMemoryApprovalClient = () => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    client: {
      approvalRequest: {
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `approval-${rows.size + 1}`, checkerUserId: null, ...data };
          rows.set(row.id as string, row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...(rows.get(where.id) ?? {}), ...data };
          rows.set(where.id, row);
          return row;
        },
      },
    } as never,
  };
};

const createLedgerClient = () => {
  const queries: Array<Record<string, unknown>> = [];
  const entries: Array<{ id: string; refType: string; refId: string }> = [];
  const lines: Array<Record<string, unknown>> = [];
  const client = {
    glAccount: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        const type = String(args.where.accountType);
        if (type === "GATEWAY_CLEARING") {
          return { id: "acc-clearing" };
        }
        if (type === "MERCHANT_WALLET") {
          return { id: "acc-wallet" };
        }
        if (type === "SUSPENSE") {
          return { id: "acc-suspense" };
        }
        return { id: `acc-${type.toLowerCase()}` };
      },
    },
    journalEntry: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        entries.find(
          (entry) => entry.refType === args.where.refType && entry.refId === args.where.refId,
        ) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        const entry = {
          id: `entry-${entries.length + 1}`,
          refType: String(args.data.refType),
          refId: String(args.data.refId),
        };
        entries.push(entry);
        return entry;
      },
    },
    journalLine: {
      create: async (args: { data: Record<string, unknown> }) => {
        const line = { id: `line-${lines.length + 1}`, ...args.data };
        lines.push(line);
        return line;
      },
    },
  } as unknown as LedgerPrismaClient;
  return { client, queries, entries, lines };
};

type Check = () => Promise<void> | void;

const checks: Record<string, Check> = {
  async expiry_inquiry_before_expire() {
    const patches: Array<Record<string, unknown>> = [];
    const { db, calls } = createRecordingDb({
      queryRows: [{ id: "attempt-1", status: "AWAITING_CUSTOMER", expires_at: new Date("2026-06-01T00:00:00Z"), terminal_at: null, route_id: "route-1", link_id: "link-1" }],
      onExecute: () => 1,
    });
    const repositories = createFakeRepositories({
      payments: {
        listRouteInquirySupport: async () => [{ routeId: "route-1", supportsStatusCheck: true }],
        updateAttempt: async (_tx, _id, patch) => {
          patches.push(patch);
          return {} as never;
        },
        updateLinkSlotCount: async () => undefined,
      },
      governance: {
        writeAuditLog: async () => undefined,
      },
    });
    const worker = new ExpirySweeperWorker({
      db,
      repositories,
      clock: () => new Date("2026-06-01T00:00:00Z"),
      inquiry: {
        inquire: async () => ({ status: "SUCCEEDED", definitive: true, settledAmount: "100.0000" }),
      },
    });
    await worker.runOnce();
    expect(patches.some((patch) => patch.settledAmount === "100.0000")).toBe(true);
    const terminal = calls.find((call) => call.kind === "execute" && call.sql.includes("UPDATE payment_attempts"));
    expect(terminal?.args[0]).toBe("SUCCEEDED");
    const select = calls.find((call) => call.kind === "query" && call.sql.includes("FROM payment_attempts"));
    expect(select?.sql).toContain("expires_at <= ?");
    expect(select?.sql).toContain("terminal_at IS NULL");
  },

  async otp_resend_cooldown() {
    const action = checkoutInternals.buildClientAction("OTP_PULL", {
      expiresAt: new Date("2026-06-01T00:15:00Z"),
      attemptReference: "PA-1",
      maskedPhone: "*******678",
      railCode: "edfali",
      widget: null,
      redirect: null,
      instructionsAr: null,
      instructionsEn: null,
      fee: {
        commission: "3.0000",
        payerSurcharge: "0.0000",
        totalCharged: "100.0000",
        merchantCredited: "97.0000",
        feeBearer: "MERCHANT_ABSORBS",
      },
    });
    expect(action.kind).toBe("SHOW_OTP_FORM");
    expect(action.resend_cooldown_seconds).toBeGreaterThan(0);
    const source = readSource("api/internal/checkout.ts");
    expect(source).toContain("otpResendCooldownSeconds");
    expect(source).toContain("OTP_RESEND_COOLDOWN");
  },

  async effective_expiry_is_minimum() {
    const source = readSource("api/internal/checkout.ts");
    expect(source).toMatch(/Math\.min\(platformCeiling,\s*gatewayTtl\)/);
    expect(source).toContain("PLATFORM_TTL_CEILINGS[mode]");
    expect(source).toContain("sessionTtlSeconds");
  },

  async otp_attempt_counter() {
    const otpExecutor: Executor = (step) => ({
      stepId: step.id,
      status: "AWAITING_CUSTOMER",
      canonicalError: "RETRYABLE_OTP",
      output: { state: {}, public: {} },
      logs: [],
    });
    const harness = createEngineHarness({
      attempt: { status: "AWAITING_CUSTOMER", otpAttempts: 0, maxOtpAttempts: 3 },
      executor: otpExecutor,
    });
    await harness.engine.confirm(harness.attempt, { otp: "0000" });
    expect(harness.attempt.otpAttempts).toBe(1);
    await harness.engine.confirm(harness.attempt, { otp: "0000" });
    expect(harness.attempt.otpAttempts).toBe(2);
    const final = await harness.engine.confirm(harness.attempt, { otp: "0000" });
    expect(final.status).toBe("FAILED");
    expect(harness.attempt.otpAttempts).toBe(3);
    expect(harness.released).toContain("attempt-1");
  },

  async timeout_moves_money_to_unknown() {
    const executor = new StepExecutor({
      fetch: (async () => {
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      }) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const harness = createEngineHarness({
      steps: {
        SUBMIT: [{
          id: "submit",
          type: "HTTP",
          method: "POST",
          url_template: "https://gw.example/confirm",
          side_effect: "MOVES_MONEY",
          point_of_no_return: true,
          retry_policy: "NEVER",
        }],
      },
      executor: (step, context) => executor.execute(step, context),
    });
    const result = await harness.engine.confirm(harness.attempt, { otp: "1234" });
    expect(result.status).toBe("UNKNOWN");
    expect(harness.attempt.status).toBe("UNKNOWN");
    expect(harness.released).toEqual([]);
  },

  async durable_worker_timers() {
    const expiry = createRecordingDb({ queryRows: [] });
    await new ExpirySweeperWorker({
      db: expiry.db,
      repositories: createFakeRepositories({}),
      clock: () => new Date("2026-06-01T00:00:00Z"),
    }).runOnce();
    const poll = createRecordingDb({ queryRows: [] });
    await new PollWorker({
      db: poll.db,
      repositories: createFakeRepositories({}),
      clock: () => new Date("2026-06-01T00:00:00Z"),
    }).runOnce();
    const jobs = createRecordingDb({ queryRows: [] });
    await new BackgroundJobWorker({
      db: jobs.db,
      repositories: createFakeRepositories({}),
      clock: () => new Date("2026-06-01T00:00:00Z"),
      handlers: {},
    }).runOnce();
    const statements = [...expiry.calls, ...poll.calls, ...jobs.calls]
      .filter((call) => call.kind === "query")
      .map((call) => call.sql);
    expect(statements.some((sql) => sql.includes("expires_at <= ?") && sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(statements.some((sql) => sql.includes("next_check_at <= ?") && sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM background_jobs") && sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);

    const terminate = createRecordingDb({
      queryRows: [{ id: "attempt-1", status: "AWAITING_CUSTOMER", expires_at: new Date("2026-05-31T00:00:00Z"), terminal_at: null, route_id: "route-1" }],
      onExecute: () => 1,
    });
    await new ExpirySweeperWorker({
      db: terminate.db,
      repositories: createFakeRepositories({}),
      clock: () => new Date("2026-06-01T00:00:00Z"),
    }).runOnce();
    const update = terminate.calls.find((call) => call.kind === "execute" && call.sql.includes("UPDATE payment_attempts"));
    expect(update?.sql).toContain("terminal_at IS NULL");
  },

  async atomic_slot_reservation() {
    const harness = createSlotHarness({ use_count: 1, confirmed_count: 0, active_locked_count: 0 });
    const store = new PrismaSlotReservationStore(harness.client);
    await store.reserveSlot(makeAttempt({ linkId: harness.link.id }));
    await expectApiCode(
      store.reserveSlot(makeAttempt({ id: "attempt-2", linkId: harness.link.id })),
      "PAYMENT_LINK_SLOT_UNAVAILABLE",
    );
    const select = harness.statements.find((entry) => entry.sql.includes("SELECT id FROM payment_links"));
    expect(select?.sql).toContain("FOR UPDATE");
    expect(select?.sql).toContain("confirmed_count + active_locked_count < use_count");
    const update = harness.statements.find((entry) => entry.sql.includes("active_locked_count = active_locked_count + 1"));
    expect(update?.sql).toContain("WHERE id = ?");
    expect(harness.link.active_locked_count).toBe(1);
  },

  async slot_held_through_unknown() {
    const executor: Executor = (step) => ({
      stepId: step.id,
      status: "UNKNOWN",
      output: { state: {}, public: {} },
      logs: [],
    });
    const harness = createEngineHarness({ executor });
    const result = await harness.engine.confirm(harness.attempt, { otp: "1234" });
    expect(result.status).toBe("UNKNOWN");
    expect(harness.released).toEqual([]);
    expect(harness.committed).toEqual([]);
    await expectApiCode(
      harness.engine.confirm({ ...harness.attempt, pointOfNoReturn: true }, { otp: "1234" }),
      "POINT_OF_NO_RETURN",
    );
  },

  async attempt_group_single_success() {
    const sql = readMigrationSql();
    expect(sql).toContain("attempt_groups_single_success");
    expect(sql).toContain("CHECK (`success_count` <= 1)");
    expect(sql).toContain("attempt_groups_link_id_customer_fingerprint_key");
  },

  async late_success_recovery() {
    const attempt = makeAttempt({ status: "EXPIRED" });
    const harness = createEngineHarness({
      attempt,
      steps: { VERIFY: [{ id: "verify", type: "HTTP" }] },
      executor: honestExecutor(attempt),
    });
    const result = await harness.engine.inquire(harness.attempt);
    expect(result.status).toBe("SUCCEEDED");
    expect(harness.attempt.status).toBe("SUCCEEDED");
    expect(harness.committed).toEqual(["attempt-1"]);
  },

  async gateway_timezone_formatting() {
    const instant = new Date("2026-03-01T10:15:00.000Z");
    const formatted = await pipeline.apply(instant, [
      { op: "format_date", args: ["YYYY-MM-DD HH:mm", "Africa/Tripoli"] },
    ]);
    expect(formatted).toBe("2026-03-01 12:15");
    expect(timezoneOffsetMs(instant, "Africa/Tripoli")).toBe(2 * 60 * 60 * 1000);
    const window = dayWindowInTimeZone(instant, "Africa/Tripoli");
    expect(window.until.getTime() - window.since.getTime()).toBe(24 * 60 * 60 * 1000);
  },

  async link_expiry_reverified() {
    const fixture = createGuardFixture({ link: linkRow({ expiresAt: new Date("2026-05-31T23:59:00Z") }) });
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => new Date("2026-06-01T00:00:00Z"),
    });
    await expectApiCode(
      guard.guard({
        linkKey: "link-key-1",
        railCode: "edfali",
        env: "SANDBOX",
        channel: "WEB",
        idempotencyKey: "idem-expiry-1",
      }),
      "PAYMENT_LINK_EXPIRED",
    );
  },

  async slot_invariant_bounded() {
    const harness = createSlotHarness({ use_count: 1, confirmed_count: 1, active_locked_count: 0, state: "COMPLETED" });
    const store = new PrismaSlotReservationStore(harness.client);
    const result = await store.commitSlot(makeAttempt({ linkId: harness.link.id }));
    expect(result?.outcome).toBe("SUSPENSE");
    expect(harness.link.confirmed_count + harness.link.active_locked_count).toBeLessThanOrEqual(harness.link.use_count);
    expect(harness.link.confirmed_count).toBe(1);
    const update = harness.statements.find((entry) => entry.sql.includes("confirmed_count = confirmed_count + 1"));
    expect(update?.sql).toContain("confirmed_count + 1 <= use_count");
    const suspense = harness.lines.find((line) => line.glAccountId === "acc-suspense");
    expect(suspense?.direction).toBe("CREDIT");
  },

  async pos_idle_timeout_resync() {
    const source = readSource("api/internal/merchant.ts");
    expect(source).toContain("15 * 60 * 1000");
    expect(source).toContain("event: attempts");
    expect(source).toContain("paymentAttempt.findMany");
  },

  async inbox_stored_before_processing() {
    let stored = false;
    let handlerCalls = 0;
    const { db, calls } = createRecordingDb({
      onQuery: () => (stored ? [{ id: "event-1" }] : []),
      onExecute: (sql) => {
        if (sql.includes("INSERT INTO inbound_events")) {
          stored = true;
        }
        return 1;
      },
    });
    const worker = new InboundInboxWorker({
      db,
      repositories: createFakeRepositories({}),
      handler: {
        handle: async () => {
          handlerCalls += 1;
          return { processed: true };
        },
      },
    });
    const result = await worker.persistInboundEvent({
      channelId: "channel-1",
      gatewayId: "gateway-1",
      env: "LIVE",
      rawBody: "{\"reference\":\"PA-1\"}",
      headers: {},
      sourceIp: "203.0.113.9",
      verified: true,
      verificationError: null,
      dedupeKey: "dedupe-1",
      attemptId: "attempt-1",
    });
    expect(result.duplicate).toBe(false);
    expect(handlerCalls).toBe(0);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO inbound_events"));
    expect(insert?.sql).not.toContain("processed_at");
  },

  async unknown_reference_no_effect() {
    const harness = createCallbackHarness();
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const result = await verifier.verify(harness.channel.pathToken, {
      rawBody: Buffer.from(JSON.stringify({ reference: "UNKNOWN", timestamp: Math.floor(Date.now() / 1000) })),
      headers: {},
      sourceIp: "203.0.113.9",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("INBOUND_ATTEMPT_UNKNOWN");
  },

  async duplicate_webhook_absorbed() {
    let stored = false;
    const { db, calls } = createRecordingDb({
      onQuery: () => (stored ? [{ id: "event-1" }] : []),
      onExecute: (sql) => {
        if (sql.includes("INSERT INTO inbound_events")) {
          stored = true;
        }
        return 1;
      },
    });
    const worker = new InboundInboxWorker({ db, repositories: createFakeRepositories({}) });
    const input = {
      channelId: "channel-1",
      gatewayId: "gateway-1",
      env: "LIVE",
      rawBody: "{}",
      headers: {},
      sourceIp: null,
      verified: true,
      verificationError: null,
      dedupeKey: "dedupe-1",
    };
    const first = await worker.persistInboundEvent(input);
    const second = await worker.persistInboundEvent(input);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(calls.filter((call) => call.sql.includes("INSERT INTO inbound_events"))).toHaveLength(1);
  },

  async no_success_downgrade() {
    const harness = createEngineHarness({ attempt: { status: "SUCCEEDED" } });
    await expectApiCode(harness.engine.transition(harness.attempt, "FAILED"), "INVALID_ATTEMPT_TRANSITION");
    await expectApiCode(harness.engine.transition(harness.attempt, "UNKNOWN"), "INVALID_ATTEMPT_TRANSITION");
    expect(harness.attempt.status).toBe("SUCCEEDED");
  },

  async late_success_after_failed() {
    const attempt = makeAttempt({ status: "FAILED" });
    const harness = createEngineHarness({
      attempt,
      steps: { VERIFY: [{ id: "verify", type: "HTTP" }] },
      executor: honestExecutor(attempt),
    });
    const result = await harness.engine.inquire(harness.attempt);
    expect(result.status).toBe("SUCCEEDED");
    expect(harness.attempt.status).toBe("SUCCEEDED");
  },

  async conflicting_signals_unknown() {
    const badExecutor: Executor = (step) => ({
      stepId: step.id,
      status: "FAILED",
      output: { state: {}, public: {} },
      logs: [],
    });
    const harness = createEngineHarness({
      attempt: { status: "UNKNOWN", context: { trustedSuccessObserved: true } },
      steps: { VERIFY: [{ id: "verify", type: "HTTP" }] },
      executor: badExecutor,
    });
    const result = await harness.engine.inquire(harness.attempt);
    expect(result.status).toBe("UNKNOWN");
    expect(result.canonicalError).toBe("CONFLICTING_TRUSTED_SIGNALS");
    expect(harness.released).toEqual([]);
  },

  async browser_callback_is_hint() {
    const harness = createEngineHarness({
      attempt: { status: "VERIFYING" },
      steps: { VERIFY: [{ id: "verify", type: "HTTP" }] },
      executor: (step) => ({
        stepId: step.id,
        status: "VERIFYING",
        output: { state: {}, public: {} },
        logs: [],
      }),
      callbackVerifier: {
        verify: async () => ({ verified: true, attemptId: "attempt-1", mustInquire: true }),
      },
      callbackInbox: { accept: async () => true },
    });
    const result = await harness.engine.verifyCallback("channel-1", { event: "completeCallback" });
    expect(result.status).toBe("VERIFYING");
    expect(result.status).not.toBe("SUCCEEDED");

    // A browser callback can arrive while the attempt still waits for the
    // customer (after initiate, before submit). The inquiry must be able to
    // run from AWAITING_CUSTOMER as well.
    const pending = createEngineHarness({
      attempt: { status: "AWAITING_CUSTOMER" },
      steps: { VERIFY: [{ id: "verify", type: "HTTP" }] },
      executor: (step) => ({
        stepId: step.id,
        status: "VERIFYING",
        output: { state: {}, public: {} },
        logs: [],
      }),
    });
    const pendingResult = await pending.engine.inquire(pending.attempt);
    expect(pendingResult.status).toBe("VERIFYING");
  },

  async forged_webhook_rejected() {
    const harness = createCallbackHarness();
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const raw = JSON.stringify({ reference: "PA-1", status: "00", amount: "100.0000", currency: "LYD", timestamp: Math.floor(Date.now() / 1000) });
    const forged = await verifier.verify(harness.channel.pathToken, {
      rawBody: Buffer.from(raw),
      headers: { "x-signature": signCallback("wrong-secret", raw) },
      sourceIp: "203.0.113.9",
    });
    expect(forged.verified).toBe(false);
    expect(forged.reason).toBe("INBOUND_SIGNATURE_INVALID");
    const valid = await verifier.verify(harness.channel.pathToken, {
      rawBody: Buffer.from(raw),
      headers: { "x-signature": signCallback("secret", raw) },
      sourceIp: "203.0.113.9",
    });
    expect(valid.verified).toBe(true);
  },

  async replay_window_rejected() {
    const harness = createCallbackHarness();
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const raw = JSON.stringify({ reference: "PA-1", status: "00", timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const result = await verifier.verify(harness.channel.pathToken, {
      rawBody: Buffer.from(raw),
      headers: { "x-signature": signCallback("secret", raw) },
      sourceIp: "203.0.113.9",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("INBOUND_TIMESTAMP_OUTSIDE_WINDOW");
  },

  async ack_before_processing() {
    let handlerCalls = 0;
    const handler = {
      handle: async () => {
        handlerCalls += 1;
        return { processed: true };
      },
    };
    let stored = false;
    const persistDb = createRecordingDb({
      onQuery: () => (stored ? [{ id: "event-1" }] : []),
      onExecute: (sql) => {
        if (sql.includes("INSERT INTO inbound_events")) {
          stored = true;
        }
        return 1;
      },
    });
    const persistWorker = new InboundInboxWorker({ db: persistDb.db, repositories: createFakeRepositories({}), handler });
    await persistWorker.persistInboundEvent({
      channelId: "channel-1",
      gatewayId: "gateway-1",
      env: "LIVE",
      rawBody: "{}",
      headers: {},
      sourceIp: null,
      verified: true,
      verificationError: null,
      dedupeKey: "dedupe-1",
    });
    expect(handlerCalls).toBe(0);

    const workerDb = createRecordingDb({
      queryRows: [{
        id: "event-1",
        channelId: "channel-1",
        gatewayId: "gateway-1",
        env: "LIVE",
        verified: true,
        dedupeKey: "dedupe-1",
        attemptId: "attempt-1",
        processedAt: null,
        processingResult: null,
        receivedAt: new Date(),
      }],
    });
    const worker = new InboundInboxWorker({ db: workerDb.db, repositories: createFakeRepositories({}), handler });
    await worker.runOnce();
    expect(handlerCalls).toBe(1);
  },

  async amount_mismatch_held() {
    const attempt = makeAttempt({ totalChargedAmount: "100.0000", mismatchTolerance: "0.0500" });
    const harness = createEngineHarness({ attempt });
    const mismatched = harness.engine.verifyTrustedSuccessFacts(
      { status: "SUCCESS", reference: "GW-1", amount: "99.9000", currency: "LYD", environment: "SANDBOX" },
      attempt,
    );
    expect(mismatched.facts.amount).toBe(false);
    expect(mismatched.trusted).toBe(false);
    const within = harness.engine.verifyTrustedSuccessFacts(
      { status: "SUCCESS", reference: "GW-1", amount: "99.9800", currency: "LYD", environment: "SANDBOX" },
      attempt,
    );
    expect(within.facts.amount).toBe(true);
    const template = buildLedgerTemplate("SUSPENSE_SETTLEMENT", { amount: "99.9000", ownershipMode: "PLATFORM_CLEARING" });
    expect(template.lines.some((line) => line.account.accountType === "SUSPENSE")).toBe(true);
  },

  async environment_separation() {
    const harness = createEngineHarness({
      attempt: { env: "LIVE" },
      callbackVerifier: {
        verify: async () => ({
          verified: true,
          attemptId: "attempt-1",
          evidence: { status: "SUCCESS", reference: "GW-1", amount: "100.0000", currency: "LYD", environment: "SANDBOX" },
        }),
      },
      callbackInbox: { accept: async () => true },
    });
    await expectApiCode(harness.engine.verifyCallback("channel-1", {}), "CALLBACK_ENVIRONMENT_MISMATCH");
  },

  async raw_bytes_preserved() {
    let stored = false;
    const { db, calls } = createRecordingDb({
      onQuery: () => (stored ? [{ id: "event-1" }] : []),
      onExecute: (sql) => {
        if (sql.includes("INSERT INTO inbound_events")) {
          stored = true;
        }
        return 1;
      },
    });
    const worker = new InboundInboxWorker({ db, repositories: createFakeRepositories({}) });
    const raw = Buffer.from('{\n  "amount": "100.0000",\n  "reference": "PA-1"\n}', "utf8");
    await worker.persistInboundEvent({
      channelId: "channel-1",
      gatewayId: "gateway-1",
      env: "LIVE",
      rawBody: raw,
      headers: { "x-signature": "sig" },
      sourceIp: "203.0.113.9",
      verified: true,
      verificationError: null,
      dedupeKey: "dedupe-1",
    });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO inbound_events"));
    const storedBody = insert?.args.find((arg) => Buffer.isBuffer(arg)) as Buffer | undefined;
    expect(storedBody?.equals(raw)).toBe(true);
  },

  async return_url_is_hint() {
    const harness = createEngineHarness({
      attempt: { status: "VERIFYING" },
      steps: { VERIFY: [{ id: "verify", type: "HTTP" }] },
      executor: (step) => ({
        stepId: step.id,
        status: "FAILED",
        output: { state: {}, public: {} },
        logs: [],
      }),
      callbackVerifier: {
        verify: async () => ({ verified: true, attemptId: "attempt-1", mustInquire: true }),
      },
      callbackInbox: { accept: async () => true },
    });
    const result = await harness.engine.verifyCallback("return-url", { status: "success" });
    expect(result.status).toBe("FAILED");
    expect(harness.attempt.status).toBe("FAILED");
  },

  async body_format_parsing() {
    const harness = createCallbackHarness({
      channel: { bodyFormat: "FORM" },
      attempt: { env: "LIVE" },
    });
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = `reference=PA-1&status=00&amount=100.0000&currency=LYD&timestamp=${timestamp}`;
    const result = await verifier.verify(harness.channel.pathToken, {
      rawBody: Buffer.from(raw),
      headers: { "x-signature": signCallback("secret", raw) },
      sourceIp: "203.0.113.9",
    });
    expect(result.verified).toBe(true);
    expect(result.evidence?.status).toBe("SUCCESS");
    expect(result.evidence?.reference).toBe("PA-1");
    expect(result.evidence?.amount).toBe("100.0000");
  },

  async trusted_proxy_ip_resolution() {
    expect(ipWithinCidr("203.0.113.9", "203.0.113.0/24")).toBe(true);
    expect(ipWithinCidr("10.0.0.1", "203.0.113.0/24")).toBe(false);
    expect(ipAllowed("203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("10.0.0.1", ["203.0.113.0/24"])).toBe(false);
    const source = readSource("api/middleware/authDoubleCheck.ts");
    expect(source).toContain("x-real-client-ip");
    expect(source).toContain("ipAllowed(clientIp(request), cidrs)");
  },

  async high_risk_requires_acceptance() {
    const validator = new GoLiveGateValidator();
    const unsigned = await validator.validate({
      ...greenEvidence(),
      evidenceLevel: "HIGH_RISK",
      highRiskExecutiveAcceptanceSigned: false,
    });
    expect(unsigned.failedGateIds).toContain("EVIDENCE_LEVEL");
    const signed = await validator.validate({
      ...greenEvidence(),
      evidenceLevel: "HIGH_RISK",
      highRiskExecutiveAcceptanceSigned: true,
    });
    expect(signed.passed).toBe(true);
    const ipOnly = await validator.validate({
      ...greenEvidence(),
      channels: [{ type: "WEBHOOK", verificationMethod: "IP_ONLY", mustInquire: false }],
    });
    expect(ipOnly.failedGateIds).toContain("CHANNEL_VERIFICATION_STRENGTH");
  },
  async settled_amount_recorded() {
    const attempt = makeAttempt();
    const harness = createEngineHarness({
      attempt,
      executor: honestExecutor(attempt, { settledAmount: "99.9000" }),
    });
    await harness.engine.confirm(harness.attempt, { otp: "1234" });
    expect(harness.attempt.settledAmount).toBe("99.9000");
    expect(harness.attempt.status).toBe("SUCCEEDED");
  },

  async amount_scale_contract() {
    expect(await pipeline.apply("10.5000", [{ op: "scale", args: [1000] }])).toBe("10500");
    expect(await pipeline.apply("10.5000", [{ op: "scale", args: [1000] }, { op: "to_int" }])).toBe(10500);
    expect(await pipeline.apply("76.255", [{ op: "format_decimal", args: [3] }])).toBe("76.255");
  },

  async currency_mismatch_hidden() {
    const result = visibleRails({ link: { amount: "100.0000", currency: "USD", railWhitelist: null } });
    expect(result.rails).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("CURRENCY_MISMATCH");
  },

  async payer_surcharge_booking() {
    const template = buildPaymentConfirmationTemplate({
      ownershipMode: "PLATFORM_CLEARING",
      feeBearer: "PAYER_SURCHARGE",
      amount: "100.0000",
      surchargeAmount: "3.0000",
      commissionAmount: "3.0000",
      merchantAmount: "100.0000",
      gatewayFeeAmount: "0.8000",
    });
    new LedgerPoster({} as never).validateTemplate({ ...template, refId: "attempt-1" });
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(byAccount.get("GATEWAY_CLEARING")?.direction).toBe("DEBIT");
    expect(decimal(byAccount.get("GATEWAY_CLEARING")?.amount ?? 0).toFixed(4)).toBe("103.0000");
    expect(decimal(byAccount.get("MERCHANT_WALLET")?.amount ?? 0).toFixed(4)).toBe("100.0000");
    expect(decimal(byAccount.get("PLATFORM_INCOME")?.amount ?? 0).toFixed(4)).toBe("3.0000");
  },

  async limit_exceeded_not_breaker() {
    const fixture = createGuardFixture({
      velocityRules: [velocityRule({ maxCount: 1 })],
      attempts: [existingAttempt()],
    });
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const decision = await guard.guard({
      linkKey: "link-key-1",
      railCode: "edfali",
      env: "SANDBOX",
      channel: "WEB",
      idempotencyKey: "idem-limit-1",
    });
    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toContain("VELOCITY_REJECT");
    const source = readSource("api/internal/admin.ts");
    expect(source).toContain("LIMIT_EXCEEDED");
    expect(source).toContain("countsTowardBreaker: z.boolean().default(false)");
  },

  async route_limits_enforced() {
    const result = visibleRails({ link: { amount: "9000.0000", currency: "LYD", railWhitelist: null } });
    expect(result.rails).toHaveLength(0);
    expect(result.excluded.some((entry) => entry.reason === "AMOUNT_ABOVE_MAXIMUM")).toBe(true);
  },

  async overpayment_held_in_suspense() {
    const harness = createSlotHarness({ use_count: 1, confirmed_count: 1, state: "COMPLETED" });
    const store = new PrismaSlotReservationStore(harness.client);
    const result = await store.commitSlot(makeAttempt({ linkId: harness.link.id }));
    expect(result?.outcome).toBe("SUSPENSE");
    expect(harness.adjustments[0]?.type).toBe("REFUND");
    expect(harness.adjustments[0]?.state).toBe("PENDING_REVIEW");
    expect(harness.operatorCases[0]?.priority).toBe("P1");
    const suspense = harness.lines.find((line) => line.glAccountId === "acc-suspense");
    expect(suspense?.direction).toBe("CREDIT");
  },

  async refund_window_enforced() {
    const { fakeTable } = await import("../helpers/governanceFake");
    const runRefund = async (options: {
      capabilities: Record<string, unknown>;
      refundWindowDays?: number | null;
      terminalAt: Date;
    }) => {
      const { client, context } = createGovernanceFixture();
      fakeTable("rail").push({
        id: "rail-1",
        capabilities: options.capabilities,
        refundWindowDays: options.refundWindowDays ?? null,
      });
      const attempt = fakeTable("paymentAttempt").find((row) => row.id === "attempt-1");
      if (!attempt) {
        throw new Error("The governance fixture lost its payment attempt");
      }
      attempt.railId = "rail-1";
      attempt.terminalAt = options.terminalAt;
      seedAdjustment(client, {
        id: "refund-1",
        type: "REFUND",
        sourceAttemptId: "attempt-1",
        amount: new Decimal(100),
        state: "PENDING_REVIEW",
      });
      const engine = {
        refund: async () => ({
          status: "SUCCEEDED",
          attempt: { ownershipMode: "PLATFORM_CLEARING" },
        }) as never,
      };
      return client.$transaction(async (tx) =>
        executeAdjustment({ ...context, engine }, tx as never, {
          adjustmentId: "refund-1",
          checkerUserId: "user-finance",
          checkerRole: "FINANCE",
        }),
      );
    };

    await expectApiCode(
      runRefund({ capabilities: { refund: false }, terminalAt: new Date("2026-06-01T00:00:00Z") }),
      "REFUND_NOT_SUPPORTED",
    );
    await expectApiCode(
      runRefund({
        capabilities: { refund: true },
        refundWindowDays: 30,
        terminalAt: new Date("2020-01-01T00:00:00Z"),
      }),
      "REFUND_WINDOW_EXPIRED",
    );
    const executed = await runRefund({
      capabilities: { refund: true },
      refundWindowDays: 30,
      terminalAt: new Date(),
    });
    expect(executed.status).toBe("EXECUTED");
    expect(executed.template).toBe("FULL_REFUND");
  },

  async chargeback_drafted() {
    const { client, context } = createGovernanceFixture();
    const { fakeTable } = await import("../helpers/governanceFake");
    const result = await client.$transaction(async (tx) =>
      openDisputeWithDraftedAdjustment(context, tx as never, {
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-0001",
        source: "MANUAL",
        amount: new Decimal(100),
        currency: "LYD",
        actorUserId: "user-finance",
        actorRole: "FINANCE",
      }),
    );
    const adjustment = fakeTable("adjustment").find((row) => row.id === result.adjustmentId);
    expect(adjustment?.type).toBe("CHARGEBACK");
    expect(adjustment?.state).toBe("PENDING_REVIEW");
    expect(adjustment?.draftedBySystem).toBe(true);
    const approval = fakeTable("approvalRequest").find((row) => row.id === result.approvalRequestId);
    expect(approval?.makerUserId).toBe(SYSTEM_AUTOMATION_USER_ID);
    const reserve = fakeTable("journalEntry").find((row) => row.refType === "DISPUTE_OUTCOME" && row.refId === result.disputeId);
    expect(reserve).toBeDefined();
  },

  async duplicate_settlement_to_suspense() {
    const harness = createSlotHarness({ use_count: 1, confirmed_count: 1, state: "COMPLETED" });
    const store = new PrismaSlotReservationStore(harness.client);
    const attempt = makeAttempt({ linkId: harness.link.id });
    const first = await store.commitSlot(attempt);
    const second = await store.commitSlot(attempt);
    expect(first?.outcome).toBe("SUSPENSE");
    expect(second?.outcome).toBe("SUSPENSE");
    expect(harness.link.confirmed_count).toBe(1);
    expect(harness.adjustments).toHaveLength(1);
  },

  async reconciliation_flags_drift() {
    const harness = createReconciliationHarness({
      attempts: [
        { id: "attempt-1", reference: "PA-1", totalChargedAmount: "100.0000", settledAmount: "100.0000", status: "SUCCEEDED" },
        { id: "attempt-2", reference: "PA-2", totalChargedAmount: "50.0000", settledAmount: "50.0000", status: "SUCCEEDED" },
      ],
    });
    const ingestor = new StatementIngestor({ db: harness.db, repositories: harness.repositories });
    const csv = [
      "our_reference,provider_reference,amount,fee,currency,occurred_at,type",
      "PA-1,PROV-1,100.0000,0.0000,LYD,20260601,PAYMENT",
      "PA-X,PROV-X,70.0000,0.0000,LYD,20260601,PAYMENT",
    ].join("\n");
    const result = await ingestor.ingest({ statementSourceId: "source-1", content: csv });
    expect(result.matched).toBe(1);
    expect(result.missingAtGateway).toBe(1);
    expect(result.missingLocally).toBe(1);
    expect(result.items.map((item) => item.result)).toContain("MISSING_AT_GATEWAY");
    expect(result.items.map((item) => item.result)).toContain("MISSING_LOCALLY");
  },

  async batch_net_parsing() {
    const harness = createReconciliationHarness({
      parserConfig: {
        format: "CSV",
        headerRow: true,
        supportsBatchNet: true,
        columnsMap: {
          ourReference: "our_reference",
          batchReference: "batch_reference",
          amount: "amount",
          fee: "fee",
          currency: "currency",
          occurredAt: "occurred_at",
          type: "type",
        },
        dateFormat: "YYYYMMDD",
      },
      attempts: [{ id: "attempt-1", reference: "PA-1", totalChargedAmount: "100.0000", settledAmount: "100.0000", status: "SUCCEEDED" }],
    });
    const ingestor = new StatementIngestor({ db: harness.db, repositories: harness.repositories });
    const csv = [
      "our_reference,batch_reference,amount,fee,currency,occurred_at,type",
      "PA-1,BATCH-1,100.0000,1.0000,LYD,20260601,SETTLEMENT",
    ].join("\n");
    const result = await ingestor.ingest({ statementSourceId: "source-1", content: csv });
    expect(result.matched).toBe(1);
    expect(parseCsvRows(csv)[1]?.[1]).toBe("BATCH-1");
    expect(harness.items[0]?.batchReference).toBe("BATCH-1");
  },

  async fee_variance_true_up() {
    const template = buildLedgerTemplate("FEE_VARIANCE_TRUE_UP", { amount: "100.0000", varianceAmount: "0.1000" });
    expect(template.refType).toBe("FEE_VARIANCE");
    expect(template.lines).toHaveLength(2);
    expect(template.lines[0]?.account.accountType).toBe("GATEWAY_FEE_EXPENSE");
    expect(decimal(template.lines[0]?.amount ?? 0).toFixed(4)).toBe("0.1000");
    expect(template.lines[1]?.account.accountType).toBe("GATEWAY_FEE_ACCRUAL");
  },

  async wire_amount_rounding() {
    const wire = await pipeline.apply("76.255", [{ op: "round", args: ["UP", 2] }, { op: "format_decimal", args: [2] }]);
    expect(wire).toBe("76.26");
    expect(await pipeline.apply("76.251", [{ op: "round", args: ["DOWN", 2] }, { op: "format_decimal", args: [2] }])).toBe("76.25");
  },

  async commission_rounding_identity() {
    const template = buildLedgerTemplate("PLATFORM_HELD_CONFIRMATION", {
      amount: "100.0000",
      commissionAmount: "3.3333",
      providerFeeAmount: "0.0000",
    });
    new LedgerPoster({} as never).validateTemplate({ ...template, refId: "attempt-1" });
    const merchant = template.lines.find((line) => line.account.accountType === "MERCHANT_WALLET");
    const commission = template.lines.find((line) => line.account.accountType === "PLATFORM_INCOME");
    expect(decimal(merchant?.amount ?? 0).plus(decimal(commission?.amount ?? 0)).toFixed(4)).toBe("100.0000");
  },

  async statement_encoding_config() {
    const date = parseStatementDate("01/06/2026", "DD/MM/YYYY");
    expect(date?.toISOString().startsWith("2026-06-01")).toBe(true);
    const rows = parseCsvRows("our_reference;amount\nPA-1;100.0000", ";");
    expect(rows[1]).toEqual(["PA-1", "100.0000"]);
    expect(parseStatementDate("2026-06-01T00:00:00Z")?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  },

  async receivable_ceiling_pauses_routes() {
    const { client, repositories } = createGovernanceFixture();
    const { fakeTable } = await import("../helpers/governanceFake");
    const merchant = fakeTable("merchant").find((row) => row.id === "merchant-1");
    if (!merchant) {
      throw new Error("The governance fixture lost its merchant");
    }
    merchant.commissionReceivableCeiling = new Decimal(100);

    const overCeiling = createFakeRepositories({
      merchants: {
        findMerchantById: repositories.merchants.findMerchantById,
        getCommissionReceivableBalance: async () => moneyFromDecimal("150.0000"),
      },
    });
    const evaluation = await evaluateCommissionReceivableCeiling(
      { repositories: overCeiling },
      client as never,
      "merchant-1",
      "PLATFORM_CLEARING",
    );
    expect(evaluation.decision).toBe("PAUSE");
    expect(evaluation.reason).toBe("CEILING_EXCEEDED_PAUSE");
    expect(evaluation.exceeded).toBe(true);

    const fixture = createGuardFixture({
      merchant: merchantRow({ commissionReceivableCeiling: new Decimal(100) }),
    });
    const guardRepositories = {
      ...fixture.repositories,
      merchants: {
        ...fixture.repositories.merchants,
        getCommissionReceivableBalance: async () => moneyFromDecimal("150.0000"),
      },
    };
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: guardRepositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const decision = await guard.guard({
      linkKey: "link-key-1",
      railCode: "edfali",
      env: "SANDBOX",
      channel: "WEB",
      idempotencyKey: "idem-ceiling-1",
    });
    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons).toContain("CEILING_EXCEEDED_PAUSE");
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
  },

  async pre_send_failure_fails_over() {
    const failing: Executor = (step) => ({
      stepId: step.id,
      status: "FAILED",
      canonicalError: "GATEWAY_UNREACHABLE",
      output: { state: {}, public: {} },
      logs: [],
    });
    const harness = createEngineHarness({
      attempt: { status: "CREATED" },
      steps: { INITIATE: [{ id: "initiate", type: "HTTP", side_effect: "READ_ONLY", point_of_no_return: false }] },
      executor: failing,
    });
    const result = await harness.engine.initiate(harness.attempt, {});
    expect(result.status).toBe("FAILED");
    expect(harness.released).toEqual(["attempt-1"]);
    const fallback = visibleRails({
      routes: [
        { ...route, id: "route-primary", healthState: "OPEN_BREAKER" },
        { ...route, id: "route-fallback", gatewayId: "gw-2", priority: 5 },
      ],
      credentialSets: [credentialSet, { ...credentialSet, id: "cred-2", gatewayId: "gw-2" }],
    });
    expect(fallback.rails[0]?.routes.map((entry) => entry.route.id)).toEqual(["route-fallback"]);
  },

  async health_samples_drive_breaker() {
    for (const healthState of ["DEGRADED", "OPEN_BREAKER"] as const) {
      const result = visibleRails({ routes: [{ ...route, healthState }] });
      expect(result.rails).toHaveLength(0);
      expect(result.excluded[0]?.reason).toBe("ROUTE_NOT_HEALTHY");
    }
  },

  async maintenance_window_hides_route() {
    const result = visibleRails({
      routes: [{
        ...route,
        maintenanceWindows: [{ start: new Date("2026-06-01T00:00:00.000Z"), end: new Date("2026-06-02T00:00:00.000Z") }],
      }],
      now: new Date("2026-06-01T12:00:00.000Z"),
    });
    expect(result.rails).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("MAINTENANCE_WINDOW");
  },

  async draining_then_retired() {
    const draining = visibleRails({ routes: [{ ...route, status: "DRAINING" }] });
    expect(draining.rails).toHaveLength(0);
    expect(draining.excluded[0]?.reason).toBe("ROUTE_NOT_ACTIVE");
    const paused = visibleRails({ routes: [{ ...route, status: "PAUSED" }] });
    expect(paused.rails).toHaveLength(0);
  },

  async breaker_removes_rail() {
    const result = visibleRails({ routes: [{ ...route, healthState: "OPEN_BREAKER" }] });
    expect(result.rails).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("ROUTE_NOT_HEALTHY");
  },

  async route_level_breaker_isolation() {
    const result = visibleRails({
      routes: [
        { ...route, id: "route-1", gatewayId: "gw-1", healthState: "OPEN_BREAKER" },
        { ...route, id: "route-2", gatewayId: "gw-2" },
      ],
      credentialSets: [credentialSet, { ...credentialSet, id: "cred-2", gatewayId: "gw-2" }],
    });
    expect(result.rails[0]?.routes.map((entry) => entry.route.id)).toEqual(["route-2"]);
  },

  async shared_attempt_group() {
    const fixture = createGuardFixture();
    const groups = new Map<string, string>();
    const db = {
      ...(fixture.db as unknown as Record<string, unknown>),
      $transaction: async (callback: (tx: Tx) => Promise<unknown>) => {
        const tx = {
          ...(fixture.db as unknown as Record<string, unknown>),
          attemptGroup: {
            upsert: async (args: { where: { linkId_customerFingerprint: { linkId: string; customerFingerprint: string } } }) => {
              const key = `${args.where.linkId_customerFingerprint.linkId}:${args.where.linkId_customerFingerprint.customerFingerprint}`;
              const existing = groups.get(key);
              if (existing) {
                return { id: existing };
              }
              const id = `group-${groups.size + 1}`;
              groups.set(key, id);
              return { id };
            },
          },
        };
        return callback(tx as unknown as Tx);
      },
    } as unknown as PrismaLike;
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const request = {
      linkKey: "link-key-1",
      railCode: "edfali",
      env: "SANDBOX" as const,
      channel: "WEB" as const,
      customer: { deviceFingerprint: "device-1", phone: "0912345678", ip: "203.0.113.9" },
      idempotencyKey: "idem-group-1",
    };
    const first = await guard.guard(request);
    const second = await guard.guard({ ...request, idempotencyKey: "idem-group-2" });
    const attempts = fixture.state.createdAttempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.attemptGroupId).toBe(attempts[1]?.attemptGroupId);
    expect(first.attemptId).not.toBe(second.attemptId);
  },

  async rate_limit_not_breaker() {
    const consumer = new ApiConsumer({
      gatewayId: "gw-1",
      env: "SANDBOX",
      credentialSetId: "cred-1",
      allowedHosts: ["gateway.example.com"],
      auth: { method: "NONE" },
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    });
    try {
      await consumer.request({ method: "GET", url: "https://gateway.example.com/pay" });
      throw new Error("Expected a rate limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiConsumerError);
      expect((error as ApiConsumerError).status).toBe(429);
      expect((error as ApiConsumerError).retryable).toBe(false);
    }
    const source = readSource("api/internal/admin.ts");
    expect(source).toContain("countsTowardBreaker: z.boolean().default(false)");
  },

  async missing_output_unknown() {
    const executor = new StepExecutor({
      fetch: (async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const result = await executor.execute({
      id: "submit",
      type: "HTTP",
      method: "POST",
      url_template: "https://gw.example/confirm",
      side_effect: "MOVES_MONEY",
      retry_policy: "NEVER",
      outputs: [{ name: "transaction_id", selector: "transaction_id", store_as: "STATE", required: true }],
    }, {});
    expect(result.status).toBe("UNKNOWN");
    expect(result.rawText).toContain("ok");
  },

  async daily_cap_excludes_route() {
    const result = visibleRails({
      routes: [{ ...route, dailyCapAmount: "100000.0000", dailyProcessedAmount: "99990.0000" }],
      link: { amount: "20.0000", currency: "LYD", railWhitelist: null },
    });
    expect(result.rails).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("DAILY_CAP_EXCEEDED");
  },
  async credential_check_on_save() {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      credentialSet: {
        findUnique: async () => ({
          id: "cred-1",
          gatewayId: "gw-1",
          env: "SANDBOX",
          entriesCiphertext: [],
          status: "UNTESTED",
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
      gateway: { findUnique: async () => ({ id: "gw-1", activeVersionId: "version-1" }) },
      gatewayVersion: {
        findUnique: async () => ({ id: "version-1" }),
        findFirst: async () => ({ id: "version-1" }),
      },
      gatewayEnvironment: { findFirst: async () => ({ baseUrls: { api: "https://gateway.example.com" } }) },
    } as unknown as PrismaLike;
    const credentialCheck = new CredentialCheckService({
      db,
      vault: vaultWith(),
      consumerRegistry: {
        getConsumer: async () => {
          throw new Error("The gateway alias was not recognised");
        },
      } as never,
      stepExecutor: {} as never,
      flowProvider: { getCredentialCheckSteps: async () => [] } as never,
    });
    const result = await credentialCheck.verify("cred-1");
    expect(result.status).toBe("FAILING");
    expect(updates[0]?.status).toBe("FAILING");
  },

  async failing_credentials_hide_routes() {
    const result = visibleRails({ credentialSets: [{ ...credentialSet, status: "FAILING" }] });
    expect(result.rails).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("NO_VERIFIED_CREDENTIAL_SET");
  },

  async secret_version_overlap() {
    const harness = createCallbackHarness({
      secrets: [
        { key: "webhook", type: "HEADER", value: "old-secret", isSecret: false, secretVersion: 1 },
        { key: "webhook", type: "HEADER", value: "new-secret", isSecret: false, secretVersion: 2 },
      ],
    });
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({ reference: "PA-1", status: "00", amount: "100.0000", currency: "LYD", timestamp });
    for (const secret of ["old-secret", "new-secret"]) {
      const result = await verifier.verify(harness.channel.pathToken, {
        rawBody: Buffer.from(raw),
        headers: { "x-signature": signCallback(secret, raw) },
        sourceIp: "203.0.113.9",
      });
      expect(result.verified).toBe(true);
    }
  },

  async single_flight_refresh() {
    let tokenCalls = 0;
    const consumer = new ApiConsumer({
      gatewayId: "gw-1",
      env: "SANDBOX",
      credentialSetId: "cred-1",
      allowedHosts: ["gateway.example.com"],
      auth: {
        method: "OAUTH2_CLIENT_CREDENTIALS",
        token_endpoint: "https://gateway.example.com/oauth/token",
      },
      credentials: { clientId: "client", clientSecret: "secret" },
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async (url: string) => {
        if (String(url).includes("/oauth/token")) {
          tokenCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    const [a, b, c] = await Promise.all([consumer.refreshAuth(), consumer.refreshAuth(), consumer.refreshAuth()]);
    expect(tokenCalls).toBe(1);
    expect(a.accessToken).toBe("token-1");
    expect(b.accessToken).toBe("token-1");
    expect(c.accessToken).toBe("token-1");
  },

  async credential_set_uniqueness() {
    const sql = readMigrationSql();
    expect(sql).toContain("credential_sets_gateway_id_env_external_merchant_id_key");
    expect(sql).toContain("UNIQUE INDEX `credential_sets_gateway_id_env_external_merchant_id_key`(`gateway_id`, `env`, `external_merchant_id`)");
    const source = readSource("api/internal/admin.ts");
    expect(source).toContain('const PLATFORM_EXTERNAL_MERCHANT_ID = "PLATFORM"');
  },

  async ownership_migration_pinned() {
    let queried: Record<string, unknown> | undefined;
    const db = {
      paymentAttempt: {
        findUnique: async (args: { where: Record<string, unknown> }) => {
          queried = args.where;
          return {
            id: "attempt-1",
            reference: "PA-1",
            gatewayReference: "GW-1",
            status: "AWAITING_CUSTOMER",
            env: "LIVE",
            mode: "OTP_PULL",
            subMode: null,
            currency: "LYD",
            requestedAmount: "100.0000",
            surchargeAmount: "0.0000",
            totalChargedAmount: "100.0000",
            settledAmount: null,
            gatewayFeeAmount: null,
            providerReference: null,
            networkReference: null,
            otpAttempts: 0,
            expiresAt: null,
            contextCiphertext: "",
            customerFieldsMasked: {},
            routeId: "route-pinned",
            credentialSetId: "cred-pinned",
            gatewayVersionId: "version-pinned",
            commissionProfileId: "profile-pinned",
            settlementTarget: "PLATFORM_CLEARING",
            gatewayVersion: { gateway: { id: "gw-pinned", kind: "DIRECT" }, setting: null },
            route: { mismatchPolicy: { tolerance_amount: "0.0100" }, costModel: {} },
          };
        },
      },
    } as unknown as PrismaLike;
    const attempt = await new PrismaAttemptRepository(db).getAttempt("attempt-1");
    expect(queried).toEqual({ id: "attempt-1" });
    expect(attempt?.routeId).toBe("route-pinned");
    expect(attempt?.credentialSetId).toBe("cred-pinned");
    expect(attempt?.gatewayVersionId).toBe("version-pinned");
  },

  async suspension_blocks_new_attempts() {
    const fixture = createGuardFixture({ merchant: merchantRow({ status: "SUSPENDED" }) });
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const decision = await guard.guard({
      linkKey: "link-key-1",
      railCode: "edfali",
      env: "SANDBOX",
      channel: "WEB",
      idempotencyKey: "idem-suspended-1",
    });
    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons).toContain("MERCHANT_SUSPENDED");
    expect(fixture.state.slotDeltas).toEqual([]);
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
  },

  async credential_owner_assertion() {
    const merchantCredential: CredentialSetRecord = {
      ...credentialSet,
      id: "cred-other",
      ownerType: "MERCHANT",
      ownerMerchantId: "merchant-2",
    };
    const result = visibleRails({
      routes: [{ ...route, credentialPolicy: "MERCHANT_REQUIRED" }],
      credentialSets: [merchantCredential],
    });
    expect(result.rails).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("NO_VERIFIED_CREDENTIAL_SET");
  },

  async merchant_direct_aml_case() {
    const rule: AmlRuleDefinition = {
      ...baseAmountRule,
      id: "rule-direct",
      code: "MERCHANT_DIRECT_THRESHOLD",
      ruleType: "MERCHANT_DIRECT_AMOUNT",
      params: { min_amount: "10000.0000" },
    };
    const result = evaluateAmlRules([rule], {
      ...amlContext,
      settlementTarget: "MERCHANT_DIRECT",
    });
    expect(result.hits).toHaveLength(1);
    expect(result.effectiveAction).toBe("CASE_ONLY");
    expect(result.requiresHold).toBe(false);
  },

  async version_pinning() {
    const queried: Array<Record<string, unknown>> = [];
    const db = {
      flow: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          queried.push(args.where);
          return [{ id: "flow-1", railId: null, subMode: null }];
        },
      },
      flowStep: {
        findMany: async () => [{
          id: "step-1",
          type: "HTTP",
          orderIndex: 0,
          sideEffect: "READ_ONLY",
          retryPolicy: "NEVER",
          parameters: [],
          outputs: [],
        }],
      },
      statusRule: { findMany: async () => [] },
      gatewayEnvironment: { findMany: async () => [] },
    } as unknown as PrismaLike;
    const provider = new PrismaFlowProvider(db);
    const steps = await provider.getSteps("SUBMIT", makeAttempt({ gatewayVersionId: "version-pinned" }));
    expect(steps).toHaveLength(1);
    expect(queried[0]?.gatewayVersionId).toBe("version-pinned");
  },

  async rollback_version_named() {
    const validator = new GoLiveGateValidator();
    const withoutRollback = await validator.validate({ ...greenEvidence(), rollbackVersionId: null });
    expect(withoutRollback.failedGateIds).toContain("ROLLBACK_VERSION");
    const withRollback = await validator.validate({ ...greenEvidence(), rollbackVersionId: "version-0" });
    expect(withRollback.failedGateIds).not.toContain("ROLLBACK_VERSION");
  },

  async independent_draft_snapshots() {
    const { rows, client } = inMemoryApprovalClient();
    const service = new ApprovalService(client, {
      getCurrentVersion: async (_tx, request) => (request as unknown as { currentVersion?: number }).currentVersion ?? null,
    });
    const first = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      payloadDiff: [{ op: "replace", path: "/riskTier", value: "HIGH" }],
      baseVersion: 3,
    });
    const second = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-2",
      payloadDiff: [{ op: "replace", path: "/riskTier", value: "LOW" }],
      baseVersion: 4,
    });
    expect(first.baseVersion).toBe(3);
    expect(second.baseVersion).toBe(4);
    expect((first.payloadDiffJson as Array<{ value: string }>)[0]?.value).toBe("HIGH");
    expect((second.payloadDiffJson as Array<{ value: string }>)[0]?.value).toBe("LOW");
    rows.get(first.id)!.currentVersion = 4;
    await expectApiCode(service.approveRequest(first.id, "checker-1"), "BASE_VERSION_MISMATCH");
    rows.get(second.id)!.currentVersion = 4;
    const approved = await service.approveRequest(second.id, "checker-1");
    expect(approved.state).toBe("EXECUTED");
  },

  async sandbox_ledger_separation() {
    const { client, queries } = createLedgerClient();
    const poster = new LedgerPoster(client);
    const template = {
      refType: "PAYMENT_ATTEMPT",
      refId: "attempt-1",
      description: "sandbox confirmation",
      lines: [
        { direction: "DEBIT" as const, amount: "100.0000", account: { accountType: "GATEWAY_CLEARING" as const } },
        { direction: "CREDIT" as const, amount: "100.0000", account: { accountType: "MERCHANT_WALLET" as const } },
      ],
    };
    await poster.post(template, {
      merchantId: "merchant-1",
      gatewayId: "gw-1",
      credentialSetId: "cred-1",
      env: "SANDBOX",
      currency: "LYD",
    });
    const clearingQuery = queries.find((where) => where.accountType === "GATEWAY_CLEARING");
    expect(clearingQuery?.env).toBe("SANDBOX");
    expect(clearingQuery?.gatewayId).toBe("gw-1");
    expect(clearingQuery?.credentialSetId).toBe("cred-1");
  },

  async reference_format_enforced() {
    const blueprint = BLUEPRINT_CATALOG.find((entry) => entry.gatewayCodes.includes("moamalat"));
    const setting = blueprint?.gateways.find((gateway) => gateway.code === "moamalat")?.settings;
    expect(setting?.referenceFormat.pattern).toBeTruthy();
    const db = {
      credentialSet: { findUnique: async () => null },
      cryptoProfile: { findFirst: async () => null },
    } as unknown as PrismaLike;
    const registry = createComputeRegistry({ db });
    const output = await registry.MOAMALAT_LIGHTBOX_PAYLOAD!(undefined, {
      attempt: {
        reference: "PA-12345678",
        gatewayReference: "GW-12345678",
        totalChargedAmount: "76.255",
        currency: "LYD",
        gatewayVersionId: "version-1",
        credentialSetId: "cred-1",
      },
    });
    const reference = String((output as Record<string, unknown>).MerchantReference);
    expect(new RegExp(String(setting?.referenceFormat.pattern)).test(reference)).toBe(true);
    expect(new RegExp(String(setting?.referenceFormat.pattern)).test("bad")).toBe(false);
  },

  async gateway_alias_resolution() {
    const gateways = BLUEPRINT_CATALOG.flatMap((entry) => entry.gateways);
    const edfali = gateways.find((gateway) => gateway.code === "edfali");
    expect(edfali?.aliases.map((alias) => alias.toLowerCase())).toContain("adfali");
    expect(edfali?.aliases.map((alias) => alias.toLowerCase())).toContain("edfaa li");
    const moamalat = gateways.find((gateway) => gateway.code === "moamalat");
    expect(moamalat?.aliases).toContain("NPG");
  },

  async export_omits_secrets() {
    const records: Array<Record<string, unknown>> = [];
    const service = new DetailChangeService({
      detailChangeLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          records.push(args.data);
          return { id: `log-${records.length}`, ...args.data } as never;
        },
        findMany: async () => [],
      },
    }, { literalSecrets: ["old-secret-value", "new-secret-value"] }, vaultWith());
    await service.recordChange({
      entityType: "CREDENTIAL_SET",
      entityId: "cred-1",
      before: { secret: "old-secret-value" },
      after: { secret: "new-secret-value" },
      actorId: "admin-1",
      source: "ADMIN",
      requestId: "req-1",
    });
    expect(records[0]?.oldValue).not.toContain("old-secret-value");
    expect(records[0]?.newValue).not.toContain("new-secret-value");
  },

  async checker_substitution() {
    const { client } = inMemoryApprovalClient();
    const service = new ApprovalService(client);
    const request = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      payloadDiff: [{ op: "replace", path: "/riskTier", value: "HIGH" }],
    });
    const approved = await service.approveRequest(request.id, "checker-2");
    expect(approved.state).toBe("EXECUTED");
    const self = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      payloadDiff: [{ op: "replace", path: "/riskTier", value: "LOW" }],
    });
    await expectApiCode(service.approveRequest(self.id, "maker-1"), "MAKER_CHECKER_SEPARATION");
    await expectApiCode(service.approveRequest(self.id, SYSTEM_AUTOMATION), "SYSTEM_AUTOMATION_CANNOT_CHECK");
  },

  async config_export_redacted() {
    const vault = vaultWith();
    const redacted = vault.redactPayload(
      { token: "abc123", nested: { password: "hunter2" }, note: "literal-secret-value" },
      ["literal-secret-value"],
    ) as Record<string, unknown>;
    expect(redacted.token).toBe(REDACTED_VALUE);
    expect(redacted.nested).toEqual({ password: REDACTED_VALUE });
    expect(redacted.note).toBe(REDACTED_VALUE);
  },

  async operator_case_sla() {
    const now = new Date("2026-06-01T00:00:00Z");
    const cases: Array<Record<string, unknown>> = [];
    const { db } = createRecordingDb({
      queryRows: [{
        id: "event-1",
        channelId: "channel-1",
        gatewayId: "gateway-1",
        env: "LIVE",
        verified: true,
        dedupeKey: "dedupe-1",
        attemptId: "attempt-1",
        processedAt: null,
        processingResult: null,
        receivedAt: now,
      }],
    });
    const worker = new InboundInboxWorker({
      db,
      repositories: createFakeRepositories({
        risk: {
          createOperatorCase: async (_tx, data) => {
            cases.push(data as unknown as Record<string, unknown>);
            return {} as never;
          },
        },
      }),
      clock: () => now,
      handler: {
        handle: async () => {
          throw new Error("permanent processing failure");
        },
      },
    });
    await worker.runOnce();
    expect(cases[0]?.priority).toBe("P2");
    expect((cases[0]?.slaDueAt as Date).getTime() - now.getTime()).toBe(4 * 60 * 60 * 1000);
    expect(slaDueAt("CRITICAL", now).getTime() - now.getTime()).toBe(4 * 60 * 60 * 1000);
  },

  async native_adapter_contract() {
    const registry = new NativeAdapterRegistry();
    const result = {
      attempt: { id: "a", status: "CREATED" as const, env: "SANDBOX", currency: "LYD", requestedAmount: "1", totalChargedAmount: "1" },
      status: "CREATED" as const,
      outputs: {},
    };
    const adapter: NativeAdapter = {
      preInitiate: async () => result,
      initiate: async () => result,
      confirm: async () => result,
      verifyCallback: async () => result,
      inquire: async () => result,
      refund: async () => result,
    };
    const unregister = registry.register("mock", adapter);
    expect(registry.require("mock")).toBe(adapter);
    unregister();
    expect(registry.has("mock")).toBe(false);
    expect(() => registry.require("mock")).toThrow();
  },

  async soft_delete_only() {
    const sql = readMigrationSql();
    expect(sql).toMatch(/payment_attempts_rail_id_fkey[^;]*ON DELETE RESTRICT/);
    expect(sql).toMatch(/payment_attempts_route_id_fkey[^;]*ON DELETE RESTRICT/);
    const blocked = visibleRails({ rails: [{ ...rail, blocked: true }] });
    expect(blocked.rails).toHaveLength(0);
    expect(blocked.excluded[0]?.reason).toBe("RAIL_BLOCKED");
  },

  async checkout_no_amount_field() {
    const app = express();
    app.use(express.json());
    app.use(checkoutInternalRouter);
    app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      response.status((error as ApiError).statusCode ?? 500).json(toErrorEnvelope(error));
    });
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      for (const payload of [
        { railCode: "edfali", formData: {}, idempotencyKey: "idem-0001", amount: "1.0000" },
        { railCode: "edfali", formData: {}, idempotencyKey: "idem-0002", currency: "LYD" },
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}/pay/LINKKEY123/initiate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await response.json() as Record<string, unknown>;
        expect(response.status).toBe(400);
        expect(body.code).toBe("INVALID_BODY");
      }
    } finally {
      server.close();
    }
  },

  async pan_memory_only() {
    const executor = new StepExecutor({
      fetch: (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
      panFieldNames: ["pan"],
    });
    const customerFields: Record<string, unknown> = { pan: Buffer.from("4111111111111111"), phone: "0912345678" };
    const panBuffer = customerFields.pan as Buffer;
    await executor.execute({
      id: "step-1",
      type: "HTTP",
      method: "POST",
      url_template: "https://gw.example/confirm",
      side_effect: "READ_ONLY",
      retry_policy: "NEVER",
    }, { customerFields });
    expect("pan" in customerFields).toBe(false);
    expect(panBuffer.every((byte) => byte === 0)).toBe(true);
  },

  async generic_error_message() {
    const envelope = toErrorEnvelope(new Error("ECONNRESET at gateway 10.0.0.1"));
    expect(envelope.code).toBe("SERVER_ERROR");
    expect(envelope.message).toBe("Internal server error");
    expect(JSON.stringify(envelope)).not.toContain("ECONNRESET");
    const api = toErrorEnvelope(new ApiError(400, "GATEWAY_003", "The request could not be processed"));
    expect(api.message).not.toContain("003");
  },

  async velocity_rule_atomic() {
    const fixture = createGuardFixture({
      velocityRules: [velocityRule({ maxCount: 2 })],
      attempts: [existingAttempt(), existingAttempt({ id: "attempt-existing-2" })],
    });
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const decision = await guard.guard({
      linkKey: "link-key-1",
      railCode: "edfali",
      env: "SANDBOX",
      channel: "WEB",
      idempotencyKey: "idem-velocity-1",
    });
    expect(decision.outcome).toBe("BLOCK");
    expect(decision.velocityRuleIds).toEqual(["velocity-1"]);
    expect(fixture.state.slotDeltas).toEqual([]);
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
  },

  async redirect_allowlist() {
    expect(validateFinalUrl("https://merchant.example/return", { allowedHosts: ["merchant.example"] })).toBeInstanceOf(URL);
    expect(() => validateFinalUrl("https://evil.example/steal", { allowedHosts: ["merchant.example"] })).toThrow();
    expect(() => compileUrl("https://merchant.example.evil.net/return", undefined, { allowedHosts: ["merchant.example"] })).toThrow();
  },

  async response_size_and_depth_cap() {
    const tooLarge = new ApiConsumer({
      gatewayId: "gw-1",
      env: "SANDBOX",
      credentialSetId: "cred-1",
      allowedHosts: ["gateway.example.com"],
      auth: { method: "NONE" },
      maxResponseBytes: 10,
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => new Response("x".repeat(100), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(tooLarge.request({ method: "GET", url: "https://gateway.example.com/pay" })).rejects.toThrow(/exceeds/);
    const tooDeep = new ApiConsumer({
      gatewayId: "gw-1",
      env: "SANDBOX",
      credentialSetId: "cred-1",
      allowedHosts: ["gateway.example.com"],
      auth: { method: "NONE" },
      maxJsonDepth: 2,
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => new Response(JSON.stringify({ a: { b: { c: { d: 1 } } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    });
    await expect(tooDeep.request({ method: "GET", url: "https://gateway.example.com/pay" })).rejects.toThrow(/depth/);
  },

  async injection_rejected() {
    expect(() => assertNoControlCharacters("value\r\nX-Injected: 1", "header")).toThrow();
    expect(() => compileUrl("https://gw.example/pay\r\nX-Injected: 1")).toThrow();
    expect(encodeForDestination("<script>", "XML")).toBe("&lt;script&gt;");
    expect(await pipeline.apply("<script>", [{ op: "xml_escape", args: [] }])).toBe("&lt;script&gt;");
  },

  async ssrf_dns_guard() {
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("169.254.169.254")).toBe(false);
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    const consumer = new ApiConsumer({
      gatewayId: "gw-1",
      env: "SANDBOX",
      credentialSetId: "cred-1",
      allowedHosts: ["gateway.example.com"],
      auth: { method: "NONE" },
      dnsLookup: async () => ["10.0.0.1"],
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(consumer.request({ method: "GET", url: "https://gateway.example.com/pay" })).rejects.toThrow(/non-public/);
  },

  async path_token_rotation() {
    const harness = createCallbackHarness();
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const unknown = await verifier.verify("moamalat/live/rotated-out", {
      rawBody: Buffer.from("{}"),
      headers: {},
      sourceIp: "203.0.113.9",
    });
    expect(unknown.verified).toBe(false);
    expect(unknown.reason).toBe("INBOUND_CHANNEL_UNKNOWN");
    const sql = readMigrationSql();
    expect(sql).toContain("confirmation_channels_path_token_key");
  },

  async four_eyes_for_sensitive_edits() {
    expect(() => assertCheckerIsNotMaker("user-1", "user-1")).toThrow();
    expect(() => assertCheckerIsNotMaker("user-1", "user-2")).not.toThrow();
    const { client } = inMemoryApprovalClient();
    const service = new ApprovalService(client);
    await expectApiCode(
      service.approveRequest("missing", SYSTEM_AUTOMATION),
      "SYSTEM_AUTOMATION_CANNOT_CHECK",
    );
    const sql = readMigrationSql();
    expect(sql).toContain("approval_requests_checker_not_maker");
    expect(sql).toContain("SIGNAL SQLSTATE '45000'");
  },

  async upload_magic_bytes() {
    const merchantSource = readSource("api/internal/merchant.ts");
    const adminSource = readSource("api/internal/admin.ts");
    expect(merchantSource).toContain('avStatus: "PENDING"');
    expect(merchantSource).toContain("x-upload-size");
    expect(merchantSource).toContain("assertUploadSignature(raw, declaredMime)");
    expect(adminSource).toContain("KIB_DOCUMENT_NOT_SCANNED");
    expect(adminSource).toContain('document.avStatus !== "CLEAN"');
    expect(adminSource).toContain("sizeBytes: z.number().int().min(1).max(2_000_000)");

    const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    let mismatch: ApiError | null = null;
    try {
      assertUploadSignature(peHeader, "application/pdf");
    } catch (error) {
      mismatch = error as ApiError;
    }
    expect(mismatch).not.toBeNull();
    expect(mismatch?.statusCode).toBe(415);
    expect(mismatch?.code).toBe("UPLOAD_SIGNATURE_MISMATCH");

    const pngDeclaredAsPdf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    let declaredMismatch: ApiError | null = null;
    try {
      assertUploadSignature(pngDeclaredAsPdf, "application/pdf");
    } catch (error) {
      declaredMismatch = error as ApiError;
    }
    expect(declaredMismatch?.code).toBe("UPLOAD_SIGNATURE_MISMATCH");
    expect((declaredMismatch?.details as { detected?: string } | undefined)?.detected).toBe("image/png");

    const realPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "utf8");
    expect(assertUploadSignature(realPdf, "application/pdf")).toBe("application/pdf");
  },

  async arabic_digit_normalisation() {
    const value = await pipeline.apply("٠٩١٢٣٤٥٦٧٨", [{ op: "arabic_digits_to_ascii", args: [] }]);
    expect(value).toBe("0912345678");
    expect(normalizeIdentifier("+218 91 234 5678")).toBe("+218912345678");
    expect(normalizeIdentifier("٠٩١ ٢٣٤ ٥٦٧٨")).toBe("0912345678");
  },

  async webview_redirect_fallback() {
    const fee = { commission: "0", payerSurcharge: "0", totalCharged: "100", merchantCredited: "100", feeBearer: "MERCHANT_ABSORBS" as const };
    const embedded = checkoutInternals.buildClientAction("EMBEDDED", {
      expiresAt: new Date("2026-06-01T00:15:00Z"),
      attemptReference: "PA-1",
      maskedPhone: "",
      railCode: "edfali",
      widget: {
        scriptUrls: ["https://cdn.example/sdk.js"],
        scriptSriHashes: [],
        configTemplate: { mid: "1" },
        allowedOrigins: ["https://gw.example"],
        iframeSandboxAttrs: ["allow-scripts"],
        sdkDriver: "lightbox",
      },
      redirect: null,
      instructionsAr: null,
      instructionsEn: null,
      fee,
    });
    expect(embedded.kind).toBe("RENDER_EMBEDDED");
    expect(embedded.sdk_driver).toBe("lightbox");
    const redirect = checkoutInternals.buildClientAction("REDIRECT", {
      expiresAt: new Date("2026-06-01T00:15:00Z"),
      attemptReference: "PA-1",
      maskedPhone: "",
      railCode: "edfali",
      widget: null,
      redirect: { method: "POST_FORM", urlSourceOutput: "", formFieldsOutput: "fields", target: "SAME_WINDOW", returnParamsMap: {} },
      instructionsAr: null,
      instructionsEn: null,
      fee,
    });
    expect(redirect.kind).toBe("HTTP_REDIRECT");
    expect(redirect.method).toBe("POST_FORM");
  },

  async bilingual_error_mapping() {
    const envelope = toErrorEnvelope(new Error("socket hang up"));
    expect(envelope.message).toBe("Internal server error");
    const source = readSource("api/internal/admin.ts");
    expect(source).toContain("customerMessageAr");
    expect(source).toContain("customerMessageEn");
    expect(source).toContain("TERMINAL_DECLINE");
  },

  async deep_link_qr_fallback() {
    const action = checkoutInternals.buildClientAction("QR_DISPLAY", {
      expiresAt: new Date("2026-06-01T00:15:00Z"),
      attemptReference: "PA-1",
      maskedPhone: "",
      railCode: "neompay_wallet",
      widget: null,
      redirect: null,
      instructionsAr: "امسح",
      instructionsEn: "Scan",
      fee: { commission: "0", payerSurcharge: "0", totalCharged: "100", merchantCredited: "100", feeBearer: "MERCHANT_ABSORBS" },
    });
    expect(action.kind).toBe("SHOW_QR_OR_CODE");
    expect(action.pay_code).toBe("PA-1");
    expect("qr_payload" in action).toBe(true);
    expect("deep_link_url" in action).toBe(true);
  },

  async cancel_releases_reservation() {
    const harness = createSlotHarness({ active_locked_count: 1 });
    const store = new PrismaSlotReservationStore(harness.client);
    await store.releaseSlot(makeAttempt({ linkId: harness.link.id }), "CUSTOMER_CANCELLED");
    const update = harness.statements.find((entry) => entry.sql.includes("active_locked_count = GREATEST"));
    expect(update?.sql).toContain("GREATEST(0, active_locked_count - 1)");
    expect(harness.link.active_locked_count).toBe(0);
  },

  async submit_idempotency() {
    let header: string | null = null;
    const executor = new StepExecutor({
      fetch: (async (_url: string, init: RequestInit) => {
        header = new Headers(init.headers).get("idempotency-key");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    await executor.execute({
      id: "step-1",
      type: "HTTP",
      method: "POST",
      url_template: "https://gw.example/pay",
      side_effect: "READ_ONLY",
      retry_policy: "NEVER",
      idempotency_config: { mode: "HEADER", key_name: "Idempotency-Key", source_template: "{attempt.reference}" },
    }, { attempt: { reference: "PA-1" } });
    expect(String(header)).toBe("PA-1");
    const sql = readMigrationSql();
    expect(sql).toContain("payment_attempts_link_id_idempotency_key_key");
  },

  async atomic_success_and_ledger() {
    const trusted: Executor = (step) => ({
      ...succeeded(step),
      response: { status: "SUCCESS", reference: "GW-1", amount: "100.0000", currency: "LYD", environment: "SANDBOX" },
    });
    const failing = createEngineHarness({
      executor: trusted,
      ledgerThrows: new Error("ledger unavailable"),
      transactionRunner: async (callback) => {
        const previous = failing.attempt.status;
        try {
          return await callback(undefined);
        } catch (error) {
          failing.attempt.status = previous;
          throw error;
        }
      },
    });
    await expect(failing.engine.confirm(failing.attempt, { otp: "1234" })).rejects.toThrow(/ledger unavailable/);
    expect(failing.attempt.status).not.toBe("SUCCEEDED");

    const calls: string[] = [];
    const success = createEngineHarness({
      executor: trusted,
      transactionRunner: async (callback) => {
        calls.push("begin");
        const result = await callback(undefined);
        calls.push("commit");
        return result;
      },
      ledger: { entry: { id: "entry-committed" } },
    });
    const result = await success.engine.confirm(success.attempt, { otp: "1234" });
    expect(result.status).toBe("SUCCEEDED");
    expect(success.attempt.ledgerEntryId).toBe("entry-committed");
    expect(calls).toEqual(["begin", "commit"]);
  },

  async notification_event_uniqueness() {
    const sql = readMigrationSql();
    expect(sql).toContain("notifications_event_id_key");
    let body = "";
    let signature = "";
    const transport = new WebhookNotificationTransport({
      url: "https://notify.example/send",
      secret: "secret",
      fetchImpl: async (_url, init) => {
        body = init.body;
        signature = init.headers[NOTIFICATION_SIGNATURE_HEADER] ?? "";
        return { ok: true, status: 200, text: async () => JSON.stringify({ messageId: "msg-1" }) };
      },
    });
    const result = await transport.deliver(
      {
        id: "notification-1",
        eventId: "event-1",
        channel: "SMS",
        lang: "EN",
        templateCode: "PAYMENT_CONFIRMED",
        payloadJson: {},
        status: "QUEUED",
        attempts: 0,
        addressMasked: "*******678",
      } as never,
      {
        subject: null,
        body: "Payment confirmed",
        templateCode: "PAYMENT_CONFIRMED",
        confidentialityClass: "PUBLIC",
        subjectTemplate: null,
        bodyTemplate: "Payment confirmed",
      },
    );
    expect(result.status).toBe("SENT");
    expect(JSON.parse(body).eventId).toBe("event-1");
    expect(signature.startsWith("sha256=")).toBe(true);
  },

  async tzdata_stability() {
    const instant = new Date("2026-01-15T09:00:00.000Z");
    expect(timezoneOffsetMs(instant, "Africa/Tripoli")).toBe(2 * 60 * 60 * 1000);
    expect(timezoneOffsetMs(instant, "Africa/Tripoli")).toBe(timezoneOffsetMs(instant, "Africa/Tripoli"));
    expect(timezoneOffsetMs(new Date("2026-07-01T12:00:00.000Z"), "Europe/London")).toBe(60 * 60 * 1000);
    expect(timezoneOffsetMs(new Date("2026-01-01T12:00:00.000Z"), "Europe/London")).toBe(0);
    const first = await pipeline.apply(instant, [{ op: "format_date", args: ["YYYY-MM-DD HH:mm", "Africa/Tripoli"] }]);
    const second = await pipeline.apply(instant, [{ op: "format_date", args: ["YYYY-MM-DD HH:mm", "Africa/Tripoli"] }]);
    expect(first).toBe(second);
    expect(first).toBe("2026-01-15 11:00");
  },

  async cluster_dedupe() {
    const sql = readMigrationSql();
    expect(sql).toContain("inbound_events_channel_id_dedupe_key_key");
    let stored = false;
    const { db, calls } = createRecordingDb({
      onQuery: () => (stored ? [{ id: "event-1" }] : []),
      onExecute: (rawSql) => {
        if (rawSql.includes("INSERT INTO inbound_events")) {
          stored = true;
        }
        return 1;
      },
    });
    const worker = new InboundInboxWorker({ db, repositories: createFakeRepositories({}) });
    const input = {
      channelId: "channel-1",
      gatewayId: "gateway-1",
      env: "LIVE",
      rawBody: "{}",
      headers: {},
      sourceIp: null,
      verified: true,
      verificationError: null,
      dedupeKey: "same-key",
    };
    await worker.persistInboundEvent(input);
    await worker.persistInboundEvent(input);
    expect(calls.filter((call) => call.sql.includes("INSERT INTO inbound_events"))).toHaveLength(1);
  },

  async refund_locks_attempt() {
    const { client, context } = createGovernanceFixture();
    const { fakeTable } = await import("../helpers/governanceFake");
    seedAdjustment(client, {
      id: "refund-1",
      type: "REFUND",
      sourceAttemptId: "attempt-1",
      amount: new Decimal(100),
      state: "PENDING_REVIEW",
    });
    let seenState: string | undefined;
    const engine = {
      refund: async () => {
        const row = fakeTable("adjustment").find((entry) => entry.id === "refund-1");
        seenState = String(row?.state);
        return { status: "SUCCEEDED", attempt: { ownershipMode: "PLATFORM_CLEARING" } } as never;
      },
    };
    const result = await client.$transaction(async (tx) =>
      executeAdjustment({ ...context, engine }, tx as never, {
        adjustmentId: "refund-1",
        checkerUserId: "user-finance",
        checkerRole: "FINANCE",
      }),
    );
    expect(seenState).toBe("EXECUTING");
    expect(result.status).toBe("EXECUTED");
    const row = fakeTable("adjustment").find((entry) => entry.id === "refund-1");
    expect(row?.state).toBe("EXECUTED");
  },

  async statement_schema_drift() {
    const harness = createReconciliationHarness({
      parserConfig: {
        format: "CSV",
        headerRow: true,
        columnsMap: {
          ourReference: "our_reference",
          providerReference: "provider_reference",
          amount: "amount",
          fee: "fee",
          currency: "currency",
          occurredAt: "occurred_at",
          type: "type",
        },
        dateFormat: "YYYYMMDD",
      },
      attempts: [{ id: "attempt-1", reference: "PA-1", totalChargedAmount: "100.0000", settledAmount: "100.0000", status: "SUCCEEDED" }],
    });
    const ingestor = new StatementIngestor({ db: harness.db, repositories: harness.repositories });
    const reordered = [
      "amount,currency,our_reference,provider_reference,fee,occurred_at,type",
      "100.0000,LYD,PA-1,PROV-1,0.0000,20260601,PAYMENT",
    ].join("\n");
    const result = await ingestor.ingest({ statementSourceId: "source-1", content: reordered });
    expect(result.matched).toBe(1);
    expect(result.amountMismatch).toBe(0);
  },

  async invalidation_bus_evicts() {
    const bus = new InvalidationBus();
    const events: unknown[] = [];
    bus.subscribe("gateway", (payload) => {
      events.push(payload);
    });
    bus.publish("gateway", { gatewayId: "gw-1" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { gatewayId: "gw-1" } });
  },

  async inbox_backlog_drain() {
    const { db, calls } = createRecordingDb({
      queryRows: [{
        id: "event-1",
        channelId: "channel-1",
        gatewayId: "gateway-1",
        env: "LIVE",
        verified: true,
        dedupeKey: "dedupe-1",
        attemptId: "attempt-1",
        processedAt: null,
        processingResult: "RETRY(4):temporary",
        receivedAt: new Date(),
      }],
    });
    const cases: unknown[] = [];
    const worker = new InboundInboxWorker({
      db,
      repositories: createFakeRepositories({
        risk: {
          createOperatorCase: async (_tx, data) => {
            cases.push(data);
            return {} as never;
          },
        },
      }),
      maxAttempts: 5,
      handler: {
        handle: async () => {
          throw new RetryableInboundError("temporary failure");
        },
      },
    });
    await worker.runOnce();
    const update = calls.find((call) => call.kind === "execute" && call.sql.includes("UPDATE inbound_events"));
    expect(update?.sql).toContain("processed_at = ?");
    expect(String(update?.args[1])).toContain("FAILED(5)");
    expect(cases).toHaveLength(1);
    expect(calls.find((call) => call.kind === "query")?.args).toContain(50);
  },

  async pos_reconnect_replay() {
    const source = readSource("api/internal/merchant.ts");
    expect(source).toContain("event: attempts");
    expect(source).toContain("paymentAttempt.findMany");
    expect(source).toContain("lastActiveAt");
    expect(source).toContain("15 * 60 * 1000");
  },
  async timestamp_tolerance_alert() {
    const harness = createCallbackHarness({ channel: { timestampToleranceSec: 30 } });
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const raw = JSON.stringify({ reference: "PA-1", status: "00", timestamp: Math.floor(Date.now() / 1000) - 120 });
    const result = await verifier.verify(harness.channel.pathToken, {
      rawBody: Buffer.from(raw),
      headers: { "x-signature": signCallback("secret", raw) },
      sourceIp: "203.0.113.9",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("INBOUND_TIMESTAMP_OUTSIDE_WINDOW");
  },

  async qr_binds_attempt_reference() {
    const registry = createComputeRegistry({ db: {} as PrismaLike });
    const expiresAt = new Date("2026-06-01T00:10:00Z");
    const context = {
      attempt: { id: "attempt-1", reference: "PA-1", gatewayReference: "GW-1", expiresAt, currency: "LYD" },
    };
    const first = await registry.NEOMPAY_QR_PAYLOAD!(undefined, context) as Record<string, unknown>;
    const second = await registry.NEOMPAY_QR_PAYLOAD!(undefined, context) as Record<string, unknown>;
    expect(String(first.qr_payload)).toContain("ref=GW-1");
    expect(String(first.qr_payload)).toContain(`exp=${Math.floor(expiresAt.getTime() / 1000)}`);
    expect(first.request_id).not.toBe(second.request_id);
  },

  async rolling_deploy_version_pinning() {
    const queried: Array<Record<string, unknown>> = [];
    const db = {
      flow: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          queried.push(args.where);
          return [{ id: "flow-1", railId: null, subMode: null }];
        },
      },
      flowStep: { findMany: async () => [] },
      statusRule: { findMany: async () => [] },
      gatewayEnvironment: { findMany: async () => [] },
    } as unknown as PrismaLike;
    const provider = new PrismaFlowProvider(db);
    await provider.getSteps("SUBMIT", makeAttempt({ gatewayVersionId: "version-old" }));
    await provider.getSteps("SUBMIT", makeAttempt({ gatewayVersionId: "version-new" }));
    expect(queried.map((where) => where.gatewayVersionId)).toEqual(["version-old", "version-new"]);
  },

  async in_flight_attempts_finish() {
    const db = {
      paymentAttempt: {
        findUnique: async () => ({
          id: "attempt-1",
          reference: "PA-1",
          status: "AWAITING_CUSTOMER",
          env: "LIVE",
          mode: "OTP_PULL",
          currency: "LYD",
          requestedAmount: "100.0000",
          surchargeAmount: "0.0000",
          totalChargedAmount: "100.0000",
          settledAmount: null,
          gatewayFeeAmount: null,
          otpAttempts: 0,
          expiresAt: null,
          contextCiphertext: "",
          customerFieldsMasked: {},
          routeId: "route-pinned",
          credentialSetId: "cred-pinned",
          gatewayVersionId: "version-pinned",
          commissionProfileId: "profile-pinned",
          gatewayVersion: { gateway: { id: "gw-pinned", kind: "DIRECT" }, setting: null },
          route: { mismatchPolicy: {}, costModel: {} },
        }),
      },
    } as unknown as PrismaLike;
    const attempt = await new PrismaAttemptRepository(db).getAttempt("attempt-1");
    expect(attempt?.routeId).toBe("route-pinned");
    expect(attempt?.credentialSetId).toBe("cred-pinned");
  },

  async checkpoint_row_lock() {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    let lockHeld = false;
    let lineReadAfterLock = false;
    const checkpoint = new CheckpointService({
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        statements.push({ sql, args });
        lockHeld = true;
        return [{ id: "acc-1", accountType: "GATEWAY_CLEARING", checkpointBalance: "0", checkpointAt: null }];
      },
      glAccount: {
        findUnique: async () => ({ id: "acc-1", accountType: "GATEWAY_CLEARING", checkpointBalance: "0", checkpointAt: null }),
        findMany: async () => [],
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ id: args.where.id, accountType: "GATEWAY_CLEARING", ...args.data }),
      },
      journalLine: {
        findMany: async () => {
          statements.push({ sql: "journalLine.findMany", args: ["acc-1"] });
          lineReadAfterLock = lockHeld;
          return [{ id: "line-1", entryId: "e1", glAccountId: "acc-1", direction: "DEBIT", amount: "10" }];
        },
      },
      journalEntry: { findFirst: async () => ({ id: "entry-1" }) },
    });
    const record = await checkpoint.captureCheckpoint("acc-1");
    expect(decimal(record.balance).toFixed(4)).toBe("10.0000");

    const lockIndex = statements.findIndex((entry) => entry.sql.includes("FOR UPDATE"));
    const linesIndex = statements.findIndex((entry) => entry.sql === "journalLine.findMany");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(linesIndex).toBeGreaterThan(lockIndex);
    expect(lineReadAfterLock).toBe(true);
    const lock = statements[lockIndex];
    expect(lock?.sql).toContain("SELECT * FROM `gl_accounts` WHERE `id` = ? FOR UPDATE");
    expect(lock?.args).toEqual(["acc-1"]);
  },

  async cashout_destination_snapshot() {
    const source = readSource("api/internal/merchant.ts");
    expect(source).toContain("destinationBankJson: json(body.destinationBank)");
    const sql = readMigrationSql();
    expect(sql).toContain("`destination_bank_json`");
  },

  async alias_capability_probe() {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      credentialSet: {
        findUnique: async () => ({
          id: "cred-1",
          gatewayId: "gw-1",
          env: "LIVE",
          entriesCiphertext: [],
          status: "VERIFIED",
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
      gateway: { findUnique: async () => ({ id: "gw-1", activeVersionId: "version-1" }) },
      gatewayVersion: { findUnique: async () => ({ id: "version-1" }), findFirst: async () => ({ id: "version-1" }) },
      gatewayEnvironment: { findFirst: async () => ({ baseUrls: { api: "https://gateway.example.com" } }) },
    } as unknown as PrismaLike;
    const credentialCheck = new CredentialCheckService({
      db,
      vault: vaultWith(),
      consumerRegistry: {
        getConsumer: async () => {
          throw new Error("The underlying payment alias no longer exists");
        },
      } as never,
      stepExecutor: {} as never,
      flowProvider: { getCredentialCheckSteps: async () => [] } as never,
    });
    const result = await credentialCheck.verify("cred-1");
    expect(result.status).toBe("FAILING");
    expect(result.reason).toContain("alias");
    expect(updates[0]?.status).toBe("FAILING");
    const hidden = visibleRails({ credentialSets: [{ ...credentialSet, status: "FAILING" }] });
    expect(hidden.rails).toHaveLength(0);
  },

  async partial_refund_serialisation() {
    const { client, context } = createGovernanceFixture();
    const engine = {
      refund: async () => ({
        status: "SUCCEEDED",
        attempt: { ownershipMode: "PLATFORM_CLEARING" },
      }) as never,
    };
    seedAdjustment(client, {
      id: "refund-1",
      type: "REFUND",
      sourceAttemptId: "attempt-1",
      amount: new Decimal(60),
      state: "PENDING_REVIEW",
    });
    seedAdjustment(client, {
      id: "refund-2",
      type: "REFUND",
      sourceAttemptId: "attempt-1",
      amount: new Decimal(60),
      state: "PENDING_REVIEW",
    });
    const first = await client.$transaction(async (tx) =>
      executeAdjustment({ ...context, engine }, tx as never, {
        adjustmentId: "refund-1",
        checkerUserId: "user-finance",
        checkerRole: "FINANCE",
      }),
    );
    expect(first.status).toBe("EXECUTED");

    await expectApiCode(
      client.$transaction(async (tx) =>
        executeAdjustment({ ...context, engine }, tx as never, {
          adjustmentId: "refund-2",
          checkerUserId: "user-finance",
          checkerRole: "FINANCE",
        }),
      ),
      "REFUND_EXCEEDS_SETTLED_AMOUNT",
    );
    const { fakeTable } = await import("../helpers/governanceFake");
    const second = fakeTable("adjustment").find((row) => row.id === "refund-2");
    expect(second?.state).toBe("PENDING_REVIEW");
    expect(fakeTable("adjustment").filter((row) => row.type === "REFUND" && row.state === "EXECUTED")).toHaveLength(1);
  },

  async provider_reference_collision_scope() {
    const harness = createCallbackHarness();
    const verifier = new PrismaCallbackVerifier(harness.client, vaultWith());
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({ reference: "PA-1", provider_reference: "PROV-1", status: "00", amount: "100.0000", currency: "LYD", timestamp });
    const result = await verifier.verify(harness.channel.pathToken, {
      rawBody: Buffer.from(raw),
      headers: { "x-signature": signCallback("secret", raw) },
      sourceIp: "203.0.113.9",
    });
    expect(result.verified).toBe(true);
    const attemptQuery = harness.queries.find((query) => Array.isArray((query as { where?: { OR?: unknown } }).where?.OR)) as { where: { OR: Array<Record<string, unknown>> } } | undefined;
    expect(attemptQuery?.where.OR[0]).toEqual({ reference: "PA-1" });
    expect(attemptQuery?.where.OR.some((branch) => "providerReference" in branch)).toBe(true);
  },

  async outage_releases_reservations() {
    const releases: string[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const { db, calls } = createRecordingDb({
      queryRows: [{ id: "attempt-1", status: "AWAITING_CUSTOMER", expires_at: new Date("2026-05-31T00:00:00Z"), terminal_at: null, link_id: "link-1" }],
      onExecute: () => 1,
    });
    const worker = new ExpirySweeperWorker({
      db,
      repositories: createFakeRepositories({
        payments: {
          updateAttempt: async (_tx, _id, patch) => {
            patches.push(patch);
            return {} as never;
          },
          updateLinkSlotCount: async (_tx, linkId, delta) => {
            expect(delta).toBe(-1);
            releases.push(linkId);
          },
        },
      }),
      clock: () => new Date("2026-06-01T00:00:00Z"),
    });
    await worker.runOnce();
    expect(releases).toEqual(["link-1"]);
    const update = calls.find((call) => call.kind === "execute" && call.sql.includes("terminal_at IS NULL"));
    expect(update?.args[0]).toBe("EXPIRED");
    expect(update).toBeDefined();
  },

  async join_request_expiry() {
    const now = new Date("2026-06-01T00:00:00Z");
    const ttl = DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS;
    expect(ttl).toBe(30 * 24 * 60 * 60 * 1000);
    const rows: Array<{
      id: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      slaDueAt?: Date;
    }> = [
      {
        id: "draft-old",
        status: "DRAFT",
        createdAt: new Date(now.getTime() - ttl - 86_400_000),
        updatedAt: new Date(now.getTime() - ttl - 86_400_000),
      },
      {
        id: "draft-recent",
        status: "DRAFT",
        createdAt: new Date(now.getTime() - 86_400_000),
        updatedAt: new Date(now.getTime() - 86_400_000),
      },
      {
        id: "review-overdue",
        status: "IN_REVIEW",
        createdAt: new Date(now.getTime() - 10 * 86_400_000),
        updatedAt: new Date(now.getTime() - 86_400_000),
        slaDueAt: new Date(now.getTime() - 86_400_000),
      },
      {
        id: "review-on-time",
        status: "IN_REVIEW",
        createdAt: new Date(now.getTime() - 86_400_000),
        updatedAt: new Date(now.getTime() - 86_400_000),
        slaDueAt: new Date(now.getTime() + 86_400_000),
      },
    ];
    const { db, calls } = createRecordingDb({
      onQuery: (sql) => {
        if (sql.includes("FROM `join_requests`") && sql.includes("`sla_due_at` <= ?")) {
          return rows
            .filter(
              (row) =>
                ["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED"].includes(row.status)
                && row.slaDueAt !== undefined
                && row.slaDueAt.getTime() <= now.getTime(),
            )
            .map((row) => ({ id: row.id }));
        }
        return [];
      },
      onExecute: (sql, args) => {
        if (sql.includes("`status` = 'DRAFT'") && sql.includes("`status` = 'EXPIRED'")) {
          const cutoff = args[2] as Date;
          let expired = 0;
          for (const row of rows) {
            if (
              row.status === "DRAFT"
              && row.createdAt.getTime() < cutoff.getTime()
              && row.updatedAt.getTime() < cutoff.getTime()
            ) {
              row.status = "EXPIRED";
              expired += 1;
            }
          }
          return expired;
        }
        if (sql.includes("WHERE `id` = ?")) {
          const id = args[1] as string;
          const row = rows.find((entry) => entry.id === id);
          if (row && ["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED"].includes(row.status)) {
            row.status = "EXPIRED";
            return 1;
          }
        }
        return 0;
      },
    });
    const worker = new JoinRequestExpiryWorker({
      db,
      repositories: createFakeRepositories({}),
      clock: () => now,
      draftTtlMs: ttl,
    });
    await worker.runOnce();

    expect(rows.find((row) => row.id === "draft-old")?.status).toBe("EXPIRED");
    expect(rows.find((row) => row.id === "review-overdue")?.status).toBe("EXPIRED");
    expect(rows.find((row) => row.id === "draft-recent")?.status).toBe("DRAFT");
    expect(rows.find((row) => row.id === "review-on-time")?.status).toBe("IN_REVIEW");

    const draftUpdate = calls.find(
      (call) => call.kind === "execute" && call.sql.includes("`status` = 'DRAFT'"),
    );
    expect(draftUpdate?.sql).toContain("UPDATE `join_requests` SET `status` = 'EXPIRED'");
    expect((draftUpdate?.args[1] as Date).getTime()).toBe(now.getTime() - ttl);
    const overdueUpdate = calls.find(
      (call) => call.kind === "execute" && call.sql.includes("WHERE `id` = ?") && call.args[1] === "review-overdue",
    );
    expect(overdueUpdate).toBeDefined();
    expect(readMigrationSql()).toContain("'EXPIRED'");
  },

  async no_autolink_unverified_email() {
    const app = express();
    app.use(express.json());
    app.use(merchantInternalRouter);
    app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      response.status((error as ApiError).statusCode ?? 500).json(toErrorEnvelope(error));
    });
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/auth/google`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: "x".repeat(30) }),
      });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(501);
      expect(body.code).toBe("GOOGLE_IDENTITY_NOT_CONFIGURED");
    } finally {
      server.close();
    }
  },

  async duplicate_applicant_detection() {
    let captured: Record<string, unknown> | undefined;
    const tx = {
      merchant: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          captured = args.where;
          return [{ id: "merchant-old", taxId: "T-1", registrationNo: "R-1" }];
        },
      },
    } as unknown as Tx;
    const repositories = new PrismaRepositories({} as never);
    const matches = await repositories.merchants.findMerchantsByDuplicateSignals(tx, {
      taxId: "T-1",
      registrationNo: "R-1",
      contactPhone: "0912345678",
      contactEmail: "owner@example.com",
    });
    expect(matches).toHaveLength(1);
    const or = captured?.OR as Array<Record<string, unknown>>;
    expect(or.map((branch) => Object.keys(branch)[0])).toEqual([
      "taxId",
      "registrationNo",
      "contactPhone",
      "contactEmail",
    ]);
  },

  async maker_barred_from_deciding() {
    const { computeFourEyesDecision, resolveFourEyesSetting } = await import("../../api/internal/merchant");
    const setting = resolveFourEyesSetting([{ policy: "RISK_BASED" }]);
    const risky = computeFourEyesDecision({
      riskTier: "HIGH",
      screeningResult: "CLEAR",
      screeningListTypes: [],
      owners: [],
      businessCategory: null,
      previouslyRejected: false,
    }, setting);
    expect(risky.required).toBe(true);
    expect(risky.reasons).toContain("RISK_TIER_HIGH");
    const clean = computeFourEyesDecision({
      riskTier: "STANDARD",
      screeningResult: "CLEAR",
      screeningListTypes: [],
      owners: [],
      businessCategory: null,
      previouslyRejected: false,
    }, setting);
    expect(clean.required).toBe(false);
  },

  async document_hash_dedupe() {
    let captured: Record<string, unknown> | undefined;
    const tx = {
      kybDocument: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          captured = args.where;
          return [
            { id: "doc-1", merchantId: "merchant-1", sha256: "abc" },
            { id: "doc-2", merchantId: "merchant-2", sha256: "abc" },
          ];
        },
      },
    } as unknown as Tx;
    const repositories = new PrismaRepositories({} as never);
    const documents = await repositories.onboarding.findKybDocumentsBySha256(tx, "abc");
    expect(captured).toEqual({ sha256: "abc" });
    expect(documents).toHaveLength(2);
    expect(new Set(documents.map((document) => document.merchantId)).size).toBe(2);
  },

  async owner_change_rescreens() {
    const state = (await import("../helpers/fakeRepositories")).createScreeningState();
    state.merchants.push(merchantRow());
    const repositories = (await import("../helpers/fakeRepositories")).createScreeningRepositories(state);
    const service = new MerchantScreeningService({
      repositories,
      screening: new MockScreeningProvider({ result: "CLEAR" }),
      clock: () => new Date("2026-06-01T00:00:00Z"),
    });
    const report = await service.screenMerchant({} as never, {
      merchantId: "merchant-1",
      trigger: "OWNER_CHANGE",
      subjects: [{
        subjectType: "BENEFICIAL_OWNER",
        subjectId: "owner-1",
        names: ["محمد الشريف"],
        identifier: "123456789012",
      }],
    });
    expect(report.outcomes).toHaveLength(1);
    expect(state.screenings[0]?.trigger).toBe("OWNER_CHANGE");
    expect(state.screenings[0]?.subjectId).toBe("owner-1");
  },

  async arabic_name_normalisation() {
    const normalized = normalizeArabicName("مُحَمَّد ٱلشَّرِيف");
    expect(normalized).toBe("محمد الشريف");
    expect(nameSimilarity("محمد الشريف", "محمد الشريف")).toBe(100);
    expect(nameSimilarity("محمد الشريف", "محمد الشریف")).toBeGreaterThanOrEqual(75);
  },

  async list_update_case() {
    const provider = new InternalWatchlistProvider({ entries: [], listVersions: { INTERNAL_WATCHLIST: "v1" } });
    const cached = new CachedScreeningProvider(provider);
    const subject = { subjectType: "MERCHANT" as const, subjectId: "merchant-1", names: ["محمد الشريف"] };
    expect(cached.screenLocal(subject).result).toBe("CLEAR");
    publishWatchlist(cached, {
      version: "v2",
      entries: [{
        entryRef: "WL-1",
        listType: "SANCTIONS",
        listName: "Internal sanctions",
        names: ["محمد الشريف"],
      }],
    });
    const hit = cached.screenLocal(subject);
    expect(hit.result).toBe("CONFIRMED_MATCH");
    expect(hit.matches[0]?.listEntryRef).toBe("WL-1");
    const state = (await import("../helpers/fakeRepositories")).createScreeningState();
    state.merchants.push(merchantRow());
    const repositories = (await import("../helpers/fakeRepositories")).createScreeningRepositories(state);
    const service = new MerchantScreeningService({
      repositories,
      screening: cached,
      clock: () => new Date("2026-06-01T00:00:00Z"),
    });
    const report = await service.screenMerchant({} as never, {
      merchantId: "merchant-1",
      trigger: "LIST_UPDATE",
      subjects: [{ subjectType: "MERCHANT", subjectId: "merchant-1", names: ["محمد الشريف"] }],
    });
    const amlCase = await service.raiseConfirmedMatchCase({} as never, report);
    expect(amlCase?.triggerReason).toContain("SCREENING_CONFIRMED_MATCH");
  },

  async screening_fail_closed() {
    const state = (await import("../helpers/fakeRepositories")).createScreeningState();
    state.merchants.push(merchantRow());
    state.joinRequests.push({
      id: "join-1",
      merchantId: "merchant-1",
      submittedByUserId: "user-1",
      status: "SUBMITTED",
      onboardingChannel: "SELF_SERVICE",
      submittedAt: new Date(),
      assignedReviewerId: null,
      slaDueAt: null,
      screeningId: null,
      proposedRiskTier: "STANDARD",
      fourEyesRequired: false,
      fourEyesReasons: [],
      decision: null,
      decisionReasonCode: null,
      decisionNotes: null,
      infoRequestJson: null,
      resubmissionOfId: null,
      approvalRequestId: null,
    } as never);
    const repositories = (await import("../helpers/fakeRepositories")).createScreeningRepositories(state);
    const service = new MerchantScreeningService({
      repositories,
      screening: new MockScreeningProvider({ result: "ERROR", errorMessage: "provider unavailable" }),
      clock: () => new Date("2026-06-01T00:00:00Z"),
    });
    const result = await service.submitOnboarding({} as never, {
      merchant: merchantRow(),
      joinRequestId: "join-1",
      owners: [],
    });
    expect(result.result).toBe("ERROR");
    expect(result.blocked).toBe(true);
    expect(result.screeningUnavailable).toBe(true);
    expect(result.joinRequestStatus).toBe("IN_REVIEW");
    expect(state.joinRequests[0]?.status).toBe("IN_REVIEW");
    expect(state.auditLogs.some((entry) => entry.action === "MERCHANT_ONBOARDING_SCREENING_UNAVAILABLE")).toBe(true);
    const merchantSource = readSource("api/internal/merchant.ts");
    expect(merchantSource).toMatch(/503,\s*"SCREENING_UNAVAILABLE"/);

    const fixture = createGuardFixture();
    const errorScreening = {
      code: "MOCK_ERROR",
      screenLocal: () => ({
        result: "ERROR" as const,
        matches: [],
        highestScore: null,
        providerCode: "MOCK_ERROR",
        providerRequestRef: null,
        listVersions: {},
        inputHash: "",
        error: "provider unavailable",
      }),
    };
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: errorScreening as never,
      clock: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const decision = await guard.guard({
      linkKey: "link-key-1",
      railCode: "edfali",
      env: "SANDBOX",
      channel: "WEB",
      idempotencyKey: "idem-screening-1",
    });
    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons).toContain("SCREENING_UNAVAILABLE");
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
    expect(fixture.state.createdAttempts[0]?.substatus).toBe("SCREENING_UNAVAILABLE");
  },

  async structuring_detected() {
    const rule: AmlRuleDefinition = {
      ...baseAmountRule,
      id: "rule-struct",
      code: "STRUCTURING",
      ruleType: "STRUCTURING",
      action: "FLAG",
      params: { threshold: "10000.0000", band_percent: 10, min_count: 2 },
    };
    const result = evaluateAmlRules([rule], {
      ...amlContext,
      amount: moneyFromDecimal("9000.0000"),
      windowStats: {
        count: 2,
        totalAmount: moneyFromDecimal("18000.0000"),
        amounts: [moneyFromDecimal("9000.0000"), moneyFromDecimal("9000.0000")],
      },
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.ruleType).toBe("STRUCTURING");
    expect(result.requiresCase).toBe(true);
  },

  async chargeback_capped_after_refund() {
    const openChargeback = async (refunded: Decimal) => {
      const { client, context } = createGovernanceFixture();
      const { fakeTable } = await import("../helpers/governanceFake");
      seedAdjustment(client, {
        id: "refund-executed",
        type: "REFUND",
        sourceAttemptId: "attempt-1",
        amount: refunded,
        state: "EXECUTED",
      });
      const result = await client.$transaction(async (tx) =>
        openDisputeWithDraftedAdjustment(context, tx as never, {
          attemptId: "attempt-1",
          gatewayId: "gateway-1",
          railId: "rail-1",
          externalDisputeRef: "DSP-AFTER-REFUND",
          source: "MANUAL",
          amount: new Decimal(100),
          currency: "LYD",
          actorUserId: "user-finance",
          actorRole: "FINANCE",
        }),
      );
      return { result, fakeTable };
    };

    const full = await openChargeback(new Decimal(100));
    expect(full.result.status).toBe("NO_CHARGEBACK_DRAFTED");
    expect(full.result.reason).toBe("ATTEMPT_FULLY_REFUNDED");
    expect(full.result.adjustmentId).toBeNull();
    expect(full.result.approvalRequestId).toBeNull();
    expect(full.fakeTable("adjustment").filter((row) => row.type === "CHARGEBACK")).toHaveLength(0);

    const partial = await openChargeback(new Decimal(40));
    expect(partial.result.status).toBe("DRAFTED");
    expect(partial.result.adjustmentId).not.toBeNull();
    const adjustment = partial.fakeTable("adjustment").find((row) => row.id === partial.result.adjustmentId);
    expect(amountOf(adjustment)).toBe("60.0000");
  },

  async unratified_suspension_persists() {
    const { client } = inMemoryApprovalClient();
    const service = new ApprovalService(client);
    const request = await service.emergencyExecuteWithRatification({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "user-maker",
      payloadDiff: [{ op: "replace", path: "/status", value: "SUSPENDED" }],
      ratifyDueAt: new Date("2026-05-31T00:00:00Z"),
    });
    await expectApiCode(
      service.ratifyEmergencyRequest(request.id, "user-checker"),
      "EMERGENCY_RATIFICATION_EXPIRED",
    );
    expect(request.state).toBe("EXECUTED");
    expect(request.mode).toBe("EMERGENCY_RATIFICATION");
  },

  async dispute_dedupe() {
    const { client, context } = createGovernanceFixture();
    const { fakeTable } = await import("../helpers/governanceFake");
    const input = {
      attemptId: "attempt-1",
      gatewayId: "gateway-1",
      railId: "rail-1",
      externalDisputeRef: "DSP-DUP",
      source: "WEBHOOK" as const,
      amount: new Decimal(100),
      currency: "LYD",
      actorUserId: "user-finance",
      actorRole: "FINANCE",
    };
    await client.$transaction(async (tx) => openDisputeWithDraftedAdjustment(context, tx as never, input));
    await expectApiCode(
      client.$transaction(async (tx) => openDisputeWithDraftedAdjustment(context, tx as never, input)),
      "DISPUTE_ALREADY_EXISTS",
    );
    expect(fakeTable("dispute")).toHaveLength(1);
    expect(readMigrationSql()).toContain("disputes_gateway_id_external_dispute_ref_key");
  },

  async hold_release_independent_of_state() {
    const { client, context } = createGovernanceFixture();
    const { fakeTable } = await import("../helpers/governanceFake");
    fakeTable("merchant")[0]!.status = "SUSPENDED";
    fakeTable("journalEntry").push({
      id: "hold-entry",
      refType: "PAYMENT_ATTEMPT",
      refId: "attempt-1",
      description: "AML hold",
    });
    fakeTable("journalLine").push({
      id: "hold-line",
      entryId: "hold-entry",
      glAccountId: "acc-aml-hold",
      direction: "CREDIT",
      amount: new Decimal(100),
    });
    fakeTable("amlCase").push({
      id: "aml-case-1",
      subjectType: "PAYMENT_ATTEMPT",
      subjectId: "attempt-1",
      triggerReason: "AML_RULE:TEST",
      severity: "HIGH",
      severityInputsJson: {},
      status: "OPEN",
      holdJournalEntryId: "hold-entry",
      confidential: true,
    });
    const result = await client.$transaction(async (tx) =>
      executeAmlCaseResolution(context, tx as never, {
        amlCaseId: "aml-case-1",
        action: "RELEASE",
        checkerUserId: "user-checker",
        checkerRole: "MLRO",
      }),
    );
    expect(result.status).toBe("EXECUTED");
    expect(result.journalEntryId).toBeTruthy();
    expect(fakeTable("amlCase")[0]?.status).toBe("RELEASED");
  },

  async no_tipping_off() {
    expect(() =>
      assertNoTippingOff({
        code: "AML_HOLD_CREATED",
        subjectTemplate: "AML case",
        bodyTemplate: "Reason: {{aml_case_reason}}",
        confidentialityClass: "PUBLIC",
      }),
    ).toThrow();
    expect(() =>
      assertNoTippingOff({
        code: "AML_HOLD_CREATED",
        subjectTemplate: "Internal review",
        bodyTemplate: "No detail is disclosed",
        confidentialityClass: "INTERNAL",
      }),
    ).not.toThrow();
  },

  async wallet_id_check_digit() {
    const blueprint = BLUEPRINT_CATALOG.find((entry) => entry.railCodes.includes("neompay_wallet"));
    const railDefinition = blueprint?.rails.find((entry) => entry.code === "neompay_wallet");
    const field = railDefinition?.fields.find((entry) => entry.key === "wallet_id");
    expect(field?.checksum).toBe("LUHN");
    const pattern = new RegExp(String(field?.regex));
    expect(pattern.test("NP-010000000009")).toBe(true);
    expect(pattern.test("NP-00000000000A")).toBe(false);
    expect(pattern.test("NP-00000000000")).toBe(false);
    if (!field) {
      throw new Error("The NeomPay wallet field is missing from the blueprint catalog");
    }

    expect(() =>
      checkoutInternals.validateRailFields([field] as never, { wallet_id: "NP-010000000009" }),
    ).not.toThrow();

    let invalid: ApiError | null = null;
    try {
      checkoutInternals.validateRailFields([field] as never, { wallet_id: "NP-010000000000" });
    } catch (error) {
      invalid = error as ApiError;
    }
    expect(invalid?.code).toBe("RAIL_FIELD_INVALID");
    expect((invalid?.details as { reason?: string } | undefined)?.reason).toBe("CHECKSUM");
  },

  async frozen_wallet_terminal_decline() {
    const blueprint = BLUEPRINT_CATALOG.find((entry) => entry.gatewayCodes.includes("neompay"));
    const gateway = blueprint?.gateways.find((entry) => entry.code === "neompay");
    const rule = gateway?.statusRules.find((entry) => String(entry.value) === "RELEASED");
    expect(rule).toBeDefined();
    const step: FlowStep = {
      id: "verify",
      type: "HTTP",
      method: "POST",
      url_template: "https://neompay.example/verify",
      side_effect: "MOVES_MONEY",
      retry_policy: "NEVER",
      status_rules: [{
        selector: String(rule?.selector),
        op: String(rule?.op ?? "EQUALS").toLowerCase() as never,
        value: rule?.value,
        canonical_status: rule?.canonicalStatus as never,
        canonical_error: rule?.canonicalError,
      }],
    };
    const executor = new StepExecutor({
      fetch: (async () => new Response(JSON.stringify({ status: "RELEASED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const result = await executor.execute(step, {});
    expect(result.status).toBe("FAILED");
    expect(result.canonicalError).toBe("TERMINAL_DECLINE");
  },

  async internal_timeout_unknown() {
    const executor = new StepExecutor({
      fetch: (async () => {
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      }) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const harness = createEngineHarness({
      attempt: { ownershipMode: "INTERNAL" },
      steps: {
        SUBMIT: [{
          id: "submit",
          type: "HTTP",
          method: "POST",
          url_template: "https://neompay.example/pay",
          side_effect: "MOVES_MONEY",
          point_of_no_return: true,
          retry_policy: "NEVER",
        }],
      },
      executor: (step, context) => executor.execute(step, context),
    });
    const result = await harness.engine.confirm(harness.attempt, { otp: "1234" });
    expect(result.status).toBe("UNKNOWN");
    expect(harness.released).toEqual([]);
    const template = buildPaymentConfirmationTemplate({
      ownershipMode: "INTERNAL",
      amount: "100.0000",
      commissionAmount: "3.0000",
      merchantAmount: "97.0000",
    });
    expect(template.lines.some((line) => line.account.accountType === "TREASURY")).toBe(true);
    expect(template.lines.some((line) => line.account.accountType === "GATEWAY_CLEARING")).toBe(false);
  },

  async self_payment_blocked() {
    const fixture = createGuardFixture();
    const { AttemptGuardPipeline } = await import("../../engine/guards/AttemptGuardPipeline");
    const guard = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const decision = await guard.guard({
      linkKey: "link-key-1",
      railCode: "edfali",
      env: "SANDBOX",
      channel: "WEB",
      customer: { walletId: fixture.state.link.walletId ?? "wallet-1" },
      idempotencyKey: "idem-self-1",
    });
    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons).toContain("SELF_PAYMENT_NOT_ALLOWED");
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
    expect(fixture.state.createdAttempts[0]?.substatus).toBe("SELF_PAYMENT_NOT_ALLOWED");
  },

  async internal_idempotent_recovery() {
    const { client } = createLedgerClient();
    const poster = new LedgerPoster(client);
    const template = {
      refType: "PAYMENT_ATTEMPT",
      refId: "attempt-1",
      description: "internal confirmation",
      lines: [
        { direction: "DEBIT" as const, amount: "100.0000", account: { accountType: "TREASURY" as const } },
        { direction: "CREDIT" as const, amount: "100.0000", account: { accountType: "MERCHANT_WALLET" as const } },
      ],
    };
    const first = await poster.post(template, { merchantId: "merchant-1", currency: "LYD" });
    const second = await poster.post(template, { merchantId: "merchant-1", currency: "LYD" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
  },

  async late_push_after_expiry() {
    const attempt = makeAttempt({ status: "EXPIRED", ownershipMode: "INTERNAL" });
    const harness = createEngineHarness({
      attempt,
      steps: { VERIFY: [{ id: "verify", type: "HTTP" }] },
      executor: honestExecutor(attempt),
    });
    const result = await harness.engine.inquire(harness.attempt);
    expect(result.status).toBe("SUCCEEDED");
    expect(harness.committed).toEqual(["attempt-1"]);
  },

  async internal_idempotency_key() {
    const headers: Array<string | null> = [];
    const executor = new StepExecutor({
      fetch: (async (_url: string, init: RequestInit) => {
        headers.push(new Headers(init.headers).get("idempotency-key"));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const step: FlowStep = {
      id: "step-1",
      type: "HTTP",
      method: "POST",
      url_template: "https://neompay.example/pay",
      side_effect: "MOVES_MONEY",
      retry_policy: "NEVER",
      idempotency_config: { mode: "HEADER", key_name: "Idempotency-Key", source_template: "{attempt.reference}" },
    };
    await executor.execute(step, { attempt: { reference: "PA-1" } });
    await executor.execute(step, { attempt: { reference: "PA-1" } });
    expect(headers).toEqual(["PA-1", "PA-1"]);
  },

  async wallet_type_allowlist() {
    const blueprint = BLUEPRINT_CATALOG.find((entry) => entry.railCodes.includes("neompay_wallet"));
    const railDefinition = blueprint?.rails.find((entry) => entry.code === "neompay_wallet");
    const field = railDefinition?.fields.find((entry) => entry.key === "wallet_id");
    const options = field?.optionsJson as { wallet_types?: string[] } | undefined;
    expect(options?.wallet_types).toContain("01");
    expect(options?.wallet_types).not.toContain("99");
    if (!field) {
      throw new Error("The NeomPay wallet field is missing from the blueprint catalog");
    }

    let unlisted: ApiError | null = null;
    try {
      checkoutInternals.validateRailFields([field] as never, { wallet_id: "NP-990000000002" });
    } catch (error) {
      unlisted = error as ApiError;
    }
    expect(unlisted?.code).toBe("RAIL_FIELD_INVALID");
    expect((unlisted?.details as { reason?: string } | undefined)?.reason).toBe("WALLET_TYPE_NOT_ALLOWED");

    expect(() =>
      checkoutInternals.validateRailFields([field] as never, { wallet_id: "NP-010000000009" }),
    ).not.toThrow();
  },

  async refund_stays_executing() {
    const { client, context } = createGovernanceFixture();
    const { fakeTable } = await import("../helpers/governanceFake");
    seedAdjustment(client, {
      id: "refund-1",
      type: "REFUND",
      sourceAttemptId: "attempt-1",
      amount: new Decimal(10),
      state: "PENDING_REVIEW",
    });
    const scheduled: string[] = [];
    const engine = {
      refund: async () => ({ status: "FAILED", canonicalError: "WALLET_CLOSED" }) as never,
    };
    const result = await client.$transaction(async (tx) =>
      executeAdjustment(
        {
          ...context,
          engine,
          reconciliationScheduler: { schedule: async (attemptId: string) => { scheduled.push(attemptId); } },
        },
        tx as never,
        {
          adjustmentId: "refund-1",
          checkerUserId: "user-finance",
          checkerRole: "FINANCE",
        },
      ),
    );
    expect(result.status).toBe("HELD");
    expect(result.reason).toBe("REFUND_GATEWAY_FAILED");
    expect(fakeTable("adjustment")[0]?.state).toBe("EXECUTING");
    expect(scheduled).toEqual(["attempt-1"]);
  },

  async cross_ledger_drift_case() {
    const verifier = new InvariantVerifier(async () => [
      {
        accountId: "acc-treasury",
        accountType: "TREASURY",
        checkpointBalance: new Decimal(0),
        delta: new Decimal(100),
        liveBalance: new Decimal(100),
      },
      {
        accountId: "acc-wallet",
        accountType: "MERCHANT_WALLET",
        checkpointBalance: new Decimal(0),
        delta: new Decimal(-99.9),
        liveBalance: new Decimal(-99.9),
      },
    ]);
    const result = await verifier.verify();
    expect(result.ok).toBe(false);
    expect(result.drift.toFixed(4)).toBe("0.1000");
    await expect(verifier.assertInvariant()).rejects.toThrow(/drift/i);
  },
};

// Every case is a real regression check: the defects these ids used to hide
// were fixed, so nothing is left as a `todo`.
const TODO_CASE_IDS = new Set<number>([]);

describe("140 entry edge case master catalog", () => {
  test("encodes exactly 140 cases across groups A to K", () => {
    expect(EDGE_CASE_CATALOG.length).toBe(140);
    const ids = EDGE_CASE_CATALOG.map((entry) => entry.id);
    expect(ids).toEqual(Array.from({ length: 140 }, (_, index) => index + 1));
  });

  test("keeps every group inside its documented range", () => {
    for (const [group, definition] of Object.entries(EDGE_CASE_GROUPS)) {
      const cases = EDGE_CASE_CATALOG.filter((entry) => entry.group === group);
      expect(cases.length).toBe(definition.range[1] - definition.range[0] + 1);
      expect(cases[0]?.id).toBe(definition.range[0]);
      expect(cases[cases.length - 1]?.id).toBe(definition.range[1]);
    }
  });

  test("declares a scenario, a resolution and a severity for every case", () => {
    for (const entry of EDGE_CASE_CATALOG) {
      expect(entry.scenario.length).toBeGreaterThan(10);
      expect(entry.resolution.length).toBeGreaterThan(10);
      expect(["Low", "Med", "High"]).toContain(entry.severity);
    }
  });

  test("covers every group with at least one case", () => {
    const groups = new Set<EdgeCaseGroup>(EDGE_CASE_CATALOG.map((entry) => entry.group));
    expect([...groups].sort()).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]);
  });

  test("every case maps to an executable regression check", () => {
    const missing = EDGE_CASE_CATALOG.filter((entry) => !(entry.check in checks)).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  for (const entry of EDGE_CASE_CATALOG) {
    const name = `case ${entry.id} (${entry.group}) ${entry.scenario}`;
    if (TODO_CASE_IDS.has(entry.id)) {
      test.todo(name, async () => {
        await checks[entry.check]?.();
      });
      continue;
    }
    test(name, async () => {
      await checks[entry.check]?.();
    });
  }
});


describe("catalog cross checks", () => {
  test("the approval service rejects a self approval and automation as checker", async () => {
    const { rows, client } = inMemoryApprovalClient();
    const service = new ApprovalService(client as never, {});
    const proposal = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      payloadDiff: [{ op: "replace", path: "/riskTier", value: "HIGH" }],
    });
    expect(rows.get(proposal.id)?.state).toBe("PENDING_REVIEW");
    await expect(service.approveRequest(proposal.id, "maker-1")).rejects.toThrow();
    await expect(service.approveRequest(proposal.id, SYSTEM_AUTOMATION)).rejects.toThrow();
  });

  test("the mock gateway exposes the fifteen deterministic scenarios", () => {
    expect(MOCK_SCENARIOS.length).toBe(15);
    expect(new Set(MOCK_SCENARIOS).size).toBe(15);
  });

  test("the backoff schedule is bounded by the policy duration", () => {
    const policy = { firstAfterSeconds: 5, backoffSeconds: [5, 15, 30], maxDurationSeconds: 60 };
    expect(computeBackoffDelaySeconds(policy, 0)).toBe(5);
    expect(computeBackoffDelaySeconds(policy, 3600)).toBeNull();
  });

  test("the canonicalization modes match the documented gateway contracts", () => {
    expect(canonicalize("MOAMALAT_SECURE_HASH", { fields: { b: 2, a: 1 } })).toBe("a=1&b=2");
    expect(canonicalize("TIMESTAMP_DOT_RAW_BODY", { timestamp: "1700000000", rawBody: "body" })).toBe("1700000000.body");
    expect(canonicalize("SORTED_VALUES_HASH", { fields: { b: "2", a: "1", hashed: "x" } })).toBe("12");
  });
});
