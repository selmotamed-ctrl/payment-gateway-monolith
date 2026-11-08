import { describe, expect, test } from "vitest";
import {
  formatCostModel,
  parseCostModel,
  serializeCostModel,
  validateCostModel,
  type CostModelForm,
} from "@/components/builders/model/costModel";
import {
  isScopeEmpty,
  parseMismatchPolicy,
  parseRouteScope,
  serializeMismatchPolicy,
  serializeRouteScope,
  validateMismatchPolicy,
  validateRouteScope,
} from "@/components/builders/model/routeScope";
import {
  blankMaintenanceWindow,
  isoToUtcInput,
  maintenanceWindowState,
  parseMaintenanceWindows,
  serializeMaintenanceWindows,
  utcInputToIso,
  validateMaintenanceWindows,
} from "@/components/builders/model/maintenanceWindows";

describe("route cost model builder", () => {
  test("round-trips an engine cost model byte for byte, including unknown keys", () => {
    const raw = {
      calc_type: "HYBRID",
      flat: "0.5000",
      percent: 1.25,
      min: "0.1000",
      max: "5.0000",
      tiers: [{ up_to: "1000.0000", flat: "0.2000", percent: "1", note: "keep me" }, { percent: "0.5" }],
      accrue_fee_at_confirm: true,
      provider_hint: { nested: ["a", 1] },
    };
    const state = parseCostModel(raw);
    expect(state.form.calcType).toBe("HYBRID");
    expect(state.form.percent).toBe("1.25");
    expect(state.extras).toEqual({ provider_hint: { nested: ["a", 1] } });
    const out = serializeCostModel(state);
    expect(out).toEqual(raw);
    // numbers stay numbers, strings stay strings
    expect(typeof out.percent).toBe("number");
    expect(typeof out.flat).toBe("string");
  });

  test("keeps the legacy wizard spelling instead of adding a second key", () => {
    const raw = { model: "FLAT", flatFee: "2", percentFee: "0", minFee: "0", maxFee: "0", currency: "LYD" };
    const state = parseCostModel(raw);
    state.form.flat = "3.5";
    const out = serializeCostModel(state);
    expect(out.flatFee).toBe("3.5");
    expect(out).not.toHaveProperty("flat");
    expect(out.currency).toBe("LYD");
  });

  test("a new field uses the canonical snake_case engine key", () => {
    const state = parseCostModel({});
    state.form.calcType = "HYBRID";
    state.form.percent = "1.5";
    state.form.flat = "0.25";
    state.form.accrueFeeAtConfirm = true;
    state.form.tiers = [{ upTo: "100", flat: "", percent: "2", meta: { keys: {}, originals: {}, extras: {} } }];
    expect(serializeCostModel(state)).toEqual({
      calc_type: "HYBRID",
      flat: "0.25",
      percent: "1.5",
      accrue_fee_at_confirm: true,
      tiers: [{ up_to: "100", percent: "2" }],
    });
  });

  test("accepts null, arrays and JSON strings as an empty or parsed model", () => {
    expect(serializeCostModel(parseCostModel(null))).toEqual({});
    expect(serializeCostModel(parseCostModel([1, 2]))).toEqual({});
    expect(parseCostModel('{"flat":"1"}').form.flat).toBe("1");
  });

  test("an unknown calc_type value is preserved verbatim", () => {
    const state = parseCostModel({ calc_type: "CUSTOM_X", flat: "1" });
    expect(state.form.calcType).toBe("");
    expect(serializeCostModel(state)).toEqual({ calc_type: "CUSTOM_X", flat: "1" });
  });

  test("formats the pill as percent + flat with bounds", () => {
    expect(formatCostModel({ percent: "1.2500", flat: "0.5", min: "0.1", max: "5" })).toBe("1.25% + 0.500 LYD (min 0.100 LYD, max 5.000 LYD)");
    expect(formatCostModel({ percent: "2" })).toBe("2%");
    expect(formatCostModel({ flat: "1.5" })).toBe("1.500 LYD");
    expect(formatCostModel({ flatFee: "0", percentFee: "0" })).toBe("");
    expect(formatCostModel({})).toBe("");
    expect(formatCostModel({ calc_type: "TIERED", tiers: [{ up_to: "10" }, { up_to: "20" }] }, { labels: { tiered: "Tiered", tiers: "tiers" } })).toBe("Tiered · 2 tiers");
    expect(formatCostModel({ percent: "1", flat: "2" }, { currency: "USD" })).toBe("1% + 2.00 USD");
  });

  test("validates amounts, percent, bounds and tier ordering", () => {
    const base: CostModelForm = { calcType: "FLAT", flat: "1", percent: "1", min: "", max: "", accrueFeeAtConfirm: false, tiers: [] };
    expect(validateCostModel(base)).toEqual([]);
    const codes = (patch: Partial<CostModelForm>) => validateCostModel({ ...base, ...patch }).map((error) => error.code);
    expect(codes({ flat: "-1" })).toContain("FLAT_INVALID");
    expect(codes({ percent: "101" })).toContain("PERCENT_OVER_100");
    expect(codes({ percent: "abc" })).toContain("PERCENT_INVALID");
    expect(codes({ min: "5", max: "1" })).toContain("MIN_GT_MAX");
    expect(codes({ calcType: "TIERED" })).toContain("TIERS_REQUIRED");
    const tier = (upTo: string) => ({ upTo, flat: "1", percent: "", meta: { keys: {}, originals: {}, extras: {} } });
    expect(codes({ calcType: "TIERED", tiers: [tier("100"), tier("50")] })).toContain("TIER_UP_TO_ORDER");
    expect(codes({ calcType: "TIERED", tiers: [tier(""), tier("50")] })).toContain("TIER_UP_TO_REQUIRED");
    expect(codes({ calcType: "TIERED", tiers: [tier("50"), tier("")] })).toEqual([]);
  });
});

