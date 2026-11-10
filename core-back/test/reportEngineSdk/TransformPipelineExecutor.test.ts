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
