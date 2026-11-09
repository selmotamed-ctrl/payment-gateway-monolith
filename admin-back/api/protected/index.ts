import express from "express";
import rateLimiter from "express-rate-limit";
import { env } from "../../lib/env";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { requireAuthoritiesByMethod, requireSession } from "../middleware/authorityGuard";
import { academyRouter } from "./academy";
import { amlRouter } from "./aml";
import { approvalsRouter } from "./approvals";
import { applicationsRouter, paymentLinksRouter, posTerminalsRouter } from "./applications";
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
import { systemRouter } from "./system";
import { inboundEventsRouter, transactionsRouter } from "./transactions";
import { walletsRouter } from "./wallets";
import { reportEngineRouter } from "./reportEngine";

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
const merchantGuard = guard({ read: ["merchant:read"], write: ["merchant:write"] });
// Beneficial owners and KYB revalidations are compliance data: core accepts `kyb:write` or `merchant:write`.
const merchantKybGuard = guard({ read: ["merchant:read", "kyb:read"], write: ["kyb:write", "merchant:write"] });
router.use(
  "/merchants",
  (req, res, next) =>
    (/^\/[^/]+\/(beneficial-owners|revalidations)(\/|$)/.test(req.path) ? merchantKybGuard : merchantGuard)(
      req,
      res,
      next,
    ),
  merchantsRouter,
);
// Wallet, application, payment link and POS containment: read `merchant:read`, mutate `merchant:write`.
const merchantOpsGuard = guard({ read: ["merchant:read"], write: ["merchant:write"] });
router.use("/wallets", merchantOpsGuard, walletsRouter);
router.use("/applications", merchantOpsGuard, applicationsRouter);
router.use("/payment-links", merchantOpsGuard, paymentLinksRouter);
router.use("/pos-terminals", merchantOpsGuard, posTerminalsRouter);
// Read-only monitors. They have no mutating routes, so the write list denies every non-read method.
router.use(
  "/transactions",
  guard({ read: ["attempt:read", "merchant:read", "finance:read"], write: ["attempt:inquire"] }),
  transactionsRouter,
);
router.use(
  "/inbound-events",
  guard({ read: ["attempt:read", "case:read"], write: ["attempt:inquire"] }),
  inboundEventsRouter,
);
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
router.use("/system", guard({ read: ["security:read"], write: ["security:write"] }), systemRouter);
router.use(
  "/report-engine",
  guard({
    read: ["report:review", "report_engine:author", "report_engine:run", "gateway:write", "security:read"],
    write: ["report:approve", "report_engine:author", "report:review", "security:write"],
  }),
  reportEngineRouter,
);
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
