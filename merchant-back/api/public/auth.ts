import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { zEmail, zMfaCode, zPassword, zPhone } from "../../lib/zReady";
import {
  coreGoogleSchema,
  coreLoginSchema,
  coreMfaSchema,
  coreRegisterSchema,
  coreVerifyIdentitySchema,
} from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const authLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: () => env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many authentication attempts, please retry later",
    });
  },
});

router.use(authLimiter);

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

router.post(
  "/login",
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

router.post(
  "/mfa/verify",
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
