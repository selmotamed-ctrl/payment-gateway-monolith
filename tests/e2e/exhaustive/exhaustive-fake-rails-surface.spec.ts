import { expect, test } from "@playwright/test";
import { noHorizontalOverflow } from "../fixtures";

const VIEWPORTS = [
  { width: 1440, height: 900, label: "desktop" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 390, height: 844, label: "phone" },
] as const;

const LOCALES = [
  { code: "en", dir: "ltr" },
  { code: "ar", dir: "rtl" },
] as const;

const THEMES = ["light", "dark"] as const;

test.describe("exhaustive fake-rails portal surface", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/portal-api/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rows: [],
          total: 0,
          totals: [],
          rails: [],
          scenarios: [],
          statements: [],
          deliveries: [],
          summary: { totals: [], rails: [], pendingActions: [] },
        }),
      }),
    );
    await page.route("**/hosted/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
    );
  });

  for (const viewport of VIEWPORTS) {
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        test(`/login · ${viewport.label} · ${locale.code} · ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.addInitScript(
            ([localeCode, themeName]) => {
              window.localStorage.setItem("locale-name", localeCode);
              window.localStorage.setItem("theme", themeName);
              window.localStorage.removeItem("fake-rails-token");
            },
            [locale.code, theme] as const,
          );
          await page.goto("/login");
          await expect(page.locator(".v-application").first()).toBeVisible();
          expect(
            await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform),
          ).toBe("none");
          expect(await noHorizontalOverflow(page)).toBe(true);
          // The fake-rails tester portal is a developer tool with a fixed
          // locale/theme; only the geometry and scaling invariants apply.
        });
      }
    }
  }
});
