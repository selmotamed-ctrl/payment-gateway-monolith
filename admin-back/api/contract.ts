import { randomBytes } from "node:crypto";
import { ApiError } from "../lib/error";

/**
 * Translation layer between the public admin vocabulary and core's canonical vocabulary.
 *
 * `core-back/api/internal/admin.ts` is the canonical contract: every write route there
 * re-validates the forwarded body with a STRICT zod object. The public admin vocabulary
 * is looser (different names, different enums, free-form records), so the edge has to
 * translate before forwarding.
 *
 * Rules for every mapper in this file:
 *  - only emit keys that core's schema accepts (core is `.strict()`),
 *  - always emit the keys core requires,
 *  - map renamed fields explicitly, never pass unknown keys through,
 *  - omit optional core fields the public API does not expose instead of inventing values.
 *
 * Every mapper is pure: `(public body) => core body`.
 */

export type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asStringArray = (value: unknown): string[] =>
  asArray(value).filter((entry): entry is string => typeof entry === "string");

const clamp = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

const nonEmpty = (value: string | undefined, fallback: string): string => {
  const candidate = value?.trim() ?? "";
  return candidate.length > 0 ? candidate : fallback;
};

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  const candidate = asString(value)?.trim().toUpperCase();
  if (!candidate) return undefined;
  return allowed.find((entry) => entry.toUpperCase() === candidate);
};

const missingCanonical = (key: string): never => {
  throw new ApiError(
    400,
    "VALIDATION_FAILED",
    `The canonical core field "${key}" is required`,
    { path: [key], message: "Required" },
  );
};

const requireCanonical = (value: string | undefined, key: string, minLength = 1): string => {
  const candidate = value?.trim() ?? "";
  if (candidate.length >= minLength) return candidate;
  return missingCanonical(key);
};

const clampNumber = (value: unknown, min: number, max: number): number | undefined => {
  const candidate = asNumber(value);
  if (candidate === undefined) return undefined;
  return Math.min(Math.max(Math.round(candidate), min), max);
};

const DECIMAL_PATTERN = /^\d{1,14}(\.\d{1,4})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ gateway catalog */

const GATEWAY_KINDS = ["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"] as const;
const RISK_CLASSES = ["NORMAL", "HIGH_RISK"] as const;
const GATEWAY_ENVIRONMENTS = ["SANDBOX", "LIVE"] as const;

const toVerificationState = (value: unknown): "VERIFIED" | "UNVERIFIED" | undefined => {
  const level = asString(value)?.trim().toUpperCase();
  if (level === "VERIFIED") return "VERIFIED";
  if (level === "PARTIAL" || level === "INTERNAL") return "UNVERIFIED";
  return undefined;
};

export const toCoreGatewayCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const name = nonEmpty(asString(source.name), "gateway");
  const result: JsonRecord = {
    code: (asString(source.code) ?? "").trim().toLowerCase(),
    name,
    // core requires `operator`; the public API exposes it optionally and falls back to the
    // gateway category and finally to the display name.
    operator: nonEmpty(asString(source.operator) ?? asString(source.category), name),
    kind: pickEnum(source.kind, GATEWAY_KINDS) ?? "DIRECT",
  };
  const country = asString(source.country);
  if (country) result.country = country.toUpperCase().slice(0, 2);
  const aliases = asStringArray(source.aliases).slice(0, 20);
  if (aliases.length > 0) result.aliases = aliases;
  const verificationState = toVerificationState(source.evidenceLevel);
  if (verificationState) result.verificationState = verificationState;
  const riskClass = pickEnum(source.riskClass, RISK_CLASSES);
  if (riskClass) result.riskClass = riskClass;
  return result;
};

export const toCoreGatewayUpdate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {};
  const code = asString(source.code)?.trim().toLowerCase();
  if (code) result.code = code;
  const name = asString(source.name);
  if (name) result.name = name;
  const operator = asString(source.operator) ?? asString(source.category);
  if (operator) result.operator = operator;
  const country = asString(source.country);
  if (country) result.country = country.toUpperCase().slice(0, 2);
  const kind = pickEnum(source.kind, GATEWAY_KINDS);
  if (kind) result.kind = kind;
  const aliases = asStringArray(source.aliases).slice(0, 20);
  if (aliases.length > 0) result.aliases = aliases;
  const verificationState = toVerificationState(source.evidenceLevel);
  if (verificationState) result.verificationState = verificationState;
  const riskClass = pickEnum(source.riskClass, RISK_CLASSES);
  if (riskClass) result.riskClass = riskClass;
  return result;
};

export const toCoreGatewayVersionCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {};
  const changeNote = asString(source.changelog);
  if (changeNote) result.changeNote = clamp(changeNote, 1000);
  const snapshot = isRecord(source.snapshot) ? source.snapshot : undefined;
  const derived: JsonRecord = {};
  const version = asNumber(source.version);
  if (version !== undefined) derived.version = version;
  const basedOn = asString(source.basedOnVersionId);
  if (basedOn) derived.basedOnVersionId = basedOn;
  result.snapshot = snapshot ?? derived;
  return result;
};

export const toCoreGatewayRollback = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  return { versionId: asString(source.targetVersionId) ?? "" };
};

const resolveEnvironment = (
  code: unknown,
  fallback: (typeof GATEWAY_ENVIRONMENTS)[number],
): (typeof GATEWAY_ENVIRONMENTS)[number] => {
  const value = asString(code)?.trim().toUpperCase() ?? "";
  if (value.length === 0) return fallback;
  if (value.includes("LIVE") || value.includes("PROD")) return "LIVE";
  if (
    value.includes("SANDBOX") ||
    value.includes("TEST") ||
    value.includes("UAT") ||
    value.includes("STAGING") ||
    value.includes("DEV")
  ) {
    return "SANDBOX";
  }
  return fallback;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const toCoreGatewayVersionEnvironments = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const entries = asArray(source.environments).filter(isRecord);
  const requested = pickEnum(source.env, GATEWAY_ENVIRONMENTS);
  const fallback = requested ?? "SANDBOX";
  const resolved = entries.map((entry) => ({
    entry,
    env: resolveEnvironment(entry.env ?? entry.code, requested ?? fallback),
  }));
  const target = requested ?? resolved[0]?.env ?? fallback;
  const selected = resolved.filter((candidate) => candidate.env === target);
  const baseUrls: JsonRecord = {};
  const allowedHosts: string[] = [];
  const inboundIpAllowlist: string[] = [];
  const outboundEgressIps: string[] = [];
  for (const candidate of selected) {
    const code = nonEmpty(asString(candidate.entry.code), target.toLowerCase());
    const baseUrl = asString(candidate.entry.baseUrl);
    if (baseUrl) {
      baseUrls[clamp(code, 40)] = clamp(baseUrl, 500);
    }
    const explicitHosts = asStringArray(candidate.entry.allowedHosts);
    if (explicitHosts.length > 0) {
      for (const host of explicitHosts) {
        if (!allowedHosts.includes(host)) allowedHosts.push(clamp(host, 200));
      }
    } else if (baseUrl) {
      const host = hostOf(baseUrl);
      if (host && !allowedHosts.includes(host)) allowedHosts.push(clamp(host, 200));
    }
    for (const ip of asStringArray(candidate.entry.inboundIpAllowlist)) {
      if (!inboundIpAllowlist.includes(ip)) inboundIpAllowlist.push(clamp(ip, 64));
    }
    for (const ip of asStringArray(candidate.entry.outboundEgressIps)) {
      if (!outboundEgressIps.includes(ip)) outboundEgressIps.push(clamp(ip, 64));
    }
  }
  const result: JsonRecord = {
    env: target,
    baseUrls,
    allowedHosts: allowedHosts.slice(0, 20),
  };
  if (inboundIpAllowlist.length > 0) result.inboundIpAllowlist = inboundIpAllowlist.slice(0, 50);
  if (outboundEgressIps.length > 0) result.outboundEgressIps = outboundEgressIps.slice(0, 50);
  const selectedEntry = selected[0]?.entry;
  const active = selectedEntry ? asBoolean(selectedEntry.enabled) ?? asBoolean(selectedEntry.active) : undefined;
  if (active !== undefined) result.enabled = active;
  return result;
};

