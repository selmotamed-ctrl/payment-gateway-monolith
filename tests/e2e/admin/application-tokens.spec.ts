import { expect, test, type Page } from "@playwright/test";
import { adminSession, seedSession, ADMIN_KEY } from "../fixtures";

const APP_ID = "0198a000-0000-7000-8000-0000000a0001";
const TOKEN_ID = "0198a000-0000-7000-8000-0000000b0001";
const MERCHANT_ID = "0198a000-0000-7000-8000-0000000c0001";

const merchant = { id: MERCHANT_ID, legalName: "Acme Trading LLC", tradeName: "Acme" };

const application = {
    id: APP_ID,
    name: "Acme web shop",
    merchantId: MERCHANT_ID,
    merchant,
    status: "ACTIVE",
    assignedWalletId: "0198a000-0000-7000-8000-0000000d0001",
    assignedWallet: { id: "0198a000-0000-7000-8000-0000000d0001", currency: "LYD", status: "ACTIVE" },
    expectedMonthlyVolume: "25000.0000",
    railWhitelist: ["EDFALI", "SADAD"],
    railWhitelistMode: "LIST",
    railWhitelistCount: 2,
    redirectDomains: ["https://shop.example.ly"],
    accessTokenCount: 2,
    tokenActiveCount: 1,
    tokenRevokedCount: 1,
    tokenExpiredCount: 0,
    tokenIpRestrictedCount: 1,
    tokenCidrCount: 2,
    paymentLinkCount: 4,
    posTerminalCount: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    redactedFields: [],
};

const token = {
    id: TOKEN_ID,
    name: "Server key",
    lastFour: "a91f",
    scopes: ["link:write", "link:read"],
    env: "LIVE",
    ipWhitelistEnabled: true,
    cidrs: ["10.0.0.0/8", "192.168.10.0/24"],
    ipCount: 2,
    merchantId: MERCHANT_ID,
    applicationId: APP_ID,
    application: { id: APP_ID, name: application.name },
    merchant,
    lastUsedAt: "2026-11-20T08:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    status: "ACTIVE",
    createdAt: "2026-11-01T10:00:00.000Z",
};

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const mock = async (page: Page) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    await page.route("**/api/v1/admin/**", async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname.replace(/^.*\/api\/v1\/admin/, "");
        if (route.request().method() === "POST" && path === `/applications/${APP_ID}/tokens/${TOKEN_ID}/revoke`) {
            return route.fulfill(json(200, { token: { ...token, revokedAt: "2026-11-26T10:00:00.000Z", status: "REVOKED" } }));
        }
        if (path === "/applications/summary") {
            return route.fulfill(json(200, { total: 1, active: 1, suspended: 0, pending: 0, withoutWhitelist: 0 }));
        }
        if (path === "/access-tokens/summary") {
            return route.fulfill(json(200, { total: 2, active: 1, revoked: 1, expired: 0, ipRestricted: 1, ipCidrs: 2 }));
        }
        if (path === "/applications") {
            return route.fulfill(json(200, { applications: [application], total: 1, page: 1, pageSize: 25 }));
        }
        if (path === "/access-tokens") {
            return route.fulfill(json(200, { accessTokens: [token], total: 1, page: 1, pageSize: 25 }));
        }
        if (path === `/applications/${APP_ID}`) {
            return route.fulfill(json(200, { application: { ...application, accessTokens: [token], paymentLinks: [], posTerminals: [], pendingApprovals: [] } }));
        }
        return route.fulfill(json(200, {}));
    });
};

test("applications shows rail and token allowlists and the platform-wide API tokens tab", async ({ page }) => {
    await mock(page);
    await page.goto("/applications");

    await expect(page.getByRole("columnheader", { name: "Rail whitelist" })).toBeVisible();
    await expect(page.getByText("EDFALI")).toBeVisible();
    await expect(page.getByText("SADAD")).toBeVisible();
    await expect(page.getByText("1 IP-restricted · 2 CIDRs")).toBeVisible();

    await page.getByRole("tab", { name: /API tokens/ }).click();
    await expect(page.getByText("Server key")).toBeVisible();
    await expect(page.getByText("LIVE", { exact: true })).toBeVisible();
    await expect(page.getByText("10.0.0.0/8")).toBeVisible();
    await expect(page.getByText("192.168.10.0/24")).toBeVisible();
    await expect(page.getByText("IP allowlists")).toBeVisible();
});

test("viewing an application's tokens opens the drawer on the tokens tab", async ({ page }) => {
    await mock(page);
    await page.goto("/applications");
    await page.getByText("Acme web shop").click({ button: "right" });
    await page.getByRole("menuitem", { name: "View API tokens" }).click();

    await expect(page.getByRole("tab", { name: /API tokens/ }).last()).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Server key")).toBeVisible();
});
