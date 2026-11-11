import { describe, expect, it } from "vitest";
import {
  formatReportValue,
  renderChromeHtml,
  renderReportSectionsToHtml,
} from "../render/reportHtmlRenderer";
import { sanitizeReportHtml } from "../sanitizer/ClientDomSanitizer";
import { resolveInputDefaults } from "../utils/inputDefaults";
import { renderVectorDrawSectionToSvg } from "../components/ReportVectorDrawRenderer";
import type { ReportDescriptorSpec } from "../types/reportSpec";
import type { ReportChromeSpec } from "../types/chromeSpec";
import type { ReportExecutionBundle } from "../types/bundle";

const spec = {
  spec_kind: "REPORT_DESCRIPTOR",
  spec_version: "1.0",
  report: { code: "test-report", version: 1, category: "TEST", audience_scope: "INTERNAL", classification: "INTERNAL" },
  page_layout: {
    paper_size: "A4",
    orientation: "PORTRAIT",
    margins_mm: { top: 26, right: 14, bottom: 24, left: 14 },
    header_mode: "GLOBAL_DEFAULT",
    footer_mode: "GLOBAL_DEFAULT",
    allow_runtime_chrome_selection: true,
    global_scoped_css: "",
  },
  required_assets: [],
  i18n: {
    default_locale: "en",
    prompt_user_when_multi_locale: true,
    locales: {
      en: { "report.title": "Test Report", "table.day": "Day", "table.amount": "Amount", "kpi.total": "Total", "draw.title": "Flow", "draw.gross": "Gross" },
      ar: { "report.title": "تقرير اختبار", "table.day": "اليوم", "table.amount": "المبلغ", "kpi.total": "الإجمالي", "draw.title": "التدفق", "draw.gross": "الإجمالي" },
    },
  },
  inputs: [
    {
      key: "periodRange",
      label_i18n_key: "table.day",
      type: "daterange",
      required: true,
      default_value: { preset: "LAST_7_DAYS" },
      layout_col_span: 6,
    },
  ],
  datasets: [],
  transforms: [],
  sections: [
    {
      section_type: "KPI_GRID",
      section_id: "kpis",
      columns: 2,
      cards: [{ label_i18n_key: "kpi.total", dataset_id: "totals", value_field: "total", row_index: 0, format_hint: "CURRENCY_MINOR", tone: "PRIMARY" }],
    },
    {
      section_type: "DATA_TABLE",
      section_id: "table",
      dataset_id: "rows",
      columns: [
        { field: "day", header_i18n_key: "table.day", align: "START", format_hint: "RAW", summary_footer: "NONE" },
        { field: "amount", header_i18n_key: "table.amount", align: "END", format_hint: "CURRENCY_MINOR", summary_footer: "SUM" },
      ],
    },
    {
      section_type: "VECTOR_DRAW",
      section_id: "draw",
      title_i18n_key: "draw.title",
      draw_kind: "FLOW_DIAGRAM",
      height_mm: 60,
      view_box: { width: 800, height: 260 },
      nodes: [{ node_id: "gross", shape: "ROUNDED_RECT", x: 10, y: 20, width: 150, height: 56, label_i18n_key: "draw.gross", fill_hex: "#F8FAFC", stroke_hex: "#1E293B", text_hex: "#0F172A" }],
      edges: [],
    },
  ],
} as unknown as ReportDescriptorSpec;

const bundle = {
  spec,
  executedAtIso: "2026-05-15T10:00:00.000Z",
  verificationSha256: "abcdef1234567890",
  actor: { id: "1", name: "Finance User", email: "finance@example.test", role: "FINANCE" },
  inputsUsed: {},
  datasets: {
    totals: [{ total: 1234567 }],
    rows: [{ day: "2026-05-14", amount: 1000000 }, { day: "2026-05-15", amount: 500000 }],
  },
  assets: {},
  assetDataUrls: {},
} as unknown as ReportExecutionBundle;

const chrome = {
  spec_kind: "REPORT_CHROME",
  spec_version: "1.0",
  chrome: { code: "header", name: "Header", chrome_type: "HEADER", height_mm: 22, show_on_first_page: true, border_style: "THIN_RULE" },
  required_assets: [],
  i18n: { default_locale: "en", locales: { en: { "chrome.page": "Page", "chrome.of": "of" }, ar: { "chrome.page": "صفحة", "chrome.of": "من" } } },
  template: { html: "<div>{{institutionName}} — {{reportTitle}} — {{$t.chrome.page}} <span class=\"report-page-number\"></span> {{$t.chrome.of}} <span class=\"report-total-pages\"></span></div>", scoped_css: "", used_variables: ["institutionName", "reportTitle", "pageNumber", "totalPages"] },
} as unknown as ReportChromeSpec;