const AUTH_METHODS = [
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

const AUTH_APPLY = ["HEADER", "QUERY", "BODY"] as const;

export const toCoreGatewayVersionAuth = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const auth = asRecord(source.auth);
  const settings = { ...asRecord(source.settings), ...auth };
  const result: JsonRecord = {
    env: pickEnum(source.env ?? auth.env, GATEWAY_ENVIRONMENTS) ?? "LIVE",
    method: pickEnum(source.authMethod ?? auth.method, AUTH_METHODS) ?? "NONE",
    authApply:
      pickEnum(source.authApply ?? auth.authApply, AUTH_APPLY) ??
      pickEnum(settings.authApply, AUTH_APPLY) ??
      "HEADER",
  };
  const refreshConfig: JsonRecord = {};
  for (const key of [
    "username",
    "keyRef",
    "tokenUrl",
    "clientIdRef",
    "clientSecretRef",
    "extraHeaders",
    "header_name",
    "query_name",
    "body_name",
    "token_endpoint",
    "refresh_url",
    "refresh_period_ms",
    "signature_header",
    "timestamp_header",
    "signature_algorithm",
  ] as const) {
    if (settings[key] !== undefined) refreshConfig[key] = settings[key];
  }
  if (Object.keys(refreshConfig).length > 0) result.refreshConfigJson = refreshConfig;
  return result;
};

const AMOUNT_SCALES = [1, 100, 1000] as const;
const AMOUNT_PRECISIONS = [0, 2, 3] as const;
const AMOUNT_ROUNDING = ["NONE", "NEAREST", "UP", "DOWN"] as const;
const AMOUNT_FORMATS = ["STRING_DECIMAL", "INTEGER_MINOR_UNITS", "NUMBER"] as const;

export const toCoreGatewayVersionSettings = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const pipeline = asRecord(source.amountPipeline);
  const settings = { ...asRecord(source.settings), ...pipeline };
  const result: JsonRecord = {
    amountScale: AMOUNT_SCALES.includes(settings.amountScale as 1)
      ? (settings.amountScale as 1)
      : 1,
    amountPrecision: AMOUNT_PRECISIONS.includes(settings.amountPrecision as 0)
      ? (settings.amountPrecision as 0)
      : 2,
    amountRounding: pickEnum(settings.amountRounding, AMOUNT_ROUNDING) ?? "NONE",
    amountFormat: pickEnum(settings.amountFormat, AMOUNT_FORMATS) ?? "STRING_DECIMAL",
    referenceFormat: isRecord(settings.referenceFormat) ? settings.referenceFormat : {},
    sessionTtlSeconds: clampNumber(settings.sessionTtlSeconds, 30, 86400) ?? 1800,
    otpTtlSeconds: clampNumber(settings.otpTtlSeconds, 30, 3600) ?? 300,
    otpResendCooldownSeconds: clampNumber(settings.otpResendCooldownSeconds, 0, 3600) ?? 60,
  };
  const timeoutMs = clampNumber(source.timeoutMs ?? settings.timeoutMs, 1000, 120000);
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
  const maxOtpAttempts = clampNumber(settings.maxOtpAttempts, 1, 10);
  if (maxOtpAttempts !== undefined) result.maxOtpAttempts = maxOtpAttempts;
  const supportsStatusCheck = asBoolean(settings.supportsStatusCheck);
  if (supportsStatusCheck !== undefined) result.supportsStatusCheck = supportsStatusCheck;
  const statusCheckMinAgeSeconds = clampNumber(settings.statusCheckMinAgeSeconds, 0, 86400);
  if (statusCheckMinAgeSeconds !== undefined) {
    result.statusCheckMinAgeSeconds = statusCheckMinAgeSeconds;
  }
  const supportsIdempotencyKey = asBoolean(settings.supportsIdempotencyKey);
  if (supportsIdempotencyKey !== undefined) result.supportsIdempotencyKey = supportsIdempotencyKey;
  const supportsCancel = asBoolean(settings.supportsCancel);
  if (supportsCancel !== undefined) result.supportsCancel = supportsCancel;
  const rateLimitPerSecond = clampNumber(settings.rateLimitPerSecond, 1, 1000);
  if (rateLimitPerSecond !== undefined) result.rateLimitPerSecond = rateLimitPerSecond;
  const concurrencyCap = clampNumber(settings.concurrencyCap, 1, 1000);
  if (concurrencyCap !== undefined) result.concurrencyCap = concurrencyCap;
  const maxResponseBytes = clampNumber(settings.maxResponseBytes, 1024, 10485760);
  if (maxResponseBytes !== undefined) result.maxResponseBytes = maxResponseBytes;
  const gatewayTimezone = asString(settings.gatewayTimezone);
  if (gatewayTimezone) result.gatewayTimezone = clamp(gatewayTimezone, 64);
  return result;
};

const CRYPTO_ALGORITHMS = ["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "SHA256"] as const;
const CRYPTO_PURPOSES = ["OUTBOUND_SIGN", "INBOUND_VERIFY"] as const;
const CANONICALIZATION_MODES = [
  "SORTED_KEY_VALUE_AMP",
  "SORTED_VALUES_HASH",
  "TEMPLATE_STRING",
  "JSON_CANONICAL",
  "RAW_BODY",
  "TIMESTAMP_DOT_RAW_BODY",
] as const;
const OUTPUT_ENCODINGS = ["HEX_LOWER", "HEX_UPPER", "BASE64"] as const;

const SECRET_KEY_ENCODINGS = ["UTF8", "HEX", "BASE64"] as const;

const toSecretKeyEncoding = (value: unknown): (typeof SECRET_KEY_ENCODINGS)[number] => {
  const normalized = asString(value)?.trim().toUpperCase() ?? "";
  if (normalized === "HEX") return "HEX";
  if (normalized === "BASE64") return "BASE64";
  return "UTF8";
};

export const toCoreGatewayVersionCryptoProfiles = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const profiles = asArray(source.cryptoProfiles)
    .filter(isRecord)
    .slice(0, 20)
    .map((profile) => {
      const encoding = asString(profile.encoding)?.trim().toUpperCase();
      const canonicalization = asString(profile.canonicalization)?.trim().toUpperCase();
      const outputEncoding = asString(profile.outputEncoding)?.trim().toUpperCase();
      const result: JsonRecord = {
        name: clamp(nonEmpty(asString(profile.code) ?? asString(profile.name), "profile"), 64),
        purpose: pickEnum(profile.purpose ?? profile.direction, CRYPTO_PURPOSES) ?? "OUTBOUND_SIGN",
        algorithm: pickEnum(profile.algorithm, CRYPTO_ALGORITHMS) ?? "SHA256",
        secretKeyEncoding: toSecretKeyEncoding(profile.keyEncoding ?? profile.encoding),
        canonicalizationMode:
          canonicalization && (CANONICALIZATION_MODES as readonly string[]).includes(canonicalization)
            ? canonicalization
            : encoding && (CANONICALIZATION_MODES as readonly string[]).includes(encoding)
              ? encoding
              : "SORTED_KEY_VALUE_AMP",
        outputEncoding:
          outputEncoding && (OUTPUT_ENCODINGS as readonly string[]).includes(outputEncoding)
            ? outputEncoding
            : encoding && (OUTPUT_ENCODINGS as readonly string[]).includes(encoding)
              ? encoding
              : "HEX_LOWER",
      };
      const secretKeyRef = asString(profile.secretRef);
      if (secretKeyRef) result.secretKeyRef = clamp(secretKeyRef, 120);
      const includedFields = asStringArray(profile.fields).slice(0, 100);
      if (includedFields.length > 0) result.includedFields = includedFields;
      return result;
    });
  return { profiles };
};

