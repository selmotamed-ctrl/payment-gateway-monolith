import { z } from "zod";

/**
 * The unified integration spec.
 *
 * This is the single contract between the "Bring-Your-Own-AI" onboarding kit
 * (the transcript the admin hands to an external AI) and the platform. The AI
 * emits a spec; the platform verifies it against the real engine and imports
 * it as a DRAFT gateway version.
 *
 * The vocabulary is deliberately snake_case: it is an external, AI-authored
 * document, and it mirrors the design's own wording (design v5 §10, §7.2-§7.4,
 * §8.4). The materializer maps it onto the camelCase Prisma models.
 */
export const SPEC_VERSION = "1.0";

/** The closed lists. They are the single source of truth for the transcript. */
export const SPEC_AUTH_METHODS = [
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
] as const;

export const SPEC_AUTH_APPLY = ["HEADER", "QUERY", "BODY"] as const;
export const SPEC_GATEWAY_KINDS = ["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"] as const;
export const SPEC_ENVIRONMENTS = ["SANDBOX", "LIVE"] as const;

export const SPEC_FLOW_PHASES = [
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
] as const;

export const SPEC_STEP_TYPES = ["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"] as const;
export const SPEC_STEP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const SPEC_SIDE_EFFECTS = ["READ_ONLY", "SENDS_NOTIFICATION", "MOVES_MONEY"] as const;
export const SPEC_RETRY_POLICIES = ["SAFE", "SAFE_WITH_COOLDOWN", "NEVER"] as const;
export const SPEC_CONTENT_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "application/xml",
  "text/xml",
  "text/plain",
] as const;

export const SPEC_PARAMETER_PLACES = [
  "HEADERS",
  "QUERY",
  "PATH",
  "BODY",
  "FORM",
  "MULTIPART",
  "XML",
] as const;

export const SPEC_PARAMETER_SOURCES = [
  "GATEWAY_META",
  "ROUTE_META",
  "CREDENTIAL",
  "ATTEMPT",
  "CUSTOMER_FIELD",
  "STATE",
  "PREVIOUS_RESPONSE",
  "URLS",
  "CLIENT_CONTEXT",
  "CONSTANT",
  "NOW",
  "RANDOM",
  "COMPUTED",
  "CRYPTO_SIGNATURE",
] as const;

export const SPEC_OUTPUT_STORES = [
  "STATE",
  "PUBLIC",
  "SETTLED_AMOUNT",
  "PROVIDER_FEE",
  "PROVIDER_REF",
  "NETWORK_REF",
] as const;

export const SPEC_STATUS_OPS = ["equals", "not_equals", "in", "exists", "matches"] as const;
export const SPEC_CANONICAL_STATUSES = [
  "AWAITING_CUSTOMER",
  "VERIFYING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
] as const;

export const SPEC_COLLECTION_MODES = [
  "OTP_PULL",
  "REDIRECT",
  "EMBEDDED",
  "PUSH_APPROVAL",
  "QR_DISPLAY",
  "PAY_CODE",
  "DEEP_LINK",
  "MANUAL",
  "HYBRID",
] as const;

export const SPEC_RAIL_FIELD_TYPES = [
  "PHONE",
  "NUMBER",
  "STRING",
  "OTP",
  "BIRTH_YEAR",
  "CARD_NUMBER",
  "PAN",
  "WALLET_ID",
  "FROM_LIST",
] as const;

export const SPEC_SENSITIVITY = ["NORMAL", "SENSITIVE", "PAN"] as const;

export const SPEC_CREDENTIAL_POLICIES = [
  "PLATFORM",
  "MERCHANT_REQUIRED",
  "MERCHANT_OR_PLATFORM",
] as const;

export const SPEC_ROUTING_STRATEGIES = ["EFFECTIVE_COST", "STRICT_PRIORITY", "WEIGHTED"] as const;

