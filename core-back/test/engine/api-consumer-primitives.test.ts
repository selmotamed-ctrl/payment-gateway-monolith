import { describe, expect, test } from "bun:test";
import { recursiveSelect, recursiveSelectWithForLoop } from "../../engine/apiConsumer/recursiveSelect";
import { recursiveSet, recursiveSetImmutable } from "../../engine/apiConsumer/recursiveSet";

describe("recursiveSet prototype pollution guard", () => {
  const forbidden = ["__proto__", "constructor", "prototype"];

  for (const segment of forbidden) {
    test(`rejects the '${segment}' path segment`, () => {
      const target: Record<string, unknown> = {};
      expect(() => recursiveSet(target, `safe.${segment}.value`, 1)).toThrow();
      expect(() => recursiveSet(target, [segment], 1)).toThrow();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  }

  test("rejects an empty path", () => {
    expect(() => recursiveSet({}, "", "x")).toThrow();
    expect(() => recursiveSet({}, [], "x")).toThrow();
  });

  test("does not mutate the caller supplied path array", () => {
    const path = ["transAmount", "amount"];
    const target: Record<string, unknown> = {};
    recursiveSet(target, path, "10.00");
    expect(path).toEqual(["transAmount", "amount"]);
    expect(target).toEqual({ transAmount: { amount: "10.00" } });
  });
});

describe("recursiveSet sibling preservation", () => {
  test("preserves sibling fields when setting a nested dot path twice", () => {
    const body: Record<string, unknown> = {};
    recursiveSet(body, "transAmount.amount", "76.26");
    recursiveSet(body, "transAmount.currency", "LYD");
    expect(body).toEqual({
      transAmount: { amount: "76.26", currency: "LYD" },
    });
  });

  test("preserves unrelated top level siblings", () => {
    const body: Record<string, unknown> = { merchantTransInfo: { merchantTransID: "TX-1" } };
    recursiveSet(body, "transAmount.amount", "76.26");
    expect(body.merchantTransInfo).toEqual({ merchantTransID: "TX-1" });
  });

  test("creates array containers for numeric path segments", () => {
    const body: Record<string, unknown> = {};
    recursiveSet(body, "items.0.sku", "A-1");
    expect(Array.isArray((body as { items: unknown[] }).items)).toBe(true);
    expect((body as { items: Array<{ sku: string }> }).items[0]?.sku).toBe("A-1");
  });

  test("does not replace an existing object container", () => {
    const body: Record<string, unknown> = { transAmount: { amount: "1", currency: "LYD" } };
    recursiveSet(body, "transAmount.amount", "2");
    expect(body).toEqual({ transAmount: { amount: "2", currency: "LYD" } });
  });

  test("immutable variant leaves the original untouched", () => {
    const body: Record<string, unknown> = {};
    const next = recursiveSetImmutable(body, "a.b", 1);
    expect(body).toEqual({});
    expect(next).toEqual({ a: { b: 1 } });
  });
});

describe("recursiveSelect", () => {
  const payload = {
    result: { process_id: "PROC-1" },
    nested: { deep: { value: 42 } },
  };

  test("selects a nested value by dot path", () => {
    expect(recursiveSelect(payload, "result.process_id")).toBe("PROC-1");
    expect(recursiveSelectWithForLoop(payload, "nested.deep.value")).toBe(42);
  });

  test("returns undefined for a missing path", () => {
    expect(recursiveSelect(payload, "result.missing")).toBeUndefined();
  });

  test("rejects prototype pollution segments", () => {
    expect(() => recursiveSelect(payload, "__proto__")).toThrow();
    expect(() => recursiveSelect(payload, "a.constructor.b")).toThrow();
  });

  test("does not read inherited properties", () => {
    expect(recursiveSelect(payload, "toString")).toBeUndefined();
  });
});