const FLOW_PHASES = [
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

const FLOW_STEP_TYPES = ["HTTP", "COMPUTE", "RENDER", "WAIT", "ASSERT", "BRANCH"] as const;
const SIDE_EFFECTS = ["READ_ONLY", "SENDS_NOTIFICATION", "MOVES_MONEY"] as const;
const RETRY_POLICIES = ["SAFE", "SAFE_WITH_COOLDOWN", "NEVER"] as const;

const toCoreFlowStep = (entry: unknown): JsonRecord => {
  const step = asRecord(entry);
  const result: JsonRecord = {
    type: pickEnum(step.type, FLOW_STEP_TYPES) ?? "HTTP",
    sideEffect: pickEnum(step.sideEffect, SIDE_EFFECTS) ?? "READ_ONLY",
    retryPolicy: pickEnum(step.retryPolicy, RETRY_POLICIES) ?? "SAFE",
  };
  const method = asString(step.method);
  if (method) result.method = clamp(method, 10);
  const urlTemplate = asString(step.urlTemplate) ?? asString(step.url);
  if (urlTemplate) result.urlTemplate = clamp(urlTemplate, 1000);
  const contentType = asString(step.contentType);
  if (contentType) result.contentType = clamp(contentType, 80);
  const pointOfNoReturn = asBoolean(step.pointOfNoReturn);
  if (pointOfNoReturn !== undefined) result.pointOfNoReturn = pointOfNoReturn;
  if (isRecord(step.idempotencyConfig)) {
    result.idempotencyConfig = step.idempotencyConfig;
  } else {
    const mode = asString(step.idempotencyConfig);
    if (mode) result.idempotencyConfig = { mode: clamp(mode, 64) };
  }
  const timeoutMs = clampNumber(step.timeoutMs, 1000, 120000);
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
  return result;
};

const resolveFlowPhases = (flow: JsonRecord): string[] => {
  const mapped = [...asStringArray(flow.phases), ...(asString(flow.phase) ? [asString(flow.phase) as string] : [])]
    .map((phase) => pickEnum(phase, FLOW_PHASES))
    .filter((phase): phase is (typeof FLOW_PHASES)[number] => phase !== undefined);
  const unique = [...new Set(mapped)];
  if (unique.length > 0) return unique;
  const fromCode = pickEnum(flow.code, FLOW_PHASES);
  return [fromCode ?? "INITIATE"];
};

export const toCoreGatewayVersionFlows = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const flows: JsonRecord[] = [];
  for (const entry of asArray(source.flows).filter(isRecord).slice(0, 40)) {
    const steps = asArray(entry.steps);
    for (const phase of resolveFlowPhases(entry)) {
      const phaseSteps = steps
        .filter((step) => {
          const stepPhase = asString(asRecord(step).phase);
          if (!stepPhase) return true;
          return stepPhase.trim().toUpperCase() === phase;
        })
        .map(toCoreFlowStep);
      flows.push({ phase, steps: phaseSteps });
    }
  }
  return { flows };
};

const CHANNEL_TYPES = ["WEBHOOK", "RETURN_URL", "BROWSER_CALLBACK", "POLL", "STATEMENT", "OPERATOR"] as const;
const VERIFY_METHODS = [
  "HMAC_BODY",
  "HASH_FIELDS",
  "SORTED_VALUES_HASH",
  "RSA",
  "SHARED_TOKEN",
  "IP_ONLY",
  "NONE_PLUS_INQUIRY",
] as const;
const BODY_FORMATS = ["JSON", "FORM", "XML"] as const;

const defaultVerifyMethod = (type: string): (typeof VERIFY_METHODS)[number] => {
  if (type === "POLL" || type === "OPERATOR") return "NONE_PLUS_INQUIRY";
  if (type === "STATEMENT") return "HASH_FIELDS";
  if (type === "RETURN_URL" || type === "BROWSER_CALLBACK") return "SHARED_TOKEN";
  return "HMAC_BODY";
};

const resolvePathToken = (source: JsonRecord): string => {
  const candidate =
    asString(source.pathToken) ??
    asString(source.token) ??
    asString(source.path) ??
    asString(source.code) ??
    asString(source.name);
  if (candidate && candidate.length >= 8 && candidate.length <= 120) return candidate;
  return randomBytes(16).toString("hex");
};

const CHANNEL_KINDS: Record<string, string> = {
  WEBHOOK: "WEBHOOK",
  RETURN_URL: "RETURN_URL",
  BROWSER_CALLBACK: "BROWSER_CALLBACK",
  INQUIRY_POLL: "POLL",
  POLL: "POLL",
  STATEMENT: "STATEMENT",
  OPERATOR: "OPERATOR",
  SYNC_RESPONSE: "WEBHOOK",
};

const toCoreChannel = (entry: unknown, forcedType?: string): JsonRecord | null => {
  if (!isRecord(entry)) return null;
  const kind = asString(entry.kind)?.trim().toUpperCase() ?? "";
  const type = forcedType ?? pickEnum(entry.type, CHANNEL_TYPES) ?? CHANNEL_KINDS[kind] ?? "WEBHOOK";
  const verifyMethod = pickEnum(entry.verifyMethod, VERIFY_METHODS) ?? defaultVerifyMethod(type);
  const result: JsonRecord = {
    type,
    pathToken: resolvePathToken(entry),
    verifyMethod,
    bodyFormat: pickEnum(entry.bodyFormat, BODY_FORMATS) ?? "JSON",
  };
  const routeId = asString(entry.routeId);
  if (routeId) result.routeId = clamp(routeId, 64);
  const signatureHeader = asString(entry.signatureHeader);
  if (signatureHeader) result.signatureHeader = clamp(signatureHeader, 120);
  const correlationSelector = asString(entry.correlationSelector);
  if (correlationSelector) result.correlationSelector = clamp(correlationSelector, 160);
  const dedupeKeySelector = asString(entry.dedupeKeySelector);
  if (dedupeKeySelector) result.dedupeKeySelector = clamp(dedupeKeySelector, 160);
  const ackBodyTemplate = asString(entry.ackBodyTemplate);
  if (ackBodyTemplate) result.ackBodyTemplate = clamp(ackBodyTemplate, 1000);
  const timestampToleranceSec = clampNumber(
    entry.timestampToleranceSec ?? entry.timestampToleranceSeconds,
    30,
    86400,
  );
  if (timestampToleranceSec !== undefined) result.timestampToleranceSec = timestampToleranceSec;
  const ipAllowlist = asStringArray(entry.ipAllowlist).slice(0, 50);
  if (ipAllowlist.length > 0) result.ipAllowlist = ipAllowlist;
  const ackStatus = clampNumber(entry.ackStatus, 200, 599);
  if (ackStatus !== undefined) result.ackStatus = ackStatus;
  const weakVerification = verifyMethod === "SHARED_TOKEN" || verifyMethod === "IP_ONLY";
  const weakTransport = type === "RETURN_URL" || type === "BROWSER_CALLBACK";
  const mustInquire = asBoolean(entry.mustInquire);
  result.mustInquire = mustInquire ?? (weakVerification || weakTransport);
  return result;
};

