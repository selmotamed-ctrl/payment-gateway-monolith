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
    expect(html).toContain('<html lang="ar" dir="rtl">');
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
});
