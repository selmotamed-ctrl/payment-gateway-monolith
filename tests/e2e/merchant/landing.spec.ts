import { expect, test, type Page } from "@playwright/test";

/**
 * Public merchant landing page (`/`, route `Landing`). No session and no API are
 * needed: the page is static and must render fully for visitors.
 */

const setLocale = async (page: Page, locale: "ar" | "en", theme: "light" | "dark" = "light") => {
  await page.addInitScript(
    ([l, th]) => {
      localStorage.setItem("locale-name", l);
      localStorage.setItem("theme", th);
    },
    [locale, theme] as const,
  );
};

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("landing: one h1, semantic sections and CTAs that route to real pages", async ({ page }) => {
  await setLocale(page, "en");
  await page.goto("/");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toContainText("Collect on any rail.");
  expect(await page.locator("main").count()).toBe(1);
  for (const id of ["pgl-flow", "pgl-product", "pgl-developers", "pgl-security", "pgl-onboarding", "pgl-faq"]) {
    await expect(page.locator(`#${id} h2`)).toHaveCount(1);
  }

  const hero = page.locator(".pgl-hero");
  await expect(hero.getByRole("link", { name: "Create a merchant account" })).toHaveAttribute("href", "/register");
  await expect(hero.getByRole("link", { name: "Sign in to the portal" })).toHaveAttribute("href", "/login");
  await expect(page.locator(".pgl-header").getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/register");
  await expect(page.locator(".pgl-footer").getByRole("link", { name: "Developer guide" })).toHaveAttribute(
    "href",
    "/portal/guide/developers",
  );

  // No nested interactive elements (a > button) — the old page wrapped VBtn in RouterLink.
  expect(await page.locator("a button, button a").count()).toBe(0);
  expect(await page.locator("img:not([alt])").count()).toBe(0);

  await hero.getByRole("link", { name: "Create a merchant account" }).click();
  await expect(page).toHaveURL(/\/register$/);
});

test("landing: Arabic is RTL, translated and has no horizontal overflow at 360px", async ({ page }) => {
  await setLocale(page, "ar");
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("h1")).toContainText("حصِّل عبر أي قناة دفع");
  await page.locator("#pgl-faq").scrollIntoViewIfNeeded();
  await page.locator("#pgl-developers").scrollIntoViewIfNeeded();
  await expect(page.locator(".pgl-code")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("landing: language and theme toggles work without reload", async ({ page }) => {
  await setLocale(page, "en");
  await page.goto("/");
  await page.locator(".pgl-lang button[lang='ar']").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("h1")).toContainText("وطابِق كل دينار");
  await page.getByRole("button", { name: "المظهر" }).click();
  await page.getByText("داكن", { exact: true }).click();
  await expect(page.locator(".v-theme--dark").first()).toBeVisible();
});

test("landing: hero simulator is operable by keyboard and the fee preview is decimal-exact", async ({ page }) => {
  await setLocale(page, "en");
  await page.goto("/");
  const demo = page.locator(".pgl-demo");
  await demo.getByRole("button", { name: "Pause simulation" }).click();
  await demo.getByRole("button", { name: "Scan QR" }).focus();
  await page.keyboard.press("Enter");
  await expect(demo.getByRole("button", { name: "Scan QR" })).toHaveAttribute("aria-pressed", "true");
  await expect(demo.locator(".pgl-demo__qr")).toBeVisible();

  const fees = page.locator(".pgl-fee");
  await fees.getByLabel("Sale amount (LYD)").fill("100");
  await fees.getByLabel("Example commission %").fill("3");
  await fees.getByRole("tab", { name: "Payer pays" }).click();
  await expect(fees.locator(".pgl-fee__result")).toContainText("103.000 LYD");
  await expect(fees.locator(".pgl-fee__net")).toContainText("100.000 LYD");
});

test("landing: reduced motion shows the final state with no autoplay and nothing hidden", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setLocale(page, "en");
  await page.goto("/");
  const demo = page.locator(".pgl-demo");
  await expect(demo).toHaveAttribute("data-step", "4");
  await expect(demo.getByRole("button", { name: "Play simulation" })).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(demo).toHaveAttribute("data-step", "4");
  await expect(page.locator(".pgl-root")).toHaveAttribute("data-motion", "off");
  // Every reveal target is fully opaque without scrolling.
  const hidden = await page
    .locator("[data-reveal]")
    .evaluateAll((els) => els.filter((el) => getComputedStyle(el).opacity !== "1").length);
  expect(hidden).toBe(0);
});
