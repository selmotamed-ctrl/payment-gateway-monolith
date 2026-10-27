import { createHash } from "node:crypto";
import { Prisma, type CollectionMode, type PrismaClient } from "../generated/prisma/client";

/**
 * The seven production blueprints of design v5 §10.
 *
 * Every blueprint is expressed as pure data in this file so that:
 *
 *  - the seed is declarative and idempotent (it upserts on the unique keys of
 *    every table it touches);
 *  - the configuration can be asserted without a database (the unit test in
 *    `test/blueprint-seed.test.ts` reads this catalogue directly);
 *  - the runtime engine has something to execute: without `flows`,
 *    `flow_steps`, `step_parameters` and `step_outputs` a freshly seeded
 *    database resolves no flow at all and every attempt ends up UNKNOWN.
 *
 * The wording of the endpoints, the money moving steps and the confirmation
 * channels follows design v5 §10 and the gateway matrix of design v5 §5.1.
 */

export type BlueprintGatewayKind = "DIRECT" | "AGGREGATOR" | "NATIVE_ADAPTER" | "INTERNAL";
export type BlueprintAuthMethod =
  | "NONE"
  | "API_KEY"
  | "PERMANENT_TOKEN"
  | "TOKEN_ENDPOINT"
  | "REFRESH_TOKEN"
  | "USERNAME_PASSWORD"
  | "BASIC"
  | "REQUEST_SIGNATURE"
  | "OAUTH2_CLIENT_CREDENTIALS"
  | "MUTUAL_TLS";
export type BlueprintAuthApply = "HEADER" | "QUERY" | "BODY";
export type BlueprintSideEffect = "READ_ONLY" | "SENDS_NOTIFICATION" | "MOVES_MONEY";
export type BlueprintRetryPolicy = "SAFE" | "SAFE_WITH_COOLDOWN" | "NEVER";
export type BlueprintStepType = "HTTP" | "COMPUTE" | "RENDER" | "WAIT" | "ASSERT" | "BRANCH";
export type BlueprintContentType =
  | "application/json"
  | "application/x-www-form-urlencoded"
  | "multipart/form-data"
  | "application/xml"
  | "text/xml"
  | "text/plain";
export type BlueprintPhase =
  | "CREDENTIAL_CHECK"
  | "PRE_INITIATE"
  | "INITIATE"
  | "SUBMIT"
  | "VERIFY"
  | "CANCEL"
  | "REFUND"
  | "VOID"
  | "CAPTURE"
  | "SETTLEMENT_FETCH";
export type BlueprintParameterPlace =
  | "HEADERS"
  | "QUERY"
  | "PATH"
  | "BODY"
  | "FORM"
  | "MULTIPART"
  | "XML";
export type BlueprintParameterSource =
  | "GATEWAY_META"
  | "ROUTE_META"
  | "CREDENTIAL"
  | "ATTEMPT"
  | "CUSTOMER_FIELD"
  | "STATE"
  | "PREVIOUS_RESPONSE"
  | "URLS"
  | "CLIENT_CONTEXT"
  | "CONSTANT"
  | "NOW"
  | "RANDOM"
  | "COMPUTED"
  | "CRYPTO_SIGNATURE";
export type BlueprintOutputStoreAs =
  | "STATE"
  | "PUBLIC"
  | "SETTLED_AMOUNT"
  | "PROVIDER_FEE"
  | "PROVIDER_REF"
  | "NETWORK_REF";
export type BlueprintChannelType =
  | "WEBHOOK"
  | "RETURN_URL"
  | "BROWSER_CALLBACK"
  | "POLL"
  | "STATEMENT"
  | "OPERATOR";
export type BlueprintVerifyMethod =
  | "HMAC_BODY"
  | "HASH_FIELDS"
  | "SORTED_VALUES_HASH"
  | "RSA"
  | "SHARED_TOKEN"
  | "IP_ONLY"
  | "NONE_PLUS_INQUIRY";
export type BlueprintBodyFormat = "JSON" | "FORM" | "XML";
export type BlueprintRailFieldType =
  | "PHONE"
  | "NUMBER"
  | "STRING"
  | "OTP"
  | "BIRTH_YEAR"
  | "CARD_NUMBER"
  | "PAN"
  | "WALLET_ID"
  | "FROM_LIST";
export type BlueprintChecksumType = "NONE" | "LUHN";
export type BlueprintSensitivity = "NORMAL" | "SENSITIVE" | "PAN";
export type BlueprintCredentialPolicy = "PLATFORM" | "MERCHANT_REQUIRED" | "MERCHANT_OR_PLATFORM";
export type BlueprintRouteStatus = "ACTIVE" | "PAUSED" | "DRAINING";
export type BlueprintHealthState = "HEALTHY" | "DEGRADED" | "OPEN_BREAKER";
export type BlueprintWidgetKind = "LIGHTBOX" | "IFRAME" | "SDK_WEBVIEW" | "NATIVE_ANDROID";
export type BlueprintRedirectMethod = "GET" | "POST_FORM";
export type BlueprintRedirectTarget = "SAME_WINDOW" | "NEW_TAB" | "TOP_FRAME";
export type BlueprintReturnMethod = "GET" | "POST";

export interface BlueprintIdempotencyConfig {
  mode: string;
  key_name: string;
  source_template: string;
}

export interface BlueprintParameter {
  place: BlueprintParameterPlace;
  key: string;
  source: BlueprintParameterSource;
  selector?: string;
  constantValue?: string;
  transforms?: unknown[];
}

export interface BlueprintOutput {
  name: string;
  selector?: string;
  transforms?: unknown[];
  storeAs: BlueprintOutputStoreAs;
  required?: boolean;
}

export interface BlueprintAssertion {
  selector: string;
  op: "equals" | "not_equals" | "in" | "exists" | "matches";
  value?: unknown;
}

export interface BlueprintStep {
  name: string;
  type: BlueprintStepType;
  method?: string;
  urlTemplate?: string;
  contentType?: BlueprintContentType;
  timeoutMs?: number;
  sideEffect: BlueprintSideEffect;
  retryPolicy: BlueprintRetryPolicy;
  pointOfNoReturn: boolean;
  idempotencyConfig: BlueprintIdempotencyConfig;
  successCheck?: BlueprintAssertion[];
  parameters?: BlueprintParameter[];
  outputs?: BlueprintOutput[];
}

export interface BlueprintFlow {
  phase: BlueprintPhase;
  subMode?: string;
  railCode?: string;
  steps: BlueprintStep[];
}

export interface BlueprintCryptoProfile {
  name: string;
  purpose: "OUTBOUND_SIGN" | "INBOUND_VERIFY";
  algorithm: "HMAC_SHA256" | "HMAC_SHA512" | "RSA_SHA256" | "SHA256";
  secretKeyRef?: string;
  secretKeyEncoding: "UTF8" | "HEX" | "BASE64";
  canonicalizationMode:
    | "SORTED_KEY_VALUE_AMP"
    | "SORTED_VALUES_HASH"
    | "TEMPLATE_STRING"
    | "JSON_CANONICAL"
    | "RAW_BODY"
    | "TIMESTAMP_DOT_RAW_BODY";
  templateString?: string;
  includedFields: string[];
  excludedFields: string[];
  outputEncoding: "HEX_LOWER" | "HEX_UPPER" | "BASE64";
}

export interface BlueprintEnvironment {
  env: "SANDBOX" | "LIVE";
  baseUrls: Record<string, string>;
  allowedHosts: string[];
  inboundIpAllowlist: string[];
}

export interface BlueprintAuth {
  method: BlueprintAuthMethod;
  authApply: BlueprintAuthApply;
  refreshConfigJson?: Record<string, unknown>;
  /** Path appended to the environment `api` base URL to build a token endpoint. */
  tokenEndpointPath?: string;
  accessTokenSelector?: string;
  expiresInSelector?: string;
}

export interface BlueprintSettings {
  amountScale: number;
  amountPrecision: number;
  amountRounding: string;
  amountFormat: string;
  referenceFormat: Record<string, unknown>;
  sessionTtlSeconds: number;
  otpTtlSeconds: number;
  otpResendCooldownSeconds: number;
  maxOtpAttempts: number;
  supportsStatusCheck: boolean;
  statusCheckMinAgeSeconds?: number;
  supportsIdempotencyKey: boolean;
  supportsCancel: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  gatewayTimezone: string;
}

export interface BlueprintChannel {
  type: BlueprintChannelType;
  railCode: string;
  pathToken: string;
  verifyMethod: BlueprintVerifyMethod;
  signatureHeader?: string;
  timestampSelector?: string;
  timestampToleranceSec: number;
  ipAllowlist: string[];
  bodyFormat: BlueprintBodyFormat;
  correlationSelector?: string;
  dedupeKeySelector?: string;
  eventMap: Record<string, string>;
  mustInquire: boolean;
  ackStatus: number;
  ackBodyTemplate?: string;
  cryptoProfileName?: string;
}

export interface BlueprintStatusRule {
  phase: string;
  selector: string;
  op: "EQUALS" | "NOT_EQUALS" | "IN" | "EXISTS" | "MATCHES";
  value?: unknown;
  canonicalStatus: "AWAITING_CUSTOMER" | "VERIFYING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  canonicalSubstatus?: string;
  canonicalError?: string;
}

export interface BlueprintGateway {
  code: string;
  name: string;
  operator: string;
  aliases: string[];
  kind: BlueprintGatewayKind;
  verificationState: "VERIFIED" | "UNVERIFIED";
  auth: BlueprintAuth;
  environments: BlueprintEnvironment[];
  settings: BlueprintSettings;
  cryptoProfiles: BlueprintCryptoProfile[];
  flows: BlueprintFlow[];
  channels: BlueprintChannel[];
  statusRules: BlueprintStatusRule[];
}

export interface BlueprintRailField {
  key: string;
  type: BlueprintRailFieldType;
  checksum?: BlueprintChecksumType;
  labelAr: string;
  labelEn: string;
  placeholderAr?: string;
  placeholderEn?: string;
  regex?: string;
  minLength?: number;
  maxLength?: number;
  minVal?: string;
  maxVal?: string;
  optionsJson?: unknown;
  required: boolean;
  orderIndex: number;
  sensitivity: BlueprintSensitivity;
}

export interface BlueprintCostModel {
  calc_type: string;
  flat: string;
  percent: string;
  min: string;
  max: string;
  bearer: string;
  accrue_fee_at_confirm: boolean;
}

export interface BlueprintMismatchPolicy {
  tolerance_amount: string;
  underpay_action: string;
  overpay_action: string;
}

export interface BlueprintWidgetDefinition {
  kind: BlueprintWidgetKind;
  sdkDriver?: string;
  scriptUrls: string[];
  scriptSriHashes: string[];
  configTemplate: Record<string, unknown>;
  callbacksMap: Record<string, string>;
  allowedOrigins: string[];
  iframeSandboxAttrs: string[];
  cspAdditions?: string;
}

export interface BlueprintRedirectDefinition {
  method: BlueprintRedirectMethod;
  urlSourceOutput: string;
  formFieldsOutput?: string;
  target: BlueprintRedirectTarget;
  returnMethodExpected: BlueprintReturnMethod;
  returnParamsMap: Record<string, string>;
}

export interface BlueprintPollPolicy {
  firstAfterSeconds: number;
  backoffSeconds: number[];
  maxDurationSeconds: number;
  stopOnStates: string[];
}

export interface BlueprintRailRoute {
  gatewayCode: string;
  credentialPolicy: BlueprintCredentialPolicy;
  priority: number;
  routingStrategy?: "EFFECTIVE_COST" | "STRICT_PRIORITY" | "WEIGHTED";
  weight?: number;
  costModel: BlueprintCostModel;
  mismatchPolicy: BlueprintMismatchPolicy;
  minAmount: string;
  maxAmount?: string;
  dailyCapAmount?: string;
  status: BlueprintRouteStatus;
  healthState: BlueprintHealthState;
  scope: Record<string, unknown>;
  widget?: BlueprintWidgetDefinition;
  redirect?: BlueprintRedirectDefinition;
  pollPolicy?: BlueprintPollPolicy;
}

export interface BlueprintRail {
  code: string;
  nameAr: string;
  nameEn: string;
  collectionMode: CollectionMode;
  subModes: string[];
  minAmount: string;
  maxAmount?: string;
  instructionsAr: string;
  instructionsEn: string;
  fields: BlueprintRailField[];
  routes: BlueprintRailRoute[];
}

export interface BlueprintCatalogEntry {
  key: string;
  name: string;
  description: string;
  gatewayCodes: string[];
  railCodes: string[];
  collectionModes: string[];
  kind: BlueprintGatewayKind;
  country: string;
  riskClass: "NORMAL" | "HIGH_RISK";
  /** The kind is per gateway code: MyPay is an aggregator, T-LYNC is direct. */
  gatewayKinds: Record<string, BlueprintGatewayKind>;
  gateways: BlueprintGateway[];
  rails: BlueprintRail[];
}

/* ------------------------------------------------------------------ *
 * Small builders
 * ------------------------------------------------------------------ */

const noIdempotency = (): BlueprintIdempotencyConfig => ({
  mode: "NONE",
  key_name: "",
  source_template: "",
});

const idempotencyHeader = (keyName: string): BlueprintIdempotencyConfig => ({
  mode: "HEADER",
  key_name: keyName,
  source_template: "{attempt.reference}",
});

const step = (
  definition: Partial<BlueprintStep> &
    Pick<BlueprintStep, "name" | "type" | "sideEffect" | "retryPolicy">,
): BlueprintStep => ({
  pointOfNoReturn: false,
  idempotencyConfig: noIdempotency(),
  ...definition,
});

const param = (
  place: BlueprintParameterPlace,
  key: string,
  source: BlueprintParameterSource,
  extra: Partial<BlueprintParameter> = {},
): BlueprintParameter => ({ place, key, source, ...extra });

const output = (
  name: string,
  selector: string | undefined,
  storeAs: BlueprintOutputStoreAs,
  required = false,
): BlueprintOutput => ({ name, selector, storeAs, required });

/**
 * The place a parameter of a request body is written to. It depends on the
 * content type of the step: a JSON body is written as a body map, a form
 * encoded body as a form field and a multipart body as a part.
 */
const bodyPlace = (contentType: BlueprintContentType): BlueprintParameterPlace => {
  if (contentType === "multipart/form-data") {
    return "MULTIPART";
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return "FORM";
  }
  return "BODY";
};

const lydSettings = (overrides: Partial<BlueprintSettings> = {}): BlueprintSettings => ({
  amountScale: 100,
  amountPrecision: 2,
  amountRounding: "NEAREST",
  amountFormat: "STRING_DECIMAL",
  referenceFormat: {
    prefix: "PG",
    template: "{attempt.reference}",
    pattern: "^[A-Z0-9-]{8,64}$",
    source: "attempt.reference",
  },
  sessionTtlSeconds: 1200,
  otpTtlSeconds: 300,
  otpResendCooldownSeconds: 60,
  maxOtpAttempts: 3,
  supportsStatusCheck: false,
  supportsIdempotencyKey: false,
  supportsCancel: false,
  timeoutMs: 15000,
  maxResponseBytes: 2097152,
  gatewayTimezone: "Africa/Tripoli",
  ...overrides,
});

/**
 * Two environments per gateway. The base URLs are named so that a flow step
 * can address them declaratively (`{api}/verify`, `{inquiry}/FilterTransactions`)
 * and the engine resolves the placeholder against the environment of the
 * attempt that executes the step.
 */
