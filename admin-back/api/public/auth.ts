import express from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { digestKeyPart, lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { zMfaCode, zPassword } from "../../lib/zReady";
import { captureSessionToken, logoutHandler } from "../../lib/security/sessionCookie";
import { coreForward } from "../forward";

const router = express.Router();

const limited = (_req: express.Request, res: express.Response) => {
  res.status(429).json({
    code: "RATE_LIMITED",
    message: "Too many authentication attempts, please retry later",
  });
};

/** Per client ip (resolved through the trusted proxy list, never a raw header). */
const authLimiter = lazyLimiter(() => rateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: () => env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: limited,
}));

const bodyField = (req: express.Request, field: string): string | undefined => {
  const value = (req.body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" && value.length > 0 ? value.toLowerCase().trim() : undefined;
};

/**
 * Per account, independent of the client ip, so a distributed guessing run against one
 * identifier (login) or one mfa challenge is throttled as well.
 */
const accountLimiter = lazyLimiter(() => rateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: () => env.AUTH_RATE_LIMIT_MAX,
  skip: (req) => bodyField(req, "identifier") === undefined && bodyField(req, "challengeId") === undefined,
  keyGenerator: (req) =>
    `account:${digestKeyPart(bodyField(req, "identifier") ?? bodyField(req, "challengeId") ?? "")}`,
  validate: { keyGeneratorIpFallback: false },
  standardHeaders: false,
  legacyHeaders: false,
  handler: limited,
}));

// Logout is deliberately outside the login limiter: a page load with several
// expired requests triggers it, and it must not consume the login budget.
router.post("/logout", logoutHandler);

router.use(authLimiter);
router.post(["/login", "/mfa"], accountLimiter);

const loginSchema = z
  .object({
    identifier: z.string().min(3).max(160),
    password: z.string().min(1).max(128),
  })
  .strict();

const mfaSchema = z
  .object({
    challengeId: z.string().min(4).max(128).optional(),
    code: zMfaCode,
  })
  .strict();

router.post(
  "/login",
  captureSessionToken,
  coreForward({
    method: "POST",
    path: () => "/internal/admin/auth/login",
    schema: loginSchema,
  }),
);

router.get(
  "/me",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/auth/me",
  }),
);

router.post(
  "/mfa",
  captureSessionToken,
  coreForward({
    method: "POST",
    path: () => "/internal/admin/auth/mfa",
    schema: mfaSchema,
  }),
);

export const adminAuthRouter = router;
export const adminPasswordSchema = zPassword;
