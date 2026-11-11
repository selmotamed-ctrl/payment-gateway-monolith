import { describe, expect, test } from "bun:test";
import { validateQueriesAndOptimizations } from "../../lib/reportEngineSdk/verifier/QuerySafetyAndOptValidator";
import { baseReportSpec, createTestHostConfig, FakeReadOnlyPort } from "./helpers";

describe("RE-T03..RE-T07: query safety, partition pruning and EXPLAIN guard", () => {
  test("RE-T03: journal_lines without a created_at filter is rejected", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.where = {
      kind: "PREDICATE",
      column: "merchant_id",
      op: "eq",
      binding: { source: "INPUT", input_key: "merchantId", omit_if_empty: false },
    };
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "MANDATORY_PARTITION_FILTER_MISSING")).toBe(true);
  });

  test("RE-T04: a daterange beyond the partition limit is rejected", async () => {
    const spec = baseReportSpec();
    spec.inputs.find((input) => input.key === "periodRange")!.validation = { max_range_days: 730 };
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "PARTITION_DATE_RANGE_UNBOUNDED")).toBe(true);
  });

  test("RE-T05: forbidden secret columns are rejected", async () => {
    const spec = baseReportSpec();
    spec.datasets.push({
      dataset_id: "secrets",
      description: "Secrets",
      from_model: "credential_sets",
      from_alias: "cs",
      joins: [],
      select: [{ alias: "sealed", column: "entries_ciphertext", expression: "COLUMN", format_hint: "RAW" }],
      group_by: [],
      having: [],
      window_fields: [],
      order_by: [],
      limit: 10,
    });
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "FORBIDDEN_SECRET_COLUMN")).toBe(true);
  });

  test("RE-T06: a merchant-facing report without merchant isolation is rejected", async () => {
    const spec = baseReportSpec();
    spec.report.audience_scope = "MERCHANT_FACING";
    spec.datasets[0]!.where = {
      kind: "PREDICATE",
      column: "created_at",
      op: "between",
      binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
    };
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "MERCHANT_ISOLATION_FILTER_MISSING")).toBe(true);
  });

  test("RE-T07: an EXPLAIN cost above the limit is rejected", async () => {
    const fake = new FakeReadOnlyPort();
    fake.explain = {
      totalCost: 999_999,
      planRows: 100_000,
      hasSeqScanOnLargeTable: true,
      seqScanTables: ["journal_lines"],
      partitionsScanned: 70,
      rawPlanJson: {},
    };
    const diagnostics = await validateQueriesAndOptimizations(
      baseReportSpec(),
      createTestHostConfig({ dbReadOnlyPort: fake }),
    );
    expect(diagnostics.some((d) => d.code === "QUERY_COST_EXCEEDED")).toBe(true);
    expect(diagnostics.some((d) => d.code === "SEQUENTIAL_SCAN_DETECTED")).toBe(true);
  });

  test("a safe spec produces no errors", async () => {
    const diagnostics = await validateQueriesAndOptimizations(baseReportSpec(), createTestHostConfig());
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("semantic AST diagnostics", () => {
  test("an unknown WHERE column is a diagnostic, not a thrown compiler error", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.where = {
      kind: "GROUP",
      logic: "AND",
      conditions: [
        {
          kind: "PREDICATE",
          column: "does_not_exist",
          op: "eq",
          binding: { source: "INPUT", input_key: "merchantId", omit_if_empty: false },
        },
      ],
    };
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((diagnostic) => diagnostic.code === "UNKNOWN_COLUMN")).toBe(true);
  });

  test("an invalid join relation is a diagnostic", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.joins = [
      { join_type: "LEFT", relation_name: "not_a_relation", target_model: "gl_accounts", alias: "ga" },
    ];
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((diagnostic) => diagnostic.code === "INVALID_JOIN_RELATION")).toBe(true);
  });
});

