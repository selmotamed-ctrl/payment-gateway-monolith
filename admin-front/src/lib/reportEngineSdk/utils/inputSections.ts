import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";

export type ReportInputSectionId = "scope" | "period" | "filters";

export interface ReportInputSection {
  id: ReportInputSectionId;
  titleKey: string;
  descriptionKey: string;
  fields: ReportInputFieldSpec[];
}

const SCOPE_AUTOCOMPLETE_SOURCES = new Set([
  "merchants",
  "applications",
  "payment_links",
  "pos_terminals",
]);

const PERIOD_TYPES = new Set(["date", "datetime", "daterange"]);

export const REPORT_INPUT_SECTIONS: Readonly<
  Record<ReportInputSectionId, { titleKey: string; descriptionKey: string }>
> = {
  scope: {
    titleKey: "Report scope",
    descriptionKey: "Choose the record this report is generated for, such as a merchant, application, payment link or terminal.",
  },
  period: {
    titleKey: "Reporting period",
    descriptionKey: "Set the dates that bound the report data.",
  },
  filters: {
    titleKey: "Filters and options",
    descriptionKey: "Narrow the result with the available filters and parameters.",
  },
};

const sectionFor = (field: ReportInputFieldSpec): ReportInputSectionId => {
  if (
    (field.type === "entity_autocomplete" || field.type === "entity_multi_autocomplete") &&
    field.autocomplete &&
    SCOPE_AUTOCOMPLETE_SOURCES.has(field.autocomplete.source)
  ) {
    return "scope";
  }
  if (PERIOD_TYPES.has(field.type)) return "period";
  return "filters";
};

/**
 * Groups report inputs into the run-form sections in a stable order:
 * scope, period, then filters/options. Hidden inputs (for example the merchant
 * scope input on the merchant runner) are removed before grouping; empty
 * sections are omitted so a report never shows an empty heading.
 */
export function groupReportInputs(
  spec: Pick<ReportDescriptorSpec, "inputs">,
  hiddenInputKeys: readonly string[] = [],
): ReportInputSection[] {
  const hidden = new Set(hiddenInputKeys);
  const buckets: Record<ReportInputSectionId, ReportInputFieldSpec[]> = {
    scope: [],
    period: [],
    filters: [],
  };
  for (const field of spec.inputs) {
    if (hidden.has(field.key)) continue;
    buckets[sectionFor(field)].push(field);
  }
  return (["scope", "period", "filters"] as const)
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({
      id,
      titleKey: REPORT_INPUT_SECTIONS[id].titleKey,
      descriptionKey: REPORT_INPUT_SECTIONS[id].descriptionKey,
      fields: buckets[id],
    }));
}
