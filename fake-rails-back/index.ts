import express from "express";
import http from "node:http";
import { createApiRouter } from "./api";
import { env } from "./lib/env";
import { parseTrustProxy, peerAllowlist } from "./lib/security";
import { requestLoggerMiddleware } from "./lib/requestLogger";
import { getDb } from "./engine/db";
import { listScenarios } from "./engine/chaos/scenarioStore";
import { startAutoApprovalScheduler } from "./engine/chaos/AutoApprovalScheduler";
import { releaseExpiredHolds } from "./engine/accounts/AccountLedgerService";
import { webhookDispatcher } from "./engine/webhooks/WebhookDispatcher";
import { broadcast } from "./api/portal/eventHub";

export const createApp = () => {
  const app = express();
  app.disable("x-powered-by");
  // Only trust X-Forwarded-* from the configured proxies (default: loopback, i.e. the local nginx).
  app.set("trust proxy", parseTrustProxy(env.FAKE_RAILS_TRUST_PROXY));
  // Real-peer network allowlist (not spoofable through X-Forwarded-For).
  app.use(peerAllowlist(env.FAKE_RAILS_ALLOWED_CIDRS));
  app.use(requestLoggerMiddleware);
  app.use(createApiRouter());
  return app;
};

export const start = async () => {
  // Touch the store so the schema is created before the first request and the
  // default scenarios exist.
  getDb();
  listScenarios();

  webhookDispatcher.setSink((event) => {
    broadcast(event.type, event);
  });

  const stopAutoApproval = startAutoApprovalScheduler();
  const holdSweeper = setInterval(() => {
    try { releaseExpiredHolds(); } catch { /* retry next tick */ }
  }, 60_000);
  (holdSweeper as unknown as { unref?: () => void }).unref?.();
  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(env.PORT, env.HOST, () => {
      console.log(
        `fake-rails-back listening on http://${env.HOST}:${env.PORT} (env=${env.NODE_ENV}, productionOptIn=${env.FAKE_RAILS_ALLOW_IN_PRODUCTION})`,
      );
      resolve();
    });
  });

  const stop = (): void => {
    stopAutoApproval();
    clearInterval(holdSweeper);
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  return server;
};

if (import.meta.main || process.env.NODE_ENV !== "test") {
  await start();
}
