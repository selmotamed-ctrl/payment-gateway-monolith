import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { captureRawBody, parseMultipart } from "../lib/rawBody";
import { env } from "../lib/env";
import { ApiError, isApiError, toErrorEnvelope } from "../lib/error";
import { requestLoggerMiddleware } from "../lib/requestLogger";
import { createRailsRouter } from "./rails";
import { createSdkRouter } from "./sdk";
import { createPortalRouter } from "./portal";

export const createApiRouter = (): Router => {
  const router = express.Router();

  router.use(
    express.json({
      limit: env.FAKE_RAILS_MAX_BODY_BYTES,
      verify: captureRawBody,
      type: ["application/json", "application/*+json"],
    }),
  );
  router.use(
    express.urlencoded({
      extended: true,
      limit: env.FAKE_RAILS_MAX_BODY_BYTES,
      verify: captureRawBody,
    }),
  );
  router.use(
    express.text({
      limit: env.FAKE_RAILS_MAX_BODY_BYTES,
      verify: captureRawBody,
      type: ["text/xml", "application/xml", "text/plain"],
    }),
  );
  router.use(
    express.raw({
      limit: env.FAKE_RAILS_MAX_BODY_BYTES,
      type: ["multipart/form-data", "application/octet-stream"],
    }),
  );
  router.use((request: Request, _response: Response, next: NextFunction) => {
    if (Buffer.isBuffer(request.body) && /multipart\/form-data/i.test(request.header("content-type") ?? "")) {
      request.rawBody = request.body;
      request.body = parseMultipart(request.body, request.header("content-type") ?? "");
    }
    next();
  });

  router.use("/rails/:gatewayCode", createRailsRouter());
  router.use("/sdk", createSdkRouter());
  router.use("/portal-api", createPortalRouter());

  router.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "fake-rails-back" });
  });

  router.get("/hosted/health", (_request, response) => {
    response.json({ ok: true, service: "fake-rails-hosted" });
  });

  router.use((_request, _response, next) => next(new ApiError(404, "NOT_FOUND", "Route not found")));

  router.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) return;
    const status = isApiError(error)
      ? error.statusCode
      : error instanceof SyntaxError
        ? 400
        : 500;
    if (!isApiError(error)) {
      request.logger?.error(error instanceof Error ? error.message : "unknown error");
    }
    response.status(status).json(toErrorEnvelope(error));
  });

  return router;
};
