import { describe, expect, test } from "bun:test";
import { executeTransformPipeline } from "../../lib/reportEngineSdk/compiler/TransformPipelineExecutor";

describe("RE-T16: transform pipeline", () => {
  test("COMPUTE_COLUMN and PERCENTAGE_SHARE run deterministically", () => {
    const result = executeTransformPipeline(
      { totals: [{ currency: "LYD", total: "1000" }] },
      [
        {
          operation: "COMPUTE_COLUMN",
          target_dataset_id: "totals",
          output_column: "fee",
          formula: "MULTIPLY",
          left_operand: "total",
          right_operand: 0.01,
          format_hint: "CURRENCY_MINOR",
        },
        {
          operation: "COMPUTE_COLUMN",
          target_dataset_id: "totals",
          output_column: "share",
          formula: "PERCENTAGE_SHARE",
          left_operand: "total",
          format_hint: "PERCENT_RATIO",
        },
      ],
      {},
    );
    expect(result.totals?.[0]?.fee).toBe("10");
    expect(result.totals?.[0]?.share).toBe("100");
  });

  test("COMPARE_WITH_ASSET reports matches, variance and discrepancies", () => {
    const result = executeTransformPipeline(
      { totals: [{ currency: "LYD", total: 1000 }, { currency: "USD", total: 500 }] },
      [
        {
          operation: "COMPARE_WITH_ASSET",
          source_dataset_id: "totals",
          asset_key: "baseline",
          output_dataset_id: "comparison",
          match_keys: ["currency"],
          compare_fields: [{ dataset_field: "total", asset_field: "total", tolerance_minor: 0 }],
        },
      ],
      { baseline: [{ currency: "LYD", total: 1000 }, { currency: "USD", total: 450 }] },
    );
    const rows = result.comparison ?? [];
    expect(rows[0]?._asset_matched).toBe(true);
    expect(rows[0]?._has_discrepancy).toBe(false);
    expect(rows[1]?._has_discrepancy).toBe(true);
    expect(rows[1]?.total_variance).toBe("50");
  });

  test("JOIN_DATASETS and PIVOT_DATASET produce the expected shapes", () => {
    const result = executeTransformPipeline(
      {
        left: [{ id: "1", name: "A" }],
        right: [{ id: "1", amount: 10 }, { id: "1", amount: 5 }],
      },
      [
        {
          operation: "JOIN_DATASETS",
          output_dataset_id: "joined",
          left_dataset_id: "left",
          right_dataset_id: "right",
          join_type: "INNER",
          on_left_key: "id",
          on_right_key: "id",
        },
      ],
      {},
    );
    expect(result.joined?.[0]?.name).toBe("A");

    const pivoted = executeTransformPipeline(
      { rows: [{ day: "2026-01-01", kind: "DEBIT", amount: 10 }, { day: "2026-01-01", kind: "CREDIT", amount: 3 }] },
      [
        {
          operation: "PIVOT_DATASET",
          source_dataset_id: "rows",
          output_dataset_id: "pivot",
          row_key: "day",
          column_key: "kind",
          value_key: "amount",
          aggregation: "SUM",
        },
      ],
      {},
    );
    expect(pivoted.pivot?.[0]).toEqual({ day: "2026-01-01", DEBIT: "10", CREDIT: "3" });
  });
});

describe("COMPARE_WITH_ASSET output contract", () => {
  test("emits asset_field, optional output_field, expected and variance", () => {
    const result = executeTransformPipeline(
      { source: [{ rail_code: "LYD", volume: 100 }] },
      [
        {
          operation: "COMPARE_WITH_ASSET",
          source_dataset_id: "source",
          asset_key: "targets",
          output_dataset_id: "comparison",
          match_keys: ["rail_code"],
          compare_fields: [
            {
              dataset_field: "volume",
              asset_field: "target_volume",
              output_field: "volume_vs_target",
              tolerance_minor: 0,
            },
          ],
        },
      ],
      { targets: [{ rail_code: "LYD", target_volume: 90 }] },
    );
    const row = result.comparison?.[0];
    expect(row).toMatchObject({
      volume: 100,
      target_volume: 90,
      volume_vs_target: "90",
      volume_expected: "90",
      volume_variance: "10",
      _asset_matched: true,
      _has_discrepancy: true,
    });
  });
});

  test("without output_field the asset_field name is the target column", () => {
    const result = executeTransformPipeline(
      { source: [{ rail_code: "LYD", volume: 100 }] },
      [
        {
          operation: "COMPARE_WITH_ASSET",
          source_dataset_id: "source",
          asset_key: "targets",
          output_dataset_id: "comparison",
          match_keys: ["rail_code"],
          compare_fields: [{ dataset_field: "volume", asset_field: "target_volume", tolerance_minor: 0 }],
        },
      ],
      { targets: [{ rail_code: "LYD", target_volume: 90 }] },
    );
    expect(result.comparison?.[0]).toMatchObject({ target_volume: 90, volume_expected: "90", volume_variance: "10" });
  });

