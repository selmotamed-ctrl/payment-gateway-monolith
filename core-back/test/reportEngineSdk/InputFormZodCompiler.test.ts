import { describe, expect, test } from "bun:test";
import { resolveInputDefaults } from "../../lib/reportEngineSdk/compiler/InputFormZodCompiler";
import { baseReportSpec } from "./helpers";

describe("RE-T20: input form Zod compiler", () => {
  test("entity_autocomplete and daterange validation are enforced", () => {
    const schema = compileReportInputsToZodObject(baseReportSpec());
    expect(
      schema.safeParse({
        merchantId: "00000000-0000-4000-8000-000000000001",
        periodRange: { start: "2026-01-01", end: "2026-12-31" },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        merchantId: "merchant-123",
        periodRange: { start: "2026-01-01", end: "2026-12-31" },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        merchantId: "00000000-0000-4000-8000-000000000001",
        periodRange: { start: "2024-01-01", end: "2026-12-31" },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        merchantId: "00000000-0000-4000-8000-000000000001",
        periodRange: { start: "2026-01-01", end: "2026-12-31" },
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  test("preset defaults resolve deterministically against a supplied clock", () => {
    const spec = baseReportSpec();
    spec.inputs = [
      {
        key: "periodRange",
        label_i18n_key: "input.period",
        type: "daterange",
        required: true,
        default_value: { preset: "LAST_7_DAYS" },
        layout_col_span: 6,
      },
      {
        key: "merchantId",
        label_i18n_key: "input.merchant",
        type: "entity_autocomplete",
        required: true,
        default_value: "00000000-0000-4000-8000-000000000001",
        layout_col_span: 6,
      },
    ];
    const defaults = resolveInputDefaults(spec, new Date("2026-05-15T12:00:00.000Z"));
    expect(defaults.periodRange).toEqual({
      start: "2026-05-09T00:00:00.000Z",
      end: "2026-05-15T23:59:59.999Z",
    });
    expect(defaults.merchantId).toBe("00000000-0000-4000-8000-000000000001");
  });
});

import { compileReportInputsToZodObject } from "../../lib/reportEngineSdk/compiler/InputFormZodCompiler";
import type { ReportInputFieldSpec } from "../../lib/reportEngineSdk/types/reportSpec";

describe("remediation A18: multi-autocomplete items are UUID-validated", () => {
  const field = (source: "applications" | "currencies"): ReportInputFieldSpec => ({
    key: "ids",
    label_i18n_key: "input.merchant",
    type: "entity_multi_autocomplete",
    required: true,
    autocomplete: { source },
    layout_col_span: 6,
  });

  test("UUID sources reject non-UUID items", () => {
    const schema = compileReportInputsToZodObject({
      inputs: [field("applications")],
    } as never);
    const result = schema.safeParse({ ids: ["not-a-uuid"] });
    expect(result.success).toBe(false);
    expect(schema.safeParse({ ids: ["11111111-1111-4111-8111-111111111111"] }).success).toBe(true);
  });

  test("currency sources keep plain string codes", () => {
    const schema = compileReportInputsToZodObject({
      inputs: [field("currencies")],
    } as never);
    expect(schema.safeParse({ ids: ["LYD", "USD"] }).success).toBe(true);
  });
});
