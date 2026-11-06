import { afterAll, describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import {
  ArtifactRepository,
  LocalRepoStore,
  MemoryArtifactStore,
  RepositoryWriteError,
  S3ObjectStore,
  VaultStore,
  assertSafeKey,
  parseBucketSpec,
  type S3ClientLike,
} from "../src/artifactStore";
import { buildRepository } from "../src/repository";
import { sha256Hex } from "../src/util";
import { RecordingRunner, makeConfig, tempDir } from "./helpers";

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await tempDir("bd-store-");
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await nodeFs.rm(dir, { recursive: true, force: true });
});

describe("artifact keys", () => {
  test("accept the documented layout and refuse traversal, absolute paths and odd characters", () => {
    for (const ok of ["wal/postgres_core/000000010000000000000001.zst.enc", "backups/audit_db/bkp_1.manifest.json", "catalog/catalog.json.enc"]) {
      expect(assertSafeKey(ok)).toBe(ok);
    }
    for (const bad of ["../etc/passwd", "/abs/path", "a/../b", "a//b", "a/./b", "", "wal/$(rm -rf)", "a b", "a\nb", ".."]) {
      expect(() => assertSafeKey(bad)).toThrow("unsafe artifact key");
    }
  });
});

describe("LocalRepoStore", () => {
  test("round-trips files and buffers atomically and lists keys", async () => {
    const root = await scratch();
    const store = new LocalRepoStore(join(root, "repo"));
    const src = join(root, "src.bin");
    await nodeFs.writeFile(src, "payload");
    await store.putFile("wal/postgres_core/a.enc", src);
    await store.putBuffer("wal/postgres_core/b.enc", Buffer.from("buffer"));
    await store.putBuffer("backups/postgres_core/m.manifest.json", Buffer.from("{}"));

    expect(await store.exists("wal/postgres_core/a.enc")).toBe(true);
    expect(await store.exists("wal/postgres_core/zzz.enc")).toBe(false);
    expect((await store.getBuffer("wal/postgres_core/b.enc"))?.toString()).toBe("buffer");
    expect(await store.getBuffer("missing/key")).toBeNull();
    expect(await store.list("wal/postgres_core")).toEqual(["wal/postgres_core/a.enc", "wal/postgres_core/b.enc"]);
    expect(await store.list("")).toHaveLength(3);
    const out = join(root, "out.bin");
    await store.getFile("wal/postgres_core/a.enc", out);
    expect(await nodeFs.readFile(out, "utf8")).toBe("payload");
    await store.delete("wal/postgres_core/a.enc");
    expect(await store.exists("wal/postgres_core/a.enc")).toBe(false);
  });

  test("cannot be coaxed outside its root and never lists in-flight temp files", async () => {
    const root = await scratch();
    const store = new LocalRepoStore(join(root, "repo"));
    expect(() => store.pathFor("../escape")).toThrow();
    await nodeFs.mkdir(join(root, "repo", "wal"), { recursive: true });
    await nodeFs.writeFile(join(root, "repo", "wal", ".half.123.1.tmp"), "partial");
    await nodeFs.writeFile(join(root, "repo", "wal", "done.enc"), "x");
    expect(await store.list("wal")).toEqual(["wal/done.enc"]);
  });

  test("health reports writability and free space", async () => {
    const root = await scratch();
    const health = await new LocalRepoStore(join(root, "repo")).health();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain("MiB free");
  });
});

