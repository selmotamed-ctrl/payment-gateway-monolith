import { describe, expect, test } from "vitest";
import { emptyTier, tiersFromApi, tiersToApi, validateTiers, withoutBlankTiers } from "@/pages/finance/pricing/commissionTiers";

describe("commission tiers editor model", () => {
  test("round trip: rows -> request -> rows", () => {
    const rows = [
      { upTo: "1000", flat: "0.5", percent: "" },
      { upTo: "5000.0000", flat: "", percent: "0.015" },
      { upTo: "", flat: "2", percent: "0.01" },
    ];
    const wire = tiersToApi(rows);
    expect(wire).toEqual([
      { upTo: "1000", flat: "0.5" },
      { upTo: "5000.0000", percent: "0.015" },
      { flat: "2", percent: "0.01" },
    ]);
    expect(tiersFromApi(wire)).toEqual(rows);
  });

  test("accepts the index-keyed object core persists, numbers and the up_to alias", () => {
    expect(tiersFromApi({ "1": { up_to: 20, percent: 0.02 }, "0": { upTo: "10", flat: "1" } })).toEqual([
      { upTo: "10", flat: "1", percent: "" },
      { upTo: "20", flat: "", percent: "0.02" },
    ]);
    expect(tiersFromApi(null)).toEqual([]);
    expect(tiersFromApi("nope")).toEqual([]);
    expect(tiersFromApi([1, null, "x", [], { flat: "3" }])).toEqual([{ upTo: "", flat: "3", percent: "" }]);
  });

  test("blank rows are dropped, text is trimmed", () => {
    expect(withoutBlankTiers([emptyTier(), { upTo: " 5 ", flat: "1", percent: "" }])).toHaveLength(1);
    expect(tiersToApi([{ upTo: " 5 ", flat: " 1 ", percent: "  " }])).toEqual([{ upTo: "5", flat: "1" }]);
  });

  test("validation", () => {
    expect(validateTiers([])).toEqual([{ index: -1, field: "table", code: "EMPTY" }]);
    expect(validateTiers([{ upTo: "10", flat: "1", percent: "" }, { upTo: "", flat: "", percent: "0.01" }])).toEqual([]);
    expect(validateTiers([{ upTo: "10", flat: "", percent: "" }])).toContainEqual({ index: 0, field: "flat", code: "MISSING_PRICE" });
    expect(validateTiers([{ upTo: "abc", flat: "1", percent: "" }])).toContainEqual({ index: 0, field: "upTo", code: "INVALID_DECIMAL" });
    expect(validateTiers([{ upTo: "10", flat: "1.123456", percent: "" }])).toContainEqual({ index: 0, field: "flat", code: "INVALID_DECIMAL" });
    const unordered = validateTiers([
      { upTo: "10", flat: "1", percent: "" },
      { upTo: "10", flat: "1", percent: "" },
    ]);
    expect(unordered).toContainEqual({ index: 1, field: "upTo", code: "NOT_ASCENDING" });
    const catchAllFirst = validateTiers([
      { upTo: "", flat: "1", percent: "" },
      { upTo: "10", flat: "1", percent: "" },
    ]);
    expect(catchAllFirst).toContainEqual({ index: 0, field: "upTo", code: "CEILING_NOT_LAST" });
    expect(validateTiers(Array.from({ length: 21 }, (_, i) => ({ upTo: String(i + 1), flat: "1", percent: "" })))).toContainEqual({
      index: -1,
      field: "table",
      code: "TOO_MANY",
    });
  });

  test("ceilings compare as decimals, not strings", () => {
    expect(
      validateTiers([
        { upTo: "9", flat: "1", percent: "" },
        { upTo: "10", flat: "1", percent: "" },
      ]),
    ).toEqual([]);
  });
});