describe("remediation A08/A09/A10/A14: mandatory-filter bypasses and grouped queries", () => {
  const withCreatedAt = (
    op: "is_not_null" | "eq" | "gte" | "lte" | "between" | "gt",
    binding?: Record<string, unknown>,
  ) => {
    const spec = baseReportSpec();
    spec.datasets[0]!.where = {
      kind: "GROUP",
      logic: "AND",
      conditions: [
        {
          kind: "PREDICATE",
          column: "merchant_id",
          op: "eq",
          binding: { source: "INPUT", input_key: "merchantId", omit_if_empty: false },
        },
        {
          kind: "PREDICATE",
          column: "created_at",
          op,
          binding: binding as never,
        },
      ],
    };
    return spec;
  };

  test("A08: MINOR_TO_MAJOR_DECIMAL on a major-unit column is rejected at Layer 2", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.select = [
      {
        alias: "total",
        column: "amount_minor",
        expression: "MINOR_TO_MAJOR_DECIMAL",
        format_hint: "DECIMAL_4",
      },
    ];
    const host = createTestHostConfig();
    host.models.journal_lines!.columns.amount = {
      name: "amount",
      dbColumnName: "amount",
      type: "decimal",
      nullable: false,
      indexed: false,
      sensitivity: "INTERNAL",
      description: "Major amount",
    };
    spec.datasets[0]!.select[0]!.column = "amount";
    const diagnostics = await validateQueriesAndOptimizations(spec, host);
    expect(diagnostics.some((d) => d.code === "MINOR_TO_MAJOR_REQUIRES_MINOR_COLUMN")).toBe(true);
  });

  test("A09: is_not_null or eq on the mandatory partition column is rejected", async () => {
    for (const op of ["is_not_null", "eq"] as const) {
      const spec = withCreatedAt(
        op,
        op === "eq" ? { source: "LITERAL", value: "2026-01-01T00:00:00Z" } : undefined,
      );
      const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
      expect(
        diagnostics.some(
          (d) =>
            d.code === "MANDATORY_FILTER_OPERATOR_NOT_ALLOWED" ||
            d.code === "MANDATORY_PARTITION_FILTER_UNBOUNDED",
        ),
        op,
      ).toBe(true);
    }
  });

  test("A09: omit_if_empty on the mandatory predicate is rejected", async () => {
    const spec = withCreatedAt("between", {
      source: "INPUT",
      input_key: "periodRange",
      range_bound: "BOTH",
      omit_if_empty: true,
    });
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "MANDATORY_FILTER_OPTIONAL_BINDING")).toBe(true);
  });

  test("A09: a single-sided gte bound is not a bounded filter", async () => {
    const spec = withCreatedAt("gte", {
      source: "INPUT",
      input_key: "periodRange",
      range_bound: "START",
    });
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "MANDATORY_PARTITION_FILTER_UNBOUNDED")).toBe(true);
  });

  test("A09: a gte + lte pair bound to the same input is accepted", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.where = {
      kind: "GROUP",
      logic: "AND",
      conditions: [
        {
          kind: "PREDICATE",
          column: "merchant_id",
          op: "eq",
          binding: { source: "INPUT", input_key: "merchantId", omit_if_empty: false },
        },
        {
          kind: "PREDICATE",
          column: "created_at",
          op: "gte",
          binding: { source: "INPUT", input_key: "periodRange", range_bound: "START", omit_if_empty: false },
        },
        {
          kind: "PREDICATE",
          column: "created_at",
          op: "lte",
          binding: { source: "INPUT", input_key: "periodRange", range_bound: "END", omit_if_empty: false },
        },
      ],
    };
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("A09: requireIndexedFilter demands an indexed predicate", async () => {
    const host = createTestHostConfig();
    host.models.journal_lines!.columns.merchant_id!.indexed = false;
    host.models.journal_lines!.columns.created_at!.indexed = false;
    const diagnostics = await validateQueriesAndOptimizations(baseReportSpec(), host);
    expect(diagnostics.some((d) => d.code === "INDEXED_FILTER_REQUIRED")).toBe(true);
  });

  test("A10: a costly large-table sequential scan is an error", async () => {
    const fake = new FakeReadOnlyPort();
    fake.explain = {
      totalCost: 100_000,
      planRows: 500_000,
      hasSeqScanOnLargeTable: true,
      seqScanTables: ["journal_lines_2026_01"],
      seqScans: [
        {
          table: "journal_lines_2026_01",
          parentTable: "journal_lines",
          totalCost: 100_000,
          planRows: 500_000,
          largeTable: true,
        },
      ],
      partitionsScanned: 1,
      rawPlanJson: {},
    };
    const diagnostics = await validateQueriesAndOptimizations(
      baseReportSpec(),
      createTestHostConfig({ dbReadOnlyPort: fake }),
    );
    const finding = diagnostics.find((d) => d.code === "SEQUENTIAL_SCAN_DETECTED");
    expect(finding?.severity).toBe("error");
  });

  test("A10b: a cheap bounded scan of one partition is allowed", async () => {
    const fake = new FakeReadOnlyPort();
    fake.explain = {
      totalCost: 100,
      planRows: 10,
      hasSeqScanOnLargeTable: true,
      seqScanTables: ["journal_lines_2026_01"],
      seqScans: [
        {
          table: "journal_lines_2026_01",
          parentTable: "journal_lines",
          totalCost: 100,
          planRows: 10,
          largeTable: true,
        },
      ],
      partitionsScanned: 1,
      rawPlanJson: {},
    };
    const diagnostics = await validateQueriesAndOptimizations(
      baseReportSpec(),
      createTestHostConfig({ dbReadOnlyPort: fake }),
    );
    expect(diagnostics.some((d) => d.code === "SEQUENTIAL_SCAN_DETECTED")).toBe(false);
  });

  test("A14: grouped ORDER BY on an ungrouped base column is rejected", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.order_by = [{ field: "merchant_id", direction: "ASC" }];
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "GROUPED_ORDER_BY_REQUIRES_ALIAS")).toBe(true);
  });

  test("A14: grouped window reference on an ungrouped base column is rejected", async () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.window_fields = [
      {
        alias: "rank",
        window_fn: "RANK",
        target_field: "merchant_id",
        partition_by: [],
        order_by: [],
      },
    ];
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "GROUPED_WINDOW_REQUIRES_ALIAS")).toBe(true);
  });
});

describe("AGE_DAYS aggregation guard", () => {
  test("AGE_DAYS on a datetime column is allowed with AVG", async () => {
    const spec = baseReportSpec();
    const ds = spec.datasets[0]!;
    ds.select = [
      { alias: "currency", column: "currency", expression: "COLUMN", format_hint: "RAW" },
      { alias: "avg_age_days", column: "created_at", expression: "AGE_DAYS", aggregate: "AVG", format_hint: "INTEGER" },
    ];
    ds.group_by = ["currency"];
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "AGGREGATE_REQUIRES_NUMERIC")).toBe(false);
  });

  test("AVG on a datetime column without AGE_DAYS is rejected", async () => {
    const spec = baseReportSpec();
    const ds = spec.datasets[0]!;
    ds.select = [
      { alias: "currency", column: "currency", expression: "COLUMN", format_hint: "RAW" },
      { alias: "avg_created", column: "created_at", expression: "COLUMN", aggregate: "AVG", format_hint: "INTEGER" },
    ];
    ds.group_by = ["currency"];
    const diagnostics = await validateQueriesAndOptimizations(spec, createTestHostConfig());
    expect(diagnostics.some((d) => d.code === "AGGREGATE_REQUIRES_NUMERIC")).toBe(true);
  });
});
