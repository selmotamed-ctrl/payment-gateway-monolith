/**
 * Suite 03.2 — recursiveSet / recursiveSelect 1,400-vector fuzz suite plus
 * prototype-pollution and malformed-path guards.
 */
import { describe, expect, test } from "bun:test";
import {
  Xoshiro128StarStar,
  errorCode,
} from "../_harness";
import { recursiveSet, recursiveSetImmutable } from "../../../engine/apiConsumer/recursiveSet";
import { recursiveSelect } from "../../../engine/apiConsumer/recursiveSelect";

const prng = new Xoshiro128StarStar("selectors-exhaustive");
const SEGMENTS = [
  "a",
  "b",
  "c",
  "d",
  "items",
  "0",
  "1",
  "2",
  "merchantTransInfo",
  "transAmount",
  "currency",
  "amount",
  "deep",
  "nested",
  "value",
] as const;

interface Vector {
  path: string[];
  value: string;
}

const VECTORS: Vector[] = Array.from({ length: 700 }, (_, index) => {
  const depth = prng.int(1, 5);
  const path = Array.from({ length: depth }, () => prng.pick(SEGMENTS));
  return {
    path,
    value: `v-${index}-${prng.int(0, 999_999)}`,
  };
});

describe("Suite 03 · recursiveSet fuzzer", () => {
  for (const [index, vector] of VECTORS.entries()) {
    test(`set vector #${index + 1} (${vector.path.join(".")}) creates the nested path`, () => {
      const target: Record<string, unknown> = {};
      recursiveSet(target, vector.path, vector.value);
      expect(recursiveSelect(target, vector.path)).toBe(vector.value);
      // Sibling preservation: a second write must never clobber the first.
      const sibling = `${vector.value}-sibling`;
      recursiveSet(target, [...vector.path.slice(0, -1), "sibling"], sibling);
      expect(recursiveSelect(target, [...vector.path.slice(0, -1), "sibling"])).toBe(sibling);
      expect(recursiveSelect(target, vector.path)).toBe(vector.value);
    });
  }

  test("numeric segments create arrays", () => {
    const target: Record<string, unknown> = {};
    recursiveSet(target, "items.0.price", "10.00");
    recursiveSet(target, "items.1.price", "20.00");
    expect(Array.isArray(target.items)).toBe(true);
    expect(recursiveSelect(target, "items.0.price")).toBe("10.00");
    expect(recursiveSelect(target, "items.1.price")).toBe("20.00");
  });

  test("deep object creation preserves siblings", () => {
    const target: Record<string, unknown> = {};
    recursiveSet(target, "transAmount.amount", "100.0000");
    recursiveSet(target, "transAmount.currency", "LYD");
    recursiveSet(target, "merchantTransInfo.merchantTransID", "MT-1");
    expect(target).toEqual({
      transAmount: { amount: "100.0000", currency: "LYD" },
      merchantTransInfo: { merchantTransID: "MT-1" },
    });
  });

  test("recursiveSetImmutable does not mutate the source", () => {
    const source: Record<string, unknown> = { a: { b: 1 } };
    const updated = recursiveSetImmutable(source, "a.c", 2);
    expect(recursiveSelect(updated, "a.c")).toBe(2);
    expect(recursiveSelect(source, "a.c")).toBeUndefined();
  });
});

describe("Suite 03 · recursiveSelect fuzzer", () => {
  for (const [index, vector] of VECTORS.entries()) {
    test(`select vector #${index + 1} (${vector.path.join(".")}) returns the stored value`, () => {
      const target: Record<string, unknown> = {};
      recursiveSet(target, vector.path, vector.value);
      expect(recursiveSelect(target, vector.path)).toBe(vector.value);
      // A missing leaf must be undefined, never throw.
      expect(recursiveSelect(target, [...vector.path, "missing", "leaf"])).toBeUndefined();
    });
  }

  test("selecting through a scalar returns undefined", () => {
    expect(recursiveSelect({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  test("selecting through null returns undefined", () => {
    expect(recursiveSelect({ a: null }, "a.b")).toBeUndefined();
  });

  test("selecting a top-level own property works", () => {
    expect(recursiveSelect({ key: "value" }, "key")).toBe("value");
  });

  test("selecting a dotted key that exists literally is not supported", () => {
    expect(recursiveSelect({ "a.b": 1 }, "a.b")).toBeUndefined();
  });
});

describe("Suite 03 · malformed paths", () => {
  const malformed = ["", "a..b", ".a", "a.", "..", "."];
  for (const path of malformed) {
    test(`recursiveSet rejects '${path}'`, () => {
      let code: string | undefined;
      try {
        recursiveSet({}, path, 1);
      } catch (error) {
        code = errorCode(error);
      }
      expect(code).toBe("INVALID_PATH");
    });

    test(`recursiveSelect rejects '${path}'`, () => {
      let code: string | undefined;
      try {
        recursiveSelect({}, path);
      } catch (error) {
        code = errorCode(error);
      }
      expect(code).toBe("INVALID_PATH");
    });
  }

  test("an empty array path is rejected", () => {
    expect(errorCode(catchError(() => recursiveSet({}, [], 1)))).toBe("INVALID_PATH");
  });

  test("a non-object target is rejected", () => {
    expect(errorCode(catchError(() => recursiveSet(null as never, "a", 1)))).toBe("INVALID_TARGET");
  });
});

describe("Suite 03 · prototype pollution guards", () => {
  const vectors = [
    "__proto__.polluted",
    "constructor.prototype.polluted",
    "a.__proto__.b",
    "a.constructor.prototype.b",
    "__proto__",
    "constructor",
    "prototype",
  ];
  for (const vector of vectors) {
    test(`recursiveSet blocks ${vector}`, () => {
      expect(errorCode(catchError(() => recursiveSet({}, vector, "polluted")))).toBe(
        "PROTOTYPE_POLLUTION_BLOCKED",
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test(`recursiveSelect blocks ${vector}`, () => {
      expect(errorCode(catchError(() => recursiveSelect({}, vector)))).toBe(
        "PROTOTYPE_POLLUTION_BLOCKED",
      );
    });
  }

  test("a polluted payload does not modify Object.prototype", () => {
    const payload = JSON.parse('{"__proto__":{"isAdmin":true}}') as Record<string, unknown>;
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("isAdmin");
    expect(payload).toBeDefined();
  });

  test("a legitimate key named '__proto__-like' is still allowed", () => {
    const target: Record<string, unknown> = {};
    recursiveSet(target, "meta.__proto__value", "ok");
    expect(recursiveSelect(target, "meta.__proto__value")).toBe("ok");
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}
