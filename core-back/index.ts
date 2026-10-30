import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import http from "node:http";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { apiRouter, internalRouter } from "./api";
import {
  assertBackgroundJobQueueDrainable,
  createProductionWorkerRuntime,
  readBackgroundJobQueueHealth,
  type QueueHealthDatabase,
} from "./engine/workers/productionRuntime";
import { env } from "./lib/env";
import { isApiError, toErrorEnvelope } from "./lib/error";
import { requestLoggerMiddleware } from "./lib/requestLogger";
import { rawBodyMiddleware } from "./lib/rawBody";
import { client } from "./prisma/client";
import { startFakeRailProvider, type FakeRailProviderHandle } from "./engine/fakeRails/provider";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const requestIdMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  const suppliedRequestId = request.header("x-request-id");
  const requestId =
    suppliedRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
  request.requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
};

const readSecretFile = (label: string, filePath: string): Buffer => {
  try {
    return fs.readFileSync(filePath);
  } catch {
    throw new Error(
      `Unable to read ${label} from '${filePath}'. Run 'bun run generate-mtls-certs' before starting core-back.`,
    );
  }
};

export interface CreateAppOptions {
  /**
   * The database the health probe reads the durable queue from. The tests
   * inject a fake; a deployment uses the Prisma client.
   */
  db?: QueueHealthDatabase;
  now?: () => Date;
}

export const createApp = (options: CreateAppOptions = {}) => {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(requestIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(rawBodyMiddleware);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  const healthDb = options.db ?? (client as unknown as QueueHealthDatabase);
  const healthClock = options.now ?? (() => new Date());
  app.get("/health", async (_request, response) => {
    const thresholdMs = env.WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS;
    const workersEnabled = env.WORKER_ENABLED && env.WORKER_BACKGROUND_JOBS_ENABLED;
    let queue: Awaited<ReturnType<typeof readBackgroundJobQueueHealth>>;
    let queueReachable = true;
    try {
      queue = await readBackgroundJobQueueHealth(healthDb, {
        now: healthClock(),
        thresholdMs,
      });
    } catch {
      // The liveness probe stays reachable even when the database is not:
      // the payload says the queue cannot be inspected instead of leaking
      // the error or the tenant rows.
      queueReachable = false;
      queue = {
        queued: 0,
        oldestQueuedAgeMs: null,
        thresholdMs,
        degraded: true,
      };
    }
    const degraded = !workersEnabled || !queueReachable || queue.degraded;
    response.json({
      msg: degraded ? "DEGRADED" : "OK",
      status: degraded ? "degraded" : "ok",
      service: "core-back",
      queue: {
        enabled: workersEnabled,
        queued: queue.queued,
        oldestQueuedAgeMs: queue.oldestQueuedAgeMs,
        thresholdMs: queue.thresholdMs,
        degraded: degraded,
        ...(queueReachable ? {} : { error: "QUEUE_HEALTH_UNAVAILABLE" }),
      },
    });
  });

  app.use("/internal", internalRouter);
  app.use("/api", apiRouter);

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (response.headersSent) {
        return;
      }

      const requestId = request.requestId;
      if (!isApiError(error)) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`[${requestId}] ${message}`);
      }

      const statusCode = isApiError(error)
        ? error.statusCode
        : error instanceof SyntaxError
          ? 400
          : 500;
      response.status(statusCode).json(toErrorEnvelope(error, requestId));
    },
  );

  return app;
};

export interface CoreHttpsServer {
  listen: (port: number, host: string, callback?: () => void) => CoreHttpsServer;
  close: (callback?: (error?: Error) => void) => void;
  address: () => ReturnType<typeof tls.Server.prototype.address>;
  on: (event: string, listener: (...args: any[]) => void) => CoreHttpsServer;
}