export const SPEC_CRYPTO_ALGORITHMS = ["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "SHA256"] as const;
export const SPEC_CRYPTO_PURPOSES = ["OUTBOUND_SIGN", "INBOUND_VERIFY"] as const;
export const SPEC_KEY_ENCODINGS = ["UTF8", "HEX", "BASE64"] as const;
export const SPEC_OUTPUT_ENCODINGS = ["HEX_LOWER", "HEX_UPPER", "BASE64"] as const;
export const SPEC_CANONICALIZATION_MODES = [
  "SORTED_KEY_VALUE_AMP",
  "SORTED_VALUES_HASH",
  "TEMPLATE_STRING",
  "JSON_CANONICAL",
  "RAW_BODY",
  "TIMESTAMP_DOT_RAW_BODY",
] as const;

export const SPEC_CHANNEL_TYPES = [
  "WEBHOOK",
  "RETURN_URL",
  "BROWSER_CALLBACK",
  "POLL",
  "STATEMENT",
  "OPERATOR",
] as const;

export const SPEC_VERIFY_METHODS = [
  "HMAC_BODY",
  "HASH_FIELDS",
  "SORTED_VALUES_HASH",
  "RSA",
  "SHARED_TOKEN",
  "IP_ONLY",
  "NONE_PLUS_INQUIRY",
] as const;

export const SPEC_BODY_FORMATS = ["JSON", "FORM", "XML"] as const;

export const SPEC_ERROR_CLASSIFICATIONS = [
  "RETRYABLE_OTP",
  "TERMINAL_DECLINE",
  "LIMIT_EXCEEDED",
  "GATEWAY_FAULT",
  "AMBIGUOUS",
] as const;

export const SPEC_AMOUNT_ROUNDING = ["NONE", "NEAREST", "UP", "DOWN"] as const;
export const SPEC_AMOUNT_FORMATS = ["STRING_DECIMAL", "INTEGER_MINOR_UNITS", "NUMBER"] as const;

/**
 * The transform operations the engine accepts. Kept in sync with
 * `TransformPipeline.TRANSFORM_OPERATIONS`; a test asserts the equality so the
 * transcript can never advertise an operation the engine does not have.
 */
export const SPEC_TRANSFORM_OPERATIONS = [
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
] as const;

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalTrimmed = (max: number) => z.string().trim().max(max).optional();
const decimalString = (max = 24) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, "must be a decimal string")
    .max(max);
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute https:// URL");

export const TransformPipeSpec = z
  .strictObject({
    op: z.enum(SPEC_TRANSFORM_OPERATIONS),
    args: z.array(z.unknown()).max(12).optional(),
  })
  .describe("One operation of the closed transform library.");

export const RailFieldSpec = z
  .strictObject({
    key: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, "must be snake_case"),
    type: z.enum(SPEC_RAIL_FIELD_TYPES),
    label_ar: trimmed(160),
    label_en: trimmed(160),
    placeholder_ar: optionalTrimmed(160),
    placeholder_en: optionalTrimmed(160),
    required: z.boolean().default(true),
    regex: z.string().max(300).optional(),
    min_length: z.number().int().min(0).max(4096).optional(),
    max_length: z.number().int().min(1).max(4096).optional(),
    sensitivity: z.enum(SPEC_SENSITIVITY).default("NORMAL"),
    options: z.array(z.string().max(120)).max(100).optional(),
    order_index: z.number().int().min(0).max(1000).default(0),
  })
  .describe("One customer form field of the rail.");

export const StepParameterSpec = z
  .strictObject({
    place: z.enum(SPEC_PARAMETER_PLACES),
    key: z.string().trim().min(1).max(120),
    source: z.enum(SPEC_PARAMETER_SOURCES),
    selector: z.string().trim().max(200).optional(),
    constant_value: z.unknown().optional(),
    crypto_profile: z.string().max(64).optional(),
    transforms: z.array(TransformPipeSpec).max(32).optional(),
  })
  .describe("One request parameter of a step.");

export const StepOutputSpec = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    selector: z.string().trim().max(200).optional(),
    transforms: z.array(TransformPipeSpec).max(32).optional(),
    store_as: z.enum(SPEC_OUTPUT_STORES),
    required: z.boolean().default(false),
  })
  .describe("One value extracted from the response.");