export const toCoreGatewayVersionChannels = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const channels: JsonRecord[] = [];
  for (const entry of asArray(source.confirmationChannels)) {
    const channel = toCoreChannel(entry);
    if (channel) channels.push(channel);
  }
  for (const entry of asArray(source.pollPolicies)) {
    const channel = toCoreChannel(entry, "POLL");
    if (channel) channels.push(channel);
  }
  return { channels: channels.slice(0, 20) };
};

const STATUS_RULE_OPS = ["equals", "not_equals", "in", "exists", "matches"] as const;
const CANONICAL_STATUSES = ["AWAITING_CUSTOMER", "VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;

const toCanonicalStatus = (value: unknown): (typeof CANONICAL_STATUSES)[number] => {
  const direct = pickEnum(value, CANONICAL_STATUSES);
  if (direct) return direct;
  const status = asString(value)?.trim().toUpperCase() ?? "";
  if (["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "CAPTURED", "SETTLED"].includes(status)) {
    return "SUCCEEDED";
  }
  if (["FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "DISPUTED", "DECLINED", "REJECTED"].includes(status)) {
    return "FAILED";
  }
  if (["CREATED", "INITIATING", "AUTHORIZING", "PROCESSING", "PENDING"].includes(status)) {
    return "VERIFYING";
  }
  if (status === "AWAITING_CUSTOMER") return "AWAITING_CUSTOMER";
  return "UNKNOWN";
};

export const toCoreGatewayVersionStatusRules = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const rules = asArray(source.statusRules)
    .filter(isRecord)
    .slice(0, 50)
    .map((rule) => {
      const gatewayCode = asString(rule.gatewayCode) ?? asString(rule.selector);
      const result: JsonRecord = {
        phase: clamp(nonEmpty(asString(rule.phase), "INITIATE"), 40),
        selector: clamp(nonEmpty(gatewayCode, "status"), 160),
        op: pickEnum(rule.op, STATUS_RULE_OPS) ?? "equals",
        value: rule.value === undefined ? gatewayCode ?? null : rule.value,
        canonicalStatus: toCanonicalStatus(rule.canonicalStatus),
      };
      const canonicalSubstatus = asString(rule.canonicalSubstatus);
      if (canonicalSubstatus) result.canonicalSubstatus = clamp(canonicalSubstatus, 80);
      const canonicalError = asString(rule.canonicalError) ?? asString(rule.messageEn);
      if (canonicalError) result.canonicalError = clamp(canonicalError, 80);
      return result;
    });
  return { rules };
};

const ERROR_CLASSIFICATIONS = [
  "RETRYABLE_OTP",
  "TERMINAL_DECLINE",
  "LIMIT_EXCEEDED",
  "GATEWAY_FAULT",
  "AMBIGUOUS",
] as const;

export const toCoreGatewayVersionErrorMaps = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const maps = asArray(source.errorMaps)
    .filter(isRecord)
    .slice(0, 100)
    .map((entry) => {
      const gatewayCode = clamp(
        nonEmpty(asString(entry.gatewayCode) ?? asString(entry.code), "UNKNOWN"),
        80,
      );
      const otpRetryable = asBoolean(entry.otpRetryable);
      const result: JsonRecord = {
        gatewayCode,
        canonicalError: clamp(
          nonEmpty(
            asString(entry.canonicalError) ?? asString(entry.canonicalStatus) ?? asString(entry.errorCode),
            gatewayCode,
          ),
          80,
        ),
        classification:
          pickEnum(entry.classification, ERROR_CLASSIFICATIONS) ??
          (otpRetryable ? "RETRYABLE_OTP" : "AMBIGUOUS"),
      };
      const retryable = asBoolean(entry.retryable);
      if (retryable !== undefined) result.retryable = retryable;
      const countsTowardLockout = asBoolean(entry.countsTowardLockout);
      if (countsTowardLockout !== undefined) result.countsTowardLockout = countsTowardLockout;
      const countsTowardBreaker = asBoolean(entry.countsTowardBreaker);
      if (countsTowardBreaker !== undefined) result.countsTowardBreaker = countsTowardBreaker;
      const customerMessageAr = asString(entry.customerMessageAr) ?? asString(entry.messageAr);
      if (customerMessageAr) result.customerMessageAr = clamp(customerMessageAr, 500);
      const customerMessageEn = asString(entry.customerMessageEn) ?? asString(entry.messageEn);
      if (customerMessageEn) result.customerMessageEn = clamp(customerMessageEn, 500);
      const operatorHint = asString(entry.operatorHint);
      if (operatorHint) result.operatorHint = clamp(operatorHint, 500);
      return result;
    });
  return { maps };
};

export const toCoreGatewayVersionDryRun = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const payload = asRecord(source.payload);
  const result: JsonRecord = {};
  const railCode = asString(payload.railCode) ?? asString(source.railCode);
  if (railCode) result.railCode = clamp(railCode, 64);
  const amount = asString(payload.amount);
  if (amount && DECIMAL_PATTERN.test(amount)) result.amount = amount;
  const currency = asString(payload.currency);
  if (currency && currency.length === 3) result.currency = currency;
  return result;
};

export const toCoreGatewayVersionRunSuite = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const scenarios = asStringArray(source.scenarios)
    .filter((scenario) => scenario.length <= 64)
    .slice(0, 30);
  const suite = asString(source.suite);
  if (suite && suite.length <= 64) scenarios.unshift(suite);
  return scenarios.length > 0 ? { scenarios } : {};
};

/* --------------------------------------------------------------------------- users */

const USER_ROLES = [
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN",
  "FINANCE",
  "OPERATOR",
  "COMPLIANCE",
  "MLRO",
  "SUPPORT",
] as const;

const USER_STATUSES = ["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"] as const;

const mapUserStatus = (value: unknown): (typeof USER_STATUSES)[number] | undefined => {
  const status = asString(value)?.trim().toUpperCase();
  if (!status) return undefined;
  if (status === "LOCKED") return "SUSPENDED";
  return pickEnum(status, USER_STATUSES);
};

const flattenAuthorities = (value: unknown): string[] => {
  const result: string[] = [];
  const push = (entry: string) => {
    const candidate = entry.trim();
    if (candidate.length < 2 || candidate.length > 64) return;
    if (!result.includes(candidate)) result.push(candidate);
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") push(entry);
    }
    return result;
  }
  if (!isRecord(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === true) {
      push(key);
      continue;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item !== "string") continue;
        push(key.includes(":") ? key : `${key}:${item}`);
      }
      continue;
    }
    if (typeof entry === "string") {
      push(key.includes(":") ? key : `${key}:${entry}`);
    }
  }
  return result;
};

