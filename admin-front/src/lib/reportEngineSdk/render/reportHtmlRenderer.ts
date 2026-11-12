import Decimal from "decimal.js";
import type { ReportChromeSpec } from "../types/chromeSpec";
import type { ReportDescriptorSpec, ReportSectionSpec } from "../types/reportSpec";
import type { ReportExecutionBundle } from "../types/bundle";
import { CHART_PALETTE, renderChartSectionToSvg } from "../components/ReportChartRenderer";
import { renderVectorDrawSectionToSvg } from "../components/ReportVectorDrawRenderer";
import { sanitizeReportCss, sanitizeReportHtml } from "../sanitizer/ClientDomSanitizer";
import {
  DEFAULT_MINOR_UNIT_DECIMALS,
  DEFAULT_REPORT_CURRENCY,
  formatDecimal,
  minorToMajor,
  toDecimal,
} from "../utils/decimalFormat";

type Row = Record<string, unknown>;
type Translate = (key: string) => string;

/**
 * Formats one report value. Money never goes through a JS float: CURRENCY_MINOR values are scaled from minor
 * units with decimal.js and printed with the host's 3 decimals and thousands separators.
 */
export function formatReportValue(
  value: unknown,
  hint: string,
  currency: string = DEFAULT_REPORT_CURRENCY,
  t?: Translate,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const decimal = toDecimal(value);
  switch (hint) {
    case "CURRENCY_MINOR":
      return decimal ? `${formatDecimal(minorToMajor(decimal), DEFAULT_MINOR_UNIT_DECIMALS)} ${currency}` : String(value);
    case "DECIMAL_2":
      return decimal ? formatDecimal(decimal, 2) : String(value);
    case "DECIMAL_4":
      return decimal ? formatDecimal(decimal, 4) : String(value);
    case "PERCENT_BPS":
      return decimal ? `${formatDecimal(decimal.div(100), 2)}%` : String(value);
    case "PERCENT_RATIO":
      return decimal ? `${formatDecimal(decimal, 2)}%` : String(value);
    case "INTEGER":
      return decimal ? formatDecimal(decimal, 0) : String(value);
    case "DATE_ISO":
      return String(value).slice(0, 10);
    case "DATETIME_ISO":
      return String(value).replace("T", " ").slice(0, 19);
    case "ENUM_TRANSLATED": {
      const key = `enum.${String(value)}`;
      const translated = t?.(key);
      return translated && translated !== key ? translated : String(value);
    }
    default:
      return String(value);
  }
}

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Engine labels printed inside the report, keyed by the REPORT locale (not the portal UI locale). */
const ENGINE_LABELS: Record<string, Record<string, string>> = {
  en: { total: "Total", noData: "No data" },
  ar: { total: "الإجمالي", noData: "لا توجد بيانات" },
};

const engineLabel = (locale: string, key: "total" | "noData"): string =>
  ENGINE_LABELS[locale]?.[key] ?? ENGINE_LABELS[locale.split("-")[0] ?? ""]?.[key] ?? ENGINE_LABELS.en![key]!;

/** Looks a key up in the spec dictionary for the selected locale, then the default locale. */
export function specLookup(spec: Pick<ReportDescriptorSpec, "i18n">, locale: string, key: string): string | undefined {
  return spec.i18n.locales[locale]?.[key] ?? spec.i18n.locales[spec.i18n.default_locale]?.[key];
}

/** The report translator: the spec's own dictionary, never the portal catalogue (which would print raw keys). */
export const specTranslator = (spec: Pick<ReportDescriptorSpec, "i18n">, locale: string): Translate => (key) =>
  specLookup(spec, locale, key) ?? key;

export const isRtlLocale = (locale: string): boolean => /^(ar|he|fa|ur)(-|$)/i.test(locale);

const logicalAlign = (align: string | undefined): string =>
  align === "END" ? "end" : align === "CENTER" ? "center" : "start";

