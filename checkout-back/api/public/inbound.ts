import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { digestKeyPart, lazyLimiter, rateLimitKey, requestClientIp } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { callCoreRaw, type CoreHttpMethod } from "../../lib/mtlsClient";
import { resolveRequestId } from "../../lib/requestLogger";

const router = express.Router();

// `content-length` is deliberately absent: the body is forwarded after body-parser inflated it, so the
// inbound length would no longer describe it (request smuggling on the shared core connection).
const FORWARDABLE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "user-agent",
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

const limited = (_req: Request, res: Response) => {
  res.status(429).json({
    code: "RATE_LIMITED",
    message: "Inbound webhook rate limit exceeded",
  });
};

/** The channel the request addresses: gateway, environment and path token of the url. */
const channelOf = (req: Request): string => {
  const [gateway = "", environment = "", token = ""] = req.path.split("/").filter((part) => part.length > 0);
  return digestKeyPart(`${gateway.toLowerCase()}/${environment.toLowerCase()}/${token}`);
};

/**
 * Per verified client ip AND channel path token: one noisy channel (or one abusive client)
 * does not burn the budget of the others. Runs BEFORE the body is read.
 */
const channelLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: env.INBOUND_RATE_LIMIT_WINDOW_MS,
    max: () => env.INBOUND_RATE_LIMIT_MAX,
    keyGenerator: (req) => rateLimitKey(req, channelOf(req)),
    standardHeaders: true,
    legacyHeaders: false,
    handler: limited,
  }),
);

/** Coarse per ip ceiling over all channels, so rotating path tokens does not evade the limit. */
const clientLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: env.INBOUND_RATE_LIMIT_WINDOW_MS,
    max: () => env.INBOUND_RATE_LIMIT_MAX * 5,
    keyGenerator: (req) => rateLimitKey(req),
    standardHeaders: false,
    legacyHeaders: false,
    handler: limited,
  }),
);

/** Gateways notify with GET (callbacks / redirects) or POST (server to server webhooks). */
const ALLOWED_INBOUND_METHODS = new Set(["GET", "HEAD", "POST"]);

/** Public error vocabulary; core's own codes, messages, details and references never leave. */
const PUBLIC_INBOUND_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  badRequest: { status: 400, code: "INBOUND_REJECTED", message: "The notification was rejected" },
  notFound: { status: 404, code: "INBOUND_NOT_FOUND", message: "The inbound channel is not available" },
  conflict: { status: 409, code: "INBOUND_CONFLICT", message: "The notification conflicts with the current state" },
  tooLarge: { status: 413, code: "PAYLOAD_TOO_LARGE", message: "The notification exceeds the size limit" },
  rateLimited: { status: 429, code: "RATE_LIMITED", message: "Inbound webhook rate limit exceeded" },
  unavailable: { status: 503, code: "INBOUND_UNAVAILABLE", message: "The notification could not be processed right now" },
};

export const toPublicInboundError = (status: number): { status: number; code: string; message: string } => {
  if (status === 400 || status === 415 || status === 422) return PUBLIC_INBOUND_ERRORS.badRequest!;
  if (status === 401 || status === 403 || status === 404 || status === 410) return PUBLIC_INBOUND_ERRORS.notFound!;
  if (status === 409) return PUBLIC_INBOUND_ERRORS.conflict!;
  if (status === 413) return PUBLIC_INBOUND_ERRORS.tooLarge!;
  if (status === 429) return PUBLIC_INBOUND_ERRORS.rateLimited!;
  return PUBLIC_INBOUND_ERRORS.unavailable!;
};

let rawParser: express.RequestHandler | undefined;

const getRawParser = (): express.RequestHandler => {
  rawParser ??= express.raw({
    type: () => true,
    limit: env.MAX_INBOUND_BODY_BYTES,
  });
  return rawParser;
};

router.use((req, res, next) => {
  if (!ALLOWED_INBOUND_METHODS.has(req.method)) {
    res.setHeader("Allow", "GET, HEAD, POST");
    res.status(405).json({ code: "METHOD_NOT_ALLOWED", message: "Only GET and POST are accepted" });
    return;
  }
  next();
});
router.use(clientLimiter);
router.use(channelLimiter);
router.use((req, res, next) => {
  getRawParser()(req, res, next);
});

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
    clientIp: requestClientIp(req),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    timeoutMs: 10_000,
  }).catch((error: unknown) => {
    const status = (error as { statusCode?: number } | null)?.statusCode;
    if (status === 400 && (error as { code?: string }).code === "CORE_HEADER_INVALID") {
      throw new ApiError(400, "INBOUND_REJECTED", "The notification was rejected");
    }
    throw new ApiError(503, "INBOUND_UNAVAILABLE", PUBLIC_INBOUND_ERRORS.unavailable!.message);
  });
  if (response.statusCode >= 400) {
    const mapped = toPublicInboundError(response.statusCode);
    res.status(mapped.status).json({ code: mapped.code, message: mapped.message });
    return;
  }
  res.status(response.statusCode);
  const responseType = response.headers["content-type"];
  if (typeof responseType === "string") res.setHeader("content-type", responseType);
  res.send(response.body);
});

export const inboundRouter = router;
