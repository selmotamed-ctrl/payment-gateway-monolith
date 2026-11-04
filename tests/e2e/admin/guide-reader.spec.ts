import { expect, test } from "@playwright/test";
import {
  ADMIN_KEY,
  adminSession,
  mockApi,
  noHorizontalOverflow,
  seedSession,
} from "../fixtures";

test.describe("admin guide reader", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    await mockApi(page);
  });

  test("searches, reads, uses the glossary by keyboard and persists read state", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/guide");
    await expect(page.getByRole("heading", { name: "Interactive Guide" })).toBeVisible();

    await page.getByRole("button", { name: "Search the guide" }).click();
    const search = page.getByRole("combobox", { name: /Search the guide/ });
    await expect(search).toBeVisible();
    await search.fill("UNKNOWN");
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/guide\/(a|glossary)\//);

    await page.goto("/guide/a/b07-03");
    await expect(page.locator(".guide-markdown").first()).toBeVisible();
    const term = page.locator(".gl-term").first();
    await expect(term).toBeVisible();
    await term.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("button", { name: /Mark as read/ }).first().click();
    await expect(page.getByRole("button", { name: /Marked as read/ }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: /Marked as read/ }).first()).toBeVisible();
  });

  test("never overflows horizontally at phone and desktop widths", async ({ page }) => {
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/guide");
      await expect(page.getByRole("heading", { name: "Interactive Guide" })).toBeVisible();
      expect(await noHorizontalOverflow(page), `overflow at ${width}px`).toBe(true);
    }
  });

  test("Arabic RTL renders without horizontal overlap", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("locale-name", "ar"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/guide");
    await expect(page.locator(".guide-home")).toBeVisible();
    const direction = await page.evaluate(() => document.documentElement.dir);
    expect(direction).toBe("rtl");
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.screenshot({ path: "test-results/guide-ar-rtl.png", fullPage: false });
  });
});