const environmentsFor = (
  code: string,
  options: { inboundIpAllowlist?: string[] } = {},
): BlueprintEnvironment[] => {
  const allowlist = options.inboundIpAllowlist ?? [];
  return [
    {
      env: "SANDBOX",
      baseUrls: {
        api: `https://sandbox.${code}.example.ly`,
        inquiry: `https://sandbox.${code}.example.ly/inquiry`,
      },
      allowedHosts: [`sandbox.${code}.example.ly`],
      inboundIpAllowlist: allowlist,
    },
    {
      env: "LIVE",
      baseUrls: {
        api: `https://api.${code}.example.ly`,
        inquiry: `https://api.${code}.example.ly/inquiry`,
      },
      allowedHosts: [`api.${code}.example.ly`],
      inboundIpAllowlist: allowlist,
    },
  ];
};

const baseScope = (): Record<string, unknown> => ({
  merchant_ids: [],
  application_ids: [],
  risk_tiers: ["LOW", "STANDARD", "HIGH"],
  channels: ["WEB", "API", "POS"],
});

const standardCostModel = (percent: string): BlueprintCostModel => ({
  calc_type: "PERCENTAGE",
  flat: "0.0000",
  percent,
  min: "0.1000",
  max: "25.0000",
  bearer: "MERCHANT_ABSORBS",
  accrue_fee_at_confirm: true,
});

const internalCostModel = (): BlueprintCostModel => ({
  calc_type: "FLAT",
  flat: "0.0000",
  percent: "0.0000",
  min: "0.0000",
  max: "0.0000",
  bearer: "MERCHANT_ABSORBS",
  accrue_fee_at_confirm: false,
});

const strictMismatchPolicy = (): BlueprintMismatchPolicy => ({
  tolerance_amount: "0.0000",
  underpay_action: "REJECT",
  overpay_action: "REJECT",
});

const tolerantMismatchPolicy = (): BlueprintMismatchPolicy => ({
  tolerance_amount: "0.0100",
  underpay_action: "REJECT",
  overpay_action: "ALLOW",
});

/* ------------------------------------------------------------------ *
 * Blueprint 1 - Edfali & Sadad (two step OTP_PULL, RETRYABLE_OTP)
 * ------------------------------------------------------------------ */

/**
 * Blueprint 1: Edfali and Sadad are fronted by the Plutu and the DPay
 * aggregators, so the callback verifier of the fronting aggregator is part of
 * the configuration of the gateway.
 */
const dpayWebhookVerifyProfile = (): BlueprintCryptoProfile => ({
  name: "DPAY_WEBHOOK_VERIFY",
  purpose: "INBOUND_VERIFY",
  algorithm: "HMAC_SHA256",
  secretKeyRef: "CREDENTIAL.webhook_secret",
  secretKeyEncoding: "UTF8",
  canonicalizationMode: "TIMESTAMP_DOT_RAW_BODY",
  includedFields: [],
  excludedFields: [],
  outputEncoding: "HEX_LOWER",
});

const plutuCallbackHashProfile = (): BlueprintCryptoProfile => ({
  name: "PLUTU_CALLBACK_HASH",
  purpose: "INBOUND_VERIFY",
  algorithm: "HMAC_SHA256",
  secretKeyRef: "CREDENTIAL.secret_key",
  secretKeyEncoding: "UTF8",
  canonicalizationMode: "SORTED_VALUES_HASH",
  includedFields: [],
  excludedFields: ["hashed"],
  outputEncoding: "HEX_UPPER",
});

const otpPullGateway = (input: {
  code: string;
  name: string;
  operator: string;
  aliases: string[];
  contentType: BlueprintContentType;
  mobileRegex: string;
  otpLength: number;
  birthYear: boolean;
}): BlueprintGateway => ({
  code: input.code,
  name: input.name,
  operator: input.operator,
  aliases: input.aliases,
  kind: "DIRECT",
  verificationState: "VERIFIED",
  auth: {
    method: input.code === "sadad" ? "PERMANENT_TOKEN" : "API_KEY",
    authApply: "HEADER",
    refreshConfigJson:
      input.code === "sadad"
        ? { header_name: "Authorization", bearer: true, api_key_header: "X-API-KEY" }
        : { header_name: "X-API-KEY", bearer: true },
  },
  environments: environmentsFor(input.code),
  settings: lydSettings({
    sessionTtlSeconds: 600,
    otpTtlSeconds: 300,
    otpResendCooldownSeconds: 60,
    maxOtpAttempts: 3,
    supportsStatusCheck: false,
  }),
  cryptoProfiles:
    input.code === "edfali" ? [plutuCallbackHashProfile()] : [dpayWebhookVerifyProfile()],
  flows: [
    {
      phase: "INITIATE",
      railCode: input.code,
      steps: [
        step({
          name: "send-otp",
          type: "HTTP",
          method: "POST",
          urlTemplate: "{api}/verify",
          contentType: input.contentType,
          sideEffect: "SENDS_NOTIFICATION",
          retryPolicy: "SAFE_WITH_COOLDOWN",
          idempotencyConfig: noIdempotency(),
          parameters: [
            param(bodyPlace(input.contentType), "mobile_number", "CUSTOMER_FIELD", {
              selector: "customer_mobile",
              transforms: [{ op: "phone_normalize", args: ["LOCAL_09"] }],
            }),
            ...(input.birthYear
              ? [
                  param(bodyPlace(input.contentType), "birth_year", "CUSTOMER_FIELD", {
                    selector: "birth_year",
                  }),
                ]
              : []),
            param(bodyPlace(input.contentType), "amount", "ATTEMPT", {
              selector: "totalChargedAmount",
              transforms: [{ op: "format_decimal", args: [2] }],
            }),
            param(bodyPlace(input.contentType), "invoice_no", "ATTEMPT", { selector: "reference" }),
          ],
          outputs: [
            output("process_id", "result.process_id", "STATE", true),
            output("otp_reference", "result.otp_reference", "STATE"),
          ],
        }),
        step({
          name: "show-otp-form",
          type: "RENDER",
          method: "SHOW_OTP_FORM",
          sideEffect: "READ_ONLY",
          retryPolicy: "SAFE",
          outputs: [output("actionType", "actionType", "PUBLIC", true)],
        }),
      ],
    },
    {
      phase: "SUBMIT",
      railCode: input.code,
      steps: [
        step({
          name: "confirm-otp",
          type: "HTTP",
          method: "POST",
          urlTemplate: "{api}/confirm",
          contentType: input.contentType,
          sideEffect: "MOVES_MONEY",
          retryPolicy: "NEVER",
          pointOfNoReturn: true,
          idempotencyConfig: noIdempotency(),
          parameters: [
            param(bodyPlace(input.contentType), "process_id", "STATE", { selector: "process_id" }),
            param(bodyPlace(input.contentType), "code", "CUSTOMER_FIELD", { selector: "otp" }),
            param(bodyPlace(input.contentType), "amount", "ATTEMPT", {
              selector: "totalChargedAmount",
              transforms: [{ op: "format_decimal", args: [2] }],
            }),
            param(bodyPlace(input.contentType), "invoice_no", "ATTEMPT", { selector: "reference" }),
          ],
          outputs: [
            output("status", "status", "STATE"),
            output("transaction_id", "transaction_id", "PROVIDER_REF", true),
            output("settled_amount", "amount", "SETTLED_AMOUNT"),
            output("network_ref", "network_ref", "NETWORK_REF"),
          ],
        }),
      ],
    },
    {
      phase: "VERIFY",
      railCode: input.code,
      steps: [
        step({
          name: "local-settlement-reconcile",
          type: "COMPUTE",
          method: "LOCAL_SETTLEMENT_RECONCILE",
          sideEffect: "READ_ONLY",
          retryPolicy: "SAFE",
          outputs: [
            output("status", "status", "STATE"),
            output("settled_amount", "settled_amount", "SETTLED_AMOUNT"),
            output("provider_reference", "provider_reference", "PROVIDER_REF"),
          ],
        }),
      ],
    },
  ],
  channels: [
    {
      type: "STATEMENT",
      railCode: input.code,
      pathToken: `${input.code}-statement`,
      verifyMethod: "NONE_PLUS_INQUIRY",
      timestampToleranceSec: 300,
      ipAllowlist: [],
      bodyFormat: "JSON",
      correlationSelector: "invoice_no",
      dedupeKeySelector: "transaction_id",
      eventMap: { SETTLED: "SUCCEEDED", REVERSED: "FAILED" },
      mustInquire: false,
      ackStatus: 200,
      ackBodyTemplate: JSON.stringify({ status: "accepted" }),
    },
  ],
  statusRules: [
    {
      phase: "INITIATE",
      selector: "result.status",
      op: "EQUALS",
      value: "OTP_SENT",
      canonicalStatus: "AWAITING_CUSTOMER",
    },
    {
      phase: "SUBMIT",
      selector: "status",
      op: "EQUALS",
      value: "SUCCESS",
      canonicalStatus: "SUCCEEDED",
    },
    {
      phase: "SUBMIT",
      selector: "status",
      op: "EQUALS",
      value: "INVALID_OTP",
      canonicalStatus: "AWAITING_CUSTOMER",
      canonicalError: "RETRYABLE_OTP",
    },
    {
      phase: "SUBMIT",
      selector: "status",
      op: "EQUALS",
      value: "DECLINED",
      canonicalStatus: "FAILED",
      canonicalError: "TERMINAL_DECLINE",
    },
  ],
});

