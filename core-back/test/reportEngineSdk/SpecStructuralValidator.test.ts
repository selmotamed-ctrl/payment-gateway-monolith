import { describe, expect, test } from "bun:test";
import { validateSpecStructureAndI18n } from "../../lib/reportEngineSdk/verifier/SpecStructuralValidator";
import { baseReportSpec, createTestHostConfig } from "./helpers";

describe("RE-T01 / RE-T02: structural and bilingual i18n validation", () => {
  test("RE-T01: a spec without the Arabic dictionary is rejected", () => {
    const spec = baseReportSpec();
    delete (spec.i18n.locales as Record<string, unknown>).ar;
    const result = validateSpecStructureAndI18n(spec);
    expect(result.spec).toBeNull();
    expect(result.diagnostics.some((d) => d.code === "MISSING_DEFAULT_LOCALE_AR")).toBe(true);
    expect(result.diagnostics.every((d) => d.layer === 1)).toBe(true);
  });

  test("RE-T02: a declared locale missing a referenced translation key is rejected", () => {
    const spec = baseReportSpec();
    spec.i18n.locales.fr = { "report.title": "Resume" };
    const result = validateSpecStructureAndI18n(spec);
    expect(result.spec).not.toBeNull();
    const missing = result.diagnostics.filter((d) => d.code === "MISSING_I18N_KEY_FOR_LOCALE");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((d) => d.path.includes(".fr"))).toBe(true);
    expect(missing.every((d) => d.aiFixHint && d.aiFixHint.length > 0)).toBe(true);
  });

  test("a complete bilingual spec passes", () => {
    const result = validateSpecStructureAndI18n(baseReportSpec());
    expect(result.spec).not.toBeNull();
    expect(result.diagnostics).toEqual([]);
  });
});

describe("remediation A15: Layer 1 input definitions", () => {
  test("an input regex that does not compile is rejected before execution", () => {
    const spec = baseReportSpec();
    spec.inputs.push({
      key: "search",
      label_i18n_key: "input.merchant",
      type: "string",
      required: false,
      validation: { regex: "([a-z" },
      layout_col_span: 6,
    });
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(result.diagnostics.some((d) => d.code === "INPUT_REGEX_INVALID")).toBe(true);
  });

  test("a default that violates the input validation is rejected", () => {
    const spec = baseReportSpec();
    spec.inputs.push({
      key: "limit",
      label_i18n_key: "input.merchant",
      type: "number",
      required: false,
      validation: { min: 5 },
      default_value: 1,
      layout_col_span: 6,
    });
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(result.diagnostics.some((d) => d.code === "INPUT_DEFAULT_INVALID")).toBe(true);
  });

  test("a range preset on a non-range input is rejected", () => {
    const spec = baseReportSpec();
    spec.inputs.push({
      key: "day",
      label_i18n_key: "input.merchant",
      type: "date",
      required: false,
      default_value: { preset: "LAST_7_DAYS" },
      layout_col_span: 6,
    });
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(result.diagnostics.some((d) => d.code === "INPUT_PRESET_TYPE_MISMATCH")).toBe(true);
  });

  test("enum literals are checked against the database enum", () => {
    const spec = baseReportSpec();
    spec.inputs.push({
      key: "direction",
      label_i18n_key: "input.merchant",
      type: "enum",
      required: false,
      validation: { enum_values: ["DEBIT", "BOGUS"] },
      layout_col_span: 6,
    });
    const ds = spec.datasets[0]!;
    ds.where = {
      kind: "GROUP",
      logic: "AND",
      conditions: [
        ...(ds.where && ds.where.kind === "GROUP" ? ds.where.conditions : []),
        {
          kind: "PREDICATE",
          column: "direction",
          op: "eq",
          binding: { source: "INPUT", input_key: "direction", omit_if_empty: false },
        },
      ],
    };
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(
      result.diagnostics.some(
        (d) => d.code === "INPUT_ENUM_LITERAL_UNKNOWN" && d.message.includes("BOGUS"),
      ),
    ).toBe(true);
  });
});

describe("remediation A18: IMAGE_BANNER caption translation keys", () => {
  test("a caption key missing from the Arabic dictionary is rejected", () => {
    const spec = baseReportSpec();
    spec.required_assets = [
      { asset_key: "logo", file_name: "logo.png", mime_type: "image/png", purpose: "VISUAL_IMAGE" },
    ];
    spec.sections.push({
      section_type: "IMAGE_BANNER",
      section_id: "banner",
      asset_key: "logo",
      caption_i18n_key: "banner.caption",
      align: "CENTER",
      max_height_mm: 45,
    });
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(
      result.diagnostics.some(
        (d) => d.code === "MISSING_I18N_KEY_FOR_LOCALE" && d.path.includes("banner.caption"),
      ),
    ).toBe(true);
  });
});

describe("print layout guardrails", () => {
  test("KPI grids reject more than three columns per row", () => {
    const spec = baseReportSpec();
    const kpi = spec.sections[0]!;
    if (kpi.section_type !== "KPI_GRID") throw new Error("base KPI expected");
    kpi.columns = 4;
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(result.spec).toBeNull();
    expect(result.diagnostics.some((d) => d.code === "SCHEMA_VALIDATION_ERROR" && d.path.includes("columns"))).toBe(true);
  });

  test("KPI cards accept a separate delta format hint", () => {
    const spec = baseReportSpec();
    const kpi = spec.sections[0]!;
    if (kpi.section_type !== "KPI_GRID") throw new Error("base KPI expected");
    kpi.columns = 3;
    kpi.cards[0]!.delta_field = "total";
    kpi.cards[0]!.delta_format_hint = "PERCENT_BPS";
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("a chart without a descriptive subtitle emits MISSING_SECTION_DESCRIPTION", () => {
    const spec = baseReportSpec();
    spec.sections.push({
      section_type: "CHART",
      section_id: "trend",
      title_i18n_key: "kpi.total",
      dataset_id: "totals",
      chart_kind: "BAR",
      height_mm: 60,
      width_percent: 100,
      x_field: "currency",
      y_axis_format: "CURRENCY_MINOR",
      series: [{ field: "total", label_i18n_key: "kpi.total", show_value_labels: false }],
    } as never);
    const result = validateSpecStructureAndI18n(spec, createTestHostConfig());
    expect(result.diagnostics.some((d) => d.code === "MISSING_SECTION_DESCRIPTION")).toBe(true);
  });
});