const isVisible = (section: ReportSectionSpec, datasets: Record<string, Row[]>, inputs: Record<string, unknown>): boolean => {
  const visibility = (section as { visibility?: { dataset_id?: string; when?: string; input_key?: string; equals_value?: unknown } })
    .visibility;
  if (!visibility || visibility.when === "ALWAYS" || !visibility.when) return true;
  if (visibility.when === "DATASET_NOT_EMPTY") return (datasets[visibility.dataset_id ?? ""] ?? []).length > 0;
  if (visibility.when === "DATASET_EMPTY") return (datasets[visibility.dataset_id ?? ""] ?? []).length === 0;
  if (visibility.when === "INPUT_EQUALS") return String(inputs[visibility.input_key ?? ""]) === String(visibility.equals_value);
  return true;
};

const CURRENCY_FIELDS = ["currency", "currency_code", "currencyCode"];
const isCurrencyCode = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);

/** Resolves the currency for a value: the row's own currency column, then a currency input, then bundle meta. */
export function resolveCurrency(bundle: Pick<ReportExecutionBundle, "inputsUsed"> & { currency?: string }, row?: Row): string {
  for (const field of CURRENCY_FIELDS) {
    if (row && isCurrencyCode(row[field])) return row[field] as string;
  }
  for (const field of CURRENCY_FIELDS) {
    const input = bundle.inputsUsed?.[field];
    if (isCurrencyCode(input)) return input;
  }
  if (isCurrencyCode(bundle.currency)) return bundle.currency;
  return DEFAULT_REPORT_CURRENCY;
}

type SummaryKind = "NONE" | "SUM" | "AVG" | "COUNT" | "MIN" | "MAX" | "LABEL_TOTAL";

/**
 * Footer summary for a table column, computed with decimal.js. Null/empty cells are skipped; COUNT counts
 * non-empty cells of any type. The result is formatted with the column's format hint.
 */
export function computeFooterSummary(params: {
  rows: Row[];
  field: string;
  kind: SummaryKind | string;
  formatHint: string;
  currency: string;
  totalLabel: string;
}): string | null {
  const { rows, field, kind, formatHint, currency, totalLabel } = params;
  if (kind === "NONE") return null;
  if (kind === "LABEL_TOTAL") return totalLabel;
  const present = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined && value !== "");
  if (kind === "COUNT") return formatDecimal(new Decimal(present.length), 0);
  const numbers = present.map(toDecimal).filter((value): value is Decimal => value !== null);
  const numericHint = ["CURRENCY_MINOR", "DECIMAL_2", "DECIMAL_4", "PERCENT_BPS", "PERCENT_RATIO", "INTEGER"].includes(formatHint)
    ? formatHint
    : "DECIMAL_2";
  if (numbers.length === 0) return kind === "SUM" ? formatReportValue("0", numericHint, currency) : "—";
  let result: Decimal;
  switch (kind) {
    case "SUM":
      result = Decimal.sum(...numbers);
      break;
    case "AVG":
      result = Decimal.sum(...numbers).div(numbers.length);
      break;
    case "MIN":
      result = Decimal.min(...numbers);
      break;
    case "MAX":
      result = Decimal.max(...numbers);
      break;
    default:
      return null;
  }
  const hint = kind === "AVG" && (numericHint === "INTEGER" || formatHint === "RAW") ? "DECIMAL_2" : numericHint;
  return formatReportValue(result.toFixed(), hint, currency);
}

const BADGE_TONES: Record<string, string> = {
  ACTIVE: "SUCCESS", APPROVED: "SUCCESS", COMPLETED: "SUCCESS", SETTLED: "SUCCESS", SUCCEEDED: "SUCCESS",
  MATCHED: "SUCCESS", PAID: "SUCCESS", POSTED: "SUCCESS", VERIFIED: "SUCCESS",
  PENDING: "WARNING", PENDING_REVIEW: "WARNING", PROCESSING: "INFO", DRAFT: "WARNING", PARTIAL: "WARNING",
  FAILED: "DANGER", REJECTED: "DANGER", DECLINED: "DANGER", CANCELLED: "DANGER", REVERSED: "DANGER",
  SUSPENDED: "DANGER", BLOCKED: "DANGER", DISCREPANT: "DANGER", MISMATCH: "DANGER",
};

type TableColumn = Extract<ReportSectionSpec, { section_type: "DATA_TABLE" }>["columns"][number];

