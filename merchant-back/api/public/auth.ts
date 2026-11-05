import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { digestKeyPart, lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { zEmail, zMfaCode, zPassword, zPhone } from "../../lib/zReady";
import {
  coreGoogleSchema,
  coreInvitationAcceptSchema,
  coreLoginSchema,
  coreMfaSchema,
  coreRegisterSchema,
  coreVerifyIdentitySchema,
} from "../contract";
import { captureSessionToken, logoutHandler } from "../../lib/security/sessionCookie";
import { coreForward } from "../forward";

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

const accountOf = (req: Request): string | undefined => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const field of ["identifier", "email", "phone", "challengeId"]) {
    const value = body[field];
    if (typeof value === "string" && value.length > 0) return (field === "challengeId" ? "challenge:" : "account:") + value.toLowerCase().trim();
  }
  return undefined;
};

/** Per account / mfa challenge regardless of the client ip, so distributed guessing is throttled too. */
const accountLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    max: () => env.AUTH_RATE_LIMIT_MAX,
    skip: (req) => req.method !== "POST" || accountOf(req) === undefined,
    keyGenerator: (req) => digestKeyPart(accountOf(req) ?? ""),
    standardHeaders: false,
    legacyHeaders: false,
    handler: limited,
  }),
);

router.use(authLimiter);
router.use(accountLimiter);

const registerSchema = z
  .object({
    phone: zPhone.optional(),
    email: zEmail.optional(),
    password: zPassword,
    fullName: z.string().min(2).max(120),
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]).optional(),
    identityNumber: z.string().min(4).max(32).optional(),
    locale: z.enum(["ar", "en"]).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.phone || value.email), {
    error: "a phone number or an email address is required",
    path: ["phone"],
  });

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

const googleSchema = z
  .object({
    idToken: z.string().min(20).max(4096),
  })
  .strict();

const mfaSchema = z
  .object({
    code: zMfaCode,
    challengeId: z.string().min(4).max(128).optional(),
  })
  .strict();

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

router.post("/logout", logoutHandler);

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
  "/google",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/auth/google",
    schema: googleSchema,
    coreSchema: coreGoogleSchema,
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

export const authRouter = router;

export const requireAuthHeader = (req: Request, _res: Response, next: () => void) => {
  if (!req.headers.authorization) {
    next();
    return;
  }
  next();
};