describe("S3ObjectStore (Bun.S3Client contract)", () => {
  const fakeS3 = () => {
    const objects = new Map<string, Buffer>();
    const calls: string[] = [];
    const client: S3ClientLike = {
      write: async (key, data) => {
        calls.push(`write:${key}`);
        const buffer = typeof data === "string" ? Buffer.from(data) : data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
        objects.set(key, buffer);
        return buffer.length;
      },
      file: (key) => ({
        exists: async () => objects.has(key),
        arrayBuffer: async () => {
          const value = objects.get(key);
          if (!value) throw new Error("NoSuchKey");
          return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
        },
      }),
      delete: async (key) => {
        objects.delete(key);
      },
      exists: async (key) => objects.has(key),
      list: async ({ prefix = "", continuationToken } = {}) => {
        const all = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = continuationToken ? Number(continuationToken) : 0;
        const page = all.slice(start, start + 2);
        const next = start + 2 < all.length;
        return { contents: page.map((key) => ({ key })), isTruncated: next, nextContinuationToken: next ? String(start + 2) : undefined };
      },
    };
    return { client, objects, calls };
  };

  test("parses s3://bucket/prefix and bare bucket names", () => {
    expect(parseBucketSpec("s3://libya-pg-backups-primary/prod")).toEqual({ bucket: "libya-pg-backups-primary", prefix: "prod" });
    expect(parseBucketSpec("s3://bucket/a/b/")).toEqual({ bucket: "bucket", prefix: "a/b" });
    expect(parseBucketSpec("bucket")).toEqual({ bucket: "bucket", prefix: "" });
  });

  test("keys live under the configured prefix; listing strips it and follows pagination", async () => {
    const { client, objects } = fakeS3();
    const store = new S3ObjectStore({ endpoint: "http://minio:9000", bucketSpec: "s3://b/prod", accessKeyId: "k", secretAccessKey: "s", client });
    const dir = await scratch();
    const file = join(dir, "f");
    await nodeFs.writeFile(file, "file-bytes");
    await store.putFile("wal/postgres_core/1.enc", file);
    for (const n of [2, 3, 4, 5]) await store.putBuffer(`wal/postgres_core/${n}.enc`, Buffer.from(`b${n}`));
    await store.putBuffer("backups/postgres_core/x.manifest.json", Buffer.from("{}"));

    expect([...objects.keys()].every((key) => key.startsWith("prod/"))).toBe(true);
    expect(await store.list("wal/postgres_core")).toEqual([1, 2, 3, 4, 5].map((n) => `wal/postgres_core/${n}.enc`));
    expect(await store.exists("wal/postgres_core/3.enc")).toBe(true);
    expect((await store.getBuffer("wal/postgres_core/2.enc"))?.toString()).toBe("b2");
    expect(await store.getBuffer("wal/postgres_core/nope.enc")).toBeNull();
    const out = join(dir, "out");
    await store.getFile("wal/postgres_core/1.enc", out);
    expect(await nodeFs.readFile(out, "utf8")).toBe("file-bytes");
    await store.delete("wal/postgres_core/1.enc");
    expect(await store.exists("wal/postgres_core/1.enc")).toBe(false);
  });

  test("health does a real write/read/delete round trip and reports failures", async () => {
    const { client, objects } = fakeS3();
    const store = new S3ObjectStore({ endpoint: "http://minio:9000", bucketSpec: "b", accessKeyId: "k", secretAccessKey: "s", client });
    expect(await store.health()).toMatchObject({ healthy: true });
    expect(objects.size).toBe(0); // the probe object is cleaned up

    const broken = new S3ObjectStore({
      endpoint: "http://minio:9000", bucketSpec: "b", accessKeyId: "k", secretAccessKey: "s",
      client: { ...client, write: async () => { throw new Error("connect ECONNREFUSED 10.0.0.9:9000"); } },
    });
    const health = await broken.health();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("ECONNREFUSED");
  });
});