describe("remediation A05/A06/A07: comparison, joins and exact decimal arithmetic", () => {
  test("A05: source fields are never overwritten; missing and duplicate asset keys are flagged", () => {
    const result = executeTransformPipeline(
      { source: [{ code: "LYD", volume: "100.1" }, { code: "USD", volume: "50" }] },
      [
        {
          operation: "COMPARE_WITH_ASSET",
          source_dataset_id: "source",
          asset_key: "baseline",
          output_dataset_id: "comparison",
          match_keys: ["code"],
          compare_fields: [{ dataset_field: "volume", asset_field: "volume", tolerance_minor: 0 }],
        },
      ],
      {
        baseline: [
          { code: "LYD", volume: "100.1" },
          { code: "EUR", volume: "7" },
          { code: "EUR", volume: "8" },
        ],
      },
    );
    const rows = result.comparison ?? [];
    const lyd = rows.find((row) => row.code === "LYD")!;
    expect(lyd.volume).toBe("100.1");
    expect(lyd.volume_expected).toBe("100.1");
    expect(lyd._has_discrepancy).toBe(false);
    const missing = rows.find((row) => row.code === "EUR" && row._missing_in_live === true)!;
    expect(missing).toBeDefined();
    expect(missing._duplicate_asset_key).toBe(true);
    expect(missing._has_discrepancy).toBe(true);
  });

  test("A06: duplicate keys cross-product, null keys never match", () => {
    const result = executeTransformPipeline(
      {
        left: [{ id: "1", name: "A" }, { id: null, name: "N" }],
        right: [{ id: "1", amount: 10 }, { id: "1", amount: 20 }, { id: null, amount: 99 }],
      },
      [
        {
          operation: "JOIN_DATASETS",
          output_dataset_id: "joined",
          left_dataset_id: "left",
          right_dataset_id: "right",
          join_type: "INNER",
          on_left_key: "id",
          on_right_key: "id",
        },
      ],
      {},
    );
    expect(result.joined).toHaveLength(2);
    expect(result.joined?.map((row) => row.amount).sort()).toEqual([10, 20]);
  });

  test("A07: decimal.js keeps 0.1+0.2, values above 2^53 and leading zeros exact", () => {
    const result = executeTransformPipeline(
      {
        rows: [
          { a: "0.1", b: "0.2", big: "9007199254740993" },
        ],
      },
      [
        {
          operation: "COMPUTE_COLUMN",
          target_dataset_id: "rows",
          output_column: "sum",
          formula: "ADD",
          left_operand: "a",
          right_operand: "b",
          format_hint: "RAW",
        },
        {
          operation: "COMPUTE_COLUMN",
          target_dataset_id: "rows",
          output_column: "big_plus_one",
          formula: "ADD",
          left_operand: "big",
          right_operand: 1,
          format_hint: "RAW",
        },
      ],
      {},
    );
    expect(result.rows?.[0]?.sum).toBe("0.3");
    expect(result.rows?.[0]?.big_plus_one).toBe("9007199254740994");
  });

  test("A07: CSV cells keep leading zeros and are not coerced before comparison", () => {
    const result = executeTransformPipeline(
      { source: [{ code: "0012", amount: "1" }] },
      [
        {
          operation: "COMPARE_WITH_ASSET",
          source_dataset_id: "source",
          asset_key: "baseline",
          output_dataset_id: "comparison",
          match_keys: ["code"],
          compare_fields: [{ dataset_field: "amount", asset_field: "amount", tolerance_minor: 0 }],
        },
      ],
      { baseline: [{ code: "0012", amount: "1" }] },
    );
    expect(result.comparison?.[0]?._asset_matched).toBe(true);
  });
});
