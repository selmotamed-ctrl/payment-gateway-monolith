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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.route("**/api/v1/pay/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) }),
  );
});

test("the payer surface renders and is not transformed", async ({ page }) => {
  await page.goto("/pay/test-key");
  await expect(page.locator(".pg-checkout")).toBeVisible();
  const transform = await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform);
  expect(transform).toBe("none");
});

test("the payer surface has no horizontal overflow on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pay/test-key");
  await expect(page.locator(".pg-checkout")).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test("the payer surface has no horizontal overflow on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pay/test-key");
  await expect(page.locator(".pg-checkout")).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});