export const createHttpsServer = (): CoreHttpsServer => {
  const app = createApp();
  const httpServer = http.createServer(app);
  const tlsServer = tls.createServer({
    key: readSecretFile("mTLS server key", env.MTLS_SERVER_KEY_PATH),
    cert: readSecretFile("mTLS server certificate", env.MTLS_SERVER_CERT_PATH),
    ca: [readSecretFile("internal CA certificate", env.MTLS_CA_CERT_PATH)],
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  });

  tlsServer.on("secureConnection", (socket) => {
    httpServer.emit("connection", socket);
  });

  tlsServer.on("error", (error) => {
    console.error(`TLS server error: ${error.message}`);
  });

  httpServer.on("clientError", (error, socket) => {
    console.error(`HTTP client error: ${error.message}`);
    socket.destroy();
  });

  const server: CoreHttpsServer = {
    listen: (port, host, callback) => {
      tlsServer.listen(port, host, callback);
      return server;
    },
    close: (callback) => {
      tlsServer.close();
      try {
        httpServer.close(callback);
      } catch {
        callback?.();
      }
    },
    address: () => tlsServer.address(),
    on: (event, listener) => {
      tlsServer.on(event, listener);
      return server;
    },
  };

  return server;
};

export const start = async () => {
  // The statement upload and the dispute intake are queue-only routes: the
  // service refuses to boot if nothing can drain the durable jobs.
  assertBackgroundJobQueueDrainable({
    workerEnabled: env.WORKER_ENABLED,
    backgroundJobsEnabled: env.WORKER_BACKGROUND_JOBS_ENABLED,
  });
  let fakeProvider: FakeRailProviderHandle | undefined;
  if (env.FAKE_RAILS_ENABLED) {
    if (env.NODE_ENV === "production" && !env.FAKE_RAILS_ALLOW_PRODUCTION) {
      throw new Error(
        "FAKE_RAILS_ENABLED=true in production requires FAKE_RAILS_ALLOW_PRODUCTION=true",
      );
    }
    if (!env.FAKE_RAILS_API_KEY) {
      throw new Error("FAKE_RAILS_API_KEY is required when FAKE_RAILS_ENABLED=true");
    }
    fakeProvider = startFakeRailProvider({
      host: env.FAKE_RAILS_BIND_HOST,
      port: env.FAKE_RAILS_PORT,
      apiKey: env.FAKE_RAILS_API_KEY,
      hmacSecret: env.FAKE_RAILS_HMAC_SECRET,
      publicBaseUrl: env.FAKE_RAILS_PUBLIC_BASE_URL,
      scenarioProfile: env.FAKE_RAILS_SCENARIO_PROFILE,
    });
    console.log(`Fake rail provider listening on ${fakeProvider.url}`);
  }
  const server = createHttpsServer();
  const workers = env.WORKER_ENABLED
    ? createProductionWorkerRuntime({
        db: client as never,
        intervalMs: env.WORKER_POLL_INTERVAL_MS,
        batchSize: env.WORKER_BATCH_SIZE,
        maxAttempts: env.WORKER_MAX_ATTEMPTS,
        rescreenIntervalMs: env.WORKER_RESCREEN_INTERVAL_MS,
        retentionEnabled: env.WORKER_RETENTION_ENABLED,
        retentionIntervalMs: env.WORKER_RETENTION_INTERVAL_MS,
        retentionBatchSize: env.WORKER_RETENTION_BATCH_SIZE,
        retentionDryRun: env.RETENTION_DRY_RUN,
        backgroundJobsEnabled: env.WORKER_BACKGROUND_JOBS_ENABLED,
        backgroundJobsIntervalMs: env.WORKER_BACKGROUND_JOBS_INTERVAL_MS,
        backgroundJobsBatchSize: env.WORKER_BACKGROUND_JOBS_BATCH_SIZE,
        backgroundJobsLeaseSeconds: env.WORKER_BACKGROUND_JOBS_LEASE_SECONDS,
      })
    : undefined;
  workers?.start();

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(env.PORT, env.HOST, () => {
      console.log(
        `Core mTLS server listening on ${env.HOST}:${env.PORT} (TLS 1.3, client certificates required)`,
      );
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    fakeProvider?.stop();
    workers?.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  process.once("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });

  return server;
};

if (import.meta.main || process.env.NODE_ENV !== "test") {
  await start();
}
