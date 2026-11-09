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