export const StatusRuleSpec = z
  .strictObject({
    selector: z.string().trim().min(1).max(200),
    op: z.enum(SPEC_STATUS_OPS),
    value: z.unknown().optional(),
    canonical_status: z.enum(SPEC_CANONICAL_STATUSES),
    canonical_substatus: z.string().max(80).optional(),
    canonical_error: z.string().max(80).optional(),
  })
  .describe("Maps a gateway response value onto a canonical status.");

export const FlowStepSpec = z
  .strictObject({
    id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a slug"),
    order_index: z.number().int().min(0).max(1000).default(0),
    type: z.enum(SPEC_STEP_TYPES),
    method: z.enum(SPEC_STEP_METHODS).optional(),
    url_template: z.string().trim().max(500).optional(),
    content_type: z.enum(SPEC_CONTENT_TYPES).optional(),
    xml_template: z.string().max(8000).optional(),
    timeout_ms: z.number().int().min(500).max(120000).optional(),
    side_effect: z.enum(SPEC_SIDE_EFFECTS).default("READ_ONLY"),
    retry_policy: z.enum(SPEC_RETRY_POLICIES).default("SAFE"),
    point_of_no_return: z.boolean().default(false),
    idempotency_config: z
      .strictObject({
        mode: z.enum(["NONE", "HEADER", "BODY_FIELD"]).default("NONE"),
        key_name: z.string().max(80).optional(),
        source_template: z.string().max(200).optional(),
      })
      .default({ mode: "NONE" }),
    compute: z
      .strictObject({
        name: z.string().trim().min(1).max(80),
        transforms: z.array(TransformPipeSpec).max(32).optional(),
      })
      .optional(),
    render: z
      .strictObject({
        action: z.enum([
          "SHOW_OTP_FORM",
          "HTTP_REDIRECT",
          "RENDER_EMBEDDED",
          "SHOW_QR_OR_CODE",
          "SHOW_PUSH_OR_TRANSFER",
        ]),
        values: z.record(z.string().max(64), z.unknown()).optional(),
      })
      .optional(),
    wait: z
      .strictObject({
        duration_ms: z.number().int().min(0).max(60000).optional(),
        timeout_ms: z.number().int().min(0).max(86400000).optional(),
      })
      .optional(),
    assertions: z
      .array(
        z.strictObject({
          selector: z.string().trim().min(1).max(200),
          op: z.enum(SPEC_STATUS_OPS),
          value: z.unknown().optional(),
        }),
      )
      .max(20)
      .optional(),
    branch: z
      .strictObject({
        selector: z.string().trim().min(1).max(200),
        op: z.enum(SPEC_STATUS_OPS),
        value: z.unknown().optional(),
        then_step_id: z.string().max(80).optional(),
        else_step_id: z.string().max(80).optional(),
      })
      .optional(),
    parameters: z.array(StepParameterSpec).max(64).default([]),
    outputs: z.array(StepOutputSpec).max(64).default([]),
    status_rules: z.array(StatusRuleSpec).max(40).default([]),
  })
  .describe("One step of a declarative flow.");

export const FlowSpec = z
  .strictObject({
    phase: z.enum(SPEC_FLOW_PHASES),
    sub_mode: z.string().max(40).optional(),
    steps: z.array(FlowStepSpec).min(1).max(30),
  })
  .describe("The steps of one flow phase.");

export const CryptoProfileSpec = z
  .strictObject({
    name: z.string().trim().min(1).max(64),
    purpose: z.enum(SPEC_CRYPTO_PURPOSES),
    algorithm: z.enum(SPEC_CRYPTO_ALGORITHMS),
    secret_key_ref: z.string().trim().max(120).optional(),
    secret_key_encoding: z.enum(SPEC_KEY_ENCODINGS).default("UTF8"),
    canonicalization_mode: z.enum(SPEC_CANONICALIZATION_MODES),
    template_string: z.string().max(2000).optional(),
    included_fields: z.array(z.string().max(80)).max(100).default([]),
    excluded_fields: z.array(z.string().max(80)).max(100).default([]),
    output_encoding: z.enum(SPEC_OUTPUT_ENCODINGS).default("HEX_LOWER"),
  })
  .describe("A signing / verification recipe.");