describe("VaultStore (off-site vault)", () => {
  test("ssh mode copies with rsync and verifies the remote SHA-256, failing on a mismatch", async () => {
    const dir = await scratch();
    const file = join(dir, "artifact.enc");
    await nodeFs.writeFile(file, "ciphertext-bytes");
    const expected = sha256Hex(Buffer.from("ciphertext-bytes"));

    const good = new RecordingRunner((command, args) =>
      command === "ssh" && args.at(-1)!.startsWith("sha256sum") ? { code: 0, stdout: `${expected}  /vault/x\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
    const vault = new VaultStore({ target: "vault@198.51.100.9:/mnt/vault/pg", runner: good, allowDelete: false });
    await vault.putFile("wal/postgres_core/1.enc", file);
    const rsync = good.calls.find((call) => call.command === "rsync");
    expect(rsync?.args.at(-1)).toBe("vault@198.51.100.9:/mnt/vault/pg/wal/postgres_core/1.enc");
    expect(good.calls.some((call) => call.command === "ssh" && call.args.at(-1)!.includes("mkdir -p '/mnt/vault/pg/wal/postgres_core'"))).toBe(true);

    const corrupt = new RecordingRunner((command, args) =>
      command === "ssh" && args.at(-1)!.startsWith("sha256sum") ? { code: 0, stdout: `${"0".repeat(64)}  /vault/x\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
    await expect(new VaultStore({ target: "vault@h:/p", runner: corrupt, allowDelete: false }).putFile("a/b.enc", file)).rejects.toThrow("checksum mismatch");
  });

  test("is append-only by default: delete is a no-op and issues no command", async () => {
    const runner = new RecordingRunner();
    const vault = new VaultStore({ target: "vault@h:/p", runner, allowDelete: false });
    await vault.delete("wal/postgres_core/1.enc");
    expect(runner.calls).toHaveLength(0);
    const deleting = new VaultStore({ target: "vault@h:/p", runner, allowDelete: true });
    await deleting.delete("wal/postgres_core/1.enc");
    expect(runner.calls[0]?.args.at(-1)).toContain("rm -f '/p/wal/postgres_core/1.enc'");
  });

  test("rclone modes (s3:// and rclone:remote:path) use rclone", async () => {
    const dir = await scratch();
    const file = join(dir, "f");
    await nodeFs.writeFile(file, "x");
    const runner = new RecordingRunner((command, args) =>
      args[0] === "lsf" ? { code: 0, stdout: "a.enc\nsub/b.enc\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    const vault = new VaultStore({ target: "rclone:offsite:pg", runner, allowDelete: true });
    await vault.putFile("wal/x.enc", file);
    expect(runner.calls[0]).toMatchObject({ command: "rclone", args: ["copyto", file, "offsite:pg/wal/x.enc"] });
    expect(await vault.list("wal")).toEqual(["wal/a.enc", "wal/sub/b.enc"]);
    expect(() => new VaultStore({ target: "not-a-target", runner, allowDelete: false })).toThrow("BACKUP_SECONDARY_SSH_TARGET");
  });

  test("health reports an unreachable vault", async () => {
    const runner = new RecordingRunner(() => ({ code: 255, stdout: "", stderr: "ssh: connect to host h port 22: Connection refused" }));
    const health = await new VaultStore({ target: "vault@h:/p", runner, allowDelete: false }).health();
    expect(health).toMatchObject({ healthy: false });
    expect(health.detail).toContain("Connection refused");
  });
});

describe("ArtifactRepository (3-2-1 fan-out)", () => {
  const stores = () => ({
    local: new MemoryArtifactStore("local-repo", "Local", "local"),
    s3: new MemoryArtifactStore("primary-s3", "S3", "s3"),
    vault: new MemoryArtifactStore("secondary-ssh", "Vault", "ssh"),
  });

  test("writes to every tier and reads fall back across tiers", async () => {
    const { local, s3, vault } = stores();
    const repo = new ArtifactRepository([local, s3, vault]);
    const outcome = await repo.putBuffer("wal/x.enc", Buffer.from("data"));
    expect(outcome.stored.sort()).toEqual(["local-repo", "primary-s3", "secondary-ssh"]);
    local.objects.clear();
    s3.objects.clear();
    expect((await repo.getBuffer("wal/x.enc"))?.toString()).toBe("data"); // served by the vault
  });

  test("a failed required tier (local or S3) fails the write; a failed off-site vault does not", async () => {
    {
      const { local, s3, vault } = stores();
      vault.failPuts = true;
      const outcome = await new ArtifactRepository([local, s3, vault]).putBuffer("a/b.enc", Buffer.from("1"));
      expect(outcome.failed.map((entry) => entry.id)).toEqual(["secondary-ssh"]);
      expect(outcome.stored.sort()).toEqual(["local-repo", "primary-s3"]);
    }
    {
      const { local, s3, vault } = stores();
      s3.failPuts = true;
      const promise = new ArtifactRepository([local, s3, vault]).putBuffer("a/b.enc", Buffer.from("1"));
      await expect(promise).rejects.toBeInstanceOf(RepositoryWriteError);
      await expect(promise).rejects.toThrow("primary-s3");
    }
  });

  test("getFileVerified skips a corrupt copy on one tier and serves the verified copy from the next", async () => {
    const dir = await scratch();
    const { local, s3, vault } = stores();
    const repo = new ArtifactRepository([local, s3, vault]);
    await local.putBuffer("backups/x.enc", Buffer.from("BIT-ROTTED"));
    await s3.putBuffer("backups/x.enc", Buffer.from("good-bytes"));
    const dest = join(dir, "out.enc");
    const verify = async (path: string): Promise<void> => {
      if ((await nodeFs.readFile(path, "utf8")) !== "good-bytes") throw new Error("ciphertext checksum mismatch");
    };
    expect(await repo.getFileVerified("backups/x.enc", dest, verify)).toBe("primary-s3");
    expect(await nodeFs.readFile(dest, "utf8")).toBe("good-bytes");

    s3.objects.set("backups/x.enc", Buffer.from("ALSO-BAD"));
    await nodeFs.rm(dest, { force: true });
    const failure = repo.getFileVerified("backups/x.enc", dest, verify);
    await expect(failure).rejects.toThrow("failed verification on every storage tier");
    await expect(failure).rejects.toThrow("checksum mismatch");
    await expect(nodeFs.access(dest)).rejects.toThrow(); // the bad copy is not left lying around
  });

  test("getFile reports which tiers were tried when the artifact is nowhere", async () => {
    const { local, s3 } = stores();
    await expect(new ArtifactRepository([local, s3]).getFile("nope/x.enc", "/tmp/never")).rejects.toThrow("not available on any storage tier");
  });

  test("list merges tiers; listByStore keeps them separate; delete honours append-only tiers", async () => {
    const { local, s3 } = stores();
    const vault = new MemoryArtifactStore("secondary-ssh", "Vault", "ssh", false);
    const repo = new ArtifactRepository([local, s3, vault]);
    await local.putBuffer("w/1.enc", Buffer.from("1"));
    await s3.putBuffer("w/2.enc", Buffer.from("2"));
    expect(await repo.list("w")).toEqual(["w/1.enc", "w/2.enc"]);
    const per = await repo.listByStore("w");
    expect([...per.get("local-repo")!]).toEqual(["w/1.enc"]);
    await repo.putBuffer("w/3.enc", Buffer.from("3"));
    await repo.delete("w/3.enc");
    expect(await vault.exists("w/3.enc")).toBe(true); // append-only vault kept it
    expect(await local.exists("w/3.enc")).toBe(false);
  });

  test("needs at least one tier", () => {
    expect(() => new ArtifactRepository([])).toThrow("at least one");
  });
});

describe("buildRepository", () => {
  test("pg-native with no S3 gets just the local repository (air-gapped LAN)", () => {
    const repo = buildRepository(makeConfig({ BACKUP_ENGINE_MODE: "pg-native", BACKUP_PRIMARY_S3_ENDPOINT: "", BACKUP_PRIMARY_S3_BUCKET: "" }), new RecordingRunner());
    expect(repo.stores.map((store) => store.id)).toEqual(["local-repo"]);
  });

  test("tiers come in restore-preference order: local, S3, off-site vault", () => {
    const repo = buildRepository(
      makeConfig({ BACKUP_ENGINE_MODE: "pg-native", BACKUP_SECONDARY_SSH_TARGET: "vault@h:/p" }),
      new RecordingRunner(),
    );
    expect(repo.stores.map((store) => store.id)).toEqual(["local-repo", "primary-s3", "secondary-ssh"]);
    expect(repo.stores[2]!.allowDelete).toBe(false);
  });

  test("wal-g without a local repository uses S3 only; mirror-delete opts the vault into deletes", () => {
    const repo = buildRepository(makeConfig({ BACKUP_SECONDARY_SSH_TARGET: "vault@h:/p", BACKUP_SECONDARY_MIRROR_DELETE: "true" }), new RecordingRunner());
    expect(repo.stores.map((store) => store.id)).toEqual(["primary-s3", "secondary-ssh"]);
    expect(repo.stores[1]!.allowDelete).toBe(true);
  });
});
