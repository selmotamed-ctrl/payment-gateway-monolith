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
}): string {
  const { bundle, locale, renderedSectionsHtml, renderedHeaderHtml, renderedFooterHtml } = params;
  const { page_layout } = bundle.spec;
  const isRtl = locale === "ar" || locale.startsWith("ar-") || locale === "he" || locale === "fa";
  const dir = isRtl ? "rtl" : "ltr";
  const pageSizeCss = `${page_layout.paper_size} ${page_layout.orientation.toLowerCase()}`;
  const m = page_layout.margins_mm;

  return `<!DOCTYPE html>
<html lang="${locale}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(bundle.spec.i18n.locales[locale]?.["report.title"] ?? bundle.spec.report.code)}</title>
  <style>
    @page {
      size: ${pageSizeCss};
      margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;
      @top-center { content: element(report-running-header); }
      @bottom-center { content: element(report-running-footer); }
    }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body {
      margin: 0; padding: 0;
      font-family: ${isRtl ? "'Tajawal', 'Cairo', 'Amiri', sans-serif" : "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"};
      font-size: 9.5pt; line-height: 1.45; color: #0F172A; direction: ${dir};
    }
    .report-running-header { position: running(report-running-header); width: 100%; }
    .report-running-footer { position: running(report-running-footer); width: 100%; }
    .report-page-number::after { content: counter(page); }
    .report-total-pages::after { content: counter(pages); }
    .report-chrome-border-thin-rule { border-bottom: 0.75pt solid #CBD5E1; }
    .report-chrome-border-double-bank-rule { border-bottom: 1.5pt double #1E293B; }
    .report-chrome-border-accent-band { border-bottom: 3pt solid #2563EB; }
    table.report-data-table.report-no-repeat-header thead { display: table-row-group; }
    table.report-data-table { width: 100%; border-collapse: collapse; margin-bottom: 12pt; font-variant-numeric: tabular-nums; }
    table.report-data-table thead { display: table-header-group; }
    table.report-data-table tfoot { display: table-footer-group; }
    table.report-data-table tr { break-inside: avoid; page-break-inside: avoid; }
    table.report-data-table th, table.report-data-table td { padding: 5pt 7pt; border-bottom: 0.75pt solid #E2E8F0; }
    table.report-data-table th { background-color: #F1F5F9; font-weight: 700; color: #1E293B; border-top: 1pt solid #CBD5E1; border-bottom: 1.25pt solid #94A3B8; }
    .report-section { margin-bottom: 14pt; }
    .report-chart-box, .report-draw-box, .report-kpi-grid { break-inside: avoid; page-break-inside: avoid; }
    .report-page-break { break-before: page; page-break-before: always; }
    .report-orientation-landscape { page: landscape; }
    .report-orientation-portrait { page: portrait; }
    @page landscape { size: ${page_layout.paper_size} landscape; }
    @page portrait { size: ${page_layout.paper_size} portrait; }
    ${bundle.resolvedHeaderChrome && !bundle.resolvedHeaderChrome.chrome.show_on_first_page ? "@page :first { @top-center { content: none; } }" : ""}
    ${bundle.resolvedFooterChrome && !bundle.resolvedFooterChrome.chrome.show_on_first_page ? "@page :first { @bottom-center { content: none; } }" : ""}
    ${bundle.resolvedHeaderChrome?.template.scoped_css ?? ""}
    ${bundle.resolvedFooterChrome?.template.scoped_css ?? ""}
    ${page_layout.global_scoped_css ?? ""}
  </style>
</head>
<body>
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
