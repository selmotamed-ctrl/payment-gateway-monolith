import { z } from "zod";

/**
 * Faithful transcription of the canonical core request schemas for the translated
 * routes (`core-back/api/internal/admin.ts`). Core validates the forwarded body with
 * these `.strict()` objects, so a payload that does not parse here is rejected by core
 * with `400 VALIDATION_FAILED`.
 */
export const CORE_SCHEMAS: Record<string, z.ZodType> = {
  "POST /gateways": z
    .object({
      code: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/),
      name: z.string().min(2).max(160),
      operator: z.string().min(2).max(160),
      country: z.string().length(2).default("LY"),
      aliases: z.array(z.string().min(1).max(64)).max(20).default([]),
      kind: z.enum(["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]),
      verificationState: z.enum(["VERIFIED", "UNVERIFIED"]).default("UNVERIFIED"),
      riskClass: z.enum(["NORMAL", "HIGH_RISK"]).default("NORMAL"),
    })
    .strict(),
  "PATCH /gateways/:id": z
    .object({
      name: z.string().min(2).max(160).optional(),
      operator: z.string().min(2).max(160).optional(),
      aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
      verificationState: z.enum(["VERIFIED", "UNVERIFIED"]).optional(),
      riskClass: z.enum(["NORMAL", "HIGH_RISK"]).optional(),
    })
    .strict(),
  "POST /gateways/:id/versions": z
    .object({
      changeNote: z.string().max(1000).optional(),
      snapshot: z.record(z.string().max(64), z.unknown()).default({}),
    })
    .strict(),
  "POST /gateways/:id/rollback": z.object({ versionId: z.string().min(1).max(64) }).strict(),
  "PUT /gateway-versions/:vid/environments": z
    .object({
      env: z.enum(["SANDBOX", "LIVE"]),
      baseUrls: z.record(z.string().max(40), z.string().max(500)),
      allowedHosts: z.array(z.string().max(200)).max(20),
      inboundIpAllowlist: z.array(z.string().max(64)).max(50).default([]),
      outboundEgressIps: z.array(z.string().max(64)).max(50).default([]),
      enabled: z.boolean().default(true),
    })
    .strict(),
  "PUT /gateway-versions/:vid/auth": z
    .object({
      env: z.enum(["SANDBOX", "LIVE"]),
      method: z.enum([
        "NONE",
        "API_KEY",
        "PERMANENT_TOKEN",
        "TOKEN_ENDPOINT",
        "REFRESH_TOKEN",
        "USERNAME_PASSWORD",
        "BASIC",
        "REQUEST_SIGNATURE",
        "OAUTH2_CLIENT_CREDENTIALS",
        "MUTUAL_TLS",
      ]),
      authApply: z.enum(["HEADER", "QUERY", "BODY"]),
      refreshConfigJson: z.record(z.string().max(64), z.unknown()).optional(),
    })
    .strict(),
  "PUT /gateway-versions/:vid/settings": z
    .object({
      amountScale: z.union([z.literal(1), z.literal(100), z.literal(1000)]),
      amountPrecision: z.union([z.literal(0), z.literal(2), z.literal(3)]),
      amountRounding: z.enum(["NONE", "NEAREST", "UP", "DOWN"]),
      amountFormat: z.enum(["STRING_DECIMAL", "INTEGER_MINOR_UNITS", "NUMBER"]),
      referenceFormat: z.record(z.string().max(40), z.unknown()),
      sessionTtlSeconds: z.number().int().min(30).max(86400),
      otpTtlSeconds: z.number().int().min(30).max(3600),
      otpResendCooldownSeconds: z.number().int().min(0).max(3600),
      maxOtpAttempts: z.number().int().min(1).max(10).default(3),
      supportsStatusCheck: z.boolean().default(false),
      statusCheckMinAgeSeconds: z.number().int().min(0).max(86400).optional(),
      supportsIdempotencyKey: z.boolean().default(false),
      supportsCancel: z.boolean().default(false),
      rateLimitPerSecond: z.number().int().min(1).max(1000).optional(),
      concurrencyCap: z.number().int().min(1).max(1000).optional(),
      timeoutMs: z.number().int().min(1000).max(120000).default(15000),
      maxResponseBytes: z.number().int().min(1024).max(10485760).default(2097152),
      gatewayTimezone: z.string().max(64).default("Africa/Tripoli"),
    })
    .strict(),
  "PUT /gateway-versions/:vid/crypto-profiles": z
    .object({
      profiles: z
        .array(
          z.object({
            name: z.string().min(1).max(64),
            purpose: z.enum(["OUTBOUND_SIGN", "INBOUND_VERIFY"]),
            algorithm: z.enum(["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "SHA256"]),
            secretKeyRef: z.string().max(120).optional(),
            secretKeyEncoding: z.enum(["UTF8", "HEX", "BASE64"]).default("UTF8"),
            canonicalizationMode: z.enum([
              "SORTED_KEY_VALUE_AMP",
              "SORTED_VALUES_HASH",
              "TEMPLATE_STRING",
              "JSON_CANONICAL",
              "RAW_BODY",
              "TIMESTAMP_DOT_RAW_BODY",
            ]),
            templateString: z.string().max(1000).optional(),
            includedFields: z.array(z.string().max(64)).max(100).default([]),
            excludedFields: z.array(z.string().max(64)).max(100).default([]),
            outputEncoding: z.enum(["HEX_LOWER", "HEX_UPPER", "BASE64"]).default("HEX_LOWER"),
          }),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  "PUT /gateway-versions/:vid/flows": z
    .object({
      flows: z
        .array(
          z.object({
            railId: z.string().min(1).max(64).optional(),
            subMode: z.string().max(64).optional(),
            phase: z.enum([
              "CREDENTIAL_CHECK",
              "PRE_INITIATE",
              "INITIATE",
              "SUBMIT",
              "VERIFY",
              "CANCEL",
              "REFUND",
              "VOID",
              "CAPTURE",
              "SETTLEMENT_FETCH",
            ]),
            steps: z
              .array(
                z.object({
                  type: z.enum(["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"]),
                  method: z.string().max(10).optional(),
                  urlTemplate: z.string().max(1000).optional(),
                  contentType: z.string().max(80).optional(),
                  sideEffect: z.enum(["READ_ONLY", "SENDS_NOTIFICATION", "MOVES_MONEY"]),
                  retryPolicy: z.enum(["SAFE", "SAFE_WITH_COOLDOWN", "NEVER"]),
                  pointOfNoReturn: z.boolean().default(false),
                  idempotencyConfig: z.record(z.string().max(64), z.unknown()).default({ mode: "NONE" }),
                  timeoutMs: z.number().int().min(1000).max(120000).optional(),
                }),
              )
              .max(50)
              .default([]),
          }),
        )
        .min(1)
        .max(40),
    })
    .strict(),
  "PUT /gateway-versions/:vid/channels": z
    .object({
      channels: z
        .array(
          z.object({
            routeId: z.string().max(64).optional(),
            type: z.enum(["WEBHOOK", "RETURN_URL", "BROWSER_CALLBACK", "POLL", "STATEMENT", "OPERATOR"]),
            pathToken: z.string().min(8).max(120),
            verifyMethod: z.enum([
              "HMAC_BODY",
              "HASH_FIELDS",
              "SORTED_VALUES_HASH",
              "RSA",
              "SHARED_TOKEN",
              "IP_ONLY",
              "NONE_PLUS_INQUIRY",
            ]),
            signatureHeader: z.string().max(120).optional(),
            timestampToleranceSec: z.number().int().min(30).max(86400).default(300),
            ipAllowlist: z.array(z.string().max(64)).max(50).default([]),
            bodyFormat: z.enum(["JSON", "FORM", "XML"]),
            correlationSelector: z.string().max(160).optional(),
            dedupeKeySelector: z.string().max(160).optional(),
            mustInquire: z.boolean().default(false),
            ackStatus: z.number().int().min(200).max(599).default(200),
            ackBodyTemplate: z.string().max(1000).optional(),
          }),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  "PUT /gateway-versions/:vid/status-rules": z
    .object({
      rules: z
        .array(
          z.object({
            phase: z.string().max(40),
            selector: z.string().max(160),
            op: z.enum(["equals", "not_equals", "in", "exists", "matches"]),
            value: z.unknown(),
            canonicalStatus: z.enum(["AWAITING_CUSTOMER", "VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN"]),
            canonicalSubstatus: z.string().max(80).optional(),
            canonicalError: z.string().max(80).optional(),
          }),
        )
        .min(1)
        .max(50),
    })
    .strict(),
  "PUT /gateway-versions/:vid/error-maps": z
    .object({
      maps: z
        .array(
          z.object({
            gatewayCode: z.string().min(1).max(80),
            canonicalError: z.string().min(1).max(80),
            classification: z.enum([
              "RETRYABLE_OTP",
              "TERMINAL_DECLINE",
              "LIMIT_EXCEEDED",
              "GATEWAY_FAULT",
              "AMBIGUOUS",
            ]),
            retryable: z.boolean().default(false),
            countsTowardLockout: z.boolean().default(false),
            countsTowardBreaker: z.boolean().default(false),
            customerMessageAr: z.string().max(500).optional(),
            customerMessageEn: z.string().max(500).optional(),
            operatorHint: z.string().max(500).optional(),
          }),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  "POST /gateway-versions/:vid/dry-run": z
    .object({
      railCode: z.string().max(64).optional(),
      amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      currency: z.string().length(3).optional(),
    })
    .strict(),
  "POST /gateway-versions/:vid/run-suite": z
    .object({ scenarios: z.array(z.string().max(64)).max(30).optional() })
    .strict(),
  "POST /users": z
    .object({
      email: z.email(),
      phone: z.string().min(6).max(20).optional(),
      password: z.string().min(10).max(128).optional(),
      role: z.enum([
        "GATEWAY_ADMIN",
        "SECURITY_ADMIN",
        "FINANCE",
        "OPERATOR",
        "COMPLIANCE",
        "MLRO",
        "SUPPORT",
      ]),
      authoritiesMap: z.array(z.string().min(2).max(64)).max(60).default([]),
      isMaker: z.boolean().default(false),
      isChecker: z.boolean().default(false),
    })
    .strict(),
  "PATCH /users": z
    .object({
      id: z.string().min(1).max(64),
      authoritiesMap: z.array(z.string().min(2).max(64)).max(60).optional(),
      role: z.string().max(40).optional(),
      status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
      isMaker: z.boolean().optional(),
      isChecker: z.boolean().optional(),
    })
    .strict(),
  "PATCH /users/:id": z
    .object({
      authoritiesMap: z.array(z.string().min(2).max(64)).max(60).optional(),
      role: z.string().max(40).optional(),
      status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
    })
    .strict(),
  "POST /join-requests/:id/assign": z.object({ reviewerId: z.string().min(1).max(64) }).strict(),
  "POST /join-requests/:id/request-info": z
    .object({
      items: z.array(z.object({ field: z.string().max(80), message: z.string().max(500) })).min(1),
    })
    .strict(),
  "POST /join-requests/:id/decide": z
    .object({
      decision: z.enum(["APPROVED", "REJECTED"]),
      reasonCode: z.string().max(64).optional(),
      notes: z.string().max(4000).optional(),
      proposedRiskTier: z.enum(["LOW", "STANDARD", "HIGH"]).optional(),
    })
    .strict(),
  "POST /kyb-documents/:id/review": z
    .object({
      decision: z.enum(["ACCEPTED", "REJECTED"]),
      reasonCode: z.string().max(64).optional(),
      expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .strict(),
  "POST /merchants/:id/suspend": z
    .object({ reasonCode: z.string().min(2).max(64), notes: z.string().max(2000).optional() })
    .strict(),
  // core does not read a body on the reinstate route.
  "POST /merchants/:id/reinstate": z.unknown(),
  "POST /merchants/:id/propose-edit": z
    .object({ patch: z.array(z.record(z.string().max(64), z.unknown())).min(1) })
    .strict(),
  "POST /approvals/:id/approve": z
    .object({
      notes: z.string().max(2000).optional(),
      riskAcceptanceNote: z.string().max(2000).optional(),
    })
    .strict(),
  "POST /approvals/:id/reject": z.object({ reason: z.string().min(2).max(2000) }).strict(),
  "POST /aml/matches/:id/disposition": z
    .object({
      disposition: z.enum(["FALSE_POSITIVE", "TRUE_MATCH", "ESCALATED"]),
      notes: z.string().max(2000).optional(),
      suppressFuture: z.boolean().default(false),
      suppressUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .strict(),
  "POST /aml/cases/:id/propose": z
    .object({
      action: z.enum(["HOLD", "RELEASE", "REJECT", "ESCALATE"]),
      notes: z.string().max(2000).optional(),
    })
    .strict(),
  "POST /aml/rules": z
    .object({
      code: z.string().min(2).max(64),
      name: z.string().min(2).max(160),
      ruleType: z.enum([
        "SINGLE_AMOUNT",
        "CUMULATIVE_WINDOW",
        "STRUCTURING",
        "RISK_TIER",
        "COUNTERPARTY_COUNTRY",
        "RAIL",
        "MERCHANT_DIRECT_AMOUNT",
      ]),
      scope: z.record(z.string().max(64), z.unknown()).default({}),
      params: z.record(z.string().max(64), z.unknown()).default({}),
      action: z.enum(["HOLD", "FLAG", "BLOCK", "CASE_ONLY"]),
      baseSeverity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      effectiveFrom: z.string().max(64).optional(),
    })
    .strict(),
  "POST /aml/reporting-rules": z
    .object({
      reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]),
      thresholdAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      windowSeconds: z.number().int().min(1).max(31_536_000).optional(),
      currency: z.string().length(3).default("LYD"),
      conditions: z.record(z.string().max(64), z.unknown()).default({}),
      sourceReference: z.string().min(2).max(200),
      status: z.enum(["PROVISIONAL", "CONFIRMED"]).default("PROVISIONAL"),
    })
    .strict(),
  "POST /aml/reports": z
    .object({
      reportType: z.enum(["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]),
      authority: z.string().min(2).max(64).default("CBL"),
      subjectType: z.string().min(2).max(40),
      subjectId: z.string().min(1).max(64),
      amlCaseId: z.string().min(1).max(64).optional(),
      payload: z.record(z.string().max(64), z.unknown()),
    })
    .strict(),
  "POST /rails": z
    .object({
      code: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/),
      nameAr: z.string().min(1).max(160),
      nameEn: z.string().min(1).max(160),
      collectionMode: z.enum([
        "OTP_PULL",
        "REDIRECT",
        "EMBEDDED",
        "PUSH_APPROVAL",
        "QR_DISPLAY",
        "PAY_CODE",
        "DEEP_LINK",
        "MANUAL",
        "HYBRID",
      ]),
      subModes: z.array(z.string().max(64)).max(20).optional(),
      currency: z.string().length(3).default("LYD"),
      minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
      maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      displayOrder: z.number().int().min(0).max(9999).default(0),
      capabilities: z.record(z.string().max(40), z.boolean()).default({}),
      refundWindowDays: z.number().int().min(0).max(3650).optional(),
      instructionsAr: z.string().max(2000).optional(),
      instructionsEn: z.string().max(2000).optional(),
    })
    .strict(),
  "PATCH /rails/:id": z
    .object({
      nameAr: z.string().min(1).max(160).optional(),
      nameEn: z.string().min(1).max(160).optional(),
      blocked: z.boolean().optional(),
      displayOrder: z.number().int().min(0).max(9999).optional(),
      minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      capabilities: z.record(z.string().max(40), z.boolean()).optional(),
      instructionsAr: z.string().max(2000).optional(),
      instructionsEn: z.string().max(2000).optional(),
    })
    .strict(),
  "PUT /rails/:id/fields": z
    .object({
      fields: z
        .array(
          z.object({
            key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
            type: z.enum([
              "phone",
              "number",
              "string",
              "otp",
              "birth_year",
              "card_number",
              "pan",
              "wallet_id",
              "from_list",
            ]),
            checksum: z.enum(["NONE", "LUHN"]).default("NONE"),
            labelAr: z.string().min(1).max(200),
            labelEn: z.string().min(1).max(200),
            placeholderAr: z.string().max(200).optional(),
            placeholderEn: z.string().max(200).optional(),
            regex: z.string().max(200).optional(),
            minLength: z.number().int().min(0).max(64).optional(),
            maxLength: z.number().int().min(0).max(64).optional(),
            minVal: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
            maxVal: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
            optionsJson: z.record(z.string().max(64), z.unknown()).optional(),
            required: z.boolean().default(true),
            orderIndex: z.number().int().min(0).max(999),
            sensitivity: z.enum(["NORMAL", "SENSITIVE", "PAN"]).default("NORMAL"),
            normalizer: z.record(z.string().max(64), z.unknown()).optional(),
          }),
        )
        .max(40),
    })
    .strict(),
  "POST /routes": z
    .object({
      railId: z.string().min(1).max(64),
      gatewayId: z.string().min(1).max(64),
      credentialPolicy: z.enum(["PLATFORM", "MERCHANT_REQUIRED", "MERCHANT_OR_PLATFORM"]),
      priority: z.number().int().min(0).max(9999).default(0),
      routingStrategy: z.enum(["EFFECTIVE_COST", "STRICT_PRIORITY", "WEIGHTED"]).default("EFFECTIVE_COST"),
      weight: z.number().int().min(1).max(1000).default(100),
      costModel: z.record(z.string().max(64), z.unknown()).default({}),
      mismatchPolicy: z.record(z.string().max(64), z.unknown()).default({}),
      minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
      maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      dailyCapAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      scope: z.record(z.string().max(64), z.unknown()).default({}),
    })
    .strict(),
  "PATCH /routes/:id": z
    .object({
      priority: z.number().int().min(0).max(9999).optional(),
      weight: z.number().int().min(1).max(1000).optional(),
      minAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      dailyCapAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      scope: z.record(z.string().max(64), z.unknown()).optional(),
      costModel: z.record(z.string().max(64), z.unknown()).optional(),
    })
    .strict(),
  "POST /routes/:id/state": z
    .object({
      status: z.enum(["ACTIVE", "PAUSED", "DRAINING"]),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  "POST /assets": z
    .object({
      name: z.string().min(1).max(120),
      mime: z.enum(["image/png", "image/svg+xml"]),
      sizeBytes: z.number().int().min(1).max(2_000_000),
      storageKey: z.string().min(1).max(300),
      sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  "POST /operator-cases/:id/resolve": z
    .object({
      resolution: z.string().min(2).max(4000),
      state: z.enum(["RESOLVED", "IN_PROGRESS"]).default("RESOLVED"),
    })
    .strict(),
  "POST /reconciliation/sources": z
    .object({
      gatewayId: z.string().min(1).max(64),
      type: z.enum(["API", "SFTP", "UPLOAD"]),
      scheduleCron: z.string().max(120).optional(),
      parserConfig: z.record(z.string().max(64), z.unknown()),
      settlementLagDays: z.number().int().min(0).max(365).default(0),
      dedupeKeyTemplate: z.string().max(200).optional(),
    })
    .strict(),
  // core reads the statement payload and the `x-statement-source-id` header on this route,
  // it does not validate a strict json body.
  "POST /reconciliation/upload": z.unknown(),
  "POST /disputes": z
    .object({
      attemptId: z.string().min(1).max(64),
      gatewayId: z.string().min(1).max(64),
      railId: z.string().min(1).max(64),
      externalDisputeRef: z.string().min(2).max(120),
      source: z.enum(["WEBHOOK", "STATEMENT", "MANUAL"]),
      reasonCode: z.string().max(80).optional(),
      amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
      currency: z.string().length(3),
    })
    .strict(),
  "POST /adjustments": z
    .object({
      type: z.enum([
        "CHARGEBACK",
        "REFUND",
        "MANUAL_CREDIT",
        "MANUAL_DEBIT",
        "CORRECTION",
        "CASHOUT_SUBTRACTION",
      ]),
      targetGlAccountId: z.string().min(1).max(64),
      sourceAttemptId: z.string().max(64).optional(),
      disputeId: z.string().max(64).optional(),
      amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
      reverseCommission: z.boolean().default(false),
      reason: z.string().min(2).max(1000),
      externalDisputeRef: z.string().max(120).optional(),
    })
    .strict(),
  "POST /cashouts/:id/process": z
    .object({
      decision: z.enum(["APPROVE", "REJECT"]),
      reason: z.string().max(1000).optional(),
    })
    .strict(),
  "POST /commission-profiles": z
    .object({
      merchantId: z.string().max(64).optional(),
      applicationId: z.string().max(64).optional(),
      railCode: z.string().min(1).max(64),
      calcType: z.enum(["FLAT", "PERCENTAGE", "TIERED", "HYBRID"]),
      flatFee: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
      percentageRate: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default("0.000000"),
      tiersJson: z.record(z.string().max(64), z.unknown()).optional(),
      minFee: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default("0.0000"),
      maxFee: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      feeBearerDefault: z
        .enum(["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"])
        .default("MERCHANT_ABSORBS"),
      roundingMode: z.string().max(32).default("HALF_UP"),
      effectiveFrom: z.string().max(64).optional(),
    })
    .strict(),
  "POST /velocity-rules": z
    .object({
      scopeType: z.enum([
        "END_CLIENT_IP",
        "END_CLIENT_PHONE",
        "END_CLIENT_CARD",
        "MERCHANT",
        "APPLICATION",
        "RAIL",
        "LINK",
      ]),
      scopeValue: z.string().max(160).optional(),
      windowSeconds: z.number().int().min(1).max(31_536_000),
      maxCount: z.number().int().min(1).max(1_000_000),
      maxAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
      action: z.enum(["REJECT", "FLAG"]),
    })
    .strict(),
  "PUT /settings": z
    .object({
      settings: z
        .array(
          z.object({
            key: z.string().min(1).max(120),
            valueJson: z.record(z.string().max(64), z.unknown()),
            effectiveFrom: z.string().max(64).optional(),
          }),
        )
        .min(1)
        .max(50),
    })
    .strict(),
};
