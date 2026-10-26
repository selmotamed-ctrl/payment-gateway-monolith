import cors from "cors";
import express from "express";
import { apiRouter } from "./api";
import { enforceLanAccess } from "./api/middleware/lanGuard";
import { env } from "./lib/env";
import { apiErrorHandler, notFoundHandler } from "./lib/error";
import { requestLoggerMiddleware } from "./lib/requestLogger";

export const createApp = () => {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(cors({ origin: true, credentials: false }));
  app.use(requestLoggerMiddleware);
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "admin-back", uptime: process.uptime() });
  });
  app.use(express.json({ limit: env.MAX_JSON_BODY_BYTES }));
  app.use(express.urlencoded({ extended: false, limit: env.MAX_JSON_BODY_BYTES }));
  app.use("/api/v1/admin", enforceLanAccess, apiRouter);
  app.use(notFoundHandler);
  app.use(apiErrorHandler);
  return app;
};

export const start = () => {
  const app = createApp();
  return app.listen(env.PORT, env.ADMIN_BIND_HOST, () => {
    console.log(`admin-back listening on ${env.ADMIN_BIND_HOST}:${env.PORT} (LAN only)`);
  });
};

if (import.meta.main) {
  start();
}
