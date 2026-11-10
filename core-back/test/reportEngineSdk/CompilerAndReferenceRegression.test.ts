import { describe, expect, test } from "bun:test";
import { compileDatasetQueryToSql } from "../../lib/reportEngineSdk/compiler/QueryAstToSqlCompiler";
import { validateSpecReferences } from "../../lib/reportEngineSdk/verifier/SpecReferenceValidator";
import { baseReportSpec, createTestHostConfig } from "./helpers";

describe("section field registry and compiler regressions", () => {
  test("window fields, transform outputs and pivot wildcards are addressable by sections", () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.window_fields = [
      {
        alias: "merchant_rank",
        window_fn: "ROW_NUMBER",
        target_field: "total",
        partition_by: [],
        order_by: [],
      },
    ];
    spec.transforms = [
      {
        operation: "COMPUTE_COLUMN",
        target_dataset_id: "totals",
        output_column: "share",
        formula: "PERCENTAGE_SHARE",
        left_operand: "total",
        right_operand: 0,
        format_hint: "PERCENT_RATIO",
      },
      {
        operation: "PIVOT_DATASET",
        source_dataset_id: "totals",
        output_dataset_id: "matrix",
        row_key: "currency",
        column_key: "currency",
        value_key: "total",
        aggregation: "SUM",
      },
      {
        operation: "JOIN_DATASETS",
        output_dataset_id: "joined",
        left_dataset_id: "totals",
        right_dataset_id: "totals",
        join_type: "LEFT",
        on_left_key: "currency",
        on_right_key: "currency",
      },
    ];
    spec.sections = [
      {
        section_type: "KPI_GRID",
        section_id: "kpis",
        columns: 2,
        cards: [
          { label_i18n_key: "report.title", dataset_id: "totals", value_field: "share", row_index: 0, format_hint: "PERCENT_RATIO", tone: "NEUTRAL" },
          { label_i18n_key: "report.title", dataset_id: "totals", value_field: "merchant_rank", row_index: 0, format_hint: "INTEGER", tone: "NEUTRAL" },
        ],
      },
      {
        section_type: "CHART",
        section_id: "rank_chart",
        title_i18n_key: "report.title",
        dataset_id: "totals",
        chart_kind: "BAR",
        height_mm: 70,
        width_percent: 100,
        x_field: "currency",
        y_axis_format: "INTEGER",
        series: [{ label_i18n_key: "report.title", field: "merchant_rank", show_value_labels: false }],
      },
      {
        section_type: "DATA_TABLE",
        section_id: "joined_table",
        dataset_id: "joined",
        repeat_header_on_page_break: true,
        avoid_row_split: true,
        zebra_striping: true,
        columns: [{ field: "currency", header_i18n_key: "report.title", align: "START", format_hint: "RAW", summary_footer: "NONE" }],
      },
      {
        section_type: "DATA_TABLE",
        section_id: "matrix_table",
        dataset_id: "matrix",
        repeat_header_on_page_break: true,
        avoid_row_split: true,
        zebra_striping: true,
        columns: [{ field: "LYD", header_i18n_key: "report.title", align: "END", format_hint: "CURRENCY_MINOR", summary_footer: "NONE" }],
      },
    ];
    const diagnostics = validateSpecReferences(spec, createTestHostConfig());
    expect(diagnostics.filter((diagnostic) => diagnostic.code.startsWith("UNKNOWN_SECTION"))).toEqual([]);
  });

  test("GROUP BY a CASE_WHEN_ENUM alias expands to the underlying column", () => {
    const spec = baseReportSpec();
    spec.datasets = [
      {
        dataset_id: "envs",
        description: "Environments",
        from_model: "payment_attempts",
        from_alias: "pa",
        joins: [],
        select: [
          { alias: "env", column: "status", expression: "CASE_WHEN_ENUM", case_map: { SUCCEEDED: "SUCCESS" }, format_hint: "ENUM_TRANSLATED" },
          { alias: "count", column: "id", expression: "COLUMN", aggregate: "COUNT", format_hint: "INTEGER" },
        ],
        group_by: ["env"],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ];
    const compiled = compileDatasetQueryToSql(spec.datasets[0]!, createTestHostConfig(), {});
    expect(compiled.sql).toContain('GROUP BY "pa"."status"');
    expect(compiled.sql).not.toContain("GROUP BY CASE");
  });

  test("additional_on joins compile before resolveColumnSql is initialized", () => {
    const spec = baseReportSpec();
    spec.datasets = [
      {
        dataset_id: "ledger_by_account_type",
        description: "Ledger by account type",
        from_model: "journal_lines",
        from_alias: "jl",
        joins: [
          {
            join_type: "LEFT",
            relation_name: "gl_account",
            target_model: "gl_accounts",
            alias: "ga",
            additional_on: {
              kind: "PREDICATE",
              table_alias: "ga",
              column: "account_type",
              op: "eq",
              binding: { source: "LITERAL", value: "ASSET" },
            },
          },
        ],
        select: [
          { alias: "account_type", table_alias: "ga", column: "account_type", expression: "COLUMN", format_hint: "RAW" },
          { alias: "total", column: "amount_minor", expression: "COLUMN", aggregate: "SUM", format_hint: "CURRENCY_MINOR" },
        ],
        group_by: ["account_type"],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ];
    const compiled = compileDatasetQueryToSql(spec.datasets[0]!, createTestHostConfig(), {});
    expect(compiled.sql).toContain('LEFT JOIN "gl_accounts" AS "ga"');
    expect(compiled.sql).toContain('"ga"."account_type" = $1');
    expect(compiled.sql).toContain("SUM(");
  });
});

  test("COMPARE_WITH_ASSET output_field and asset_field are section-addressable", () => {
    const spec = baseReportSpec();
    spec.transforms = [
      {
        operation: "COMPARE_WITH_ASSET",
        source_dataset_id: "totals",
        asset_key: "baseline",
        output_dataset_id: "rail_vs_target",
        match_keys: ["currency"],
        compare_fields: [
          { dataset_field: "total", asset_field: "target_total", output_field: "total_vs_target", tolerance_minor: 0 },
        ],
      },
    ];
    spec.sections = [
      {
        section_type: "DATA_TABLE",
        section_id: "tbl",
        dataset_id: "rail_vs_target",
        repeat_header_on_page_break: true,
        avoid_row_split: true,
        zebra_striping: true,
        columns: [
          { field: "target_total", header_i18n_key: "report.title", align: "END", format_hint: "CURRENCY_MINOR", summary_footer: "NONE" },
          { field: "total_vs_target", header_i18n_key: "report.title", align: "END", format_hint: "CURRENCY_MINOR", summary_footer: "NONE" },
        ],
      },
    ];
    const diagnostics = validateSpecReferences(spec, createTestHostConfig());
    expect(diagnostics.filter((diagnostic) => diagnostic.code.startsWith("UNKNOWN_SECTION"))).toEqual([]);
  });

  test("unknown field diagnostics list available fields and a near match", () => {
    const spec = baseReportSpec();
    spec.sections = [
      {
        section_type: "DATA_TABLE",
        section_id: "tbl",
        dataset_id: "totals",
        repeat_header_on_page_break: true,
        avoid_row_split: true,
        zebra_striping: true,
        columns: [{ field: "totl", header_i18n_key: "report.title", align: "START", format_hint: "RAW", summary_footer: "NONE" }],
      },
    ];
    const diagnostics = validateSpecReferences(spec, createTestHostConfig());
    const field = diagnostics.find((diagnostic) => diagnostic.code === "UNKNOWN_SECTION_FIELD");
    expect(field?.message).toContain("Available fields:");
    expect(field?.message).toContain("total");
    expect(field?.aiFixHint).toContain('Did you mean "total"');
  });

  test("additional_on daterange predicates compile safely", () => {
    const spec = baseReportSpec();
    spec.datasets = [
      {
        dataset_id: "route_health",
        description: "Route health",
        from_model: "journal_lines",
        from_alias: "jl",
        joins: [
          {
            join_type: "LEFT",
            relation_name: "gl_account",
            target_model: "gl_accounts",
            alias: "ga",
            additional_on: {
              kind: "PREDICATE",
              table_alias: "ga",
              column: "account_type",
              op: "between",
              binding: { source: "INPUT", input_key: "range", range_bound: "BOTH", omit_if_empty: false },
            },
          },
        ],
        select: [
          { alias: "total", column: "amount_minor", expression: "COLUMN", aggregate: "SUM", format_hint: "CURRENCY_MINOR" },
        ],
        group_by: [],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ];
    const compiled = compileDatasetQueryToSql(
      spec.datasets[0]!,
      createTestHostConfig(),
      { range: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.999Z" } },
    );
    expect(compiled.sql).toContain('LEFT JOIN "gl_accounts" AS "ga"');
    expect(compiled.sql).toContain("BETWEEN $1 AND $2");
    expect(compiled.sql).toContain("SUM(");
  });

  test("GROUP BY a DATE_TRUNC alias expands to the expression", () => {
    const spec = baseReportSpec();
    spec.datasets = [
      {
        dataset_id: "days",
        description: "Days",
        from_model: "payment_attempts",
        from_alias: "pa",
        joins: [],
        select: [
          { alias: "day", column: "created_at", expression: "DATE_TRUNC_DAY", format_hint: "DATE_ISO" },
          { alias: "count", column: "id", expression: "COLUMN", aggregate: "COUNT", format_hint: "INTEGER" },
        ],
        group_by: ["day"],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ];
    const compiled = compileDatasetQueryToSql(spec.datasets[0]!, createTestHostConfig(), {});
    expect(compiled.sql).toContain("GROUP BY date_trunc('day', \"pa\".\"created_at\")");
  });
