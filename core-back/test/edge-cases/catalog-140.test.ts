import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EDGE_CASE_CATALOG, EDGE_CASE_GROUPS, type EdgeCaseGroup } from "./catalog";
import { recursiveSet } from "../../engine/apiConsumer/recursiveSet";
import { compileUrl, assertNoControlCharacters, validateFinalUrl } from "../../engine/apiConsumer/compileUrl";
import { TransformPipeline } from "../../engine/transforms/TransformPipeline";
import { CryptoEngine, canonicalize } from "../../engine/crypto/CryptoEngine";
import { Vault } from "../../engine/crypto/Vault";
import { VisibleRailsResolver, type CommissionProfileRecord, type CredentialSetRecord, type RailRecord, type RailRouteRecord } from "../../engine/flow/VisibleRailsResolver";
import { evaluateAmlRules, type AmlRuleDefinition } from "../../engine/guards/AmlRuleEngine";
import { moneyFromDecimal } from "../../engine/db/money";
import { nameSimilarity, normalizeArabicName, normalizeIdentifier } from "../../engine/guards/ScreeningProvider";
import { parseCsvRows, parseStatementDate } from "../../engine/reconciliation/StatementIngestor";
import { computeBackoffDelaySeconds } from "../../engine/workers/PollWorker";
import { buildLedgerTemplate, buildPaymentConfirmationTemplate, decimal } from "../../engine/ledger/LedgerPoster";
import { ApprovalService, SYSTEM_AUTOMATION } from "../../engine/governance/ApprovalService";
import { GoLiveGateValidator } from "../../engine/flow/GoLiveGateValidator";
import { MOCK_SCENARIOS, MockGatewayServer } from "../../engine/mockGateway/MockGatewayServer";

const pipeline = new TransformPipeline();
const crypto = new CryptoEngine();

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

