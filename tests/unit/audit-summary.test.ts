import { describe, expect, test } from "vitest";
import { auditChangeChips, describeAuditChange, formatAuditValue, summarizeAuditChange } from "@/utils/auditSummary";

describe("summarizeAuditChange", () => {
  test("lists humanised top-level keys that differ", () => {
    expect(summarizeAuditChange({ status: "PENDING", riskTier: "LOW", name: "A" }, { status: "ACTIVE", riskTier: "HIGH", name: "A" })).toEqual([
      "Status",
      "Risk Tier",
    ]);
  });

  test("priority keys first, the rest alphabetical, independent of key order", () => {
    const before = { zeta: 1, alpha: 1, status: "A", payoutBankDetailsJson: { iban: "x" } };
    const after = { alpha: 2, status: "B", zeta: 2, payoutBankDetailsJson: { iban: "y" } };
    expect(summarizeAuditChange(before, after)).toEqual(["Status", "Alpha", "Payout Bank Details", "Zeta"]);
    expect(summarizeAuditChange(after, before)).toEqual(["Status", "Alpha", "Payout Bank Details", "Zeta"]);
  });

  test("ignores identical values, bookkeeping timestamps and null-vs-absent", () => {
    expect(
      summarizeAuditChange(
        { status: "A", updatedAt: "2026-01-01T00:00:00Z", note: null, tags: [] },
        { status: "A", updatedAt: "2026-02-02T00:00:00Z", extra: "", tags: [] },
      ),
    ).toEqual([]);
    expect(summarizeAuditChange({ updated_at: 1, created_at: 1 }, { updated_at: 2, created_at: 2 })).toEqual([]);
  });

  test("creation and deletion list every populated key", () => {
    expect(summarizeAuditChange(null, { status: "ACTIVE", code: "X", empty: null })).toEqual(["Status", "Code"]);
    expect(summarizeAuditChange({ status: "ACTIVE" }, undefined)).toEqual(["Status"]);
    expect(summarizeAuditChange(undefined, undefined)).toEqual([]);
    expect(summarizeAuditChange({}, {})).toEqual([]);
  });

  test("deep changes count once under the top-level key; labels are de-duplicated", () => {
    expect(summarizeAuditChange({ payout: { iban: "a", bank: "x" } }, { payout: { iban: "b", bank: "y" } })).toEqual(["Payout"]);
    expect(summarizeAuditChange({ payoutBankDetails: 1, payoutBankDetailsJson: 1 }, { payoutBankDetails: 2, payoutBankDetailsJson: 2 })).toEqual([
      "Payout Bank Details",
    ]);
  });

  test("accepts JSON strings and non-object snapshots", () => {
    expect(summarizeAuditChange('{"status":"A"}', '{"status":"B"}')).toEqual(["Status"]);
    expect(summarizeAuditChange("a", "b")).toEqual(["Value"]);
    expect(summarizeAuditChange("same", "same")).toEqual([]);
  });
});

describe("auditChangeChips", () => {
  test("max 3 chips and a +N counter", () => {
    expect(auditChangeChips(["A", "B", "C", "D", "E"])).toEqual({ visible: ["A", "B", "C"], more: 2 });
    expect(auditChangeChips(["A", "B"])).toEqual({ visible: ["A", "B"], more: 0 });
    expect(auditChangeChips([])).toEqual({ visible: [], more: 0 });
    expect(auditChangeChips(["A", "B", "C"], 1)).toEqual({ visible: ["A"], more: 2 });
  });
});

describe("formatAuditValue / describeAuditChange (replace the per-page JSON.stringify summaries)", () => {
  test("scalars, empties and lists never become JSON", () => {
    expect(formatAuditValue(null)).toBe("—");
    expect(formatAuditValue("")).toBe("—");
    expect(formatAuditValue(undefined)).toBe("—");
    expect(formatAuditValue(42)).toBe("42");
    expect(formatAuditValue(false)).toBe("false");
    expect(formatAuditValue([])).toBe("—");
    expect(formatAuditValue(["a", "b", 3])).toBe("a, b, 3");
    expect(formatAuditValue([{ a: 1 }, { b: 2 }])).toBe("2 items");
  });

  test("objects become `Label: value` pairs with nested keys joined by a middle dot", () => {
    const text = formatAuditValue({ payoutBankDetailsJson: { iban: "LY83002", bankName: "Sahara" }, status: "ACTIVE", updatedAt: "2026-11-05" }, 500);
    expect(text).toContain("Payout Bank Details · IBAN: LY83002");
    expect(text).toContain("Payout Bank Details · Bank Name: Sahara");
    expect(text).toContain("Status: ACTIVE");
    expect(text).not.toContain("{");
    expect(text).not.toContain("updated");
    expect(text).not.toContain("2026-11-05");
  });

  test("a JSON string snapshot is parsed first, long values are truncated with an ellipsis", () => {
    expect(formatAuditValue('{"status":"SUSPENDED"}')).toBe("Status: SUSPENDED");
    const long = formatAuditValue("x".repeat(200), 20);
    expect(long.length).toBe(20);
    expect(long.endsWith("…")).toBe(true);
  });

  test("describeAuditChange lists only the changed keys, priority first, with before → after", () => {
    const before = { name: "Acme", status: "PENDING", riskTier: "LOW", updatedAt: "a" };
    const after = { name: "Acme", status: "ACTIVE", riskTier: "HIGH", updatedAt: "b" };
    expect(describeAuditChange(before, after)).toBe("Status: PENDING → ACTIVE · Risk Tier: LOW → HIGH");
    expect(describeAuditChange(before, before)).toBe("");
    expect(describeAuditChange(null, null)).toBe("");
  });

  test("describeAuditChange folds the rest into +N more", () => {
    const before = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 };
    const after = { a: 2, b: 2, c: 2, d: 2, e: 2, f: 2 };
    const text = describeAuditChange(before, after, 2);
    expect(text.endsWith("+4 more")).toBe(true);
    expect(text.split(" · ").length).toBe(3);
  });

  test("absent versus empty is not a change, an added key is", () => {
    expect(describeAuditChange({}, { note: "" })).toBe("");
    expect(describeAuditChange({}, { note: "hello" })).toBe("Note: — → hello");
  });
});