const blueprint1: BlueprintCatalogEntry = {
  key: "edfali-sadad-otp",
  name: "Edfali & Sadad OTP",
  description: "Two-step OTP_PULL payments with retryable OTP confirmation.",
  gatewayCodes: ["edfali", "sadad"],
  railCodes: ["edfali", "sadad"],
  collectionModes: ["OTP_PULL"],
  kind: "DIRECT",
  country: "LY",
  riskClass: "NORMAL",
  gatewayKinds: { edfali: "DIRECT", sadad: "DIRECT" },
  gateways: [
    otpPullGateway({
      code: "edfali",
      name: "Edfali",
      operator: "Banque de Commerce",
      aliases: ["Edfaa Li", "Adfali"],
      contentType: "multipart/form-data",
      mobileRegex: "^09[0-9]{8}$",
      otpLength: 4,
      birthYear: false,
    }),
    otpPullGateway({
      code: "sadad",
      name: "Sadad",
      operator: "Almadar Aljadeed",
      aliases: ["Almadar"],
      contentType: "application/json",
      mobileRegex: "^091[0-9]{7}$",
      otpLength: 6,
      birthYear: true,
    }),
  ],
  rails: [
    {
      code: "edfali",
      nameAr: "إدفالي",
      nameEn: "Edfali",
      collectionMode: "OTP_PULL",
      subModes: ["OTP_PULL"],
      minAmount: "1.0000",
      maxAmount: "10000.0000",
      instructionsAr: "سيتم إرسال رمز تحقق إلى رقم الهاتف المسجل.",
      instructionsEn: "A verification code is sent to the registered mobile number.",
      fields: [
        {
          key: "customer_mobile",
          type: "PHONE",
          checksum: "NONE",
          labelAr: "رقم الهاتف",
          labelEn: "Mobile number",
          placeholderAr: "09XXXXXXXX",
          placeholderEn: "09XXXXXXXX",
          regex: "^09[0-9]{8}$",
          minLength: 10,
          maxLength: 10,
          required: true,
          orderIndex: 1,
          sensitivity: "SENSITIVE",
        },
        {
          key: "otp",
          type: "OTP",
          checksum: "NONE",
          labelAr: "رمز التحقق",
          labelEn: "Verification code",
          placeholderAr: "0000",
          placeholderEn: "0000",
          regex: "^[0-9]{4}$",
          minLength: 4,
          maxLength: 4,
          required: true,
          orderIndex: 2,
          sensitivity: "SENSITIVE",
        },
      ],
      routes: [
        {
          gatewayCode: "edfali",
          credentialPolicy: "PLATFORM",
          priority: 10,
          costModel: standardCostModel("1.2000"),
          mismatchPolicy: strictMismatchPolicy(),
          minAmount: "1.0000",
          maxAmount: "10000.0000",
          dailyCapAmount: "250000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
        },
      ],
    },
    {
      code: "sadad",
      nameAr: "سداد",
      nameEn: "Sadad",
      collectionMode: "OTP_PULL",
      subModes: ["OTP_PULL"],
      minAmount: "1.0000",
      maxAmount: "10000.0000",
      instructionsAr: "سيتم إرسال رمز تحقق إلى رقم الهاتف المسجل.",
      instructionsEn: "A verification code is sent to the registered mobile number.",
      fields: [
        {
          key: "customer_mobile",
          type: "PHONE",
          checksum: "NONE",
          labelAr: "رقم الهاتف",
          labelEn: "Mobile number",
          placeholderAr: "091XXXXXXX",
          placeholderEn: "091XXXXXXX",
          regex: "^091[0-9]{7}$",
          minLength: 10,
          maxLength: 10,
          required: true,
          orderIndex: 1,
          sensitivity: "SENSITIVE",
        },
        {
          key: "birth_year",
          type: "BIRTH_YEAR",
          checksum: "NONE",
          labelAr: "سنة الميلاد",
          labelEn: "Year of birth",
          placeholderAr: "1990",
          placeholderEn: "1990",
          regex: "^(19[2-9][0-9]|20[01][0-9])$",
          minLength: 4,
          maxLength: 4,
          minVal: "1925",
          maxVal: "2012",
          required: false,
          orderIndex: 2,
          sensitivity: "SENSITIVE",
        },
        {
          key: "otp",
          type: "OTP",
          checksum: "NONE",
          labelAr: "رمز التحقق",
          labelEn: "Verification code",
          placeholderAr: "000000",
          placeholderEn: "000000",
          regex: "^[0-9]{6}$",
          minLength: 6,
          maxLength: 6,
          required: true,
          orderIndex: 3,
          sensitivity: "SENSITIVE",
        },
      ],
      routes: [
        {
          gatewayCode: "sadad",
          credentialPolicy: "PLATFORM",
          priority: 10,
          costModel: standardCostModel("1.5000"),
          mismatchPolicy: strictMismatchPolicy(),
          minAmount: "1.0000",
          maxAmount: "10000.0000",
          dailyCapAmount: "200000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Blueprint 2 - Moamalat National Switch (EMBEDDED Lightbox)
 * ------------------------------------------------------------------ */

const blueprint2: BlueprintCatalogEntry = {
  key: "moamalat-lightbox",
  name: "Moamalat National Switch",
  description: "EMBEDDED Lightbox with Hex-HMAC and mandatory inquiry.",
  gatewayCodes: ["moamalat"],
  railCodes: ["moamalat_card"],
  collectionModes: ["EMBEDDED"],
  kind: "DIRECT",
  country: "LY",
  riskClass: "NORMAL",
  gatewayKinds: { moamalat: "DIRECT" },
  gateways: [
    {
      code: "moamalat",
      name: "Moamalat National Switch",
      operator: "National Payment Gateway",
      aliases: ["NPG", "Moamalat"],
      kind: "DIRECT",
      verificationState: "VERIFIED",
      auth: {
        method: "REQUEST_SIGNATURE",
        authApply: "HEADER",
        refreshConfigJson: {
          signature_header: "X-SecureHash",
          timestamp_header: "X-Timestamp",
          signature_algorithm: "HMAC_SHA256",
          header_name: "X-MID",
        },
      },
      environments: environmentsFor("moamalat", {
        inboundIpAllowlist: ["192.0.2.0/24", "198.51.100.0/24"],
      }),
      settings: lydSettings({
        amountScale: 1000,
        amountPrecision: 3,
        amountRounding: "NONE",
        amountFormat: "INTEGER_MINOR_UNITS",
        sessionTtlSeconds: 600,
        otpTtlSeconds: 300,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 30,
        timeoutMs: 20000,
      }),
      cryptoProfiles: [
        {
          name: "MOAMALAT_SECURE_HASH",
          purpose: "OUTBOUND_SIGN",
          algorithm: "HMAC_SHA256",
          secretKeyRef: "CREDENTIAL.MerchantSecretKey",
          secretKeyEncoding: "HEX",
          canonicalizationMode: "SORTED_KEY_VALUE_AMP",
          includedFields: [
            "Amount",
            "DateTimeLocalTrxn",
            "MerchantId",
            "MerchantReference",
            "TerminalId",
          ],
          excludedFields: [],
          outputEncoding: "HEX_UPPER",
        },
        {
          name: "MOAMALAT_INBOUND_VERIFY",
          purpose: "INBOUND_VERIFY",
          algorithm: "HMAC_SHA256",
          secretKeyRef: "CREDENTIAL.WebhookSecret",
          secretKeyEncoding: "UTF8",
          canonicalizationMode: "SORTED_KEY_VALUE_AMP",
          includedFields: [],
          excludedFields: [],
          outputEncoding: "HEX_LOWER",
        },
      ],
      flows: [
        {
          phase: "INITIATE",
          railCode: "moamalat_card",
          steps: [
            step({
              name: "build-lightbox-payload",
              type: "COMPUTE",
              method: "MOAMALAT_LIGHTBOX_PAYLOAD",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [
                output("AmountTrxn", "AmountTrxn", "PUBLIC", true),
                output("MerchantReference", "MerchantReference", "PUBLIC", true),
                output("TrxDateTime", "TrxDateTime", "PUBLIC", true),
                output("SecureHash", "SecureHash", "PUBLIC", true),
                output("Currency", "Currency", "PUBLIC"),
                output("Amount", "Amount", "PUBLIC"),
              ],
            }),
            step({
              name: "render-lightbox",
              type: "RENDER",
              method: "RENDER_EMBEDDED",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [output("actionType", "actionType", "PUBLIC", true)],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          railCode: "moamalat_card",
          steps: [
            step({
              name: "get-transaction-status",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{inquiry}/GetTransactionStatus",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [
                param("QUERY", "MID", "CREDENTIAL", { selector: "MID" }),
                param("QUERY", "TID", "CREDENTIAL", { selector: "TID" }),
                param("QUERY", "MerchantReference", "STATE", { selector: "MerchantReference" }),
              ],
              outputs: [
                output("approved", "Approved", "STATE", true),
                output("action_code", "ActionCode", "STATE"),
                output("settled_amount", "AmountTrxn", "SETTLED_AMOUNT"),
                output("provider_reference", "TransactionId", "PROVIDER_REF"),
              ],
            }),
            step({
              name: "assert-approved",
              type: "ASSERT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              successCheck: [
                { selector: "Approved", op: "equals", value: true },
                { selector: "ActionCode", op: "equals", value: "00" },
              ],
            }),
          ],
        },
        {
          phase: "VERIFY",
          railCode: "moamalat_card",
          steps: [
            step({
              name: "filter-transactions",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{inquiry}/FilterTransactions",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [
                param("BODY", "MID", "CREDENTIAL", { selector: "MID" }),
                param("BODY", "TID", "CREDENTIAL", { selector: "TID" }),
                param("BODY", "MerchantReference", "STATE", { selector: "MerchantReference" }),
                param("BODY", "SecureHash", "STATE", { selector: "SecureHash" }),
                param("BODY", "AmountTrxn", "STATE", { selector: "AmountTrxn" }),
              ],
              outputs: [
                output("approved", "Approved", "STATE", true),
                output("action_code", "ActionCode", "STATE"),
                output("settled_amount", "AmountTrxn", "SETTLED_AMOUNT"),
                output("provider_reference", "TransactionId", "PROVIDER_REF"),
              ],
            }),
            step({
              name: "assert-approved",
              type: "ASSERT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              successCheck: [
                { selector: "Approved", op: "equals", value: true },
                { selector: "ActionCode", op: "equals", value: "00" },
              ],
            }),
          ],
        },
      ],
      channels: [
        {
          type: "WEBHOOK",
          railCode: "moamalat_card",
          pathToken: "moamalat-webhook",
          verifyMethod: "HMAC_BODY",
          signatureHeader: "X-Signature",
          timestampSelector: "timestamp",
          timestampToleranceSec: 300,
          ipAllowlist: ["192.0.2.0/24", "198.51.100.0/24"],
          bodyFormat: "JSON",
          correlationSelector: "MerchantReference",
          dedupeKeySelector: "TransactionId",
          eventMap: { "00": "SUCCEEDED", "99": "FAILED" },
          mustInquire: true,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
          cryptoProfileName: "MOAMALAT_INBOUND_VERIFY",
        },
        {
          type: "BROWSER_CALLBACK",
          railCode: "moamalat_card",
          pathToken: "moamalat-browser-callback",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "MerchantReference",
          eventMap: { completed: "VERIFYING" },
          mustInquire: true,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
        },
        {
          type: "POLL",
          railCode: "moamalat_card",
          pathToken: "moamalat-poll",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "MerchantReference",
          eventMap: {},
          mustInquire: false,
          ackStatus: 200,
        },
      ],
      statusRules: [
        {
          phase: "VERIFY",
          selector: "Approved",
          op: "EQUALS",
          value: true,
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "VERIFY",
          selector: "ActionCode",
          op: "EQUALS",
          value: "00",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "VERIFY",
          selector: "ActionCode",
          op: "NOT_EQUALS",
          value: "00",
          canonicalStatus: "FAILED",
          canonicalError: "TERMINAL_DECLINE",
        },
      ],
    },
  ],
  rails: [
    {
      code: "moamalat_card",
      nameAr: "بطاقة مصرففا مصرفف",
      nameEn: "Moamalat Card",
      collectionMode: "EMBEDDED",
      subModes: ["EMBEDDED"],
      minAmount: "1.0000",
      maxAmount: "20000.0000",
      instructionsAr: "أدخل بيانات البطاقة داخل نافذة الدفع الآمنة.",
      instructionsEn: "Enter the card details inside the secure payment window.",
      fields: [],
      routes: [
        {
          gatewayCode: "moamalat",
          credentialPolicy: "PLATFORM",
          priority: 10,
          costModel: standardCostModel("1.8000"),
          mismatchPolicy: tolerantMismatchPolicy(),
          minAmount: "1.0000",
          maxAmount: "20000.0000",
          dailyCapAmount: "500000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
          pollPolicy: {
            firstAfterSeconds: 5,
            backoffSeconds: [5, 10, 20, 30, 60, 120],
            maxDurationSeconds: 600,
            stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
          },
          widget: {
            kind: "LIGHTBOX",
            sdkDriver: "MOAMALAT_LIGHTBOX_V2",
            scriptUrls: [],
            scriptSriHashes: [],
            configTemplate: {
              amount: "{{amount}}",
              currency: "{{currency}}",
              merchantId: "{{merchantId}}",
              terminalId: "{{terminalId}}",
              merchantReference: "{{merchantReference}}",
              trxDateTime: "{{trxDateTime}}",
              secureHash: "{{secureHash}}",
              language: "{{language}}",
            },
            callbacksMap: {
              complete: "MOAMALAT_LIGHTBOX_COMPLETE",
              cancel: "MOAMALAT_LIGHTBOX_CANCEL",
            },
            allowedOrigins: ["https://pay.domain.ly", "https://checkout.pay.domain.ly"],
            iframeSandboxAttrs: ["allow-forms", "allow-scripts", "allow-same-origin"],
            cspAdditions: "frame-src https://*.moamalat.example.ly",
          },
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Blueprint 3 - CBL LYPay (QR_DISPLAY / PUSH_APPROVAL)
 * ------------------------------------------------------------------ */

const blueprint3: BlueprintCatalogEntry = {
  key: "cbl-lypay",
  name: "CBL LYPay Instant Payment",
  description: "QR_DISPLAY and PUSH_APPROVAL with synchronous confirmation, webhook, and enquiry.",
  gatewayCodes: ["cbl_lypay"],
  railCodes: ["lypay"],
  collectionModes: ["QR_DISPLAY", "PUSH_APPROVAL"],
  kind: "DIRECT",
  country: "LY",
  riskClass: "NORMAL",
  gatewayKinds: { cbl_lypay: "DIRECT" },
  gateways: [
    {
      code: "cbl_lypay",
      name: "CBL LYPay",
      operator: "Central Bank of Libya",
      aliases: ["LYPay", "CBL Instant Payment"],
      kind: "DIRECT",
      verificationState: "VERIFIED",
      auth: {
        method: "TOKEN_ENDPOINT",
        authApply: "HEADER",
        tokenEndpointPath: "/api/v1/auth/token",
        accessTokenSelector: "access_token",
        expiresInSelector: "expires_in",
        refreshConfigJson: {
          header_name: "Authorization",
          client_id: "clientId",
          client_secret: "clientSecret",
        },
      },
      environments: environmentsFor("cbl_lypay", {
        inboundIpAllowlist: ["192.0.2.0/24"],
      }),
      settings: lydSettings({
        amountScale: 1,
        amountPrecision: 3,
        amountRounding: "NONE",
        amountFormat: "STRING_DECIMAL",
        sessionTtlSeconds: 900,
        otpTtlSeconds: 300,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 15,
        supportsIdempotencyKey: true,
        timeoutMs: 10000,
      }),
      cryptoProfiles: [
        {
          name: "LYPAY_WEBHOOK_VERIFY",
          purpose: "INBOUND_VERIFY",
          algorithm: "HMAC_SHA256",
          secretKeyRef: "CREDENTIAL.WebhookSecret",
          secretKeyEncoding: "UTF8",
          canonicalizationMode: "TIMESTAMP_DOT_RAW_BODY",
          includedFields: [],
          excludedFields: [],
          outputEncoding: "HEX_LOWER",
        },
      ],
      flows: [
        {
          phase: "INITIATE",
          railCode: "lypay",
          steps: [
            step({
              name: "create-funds-transfer",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/api/v1/payments/funds-transfers",
              contentType: "application/json",
              sideEffect: "SENDS_NOTIFICATION",
              retryPolicy: "SAFE",
              idempotencyConfig: idempotencyHeader("Idempotency-Key"),
              parameters: [
                param("BODY", "amount", "ATTEMPT", {
                  selector: "totalChargedAmount",
                  transforms: [{ op: "format_decimal", args: [3] }],
                }),
                param("BODY", "currency", "CONSTANT", { constantValue: "LYD" }),
                param("BODY", "merchantRef", "ATTEMPT", { selector: "reference" }),
                param("BODY", "alias", "CUSTOMER_FIELD", { selector: "customer_alias" }),
              ],
              outputs: [
                output("transfer_uuid", "transfer_uuid", "STATE", true),
                output("emvco_tlv", "qr.emvco_tlv", "PUBLIC"),
                output("qr_payload", "qr.payload", "PUBLIC"),
              ],
            }),
            step({
              name: "show-qr",
              type: "RENDER",
              method: "SHOW_QR_OR_CODE",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [output("actionType", "actionType", "PUBLIC", true)],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          railCode: "lypay",
          steps: [
            step({
              name: "confirm-funds-transfer",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/api/v1/payments/funds-transfers/{transfer_uuid}/confirm",
              contentType: "application/json",
              sideEffect: "MOVES_MONEY",
              retryPolicy: "NEVER",
              pointOfNoReturn: true,
              idempotencyConfig: idempotencyHeader("Idempotency-Key"),
              parameters: [
                param("PATH", "transfer_uuid", "STATE", { selector: "transfer_uuid" }),
                param("BODY", "merchantRef", "ATTEMPT", { selector: "reference" }),
              ],
              outputs: [
                output("status", "status", "STATE", true),
                output("transfer_uuid", "transfer_uuid", "PROVIDER_REF"),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
              ],
            }),
          ],
        },
        {
          phase: "VERIFY",
          railCode: "lypay",
          steps: [
            step({
              name: "enquire-funds-transfer",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/api/v1/payments/funds-transfers/enquiry",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [
                param("QUERY", "merchantRef", "ATTEMPT", { selector: "reference" }),
              ],
              outputs: [
                output("status", "status", "STATE", true),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "transfer_uuid", "PROVIDER_REF"),
              ],
            }),
          ],
        },
      ],
      channels: [
        {
          type: "WEBHOOK",
          railCode: "lypay",
          pathToken: "cbl-lypay-webhook",
          verifyMethod: "HMAC_BODY",
          signatureHeader: "X-Signature",
          timestampSelector: "timestamp",
          timestampToleranceSec: 300,
          ipAllowlist: ["192.0.2.0/24"],
          bodyFormat: "JSON",
          correlationSelector: "merchantRef",
          dedupeKeySelector: "eventId",
          eventMap: {
            transaction_status_update: "VERIFYING",
            transaction_credit_notice: "SUCCEEDED",
          },
          mustInquire: true,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
          cryptoProfileName: "LYPAY_WEBHOOK_VERIFY",
        },
        {
          type: "POLL",
          railCode: "lypay",
          pathToken: "cbl-lypay-poll",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "merchantRef",
          eventMap: {},
          mustInquire: false,
          ackStatus: 200,
        },
      ],
      statusRules: [
        {
          phase: "SUBMIT",
          selector: "status",
          op: "EQUALS",
          value: "Confirmed",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "SUBMIT",
          selector: "status",
          op: "EQUALS",
          value: "Processing",
          canonicalStatus: "VERIFYING",
        },
        {
          phase: "SUBMIT",
          selector: "status",
          op: "EQUALS",
          value: "Declined",
          canonicalStatus: "FAILED",
          canonicalError: "TERMINAL_DECLINE",
        },
        {
          phase: "VERIFY",
          selector: "status",
          op: "EQUALS",
          value: "Confirmed",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "VERIFY",
          selector: "status",
          op: "EQUALS",
          value: "Declined",
          canonicalStatus: "FAILED",
          canonicalError: "TERMINAL_DECLINE",
        },
      ],
    },
  ],
  rails: [
    {
      code: "lypay",
      nameAr: "لاي باي",
      nameEn: "LYPay",
      collectionMode: "QR_DISPLAY",
      subModes: ["QR_DISPLAY", "PUSH_APPROVAL"],
      minAmount: "0.1000",
      maxAmount: "100000.0000",
      instructionsAr: "امسح رمز الاستجابة السريعة أو وافق على إشعار الدفع.",
      instructionsEn: "Scan the QR code or approve the push notification.",
      fields: [
        {
          key: "customer_alias",
          type: "STRING",
          checksum: "NONE",
          labelAr: "الاسم المستعار",
          labelEn: "Customer alias",
          placeholderAr: "الاسم أو الحساب",
          placeholderEn: "Name or account",
          regex: "^[A-Za-z0-9 ._-]{2,64}$",
          minLength: 2,
          maxLength: 64,
          required: false,
          orderIndex: 1,
          sensitivity: "NORMAL",
        },
      ],
      routes: [
        {
          gatewayCode: "cbl_lypay",
          credentialPolicy: "PLATFORM",
          priority: 10,
          costModel: standardCostModel("1.0000"),
          mismatchPolicy: tolerantMismatchPolicy(),
          minAmount: "0.1000",
          maxAmount: "20000.0000",
          dailyCapAmount: "1000000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
          pollPolicy: {
            firstAfterSeconds: 5,
            backoffSeconds: [5, 10, 20, 30, 60],
            maxDurationSeconds: 900,
            stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
          },
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Blueprint 4 - MyPay & Tadawul T-LYNC (REDIRECT hosted checkout)
 * ------------------------------------------------------------------ */

const blueprint4: BlueprintCatalogEntry = {
  key: "mypay-tlync-redirect",
  name: "MyPay & Tadawul T-LYNC Redirect",
  description: "REDIRECT hosted checkout with signed callbacks and receipt inquiry.",
  gatewayCodes: ["mypay", "tlync"],
  railCodes: ["mypay", "tlync"],
  collectionModes: ["REDIRECT"],
  kind: "AGGREGATOR",
  country: "LY",
  riskClass: "NORMAL",
  gatewayKinds: { mypay: "AGGREGATOR", tlync: "DIRECT" },
  gateways: [
    {
      code: "mypay",
      name: "MyPay",
      operator: "MyPay",
      aliases: ["MyPay Aggregator"],
      kind: "AGGREGATOR",
      verificationState: "VERIFIED",
      auth: {
        method: "TOKEN_ENDPOINT",
        authApply: "HEADER",
        tokenEndpointPath: "/oauth/token",
        accessTokenSelector: "access_token",
        expiresInSelector: "expires_in",
        refreshConfigJson: {
          header_name: "Authorization",
          client_id: "clientId",
          client_secret: "clientSecret",
        },
      },
      environments: environmentsFor("mypay", {
        inboundIpAllowlist: ["192.0.2.0/24"],
      }),
      settings: lydSettings({
        sessionTtlSeconds: 1800,
        otpTtlSeconds: 300,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 30,
        timeoutMs: 15000,
      }),
      cryptoProfiles: [
        {
          name: "MYPAY_SIGNATURE",
          purpose: "INBOUND_VERIFY",
          algorithm: "HMAC_SHA256",
          secretKeyRef: "CREDENTIAL.SecretKey",
          secretKeyEncoding: "UTF8",
          canonicalizationMode: "RAW_BODY",
          includedFields: [],
          excludedFields: [],
          outputEncoding: "HEX_LOWER",
        },
      ],
      flows: [
        {
          phase: "INITIATE",
          railCode: "mypay",
          steps: [
            step({
              name: "create-checkout-session",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/payment/create",
              contentType: "application/json",
              sideEffect: "SENDS_NOTIFICATION",
              retryPolicy: "SAFE_WITH_COOLDOWN",
              parameters: [
                param("BODY", "amount", "ATTEMPT", {
                  selector: "totalChargedAmount",
                  transforms: [{ op: "format_decimal", args: [2] }],
                }),
                param("BODY", "currency", "CONSTANT", { constantValue: "LYD" }),
                param("BODY", "custom_ref", "ATTEMPT", { selector: "reference" }),
                param("BODY", "frontend_url", "URLS", { selector: "return_url" }),
                param("BODY", "backend_url", "URLS", { selector: "callback_url" }),
              ],
              outputs: [
                output("redirect_url", "redirect_url", "PUBLIC", true),
                output("session_id", "session_id", "STATE"),
              ],
            }),
            step({
              name: "redirect-customer",
              type: "RENDER",
              method: "HTTP_REDIRECT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [
                output("actionType", "actionType", "PUBLIC", true),
                output("redirect_url", "redirect_url", "PUBLIC"),
              ],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          railCode: "mypay",
          steps: [
            step({
              name: "local-settlement-reconcile",
              type: "COMPUTE",
              method: "LOCAL_SETTLEMENT_RECONCILE",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [
                output("status", "status", "STATE"),
                output("settled_amount", "settled_amount", "SETTLED_AMOUNT"),
                output("provider_reference", "provider_reference", "PROVIDER_REF"),
              ],
            }),
          ],
        },
        {
          phase: "VERIFY",
          railCode: "mypay",
          steps: [
            step({
              name: "local-settlement-reconcile",
              type: "COMPUTE",
              method: "LOCAL_SETTLEMENT_RECONCILE",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [
                output("status", "status", "STATE"),
                output("settled_amount", "settled_amount", "SETTLED_AMOUNT"),
                output("provider_reference", "provider_reference", "PROVIDER_REF"),
              ],
            }),
          ],
        },
      ],
      channels: [
        {
          type: "WEBHOOK",
          railCode: "mypay",
          pathToken: "mypay-webhook",
          verifyMethod: "HMAC_BODY",
          signatureHeader: "X-MYPAY-SIGNATURE",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "custom_ref",
          dedupeKeySelector: "transaction_id",
          eventMap: { PAID: "SUCCEEDED", FAILED: "FAILED", PENDING: "VERIFYING" },
          mustInquire: false,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
          cryptoProfileName: "MYPAY_SIGNATURE",
        },
        {
          type: "RETURN_URL",
          railCode: "mypay",
          pathToken: "mypay-return",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "custom_ref",
          eventMap: {},
          mustInquire: true,
          ackStatus: 200,
        },
        {
          type: "POLL",
          railCode: "mypay",
          pathToken: "mypay-poll",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "custom_ref",
          eventMap: {},
          mustInquire: false,
          ackStatus: 200,
        },
      ],
      statusRules: [
        {
          phase: "INITIATE",
          selector: "status",
          op: "EQUALS",
          value: "CREATED",
          canonicalStatus: "AWAITING_CUSTOMER",
        },
      ],
    },
    {
      code: "tlync",
      name: "Tadawul T-LYNC",
      operator: "Tadawul",
      aliases: ["T-LYNC", "TDSP"],
      kind: "DIRECT",
      verificationState: "VERIFIED",
      auth: {
        method: "API_KEY",
        authApply: "HEADER",
        refreshConfigJson: {
          header_name: "X-Store-Token",
          api_key_header: "X-Store-Id",
        },
      },
      environments: environmentsFor("tlync", {
        inboundIpAllowlist: ["192.0.2.0/24", "198.51.100.0/24"],
      }),
      settings: lydSettings({
        sessionTtlSeconds: 1800,
        otpTtlSeconds: 300,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 30,
        timeoutMs: 15000,
      }),
      cryptoProfiles: [],
      flows: [
        {
          phase: "INITIATE",
          railCode: "tlync",
          steps: [
            step({
              name: "create-checkout-session",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/payment/create",
              contentType: "application/json",
              sideEffect: "SENDS_NOTIFICATION",
              retryPolicy: "SAFE_WITH_COOLDOWN",
              parameters: [
                param("BODY", "store_id", "CREDENTIAL", { selector: "store_id" }),
                param("BODY", "store_token", "CREDENTIAL", { selector: "store_token" }),
                param("BODY", "amount", "ATTEMPT", {
                  selector: "totalChargedAmount",
                  transforms: [{ op: "format_decimal", args: [2] }],
                }),
                param("BODY", "currency", "CONSTANT", { constantValue: "LYD" }),
                param("BODY", "custom_ref", "ATTEMPT", { selector: "reference" }),
                param("BODY", "frontend_url", "URLS", { selector: "return_url" }),
                param("BODY", "backend_url", "URLS", { selector: "callback_url" }),
              ],
              outputs: [
                output("redirect_url", "redirect_url", "PUBLIC", true),
                output("session_id", "session_id", "STATE"),
              ],
            }),
            step({
              name: "redirect-customer",
              type: "RENDER",
              method: "HTTP_REDIRECT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [
                output("actionType", "actionType", "PUBLIC", true),
                output("redirect_url", "redirect_url", "PUBLIC"),
              ],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          railCode: "tlync",
          steps: [
            step({
              name: "receipt-transaction",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/receipt/transaction",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [
                param("BODY", "store_id", "CREDENTIAL", { selector: "store_id" }),
                param("BODY", "custom_ref", "ATTEMPT", { selector: "reference" }),
              ],
              outputs: [
                output("status", "status", "STATE", true),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "transaction_id", "PROVIDER_REF"),
              ],
            }),
          ],
        },
        {
          phase: "VERIFY",
          railCode: "tlync",
          steps: [
            step({
              name: "receipt-transaction",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/receipt/transaction",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [
                param("BODY", "store_id", "CREDENTIAL", { selector: "store_id" }),
                param("BODY", "custom_ref", "ATTEMPT", { selector: "reference" }),
              ],
              outputs: [
                output("status", "status", "STATE", true),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "transaction_id", "PROVIDER_REF"),
              ],
            }),
          ],
        },
      ],
      channels: [
        {
          type: "WEBHOOK",
          railCode: "tlync",
          pathToken: "tlync-webhook",
          verifyMethod: "IP_ONLY",
          timestampToleranceSec: 300,
          ipAllowlist: ["192.0.2.0/24", "198.51.100.0/24"],
          bodyFormat: "JSON",
          correlationSelector: "custom_ref",
          dedupeKeySelector: "transaction_id",
          eventMap: { PAID: "SUCCEEDED", FAILED: "FAILED" },
          mustInquire: true,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
        },
        {
          type: "RETURN_URL",
          railCode: "tlync",
          pathToken: "tlync-return",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "custom_ref",
          eventMap: {},
          mustInquire: true,
          ackStatus: 200,
        },
        {
          type: "POLL",
          railCode: "tlync",
          pathToken: "tlync-poll",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "custom_ref",
          eventMap: {},
          mustInquire: false,
          ackStatus: 200,
        },
      ],
      statusRules: [
        {
          phase: "INITIATE",
          selector: "status",
          op: "EQUALS",
          value: "CREATED",
          canonicalStatus: "AWAITING_CUSTOMER",
        },
        {
          phase: "VERIFY",
          selector: "status",
          op: "EQUALS",
          value: "SUCCESS",
          canonicalStatus: "SUCCEEDED",
        },
      ],
    },
  ],
  rails: [
    {
      code: "mypay",
      nameAr: "ماي باي",
      nameEn: "MyPay",
      collectionMode: "REDIRECT",
      subModes: ["REDIRECT"],
      minAmount: "1.0000",
      maxAmount: "10000.0000",
      instructionsAr: "سيتم تحويلك إلى صفحة الدفع المستضافة لإتمام العملية.",
      instructionsEn: "You are redirected to the hosted checkout page to complete the payment.",
      fields: [],
      routes: [
        {
          gatewayCode: "mypay",
          credentialPolicy: "PLATFORM",
          priority: 20,
          costModel: standardCostModel("2.2000"),
          mismatchPolicy: tolerantMismatchPolicy(),
          minAmount: "1.0000",
          maxAmount: "10000.0000",
          dailyCapAmount: "150000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
          pollPolicy: {
            firstAfterSeconds: 10,
            backoffSeconds: [10, 30, 60, 120, 300, 600],
            maxDurationSeconds: 1800,
            stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
          },
          redirect: {
            method: "GET",
            urlSourceOutput: "redirect_url",
            target: "SAME_WINDOW",
            returnMethodExpected: "GET",
            returnParamsMap: { status: "status", reference: "custom_ref" },
          },
        },
      ],
    },
    {
      code: "tlync",
      nameAr: "تي لينك",
      nameEn: "T-LYNC",
      collectionMode: "REDIRECT",
      subModes: ["REDIRECT"],
      minAmount: "1.0000",
      maxAmount: "10000.0000",
      instructionsAr: "سيتم تحويلك إلى صفحة الدفع المستضافة لإتمام العملية.",
      instructionsEn: "You are redirected to the hosted checkout page to complete the payment.",
      fields: [
        {
          key: "customer_mobile",
          type: "PHONE",
          checksum: "NONE",
          labelAr: "رقم الهاتف",
          labelEn: "Mobile number",
          placeholderAr: "09XXXXXXXX",
          placeholderEn: "09XXXXXXXX",
          regex: "^09[0-9]{8}$",
          minLength: 10,
          maxLength: 10,
          required: false,
          orderIndex: 1,
          sensitivity: "SENSITIVE",
        },
        {
          key: "customer_email",
          type: "STRING",
          checksum: "NONE",
          labelAr: "البريد الإلكتروني",
          labelEn: "Email address",
          placeholderAr: "name@example.com",
          placeholderEn: "name@example.com",
          regex: "^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$",
          minLength: 5,
          maxLength: 120,
          required: false,
          orderIndex: 2,
          sensitivity: "NORMAL",
        },
      ],
      routes: [
        {
          gatewayCode: "tlync",
          credentialPolicy: "PLATFORM",
          priority: 10,
          costModel: standardCostModel("1.9000"),
          mismatchPolicy: tolerantMismatchPolicy(),
          minAmount: "1.0000",
          maxAmount: "10000.0000",
          dailyCapAmount: "150000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
          pollPolicy: {
            firstAfterSeconds: 10,
            backoffSeconds: [10, 30, 60, 120, 300, 600],
            maxDurationSeconds: 1800,
            stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
          },
          redirect: {
            method: "GET",
            urlSourceOutput: "redirect_url",
            target: "SAME_WINDOW",
            returnMethodExpected: "GET",
            returnParamsMap: { status: "status", reference: "custom_ref" },
          },
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Blueprint 5 - MobiCash, OnePay, Yussor & Sahara (HYBRID)
 * ------------------------------------------------------------------ */

const hybridGateway = (input: {
  code: string;
  name: string;
  operator: string;
  aliases: string[];
  kind?: BlueprintGatewayKind;
  verificationState?: "VERIFIED" | "UNVERIFIED";
  auth: BlueprintAuth;
  cardRegex: string;
  cardLength: number;
  verifyVia: "LOCAL_SETTLEMENT_RECONCILE" | "DPay_GET_INQUIRY";
  inquiryPath: string;
}): BlueprintGateway => ({
  code: input.code,
  name: input.name,
  operator: input.operator,
  aliases: input.aliases,
  kind: input.kind ?? "DIRECT",
  verificationState: input.verificationState ?? "VERIFIED",
  auth: input.auth,
  environments: environmentsFor(input.code, {
    inboundIpAllowlist: ["192.0.2.0/24"],
  }),
  settings: lydSettings({
    sessionTtlSeconds: 900,
    otpTtlSeconds: 300,
    otpResendCooldownSeconds: 90,
    maxOtpAttempts: 3,
    supportsStatusCheck: input.verifyVia === "DPay_GET_INQUIRY",
    statusCheckMinAgeSeconds: 30,
    supportsIdempotencyKey: true,
    timeoutMs: 15000,
  }),
  cryptoProfiles: [dpayWebhookVerifyProfile()],
  flows: [
    {
      phase: "INITIATE",
      railCode: input.code,
      steps: [
        step({
          name: "open-payment",
          type: "HTTP",
          method: "POST",
          urlTemplate: "{api}/payment",
          contentType: "application/json",
          sideEffect: "SENDS_NOTIFICATION",
          retryPolicy: "SAFE",
          idempotencyConfig: idempotencyHeader("Idempotency-Key"),
          parameters: [
            param("BODY", "card_number", "CUSTOMER_FIELD", { selector: "card_number" }),
            param("BODY", "mobile_number", "CUSTOMER_FIELD", { selector: "customer_mobile" }),
            param("BODY", "amount", "ATTEMPT", {
              selector: "totalChargedAmount",
              transforms: [{ op: "format_decimal", args: [2] }],
            }),
            param("BODY", "currency", "CONSTANT", { constantValue: "LYD" }),
            param("BODY", "reference", "ATTEMPT", { selector: "reference" }),
          ],
          outputs: [
            output("payment_uuid", "payment_uuid", "STATE", true),
            output("pay_code", "pay_code", "PUBLIC"),
            output("qr_payload", "qr.payload", "PUBLIC"),
          ],
        }),
        step({
          name: "show-otp-or-qr",
          type: "RENDER",
          method: "SHOW_QR_OR_CODE",
          sideEffect: "READ_ONLY",
          retryPolicy: "SAFE",
          outputs: [output("actionType", "actionType", "PUBLIC", true)],
        }),
      ],
    },
    {
      phase: "SUBMIT",
      railCode: input.code,
      steps: [
        step({
          name: "confirm-payment",
          type: "HTTP",
          method: "POST",
          urlTemplate: "{api}/payment/{payment_uuid}/confirm",
          contentType: "application/json",
          sideEffect: "MOVES_MONEY",
          retryPolicy: "NEVER",
          pointOfNoReturn: true,
          idempotencyConfig: idempotencyHeader("Idempotency-Key"),
          parameters: [
            param("PATH", "payment_uuid", "STATE", { selector: "payment_uuid" }),
            param("BODY", "otp", "CUSTOMER_FIELD", { selector: "otp" }),
            param("BODY", "reference", "ATTEMPT", { selector: "reference" }),
          ],
          outputs: [
            output("status", "status", "STATE", true),
            output("bank_reference", "bank_reference", "PROVIDER_REF", true),
            output("settled_amount", "amount", "SETTLED_AMOUNT"),
          ],
        }),
      ],
    },
    {
      phase: "VERIFY",
      railCode: input.code,
      steps:
        input.verifyVia === "DPay_GET_INQUIRY"
          ? [
              step({
                name: "inquiry-payment",
                type: "HTTP",
                method: "GET",
                urlTemplate: `{api}${input.inquiryPath}`,
                contentType: "application/json",
                sideEffect: "READ_ONLY",
                retryPolicy: "SAFE",
                parameters: [
                  param("QUERY", "reference", "ATTEMPT", { selector: "reference" }),
                ],
                outputs: [
                  output("status", "status", "STATE", true),
                  output("settled_amount", "amount", "SETTLED_AMOUNT"),
                  output("provider_reference", "bank_reference", "PROVIDER_REF"),
                ],
              }),
            ]
          : [
              step({
                name: "local-settlement-reconcile",
                type: "COMPUTE",
                method: "LOCAL_SETTLEMENT_RECONCILE",
                sideEffect: "READ_ONLY",
                retryPolicy: "SAFE",
                outputs: [
                  output("status", "status", "STATE"),
                  output("settled_amount", "settled_amount", "SETTLED_AMOUNT"),
                  output("provider_reference", "provider_reference", "PROVIDER_REF"),
                ],
              }),
            ],
    },
  ],
  channels: [
    {
      type: "WEBHOOK",
      railCode: input.code,
      pathToken: `${input.code}-webhook`,
      verifyMethod: "HMAC_BODY",
      signatureHeader: "X-Signature",
      timestampToleranceSec: 300,
      ipAllowlist: ["192.0.2.0/24"],
      bodyFormat: "JSON",
      correlationSelector: "reference",
      dedupeKeySelector: "event_id",
      eventMap: { PAID: "SUCCEEDED", FAILED: "FAILED", PENDING: "VERIFYING" },
      mustInquire: true,
      ackStatus: 200,
      ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
      cryptoProfileName: "DPAY_WEBHOOK_VERIFY",
    },
    {
      type: "STATEMENT",
      railCode: input.code,
      pathToken: `${input.code}-statement`,
      verifyMethod: "NONE_PLUS_INQUIRY",
      timestampToleranceSec: 300,
      ipAllowlist: [],
      bodyFormat: "JSON",
      correlationSelector: "reference",
      dedupeKeySelector: "transaction_id",
      eventMap: { SETTLED: "SUCCEEDED" },
      mustInquire: false,
      ackStatus: 200,
    },
  ],
  statusRules: [
    {
      phase: "INITIATE",
      selector: "status",
      op: "EQUALS",
      value: "OTP_SENT",
      canonicalStatus: "AWAITING_CUSTOMER",
    },
    {
      phase: "SUBMIT",
      selector: "status",
      op: "EQUALS",
      value: "SUCCESS",
      canonicalStatus: "SUCCEEDED",
    },
    {
      phase: "SUBMIT",
      selector: "status",
      op: "EQUALS",
      value: "INVALID_OTP",
      canonicalStatus: "AWAITING_CUSTOMER",
      canonicalError: "RETRYABLE_OTP",
    },
  ],
});

const hybridRail = (input: {
  code: string;
  nameAr: string;
  nameEn: string;
  cardRegex: string;
  cardLength: number;
  gatewayCode: string;
  percent: string;
  maxAmount: string;
  dailyCap: string;
}): BlueprintRail => ({
  code: input.code,
  nameAr: input.nameAr,
  nameEn: input.nameEn,
  collectionMode: "HYBRID",
  subModes: ["OTP_PULL", "QR_DISPLAY", "PAY_CODE"],
  minAmount: "1.0000",
  maxAmount: input.maxAmount,
  instructionsAr: "أدخل رقم البطاقة أو امسح رمز الاستجابة السريعة.",
  instructionsEn: "Enter the card number or scan the QR code.",
  fields: [
    {
      key: "card_number",
      type: "PAN",
      checksum: "NONE",
      labelAr: "رقم البطاقة",
      labelEn: "Card number",
      placeholderAr: "0000000",
      placeholderEn: "0000000",
      regex: input.cardRegex,
      minLength: input.cardLength,
      maxLength: input.cardLength,
      required: false,
      orderIndex: 1,
      sensitivity: "PAN",
    },
    {
      key: "customer_mobile",
      type: "PHONE",
      checksum: "NONE",
      labelAr: "رقم الهاتف",
      labelEn: "Mobile number",
      placeholderAr: "09XXXXXXXX",
      placeholderEn: "09XXXXXXXX",
      regex: "^09[0-9]{8}$",
      minLength: 10,
      maxLength: 10,
      required: false,
      orderIndex: 2,
      sensitivity: "SENSITIVE",
    },
    {
      key: "otp",
      type: "OTP",
      checksum: "NONE",
      labelAr: "رمز التحقق",
      labelEn: "Verification code",
      placeholderAr: "000000",
      placeholderEn: "000000",
      regex: "^[0-9]{4,6}$",
      minLength: 4,
      maxLength: 6,
      required: false,
      orderIndex: 3,
      sensitivity: "SENSITIVE",
    },
  ],
  routes: [
    {
      gatewayCode: input.gatewayCode,
      credentialPolicy: "PLATFORM",
      priority: 10,
      costModel: standardCostModel(input.percent),
      mismatchPolicy: tolerantMismatchPolicy(),
      minAmount: "1.0000",
      maxAmount: input.maxAmount,
      dailyCapAmount: input.dailyCap,
      status: "ACTIVE",
      healthState: "HEALTHY",
      scope: baseScope(),
      pollPolicy: {
        firstAfterSeconds: 15,
        backoffSeconds: [15, 30, 60, 120, 300],
        maxDurationSeconds: 900,
        stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
      },
    },
  ],
});

const blueprint5: BlueprintCatalogEntry = {
  key: "hybrid-wallet-rails",
  name: "MobiCash, OnePay, Yussor & Sahara Hybrid",
  description: "HYBRID card, pay-code, and EMVCo QR collection rails.",
  gatewayCodes: ["mobicash", "onepay", "yussor", "sahara"],
  railCodes: ["mobicash", "onepay", "yussor", "sahara"],
  collectionModes: ["HYBRID"],
  kind: "DIRECT",
  country: "LY",
  riskClass: "NORMAL",
  gatewayKinds: {
    mobicash: "DIRECT",
    onepay: "DIRECT",
    yussor: "DIRECT",
    sahara: "DIRECT",
  },
  gateways: [
    hybridGateway({
      code: "mobicash",
      name: "MobiCash",
      operator: "Masarat",
      aliases: ["Mobi Cash"],
      auth: {
        method: "PERMANENT_TOKEN",
        authApply: "HEADER",
        refreshConfigJson: { header_name: "Authorization", bearer: true },
      },
      cardRegex: "^[0-9]{7}$",
      cardLength: 7,
      verifyVia: "LOCAL_SETTLEMENT_RECONCILE",
      inquiryPath: "/get",
    }),
    hybridGateway({
      code: "onepay",
      name: "OnePay",
      operator: "CBL",
      aliases: ["CBL OnePay"],
      verificationState: "UNVERIFIED",
      auth: {
        method: "MUTUAL_TLS",
        authApply: "HEADER",
      },
      cardRegex: "^[0-9]{9}$",
      cardLength: 9,
      verifyVia: "DPay_GET_INQUIRY",
      inquiryPath: "/get",
    }),
    hybridGateway({
      code: "yussor",
      name: "Yussor Pay",
      operator: "National Commercial Bank",
      aliases: ["Yussor"],
      auth: {
        method: "API_KEY",
        authApply: "HEADER",
        refreshConfigJson: { header_name: "X-API-KEY" },
      },
      cardRegex: "^[0-9]{7}$",
      cardLength: 7,
      verifyVia: "DPay_GET_INQUIRY",
      inquiryPath: "/get",
    }),
    hybridGateway({
      code: "sahara",
      name: "Sahara Pay",
      operator: "Sahara Bank",
      aliases: ["Sahara"],
      auth: {
        method: "PERMANENT_TOKEN",
        authApply: "HEADER",
        refreshConfigJson: { header_name: "Authorization", bearer: true },
      },
      cardRegex: "^[0-9]{7}$",
      cardLength: 7,
      verifyVia: "DPay_GET_INQUIRY",
      inquiryPath: "/get",
    }),
  ],
  rails: [
    hybridRail({
      code: "mobicash",
      nameAr: "موبي كاش",
      nameEn: "MobiCash",
      cardRegex: "^[0-9]{7}$",
      cardLength: 7,
      gatewayCode: "mobicash",
      percent: "1.6000",
      maxAmount: "10000.0000",
      dailyCap: "120000.0000",
    }),
    hybridRail({
      code: "onepay",
      nameAr: "ون باي",
      nameEn: "OnePay",
      cardRegex: "^[0-9]{9}$",
      cardLength: 9,
      gatewayCode: "onepay",
      percent: "1.4000",
      maxAmount: "10000.0000",
      dailyCap: "120000.0000",
    }),
    hybridRail({
      code: "yussor",
      nameAr: "يوسور",
      nameEn: "Yussor Pay",
      cardRegex: "^[0-9]{7}$",
      cardLength: 7,
      gatewayCode: "yussor",
      percent: "1.7000",
      maxAmount: "10000.0000",
      dailyCap: "120000.0000",
    }),
    hybridRail({
      code: "sahara",
      nameAr: "صحراء باي",
      nameEn: "Sahara Pay",
      cardRegex: "^[0-9]{7}$",
      cardLength: 7,
      gatewayCode: "sahara",
      percent: "1.7000",
      maxAmount: "10000.0000",
      dailyCap: "120000.0000",
    }),
  ],
};

/* ------------------------------------------------------------------ *
 * Blueprint 6 - MPGS 3DS2 & Evo Pay
 * ------------------------------------------------------------------ */

const blueprint6: BlueprintCatalogEntry = {
  key: "mpgs-evo-pay",
  name: "MPGS 3DS2 & Evo Pay",
  description: "EMBEDDED and REDIRECT multi-currency card and wallet checkout.",
  gatewayCodes: ["mpgs", "evo_pay"],
  railCodes: ["mpgs", "evo_pay"],
  collectionModes: ["EMBEDDED", "REDIRECT"],
  kind: "DIRECT",
  country: "LY",
  riskClass: "HIGH_RISK",
  gatewayKinds: { mpgs: "DIRECT", evo_pay: "DIRECT" },
  gateways: [
    {
      code: "mpgs",
      name: "Mastercard Payment Gateway Services",
      operator: "MPGS",
      aliases: ["Visa", "Mastercard", "3DS2"],
      kind: "DIRECT",
      verificationState: "VERIFIED",
      auth: {
        method: "BASIC",
        authApply: "HEADER",
        refreshConfigJson: { header_name: "Authorization" },
      },
      environments: environmentsFor("mpgs", {
        inboundIpAllowlist: ["192.0.2.0/24"],
      }),
      settings: lydSettings({
        amountScale: 100,
        amountPrecision: 2,
        amountRounding: "NEAREST",
        amountFormat: "STRING_DECIMAL",
        sessionTtlSeconds: 900,
        otpTtlSeconds: 300,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 30,
        timeoutMs: 30000,
      }),
      cryptoProfiles: [
        {
          name: "MPGS_NOTIFICATION_VERIFY",
          purpose: "INBOUND_VERIFY",
          algorithm: "HMAC_SHA256",
          secretKeyRef: "CREDENTIAL.NotificationSecret",
          secretKeyEncoding: "UTF8",
          canonicalizationMode: "RAW_BODY",
          includedFields: [],
          excludedFields: [],
          outputEncoding: "HEX_LOWER",
        },
      ],
      flows: [
        {
          phase: "INITIATE",
          railCode: "mpgs",
          steps: [
            step({
              name: "create-hosted-session",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/checkout/sessions",
              contentType: "application/json",
              sideEffect: "SENDS_NOTIFICATION",
              retryPolicy: "SAFE",
              idempotencyConfig: idempotencyHeader("Idempotency-Key"),
              parameters: [
                param("BODY", "amount", "ATTEMPT", {
                  selector: "totalChargedAmount",
                  transforms: [{ op: "format_decimal", args: [2] }],
                }),
                param("BODY", "currency", "CONSTANT", { constantValue: "LYD" }),
                param("BODY", "reference", "ATTEMPT", { selector: "reference" }),
                param("BODY", "returnUrl", "URLS", { selector: "return_url" }),
              ],
              outputs: [
                output("session_id", "session_id", "STATE", true),
                output("redirect_url", "redirect_url", "PUBLIC"),
                output("order_id", "order_id", "STATE"),
              ],
            }),
            step({
              name: "render-hosted-session",
              type: "RENDER",
              method: "RENDER_EMBEDDED",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [output("actionType", "actionType", "PUBLIC", true)],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          railCode: "mpgs",
          steps: [
            step({
              name: "inquiry-order",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/order/{order_id}",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [param("PATH", "order_id", "STATE", { selector: "order_id" })],
              outputs: [
                output("result", "result", "STATE", true),
                output("status", "status", "STATE"),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "order.id", "PROVIDER_REF"),
              ],
            }),
            step({
              name: "assert-captured",
              type: "ASSERT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              successCheck: [
                { selector: "result", op: "equals", value: "SUCCESS" },
                { selector: "status", op: "equals", value: "CAPTURED" },
              ],
            }),
          ],
        },
        {
          phase: "VERIFY",
          railCode: "mpgs",
          steps: [
            step({
              name: "inquiry-order",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/order/{order_id}",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [param("PATH", "order_id", "STATE", { selector: "order_id" })],
              outputs: [
                output("result", "result", "STATE", true),
                output("status", "status", "STATE"),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "order.id", "PROVIDER_REF"),
              ],
            }),
            step({
              name: "assert-captured",
              type: "ASSERT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              successCheck: [
                { selector: "result", op: "equals", value: "SUCCESS" },
                { selector: "status", op: "equals", value: "CAPTURED" },
              ],
            }),
          ],
        },
      ],
      channels: [
        {
          type: "WEBHOOK",
          railCode: "mpgs",
          pathToken: "mpgs-webhook",
          verifyMethod: "HMAC_BODY",
          signatureHeader: "X-Notification-Secret",
          timestampToleranceSec: 300,
          ipAllowlist: ["192.0.2.0/24"],
          bodyFormat: "JSON",
          correlationSelector: "order.id",
          dedupeKeySelector: "eventId",
          eventMap: { AUTHORISATION: "VERIFYING", CAPTURE: "SUCCEEDED", REVERSAL: "FAILED" },
          mustInquire: true,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
          cryptoProfileName: "MPGS_NOTIFICATION_VERIFY",
        },
        {
          type: "RETURN_URL",
          railCode: "mpgs",
          pathToken: "mpgs-return",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "order.id",
          eventMap: {},
          mustInquire: true,
          ackStatus: 200,
        },
        {
          type: "POLL",
          railCode: "mpgs",
          pathToken: "mpgs-poll",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "order.id",
          eventMap: {},
          mustInquire: false,
          ackStatus: 200,
        },
      ],
      statusRules: [
        {
          phase: "VERIFY",
          selector: "result",
          op: "EQUALS",
          value: "SUCCESS",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "VERIFY",
          selector: "status",
          op: "EQUALS",
          value: "CAPTURED",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "VERIFY",
          selector: "result",
          op: "EQUALS",
          value: "FAILURE",
          canonicalStatus: "FAILED",
          canonicalError: "TERMINAL_DECLINE",
        },
      ],
    },
    {
      code: "evo_pay",
      name: "Evo Pay",
      operator: "Evo Wallet",
      aliases: ["EvoPay"],
      kind: "DIRECT",
      verificationState: "UNVERIFIED",
      auth: {
        method: "API_KEY",
        authApply: "HEADER",
        refreshConfigJson: { header_name: "X-API-KEY", signature_header: "X-Signature" },
      },
      environments: environmentsFor("evo_pay", {
        inboundIpAllowlist: ["192.0.2.0/24"],
      }),
      settings: lydSettings({
        sessionTtlSeconds: 900,
        otpTtlSeconds: 300,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 30,
        timeoutMs: 20000,
      }),
      cryptoProfiles: [
        {
          name: "EVO_PAY_SIGNATURE",
          purpose: "OUTBOUND_SIGN",
          algorithm: "RSA_SHA256",
          secretKeyRef: "CREDENTIAL.PrivateKey",
          secretKeyEncoding: "UTF8",
          canonicalizationMode: "JSON_CANONICAL",
          includedFields: ["transAmount", "merchantTransInfo"],
          excludedFields: [],
          outputEncoding: "BASE64",
        },
      ],
      flows: [
        {
          phase: "INITIATE",
          railCode: "evo_pay",
          steps: [
            step({
              name: "create-payment",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/Payment",
              contentType: "application/json",
              sideEffect: "SENDS_NOTIFICATION",
              retryPolicy: "SAFE",
              idempotencyConfig: idempotencyHeader("Idempotency-Key"),
              parameters: [
                param("BODY", "transAmount.amount", "ATTEMPT", {
                  selector: "totalChargedAmount",
                  transforms: [{ op: "format_decimal", args: [2] }],
                }),
                param("BODY", "transAmount.currency", "CONSTANT", { constantValue: "LYD" }),
                param("BODY", "merchantTransInfo.merchantTransID", "ATTEMPT", {
                  selector: "reference",
                }),
              ],
              outputs: [
                output("payment_id", "payment_id", "STATE", true),
                output("qr_payload", "qrCode", "PUBLIC"),
                output("provider_reference", "payment_id", "PROVIDER_REF"),
              ],
            }),
            step({
              name: "show-qr",
              type: "RENDER",
              method: "SHOW_QR_OR_CODE",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [output("actionType", "actionType", "PUBLIC", true)],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          railCode: "evo_pay",
          steps: [
            step({
              name: "inquiry-payment",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/Payment/{payment_id}",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [param("PATH", "payment_id", "STATE", { selector: "payment_id" })],
              outputs: [
                output("status", "payment.status", "STATE", true),
                output("settled_amount", "payment.transAmount.amount", "SETTLED_AMOUNT"),
                output("provider_reference", "payment.id", "PROVIDER_REF"),
              ],
            }),
            step({
              name: "assert-captured",
              type: "ASSERT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              successCheck: [{ selector: "payment.status", op: "equals", value: "Captured" }],
            }),
          ],
        },
        {
          phase: "VERIFY",
          railCode: "evo_pay",
          steps: [
            step({
              name: "inquiry-payment",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/Payment/{payment_id}",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [param("PATH", "payment_id", "STATE", { selector: "payment_id" })],
              outputs: [
                output("status", "payment.status", "STATE", true),
                output("settled_amount", "payment.transAmount.amount", "SETTLED_AMOUNT"),
                output("provider_reference", "payment.id", "PROVIDER_REF"),
              ],
            }),
            step({
              name: "assert-captured",
              type: "ASSERT",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              successCheck: [{ selector: "payment.status", op: "equals", value: "Captured" }],
            }),
          ],
        },
      ],
      channels: [
        {
          type: "WEBHOOK",
          railCode: "evo_pay",
          pathToken: "evo-pay-webhook",
          verifyMethod: "RSA",
          signatureHeader: "X-Signature",
          timestampToleranceSec: 300,
          ipAllowlist: ["192.0.2.0/24"],
          bodyFormat: "JSON",
          correlationSelector: "merchantTransInfo.merchantTransID",
          dedupeKeySelector: "eventId",
          eventMap: { CAPTURED: "SUCCEEDED", FAILED: "FAILED" },
          mustInquire: true,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
        },
        {
          type: "POLL",
          railCode: "evo_pay",
          pathToken: "evo-pay-poll",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "merchantTransInfo.merchantTransID",
          eventMap: {},
          mustInquire: false,
          ackStatus: 200,
        },
      ],
      statusRules: [
        {
          phase: "VERIFY",
          selector: "payment.status",
          op: "EQUALS",
          value: "Captured",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "VERIFY",
          selector: "payment.status",
          op: "EQUALS",
          value: "Failed",
          canonicalStatus: "FAILED",
          canonicalError: "TERMINAL_DECLINE",
        },
      ],
    },
  ],
  rails: [
    {
      code: "mpgs",
      nameAr: "فيزا وماستركارد",
      nameEn: "Visa & Mastercard",
      collectionMode: "EMBEDDED",
      subModes: ["EMBEDDED", "REDIRECT"],
      minAmount: "1.0000",
      maxAmount: "20000.0000",
      instructionsAr: "أكمل التحقق داخل صفحة الدفع المستضافة.",
      instructionsEn: "Complete the challenge inside the hosted payment page.",
      fields: [],
      routes: [
        {
          gatewayCode: "mpgs",
          credentialPolicy: "PLATFORM",
          priority: 10,
          costModel: standardCostModel("2.4000"),
          mismatchPolicy: strictMismatchPolicy(),
          minAmount: "1.0000",
          maxAmount: "20000.0000",
          dailyCapAmount: "400000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
          pollPolicy: {
            firstAfterSeconds: 10,
            backoffSeconds: [10, 30, 60, 120, 300],
            maxDurationSeconds: 900,
            stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
          },
          widget: {
            kind: "IFRAME",
            sdkDriver: "MPGS_HOSTED_SESSION",
            scriptUrls: [],
            scriptSriHashes: [],
            configTemplate: {
              sessionId: "{{sessionId}}",
              amount: "{{amount}}",
              currency: "{{currency}}",
              reference: "{{reference}}",
            },
            callbacksMap: { complete: "MPGS_SESSION_COMPLETE" },
            allowedOrigins: ["https://pay.domain.ly", "https://checkout.pay.domain.ly"],
            iframeSandboxAttrs: ["allow-forms", "allow-scripts", "allow-same-origin", "allow-popups"],
            cspAdditions: "frame-src https://*.mpgs.example.ly",
          },
        },
      ],
    },
    {
      code: "evo_pay",
      nameAr: "إيفو باي",
      nameEn: "Evo Pay",
      collectionMode: "REDIRECT",
      subModes: ["QR_DISPLAY", "PUSH_APPROVAL"],
      minAmount: "1.0000",
      maxAmount: "10000.0000",
      instructionsAr: "امسح رمز الاستجابة السريعة لإتمام الدفع.",
      instructionsEn: "Scan the QR code to complete the payment.",
      fields: [
        {
          key: "wallet_account_id",
          type: "STRING",
          checksum: "NONE",
          labelAr: "رقم المحفظة",
          labelEn: "Wallet account id",
          placeholderAr: "EW-000000",
          placeholderEn: "EW-000000",
          regex: "^[A-Za-z0-9-]{4,32}$",
          minLength: 4,
          maxLength: 32,
          required: false,
          orderIndex: 1,
          sensitivity: "SENSITIVE",
        },
      ],
      routes: [
        {
          gatewayCode: "evo_pay",
          credentialPolicy: "PLATFORM",
          priority: 10,
          costModel: standardCostModel("2.0000"),
          mismatchPolicy: tolerantMismatchPolicy(),
          minAmount: "1.0000",
          maxAmount: "10000.0000",
          dailyCapAmount: "150000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
          pollPolicy: {
            firstAfterSeconds: 15,
            backoffSeconds: [15, 30, 60, 120, 300],
            maxDurationSeconds: 900,
            stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
          },
          redirect: {
            method: "GET",
            urlSourceOutput: "qr_payload",
            target: "SAME_WINDOW",
            returnMethodExpected: "GET",
            returnParamsMap: { status: "payment.status" },
          },
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Blueprint 7 - NeomPay first party wallet (INTERNAL)
 * ------------------------------------------------------------------ */

const blueprint7: BlueprintCatalogEntry = {
  key: "neompay-internal",
  name: "NeomPay First-Party Wallet",
  description: "INTERNAL PUSH_APPROVAL, OTP_PULL, and QR_DISPLAY wallet rail.",
  gatewayCodes: ["neompay"],
  railCodes: ["neompay_wallet"],
  collectionModes: ["PUSH_APPROVAL", "OTP_PULL", "QR_DISPLAY"],
  kind: "INTERNAL",
  country: "LY",
  riskClass: "NORMAL",
  gatewayKinds: { neompay: "INTERNAL" },
  gateways: [
    {
      code: "neompay",
      name: "NeomPay",
      operator: "Neom",
      aliases: ["Neom Wallet"],
      kind: "INTERNAL",
      verificationState: "VERIFIED",
      auth: {
        method: "MUTUAL_TLS",
        authApply: "HEADER",
      },
      environments: environmentsFor("neompay"),
      settings: lydSettings({
        amountScale: 1,
        amountPrecision: 3,
        amountRounding: "NONE",
        amountFormat: "STRING_DECIMAL",
        sessionTtlSeconds: 600,
        otpTtlSeconds: 300,
        otpResendCooldownSeconds: 60,
        maxOtpAttempts: 3,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 15,
        supportsIdempotencyKey: true,
        supportsCancel: true,
        timeoutMs: 15000,
      }),
      cryptoProfiles: [],
      flows: [
        {
          phase: "INITIATE",
          subMode: "PUSH_APPROVAL",
          railCode: "neompay_wallet",
          steps: [
            step({
              name: "create-payment-request",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/payments/requests",
              contentType: "application/json",
              sideEffect: "SENDS_NOTIFICATION",
              retryPolicy: "SAFE",
              idempotencyConfig: idempotencyHeader("Idempotency-Key"),
              parameters: [
                param("BODY", "amount", "ATTEMPT", {
                  selector: "totalChargedAmount",
                  transforms: [{ op: "format_decimal", args: [3] }],
                }),
                param("BODY", "currency", "CONSTANT", { constantValue: "LYD" }),
                param("BODY", "our_reference", "ATTEMPT", { selector: "reference" }),
                param("BODY", "wallet_id", "CUSTOMER_FIELD", { selector: "wallet_id" }),
              ],
              outputs: [
                output("request_id", "request_id", "STATE", true),
                output("wallet_hint", "wallet_hint", "PUBLIC"),
              ],
            }),
            step({
              name: "show-push-approval",
              type: "RENDER",
              method: "SHOW_PUSH_OR_TRANSFER",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [output("actionType", "actionType", "PUBLIC", true)],
            }),
          ],
        },
        {
          phase: "INITIATE",
          subMode: "OTP_PULL",
          railCode: "neompay_wallet",
          steps: [
            step({
              name: "create-payment-request",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/payments/requests",
              contentType: "application/json",
              sideEffect: "SENDS_NOTIFICATION",
              retryPolicy: "SAFE",
              idempotencyConfig: idempotencyHeader("Idempotency-Key"),
              parameters: [
                param("BODY", "amount", "ATTEMPT", {
                  selector: "totalChargedAmount",
                  transforms: [{ op: "format_decimal", args: [3] }],
                }),
                param("BODY", "currency", "CONSTANT", { constantValue: "LYD" }),
                param("BODY", "our_reference", "ATTEMPT", { selector: "reference" }),
                param("BODY", "wallet_id", "CUSTOMER_FIELD", { selector: "wallet_id" }),
              ],
              outputs: [output("request_id", "request_id", "STATE", true)],
            }),
          ],
        },
        {
          phase: "INITIATE",
          subMode: "QR_DISPLAY",
          railCode: "neompay_wallet",
          steps: [
            step({
              name: "build-qr-payload",
              type: "COMPUTE",
              method: "NEOMPAY_QR_PAYLOAD",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [
                output("qr_payload", "qr_payload", "PUBLIC", true),
                output("expires_at", "expires_at", "PUBLIC"),
                output("request_id", "request_id", "STATE"),
              ],
            }),
            step({
              name: "show-qr",
              type: "RENDER",
              method: "SHOW_QR_OR_CODE",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              outputs: [output("actionType", "actionType", "PUBLIC", true)],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          subMode: "OTP_PULL",
          railCode: "neompay_wallet",
          steps: [
            step({
              name: "confirm-payment",
              type: "HTTP",
              method: "POST",
              urlTemplate: "{api}/payments/{request_id}/confirm",
              contentType: "application/json",
              sideEffect: "MOVES_MONEY",
              retryPolicy: "NEVER",
              pointOfNoReturn: true,
              idempotencyConfig: idempotencyHeader("Idempotency-Key"),
              parameters: [
                param("PATH", "request_id", "STATE", { selector: "request_id" }),
                param("BODY", "wallet_id", "CUSTOMER_FIELD", { selector: "wallet_id" }),
                param("BODY", "otp", "CUSTOMER_FIELD", { selector: "otp" }),
                param("BODY", "our_reference", "ATTEMPT", { selector: "reference" }),
              ],
              outputs: [
                output("status", "status", "STATE", true),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "payment_id", "PROVIDER_REF"),
              ],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          subMode: "PUSH_APPROVAL",
          railCode: "neompay_wallet",
          steps: [
            step({
              name: "read-approval-state",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/payments/requests/{request_id}",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [param("PATH", "request_id", "STATE", { selector: "request_id" })],
              outputs: [
                output("status", "status", "STATE", true),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "payment_id", "PROVIDER_REF"),
              ],
            }),
          ],
        },
        {
          phase: "SUBMIT",
          subMode: "QR_DISPLAY",
          railCode: "neompay_wallet",
          steps: [
            step({
              name: "inquire-by-reference",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/payments/by-reference/{our_reference}",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [
                param("PATH", "our_reference", "ATTEMPT", { selector: "reference" }),
              ],
              outputs: [
                output("status", "status", "STATE", true),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "payment_id", "PROVIDER_REF"),
              ],
            }),
          ],
        },
        {
          phase: "VERIFY",
          railCode: "neompay_wallet",
          steps: [
            step({
              name: "inquire-by-reference",
              type: "HTTP",
              method: "GET",
              urlTemplate: "{api}/payments/by-reference/{our_reference}",
              contentType: "application/json",
              sideEffect: "READ_ONLY",
              retryPolicy: "SAFE",
              parameters: [
                param("PATH", "our_reference", "ATTEMPT", { selector: "reference" }),
              ],
              outputs: [
                output("status", "status", "STATE", true),
                output("settled_amount", "amount", "SETTLED_AMOUNT"),
                output("provider_reference", "payment_id", "PROVIDER_REF"),
              ],
            }),
          ],
        },
      ],
      channels: [
        {
          type: "POLL",
          railCode: "neompay_wallet",
          pathToken: "neompay-poll",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "our_reference",
          eventMap: {},
          mustInquire: false,
          ackStatus: 200,
        },
        {
          type: "WEBHOOK",
          railCode: "neompay_wallet",
          pathToken: "neompay-webhook",
          verifyMethod: "NONE_PLUS_INQUIRY",
          timestampToleranceSec: 300,
          ipAllowlist: [],
          bodyFormat: "JSON",
          correlationSelector: "our_reference",
          dedupeKeySelector: "event_id",
          eventMap: { APPROVED: "SUCCEEDED", DECLINED: "FAILED" },
          mustInquire: true,
          ackStatus: 200,
          ackBodyTemplate: JSON.stringify({ status: "acknowledged" }),
        },
      ],
      statusRules: [
        {
          phase: "INITIATE",
          selector: "status",
          op: "EQUALS",
          value: "REQUESTED",
          canonicalStatus: "AWAITING_CUSTOMER",
        },
        {
          phase: "SUBMIT",
          selector: "status",
          op: "EQUALS",
          value: "CAPTURED",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "SUBMIT",
          selector: "status",
          op: "EQUALS",
          value: "PENDING",
          canonicalStatus: "AWAITING_CUSTOMER",
        },
        {
          phase: "VERIFY",
          selector: "status",
          op: "EQUALS",
          value: "CAPTURED",
          canonicalStatus: "SUCCEEDED",
        },
        {
          phase: "VERIFY",
          selector: "status",
          op: "EQUALS",
          value: "RELEASED",
          canonicalStatus: "FAILED",
          canonicalError: "TERMINAL_DECLINE",
        },
      ],
    },
  ],
  rails: [
    {
      code: "neompay_wallet",
      nameAr: "محفظة نيوم باي",
      nameEn: "NeomPay Wallet",
      collectionMode: "HYBRID",
      subModes: ["PUSH_APPROVAL", "OTP_PULL", "QR_DISPLAY"],
      minAmount: "0.1000",
      maxAmount: "50000.0000",
      instructionsAr: "وافق على إشعار الدفع أو امسح رمز الاستجابة السريعة.",
      instructionsEn: "Approve the push notification or scan the QR code.",
      fields: [
        {
          key: "wallet_id",
          type: "WALLET_ID",
          checksum: "LUHN",
          labelAr: "رقم المحفظة",
          labelEn: "Wallet id",
          placeholderAr: "NP-000000000000",
          placeholderEn: "NP-000000000000",
          regex: "^NP-[0-9]{12}$",
          minLength: 15,
          maxLength: 15,
          optionsJson: {
            wallet_types: ["01", "02", "03", "04", "05"],
            note: "Allow-listed NeomPay wallet type codes (NP-TTSSSSSSSSSC).",
          },
          required: false,
          orderIndex: 1,
          sensitivity: "SENSITIVE",
        },
        {
          key: "otp",
          type: "OTP",
          checksum: "NONE",
          labelAr: "رمز التحقق",
          labelEn: "Verification code",
          placeholderAr: "0000",
          placeholderEn: "0000",
          regex: "^[0-9]{4,6}$",
          minLength: 4,
          maxLength: 6,
          required: false,
          orderIndex: 2,
          sensitivity: "SENSITIVE",
        },
      ],
      routes: [
        {
          gatewayCode: "neompay",
          credentialPolicy: "PLATFORM",
          priority: 100,
          routingStrategy: "STRICT_PRIORITY",
          costModel: internalCostModel(),
          mismatchPolicy: strictMismatchPolicy(),
          minAmount: "0.1000",
          maxAmount: "50000.0000",
          dailyCapAmount: "1000000.0000",
          status: "ACTIVE",
          healthState: "HEALTHY",
          scope: baseScope(),
          pollPolicy: {
            firstAfterSeconds: 5,
            backoffSeconds: [5, 10, 20, 30, 60],
            maxDurationSeconds: 600,
            stopOnStates: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
          },
        },
      ],
    },
  ],
};

/**
 * A channel that carries no signature must always be confirmed by an inquiry.
 * The rule is enforced once so that the seeded rows and the catalogue never
 * disagree.
 */
const normalizeChannels = (blueprint: BlueprintCatalogEntry): BlueprintCatalogEntry => ({
  ...blueprint,
  gateways: blueprint.gateways.map((gateway) => ({
    ...gateway,
    channels: gateway.channels.map((channel) => ({
      ...channel,
      mustInquire: channel.mustInquire || channel.verifyMethod === "NONE_PLUS_INQUIRY",
    })),
  })),
});

export const BLUEPRINT_CATALOG: BlueprintCatalogEntry[] = [
  blueprint1,
  blueprint2,
  blueprint3,
  blueprint4,
  blueprint5,
  blueprint6,
  blueprint7,
].map(normalizeChannels);

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

const SEED_ACTOR_EMAIL = "gateway-admin@payment-gateway.internal";
const GATEWAY_VERSION_NUMBER = 1;

const json = (value: unknown): Prisma.InputJsonValue => value as unknown as Prisma.InputJsonValue;

const contentHashFor = (blueprintKey: string, gatewayCode: string, versionNumber: number): string =>
  createHash("sha256").update(`${blueprintKey}:${gatewayCode}:v${versionNumber}`).digest("hex");

const snapshotFor = (
  blueprint: BlueprintCatalogEntry,
  gateway: BlueprintGateway,
  versionNumber: number,
): string =>
  JSON.stringify({
    blueprintKey: blueprint.key,
    gatewayCode: gateway.code,
    versionNumber,
    kind: gateway.kind,
    auth: gateway.auth,
    settings: gateway.settings,
    cryptoProfiles: gateway.cryptoProfiles.map((profile) => profile.name),
    flows: gateway.flows.map((flow) => ({
      phase: flow.phase,
      subMode: flow.subMode ?? null,
      railCode: flow.railCode ?? null,
      steps: flow.steps.map((entry) => ({
        name: entry.name,
        type: entry.type,
        sideEffect: entry.sideEffect,
        retryPolicy: entry.retryPolicy,
        pointOfNoReturn: entry.pointOfNoReturn,
      })),
    })),
    channels: gateway.channels.map((channel) => channel.pathToken),
  });

const refreshConfigFor = (
  auth: BlueprintAuth,
  environment: BlueprintEnvironment,
): Record<string, unknown> | undefined => {
  const config: Record<string, unknown> = { ...auth.refreshConfigJson };
  if (auth.tokenEndpointPath) {
    config.token_endpoint = `${environment.baseUrls.api ?? ""}${auth.tokenEndpointPath}`;
    config.access_token_selector = auth.accessTokenSelector ?? "access_token";
    config.expires_in_selector = auth.expiresInSelector ?? "expires_in";
  }
  return Object.keys(config).length > 0 ? config : undefined;
};

/**
 * The capability flags of a rail. The keys are the snake_case names of design
 * v5 §6.3 (`partial_refund`, not `partialRefund`).
 */
export const RAIL_CAPABILITIES: Record<string, boolean> = {
  refund: true,
  partial_refund: true,
  void: true,
  capture: true,
  recurring: false,
};

const seedGatewayVersion = async (
  prisma: PrismaClient,
  blueprint: BlueprintCatalogEntry,
  gateway: BlueprintGateway,
  actorId: string,
): Promise<string> => {
  const contentHash = contentHashFor(blueprint.key, gateway.code, GATEWAY_VERSION_NUMBER);
  const gatewayRow = await prisma.gateway.findUniqueOrThrow({ where: { code: gateway.code } });
  const version = await prisma.gatewayVersion.upsert({
    where: { contentHash },
    update: {
      gatewayId: gatewayRow.id,
      versionNumber: GATEWAY_VERSION_NUMBER,
      snapshotCiphertext: snapshotFor(blueprint, gateway, GATEWAY_VERSION_NUMBER),
      state: "LIVE",
      createdById: actorId,
      changeNote: `Seeded production blueprint '${blueprint.key}'.`,
    },
    create: {
      gatewayId: gatewayRow.id,
      versionNumber: GATEWAY_VERSION_NUMBER,
      snapshotCiphertext: snapshotFor(blueprint, gateway, GATEWAY_VERSION_NUMBER),
      contentHash,
      state: "LIVE",
      createdById: actorId,
      changeNote: `Seeded production blueprint '${blueprint.key}'.`,
    },
  });

  for (const environment of gateway.environments) {
    await prisma.gatewayEnvironment.upsert({
      where: { gatewayVersionId_env: { gatewayVersionId: version.id, env: environment.env } },
      update: {
        baseUrls: json(environment.baseUrls),
        allowedHosts: json(environment.allowedHosts),
        inboundIpAllowlist: json(environment.inboundIpAllowlist),
        outboundEgressIps: json([]),
        enabled: true,
      },
      create: {
        gatewayVersionId: version.id,
        env: environment.env,
        baseUrls: json(environment.baseUrls),
        allowedHosts: json(environment.allowedHosts),
        inboundIpAllowlist: json(environment.inboundIpAllowlist),
        outboundEgressIps: json([]),
        enabled: true,
      },
    });

    const refreshConfigJson = refreshConfigFor(gateway.auth, environment);
    await prisma.gatewayAuth.upsert({
      where: { gatewayVersionId_env: { gatewayVersionId: version.id, env: environment.env } },
      update: {
        method: gateway.auth.method,
        authApply: gateway.auth.authApply,
        refreshConfigJson: jsonOptional(refreshConfigJson),
      },
      create: {
        gatewayVersionId: version.id,
        env: environment.env,
        method: gateway.auth.method,
        authApply: gateway.auth.authApply,
        refreshConfigJson: jsonOptional(refreshConfigJson),
      },
    });
  }

  await prisma.gatewaySetting.upsert({
    where: { gatewayVersionId: version.id },
    update: {
      amountScale: gateway.settings.amountScale,
      amountPrecision: gateway.settings.amountPrecision,
      amountRounding: gateway.settings.amountRounding,
      amountFormat: gateway.settings.amountFormat,
      referenceFormat: json(gateway.settings.referenceFormat),
      sessionTtlSeconds: gateway.settings.sessionTtlSeconds,
      otpTtlSeconds: gateway.settings.otpTtlSeconds,
      otpResendCooldownSeconds: gateway.settings.otpResendCooldownSeconds,
      maxOtpAttempts: gateway.settings.maxOtpAttempts,
      supportsStatusCheck: gateway.settings.supportsStatusCheck,
      statusCheckMinAgeSeconds: gateway.settings.statusCheckMinAgeSeconds ?? null,
      supportsIdempotencyKey: gateway.settings.supportsIdempotencyKey,
      supportsCancel: gateway.settings.supportsCancel,
      timeoutMs: gateway.settings.timeoutMs,
      maxResponseBytes: gateway.settings.maxResponseBytes,
      gatewayTimezone: gateway.settings.gatewayTimezone,
    },
    create: {
      gatewayVersionId: version.id,
      amountScale: gateway.settings.amountScale,
      amountPrecision: gateway.settings.amountPrecision,
      amountRounding: gateway.settings.amountRounding,
      amountFormat: gateway.settings.amountFormat,
      referenceFormat: json(gateway.settings.referenceFormat),
      sessionTtlSeconds: gateway.settings.sessionTtlSeconds,
      otpTtlSeconds: gateway.settings.otpTtlSeconds,
      otpResendCooldownSeconds: gateway.settings.otpResendCooldownSeconds,
      maxOtpAttempts: gateway.settings.maxOtpAttempts,
      supportsStatusCheck: gateway.settings.supportsStatusCheck,
      statusCheckMinAgeSeconds: gateway.settings.statusCheckMinAgeSeconds ?? null,
      supportsIdempotencyKey: gateway.settings.supportsIdempotencyKey,
      supportsCancel: gateway.settings.supportsCancel,
      timeoutMs: gateway.settings.timeoutMs,
      maxResponseBytes: gateway.settings.maxResponseBytes,
      gatewayTimezone: gateway.settings.gatewayTimezone,
    },
  });

  for (const profile of gateway.cryptoProfiles) {
    await prisma.cryptoProfile.upsert({
      where: { gatewayVersionId_name: { gatewayVersionId: version.id, name: profile.name } },
      update: {
        purpose: profile.purpose,
        algorithm: profile.algorithm,
        secretKeyRef: profile.secretKeyRef,
        secretKeyEncoding: profile.secretKeyEncoding,
        canonicalizationMode: profile.canonicalizationMode,
        templateString: profile.templateString,
        includedFields: json(profile.includedFields),
        excludedFields: json(profile.excludedFields),
        outputEncoding: profile.outputEncoding,
      },
      create: {
        gatewayVersionId: version.id,
        name: profile.name,
        purpose: profile.purpose,
        algorithm: profile.algorithm,
        secretKeyRef: profile.secretKeyRef,
        secretKeyEncoding: profile.secretKeyEncoding,
        canonicalizationMode: profile.canonicalizationMode,
        templateString: profile.templateString,
        includedFields: json(profile.includedFields),
        excludedFields: json(profile.excludedFields),
        outputEncoding: profile.outputEncoding,
      },
    });
  }

  // Flows have no natural unique key, so the version is rebuilt as a whole.
  // The delete cascades to the steps, the parameters and the outputs.
  await prisma.flow.deleteMany({ where: { gatewayVersionId: version.id } });
  for (const flow of gateway.flows) {
    const rail = flow.railCode
      ? await prisma.rail.findUnique({ where: { code: flow.railCode } })
      : null;
    await prisma.flow.create({
      data: {
        gatewayVersionId: version.id,
        railId: rail?.id ?? null,
        subMode: flow.subMode ?? null,
        phase: flow.phase,
        steps: {
          create: flow.steps.map((entry, index) => ({
            orderIndex: index,
            type: entry.type,
            method: entry.method,
            urlTemplate: entry.urlTemplate,
            contentType: contentTypeFor(entry.contentType),
            timeoutMs: entry.timeoutMs,
            successCheck: entry.successCheck ? json(entry.successCheck) : undefined,
            sideEffect: entry.sideEffect,
            retryPolicy: entry.retryPolicy,
            idempotencyConfig: json(entry.idempotencyConfig),
            pointOfNoReturn: entry.pointOfNoReturn,
            parameters: {
              create: (entry.parameters ?? []).map((parameter) => ({
                place: parameter.place,
                key: parameter.key,
                source: parameter.source,
                selector: parameter.selector,
                constantValue: parameter.constantValue,
                transforms: json(parameter.transforms ?? []),
              })),
            },
            outputs: {
              create: (entry.outputs ?? []).map((outputDefinition) => ({
                name: outputDefinition.name,
                selector: outputDefinition.selector,
                transforms: json(outputDefinition.transforms ?? []),
                storeAs: outputDefinition.storeAs,
                required: outputDefinition.required ?? false,
              })),
            },
          })),
        },
      },
    });
  }

  await prisma.statusRule.deleteMany({ where: { gatewayVersionId: version.id } });
  for (const [index, rule] of gateway.statusRules.entries()) {
    await prisma.statusRule.create({
      data: {
        gatewayVersionId: version.id,
        phase: rule.phase,
        orderIndex: index,
        selector: rule.selector,
        op: rule.op,
        valueJson: json(rule.value ?? null),
        canonicalStatus: rule.canonicalStatus,
        canonicalSubstatus: rule.canonicalSubstatus,
        canonicalError: rule.canonicalError,
      },
    });
  }

  return version.id;
};

const jsonOptional = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : json(value);

const CONTENT_TYPES: Record<BlueprintContentType, string> = {
  "application/json": "APPLICATION_JSON",
  "application/x-www-form-urlencoded": "APPLICATION_FORM_URLENCODED",
  "multipart/form-data": "MULTIPART_FORM_DATA",
  "application/xml": "APPLICATION_XML",
  "text/xml": "TEXT_XML",
  "text/plain": "TEXT_PLAIN",
};

const contentTypeFor = (
  value: BlueprintContentType | undefined,
): "APPLICATION_JSON" | "APPLICATION_FORM_URLENCODED" | "MULTIPART_FORM_DATA" | "APPLICATION_XML" | "TEXT_XML" | "TEXT_PLAIN" | null =>
  value ? (CONTENT_TYPES[value] as never) : null;

const seedRail = async (
  prisma: PrismaClient,
  blueprint: BlueprintCatalogEntry,
  rail: BlueprintRail,
): Promise<void> => {
  await prisma.rail.upsert({
    where: { code: rail.code },
    update: {
      nameAr: rail.nameAr,
      nameEn: rail.nameEn,
      collectionMode: rail.collectionMode,
      subModes: json(rail.subModes),
      currency: "LYD",
      minAmount: new Prisma.Decimal(rail.minAmount),
      maxAmount: rail.maxAmount ? new Prisma.Decimal(rail.maxAmount) : null,
      blocked: false,
      capabilities: json(RAIL_CAPABILITIES),
      instructionsAr: rail.instructionsAr,
      instructionsEn: rail.instructionsEn,
      metadata: json({
        blueprintKey: blueprint.key,
        collectionModes: blueprint.collectionModes,
      }),
    },
    create: {
      code: rail.code,
      nameAr: rail.nameAr,
      nameEn: rail.nameEn,
      collectionMode: rail.collectionMode,
      subModes: json(rail.subModes),
      currency: "LYD",
      minAmount: new Prisma.Decimal(rail.minAmount),
      maxAmount: rail.maxAmount ? new Prisma.Decimal(rail.maxAmount) : null,
      blocked: false,
      capabilities: json(RAIL_CAPABILITIES),
      instructionsAr: rail.instructionsAr,
      instructionsEn: rail.instructionsEn,
      metadata: json({
        blueprintKey: blueprint.key,
        collectionModes: blueprint.collectionModes,
      }),
    },
  });

  const railRow = await prisma.rail.findUniqueOrThrow({ where: { code: rail.code } });

  for (const field of rail.fields) {
    await prisma.railField.upsert({
      where: { railId_key: { railId: railRow.id, key: field.key } },
      update: {
        type: field.type,
        checksum: field.checksum ?? "NONE",
        labelAr: field.labelAr,
        labelEn: field.labelEn,
        placeholderAr: field.placeholderAr,
        placeholderEn: field.placeholderEn,
        regex: field.regex,
        minLength: field.minLength,
        maxLength: field.maxLength,
        minVal: field.minVal ? new Prisma.Decimal(field.minVal) : null,
        maxVal: field.maxVal ? new Prisma.Decimal(field.maxVal) : null,
        optionsJson: jsonOptional(field.optionsJson),
        required: field.required,
        orderIndex: field.orderIndex,
        sensitivity: field.sensitivity,
      },
      create: {
        railId: railRow.id,
        key: field.key,
        type: field.type,
        checksum: field.checksum ?? "NONE",
        labelAr: field.labelAr,
        labelEn: field.labelEn,
        placeholderAr: field.placeholderAr,
        placeholderEn: field.placeholderEn,
        regex: field.regex,
        minLength: field.minLength,
        maxLength: field.maxLength,
        minVal: field.minVal ? new Prisma.Decimal(field.minVal) : null,
        maxVal: field.maxVal ? new Prisma.Decimal(field.maxVal) : null,
        optionsJson: jsonOptional(field.optionsJson),
        required: field.required,
        orderIndex: field.orderIndex,
        sensitivity: field.sensitivity,
      },
    });
  }
};

/**
 * The scope of a seeded route.
 *
 * The scope lists the merchants, the applications, the risk tiers and the
 * channels a route is limited to. A list that is empty carries no
 * restriction, and the resolver of the visible rails treats a missing key as
 * unrestricted, so the empty lists are dropped instead of being written as
 * an empty array (which would exclude every merchant).
 */
export const normalizeRouteScope = (scope: Record<string, unknown>): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scope)) {
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    output[key] = value;
  }
  return output;
};

const seedRoutes = async (
  prisma: PrismaClient,
  rail: BlueprintRail,
): Promise<void> => {
  const railRow = await prisma.rail.findUniqueOrThrow({ where: { code: rail.code } });

  for (const route of rail.routes) {
    const gatewayRow = await prisma.gateway.findUniqueOrThrow({
      where: { code: route.gatewayCode },
    });
    const routeRow = await prisma.railRoute.upsert({
      where: {
        railId_gatewayId_credentialPolicy: {
          railId: railRow.id,
          gatewayId: gatewayRow.id,
          credentialPolicy: route.credentialPolicy,
        },
      },
      update: {
        priority: route.priority,
        routingStrategy: route.routingStrategy ?? "EFFECTIVE_COST",
        weight: route.weight ?? 100,
        costModel: json(route.costModel),
        mismatchPolicy: json(route.mismatchPolicy),
        minAmount: new Prisma.Decimal(route.minAmount),
        maxAmount: route.maxAmount ? new Prisma.Decimal(route.maxAmount) : null,
        dailyCapAmount: route.dailyCapAmount ? new Prisma.Decimal(route.dailyCapAmount) : null,
        status: route.status,
        healthState: route.healthState,
        maintenanceWindows: json([]),
        scope: json(normalizeRouteScope(route.scope)),
      },
      create: {
        railId: railRow.id,
        gatewayId: gatewayRow.id,
        credentialPolicy: route.credentialPolicy,
        priority: route.priority,
        routingStrategy: route.routingStrategy ?? "EFFECTIVE_COST",
        weight: route.weight ?? 100,
        costModel: json(route.costModel),
        mismatchPolicy: json(route.mismatchPolicy),
        minAmount: new Prisma.Decimal(route.minAmount),
        maxAmount: route.maxAmount ? new Prisma.Decimal(route.maxAmount) : null,
        dailyCapAmount: route.dailyCapAmount ? new Prisma.Decimal(route.dailyCapAmount) : null,
        status: route.status,
        healthState: route.healthState,
        maintenanceWindows: json([]),
        scope: json(normalizeRouteScope(route.scope)),
      },
    });

    if (route.pollPolicy) {
      await prisma.pollPolicy.upsert({
        where: { routeId: routeRow.id },
        update: {
          firstAfterSeconds: route.pollPolicy.firstAfterSeconds,
          backoffSeconds: json(route.pollPolicy.backoffSeconds),
          maxDurationSeconds: route.pollPolicy.maxDurationSeconds,
          stopOnStates: json(route.pollPolicy.stopOnStates),
        },
        create: {
          routeId: routeRow.id,
          firstAfterSeconds: route.pollPolicy.firstAfterSeconds,
          backoffSeconds: json(route.pollPolicy.backoffSeconds),
          maxDurationSeconds: route.pollPolicy.maxDurationSeconds,
          stopOnStates: json(route.pollPolicy.stopOnStates),
        },
      });
    }

    if (route.widget) {
      await prisma.widgetDefinition.upsert({
        where: { routeId: routeRow.id },
        update: {
          kind: route.widget.kind,
          sdkDriver: route.widget.sdkDriver,
          scriptUrls: json(route.widget.scriptUrls),
          scriptSriHashes: json(route.widget.scriptSriHashes),
          configTemplate: json(route.widget.configTemplate),
          callbacksMap: json(route.widget.callbacksMap),
          allowedOrigins: json(route.widget.allowedOrigins),
          iframeSandboxAttrs: json(route.widget.iframeSandboxAttrs),
          cspAdditions: route.widget.cspAdditions,
        },
        create: {
          routeId: routeRow.id,
          kind: route.widget.kind,
          sdkDriver: route.widget.sdkDriver,
          scriptUrls: json(route.widget.scriptUrls),
          scriptSriHashes: json(route.widget.scriptSriHashes),
          configTemplate: json(route.widget.configTemplate),
          callbacksMap: json(route.widget.callbacksMap),
          allowedOrigins: json(route.widget.allowedOrigins),
          iframeSandboxAttrs: json(route.widget.iframeSandboxAttrs),
          cspAdditions: route.widget.cspAdditions,
        },
      });
    }

    if (route.redirect) {
      await prisma.redirectDefinition.upsert({
        where: { routeId: routeRow.id },
        update: {
          method: route.redirect.method,
          urlSourceOutput: route.redirect.urlSourceOutput,
          formFieldsOutput: route.redirect.formFieldsOutput,
          target: route.redirect.target,
          returnMethodExpected: route.redirect.returnMethodExpected,
          returnParamsMap: json(route.redirect.returnParamsMap),
        },
        create: {
          routeId: routeRow.id,
          method: route.redirect.method,
          urlSourceOutput: route.redirect.urlSourceOutput,
          formFieldsOutput: route.redirect.formFieldsOutput,
          target: route.redirect.target,
          returnMethodExpected: route.redirect.returnMethodExpected,
          returnParamsMap: json(route.redirect.returnParamsMap),
        },
      });
    }
  }
};

const seedChannels = async (
  prisma: PrismaClient,
  gateway: BlueprintGateway,
  versionId: string,
): Promise<void> => {
  for (const channel of gateway.channels) {
    const rail = await prisma.rail.findUnique({ where: { code: channel.railCode } });
    const route = rail
      ? await prisma.railRoute.findFirst({
          where: { railId: rail.id, gateway: { code: gateway.code } },
        })
      : null;
    const cryptoProfile = channel.cryptoProfileName
      ? await prisma.cryptoProfile.findFirst({
          where: { gatewayVersionId: versionId, name: channel.cryptoProfileName },
        })
      : null;

    await prisma.confirmationChannel.upsert({
      where: { pathToken: channel.pathToken },
      update: {
        gatewayVersionId: versionId,
        routeId: route?.id ?? null,
        type: channel.type,
        cryptoProfileId: cryptoProfile?.id ?? null,
        verifyMethod: channel.verifyMethod,
        signatureHeader: channel.signatureHeader,
        timestampSelector: channel.timestampSelector,
        timestampToleranceSec: channel.timestampToleranceSec,
        ipAllowlist: json(channel.ipAllowlist),
        bodyFormat: channel.bodyFormat,
        correlationSelector: channel.correlationSelector,
        dedupeKeySelector: channel.dedupeKeySelector,
        eventMap: json(channel.eventMap),
        mustInquire: channel.mustInquire,
        ackStatus: channel.ackStatus,
        ackBodyTemplate: channel.ackBodyTemplate,
      },
      create: {
        gatewayVersionId: versionId,
        routeId: route?.id ?? null,
        type: channel.type,
        pathToken: channel.pathToken,
        cryptoProfileId: cryptoProfile?.id ?? null,
        verifyMethod: channel.verifyMethod,
        signatureHeader: channel.signatureHeader,
        timestampSelector: channel.timestampSelector,
        timestampToleranceSec: channel.timestampToleranceSec,
        ipAllowlist: json(channel.ipAllowlist),
        bodyFormat: channel.bodyFormat,
        correlationSelector: channel.correlationSelector,
        dedupeKeySelector: channel.dedupeKeySelector,
        eventMap: json(channel.eventMap),
        mustInquire: channel.mustInquire,
        ackStatus: channel.ackStatus,
        ackBodyTemplate: channel.ackBodyTemplate,
      },
    });
  }
};

export const seedBlueprints = async (prisma: PrismaClient) => {  const actor = await prisma.user.findUnique({
    where: { email: SEED_ACTOR_EMAIL },
    select: { id: true },
  });
  if (!actor) {
    throw new Error(
      `The seed actor '${SEED_ACTOR_EMAIL}' does not exist. Run the platform seed before the blueprints.`,
    );
  }

  for (const blueprint of BLUEPRINT_CATALOG) {
    // 1. The gateway rows themselves.
    for (const gateway of blueprint.gateways) {
      const kind = blueprint.gatewayKinds[gateway.code] ?? gateway.kind;
      await prisma.gateway.upsert({
        where: { code: gateway.code },
        update: {
          name: gateway.name,
          operator: gateway.operator,
          aliases: json(gateway.aliases),
          kind,
          country: blueprint.country,
          riskClass: blueprint.riskClass,
          verificationState: gateway.verificationState,
          metadata: json({
            blueprintKey: blueprint.key,
            collectionModes: blueprint.collectionModes,
            description: blueprint.description,
          }),
        },
        create: {
          code: gateway.code,
          name: gateway.name,
          operator: gateway.operator,
          aliases: json(gateway.aliases),
          kind,
          country: blueprint.country,
          riskClass: blueprint.riskClass,
          verificationState: gateway.verificationState,
          metadata: json({
            blueprintKey: blueprint.key,
            collectionModes: blueprint.collectionModes,
            description: blueprint.description,
          }),
        },
      });
    }

    // 2. The rails and their customer facing fields.
    for (const rail of blueprint.rails) {
      await seedRail(prisma, blueprint, rail);
      await seedRoutes(prisma, rail);
    }

    // 3. The live configuration version of every gateway.
    for (const gateway of blueprint.gateways) {
      const versionId = await seedGatewayVersion(prisma, blueprint, gateway, actor.id);
      await prisma.gateway.update({
        where: { code: gateway.code },
        data: {
          activeVersionId: versionId,
          status: "LIVE",
        },
      });
    }

    // 4. The confirmation channels (they reference the rail routes).
    for (const gateway of blueprint.gateways) {
      const version = await prisma.gatewayVersion.findUniqueOrThrow({
        where: {
          contentHash: contentHashFor(blueprint.key, gateway.code, GATEWAY_VERSION_NUMBER),
        },
      });
      await seedChannels(prisma, gateway, version.id);
    }
  }
};
/**
 * The platform owned credential sets of the seeded gateways.
 *
 * Design v5 §6: a route is only visible when its credential set is
 * `VERIFIED`, and a route with the `PLATFORM` credential policy needs a
 * credential set that the platform owns. Without these rows the seeded
 * catalogue has no visible rail at all, so no payment can start.
 *
 * One set is seeded per gateway and environment. The external merchant id of
 * a platform owned set is the sentinel `PLATFORM`, because the uniqueness
 * constraint of the table is `(gateway_id, env, external_merchant_id)`.
 *
 * The entries are empty: a real secret is only ever written through the
 * credential set API, which encrypts it with the vault. The set is seeded as
 * `VERIFIED` so that a freshly seeded database exposes its routes; the
 * operator replaces the entries with the real credentials and the set is
 * verified again.
 */
export const PLATFORM_EXTERNAL_MERCHANT_ID = "PLATFORM";

export const seedPlatformCredentialSets = async (prisma: PrismaClient): Promise<number> => {
  const versions = await prisma.gatewayVersion.findMany({
    where: { state: "LIVE" },
    include: { gateway: { select: { id: true, code: true } }, environments: true },
  });
  let seeded = 0;
  for (const version of versions) {
    for (const environment of version.environments) {
      const existing = await prisma.credentialSet.findFirst({
        where: {
          gatewayId: version.gateway.id,
          env: environment.env,
          externalMerchantId: PLATFORM_EXTERNAL_MERCHANT_ID,
        },
      });
      if (existing) {
        await prisma.credentialSet.update({
          where: { id: existing.id },
          data: {
            ownerType: "PLATFORM",
            ownerMerchantId: null,
            settlementTarget: "PLATFORM_CLEARING",
            status: "VERIFIED",
            lastVerifiedAt: existing.lastVerifiedAt ?? new Date(),
          },
        });
        continue;
      }
      await prisma.credentialSet.create({
        data: {
          gatewayId: version.gateway.id,
          env: environment.env,
          ownerType: "PLATFORM",
          ownerMerchantId: null,
          externalMerchantId: PLATFORM_EXTERNAL_MERCHANT_ID,
          settlementTarget: "PLATFORM_CLEARING",
          entriesCiphertext: json([]),
          status: "VERIFIED",
          lastVerifiedAt: new Date(),
        },
      });
      seeded += 1;
    }
  }
  return seeded;
};
