import { describe, expect, test } from "bun:test";
import { createReportEngine } from "../../lib/reportEngineSdk";
import type { ReportChromeRegistryEntry } from "../../lib/reportEngineSdk";
import { baseChromeSpec, baseReportSpec, createTestHostConfig } from "./helpers";

describe("RE-T17: chrome resolution", () => {
  const header = baseChromeSpec("HEADER", "institutional-header-v1");
  const footer = baseChromeSpec("FOOTER", "institutional-footer-v1");
  const registry: ReportChromeRegistryEntry[] = [
    { spec: header, status: "PUBLISHED", isDefaultGlobal: true },
    { spec: footer, status: "PUBLISHED", isDefaultGlobal: true },
  ];

  test("GLOBAL_DEFAULT resolves the published default per type; NONE resolves nothing", () => {
    const engine = createReportEngine(createTestHostConfig());
    const spec = baseReportSpec();
    spec.page_layout.header_mode = "GLOBAL_DEFAULT";
    spec.page_layout.footer_mode = "NONE";
    const resolved = engine.resolveChrome({ spec, chromeRegistry: registry });
    expect(resolved.header?.chrome.code).toBe("institutional-header-v1");
    expect(resolved.footer).toBeNull();
  });

  test("SPECIFIC_CHROME_CODE resolves the requested published chrome", () => {
    const engine = createReportEngine(createTestHostConfig());
    const spec = baseReportSpec();
    spec.page_layout.header_mode = "NONE";
    spec.page_layout.footer_mode = "NONE";
    const resolved = engine.resolveChrome({
      spec,
      chromeRegistry: registry,
      override: { footerMode: "SPECIFIC_CHROME_CODE", footerChromeCode: "institutional-footer-v1" },
    });
    expect(resolved.header).toBeNull();
    expect(resolved.footer?.chrome.code).toBe("institutional-footer-v1");
  });

  test("INLINE_SPEC wraps the report's inline template", () => {
    const engine = createReportEngine(createTestHostConfig());
    const spec = baseReportSpec();
    spec.page_layout.header_mode = "INLINE_SPEC";
    spec.page_layout.inline_header_spec = {
      html: "<div>Inline header</div>",
      scoped_css: "",
      used_variables: [],
    };
    const resolved = engine.resolveChrome({ spec, chromeRegistry: [] });
    expect(resolved.header?.chrome.code).toBe("inline-header");
    expect(resolved.header?.template.html).toContain("Inline header");
  });
});
