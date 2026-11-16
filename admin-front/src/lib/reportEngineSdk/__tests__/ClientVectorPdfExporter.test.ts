import { describe, expect, it } from "vitest";
import { buildPagedMediaHtmlDocument } from "../print/ClientVectorPdfExporter";
import type { ReportExecutionBundle } from "../types/bundle";
import type { ReportDescriptorSpec } from "../types/reportSpec";

const spec = {
  spec_kind: "REPORT_DESCRIPTOR",
  spec_version: "1.0",
  report: { code: "ledger-statement", version: 1, category: "LEDGER", audience_scope: "INTERNAL", classification: "INTERNAL" },
  page_layout: {
    paper_size: "A4",
    orientation: "PORTRAIT",
    margins_mm: { top: 26, right: 14, bottom: 24, left: 14 },
    header_mode: "GLOBAL_DEFAULT",
    footer_mode: "GLOBAL_DEFAULT",
    allow_runtime_chrome_selection: true,
    global_scoped_css: ".x{color:#111827}",
  },
  required_assets: [],
  i18n: { default_locale: "en", prompt_user_when_multi_locale: true, locales: { en: { "report.title": "Ledger Statement" }, ar: { "report.title": "كشف الحساب" } } },
  inputs: [],
  datasets: [],
  transforms: [],
  sections: [],
} as unknown as ReportDescriptorSpec;

const bundle = {
  spec,
  executedAtIso: "2026-05-15T10:00:00.000Z",
  verificationSha256: "abcdef",
  actor: { id: "1", name: "Finance", email: "f@example.test", role: "FINANCE" },
  inputsUsed: {},
  datasets: {},
  assets: {},
  assetDataUrls: {},
} as unknown as ReportExecutionBundle;

describe("RE-T19: paged media document builder", () => {
  it("emits @page rules, running header/footer slots, repeated table headers and RTL direction", () => {
    const html = buildPagedMediaHtmlDocument({
      bundle,
      locale: "ar",
      renderedSectionsHtml: '<table class="report-data-table"><thead><tr><th>اليوم</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
      renderedHeaderHtml: "<div>header</div>",
      renderedFooterHtml: "<div>footer</div>",
      assetOrigin: "https://admin.test",
    });
    expect(html).toContain('<html lang="ar" dir="rtl" data-report-preview-theme="light">');
    expect(html).toContain("@page");
    expect(html).toContain("@top-center { content: element(report-running-header); }");
    expect(html).toContain("@bottom-center { content: element(report-running-footer); }");
    expect(html).toContain("display: table-header-group");
    expect(html).toContain("report-page-number::after { content: counter(page); }");
    expect(html).toContain('<header class="report-running-header">');
    expect(html).toContain('<footer class="report-running-footer">');
    expect(html).toContain("Report Arabic");
    // Paged.js resolves CSS url() values against about:srcdoc; report fonts
    // must therefore be absolute same-origin URLs.
    expect(html).toMatch(/src: url\("https?:\/\/[^"]+\/report-engine\/fonts\/plus-jakarta-sans-400-normal\.ttf"\)/);
    expect(html).not.toContain('url("/report-engine/fonts/');
  });

  it("renders a themed preview canvas with separated, centered paper pages", () => {
    const html = buildPagedMediaHtmlDocument({
      bundle,
      locale: "en",
      renderedSectionsHtml: "<p>Body</p>",
      renderedHeaderHtml: "",
      renderedFooterHtml: "",
      assetOrigin: "https://admin.test",
    });
    expect(html).toContain('data-report-preview-theme="light"');
    expect(html).toContain("--report-preview-canvas: #F1F5F9");
    expect(html).toContain("align-items: center");
    expect(html).toContain("gap: 24px; padding: 32px 20px");
    expect(html).toContain("border: 1px solid var(--report-preview-page-border)");
  });

  it("uses a dark preview canvas while keeping printed pages white", () => {
    const html = buildPagedMediaHtmlDocument({
      bundle,
      locale: "en",
      renderedSectionsHtml: "<p>Body</p>",
      renderedHeaderHtml: "",
      renderedFooterHtml: "",
      previewTheme: "dark",
      assetOrigin: "https://admin.test",
    });
    expect(html).toContain('data-report-preview-theme="dark"');
    expect(html).toContain("--report-preview-canvas: #18181C");
    expect(html).toContain("background: #FFFFFF");
    expect(html).toContain("border: 1px solid var(--report-preview-page-border)");
  });

  it("adds page-content vertical padding when a header and footer are rendered", () => {
    const html = buildPagedMediaHtmlDocument({
      bundle,
      locale: "en",
      renderedSectionsHtml: "<p>Body</p>",
      renderedHeaderHtml: "<div>Header</div>",
      renderedFooterHtml: "<div>Footer</div>",
      assetOrigin: "https://admin.test",
    });
    // 26mm top + 4mm comfort pad, 24mm bottom + 4mm comfort pad.
    expect(html).toContain("margin: 30mm 14mm 28mm 14mm;");
    expect(html).toContain('data-report-margin-top="30"');
    expect(html).toContain('data-report-margin-bottom="28"');
  });

  it("keeps the original page margins when no chrome is rendered", () => {
    const html = buildPagedMediaHtmlDocument({
      bundle,
      locale: "en",
      renderedSectionsHtml: "<p>Body</p>",
      renderedHeaderHtml: "",
      renderedFooterHtml: "",
      assetOrigin: "https://admin.test",
    });
    expect(html).toContain("margin: 26mm 14mm 24mm 14mm;");
    expect(html).toContain('data-report-margin-top="26"');
    expect(html).toContain('data-report-margin-bottom="24"');
  });

  it("restores the unpadded margin on a first page that hides the chrome", () => {
    const hiddenOnFirstPage = {
      ...bundle,
      resolvedHeaderChrome: { chrome: { show_on_first_page: false }, template: { scoped_css: "" } },
      resolvedFooterChrome: { chrome: { show_on_first_page: false }, template: { scoped_css: "" } },
    } as unknown as ReportExecutionBundle;
    const html = buildPagedMediaHtmlDocument({
      bundle: hiddenOnFirstPage,
      locale: "en",
      renderedSectionsHtml: "<p>Body</p>",
      renderedHeaderHtml: "<div>Header</div>",
      renderedFooterHtml: "<div>Footer</div>",
      assetOrigin: "https://admin.test",
    });
    expect(html).toContain("@page :first { margin-top: 26mm; @top-center { content: none; } }");
    expect(html).toContain("@page :first { margin-bottom: 24mm; @bottom-center { content: none; } }");
  });
});
