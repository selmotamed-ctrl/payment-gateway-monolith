import { expect, test } from "@playwright/test";
import { noHorizontalOverflow } from "../fixtures";

const summary = {
  summary: {
    linkKey: "test-key",
    merchantName: "Acme Store",
    merchantTradeName: "Acme Store",
    amount: "10.0000",
    currency: "LYD",
    description: "Test payment",
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    visibleRails: [],
    supportConfig: { enabled: false },
  },
};

const VIEWPORTS = [
  { width: 1440, height: 900, label: "desktop" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 390, height: 844, label: "phone" },
] as const;

const LOCALES = [
  { code: "en", dir: "ltr" },
  { code: "ar", dir: "rtl" },
] as const;

const THEMES = ["light"] as const;

test.describe("exhaustive checkout surface", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/v1/pay/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) }),
    );
  });

  for (const viewport of VIEWPORTS) {
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        test(`/pay/test-key · ${viewport.label} · ${locale.code} · ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.addInitScript(
            ([localeCode, themeName]) => {
              window.localStorage.setItem("locale-name", localeCode);
              window.localStorage.setItem("theme", themeName);
            },
            [locale.code, theme] as const,
          );
          await page.goto("/pay/test-key");
          await expect(page.locator(".pg-checkout")).toBeVisible();

          expect(
            await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform),
          ).toBe("none");
          expect(await noHorizontalOverflow(page)).toBe(true);

          const dir = await page.evaluate(() => document.documentElement.dir);
          expect(dir).toBe(locale.dir);

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
});
