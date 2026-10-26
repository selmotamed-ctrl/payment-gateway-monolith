import express from "express";
import rateLimiter from "express-rate-limit";

const limiterMiddleware = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
});

const router = express.Router();
router.use(limiterMiddleware);

export const publicRouter = router;
