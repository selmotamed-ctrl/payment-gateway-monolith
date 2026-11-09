import type { ReportChromeSpec } from "../types/chromeSpec";
import type { ReportDescriptorSpec, ReportSectionSpec } from "../types/reportSpec";
import type { ReportExecutionBundle } from "../types/bundle";
import { renderChartSectionToSvg } from "../components/ReportChartRenderer";
import { renderVectorDrawSectionToSvg } from "../components/ReportVectorDrawRenderer";
import { sanitizeReportHtml } from "../sanitizer/ClientDomSanitizer";

export function formatReportValue(
  value: unknown,
  hint: string,
  currency = "LYD",
  t?: (key: string) => string,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  switch (hint) {
    case "CURRENCY_MINOR":
      return Number.isFinite(numeric)
        ? `${(numeric / 1000).toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${currency}`
        : String(value);
    case "DECIMAL_2":
      return Number.isFinite(numeric) ? numeric.toFixed(2) : String(value);
    case "DECIMAL_4":
      return Number.isFinite(numeric) ? numeric.toFixed(4) : String(value);
    case "PERCENT_BPS":
      return Number.isFinite(numeric) ? `${(numeric / 100).toFixed(2)}%` : String(value);
    case "PERCENT_RATIO":
      return Number.isFinite(numeric) ? `${numeric.toFixed(2)}%` : String(value);
    case "INTEGER":
      return Number.isFinite(numeric) ? String(Math.round(numeric)) : String(value);
    case "DATE_ISO":
      return String(value).slice(0, 10);
    case "DATETIME_ISO":
      return String(value).replace("T", " ").slice(0, 19);
    case "ENUM_TRANSLATED":
      return t?.(`enum.${String(value)}`) ?? String(value);
    default:
      return String(value);
  }
}

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const tFor = (spec: ReportDescriptorSpec, locale: string) => (key: string): string =>
  spec.i18n.locales[locale]?.[key] ?? spec.i18n.locales[spec.i18n.default_locale]?.[key] ?? key;

const isVisible = (
  section: ReportSectionSpec,
  spec: ReportDescriptorSpec,
  datasets: Record<string, Array<Record<string, unknown>>>,
  inputs: Record<string, unknown>,
): boolean => {
  const visibility = (section as { visibility?: { dataset_id?: string; when?: string; input_key?: string; equals_value?: unknown } }).visibility;
  if (!visibility || visibility.when === "ALWAYS" || !visibility.when) return true;
  if (visibility.when === "DATASET_NOT_EMPTY") {
    return (datasets[visibility.dataset_id ?? ""] ?? []).length > 0;
  }
  if (visibility.when === "DATASET_EMPTY") {
    return (datasets[visibility.dataset_id ?? ""] ?? []).length === 0;
  }
  if (visibility.when === "INPUT_EQUALS") {
    return String(inputs[visibility.input_key ?? ""]) === String(visibility.equals_value);
  }
  return true;
};

const summaryValue = (
  rows: Array<Record<string, unknown>>,
  field: string,
  kind: string,
): string | null => {
  if (kind === "NONE" || kind === "LABEL_TOTAL") return kind === "LABEL_TOTAL" ? "Total" : null;
  const values = rows.map((row) => Number(row[field] ?? 0)).filter((value) => Number.isFinite(value));
  if (values.length === 0) return "0";
  switch (kind) {
    case "SUM":
      return String(values.reduce((sum, value) => sum + value, 0));
    case "AVG":
      return String(values.reduce((sum, value) => sum + value, 0) / values.length);
    case "COUNT":
      return String(values.length);
    case "MIN":
      return String(Math.min(...values));
    case "MAX":
      return String(Math.max(...values));
    default:
      return null;
  }
};

