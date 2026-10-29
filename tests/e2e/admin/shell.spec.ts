import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, geometry, mockApi, noHorizontalOverflow, seedSession } from "../fixtures";

test.describe("admin shell", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    await mockApi(page);
  });

  test("the app bar never overlaps the page content on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await expect(page.locator(".pg-page")).toBeVisible();

    const { bar, content } = await geometry(page);
    expect(bar).not.toBeNull();
    expect(content).not.toBeNull();
    expect(content!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test("the permanent drawer sits beside the content, not over it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    const { drawer, content } = await geometry(page);
    expect(drawer).not.toBeNull();
    expect(drawer!.width).toBeGreaterThan(250);
    expect(drawer!.width).toBeLessThan(320);
    // The test seeds English (LTR): the drawer is on the left, content right of it.
    expect(drawer!.x).toBeLessThanOrEqual(2);
    expect(content!.x).toBeGreaterThanOrEqual(drawer!.width - 1);
  });

  test("the hamburger collapses and restores the drawer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    const before = await page.locator(".pg-drawer").boundingBox();
    expect(before!.x).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
    const collapsed = await page.locator(".pg-drawer").boundingBox();
    expect(collapsed === null || collapsed.x <= -250).toBe(true);

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
    const restored = await page.locator(".pg-drawer").boundingBox();
    expect(restored!.x).toBeLessThanOrEqual(2);
  });

  test("on a phone the drawer starts closed, opens, and closes after navigating", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(page.locator(".pg-page")).toBeVisible();

    const closed = await page.locator(".pg-drawer").boundingBox();
    expect(closed === null || closed.x <= -250).toBe(true);

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.waitForTimeout(400);
    const opened = await page.locator(".pg-drawer").boundingBox();
    expect(opened).not.toBeNull();
    expect(opened!.x).toBeGreaterThanOrEqual(0);

    await page.locator(".pg-drawer a", { hasText: "Gateways" }).first().click();
    await page.waitForTimeout(500);
    const afterNav = await page.locator(".pg-drawer").boundingBox();
    expect(afterNav === null || afterNav.x <= -250).toBe(true);
    await expect(page.locator(".pg-page")).toBeVisible();
  });

  test("switching to Arabic flips the layout to RTL and moves the drawer to the right", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");

    await page.getByRole("button", { name: "Language" }).click();
    await page.getByText("العربية", { exact: true }).click();
    await page.waitForTimeout(400);

    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    const drawer = await page.locator(".pg-drawer").boundingBox();
    expect(drawer!.x + drawer!.width).toBeGreaterThanOrEqual(1440 - 2);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test("the theme toggle switches the application to dark", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator(".v-application")).not.toHaveClass(/v-theme--dark/);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(page.locator(".v-application")).toHaveClass(/v-theme--dark/);
  });

  test("every navigation destination renders a page below the bar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    const items = page.locator(".pg-drawer a");
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    expect(count).toBeGreaterThan(5);

    for (let index = 0; index < count; index += 1) {
      const name = (await items.nth(index).innerText()).trim();
      await items.nth(index).click();
      await page.waitForTimeout(150);
      await expect(page.locator(".pg-page"), `page for "${name}"`).toBeVisible();
      const { bar, content } = await geometry(page);
      expect(content!.y, `content offset for "${name}"`).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
      expect(await noHorizontalOverflow(page), `overflow for "${name}"`).toBe(true);
    }
  });

  test("has no horizontal overflow at every breakpoint", async ({ page }) => {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/dashboard");
      await expect(page.locator(".pg-page")).toBeVisible();
      expect(await noHorizontalOverflow(page), `overflow at ${width}px`).toBe(true);
    }
  });

  test("hides navigation sections that have no visible routes", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem("locale-name", "en");
        window.localStorage.setItem(key, JSON.stringify(value));
      },
      [
        ADMIN_KEY,
        {
          ...adminSession,
          userInfo: { ...adminSession.userInfo, authoritiesMap: { "gateways.edit": true } },
        },
      ] as const,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await expect(page.locator(".pg-drawer a", { hasText: "Gateways" }).first()).toBeVisible();
    await expect(page.locator(".pg-drawer .v-list-subheader", { hasText: "Onboarding" })).toHaveCount(0);
    await expect(page.locator(".pg-drawer .v-list-subheader", { hasText: "Finance" })).toHaveCount(0);
  });

  test("a GATEWAY_ADMIN does not see Operator Cases or Disputes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await expect(page.locator(".pg-drawer a").first()).toBeVisible();
    await expect(page.locator(".pg-drawer a", { hasText: "Operator Cases" })).toHaveCount(0);
    await expect(page.locator(".pg-drawer a", { hasText: "Disputes" })).toHaveCount(0);
  });

  test("an operator with case:read sees Operator Cases but not Disputes", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem("locale-name", "en");
        window.localStorage.setItem(key, JSON.stringify(value));
      },
      [ADMIN_KEY, { ...adminSession, userInfo: { ...adminSession.userInfo, authoritiesMap: { "case:read": true } } }] as const,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await expect(page.locator(".pg-drawer a", { hasText: "Operator Cases" })).toBeVisible();
    await expect(page.locator(".pg-drawer a", { hasText: "Disputes" })).toHaveCount(0);
  });

  test("a finance user with dispute:read sees Disputes but not Operator Cases", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem("locale-name", "en");
        window.localStorage.setItem(key, JSON.stringify(value));
      },
      [ADMIN_KEY, { ...adminSession, userInfo: { ...adminSession.userInfo, authoritiesMap: { "dispute:read": true } } }] as const,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await expect(page.locator(".pg-drawer a", { hasText: "Disputes" })).toBeVisible();
    await expect(page.locator(".pg-drawer a", { hasText: "Operator Cases" })).toHaveCount(0);
  });

  test("direct access to a page the role cannot use is redirected", async ({ page }) => {
    await page.goto("/disputes");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("the navigation labels re-translate when the locale changes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await expect(page.locator(".pg-drawer").getByText("Dashboard", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Language" }).click();
    await page.getByText("العربية", { exact: true }).click();
    await page.waitForTimeout(500);

    // The sidebar and the app-bar title switch without a reload.
    await expect(page.locator(".pg-drawer").getByText("لوحة التحكم", { exact: true })).toBeVisible();
    await expect(page.locator(".pg-app-bar__title")).toHaveText("لوحة التحكم");
    await expect(page.locator(".pg-drawer").getByText("Dashboard", { exact: true })).toHaveCount(0);
  });

  test("the global scaling regression is gone (#app is not transformed)", async ({ page }) => {
    await page.goto("/dashboard");
    const transform = await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform);
    expect(transform).toBe("none");
    const spacing = await page.evaluate(() => getComputedStyle(document.body).letterSpacing);
    expect(["normal", "0px"]).toContain(spacing);
  });
});
