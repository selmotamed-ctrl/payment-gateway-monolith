import { describe, expect, test } from "bun:test";
import { parseArgs, rollingBatches } from "../deploy";

describe("rolling deploy batches", () => {
  test("preserves node order and covers every node exactly once", () => {
    const nodes = ["core-1", "core-2", "core-3", "core-4", "core-5"];
    const batches = rollingBatches(nodes, 2);
    expect(batches).toEqual([["core-1", "core-2"], ["core-3", "core-4"], ["core-5"]]);
    expect(batches.flat()).toEqual(nodes);
    expect(new Set(batches.flat()).size).toBe(nodes.length);
  });

  test("clamps an invalid or oversized batch size", () => {
    expect(rollingBatches(["a", "b", "c"], 0)).toEqual([["a"], ["b"], ["c"]]);
    expect(rollingBatches(["a", "b", "c"], -5)).toEqual([["a"], ["b"], ["c"]]);
    expect(rollingBatches(["a", "b", "c"], 30)).toEqual([["a", "b", "c"]]);
    expect(rollingBatches([], 3)).toEqual([]);
  });

  test("a failed batch stops before the next batch (no-downtime ordering invariant)", () => {
    const applied: string[] = [];
    const batches = rollingBatches(["core-1", "core-2", "core-3"], 1);
    let failed = false;
    for (const [index, batch] of batches.entries()) {
      applied.push(...batch);
      if (index === 0) {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(applied).toEqual(["core-1"]);
    expect(applied).not.toContain("core-2");
  });

  test("parses --rolling-batch and --nodes while extending --only with storage roles", () => {
    const options = parseArgs([
      "--only=core,pg,redis,audit-db,log-db,backup,storage",
      "--rolling-batch=3",
      "--nodes=core-1,chk-2",
    ]);
    expect(options.rollingBatch).toBe(3);
    expect([...options.only]).toEqual(["core", "pg", "redis", "audit-db", "log-db", "backup", "storage"]);
    expect([...(options.nodes ?? [])]).toEqual(["core-1", "chk-2"]);
  });

  test("rejects invalid rolling batch sizes", () => {
    expect(() => parseArgs(["--rolling-batch=0"])).toThrow(/Invalid --rolling-batch/);
    expect(() => parseArgs(["--rolling-batch=abc"])).toThrow(/Invalid --rolling-batch/);
  });
});