export const ConfirmationChannelSpec = z
  .strictObject({
    type: z.enum(SPEC_CHANNEL_TYPES),
    path_token: z
      .string()
      .trim()
      .min(8)
      .max(120)
      .regex(/^[A-Za-z0-9_-]+$/, "must be url-safe"),
    crypto_profile: z.string().max(64).optional(),
    verify_method: z.enum(SPEC_VERIFY_METHODS),
    signature_header: z.string().max(80).optional(),
    timestamp_selector: z.string().max(120).optional(),
    timestamp_tolerance_sec: z.number().int().min(0).max(86400).default(300),
    ip_allowlist: z.array(z.string().max(64)).max(50).default([]),
    body_format: z.enum(SPEC_BODY_FORMATS).default("JSON"),
    correlation_selector: z.string().max(160).optional(),
    dedupe_key_selector: z.string().max(160).optional(),
    event_map: z.record(z.string().max(64), z.string().max(64)).default({}),
    must_inquire: z.boolean().default(false),
    ack_status: z.number().int().min(200).max(299).default(200),
    ack_body_template: z.string().max(2000).optional(),
  })
  .describe("How the gateway calls us back (or how we poll).");

export const ErrorMapSpec = z
  .strictObject({
    gateway_code: z.string().trim().min(1).max(80),
    canonical_error: z.string().trim().min(1).max(80),
    classification: z.enum(SPEC_ERROR_CLASSIFICATIONS),
    retryable: z.boolean().default(false),
    counts_toward_lockout: z.boolean().default(false),
    counts_toward_breaker: z.boolean().default(false),
    customer_message_ar: optionalTrimmed(300),
    customer_message_en: optionalTrimmed(300),
    operator_hint: optionalTrimmed(500),
  })
  .describe("Maps a gateway error to a canonical error.");

export const GatewaySpec = z
  .strictObject({
    code: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9_-]+$/, "must be a lowercase slug"),
    name: trimmed(160),
    operator: trimmed(160),
    country: z.string().trim().length(2).default("LY"),
    aliases: z.array(z.string().max(64)).max(20).default([]),
    kind: z.enum(SPEC_GATEWAY_KINDS),
    risk_class: z.enum(["NORMAL", "HIGH"]).default("NORMAL"),
  })
  .describe("Identity of the gateway / provider.");

export const EnvironmentSpec = z
  .strictObject({
    env: z.enum(SPEC_ENVIRONMENTS),
    base_urls: z.record(z.string().max(40), httpsUrl).default({}),
    allowed_hosts: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    inbound_ip_allowlist: z.array(z.string().max(64)).max(50).default([]),
    enabled: z.boolean().default(true),
  })
  .describe("One environment (sandbox / live) and its hosts.");

export const AuthSpec = z
  .strictObject({
    env: z.enum(SPEC_ENVIRONMENTS),
    method: z.enum(SPEC_AUTH_METHODS),
    apply: z.enum(SPEC_AUTH_APPLY),
    header_name: z.string().max(80).optional(),
    query_name: z.string().max(80).optional(),
    body_name: z.string().max(80).optional(),
    token_endpoint: httpsUrl.optional(),
    refresh_url: httpsUrl.optional(),
    refresh_period_ms: z.number().int().min(1000).max(86400000).optional(),
    signature_header: z.string().max(80).optional(),
    timestamp_header: z.string().max(80).optional(),
    signature_algorithm: z.enum(["HMAC_SHA256", "HMAC_SHA512"]).optional(),
    refresh_config: z.record(z.string().max(64), z.unknown()).optional(),
  })
  .describe("How the platform authenticates to the gateway.");

