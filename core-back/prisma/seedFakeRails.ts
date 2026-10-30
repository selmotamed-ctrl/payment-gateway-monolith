import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client";
import { Vault } from "../engine/crypto/Vault";

export interface FakeRailSeedOptions {
  baseUrl: string;
  apiKey: string;
  hmacSecret?: string;
  publicBaseUrl?: string;
  namespace?: string;
}

const GATEWAY_CODE = "demo-rails";
const NAMESPACE = "demo";
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

interface RailDefinition {
  code: string;
  nameAr: string;
  nameEn: string;
  mode: "OTP_PULL" | "QR_DISPLAY" | "PUSH_APPROVAL" | "REDIRECT";
  fieldKey: string;
  fieldType: "PHONE";
  instructionsAr: string;
  instructionsEn: string;
  poll: boolean;
}

const RAILS: RailDefinition[] = [
  {
    code: "demo-otp",
    nameAr: "تجريبي رمز التحقق",
    nameEn: "Demo OTP",
    mode: "OTP_PULL",
    fieldKey: "customer_mobile",
    fieldType: "PHONE",
    instructionsAr: "أدخل رمز التحقق 123456 لإتمام الدفع التجريبي.",
    instructionsEn: "Enter OTP 123456 to complete the demo payment.",
    poll: false,
  },
  {
    code: "demo-qr",
    nameAr: "تجريبي رمز QR",
    nameEn: "Demo QR",
    mode: "QR_DISPLAY",
    fieldKey: "customer_mobile",
    fieldType: "PHONE",
    instructionsAr: "امسح رمز QR التجريبي أو استخدم رمز الدفع.",
    instructionsEn: "Scan the demo QR or use the pay code.",
    poll: true,
  },
  {
    code: "demo-push",
    nameAr: "تجريبي موافقة الدفع",
    nameEn: "Demo Push Approval",
    mode: "PUSH_APPROVAL",
    fieldKey: "customer_mobile",
    fieldType: "PHONE",
    instructionsAr: "وافق على طلب الدفع التجريبي من المحفظة.",
    instructionsEn: "Approve the demo payment request in the wallet.",
    poll: true,
  },
  {
    code: "demo-redirect",
    nameAr: "تجريبي إعادة التوجيه",
    nameEn: "Demo Redirect",
    mode: "REDIRECT",
    fieldKey: "customer_mobile",
    fieldType: "PHONE",
    instructionsAr: "سيتم تحويلك إلى صفحة الدفع التجريبية.",
    instructionsEn: "You will be redirected to the demo payment page.",
    poll: false,
  },
];

const step = (input: {
  name: string;
  type: "HTTP" | "COMPUTE" | "RENDER" | "WAIT" | "ASSERT" | "BRANCH";
  method?: string;
  url?: string;
  sideEffect?: "READ_ONLY" | "SENDS_NOTIFICATION" | "MOVES_MONEY";
  retryPolicy?: "SAFE" | "SAFE_WITH_COOLDOWN" | "NEVER";
  pointOfNoReturn?: boolean;
  contentType?: string;
  parameters?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
}) => ({
  name: input.name,
  type: input.type,
  method: input.method,
  urlTemplate: input.url,
  contentType: input.contentType as never,
  sideEffect: input.sideEffect ?? "READ_ONLY",
  retryPolicy: input.retryPolicy ?? "SAFE",
  pointOfNoReturn: input.pointOfNoReturn ?? false,
  idempotencyConfig: json({ mode: "NONE" }),
  parameters: input.parameters ?? [],
  outputs: input.outputs ?? [],
});

const param = (place: string, key: string, source: string, selector?: string) => ({
  place: place as never,
  key,
  source: source as never,
  selector,
  transforms: json([]),
});

const out = (name: string, selector: string, storeAs: string, required = false) => ({
  name,
  selector,
  transforms: json([]),
  storeAs: storeAs as never,
  required,
});

export const fakeRailSeedHash = (options: FakeRailSeedOptions): string =>
  createHash("sha256")
    .update(`${GATEWAY_CODE}:${options.baseUrl}:${options.apiKey}:${options.publicBaseUrl ?? ""}`)
    .digest("hex");