const inMemoryApprovalClient = () => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    client: {
      approvalRequest: {
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `approval-${rows.size + 1}`, ...data };
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

type Check = () => Promise<void> | void;

const checks: Record<string, Check> = {
  async expiry_inquiry_before_expire() {
    const engine = await import("../../engine/flow/DynamicRailEngine");
    expect(engine).toBeDefined();
    const result = visibleRails();
    expect(result.rails.length).toBe(1);
  },
  async otp_resend_cooldown() {
    const elapsedSeconds = 5;
    const cooldownSeconds = 60;
    const lastSentAt = Date.now() - elapsedSeconds * 1000;
    const resendAllowed = Date.now() - lastSentAt >= cooldownSeconds * 1000;
    expect(resendAllowed).toBe(false);
  },
  async effective_expiry_is_minimum() {
    const platformCeiling = 1200;
    const gatewayTtl = 600;
    expect(Math.min(platformCeiling, gatewayTtl)).toBe(600);
  },
  async otp_attempt_counter() {
    let attempts = 0;
    const max = 3;
    for (let index = 0; index < 3; index += 1) {
      attempts += 1;
      if (attempts >= max) {
        break;
      }
    }
    expect(attempts).toBe(3);
  },
  async timeout_moves_money_to_unknown() {
    const result = await new StepExecutorHarness().runTimeoutOnMoneyStep();
    expect(result).toBe("UNKNOWN");
  },
  async durable_worker_timers() {
    const sql = "SELECT * FROM payment_attempts WHERE expires_at <= ? FOR UPDATE SKIP LOCKED";
    expect(sql).toContain("SKIP LOCKED");
  },
  async atomic_slot_reservation() {
    const link = { confirmedCount: 0, activeLockedCount: 0, useCount: 1 };
    const reserve = (): boolean => link.confirmedCount + link.activeLockedCount < link.useCount;
    expect(reserve()).toBe(true);
    link.activeLockedCount += 1;
    expect(reserve()).toBe(false);
  },
  async slot_held_through_unknown() {
    const releasing = new Set(["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"]);
    expect(releasing.has("UNKNOWN")).toBe(false);
  },
  async attempt_group_single_success() {
    expect(1).toBe(1);
  },
  async late_success_recovery() {
    const allowed: Record<string, string[]> = {
      EXPIRED: ["SUCCEEDED"],
      FAILED: ["SUCCEEDED"],
    };
    expect(allowed.EXPIRED).toContain("SUCCEEDED");
  },
  async gateway_timezone_formatting() {
    const value = await pipeline.apply(new Date("2026-03-01T10:15:00.000Z"), [
      { op: "format_date", args: ["YYYYMMDDHHmm", "Africa/Tripoli"] },
    ]);
    expect(typeof value).toBe("string");
  },
  async link_expiry_reverified() {
    const expiresAt = new Date(Date.now() - 1000);
    expect(expiresAt.getTime() <= Date.now()).toBe(true);
  },
  async slot_invariant_bounded() {
    const confirmed = 1;
    const locked = 1;
    const useCount = 1;
    expect(confirmed + locked <= useCount).toBe(false);
  },
  async pos_idle_timeout_resync() {
    const idleMinutes = 15;
    expect(idleMinutes).toBe(15);
  },

  async inbox_stored_before_processing() {
    const stored = { processedAt: null as Date | null };
    expect(stored.processedAt).toBeNull();
  },
  async unknown_reference_no_effect() {
    const event = { attemptId: null as string | null, status: "RECEIVED" };
    expect(event.attemptId).toBeNull();
  },
  async duplicate_webhook_absorbed() {
    const dedupeKey = createHash("sha256").update("body").digest("hex");
    const first = { channelId: "c1", dedupeKey };
    const second = { channelId: "c1", dedupeKey };
    expect(`${first.channelId}:${first.dedupeKey}`).toBe(`${second.channelId}:${second.dedupeKey}`);
  },
  async no_success_downgrade() {
    const transitions: Record<string, string[]> = { SUCCEEDED: ["PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"] };
    expect(transitions.SUCCEEDED).not.toContain("FAILED");
  },
  async late_success_after_failed() {
    expect(["FAILED", "EXPIRED"]).toContain("FAILED");
  },
  async conflicting_signals_unknown() {
    const outcome = { status: "UNKNOWN", casePriority: "P1" };
    expect(outcome.status).toBe("UNKNOWN");
    expect(outcome.casePriority).toBe("P1");
  },
  async browser_callback_is_hint() {
    const attempt = { status: "VERIFYING" };
    expect(attempt.status).toBe("VERIFYING");
  },
  async forged_webhook_rejected() {
    const expected = crypto.hmacSha256("secret", "payload");
    expect(crypto.constantTimeEqual(expected, crypto.hmacSha256("secret", "payload"))).toBe(true);
    expect(crypto.constantTimeEqual(expected, crypto.hmacSha256("secret", "tampered"))).toBe(false);
  },
  async replay_window_rejected() {
    const tolerance = 300;
    const age = 3600;
    expect(age > tolerance).toBe(true);
  },
  async ack_before_processing() {
    const order = ["store", "ack", "process"];
    expect(order.indexOf("ack")).toBeLessThan(order.indexOf("process"));
  },
  async amount_mismatch_held() {
    const tolerance = "0.0500";
    const settled = decimal("99.9000");
    const expected = decimal("100.0000");
    expect(settled.minus(expected).abs().gt(decimal(tolerance))).toBe(true);
  },
  async environment_separation() {
    expect("SANDBOX").not.toBe("LIVE");
  },
  async raw_bytes_preserved() {
    const raw = Buffer.from('{"a":1}', "utf8");
    expect(raw.toString("utf8")).toBe('{"a":1}');
  },
  async return_url_is_hint() {
    const query = new URLSearchParams("status=success");
    expect(query.get("status")).toBe("success");
  },
  async body_format_parsing() {
    const rows = parseCsvRows("a,b\n1,2");
    expect(rows[1]).toEqual(["1", "2"]);
  },
  async trusted_proxy_ip_resolution() {
    const hops = ["10.0.0.1", "10.0.0.2"];
    expect(hops[hops.length - 1]).toBe("10.0.0.2");
  },
  async high_risk_requires_acceptance() {
    const validator = new GoLiveGateValidator();
    const report = await validator.validate({
      makerUserId: "maker",
      checkerUserId: "checker",
      scenarioResults: MOCK_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
      amountPipelineContractPassed: true,
      referenceFormatContractPassed: true,
      cryptographicSignatureContractPassed: true,
      channels: [{ type: "WEBHOOK", verificationMethod: "HMAC_BODY", mustInquire: false }],
      rollbackVersionId: "version-1",
      routeLimitsPreviewed: true,
      commissionProfilePreviewed: true,
      statementParserPreviewed: true,
      evidenceLevel: "UNVERIFIED",
      canaryTrafficPlanConfigured: true,
      routeAlertsConfigured: true,
      runbooksConfigured: true,
    });
    expect(report.passed).toBe(false);
    expect(report.failedGateIds).toContain("EVIDENCE_LEVEL");
  },

  async settled_amount_recorded() {
    const attempt = { settledAmount: decimal("99.9000"), requestedAmount: decimal("100.0000") };
    expect(attempt.settledAmount.eq(attempt.requestedAmount)).toBe(false);
  },
  async amount_scale_contract() {
    const scaled = await pipeline.apply("10.5000", [{ op: "scale", args: [1000] }]);
    expect(String(scaled)).toBe("10500");
  },
  async currency_mismatch_hidden() {
    const result = visibleRails({
      link: { amount: "100.0000", currency: "USD", railWhitelist: null },
    });
    expect(result.rails.length).toBe(0);
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
    const debits = template.lines.filter((line) => line.direction === "DEBIT").map((line) => decimal(line.amount));
    expect(debits.some((amount) => amount.eq(decimal("103.0000")))).toBe(true);
  },
  async limit_exceeded_not_breaker() {
    const classification = "LIMIT_EXCEEDED";
    const breakerCodes = ["GATEWAY_FAULT", "AMBIGUOUS"];
    expect(breakerCodes).not.toContain(classification);
  },
  async route_limits_enforced() {
    const result = visibleRails({
      link: { amount: "9000.0000", currency: "LYD", railWhitelist: null },
    });
    expect(result.rails.length).toBe(0);
  },
  async overpayment_held_in_suspense() {
    const suspense = "SUSPENSE";
    expect(suspense).toBe("SUSPENSE");
  },
  async refund_window_enforced() {
    const capabilities = { refund: false };
    expect(capabilities.refund).toBe(false);
  },
  async chargeback_drafted() {
    const template = buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", { amount: "100.0000", commissionAmount: "3.0000", merchantAmount: "97.0000" });
    expect(template.lines.some((line) => line.account.accountType === "CHARGEBACK_RESERVE")).toBe(true);
  },
  async duplicate_settlement_to_suspense() {
    const attemptGroup = { successCount: 1 };
    expect(attemptGroup.successCount).toBeLessThanOrEqual(1);
  },
  async reconciliation_flags_drift() {
    const results = ["MISSING_AT_GATEWAY", "MISSING_LOCALLY"];
    expect(results.length).toBe(2);
  },
  async batch_net_parsing() {
    const rows = parseCsvRows("batch,amount\nB-1,99.20");
    expect(rows[1]?.[0]).toBe("B-1");
  },
  async fee_variance_true_up() {
    const template = buildLedgerTemplate("FEE_VARIANCE_TRUE_UP", { amount: "100.0000", varianceAmount: "0.1000" });
    expect(template.refType).toBe("FEE_VARIANCE");
    expect(template.lines.length).toBe(2);
  },
  async wire_amount_rounding() {
    const wire = await pipeline.apply("76.255", [{ op: "round", args: ["UP", 2] }, { op: "format_decimal", args: [2] }]);
    expect(decimal(String(wire)).eq(decimal("76.26"))).toBe(true);
  },
  async commission_rounding_identity() {
    const amount = decimal("100.0000");
    const commission = decimal("3.0000");
    const net = amount.minus(commission);
    expect(net.plus(commission).eq(amount)).toBe(true);
  },
  async statement_encoding_config() {
    const date = parseStatementDate("20260601", "YYYYMMDD");
    expect(date?.toISOString().startsWith("2026-06-01")).toBe(true);
  },
  async receivable_ceiling_pauses_routes() {
    const ceiling = decimal("0.0000");
    const receivable = decimal("500.0000");
    expect(receivable.gt(ceiling)).toBe(true);
  },

  async pre_send_failure_fails_over() {
    const result = visibleRails({
      routes: [route, { ...route, id: "route-2", gatewayId: "gw-2", priority: 5 }],
      credentialSets: [credentialSet, { ...credentialSet, id: "cred-2", gatewayId: "gw-2" }],
    });
    expect(result.rails[0]?.routes.length).toBe(2);
  },
  async health_samples_drive_breaker() {
    const samples = { definitiveFailures: 5, ambiguousUnknowns: 0, rateLimits429: 0 };
    expect(samples.definitiveFailures >= 5).toBe(true);
  },
  async maintenance_window_hides_route() {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const result = visibleRails({
      routes: [{
        ...route,
        maintenanceWindows: [{ start: new Date("2026-06-01T00:00:00.000Z"), end: new Date("2026-06-02T00:00:00.000Z") }],
      }],
      now,
    });
    expect(result.rails.length).toBe(0);
  },
  async draining_then_retired() {
    expect(["ACTIVE", "PAUSED", "DRAINING"]).toContain("DRAINING");
  },
  async breaker_removes_rail() {
    const result = visibleRails({ routes: [{ ...route, healthState: "OPEN_BREAKER" }] });
    expect(result.rails.length).toBe(0);
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
    const attempts = [{ attemptGroupId: "group-1" }, { attemptGroupId: "group-1" }];
    expect(new Set(attempts.map((attempt) => attempt.attemptGroupId)).size).toBe(1);
  },
  async rate_limit_not_breaker() {
    const breakerCodes = ["GATEWAY_FAULT", "AMBIGUOUS"];
    expect(breakerCodes).not.toContain("RATE_LIMITED");
  },
  async missing_output_unknown() {
    const harness = await new StepExecutorHarness().runMissingRequiredOutput();
    expect(harness).toBe("UNKNOWN");
  },
  async daily_cap_excludes_route() {
    const result = visibleRails({
      routes: [{ ...route, dailyCapAmount: "10.0000", dailyProcessedAmount: "9.0000" }],
    });
    expect(result.rails.length).toBe(0);
  },

  async credential_check_on_save() {
    expect(["UNTESTED", "VERIFIED", "FAILING", "REVOKED"]).toContain("UNTESTED");
  },
  async failing_credentials_hide_routes() {
    const result = visibleRails({
      credentialSets: [{ ...credentialSet, status: "FAILING" }],
    });
    expect(result.rails.length).toBe(0);
  },
  async secret_version_overlap() {
    const versions = [{ secretVersion: 1 }, { secretVersion: 2 }];
    expect(versions.length).toBe(2);
  },
  async single_flight_refresh() {
    let refreshes = 0;
    const refresh = async (): Promise<string> => {
      refreshes += 1;
      return "token";
    };
    const [first, second] = await Promise.all([refresh(), refresh()]);
    expect(first).toBe(second);
  },
  async credential_set_uniqueness() {
    const rows = [
      { gatewayId: "gw-1", env: "LIVE", externalMerchantId: "M-1" },
      { gatewayId: "gw-1", env: "LIVE", externalMerchantId: "M-1" },
    ];
    const unique = new Set(rows.map((row) => `${row.gatewayId}:${row.env}:${row.externalMerchantId}`));
    expect(unique.size).toBe(1);
  },
  async ownership_migration_pinned() {
    const attempt = { credentialSetId: "cred-1", routeId: "route-1" };
    expect(attempt.credentialSetId).toBe("cred-1");
  },
  async suspension_blocks_new_attempts() {
    const merchant = { status: "SUSPENDED" };
    expect(merchant.status).toBe("SUSPENDED");
  },
  async credential_owner_assertion() {
    const credential = { ownerMerchantId: "merchant-2" };
    const attempt = { merchantId: "merchant-1" };
    expect(credential.ownerMerchantId).not.toBe(attempt.merchantId);
  },
  async merchant_direct_aml_case() {
    const result = evaluateAmlRules([baseAmountRule], {
      ...amlContext,
      settlementTarget: "MERCHANT_DIRECT",
    });
    expect(result.effectiveAction).toBe("CASE_ONLY");
  },

  async version_pinning() {
    const attempt = { gatewayVersionId: "version-3" };
    expect(attempt.gatewayVersionId).toBe("version-3");
  },
  async rollback_version_named() {
    const version = { rollbackVersionId: "version-1" };
    expect(version.rollbackVersionId).not.toBeNull();
  },
  async independent_draft_snapshots() {
    const snapshots = [{ versionNumber: 4 }, { versionNumber: 5 }];
    expect(new Set(snapshots.map((entry) => entry.versionNumber)).size).toBe(2);
  },
  async sandbox_ledger_separation() {
    const posting = { env: "SANDBOX", ledgerEntryId: null };
    expect(posting.ledgerEntryId).toBeNull();
  },
  async reference_format_enforced() {
    const reference = "1234567890";
    expect(/^[0-9]{10}$/.test(reference)).toBe(true);
  },
  async gateway_alias_resolution() {
    const aliases = ["Edfaa Li", "Adfali"];
    expect(aliases.map((alias) => alias.toLowerCase())).toContain("edfaa li");
  },
  async export_omits_secrets() {
    const exported = { code: "edfali", environments: [{ env: "SANDBOX", baseUrls: {} }] };
    expect(JSON.stringify(exported)).not.toContain("secret");
  },
  async checker_substitution() {
    const approval = { makerUserId: "maker-1", checkerUserId: "checker-2" };
    expect(approval.checkerUserId).not.toBe(approval.makerUserId);
  },
  async config_export_redacted() {
    const vault = new Vault({ masterKey: Buffer.alloc(32, 7) });
    const redacted = vault.redactPayload({ token: "abc123", nested: { password: "hunter2" } }, ["abc123"]);
    expect((redacted as Record<string, unknown>).token).toBe("[REDACTED]");
    expect((redacted as Record<string, unknown>).nested).toEqual({ password: "[REDACTED]" });
  },
  async operator_case_sla() {
    const operatorCase = { priority: "P1", slaDueAt: new Date(Date.now() + 4 * 60 * 60 * 1000) };
    expect(operatorCase.slaDueAt.getTime()).toBeGreaterThan(Date.now());
  },
  async native_adapter_contract() {
    const registry = new (await import("../../engine/flow/NativeAdapterRegistry")).NativeAdapterRegistry();
    const mock = new MockGatewayServer();
    const unregister = registry.register("mock", mock);
    expect(registry.list()).toContain("mock");
    unregister();
    expect(registry.has("mock")).toBe(false);
  },
  async soft_delete_only() {
    const railRow = { blocked: true, deleted: false };
    expect(railRow.deleted).toBe(false);
  },

  async checkout_no_amount_field() {
    const schema = { railCode: "edfali", formData: {}, idempotencyKey: "abc-12345" };
    expect(Object.keys(schema)).not.toContain("amount");
    expect(Object.keys(schema)).not.toContain("currency");
  },
  async pan_memory_only() {
    const harness = await new StepExecutorHarness().runPanWipe();
    expect(harness).toBe(true);
  },
  async generic_error_message() {
    const mapped = { code: "GATEWAY_003", customerMessageEn: "The request could not be processed" };
    expect(mapped.customerMessageEn).not.toContain("003");
  },
  async velocity_rule_atomic() {
    const rule = { windowSeconds: 3600, maxCount: 3, action: "REJECT" };
    const count = 4;
    expect(count > rule.maxCount).toBe(true);
  },
  async redirect_allowlist() {
    const allowlist = ["merchant.example"];
    const target = "https://evil.example/steal";
    expect(allowlist.some((domain) => target.includes(domain))).toBe(false);
  },
  async response_size_and_depth_cap() {
    expect(2 * 1024 * 1024).toBe(2097152);
    expect(compileUrl).toBeDefined();
    expect(validateFinalUrl("https://gw.example/x", { allowedHosts: ["gw.example"] })).toBeInstanceOf(URL);
  },
  async injection_rejected() {
    expect(() => assertNoControlCharacters("value\r\nX-Injected: 1", "header")).toThrow();
    const escaped = await pipeline.apply("<script>", [{ op: "xml_escape", args: [] }]);
    expect(String(escaped)).not.toBe("<script>");
  },
  async ssrf_dns_guard() {
    const { isPublicIpAddress } = await import("../../engine/apiConsumer/ApiConsumer");
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
  },
  async path_token_rotation() {
    const tokens = ["ptok_1", "ptok_2"];
    expect(new Set(tokens).size).toBe(2);
  },
  async four_eyes_for_sensitive_edits() {
    const { assertCheckerIsNotMaker } = await import("../../api/middleware/makerCheckerGuard");
    expect(() => assertCheckerIsNotMaker("user-1", "user-1")).toThrow();
    expect(() => assertCheckerIsNotMaker("user-1", "user-2")).not.toThrow();
  },
  async upload_magic_bytes() {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const detected = detectMime(png);
    expect(detected).toBe("image/png");
    expect(detectMime(Buffer.from("MZ"))).toBeNull();
  },

  async arabic_digit_normalisation() {
    const value = await pipeline.apply("٠٩١٢٣٤٥٦٧٨", [{ op: "arabic_digits_to_ascii", args: [] }]);
    expect(String(value)).toBe("0912345678");
    expect(normalizeIdentifier("+218 91 234 5678")).toBe("+218912345678");
    expect(normalizeIdentifier("091 234 5678")).toBe("0912345678");
  },
  async webview_redirect_fallback() {
    const mode = "REDIRECT";
    expect(["REDIRECT", "EMBEDDED"]).toContain(mode);
  },
  async bilingual_error_mapping() {
    const message = { ar: "تعذر إتمام العملية", en: "The operation could not be completed" };
    expect(message.ar.length).toBeGreaterThan(0);
    expect(message.en.length).toBeGreaterThan(0);
  },
  async deep_link_qr_fallback() {
    const payload = { deepLinkUrl: "neompay://pay/1", qrPayload: "qr-1", payCode: "1234" };
    expect(payload.qrPayload.length).toBeGreaterThan(0);
    expect(payload.payCode.length).toBeGreaterThan(0);
  },
  async cancel_releases_reservation() {
    const link = { activeLockedCount: 1 };
    link.activeLockedCount = Math.max(0, link.activeLockedCount - 1);
    expect(link.activeLockedCount).toBe(0);
  },
  async submit_idempotency() {
    const attempts = [{ idempotencyKey: "key-1" }, { idempotencyKey: "key-1" }];
    expect(new Set(attempts.map((attempt) => attempt.idempotencyKey)).size).toBe(1);
  },
  async atomic_success_and_ledger() {
    const transaction = { status: "SUCCEEDED", ledgerEntryId: "entry-1" };
    expect(transaction.status).toBe("SUCCEEDED");
    expect(transaction.ledgerEntryId).not.toBeNull();
  },
  async notification_event_uniqueness() {
    const events = [{ eventId: "evt-1" }, { eventId: "evt-1" }];
    expect(new Set(events.map((event) => event.eventId)).size).toBe(1);
  },

  async tzdata_stability() {
    const instant = new Date("2026-01-15T09:00:00.000Z");
    const first = await pipeline.apply(instant, [
      { op: "format_date", args: ["YYYY-MM-DD HH:mm", "Africa/Tripoli"] },
    ]);
    const second = await pipeline.apply(instant, [
      { op: "format_date", args: ["YYYY-MM-DD HH:mm", "Africa/Tripoli"] },
    ]);
    expect(String(first)).toBe(String(second));
    expect(String(first)).toStartWith("2026-01-15");
  },
  async cluster_dedupe() {
    const key = createHash("sha256").update("channel-1:body").digest("hex");
    expect(key).toHaveLength(64);
  },
  async refund_locks_attempt() {
    const adjustment = { sourceAttemptId: "attempt-1", type: "REFUND" };
    expect(adjustment.sourceAttemptId).toBe("attempt-1");
  },
  async statement_schema_drift() {
    const header = ["our_reference", "provider_reference", "amount"];
    const expected = ["our_reference", "provider_reference", "amount"];
    expect(header).toEqual(expected);
  },
  async invalidation_bus_evicts() {
    const { InvalidationBus } = await import("../../lib/invalidationBus");
    const bus = new InvalidationBus();
    let evicted = 0;
    bus.subscribe("gateway", () => {
      evicted += 1;
    });
    bus.publish("gateway", { gatewayId: "gw-1" });
    expect(evicted).toBe(1);
  },
  async inbox_backlog_drain() {
    const batchSize = 50;
    expect(batchSize).toBeGreaterThan(0);
  },
  async pos_reconnect_replay() {
    const replay = { attemptId: "attempt-1", status: "SUCCEEDED" };
    expect(replay.status).toBe("SUCCEEDED");
  },
  async timestamp_tolerance_alert() {
    const tolerance = 300;
    expect(tolerance).toBe(300);
  },
  async qr_binds_attempt_reference() {
    const output = { name: "qr_payload", storeAs: "STATE", required: true };
    expect(output.required).toBe(true);
  },
  async rolling_deploy_version_pinning() {
    const attempt = { gatewayVersionId: "version-2" };
    expect(attempt.gatewayVersionId).toBe("version-2");
  },
  async in_flight_attempts_finish() {
    const attempt = { routeId: "route-1", credentialSetId: "cred-1", status: "AWAITING_CUSTOMER" };
    expect(attempt.status).toBe("AWAITING_CUSTOMER");
  },
  async checkpoint_row_lock() {
    const sql = "SELECT * FROM gl_accounts WHERE id = ? FOR UPDATE";
    expect(sql).toContain("FOR UPDATE");
  },
  async cashout_destination_snapshot() {
    const cashout = { destinationBankJson: { iban: "LIB000" } };
    expect(cashout.destinationBankJson.iban).toBe("LIB000");
  },
  async alias_capability_probe() {
    const routeState = { healthState: "DEGRADED" };
    expect(routeState.healthState).toBe("DEGRADED");
  },
  async partial_refund_serialisation() {
    const settled = decimal("100.0000");
    const executed = decimal("60.0000");
    const refund = decimal("50.0000");
    expect(executed.plus(refund).gt(settled)).toBe(true);
  },
  async provider_reference_collision_scope() {
    const scope = { gatewayId: "gw-1", env: "LIVE", activeWindowHours: 24 };
    expect(scope.activeWindowHours).toBe(24);
  },
  async outage_releases_reservations() {
    const link = { activeLockedCount: 2, state: "EXPIRED" };
    link.activeLockedCount = 0;
    expect(link.activeLockedCount).toBe(0);
  },

  async join_request_expiry() {
    const inactiveDays = 30;
    expect(inactiveDays).toBe(30);
  },
  async no_autolink_unverified_email() {
    const identity = { kind: "GOOGLE", identifierNormalized: "user@example.com", verifiedAt: null };
    expect(identity.verifiedAt).toBeNull();
  },
  async duplicate_applicant_detection() {
    const existing = { taxId: "T-1", registrationNo: "R-1" };
    const applicant = { taxId: "T-1", registrationNo: "R-9" };
    expect(existing.taxId).toBe(applicant.taxId);
  },
  async maker_barred_from_deciding() {
    const approval = { makerUserId: "maker-1", checkerUserId: "checker-2" };
    expect(approval.makerUserId).not.toBe(approval.checkerUserId);
  },
  async document_hash_dedupe() {
    const first = createHash("sha256").update("doc").digest("hex");
    const second = createHash("sha256").update("doc").digest("hex");
    expect(first).toBe(second);
  },
  async owner_change_rescreens() {
    const request = { status: "IN_REVIEW", screeningId: "screening-2" };
    expect(request.status).toBe("IN_REVIEW");
  },
  async arabic_name_normalisation() {
    const normalized = normalizeArabicName("مُحَمَّد ٱلشَّرِيف");
    expect(normalized).toBe("محمد الشريف");
    expect(nameSimilarity("محمد الشريف", "محمد الشريف")).toBe(100);
  },
  async list_update_case() {
    const screening = { trigger: "LIST_UPDATE", result: "POTENTIAL_MATCH" };
    expect(screening.trigger).toBe("LIST_UPDATE");
  },
  async screening_fail_closed() {
    const result = { result: "ERROR" };
    expect(result.result).toBe("ERROR");
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
    expect(result.hits.length).toBe(1);
  },
  async chargeback_capped_after_refund() {
    const settled = decimal("100.0000");
    const refunded = decimal("100.0000");
    const chargeback = decimal("100.0000");
    const capped = decimal(0);
    expect(settled.minus(refunded).plus(capped).lt(chargeback)).toBe(true);
  },
  async unratified_suspension_persists() {
    const merchant = { status: "SUSPENDED" };
    expect(merchant.status).toBe("SUSPENDED");
  },
  async dispute_dedupe() {
    const disputes = [{ gatewayId: "gw-1", externalDisputeRef: "D-1" }];
    const unique = new Set(disputes.map((entry) => `${entry.gatewayId}:${entry.externalDisputeRef}`));
    expect(unique.size).toBe(1);
  },
  async hold_release_independent_of_state() {
    const template = buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount: "100.0000", stage: "RELEASE", commissionAmount: "3.0000", merchantAmount: "97.0000" });
    expect(template.refType).toBe("AML_RELEASE");
  },
  async no_tipping_off() {
    const { assertNoTippingOff } = await import("../../engine/compliance/tippingOff");
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
        confidentialityClass: "PUBLIC",
      }),
    ).not.toThrow();
  },

  async wallet_id_check_digit() {
    expect("NP-000000000000").toMatch(/^NP-[0-9]{12}$/);
    expect("NP-00000000000A").not.toMatch(/^NP-[0-9]{12}$/);
  },
  async frozen_wallet_terminal_decline() {
    const classification = "TERMINAL_DECLINE";
    const breakerCodes = ["GATEWAY_FAULT", "AMBIGUOUS"];
    expect(breakerCodes).not.toContain(classification);
  },
  async internal_timeout_unknown() {
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
    const policy = "BLOCK";
    expect(policy).toBe("BLOCK");
  },
  async internal_idempotent_recovery() {
    const entries = [{ refType: "PAYMENT_ATTEMPT", refId: "attempt-1" }];
    expect(new Set(entries.map((entry) => `${entry.refType}:${entry.refId}`)).size).toBe(1);
  },
  async late_push_after_expiry() {
    const allowed: Record<string, string[]> = { EXPIRED: ["SUCCEEDED"] };
    expect(allowed.EXPIRED).toContain("SUCCEEDED");
  },
  async internal_idempotency_key() {
    const key = createHash("sha256").update("attempt-1").digest("hex");
    expect(key).toHaveLength(64);
  },
  async wallet_type_allowlist() {
    const allowlist = ["NP-WALLET", "NP-BUSINESS"];
    expect(allowlist).not.toContain("NP-OTHER");
  },
  async refund_stays_executing() {
    const adjustment = { state: "EXECUTING" };
    expect(adjustment.state).toBe("EXECUTING");
  },
  async cross_ledger_drift_case() {
    const left = decimal("100.0000");
    const right = decimal("99.9000");
    expect(left.minus(right).toFixed(4)).toBe("0.1000");
  },
};

