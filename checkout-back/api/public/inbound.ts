import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseOrThrow } from "../../lib/error";
import { callCoreRaw, type CoreHttpMethod } from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";

const router = express.Router();

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
]);

const EDGE_OWNED_HEADERS = new Set([
  "x-request-id",
  "x-real-client-ip",
  "x-client-user-agent",
  "x-edge-service",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
]);

export const pickForwardableHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> => {
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (EDGE_OWNED_HEADERS.has(name)) continue;
    if (value === undefined) continue;
    forwarded[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return forwarded;
};

const paramsSchema = z.object({
  gateway: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "invalid gateway identifier"),
  env: z.enum(["sandbox", "test", "uat", "live", "production"]),
  pathToken: z
    .string()
    .min(4)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/, "invalid inbound path token"),
});

const inboundLimiter = rateLimiter({
  windowMs: 60_000,
  max: () => env.INBOUND_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Inbound webhook rate limit exceeded",
    });
  },
});

let rawParser: express.RequestHandler | undefined;

const getRawParser = (): express.RequestHandler => {
  rawParser ??= express.raw({
    type: () => true,
    limit: env.MAX_INBOUND_BODY_BYTES,
  });
  return rawParser;
};

router.use((req, res, next) => {
  getRawParser()(req, res, next);
});
router.use(inboundLimiter);

router.all("/:gateway/:env/:pathToken", async (req: Request, res: Response) => {
  const params = parseOrThrow(paramsSchema, req.params);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const contentType = req.headers["content-type"];
  const response = await callCoreRaw({
    method: req.method as CoreHttpMethod,
    path: `/internal/checkout/inbound/${encodeURIComponent(params.gateway)}/${encodeURIComponent(params.env)}/${encodeURIComponent(params.pathToken)}`,
    rawBody: raw,
    rawContentType: typeof contentType === "string" ? contentType : undefined,
    headers: pickForwardableHeaders(req.headers),
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    timeoutMs: 10_000,
  });
  res.status(response.statusCode);
  const responseType = response.headers["content-type"];
  if (typeof responseType === "string") res.setHeader("content-type", responseType);
  res.send(response.body);
});

export const inboundRouter = router;