export function renderReportSectionsToHtml(params: {
  bundle: ReportExecutionBundle;
  locale: string;
  t?: (key: string) => string;
}): string {
  const { bundle, locale } = params;
  const spec = bundle.spec;
  const t = params.t ?? tFor(spec, locale);
  const isRtl = locale === "ar" || locale.startsWith("ar-");
  const currency = hostCurrency(spec);

  return spec.sections
    .filter((section) => isVisible(section, spec, bundle.datasets, bundle.inputsUsed))
    .map((section) => {
      switch (section.section_type) {
        case "KPI_GRID": {
          const cards = section.cards
            .map((card) => {
              const row = (bundle.datasets[card.dataset_id] ?? [])[card.row_index] ?? {};
              const value = formatReportValue(row[card.value_field], card.format_hint, currency, t);
              const delta = card.delta_field
                ? formatReportValue(row[card.delta_field], card.format_hint, currency, t)
                : null;
              return `<div class="report-kpi-card report-tone-${card.tone.toLowerCase()}">
                <div class="report-kpi-label">${escapeHtml(t(card.label_i18n_key))}</div>
                <div class="report-kpi-value">${escapeHtml(value)}</div>
                ${delta ? `<div class="report-kpi-delta">${escapeHtml(delta)}</div>` : ""}
              </div>`;
            })
            .join("");
          return `<section class="report-section report-kpi-section">
            ${section.title_i18n_key ? `<h3>${escapeHtml(t(section.title_i18n_key))}</h3>` : ""}
            <div class="report-kpi-grid" style="grid-template-columns:repeat(${section.columns},minmax(0,1fr))">${cards}</div>
          </section>`;
        }

        case "DATA_TABLE": {
          const rows = bundle.datasets[section.dataset_id] ?? [];
          const head = section.columns
            .map((col) => `<th style="text-align:${col.align.toLowerCase()}">${escapeHtml(t(col.header_i18n_key))}</th>`)
            .join("");
          const body = rows
            .map(
              (row) =>
                `<tr>${section.columns
                  .map((col) => {
                    const raw = row[col.field];
                    const value =
                      col.format_hint === "BADGE"
                        ? `<span class="report-badge report-badge-${escapeHtml(String(raw).toLowerCase())}">${escapeHtml(raw)}</span>`
                        : escapeHtml(formatReportValue(raw, col.format_hint, currency));
                    return `<td style="text-align:${col.align.toLowerCase()}">${value}</td>`;
                  })
                  .join("")}</tr>`,
            )
            .join("");
          const foot = section.columns
            .map((col) => {
              const summary = summaryValue(rows, col.field, col.summary_footer);
              return `<td style="text-align:${col.align.toLowerCase()}">${escapeHtml(summary ?? "")}</td>`;
            })
            .join("");
          return `<section class="report-section">
            ${section.title_i18n_key ? `<h3>${escapeHtml(t(section.title_i18n_key))}</h3>` : ""}
            ${section.subtitle_i18n_key ? `<p class="report-section-subtitle">${escapeHtml(t(section.subtitle_i18n_key))}</p>` : ""}
            <table class="report-data-table${section.zebra_striping ? " report-zebra" : ""}${section.repeat_header_on_page_break ? "" : " report-no-repeat-header"}">
              <thead><tr>${head}</tr></thead>
              <tbody>${body || `<tr><td colspan="${section.columns.length}">—</td></tr>`}</tbody>
              <tfoot><tr>${foot}</tr></tfoot>
            </table>
          </section>`;
        }

        case "CHART": {
          const svg = renderChartSectionToSvg({ section, datasets: bundle.datasets, t, isRtl });
          return `<section class="report-section report-chart-box">
            ${section.title_i18n_key ? `<h3>${escapeHtml(t(section.title_i18n_key))}</h3>` : ""}
            ${section.subtitle_i18n_key ? `<p class="report-section-subtitle">${escapeHtml(t(section.subtitle_i18n_key))}</p>` : ""}
            <div style="width:${section.width_percent}%">${svg}</div>
          </section>`;
        }

        case "VECTOR_DRAW": {
          const svg = renderVectorDrawSectionToSvg({
            section,
            datasets: bundle.datasets,
            t,
            formatValue: (value, hint) => formatReportValue(value, hint, currency, t),
            isRtl,
          });
          return `<section class="report-section report-draw-box">
            ${section.title_i18n_key ? `<h3>${escapeHtml(t(section.title_i18n_key))}</h3>` : ""}
            ${svg}
          </section>`;
        }

        case "HTML_TEMPLATE": {
          const html = section.html_template
            .replace(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => escapeHtml(t(key)))
            .replace(/asset:\/\/([a-zA-Z0-9_-]+)/g, (_m, key: string) => bundle.assetDataUrls[key] ?? "");
          return `<section class="report-section">
            ${section.title_i18n_key ? `<h3>${escapeHtml(t(section.title_i18n_key))}</h3>` : ""}
            ${sanitizeReportHtml(html)}
            ${section.scoped_css ? `<style>${section.scoped_css}</style>` : ""}
          </section>`;
        }

        case "IMAGE_BANNER": {
          const src = bundle.assetDataUrls[section.asset_key];
          return `<section class="report-section" style="text-align:${section.align.toLowerCase()}">
            ${section.caption_i18n_key ? `<h3>${escapeHtml(t(section.caption_i18n_key))}</h3>` : ""}
            ${src ? `<img src="${src}" alt="${escapeHtml(section.asset_key)}" style="max-height:${section.max_height_mm}mm;max-width:100%" />` : ""}
          </section>`;
        }

        case "PAGE_BREAK":
          return `<div class="report-page-break${section.orientation_after ? ` report-orientation-${section.orientation_after.toLowerCase()}` : ""}"></div>`;
      }
    })
    .join("\n");
}

