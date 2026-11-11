import { describe, expect, test } from "bun:test";
import { ReportDescriptorSpecSchema, type ReportDescriptorSpec } from "../../lib/reportEngineSdk/types/reportSpec";
import { buildMockReportBundle } from "../../lib/reportEngineSdk/preview/MockReportBundleBuilder";
import { validateSpecStructureAndI18n } from "../../lib/reportEngineSdk/verifier/SpecStructuralValidator";
import { validateQueriesAndOptimizations } from "../../lib/reportEngineSdk/verifier/QuerySafetyAndOptValidator";
import { baseReportSpec, createTestHostConfig } from "./helpers";

function complexSpec(): ReportDescriptorSpec {
  const base = baseReportSpec();
  return ReportDescriptorSpecSchema.parse({
    ...base,
    required_assets: [
      {
        asset_key: "logo",
        file_name: "logo.svg",
        mime_type: "image/svg+xml",
        purpose: "VISUAL_IMAGE",
      },
      {
        asset_key: "targets",
        file_name: "targets.csv",
        mime_type: "text/csv",
        purpose: "COMPARISON_BASELINE_DATA",
      },
    ],
    datasets: [
      ...base.datasets,
      {
        dataset_id: "daily",
        description: "Daily trend",
        from_model: "payment_attempts",
        from_alias: "pa",
        select: [
          { alias: "day", column: "created_at", expression: "DATE_TRUNC_DAY" },
          { alias: "attempts", column: "id", aggregate: "COUNT", format_hint: "INTEGER" },
          { alias: "volume", column: "total_charged_amount_minor", aggregate: "SUM", format_hint: "CURRENCY_MINOR" },
        ],
        where: {
          kind: "PREDICATE",
          column: "created_at",
          op: "between",
          binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH" },
        },
        group_by: ["day"],
        order_by: [{ field: "day", direction: "ASC" }],
        limit: 30,
      },
    ],
    transforms: [
      {
        operation: "COMPUTE_COLUMN",
        target_dataset_id: "daily",
        output_column: "share",
        formula: "PERCENTAGE_SHARE",
        left_operand: "volume",
        format_hint: "PERCENT_RATIO",
      },
      {
        operation: "COMPARE_WITH_ASSET",
        source_dataset_id: "daily",
        asset_key: "targets",
        output_dataset_id: "daily_vs_targets",
        match_keys: ["day"],
        compare_fields: [{ dataset_field: "volume", asset_field: "target_volume", tolerance_minor: 0 }],
      },
    ],
    sections: [
      ...base.sections,
      {
        section_type: "DATA_TABLE",
        section_id: "trend",
        title_i18n_key: "table.title",
        dataset_id: "daily",
        columns: [
          { field: "day", header_i18n_key: "table.day", width_percent: 60 },
          { field: "volume", header_i18n_key: "table.amount", width_percent: 40, format_hint: "CURRENCY_MINOR" },
        ],
      },
      {
        section_type: "CHART",
        section_id: "trend_chart",
        title_i18n_key: "table.title",
        dataset_id: "daily",
        chart_kind: "LINE",
        x_field: "day",
        series: [{ field: "volume", label_i18n_key: "table.amount" }],
      },
      {
        section_type: "IMAGE_BANNER",
        section_id: "banner",
        asset_key: "logo",
      },
      {
        section_type: "HTML_TEMPLATE",
        section_id: "note",
        html_template: "<div>{{$t.table.title}} {{$t.table.day}}</div>",
        scoped_css: "",
      },
      {
        section_type: "DATA_TABLE",
        section_id: "hidden_when_empty",
        title_i18n_key: "table.title",
        dataset_id: "daily_vs_targets",
        visibility: { when: "DATASET_NOT_EMPTY", dataset_id: "daily_vs_targets" },
        columns: [
          { field: "day", header_i18n_key: "table.day" },
          { field: "volume", header_i18n_key: "table.amount", format_hint: "CURRENCY_MINOR" },
          { field: "target_volume", header_i18n_key: "table.amount", format_hint: "CURRENCY_MINOR" },
          { field: "_has_discrepancy", header_i18n_key: "table.day" },
        ],
      },
    ],
  });
}

describe("Studio mock preview bundle", () => {
  test("fills every dataset and runs transforms without a database", () => {
    const spec = complexSpec();
    const bundle = buildMockReportBundle({
      spec,
      host: createTestHostConfig(),
      actor: { userId: "u1", email: "author@example.test", role: "FINANCE", authorities: ["finance:read"] },
    });
    expect(bundle.previewMode).toBe("MOCK");
    expect(bundle.datasets.totals!.length).toBeGreaterThan(0);
    expect(bundle.datasets.daily!.length).toBeGreaterThan(1);
    expect(bundle.datasets.daily_vs_targets!.length).toBeGreaterThan(0);
    expect(bundle.datasets.daily_vs_targets![0]).toHaveProperty("share");
    expect(bundle.datasets.daily_vs_targets![0]).toHaveProperty("target_volume");
    expect(bundle.datasets.daily_vs_targets![0]).toHaveProperty("_has_discrepancy");
    for (const row of bundle.datasets.daily!) {
      expect(row.day).toBeTruthy();
      expect(row.volume).toBeTruthy();
    }
  });

  test("mocks image assets so previews never drop banners", () => {
    const spec = complexSpec();
    const bundle = buildMockReportBundle({ spec, host: createTestHostConfig() });
    expect(bundle.assetDataUrls.logo).toStartWith("data:image/svg+xml;base64,");
  });

  test("returns a verification hash and inputs used", () => {
    const spec = complexSpec();
    const bundle = buildMockReportBundle({ spec, host: createTestHostConfig() });
    expect(bundle.verificationSha256).toBe("mock-preview-data");
    expect(Object.keys(bundle.inputsUsed).sort()).toEqual(["merchantId", "periodRange"]);
  });
});

describe("authoring guardrails", () => {
  test("unsupported HTML template tokens are rejected at Layer 1", () => {
    const spec = baseReportSpec();
    spec.sections.push({
      section_type: "HTML_TEMPLATE",
      section_id: "cover",
      html_template: "<div>{{attempts}} {{success_rate}}</div>",
      scoped_css: "",
    });
    const { diagnostics } = validateSpecStructureAndI18n(spec, createTestHostConfig());
    const tokenErrors = diagnostics.filter((d) => d.code === "UNSUPPORTED_TEMPLATE_TOKEN");
    expect(tokenErrors.length).toBe(2);
  });

  test("engine-internal models are not reportable", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.from_model = "report_definition_specs";
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "UNKNOWN_MODEL" || d.code === "MODEL_NOT_REPORTABLE")).toBe(true);
  });
});
