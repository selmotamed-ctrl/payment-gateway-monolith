import { ReportDescriptorSpecSchema, type ReportDescriptorSpec } from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";

export function validateSpecStructureAndI18n(rawSpec: unknown): {
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
    }
  }

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