describe("RE-T22: admin-front report rendering helpers", () => {
  it("formats minor units, percentages and dates", () => {
    expect(formatReportValue(1234567, "CURRENCY_MINOR", "LYD")).toBe("1,234.567 LYD");
    expect(formatReportValue(250, "PERCENT_BPS")).toBe("2.50%");
    expect(formatReportValue("2026-05-15T10:00:00Z", "DATE_ISO")).toBe("2026-05-15");
    expect(formatReportValue(null, "CURRENCY_MINOR")).toBe("—");
  });

  it("resolves preset defaults in UTC", () => {
    const defaults = resolveInputDefaults(spec);
    expect(defaults.periodRange).toBeTruthy();
    const range = defaults.periodRange as { start: string; end: string };
    expect(range.start).toMatch(/T00:00:00\.000Z$/);
    expect(range.end).toMatch(/T23:59:59\.999Z$/);
  });

  it("renders bilingual KPI, table and vector sections with RTL mirroring", () => {
    const html = renderReportSectionsToHtml({ bundle, locale: "ar" });
    expect(html).toContain("الإجمالي");
    expect(html).toContain("1,234.567 LYD");
    expect(html).toContain("اليوم");
    expect(html).toContain("report-data-table");
    const svg = renderVectorDrawSectionToSvg({
      section: spec.sections[2] as never,
      datasets: bundle.datasets,
      t: (key) => spec.i18n.locales.ar?.[key] ?? key,
      formatValue: (value, hint) => formatReportValue(value, hint),
      isRtl: true,
    });
    expect(svg).toContain("translate(640");
  });

  it("binds chrome variables and page counters", () => {
    const html = renderChromeHtml({ chrome, bundle, locale: "en" });
    expect(html).toContain("Libyan National Payment Gateway");
    expect(html).toContain("Test Report");
    expect(html).toContain('class="report-page-number"');
    expect(html).not.toContain("{{");
  });

  it("the fallback sanitizer strips active content", () => {
    const sanitized = sanitizeReportHtml('<div onclick="x()"><script>alert(1)</script><p>ok</p></div>');
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).toContain("<p>ok</p>");
  });
});

describe("report rendering additions", () => {
  it("uses the host institution and chrome variables", () => {
    const html = renderChromeHtml({
      chrome,
      bundle: {
        ...bundle,
        institutionName: "Acme Payments",
        chromeVariables: { periodSummary: "2026-05-01 – 2026-05-31" },
      } as never,
      locale: "en",
    });
    expect(html).toContain("Acme Payments");
  });

  it("formats translated enum values when a translator is supplied", () => {
    expect(formatReportValue("ACTIVE", "ENUM_TRANSLATED", "LYD", (key) => (key === "enum.ACTIVE" ? "Active" : key))).toBe("Active");
  });

  it("mock preview renders visibility-gated sections", () => {
    const hiddenSpec = {
      ...spec,
      sections: [
        ...spec.sections,
        {
          section_type: "HTML_TEMPLATE",
          section_id: "hidden_section",
          html_template: "<div>HIDDEN_MARKER</div>",
          scoped_css: "",
          visibility: { when: "DATASET_EMPTY", dataset_id: "rows" },
        },
      ],
    } as unknown as ReportDescriptorSpec;
    const hiddenBundle = { ...bundle, spec: hiddenSpec } as unknown as ReportExecutionBundle;
    expect(renderReportSectionsToHtml({ bundle: hiddenBundle, locale: "en" })).not.toContain("HIDDEN_MARKER");
    expect(
      renderReportSectionsToHtml({ bundle: hiddenBundle, locale: "en", includeHiddenSections: true }),
    ).toContain("HIDDEN_MARKER");
  });

  it("renders a declarative SVG canvas template", () => {
    const svg = renderVectorDrawSectionToSvg({
      section: {
        section_type: "VECTOR_DRAW",
        section_id: "canvas",
        draw_kind: "DECLARATIVE_SVG_CANVAS",
        height_mm: 40,
        view_box: { width: 400, height: 100 },
        nodes: [],
        edges: [],
        custom_svg_template: '<svg xmlns="http://www.w3.org/2000/svg"><text>{{$t.draw.gross}}</text></svg>',
      } as never,
      datasets: {},
      t: (key) => (key === "draw.gross" ? "Gross" : key),
      formatValue: (value, hint) => formatReportValue(value, hint),
      isRtl: false,
    });
    expect(svg).toContain("<text>Gross</text>");
  });
});

