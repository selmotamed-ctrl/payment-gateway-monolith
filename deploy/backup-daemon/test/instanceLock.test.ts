import { afterAll, describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { InstanceLockError, acquireInstanceLock } from "../src/instanceLock";
import { tempDir } from "./helpers";

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await tempDir("bd-lock-");
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await nodeFs.rm(dir, { recursive: true, force: true });
});

describe("one daemon per state directory", () => {
  test("a live holder blocks a second daemon with a clear error; release lets the next one in", async () => {
    const path = join(await scratch(), "state", "daemon.lock");
    const first = await acquireInstanceLock(path, { pid: 1111, isAlive: () => true, commandLine: async () => "bun run src/index.ts" });
    await expect(
      acquireInstanceLock(path, { pid: 2222, isAlive: (pid) => pid === 1111, commandLine: async () => "bun run src/index.ts" }),
    ).rejects.toBeInstanceOf(InstanceLockError);
    await expect(
      acquireInstanceLock(path, { pid: 2222, isAlive: (pid) => pid === 1111, commandLine: async () => "bun run src/index.ts" }),
    ).rejects.toThrow("pid 1111");

    await first.release();
    await expect(nodeFs.access(path)).rejects.toThrow();
    const second = await acquireInstanceLock(path, { pid: 2222 });
    expect(JSON.parse(await nodeFs.readFile(path, "utf8")).pid).toBe(2222);
    await second.release();
  });

  test("a stale lock (holder crashed) is taken over", async () => {
    const path = join(await scratch(), "daemon.lock");
    await nodeFs.writeFile(path, JSON.stringify({ pid: 999999, startedAt: "2026-01-01T00:00:00Z" }));
    const lock = await acquireInstanceLock(path, { pid: 3333, isAlive: () => false });
    expect(JSON.parse(await nodeFs.readFile(path, "utf8")).pid).toBe(3333);
    await lock.release();
  });

  test("a recycled pid that now belongs to an unrelated program does not block the daemon", async () => {
    const path = join(await scratch(), "daemon.lock");
    await nodeFs.writeFile(path, JSON.stringify({ pid: 4444 }));
    const lock = await acquireInstanceLock(path, { pid: 5555, isAlive: () => true, commandLine: async () => "/usr/bin/nginx -g daemon off" });
    expect(JSON.parse(await nodeFs.readFile(path, "utf8")).pid).toBe(5555);
    await lock.release();
  });

  test("a corrupt lock file is treated as stale", async () => {
    const path = join(await scratch(), "daemon.lock");
    await nodeFs.writeFile(path, "{not json");
    const lock = await acquireInstanceLock(path, { pid: 6666 });
    expect(JSON.parse(await nodeFs.readFile(path, "utf8")).pid).toBe(6666);
    await lock.release();
  });

  test("release never removes a lock that now belongs to someone else", async () => {
    const path = join(await scratch(), "daemon.lock");
    const mine = await acquireInstanceLock(path, { pid: 7777 });
    await nodeFs.writeFile(path, JSON.stringify({ pid: 8888 })); // taken over meanwhile
    await mine.release();
    expect(JSON.parse(await nodeFs.readFile(path, "utf8")).pid).toBe(8888);
  });

  test("STRESS: 300 rounds of simultaneous starts on a fresh directory never produce two holders", async () => {
    const dir = await scratch();
    const deps = { isAlive: () => true, commandLine: async () => "bun index.ts" };
    for (let round = 0; round < 300; round += 1) {
      const path = join(dir, `round-${round}.lock`);
      const results = await Promise.allSettled([1, 2, 3, 4].map((n) => acquireInstanceLock(path, { ...deps, pid: 1000 + n })));
      const winners = results.filter((result) => result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      const holder = JSON.parse(await nodeFs.readFile(path, "utf8")).pid;
      expect((winners[0] as PromiseFulfilledResult<{ release: () => Promise<void> }>).value).toBeDefined();
      expect([1001, 1002, 1003, 1004]).toContain(holder);
    }
  });

  test("STRESS: simultaneous starts that all find the same STALE lock still end with exactly one holder", async () => {
    const dir = await scratch();
    for (let round = 0; round < 200; round += 1) {
      const path = join(dir, `stale-${round}.lock`);
      await nodeFs.writeFile(path, JSON.stringify({ pid: 999999, startedAt: "2026-01-01T00:00:00Z" }));
      const deps = { isAlive: (pid: number) => pid < 2000 && pid >= 1000, commandLine: async () => "bun index.ts" };
      const results = await Promise.allSettled([1, 2, 3].map((n) => acquireInstanceLock(path, { ...deps, pid: 1000 + n })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    }
  });

  test("two real concurrent starts: exactly one wins", async () => {
    const path = join(await scratch(), "daemon.lock");
    const deps = { isAlive: () => true, commandLine: async () => "bun index.ts" };
    const results = await Promise.allSettled([
      acquireInstanceLock(path, { ...deps, pid: 101 }),
      acquireInstanceLock(path, { ...deps, pid: 102 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
