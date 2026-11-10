import express from "express";
import rateLimiter from "express-rate-limit";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { applicationsRouter } from "./applications";
import { cashoutsRouter } from "./cashouts";
import { credentialSetsRouter } from "./credentialSets";
import { disputesRouter } from "./disputes";
import { linksRouter } from "./links";
import { paymentsRouter } from "./payments";
import { posRouter } from "./pos";
import { statsRouter } from "./stats";
import { tokensRouter } from "./tokens";
import { usersRouter } from "./users";
import { walletsRouter } from "./wallets";
import { webhooksRouter } from "./webhooks";
import { reportEngineRouter } from "./reportEngine";

const router = express.Router();

const apiLimiter = lazyLimiter(() => rateLimiter({
  windowMs: env.API_RATE_LIMIT_WINDOW_MS,
  max: () => env.API_RATE_LIMIT_MAX,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many merchant portal requests, please retry later",
    });
  },
}));

router.use(apiLimiter);

router.use("/wallets", walletsRouter);
router.use("/applications", applicationsRouter);
router.use("/links", linksRouter);
router.use("/pos", posRouter);
router.use("/payments", paymentsRouter);
router.use("/disputes", disputesRouter);
router.use("/cashouts", cashoutsRouter);
router.use("/tokens", tokensRouter);
router.use("/credential-sets", credentialSetsRouter);
router.use("/users", usersRouter);
router.use("/stats", statsRouter);
router.use("/webhooks", webhooksRouter);
router.use("/report-engine", reportEngineRouter);

export const protectedRouter = router;