/** Expands pivot wildcard columns (`field: "*"`) into one column per data key not used by an explicit column. */
export function expandTableColumns(
  columns: TableColumn[],
  rows: Row[],
  lookup: (key: string) => string | undefined,
): Array<TableColumn & { header: string }> {
  const explicit = new Set(columns.filter((col) => col.field !== "*").map((col) => col.field));
  const result: Array<TableColumn & { header: string }> = [];
  for (const col of columns) {
    if (col.field !== "*") {
      result.push({ ...col, header: lookup(col.header_i18n_key) ?? col.header_i18n_key });
      continue;
    }
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (explicit.has(key) || seen.has(key) || key.startsWith("_")) continue;
        seen.add(key);
        keys.push(key);
      }
    }
    const share = col.width_percent && keys.length > 0 ? Math.max(1, col.width_percent / keys.length) : undefined;
    for (const key of keys) {
      result.push({
        ...col,
        field: key,
        width_percent: share,
        header: lookup(`${col.header_i18n_key}.${key}`) ?? key.replace(/_/g, " "),
      });
    }
  }
  return result;
}

const PAPER_MM: Record<string, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  LETTER: { width: 215.9, height: 279.4 },
  LEGAL: { width: 215.9, height: 355.6 },
};

/** Width of the page content box in CSS px for the paper size, orientation and side margins. */
export function pageContentWidthPx(spec: ReportDescriptorSpec, orientation: "PORTRAIT" | "LANDSCAPE"): number {
  const paper = PAPER_MM[spec.page_layout.paper_size] ?? PAPER_MM.A4!;
  const widthMm = orientation === "LANDSCAPE" ? paper.height : paper.width;
  const margins = spec.page_layout.margins_mm ?? { left: 14, right: 14 };
  return Math.round(((widthMm - (margins.left ?? 14) - (margins.right ?? 14)) * 96) / 25.4);
}

