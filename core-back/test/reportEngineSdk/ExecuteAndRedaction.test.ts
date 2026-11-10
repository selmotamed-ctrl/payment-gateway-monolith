import { describe, expect, test } from "bun:test";
import { executeReport } from "../../lib/reportEngineSdk";
import { createTestHostConfig, baseReportSpec, financeActor, FakeReadOnlyPort } from "./helpers";
import type { ReportDescriptorSpec } from "../../lib/reportEngineSdk/types/reportSpec";

const MONTH = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.999Z" };

function specWithComparison(): ReportDescriptorSpec {
  const spec = baseReportSpec();
  spec.required_assets = [
    {
      asset_key: "baseline",
      file_name: "baseline.json",
      mime_type: "application/json",
      purpose: "COMPARISON_BASELINE_DATA",
    },
  ];
  spec.transforms = [
    {
      operation: "COMPARE_WITH_ASSET",
      source_dataset_id: "totals",
      asset_key: "baseline",
      output_dataset_id: "comparison",
      match_keys: ["currency"],
      compare_fields: [{ dataset_field: "total", asset_field: "total", tolerance_minor: 0 }],
    },
  ];
  return spec;
}

describe("remediation A04/A18: execution, bundle assets, aggregates and truncation", () => {
  test("A04: COMPARISON_BASELINE_DATA is loaded from the stored bundle when no buffers are passed", async () => {
    const fake = new FakeReadOnlyPort();
    fake.rows = [{ currency: "LYD", total: "1000" }];
    const assetCalls: Array<{ bundleId: string; relativePath: string }> = [];
    const host = createTestHostConfig({
      dbReadOnlyPort: fake,
      assetStoragePort: {
        storeAssetBundle: async () => ({ bundleStorageKey: "bundle-1" }),
        getAssetBuffer: async (params) => {
          assetCalls.push(params);
          return {
            buffer: Buffer.from(JSON.stringify([{ currency: "LYD", total: "1000" }])),
            mimeType: "application/json",
            sha256: "test",
          };
        },
      },
    });

    const bundle = await executeReport(host, {
      spec: specWithComparison(),
      inputs: { merchantId: "11111111-1111-4111-8111-111111111111", periodRange: MONTH },
      actor: financeActor,
      chromeRegistry: [],
      assetBundleId: "bundle-1",
    });

    expect(assetCalls.some((call) => call.relativePath === "baseline.json")).toBe(true);
    expect(bundle.datasets.comparison?.[0]?._asset_matched).toBe(true);
    expect(bundle.datasets.comparison?.[0]?._has_discrepancy).toBe(false);
  });

  test("A18: aggregate counts are not masked as PII", async () => {
    const fake = new FakeReadOnlyPort();
    fake.rows = [{ email_count: 3 }];
    const host = createTestHostConfig({ dbReadOnlyPort: fake });
    const spec = baseReportSpec();
    spec.report.audience_scope = "BACKOFFICE_INTERNAL";
    spec.report.merchant_scope_input_key = undefined as unknown as string;
    spec.inputs = [];
    spec.datasets = [
      {
        dataset_id: "counts",
        description: "counts",
        from_model: "users",
        from_alias: "u",
        joins: [],
        select: [
          {
            alias: "email_count",
            column: "email",
            expression: "COLUMN",
            aggregate: "COUNT",
            format_hint: "INTEGER",
          },
        ],
        group_by: [],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ];

    const bundle = await executeReport(host, {
      spec,
      inputs: {},
      actor: financeActor,
      chromeRegistry: [],
    });
    expect(bundle.datasets.counts?.[0]?.email_count).toBe(3);
  });

  test("A18: a dataset at its row cap reports truncated", async () => {
    const fake = new FakeReadOnlyPort();
    fake.rows = [{ currency: "LYD", total: "1000" }];
    const host = createTestHostConfig({ dbReadOnlyPort: fake });
    const spec = baseReportSpec();
    spec.datasets[0]!.limit = 1;
    const bundle = await executeReport(host, {
      spec,
      inputs: { merchantId: "11111111-1111-4111-8111-111111111111", periodRange: MONTH },
      actor: financeActor,
      chromeRegistry: [],
    });
    expect(bundle.datasetTruncated.totals).toBe(true);
  });
});
