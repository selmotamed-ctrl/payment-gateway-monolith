import { ReportDescriptorSpecSchema, type ReportDescriptorSpec } from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";
import type { ReportEngineHostConfig } from "../types/hostConfig";
import {
  compileInputFieldToZod,
  resolveInputPresetValue,
} from "../compiler/InputFormZodCompiler";

const RANGE_PRESETS = new Set([
  "LAST_7_DAYS",
  "LAST_30_DAYS",
  "CURRENT_MONTH",
  "PREVIOUS_MONTH",
]);

/**
 * Layer 1 input-definition vetting (A15): regexes must compile, resolved
 * defaults must satisfy the compiled field schema, enum literals must exist on
 * the database enum the input filters, and range presets are daterange-only.
 */
function validateInputDefinitions(
  spec: ReportDescriptorSpec,
  host: ReportEngineHostConfig | undefined,
  diagnostics: ReportDiagnostic[],
): void {
  const boundEnumColumns = new Map<string, Set<string>>();
  if (host) {
    const noteColumn = (inputKey: string, modelName: string | undefined, columnName: string): void => {
      if (!modelName) return;
      const column = host.models[modelName]?.columns[columnName];
      if (!column?.enumName) return;
      const set = boundEnumColumns.get(inputKey) ?? new Set<string>();
      set.add(column.enumName);
      boundEnumColumns.set(inputKey, set);
    };
    for (const ds of spec.datasets) {
      const modelForAlias = (alias: string | undefined): string | undefined => {
        const resolved = alias ?? ds.from_alias;
        if (resolved === ds.from_alias) return ds.from_model;
        return ds.joins.find((join) => join.alias === resolved)?.target_model;
      };
      const visit = (node: NonNullable<typeof ds.where> | undefined): void => {
        if (!node) return;
        if (node.kind === "GROUP") {
          node.conditions.forEach(visit);
          return;
        }
        if (node.binding?.source === "INPUT") {
          noteColumn(node.binding.input_key, modelForAlias(node.table_alias), node.column);
        }
      };
      visit(ds.where);
      ds.joins.forEach((join) => visit(join.additional_on));
    }
  }

  for (let i = 0; i < spec.inputs.length; i++) {
    const field = spec.inputs[i]!;
    const path = `inputs[${i}](${field.key})`;

    if (field.validation?.regex) {
      if (field.validation.regex.length > 256) {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: `${path}.validation.regex`,
          code: "INPUT_REGEX_INVALID",
          message: `Input "${field.key}" regex exceeds the 256-character limit.`,
          aiFixHint: "Use a shorter, simpler regular expression.",
        });
      } else {
        try {
          new RegExp(field.validation.regex);
        } catch (error) {
          diagnostics.push({
            layer: 1,
            severity: "error",
            path: `${path}.validation.regex`,
            code: "INPUT_REGEX_INVALID",
            message: `Input "${field.key}" regex does not compile: ${(error as Error).message}`,
            aiFixHint: "Return a valid JavaScript regular expression.",
          });
        }
      }
    }

    const rawDefault =
      field.default_value && typeof field.default_value === "object" && !Array.isArray(field.default_value) &&
      "preset" in (field.default_value as Record<string, unknown>)
        ? (field.default_value as { preset: string }).preset
        : null;
    if (rawDefault && RANGE_PRESETS.has(rawDefault) && field.type !== "daterange") {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: `${path}.default_value`,
        code: "INPUT_PRESET_TYPE_MISMATCH",
        message: `Range preset "${rawDefault}" is only valid on a daterange input; "${field.key}" is ${field.type}.`,
        aiFixHint: 'Use a "daterange" input, a literal scalar default, or the TODAY/YESTERDAY preset on single-date fields.',
      });
    }

    try {
      const fieldSchema = compileInputFieldToZod(field);
      const resolvedDefault = resolveInputPresetValue(field);
      if (resolvedDefault !== undefined) {
        const parsed = fieldSchema.safeParse(resolvedDefault);
        if (!parsed.success) {
          diagnostics.push({
            layer: 1,
            severity: "error",
            path: `${path}.default_value`,
            code: "INPUT_DEFAULT_INVALID",
            message: `Default value for input "${field.key}" does not satisfy its own validation: ${parsed.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
            aiFixHint: "Make the default value match the input type and validation rules.",
          });
        }
      }
    } catch (error) {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path,
        code: "INPUT_DEFINITION_INVALID",
        message: `Input "${field.key}" could not be compiled: ${(error as Error).message}`,
        aiFixHint: "Fix the input type and validation values.",
      });
    }

    const enumValues = field.validation?.enum_values ?? [];
    if (field.type === "enum" || field.type === "multi_enum") {
      const defaultLiteral =
        field.default_value && typeof field.default_value === "object" && !Array.isArray(field.default_value) &&
        "literal" in (field.default_value as Record<string, unknown>)
          ? (field.default_value as { literal: unknown }).literal
          : field.default_value;
      const defaults = Array.isArray(defaultLiteral) ? defaultLiteral : [defaultLiteral];
      for (const value of defaults) {
        if (typeof value === "string" && enumValues.length > 0 && !enumValues.includes(value)) {
          diagnostics.push({
            layer: 1,
            severity: "error",
            path: `${path}.default_value`,
            code: "INPUT_ENUM_LITERAL_UNKNOWN",
            message: `Default value "${value}" is not one of the declared enum_values for input "${field.key}".`,
            aiFixHint: "Use one of validation.enum_values as the default.",
          });
        }
      }
      if (host) {
        for (const enumName of boundEnumColumns.get(field.key) ?? []) {
          const allowed = new Set(host.enums[enumName] ?? []);
          if (allowed.size === 0) continue;
          for (const value of [...enumValues, ...defaults.filter((v): v is string => typeof v === "string")]) {
            if (!allowed.has(value)) {
              diagnostics.push({
                layer: 1,
                severity: "error",
                path: `${path}`,
                code: "INPUT_ENUM_LITERAL_UNKNOWN",
                message: `Enum literal "${value}" is not a ${enumName} value in the database catalog.`,
                aiFixHint: `Use one of: ${[...allowed].join(", ")}.`,
              });
            }
          }
        }
      }
    }
  }
}

export function validateSpecStructureAndI18n(
  rawSpec: unknown,
  host?: ReportEngineHostConfig,
): {
  spec: ReportDescriptorSpec | null;
  diagnostics: ReportDiagnostic[];
} {
  const diagnostics: ReportDiagnostic[] = [];
  const parsed = ReportDescriptorSpecSchema.safeParse(rawSpec);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pathStr = issue.path.join(".") || "<root>";
      const isMissingAr = pathStr.startsWith("i18n.locales") && issue.message.includes("'ar'");
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: pathStr,
        code: isMissingAr ? "MISSING_DEFAULT_LOCALE_AR" : "SCHEMA_VALIDATION_ERROR",
        message: issue.message,
        aiFixHint: isMissingAr
          ? "Populate both i18n.locales.en (English) and i18n.locales.ar (Arabic) dictionaries in the spec."
          : `Fix field "${pathStr}" to satisfy the ReportDescriptorSpec v1.0 schema (${issue.message}).`,
      });
    }
    return { spec: null, diagnostics };
  }

  const spec = parsed.data;
  const declaredLocales = Object.keys(spec.i18n.locales);

  const referencedKeys: Array<{ key: string; path: string }> = [];
  for (let i = 0; i < spec.inputs.length; i++) {
    const inp = spec.inputs[i]!;
    referencedKeys.push({ key: inp.label_i18n_key, path: `inputs[${i}].label_i18n_key` });
    if (inp.help_i18n_key) referencedKeys.push({ key: inp.help_i18n_key, path: `inputs[${i}].help_i18n_key` });
    if (inp.placeholder_i18n_key) {
      referencedKeys.push({ key: inp.placeholder_i18n_key, path: `inputs[${i}].placeholder_i18n_key` });
    }
  }

  for (let i = 0; i < spec.sections.length; i++) {
    const sec = spec.sections[i]!;
    const sPath = `sections[${i}](${sec.section_id})`;
    if ("title_i18n_key" in sec && sec.title_i18n_key) {
      referencedKeys.push({ key: sec.title_i18n_key, path: `${sPath}.title_i18n_key` });
    }
    if ("subtitle_i18n_key" in sec && sec.subtitle_i18n_key) {
      referencedKeys.push({ key: sec.subtitle_i18n_key, path: `${sPath}.subtitle_i18n_key` });
    }
    if (sec.section_type === "KPI_GRID") {
      sec.cards.forEach((c, cIdx) =>
        referencedKeys.push({ key: c.label_i18n_key, path: `${sPath}.cards[${cIdx}].label_i18n_key` }),
      );
    } else if (sec.section_type === "DATA_TABLE") {
      sec.columns.forEach((col, cIdx) =>
        referencedKeys.push({ key: col.header_i18n_key, path: `${sPath}.columns[${cIdx}].header_i18n_key` }),
      );
    } else if (sec.section_type === "CHART") {
      if (sec.x_label_i18n_key) referencedKeys.push({ key: sec.x_label_i18n_key, path: `${sPath}.x_label_i18n_key` });
      sec.series.forEach((ser, sIdx) =>
        referencedKeys.push({ key: ser.label_i18n_key, path: `${sPath}.series[${sIdx}].label_i18n_key` }),
      );
    } else if (sec.section_type === "VECTOR_DRAW") {
      sec.nodes.forEach((n, nIdx) =>
        referencedKeys.push({ key: n.label_i18n_key, path: `${sPath}.nodes[${nIdx}].label_i18n_key` }),
      );
      sec.edges.forEach((e, eIdx) => {
        if (e.label_i18n_key) {
          referencedKeys.push({ key: e.label_i18n_key, path: `${sPath}.edges[${eIdx}].label_i18n_key` });
        }
      });
    } else if (sec.section_type === "HTML_TEMPLATE") {
      const tokenMatches = sec.html_template.matchAll(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g);
      for (const m of tokenMatches) {
        if (m[1]) referencedKeys.push({ key: m[1], path: `${sPath}.html_template` });
      }
    } else if (sec.section_type === "IMAGE_BANNER") {
      if (sec.caption_i18n_key) {
        referencedKeys.push({ key: sec.caption_i18n_key, path: `${sPath}.caption_i18n_key` });
      }
    }
  }

  validateInputDefinitions(spec, host, diagnostics);

  for (const ref of referencedKeys) {
    for (const locale of declaredLocales) {
      const dict = spec.i18n.locales[locale] ?? {};
      const val = dict[ref.key];
      if (typeof val !== "string" || val.trim() === "") {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: `i18n.locales.${locale}["${ref.key}"]`,
          code: "MISSING_I18N_KEY_FOR_LOCALE",
          message: `Translation key "${ref.key}" (referenced at ${ref.path}) is missing or empty in locale "${locale}".`,
          aiFixHint: `Add a non-empty translation for "${ref.key}" inside i18n.locales.${locale}.`,
        });
      }
    }
  }

  return { spec, diagnostics };
}

import {
  ReportChromeSpecSchema,
  type ReportChromeSpec,
} from "../types/chromeSpec";

export function validateChromeSpecStructureAndI18n(rawSpec: unknown): {
  spec: ReportChromeSpec | null;
  diagnostics: ReportDiagnostic[];
} {
  const diagnostics: ReportDiagnostic[] = [];
  const parsed = ReportChromeSpecSchema.safeParse(rawSpec);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pathStr = issue.path.join(".") || "<root>";
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: pathStr,
        code: "CHROME_SCHEMA_VALIDATION_ERROR",
        message: issue.message,
        aiFixHint: `Fix field "${pathStr}" to satisfy the ReportChromeSpec v1.0 schema.`,
      });
    }
    return { spec: null, diagnostics };
  }

  const spec = parsed.data;
  const locales = Object.keys(spec.i18n.locales);
  const referencedKeys: Array<{ key: string; path: string }> = [];
  spec.required_assets.forEach((asset, index) =>
    referencedKeys.push({
      key: asset.alt_i18n_key,
      path: `required_assets[${index}].alt_i18n_key`,
    }),
  );
  for (const match of spec.template.html.matchAll(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    if (match[1]) referencedKeys.push({ key: match[1], path: "template.html" });
  }
  for (const ref of referencedKeys) {
    for (const locale of locales) {
      const value = spec.i18n.locales[locale]?.[ref.key];
      if (typeof value !== "string" || value.trim() === "") {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: `i18n.locales.${locale}["${ref.key}"]`,
          code: "MISSING_I18N_KEY_FOR_LOCALE",
          message: `Chrome translation key "${ref.key}" (referenced at ${ref.path}) is missing or empty in locale "${locale}".`,
          aiFixHint: `Add a non-empty translation for "${ref.key}" inside i18n.locales.${locale}.`,
        });
      }
    }
  }

  return { spec, diagnostics };
}
