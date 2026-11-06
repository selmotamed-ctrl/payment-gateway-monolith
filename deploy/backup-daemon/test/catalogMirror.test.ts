import { describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { ArtifactRepository, MemoryArtifactStore } from "../src/artifactStore";
import { CATALOG_KEY, RepositoryCatalogMirror } from "../src/catalogMirror";
import { CatalogStore, createDefaultPolicy, type BackupRun } from "../src/catalogStore";
import { masterKeyFromHex } from "../src/cryptoEnvelope";
import { ENCRYPTION_KEY_HEX, MemoryCatalogFileSystem, tempDir } from "./helpers";

const master = masterKeyFromHex(ENCRYPTION_KEY_HEX);
const run = (id: string): BackupRun => ({
  id, target: "postgres_core", kind: "full", engine: "pg-native", status: "PASSED",
  startedAt: "2026-11-06T02:00:00.000Z", completedAt: "2026-11-06T02:01:00.000Z", storageTargets: ["local-repo"],
});

const setup = async () => {
  const staging = await tempDir("bd-cat-");
  const s3 = new MemoryArtifactStore("primary-s3");
  const vault = new MemoryArtifactStore("secondary-ssh", "Vault", "ssh");
  const mirror = new RepositoryCatalogMirror(new ArtifactRepository([s3, vault]), master, staging);
  return { staging, s3, vault, mirror };
};
const load = (mirror: RepositoryCatalogMirror, fileSystem = new MemoryCatalogFileSystem()) =>
  CatalogStore.load({ path: "/virtual/catalog.json", defaultPolicy: createDefaultPolicy({ updatedAt: "2026-11-06T00:00:00.000Z" }), fileSystem, mirror });

describe("catalog mirroring and recovery", () => {
  test("every catalog save uploads an ENCRYPTED copy to every tier", async () => {
    const { s3, vault, mirror, staging } = await setup();
    const catalog = await load(mirror);
    await catalog.addRun(run("run-1"));
    await catalog.whenMirrored();
    for (const store of [s3, vault]) {
      const stored = store.objects.get(CATALOG_KEY)!;
      expect(stored).toBeDefined();
      expect(stored.includes(Buffer.from("run-1"))).toBe(false);
    }
    expect(await nodeFs.readdir(staging)).toEqual([]); // no temp files left behind
    await nodeFs.rm(staging, { recursive: true, force: true });
  });

  test("a replacement host recovers runs AND the approved policy from the mirror, then persists them locally", async () => {
    const { mirror, staging } = await setup();
    const original = await load(mirror);
    await original.updatePolicy({ fullRetentionDays: 90, updatedBy: "checker-1" });
    await original.addRun(run("run-1"));
    await original.addRun(run("run-2"));
    await original.whenMirrored();

    const freshDisk = new MemoryCatalogFileSystem();
    const replacement = await load(mirror, freshDisk);
    expect(replacement.recovered).toBe(true);
    expect(replacement.listRuns(10).map((entry) => entry.id).sort()).toEqual(["run-1", "run-2"]);
    expect(replacement.getPolicy()).toMatchObject({ fullRetentionDays: 90, updatedBy: "checker-1" });
    expect(freshDisk.files.get("/virtual/catalog.json")).toContain("run-2");
    await nodeFs.rm(staging, { recursive: true, force: true });
  });

  test("an existing local catalog is NOT overwritten by the mirror", async () => {
    const { mirror, staging } = await setup();
    const first = await load(mirror);
    await first.addRun(run("mirrored"));
    await first.whenMirrored();
    const local = new MemoryCatalogFileSystem();
    const seeded = await CatalogStore.load({ path: "/virtual/catalog.json", fileSystem: local, defaultPolicy: createDefaultPolicy() });
    await seeded.addRun(run("local-only"));
    const reloaded = await load(mirror, local);
    expect(reloaded.recovered).toBe(false);
    expect(reloaded.listRuns(10).map((entry) => entry.id)).toEqual(["local-only"]);
    await nodeFs.rm(staging, { recursive: true, force: true });
  });

  test("a tampered or wrong-key mirror is ignored: the host starts clean instead of trusting it", async () => {
    const { s3, vault, mirror, staging } = await setup();
    const catalog = await load(mirror);
    await catalog.addRun(run("run-1"));
    await catalog.whenMirrored();
    for (const store of [s3, vault]) {
      const bytes = Buffer.from(store.objects.get(CATALOG_KEY)!);
      bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 1;
      store.objects.set(CATALOG_KEY, bytes);
    }
    const recovered = await load(mirror);
    expect(recovered.recovered).toBe(false);
    expect(recovered.listRuns(10)).toEqual([]);

    const otherKey = new RepositoryCatalogMirror(new ArtifactRepository([s3]), masterKeyFromHex("ab".repeat(32)), staging);
    expect(await otherKey.download()).toBeNull();
    await nodeFs.rm(staging, { recursive: true, force: true });
  });

  test("the mirror falls back to the next tier when the first is damaged, and never blocks or breaks catalog writes when it is down", async () => {
    const { s3, vault, mirror, staging } = await setup();
    const catalog = await load(mirror);
    await catalog.addRun(run("run-1"));
    await catalog.whenMirrored();
    s3.objects.set(CATALOG_KEY, Buffer.from("garbage"));
    expect(await mirror.download()).toContain("run-1"); // served by the vault

    s3.failPuts = true;
    vault.failPuts = true;
    const result = await catalog.addRun(run("run-2"));
    expect(result.id).toBe("run-2");
    await catalog.whenMirrored();
    expect(catalog.getMirrorError()).toBeDefined();
    expect(catalog.listRuns(10)).toHaveLength(2);
    await nodeFs.rm(staging, { recursive: true, force: true });
  });

  test("runs that were QUEUED/RUNNING when the daemon stopped are failed on restart instead of staying RUNNING forever", async () => {
    const catalog = await CatalogStore.load({ path: "/virtual/c.json", fileSystem: new MemoryCatalogFileSystem(), defaultPolicy: createDefaultPolicy() });
    await catalog.addRun({ ...run("finished"), status: "PASSED" });
    await catalog.addRun({ ...run("was-running"), status: "RUNNING", completedAt: undefined });
    await catalog.addRun({ ...run("was-queued"), status: "QUEUED", completedAt: undefined });
    expect((await catalog.failInterruptedRuns()).sort()).toEqual(["was-queued", "was-running"]);
    const byId = Object.fromEntries(catalog.listRuns(10).map((entry) => [entry.id, entry]));
    expect(byId["finished"]!.status).toBe("PASSED");
    expect(byId["was-running"]).toMatchObject({ status: "FAILED", errorMessage: expect.stringContaining("daemon restarted") });
    expect(byId["was-running"]!.completedAt).toBeDefined();
    expect(await catalog.failInterruptedRuns()).toEqual([]);
    expect(catalog.hasFinishedJob("finished")).toBe(true);
    expect(catalog.hasFinishedJob("was-running")).toBe(true); // now FAILED, i.e. finished
    expect(catalog.hasFinishedJob("never-heard-of-it")).toBe(false);
  });

  test("importRuns adds history rebuilt from manifests without duplicating known ids", async () => {
    const catalog = await CatalogStore.load({ path: "/virtual/c.json", fileSystem: new MemoryCatalogFileSystem(), defaultPolicy: createDefaultPolicy() });
    await catalog.addRun(run("known"));
    expect(await catalog.importRuns([run("known"), run("rebuilt-1"), run("rebuilt-2")])).toBe(2);
    expect(catalog.listRuns(10)).toHaveLength(3);
    expect(await catalog.importRuns([run("rebuilt-1")])).toBe(0);
  });
});
