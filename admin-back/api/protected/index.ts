import express from "express";
import rateLimiter from "express-rate-limit";
import { env } from "../../lib/env";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { requireAuthoritiesByMethod, requireSession } from "../middleware/authorityGuard";
import { academyRouter } from "./academy";
import { amlRouter } from "./aml";
import { approvalsRouter } from "./approvals";
import { assetsRouter } from "./assets";
import { backupsRouter } from "./backups";
import { credentialSetsRouter } from "./credentialSets";
import { financeRouter } from "./finance";
import { gatewaysRouter, gatewayVersionsRouter } from "./gateways";
import { joinRequestsRouter } from "./joinRequests";
import { kybReviewRouter } from "./kybReview";
import { merchantsRouter } from "./merchants";
import { operationsRouter } from "./operations";
import { railsRouter, routesRouter } from "./rails";
import { reconciliationRouter } from "./reconciliation";
import { settingsRouter } from "./settings";
import { optionsRouter } from "./options";
import { statsRouter } from "./stats";
import { auditLogsRouter } from "./auditLogs";
import { usersRouter } from "./users";
import { searchRouter } from "./search";

const router = express.Router();

const adminLimiter = lazyLimiter(() => rateLimiter({
  windowMs: env.ADMIN_RATE_LIMIT_WINDOW_MS,
  max: () => env.ADMIN_RATE_LIMIT_MAX,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many admin requests, please retry later",
    });
  },
}));

router.use(adminLimiter);
router.use(requireSession);

/**
 * Edge deny-by-default authority requirements. They mirror the any-of lists core enforces on
 * the same routes (core-back/api/internal/admin.ts); core stays the authority and re-verifies
 * the session, the edge only refuses credentials that cannot possibly satisfy the route.
 * Mounts that are not listed here (search, academy, options, stats) are left to core.
 */
const guard = requireAuthoritiesByMethod;
const kybGuard = guard({
  read: ["kyb:read", "compliance:read"],
  write: ["kyb:write", "compliance:write"],
});
const gatewayGuard = guard({ read: ["gateway:read"], write: ["gateway:write", "gateway:test"] });

router.use("/search", searchRouter);
router.use("/academy", academyRouter);
router.use(
  "/users",
  guard({ read: ["user:read", "security:read"], write: ["user:write", "security:write"] }),
  usersRouter,
);
router.use("/join-requests", kybGuard, joinRequestsRouter);
router.use("/merchants", guard({ read: ["merchant:read"], write: ["merchant:write"] }), merchantsRouter);
router.use(
  "/approvals",
  guard({ read: ["approval:read"], write: ["approval:check", "approval:write"] }),
  approvalsRouter,
);
router.use("/aml", amlRouter);
router.use("/gateways", gatewayGuard, gatewaysRouter);
router.use("/gateway-versions", gatewayGuard, gatewayVersionsRouter);
router.use(
  "/credential-sets",
  guard({ read: ["credential:read", "gateway:read"], write: ["credential:write", "gateway:write"] }),
  credentialSetsRouter,
);
router.use("/rails", gatewayGuard, railsRouter);
router.use("/routes", gatewayGuard, routesRouter);
router.use("/assets", gatewayGuard, assetsRouter);
router.use(
  "/reconciliation",
  guard({ read: ["reconciliation:read"], write: ["reconciliation:write"] }),
  reconciliationRouter,
);
router.use(
  "/settings",
  guard({ read: ["settings:read"], write: ["settings:write"], readPaths: [/^\/restore-preview\/?$/] }),
  settingsRouter,
);
router.use("/options", optionsRouter);
router.use("/stats", statsRouter);
router.use("/audit-logs", guard({ read: ["security:read"], write: ["security:read"] }), auditLogsRouter);
router.use("/kyb-documents", kybGuard, kybReviewRouter);
router.use("/system/backups", backupsRouter);
router.use(
  ["/operator-cases", "/gateway-inquiries"],
  guard({
    read: ["case:read", "operator:read"],
    write: ["case:write", "operator:write", "attempt:inquire"],
  }),
);
router.use("/attempts", guard({ read: ["attempt:read"], write: ["attempt:inquire"] }));
router.use("/", operationsRouter);
router.use("/disputes", guard({ read: ["dispute:read"], write: ["dispute:write"] }));
router.use("/adjustments", guard({ read: ["finance:read"], write: ["finance:write"] }));
router.use("/cashouts", guard({ read: ["cashout:read"], write: ["cashout:review", "finance:write"] }));
router.use(
  "/commission-profiles",
  guard({ read: ["commission:read", "finance:read"], write: ["commission:write"] }),
);
router.use(
  "/velocity-rules",
  guard({ read: ["velocity:read", "compliance:read"], write: ["velocity:write", "compliance:write"] }),
);
router.use("/finance", guard({ read: ["finance:read"], write: ["finance:write"] }));
router.use("/", financeRouter);

export const protectedRouter = router;