export const RequiredCredentialSpec = z
  .strictObject({
    key: z.string().trim().min(1).max(64),
    is_secret: z.boolean().default(true),
    encoding: z.enum(SPEC_KEY_ENCODINGS).optional(),
    description: z.string().max(300).optional(),
    /** `HEADER` | `QUERY` | `BODY` | `CERTIFICATE` — mirrors the credential entry type. */
    type: z.enum(["HEADER", "QUERY", "BODY", "CERTIFICATE"]).default("HEADER"),
  })
  .describe("A credential the admin must supply after the import.");

export const GatewaySettingsSpec = z
  .strictObject({
    amount_scale: z.union([z.literal(1), z.literal(100), z.literal(1000)]).default(1),
    amount_precision: z.union([z.literal(0), z.literal(2), z.literal(3)]).default(2),
    amount_rounding: z.enum(SPEC_AMOUNT_ROUNDING).default("NONE"),
    amount_format: z.enum(SPEC_AMOUNT_FORMATS).default("STRING_DECIMAL"),
    reference_format: z.record(z.string().max(40), z.unknown()).default({}),
    session_ttl_seconds: z.number().int().min(30).max(86400).default(1200),
    otp_ttl_seconds: z.number().int().min(30).max(3600).default(300),
    otp_resend_cooldown_seconds: z.number().int().min(0).max(3600).default(60),
    max_otp_attempts: z.number().int().min(1).max(10).default(3),
    supports_status_check: z.boolean().default(true),
    status_check_min_age_seconds: z.number().int().min(0).max(86400).optional(),
    supports_idempotency_key: z.boolean().default(false),
    supports_cancel: z.boolean().default(true),
    rate_limit_per_second: z.number().int().min(1).max(1000).optional(),
    concurrency_cap: z.number().int().min(1).max(1000).optional(),
    timeout_ms: z.number().int().min(1000).max(120000).default(15000),
    max_response_bytes: z.number().int().min(1024).max(10485760).default(2097152),
    gateway_timezone: z.string().max(64).default("Africa/Tripoli"),
  })
  .describe("The money and session settings of the gateway.");

export const RailSpec = z
  .strictObject({
    code: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9_-]+$/, "must be a lowercase slug"),
    name_ar: trimmed(160),
    name_en: trimmed(160),
    collection_mode: z.enum(SPEC_COLLECTION_MODES),
    sub_modes: z.array(z.string().max(40)).max(10).optional(),
    currency: z.string().trim().length(3).default("LYD"),
    capabilities: z
      .strictObject({
        refund: z.boolean().default(false),
        partial_refund: z.boolean().default(false),
        void: z.boolean().default(false),
        capture: z.boolean().default(false),
        recurring: z.boolean().default(false),
      })
      .prefault({}),
    instructions_ar: optionalTrimmed(1000),
    instructions_en: optionalTrimmed(1000),
  })
  .describe("The customer-facing rail.");

export const RailRouteSpec = z
  .strictObject({
    credential_policy: z.enum(SPEC_CREDENTIAL_POLICIES).default("PLATFORM"),
    priority: z.number().int().min(0).max(9999).default(100),
    routing_strategy: z.enum(SPEC_ROUTING_STRATEGIES).default("EFFECTIVE_COST"),
    weight: z.number().int().min(1).max(1000).default(100),
    cost_model: z
      .strictObject({
        calc_type: z.enum(["FLAT", "PERCENTAGE", "TIERED", "HYBRID"]).default("FLAT"),
        flat: decimalString().optional(),
        percent: decimalString().optional(),
        min: decimalString().optional(),
        max: decimalString().optional(),
        accrue_fee_at_confirm: z.boolean().default(false),
      })
      .prefault({}),
    mismatch_policy: z
      .strictObject({
        tolerance_amount: decimalString().default("0.0000"),
        underpay_action: z.enum(["ACCEPT", "INQUIRE", "REJECT"]).default("ACCEPT"),
        overpay_action: z.enum(["ACCEPT", "INQUIRE", "REJECT"]).default("ACCEPT"),
      })
      .prefault({}),
    min_amount: decimalString().default("0.0001"),
    max_amount: decimalString().optional(),
    daily_cap_amount: decimalString().optional(),
    scope: z.record(z.string().max(40), z.unknown()).default({}),
  })
  .describe("How the rail routes to the gateway.");

