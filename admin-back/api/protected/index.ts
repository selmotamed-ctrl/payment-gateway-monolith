import express from "express";
import rateLimiter from "express-rate-limit";
import { env } from "../../lib/env";
import { requireSession } from "../middleware/authorityGuard";
import { academyRouter } from "./academy";
import { amlRouter } from "./aml";
import { approvalsRouter } from "./approvals";
import { assetsRouter } from "./assets";
import { credentialSetsRouter } from "./credentialSets";
import { financeRouter } from "./finance";
import { gatewaysRouter, gatewayVersionsRouter } from "./gateways";
import { joinRequestsRouter, kybRouter } from "./joinRequests";
import { merchantsRouter } from "./merchants";
import { operationsRouter } from "./operations";
import { railsRouter, routesRouter } from "./rails";
import { reconciliationRouter } from "./reconciliation";
import { settingsRouter } from "./settings";
import { optionsRouter } from "./options";
import { statsRouter } from "./stats";
import { usersRouter } from "./users";

const router = express.Router();

const adminLimiter = rateLimiter({
  windowMs: 60_000,
  max: () => env.ADMIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many admin requests, please retry later",
    });
  },
});

router.use(adminLimiter);
router.use(requireSession);

router.use("/academy", academyRouter);
router.use("/users", usersRouter);
router.use("/join-requests", joinRequestsRouter);
router.use("/merchants", merchantsRouter);
router.use("/approvals", approvalsRouter);
router.use("/aml", amlRouter);
router.use("/gateways", gatewaysRouter);
router.use("/gateway-versions", gatewayVersionsRouter);
router.use("/credential-sets", credentialSetsRouter);
router.use("/rails", railsRouter);
router.use("/routes", routesRouter);
router.use("/assets", assetsRouter);
router.use("/reconciliation", reconciliationRouter);
router.use("/settings", settingsRouter);
router.use("/options", optionsRouter);
router.use("/stats", statsRouter);
router.use("/", kybRouter);
router.use("/", operationsRouter);
router.use("/", financeRouter);

export const protectedRouter = router;
