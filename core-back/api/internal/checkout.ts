import { createHash } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { VisibleRailsResolver, type RailRecord, type RailRouteRecord, type CredentialSetRecord, type CommissionProfileRecord } from "../../engine/flow/VisibleRailsResolver";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { fingerprint, principalOf } from "../middleware/authDoubleCheck";

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

const asStringArray = (value: unknown): string[] | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => String(entry));
};

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

const loadCatalog = async (): Promise<Catalog> => {
  const [rails, routes, credentialSets, commissionProfiles] = await Promise.all([
    client.rail.findMany({ orderBy: { displayOrder: "asc" } }),
    client.railRoute.findMany(),
    client.credentialSet.findMany(),
    client.commissionProfile.findMany(),
  ]);
  return {
    rails: rails.map((rail) => ({
      id: rail.id,
      code: rail.code,
      nameAr: rail.nameAr,
      nameEn: rail.nameEn,
      currency: rail.currency,
      blocked: rail.blocked,
      displayOrder: rail.displayOrder,
      collectionMode: rail.collectionMode,
    })),
    routes: routes.map((entry) => ({
      id: entry.id,
      railId: entry.railId,
      gatewayId: entry.gatewayId,
      credentialPolicy: entry.credentialPolicy,
      priority: entry.priority,
      routingStrategy: entry.routingStrategy,
      weight: entry.weight,
      costModel: (entry.costModel ?? undefined) as RailRouteRecord["costModel"],
      minAmount: entry.minAmount,
      maxAmount: entry.maxAmount,
      dailyCapAmount: entry.dailyCapAmount,
      status: entry.status,
      healthState: entry.healthState,
      maintenanceWindows: (entry.maintenanceWindows ?? undefined) as RailRouteRecord["maintenanceWindows"],
      scope: (entry.scope ?? undefined) as RailRouteRecord["scope"],
    })),
    credentialSets: credentialSets.map((entry) => ({
      id: entry.id,
      gatewayId: entry.gatewayId,
      env: entry.env,
      ownerType: entry.ownerType,
      ownerMerchantId: entry.ownerMerchantId,
      settlementTarget: entry.settlementTarget,
      status: entry.status,
    })),
    commissionProfiles: commissionProfiles.map((entry) => ({
      id: entry.id,
      merchantId: entry.merchantId,
      applicationId: entry.applicationId,
      railCode: entry.railCode,
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
    })),
  };
};

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

