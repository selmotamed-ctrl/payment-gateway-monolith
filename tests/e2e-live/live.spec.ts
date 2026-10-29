import { expect, test, type Page } from "@playwright/test";

const ADMIN = process.env.PG_ADMIN_URL ?? "https://192.168.1.222:8443";
const MERCHANT = process.env.PG_MERCHANT_URL ?? "https://192.168.1.222:8081";
const CHECKOUT = process.env.PG_CHECKOUT_URL ?? "https://192.168.1.222:8082";
const ADMIN_EMAIL = process.env.PG_ADMIN_EMAIL ?? "gateway-admin@payment-gateway.internal";
const MERCHANT_EMAIL = process.env.PG_MERCHANT_EMAIL ?? "merchant@pgtest.lan";
const PASSWORD = process.env.PG_PASSWORD ?? "DeployTest!2026";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
});

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

const assertShell = async (page: Page) => {
  await expect(page.locator(".pg-page").first()).toBeVisible();
  const bar = await page.locator(".pg-app-bar").boundingBox();
  const content = await page.locator(".pg-page").first().boundingBox();
  expect(bar).not.toBeNull();
  expect(content).not.toBeNull();
  expect(content!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
  expect(await noOverflow(page)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform)).toBe("none");
};

test("live admin: login, dashboard loads below the bar, no scaling transform", async ({ page }) => {
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Email or phone").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await assertShell(page);
  // A GATEWAY_ADMIN must not be offered pages its role cannot use.
  await expect(page.locator(".pg-drawer a", { hasText: "Operator Cases" })).toHaveCount(0);
  await expect(page.locator(".pg-drawer a", { hasText: "Disputes" })).toHaveCount(0);
});

test("live finance: Disputes is offered and loads", async ({ page }) => {
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Email or phone").fill(process.env.PG_FINANCE_EMAIL ?? "finance@payment-gateway.internal");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  const disputes = page.locator(".pg-drawer a", { hasText: "Disputes" });
  await expect(disputes).toBeVisible();
  await disputes.click();
  await expect(page).toHaveURL(/\/disputes/);
  await expect(page.locator(".pg-page")).toBeVisible();
  await expect(page.locator(".pg-app-bar__title")).toHaveText("Disputes");
});

test("live merchant: login, portal loads below the bar, no scaling transform", async ({ page }) => {
  await page.goto(`${MERCHANT}/login`);
  await page.getByLabel("Phone Or Email").fill(MERCHANT_EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page).toHaveURL(/\/portal\/dashboard/, { timeout: 20_000 });
  await assertShell(page);
});

test("live admin: mobile drawer works end to end", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Email or phone").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  const closed = await page.locator(".pg-drawer").boundingBox();
  expect(closed === null || closed.x <= -250).toBe(true);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.waitForTimeout(400);
  expect((await page.locator(".pg-drawer").boundingBox())!.x).toBeGreaterThanOrEqual(0);
  expect(await noOverflow(page)).toBe(true);
});

test("live checkout: payer surface renders without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CHECKOUT}/pay/does-not-exist`);
  await expect(page.locator(".pg-checkout")).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform)).toBe("none");
});
