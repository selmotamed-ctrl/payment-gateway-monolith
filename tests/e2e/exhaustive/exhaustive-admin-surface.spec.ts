import { expect, test } from "@playwright/test";
import {
  ADMIN_KEY,
  adminSession,
  mockApi,
  noHorizontalOverflow,
} from "../fixtures";

const ROUTES = [
  "/dashboard",
  "/join-requests",
  "/kyb",
  "/merchants",
  "/approvals",
  "/aml/cases",
  "/aml/screenings",
  "/aml/rules",
  "/aml/reports",
  "/operator-cases",
  "/disputes",
  "/adjustments",
  "/cashouts",
  "/reconciliation",
  "/finance/profitability",
  "/finance/liquidity",
  "/finance/invariant",
  "/gateways",
  "/gateways/ai-import",
  "/rails",
  "/routes",
  "/guide",
  "/academy",
  "/settings/checkout-help",
] as const;

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

test.describe("exhaustive admin surface", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([key, session]) => {
        window.localStorage.setItem(key, JSON.stringify(session));
      },
      [ADMIN_KEY, adminSession] as const,
    );
    await mockApi(page);
  });

  for (const viewport of VIEWPORTS) {
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        for (const route of ROUTES) {
          test(`${route} · ${viewport.label} · ${locale.code} · ${theme}`, async ({ page }) => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.addInitScript(
              ([localeCode, themeName]) => {
                window.localStorage.setItem("locale-name", localeCode);
                window.localStorage.setItem("theme", themeName);
              },
              [locale.code, theme] as const,
            );
            await page.goto(route);
            await expect(page.locator(".pg-page").first()).toBeVisible();

            // The global scaling transform must never regress.
            const transform = await page.evaluate(
              () => getComputedStyle(document.getElementById("app")!).transform,
            );
            expect(transform).toBe("none");

            // Zero unintended horizontal overflow.
            expect(await noHorizontalOverflow(page)).toBe(true);

            // The app bar never overlaps the page content.
            const bar = await page.locator(".pg-app-bar").boundingBox();
            const content = await page.locator(".pg-page").first().boundingBox();
            expect(bar).not.toBeNull();
            expect(content).not.toBeNull();
            expect(content!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);

            // The language switch drives the document direction.
            const dir = await page.evaluate(() => document.documentElement.dir);
            expect(dir).toBe(locale.dir);

            // The theme switch is reflected on the application root.
            const application = page.locator(".v-application").first();
            if (theme === "dark") {
              await expect(application).toHaveClass(/v-theme--dark/);
            } else {
              await expect(application).not.toHaveClass(/v-theme--dark/);
            }
          });
        }
      }
    }
  }
});