export const toCoreUserCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    email: (asString(source.email) ?? "").trim().toLowerCase(),
    role: pickEnum(source.role, USER_ROLES) ?? asString(source.role) ?? "",
  };
  const phone = asString(source.phone);
  if (phone) result.phone = phone;
  const password = asString(source.temporaryPassword) ?? asString(source.password);
  if (password) result.password = password;
  const authorities = flattenAuthorities(source.authorities).slice(0, 60);
  if (authorities.length > 0) result.authoritiesMap = authorities;
  return result;
};

export const toCoreUserUpdate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {};
  const role = asString(source.role);
  if (role) result.role = role;
  const status = mapUserStatus(source.status);
  if (status) result.status = status;
  const authorities = flattenAuthorities(source.authorities).slice(0, 60);
  if (authorities.length > 0) result.authoritiesMap = authorities;
  return result;
};

export const toCoreUserUpdates = (body: unknown): JsonRecord[] => {
  const source = asRecord(body);
  const userIds = asStringArray(source.userIds);
  return userIds.map((userId) => {
    const update = toCoreUserUpdate(source);
    return { id: userId, ...update };
  });
};

/* ------------------------------------------------------------------ join requests/kyb */

export const toCoreJoinRequestAssign = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  return { reviewerId: asString(source.assigneeUserId) ?? "" };
};

export const toCoreJoinRequestRequestInfo = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const message = clamp(asString(source.message) ?? "", 500);
  const items = asStringArray(source.requestedItems)
    .slice(0, 50)
    .map((item) => ({ field: clamp(item, 80), message }));
  return { items };
};

export const toCoreJoinRequestDecide = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const decision = asString(source.decision)?.trim().toUpperCase();
  let coreDecision: "APPROVED" | "REJECTED";
  if (decision === "APPROVE" || decision === "APPROVED") {
    coreDecision = "APPROVED";
  } else if (decision === "REJECT" || decision === "REJECTED") {
    coreDecision = "REJECTED";
  } else {
    throw new ApiError(
      400,
      "UNSUPPORTED_DECISION",
      "Core only supports the APPROVED and REJECTED join request decisions; use the request-info route to ask for more documents",
      { decision: decision ?? null },
    );
  }
  const result: JsonRecord = { decision: coreDecision };
  const reason = asString(source.reason) ?? asString(source.reasonCode);
  if (reason) result.reasonCode = clamp(reason, 64);
  const notes = asString(source.notes) ?? reason;
  if (notes) result.notes = clamp(notes, 4000);
  return result;
};

export const toCoreKybDocumentReview = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const decision = asString(source.decision)?.trim().toUpperCase();
  let coreDecision: "ACCEPTED" | "REJECTED";
  if (decision === "ACCEPT" || decision === "ACCEPTED") {
    coreDecision = "ACCEPTED";
  } else if (decision === "REJECT" || decision === "REJECTED") {
    coreDecision = "REJECTED";
  } else {
    throw new ApiError(
      400,
      "UNSUPPORTED_DECISION",
      "Core only supports the ACCEPTED and REJECTED kyb document review decisions",
      { decision: decision ?? null },
    );
  }
  const result: JsonRecord = { decision: coreDecision };
  const reasonCode = asString(source.reasonCode) ?? asString(source.notes);
  if (reasonCode) result.reasonCode = clamp(reasonCode, 64);
  const expiresOn = asString(source.expiresOn);
  if (expiresOn && DATE_PATTERN.test(expiresOn)) result.expiresOn = expiresOn;
  return result;
};

/* ------------------------------------------------------------------------ merchants */

export const toCoreMerchantSuspend = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const reason = asString(source.reason) ?? "";
  return {
    reasonCode: clamp(reason, 64),
    notes: clamp(reason, 2000),
  };
};

export const toCoreMerchantReinstate = (_body: unknown): JsonRecord => ({});

export const toCoreMerchantProposeEdit = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const patch = asArray(source.patch)
    .filter(isRecord)
    .slice(0, 200)
    .map((entry) => ({ ...entry }));
  return { patch };
};

/* ------------------------------------------------------------------------ approvals */

const DISPUTE_OUTCOMES = ["WON", "LOST"] as const;

export const toCoreApprovalApprove = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {};
  const notes = asString(source.comment) ?? asString(source.reason);
  if (notes) result.notes = clamp(notes, 2000);
  // The outcome of a chargeback is what the adjustment execution consumes:
  // without it core holds the money forever.
  const outcome = pickEnum(source.outcome, DISPUTE_OUTCOMES);
  if (outcome) result.outcome = outcome;
  const riskAcceptanceNote = asString(source.riskAcceptanceNote);
  if (riskAcceptanceNote) result.riskAcceptanceNote = clamp(riskAcceptanceNote, 2000);
  return result;
};

export const toCoreApprovalReject = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  return { reason: clamp(asString(source.reason) ?? "", 2000) };
};

/* ------------------------------------------------------------------------------ aml */

const AML_DISPOSITIONS = ["FALSE_POSITIVE", "TRUE_MATCH", "ESCALATED"] as const;

export const toCoreAmlMatchDisposition = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const disposition = asString(source.disposition)?.trim().toUpperCase();
  let coreDisposition: (typeof AML_DISPOSITIONS)[number];
  if (disposition === "FALSE_POSITIVE") {
    coreDisposition = "FALSE_POSITIVE";
  } else if (disposition === "CONFIRMED_MATCH" || disposition === "TRUE_MATCH") {
    coreDisposition = "TRUE_MATCH";
  } else {
    // PENDING is not a terminal disposition: core keeps it open by escalating it.
    coreDisposition = "ESCALATED";
  }
  const result: JsonRecord = { disposition: coreDisposition };
  const notes = asString(source.notes);
  if (notes) result.notes = clamp(notes, 2000);
  const suppressFuture = asBoolean(source.suppressFuture);
  if (suppressFuture !== undefined) result.suppressFuture = suppressFuture;
  const suppressUntil = asString(source.suppressUntil);
  if (suppressUntil && DATE_PATTERN.test(suppressUntil)) result.suppressUntil = suppressUntil;
  return result;
};

export const toCoreAmlCasePropose = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const action = asString(source.action)?.trim().toUpperCase();
  let coreAction: "HOLD" | "RELEASE" | "REJECT" | "ESCALATE";
  if (action === "AML_HOLD" || action === "BLOCK" || action === "HOLD") {
    coreAction = "HOLD";
  } else if (action === "RELEASE") {
    coreAction = "RELEASE";
  } else if (action === "REJECT") {
    coreAction = "REJECT";
  } else {
    // CASE_ONLY and REPORT both end up as an escalation for the checker.
    coreAction = "ESCALATE";
  }
  const notes = asString(source.notes) ?? asString(source.reason);
  return notes ? { action: coreAction, notes: clamp(notes, 2000) } : { action: coreAction };
};

const AML_RULE_TYPES = [
  "SINGLE_AMOUNT",
  "CUMULATIVE_WINDOW",
  "STRUCTURING",
  "RISK_TIER",
  "COUNTERPARTY_COUNTRY",
  "RAIL",
  "MERCHANT_DIRECT_AMOUNT",
] as const;