export function renderChromeHtml(params: {
  chrome: ReportChromeSpec | null;
  bundle: ReportExecutionBundle;
  locale: string;
  t?: (key: string) => string;
}): string {
  const { chrome, bundle, locale } = params;
  if (!chrome) return "";
  const spec = bundle.spec;
  const t = params.t ?? ((key: string) => chrome.i18n.locales[locale]?.[key] ?? chrome.i18n.locales[chrome.i18n.default_locale]?.[key] ?? spec.i18n.locales[locale]?.[key] ?? key);
  const specT = (key: string): string =>
    spec.i18n.locales[locale]?.[key] ??
    spec.i18n.locales[spec.i18n.default_locale]?.[key] ??
    key;
  const variables: Record<string, string> = {
    institutionName: bundle.institutionName ?? "Libyan National Payment Gateway",
    reportTitle: specT("report.title"),
    reportSubtitle: specT("report.subtitle"),
    reportCode: spec.report.code,
    reportVersion: String(spec.report.version),
    generatedAtIso: bundle.executedAtIso,
    generatedAtFormatted: bundle.executedAtIso.replace("T", " ").slice(0, 19),
    actorName: bundle.actor.name,
    actorEmail: bundle.actor.email,
    actorRole: bundle.actor.role,
    selectedLocale: locale,
    classificationBadge: spec.report.classification,
    verificationHashShort: bundle.verificationSha256.slice(0, 12),
    ...(bundle.chromeVariables ?? {}),
  };
  let html = chrome.template.html;
  html = html.replace(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => escapeHtml(t(key)));
  html = html.replace(/\{\{\s*pageNumber\s*\}\}/g, '<span class="report-page-number"></span>');
  html = html.replace(/\{\{\s*totalPages\s*\}\}/g, '<span class="report-total-pages"></span>');
  for (const [key, value] of Object.entries(variables)) {
    html = html.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), escapeHtml(value));
  }
  html = html.replace(/asset:\/\/([a-zA-Z0-9_-]+)/g, (_m, key: string) => bundle.assetDataUrls[key] ?? "");
  const borderClass = chrome.chrome.border_style === "NONE"
    ? ""
    : ` report-chrome-border-${chrome.chrome.border_style.toLowerCase().replaceAll("_", "-")}`;
  return `<div class="report-chrome report-chrome-${chrome.chrome.chrome_type.toLowerCase()}${borderClass}" style="min-height:${chrome.chrome.height_mm}mm">${sanitizeReportHtml(html)}</div>`;
}

function hostCurrency(spec: ReportDescriptorSpec): string {
  void spec;
  return "LYD";
}
