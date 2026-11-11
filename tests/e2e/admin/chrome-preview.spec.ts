import { expect, test } from "@playwright/test";
import { adminSession, mockApi, seedSession } from "../fixtures";

const headerSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: "1.0",
  chrome: {
    code: "institutional-header-v1",
    name: "Institutional Header",
    chrome_type: "HEADER",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "NONE",
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
  required_assets: [],
  i18n: { default_locale: "en", locales: { en: {}, ar: {} } },
  template: {
    html: "<div class='test-header' style='height:100%;display:flex;align-items:center;justify-content:space-between;padding:0 4mm;box-sizing:border-box'><strong>Libyan National Payment Gateway</strong><span>{{periodSummary}} · {{defaultCurrency}}</span></div>",
    scoped_css: ".test-header{background:#fff;color:#0d3b66;border-inline-start:1.6mm solid #0b5d7a;padding-inline-start:3mm}",
    used_variables: ["periodSummary", "defaultCurrency"],
  },
};

const footerSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: "1.0",
  chrome: {
    code: "institutional-footer-v1",
    name: "Institutional Footer",
    chrome_type: "FOOTER",
    height_mm: 16,
    show_on_first_page: true,
    border_style: "NONE",
  },
  required_assets: [],
  i18n: { default_locale: "en", locales: { en: {}, ar: {} } },
  template: {
    html: "<div class='test-footer' style='height:100%;display:flex;align-items:center;justify-content:space-between;padding:0 4mm;box-sizing:border-box'><span>Libyan National Payment Gateway</span><span>Generated {{generatedAtFormatted}}</span></div>",
    scoped_css: ".test-footer{background:#0d3b66;color:#fff;border-top:0.9mm solid #e67e22}",
    used_variables: ["generatedAtFormatted"],
  },
};

test("chrome preview renders a full A4 page with header, footer and accent band", async ({ page }) => {
  const session = {
    ...adminSession,
    userInfo: {
      ...adminSession.userInfo,
      authoritiesMap: {
        ...adminSession.userInfo.authoritiesMap,
        "reports.studio": true,
        "report_engine:author": true,
      },
    },
  };
  await seedSession(page, "PAYMENT_GATEWAY:ADMIN:USER", session);
  await mockApi(page);
  await page.route("**/api/v1/admin/report-engine/chrome**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 2,
        specs: [
          { id: "header-1", code: "institutional-header-v1", version: 1, name: "Institutional Header", chromeType: "HEADER", status: "PUBLISHED", isDefaultGlobal: true, supportedLocales: ["en", "ar"], spec: headerSpec, assetDataUrls: {} },
          { id: "footer-1", code: "institutional-footer-v1", version: 1, name: "Institutional Footer", chromeType: "FOOTER", status: "PUBLISHED", isDefaultGlobal: true, supportedLocales: ["en", "ar"], spec: footerSpec, assetDataUrls: {} },
        ],
      }),
    }),
  );

  await page.goto("/reports/chrome");
  const preview = page.getByRole("button", { name: "Preview", exact: true }).first();
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await preview.click();
  const frame = page.frameLocator("iframe.report-sandboxed-surface");
  await expect(frame.locator(".chrome-preview-page")).toBeVisible({ timeout: 15_000 });
  await expect(frame.locator(".chrome-preview-header .report-chrome-accent-band")).toHaveCount(1);
  await expect(frame.locator(".chrome-preview-footer .test-footer")).toHaveCount(1);
  await expect(frame.locator(".chrome-preview-header")).toContainText("01 Jan 2026");
  await expect(frame.locator(".chrome-preview-header")).toContainText("LYD");
  await expect(frame.locator(".chrome-preview-footer")).toContainText("11 Nov 2026");
});
