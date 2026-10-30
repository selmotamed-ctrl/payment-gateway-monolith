import express from "express";
import http from "node:http";
import { createApiRouter } from "./api";
import { env } from "./lib/env";
import { requestLoggerMiddleware } from "./lib/requestLogger";
import { getDb } from "./engine/db";
import { listScenarios } from "./engine/chaos/scenarioStore";
import { webhookDispatcher } from "./engine/webhooks/WebhookDispatcher";
import { broadcast } from "./api/portal/eventHub";

export const createApp = () => {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
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
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  return server;
};

if (import.meta.main || process.env.NODE_ENV !== "test") {
  await start();
}
