import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTestPki, type TestPki } from "./helpers/core";
import { operatorToken, signSession } from "./helpers/session";

interface CoreRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface BackupsTestCore {
  url: string;
  requests: CoreRequestRecord[];
  close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const readJsonBody = (body: Buffer): Record<string, unknown> => {
  const raw = body.toString("utf8");
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const overviewPayload = {
  configured: true,
  daemonReachable: true,
  generatedAt: "2026-11-03T00:00:00.000Z",
  engineMode: "wal-g",
  healthy: true,
  wal: {
    archiveLagSeconds: 2,
    currentLsn: "0/16B6C50",
    lastArchivedLsn: "0/16B6C10",
    lagBytes: 64,
  },
  targets: [
    { id: "primary", name: "Primary S3", kind: "S3", healthy: true, detail: "reachable" },
    { id: "secondary", name: "Secondary remote", kind: "SFTP", healthy: true, detail: "reachable" },
  ],
  schedule: {
    fullCron: "0 2 * * 0",
    deltaCron: "0 2 * * 1-6",
    drillCron: "0 3 * * 0",
    fullRetentionDays: 56,
    walRetentionDays: 14,
    alertLagSeconds: 30,
  },
  policy: {},
  backups: [],
  latestDrill: null,
  drills: [],
  localCatalog: { backups: [], drills: [] },
};

const startBackupsTestCore = async (pki: TestPki): Promise<BackupsTestCore> => {
  const requests: CoreRequestRecord[] = [];
  const server = https.createServer(
    {
      cert: readFileSync(pki.serverCert),
      key: readFileSync(pki.serverKey),
      ca: readFileSync(pki.caCert),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    async (request: IncomingMessage, response: ServerResponse) => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      });
      const path = (request.url ?? "/").split("?")[0] ?? request.url ?? "/";
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (path === "/internal/admin/system/backups/overview" && request.method === "GET") {
        json(200, overviewPayload);
        return;
      }
      if (path === "/internal/admin/system/backups/trigger" && request.method === "POST") {
        json(202, { backupJobId: "bkp_job_1", acceptedAt: "2026-11-03T00:00:01.000Z" });
        return;
      }
      if (path === "/internal/admin/system/backups/drill" && request.method === "POST") {
        json(202, { drillId: "drill_1", acceptedAt: "2026-11-03T00:00:02.000Z" });
        return;
      }
      if (path === "/internal/admin/system/backups/policy" && request.method === "PUT") {
        json(202, {
          status: "PENDING_REVIEW",
          approvalRequestId: "apr_backup_1",
          policy: readJsonBody(body),
        });
        return;
      }
      json(404, { code: "NOT_FOUND", message: `${request.method} ${path}` });
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `https://localhost:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

const pki: TestPki = createTestPki("admin-back");
const core: BackupsTestCore = await startBackupsTestCore(pki);

const { createApp } = await import("../index");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const securityWriter = signSession({
  sub: "u-security-writer",
  role: "SECURITY_ADMIN",
  authorities: ["security:read", "security:write", "gateway:read"],
});

const securityReader = signSession({
  sub: "u-security-reader",
  role: "SECURITY_ADMIN",
  authorities: ["security:read"],
});

const operator = operatorToken();

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.ADMIN_LAN_CIDRS = "10.0.0.0/8,192.168.0.0/16,127.0.0.1/32";
  process.env.ADMIN_AUTHORITY_HINTS = "security:read,security:write,gateway:read";
  process.env.BACKUP_JOB_RATE_LIMIT_MAX = "1000";
});

beforeAll(async () => {
  const app = createApp();
  edgeServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => edgeServer.once("listening", resolve));
  const address = edgeServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  edgeUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
  delete process.env.ADMIN_AUTHORITY_HINTS;
  delete process.env.BACKUP_JOB_RATE_LIMIT_MAX;
});

const call = (
  method: string,
  path: string,
  options: { token?: string; body?: unknown; idempotencyKey?: string } = {},
) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST" && /\/system\/backups\/(trigger|drill)$/.test(path)) {
    headers["idempotency-key"] = options.idempotencyKey ?? "test-idempotency-key";
  }
  return fetch(`${edgeUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};

const forwardedBody = (): Record<string, unknown> => {
  const raw = core.requests.at(-1)?.body.toString("utf8") ?? "";
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

describe("system backups route surface", () => {
  test("forwards the overview read with the caller authorization", async () => {
    const response = await call("GET", "/api/v1/admin/system/backups/overview", {
      token: operator,
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.method).toBe("GET");
    expect(forwarded?.url).toBe("/internal/admin/system/backups/overview");
    expect(forwarded?.headers.authorization).toBe(`Bearer ${operator}`);
    const payload = (await response.json()) as { daemonReachable?: boolean };
    expect(payload.daemonReachable).toBe(true);
  });

  test("allows the overview for a security read authority", async () => {
    const response = await call("GET", "/api/v1/admin/system/backups/overview", {
      token: securityReader,
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/system/backups/overview");
  });

  test("denies the overview to a session without security:read or gateway:read", async () => {
    const before = core.requests.length;
    const response = await call("GET", "/api/v1/admin/system/backups/overview", {
      token: signSession({ sub: "u-aml", role: "COMPLIANCE", authorities: ["aml:read"] }),
    });
    expect(response.status).toBe(403);
    expect(core.requests.length).toBe(before);
  });

  test("requires a bearer token on every backups route", async () => {
    const response = await call("GET", "/api/v1/admin/system/backups/overview");
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("AUTH_REQUIRED");
  });

  test("forwards a validated trigger and relays the accepted status", async () => {
    const response = await call("POST", "/api/v1/admin/system/backups/trigger", {
      token: securityWriter,
      body: { target: "postgres_core", kind: "delta" },
    });
    expect(response.status).toBe(202);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.url).toBe("/internal/admin/system/backups/trigger");
    expect(forwardedBody()).toEqual({ target: "postgres_core", kind: "delta" });
    const payload = (await response.json()) as { backupJobId?: string };
    expect(payload.backupJobId).toBe("bkp_job_1");
  });

  test("forwards all supported trigger targets", async () => {
    for (const target of ["all", "postgres_core", "audit_db", "redis"]) {
      const response = await call("POST", "/api/v1/admin/system/backups/trigger", {
        token: securityWriter,
        body: { target, kind: "full" },
      });
      expect(response.status).toBe(202);
      expect(forwardedBody()).toEqual({ target, kind: "full" });
    }
  });

  test("rejects an invalid trigger target before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("POST", "/api/v1/admin/system/backups/trigger", {
      token: securityWriter,
      body: { target: "mysql", kind: "full" },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("rejects an invalid trigger kind before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("POST", "/api/v1/admin/system/backups/trigger", {
      token: securityWriter,
      body: { target: "all", kind: "incremental" },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("rejects a trigger without a kind before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("POST", "/api/v1/admin/system/backups/trigger", {
      token: securityWriter,
      body: { target: "all" },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("denies trigger to a session without security:write", async () => {
    const before = core.requests.length;
    const response = await call("POST", "/api/v1/admin/system/backups/trigger", {
      token: operator,
      body: { target: "all", kind: "full" },
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("EDGE_AUTHORITY_DENIED");
    expect(core.requests.length).toBe(before);
  });

  test("forwards a drill and relays the accepted status", async () => {
    const response = await call("POST", "/api/v1/admin/system/backups/drill", {
      token: securityWriter,
      body: {},
    });
    expect(response.status).toBe(202);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.url).toBe("/internal/admin/system/backups/drill");
    expect(forwardedBody()).toEqual({});
    const payload = (await response.json()) as { drillId?: string };
    expect(payload.drillId).toBe("drill_1");
  });

  test("rejects a drill body with unexpected fields before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("POST", "/api/v1/admin/system/backups/drill", {
      token: securityWriter,
      body: { targetTime: "2026-11-03T00:00:00.000Z" },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("denies drill to a session without security:write", async () => {
    const before = core.requests.length;
    const response = await call("POST", "/api/v1/admin/system/backups/drill", {
      token: securityReader,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(core.requests.length).toBe(before);
  });

  test("forwards a strict policy body and relays the pending review", async () => {
    const body = {
      fullCron: "0 2 * * 0",
      deltaCron: "0 2 * * 1-6",
      drillCron: "0 3 * * 0",
      fullRetentionDays: 56,
      walRetentionDays: 14,
      alertLagSeconds: 30,
      approvalRequestId: "apr_request_1",
    };
    const response = await call("PUT", "/api/v1/admin/system/backups/policy", {
      token: securityWriter,
      body,
    });
    expect(response.status).toBe(202);
    const forwarded = core.requests.at(-1);
    expect(forwarded?.method).toBe("PUT");
    expect(forwarded?.url).toBe("/internal/admin/system/backups/policy");
    expect(forwardedBody()).toEqual(body);
    const payload = (await response.json()) as { status?: string; approvalRequestId?: string };
    expect(payload.status).toBe("PENDING_REVIEW");
    expect(payload.approvalRequestId).toBe("apr_backup_1");
  });

  test("rejects a policy body with unexpected fields before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("PUT", "/api/v1/admin/system/backups/policy", {
      token: securityWriter,
      body: {
        fullCron: "0 2 * * 0",
        deltaCron: "0 2 * * 1-6",
        drillCron: "0 3 * * 0",
        fullRetentionDays: 56,
        walRetentionDays: 14,
        alertLagSeconds: 30,
        extra: true,
      },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("rejects a policy body with invalid retention before contacting core", async () => {
    const before = core.requests.length;
    const response = await call("PUT", "/api/v1/admin/system/backups/policy", {
      token: securityWriter,
      body: {
        fullCron: "0 2 * * 0",
        deltaCron: "0 2 * * 1-6",
        drillCron: "0 3 * * 0",
        fullRetentionDays: 0,
        walRetentionDays: 14,
        alertLagSeconds: 30,
      },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("denies policy changes to a session without security:write", async () => {
    const before = core.requests.length;
    const response = await call("PUT", "/api/v1/admin/system/backups/policy", {
      token: securityReader,
      body: {
        fullCron: "0 2 * * 0",
        deltaCron: "0 2 * * 1-6",
        drillCron: "0 3 * * 0",
        fullRetentionDays: 56,
        walRetentionDays: 14,
        alertLagSeconds: 30,
      },
    });
    expect(response.status).toBe(403);
    expect(core.requests.length).toBe(before);
  });
});
