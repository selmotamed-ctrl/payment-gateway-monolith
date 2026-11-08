import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession } from "../fixtures";

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const WALLET_ACTIVE = "0198a000-0000-7000-8000-00000000a001";
const WALLET_FROZEN = "0198a000-0000-7000-8000-00000000a002";
const MERCHANT = "0198a000-0000-7000-8000-00000000b001";

const wallet = (id: string, status: string, restricted: boolean) => ({
  id,
  merchantId: MERCHANT,
  merchant: { id: MERCHANT, legalName: "Acme Trading LLC", tradeName: "Acme" },
  currency: "LYD",
  status,
  glAccountId: `0198a000-0000-7000-8000-0000000c${id.slice(-3)}`,
  liveBalance: restricted ? null : "1250.5000",
  checkpointBalance: restricted ? null : "1200.0000",
  applicationCount: 2,
  paymentLinkCount: 5,
  pendingCashoutCount: 0,
  createdAt: "2026-11-01T10:00:00.000Z",
  redactedFields: restricted ? ["liveBalance", "checkpointBalance"] : [],
});

/** Staff with merchant:write: may freeze, and may propose an unfreeze. */
const writerSession = {
  ...adminSession,
  userInfo: {
    ...adminSession.userInfo,
    authoritiesMap: { ...adminSession.userInfo.authoritiesMap, "merchant:write": true, "merchants.read": true, "support.read_merchant": true },
  },
};

test.describe("wallets: containment is immediate, restoring is governed", () => {
  const statusCalls: Array<{ id: string; body: Record<string, unknown> }> = [];

  test.beforeEach(async ({ page }) => {
    statusCalls.length = 0;
    await page.addInitScript(
      ([key, session]) => {
        window.localStorage.setItem(key, JSON.stringify(session));
        window.localStorage.setItem("locale-name", "en"); // the portal defaults to Arabic; the assertions read English
      },
      [ADMIN_KEY, writerSession] as const,
    );
    await page.route("**/api/v1/admin/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/wallets/summary")) {
        await route.fulfill(json(200, { totalWallets: 2, activeWallets: 1, frozenWallets: 1, pendingCashoutWallets: 0, totalBalanceByCurrency: [{ currency: "LYD", total: "1250.5000" }] }));
        return;
      }
      if (path.endsWith("/wallets") && route.request().method() === "GET") {
        await route.fulfill(json(200, { wallets: [wallet(WALLET_ACTIVE, "ACTIVE", false), wallet(WALLET_FROZEN, "FROZEN", true)], total: 2, page: 1, pageSize: 20 }));
        return;
      }
      const match = /\/wallets\/([0-9a-f-]+)\/status$/.exec(path);
      if (match && route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        statusCalls.push({ id: match[1]!, body });
        if (body.status === "ACTIVE") {
          await route.fulfill(json(202, { approvalRequestId: "0198a000-0000-7000-8000-00000000d001", state: "PENDING_REVIEW" }));
        } else {
          await route.fulfill(json(200, { wallet: { id: match[1], merchantId: MERCHANT, currency: "LYD", status: "FROZEN" } }));
        }
        return;
      }
      await route.fulfill(json(200, {}));
    });
  });

  const openRowMenu = async (page: import("@playwright/test").Page, rowText: RegExp) => {
    const row = page.getByRole("row").filter({ hasText: rowText }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /row actions/i }).first().click();
  };

  test("balances are 'Restricted' for a role without financial visibility, never 0", async ({ page }) => {
    await page.goto("/wallets");
    await expect(page.getByText("Acme").first()).toBeVisible();
    await expect(page.getByText(/1,?250\.5/).first()).toBeVisible();
    // the frozen row's balances came back null: the UI must say so instead of printing zero
    await expect(page.getByText(/restricted/i).first()).toBeVisible();
  });

  test("freezing needs a reason of at least 10 characters and is sent as an immediate FROZEN request", async ({ page }) => {
    await page.goto("/wallets");
    await openRowMenu(page, /1,?250\.5/);
    await page.getByText(/^Freeze wallet$/).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/takes effect immediately/i)).toBeVisible();

    const reason = dialog.getByLabel(/reason/i);
    await reason.fill("too short");
    await dialog.getByRole("button", { name: /freeze wallet/i }).last().click();
    expect(statusCalls).toHaveLength(0); // client-side validation: nothing was sent

    await reason.fill("Suspicious payout pattern reported by compliance");
    await dialog.getByRole("button", { name: /freeze wallet/i }).last().click();
    await expect.poll(() => statusCalls.length).toBe(1);
    expect(statusCalls[0]!.id).toBe(WALLET_ACTIVE);
    expect(statusCalls[0]!.body).toMatchObject({ status: "FROZEN", reason: "Suspicious payout pattern reported by compliance" });
  });

  test("restoring a frozen wallet is a proposal: HTTP 202 is reported as 'submitted for approval', not as applied", async ({ page }) => {
    await page.goto("/wallets");
    await openRowMenu(page, /restricted/i);
    await page.getByText(/^Request unfreeze$/).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/four-eyes approval/i)).toBeVisible();
    await dialog.getByLabel(/reason/i).fill("Investigation closed, no findings against the merchant");
    await dialog.getByRole("button", { name: /request unfreeze/i }).last().click();
    await expect.poll(() => statusCalls.length).toBe(1);
    expect(statusCalls[0]!.body).toMatchObject({ status: "ACTIVE" });
    await expect(page.getByText(/submitted for (four-eyes )?approval|approval/i).first()).toBeVisible();
  });

  test("a read-only role gets no freeze action", async ({ page }) => {
    const readerSession = {
      ...adminSession,
      userInfo: { ...adminSession.userInfo, authoritiesMap: { "merchants.read": true, "support.read_merchant": true } },
    };
    await page.addInitScript(([key, session]) => window.localStorage.setItem(key, JSON.stringify(session)), [ADMIN_KEY, readerSession] as const);
    await page.goto("/wallets");
    await openRowMenu(page, /1,?250\.5/);
    await expect(page.getByText(/^Inspect GL account$/)).toBeVisible();
    await expect(page.getByText(/^Freeze wallet$/)).toHaveCount(0);
  });
});