export const TestVectorSpec = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    phase: z.enum(SPEC_FLOW_PHASES).default("INITIATE"),
    /** The customer / attempt inputs the flow sees. */
    request: z.record(z.string().max(64), z.unknown()).default({}),
    /** The gateway response body the flow must parse. */
    response: z.unknown(),
    expect: z
      .strictObject({
        status: z.enum(SPEC_CANONICAL_STATUSES).optional(),
        extractions: z.record(z.string().max(80), z.unknown()).optional(),
        signature: z
          .strictObject({
            profile: z.string().max(64).optional(),
            header: z.string().max(80).optional(),
            expected: z.string().min(1).max(2048),
          })
          .optional(),
        wire_amount: z.string().max(64).optional(),
      })
      .prefault({}),
  })
  .describe("A doc-derived request/response pair used to prove the spec offline.");

export const IntegrationSpecSchema = z
  .strictObject({
    spec_version: z.literal(SPEC_VERSION),
    gateway: GatewaySpec,
    environments: z.array(EnvironmentSpec).min(1).max(2),
    auth: z.array(AuthSpec).min(1).max(2),
    required_credentials: z.array(RequiredCredentialSpec).max(40).default([]),
    settings: GatewaySettingsSpec.prefault({}),
    rail: RailSpec,
    rail_fields: z.array(RailFieldSpec).max(40).default([]),
    rail_route: RailRouteSpec.prefault({}),
    crypto_profiles: z.array(CryptoProfileSpec).max(20).default([]),
    flows: z.array(FlowSpec).min(1).max(20),
    confirmation_channels: z.array(ConfirmationChannelSpec).max(20).default([]),
    error_maps: z.array(ErrorMapSpec).max(100).default([]),
    /** Flow-level status rules (the step-level ones live on the step). */
    status_rules: z
      .array(
        z.strictObject({
          phase: z.enum(SPEC_FLOW_PHASES),
          selector: z.string().trim().min(1).max(200),
          op: z.enum(SPEC_STATUS_OPS),
          value: z.unknown().optional(),
          canonical_status: z.enum(SPEC_CANONICAL_STATUSES),
          canonical_substatus: z.string().max(80).optional(),
          canonical_error: z.string().max(80).optional(),
        }),
      )
      .max(100)
      .default([]),
    test_vectors: z.array(TestVectorSpec).max(20).default([]),
  })
  .describe("The complete integration spec an external AI produces.");

export type IntegrationSpec = z.infer<typeof IntegrationSpecSchema>;
export type GatewaySpecType = z.infer<typeof GatewaySpec>;
export type FlowSpecType = z.infer<typeof FlowSpec>;
export type FlowStepSpecType = z.infer<typeof FlowStepSpec>;
export type StepParameterSpecType = z.infer<typeof StepParameterSpec>;
export type TestVectorSpecType = z.infer<typeof TestVectorSpec>;
export type RequiredCredentialSpecType = z.infer<typeof RequiredCredentialSpec>;
export type CryptoProfileSpecType = z.infer<typeof CryptoProfileSpec>;
export type RailSpecType = z.infer<typeof RailSpec>;
export type RailFieldSpecType = z.infer<typeof RailFieldSpec>;
export type RailRouteSpecType = z.infer<typeof RailRouteSpec>;
export type ConfirmationChannelSpecType = z.infer<typeof ConfirmationChannelSpec>;
export type ErrorMapSpecType = z.infer<typeof ErrorMapSpec>;
export type GatewaySettingsSpecType = z.infer<typeof GatewaySettingsSpec>;
export type AuthSpecType = z.infer<typeof AuthSpec>;
export type EnvironmentSpecType = z.infer<typeof EnvironmentSpec>;
