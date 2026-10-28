import cors from "cors";
import express from "express";
import { apiRouter } from "./api";
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
    res.json({ status: "ok", service: "merchant-back", uptime: process.uptime() });
  });
  app.use(express.json({ limit: env.MAX_JSON_BODY_BYTES }));
  app.use(express.urlencoded({ extended: false, limit: env.MAX_JSON_BODY_BYTES }));
  app.use("/api/v1", apiRouter);
  app.use(notFoundHandler);
  app.use(apiErrorHandler);
  return app;
};

export const start = () => {
  const app = createApp();
  return app.listen(env.PORT, env.BIND_HOST, () => {
    console.log(`merchant-back listening on ${env.BIND_HOST}:${env.PORT}`);
  });
};

if (import.meta.main) {
  start();
}
