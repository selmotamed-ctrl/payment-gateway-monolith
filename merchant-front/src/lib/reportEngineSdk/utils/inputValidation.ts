import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

export interface ReportInputValidation {
  valid: boolean;
  errors: Record<string, string>;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

const english: Translate = (key, params) =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), key);

/**
 * Client-side mirror of the server input schema (C10). It is advisory for the
 * user experience; core still compiles the real Zod schema and rejects bad
 * values.
 */
export function validateReportInputs(
  spec: ReportDescriptorSpec,
  values: Record<string, unknown>,
  translate: Translate = english,
): ReportInputValidation {
  const t = translate;
  const errors: Record<string, string> = {};
  const check = (field: ReportInputFieldSpec, message: string) => {
    errors[field.key] = message;
  };

  for (const field of spec.inputs) {
    const value = values[field.key];
    if (isEmpty(value)) {
      if (field.required) check(field, t("This field is required"));
      continue;
    }
    const validation = field.validation;
    switch (field.type) {
      case "number":
      case "integer":
      case "amount_minor": {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          check(field, t("Enter a valid number"));
          break;
        }
        if (field.type !== "number" && !Number.isInteger(numeric)) {
          check(field, t("Enter a whole number"));
          break;
        }
        if (validation?.min !== undefined && numeric < validation.min) {
          check(field, t("Minimum is {min}", { min: validation.min }));
        } else if (validation?.max !== undefined && numeric > validation.max) {
          check(field, t("Maximum is {max}", { max: validation.max }));
        }
        break;
      }
      case "string": {
        const text = String(value);
        if (validation?.min_length !== undefined && text.length < validation.min_length) {
          check(field, t("Minimum length is {min}", { min: validation.min_length }));
        } else if (validation?.max_length !== undefined && text.length > validation.max_length) {
          check(field, t("Maximum length is {max}", { max: validation.max_length }));
        } else if (validation?.regex) {
          try {
            if (!new RegExp(validation.regex).test(text)) check(field, t("The value has an invalid format"));
          } catch {
            // The server reports an invalid regex; do not mask it here.
          }
        }
        break;
      }
      case "uuid":
      case "entity_autocomplete": {
        if (field.autocomplete?.source !== "currencies" && !UUID_RE.test(String(value))) {
          check(field, t("Choose a valid record"));
        }
        break;
      }
      case "entity_multi_autocomplete": {
        const list = Array.isArray(value) ? value : [];
        if (field.autocomplete?.source !== "currencies" && list.some((item) => !UUID_RE.test(String(item)))) {
          check(field, t("Choose only valid records"));
        }
        break;
      }
      case "enum":
      case "multi_enum": {
        const list = Array.isArray(value) ? value : [value];
        const allowed = new Set(validation?.enum_values ?? []);
        if (allowed.size > 0 && list.some((item) => !allowed.has(String(item)))) {
          check(field, t("Choose one of the listed values"));
        }
        break;
      }
      case "daterange": {
        const range = value as { start?: string; end?: string };
        const start = Date.parse(String(range.start ?? ""));
        const end = Date.parse(String(range.end ?? ""));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
          check(field, t("Choose a valid date range"));
        } else if (validation?.max_range_days !== undefined) {
          const days = (end - start) / (24 * 3600 * 1000);
          if (days > validation.max_range_days) {
            check(field, t("The range cannot exceed {days} days", { days: validation.max_range_days }));
          }
        }
        break;
      }
      case "datetime": {
        if (!Number.isFinite(Date.parse(String(value)))) check(field, t("Choose a valid date and time"));
        break;
      }
      case "date": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) check(field, t("Choose a valid date"));
        break;
      }
      case "boolean":
        break;
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
