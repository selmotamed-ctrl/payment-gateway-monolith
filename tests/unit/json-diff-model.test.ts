import { describe, expect, test } from "vitest";
import {
  classifyValue,
  coerceValue,
  compareValues,
  deepEqual,
  entryView,
  flattenLeaves,
  humanizeKey,
  humanizePath,
  isMoneyKey,
  isStatusValue,
  normalizeDiff,
  parsePath,
} from "@/components/ui/jsonDiffModel";

describe("label humanisation", () => {
  test("camelCase, snake_case and acronyms", () => {
    expect(humanizeKey("commissionReceivableCeiling")).toBe("Commission Receivable Ceiling");
    expect(humanizeKey("rail_code")).toBe("Rail Code");
    expect(humanizeKey("iban")).toBe("IBAN");
    expect(humanizeKey("merchantId")).toBe("Merchant ID");
    expect(humanizeKey("kybStatus")).toBe("KYB Status");
    expect(humanizeKey("redirectUrl")).toBe("Redirect URL");
  });

  test("a trailing Json word is dropped but a lone key is kept", () => {
    expect(humanizeKey("payoutBankDetailsJson")).toBe("Payout Bank Details");
    expect(humanizeKey("json")).toBe("Json");
  });

  test("slash paths: /payoutBankDetailsJson/iban", () => {
    expect(humanizePath("/payoutBankDetailsJson/iban")).toBe("Payout Bank Details · IBAN");
    expect(humanizePath("/commissionReceivableCeiling")).toBe("Commission Receivable Ceiling");
  });

  test("array indexes, append marker, escapes and dotted paths", () => {
    expect(humanizePath("/tiers/0/flat")).toBe("Tiers · #1 · Flat");
    expect(humanizePath("/railWhitelist/-")).toBe("Rail Whitelist · New item");
    expect(parsePath("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(parsePath("payout.iban")).toEqual(["payout", "iban"]);
    expect(parsePath("tiers[2].flat")).toEqual(["tiers", "2", "flat"]);
    expect(parsePath("")).toEqual([]);
    expect(humanizePath("")).toBe("");
  });
});

describe("diff normalisation", () => {
  test("RFC-6902 arrays", () => {
    const model = normalizeDiff([
      { op: "replace", path: "/riskTier", value: "HIGH", oldValue: "LOW" },
      { op: "add", path: "/payoutBankDetailsJson", value: { iban: "LY83002048000020100120361", bankName: "Test Bank" } },
      { op: "remove", path: "/note", value: "old" },
    ]);
    expect(model.mode).toBe("patch");
    const byLabel = Object.fromEntries(model.entries.map((entry) => [entry.label, entry]));
    expect(byLabel["Risk Tier"]).toMatchObject({ op: "replace", before: "LOW", after: "HIGH", hasBefore: true, hasAfter: true });
    expect(byLabel["Payout Bank Details · IBAN"]).toMatchObject({ op: "add", hasBefore: false, after: "LY83002048000020100120361" });
    expect(byLabel["Payout Bank Details · Bank Name"]?.op).toBe("add");
    expect(byLabel["Note"]).toMatchObject({ op: "remove", before: "old", hasAfter: false });
  });

  test("operations wrapper, move/copy and JSON strings", () => {
    const wrapped = normalizeDiff({ operations: [{ op: "move", from: "/oldKey", path: "/newKey" }] });
    expect(wrapped.mode).toBe("patch");
    expect(wrapped.entries[0]).toMatchObject({ op: "move", label: "New Key", fromLabel: "Old Key" });
    const text = normalizeDiff(JSON.stringify([{ op: "replace", path: "/a", value: 2, oldValue: 1 }]));
    expect(text.entries[0]).toMatchObject({ before: 1, after: 2 });
  });

  test("serialised object values are expanded into sub-rows", () => {
    const model = normalizeDiff([{ op: "replace", path: "/payout", value: '{"iban":"B","bank":"X"}', oldValue: '{"iban":"A","bank":"X"}' }]);
    expect(model.entries.map((entry) => entry.label)).toEqual(["Payout · IBAN"]);
  });

  test("{ before, after } keeps only changed leaves and ignores null vs absent", () => {
    const model = normalizeDiff({
      before: { status: "PENDING", name: "A", note: null, nested: { x: 1, y: 2 } },
      after: { status: "ACTIVE", name: "A", extra: null, nested: { x: 1, y: 3 }, added: "yes" },
    });
    expect(model.mode).toBe("compare");
    expect(model.entries.map((entry) => `${entry.op}:${entry.path}`)).toEqual([
      "add:/added",
      "replace:/nested/y",
      "replace:/status",
    ]);
  });

  test("{ before: null } (create) lists every non-empty after leaf as added", () => {
    const model = normalizeDiff({ before: null, after: { code: "X1", empty: "", tiers: [] } });
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0]).toMatchObject({ op: "add", path: "/code", hasBefore: false });
    expect(normalizeDiff({ before: {}, after: {} }).entries).toEqual([]);
  });

  test("plain payloads show every leaf once", () => {
    const model = normalizeDiff({ action: "FREEZE", reason: "fraud", limits: { daily: "10.5", currency: "LYD" } });
    expect(model.mode).toBe("payload");
    expect(model.entries.map((entry) => entry.path)).toEqual(["/action", "/reason", "/limits/daily", "/limits/currency"]);
    expect(model.entries.every((entry) => entry.op === "value" && !entry.hasBefore)).toBe(true);
  });

  test("empty inputs", () => {
    for (const value of [null, undefined, "", [], {}, { operations: [] }]) {
      expect(normalizeDiff(value)).toEqual({ mode: "empty", entries: [] });
    }
  });
});

