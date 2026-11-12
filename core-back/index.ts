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
import { defaultWorkerHealthRegistry, type WorkerHealthRegistry } from "./engine/workers/workerRuntime";
import { env } from "./lib/env";
import { ApiError, isApiError, toErrorEnvelope } from "./lib/error";
import { BlobStoreUnavailableError, ObjectStorageError } from "./lib/objectStorageSdk";
import { REPORT_ENGINE_JSON_LIMIT } from "./api/internal/adminReportEngine";
import { reconcileReportChromeDefaults } from "./engine/reportStudio/reconcileChromeDefaults";

/** Admin report-engine routes: authoring bodies carry the asset zip. */
export const REPORT_ENGINE_BODY_PATH = /^\/internal\/(admin|merchant)\/report-engine(\/|$)/;
import { requestLoggerMiddleware, setAccessLogSink } from "./lib/requestLogger";
import { rawBodyMiddleware } from "./lib/rawBody";
import { client } from "./prisma/client";
import { getStorageEngine, getStorageEngineIfConfigured, shutdownStorageEngine } from "./lib/storageEngine";
import { setPlatformStorage } from "./engine/runtime";
import { invalidationBus } from "./lib/invalidationBus";
import { storageTelemetry } from "./lib/storageEngine";

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
  /** The worker health registry served under `workers` (default: the process-wide registry). */
  workerHealth?: WorkerHealthRegistry;
}

export const createApp = (options: CreateAppOptions = {}) => {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(requestIdMiddleware);
  app.use((_request, response, next) => {
    storageTelemetry.run({ response }, next);
  });
  app.use(requestLoggerMiddleware);
  app.use(rawBodyMiddleware);
  // Report-engine authoring bodies carry a base64 asset zip (≤ 15 MB binary):
  // that prefix is parsed with a larger, route-scoped limit and skips the
  // global 1 MB parser. An oversized body is a 413 with a stable code.
  const reportEngineJson = express.json({ limit: REPORT_ENGINE_JSON_LIMIT });
  const defaultJson = express.json({ limit: "1mb" });
  app.use((request, response, next) => {
    if (!REPORT_ENGINE_BODY_PATH.test(request.path)) {
      defaultJson(request, response, next);
      return;
    }
    reportEngineJson(request, response, (error?: unknown) => {
      if ((error as { type?: unknown } | undefined)?.type === "entity.too.large") {
        next(new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the report-engine size limit", {
          limit: REPORT_ENGINE_JSON_LIMIT,
        }));
        return;
      }
      next(error as Error | undefined);
    });
  });
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  const healthDb = options.db ?? (client as unknown as QueueHealthDatabase);
  const healthClock = options.now ?? (() => new Date());
  const workerHealth = options.workerHealth ?? defaultWorkerHealthRegistry;
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
    const leader = getStorageEngineIfConfigured()?.leaderElection?.status?.() ?? null;
    const degraded = !workersEnabled || !queueReachable || queue.degraded;
    response.json({
      msg: degraded ? "DEGRADED" : "OK",
      status: degraded ? "degraded" : "ok",
      service: "core-back",
      release: process.env.APP_RELEASE ?? null,
      commit: process.env.APP_COMMIT ?? null,
      leader,
      queue: {
        enabled: workersEnabled,
        queued: queue.queued,
        oldestQueuedAgeMs: queue.oldestQueuedAgeMs,
        thresholdMs: queue.thresholdMs,
        degraded: degraded,
        ...(queueReachable ? {} : { error: "QUEUE_HEALTH_UNAVAILABLE" }),
      },
      // AUTO-03: per-worker health (informational; does not change `status`).
      workers: workerHealth.snapshot(healthClock()).workers,
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
      // Storage denials must keep their public meaning (403 tenant/authority,
      // 404 missing, 409 state, 413 size, 415 MIME, 423 quarantine, 503 vault
      // unavailable) on every domain route, not become a generic 500.
      const mapped = error instanceof ObjectStorageError || error instanceof BlobStoreUnavailableError
        ? new ApiError(error.httpStatus, error.code, error.message)
        : error;
      if (!isApiError(mapped)) {
        const message = mapped instanceof Error ? mapped.message : "unknown error";
        console.error(`[${requestId}] ${message}`);
      }

      const statusCode = isApiError(mapped)
        ? mapped.statusCode
        : mapped instanceof SyntaxError
          ? 400
          : 500;
      response.status(statusCode).json(toErrorEnvelope(mapped, requestId));
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

const configureRedisInvalidation = async (): Promise<(() => Promise<void>)> => {
  const firstRedisNode = env.REDIS_NODES.split(",").map((node) => node.trim()).filter(Boolean)[0];
  const redisUrl = env.REDIS_URL ?? (firstRedisNode ? `redis://${firstRedisNode}` : undefined);
  if (!redisUrl) {
    return async () => undefined;
  }
  try {
    const redisModule = await import("redis");
    const publisher = redisModule.createClient({ url: redisUrl });
    const subscriber = publisher.duplicate();
    await publisher.connect();
    await subscriber.connect();
    invalidationBus.configureTransport(
    {
      publish: async (channel, message) => {
        await publisher.publish(channel, message);
      },
    },
    {
      subscribe: async (channel, listener) => {
        await subscriber.subscribe(channel, (message) => listener(message));
      },
      unsubscribe: async (channel) => {
        await subscriber.unsubscribe(channel);
      },
      psubscribe: async (pattern, listener) => {
        await subscriber.pSubscribe(pattern, (message) => listener(message));
      },
        punsubscribe: async (pattern) => {
          await subscriber.pUnsubscribe(pattern);
        },
      },
    );
    return async () => {
      invalidationBus.configureTransport(undefined, undefined);
      await Promise.allSettled([publisher.quit(), subscriber.quit()]);
    };
  } catch (error) {
    console.warn(
      `Redis invalidation bus disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
    invalidationBus.configureTransport(undefined, undefined);
    return async () => undefined;
  }
};

export const start = async () => {
  // The statement upload and the dispute intake are queue-only routes: the
  // service refuses to boot if nothing can drain the durable jobs.
  assertBackgroundJobQueueDrainable({
    workerEnabled: env.WORKER_ENABLED,
    backgroundJobsEnabled: env.WORKER_BACKGROUND_JOBS_ENABLED,
  });
  const closeInvalidationTransport = await configureRedisInvalidation();
  const server = createHttpsServer();
  const storage = getStorageEngine();
  setPlatformStorage(storage);
  setAccessLogSink(storage.logSink);

  // Singleton workers rely on a session advisory lock. Prove the configured
  // endpoint preserves one before any worker ticks: a transaction-pooled
  // PgBouncer URL would silently allow two nodes to lead at once.
  if (env.WORKER_ENABLED && storage.leaderElection?.verifySessionSafety) {
    const status = await storage.leaderElection.verifySessionSafety();
    const endpoint = status.endpoint
      ? `${status.endpoint.host}:${status.endpoint.port}/${status.endpoint.database}`
      : "configured client factory";
    console.log(`Leader-election endpoint verified as session-safe (${endpoint})`);
  }
  const workers = env.WORKER_ENABLED
    ? createProductionWorkerRuntime({
        db: client as never,
        ...(storage ? { storage } : {}),
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
  // Best-effort: a major engine deploy revokes incompatible defaults without
  // requiring an operator to open the migration page first.
  void reconcileReportChromeDefaults().catch((error: unknown) => {
    console.warn(
      `Report chrome default reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

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
    workers?.stop();
    setAccessLogSink(undefined);
    setPlatformStorage(undefined);
    await closeInvalidationTransport();
    await shutdownStorageEngine();
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
