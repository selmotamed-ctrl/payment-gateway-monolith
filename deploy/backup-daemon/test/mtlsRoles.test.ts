import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { CatalogStore, createDefaultPolicy } from "../src/catalogStore";
import { startBackupDaemonServer, type RunningBackupDaemonServer } from "../src/server";
import { FakeEngine, MemoryCatalogFileSystem, makeConfig, makeDrillReport } from "./helpers";

const hasOpenssl = (() => {
  try {
    return spawnSync("openssl", ["version"]).status === 0;
  } catch {
    return false;
  }
})();
const live = hasOpenssl ? describe : describe.skip;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const makePki = (names: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "bd-roles-"));
  dirs.push(dir);
  const run = (args: string[]) => {
    const result = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${result.stderr}`);
  };
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Test CA"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  for (const name of ["server", ...names]) {
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
    run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", "ext.cnf"]);
  }
  return dir;
};

interface Started {
  dir: string;
  port: number;
  server: RunningBackupDaemonServer;
  uploads: Array<{ target: string; file: string; bytes: number }>;
}

let nextPort = 47400 + Math.floor(Math.random() * 400);

const start = async (): Promise<Started> => {
  const dir = makePki(["backup-client", "wal-archive-client", "admin-back"]);
  const port = nextPort++;
  const uploads: Started["uploads"] = [];
  const engine = new FakeEngine();
  (engine as unknown as { ingestWal: unknown }).ingestWal = async (target: string, file: string, body: Readable) => {
    let bytes = 0;
    for await (const chunk of body) bytes += (chunk as Buffer).length;
    uploads.push({ target, file, bytes });
    return { status: "stored", key: `wal/${target}/${file}.zst.enc`, bytes };
  };
  const catalog = await CatalogStore.load({
    path: "/virtual/catalog.json",
    defaultPolicy: createDefaultPolicy({ updatedAt: new Date().toISOString() }),
    fileSystem: new MemoryCatalogFileSystem(),
  });
  const server = await startBackupDaemonServer({
    config: makeConfig({
      BACKUP_ENGINE_MODE: "pg-native",
      BACKUP_ALLOW_INSECURE_HTTP: "false",
      BACKUP_DAEMON_BIND_HOST: "127.0.0.1",
      BACKUP_DAEMON_PORT: String(port),
      BACKUP_DAEMON_CERT_PATH: join(dir, "server.crt"),
      BACKUP_DAEMON_KEY_PATH: join(dir, "server.key"),
      BACKUP_DAEMON_CA_CERT_PATH: join(dir, "ca.crt"),
    }),
    engine,
    drillRunner: { run: async () => makeDrillReport("d1") },
    catalog,
  });
  return { dir, port, server, uploads };
};

const agentFor = (dir: string, client: string, maxSockets = 8): https.Agent =>
  new https.Agent({
    keepAlive: true,
    maxSockets,
    minVersion: "TLSv1.3",
    ca: readFileSync(join(dir, "ca.crt")),
    cert: readFileSync(join(dir, `${client}.crt`)),
    key: readFileSync(join(dir, `${client}.key`)),
  });

const call = (started: Started, agent: https.Agent, path: string, method = "GET", body?: Buffer | string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: started.port,
        servername: "localhost",
        path,
        method,
        agent,
        timeout: 8000,
        headers: body === undefined ? {} : { "content-length": Buffer.byteLength(body), "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end(body);
  });

live("mTLS roles over real TLS 1.3", () => {
  test("backup-client reaches the control plane but cannot upload WAL; wal-archive-client can ONLY upload WAL; others get 403", async () => {
    const started = await start();
    const control = agentFor(started.dir, "backup-client");
    const wal = agentFor(started.dir, "wal-archive-client");
    const stranger = agentFor(started.dir, "admin-back");
    try {
      expect((await call(started, control, "/health")).status).toBe(200);
      expect((await call(started, control, "/v1/overview")).status).toBe(200);
      const controlWal = await call(started, control, "/v1/wal/postgres_core/000000010000000000000001", "PUT", "segment");
      expect(controlWal.status).toBe(403);

      const upload = await call(started, wal, "/v1/wal/postgres_core/000000010000000000000001", "PUT", Buffer.alloc(300_000, 1));
      expect(upload.status).toBe(200);
      expect(JSON.parse(upload.body)).toMatchObject({ status: "stored", bytes: 300_000 });
      expect(started.uploads).toEqual([{ target: "postgres_core", file: "000000010000000000000001", bytes: 300_000 }]);
      for (const path of ["/v1/overview", "/health", "/v1/policy"]) {
        expect((await call(started, wal, path, path === "/v1/policy" ? "PUT" : "GET", path === "/v1/policy" ? "{}" : undefined)).status).toBe(403);
      }

      const denied = await call(started, stranger, "/v1/overview");
      expect(denied.status).toBe(403);
      expect(denied.body).not.toContain("engineMode");
      expect(started.uploads).toHaveLength(1);
    } finally {
      for (const agent of [control, wal, stranger]) agent.destroy();
      started.server.stop();
    }
  });

  test("a client without any certificate cannot even complete the handshake", async () => {
    const started = await start();
    try {
      const bare = new https.Agent({ ca: readFileSync(join(started.dir, "ca.crt")), minVersion: "TLSv1.3" });
      await expect(call(started, bare, "/health")).rejects.toThrow();
      bare.destroy();
    } finally {
      started.server.stop();
    }
  });

  test("50 sequential + 50 concurrent requests over pooled keep-alive TLS 1.3 sockets (core-back's BackupControlClient agent settings) all succeed", async () => {
    const started = await start();
    const agent = agentFor(started.dir, "backup-client", 8);
    try {
      const sequential: number[] = [];
      for (let index = 0; index < 50; index += 1) sequential.push((await call(started, agent, "/health")).status);
      const concurrent = await Promise.all(Array.from({ length: 50 }, (_, index) => call(started, agent, index % 2 === 0 ? "/health" : "/v1/overview")));
      expect(new Set(sequential)).toEqual(new Set([200]));
      expect(concurrent.every((response) => response.status === 200)).toBe(true);

      const trigger = await call(started, agent, "/v1/backups/trigger", "POST", JSON.stringify({ target: "postgres_core", kind: "full" }));
      expect(trigger.status).toBe(202);
    } finally {
      agent.destroy();
      started.server.stop();
    }
  });

  test("several large WAL uploads and control requests interleave without corrupting each other", async () => {
    const started = await start();
    const control = agentFor(started.dir, "backup-client");
    const wal = agentFor(started.dir, "wal-archive-client");
    try {
      const segments = Array.from({ length: 4 }, (_, index) => `00000001000000000000000${index + 1}`);
      const results = await Promise.all([
        ...segments.map((segment) => call(started, wal, `/v1/wal/postgres_core/${segment}`, "PUT", Buffer.alloc(8 * 1024 * 1024, 7))),
        ...Array.from({ length: 10 }, () => call(started, control, "/v1/overview")),
      ]);
      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(started.uploads.map((upload) => upload.bytes)).toEqual(Array(4).fill(8 * 1024 * 1024));
      expect(started.uploads.map((upload) => upload.file).sort()).toEqual(segments);
    } finally {
      for (const agent of [control, wal]) agent.destroy();
      started.server.stop();
    }
  });
});
