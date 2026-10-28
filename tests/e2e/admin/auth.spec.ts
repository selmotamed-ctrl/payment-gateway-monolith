import { expect, test } from "@playwright/test";
import { adminSession } from "../fixtures";

const catchAll = (page: import("@playwright/test").Page) =>
  page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

test("admin login posts `identifier` (not `username`) and lands on the dashboard", async ({ page }) => {
  await catchAll(page);
  let body: any = null;
  await page.route("**/api/v1/admin/auth/login", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(adminSession) });
  });

  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("admin@pgtest.lan");
  await page.getByLabel("Password").fill("DeployTest!2026");
  await page.getByRole("button", { name: "Login", exact: true }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  expect(body).toMatchObject({ identifier: "admin@pgtest.lan" });
  expect(body.username).toBeUndefined();
  const stored = await page.evaluate(() => localStorage.getItem("PAYMENT_GATEWAY:ADMIN:USER"));
  expect(JSON.parse(stored!).userInfo.role).toBe("GATEWAY_ADMIN");
});

test("admin login surfaces a validation error and stays on the login page", async ({ page }) => {
  await catchAll(page);
  await page.route("**/api/v1/admin/auth/login", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ code: "VALIDATION_FAILED", message: "Request payload failed validation" }),
    }),
  );

  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("admin@pgtest.lan");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page.locator(".v-alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  const stored = await page.evaluate(() => localStorage.getItem("PAYMENT_GATEWAY:ADMIN:USER"));
  expect(stored).toBeNull();
});
