import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { CatalogStore, createDefaultPolicy } from "../src/catalogStore";
import { isAllowedClientIdentity, parseAllowedClientCns, startBackupDaemonServer } from "../src/server";
import { FakeEngine, MemoryCatalogFileSystem, freePort, makeConfig, makeDrillReport } from "./helpers";

describe("mTLS client authorization (D7/B-H2)", () => {
  test("allowlist matches subject CN or DNS SAN only", () => {
    const allowed = parseAllowedClientCns("backup-client, core-back.internal");
    expect(isAllowedClientIdentity({ subject: { CN: "backup-client" } }, allowed)).toBe(true);
    expect(isAllowedClientIdentity({ subject: { CN: "other" }, subjectaltname: "DNS:core-back.internal, IP Address:10.0.0.1" }, allowed)).toBe(true);
    expect(isAllowedClientIdentity({ subject: { CN: "admin-back" } }, allowed)).toBe(false);
    expect(isAllowedClientIdentity({ subject: { CN: "backup-client-evil" }, subjectaltname: "DNS:x" }, allowed)).toBe(false);
    expect(isAllowedClientIdentity(undefined, allowed)).toBe(false);
    expect(isAllowedClientIdentity({ subject: { CN: "backup-client" } }, [])).toBe(false);
  });

  const openssl = (() => {
    try {
      return spawnSync("openssl", ["version"]).status === 0;
    } catch {
      return false;
    }
  })();
  const live = openssl ? test : test.skip;
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  live("an internal-CA certificate with an unlisted CN gets 403; the allowed CN gets 200", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bd-mtls-"));
    dirs.push(dir);
    const run = (args: string[]) => {
      const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
      if (r.status !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${r.stderr}`);
    };
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Test CA"]);
    writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    for (const name of ["server", "backup-client", "admin-back"]) {
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
      run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", "ext.cnf"]);
    }
    const port = await freePort();
    const config = makeConfig({
      BACKUP_ALLOW_INSECURE_HTTP: "false",
      BACKUP_DAEMON_BIND_HOST: "127.0.0.1",
      BACKUP_DAEMON_PORT: String(port),
      BACKUP_DAEMON_CERT_PATH: join(dir, "server.crt"),
      BACKUP_DAEMON_KEY_PATH: join(dir, "server.key"),
      BACKUP_DAEMON_CA_CERT_PATH: join(dir, "ca.crt"),
    });
    const catalog = await CatalogStore.load({
      path: "/virtual/catalog.json",
      defaultPolicy: createDefaultPolicy({ updatedAt: new Date().toISOString() }),
      fileSystem: new MemoryCatalogFileSystem(),
    });
    const server = await startBackupDaemonServer({
      config,
      engine: new FakeEngine(),
      drillRunner: { run: async () => makeDrillReport("d1") },
      catalog,
    });
    const call = (client: string) =>
      new Promise<string>((resolve) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          servername: "localhost",
          ca: readFileSync(join(dir, "ca.crt")),
          cert: readFileSync(join(dir, `${client}.crt`)),
          key: readFileSync(join(dir, `${client}.key`)),
        });
        let data = "";
        socket.on("secureConnect", () => socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("end", () => resolve(data));
        socket.on("error", (error) => resolve(`ERR ${error.message}`));
      });
    try {
      expect(await call("backup-client")).toContain("200 OK");
      const denied = await call("admin-back");
      expect(denied).toContain("403");
      expect(denied).not.toContain('"status":"ok"');
    } finally {
      server.stop();
    }
  });
});