describe("print layout contract", () => {
  it("groups consecutive half-width charts into one centered row", () => {
    const chartSpec = {
      ...spec,
      sections: [
        {
          section_type: "CHART",
          section_id: "first",
          title_i18n_key: "table.day",
          dataset_id: "missing",
          chart_kind: "BAR",
          height_mm: 60,
          width_percent: 50,
          x_field: "day",
          y_axis_format: "CURRENCY_MINOR",
          series: [{ field: "amount", label_i18n_key: "table.amount", show_value_labels: false }],
        },
        {
          section_type: "CHART",
          section_id: "second",
          title_i18n_key: "table.amount",
          dataset_id: "missing",
          chart_kind: "BAR",
          height_mm: 60,
          width_percent: 50,
          x_field: "day",
          y_axis_format: "CURRENCY_MINOR",
          series: [{ field: "amount", label_i18n_key: "table.amount", show_value_labels: false }],
        },
      ],
    } as unknown as ReportDescriptorSpec;
    const html = renderReportSectionsToHtml({
      bundle: { ...bundle, spec: chartSpec } as ReportExecutionBundle,
      locale: "en",
    });
    expect(html).toContain("report-chart-row");
    expect((html.match(/report-chart-cell/g) ?? []).length).toBe(2);
  });

  it("renders a no-data state instead of an empty chart", () => {
    const chartSpec = {
      ...spec,
      sections: [
        {
          section_type: "CHART",
          section_id: "empty",
          title_i18n_key: "table.day",
          dataset_id: "missing",
          chart_kind: "BAR",
          height_mm: 60,
          width_percent: 50,
          x_field: "day",
          y_axis_format: "INTEGER",
          series: [{ field: "amount", label_i18n_key: "table.amount", show_value_labels: false }],
        },
      ],
    } as unknown as ReportDescriptorSpec;
    const html = renderReportSectionsToHtml({
      bundle: { ...bundle, spec: chartSpec } as ReportExecutionBundle,
      locale: "en",
    });
    expect(html).toContain("report-chart-empty");
    expect(html).toContain("No data");
  });

  it("pins KPI values to the bottom and scales long numbers", () => {
    const kpiSpec = {
      ...spec,
      sections: [
        {
          section_type: "KPI_GRID",
          section_id: "kpis",
          columns: 3,
          cards: [
            {
              label_i18n_key: "kpi.total",
              dataset_id: "totals",
              value_field: "big",
              row_index: 0,
              format_hint: "CURRENCY_MINOR",
              tone: "PRIMARY",
            },
          ],
        },
      ],
    } as unknown as ReportDescriptorSpec;
    const bigBundle = {
      ...bundle,
      spec: kpiSpec,
      datasets: { totals: [{ big: 1234567890123 }] },
    } as unknown as ReportExecutionBundle;
    const html = renderReportSectionsToHtml({ bundle: bigBundle, locale: "en" });
    expect(html).toContain("report-kpi-metric");
    expect(html).toContain("report-kpi-value--long");
  });

  it("styles numeric, badge and total cells for the print table", () => {
    const tableSpec = {
      ...spec,
      sections: [
        {
          section_type: "DATA_TABLE",
          section_id: "table",
          title_i18n_key: "table.day",
          dataset_id: "rows",
          columns: [
            { field: "status", header_i18n_key: "table.day", format_hint: "BADGE", summary_footer: "NONE" },
            { field: "amount", header_i18n_key: "table.amount", align: "END", format_hint: "CURRENCY_MINOR", summary_footer: "LABEL_TOTAL" },
          ],
        },
      ],
    } as unknown as ReportDescriptorSpec;
    const tableBundle = {
      ...bundle,
      spec: tableSpec,
      datasets: { rows: [{ status: "PARTIALLY_REFUNDED", amount: 1234567 }] },
    } as unknown as ReportExecutionBundle;
    const html = renderReportSectionsToHtml({ bundle: tableBundle, locale: "en" });
    expect(html).toContain("report-badge--xlong");
    expect(html).toContain("report-cell-number");
    expect(html).toContain("report-cell-badge");
    expect(html).toContain("report-footer-label");
  });
});

describe("chrome accent band and variables", () => {
  it("renders a structured multi-color band, suppresses the simple border and formats chrome variables", () => {
    const chromeWithBand = {
      ...chrome,
      chrome: {
        ...chrome.chrome,
        border_style: "ACCENT_BAND",
        accent_band: {
          position: "BOTTOM",
          height_mm: 1.4,
          radius_mm: 0.6,
          segments: [
            { color: "#0b5d7a", width_percent: 58 },
            { color: "#2e8b57", width_percent: 26 },
            { color: "#e67e22", width_percent: 16 },
          ],
        },
      },
      template: {
        ...chrome.template,
        html: "<div style='height:100%'>{{periodSummary}} · {{defaultCurrency}} · {{generatedAtFormatted}}</div>",
      },
    } as unknown as ReportChromeSpec;
    const bundleWithVars = {
      ...bundle,
      currency: "LYD",
      executedAtIso: "2026-11-11T14:31:00.000Z",
      chromeVariables: { periodSummary: "2026-01-01 – 2026-10-31" },
    } as unknown as ReportExecutionBundle;
    const html = renderChromeHtml({ chrome: chromeWithBand, bundle: bundleWithVars, locale: "en" });
    expect(html).toContain("report-chrome-accent-band");
    expect(html).toContain("linear-gradient");
    expect(html).toContain("#0b5d7a");
    expect(html).toContain("#2e8b57");
    expect(html).toContain("#e67e22");
    expect(html).not.toContain("report-chrome-border-accent-band");
    expect(html).toContain("01 Jan 2026 – 31 Oct 2026");
    expect(html).toContain("LYD");
    expect(html).toContain("11 Nov 2026, 14:31");
  });
});
