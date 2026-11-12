import express from "express";
import { apiRouter } from "./api";
import { enforceLanAccess } from "./api/middleware/lanGuard";
import { env } from "./lib/env";
import { apiErrorHandler, notFoundHandler } from "./lib/error";
import { requestLoggerMiddleware } from "./lib/requestLogger";
import { corsAllowList, securityHeaders } from "./lib/security";

export const createApp = () => {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(securityHeaders);
  app.use(corsAllowList());
  app.use(requestLoggerMiddleware);
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "admin-back", release: process.env.APP_RELEASE ?? null, commit: process.env.APP_COMMIT ?? null, uptime: process.uptime() });
  });
  // Report-engine authoring bodies carry a base64 asset zip. That prefix is
  // parsed with a larger route-scoped limit; every other route keeps the
  // standard JSON cap (B02).
  const reportEngineJson = express.json({ limit: "24mb" });
  const defaultJson = express.json({ limit: env.MAX_JSON_BODY_BYTES });
  app.use((request, response, next) => {
    const parser = /^\/api\/v1\/admin\/report-engine(\/|$)/.test(request.path)
      ? reportEngineJson
      : defaultJson;
    parser(request, response, next);
  });
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