describe("nested flattening", () => {
  test("objects become sub-rows, arrays of objects use indexes, scalar arrays stay chips", () => {
    const leaves = flattenLeaves({ a: { b: 1 }, tiers: [{ flat: "1" }, { flat: "2" }], tags: ["x", "y"], empty: {} });
    expect(leaves.map((leaf) => leaf.segments.join("/"))).toEqual(["a/b", "tiers/0/flat", "tiers/1/flat", "tags", "empty"]);
    expect(leaves.find((leaf) => leaf.segments[0] === "tags")?.value).toEqual(["x", "y"]);
  });

  test("the nearest currency string is inherited by money leaves", () => {
    const leaves = flattenLeaves({ currency: "USD", limit: { maxAmount: "5.00" } });
    expect(leaves.find((leaf) => leaf.segments.join("/") === "limit/maxAmount")?.currency).toBe("USD");
  });

  test("compareValues sorts naturally (#2 before #10)", () => {
    const rows = compareValues({}, { items: Array.from({ length: 11 }, (_, i) => ({ v: String(i) })) });
    expect(rows[1]?.path).toBe("/items/1/v");
    expect(rows[2]?.path).toBe("/items/2/v");
  });

  test("deepEqual / coerceValue", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(coerceValue('{"a":1}')).toEqual({ a: 1 });
    expect(coerceValue("[not json")).toBe("[not json");
    expect(coerceValue("plain")).toBe("plain");
    expect(coerceValue("42")).toBe("42");
  });
});

describe("money and status detection", () => {
  test("money keys", () => {
    for (const key of ["requestedAmount", "commissionReceivableCeiling", "flatFee", "minFee", "walletBalance", "monthlyVolume", "amount", "flat", "upTo"]) {
      expect(isMoneyKey(key)).toBe(true);
    }
    for (const key of ["feeBearerDefault", "currency", "status", "amountCurrency"]) expect(isMoneyKey(key)).toBe(false);
  });

  test("money values need a decimal string or number", () => {
    expect(classifyValue("maxAmount", "1250.5000", true, "LYD")).toEqual({ kind: "money", amount: "1250.5000", currency: "LYD" });
    expect(classifyValue("maxAmount", 12, true)).toEqual({ kind: "money", amount: "12", currency: undefined });
    expect(classifyValue("maxAmount", "n/a")).toEqual({ kind: "text", text: "n/a" });
  });

  test("status-looking strings", () => {
    expect(isStatusValue("status", "ACTIVE")).toBe(true);
    expect(isStatusValue("riskTier", "HIGH")).toBe(true);
    expect(isStatusValue("whatever", "PENDING_REVIEW")).toBe(true);
    expect(isStatusValue("whatever", "ACTIVE")).toBe(true);
    expect(isStatusValue("currency", "LYD")).toBe(false);
    expect(isStatusValue("merchantId", "ABC_DEF")).toBe(false);
    expect(isStatusValue("name", "Alice")).toBe(false);
    expect(classifyValue("status", "SUSPENDED")).toEqual({ kind: "status", status: "SUSPENDED" });
  });

  test("other leaf kinds", () => {
    expect(classifyValue("x", undefined, false)).toEqual({ kind: "absent" });
    expect(classifyValue("x", null)).toEqual({ kind: "empty" });
    expect(classifyValue("x", "")).toEqual({ kind: "empty" });
    expect(classifyValue("x", [])).toEqual({ kind: "empty" });
    expect(classifyValue("rails", ["A", "B"])).toEqual({ kind: "list", items: ["A", "B"] });
    expect(classifyValue("active", true)).toEqual({ kind: "boolean", value: true });
    expect(classifyValue("createdOn", "2026-01-05T10:00:00.000Z")).toEqual({ kind: "datetime", iso: "2026-01-05T10:00:00.000Z" });
    expect(classifyValue("count", 3)).toEqual({ kind: "number", text: "3" });
  });

  test("entryView resolves the key behind array indexes", () => {
    const entry = normalizeDiff({ before: { tiers: [{ flat: "1.0" }] }, after: { tiers: [{ flat: "2.5" }] } }).entries[0]!;
    expect(entryView(entry, "after")).toMatchObject({ kind: "money", amount: "2.5" });
    expect(entryView(entry, "before")).toMatchObject({ kind: "money", amount: "1.0" });
    const added = normalizeDiff({ before: null, after: { code: "X" } }).entries[0]!;
    expect(entryView(added, "before")).toEqual({ kind: "absent" });
  });
});