const AML_RULE_ACTIONS = ["HOLD", "FLAG", "BLOCK", "CASE_ONLY"] as const;
const AML_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const toCoreAmlRule = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    code: asString(source.code) ?? "",
    name: asString(source.name) ?? "",
    ruleType: pickEnum(source.ruleType, AML_RULE_TYPES) ?? "SINGLE_AMOUNT",
    action: pickEnum(source.action, AML_RULE_ACTIONS) ?? "FLAG",
    baseSeverity: pickEnum(source.baseSeverity, AML_SEVERITIES) ?? "MEDIUM",
    params: asRecord(source.params),
  };
  const effectiveFrom = asString(source.effectiveFrom);
  if (effectiveFrom) result.effectiveFrom = clamp(effectiveFrom, 64);
  return result;
};

const REPORT_TYPES = ["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"] as const;

const inferReportType = (explicit: unknown, hints: unknown[]): string => {
  const direct = pickEnum(explicit, REPORT_TYPES);
  if (direct) return direct;
  for (const hint of hints) {
    const value = asString(hint)?.trim().toUpperCase() ?? "";
    if (value.length === 0) continue;
    if (value.includes("LARGE") || value.includes("THRESHOLD")) return "LARGE_TRANSACTION";
    if (value.includes("SUSPICIOUS") || value.includes("SAR")) return "SUSPICIOUS_ACTIVITY";
    if (value.includes("PERIODIC") || value.includes("RETURN")) return "PERIODIC_RETURN";
  }
  return "LARGE_TRANSACTION";
};

export const toCoreAmlReportingRule = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    reportType: inferReportType(source.reportType, [source.code, source.name]),
    sourceReference: asString(source.code) ?? asString(source.name) ?? "",
    status: pickEnum(source.mode, ["PROVISIONAL", "CONFIRMED"]) ?? "PROVISIONAL",
  };
  const threshold = asString(source.threshold);
  if (threshold && DECIMAL_PATTERN.test(threshold)) result.thresholdAmount = threshold;
  const currency = asString(source.currency);
  if (currency && currency.length === 3) result.currency = currency.toUpperCase();
  const windowDays = asNumber(source.windowDays);
  if (windowDays !== undefined) {
    result.windowSeconds = Math.min(Math.max(Math.round(windowDays * 86400), 1), 31536000);
  }
  return result;
};

export const toCoreAmlReport = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const caseId = asString(source.caseId);
  const reportingRuleId = asString(source.reportingRuleId) ?? "";
  const payload: JsonRecord = {
    reportingRuleId,
    periodStart: asString(source.periodStart) ?? "",
    periodEnd: asString(source.periodEnd) ?? "",
  };
  const notes = asString(source.notes);
  if (notes) payload.notes = notes;
  const result: JsonRecord = {
    reportType: inferReportType(source.reportType, [reportingRuleId, caseId]),
    subjectType: caseId ? "AML_CASE" : "REPORTING_RULE",
    subjectId: caseId ?? reportingRuleId,
    payload,
  };
  if (caseId) result.amlCaseId = caseId;
  const authority = asString(source.authority);
  if (authority) result.authority = clamp(authority, 64);
  return result;
};

/* -------------------------------------------------------------------------------- rails */

const RAIL_COLLECTION_MODES: Record<string, string> = {
  OTP_PULL: "OTP_PULL",
  REDIRECT: "REDIRECT",
  EMBEDDED: "EMBEDDED",
  PUSH_APPROVAL: "PUSH_APPROVAL",
  QR_DISPLAY: "QR_DISPLAY",
  QR: "QR_DISPLAY",
  PUSH: "PUSH_APPROVAL",
  PAY_CODE: "PAY_CODE",
  DEEP_LINK: "DEEP_LINK",
  MANUAL: "MANUAL",
  TRANSFER: "MANUAL",
  CASH: "PAY_CODE",
  HYBRID: "HYBRID",
};

const toCoreCollectionMode = (value: unknown): string | undefined => {
  const mode = asString(value)?.trim().toUpperCase() ?? "";
  return RAIL_COLLECTION_MODES[mode];
};

const toCapabilitiesRecord = (value: unknown): JsonRecord => {
  if (isRecord(value)) return value;
  const record: JsonRecord = {};
  for (const key of asStringArray(value)) record[clamp(key, 40)] = true;
  return record;
};

export const toCoreRailCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const name = clamp(nonEmpty(asString(source.name), "rail"), 160);
  const nameAr = clamp(nonEmpty(asString(source.nameAr), name), 160);
  const nameEn = clamp(nonEmpty(asString(source.nameEn), name), 160);
  const result: JsonRecord = {
    code: (asString(source.code) ?? "").trim().toLowerCase(),
    nameAr,
    nameEn,
    collectionMode: toCoreCollectionMode(source.collectionMode) ?? missingCanonical("collectionMode"),
  };
  const subModes = asStringArray(source.subModes).slice(0, 20);
  if (subModes.length > 0) result.subModes = subModes;
  const currency = asString(source.currency);
  if (currency && currency.length === 3) result.currency = currency.toUpperCase();
  for (const key of ["minAmount", "maxAmount"] as const) {
    const value = asString(source[key]);
    if (value && DECIMAL_PATTERN.test(value)) result[key] = value;
  }
  const capabilities = toCapabilitiesRecord(source.capabilities);
  if (Object.keys(capabilities).length > 0) result.capabilities = capabilities;
  return result;
};

export const toCoreRailUpdate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {};
  const name = asString(source.name)?.trim();
  const nameAr = asString(source.nameAr)?.trim();
  const nameEn = asString(source.nameEn)?.trim();
  if (nameAr) result.nameAr = clamp(nameAr, 160);
  if (nameEn) result.nameEn = clamp(nameEn, 160);
  if (name && !nameAr && !nameEn) {
    result.nameAr = clamp(name, 160);
    result.nameEn = clamp(name, 160);
  }
  const active = asBoolean(source.active);
  if (active !== undefined) result.blocked = !active;
  for (const key of ["minAmount", "maxAmount", "instructionsAr", "instructionsEn"] as const) {
    const value = asString(source[key]);
    if (value !== undefined) result[key] = clamp(value, key.startsWith("instructions") ? 2000 : 40);
  }
  const displayOrder = clampNumber(source.displayOrder, 0, 9999);
  if (displayOrder !== undefined) result.displayOrder = displayOrder;
  const capabilities = toCapabilitiesRecord(source.capabilities);
  if (Object.keys(capabilities).length > 0) result.capabilities = capabilities;
  return result;
};

const RAIL_FIELD_TYPES: Record<string, string> = {
  TEXT: "string",
  STRING: "string",
  NUMBER: "number",
  NUMERIC: "number",
  PHONE: "phone",
  OTP: "otp",
  NATIONAL_ID: "string",
  PASSPORT: "string",
  DATE: "string",
  HIDDEN: "string",
  WALLET_ID: "wallet_id",
  SELECT: "from_list",
  FROM_LIST: "from_list",
};

const NORMALIZERS: Record<string, string> = {
  ARABIC_DIGITS_TO_ASCII: "arabic_digits_to_ascii",
  PHONE_NORMALIZE_LOCAL_09: "phone_normalize_local_09",
  PHONE_NORMALIZE_INTL_218: "phone_normalize_intl_218",
  PHONE_NORMALIZE_E164: "phone_normalize_e164",
};

