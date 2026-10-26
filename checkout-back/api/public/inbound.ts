import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { callCoreRaw, type CoreHttpMethod } from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";

const router = express.Router();

const FORWARDABLE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "user-agent",
  "content-length",
  "x-signature",
  "x-gateway-signature",
  "x-hub-signature-256",
  "x-moomalat-signature",
  "x-timestamp",
  "x-nonce",
]);

export const pickForwardableHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> => {
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!FORWARDABLE_HEADER_ALLOWLIST.has(name)) continue;
    if (value === undefined) continue;
    forwarded[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return forwarded;
};

export const INBOUND_ENVIRONMENTS = ["sandbox", "test", "uat", "live", "production"] as const;

export type InboundEnvironment = (typeof INBOUND_ENVIRONMENTS)[number];
export type CoreInboundEnvironment = "SANDBOX" | "LIVE";

const CORE_ENV_BY_INBOUND_ENV: Record<InboundEnvironment, CoreInboundEnvironment> = {
  sandbox: "SANDBOX",
  test: "SANDBOX",
  uat: "SANDBOX",
  live: "LIVE",
  production: "LIVE",
};

export const translateInboundEnvironment = (value: string): CoreInboundEnvironment => {
  const key = value.trim().toLowerCase() as InboundEnvironment;
  const canonical = CORE_ENV_BY_INBOUND_ENV[key];
  if (!canonical) {
    throw new ApiError(400, "INBOUND_ENVIRONMENT_INVALID", "The inbound environment is invalid");
  }
  return canonical;
};

const paramsSchema = z.object({
  gateway: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "invalid gateway identifier"),
  env: z.enum(INBOUND_ENVIRONMENTS),
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
  const coreEnvironment = translateInboundEnvironment(params.env);
  const response = await callCoreRaw({
    method: req.method as CoreHttpMethod,
    path: `/internal/checkout/inbound/${encodeURIComponent(params.gateway)}/${coreEnvironment}/${encodeURIComponent(params.pathToken)}`,
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
