import { z } from "zod";
import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRangeValue {
  start: string;
  end: string;
}

export function resolveInputPresetValue(
  field: ReportInputFieldSpec,
  now: Date = new Date(),
): unknown {
  const def = field.default_value;
  if (!def || typeof def !== "object" || Array.isArray(def) || !("preset" in def)) {
    return def;
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const startOfDayUtc = (year: number, month: number, day: number) =>
    new Date(Date.UTC(year, month, day, 0, 0, 0, 0)).toISOString();
  const endOfDayUtc = (year: number, month: number, day: number) =>
    new Date(Date.UTC(year, month, day, 23, 59, 59, 999)).toISOString();

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

export function compileInputFieldToZod(field: ReportInputFieldSpec): z.ZodTypeAny {
  const v = field.validation;
  let schema: z.ZodTypeAny;

  switch (field.type) {
    case "string": {
      let s = z.string().trim();
      if (v?.min_length !== undefined) s = s.min(v.min_length);
      if (v?.max_length !== undefined) s = s.max(v.max_length);
      if (v?.regex) s = s.regex(new RegExp(v.regex));
      schema = s;
      break;
    }
    case "uuid":
    case "entity_autocomplete": {
      const isUuid = !field.autocomplete || field.autocomplete.source !== "currencies";
      schema = isUuid
        ? z.string().trim().regex(UUID_REGEX, `Field "${field.key}" must be a valid UUID`)
        : z.string().trim().min(1).max(64);
      break;
    }
    case "entity_multi_autocomplete": {
      const itemSchema =
        field.autocomplete?.source === "currencies"
          ? z.string().trim().min(1).max(64)
          : z.string().trim().regex(UUID_REGEX, `Field "${field.key}" items must be valid UUIDs`);
      schema = z.array(itemSchema).min(field.required ? 1 : 0).max(50);
      break;
    }
    case "number": {
      let n = z.coerce.number().finite();
      if (v?.min !== undefined) n = n.min(v.min);
      if (v?.max !== undefined) n = n.max(v.max);
      schema = n;
      break;
    }
    case "integer":
    case "amount_minor": {
      let n = z.coerce.number().int();
      if (v?.min !== undefined) n = n.min(v.min);
      if (v?.max !== undefined) n = n.max(v.max);
      schema = n;
      break;
    }
    case "boolean": {
      schema = z.boolean();
      break;
    }
    case "date": {
      schema = z.string().regex(ISO_DATE_REGEX, `Field "${field.key}" must be YYYY-MM-DD`);
      break;
    }
    case "datetime": {
      schema = z.string().datetime({ message: `Field "${field.key}" must be an ISO-8601 UTC datetime` });
      break;
    }
    case "daterange": {
      const maxDays = v?.max_range_days ?? 366;
      schema = z
        .object({
          start: z.string().min(10),
          end: z.string().min(10),
        })
        .refine(
          (range) => {
            const startMs = Date.parse(range.start);
            const endMs = Date.parse(range.end);
            return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
          },
          { message: `Field "${field.key}" must have a valid start and end date where end >= start.` },
        )
        .refine(
          (range) => {
            const startMs = Date.parse(range.start);
            const endMs = Date.parse(range.end);
            const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
            return diffDays <= maxDays;
          },
          { message: `Date range for "${field.key}" cannot exceed ${maxDays} days (partition safety limit).` },
        );
      break;
    }
    case "enum": {
      const allowed = v?.enum_values && v.enum_values.length > 0 ? v.enum_values : ["DEFAULT"];
      schema = z.enum(allowed as [string, ...string[]]);
      break;
    }
    case "multi_enum": {
      const allowed = v?.enum_values && v.enum_values.length > 0 ? v.enum_values : ["DEFAULT"];
      const itemSchema = z.enum(allowed as [string, ...string[]]);
      schema = z.array(itemSchema).min(field.required ? 1 : 0);
      break;
    }
  }

  if (!field.required) {
    schema = schema.optional().nullable();
  }
  return schema;
}

export function compileReportInputsToZodObject(
  spec: ReportDescriptorSpec,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of spec.inputs) {
    shape[field.key] = compileInputFieldToZod(field);
  }
  return z.object(shape).strict();
}

export function resolveInputDefaults(
  spec: ReportDescriptorSpec,
  now: Date = new Date(),
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of spec.inputs) {
    const resolved = resolveInputPresetValue(field, now);
    if (resolved !== undefined) {
      values[field.key] = resolved;
    }
  }
  return values;
}
