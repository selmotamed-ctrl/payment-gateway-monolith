import { Router } from "express";
import { portalAuthGuard } from "../middleware/portalAuthGuard";
import { createAuthRouter } from "./auth";
import { createTransactionsRouter } from "./transactions";
import { createScenariosRouter } from "./scenarios";
import { createWebhooksRouter } from "./webhooks";
import { createStatementsRouter } from "./statements";
import { createSeederSyncRouter } from "./seederSync";
import { createHostedRouter } from "./hosted";

export const createPortalRouter = (): Router => {
  const router = Router();
  router.use(portalAuthGuard);
  router.use("/hosted", createHostedRouter());
  router.use("/auth", createAuthRouter());
  router.use("/transactions", createTransactionsRouter());
  router.use("/scenarios", createScenariosRouter());
  router.use("/webhooks", createWebhooksRouter());
  router.use("/statements", createStatementsRouter());
  router.use("/internal", createSeederSyncRouter());
  return router;
};
