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
  await page.getByLabel("Email").fill("acme@example.com");
  await page.getByLabel("Password", { exact: true }).fill("DeployTest!2026");
  await page.getByRole("button", { name: "Login", exact: true }).click();

  await expect(page).toHaveURL(/\/portal\/dashboard/);
  expect(body).toMatchObject({ identifier: "acme@example.com" });
  expect(body.identity).toBeUndefined();
  expect(body.mfaCode).toBeUndefined();
});

test("merchant registration has no phone field and asks for email verification", async ({ page }) => {
  await catchAll(page);
  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/register");
  await expect(page.getByLabel("Full Name")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Phone")).toHaveCount(0);
  await expect(page.getByText("We will send a six-digit verification code to your email address.")).toBeVisible();
});

test("the merchant login shows maintenance when email delivery is not configured", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => {
    if (route.request().url().includes("/auth/me")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          platformName: "Payment Gateway",
          communication: {
            emailConfigured: false,
            smsConfigured: false,
            googleEnabled: false,
            registrationEnabled: false,
            passwordResetEnabled: false,
            maintenance: { active: true, code: "EMAIL_NOT_CONFIGURED", message: "Email delivery is not configured." },
          },
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/login");
  await expect(page.getByText("Platform under maintenance")).toBeVisible();
  await expect(page.getByText("Email delivery is not configured.")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
});

test("merchant login shows the MFA step when the server asks for it", async ({ page }) => {
  await catchAll(page);
  await page.route("**/api/v1/merchant/auth/login", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mfaRequired: true, challengeId: "challenge-123456", deliveryChannels: ["EMAIL"] }),
    }),
  );

  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/login");
  await page.getByLabel("Email").fill("acme@example.com");
  await page.getByLabel("Password", { exact: true }).fill("DeployTest!2026");
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page.getByLabel("Verification Code")).toBeVisible();
  await expect(page.getByText("Enter the six-digit code sent to your email.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify" })).toBeVisible();
});
