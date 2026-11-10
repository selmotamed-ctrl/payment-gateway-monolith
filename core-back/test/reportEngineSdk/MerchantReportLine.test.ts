import { describe, expect, test } from "bun:test";
import { compileDatasetQueryToSql } from "../../lib/reportEngineSdk/compiler/QueryAstToSqlCompiler";
import { executeReport, ReportMerchantScopeViolationError } from "../../lib/reportEngineSdk";
import {
  MERCHANT_REPORT_MODEL_ALLOWLIST,
  getMerchantReportHostConfig,
} from "../../engine/reportStudio/merchantHostConfig";
import {
  MERCHANT_TIER_LIMITS,
  validateMerchantTierLimits,
} from "../../engine/reportStudio/merchantReportEngine";
import { baseReportSpec, createTestHostConfig, financeActor, FakeReadOnlyPort } from "./helpers";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MERCHANT_ID = "22222222-2222-4222-8222-222222222222";

describe("E02: merchant host is an explicit allow-list", () => {
  test("only directly merchant-scoped models are present", () => {
    const host = getMerchantReportHostConfig();
    expect(Object.keys(host.models).sort()).toEqual([...MERCHANT_REPORT_MODEL_ALLOWLIST].sort());
    for (const forbidden of [
      "journal_lines",
      "credential_sets",
      "audit_log",
      "aml_cases",
      "users",
      "reporting_rules",
      "payment_links",
      "pos_terminals",
      "disputes",
      "outbox_events",
    ]) {
      expect(host.models[forbidden]).toBeUndefined();
    }
    for (const model of Object.values(host.models)) {
      expect(model.confidentialAmlOnly).toBe(false);
      expect(model.merchantScopable).toBeDefined();
    }
  });

  test("sensitive columns are absent from the merchant catalog", () => {
    const host = getMerchantReportGatewayReportHost();
    expect(host.models.payment_attempts?.columns.context_ciphertext).toBeUndefined();
    expect(host.models.payment_attempts?.columns.client_ip).toBeUndefined();
    expect(host.models.merchants?.columns.payout_bank_details_json).toBeUndefined();
    expect(host.models.merchants?.columns.contact_email).toBeUndefined();
    expect(host.models.cashout_requests?.columns.destination_bank_json).toBeUndefined();
  });
});

function getMerchantReportGatewayReportHost() {
  return getMerchantReportHostConfig();
}

describe("E04: engine-injected merchant identity", () => {
  const scopedDataset = () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.from_model = "payment_attempts";
    spec.datasets[0]!.from_alias = "pa";
    spec.datasets[0]!.joins = [];
    spec.datasets[0]!.select = [
      { alias: "currency", column: "currency", expression: "COLUMN", format_hint: "RAW" },
      {
        alias: "total",
        column: "total_charged_amount_minor",
        expression: "COLUMN",
        aggregate: "SUM",
        format_hint: "CURRENCY_MINOR",
      },
    ];
    spec.datasets[0]!.where = {
      kind: "GROUP",
      logic: "AND",
      conditions: [
        {
          kind: "PREDICATE",
          column: "created_at",
          op: "between",
          binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
        },
      ],
    };
    return spec;
  };

  test("the compiler adds a top-level merchant predicate on every alias", () => {
    const host = createTestHostConfig();
    const compiled = compileDatasetQueryToSql(
      scopedDataset().datasets[0]!,
      host,
      { periodRange: { start: "2026-01-01", end: "2026-01-31" } },
      undefined,
      { merchantScope: { merchantId: MERCHANT_ID } },
    );
    expect(compiled.scopeAliases).toEqual(["pa"]);
    expect(compiled.sql).toContain('"pa"."merchant_id" = $');
    expect(compiled.values).toContain(MERCHANT_ID);
    expect(compiled.sql).toContain('"__scope_merchant_id"');
  });

  test("a returned row outside the merchant scope aborts execution", async () => {
    const fake = new FakeReadOnlyPort();
    fake.rows = [{ currency: "LYD", total: "10", __scope_merchant_id: OTHER_MERCHANT_ID }];
    const host = createTestHostConfig({ dbReadOnlyPort: fake });
    const violations: string[] = [];
    await expect(
      executeReport(host, {
        spec: scopedDataset(),
        inputs: {
          merchantId: MERCHANT_ID,
          periodRange: { start: "2026-01-01", end: "2026-01-31" },
        },
        actor: financeActor,
        chromeRegistry: [],
        merchantScope: {
          merchantId: MERCHANT_ID,
          onViolation: (info) => {
            violations.push(info.datasetId);
          },
        },
      }),
    ).rejects.toBeInstanceOf(ReportMerchantScopeViolationError);
    expect(violations).toEqual(["totals"]);
  });

  test("the hidden scope column never reaches the caller", async () => {
    const fake = new FakeReadOnlyPort();
    fake.rows = [{ currency: "LYD", total: "10", __scope_merchant_id: MERCHANT_ID }];
    const host = createTestHostConfig({ dbReadOnlyPort: fake });
    const bundle = await executeReport(host, {
      spec: scopedDataset(),
      inputs: {
        merchantId: MERCHANT_ID,
        periodRange: { start: "2026-01-01", end: "2026-01-31" },
      },
      actor: financeActor,
      chromeRegistry: [],
      merchantScope: { merchantId: MERCHANT_ID },
    });
    expect(bundle.datasets.totals?.[0]?.__scope_merchant_id).toBeUndefined();
  });
});

