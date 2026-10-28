import { expect, test } from "@playwright/test";
import { merchantSession } from "../fixtures";

const catchAll = (page: import("@playwright/test").Page) =>
  page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

test("merchant login posts `identifier` (not `identity`) and lands on the portal", async ({ page }) => {
  await catchAll(page);
  let body: any = null;
  await page.route("**/api/v1/merchant/auth/login", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(merchantSession) });
  });

  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/login");
  await page.getByLabel("Phone Or Email").fill("acme@example.com");
  await page.getByLabel("Password").fill("DeployTest!2026");
  await page.getByRole("button", { name: "Login", exact: true }).click();

  await expect(page).toHaveURL(/\/portal\/dashboard/);
  expect(body).toMatchObject({ identifier: "acme@example.com" });
  expect(body.identity).toBeUndefined();
  expect(body.mfaCode).toBeUndefined();
});

test("merchant login shows the MFA step when the server asks for it", async ({ page }) => {
  await catchAll(page);
  await page.route("**/api/v1/merchant/auth/login", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mfaRequired: true, challengeId: "challenge-123456" }),
    }),
  );

  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/login");
  await page.getByLabel("Phone Or Email").fill("acme@example.com");
  await page.getByLabel("Password").fill("DeployTest!2026");
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page.getByLabel("Verification Code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify" })).toBeVisible();
});