const toCoreFieldKey = (value: unknown): string => {
  const candidate = (asString(value) ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clamp(candidate, 64) || "field";
};

export const toCoreRailFields = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const fields = asArray(source.fields)
    .filter(isRecord)
    .slice(0, 40)
    .map((field, index) => {
      const key = toCoreFieldKey(field.code ?? field.key ?? field.fieldKey);
      const labelEn = clamp(nonEmpty(asString(field.labelEn) ?? asString(field.label), key), 200);
      const labelAr = clamp(nonEmpty(asString(field.labelAr) ?? asString(field.label), labelEn), 200);
      const typeValue = asString(field.type) ?? asString(field.inputType);
      const result: JsonRecord = {
        key,
        type: RAIL_FIELD_TYPES[(typeValue ?? "").trim().toUpperCase()] ?? "string",
        labelAr,
        labelEn,
        orderIndex: clampNumber(field.orderIndex ?? field.order, 0, 999) ?? index,
      };
      const required = asBoolean(field.required);
      if (required !== undefined) result.required = required;
      const sensitivity = asString(field.sensitivity)?.trim().toUpperCase();
      if (sensitivity === "SENSITIVE" || sensitivity === "PAN") {
        result.sensitivity = sensitivity;
      } else if (asBoolean(field.sensitive)) {
        result.sensitivity = "SENSITIVE";
      }
      const pattern = asString(field.pattern) ?? asString(field.regex);
      if (pattern) result.regex = clamp(pattern, 200);
      const minLength = clampNumber(field.minLength, 0, 64);
      if (minLength !== undefined) result.minLength = minLength;
      const maxLength = clampNumber(field.maxLength, 0, 64);
      if (maxLength !== undefined) result.maxLength = maxLength;
      const normalizer = asString(field.normalizer)?.trim().toUpperCase() ?? "";
      if (NORMALIZERS[normalizer]) result.normalizer = { type: NORMALIZERS[normalizer] };
      const options = asStringArray(field.options).slice(0, 100);
      if (options.length > 0) result.optionsJson = { options };
      return result;
    });
  return { fields };
};

/* ------------------------------------------------------------------------------- routes */

const CREDENTIAL_POLICIES = ["PLATFORM", "MERCHANT_REQUIRED", "MERCHANT_OR_PLATFORM"] as const;

export const toCoreRouteCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    railId: requireCanonical(asString(source.railId), "railId"),
    gatewayId: requireCanonical(asString(source.gatewayId), "gatewayId"),
    credentialPolicy:
      pickEnum(source.credentialPolicy, CREDENTIAL_POLICIES) ?? missingCanonical("credentialPolicy"),
  };
  const priority = clampNumber(source.priority, 0, 9999);
  if (priority !== undefined) result.priority = priority;
  const costModel = asRecord(source.costModel);
  if (Object.keys(costModel).length > 0) result.costModel = costModel;
  const limitAmount = asString(source.limitAmount);
  if (limitAmount && DECIMAL_PATTERN.test(limitAmount)) result.maxAmount = limitAmount;
  return result;
};

export const toCoreRouteUpdate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {};
  const priority = clampNumber(source.priority, 0, 9999);
  if (priority !== undefined) result.priority = priority;
  const weight = clampNumber(source.weight, 1, 1000);
  if (weight !== undefined) result.weight = weight;
  const costModel = asRecord(source.costModel);
  if (Object.keys(costModel).length > 0) result.costModel = costModel;
  const scope = asRecord(source.scope);
  if (Object.keys(scope).length > 0) result.scope = scope;
  for (const key of ["minAmount", "maxAmount", "dailyCapAmount"] as const) {
    const value = asString(source[key]);
    if (value && DECIMAL_PATTERN.test(value)) result[key] = value;
  }
  const limitAmount = asString(source.limitAmount);
  if (limitAmount && DECIMAL_PATTERN.test(limitAmount)) result.maxAmount = limitAmount;
  return result;
};

export const toCoreRouteState = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    status: pickEnum(source.status ?? source.state, ["ACTIVE", "PAUSED", "DRAINING"]) ?? missingCanonical("status"),
  };
  const reason = asString(source.reason);
  if (reason) result.reason = clamp(reason, 500);
  return result;
};

/* ------------------------------------------------------------------------------- assets */

const ASSET_MIMES = ["image/png", "image/svg+xml"] as const;

const toCoreAssetMime = (value: unknown): string | undefined => {
  const mime = asString(value)?.split(";")[0]?.trim().toLowerCase() ?? "";
  return ASSET_MIMES.find((entry) => entry === mime);
};

export const toCoreAssetCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const mime = toCoreAssetMime(source.contentType) ?? missingCanonical("mime");
  const sizeBytes = clampNumber(source.sizeBytes, 1, 2_000_000) ?? missingCanonical("sizeBytes");
  const sha256 = (asString(source.checksumSha256) ?? asString(source.sha256))?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(sha256)) missingCanonical("sha256");
  return {
    name: clamp(nonEmpty(asString(source.name), "asset"), 120),
    mime,
    sizeBytes,
    storageKey: clamp(nonEmpty(asString(source.storageKey), "asset"), 300),
    sha256,
  };
};

/* ----------------------------------------------------------------------- operator cases */

export const toCoreOperatorCaseResolve = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const notes = asString(source.notes) ?? asString(source.operatorNote) ?? asString(source.reason);
  const resolution = clamp((notes ?? "").trim(), 4000);
  if (resolution.length < 2) missingCanonical("resolution");
  const action = asString(source.resolution)?.trim().toUpperCase() ?? "";
  return {
    resolution,
    state: action === "ESCALATE" ? "IN_PROGRESS" : "RESOLVED",
  };
};

/* -------------------------------------------------------------------------- reconciliation */

const STATEMENT_SOURCE_TYPES = ["API", "SFTP", "UPLOAD"] as const;

const toCoreParserConfig = (source: JsonRecord): JsonRecord => {
  const config: JsonRecord = {};
  const fileType = asString(source.fileType);
  if (fileType) config.fileType = fileType;
  const delimiter = asString(source.delimiter);
  if (delimiter) config.delimiter = delimiter;
  const hasHeader = asBoolean(source.hasHeader);
  if (hasHeader !== undefined) config.hasHeader = hasHeader;
  const columnMapping = asRecord(source.columnMapping);
  if (Object.keys(columnMapping).length > 0) config.columnMapping = columnMapping;
  const dateFormat = asString(source.dateFormat);
  if (dateFormat) config.dateFormat = dateFormat;
  return config;
};

export const toCoreReconciliationSourceCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    gatewayId: requireCanonical(asString(source.gatewayId), "gatewayId"),
    type: pickEnum(source.type, STATEMENT_SOURCE_TYPES) ?? missingCanonical("type"),
    parserConfig: toCoreParserConfig(source),
  };
  const scheduleCron = asString(source.scheduleCron);
  if (scheduleCron) result.scheduleCron = clamp(scheduleCron, 120);
  const settlementLagDays = clampNumber(source.settlementLagDays, 0, 365);
  if (settlementLagDays !== undefined) result.settlementLagDays = settlementLagDays;
  const dedupeKeyTemplate = asString(source.dedupeKeyTemplate);
  if (dedupeKeyTemplate) result.dedupeKeyTemplate = clamp(dedupeKeyTemplate, 200);
  return result;
};

