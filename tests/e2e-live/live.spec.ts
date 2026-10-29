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

/**
 * TLS is optional per portal, so the deployed URL may be either scheme. Try the
 * configured scheme first and fall back to the other one (nginx answers 400 for
 * a plain request to a TLS port, and the TLS handshake fails on a plain port).
 */
const resolvedBase = new Map<string, string>();

const gotoAny = async (page: Page, baseUrl: string, path: string): Promise<void> => {
  const host = new URL(baseUrl).host;
  let base = resolvedBase.get(host);
  if (!base) {
    const candidates = baseUrl.startsWith("https://")
      ? [`https://${host}`, `http://${host}`]
      : [`http://${host}`, `https://${host}`];
    for (const candidate of candidates) {
      try {
        // Probe with the request context (a failed page navigation poisons the
        // next goto with a chrome-error:// URL).
        const probe = await page.request.get(`${candidate}/`, { timeout: 8_000 });
        if (probe.status() < 400) {
          base = candidate;
          break;
        }
      } catch {
        // wrong scheme for this listener; try the next one
      }
    }
    if (!base) {
      throw new Error(`could not reach ${baseUrl} over http or https`);
    }
    resolvedBase.set(host, base);
  }
  const response = await page.goto(`${base}${path}`, { timeout: 15_000, waitUntil: "domcontentloaded" });
  if (response && response.status() >= 400) {
    throw new Error(`unexpected ${response.status()} from ${base}${path}`);
  }
};

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

const login = async (page: Page, baseUrl: string, label: string, email: string) => {
  await gotoAny(page, baseUrl, "/login");
  await page.getByLabel(label).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
};

test("live admin: login, dashboard loads below the bar, no scaling transform", async ({ page }) => {
  await login(page, ADMIN, "Email or phone", ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await assertShell(page);
  // A GATEWAY_ADMIN must not be offered pages its role cannot use.
  await expect(page.locator(".pg-drawer a", { hasText: "Operator Cases" })).toHaveCount(0);
  await expect(page.locator(".pg-drawer a", { hasText: "Disputes" })).toHaveCount(0);
});

test("live finance: Disputes is offered and loads", async ({ page }) => {
  await login(page, ADMIN, "Email or phone", process.env.PG_FINANCE_EMAIL ?? "finance@payment-gateway.internal");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  const disputes = page.locator(".pg-drawer a", { hasText: "Disputes" });
  await expect(disputes).toBeVisible();
  await disputes.click();
  await expect(page).toHaveURL(/\/disputes/);
  await expect(page.locator(".pg-page")).toBeVisible();
  await expect(page.locator(".pg-app-bar__title")).toHaveText("Disputes");
});

test("live gateway admin creates a gateway from the UI", async ({ page }) => {
  await login(page, ADMIN, "Email or phone", ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  await page.locator(".pg-drawer a", { hasText: "Gateways" }).first().click();
  await expect(page).toHaveURL(/\/gateways$/);

  const code = `ui-test-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "New Gateway" }).click();
  await page.getByLabel("Gateway Code").fill(code);
  await page.getByLabel("Gateway", { exact: true }).fill("UI Test Gateway");
  await page.getByLabel("Operator").fill("UI Test Operator");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/gateways\/wizard\//, { timeout: 20_000 });

  // The gateway persisted: read it back through the same API with the session.
  const token = await page.evaluate(() => {
    const raw = window.localStorage.getItem("PAYMENT_GATEWAY:ADMIN:USER");
    return raw ? JSON.parse(raw).token : "";
  });
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(`${origin}/api/v1/admin/gateways`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  const payload = await response.json();
  const gateways = payload.gateways ?? [];
  expect(gateways.some((gateway: { code: string }) => gateway.code === code)).toBe(true);

  await page.locator(".pg-drawer a", { hasText: "Gateways" }).first().click();
  await expect(page).toHaveURL(/\/gateways$/);
  await expect(page.locator(".pg-page")).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});

test("live merchant: login, portal loads below the bar, no scaling transform", async ({ page }) => {
  await login(page, MERCHANT, "Phone Or Email", MERCHANT_EMAIL);
  await expect(page).toHaveURL(/\/portal\/dashboard/, { timeout: 20_000 });
  await assertShell(page);
});

test("live admin: mobile drawer works end to end", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, ADMIN, "Email or phone", ADMIN_EMAIL);
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
  await gotoAny(page, CHECKOUT, "/pay/does-not-exist");
  await expect(page.locator(".pg-checkout")).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("app")!).transform)).toBe("none");
});
