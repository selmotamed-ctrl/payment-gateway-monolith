import express from "express";
import { ApiError, errorCodePrefixer, parseOrThrow } from "../../lib/error";
import rateLimiter from "express-rate-limit";
import z from "zod";
import { nationalIdRegex, passportRegex, zPhone } from "../../lib/zReady";
import { client } from "../../prisma/client";

const limiterMiddleware = rateLimiter({
  windowMs: 60 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 requests per windowMs
  standardHeaders: true, // return rate limit info in RateLimit-* headers
  legacyHeaders: false, // disable X-RateLimit-* headers
  message: "Too many requests, please try again later.",
});

const router = express.Router();
router.use(limiterMiddleware);



export const publicRouter = router;
