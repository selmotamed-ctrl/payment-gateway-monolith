import { z } from "zod";

export const zUuid = z.string().min(1, "identifier is required");

export const zAmount = z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .refine((value) => /^-?\d+(\.\d+)?$/.test(value.trim()), "amount must be a decimal string");

export const zCurrency = z
    .string()
    .trim()
    .min(3)
    .max(3)
    .regex(/^[A-Za-z]{3}$/, "currency must be a 3 letter ISO code")
    .transform((value) => value.toUpperCase());

export const zPhone = z
    .string()
    .trim()
    .min(9)
    .max(20)
    .regex(/^\+?[0-9]{9,15}$/, "phone must be a valid international number");

export const zNationalId = z.string().trim().min(4, "national id is required").max(32);

export const zLinkKey = z.string().trim().min(6).max(120);

export const zPercent = z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .refine((value) => /^\d+(\.\d+)?$/.test(value.trim()), "percent must be a decimal string");

export const zPagination = z.object({
    skip: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(20),
});

export const zDateRange = z
    .object({
        from: z.string().optional(),
        to: z.string().optional(),
    })
    .optional();

export const zSearch = z.string().trim().max(120).optional();

export const zIdempotencyKey = z.string().trim().min(8).max(120);

export const zEnumValue = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

export const zApprovalDecision = z.enum(["APPROVE", "REJECT"]);

export const zJoinRequestDecision = z.enum(["APPROVE", "REJECT"]);

export const zDisposition = z.enum(["FALSE_POSITIVE", "TRUE_MATCH", "ESCALATED"]);

export const zCaseResolution = z.enum(["RELEASE", "VOID_AND_RETURN", "FREEZE", "ESCALATE_STR"]);

export const zCaseSeverity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const zGatewayKind = z.enum(["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]);

export const zVerificationState = z.enum(["VERIFIED", "UNVERIFIED"]);

export const zRiskClass = z.enum(["NORMAL", "HIGH_RISK"]);

export const zGatewayEnvironment = z.enum(["SANDBOX", "LIVE"]);

export const zAuthMethod = z.enum([
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
]);

export const zCredentialOwner = z.enum(["PLATFORM", "MERCHANT"]);

export const zSettlementTarget = z.enum(["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]);

export const zFieldSensitivity = z.enum(["NORMAL", "SENSITIVE", "PAN"]);

export const zNormalizer = z.enum([
    "NONE",
    "ARABIC_DIGITS_TO_ASCII",
    "PHONE_NORMALIZE_LOCAL_09",
    "PHONE_NORMALIZE_INTL_218",
    "PHONE_NORMALIZE_E164",
]);

export const zFlowPhase = z.enum([
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
]);

export const zStepType = z.enum(["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"]);

export const zSideEffect = z.enum(["READ_ONLY", "SAFE_WITH_COOLDOWN", "SENDS_NOTIFICATION", "MOVES_MONEY"]);

export const zRetryPolicy = z.enum(["NEVER", "SAFE", "IDEMPOTENT"]);

export const zClientActionKind = z.enum([
    "SHOW_OTP_FORM",
    "HTTP_REDIRECT",
    "RENDER_EMBEDDED",
    "SHOW_QR_OR_CODE",
    "SHOW_PUSH_OR_TRANSFER",
]);

export const zConfirmationChannelKind = z.enum([
    "SYNC_RESPONSE",
    "WEBHOOK",
    "INQUIRY_POLL",
    "RETURN_URL",
    "BROWSER_CALLBACK",
    "STATEMENT",
    "OPERATOR",
]);

export const zRouteStatus = z.enum(["ACTIVE", "PAUSED", "DRAINING"]);

export const zHealthState = z.enum(["HEALTHY", "DEGRADED", "OPEN_BREAKER"]);

export const zAmountRounding = z.enum(["NONE", "NEAREST", "UP", "DOWN"]);

export const zTransformOp = z.enum([
    "scale",
    "MUL_INT",
    "DIV_DECIMAL",
    "round",
    "format_decimal",
    "to_int",
    "to_number",
    "to_string",
    "concat",
    "template",
    "lowercase",
    "uppercase",
    "trim",
    "pad_left",
    "pad_right",
    "substring",
    "mask",
    "prepend",
    "arabic_digits_to_ascii",
    "phone_normalize",
    "sort_keys",
    "values_only",
    "join_pairs",
    "format_date",
    "epoch_seconds",
    "epoch_millis",
    "uuid",
    "numeric_random",
    "base64_encode",
    "hex_lower",
    "hex_upper",
    "url_encode",
    "json_encode",
    "xml_escape",
    "sha256",
    "sha512",
    "hmac_sha256",
    "hmac_sha512",
    "rsa_sha256_sign",
]);

export const zTransform = z.object({
    op: zTransformOp,
    args: z.array(z.unknown()).optional(),
    keyRef: z.string().optional(),
    keyEncoding: z.enum(["utf8", "hex", "base64"]).optional(),
});

export const zDryRunRequest = z.object({
    phase: zFlowPhase,
    formData: z.record(z.string(), z.unknown()).optional(),
    sampleAmount: zAmount.optional(),
    sampleCurrency: zCurrency.optional(),
    scenario: z.string().optional(),
});

export const zGoLiveGate = z.object({
    key: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
});

export const zMoneyBreakdown = z.object({
    total: zAmount,
    fee: zAmount,
    net: zAmount,
    currency: zCurrency,
});