describe("route scope builder", () => {
  const merchant = "0190f3a2-1b2c-7d3e-8f40-123456789abc";

  test("round-trips snake_case scope with unknown keys and never writes empty arrays", () => {
    const raw = { merchant_ids: [merchant], channels: ["WEB", "API"], regions: ["tripoli"] };
    const state = parseRouteScope(raw);
    expect(state.form.merchantIds).toEqual([merchant]);
    expect(serializeRouteScope(state)).toEqual(raw);
    state.form.channels = [];
    expect(serializeRouteScope(state)).toEqual({ merchant_ids: [merchant], regions: ["tripoli"] });
  });

  test("keeps the camelCase spelling that was stored", () => {
    const state = parseRouteScope({ riskTiers: ["HIGH"] });
    state.form.riskTiers = ["HIGH", "LOW"];
    expect(serializeRouteScope(state)).toEqual({ riskTiers: ["HIGH", "LOW"] });
  });

  test("validates ids, tiers and channels", () => {
    const form = { merchantIds: ["nope"], applicationIds: [merchant], riskTiers: ["MEDIUM"], channels: ["POS", "SMS"] };
    expect(validateRouteScope(form).map((error) => error.code)).toEqual(["MERCHANT_ID_INVALID", "RISK_TIER_INVALID", "CHANNEL_INVALID"]);
    expect(isScopeEmpty({ merchantIds: [], applicationIds: [], riskTiers: [], channels: [] })).toBe(true);
  });

  test("mismatch policy tolerance keeps its spelling, type and extras", () => {
    const state = parseMismatchPolicy({ toleranceAmount: 0.5, action: "FLAG" });
    expect(state.toleranceAmount).toBe("0.5");
    expect(serializeMismatchPolicy(state)).toEqual({ toleranceAmount: 0.5, action: "FLAG" });
    state.toleranceAmount = "";
    expect(serializeMismatchPolicy(state)).toEqual({ action: "FLAG" });
    state.toleranceAmount = "1.2500";
    expect(serializeMismatchPolicy(state)).toEqual({ toleranceAmount: "1.2500", action: "FLAG" });
    expect(validateMismatchPolicy(state)).toBeNull();
    state.toleranceAmount = "x";
    expect(validateMismatchPolicy(state)).toBe("TOLERANCE_INVALID");
  });
});

describe("maintenance windows builder", () => {
  test("converts between ISO instants and UTC inputs", () => {
    expect(isoToUtcInput("2026-11-06T22:30:00.000Z")).toBe("2026-11-06T22:30");
    expect(utcInputToIso("2026-11-06T22:30")).toBe("2026-11-06T22:30:00.000Z");
    expect(utcInputToIso("06/11/2026")).toBeNull();
    expect(isoToUtcInput("garbage")).toBe("");
  });

  test("untouched windows serialise to their original values (lossless)", () => {
    const raw = [{ start: "2026-11-06T22:30:00Z", end: "2026-11-07T01:00:00.000Z", reason: "provider upgrade" }];
    const rows = parseMaintenanceWindows(raw);
    expect(serializeMaintenanceWindows(rows)).toEqual(raw);
    rows[0]!.end = "2026-11-07T02:00";
    expect(serializeMaintenanceWindows(rows)).toEqual([{ start: "2026-11-06T22:30:00Z", end: "2026-11-07T02:00:00.000Z", reason: "provider upgrade" }]);
  });

  test("rejects missing, reversed and overlapping windows", () => {
    const rows = [blankMaintenanceWindow(), blankMaintenanceWindow(), blankMaintenanceWindow(), blankMaintenanceWindow()];
    rows[0]!.start = "2026-11-06T10:00";
    rows[0]!.end = "2026-11-06T09:00";
    rows[1]!.start = "2026-11-07T10:00";
    rows[1]!.end = "2026-11-07T12:00";
    rows[2]!.start = "2026-11-07T11:00";
    rows[2]!.end = "2026-11-07T13:00";
    const codes = validateMaintenanceWindows(rows).map((error) => `${error.index}:${error.field}:${error.code}`);
    expect(codes).toContain("0:end:END_NOT_AFTER_START");
    expect(codes).toContain("2:start:OVERLAP");
    expect(codes).toContain("3:start:START_REQUIRED");
    expect(codes).toContain("3:end:END_REQUIRED");
    expect(validateMaintenanceWindows([])).toEqual([]);
  });

  test("a window is active for start <= now < end", () => {
    const row = { start: "2026-11-06T10:00", end: "2026-11-06T12:00" };
    expect(maintenanceWindowState(row, new Date("2026-11-06T09:59:59Z"))).toBe("UPCOMING");
    expect(maintenanceWindowState(row, new Date("2026-11-06T10:00:00Z"))).toBe("ACTIVE");
    expect(maintenanceWindowState(row, new Date("2026-11-06T12:00:00Z"))).toBe("PAST");
    expect(maintenanceWindowState({ start: "", end: "" })).toBeNull();
  });
});
