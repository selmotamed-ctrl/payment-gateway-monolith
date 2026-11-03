import { beforeEach, describe, expect, test } from "bun:test";
import { compareLsn, isLsnGreaterOrEqual } from "../../lib/storageEngine/lsn";
import { resetUuidV7State, uuidv7 } from "../../lib/storageEngine/uuid";
import {
  DEFAULT_SHARD_COUNT,
  fnv1aHash,
  shardCountForAccountType,
  shardIdForAttempt,
  shardKey,
  signedShardDelta,
} from "../../lib/storageEngine/shardBalances";
import { stableJson } from "../../lib/storageEngine/auditAndLogAdapters";

describe("LSN comparison", () => {
  test("compares the canonical zero LSN and equal values", () => {
    expect(compareLsn("0/0", "0/0")).toBe(0);
    expect(compareLsn("0/0", "0/0")).toBe(0);
    expect(isLsnGreaterOrEqual("0/0", "0/0")).toBe(true);
    expect(compareLsn("16/B374D848", "16/B374D848")).toBe(0);
  });

  test("orders low and high halves like PostgreSQL", () => {
    expect(compareLsn("0/1", "0/0")).toBe(1);
    expect(compareLsn("0/0", "0/1")).toBe(-1);
    expect(compareLsn("1/0", "0/FFFFFFFF")).toBe(1);
    expect(compareLsn("0/FFFFFFFF", "1/0")).toBe(-1);
    expect(compareLsn("2/00000000", "1/FFFFFFFF")).toBe(1);
    expect(compareLsn("A/B", "a/b")).toBe(0);
  });

  test("handles the full 64-bit LSN range and overflow beyond it", () => {
    expect(compareLsn("FFFFFFFF/FFFFFFFF", "FFFFFFFF/FFFFFFFE")).toBe(1);
    expect(compareLsn("FFFFFFFF/FFFFFFFF", "0/0")).toBe(1);
    // The parser uses BigInt, so a high half above 32 bits does not wrap.
    expect(compareLsn("100000000/0", "FFFFFFFF/FFFFFFFF")).toBe(1);
    expect(compareLsn("100000001/0", "100000000/FFFFFFFF")).toBe(1);
  });

  test("invalid LSNs never throw and never satisfy a watermark", () => {
    expect(compareLsn("not-an-lsn", "0/0")).toBe(0);
    expect(compareLsn("0/0", "not-an-lsn")).toBe(0);
    expect(compareLsn("", "")).toBe(0);
    expect(compareLsn("0/", "0/0")).toBe(0);
    expect(compareLsn("/0", "0/0")).toBe(0);
    expect(compareLsn("0/0/1", "0/0")).toBe(0);
    expect(compareLsn("-1/0", "0/0")).toBe(0);
    expect(isLsnGreaterOrEqual("not-an-lsn", "0/0")).toBe(false);
    expect(isLsnGreaterOrEqual("0/0", "not-an-lsn")).toBe(false);
    // A malformed value WITH a slash reaches BigInt and correctly fails.
    expect(isLsnGreaterOrEqual("0/ZZZZ", "0/0")).toBe(false);
    expect(isLsnGreaterOrEqual("0/0", "0/ZZZZ")).toBe(false);
    expect(isLsnGreaterOrEqual("0/1", "0/0")).toBe(true);
  });
});

describe("UUIDv7", () => {
  beforeEach(() => {
    resetUuidV7State();
  });

  test("sets the RFC 9562 version and variant bits", () => {
    const id = uuidv7(1_700_000_000_000);
    const hex = id.replaceAll("-", "");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(hex[12]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(hex[16] as string);
  });

  test("encodes the 48-bit Unix millisecond timestamp big-endian", () => {
    const timestamps = [0, 1, 1_700_000_000_000, 2 ** 48 - 1];
    for (const timestamp of timestamps) {
      const id = uuidv7(timestamp);
      const prefix = id.slice(0, 8) + id.slice(9, 13);
      expect(BigInt(`0x${prefix}`)).toBe(BigInt(timestamp));
    }
  });

  test("stays unique and lexicographically monotonic under a fixed clock", () => {
    const fixed = 1_761_000_000_000;
    const ids = Array.from({ length: 10_000 }, () => uuidv7(fixed));
    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < ids.length; index += 1) {
      expect((ids[index] as string) > (ids[index - 1] as string)).toBe(true);
    }
    const firstPrefix = BigInt(`0x${(ids[0] as string).slice(0, 8)}${(ids[0] as string).slice(9, 13)}`);
    const lastPrefix = BigInt(`0x${(ids.at(-1) as string).slice(0, 8)}${(ids.at(-1) as string).slice(9, 13)}`);
    expect(lastPrefix >= firstPrefix).toBe(true);
  });

  test("is lexicographically ordered when the clock advances", () => {
    const base = 1_761_000_000_000;
    let previous = uuidv7(base);
    for (let index = 1; index < 10_000; index += 1) {
      const current = uuidv7(base + index);
      expect(current > previous).toBe(true);
      previous = current;
    }
  });
});

