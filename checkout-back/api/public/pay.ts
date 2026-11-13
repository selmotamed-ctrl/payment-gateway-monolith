import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { callCore, proxyCoreStream, type CoreCallOptions } from "../../lib/mtlsClient";
import { isSandboxLinkKey, linkTargetUrls, requireSandboxCoreBackUrls } from "../../lib/corePools";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";
import {
  assertNoMonetaryFields,
  zAttemptId,
  zClientEvent,
  zEvidence,
  zFormData,
  zIdempotencyKey,
  zLinkKey,
  zOtp,
  zRailCode,
} from "../../lib/zReady";

const router = express.Router();

const payLimiter = lazyLimiter(() => rateLimiter({
  windowMs: env.PAY_RATE_LIMIT_WINDOW_MS,
  max: () => env.PAY_RATE_LIMIT_MAX,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many checkout requests, please retry later",
    });
  },
}));

router.use(payLimiter);

const paramsSchema = z.object({
  linkKey: zLinkKey,
});

const attemptParamsSchema = z.object({
  linkKey: zLinkKey,
  attemptId: zAttemptId,
});

const initiateSchema = z
  .object({
    railCode: zRailCode,
    subMode: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
    formData: zFormData.default({}),
    idempotencyKey: zIdempotencyKey,
  })
  .strict();

const confirmSchema = z
  .object({
    otp: zOtp,
    evidence: zEvidence.optional(),
    idempotencyKey: zIdempotencyKey,
  })
  .strict();

const resendSchema = z
  .object({
    idempotencyKey: zIdempotencyKey.optional(),
  })
  .strict();

const cancelSchema = z
  .object({
    idempotencyKey: zIdempotencyKey.optional(),
    reason: z.string().max(256).optional(),
  })
  .strict();

const clientEventSchema = z
  .object({
    event: zClientEvent,
    payload: zEvidence.optional(),
    idempotencyKey: zIdempotencyKey.optional(),
  })
  .strict();

const baseOptions = (req: Request): CoreCallOptions => ({
  method: "GET",
  path: "",
  requestId: resolveRequestId(req),
  clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
  userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
});

const encode = (value: string): string => encodeURIComponent(value);

router.get("/:linkKey", async (req: Request, res: Response) => {
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  const payload = await callCore({
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}`,
  });
  res.json(payload);
});

router.post("/:linkKey/initiate", async (req: Request, res: Response) => {
  assertNoMonetaryFields(req.body);
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  const body = parseOrThrow(initiateSchema, req.body);
  const payload = await callCore({
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/initiate`,
    body,
  });
  res.status(201).json(payload);
});

router.get("/:linkKey/logs/:attemptId", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  const payload = await callCore({
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}`,
  });
  res.json(payload);
});

router.get("/:linkKey/logs/:attemptId/status", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  await proxyCoreStream(req, res, {
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/status`,
    timeoutMs: 10 * 60 * 1000,
  });
});

router.post("/:linkKey/logs/:attemptId/confirm", async (req: Request, res: Response) => {
  assertNoMonetaryFields(req.body);
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  const body = parseOrThrow(confirmSchema, req.body);
  const payload = await callCore({
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/confirm`,
    body,
  });
  res.json(payload);
});

router.post("/:linkKey/logs/:attemptId/resend", async (req: Request, res: Response) => {
  assertNoMonetaryFields(req.body);
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  const body = parseOrThrow(resendSchema, req.body ?? {});
  const payload = await callCore({
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/resend`,
    body,
  });
  res.json(payload);
});

router.post("/:linkKey/logs/:attemptId/cancel", async (req: Request, res: Response) => {
  assertNoMonetaryFields(req.body);
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  const body = parseOrThrow(cancelSchema, req.body ?? {});
  const payload = await callCore({
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/cancel`,
    body,
  });
  res.json(payload);
});

router.post("/:linkKey/logs/:attemptId/client-event", async (req: Request, res: Response) => {
  assertNoMonetaryFields(req.body);
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  const body = parseOrThrow(clientEventSchema, req.body);
  const payload = await callCore({
    targetUrls: linkTargetUrls(linkKey),
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/client-event`,
    body,
  });
  res.json(payload);
});

// --- Sandbox checkout inspector (v38) ------------------------------------

const sandboxAccountParamsSchema = z.object({
  linkKey: zLinkKey,
  accountId: z.string().min(1).max(128),
});

