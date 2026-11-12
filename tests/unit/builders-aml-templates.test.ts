import { describe, expect, test } from "vitest";
import {
  AML_PARAM_FIELDS,
  AML_RULE_TYPES,
  buildAmlParams,
  defaultAmlParams,
  joinDuration,
  parseAmlParams,
  splitDuration,
  summarizeAmlParams,
  summarizeAmlScope,
  summarizeReportingConditions,
  validateAmlParams,
  type AmlRuleType,
} from "@/components/builders/model/amlRules";
import {
  groupTemplatesByCode,
  insertPlaceholder,
  previewTemplate,
  unknownTemplateVariables,
  uniqueTemplateVariables,
} from "@/components/builders/model/templateVariables";
import { logoStorageKey, slugifyAssetName, validateLogoFile } from "@/components/builders/model/assets";

describe("aml rule params per category", () => {
  test("every category in the core enum has a param schema", () => {
    expect([...AML_RULE_TYPES]).toEqual(Object.keys(AML_PARAM_FIELDS));
  });

  test("SINGLE_AMOUNT builds the exact engine keys", () => {
    const state = parseAmlParams("SINGLE_AMOUNT", { min_amount: "10000.0000", currency: "lyd", unknown_flag: true });
    state.form.currency = "lyd";
    expect(buildAmlParams("SINGLE_AMOUNT", state)).toEqual({ min_amount: "10000.0000", currency: "LYD", unknown_flag: true });
    state.form.min_amount = "10000.00001";
    expect(validateAmlParams("SINGLE_AMOUNT", state.form).map((error) => error.code)).toEqual(["MONEY_INVALID"]);
    state.form.min_amount = "";
    expect(validateAmlParams("SINGLE_AMOUNT", state.form).map((error) => error.code)).toEqual(["REQUIRED"]);
  });

  test("CUMULATIVE_WINDOW needs a limit and keeps numeric types", () => {
    const raw = { max_amount: "50000.0000", max_count: 5, window_seconds: 86400 };
    const state = parseAmlParams("CUMULATIVE_WINDOW", raw);
    expect(buildAmlParams("CUMULATIVE_WINDOW", state)).toEqual(raw);
    state.form.max_amount = "";
    state.form.max_count = "";
    expect(validateAmlParams("CUMULATIVE_WINDOW", state.form).map((error) => error.code)).toEqual(["AT_LEAST_ONE_LIMIT"]);
    state.form.max_count = "7";
    expect(buildAmlParams("CUMULATIVE_WINDOW", state)).toEqual({ max_count: 7, window_seconds: 86400 });
  });

  test("STRUCTURING defaults match the engine defaults", () => {
    const state = defaultAmlParams("STRUCTURING");
    state.form.threshold = "10000";
    expect(buildAmlParams("STRUCTURING", state)).toEqual({ threshold: "10000", band_percent: 10, min_count: 2, window_seconds: 86400 });
    state.form.band_percent = "100";
    state.form.min_count = "1";
    expect(validateAmlParams("STRUCTURING", state.form).map((error) => error.code)).toEqual(["RANGE", "RANGE"]);
  });

  test("RISK_TIER, COUNTERPARTY_COUNTRY, RAIL and MERCHANT_DIRECT_AMOUNT", () => {
    const tier = parseAmlParams("RISK_TIER", { tier: "HIGH", min_amount: "5000.0000" });
    expect(buildAmlParams("RISK_TIER", tier)).toEqual({ tier: "HIGH", min_amount: "5000.0000" });
    tier.form.tier = "MEDIUM";
    expect(validateAmlParams("RISK_TIER", tier.form).map((error) => error.code)).toEqual(["OPTION_INVALID"]);

    const country = parseAmlParams("COUNTERPARTY_COUNTRY", { mode: "DENY", countries: ["kp", "ir"] });
    expect(buildAmlParams("COUNTERPARTY_COUNTRY", country)).toEqual({ mode: "DENY", countries: ["KP", "IR"] });
    country.form.countries = ["KPX"];
    expect(validateAmlParams("COUNTERPARTY_COUNTRY", country.form)).toEqual([{ field: "countries", code: "ENTRY_INVALID", value: "KPX" }]);
    country.form.countries = [];
    expect(validateAmlParams("COUNTERPARTY_COUNTRY", country.form).map((error) => error.code)).toEqual(["REQUIRED"]);

    const rail = parseAmlParams("RAIL", { rail_codes: ["moamalat"], min_amount: "20000.0000" });
    expect(buildAmlParams("RAIL", rail)).toEqual({ rail_codes: ["moamalat"], min_amount: "20000.0000" });

    const direct = defaultAmlParams("MERCHANT_DIRECT_AMOUNT");
    expect(validateAmlParams("MERCHANT_DIRECT_AMOUNT", direct.form).map((error) => error.code)).toEqual(["REQUIRED"]);
  });

  test("defaults validate once the required fields are filled, for every category", () => {
    const filled: Record<AmlRuleType, Record<string, string | string[]>> = {
      SINGLE_AMOUNT: { min_amount: "1" },
      CUMULATIVE_WINDOW: { max_amount: "1" },
      STRUCTURING: { threshold: "1" },
      RISK_TIER: {},
      COUNTERPARTY_COUNTRY: { countries: ["LY"] },
      RAIL: { rail_codes: ["moamalat"] },
      MERCHANT_DIRECT_AMOUNT: { min_amount: "1" },
    };
    for (const type of AML_RULE_TYPES) {
      const state = defaultAmlParams(type);
      Object.assign(state.form, filled[type]);
      expect(validateAmlParams(type, state.form), type).toEqual([]);
    }
  });

  test("summaries are labelled rows with formatted values", () => {
    const rows = summarizeAmlParams("SINGLE_AMOUNT", { min_amount: "10000.0000", currency: "LYD" });
    expect(rows[0]).toEqual({ key: "min_amount", label: "Minimum amount", text: "10000.0000 LYD" });
    const window = summarizeAmlParams("STRUCTURING", { threshold: "10000", band_percent: 10, min_count: 2, window_seconds: 3600, mystery: { a: 1 } });
    expect(window.find((row) => row.key === "band_percent")?.text).toBe("10%");
    expect(window.find((row) => row.key === "window_seconds")?.seconds).toBe(3600);
    expect(window.find((row) => row.label === "Mystery · A")?.text).toBe("1");
    expect(summarizeAmlScope({})).toEqual([]);
    expect(summarizeAmlScope({ merchant_ids: ["a", "b"] })).toEqual([{ key: "merchant_ids", label: "Merchant ids", list: ["a", "b"] }]);
  });

  test("durations split into the largest exact unit", () => {
    expect(splitDuration(86400)).toEqual({ value: 1, unit: "days" });
    expect(splitDuration(7200)).toEqual({ value: 2, unit: "hours" });
    expect(splitDuration(90)).toEqual({ value: 90, unit: "seconds" });
    expect(joinDuration(2, "hours")).toBe(7200);
  });

  test("reporting rule conditions are shown by the keys the evaluator reads", () => {
    expect(summarizeReportingConditions({ currencies: ["LYD"], minAmount: "10000", note: { a: "b" } })).toEqual([
      { key: "currencies", label: "Currencies", list: ["LYD"] },
      { key: "minAmount", label: "Minimum amount", text: "10000" },
      { key: "note.a", label: "Note · A", text: "b" },
    ]);
  });
});

