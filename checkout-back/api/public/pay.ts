import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { callCore, proxyCoreStream, type CoreCallOptions } from "../../lib/mtlsClient";
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

const baseOptions = (req: Request, plane?: "LIVE" | "SANDBOX"): CoreCallOptions => {
  const sandboxPin = req.header("x-pg-sandbox-pin");
  return {
    method: "GET",
    path: "",
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    plane,
    ...(sandboxPin ? { headers: { "x-pg-sandbox-pin": sandboxPin } } : {}),
  };
};

const planeForLink = (linkKey: string): "LIVE" | "SANDBOX" | undefined =>
  linkKey.startsWith("sbx_") ? "SANDBOX" : undefined;

const encode = (value: string): string => encodeURIComponent(value);

router.get("/:linkKey", async (req: Request, res: Response) => {
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  const payload = await callCore({
    ...baseOptions(req, planeForLink(linkKey)),
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
    ...baseOptions(req, planeForLink(linkKey)),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/initiate`,
    body,
  });
  res.status(201).json(payload);
});

const assertSandboxLink = (linkKey: string): void => {
  if (!linkKey.startsWith("sbx_")) {
    throw new ApiError(403, "SANDBOX_ONLY_ENDPOINT", "This endpoint is only available for sandbox payment links");
  }
};

router.get("/:linkKey/sandbox-accounts", async (req: Request, res: Response) => {
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  assertSandboxLink(linkKey);
  const query = typeof req.query.railCode === "string"
    ? `?railCode=${encodeURIComponent(req.query.railCode)}`
    : "";
  const payload = await callCore({
    ...baseOptions(req, planeForLink(linkKey)),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/sandbox-accounts${query}`,
  });
  res.json(payload);
});

router.patch("/:linkKey/sandbox-accounts/:accountId", async (req: Request, res: Response) => {
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  assertSandboxLink(linkKey);
  const accountId = String(req.params.accountId ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) {
    throw new ApiError(400, "SANDBOX_ACCOUNT_ID_INVALID", "The sandbox account id is invalid");
  }
  const payload = await callCore({
    ...baseOptions(req, planeForLink(linkKey)),
    method: "PATCH",
    path: `/internal/checkout/pay/${encode(linkKey)}/sandbox-accounts/${encode(accountId)}`,
    body: req.body,
  });
  res.json(payload);
});

router.get("/:linkKey/sandbox-accounts/:accountId/movements", async (req: Request, res: Response) => {
  const { linkKey } = parseOrThrow(paramsSchema, req.params);
  assertSandboxLink(linkKey);
  const accountId = String(req.params.accountId ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) {
    throw new ApiError(400, "SANDBOX_ACCOUNT_ID_INVALID", "The sandbox account id is invalid");
  }
  const payload = await callCore({
    ...baseOptions(req, planeForLink(linkKey)),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/sandbox-accounts/${encode(accountId)}/movements`,
  });
  res.json(payload);
});

router.post("/:linkKey/logs/:attemptId/sandbox-simulate", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  assertSandboxLink(linkKey);
  const payload = await callCore({
    ...baseOptions(req, planeForLink(linkKey)),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/sandbox-simulate`,
    body: req.body,
  });
  res.json(payload);
});

router.get("/:linkKey/logs/:attemptId", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  const payload = await callCore({
    ...baseOptions(req, planeForLink(linkKey)),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}`,
  });
  res.json(payload);
});

router.get("/:linkKey/logs/:attemptId/status", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  await proxyCoreStream(req, res, {
    ...baseOptions(req, planeForLink(linkKey)),
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
    ...baseOptions(req, planeForLink(linkKey)),
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
    ...baseOptions(req, planeForLink(linkKey)),
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
    ...baseOptions(req, planeForLink(linkKey)),
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
    ...baseOptions(req, planeForLink(linkKey)),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/client-event`,
    body,
  });
  res.json(payload);
});

export const payRouter = router;
