import { describe, expect, test } from "bun:test";
import { ReportDescriptorSpecSchema } from "../../lib/reportEngineSdk/types/reportSpec";
import { normalizeReportSpec } from "../../lib/reportEngineSdk/types/normalizeReportSpec";
import { baseReportSpec } from "./helpers";

describe("report spec authoring aliases and limits", () => {
  test("normalises transform kind/compute aliases and default literal values", () => {
    const spec = baseReportSpec();
    spec.inputs[0]!.default_value = { literal: "00000000-0000-4000-8000-000000000001" } as never;
    spec.transforms = [
      {
        kind: "COMPUTE_COLUMN",
        compute: "SAFE_DIVIDE",
        target_dataset_id: "totals",
        output_column: "fee",
        left_operand: "total",
        right_operand: 10,
        format_hint: "INTEGER",
      } as never,
    ];
    const parsed = ReportDescriptorSpecSchema.parse(spec);
    expect(parsed.inputs[0]?.default_value).toBe("00000000-0000-4000-8000-000000000001");
    expect(parsed.transforms[0]).toMatchObject({ operation: "COMPUTE_COLUMN", formula: "SAFE_DIVIDE" });
  });

  test("normalises SVG view_box strings and accepts BAR shapes and INTEGER format hints", () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.select[0]!.format_hint = "INTEGER";
    spec.sections = [
      {
        section_type: "VECTOR_DRAW",
        section_id: "draw",
        draw_kind: "SETTLEMENT_WATERFALL_DIAGRAM",
        height_mm: 60,
        view_box: "0 0 800 260" as never,
        nodes: [
          {
            node_id: "bar",
            shape: "BAR",
            x: 10,
            y: 20,
            label_i18n_key: "report.title",
          } as never,
        ],
        edges: [],
      },
    ];
    const parsed = ReportDescriptorSpecSchema.parse(spec);
    expect(parsed.sections[0]).toMatchObject({ view_box: { x: 0, y: 0, width: 800, height: 260 } });
    expect((parsed.sections[0] as never as { nodes: Array<{ shape: string }> }).nodes[0]?.shape).toBe("BAR");
    expect(parsed.datasets[0]?.select[0]?.format_hint).toBe("INTEGER");
  });

  test("accepts 31 datasets, 26 transforms and 57 sections", () => {
    const spec = baseReportSpec();
    const dataset = spec.datasets[0]!;
    spec.datasets = Array.from({ length: 31 }, (_, index) => ({
      ...dataset,
      dataset_id: `ds_${index}`,
    }));
    spec.transforms = Array.from({ length: 26 }, (_, index) => ({
      operation: "COMPUTE_COLUMN",
      target_dataset_id: "ds_0",
      output_column: `computed_${index}`,
      formula: "ADD",
      left_operand: "total",
      right_operand: 1,
    })) as never;
    spec.sections = Array.from({ length: 57 }, (_, index) => ({
      section_type: "KPI_GRID",
      section_id: `kpi_${index}`,
      columns: 2,
      cards: [
        {
          label_i18n_key: "report.title",
          dataset_id: "ds_0",
          value_field: "total",
        },
      ],
    })) as never;
    expect(ReportDescriptorSpecSchema.safeParse(spec).success).toBe(true);
  });

  test("the normalizer is idempotent for canonical transforms", () => {
    const canonical = {
      operation: "COMPUTE_COLUMN",
      formula: "ADD",
      target_dataset_id: "ds",
      output_column: "x",
      left_operand: "a",
      right_operand: 1,
    };
    expect(normalizeReportSpec({ transforms: [canonical] })).toEqual({ transforms: [canonical] });
  });
});
