import { expect, test } from "@playwright/test";
import { MERCHANT_KEY, geometry, merchantSession, mockApi, noHorizontalOverflow, seedSession } from "../fixtures";

test.describe("merchant shell", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, MERCHANT_KEY, merchantSession);
    await mockApi(page);
  });

  test("the app bar never overlaps the page content", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/portal/dashboard");
    await expect(page.locator(".pg-page")).toBeVisible();
    const { bar, content } = await geometry(page);
    expect(content!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test("the drawer is permanent on desktop and bound to the hamburger", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/portal/dashboard");
    const before = await page.locator(".pg-drawer").boundingBox();
    expect(before).not.toBeNull();

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
    const collapsed = await page.locator(".pg-drawer").boundingBox();
    expect(collapsed === null || collapsed.x <= -250).toBe(true);

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
    expect((await page.locator(".pg-drawer").boundingBox())!.x).toBeLessThanOrEqual(2);
  });

  test("mobile drawer starts closed and closes after navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portal/dashboard");
    const closed = await page.locator(".pg-drawer").boundingBox();
    expect(closed === null || closed.x <= -250).toBe(true);

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
    expect((await page.locator(".pg-drawer").boundingBox())!.x).toBeGreaterThanOrEqual(0);

    await page.locator(".pg-drawer a", { hasText: "Wallets" }).first().click();
    await page.waitForTimeout(500);
    const after = await page.locator(".pg-drawer").boundingBox();
    expect(after === null || after.x <= -250).toBe(true);
  });

  test("every navigation destination renders", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/portal/dashboard");
    const items = page.locator(".pg-drawer a");
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    expect(count).toBeGreaterThan(4);
    for (let index = 0; index < count; index += 1) {
      const name = (await items.nth(index).innerText()).trim();
      await items.nth(index).click();
      await page.waitForTimeout(150);
      await expect(page.locator(".pg-page"), `page for "${name}"`).toBeVisible();
    }
  });

  test("has no horizontal overflow at every breakpoint", async ({ page }) => {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/portal/dashboard");
      await expect(page.locator(".pg-page")).toBeVisible();
      expect(await noHorizontalOverflow(page), `overflow at ${width}px`).toBe(true);
    }
  });

  test("the navigation labels re-translate when the locale changes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/portal/dashboard");
    await expect(page.locator(".pg-drawer").getByText("Dashboard", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Language" }).click();
    await page.getByText("العربية", { exact: true }).click();
    await page.waitForTimeout(500);
    await expect(page.locator(".pg-drawer").getByText("لوحة التحكم", { exact: true })).toBeVisible();
  });

  test("no global scaling transform remains", async ({ page }) => {
    await page.goto("/portal/dashboard");
    const transform = await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform);
    expect(transform).toBe("none");
  });
});