describe("notification template variables", () => {
  test("extracts the same placeholders as the server", () => {
    expect(uniqueTemplateVariables("Paid {{ amount }} {{currency}}", "{{amount}} {{ref.id}}")).toEqual(["amount", "currency", "ref.id"]);
    expect(uniqueTemplateVariables("no placeholders { amount }")).toEqual([]);
  });

  test("flags unknown placeholders and inserts chips at the caret", () => {
    expect(unknownTemplateVariables(["Hi {{name}} {{amount}}", null], ["amount"])).toEqual(["name"]);
    expect(insertPlaceholder("Total: ", "amount", 7, 7)).toEqual({ value: "Total: {{amount}}", caret: 17 });
    expect(insertPlaceholder("ab", "x", 1, 2)).toEqual({ value: "a{{x}}", caret: 6 });
  });

  test("previews with samples and leaves unknown variables visible", () => {
    expect(previewTemplate("{{amount}} {{currency}} {{x}}", { amount: "10.000", currency: "LYD" })).toBe("10.000 LYD {{x}}");
  });

  test("groups the latest versions by code", () => {
    const groups = groupTemplatesByCode([
      { code: "B", channel: "SMS", lang: "EN" },
      { code: "A", channel: "EMAIL", lang: "EN" },
      { code: "A", channel: "EMAIL", lang: "AR" },
    ]);
    expect(groups.map((group) => group.code)).toEqual(["A", "B"]);
    expect(groups[0]!.rows.map((row) => row.lang)).toEqual(["AR", "EN"]);
  });
});

describe("rail logo assets", () => {
  test("only png/svg up to 5 MB are accepted", () => {
    expect(validateLogoFile({ name: "a.png", type: "image/png", size: 100 })).toBeNull();
    expect(validateLogoFile({ name: "a.svg", type: "image/svg+xml; charset=utf-8", size: 100 })).toBeNull();
    expect(validateLogoFile({ name: "a.jpg", type: "image/jpeg", size: 100 })).toBe("TYPE");
    expect(validateLogoFile({ name: "a.png", type: "image/png", size: 0 })).toBe("EMPTY");
    expect(validateLogoFile({ name: "a.png", type: "image/png", size: 5_000_001 })).toBe("TOO_LARGE");
  });

  test("storage keys are slugged", () => {
    expect(slugifyAssetName("Moamalat Logo (v2).PNG")).toBe("moamalat-logo-v2.png");
    expect(logoStorageKey("a".repeat(64), "x y.svg")).toBe(`rails/logos/${"a".repeat(64)}/x-y.svg`);
  });
});
