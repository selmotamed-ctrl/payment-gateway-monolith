import express from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { createAccountLimiters, type AccountKey } from "../../lib/authLimiters";
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

const accountOf = (req: express.Request): AccountKey | undefined => {
  const identifier = bodyField(req, "identifier");
  if (identifier) return { kind: "account", value: identifier };
  const challenge = bodyField(req, "challengeId");
  return challenge ? { kind: "challenge", value: challenge } : undefined;
};

/** Per account and address (and an account-wide ceiling), counting failures only: see `lib/authLimiters.ts`. */
const accountLimiters = createAccountLimiters(accountOf);

// Logout is deliberately outside the login limiter: a page load with several
// expired requests triggers it, and it must not consume the login budget.
router.post("/logout", logoutHandler);

router.use(authLimiter);
router.post(["/login", "/mfa"], accountLimiters.perAddress, accountLimiters.ceiling);

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

/**
 * Public: a staff invitee accepts the invitation emailed to them and chooses their own password and the
 * optional phone for SMS. The account stays INVITED until a checker approves activation.
 */
const mfaResendSchema = z.object({ challengeId: z.string().uuid() }).strict();

const acceptInvitationSchema = z
  .object({
    token: z.string().min(16).max(256),
    password: zPassword,
    /** Optional: email is the primary MFA channel; a phone adds SMS as a secondary channel. */
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/).optional(),
  })
  .strict();

const passwordForgotSchema = z.object({ email: z.string().email() }).strict();

const passwordResetSchema = z
  .object({
    email: z.string().email(),
    code: z.string().regex(/^\d{6}$/),
    newPassword: zPassword,
  })
  .strict();

router.post(
  "/accept-invitation",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/auth/accept-invitation",
    schema: acceptInvitationSchema,
  }),
);

router.post(
  "/mfa/resend",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/auth/mfa/resend",
    schema: mfaResendSchema,
  }),
);

router.post(
  "/password/forgot",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/auth/password/forgot",
    schema: passwordForgotSchema,
    status: 202,
  }),
);

router.post(
  "/password/reset",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/auth/password/reset",
    schema: passwordResetSchema,
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
