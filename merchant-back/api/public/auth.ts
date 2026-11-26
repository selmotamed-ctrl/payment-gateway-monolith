import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { createAccountLimiters, type AccountKey } from "../../lib/authLimiters";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { zEmail, zMfaCode, zPassword, zPhone } from "../../lib/zReady";
import {
  coreEmailResendSchema,
  coreEmailVerifySchema,
  coreGoogleExchangeSchema,
  coreGoogleSchema,
  coreInvitationAcceptSchema,
  coreLoginSchema,
  coreMfaResendSchema,
  coreMfaSchema,
  corePasswordForgotSchema,
  corePasswordResetSchema,
  coreRegisterSchema,
  coreVerifyIdentitySchema,
} from "../contract";
import { captureSessionToken, logoutHandler } from "../../lib/security/sessionCookie";
import { coreCallContext, coreForward } from "../forward";
import { callCore } from "../../lib/coreInternalClient";
import { targetUrlsForRequest } from "../../lib/corePools";

const router = express.Router();

const limited = (_req: Request, res: Response) => {
  res.status(429).json({
    code: "RATE_LIMITED",
    message: "Too many authentication attempts, please retry later",
  });
};

/** Per verified client ip (trusted-proxy aware resolution, never a raw header). */
const authLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    max: () => env.AUTH_RATE_LIMIT_MAX,
    keyGenerator: (req) => rateLimitKey(req),
    standardHeaders: true,
    legacyHeaders: false,
    handler: limited,
  }),
);

const accountOf = (req: Request): AccountKey | undefined => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const field of ["identifier", "email", "phone", "challengeId"]) {
    const value = body[field];
    if (typeof value === "string" && value.length > 0) {
      return { kind: field === "challengeId" ? "challenge" : "account", value: value.toLowerCase().trim() };
    }
  }
  return undefined;
};

/** Per account and address (and an account-wide ceiling), counting failures only: see `lib/authLimiters.ts`. */
const accountLimiters = createAccountLimiters(accountOf);

// Logout is deliberately outside the login limiter (see admin-back).
router.post("/logout", logoutHandler);

router.use(authLimiter);
router.use(accountLimiters.perAddress, accountLimiters.ceiling);

const registerSchema = z
  .object({
    email: zEmail,
    password: zPassword,
    fullName: z.string().min(2).max(120),
    locale: z.enum(["ar", "en"]).optional(),
  })
  .strict();

const verifyIdentitySchema = z
  .object({
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
    identityNumber: z.string().min(4).max(32),
    phone: zPhone,
    code: z.string().regex(/^\d{4,8}$/),
  })
  .strict();

const loginSchema = z
  .object({
    identifier: z.string().min(3).max(128),
    password: z.string().min(1).max(128),
  })
  .strict();

const googleStartSchema = z
  .object({
    mode: z.enum(["login", "register"]).optional(),
    returnPath: z.enum(["/login", "/register"]).optional(),
    redirectUri: z.string().max(512).optional(),
  })
  .strict();

const googleCallbackQuerySchema = z.object({ code: z.string().min(8).max(4096), state: z.string().min(8).max(256) }).strict();

const googleExchangeSchema = z.object({ ticket: z.string().min(16).max(512) }).strict();

const emailVerifySchema = z.object({ email: zEmail, code: z.string().regex(/^\d{6}$/) }).strict();

const emailResendSchema = z.object({ email: zEmail }).strict();

const passwordForgotSchema = z.object({ email: zEmail }).strict();

const passwordResetSchema = z
  .object({ email: zEmail, code: z.string().regex(/^\d{6}$/), newPassword: zPassword })
  .strict();

const mfaSchema = z
  .object({
    code: zMfaCode,
    challengeId: z.string().min(4).max(128).optional(),
  })
  .strict();

const mfaResendSchema = z.object({ challengeId: z.string().uuid() }).strict();

router.post(
  "/register",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/register",
    schema: registerSchema,
    coreSchema: coreRegisterSchema,
    requireAuth: false,
    status: 201,
  }),
);

router.post(
  "/verify-identity",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/verify-identity",
    schema: verifyIdentitySchema,
    coreSchema: coreVerifyIdentitySchema,
    requireAuth: false,
  }),
);

const acceptInvitationSchema = z
  .object({
    token: z.string().min(16).max(256),
    password: zPassword,
  })
  .strict();

router.post(
  "/accept-invitation",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/accept-invitation",
    schema: acceptInvitationSchema,
    coreSchema: coreInvitationAcceptSchema,
    requireAuth: false,
  }),
);

router.post(
  "/login",
  captureSessionToken,
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/login",
    schema: loginSchema,
    coreSchema: coreLoginSchema,
    requireAuth: false,
  }),
);

router.post(
  "/google/start",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/google/start",
    schema: googleStartSchema,
    coreSchema: coreGoogleSchema,
    requireAuth: false,
  }),
);

// Legacy alias used by the first frontend build.
router.post(
  "/google",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/google",
    schema: googleStartSchema,
    coreSchema: coreGoogleSchema,
    requireAuth: false,
  }),
);

router.get("/google/callback", async (req: Request, res: Response): Promise<void> => {
  const query = parseOrThrow(googleCallbackQuerySchema, req.query);
  try {
    const result = await callCore<{ redirectPath?: string; errorPath?: string }>({
      ...coreCallContext(req),
      targetUrls: targetUrlsForRequest(req),
      method: "GET",
      path: "/internal/merchant/auth/google/callback",
      query,
    });
    res.redirect(302, result.redirectPath ?? result.errorPath ?? "/login?error=GOOGLE_LOGIN_FAILED");
  } catch {
    res.redirect(302, "/login?error=GOOGLE_LOGIN_FAILED");
  }
});

router.post(
  "/google/exchange",
  captureSessionToken,
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/google/exchange",
    schema: googleExchangeSchema,
    coreSchema: coreGoogleExchangeSchema,
    requireAuth: false,
  }),
);

router.post(
  "/email/verify",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/email/verify",
    schema: emailVerifySchema,
    coreSchema: coreEmailVerifySchema,
    requireAuth: false,
  }),
);

router.post(
  "/email/resend",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/email/resend",
    schema: emailResendSchema,
    coreSchema: coreEmailResendSchema,
    requireAuth: false,
    status: 202,
  }),
);

router.post(
  "/password/forgot",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/password/forgot",
    schema: passwordForgotSchema,
    coreSchema: corePasswordForgotSchema,
    requireAuth: false,
    status: 202,
  }),
);

router.post(
  "/password/reset",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/password/reset",
    schema: passwordResetSchema,
    coreSchema: corePasswordResetSchema,
    requireAuth: false,
  }),
);

router.get(
  "/me",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/auth/me",
    requireAuth: false,
  }),
);

router.post(
  "/mfa/verify",
  captureSessionToken,
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/mfa/verify",
    schema: mfaSchema,
    coreSchema: coreMfaSchema,
    requireAuth: false,
  }),
);

router.post(
  "/mfa/resend",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/mfa/resend",
    schema: mfaResendSchema,
    coreSchema: coreMfaResendSchema,
    requireAuth: false,
  }),
);

export const authRouter = router;

export const requireAuthHeader = (req: Request, _res: Response, next: () => void) => {
  if (!req.headers.authorization) {
    next();
    return;
  }
  next();
};