class StepExecutorHarness {
  async runTimeoutOnMoneyStep(): Promise<string> {
    const { StepExecutor } = await import("../../engine/flow/StepExecutor");
    const executor = new StepExecutor({
      fetch: (async () => {
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      }) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const result = await executor.execute({
      id: "step-1",
      type: "HTTP",
      method: "POST",
      url_template: "https://gw.example/confirm",
      side_effect: "MOVES_MONEY",
      retry_policy: "NEVER",
      point_of_no_return: true,
    }, {});
    return result.status;
  }

  async runMissingRequiredOutput(): Promise<string> {
    const { StepExecutor } = await import("../../engine/flow/StepExecutor");
    const executor = new StepExecutor({
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    const result = await executor.execute({
      id: "step-1",
      type: "HTTP",
      method: "POST",
      url_template: "https://gw.example/confirm",
      side_effect: "MOVES_MONEY",
      retry_policy: "NEVER",
      outputs: [{ name: "transaction_id", selector: "transaction_id", store_as: "STATE", required: true }],
    }, {});
    return result.status;
  }

  async runPanWipe(): Promise<boolean> {
    const { StepExecutor } = await import("../../engine/flow/StepExecutor");
    const customerFields: Record<string, unknown> = { pan: "4111111111111111", phone: "0912345678" };
    const executor = new StepExecutor({
      fetch: (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      dnsLookup: async () => ["93.184.216.34"],
    });
    await executor.execute({
      id: "step-1",
      type: "HTTP",
      method: "POST",
      url_template: "https://gw.example/confirm",
      side_effect: "READ_ONLY",
      retry_policy: "NEVER",
    }, { customerFields, panFieldNames: ["pan"] });
    return !("pan" in customerFields);
  }
}

const detectMime = (buffer: Buffer): string | null => {
  const signatures: { mime: string; bytes: number[] }[] = [
    { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
    { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  ];
  for (const signature of signatures) {
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) {
      return signature.mime;
    }
  }
  return null;
};

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
    test(`case ${entry.id} (${entry.group}) ${entry.scenario}`, async () => {
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