export const toCoreReconciliationUpload = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    sourceId: requireCanonical(asString(source.sourceId), "sourceId"),
  };
  const periodStart = asString(source.periodStart);
  if (periodStart) result.periodStart = clamp(periodStart, 64);
  const periodEnd = asString(source.periodEnd);
  if (periodEnd) result.periodEnd = clamp(periodEnd, 64);
  const currency = asString(source.currency);
  if (currency) result.currency = currency.toUpperCase();
  const autoPost = asBoolean(source.autoPost);
  if (autoPost !== undefined) result.autoPost = autoPost;
  return result;
};

/* ------------------------------------------------------------ disputes and adjustments */

const DISPUTE_SOURCES = ["WEBHOOK", "STATEMENT", "MANUAL"] as const;

export const toCoreDisputeCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const amount = asString(source.amount);
  const currency = asString(source.currency);
  const result: JsonRecord = {
    attemptId: requireCanonical(asString(source.paymentReference), "attemptId"),
    gatewayId: requireCanonical(asString(source.gatewayId), "gatewayId"),
    railId: requireCanonical(asString(source.railId), "railId"),
    externalDisputeRef: requireCanonical(
      asString(source.externalDisputeRef),
      "externalDisputeRef",
      2,
    ),
    source: pickEnum(source.source, DISPUTE_SOURCES) ?? missingCanonical("source"),
    amount: amount && DECIMAL_PATTERN.test(amount) ? amount : missingCanonical("amount"),
    currency:
      currency && currency.length === 3 ? currency.toUpperCase() : missingCanonical("currency"),
  };
  const reasonCode = asString(source.reason);
  if (reasonCode) result.reasonCode = clamp(reasonCode, 80);
  return result;
};

const ADJUSTMENT_TYPES: Record<string, string> = {
  CHARGEBACK: "CHARGEBACK",
  REFUND: "REFUND",
  MANUAL_CREDIT: "MANUAL_CREDIT",
  MANUAL_DEBIT: "MANUAL_DEBIT",
  CORRECTION: "CORRECTION",
  FEE_VARIANCE: "CORRECTION",
  RECOVERY: "MANUAL_CREDIT",
  WRITEOFF: "MANUAL_DEBIT",
};

export const toCoreAdjustmentCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const amount = asString(source.amount);
  const reason = (asString(source.reason) ?? asString(source.reasonCode))?.trim() ?? "";
  const result: JsonRecord = {
    type:
      ADJUSTMENT_TYPES[asString(source.type)?.trim().toUpperCase() ?? ""] ??
      missingCanonical("type"),
    targetGlAccountId: requireCanonical(asString(source.targetGlAccountId), "targetGlAccountId"),
    amount: amount && DECIMAL_PATTERN.test(amount) ? amount : missingCanonical("amount"),
    reason: reason.length >= 2 ? clamp(reason, 1000) : missingCanonical("reason"),
  };
  const disputeId = asString(source.disputeId);
  if (disputeId) result.disputeId = clamp(disputeId, 64);
  const attemptId = asString(source.attemptId);
  if (attemptId) result.sourceAttemptId = clamp(attemptId, 64);
  const externalDisputeRef = asString(source.externalDisputeRef);
  if (externalDisputeRef) result.externalDisputeRef = clamp(externalDisputeRef, 120);
  const reverseCommission = asBoolean(source.reverseCommission);
  if (reverseCommission !== undefined) result.reverseCommission = reverseCommission;
  return result;
};

export const toCoreCashoutProcess = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const decision = asString(source.decision)?.trim().toUpperCase();
  if (decision !== "APPROVE" && decision !== "REJECT") {
    throw new ApiError(
      400,
      "UNSUPPORTED_DECISION",
      "Core only supports the APPROVE and REJECT cash-out decisions",
      { decision: decision ?? null },
    );
  }
  const result: JsonRecord = { decision };
  const reason = asString(source.reason);
  if (reason) result.reason = clamp(reason, 1000);
  return result;
};

/* ------------------------------------------------------- commission and velocity rules */

const COMMISSION_CALC_TYPES: Record<string, string> = {
  FLAT: "FLAT",
  PERCENTAGE: "PERCENTAGE",
  TIERED: "TIERED",
  MIXED: "HYBRID",
};

export const toCoreCommissionProfileCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const result: JsonRecord = {
    railCode: requireCanonical(asString(source.railCode), "railCode"),
    calcType:
      COMMISSION_CALC_TYPES[asString(source.model)?.trim().toUpperCase() ?? ""] ??
      missingCanonical("calcType"),
  };
  const flatFee = asString(source.flatAmount);
  if (flatFee && DECIMAL_PATTERN.test(flatFee)) result.flatFee = flatFee;
  const percentageRate = asString(source.percentage);
  if (percentageRate && /^\d{1,6}(\.\d{1,6})?$/.test(percentageRate)) {
    result.percentageRate = percentageRate;
  }
  const tiers = asArray(source.tiers).filter(isRecord).slice(0, 20);
  if (tiers.length > 0) {
    result.tiersJson = tiers.reduce<JsonRecord>((accumulator, tier, index) => {
      accumulator[String(index)] = tier;
      return accumulator;
    }, {});
  }
  return result;
};

const VELOCITY_SCOPE_TYPES = [
  "END_CLIENT_IP",
  "END_CLIENT_PHONE",
  "END_CLIENT_CARD",
  "MERCHANT",
  "APPLICATION",
  "RAIL",
  "LINK",
] as const;

const VELOCITY_SCOPES: Record<string, string> = {
  MERCHANT: "MERCHANT",
  APPLICATION: "APPLICATION",
  LINK: "LINK",
  IP: "END_CLIENT_IP",
};

const VELOCITY_ACTIONS: Record<string, string> = {
  BLOCK: "REJECT",
  REVIEW: "FLAG",
  THROTTLE: "FLAG",
  CHALLENGE: "FLAG",
};

export const toCoreVelocityRuleCreate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const scope = asString(source.scope)?.trim().toUpperCase() ?? "";
  const scopeType =
    pickEnum(source.scopeType, VELOCITY_SCOPE_TYPES) ??
    VELOCITY_SCOPES[scope] ??
    missingCanonical("scopeType");
  const windowSeconds =
    clampNumber(source.windowSeconds, 1, 31_536_000) ?? missingCanonical("windowSeconds");
  const maxCount = clampNumber(source.maxAttempts, 1, 1_000_000) ?? missingCanonical("maxCount");
  const action =
    VELOCITY_ACTIONS[asString(source.action)?.trim().toUpperCase() ?? ""] ??
    missingCanonical("action");
  const result: JsonRecord = { scopeType, windowSeconds, maxCount, action };
  const maxAmount = asString(source.maxAmount);
  if (maxAmount && DECIMAL_PATTERN.test(maxAmount)) result.maxAmount = maxAmount;
  return result;
};

/* ------------------------------------------------------------------------------ settings */

const toCoreSettingValue = (value: unknown): JsonRecord => {
  if (!isRecord(value)) return { value };
  const keys = Object.keys(value);
  if (keys.some((key) => key.length > 64)) return { value };
  return { ...value };
};

export const toCoreSettingsUpdate = (body: unknown): JsonRecord => {
  const source = asRecord(body);
  const settings = asRecord(source.settings);
  const entries: JsonRecord[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const trimmed = key.trim();
    if (trimmed.length === 0) continue;
    entries.push({ key: clamp(trimmed, 120), valueJson: toCoreSettingValue(value) });
    if (entries.length >= 50) break;
  }
  if (entries.length === 0) missingCanonical("settings");
  return { settings: entries };
};
