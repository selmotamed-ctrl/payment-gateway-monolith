import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteMtlsBlobStore } from "../../../core-back/lib/objectStorageSdk/blobStore";
import {
  startObjectStorageDaemon,
  type RunningObjectStorageDaemon,
} from "../src/server";
import {
  createTestCertificates,
  opensslAvailable,
  type TestCertificates,
} from "./helpers/certs";

const live = opensslAvailable ? test : test.skip;

describe("RemoteMtlsBlobStore against the object-storage daemon", () => {
  let certs: TestCertificates | undefined;
  let root = "";
  let daemon: RunningObjectStorageDaemon | undefined;

  beforeAll(async () => {
    if (!opensslAvailable) return;
    certs = createTestCertificates();
    root = mkdtempSync(join(tmpdir(), "object-daemon-sdk-mtls-"));
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
  });

  afterAll(async () => {
    await daemon?.close();
    certs?.cleanup();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  live("an allowed client can health-check, put, stat, read and list over mTLS", async () => {
    const store = new RemoteMtlsBlobStore({
      baseUrl: daemon!.baseUrl,
      caCertPath: certs!.ca,
      clientCertPath: certs!.allowedCert,
      clientKeyPath: certs!.allowedKey,
    });

    const health = await store.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.mode).toBe("REMOTE_MTLS");

    const bytes = Buffer.from("RemoteMtlsBlobStore round-trip", "utf8");
    const put = await store.put("HOT", "sdk/mtls.v1.enc", bytes);
    expect(put.byteSize).toBe(bytes.byteLength);

    const stat = await store.stat("HOT", "sdk/mtls.v1.enc");
    expect(stat.exists).toBe(true);
    expect(stat.byteSize).toBe(bytes.byteLength);

    const read = await store.readBytes("HOT", "sdk/mtls.v1.enc");
    expect(Buffer.from(read).equals(bytes)).toBe(true);

    const listed = await store.list("HOT", "sdk/");
    expect(listed.some((entry) => entry.relPath === "sdk/mtls.v1.enc")).toBe(true);
  });

  live("a client with an unlisted CN is refused by the daemon", async () => {
    const store = new RemoteMtlsBlobStore({
      baseUrl: daemon!.baseUrl,
      caCertPath: certs!.ca,
      clientCertPath: certs!.deniedCert,
      clientKeyPath: certs!.deniedKey,
    });
    const health = await store.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("403");
  });

  live("the SDK refuses an incomplete TLS configuration", () => {
    expect(
      () =>
        new RemoteMtlsBlobStore({
          baseUrl: daemon!.baseUrl,
          caCertPath: certs!.ca,
          clientCertPath: certs!.allowedCert,
        }),
    ).toThrow(/OBJECT_STORAGE_TLS_INCOMPLETE/);
  });
});