const sandboxPatchSchema = z
  .object({
    availableBalanceLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    deltaLyd: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/).optional(),
    dailyLimitLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    dailySpentLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).optional(),
    staticOtp: z.string().regex(/^\d{4,8}$/).nullable().optional(),
    presetFault: z.string().max(64).nullable().optional(),
    quickPreset: z.enum(["SET_ZERO", "SET_LINK_AMOUNT", "TOP_UP_5000", "RESET_DAILY_SPENT"]).optional(),
    linkAmountLyd: z.string().optional(),
    reason: z.string().max(255).optional(),
  })
  .strict();

const sandboxSimulateSchema = z
  .object({
    action: z.enum([
      "APPROVE_PUSH_OR_QR",
      "DECLINE_PUSH_OR_QR",
      "APPROVE_WITH_VARIANCE",
      "FIRE_WEBHOOK_NOW",
      "REPLAY_DUPLICATE_WEBHOOK",
      "FIRE_TAMPERED_WEBHOOK",
    ]),
  })
  .strict();

const assertSandboxLink = (linkKey: string): void => {
  if (!isSandboxLinkKey(linkKey)) {
    throw new ApiError(
      403,
      "SANDBOX_INSPECTOR_FORBIDDEN_ON_LIVE_LINK",
      "The checkout inspector is only available for a Sandbox (sbx_) payment link",
    );
  }
};

const sandboxCreateSchema = z
  .object({
    railCode: z.string().min(2).max(64),
    gatewayCode: z.string().min(2).max(64),
    instrumentType: z.enum(["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"]).optional(),
    identifier: z.string().min(3).max(64),
    holderName: z.string().min(2).max(120),
    secretPin: z.string().min(3).max(16).optional(),
    expiry: z.string().max(16).nullable().optional(),
    availableBalanceLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    dailyLimitLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).optional(),
    staticOtp: z.string().regex(/^\d{4,8}$/).nullable().optional(),
    notes: z.string().max(255).nullable().optional(),
  })
  .strict();

router.post("/:linkKey/sandbox-accounts", async (req: Request, res: Response) => {
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  assertSandboxLink(linkKey);
  const body = parseOrThrow(sandboxCreateSchema, req.body);
  const payload = await callCore({
    targetUrls: requireSandboxCoreBackUrls(),
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/sandbox-accounts`,
    body,
  });
  res.status(201).json(payload);
});

router.get("/:linkKey/sandbox-accounts", async (req: Request, res: Response) => {
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  assertSandboxLink(linkKey);
  const railCode = typeof req.query.railCode === "string" ? req.query.railCode : undefined;
  const payload = await callCore({
    targetUrls: requireSandboxCoreBackUrls(),
    ...baseOptions(req),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/sandbox-accounts${railCode ? `?railCode=${encodeURIComponent(railCode)}` : ""}`,
  });
  res.json(payload);
});

router.get("/:linkKey/sandbox-accounts/:accountId/movements", async (req: Request, res: Response) => {
  const { linkKey, accountId } = parseOrThrow(sandboxAccountParamsSchema, req.params);
  assertSandboxLink(linkKey);
  const payload = await callCore({
    targetUrls: requireSandboxCoreBackUrls(),
    ...baseOptions(req),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/sandbox-accounts/${encode(accountId)}/movements`,
  });
  res.json(payload);
});

router.patch("/:linkKey/sandbox-accounts/:accountId", async (req: Request, res: Response) => {
  const { linkKey, accountId } = parseOrThrow(sandboxAccountParamsSchema, req.params);
  assertSandboxLink(linkKey);
  const body = parseOrThrow(sandboxPatchSchema, req.body);
  const payload = await callCore({
    targetUrls: requireSandboxCoreBackUrls(),
    ...baseOptions(req),
    method: "PATCH",
    path: `/internal/checkout/pay/${encode(linkKey)}/sandbox-accounts/${encode(accountId)}`,
    body,
  });
  res.json(payload);
});

router.get("/:linkKey/logs/:attemptId/sandbox-inspector", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  assertSandboxLink(linkKey);
  const payload = await callCore({
    targetUrls: requireSandboxCoreBackUrls(),
    ...baseOptions(req),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/sandbox-inspector`,
  });
  res.json(payload);
});

router.post("/:linkKey/logs/:attemptId/sandbox-simulate", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  assertSandboxLink(linkKey);
  const body = parseOrThrow(sandboxSimulateSchema, req.body);
  const payload = await callCore({
    targetUrls: requireSandboxCoreBackUrls(),
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/sandbox-simulate`,
    body,
  });
  res.json(payload);
});

export const payRouter = router;
