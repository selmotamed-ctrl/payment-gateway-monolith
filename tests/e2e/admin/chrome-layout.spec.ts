import { expect, test } from "@playwright/test";

/**
 * Chrome layout gate: renders the published default header/footer on a real
 * A4 page frame (the same composition the report and Chrome Studio preview use)
 * and checks slot fill, accent band, offsets and localized variables.
 */

const API = process.env.PG_API_URL ?? "http://127.0.0.1:4101";
const USER = process.env.PG_ADMIN_IDENTIFIER ?? "admin@pg.dev";
const PASS = process.env.PG_ADMIN_PASSWORD ?? "Mayallahhelpme@96";

async function token(request: import("@playwright/test").APIRequestContext): Promise<string> {
  if (process.env.PG_TOKEN) return process.env.PG_TOKEN;
  const response = await request.post(`${API}/api/v1/admin/auth/login`, {
    data: { identifier: USER, password: PASS },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

test("default chrome fills its slot and renders the multi-color band", async ({ page, request }) => {
  const auth = await token(request);
  const list = await request.get(`${API}/api/v1/admin/report-engine/chrome`, {
    headers: { authorization: `Bearer ${auth}` },
    params: { includeAssets: 1, pageSize: 200 },
  });
  expect(list.ok(), await list.text()).toBeTruthy();
  const specs = (await list.json()).specs as Array<any>;
  const header = specs.find((row) => row.isDefaultGlobal && row.chromeType === "HEADER");
  const footer = specs.find((row) => row.isDefaultGlobal && row.chromeType === "FOOTER");
  expect(header?.spec?.chrome?.accent_band).toBeTruthy();
  expect(footer?.spec).toBeTruthy();

  const bundle = {
    executionId: "chrome-layout-test",
    executedAtIso: "2026-11-11T14:31:00.000Z",
    verificationSha256: "7f3c9a2e18d4b7f0c1a2e3d4b5c6a7f8",
    spec: {
      spec_kind: "REPORT_DESCRIPTOR",
      spec_version: "1.0",
      report: { code: "platform-assurance-command-report", version: 1, category: "OPERATIONS_SUPPORT", audience_scope: "BACKOFFICE_INTERNAL", classification: "INTERNAL" },
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
          en: {
            "report.title": "Platform Assurance Command Report",
            "report.subtitle": "Payments, rails, reconciliation, compliance and security",
          },
          ar: {
            "report.title": "تقرير قيادة ضمان المنصة",
            "report.subtitle": "المدفوعات والمسارات والمطابقة والامتثال والأمن",
          },
        },
      },
      inputs: [],
      datasets: [],
      sections: [],
    },
    resolvedHeaderChrome: header.spec,
    resolvedFooterChrome: footer.spec,
    datasets: {},
    assetDataUrls: { ...(header.assetDataUrls ?? {}), ...(footer.assetDataUrls ?? {}) },
    actor: { name: "Salem A.", email: "salem@example.test", role: "GATEWAY_ADMIN" },
    institutionName: "Libyan National Payment Gateway",
    chromeVariables: { periodSummary: "2026-01-01 – 2026-10-31" },
    currency: "LYD",
    inputsUsed: {},
    rowCountTotal: 0,
    durationMs: 0,
    servedByNode: "chrome-layout-test",
  };

  await page.addInitScript(() => localStorage.setItem("locale-name", "en"));
  await page.goto("http://127.0.0.1:5101/");
  const result = await page.evaluate(async (bundle) => {
    const renderer: any = await import("/src/lib/reportEngineSdk/render/reportHtmlRenderer.ts");
    const headerHtml = renderer.renderChromeHtml({ chrome: bundle.resolvedHeaderChrome, bundle, locale: "en" });
    const footerHtml = renderer.renderChromeHtml({ chrome: bundle.resolvedFooterChrome, bundle, locale: "en" });
    const style = document.createElement("style");
    style.textContent = `
      ${bundle.resolvedHeaderChrome.template.scoped_css}
      ${bundle.resolvedFooterChrome.template.scoped_css}
      .cp-page { position: fixed; left: -10000px; top: 0; width: 210mm; height: 297mm; background: #fff; font-family: Arial, sans-serif; }
      .cp-header { position: absolute; top: 2mm; left: 14mm; right: 14mm; height: 22mm; }
      .cp-footer { position: absolute; bottom: 4mm; left: 14mm; right: 14mm; height: 16mm; }
      .cp-body { position: absolute; top: 26mm; left: 14mm; right: 14mm; bottom: 24mm; }
      .report-chrome { display: flex; flex-direction: column; position: relative; box-sizing: border-box; height: 100%; min-width: 0; max-width: 100%; }
      .report-chrome > :first-child { flex: 1 1 auto; min-height: 0; }
      .report-chrome-accent-band { pointer-events: none; z-index: 2; }
    `;
    const pageElement = document.createElement("div");
    pageElement.className = "cp-page";
    pageElement.innerHTML = `<div class="cp-header">${headerHtml}</div><div class="cp-body"></div><div class="cp-footer">${footerHtml}</div>`;
    document.head.appendChild(style);
    document.body.appendChild(pageElement);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const header = pageElement.querySelector(".cp-header .report-chrome-header") as HTMLElement;
    const headerRoot = header?.querySelector(".lnpg-header") as HTMLElement;
    const brand = header?.querySelector(".lnpg-header .brand") as HTMLElement;
    const meta = header?.querySelector(".lnpg-header .meta") as HTMLElement;
    const footer = pageElement.querySelector(".cp-footer .report-chrome-footer") as HTMLElement;
    const footerRoot = footer?.querySelector(".lnpg-footer") as HTMLElement;
    const band = header?.querySelector(".report-chrome-accent-band") as HTMLElement;
    const rect = (element: HTMLElement | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const bandStyle = band ? getComputedStyle(band) : null;
    const headerRect = rect(header);
    const pageRect = rect(pageElement);
    const footerRect = rect(footer);
    const result = {
      header: headerRect,
      headerRoot: rect(headerRoot),
      brand: rect(brand),
      meta: rect(meta),
      footer: footerRect,
      footerRoot: rect(footerRoot),
      page: pageRect,
      band: band
        ? {
            rect: rect(band),
            background: bandStyle?.backgroundImage ?? "",
            radius: bandStyle?.borderRadius ?? "",
            bottom: bandStyle?.bottom ?? "",
          }
        : null,
      headerText: headerRoot?.textContent ?? "",
      footerText: footerRoot?.textContent ?? "",
      headerClasses: header?.className ?? "",
    };
    pageElement.remove();
    style.remove();
    return result;
  }, bundle);

  expect(result.header).toBeTruthy();
  expect(result.headerRoot).toBeTruthy();
  expect(result.headerRoot!.height).toBeGreaterThan(result.header!.height * 0.95);
  expect(result.brand!.height).toBeGreaterThan(result.headerRoot!.height * 0.8);
  expect(result.meta!.height).toBeGreaterThan(result.headerRoot!.height * 0.8);
  expect(result.footerRoot!.height).toBeGreaterThan(result.footer!.height * 0.95);
  expect(result.band).toBeTruthy();
  expect(result.band!.background).toContain("linear-gradient");
  expect(result.band!.background).toContain("rgb(11, 93, 122)");
  expect(result.band!.background).toContain("rgb(46, 139, 87)");
  expect(result.band!.background).toContain("rgb(230, 126, 34)");
  expect(result.band!.rect!.height).toBeGreaterThan(4);
  expect(result.band!.bottom).toBe("0px");
  expect(result.headerClasses).not.toContain("report-chrome-border-accent-band");
  expect(result.page!.bottom - result.header!.bottom).toBeGreaterThan(0);
  expect(result.header!.top).toBeGreaterThan(6);
  expect(result.header!.top).toBeLessThan(9);
  expect(result.page!.bottom - result.footer!.bottom).toBeGreaterThan(12);
  expect(result.page!.bottom - result.footer!.bottom).toBeLessThan(18);
  expect(result.headerText).toContain("01 Jan 2026 – 31 Oct 2026");
  expect(result.headerText).toContain("LYD");
  expect(result.footerText).toContain("11 Nov 2026, 14:31");
});