const splitRatio = (value: unknown): number => {
  if (!value || typeof value !== "object") {
    return 0.5;
  }
  const record = value as Record<string, unknown>;
  const raw = record.platformShare ?? record.platform_share ?? record.share;
  const parsed = raw === undefined ? 0.5 : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return 0.5;
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

const ensureLinkUsable = (link: LoadedLink): void => {
  if (link.state !== "PENDING") {
    throw new ApiError(409, "PAYMENT_LINK_NOT_AVAILABLE", "The payment link is no longer available");
  }
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(409, "PAYMENT_LINK_EXPIRED", "The payment link has expired");
  }
};

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
    splitPercent: link.feeBearer === "SPLIT" ? String(Math.round(splitRatio(link.splitRatioJson) * 100)) : null,
    visibleRails: rails,
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
  const reference = `PA-${Date.now().toString(36).toUpperCase()}-${createHash("sha256")
    .update(`${link.id}:${customerFingerprint}:${body.idempotencyKey}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase()}`;

  const breakdown = buildBreakdown(link, profile);

  const attempt = await client.$transaction(async (tx) => {
    const reservation = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      "UPDATE payment_links SET active_locked_count = active_locked_count + 1, updated_at = NOW() WHERE id = $1 AND (infinite_use = true OR confirmed_count + active_locked_count < use_count) RETURNING id",
      link.id,
    );
    if (!Array.isArray(reservation) || reservation.length === 0) {
      throw new ApiError(409, "PAYMENT_LINK_SLOT_UNAVAILABLE", "The payment link has no available slot");
    }

    const group = await tx.attemptGroup.upsert({
      where: { linkId_customerFingerprint: { linkId: link.id, customerFingerprint } },
      update: {},
      create: { linkId: link.id, customerFingerprint },
    });

    return tx.paymentAttempt.create({
      data: {
        reference,
        idempotencyKey: body.idempotencyKey,
        linkId: link.id,
        attemptGroupId: group.id,
        applicationId: link.applicationId,
        merchantId: link.merchantId,
        railId: rail.id,
        routeId: routeRow.id,
        credentialSetId: credentialSet.id,
        gatewayVersionId: activeVersionId,
        commissionProfileId: profile.id,
        env: credentialSet.env,
        mode,
        subMode: body.subMode ?? null,
        status: "INITIATING",
        requestedAmount: link.amount,
        surchargeAmount: new Prisma.Decimal(breakdown.payerSurcharge),
        totalChargedAmount: new Prisma.Decimal(breakdown.totalCharged),
        platformCommissionAmount: new Prisma.Decimal(breakdown.commission),
        netMerchantAmount: new Prisma.Decimal(breakdown.merchantCredited),
        feeBearer: link.feeBearer,
        currency: link.currency,
        customerFieldsMasked: { fingerprint: customerFingerprint },
        contextCiphertext: "",
        expiresAt,
        graceExpiresAt,
        clientIp,
        userAgent,
        nextCheckAt: new Date(Date.now() + 5000),
      },
    });
  });

  const widget = await client.widgetDefinition.findUnique({ where: { routeId: routeRow.id } });
  const redirect = await client.redirectDefinition.findUnique({ where: { routeId: routeRow.id } });

  const clientAction = buildClientAction(mode, {
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

  await client.paymentAttempt.update({
    where: { id: attempt.id },
    data: { status: "AWAITING_CUSTOMER", substatus: mode },
  });

  response.status(201).json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: "AWAITING_CUSTOMER",
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
  if (!["CREATED", "INITIATING", "AWAITING_CUSTOMER", "VERIFYING", "UNKNOWN"].includes(attempt.status)) {
    throw new ApiError(409, "ATTEMPT_NOT_CONFIRMABLE", "The attempt is not in a confirmable state");
  }

  const otpAttempts = body.otp ? attempt.otpAttempts + 1 : attempt.otpAttempts;
  const updated = await client.paymentAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "VERIFYING",
      substatus: "AWAITING_GATEWAY_CONFIRMATION",
      otpAttempts,
      nextCheckAt: new Date(Date.now() + 5000),
    },
  });

  response.json({
    attemptId: updated.id,
    reference: updated.reference,
    status: updated.status,
    clientAction: null,
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
  if (["SUCCEEDED", "AUTHORIZING", "REFUNDED", "PARTIALLY_REFUNDED"].includes(attempt.status)) {
    throw new ApiError(409, "ATTEMPT_NOT_CANCELLABLE", "The attempt can no longer be cancelled");
  }
  const updated = await client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      "UPDATE payment_links SET active_locked_count = GREATEST(0, active_locked_count - 1), updated_at = NOW() WHERE id = $1",
      attempt.linkId,
    );
    return tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: "CANCELLED", terminalAt: new Date(), nextCheckAt: null },
    });
  });
  response.json({ attemptId: updated.id, status: updated.status });
});

route.post("/pay/:linkKey/logs/:attemptId/client-event", async (request: Request, response: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, request.params);
  const body = parseOrThrow(clientEventSchema, request.body);
  const { attempt } = await loadAttempt(linkKey, attemptId);
  if (attempt.status === "SUCCEEDED") {
    response.json({ attemptId: attempt.id, status: attempt.status });
    return;
  }
  const updated = await client.paymentAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "VERIFYING",
      substatus: `CLIENT_EVENT:${body.event}`,
      nextCheckAt: new Date(Date.now() + 3000),
    },
  });
  response.json({ attemptId: updated.id, status: updated.status });
});

route.get("/return/:attemptToken", async (request: Request, response: Response) => {
  const attemptToken = String(request.params.attemptToken ?? "");
  const attempt = await client.paymentAttempt.findFirst({
    where: { OR: [{ reference: attemptToken }, { gatewayReference: attemptToken }] },
  });
  if (!attempt) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The attempt token is not recognised");
  }
  await client.paymentAttempt.update({
    where: { id: attempt.id },
    data: { status: attempt.status === "SUCCEEDED" ? "SUCCEEDED" : "VERIFYING", nextCheckAt: new Date(Date.now() + 3000) },
  });
  response.json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: attempt.status,
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
  await client.paymentAttempt.update({
    where: { id: attempt.id },
    data: { status: attempt.status === "SUCCEEDED" ? "SUCCEEDED" : "VERIFYING", nextCheckAt: new Date(Date.now() + 3000) },
  });
  response.json({
    attemptId: attempt.id,
    reference: attempt.reference,
    status: attempt.status,
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
      redactedHeadersJson: { "content-type": request.headers["content-type"] ?? null },
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
};
export { principalOf };
