import * as echarts from "echarts";
import type { ReportExecutionBundle } from "../types/bundle";

export type { ReportExecutionBundle };

export function renderChartSectionToSvgString(params: {
  echartsOption: echarts.EChartsOption;
  widthPx: number;
  heightPx: number;
}): string {
  const container = document.createElement("div");
  container.style.width = `${params.widthPx}px`;
  container.style.height = `${params.heightPx}px`;
  const chart = echarts.init(container, undefined, {
    renderer: "svg",
    width: params.widthPx,
    height: params.heightPx,
  });
  try {
    chart.setOption({ ...params.echartsOption, animation: false });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

export function buildPagedMediaHtmlDocument(params: {
  bundle: ReportExecutionBundle;
  locale: string;
  renderedSectionsHtml: string;
  renderedHeaderHtml: string;
  renderedFooterHtml: string;
  /** Override the same-origin base used for report font URLs (tests/SSR). */
  assetOrigin?: string;
}): string {
  const { bundle, locale, renderedSectionsHtml, renderedHeaderHtml, renderedFooterHtml } = params;
  const { page_layout } = bundle.spec;
  const isRtl = locale === "ar" || locale.startsWith("ar-") || locale === "he" || locale === "fa";
  const dir = isRtl ? "rtl" : "ltr";
  const pageSizeCss = `${page_layout.paper_size} ${page_layout.orientation.toLowerCase()}`;
  const m = page_layout.margins_mm;
  // Paged.js resolves CSS url() values against the srcdoc document URL
  // (`about:srcdoc`), so relative paths are invalid. Use absolute same-origin
  // URLs for the report fonts.
  const assetOrigin =
    params.assetOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");

  return `<!DOCTYPE html>
<html lang="${locale}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(bundle.spec.i18n.locales[locale]?.["report.title"] ?? bundle.spec.report.code)}</title>
  <style>
    @font-face {
      font-family: "Report Sans";
      src: url("${assetOrigin}/report-engine/fonts/plus-jakarta-sans-400-normal.ttf") format("truetype");
      font-weight: 200 800;
      font-style: normal;
    }
    @font-face {
      font-family: "Report Arabic";
      src: url("${assetOrigin}/report-engine/fonts/cairo-400-normal.ttf") format("truetype");
      font-weight: 200 900;
      font-style: normal;
    }
    @font-face {
      font-family: "Report Mono";
      src: url("${assetOrigin}/report-engine/fonts/jetbrains-mono-latin-600-normal.woff2") format("woff2");
      font-weight: 600;
      font-style: normal;
    }
    @page {
      size: ${pageSizeCss};
      margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;
      @top-center { content: element(report-running-header); }
      @bottom-center { content: element(report-running-footer); }
    }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body {
      margin: 0; padding: 0;
      font-family: ${isRtl ? "'Report Arabic', 'Cairo', 'Amiri', sans-serif" : "'Report Sans', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif"};
      font-size: 9pt; line-height: 1.4; color: #0F172A; direction: ${dir};
    }
    code, pre, .report-mono { font-family: "Report Mono", ui-monospace, SFMono-Regular, monospace; }
    .pagedjs_pages { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 18px; background: #E2E8F0; }
    .pagedjs_page { background: #FFFFFF; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16); }
    @media print {
      .pagedjs_pages { padding: 0; gap: 0; background: transparent; display: block !important; }
      .pagedjs_page {
        box-shadow: none;
        break-before: page !important;
        page-break-before: always !important;
        break-after: auto !important;
        page-break-after: auto !important;
      }
      .pagedjs_page:first-child {
        break-before: auto !important;
        page-break-before: auto !important;
      }
      .pagedjs_page.pagedjs_landscape_page { page: landscape !important; }
      .pagedjs_page.pagedjs_portrait_page { page: portrait !important; }
      .pagedjs_page.pagedjs_landscape_page,
      .pagedjs_page.pagedjs_landscape_page > .pagedjs_sheet,
      .pagedjs_page.pagedjs_landscape_page .pagedjs_pagebox {
        width: ${page_layout.paper_size === "LETTER" ? "279.4mm" : page_layout.paper_size === "LEGAL" ? "355.6mm" : "297mm"} !important;
        height: ${page_layout.paper_size === "LETTER" ? "215.9mm" : page_layout.paper_size === "LEGAL" ? "215.9mm" : "210mm"} !important;
        max-height: none !important;
      }
      .pagedjs_page.pagedjs_portrait_page,
      .pagedjs_page.pagedjs_portrait_page > .pagedjs_sheet,
      .pagedjs_page.pagedjs_portrait_page .pagedjs_pagebox {
        width: ${page_layout.paper_size === "LETTER" ? "215.9mm" : page_layout.paper_size === "LEGAL" ? "215.9mm" : "210mm"} !important;
        height: ${page_layout.paper_size === "LETTER" ? "279.4mm" : page_layout.paper_size === "LEGAL" ? "355.6mm" : "297mm"} !important;
        max-height: none !important;
      }
    }
    .report-kpi-grid { display: grid; gap: 6pt; margin: 4pt 0 8pt; align-items: stretch; }
    .report-kpi-card {
      display: flex; flex-direction: column; justify-content: space-between;
      min-height: 22mm; padding: 7pt 9pt; border: 0.75pt solid #E2E8F0; border-radius: 5pt;
      background: #F8FAFC; border-inline-start: 3pt solid #64748B;
      break-inside: avoid; page-break-inside: avoid;
    }
    .report-kpi-label {
      font-size: 6.8pt; line-height: 1.25; text-transform: uppercase; letter-spacing: 0.04em;
      color: #475569; min-height: 2.4em; overflow-wrap: anywhere;
    }
    .report-kpi-metric { margin-top: auto; padding-top: 2pt; min-width: 0; }
    .report-kpi-value {
      font-size: 12pt; line-height: 1.15; font-weight: 700; color: #0F172A;
      font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .report-kpi-value--long { font-size: 10.5pt; }
    .report-kpi-value--xlong { font-size: 9pt; }
    .report-kpi-delta { font-size: 6.8pt; line-height: 1.25; color: #475569; margin-top: 1.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .report-tone-primary { border-inline-start-color: #2563EB; background: #EFF6FF; }
    .report-tone-success { border-inline-start-color: #059669; background: #ECFDF5; }
    .report-tone-warning { border-inline-start-color: #D97706; background: #FFFBEB; }
    .report-tone-danger { border-inline-start-color: #DC2626; background: #FEF2F2; }
    .report-tone-neutral { border-inline-start-color: #64748B; background: #F8FAFC; }
    .report-badge {
      display: inline-block; padding: 1pt 3.5pt; border-radius: 999px; font-size: 6.4pt;
      line-height: 1.25; font-weight: 700; border: 0.75pt solid transparent;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; vertical-align: middle;
    }
    .report-badge--long { font-size: 5.8pt; }
    .report-badge--xlong { font-size: 5.2pt; }
    .report-badge-success { background: #D1FAE5; color: #065F46; border-color: #A7F3D0; }
    .report-badge-warning { background: #FEF3C7; color: #92400E; border-color: #FDE68A; }
    .report-badge-danger { background: #FEE2E2; color: #991B1B; border-color: #FECACA; }
    .report-badge-info { background: #DBEAFE; color: #1E40AF; border-color: #BFDBFE; }
    .report-badge-neutral { background: #F1F5F9; color: #334155; border-color: #E2E8F0; }
    .report-zebra tbody tr:nth-child(even) { background: #F8FAFC; }
    .report-empty-cell { color: #64748B; text-align: center; padding: 10pt 6pt; }
    .report-running-header { position: running(report-running-header); width: 100%; }
    .report-running-footer { position: running(report-running-footer); width: 100%; }
    .report-page-number::after { content: counter(page); }
    .report-total-pages::after { content: counter(pages); }
    .report-chrome-border-thin-rule { border-bottom: 0.75pt solid #CBD5E1; }
    .report-chrome-border-double-bank-rule { border-bottom: 1.5pt double #1E293B; }
    .report-chrome-border-accent-band { border-bottom: 3pt solid #2563EB; }
    table.report-data-table.report-no-repeat-header thead { display: table-row-group; }
    table.report-data-table {
      width: 100%; max-width: 100%; table-layout: fixed; border-collapse: collapse;
      margin-bottom: 10pt; font-size: 7.8pt; line-height: 1.3; font-variant-numeric: tabular-nums;
    }
    table.report-data-table thead { display: table-header-group; }
    table.report-data-table tfoot { display: table-footer-group; }
    table.report-data-table.report-avoid-row-split tr { break-inside: avoid; page-break-inside: avoid; }
    table.report-data-table th, table.report-data-table td {
      padding: 3.5pt 4.5pt; border-bottom: 0.6pt solid #E2E8F0;
      overflow-wrap: break-word; word-break: normal; vertical-align: top;
    }
    table.report-data-table th { font-size: 7pt; line-height: 1.25; hyphens: auto; }
    table.report-data-table td.report-cell-text { overflow-wrap: anywhere; }
    table.report-data-table td.report-cell-number { white-space: nowrap; font-size: 7.4pt; letter-spacing: -0.01em; }
    table.report-data-table td.report-cell-badge { overflow: hidden; }
    table.report-data-table td.report-footer-label { white-space: nowrap; overflow-wrap: normal; font-size: 6.8pt; }
    table.report-data-table col { min-width: 0; }
    table.report-data-table th { background-color: #F1F5F9; font-weight: 700; color: #1E293B; border-top: 1pt solid #CBD5E1; border-bottom: 1.25pt solid #94A3B8; }
    .report-section { margin-bottom: 12pt; }
    .report-section-title {
      font-size: 10.5pt; line-height: 1.25; margin: 0 0 1.8mm 0; color: #0F172A;
      break-after: avoid; page-break-after: avoid;
    }
    .report-section-subtitle {
      font-size: 8pt; line-height: 1.35; color: #475569; margin: -0.8mm 0 2.4mm 0;
      break-after: avoid; page-break-after: avoid;
    }
    .report-kpi-section, .report-chart-box, .report-draw-box, .report-image-section,
    .report-html-section, .report-kpi-grid { break-inside: avoid; page-break-inside: avoid; min-width: 0; }
    .report-table-section--compact { break-inside: avoid; page-break-inside: avoid; }
    .report-chart-row {
      display: flex; justify-content: center; align-items: flex-start; gap: 5mm;
      width: 100%; max-width: 100%; break-inside: avoid; page-break-inside: avoid; margin-bottom: 12pt;
    }
    .report-chart-row > .report-chart-cell { min-width: 0; max-width: 100%; }
    .report-chart-row .report-chart-box { margin-bottom: 0; }
    .report-chart-legend {
      display: flex; flex-wrap: wrap; justify-content: center; align-items: center;
      gap: 3pt 10pt; margin-top: 5pt; font-size: 7.5pt; line-height: 1.3; color: #475569;
      break-inside: avoid; page-break-inside: avoid;
    }
    .report-chart-legend-item { display: inline-flex; align-items: center; gap: 4pt; white-space: nowrap; max-width: 100%; }
    .report-chart-legend-swatch { display: inline-block; width: 8pt; height: 8pt; border-radius: 2pt; border: 0.5pt solid rgba(15,23,42,0.15); }
    .report-chart-empty {
      border: 0.75pt dashed #CBD5E1; border-radius: 4pt; background: #F8FAFC;
      color: #64748B; text-align: center; padding: 10mm 4mm; font-size: 8.5pt;
    }
    .report-page-break { break-before: page; page-break-before: always; }
    .report-orientation-landscape { page: landscape; }
    .report-orientation-portrait { page: portrait; }
    @page landscape { size: ${page_layout.paper_size} landscape; }
    @page portrait { size: ${page_layout.paper_size} portrait; }
    /* Paged.js names the page element; print engines only honour a named
       page when the page-level element carries the page name. */
    .pagedjs_page.pagedjs_landscape_page {
      page: landscape;
      --pagedjs-width: ${page_layout.paper_size === "LETTER" ? "279.4mm" : page_layout.paper_size === "LEGAL" ? "355.6mm" : "297mm"};
      --pagedjs-height: ${page_layout.paper_size === "LETTER" ? "215.9mm" : page_layout.paper_size === "LEGAL" ? "215.9mm" : "210mm"};
      width: var(--pagedjs-width);
      height: var(--pagedjs-height);
    }
    .pagedjs_page.pagedjs_landscape_page > .pagedjs_sheet,
    .pagedjs_page.pagedjs_landscape_page .pagedjs_pagebox {
      width: ${page_layout.paper_size === "LETTER" ? "279.4mm" : page_layout.paper_size === "LEGAL" ? "355.6mm" : "297mm"} !important;
      height: ${page_layout.paper_size === "LETTER" ? "215.9mm" : page_layout.paper_size === "LEGAL" ? "215.9mm" : "210mm"} !important;
    }
    .pagedjs_page.pagedjs_portrait_page {
      page: portrait;
      --pagedjs-width: ${page_layout.paper_size === "LETTER" ? "215.9mm" : page_layout.paper_size === "LEGAL" ? "215.9mm" : "210mm"};
      --pagedjs-height: ${page_layout.paper_size === "LETTER" ? "279.4mm" : page_layout.paper_size === "LEGAL" ? "355.6mm" : "297mm"};
      width: var(--pagedjs-width);
      height: var(--pagedjs-height);
    }
    /* A4 containment: nothing may exceed the page content box. */
    .report-body-container, .report-page-group, .report-section, .report-html-section,
    .report-chart-frame, .report-draw-box, .report-image-section, .report-chrome,
    .report-kpi-grid, .report-kpi-card { max-width: 100%; min-width: 0; }
    .report-section > *, .report-page-group > * { min-width: 0; }
    img { max-width: 100%; height: auto; }
    .report-chart-frame { margin-inline: auto; }
    .report-chart-frame svg, .report-draw-box svg, .report-html-section svg { max-width: 100%; }
    .report-html-section { font-size: 8.5pt; line-height: 1.4; }
    .report-html-section h1, .report-html-section h2, .report-html-section h3 { line-height: 1.25; margin-top: 0; }
    .report-html-section table { table-layout: fixed; width: 100%; border-collapse: collapse; }
    .report-html-section th, .report-html-section td { overflow-wrap: anywhere; word-break: break-word; }
    .report-html-section pre, .report-html-section code, code, pre, .report-mono {
      white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
    }
    .report-chrome {
      display: flex; flex-direction: column; position: relative; box-sizing: border-box;
      max-width: 100%; min-width: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .report-chrome > :first-child { flex: 1 1 auto; min-height: 0; }
    .report-chrome-accent-band { pointer-events: none; z-index: 2; }
    .report-chrome, .report-chrome * { overflow-wrap: anywhere; max-width: 100%; min-width: 0; }
    .report-running-header, .report-running-footer { max-width: 100%; min-width: 0; }
    .report-running-header > div, .report-running-footer > div { max-width: 100%; min-width: 0; flex-wrap: wrap; }
    /* Paged.js wraps page content in an anonymous block; keep it inside the content box. */
    .pagedjs_page_content > div { max-width: 100%; min-width: 0; }
    ${bundle.resolvedHeaderChrome && !bundle.resolvedHeaderChrome.chrome.show_on_first_page ? "@page :first { @top-center { content: none; } }" : ""}
    ${bundle.resolvedFooterChrome && !bundle.resolvedFooterChrome.chrome.show_on_first_page ? "@page :first { @bottom-center { content: none; } }" : ""}
    ${bundle.resolvedHeaderChrome?.template.scoped_css ?? ""}
    ${bundle.resolvedFooterChrome?.template.scoped_css ?? ""}
    ${page_layout.global_scoped_css ?? ""}
  </style>
</head>
<body data-report-paper="${page_layout.paper_size}" data-report-paper-width="${page_layout.paper_size === "LETTER" ? "215.9" : page_layout.paper_size === "LEGAL" ? "215.9" : "210"}" data-report-paper-height="${page_layout.paper_size === "LETTER" ? "279.4" : page_layout.paper_size === "LEGAL" ? "355.6" : "297"}" data-report-margin-top="${m.top}" data-report-margin-right="${m.right}" data-report-margin-bottom="${m.bottom}" data-report-margin-left="${m.left}">
  ${renderedHeaderHtml ? `<header class="report-running-header">${renderedHeaderHtml}</header>` : ""}
  ${renderedFooterHtml ? `<footer class="report-running-footer">${renderedFooterHtml}</footer>` : ""}
  <main class="report-body-container">${renderedSectionsHtml}</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