describe("E05: merchant tier limits", () => {
  const merchantSpec = () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.from_model = "payment_attempts";
    spec.datasets[0]!.from_alias = "pa";
    spec.datasets[0]!.select = [
      { alias: "currency", column: "currency", expression: "COLUMN", format_hint: "RAW" },
      {
        alias: "total",
        column: "total_charged_amount_minor",
        expression: "COLUMN",
        aggregate: "SUM",
        format_hint: "CURRENCY_MINOR",
      },
    ];
    return spec;
  };

  test("a spec inside the limits passes", () => {
    const spec = merchantSpec();
    spec.datasets[0]!.where = {
      kind: "PREDICATE",
      column: "created_at",
      op: "between",
      binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
    };
    spec.inputs.find((input) => input.key === "periodRange")!.validation = { max_range_days: 30 };
    expect(validateMerchantTierLimits(spec).filter((d) => d.severity === "error")).toEqual([]);
  });

  test("dataset, join, select and section caps are enforced", () => {
    const spec = merchantSpec();
    spec.datasets[0]!.joins = Array.from({ length: MERCHANT_TIER_LIMITS.maxJoinsPerDataset + 1 }, (_, index) => ({
      join_type: "INNER",
      relation_name: `r${index}`,
      target_model: "merchants",
      alias: `j${index}`,
    }));
    spec.datasets[0]!.select = Array.from({ length: MERCHANT_TIER_LIMITS.maxSelectFields + 1 }, (_, index) => ({
      alias: `f${index}`,
      column: "currency",
      expression: "COLUMN",
      format_hint: "RAW",
    }));
    spec.sections = Array.from({ length: MERCHANT_TIER_LIMITS.maxSections + 1 }, (_, index) => ({
      section_type: "KPI_GRID",
      section_id: `s${index}`,
      columns: 1,
      cards: [
        {
          label_i18n_key: "kpi.total",
          dataset_id: "totals",
          value_field: "total",
          row_index: 0,
          format_hint: "RAW",
          tone: "PRIMARY",
        },
      ],
    }));
    const codes = validateMerchantTierLimits(spec).map((d) => d.code);
    expect(codes).toContain("MERCHANT_TOO_MANY_JOINS");
    expect(codes).toContain("MERCHANT_TOO_MANY_SELECTS");
    expect(codes).toContain("MERCHANT_TOO_MANY_SECTIONS");
  });

  test("a missing or too-wide date range is rejected", () => {
    const spec = merchantSpec();
    spec.datasets[0]!.where = undefined;
    expect(validateMerchantTierLimits(spec).map((d) => d.code)).toContain("MERCHANT_DATE_RANGE_UNBOUNDED");

    const wide = merchantSpec();
    wide.datasets[0]!.where = {
      kind: "PREDICATE",
      column: "created_at",
      op: "between",
      binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
    };
    wide.inputs.find((input) => input.key === "periodRange")!.validation = { max_range_days: 180 };
    expect(validateMerchantTierLimits(wide).map((d) => d.code)).toContain("MERCHANT_DATE_RANGE_UNBOUNDED");
  });
});

describe("E04/E05 regression: aggregated scope and gte/lte ranges", () => {
  const merchantAggregateSpec = () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.from_model = "payment_attempts";
    spec.datasets[0]!.from_alias = "pa";
    spec.datasets[0]!.joins = [];
    spec.datasets[0]!.select = [
      { alias: "currency", column: "currency", expression: "COLUMN", format_hint: "RAW" },
      {
        alias: "total",
        column: "total_charged_amount_minor",
        expression: "COLUMN",
        aggregate: "SUM",
        format_hint: "CURRENCY_MINOR",
      },
    ];
    spec.datasets[0]!.where = {
      kind: "PREDICATE",
      column: "created_at",
      op: "between",
      binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
    };
    spec.inputs.find((input) => input.key === "periodRange")!.validation = { max_range_days: 30 };
    return spec;
  };

  test("a grouped merchant query aggregates the hidden scope column", () => {
    const host = createTestHostConfig();
    const spec = merchantAggregateSpec();
    const compiled = compileDatasetQueryToSql(
      spec.datasets[0]!,
      host,
      { periodRange: { start: "2026-01-01", end: "2026-01-31" } },
      undefined,
      { merchantScope: { merchantId: MERCHANT_ID } },
    );
    expect(compiled.sql).toContain('MAX("pa"."merchant_id") AS "__scope_merchant_id"');
    expect(compiled.sql).toContain('GROUP BY "pa"."currency"');
  });

  test("an aggregate-only merchant query aggregates the hidden scope column", () => {
    const host = createTestHostConfig();
    const spec = merchantAggregateSpec();
    spec.datasets[0]!.select = [
      {
        alias: "total",
        column: "total_charged_amount_minor",
        expression: "COLUMN",
        aggregate: "SUM",
        format_hint: "CURRENCY_MINOR",
      },
    ];
    spec.datasets[0]!.group_by = [];
    const compiled = compileDatasetQueryToSql(
      spec.datasets[0]!,
      host,
      { periodRange: { start: "2026-01-01", end: "2026-01-31" } },
      undefined,
      { merchantScope: { merchantId: MERCHANT_ID } },
    );
    expect(compiled.sql).toContain('MAX("pa"."merchant_id") AS "__scope_merchant_id"');
  });

  test("a same-input gte/lte pair satisfies the 92-day merchant range", () => {
    const spec = merchantAggregateSpec();
    spec.inputs.find((input) => input.key === "periodRange")!.validation = { max_range_days: 30 };
    spec.datasets[0]!.where = {
      kind: "GROUP",
      logic: "AND",
      conditions: [
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
    expect(validateMerchantTierLimits(spec).filter((d) => d.severity === "error")).toEqual([]);
  });
});
