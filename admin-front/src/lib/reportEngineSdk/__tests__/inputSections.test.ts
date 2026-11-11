import { describe, expect, test } from "vitest";
import { groupReportInputs } from "../utils/inputSections";
import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";

const input = (key: string, type: ReportInputFieldSpec["type"], source?: string): ReportInputFieldSpec => ({
  key,
  label_i18n_key: `input.${key}`,
  type,
  required: false,
  ...(source ? { autocomplete: { source } } : {}),
  layout_col_span: 6,
}) as ReportInputFieldSpec;

const spec = (inputs: ReportInputFieldSpec[]) => ({ inputs }) as Pick<ReportDescriptorSpec, "inputs">;

describe("report input sections", () => {
  test("groups scope, period and filters in a stable order", () => {
    const sections = groupReportInputs(
      spec([
        input("status", "enum"),
        input("merchantId", "entity_autocomplete", "merchants"),
        input("period", "daterange"),
        input("applicationId", "entity_autocomplete", "applications"),
        input("currency", "entity_autocomplete", "currencies"),
      ]),
    );
    expect(sections.map((section) => section.id)).toEqual(["scope", "period", "filters"]);
    expect(sections[0]?.fields.map((field) => field.key)).toEqual(["merchantId", "applicationId"]);
    expect(sections[1]?.fields.map((field) => field.key)).toEqual(["period"]);
    expect(sections[2]?.fields.map((field) => field.key)).toEqual(["status", "currency"]);
  });

  test("omits hidden scope inputs and empty sections", () => {
    const sections = groupReportInputs(
      spec([
        input("merchantId", "entity_autocomplete", "merchants"),
        input("status", "enum"),
      ]),
      ["merchantId"],
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe("filters");
    expect(sections[0]?.fields.map((field) => field.key)).toEqual(["status"]);
  });

  test("returns no sections for an empty report", () => {
    expect(groupReportInputs(spec([]))).toEqual([]);
  });
});
