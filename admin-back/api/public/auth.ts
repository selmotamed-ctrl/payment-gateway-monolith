import express from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { zMfaCode, zPassword } from "../../lib/zReady";
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
  coreForward({
    method: "POST",
    path: () => "/internal/admin/auth/mfa",
    schema: mfaSchema,
  }),
);

export const adminAuthRouter = router;
export const adminPasswordSchema = zPassword;
