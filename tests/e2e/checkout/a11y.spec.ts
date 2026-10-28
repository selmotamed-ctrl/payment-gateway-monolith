import { expect, test } from "@playwright/test";

test("checkout: images have alt text", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.route("**/api/v1/pay/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ visibleRails: [] }) }),
  );
  await page.goto("/pay/test-key");
  await expect(page.locator(".pg-checkout")).toBeVisible();
  const missing = await page.locator("img:not([alt])").count();
  expect(missing).toBe(0);
});
