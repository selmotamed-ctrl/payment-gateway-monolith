import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseOrThrow } from "../../lib/error";
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

const payLimiter = rateLimiter({
  windowMs: 60_000,
  max: () => env.PAY_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many checkout requests, please retry later",
    });
  },
});

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
    ...baseOptions(req),
    method: "GET",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}`,
  });
  res.json(payload);
});

router.get("/:linkKey/logs/:attemptId/status", async (req: Request, res: Response) => {
  const { linkKey, attemptId } = parseOrThrow(attemptParamsSchema, req.params);
  await proxyCoreStream(req, res, {
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
    ...baseOptions(req),
    method: "POST",
    path: `/internal/checkout/pay/${encode(linkKey)}/logs/${encode(attemptId)}/client-event`,
    body,
  });
  res.json(payload);
});

export const payRouter = router;
