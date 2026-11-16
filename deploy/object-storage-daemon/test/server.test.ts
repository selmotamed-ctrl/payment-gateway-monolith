import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startObjectStorageDaemon, type RunningObjectStorageDaemon } from "../src/server";
import { FsBlobStore } from "../src/shared/blobStore";

describe("FsBlobStore", () => {
  test("rejects paths that escape the bucket root", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fs-blob-test-"));
    const store = new FsBlobStore(root);
    await expect(store.readBytes("HOT", "../../etc/passwd")).rejects.toThrow(/Unsafe storage relative path|traversal/);
    await expect(store.list("HOT", "../../")).rejects.toThrow(/Unsafe storage relative path/);
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe("object storage daemon HTTP surface", () => {
  let root: string;
  let daemon: RunningObjectStorageDaemon;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "object-daemon-http-"));
    daemon = await startObjectStorageDaemon({
      rootDir: root,
      bindHost: "127.0.0.1",
      port: 0,
      requireMtls: false,
    } as never);
  });

  afterAll(async () => {
    await daemon.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const put = (relPath: string, body: Buffer, sha?: string) =>
    fetch(`${daemon.baseUrl}/v1/blobs/HOT/${relPath}`, {
      method: "PUT",
      body,
      headers: {
        "content-type": "application/octet-stream",
        ...(sha ? { "x-content-sha256": sha } : {}),
      },
    });

  test("health, put, stat, get and list round-trip", async () => {
    const health = await fetch(`${daemon.baseUrl}/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const bytes = Buffer.from("hello object vault", "utf8");
    const created = await put("kyb_documents/shared/2026/11/a.v1.enc", bytes, createHash("sha256").update(bytes).digest("hex"));
    expect(created.status).toBe(201);

    const head = await fetch(`${daemon.baseUrl}/v1/blobs/HOT/kyb_documents/shared/2026/11/a.v1.enc`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-blob-byte-size")).toBe(String(bytes.byteLength));

    const got = await fetch(`${daemon.baseUrl}/v1/blobs/HOT/kyb_documents/shared/2026/11/a.v1.enc`);
    expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);

    const list = await fetch(`${daemon.baseUrl}/v1/list/HOT?prefix=kyb_documents/`);
    const listed = (await list.json()) as { items: Array<{ relPath: string }> };
    expect(listed.items.map((item) => item.relPath)).toContain("kyb_documents/shared/2026/11/a.v1.enc");
  });

  test("a PUT with a mismatched checksum is refused", async () => {
    const response = await put("bad/sha.v1.enc", Buffer.from("data"), "0".repeat(64));
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "SHA256_MISMATCH_ON_PUT" });
  });

  test("a PUT with a traversal path is refused", async () => {
    const response = await put("../escape.v1.enc", Buffer.from("data"));
    expect(response.status).toBe(400);
  });

  test("trash and purge move the blob out of the bucket", async () => {
    const bytes = Buffer.from("trash me");
    await put("trash/me.v1.enc", bytes);
    const moved = await fetch(`${daemon.baseUrl}/v1/trash/HOT/trash/me.v1.enc`, {
      method: "POST",
      body: JSON.stringify({ trashDateIso: "2026-11-12" }),
      headers: { "content-type": "application/json" },
    });
    expect(moved.status).toBe(200);
    const gone = await fetch(`${daemon.baseUrl}/v1/blobs/HOT/trash/me.v1.enc`);
    expect(gone.status).toBe(404);
    const purged = await fetch(`${daemon.baseUrl}/v1/purge-trash`, {
      method: "POST",
      body: JSON.stringify({ cutoffDateIso: "2026-11-13" }),
      headers: { "content-type": "application/json" },
    });
    const purgedBody = (await purged.json()) as { purgedCount: number };
    expect(purgedBody.purgedCount).toBeGreaterThanOrEqual(1);
    await expect(fsp.stat(path.join(root, ".trash", "2026-11-12"))).rejects.toThrow();
  });

  test("unknown buckets and routes are refused", async () => {
    const bucket = await fetch(`${daemon.baseUrl}/v1/blobs/NO_SUCH_BUCKET/x`, { method: "HEAD" });
    expect(bucket.status).toBe(400);
    const route = await fetch(`${daemon.baseUrl}/v1/nope`);
    expect(route.status).toBe(404);
  });
});