export function renderReportSectionsToHtml(params: {
  bundle: ReportExecutionBundle;
  locale: string;
  /** @deprecated Ignored for report content: labels always come from the spec dictionary of `locale`. */
  t?: Translate;
  /** Studio mock preview: render every section, including visibility-gated ones. */
  includeHiddenSections?: boolean;
}): string {
  const { bundle, locale } = params;
  const spec = bundle.spec;
  const t = specTranslator(spec, locale);
  const lookup = (key: string) => specLookup(spec, locale, key);
  const isRtl = isRtlLocale(locale);
  const totalLabel = lookup("report.total") ?? engineLabel(locale, "total");
  const noDataLabel = lookup("report.no_data") ?? engineLabel(locale, "noData");
  const heading = (key: string | undefined, tag = "h3") => (key ? `<${tag} class="report-section-title">${escapeHtml(t(key))}</${tag}>` : "");
  const subtitle = (key: string | undefined) => (key ? `<p class="report-section-subtitle">${escapeHtml(t(key))}</p>` : "");
  let orientation: "PORTRAIT" | "LANDSCAPE" = spec.page_layout.orientation ?? "PORTRAIT";

  const renderSection = (section: ReportSectionSpec): string => {
    switch (section.section_type) {
      case "KPI_GRID": {
        const columns = Math.max(1, Math.min(3, section.columns));
        const cards = section.cards
          .map((card) => {
            const row = (bundle.datasets[card.dataset_id] ?? [])[card.row_index] ?? {};
            const currency = resolveCurrency(bundle, row);
            const value = formatReportValue(row[card.value_field], card.format_hint, currency, t);
            const delta = card.delta_field
              ? formatReportValue(
                  row[card.delta_field],
                  card.delta_format_hint ?? card.format_hint,
                  currency,
                  t,
                )
              : null;
            const valueLength = value.length;
            const valueSize =
              valueLength > 22 ? "report-kpi-value--xlong" : valueLength > 16 ? "report-kpi-value--long" : "";
            return `<div class="report-kpi-card report-tone-${card.tone.toLowerCase()}">
                <div class="report-kpi-label">${escapeHtml(t(card.label_i18n_key))}</div>
                <div class="report-kpi-metric">
                  <div class="report-kpi-value ${valueSize}">${escapeHtml(value)}</div>
                  ${delta ? `<div class="report-kpi-delta">${escapeHtml(delta)}</div>` : ""}
                </div>
              </div>`;
          })
          .join("");
        return `<section class="report-section report-kpi-section">
            ${heading(section.title_i18n_key)}
            <div class="report-kpi-grid" style="grid-template-columns:repeat(${columns},minmax(0,1fr))">${cards}</div>
          </section>`;
      }

      case "DATA_TABLE": {
        const rows = bundle.datasets[section.dataset_id] ?? [];
        const columns = expandTableColumns(section.columns, rows, lookup);
        // Fixed-layout percentages must add up to 100%; otherwise browsers
        // distribute the remainder unpredictably and long values look cramped.
        const specifiedWidths = columns.map((col) => col.width_percent ?? 0);
        const specifiedTotal = specifiedWidths.reduce((sum, value) => sum + value, 0);
        const unspecified = specifiedWidths.filter((value) => value === 0).length;
        const fallback = unspecified > 0 ? Math.max(1, (100 - specifiedTotal) / unspecified) : 0;
        const widths = columns.map((col) => (col.width_percent ?? fallback));
        const widthTotal = widths.reduce((sum, value) => sum + value, 0) || 1;
        const normalizedWidths = widths.map((width) => Math.round((width / widthTotal) * 1000) / 10);
        const colgroup = `<colgroup>${normalizedWidths.map((width) => `<col style="width:${width}%" />`).join("")}</colgroup>`;
        const head = columns
          .map((col) => `<th style="text-align:${logicalAlign(col.align)}">${escapeHtml(col.header)}</th>`)
          .join("");
        const numericHints = new Set([
          "CURRENCY_MINOR",
          "DECIMAL_2",
          "DECIMAL_4",
          "PERCENT_BPS",
          "PERCENT_RATIO",
          "INTEGER",
        ]);
        const cellClass = (col: (typeof columns)[number]): string =>
          col.format_hint === "BADGE"
            ? "report-cell-badge"
            : numericHints.has(col.format_hint) || col.align === "END"
              ? "report-cell-number"
              : "report-cell-text";
        const cell = (row: Row, col: (typeof columns)[number]): string => {
          const raw = row[col.field];
          if (col.format_hint === "BADGE") {
            if (raw === null || raw === undefined || raw === "") return "—";
            const key = String(raw);
            const tone = (col.badge_tone_map?.[key] ?? BADGE_TONES[key.toUpperCase()] ?? "NEUTRAL").toLowerCase();
            const sizeClass = key.length > 16 ? "report-badge--xlong" : key.length > 10 ? "report-badge--long" : "";
            return `<span class="report-badge report-badge-${tone} ${sizeClass}">${escapeHtml(formatReportValue(raw, "ENUM_TRANSLATED", undefined, t))}</span>`;
          }
          return escapeHtml(formatReportValue(raw, col.format_hint, resolveCurrency(bundle, row), t));
        };
        const body = rows
          .map((row) => `<tr>${columns.map((col) => `<td class="${cellClass(col)}" style="text-align:${logicalAlign(col.align)}">${cell(row, col)}</td>`).join("")}</tr>`)
          .join("");
        const summaries = columns.map((col) =>
          computeFooterSummary({
            rows,
            field: col.field,
            kind: col.summary_footer,
            formatHint: col.format_hint,
            currency: resolveCurrency(bundle, rows[0]),
            totalLabel,
          }),
        );
        const foot = summaries.some((value) => value !== null)
          ? `<tfoot><tr>${columns
              .map((col, index) => {
                const isLabel = col.summary_footer === "LABEL_TOTAL";
                return `<td class="${cellClass(col)}${isLabel ? " report-footer-label" : ""}" style="text-align:${logicalAlign(col.align)}">${escapeHtml(summaries[index] ?? "")}</td>`;
              })
              .join("")}</tr></tfoot>`
          : "";
        const classes = [
          "report-data-table",
          section.zebra_striping ? "report-zebra" : "",
          section.repeat_header_on_page_break === false ? "report-no-repeat-header" : "",
          section.avoid_row_split === false ? "" : "report-avoid-row-split",
        ]
          .filter(Boolean)
          .join(" ");
        const compactTable = rows.length <= 8;
        return `<section class="report-section report-table-section${compactTable ? " report-table-section--compact" : ""}">
            ${heading(section.title_i18n_key)}
            ${subtitle(section.subtitle_i18n_key)}
            <table class="${classes}">
              ${colgroup}
              <thead><tr>${head}</tr></thead>
              <tbody>${body || `<tr><td class="report-empty-cell" colspan="${Math.max(1, columns.length)}">${escapeHtml(noDataLabel)}</td></tr>`}</tbody>
              ${foot}
            </table>
          </section>`;
      }

      case "CHART": {
        const chartRows = bundle.datasets[section.dataset_id] ?? [];
        const hasData =
          chartRows.length > 0 &&
          section.series.some((series) =>
            chartRows.some((row) => {
              const value = row[series.field];
              return value !== null && value !== undefined && String(value) !== "";
            }),
          );
        if (!hasData) {
          return `<section class="report-section report-chart-box">
              ${heading(section.title_i18n_key)}
              ${subtitle(section.subtitle_i18n_key)}
              <div class="report-chart-empty">${escapeHtml(noDataLabel)}</div>
            </section>`;
        }
        const svg = renderChartSectionToSvg({
          section,
          datasets: bundle.datasets,
          t,
          isRtl,
          contentWidthPx: pageContentWidthPx(spec, orientation),
        });
        const legendEntries: Array<{ label: string; color: string }> = [];
        if (section.chart_kind === "PIE" || section.chart_kind === "DONUT") {
          const seen = new Set<string>();
          chartRows.forEach((row, index) => {
            const label = formatReportValue(row[section.x_field], "ENUM_TRANSLATED", undefined, t);
            if (label === "—" || seen.has(label)) return;
            seen.add(label);
            legendEntries.push({
              label,
              color: CHART_PALETTE[index % CHART_PALETTE.length]!,
            });
          });
        } else if (section.chart_kind !== "HEATMAP" && section.series.length > 1) {
          section.series.forEach((series, index) => {
            legendEntries.push({
              label: t(series.label_i18n_key),
              color: series.color_hex ?? CHART_PALETTE[index % CHART_PALETTE.length]!,
            });
          });
        }
        const legend = legendEntries.length
          ? `<div class="report-chart-legend">${legendEntries
              .map(
                (entry) =>
                  `<span class="report-chart-legend-item"><span class="report-chart-legend-swatch" style="background:${escapeHtml(entry.color)}"></span>${escapeHtml(entry.label)}</span>`,
              )
              .join("")}</div>`
          : "";
        return `<section class="report-section report-chart-box">
            ${heading(section.title_i18n_key)}
            ${subtitle(section.subtitle_i18n_key)}
            <div class="report-chart-frame" style="width:100%;max-width:100%">${svg}</div>
            ${legend}
          </section>`;
      }

      case "VECTOR_DRAW": {
        const svg = renderVectorDrawSectionToSvg({
          section,
          datasets: bundle.datasets,
          t,
          formatValue: (value, hint) => formatReportValue(value, hint, resolveCurrency(bundle), t),
          isRtl,
        });
        return `<section class="report-section report-draw-box">
            ${heading(section.title_i18n_key)}
            ${svg}
          </section>`;
      }

      case "HTML_TEMPLATE": {
        const html = section.html_template
          .replace(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => escapeHtml(t(key)))
          .replace(/asset:\/\/([a-zA-Z0-9_-]+)/g, (_m, key: string) => bundle.assetDataUrls?.[key] ?? "");
        return `<section class="report-section report-html-section" data-section-id="${escapeHtml(section.section_id)}">
            ${heading(section.title_i18n_key)}
            ${sanitizeReportHtml(html)}
            ${section.scoped_css ? `<style>${sanitizeReportCss(section.scoped_css)}</style>` : ""}
          </section>`;
      }

      case "IMAGE_BANNER": {
        const src = bundle.assetDataUrls?.[section.asset_key];
        const safeSrc = src && /^data:image\//i.test(src) ? src : "";
        return `<section class="report-section report-image-section" style="text-align:${logicalAlign(section.align)}">
            ${safeSrc ? `<img src="${escapeHtml(safeSrc)}" alt="${escapeHtml(section.caption_i18n_key ? t(section.caption_i18n_key) : section.asset_key)}" style="max-height:${section.max_height_mm}mm;max-width:100%" />` : ""}
            ${section.caption_i18n_key ? `<p class="report-image-caption">${escapeHtml(t(section.caption_i18n_key))}</p>` : ""}
          </section>`;
      }

      case "PAGE_BREAK":
        return "";
    }
    return "";
  };

  // Content is grouped between page breaks; a PAGE_BREAK's orientation applies to the group that FOLLOWS it
  // through a named page on the wrapper.
  const groups: Array<{ orientation: string | null; breakBefore: boolean; html: string[] }> = [
    { orientation: null, breakBefore: false, html: [] },
  ];
  let pendingCharts: Array<{ width: number; html: string }> = [];
  const flushCharts = (): void => {
    if (pendingCharts.length === 0) return;
    const cells = pendingCharts
      .map(
        (chart) =>
          `<div class="report-chart-cell" style="flex:0 1 calc(${chart.width}% - 2.5mm);">${chart.html}</div>`,
      )
      .join("");
    groups[groups.length - 1]!.html.push(`<div class="report-chart-row">${cells}</div>`);
    pendingCharts = [];
  };
  for (const section of spec.sections) {
    if (!params.includeHiddenSections && !isVisible(section, bundle.datasets, bundle.inputsUsed ?? {})) continue;
    if (section.section_type === "PAGE_BREAK") {
      flushCharts();
      const previous = groups[groups.length - 1]!;
      if (section.orientation_after) orientation = section.orientation_after;
      groups.push({
        orientation: section.orientation_after ? section.orientation_after.toLowerCase() : previous.orientation,
        breakBefore: true,
        html: [],
      });
      continue;
    }
    if (section.section_type === "CHART" && (section.width_percent ?? 100) < 100) {
      pendingCharts.push({ width: section.width_percent ?? 50, html: renderSection(section) });
      if (pendingCharts.length >= 2) flushCharts();
      continue;
    }
    flushCharts();
    groups[groups.length - 1]!.html.push(renderSection(section));
  }
  flushCharts();
  if (groups.length > 1 && groups[0]!.html.length === 0) {
    groups.shift();
    groups[0]!.breakBefore = false;
  }
  return groups
    .map((group) => {
      const classes = [
        "report-page-group",
        group.breakBefore ? "report-page-break" : "",
        group.orientation ? `report-orientation-${group.orientation}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<div class="${classes}">\n${group.html.join("\n")}\n</div>`;
    })
    .join("\n");
}

const formatChromeDate = (iso: string, locale: string, withTime: boolean): string => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const resolved = locale.startsWith("en") ? "en-GB" : locale;
  return new Intl.DateTimeFormat(resolved, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    timeZone: "UTC",
  }).format(date);
};

