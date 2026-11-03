import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  BackupControlClient,
  BackupDaemonError,
  type BackupPolicy,
} from "../../lib/storageEngine/backupControlClient";

const repoCerts = path.join(import.meta.dirname, "..", "..", "certs");
const originalEnv = {
  url: process.env.BACKUP_DAEMON_URL,
  ca: process.env.BACKUP_DAEMON_CA_CERT_PATH,
  cert: process.env.BACKUP_DAEMON_CLIENT_CERT_PATH,
  key: process.env.BACKUP_DAEMON_CLIENT_KEY_PATH,
};

afterAll(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restore("BACKUP_DAEMON_URL", originalEnv.url);
  restore("BACKUP_DAEMON_CA_CERT_PATH", originalEnv.ca);
  restore("BACKUP_DAEMON_CLIENT_CERT_PATH", originalEnv.cert);
  restore("BACKUP_DAEMON_CLIENT_KEY_PATH", originalEnv.key);
});

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RunningServer {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

const readBody = (request: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const startServer = async (
  handler: (request: CapturedRequest, response: http.ServerResponse) => void,
  secure = false,
): Promise<RunningServer> => {
  const requests: CapturedRequest[] = [];
  const listener = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    const body = await readBody(request);
    const captured: CapturedRequest = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body,
    };
    requests.push(captured);
    handler(captured, response);
  };
  const server = secure
    ? https.createServer(
        {
          key: fs.readFileSync(path.join(repoCerts, "core-back.key")),
          cert: fs.readFileSync(path.join(repoCerts, "core-back.crt")),
        },
        (request, response) => {
          void listener(request, response);
        },
      )
    : http.createServer((request, response) => {
        void listener(request, response);
      });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `${secure ? "https" : "http"}://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

const sendJson = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
};

describe("BackupControlClient over HTTP", () => {
  test("sends the correct URL, method and body for every control-plane call", async () => {
    const policy: BackupPolicy = {
      fullCron: "0 2 * * 0",
      deltaCron: "0 2 * * 1-6",
      drillCron: "0 4 * * 0",
      fullRetentionDays: 56,
      walRetentionDays: 14,
      alertLagSeconds: 60,
    };
    const server = await startServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok", engineMode: "postgres", version: "1" });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/overview") {
        sendJson(response, 200, {
          generatedAt: "2026-01-01T00:00:00.000Z",
          engineMode: "postgres",
          healthy: true,
          wal: { archiveLagSeconds: 1, currentLsn: "0/1", lastArchivedLsn: "0/0", lagBytes: 1 },
          targets: [],
          schedule: policy,
          policy,
          backups: [],
          latestDrill: null,
          drills: [],
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/backups/trigger") {
        sendJson(response, 202, {
          backupJobId: "11111111-1111-4111-8111-111111111111",
          acceptedAt: "2026-01-01T00:00:00.000Z",
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/drills/run") {
        sendJson(response, 202, {
          drillId: "22222222-2222-4222-8222-222222222222",
          acceptedAt: "2026-01-01T00:00:00.000Z",
        });
        return;
      }
      if (request.method === "PUT" && request.url === "/v1/policy") {
        sendJson(response, 200, { policy });
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/v1/runs")) {
        sendJson(response, 200, { runs: [] });
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/v1/drills")) {
        sendJson(response, 200, { drills: [] });
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "not found" } });
    });
    process.env.BACKUP_DAEMON_CLIENT_KEY_PATH = "/tmp/does-not-exist-secret.key";
    process.env.BACKUP_DAEMON_CLIENT_CERT_PATH = "/tmp/does-not-exist-secret.crt";
    const client = new BackupControlClient({
      baseUrl: `${server.url}/`,
      timeoutMs: 2_000,
    });
    try {
      expect(client.isConfigured()).toBe(true);
      const overview = await client.overview();
      expect(overview.engineMode).toBe("postgres");
      expect(overview.policy).toEqual(policy);
      expect(await client.health()).toEqual({
        status: "ok",
        engineMode: "postgres",
        version: "1",
      });
      expect(await client.triggerBackup("postgres_core", "delta", "user-1")).toEqual({
        backupJobId: "11111111-1111-4111-8111-111111111111",
        acceptedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(await client.runDrill("user-2")).toEqual({
        drillId: "22222222-2222-4222-8222-222222222222",
        acceptedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(await client.updatePolicy(policy)).toEqual({ policy });
      await client.listRuns(0);
      await client.listRuns(9_999);
      await client.listDrills(30);

      const trigger = server.requests.find(
        (request) => request.url === "/v1/backups/trigger",
      );
      expect(trigger?.method).toBe("POST");
      expect(JSON.parse(trigger?.body ?? "{}")).toEqual({
        target: "postgres_core",
        kind: "delta",
        requestedBy: "user-1",
      });
      expect(trigger?.headers["content-type"]).toBe("application/json");
      const drill = server.requests.find((request) => request.url === "/v1/drills/run");
      expect(JSON.parse(drill?.body ?? "{}")).toEqual({ requestedBy: "user-2" });
      const policyRequest = server.requests.find(
        (request) => request.method === "PUT" && request.url === "/v1/policy",
      );
      expect(JSON.parse(policyRequest?.body ?? "{}")).toEqual(policy);

      const runLimits = server.requests
        .filter((request) => request.url?.startsWith("/v1/runs"))
        .map((request) => new URL(request.url, server.url).searchParams.get("limit"));
      expect(runLimits).toEqual(["1", "500"]);

      const serialized = JSON.stringify(
        server.requests.map((request) => ({ headers: request.headers, body: request.body })),
      );
      expect(serialized).not.toContain("does-not-exist-secret");
      expect(serialized).not.toContain("client-key");
    } finally {
      await server.close();
    }
  });

  test("maps a daemon timeout to BACKUP_DAEMON_TIMEOUT", async () => {
    const server = await startServer(() => {
      // Deliberately never respond.
    });
    const client = new BackupControlClient({
      baseUrl: server.url,
      timeoutMs: 60,
    });
    try {
      const started = performance.now();
      const error = await client.overview().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BackupDaemonError);
      expect((error as BackupDaemonError).code).toBe("BACKUP_DAEMON_TIMEOUT");
      expect((error as BackupDaemonError).statusCode).toBe(504);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await server.close();
    }
  });

  test("maps non-2xx envelopes without losing code, status or details", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, 503, {
        error: {
          code: "DAEMON_BUSY",
          message: "backup daemon is busy",
          details: { retryAfterSeconds: 5 },
        },
      });
    });
    const client = new BackupControlClient({ baseUrl: server.url, timeoutMs: 1_000 });
    try {
      const error = await client.triggerBackup("all", "full").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BackupDaemonError);
      expect((error as BackupDaemonError).code).toBe("DAEMON_BUSY");
      expect((error as BackupDaemonError).statusCode).toBe(503);
      expect((error as BackupDaemonError).details).toEqual({ retryAfterSeconds: 5 });
      expect((error as Error).message).toBe("backup daemon is busy");
    } finally {
      await server.close();
    }
  });

  test("is not configured without a base URL", async () => {
    const client = new BackupControlClient({ baseUrl: "" });
    expect(client.isConfigured()).toBe(false);
    const error = await client.overview().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupDaemonError);
    expect((error as BackupDaemonError).code).toBe("BACKUP_DAEMON_NOT_CONFIGURED");
    expect((error as BackupDaemonError).statusCode).toBe(503);
  });

  test("rejects a malformed base URL instead of hanging", async () => {
    const client = new BackupControlClient({ baseUrl: "not a valid url", timeoutMs: 100 });
    await expect(client.overview()).rejects.toBeInstanceOf(Error);
  });
});

describe("BackupControlClient over HTTPS", () => {
  test("trusts the configured CA and does not require a client certificate", async () => {
    const server = await startServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/overview") {
        sendJson(response, 200, {
          generatedAt: "2026-01-01T00:00:00.000Z",
          engineMode: "postgres",
          healthy: true,
          wal: { archiveLagSeconds: 0, currentLsn: "0/0", lastArchivedLsn: "0/0", lagBytes: 0 },
          targets: [],
          schedule: {
            fullCron: "0 2 * * 0",
            deltaCron: "0 2 * * 1-6",
            drillCron: "0 4 * * 0",
            fullRetentionDays: 56,
            walRetentionDays: 14,
            alertLagSeconds: 60,
          },
          policy: {
            fullCron: "0 2 * * 0",
            deltaCron: "0 2 * * 1-6",
            drillCron: "0 4 * * 0",
            fullRetentionDays: 56,
            walRetentionDays: 14,
            alertLagSeconds: 60,
          },
          backups: [],
          latestDrill: null,
          drills: [],
        });
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "not found" } });
    }, true);
    process.env.BACKUP_DAEMON_CA_CERT_PATH = path.join(repoCerts, "internal-ca.crt");
    delete process.env.BACKUP_DAEMON_CLIENT_CERT_PATH;
    delete process.env.BACKUP_DAEMON_CLIENT_KEY_PATH;
    const client = new BackupControlClient({ baseUrl: server.url, timeoutMs: 2_000 });
    try {
      const overview = await client.overview();
      expect(overview.engineMode).toBe("postgres");
    } finally {
      await server.close();
    }
  });
});
