import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { VisibleRailsResolver, evaluateRouteDailyCap, type RailRecord, type RailRouteRecord, type CredentialSetRecord, type CommissionProfileRecord } from "../../engine/flow/VisibleRailsResolver";
import { loadRailCatalog, asStringArray } from "../../engine/flow/VisibleRailsCatalog";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { getPlatformRuntime } from "../../engine/runtime";
import type { DynamicAttempt } from "../../engine/flow/DynamicRailEngine";
import { fingerprint, principalOf } from "../middleware/authDoubleCheck";
import { json } from "./json";

const PLATFORM_TTL_CEILINGS: Record<string, number> = {
  OTP_PULL: 1200,
  REDIRECT: 1800,
  QR_DISPLAY: 900,
  PUSH_APPROVAL: 900,
  PAY_CODE: 900,
  DEEP_LINK: 900,
  EMBEDDED: 1800,
  HYBRID: 1200,
  MANUAL: 86400,
};

const route = express.Router();

route.get("/health", (_request, response) => {
  response.json({ status: "ok", channel: "checkout" });
});

const linkParamsSchema = z.object({ linkKey: z.string().min(6).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const attemptParamsSchema = z.object({
  linkKey: z.string().min(6).max(64).regex(/^[A-Za-z0-9_-]+$/),
  attemptId: z.string().min(4).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

const initiateSchema = z
  .object({
    railCode: z.string().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/),
    subMode: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
    formData: z.record(z.string().max(64), z.unknown()).default({}),
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();

const confirmSchema = z
  .object({
    otp: z.string().regex(/^\d{4,8}$/).optional(),
    evidence: z.record(z.string().max(64), z.unknown()).optional(),
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();

const resendSchema = z
  .object({ idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional() })
  .strict();

const cancelSchema = z
  .object({
    reason: z.string().max(256).optional(),
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  })
  .strict();

const clientEventSchema = z
  .object({
    event: z.enum(["completeCallback", "errorCallback", "widgetEvent", "returnHint"]),
    payload: z.record(z.string().max(64), z.unknown()).optional(),
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  })
  .strict();

interface LoadedLink {
  id: string;
  key: string;
  applicationId: string;
  walletId: string;
  merchantId: string;
  amount: Prisma.Decimal;
  currency: string;
  feeBearer: "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";
  splitRatioJson: unknown;
  infiniteUse: boolean;
  useCount: number;
  confirmedCount: number;
  activeLockedCount: number;
  state: string;
  expiresAt: Date | null;
  railWhitelist: unknown;
  applicationRailWhitelist: unknown;
  merchantTradeName: string;
  merchantLegalName: string;
  merchantStatus: string;
  merchantRiskTier: string;
}

const loadLink = async (linkKey: string): Promise<LoadedLink | null> => {
  const link = await client.paymentLink.findUnique({
    where: { key: linkKey },
    include: { application: { include: { merchant: true } } },
  });
  if (!link) {
    return null;
  }
  return {
    id: link.id,
    key: link.key,
    applicationId: link.applicationId,
    walletId: link.walletId,
    merchantId: link.application.merchantId,
    amount: link.amount,
    currency: link.currency,
    feeBearer: link.feeBearer,
    splitRatioJson: link.splitRatioJson,
    infiniteUse: link.infiniteUse,
    useCount: link.useCount,
    confirmedCount: link.confirmedCount,
    activeLockedCount: link.activeLockedCount,
    state: link.state,
    expiresAt: link.expiresAt,
    railWhitelist: link.railWhitelist,
    applicationRailWhitelist: link.application.railWhitelist,
    merchantTradeName: link.application.merchant.tradeName,
    merchantLegalName: link.application.merchant.legalName,
    merchantStatus: link.application.merchant.status,
    merchantRiskTier: link.application.merchant.riskTier,
  };
};

interface Catalog {
  rails: RailRecord[];
  routes: RailRouteRecord[];
  credentialSets: CredentialSetRecord[];
  commissionProfiles: CommissionProfileRecord[];
}

const loadCatalog = async (): Promise<Catalog> => loadRailCatalog(client as never);

const resolveEnvironment = (merchantStatus: string): "SANDBOX" | "LIVE" =>
  merchantStatus === "ACTIVE" ? "LIVE" : "SANDBOX";

const visibleRailsFor = (link: LoadedLink, catalog: Catalog, env: "SANDBOX" | "LIVE") => {
  const resolver = new VisibleRailsResolver();
  return resolver.resolve({
    application: {
      id: link.applicationId,
      merchantId: link.merchantId,
      riskTier: link.merchantRiskTier,
      railWhitelist: asStringArray(link.applicationRailWhitelist),
    },
    link: {
      amount: link.amount,
      currency: link.currency,
      railWhitelist: asStringArray(link.railWhitelist),
    },
    channel: "WEB",
    env,
    rails: catalog.rails,
    routes: catalog.routes,
    credentialSets: catalog.credentialSets,
    commissionProfiles: catalog.commissionProfiles,
  });
};

interface CommissionBreakdown {
  commission: string;
  payerSurcharge: string;
  totalCharged: string;
  merchantCredited: string;
  feeBearer: "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";
}

const commissionForProfile = (
  profile: {
    calcType: string;
    flatFee: Prisma.Decimal;
    percentageRate: Prisma.Decimal;
    minFee: Prisma.Decimal;
    maxFee: Prisma.Decimal | null;
    tiersJson: unknown;
  },
  amount: Prisma.Decimal,
): Prisma.Decimal => {
  let value = decimal(0);
  if (profile.calcType === "FLAT" || profile.calcType === "HYBRID") {
    value = value.plus(decimal(profile.flatFee));
  }
  if (profile.calcType === "PERCENTAGE" || profile.calcType === "HYBRID") {
    value = value.plus(decimal(amount).mul(decimal(profile.percentageRate)));
  }
  if (profile.calcType === "TIERED") {
    const tiers = Array.isArray(profile.tiersJson) ? (profile.tiersJson as Array<Record<string, unknown>>) : [];
    for (const tier of tiers) {
      const upTo = tier.upTo ?? tier.up_to;
      if (upTo === undefined || decimal(amount).lte(decimal(String(upTo)))) {
        const flat = tier.flat;
        const percent = tier.percent;
        if (flat !== undefined) {
          value = value.plus(decimal(String(flat)));
        }
        if (percent !== undefined) {
          value = value.plus(decimal(amount).mul(decimal(String(percent))));
        }
        break;
      }
    }
  }
  if (value.lt(decimal(profile.minFee))) {
    value = decimal(profile.minFee);
  }
  if (profile.maxFee !== null && value.gt(decimal(profile.maxFee))) {
    value = decimal(profile.maxFee);
  }
  return value;
};

/**
 * The platform share of a split fee bearer. The ratio is a DECIMAL, never a
 * JavaScript float: it is multiplied into money.
 */
const splitRatio = (value: unknown): Decimal => {
  const fallback = decimal("0.5");
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const raw = record.platformShare ?? record.platform_share ?? record.share;
  if (raw === undefined || raw === null) {
    return fallback;
  }
  let parsed: Decimal;
  try {
    parsed = decimal(raw as never);
  } catch {
    return fallback;
  }
  if (!parsed.isFinite() || parsed.lt(0) || parsed.gt(1)) {
    return fallback;
  }
  return parsed;
};

const buildBreakdown = (
  link: LoadedLink,
  profile: {
    calcType: string;
    flatFee: Prisma.Decimal;
    percentageRate: Prisma.Decimal;
    minFee: Prisma.Decimal;
    maxFee: Prisma.Decimal | null;
    tiersJson: unknown;
  },
): CommissionBreakdown => {
  const amount = decimal(link.amount);
  const commission = commissionForProfile(profile, link.amount);
  const feeBearer = link.feeBearer;
  if (feeBearer === "MERCHANT_ABSORBS") {
    return {
      commission: commission.toFixed(4),
      payerSurcharge: "0.0000",
      totalCharged: amount.toFixed(4),
      merchantCredited: amount.minus(commission).toFixed(4),
      feeBearer,
    };
  }
  if (feeBearer === "PAYER_SURCHARGE") {
    return {
      commission: commission.toFixed(4),
      payerSurcharge: commission.toFixed(4),
      totalCharged: amount.plus(commission).toFixed(4),
      merchantCredited: amount.toFixed(4),
      feeBearer,
    };
  }
  const platformShare = splitRatio(link.splitRatioJson);
  const payerShare = commission.mul(platformShare);
  return {
    commission: commission.toFixed(4),
    payerSurcharge: payerShare.toFixed(4),
    totalCharged: amount.plus(payerShare).toFixed(4),
    merchantCredited: amount.minus(commission.minus(payerShare)).toFixed(4),
    feeBearer,
  };
};

const fieldInputType = (type: string): string => {
  switch (type) {
    case "PHONE":
      return "phone";
    case "NUMBER":
    case "CARD_NUMBER":
    case "PAN":
      return "numeric";
    case "OTP":
      return "otp";
    case "WALLET_ID":
      return "wallet_id";
    case "FROM_LIST":
      return "select";
    default:
      return "text";
  }
};

const fieldOptions = (options: unknown): string[] | null => {
  if (!Array.isArray(options)) {
    return null;
  }
  return options.map((option) => String(option));
};

const maskedPhone = (formData: Record<string, unknown>): string => {
  const raw = formData.phone ?? formData.customer_mobile ?? formData.mobile;
  if (typeof raw !== "string" || raw.length === 0) {
    return "";
  }
  const tail = raw.slice(-4);
  return `${"*".repeat(Math.max(0, raw.length - 4))}${tail}`;
};

/**
 * The first value of the form data that is a non empty string.
 *
 * The customer fields are named differently by the rails, so the guard reads
 * the customer context from a fixed list of aliases instead of trusting one
 * particular name.
 */
const formValue = (
  formData: Record<string, unknown>,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const value = formData[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const customerPhoneOf = (formData: Record<string, unknown>): string | null =>
  formValue(formData, ["phone", "customer_mobile", "mobile", "customer_phone"]);

const customerCardAliasOf = (formData: Record<string, unknown>): string | null =>
  formValue(formData, ["card_alias", "cardAlias", "card_bin", "bin"]);

const customerNameOf = (formData: Record<string, unknown>): string | null =>
  formValue(formData, ["name", "customer_name", "full_name"]);

const customerWalletOf = (formData: Record<string, unknown>): string | null =>
  formValue(formData, ["wallet_id", "walletId"]);

/**
 * The fields of a rail, as declared in `rail_fields`.
 *
 * The checkout validates the submitted form against exactly this descriptor,
 * so every rail gets the same server-side validation as the one the customer
 * form advertised. The client is never trusted to have enforced it.
 */
export interface RailFieldRule {
  key: string;
  type: string;
  checksum?: string | null;
  regex?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  optionsJson?: unknown;
  required?: boolean | null;
}

const railFieldError = (
  field: string,
  reason: string,
  message: string,
): ApiError => new ApiError(400, "RAIL_FIELD_INVALID", message, { field, reason });

const asOptionsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The Luhn (mod 10) check digit. Non-digit separators are ignored, so a PAN
 * or a wallet id may be formatted with spaces or hyphens.
 */
export const isValidLuhn = (value: string): boolean => {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 2) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) {
      return false;
    }
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

const walletTypeCodes = (options: Record<string, unknown>): string[] | null => {
  const raw = options.wallet_types ?? options.walletTypes;
  if (!Array.isArray(raw)) {
    return null;
  }
  const codes = raw
    .filter((entry) => typeof entry === "string" || typeof entry === "number")
    .map((entry) => String(entry));
  return codes.length > 0 ? codes : null;
};

/**
 * Validates the customer form data against the `rail_fields` descriptors.
 *
 * The rules are driven by the catalog: required, regex, length, the optional
 * Luhn checksum and the optional wallet-type allow-list in `options_json`.
 * The first violation is reported as a field-level 400 before any money
 * moves and before the gateway is contacted.
 */
export const validateRailFields = (
  fields: readonly RailFieldRule[],
  formData: Record<string, unknown>,
): void => {
  for (const field of fields) {
    const raw = formData[field.key];
    const absent =
      raw === undefined
      || raw === null
      || (typeof raw === "string" && raw.trim().length === 0);
    if (absent) {
      if (field.required === true) {
        throw railFieldError(
          field.key,
          "REQUIRED",
          `The field '${field.key}' is required`,
        );
      }
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw railFieldError(
        field.key,
        "INVALID_TYPE",
        `The field '${field.key}' must be a text value`,
      );
    }
    const value = typeof raw === "string" ? raw : String(raw);
    if (typeof field.minLength === "number" && value.length < field.minLength) {
      throw railFieldError(
        field.key,
        "MIN_LENGTH",
        `The field '${field.key}' must be at least ${field.minLength} characters long`,
      );
    }
    if (typeof field.maxLength === "number" && value.length > field.maxLength) {
      throw railFieldError(
        field.key,
        "MAX_LENGTH",
        `The field '${field.key}' must be at most ${field.maxLength} characters long`,
      );
    }
    if (typeof field.regex === "string" && field.regex.length > 0) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(field.regex);
      } catch {
        throw new ApiError(
          500,
          "RAIL_FIELD_CONFIGURATION_INVALID",
          `The validation rule of the field '${field.key}' is invalid`,
        );
      }
      if (!pattern.test(value)) {
        throw railFieldError(
          field.key,
          "REGEX",
          `The field '${field.key}' does not match the required format`,
        );
      }
    }
    if (String(field.checksum ?? "NONE").toUpperCase() === "LUHN" && !isValidLuhn(value)) {
      throw railFieldError(
        field.key,
        "CHECKSUM",
        `The field '${field.key}' fails the check digit validation`,
      );
    }
    const options = asOptionsRecord(field.optionsJson);
    const allowedTypes = walletTypeCodes(options);
    if (allowedTypes) {
      const offset = typeof options.wallet_type_offset === "number"
        ? Math.max(0, Math.trunc(options.wallet_type_offset))
        : 0;
      const length = typeof options.wallet_type_length === "number"
        ? Math.max(1, Math.trunc(options.wallet_type_length))
        : 2;
      const digits = value.replace(/\D/g, "");
      const typeCode = digits.slice(offset, offset + length);
      if (!allowedTypes.includes(typeCode)) {
        throw railFieldError(
          field.key,
          "WALLET_TYPE_NOT_ALLOWED",
          `The wallet type of the field '${field.key}' is not allowed`,
        );
      }
    }
  }
};

const buildClientAction = (
  mode: string,
  payload: {
    expiresAt: Date;
    attemptReference: string;
    maskedPhone: string;
    railCode: string;
    widget: { scriptUrls: unknown; scriptSriHashes: unknown; configTemplate: unknown; allowedOrigins: unknown; iframeSandboxAttrs: unknown; sdkDriver: string | null } | null;
    redirect: { method: string; urlSourceOutput: string; formFieldsOutput: string | null; target: string; returnParamsMap: unknown } | null;
    instructionsAr: string | null;
    instructionsEn: string | null;
    fee: CommissionBreakdown;
  },
) => {
  switch (mode) {
    case "OTP_PULL":
      return {
        kind: "SHOW_OTP_FORM" as const,
        otp_length: 4,
        max_attempts: 3,
        resend_cooldown_seconds: 60,
        expires_at: payload.expiresAt.toISOString(),
        masked_phone: payload.maskedPhone,
      };
    case "REDIRECT":
      return {
        kind: "HTTP_REDIRECT" as const,
        method: payload.redirect?.method === "POST_FORM" ? "POST_FORM" : "GET",
        url: payload.redirect?.urlSourceOutput ?? "",
        form_fields: payload.redirect?.formFieldsOutput ? {} : {},
        target: payload.redirect?.target ?? "SAME_WINDOW",
        return_token: payload.attemptReference,
      };
    case "EMBEDDED":
      return {
        kind: "RENDER_EMBEDDED" as const,
        sdk_driver: payload.widget?.sdkDriver ?? "",
        script_urls: payload.widget?.scriptUrls ?? [],
        script_sri_hashes: payload.widget?.scriptSriHashes ?? [],
        config: payload.widget?.configTemplate ?? {},
        allowed_origins: payload.widget?.allowedOrigins ?? [],
        iframe_sandbox: JSON.stringify(payload.widget?.iframeSandboxAttrs ?? []),
        iframe_src: null,
      };
    case "QR_DISPLAY":
      return {
        kind: "SHOW_QR_OR_CODE" as const,
        qr_payload: "",
        pay_code: payload.attemptReference,
        instructions_ar: payload.instructionsAr ?? "",
        instructions_en: payload.instructionsEn ?? "",
        expires_at: payload.expiresAt.toISOString(),
        deep_link_url: null,
      };
    default:
      return {
        kind: "SHOW_PUSH_OR_TRANSFER" as const,
        wallet_hint: "",
        destination_account: "",
        payment_reference: payload.attemptReference,
        instructions_ar: payload.instructionsAr ?? "",
        instructions_en: payload.instructionsEn ?? "",
        proof_upload_allowed: false,
        expires_at: payload.expiresAt.toISOString(),
        cancel_supported: true,
      };
  }
};

/**
 * The gateway fee is derived from the pinned route cost model. It is never
 * guessed: a route without a cost model books no gateway fee.
 */
const gatewayFeeForRoute = (
  costModel: RailRouteRecord["costModel"],
  amount: string,
): string => {
  const model = costModel;
  if (!model) {
    return "0.0000";
  }
  let cost = decimal(0);
  if (model.flat !== undefined) {
    cost = cost.plus(decimal(model.flat));
  }
  if (model.percent !== undefined) {
    cost = cost.plus(decimal(amount).mul(decimal(model.percent)).div(100));
  }
  if (model.calc_type === "TIERED" || model.calc_type === "HYBRID") {
    for (const tier of model.tiers ?? []) {
      if (tier.up_to === undefined || decimal(amount).lte(decimal(tier.up_to))) {
        if (tier.flat !== undefined) {
          cost = cost.plus(decimal(tier.flat));
        }
        if (tier.percent !== undefined) {
          cost = cost.plus(decimal(amount).mul(decimal(tier.percent)).div(100));
        }
        break;
      }
    }
  }
  if (model.min !== undefined) {
    cost = decimal(decimal(model.min)).gt(cost) ? decimal(model.min) : cost;
  }
  if (model.max !== undefined && cost.gt(decimal(model.max))) {
    cost = decimal(model.max);
  }
  return cost.toFixed(4);
};

/**
 * Customer supplied fields are stored masked. PAN-class fields are never
 * persisted at all - they are wiped from memory after the single outbound
 * call that needs them.
 */
const SENSITIVE_FORM_FIELDS = new Set([
  "pan",
  "card_number",
  "cardnumber",
  "cvv",
  "cvc",
  "expiry",
  "exp_month",
  "exp_year",
]);

const maskedCustomerFields = (formData: Record<string, unknown>): Record<string, unknown> => {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(formData)) {
    if (SENSITIVE_FORM_FIELDS.has(key.toLowerCase())) {
      continue;
    }
    masked[key] = typeof value === "string" ? maskIdentifier(value) : value;
  }
  return masked;
};

const maskIdentifier = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    return "*".repeat(trimmed.length);
  }
  return `${"*".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
};

/**
 * The engine produces the declarative `ClientAction` in its own envelope; the
 * hosted checkout consumes the flat `kind` + payload contract.
 */
const toClientActionPayload = (action: {
  type: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> => {
  const { type, payload } = action;
  switch (type) {
    case "HTTP_REDIRECT":
      return { kind: "HTTP_REDIRECT", ...payload };
    case "RENDER_EMBEDDED":
      return { kind: "RENDER_EMBEDDED", ...payload };
    case "SHOW_QR_OR_CODE":
      return { kind: "SHOW_QR_OR_CODE", ...payload };
    case "SHOW_PUSH_OR_TRANSFER":
      return { kind: "SHOW_PUSH_OR_TRANSFER", ...payload };
    case "SHOW_OTP_FORM":
    default:
      return { kind: "SHOW_OTP_FORM", ...payload };
  }
};

const ensureLinkUsable = (link: LoadedLink): void => {
  if (link.state !== "PENDING") {
    throw new ApiError(409, "PAYMENT_LINK_NOT_AVAILABLE", "The payment link is no longer available");
  }
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(409, "PAYMENT_LINK_EXPIRED", "The payment link has expired");
  }
};

const NON_CANCELLABLE_STATUSES = [
  "SUCCEEDED",
  "AUTHORIZING",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "BLOCKED",
] as const;

/**
 * The AML guard marks a held attempt with this substatus. The AML case owns the
 * lifecycle of a held payment (release/void) until it is resolved, so the
 * customer cancel and the generic expiry sweeper must not touch it.
 */
export const AML_HOLD_SUBSTATUS = "AML_HOLD";

/**
 * The attempt states from which a confirm may claim the SUBMIT phase. The claim
 * is a single conditional UPDATE, so exactly one concurrent caller wins.
 */
export const CONFIRM_CLAIMABLE_STATUSES = [
  "CREATED",
  "INITIATING",
  "AWAITING_CUSTOMER",
  "VERIFYING",
  "UNKNOWN",
] as const;

const CONFIRM_IDEMPOTENCY_FIELD = "confirm_idempotency_key_hash";

/**
 * The confirm idempotency key is stored as a hash in the attempt's existing
 * `customer_fields_masked` JSON document. No schema column is added, and the
 * marker survives every engine update (canonical errors only overwrite
 * `substatus`).
 */
export const confirmIdempotencyHash = (idempotencyKey: string): string =>
  createHash("sha256").update(idempotencyKey).digest("hex");

export interface ConfirmClaimResult {
  claimed: boolean;
  attemptId: string;
}

/**
 * Atomically claims an attempt for the SUBMIT phase (design §9.1 rules 2/3/5).
 *
 * The conditional UPDATE is the single-writer guard: only one concurrent
 * confirm can move a claimable attempt to AUTHORIZING. A repeated confirm with
 * the same idempotency key is refused by the marker comparison before the
 * gateway is contacted, and an UNKNOWN attempt past the point of no return can
 * never be claimed again.
 */
export const claimAttemptForConfirm = async (
  db: typeof client,
  attemptId: string,
  idempotencyKeyHash: string,
): Promise<ConfirmClaimResult> => {
  const statusPlaceholders = CONFIRM_CLAIMABLE_STATUSES.map(() => "?").join(", ");
  const affected = Number(
    await db.$executeRawUnsafe(
      `UPDATE payment_attempts
          SET status = 'AUTHORIZING',
              point_of_no_return = 1,
              customer_fields_masked = JSON_SET(
                customer_fields_masked,
                '$.${CONFIRM_IDEMPOTENCY_FIELD}',
                ?
              ),
              updated_at = NOW()
        WHERE id = ?
          AND terminal_at IS NULL
          AND status IN (${statusPlaceholders})
          AND NOT (status = 'UNKNOWN' AND point_of_no_return = 1)
          AND (substatus IS NULL OR substatus <> '${AML_HOLD_SUBSTATUS}')
          AND (
            JSON_UNQUOTE(JSON_EXTRACT(customer_fields_masked, '$.${CONFIRM_IDEMPOTENCY_FIELD}')) IS NULL
            OR JSON_UNQUOTE(JSON_EXTRACT(customer_fields_masked, '$.${CONFIRM_IDEMPOTENCY_FIELD}')) <> ?
          )`,
      idempotencyKeyHash,
      attemptId,
      ...CONFIRM_CLAIMABLE_STATUSES,
      idempotencyKeyHash,
    ) ?? 0,
  );
  return { claimed: affected === 1, attemptId };
};

export interface CancelAttemptResult {
  attemptId: string;
  status: string;
  released: boolean;
}

/**
 * Cancels an attempt with one conditional transition (design §16.1).
 *
 * The update only succeeds while the attempt is non-terminal, before the point
 * of no return, and not AML-held. The link reservation is released only when
 * that exact transition changed a row, so a repeated cancel (or a cancel of a
 * BLOCKED / EXPIRED attempt that never held a slot) can never free another
 * attempt's slot. A held attempt is owned by its AML case: cancelling it here
 * would release the slot and let a later release credit a cancelled attempt.
 * The current status is always returned, which makes repeats idempotent.
 */
export const cancelAttemptAtomically = async (
  db: typeof client,
  attempt: { id: string; linkId: string },
): Promise<CancelAttemptResult> =>
  db.$transaction(async (tx) => {
    const affected = Number(
      await tx.$executeRawUnsafe(
        `UPDATE payment_attempts
            SET status = 'CANCELLED', terminal_at = ?, next_check_at = NULL, updated_at = NOW()
          WHERE id = ?
            AND terminal_at IS NULL
            AND point_of_no_return = 0
            AND (substatus IS NULL OR substatus <> '${AML_HOLD_SUBSTATUS}')
            AND status NOT IN (${NON_CANCELLABLE_STATUSES.map(() => "?").join(", ")})`,
        new Date(),
        attempt.id,
        ...NON_CANCELLABLE_STATUSES,
      ) ?? 0,
    );
    if (affected > 0) {
      await tx.$executeRawUnsafe(
        "UPDATE payment_links SET active_locked_count = GREATEST(0, active_locked_count - 1), updated_at = NOW() WHERE id = ?",
        attempt.linkId,
      );
    }
    const current = await tx.paymentAttempt.findUnique({
      where: { id: attempt.id },
      select: { status: true },
    });
    return {
      attemptId: attempt.id,
      status: current?.status ?? "UNKNOWN",
      released: affected > 0,
    };
  });

route.get("/pay/:linkKey", async (request: Request, response: Response) => {
  const { linkKey } = parseOrThrow(linkParamsSchema, request.params);
  const link = await loadLink(linkKey);
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  const env = resolveEnvironment(link.merchantStatus);
  const catalog = await loadCatalog();
  const visible = visibleRailsFor(link, catalog, env);
  const railFields = await client.railField.findMany({
    where: { railId: { in: visible.rails.map((entry) => entry.rail.id) } },
    orderBy: { orderIndex: "asc" },
  });
  const profiles = await client.commissionProfile.findMany({
    where: { id: { in: visible.rails.map((entry) => entry.commissionProfile.id) } },
  });
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  const rails = visible.rails.map((entry) => {
    const profile = profileById.get(entry.commissionProfile.id);
    const breakdown = profile
      ? buildBreakdown(link, profile)
      : {
          commission: "0.0000",
          payerSurcharge: "0.0000",
          totalCharged: decimal(link.amount).toFixed(4),
          merchantCredited: decimal(link.amount).toFixed(4),
          feeBearer: link.feeBearer,
        };
    return {
      code: entry.rail.code,
      displayNameAr: entry.rail.nameAr ?? entry.rail.code,
      displayNameEn: entry.rail.nameEn ?? entry.rail.code,
      collectionMode: entry.rail.collectionMode ?? "HYBRID",
      minAmount: null,
      maxAmount: null,
      currency: link.currency,
      icon: null,
      fields: railFields
        .filter((field) => field.railId === entry.rail.id)
        .map((field) => ({
          key: field.key,
          inputType: fieldInputType(field.type),
          labelAr: field.labelAr,
          labelEn: field.labelEn,
          placeholderAr: field.placeholderAr,
          placeholderEn: field.placeholderEn,
          regex: field.regex,
          minLength: field.minLength,
          maxLength: field.maxLength,
          required: field.required,
          options: fieldOptions(field.optionsJson),
          sensitivity: field.sensitivity,
        })),
      routes: entry.routes.map((ranked) => {
        const cap = evaluateRouteDailyCap(ranked.route, link.amount);
        return {
          routeId: ranked.route.id,
          rank: ranked.rank,
          dailyCapAmount: cap.cap?.toFixed(4) ?? null,
          dailyProcessedAmount: cap.processed.toFixed(4),
          dailyCapRemaining: cap.remaining?.toFixed(4) ?? null,
          withinDailyCap: cap.withinCap,
        };
      }),
      fee: breakdown,
    };
  });

  const defaultProfile = profiles[0];
  const fee = defaultProfile
    ? buildBreakdown(link, defaultProfile)
    : {
        commission: "0.0000",
        payerSurcharge: "0.0000",
        totalCharged: decimal(link.amount).toFixed(4),
        merchantCredited: decimal(link.amount).toFixed(4),
        feeBearer: link.feeBearer,
      };

  response.json({
    linkKey: link.key,
    merchantTradeName: link.merchantTradeName,
    merchantLogoUrl: null,
    description: null,
    amount: decimal(link.amount).toFixed(4),
    currency: link.currency,
    feeBearerMode: link.feeBearer,
    baseAmount: decimal(link.amount).toFixed(4),
    feeAmount: fee.commission,
    totalAmount: fee.totalCharged,
    merchantAmount: fee.merchantCredited,
    splitPercent: link.feeBearer === "SPLIT"
      ? splitRatio(link.splitRatioJson).mul(100).toFixed(0)
      : null,
    visibleRails: rails,
    // The rails that were not visible, with the reason why. The daily cap
    // guard is observable instead of being an invisible filter.
    excludedRails: visible.excluded,
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    status: link.state,
    redirectUrl: null,
    allowlistedRedirectHosts: [] as string[],
  });
});

route.post("/pay/:linkKey/initiate", async (request: Request, response: Response) => {
  const { linkKey } = parseOrThrow(linkParamsSchema, request.params);
  const body = parseOrThrow(initiateSchema, request.body);
  const link = await loadLink(linkKey);
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  ensureLinkUsable(link);

  const existing = await client.paymentAttempt.findFirst({
    where: { idempotencyKey: body.idempotencyKey, linkId: link.id },
  });
  if (existing) {
    response.status(201).json({
      attemptId: existing.id,
      reference: existing.reference,
      status: existing.status,
      clientAction: null,
    });
    return;
  }

  const env = resolveEnvironment(link.merchantStatus);
  const catalog = await loadCatalog();
  const visible = visibleRailsFor(link, catalog, env);
  const visibleRail = visible.rails.find((entry) => entry.rail.code === body.railCode);
  if (!visibleRail) {
    throw new ApiError(404, "RAIL_NOT_AVAILABLE", "The requested rail is not available for this payment link");
  }
  const ranked = visibleRail.routes[0];
  if (!ranked) {
    throw new ApiError(409, "NO_ELIGIBLE_ROUTE", "No eligible route is configured for the requested rail");
  }
  const routeRow = ranked.route;
  const credentialSet = ranked.credentialSet;

  const gateway = await client.gateway.findUnique({ where: { id: routeRow.gatewayId } });
  const activeVersionId = gateway?.activeVersionId ?? null;
  if (!activeVersionId) {
    throw new ApiError(409, "GATEWAY_VERSION_NOT_LIVE", "The selected gateway has no live configuration version");
  }
  const gatewaySetting = await client.gatewaySetting.findUnique({
    where: { gatewayVersionId: activeVersionId },
  });
  const rail = await client.rail.findUnique({ where: { id: visibleRail.rail.id } });
  const profile = await client.commissionProfile.findUnique({
    where: { id: visibleRail.commissionProfile.id },
  });
  if (!rail || !profile) {
    throw new ApiError(409, "RAIL_CONFIGURATION_INCOMPLETE", "The rail configuration is incomplete");
  }

  // The customer form is validated against the rail's own field descriptors
  // before the guard runs or the gateway is contacted (design §7.3 and §10;
  // edge cases 131 and 138).
  const railFields = await client.railField.findMany({
    where: { railId: rail.id },
    orderBy: { orderIndex: "asc" },
  });
  validateRailFields(railFields, body.formData);

  const mode = rail.collectionMode;
  const platformCeiling = PLATFORM_TTL_CEILINGS[mode] ?? 1200;
  const gatewayTtl = gatewaySetting?.sessionTtlSeconds ?? platformCeiling;
  const ttlSeconds = Math.min(platformCeiling, gatewayTtl);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const graceExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const clientIp = typeof request.headers["x-real-client-ip"] === "string"
    ? (request.headers["x-real-client-ip"] as string)
    : request.ip ?? null;
  const userAgent = typeof request.headers["x-client-user-agent"] === "string"
    ? (request.headers["x-client-user-agent"] as string)
    : null;

  const customerFingerprint = fingerprint([clientIp, userAgent, link.id]);

  const breakdown = buildBreakdown(link, profile);
  const gatewayFee = gatewayFeeForRoute(routeRow.costModel, breakdown.totalCharged);
  const settlementTarget = credentialSet.settlementTarget;

  // The attempt-creation guard (design §9.1 rule 2) runs inside the
  // transaction that reserves the slot of the link: the velocity rules, the
  // watch list and the AML rules are evaluated there, a rejected payment
  // leaves a terminal BLOCKED attempt behind and a held payment leaves its
  // money escrowed in `AML_HOLD`.
  const platform = getPlatformRuntime(client as never);
  const decision = await client.$transaction(async (tx) =>
    platform.guardPipeline.guard(
      {
        linkKey,
        railCode: body.railCode,
        applicationId: link.applicationId,
        merchantId: link.merchantId,
        env,
        channel: "WEB",
        mode,
        subMode: body.subMode ?? null,
        customer: {
          phone: customerPhoneOf(body.formData),
          ip: clientIp,
          cardAlias: customerCardAliasOf(body.formData),
          deviceFingerprint: customerFingerprint,
          walletId: customerWalletOf(body.formData),
          name: customerNameOf(body.formData),
        },
        idempotencyKey: body.idempotencyKey,
        clientIp,
        userAgent,
        pinnedRoute: {
          railId: rail.id,
          routeId: routeRow.id,
          credentialSetId: credentialSet.id,
          gatewayVersionId: activeVersionId,
          commissionProfileId: profile.id,
          settlementTarget,
          gatewayId: routeRow.gatewayId,
          mode,
        },
        amounts: {
          surchargeAmount: breakdown.payerSurcharge,
          totalChargedAmount: breakdown.totalCharged,
          platformCommissionAmount: breakdown.commission,
          netMerchantAmount: breakdown.merchantCredited,
          gatewayFeeAmount: gatewayFee,
        },
        customerFields: {
          fingerprint: customerFingerprint,
          fields: maskedCustomerFields(body.formData),
        },
        expiresAt,
        graceExpiresAt,
        nextCheckAt: new Date(Date.now() + 5000),
      },
      tx as never,
    ),
  );

  if (decision.outcome === "BLOCK") {
    // The customer sees a generic message: the reason of the refusal stays
    // internal (design §20).
    response.status(decision.customerMessageCode === "PAYMENT_IN_PROGRESS" ? 409 : 403).json({
      attemptId: decision.attemptId,
      reference: decision.reference,
      status: "BLOCKED",
      code: decision.customerMessageCode,
      reasons: decision.reasons,
      clientAction: null,
    });
    return;
  }

  if (decision.outcome === "HOLD") {
    // The money is escrowed and the attempt waits for the resolution of the
    // AML case. It is never settled from here.
    response.status(202).json({
      attemptId: decision.attemptId,
      reference: decision.reference,
      status: "CREATED",
      code: decision.customerMessageCode,
      reasons: decision.reasons,
      hold: true,
      clientAction: null,
    });
    return;
  }

  const attemptId = decision.attemptId;
  if (!attemptId) {
    throw new ApiError(500, "ATTEMPT_NOT_CREATED", "The payment attempt was not created");
  }
  const attempt = await client.paymentAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) {
    throw new ApiError(500, "ATTEMPT_NOT_CREATED", "The payment attempt was not created");
  }

  const widget = await client.widgetDefinition.findUnique({ where: { routeId: routeRow.id } });
  const redirect = await client.redirectDefinition.findUnique({ where: { routeId: routeRow.id } });

  const fallbackAction = buildClientAction(mode, {
    expiresAt,
    attemptReference: attempt.reference,
    maskedPhone: maskedPhone(body.formData),
    railCode: rail.code,
    widget: widget
      ? {
          scriptUrls: widget.scriptUrls,
          scriptSriHashes: widget.scriptSriHashes,
          configTemplate: widget.configTemplate,
          allowedOrigins: widget.allowedOrigins,
          iframeSandboxAttrs: widget.iframeSandboxAttrs,
          sdkDriver: widget.sdkDriver,
        }
      : null,
    redirect: redirect
      ? {
          method: redirect.method,
          urlSourceOutput: "",
          formFieldsOutput: redirect.formFieldsOutput,
          target: redirect.target,
          returnParamsMap: redirect.returnParamsMap,
        }
      : null,
    instructionsAr: rail.instructionsAr,
    instructionsEn: rail.instructionsEn,
    fee: breakdown,
  });

  // The slot reservation, the flow execution and the state transition are
  // owned by the universal rail engine. The guard already reserved the slot
  // in the transaction that created the attempt, so the engine must not take
  // a second reservation (design §9.1 rule 2).
  const engineResult = await platform.engine.initiate(
    attempt as unknown as DynamicAttempt,
    body.formData,
    { slotReserved: decision.slotReserved === true },
  );

  const attemptRow = await client.paymentAttempt.findUnique({ where: { id: attempt.id } });
  const clientAction = engineResult.clientAction
    ? toClientActionPayload(engineResult.clientAction)
    : fallbackAction;

  response.status(201).json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: attemptRow?.status ?? engineResult.status,
    clientAction,
  });
});

const loadAttempt = async (linkKey: string, attemptId: string) => {
  const link = await loadLink(linkKey);
  if (!link) {
    throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  }
  const attempt = await client.paymentAttempt.findFirst({
    where: { id: attemptId, linkId: link.id },
  });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The payment attempt does not exist");
  }
  return { link, attempt };
};

route.get("/pay/:linkKey/logs/:attemptId", async (request: Request, response: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, request.params);
  const { attempt } = await loadAttempt(linkKey, attemptId);
  response.json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: attempt.status,
    substatus: attempt.substatus,
    amount: decimal(attempt.totalChargedAmount).toFixed(4),
    currency: attempt.currency,
    feeBearer: attempt.feeBearer,
    expiresAt: attempt.expiresAt.toISOString(),
    otpAttempts: attempt.otpAttempts,
    providerReference: attempt.providerReference,
    clientAction: null,
    publicOutputs: {},
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
  });
});

route.get("/pay/:linkKey/logs/:attemptId/status", async (request: Request, response: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, request.params);
  await loadAttempt(linkKey, attemptId);
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();

  const terminal = new Set(["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "REFUNDED"]);
  let lastStatus = "";
  const deadline = Date.now() + 10 * 60 * 1000;

  const poll = async (): Promise<void> => {
    if (response.writableEnded || Date.now() > deadline) {
      response.end();
      return;
    }
    const attempt = await client.paymentAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) {
      response.end();
      return;
    }
    if (attempt.status !== lastStatus) {
      lastStatus = attempt.status;
      response.write(`event: status\ndata: ${JSON.stringify({
        attemptId: attempt.id,
        reference: attempt.reference,
        status: attempt.status,
        substatus: attempt.substatus,
      })}\n\n`);
    }
    if (terminal.has(attempt.status)) {
      response.end();
      return;
    }
    setTimeout(() => {
      void poll();
    }, 2000);
  };

  request.on("close", () => {
    response.end();
  });
  await poll();
});

route.post("/pay/:linkKey/logs/:attemptId/confirm", async (request: Request, response: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, request.params);
  const body = parseOrThrow(confirmSchema, request.body);
  const { attempt } = await loadAttempt(linkKey, attemptId);
  if (attempt.status === "SUCCEEDED") {
    response.json({ attemptId: attempt.id, status: attempt.status });
    return;
  }
  // AUTHORIZING is included so a duplicate confirm that arrives after the
  // winner has claimed the attempt returns the current state instead of a 409.
  // The atomic claim still guarantees that only one caller runs SUBMIT.
  if (!["CREATED", "INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "UNKNOWN", "AUTHORIZING"].includes(attempt.status)) {
    throw new ApiError(409, "ATTEMPT_NOT_CONFIRMABLE", "The attempt is not in a confirmable state");
  }

  // The SUBMIT stack, the trusted success facts and the ledger posting are
  // owned by the universal rail engine.
  const platform = getPlatformRuntime(client as never);
  const evidence: Record<string, unknown> = {
    ...((body.evidence ?? {}) as Record<string, unknown>),
    ...(body.otp ? { otp: body.otp } : {}),
  };
  const idempotencyKeyHash = confirmIdempotencyHash(body.idempotencyKey);
  const result = await platform.engine.confirm(attempt as unknown as DynamicAttempt, evidence, {
    claim: async (targetAttemptId) =>
      (await claimAttemptForConfirm(client, targetAttemptId, idempotencyKeyHash)).claimed,
  });
  const updated = await client.paymentAttempt.findUnique({ where: { id: attempt.id } });

  response.json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: updated?.status ?? result.status,
    canonicalError: result.canonicalError ?? null,
    clientAction: result.clientAction ? toClientActionPayload(result.clientAction) : null,
  });
});

route.post("/pay/:linkKey/logs/:attemptId/resend", async (request: Request, response: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, request.params);
  parseOrThrow(resendSchema, request.body ?? {});
  const { attempt } = await loadAttempt(linkKey, attemptId);
  if (attempt.status !== "AWAITING_CUSTOMER") {
    throw new ApiError(409, "ATTEMPT_NOT_AWAITING_CUSTOMER", "The attempt is not awaiting customer input");
  }
  const gatewayVersion = await client.gatewayVersion.findUnique({
    where: { id: attempt.gatewayVersionId },
    include: { setting: true },
  });
  const cooldown = gatewayVersion?.setting?.otpResendCooldownSeconds ?? 60;
  const lastSent = attempt.lastOtpSentAt?.getTime() ?? 0;
  if (Date.now() - lastSent < cooldown * 1000) {
    throw new ApiError(429, "OTP_RESEND_COOLDOWN", "The OTP resend cooldown has not elapsed");
  }
  const updated = await client.paymentAttempt.update({
    where: { id: attempt.id },
    data: { lastOtpSentAt: new Date(), otpAttempts: attempt.otpAttempts },
  });
  response.json({ attemptId: updated.id, status: updated.status, resendAvailableInSeconds: cooldown });
});

route.post("/pay/:linkKey/logs/:attemptId/cancel", async (request: Request, response: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, request.params);
  parseOrThrow(cancelSchema, request.body ?? {});
  const { attempt } = await loadAttempt(linkKey, attemptId);
  const cancelled = await cancelAttemptAtomically(client, attempt);
  if (!cancelled.released && cancelled.status !== "CANCELLED") {
    throw new ApiError(409, "ATTEMPT_NOT_CANCELLABLE", "The attempt can no longer be cancelled");
  }
  response.json({ attemptId: cancelled.attemptId, status: cancelled.status });
});

route.post("/pay/:linkKey/logs/:attemptId/client-event", async (request: Request, response: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, request.params);
  const body = parseOrThrow(clientEventSchema, request.body);
  const { attempt } = await loadAttempt(linkKey, attemptId);
  if (attempt.status === "SUCCEEDED") {
    response.json({ attemptId: attempt.id, status: attempt.status });
    return;
  }
  // A browser callback is only a HINT. It never decides the outcome: the
  // engine inquires the gateway and trusts only verified facts.
  const platform = getPlatformRuntime(client as never);
  const result = await platform.engine.inquire(attempt as unknown as DynamicAttempt);
  const updated = await client.paymentAttempt.findUnique({ where: { id: attempt.id } });
  response.json({
    attemptId: attempt.id,
    status: updated?.status ?? result.status,
    event: body.event,
  });
});

route.get("/return/:attemptToken", async (request: Request, response: Response) => {
  const attemptToken = String(request.params.attemptToken ?? "");
  const attempt = await client.paymentAttempt.findFirst({
    where: { OR: [{ reference: attemptToken }, { gatewayReference: attemptToken }] },
  });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The attempt token is not recognised");
  }
  const platform = getPlatformRuntime(client as never);
  const result = await platform.engine.inquire(attempt as unknown as DynamicAttempt);
  const updated = await client.paymentAttempt.findUnique({ where: { id: attempt.id } });
  response.json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: updated?.status ?? result.status,
    redirect: `/pay/${attempt.reference}/status`,
  });
});

route.post("/return/:attemptToken", async (request: Request, response: Response) => {
  const attemptToken = String(request.params.attemptToken ?? "");
  const attempt = await client.paymentAttempt.findFirst({
    where: { OR: [{ reference: attemptToken }, { gatewayReference: attemptToken }] },
  });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The attempt token is not recognised");
  }
  const platform = getPlatformRuntime(client as never);
  const result = await platform.engine.inquire(attempt as unknown as DynamicAttempt);
  const updated = await client.paymentAttempt.findUnique({ where: { id: attempt.id } });
  response.json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: updated?.status ?? result.status,
    redirect: `/pay/${attempt.reference}/status`,
  });
});

route.post("/inbound/:gateway/:env/:pathToken", async (request: Request, response: Response) => {
  const gatewayCode = String(request.params.gateway ?? "");
  const environment = String(request.params.env ?? "").toUpperCase();
  const pathToken = String(request.params.pathToken ?? "");
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

  const channel = await client.confirmationChannel.findUnique({
    where: { pathToken },
    include: { gatewayVersion: true },
  });
  if (!channel) {
    throw new ApiError(404, "INBOUND_CHANNEL_UNKNOWN", "The inbound channel token is not registered");
  }
  const gateway = await client.gateway.findUnique({ where: { id: channel.gatewayVersion.gatewayId } });
  if (!gateway || gateway.code !== gatewayCode) {
    throw new ApiError(403, "INBOUND_GATEWAY_MISMATCH", "The inbound gateway does not match the channel");
  }
  if (environment !== "SANDBOX" && environment !== "LIVE") {
    throw new ApiError(400, "INBOUND_ENVIRONMENT_INVALID", "The inbound environment is invalid");
  }
  const boundEnvironment = await client.gatewayEnvironment.findFirst({
    where: { gatewayVersionId: channel.gatewayVersionId, env: environment },
  });
  if (!boundEnvironment || !boundEnvironment.enabled) {
    throw new ApiError(403, "INBOUND_ENVIRONMENT_NOT_BOUND", "The inbound channel is not bound to this environment");
  }

  const dedupeKey = createHash("sha256")
    .update(`${channel.id}:${rawBody.toString("base64")}`, "utf8")
    .digest("hex");

  const sourceIp = typeof request.headers["x-real-client-ip"] === "string"
    ? (request.headers["x-real-client-ip"] as string)
    : request.ip ?? "0.0.0.0";

  const existing = await client.inboundEvent.findFirst({
    where: { channelId: channel.id, dedupeKey },
  });
  if (existing) {
    response.status(channel.ackStatus).send(
      channel.ackBodyTemplate ? renderTemplate(channel.ackBodyTemplate, { dedupeKey }) : "",
    );
    return;
  }

  const stored = await client.inboundEvent.create({
    data: {
      channelId: channel.id,
      gatewayId: channel.gatewayVersion.gatewayId,
      env: environment,
      rawBodyBytes: new Uint8Array(rawBody),
      redactedHeadersJson: json({
        "content-type": request.headers["content-type"] ?? null,
        "content-length": rawBody.byteLength,
      }),
      sourceIp,
      verified: false,
      verificationError: "VERIFICATION_PENDING",
      dedupeKey,
      receivedAt: new Date(),
    },
  });

  const correlation = extractCorrelation(rawBody, channel.correlationSelector);
  const attempt = correlation
    ? await client.paymentAttempt.findFirst({
        where: {
          OR: [
            { reference: correlation },
            { providerReference: correlation },
            { networkReference: correlation },
            { gatewayReference: correlation },
          ],
        },
      })
    : null;

  if (attempt) {
    await client.inboundEvent.update({
      where: { id: stored.id },
      data: { attemptId: attempt.id },
    });
  }

  // The webhook is never trusted on arrival. The engine verifies the
  // signature (constant time, across every active secret version), enforces
  // the IP allowlist and the replay window, and only then trusts the facts.
  const platform = getPlatformRuntime(client as never);
  let verified = false;
  let verificationError: string | null = null;
  let processingResult = "IGNORED";
  try {
    const result = await platform.engine.verifyCallback(pathToken, {
      rawBody,
      headers: Object.fromEntries(
        Object.entries(request.headers as Record<string, string | string[] | undefined>)
          .filter(([, value]) => typeof value === "string")
          .map(([key, value]) => [key.toLowerCase(), value as string]),
      ),
      sourceIp,
    });
    verified = true;
    processingResult = result.status;
  } catch (error) {
    verificationError = String((error as { code?: string })?.code ?? "CALLBACK_VERIFICATION_FAILED");
    processingResult = "REJECTED";
  }

  await client.inboundEvent.update({
    where: { id: stored.id },
    data: {
      verified,
      verificationError,
      processedAt: new Date(),
      processingResult,
    },
  });

  response.status(channel.ackStatus).send(
    channel.ackBodyTemplate
      ? renderTemplate(channel.ackBodyTemplate, { eventId: stored.id, attemptId: attempt?.id ?? "" })
      : "",
  );
});

const extractCorrelation = (rawBody: Buffer, selector: string | null): string | null => {
  if (!rawBody.length) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (!selector) {
    return null;
  }
  const segments = selector.split(".");
  let cursor: unknown = parsed;
  for (const segment of segments) {
    if (cursor && typeof cursor === "object" && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return null;
    }
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
};

const renderTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) => values[key] ?? "");

export const checkoutInternalRouter = route;
export const checkoutInternals = {
  buildClientAction,
  buildBreakdown,
  visibleRailsFor,
  loadCatalog,
  loadLink,
  isValidLuhn,
  validateRailFields,
  cancelAttemptAtomically,
  claimAttemptForConfirm,
  confirmIdempotencyHash,
};
export { principalOf };
