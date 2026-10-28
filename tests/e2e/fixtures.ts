import type { Page } from "@playwright/test";

export const ADMIN_KEY = "PAYMENT_GATEWAY:ADMIN:USER";
export const MERCHANT_KEY = "PAYMENT_GATEWAY:MERCHANT:USER";

const ALL_ADMIN_UI_AUTHORITIES = [
  "joinrequests.review",
  "kyb.review",
  "merchants.read",
  "support.read_merchant",
  "approvals.approve",
  "approvals.reject",
  "aml.read_confidential",
  "adjustments.propose",
  "cashout.process",
  "reconciliation.run",
  "reconciliation.resolve",
  "profit.read",
  "liquidity.read",
  "gateways.edit",
  "users_admin.propose",
];

export const adminSession = {
  token: "test-admin-token",
  refreshToken: null,
  userInfo: {
    id: "admin-1",
    name: "Deploy Admin",
    username: "admin@pgtest.lan",
    role: "GATEWAY_ADMIN",
    email: "admin@pgtest.lan",
    phone: null,
    isMaker: true,
    isChecker: false,
    authoritiesMap: Object.fromEntries(ALL_ADMIN_UI_AUTHORITIES.map((key) => [key, true])),
  },
};

const ALL_MERCHANT_UI_AUTHORITIES = [
  "stats.read",
  "wallets.read",
  "statements.read",
  "statements.export",
  "applications.read",
  "links.read",
  "links.create",
  "payments.read",
  "cashout.read",
  "cashout.request",
  "pos.manage",
  "tokens.read",
  "credentials.manage",
  "users.manage",
];

export const merchantSession = {
  token: "test-merchant-token",
  refreshToken: null,
  userInfo: {
    id: "merchant-1",
    name: "Acme Store",
    username: "acme@example.com",
    role: "MERCHANT_ADMIN",
    email: "acme@example.com",
    phone: "+218910000000",
    merchantId: "merchant-1",
    merchantTradeName: "Acme Store",
    isMaker: true,
    isChecker: false,
    appScopeIds: [],
    authoritiesMap: Object.fromEntries(ALL_MERCHANT_UI_AUTHORITIES.map((key) => [key, true])),
  },
};

export const seedSession = async (page: Page, key: string, session: unknown): Promise<void> => {
  await page.addInitScript(
    ([storageKey, value]) => {
      window.localStorage.setItem("locale-name", "en");
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    },
    [key, session] as const,
  );
};

/** Answers every API call so the SPA renders without a backend. */
export const mockApi = async (page: Page, overrides: Record<string, unknown> = {}): Promise<void> => {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const override = Object.entries(overrides).find(([suffix]) => path.endsWith(suffix));
    if (override) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(override[1]) });
      return;
    }
    if (path.endsWith("/stats/overview")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          attemptsByState: { CREATED: 3, SUCCEEDED: 12, FAILED: 1 },
          unknownBacklog: 2,
          unknownOldestAgeSeconds: 90,
          openCircuitBreakers: 0,
          webhookInboxLagSeconds: 0,
          reconciliationMatchRate: "98.4",
          approvalQueueAgeing: [{ role: "PENDING_REVIEW", oldestHours: 3, count: 2 }],
          joinRequestSlaBreaches: 0,
          amlSlaBreaches: 1,
          merchantsActive: 7,
          merchantsPending: 2,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
};

export const geometry = async (page: Page) => {
  const bar = await page.locator(".pg-app-bar").boundingBox();
  const drawer = await page.locator(".pg-drawer").boundingBox();
  const content = await page.locator(".pg-page").first().boundingBox();
  return { bar, drawer, content };
};

export const noHorizontalOverflow = async (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