describe("FNV-1a shard hashing", () => {
  test("matches the known FNV-1a 32-bit vector", () => {
    expect(fnv1aHash("")).toBe(0x811c9dc5);
    expect(fnv1aHash("hello")).toBe(0x4f9f2cab);
    expect(fnv1aHash("hello")).toBe(fnv1aHash("hello"));
  });

  test("distributes 10k attempts reasonably evenly across 16 shards", () => {
    const buckets = Array.from({ length: DEFAULT_SHARD_COUNT }, () => 0);
    for (let index = 0; index < 10_000; index += 1) {
      const shard = shardIdForAttempt(`attempt-${index}-${(index * 7919) % 10_000}`, "TREASURY");
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(DEFAULT_SHARD_COUNT);
      buckets[shard] = (buckets[shard] ?? 0) + 1;
    }
    expect(buckets.every((count) => count > 0)).toBe(true);
    const expected = 10_000 / DEFAULT_SHARD_COUNT;
    const chiSquare = buckets.reduce(
      (sum, count) => sum + ((count - expected) ** 2) / expected,
      0,
    );
    // df = 15; a very generous bound keeps this deterministic while still
    // catching a degenerate hash.
    expect(chiSquare).toBeLessThan(60);
  });

  test("merchant wallets always use shard 0 and system accounts the configured count", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(shardIdForAttempt(`attempt-${index}`, "MERCHANT_WALLET")).toBe(0);
      expect(shardIdForAttempt(`attempt-${index}`, "MERCHANT_WALLET", 64)).toBe(0);
    }
    expect(shardCountForAccountType("TREASURY")).toBe(DEFAULT_SHARD_COUNT);
    expect(shardCountForAccountType("TREASURY", 32)).toBe(32);
    expect(shardCountForAccountType("MERCHANT_WALLET", 32)).toBe(1);
    expect(shardCountForAccountType("UNKNOWN", 0)).toBe(1);
    expect(shardKey("account", 7)).toBe("account:7");
  });

  test("signed shard deltas follow the debit-positive convention", () => {
    expect(signedShardDelta("DEBIT", "12.5000")).toBe("12.5000");
    expect(signedShardDelta("CREDIT", "12.5000")).toBe("-12.5000");
    expect(signedShardDelta("CREDIT", { toString: () => "0.0001" })).toBe("-0.0001");
  });
});

describe("stableJson", () => {
  test("sorts object keys recursively while preserving array order", () => {
    const value = {
      zebra: 1,
      alpha: {
        delta: [3, { beta: 2, alpha: 1 }, "x"],
        gamma: null,
      },
      beta: true,
    };
    expect(stableJson(value)).toBe(
      '{"alpha":{"delta":[3,{"alpha":1,"beta":2},"x"],"gamma":null},"beta":true,"zebra":1}',
    );
  });

  test("is independent of insertion order and escapes keys correctly", () => {
    const left = { b: { z: 1, a: 2 }, a: "line\nbreak", "quote\"key": 3 };
    const right = { a: "line\nbreak", "quote\"key": 3, b: { a: 2, z: 1 } };
    expect(stableJson(left)).toBe(stableJson(right));
    expect(stableJson(["b", "a"])).not.toBe(stableJson(["a", "b"]));
    expect(stableJson({ "a/b": "c" })).toBe('{"a/b":"c"}');
  });

  test("round-trips primitives and nested arrays deterministically", () => {
    expect(stableJson(null)).toBe("null");
    expect(stableJson("x")).toBe('"x"');
    expect(stableJson(42)).toBe("42");
    expect(stableJson(false)).toBe("false");
    const value = [[{ b: 1, a: 2 }], [], { "": 0 }];
    expect(stableJson(value)).toBe('[[{"a":2,"b":1}],[],{"":0}]');
    expect(JSON.parse(stableJson(value))).toEqual(value);
  });
});