/** Normalises the engine's raw ISO period pair into the reference's localized format. */
const formatChromePeriod = (raw: string, locale: string): string => {
  if (!raw) return "";
  // Split only on a dash separator, never on the hyphens inside ISO dates.
  const parts = raw.split(/\s*[–—]\s*|\s+-\s+/).filter(Boolean);
  if (parts.length !== 2) return raw;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(parts[0]!) ? formatChromeDate(`${parts[0]}T00:00:00.000Z`, locale, false) : parts[0]!;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(parts[1]!) ? formatChromeDate(`${parts[1]}T00:00:00.000Z`, locale, false) : parts[1]!;
  return `${start} – ${end}`;
};

/** Renders a header/footer chrome with its variables bound; labels come from the chrome dictionary. */
export function renderChromeHtml(params: {
  chrome: ReportChromeSpec | null;
  bundle: ReportExecutionBundle;
  locale: string;
  /** @deprecated Ignored: chrome labels come from the chrome dictionary, then the report dictionary. */
  t?: Translate;
}): string {
  const { chrome, bundle, locale } = params;
  if (!chrome) return "";
  const spec = bundle.spec;
  const t: Translate = (key) =>
    chrome.i18n.locales[locale]?.[key] ??
    chrome.i18n.locales[chrome.i18n.default_locale]?.[key] ??
    (spec ? specLookup(spec, locale, key) : undefined) ??
    key;
  const specT = (key: string): string => (spec ? specLookup(spec, locale, key) ?? "" : "");
  const variables: Record<string, string> = {
    institutionName: bundle.institutionName ?? "Libyan National Payment Gateway",
    reportTitle: specT("report.title") || spec?.report.code || "",
    reportSubtitle: specT("report.subtitle"),
    reportCode: spec?.report.code ?? "",
    reportVersion: String(spec?.report.version ?? ""),
    generatedAtIso: bundle.executedAtIso ?? "",
    generatedAtFormatted: formatChromeDate(bundle.executedAtIso ?? "", locale, true),
    actorName: bundle.actor?.name ?? "",
    actorEmail: bundle.actor?.email ?? "",
    actorRole: bundle.actor?.role ?? "",
    selectedLocale: locale,
    defaultCurrency: bundle.currency ?? "LYD",
    classificationBadge: spec?.report.classification ?? "",
    verificationHashShort: String(bundle.verificationSha256 ?? "").slice(0, 12),
    ...(bundle.chromeVariables ?? {}),
  };
  if (bundle.chromeVariables?.periodSummary) {
    variables.periodSummary = formatChromePeriod(bundle.chromeVariables.periodSummary, locale);
  }
  let html = chrome.template.html;
  html = html.replace(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => escapeHtml(t(key)));
  html = html.replace(/\{\{\s*pageNumber\s*\}\}/g, '<span class="report-page-number"></span>');
  html = html.replace(/\{\{\s*totalPages\s*\}\}/g, '<span class="report-total-pages"></span>');
  html = html.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? escapeHtml(variables[key]) : match,
  );
  for (const asset of chrome.required_assets ?? []) {
    if (!asset.max_width_mm && !asset.max_height_mm) continue;
    const escapedKey = asset.asset_key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const imagePattern = new RegExp(`(<img[^>]*src=["']asset://${escapedKey}["'][^>]*?)\\s*/?>`, "gi");
    html = html.replace(imagePattern, (match, attrs: string) => {
      if (/\bstyle=/i.test(attrs)) return match;
      const styles = [
        asset.max_width_mm ? `max-width:${asset.max_width_mm}mm` : "",
        asset.max_height_mm ? `max-height:${asset.max_height_mm}mm` : "",
      ]
        .filter(Boolean)
        .join(";");
      return `${attrs} style="${styles}" />`;
    });
  }
  html = html.replace(/asset:\/\/([a-zA-Z0-9_-]+)/g, (_m, key: string) => bundle.assetDataUrls?.[key] ?? "");
  const band = chrome.chrome.accent_band;
  const borderClass = band
    ? ""
    : chrome.chrome.border_style === "NONE"
      ? ""
      : ` report-chrome-border-${chrome.chrome.border_style.toLowerCase().replaceAll("_", "-")}`;
  let bandHtml = "";
  if (band) {
    const total = band.segments.reduce((sum, segment) => sum + segment.width_percent, 0) || 1;
    let cursor = 0;
    const stops = band.segments.map((segment) => {
      const start = (cursor / total) * 100;
      cursor += segment.width_percent;
      const end = (cursor / total) * 100;
      return `${escapeHtml(segment.color)} ${start}% ${end}%`;
    });
    const radius =
      band.position === "TOP"
        ? `${band.radius_mm}mm ${band.radius_mm}mm 0 0`
        : `0 0 ${band.radius_mm}mm ${band.radius_mm}mm`;
    bandHtml = `<div class="report-chrome-accent-band" style="position:absolute;left:0;right:0;${band.position === "TOP" ? "top" : "bottom"}:0;height:${band.height_mm}mm;border-radius:${radius};background:linear-gradient(90deg,${stops.join(",")});"></div>`;
  }
  return `<div class="report-chrome report-chrome-${chrome.chrome.chrome_type.toLowerCase()}${borderClass}" style="height:${chrome.chrome.height_mm}mm;min-height:${chrome.chrome.height_mm}mm;position:relative;">${sanitizeReportHtml(html)}${bandHtml}</div>`;
}
