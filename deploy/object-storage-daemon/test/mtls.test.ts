import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllowedClientIdentity,
  startObjectStorageDaemon,
  type RunningObjectStorageDaemon,
} from "../src/server";
import {
  createTestCertificates,
  opensslAvailable,
  type TestCertificates,
} from "./helpers/certs";

describe("object storage mTLS client identity", () => {
  test("matches the subject CN only, rejects missing/unknown identities", () => {
    const allowed = ["object-storage-client", "backup-client"];
    expect(isAllowedClientIdentity({ subject: { CN: "object-storage-client" } }, allowed)).toBe(true);
    expect(isAllowedClientIdentity({ subject: { CN: ["backup-client"] } }, allowed)).toBe(true);
    expect(isAllowedClientIdentity({ subject: { CN: "admin-back" } }, allowed)).toBe(false);
    expect(isAllowedClientIdentity({ subject: { CN: "object-storage-client-evil" } }, allowed)).toBe(false);
    expect(isAllowedClientIdentity({}, allowed)).toBe(false);
    expect(isAllowedClientIdentity(undefined, allowed)).toBe(false);
    expect(isAllowedClientIdentity({ subject: { CN: "object-storage-client" } }, [])).toBe(false);
  });
});

const live = opensslAvailable ? test : test.skip;

describe("object storage daemon mTLS surface", () => {
  let certs: TestCertificates | undefined;
  let root = "";
  let daemon: RunningObjectStorageDaemon | undefined;
  let port = 0;

  const request = (options: {
    cert?: string;
    key?: string;
    method: string;
    path: string;
    body?: string | Buffer;
  }): Promise<{ status?: number; body?: Buffer; error?: string }> =>
    new Promise((resolve) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port,
          servername: "localhost",
          method: options.method,
          path: options.path,
          ca: readFileSync(certs!.ca),
          ...(options.cert ? { cert: readFileSync(options.cert) } : {}),
          ...(options.key ? { key: readFileSync(options.key) } : {}),
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          agent: false,
          headers: { connection: "close" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        },
      );
      req.on("error", (error) => resolve({ error: error.message }));
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });

  beforeAll(async () => {
    if (!opensslAvailable) return;
    certs = createTestCertificates();
    root = mkdtempSync(join(tmpdir(), "object-daemon-mtls-root-"));
    daemon = await startObjectStorageDaemon({
      rootDir: root,
      bindHost: "127.0.0.1",
      port: 0,
      requireMtls: true,
      tlsCaCertPath: certs.ca,
      tlsServerCertPath: certs.serverCert,
      tlsServerKeyPath: certs.serverKey,
      allowedClientCns: ["object-storage-client"],
    });
    port = daemon.port;
  });

  afterAll(async () => {
    await daemon?.close();
    certs?.cleanup();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  live("an allowed client certificate can read the health endpoint", async () => {
    const response = await request({
      cert: certs!.allowedCert,
      key: certs!.allowedKey,
      method: "GET",
      path: "/v1/health",
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body!.toString("utf8"))).toMatchObject({ ok: true });
  });

  live("an allowed client can PUT and GET a blob through the TLS bridge", async () => {
    const payload = Buffer.from("mTLS bridge round-trip", "utf8");
    const put = await request({
      cert: certs!.allowedCert,
      key: certs!.allowedKey,
      method: "PUT",
      path: "/v1/blobs/HOT/mtls/test.v1.enc",
      body: payload,
    });
    expect(put.status).toBe(201);
    const get = await request({
      cert: certs!.allowedCert,
      key: certs!.allowedKey,
      method: "GET",
      path: "/v1/blobs/HOT/mtls/test.v1.enc",
    });
    expect(get.status).toBe(200);
    expect(Buffer.from(get.body!).equals(payload)).toBe(true);
  });

  live("a CA-signed certificate with an unlisted CN gets 403", async () => {
    const response = await request({
      cert: certs!.deniedCert,
      key: certs!.deniedKey,
      method: "GET",
      path: "/v1/health",
    });
    expect(response.status).toBe(403);
    expect(response.body!.toString("utf8")).toContain("MTLS_CLIENT_CN_FORBIDDEN");
    expect(response.body!.toString("utf8")).not.toContain('"ok":true');
  });

  live("a client without a certificate fails the handshake", async () => {
    const response = await request({ method: "GET", path: "/v1/health" });
    expect(response.status).toBeUndefined();
    expect(response.error).toBeTruthy();
  });

  live("a client signed by an untrusted CA fails the handshake", async () => {
    const response = await request({
      cert: certs!.untrustedCert,
      key: certs!.untrustedKey,
      method: "GET",
      path: "/v1/health",
    });
    expect(response.status).toBeUndefined();
    expect(response.error).toBeTruthy();
  });

  live("a TLS 1.2 client is rejected (TLS 1.3 is required)", async () => {
    const response = await new Promise<{ status?: number; error?: string }>((resolve) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port,
          servername: "localhost",
          method: "GET",
          path: "/v1/health",
          ca: readFileSync(certs!.ca),
          cert: readFileSync(certs!.allowedCert),
          key: readFileSync(certs!.allowedKey),
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
          agent: false,
          headers: { connection: "close" },
        },
        (res) => resolve({ status: res.statusCode }),
      );
      req.on("error", (error) => resolve({ error: error.message }));
      req.end();
    });
    expect(response.status).toBeUndefined();
    expect(response.error).toBeTruthy();
  });
});
