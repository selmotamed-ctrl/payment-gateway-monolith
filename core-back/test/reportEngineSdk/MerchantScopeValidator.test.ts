import { describe, expect, test } from "bun:test";
import { validateMerchantReportScope } from "../../lib/reportEngineSdk/verifier/MerchantScopeValidator";
import { baseReportSpec, createTestHostConfig } from "./helpers";

describe("merchant report scope validation", () => {
  test("the base merchant report is safe", () => {
    expect(validateMerchantReportScope(baseReportSpec(), createTestHostConfig())).toEqual([]);
  });

  test("removing the merchant predicate is rejected", () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.where = {
      kind: "PREDICATE",
      column: "created_at",
      op: "between",
      binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
    };
    expect(
      validateMerchantReportScope(spec, createTestHostConfig()).some(
        (diagnostic) => diagnostic.code === "MERCHANT_ISOLATION_FILTER_MISSING",
      ),
    ).toBe(true);
  });

  test("an OR branch without the merchant predicate is rejected", () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.where = {
      kind: "GROUP",
      logic: "OR",
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
          op: "between",
          binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
        },
      ],
    };
    expect(
      validateMerchantReportScope(spec, createTestHostConfig()).some(
        (diagnostic) => diagnostic.code === "MERCHANT_ISOLATION_FILTER_MISSING",
      ),
    ).toBe(true);
  });

  test("a non-merchant model is rejected", () => {
    const spec = baseReportSpec();
    spec.datasets.push({
      dataset_id: "gateway_versions",
      description: "Gateway versions",
      from_model: "gateway_versions",
      from_alias: "gv",
      joins: [],
      select: [{ alias: "version_id", column: "id", expression: "COLUMN", format_hint: "RAW" }],
      group_by: [],
      having: [],
      window_fields: [],
      order_by: [],
      limit: 10,
    });
    expect(
      validateMerchantReportScope(spec, createTestHostConfig()).some(
        (diagnostic) => ["MERCHANT_MODEL_OUT_OF_SCOPE", "MERCHANT_CONFIDENTIAL_DOMAIN_FORBIDDEN"].includes(diagnostic.code),
      ),
    ).toBe(true);
  });
});
