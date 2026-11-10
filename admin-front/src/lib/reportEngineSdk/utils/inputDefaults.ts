import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";

const startOfDayUtc = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day, 0, 0, 0, 0)).toISOString();
const endOfDayUtc = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day, 23, 59, 59, 999)).toISOString();

export function resolvePreset(field: ReportInputFieldSpec, now = new Date()): unknown {
  const def = field.default_value;
  if (!def || typeof def !== "object" || Array.isArray(def) || !("preset" in def)) {
    return def;
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (def.preset) {
    case "TODAY":
      return field.type === "daterange"
        ? { start: startOfDayUtc(y, m, d), end: endOfDayUtc(y, m, d) }
        : startOfDayUtc(y, m, d).slice(0, 10);
    case "YESTERDAY":
      return field.type === "daterange"
        ? { start: startOfDayUtc(y, m, d - 1), end: endOfDayUtc(y, m, d - 1) }
        : startOfDayUtc(y, m, d - 1).slice(0, 10);
    case "LAST_7_DAYS":
      return { start: startOfDayUtc(y, m, d - 6), end: endOfDayUtc(y, m, d) };
    case "LAST_30_DAYS":
      return { start: startOfDayUtc(y, m, d - 29), end: endOfDayUtc(y, m, d) };
    case "CURRENT_MONTH":
      return { start: startOfDayUtc(y, m, 1), end: endOfDayUtc(y, m, d) };
    case "PREVIOUS_MONTH":
      return { start: startOfDayUtc(y, m - 1, 1), end: endOfDayUtc(y, m, 0) };
  }
}

export function resolveInputDefaults(spec: ReportDescriptorSpec): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of spec.inputs) {
    const value = resolvePreset(field);
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}