export const seedFakeRails = async (
  prisma: PrismaClient,
  options: FakeRailSeedOptions,
): Promise<{ gatewayId: string; gatewayVersionId: string; rails: number }> => {
  const vault = new Vault();
  const seedHash = fakeRailSeedHash(options);
  const gateway = await prisma.gateway.upsert({
    where: { code: GATEWAY_CODE },
    update: {
      name: "Demo Rails Gateway",
      operator: "Payment Gateway Demo",
      aliases: ["demo", "fake"],
      kind: "AGGREGATOR",
      country: "LY",
      status: "LIVE",
      verificationState: "VERIFIED",
      riskClass: "NORMAL",
      metadata: json({ synthetic: true, namespace: options.namespace ?? NAMESPACE, seedHash }),
    },
    create: {
      code: GATEWAY_CODE,
      name: "Demo Rails Gateway",
      operator: "Payment Gateway Demo",
      aliases: ["demo", "fake"],
      kind: "AGGREGATOR",
      country: "LY",
      status: "LIVE",
      verificationState: "VERIFIED",
      riskClass: "NORMAL",
      metadata: json({ synthetic: true, namespace: options.namespace ?? NAMESPACE, seedHash }),
    },
  });

  const existingVersion = await prisma.gatewayVersion.findFirst({
    where: { gatewayId: gateway.id, contentHash: seedHash },
  });
  const latest = await prisma.gatewayVersion.findFirst({
    where: { gatewayId: gateway.id },
    orderBy: { versionNumber: "desc" },
  });
  const version = existingVersion ?? await prisma.gatewayVersion.create({
    data: {
      gatewayId: gateway.id,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      snapshotCiphertext: JSON.stringify({ synthetic: true, gatewayCode: GATEWAY_CODE, baseUrl: options.baseUrl }),
      contentHash: seedHash,
      state: "LIVE",
      createdById: (await prisma.user.findFirstOrThrow({ where: { role: "GATEWAY_ADMIN" } })).id,
      changeNote: "Synthetic demo rails",
    },
  });
  await prisma.gatewayVersion.updateMany({
    where: { gatewayId: gateway.id, id: { not: version.id }, state: "LIVE" },
    data: { state: "SUPERSEDED" },
  });
  await prisma.gateway.update({
    where: { id: gateway.id },
    data: { activeVersionId: version.id, status: "LIVE" },
  });

  const baseHost = new URL(options.baseUrl).hostname;
  await prisma.gatewayEnvironment.upsert({
    where: { gatewayVersionId_env: { gatewayVersionId: version.id, env: "LIVE" } },
    update: { baseUrls: json({ api: options.baseUrl }), allowedHosts: json([baseHost]), inboundIpAllowlist: json([]), outboundEgressIps: json([]), enabled: true },
    create: { gatewayVersionId: version.id, env: "LIVE", baseUrls: json({ api: options.baseUrl }), allowedHosts: json([baseHost]), inboundIpAllowlist: json([]), outboundEgressIps: json([]), enabled: true },
  });
  await prisma.gatewayEnvironment.upsert({
    where: { gatewayVersionId_env: { gatewayVersionId: version.id, env: "SANDBOX" } },
    update: { baseUrls: json({ api: options.baseUrl }), allowedHosts: json([baseHost]), inboundIpAllowlist: json([]), outboundEgressIps: json([]), enabled: true },
    create: { gatewayVersionId: version.id, env: "SANDBOX", baseUrls: json({ api: options.baseUrl }), allowedHosts: json([baseHost]), inboundIpAllowlist: json([]), outboundEgressIps: json([]), enabled: true },
  });
  await prisma.gatewayAuth.upsert({
    where: { gatewayVersionId_env: { gatewayVersionId: version.id, env: "LIVE" } },
    update: { method: "API_KEY", authApply: "HEADER", refreshConfigJson: json({ header_name: "X-API-KEY" }) },
    create: { gatewayVersionId: version.id, env: "LIVE", method: "API_KEY", authApply: "HEADER", refreshConfigJson: json({ header_name: "X-API-KEY" }) },
  });
  await prisma.gatewayAuth.upsert({
    where: { gatewayVersionId_env: { gatewayVersionId: version.id, env: "SANDBOX" } },
    update: { method: "API_KEY", authApply: "HEADER", refreshConfigJson: json({ header_name: "X-API-KEY" }) },
    create: { gatewayVersionId: version.id, env: "SANDBOX", method: "API_KEY", authApply: "HEADER", refreshConfigJson: json({ header_name: "X-API-KEY" }) },
  });
  const settingData = {
    amountScale: 100,
    amountPrecision: 2,
    amountRounding: "NEAREST",
    amountFormat: "STRING_DECIMAL",
    referenceFormat: json({ prefix: "DEMO", template: "{attempt.reference}" }),
    sessionTtlSeconds: 1200,
    otpTtlSeconds: 300,
    otpResendCooldownSeconds: 10,
    maxOtpAttempts: 3,
    supportsStatusCheck: true,
    statusCheckMinAgeSeconds: 1,
    supportsIdempotencyKey: true,
    supportsCancel: true,
    rateLimitPerSecond: 100,
    concurrencyCap: 100,
    timeoutMs: 5000,
    maxResponseBytes: 1048576,
    gatewayTimezone: "Africa/Tripoli",
  };
  await prisma.gatewaySetting.upsert({
    where: { gatewayVersionId: version.id },
    update: settingData,
    create: { gatewayVersionId: version.id, ...settingData },
  });

  const encryptedEntries = [
    { key: "api_key", type: "HEADER", value: await vault.encryptSecret(options.apiKey, "credential-set"), isSecret: true, secretVersion: 1 },
    ...(options.hmacSecret ? [{ key: "hmac_secret", type: "HEADER", value: await vault.encryptSecret(options.hmacSecret, "credential-set"), isSecret: true, secretVersion: 1 }] : []),
  ];
  for (const env of ["LIVE", "SANDBOX"] as const) {
    const existing = await prisma.credentialSet.findFirst({
      where: { gatewayId: gateway.id, env, externalMerchantId: "FAKE_RAILS" },
    });
    if (existing) {
      await prisma.credentialSet.update({
        where: { id: existing.id },
        data: { ownerType: "PLATFORM", settlementTarget: "PLATFORM_CLEARING", entriesCiphertext: json(encryptedEntries), status: "VERIFIED", lastVerifiedAt: new Date() },
      });
    } else {
      await prisma.credentialSet.create({
        data: { gatewayId: gateway.id, env, ownerType: "PLATFORM", externalMerchantId: "FAKE_RAILS", settlementTarget: "PLATFORM_CLEARING", entriesCiphertext: json(encryptedEntries), status: "VERIFIED", lastVerifiedAt: new Date() },
      });
    }
  }

  await prisma.flow.deleteMany({ where: { gatewayVersionId: version.id } });
  await prisma.statusRule.deleteMany({ where: { gatewayVersionId: version.id } });

  const statusRules: Array<Record<string, unknown>> = [
    { phase: "INITIATE", orderIndex: 0, selector: "status", op: "EQUALS", valueJson: json("PENDING"), canonicalStatus: "AWAITING_CUSTOMER" },
    { phase: "INITIATE", orderIndex: 1, selector: "status", op: "EQUALS", valueJson: json("FAILED"), canonicalStatus: "FAILED", canonicalError: "GATEWAY_REJECTED" },
    { phase: "SUBMIT", orderIndex: 0, selector: "status", op: "EQUALS", valueJson: json("SUCCESS"), canonicalStatus: "SUCCEEDED" },
    { phase: "SUBMIT", orderIndex: 1, selector: "status", op: "EQUALS", valueJson: json("INVALID_OTP"), canonicalStatus: "AWAITING_CUSTOMER", canonicalError: "RETRYABLE_OTP" },
    { phase: "SUBMIT", orderIndex: 2, selector: "status", op: "EQUALS", valueJson: json("FAILED"), canonicalStatus: "FAILED", canonicalError: "TERMINAL_DECLINE" },
    { phase: "VERIFY", orderIndex: 0, selector: "status", op: "EQUALS", valueJson: json("SUCCESS"), canonicalStatus: "SUCCEEDED" },
    { phase: "VERIFY", orderIndex: 1, selector: "status", op: "EQUALS", valueJson: json("FAILED"), canonicalStatus: "FAILED", canonicalError: "TERMINAL_DECLINE" },
    { phase: "VERIFY", orderIndex: 2, selector: "status", op: "EQUALS", valueJson: json("UNKNOWN"), canonicalStatus: "UNKNOWN" },
    { phase: "REFUND", orderIndex: 0, selector: "status", op: "EQUALS", valueJson: json("REFUNDED"), canonicalStatus: "SUCCEEDED" },
  ];
  await prisma.statusRule.createMany({
    data: statusRules.map((rule) => ({
      gatewayVersionId: version.id,
      phase: String(rule.phase),
      orderIndex: Number(rule.orderIndex),
      selector: String(rule.selector),
      op: rule.op as never,
      valueJson: rule.valueJson as never,
      canonicalStatus: rule.canonicalStatus as never,
      canonicalSubstatus: (rule.canonicalSubstatus as string | undefined) ?? null,
      canonicalError: (rule.canonicalError as string | undefined) ?? null,
    })),
  });

  for (const rail of RAILS) {
    const railRow = await prisma.rail.upsert({
      where: { code: rail.code },
      update: {
        nameAr: rail.nameAr,
        nameEn: rail.nameEn,
        collectionMode: rail.mode,
        subModes: json([rail.mode]),
        currency: "LYD",
        minAmount: dec("1.0000"),
        maxAmount: dec("100000.0000"),
        blocked: false,
        capabilities: json({ refund: true, partial_refund: true, void: true, capture: true, recurring: false }),
        instructionsAr: rail.instructionsAr,
        instructionsEn: rail.instructionsEn,
        metadata: json({ synthetic: true, namespace: NAMESPACE }),
      },
      create: {
        code: rail.code,
        nameAr: rail.nameAr,
        nameEn: rail.nameEn,
        collectionMode: rail.mode,
        subModes: json([rail.mode]),
        currency: "LYD",
        minAmount: dec("1.0000"),
        maxAmount: dec("100000.0000"),
        blocked: false,
        capabilities: json({ refund: true, partial_refund: true, void: true, capture: true, recurring: false }),
        instructionsAr: rail.instructionsAr,
        instructionsEn: rail.instructionsEn,
        metadata: json({ synthetic: true, namespace: NAMESPACE }),
      },
    });
    await prisma.railField.upsert({
      where: { railId_key: { railId: railRow.id, key: rail.fieldKey } },
      update: { type: rail.fieldType, labelAr: "رقم الهاتف", labelEn: "Mobile number", regex: "^0[0-9]{9}$", minLength: 10, maxLength: 10, required: true, orderIndex: 1, sensitivity: "SENSITIVE" },
      create: { railId: railRow.id, key: rail.fieldKey, type: rail.fieldType, labelAr: "رقم الهاتف", labelEn: "Mobile number", regex: "^0[0-9]{9}$", minLength: 10, maxLength: 10, required: true, orderIndex: 1, sensitivity: "SENSITIVE" },
    });
    if (rail.mode === "OTP_PULL") {
      await prisma.railField.upsert({
        where: { railId_key: { railId: railRow.id, key: "otp" } },
        update: { type: "OTP", labelAr: "رمز التحقق", labelEn: "OTP", regex: "^[0-9]{6}$", minLength: 6, maxLength: 6, required: true, orderIndex: 2, sensitivity: "SENSITIVE" },
        create: { railId: railRow.id, key: "otp", type: "OTP", labelAr: "رمز التحقق", labelEn: "OTP", regex: "^[0-9]{6}$", minLength: 6, maxLength: 6, required: true, orderIndex: 2, sensitivity: "SENSITIVE" },
      });
    }
    const route = await prisma.railRoute.upsert({
      where: { railId_gatewayId_credentialPolicy: { railId: railRow.id, gatewayId: gateway.id, credentialPolicy: "PLATFORM" } },
      update: {
        priority: 1,
        routingStrategy: "EFFECTIVE_COST",
        weight: 100,
        costModel: json({ calc_type: "PERCENTAGE", flat: "0.0000", percent: "1.5000", min: "0.1000", max: "25.0000", bearer: "MERCHANT_ABSORBS", accrue_fee_at_confirm: true }),
        mismatchPolicy: json({ tolerance_amount: "0.0100", underpay_action: "REJECT", overpay_action: "ALLOW" }),
        minAmount: dec("1.0000"),
        maxAmount: dec("100000.0000"),
        dailyCapAmount: dec("500000.0000"),
        status: "ACTIVE",
        healthState: "HEALTHY",
        scope: json({ risk_tiers: ["LOW", "STANDARD", "HIGH"], channels: ["WEB", "API", "POS"] }),
      },
      create: {
        railId: railRow.id,
        gatewayId: gateway.id,
        credentialPolicy: "PLATFORM",
        priority: 1,
        routingStrategy: "EFFECTIVE_COST",
        weight: 100,
        costModel: json({ calc_type: "PERCENTAGE", flat: "0.0000", percent: "1.5000", min: "0.1000", max: "25.0000", bearer: "MERCHANT_ABSORBS", accrue_fee_at_confirm: true }),
        mismatchPolicy: json({ tolerance_amount: "0.0100", underpay_action: "REJECT", overpay_action: "ALLOW" }),
        minAmount: dec("1.0000"),
        maxAmount: dec("100000.0000"),
        dailyCapAmount: dec("500000.0000"),
        status: "ACTIVE",
        healthState: "HEALTHY",
        scope: json({ risk_tiers: ["LOW", "STANDARD", "HIGH"], channels: ["WEB", "API", "POS"] }),
      },
    });
    if (rail.poll) {
      await prisma.pollPolicy.upsert({
        where: { routeId: route.id },
        update: { firstAfterSeconds: 1, backoffSeconds: json([2, 3, 5, 10]), maxDurationSeconds: 120, stopOnStates: json(["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"]) },
        create: { routeId: route.id, firstAfterSeconds: 1, backoffSeconds: json([2, 3, 5, 10]), maxDurationSeconds: 120, stopOnStates: json(["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"]) },
      });
    }
    await prisma.commissionProfile.upsert({
      where: { seedKey: `fake-rails:${rail.code}` },
      update: { merchantId: null, applicationId: null, railCode: rail.code, calcType: "PERCENTAGE", flatFee: dec("0"), percentageRate: dec("0.025000"), minFee: dec("0"), maxFee: dec("25.0000"), feeBearerDefault: "MERCHANT_ABSORBS", roundingMode: "HALF_UP", effectiveFrom: new Date("2020-01-01T00:00:00Z") },
      create: { merchantId: null, applicationId: null, railCode: rail.code, calcType: "PERCENTAGE", flatFee: dec("0"), percentageRate: dec("0.025000"), minFee: dec("0"), maxFee: dec("25.0000"), feeBearerDefault: "MERCHANT_ABSORBS", roundingMode: "HALF_UP", effectiveFrom: new Date("2020-01-01T00:00:00Z"), version: 1, seedKey: `fake-rails:${rail.code}` },
    });

    const common = [
      param("BODY", "reference", "ATTEMPT", "reference"),
      param("BODY", "amount", "ATTEMPT", "totalChargedAmount"),
      param("BODY", "currency", "ATTEMPT", "currency"),
      param("BODY", "environment", "ATTEMPT", "env"),
      param("BODY", "attempt_id", "ATTEMPT", "id"),
    ];
    const initiatePath = rail.mode === "OTP_PULL" ? "/otp/initiate" : rail.mode === "QR_DISPLAY" ? "/qr/initiate" : rail.mode === "PUSH_APPROVAL" ? "/push/initiate" : "/redirect/initiate";
    const initiateOutputs = rail.mode === "REDIRECT"
      ? [out("provider_reference", "provider_reference", "PROVIDER_REF", true), out("redirect_token", "return_token", "STATE", true), out("actionType", "action_type", "PUBLIC", true), out("url", "redirect_url", "PUBLIC", true), out("method", "method", "PUBLIC"), out("target", "target", "PUBLIC")]
      : rail.mode === "QR_DISPLAY"
        ? [out("provider_reference", "provider_reference", "PROVIDER_REF", true), out("actionType", "action_type", "PUBLIC", true), out("qr_payload", "qr_payload", "PUBLIC"), out("pay_code", "pay_code", "PUBLIC"), out("instructions_ar", "instructions_ar", "PUBLIC"), out("instructions_en", "instructions_en", "PUBLIC")]
        : rail.mode === "PUSH_APPROVAL"
          ? [out("provider_reference", "provider_reference", "PROVIDER_REF", true), out("actionType", "action_type", "PUBLIC", true), out("wallet_hint", "wallet_hint", "PUBLIC"), out("destination_account", "destination_account", "PUBLIC"), out("payment_reference", "payment_reference", "PUBLIC"), out("instructions_ar", "instructions_ar", "PUBLIC"), out("instructions_en", "instructions_en", "PUBLIC")]
          : [out("provider_reference", "provider_reference", "PROVIDER_REF", true), out("process_id", "process_id", "STATE")];
    const initiateSteps = [
      step({ name: `${rail.code}-initiate`, type: "HTTP", method: "POST", url: `{api}${initiatePath}`, contentType: "APPLICATION_JSON", sideEffect: "SENDS_NOTIFICATION", retryPolicy: "SAFE", parameters: [...common, ...(rail.mode === "REDIRECT" ? [param("BODY", "link_key", "ATTEMPT", "linkKey")] : [])], outputs: initiateOutputs }),
    ];
    await prisma.flow.create({
      data: {
        gatewayVersionId: version.id,
        railId: railRow.id,
        phase: "INITIATE",
        steps: {
          create: initiateSteps.map((entry, index) => ({
            orderIndex: index,
            type: entry.type as never,
            method: entry.method,
            urlTemplate: entry.urlTemplate,
            contentType: entry.contentType,
            sideEffect: entry.sideEffect as never,
            retryPolicy: entry.retryPolicy as never,
            pointOfNoReturn: entry.pointOfNoReturn,
            idempotencyConfig: entry.idempotencyConfig,
            parameters: { create: entry.parameters as never },
            outputs: { create: entry.outputs as never },
          })),
        },
      },
    });

    if (rail.mode === "OTP_PULL" || rail.mode === "REDIRECT") {
      const submitPath = rail.mode === "OTP_PULL" ? "/otp/confirm" : "/redirect/complete";
      const submitParams = rail.mode === "OTP_PULL"
        ? [...common, param("BODY", "process_id", "STATE", "process_id"), param("BODY", "code", "CUSTOMER_FIELD", "otp")]
        : [...common, param("BODY", "token", "STATE", "redirect_token"), param("BODY", "decision", "CUSTOMER_FIELD", "demo_outcome")];
      await prisma.flow.create({
        data: {
          gatewayVersionId: version.id,
          railId: railRow.id,
          phase: "SUBMIT",
          steps: {
            create: [{
              orderIndex: 0,
              type: "HTTP",
              method: "POST",
              urlTemplate: `{api}${submitPath}`,
              contentType: "APPLICATION_JSON",
              sideEffect: "MOVES_MONEY",
              retryPolicy: "NEVER",
              pointOfNoReturn: true,
              idempotencyConfig: json({ mode: "NONE" }),
              parameters: { create: submitParams as never },
              outputs: { create: [
                { name: "status", selector: "status", transforms: json([]), storeAs: "STATE", required: false },
                { name: "transaction_id", selector: "provider_reference", transforms: json([]), storeAs: "PROVIDER_REF", required: true },
                { name: "settled_amount", selector: "settled_amount", transforms: json([]), storeAs: "SETTLED_AMOUNT", required: false },
              ] },
            }],
          },
        },
      });
    } else {
      const statusPath = rail.mode === "QR_DISPLAY" ? "/qr/status" : "/push/status";
      await prisma.flow.create({
        data: {
          gatewayVersionId: version.id,
          railId: railRow.id,
          phase: "VERIFY",
          steps: {
            create: [{
              orderIndex: 0,
              type: "HTTP",
              method: "POST",
              urlTemplate: `{api}${statusPath}`,
              contentType: "APPLICATION_JSON",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              pointOfNoReturn: false,
              idempotencyConfig: json({ mode: "NONE" }),
              parameters: { create: common as never },
              outputs: { create: [
                { name: "status", selector: "status", transforms: json([]), storeAs: "STATE", required: false },
                { name: "transaction_id", selector: "provider_reference", transforms: json([]), storeAs: "PROVIDER_REF", required: true },
                { name: "settled_amount", selector: "settled_amount", transforms: json([]), storeAs: "SETTLED_AMOUNT", required: false },
              ] },
            }],
          },
        },
      });
    }

    await prisma.flow.create({
      data: {
        gatewayVersionId: version.id,
        railId: railRow.id,
        phase: "REFUND",
        steps: {
          create: [{
            orderIndex: 0,
            type: "HTTP",
            method: "POST",
            urlTemplate: "{api}/refund",
            contentType: "APPLICATION_JSON",
            sideEffect: "MOVES_MONEY",
            retryPolicy: "NEVER",
            pointOfNoReturn: true,
            idempotencyConfig: json({ mode: "NONE" }),
            parameters: { create: [...common, param("BODY", "refund_amount", "STATE", "refundAmount")] as never },
            outputs: { create: [{ name: "status", selector: "status", transforms: json([]), storeAs: "STATE", required: false }] },
          }],
        },
      },
    });
  }

  return { gatewayId: gateway.id, gatewayVersionId: version.id, rails: RAILS.length };
};
