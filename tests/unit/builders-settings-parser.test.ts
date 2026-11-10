import { describe, expect, test } from "vitest";
import {
  buildSettingValue,
  parseSettingForm,
  resolveSettingNamespace,
  summarizeSetting,
  validateSettingForm,
} from "@/components/builders/model/settingsSchemas";
import {
  parseParserConfig,
  positionalColumnOrder,
  serializeParserConfig,
  summarizeColumnMapping,
  validateParserConfig,
} from "@/components/builders/model/parserConfig";
import { humanizeKey, parseListEntry, summarizeValue, validateNewKey, withoutKey } from "@/components/builders/model/jsonTree";

describe("generic json helpers", () => {
  test("humanizes snake, camel and dotted keys", () => {
    expect(humanizeKey("min_amount")).toBe("Min amount");
    expect(humanizeKey("ownerThresholdPercent")).toBe("Owner threshold percent");
    expect(humanizeKey("rail-codes")).toBe("Rail codes");
  });

  test("flattens nested values into labelled rows, never raw json", () => {
    const rows = summarizeValue({ a: { b_c: 1, d: [1, 2] }, e: true, f: "", g: [] });
    expect(rows.map((row) => [row.label, row.kind])).toEqual([
      ["A · B c", "text"],
      ["A · D", "list"],
      ["E", "boolean"],
      ["F", "empty"],
      ["G", "empty"],
    ]);
  });

  test("list entries follow the type of the list; new keys are validated", () => {
    expect(parseListEntry("12", [1, 2])).toBe(12);
    expect(parseListEntry("x", [1, 2])).toBeUndefined();
    expect(parseListEntry(" ab ", ["a"])).toBe("ab");
    expect(validateNewKey({ a: 1 }, "a")).toBe("DUPLICATE");
    expect(validateNewKey({}, "bad key")).toBe("INVALID");
    expect(validateNewKey({}, "")).toBe("EMPTY");
    expect(withoutKey({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });
});

describe("typed platform setting editors", () => {
  test("resolves the seeded decision-register keys and the go-live family", () => {
    for (const key of ["OD-1", "OD-2", "OD-3", "OD-4", "OD-5", "OD-6", "OD-7", "OD-8", "OD-9", "OD-10", "OD-11", "onboarding.required_documents", "join_request.volume_threshold", "kyb.refresh_policy", "screening.watchlist", "screening.fail_closed", "SELF_PAYMENT_POLICY", "merchant_reports.policy"]) {
      expect(resolveSettingNamespace(key), key).not.toBeNull();
    }
    expect(resolveSettingNamespace("gateway.go_live.neompay.sla")?.fields).toEqual([]);
    expect(resolveSettingNamespace("something.else")).toBeNull();
  });

  test("OD-7 round trip keeps numbers numeric and unknown keys", () => {
    const raw = { otpPullSeconds: 1200, redirectSeconds: 1800, qrDisplaySeconds: 900, pushApprovalSeconds: 900, description: "ttl", futureKey: { x: [1] } };
    const def = resolveSettingNamespace("OD-7");
    const form = parseSettingForm(def, raw);
    expect(form.values.otpPullSeconds).toBe("1200");
    expect(buildSettingValue(def, form)).toEqual(raw);
    form.values.redirectSeconds = "2400";
    expect(buildSettingValue(def, form)).toEqual({ ...raw, redirectSeconds: 2400 });
  });

  test("four-eyes policy keeps the snake_case alias that was stored", () => {
    const def = resolveSettingNamespace("join_request.four_eyes_policy");
    const form = parseSettingForm(def, { policy: "RISK_BASED", owner_threshold_percent: "25", high_risk_categories: ["arms"] });
    expect(form.keys.ownerThresholdPercent).toBe("owner_threshold_percent");
    form.values.ownerThresholdPercent = "30";
    form.values.highRiskCategories = ["arms", "crypto", "ARMS"];
    expect(buildSettingValue(def, form)).toEqual({ policy: "RISK_BASED", owner_threshold_percent: 30, high_risk_categories: ["ARMS", "CRYPTO"] });
  });

  test("required documents: per-category lists round trip and normalise", () => {
    const def = resolveSettingNamespace("onboarding.required_documents");
    const raw = { default: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE"], byCategory: { CRYPTO: ["SECTOR_LICENSE"] }, description: "x" };
    const form = parseSettingForm(def, raw);
    expect(buildSettingValue(def, form)).toEqual(raw);
    (form.values.byCategory as Record<string, string[]>).ARMS = ["sector_license"];
    expect((buildSettingValue(def, form).byCategory as Record<string, string[]>).ARMS).toEqual(["SECTOR_LICENSE"]);
  });

  test("boolean and select namespaces", () => {
    const watch = resolveSettingNamespace("screening.fail_closed");
    const form = parseSettingForm(watch, { fail_closed: false });
    expect(buildSettingValue(watch, form)).toEqual({ fail_closed: false });
    form.values.failClosed = true;
    expect(buildSettingValue(watch, form)).toEqual({ fail_closed: true });
    const policy = resolveSettingNamespace("SELF_PAYMENT_POLICY");
    const policyForm = parseSettingForm(policy, { policy: "BLOCK" });
    policyForm.values.policy = "MAYBE";
    expect(validateSettingForm(policy, policyForm).map((error) => error.code)).toEqual(["OPTION"]);
  });

  test("merchant reporting policy round trips booleans and an alias", () => {
    const def = resolveSettingNamespace("merchant_reports.policy");
    const raw = { enabled: true, assets_enabled: false, description: "policy" };
    const form = parseSettingForm(def, raw);
    expect(form.values.enabled).toBe(true);
    expect(form.keys.assetsEnabled).toBe("assets_enabled");
    expect(buildSettingValue(def, form)).toEqual(raw);
    form.values.assetsEnabled = true;
    expect(buildSettingValue(def, form)).toEqual({ enabled: true, assets_enabled: true, description: "policy" });
  });

  test("validates numbers, money and required fields", () => {
    const od8 = resolveSettingNamespace("OD-8");
    const form = parseSettingForm(od8, { negativeBalanceCeiling: "0.0000", currency: "LYD" });
    expect(validateSettingForm(od8, form)).toEqual([]);
    form.values.negativeBalanceCeiling = "";
    form.values.currency = "lyd";
    expect(validateSettingForm(od8, form).map((error) => `${error.field}:${error.code}`)).toEqual(["negativeBalanceCeiling:REQUIRED", "currency:CURRENCY"]);
    const od9 = resolveSettingNamespace("OD-9");
    const f9 = parseSettingForm(od9, { ratificationWindowHours: 24 });
    f9.values.ratificationWindowHours = "0";
    expect(validateSettingForm(od9, f9).map((error) => error.code)).toEqual(["RANGE"]);
  });

  test("structured read view never emits raw json", () => {
    const rows = summarizeSetting("OD-9", { ratificationWindowHours: 24, authorizedRoles: ["MLRO"], description: "d", extra: { deep: { x: 1 } } });
    expect(rows.map((row) => [row.label, row.kind])).toEqual([
      ["Ratification window (hours)", "text"],
      ["Authorised roles", "list"],
      ["Description", "text"],
      ["Extra · Deep · X", "text"],
    ]);
    for (const row of rows) expect(String(row.value)).not.toContain("{");
  });

  test("an unknown key falls back to a fully generic form that keeps everything", () => {
    const form = parseSettingForm(null, { a: 1, b: { c: [1] } });
    expect(buildSettingValue(null, form)).toEqual({ a: 1, b: { c: [1] } });
  });
});

describe("statement parser form", () => {
  const raw = {
    format: "csv",
    encoding: "utf8",
    delimiter: ";",
    header_row: false,
    columns_map: { our_reference: "ref", provider_reference: "pref", amount: "amt", fee: "fee_amt", occurred_at: "date", extra_col: "x" },
    date_format: "DD/MM/YYYY",
    timezone: "Africa/Tripoli",
    supports_batch_net: true,
    active: true,
    columns: ["a", "b"],
    custom: { keep: 1 },
  };

  test("reads every spelling the ingestor accepts and writes them back as found", () => {
    const state = parseParserConfig(raw);
    expect(state.form.format).toBe("CSV");
    expect(state.form.headerRow).toBe(false);
    expect(state.form.columns.ourReference).toBe("ref");
    expect(state.form.columns.occurredAt).toBe("date");
    const out = serializeParserConfig(state);
    expect(out).toEqual({ ...raw, format: "CSV" });
  });

  test("an edit only changes the touched key", () => {
    const state = parseParserConfig(raw);
    state.form.columns.amount = "total";
    state.form.delimiter = ",";
    const out = serializeParserConfig(state);
    expect((out.columns_map as Record<string, string>).amount).toBe("total");
    expect(out.delimiter).toBe(",");
    expect(out.custom).toEqual({ keep: 1 });
    expect(out.columns).toEqual(["a", "b"]);
  });

  test("a brand new config uses the camelCase keys the ingestor reads first", () => {
    const state = parseParserConfig({});
    state.form.columns.providerReference = "Reference";
    state.form.columns.amount = "Amount";
    expect(serializeParserConfig(state)).toEqual({
      format: "CSV",
      encoding: "utf8",
      delimiter: ",",
      headerRow: true,
      columnsMap: { providerReference: "Reference", amount: "Amount" },
    });
  });

  test("validates format, delimiter, duplicates and warns about unmapped essentials", () => {
    const state = parseParserConfig({ format: "csv", delimiter: "ab", columnsMap: { amount: "x", fee: "x" } });
    const errors = validateParserConfig(state.form);
    const hard = errors.filter((error) => error.severity === "error").map((error) => error.code);
    expect(hard).toEqual(["DELIMITER_LENGTH", "COLUMN_DUPLICATE"]);
    expect(validateParserConfig(parseParserConfig({ format: "xml" }).form).map((error) => error.code)).toContain("FORMAT_INVALID");
    expect(errors.filter((error) => error.severity === "warning").map((error) => error.code)).toEqual(["REFERENCE_REQUIRED"]);
    expect(validateParserConfig(parseParserConfig({ timezone: "Mars/Base" }).form).some((error) => error.code === "TIMEZONE_INVALID")).toBe(true);
  });

  test("headerless csv reads cells by canonical position", () => {
    const state = parseParserConfig({ headerRow: false, columnsMap: { fee: "f", ourReference: "r", amount: "a" } });
    expect(positionalColumnOrder(state.form)).toEqual(["ourReference", "amount", "fee"]);
  });

  test("mapping badge uses columnsMap, which the list row does not expose", () => {
    expect(summarizeColumnMapping({ columns_map: { providerReference: "p", amount: "a" } })).toEqual({ mapped: ["providerReference", "amount"], missing: [], ok: true });
    expect(summarizeColumnMapping({ supports_batch_net: true })).toEqual({ mapped: [], missing: ["amount", "ourReference"], ok: false });
  });
});
