import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, adminSession } from "../fixtures";

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const WALLET = "0198a000-0000-7000-8000-00000000a001";
const FROZEN_WALLET = "0198a000-0000-7000-8000-00000000a002";
const MERCHANT = "0198a000-0000-7000-8000-00000000b001";
const GL_ACCOUNT = "0198a000-0000-7000-8000-00000000c001";
const ENTRY_PREFIX = "0198a000-0000-7000-8000-0000000e";
const STATEMENT_TOTAL = 30;

const walletDetail = (id: string, status: string, pendingApprovals: unknown[] = []) => ({
  id,
  merchantId: MERCHANT,
  merchant: { id: MERCHANT, legalName: "Acme Trading LLC", tradeName: "Acme" },
  currency: "LYD",
  status,
  glAccountId: GL_ACCOUNT,
  liveBalance: "70.0000",
  checkpointBalance: "60.0000",
  applicationCount: 1,
  paymentLinkCount: 2,
  pendingCashoutCount: 0,
  createdAt: "2026-11-01T10:00:00.000Z",
  redactedFields: [],
  glAccount: { id: GL_ACCOUNT, accountType: "MERCHANT_WALLET", currency: "LYD", checkpointBalance: "60.0000", checkpointAt: "2026-11-05T10:00:00.000Z" },
  shards: [
    { shardId: 0, currentBalance: "-50.0000", updatedAt: "2026-11-06T10:00:00.000Z" },
    { shardId: 1, currentBalance: "-20.0000", updatedAt: "2026-11-06T10:00:00.000Z" },
  ],
  applications: [{ id: "0198a000-0000-7000-8000-00000000f001", name: "Acme web shop", status: "ACTIVE" }],
  cashouts: [],
  pendingApprovals,
});

/** Line n (1 = newest). Every third line is a debit, the rest are credits. */
const line = (n: number) => ({
  lineId: `0198a000-0000-7000-8000-0000000d${String(n).padStart(4, "0")}`,
  entryId: `${ENTRY_PREFIX}${String(n).padStart(4, "0")}`,
  direction: n % 3 === 0 ? "DEBIT" : "CREDIT",
  amount: `${n}.0000`,
  createdAt: `2026-11-06T10:${String(60 - n).padStart(2, "0")}:00.000Z`,
  refType: "PAYMENT_ATTEMPT",
  refId: `0198a000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`,
  description: `Payment ${n}`,
});

const linesPage = (url: URL) => {
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "25");
  const direction = url.searchParams.get("direction");
  const all = Array.from({ length: STATEMENT_TOTAL }, (_, index) => line(index + 1)).filter((entry) => !direction || entry.direction === direction);
  const rows = all.slice((page - 1) * pageSize, page * pageSize);
  const sum = (side: string) => all.filter((entry) => entry.direction === side).reduce((total, entry) => total + Number(entry.amount), 0);
  return {
    lines: rows,
    total: all.length,
    page,
    pageSize,
    totals: { lineCount: all.length, totalDebit: sum("DEBIT").toFixed(4), totalCredit: sum("CREDIT").toFixed(4), netDebit: (sum("DEBIT") - sum("CREDIT")).toFixed(4) },
  };
};

const entryDetail = (id: string) => ({
  id,
  refType: "PAYMENT_ATTEMPT",
  refId: "0198a000-0000-7000-8000-0000000a0001",
  description: "Payment 1",
  createdAt: "2026-11-06T10:59:00.000Z",
  balanced: true,
  totalDebit: "1.0000",
  totalCredit: "1.0000",
  currency: "LYD",
  lines: [
    { lineId: "l1", direction: "DEBIT", amount: "1.0000", createdAt: "2026-11-06T10:59:00.000Z", glAccount: { id: "0198a000-0000-7000-8000-00000000c009", accountType: "TREASURY", currency: "LYD", ownerId: null } },
    { lineId: "l2", direction: "CREDIT", amount: "1.0000", createdAt: "2026-11-06T10:59:00.000Z", glAccount: { id: GL_ACCOUNT, accountType: "MERCHANT_WALLET", currency: "LYD", ownerId: MERCHANT } },
  ],
  reference: { type: "PAYMENT_ATTEMPT", id: "0198a000-0000-7000-8000-0000000a0001", route: "attempt" },
});

/** Staff with merchant:write and finance access. */
const writerSession = {
  ...adminSession,
  userInfo: {
    ...adminSession.userInfo,
    authoritiesMap: { ...adminSession.userInfo.authoritiesMap, "merchant:write": true, "merchants.read": true, "support.read_merchant": true, "profit.read": true, "liquidity.read": true, "finance:write": true, "finance:read": true },
  },
};

const calls: string[] = [];
let failingShard = false;
const repairCalls: Array<{ path: string; body: Record<string, unknown> }> = [];

const mock = async (page: Page) => {
  await page.addInitScript(
    ([key, session]) => {
      window.localStorage.setItem(key, JSON.stringify(session));
      window.localStorage.setItem("locale-name", "en"); // the portal defaults to Arabic; the assertions read English
    },
    [ADMIN_KEY, writerSession] as const,
  );
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/v1\/admin/, "");
    calls.push(`${path}${url.search}`);
    if (path === "/wallets/summary") return route.fulfill(json(200, { totalWallets: 2, activeWallets: 1, frozenWallets: 1, pendingCashoutWallets: 0, totalBalanceByCurrency: [] }));
    if (path === "/wallets") {
      const row = { ...walletDetail(WALLET, "ACTIVE") };
      return route.fulfill(json(200, { wallets: [row], total: 1, page: 1, pageSize: 25 }));
    }
    if (path === `/wallets/${WALLET}`) return route.fulfill(json(200, { wallet: walletDetail(WALLET, "ACTIVE") }));
    if (path === `/wallets/${FROZEN_WALLET}`) {
      return route.fulfill(json(200, { wallet: walletDetail(FROZEN_WALLET, "FROZEN") }));
    }
    if (path.endsWith("/statement") || path === `/finance/gl-accounts/${GL_ACCOUNT}/lines`) return route.fulfill(json(200, linesPage(url)));
    if (path.endsWith("/audit-events")) {
      return route.fulfill(
        json(200, {
          auditEvents: [
            {
              id: "a1",
              action: "WALLET_FROZEN",
              role: "FINANCE",
              actorEmail: "finance@example.ly",
              approvalRequestId: null,
              before: { status: "ACTIVE" },
              after: { status: "FROZEN", reason: "Suspicious payout pattern" },
              createdAt: "2026-11-06T09:00:00.000Z",
              redacted: false,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 10,
        }),
      );
    }
    if (/\/finance\/gl-accounts\/[0-9a-f-]+\/shards\/1\/repair-plan$/.test(path)) {
      return route.fulfill(
        json(200, {
          needsRepair: true,
          kind: "RECOMPUTE",
          sequenceIntact: true,
          status: "PARITY",
          before: { balance: "-20.5000", lineSeq: "12", checkpointBalance: "-20.0000", checkpointSeq: "12", baselineSeq: "0" },
          journal: { total: "-20.0000", highestSequence: "12", linesAfterBaseline: "12" },
          after: { balance: "-20.0000", lineSeq: "12", baselineSeq: "0" },
          delta: "0.5000",
          planHash: "a".repeat(64),
        }),
      );
    }
    if (/\/finance\/gl-accounts\/[0-9a-f-]+\/shards\/1\/repair$/.test(path) && route.request().method() === "POST") {
      repairCalls.push({ path, body: JSON.parse(route.request().postData() ?? "{}") });
      failingShard = false;
      return route.fulfill(json(200, { repaired: true }));
    }
    if (path === `/finance/gl-accounts/${GL_ACCOUNT}`) {
      return route.fulfill(
        json(200, {
          account: { id: GL_ACCOUNT, accountType: "MERCHANT_WALLET", ownerId: MERCHANT, currency: "LYD", gatewayId: null, checkpointBalance: "-60.0000", checkpointAt: "2026-11-05T10:00:00.000Z", shardCount: 2, shardScaledAt: null },
          liveBalance: "-70.0000",
          naturalBalance: "70.0000",
          balanceSource: "shards",
          checkpoint: { status: failingShard ? "PARITY" : "OK", pendingLines: "10", shardsBehind: 1 },
          shards: [
            { shardId: 0, currentBalance: "-50.0000", lineSeq: "30", checkpointBalance: "-40.0000", checkpointSeq: "20", checkpointAt: "2026-11-05T10:00:00.000Z", pendingLines: "10", status: "OK", failureKind: null, consecutiveFailures: 0, updatedAt: "2026-11-06T10:00:00.000Z" },
            { shardId: 1, currentBalance: "-20.0000", lineSeq: "12", checkpointBalance: "-20.0000", checkpointSeq: "12", checkpointAt: "2026-11-05T10:00:00.000Z", pendingLines: "0", status: failingShard ? "PARITY" : "OK", failureKind: failingShard ? "drift 0.5000" : null, consecutiveFailures: failingShard ? 3 : 0, updatedAt: "2026-11-06T10:00:00.000Z" },
          ],
        }),
      );
    }
    const entry = /\/finance\/journal-entries\/([0-9a-f-]+)$/.exec(path);
    if (entry) return route.fulfill(json(200, entryDetail(entry[1]!)));
    return route.fulfill(json(200, {}));
  });
};

test.beforeEach(async ({ page }) => {
  calls.length = 0;
  failingShard = false;
  repairCalls.length = 0;
  await mock(page);
});

test.describe("wallet details page", () => {
  test("Inspect in the wallets list opens the details page, not a drawer", async ({ page }) => {
    await page.goto("/wallets");
    await page.getByRole("button", { name: /^inspect$/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/wallets/${WALLET}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Acme" })).toBeVisible();
    await expect(page.getByRole("button", { name: /back to wallets/i })).toBeVisible();
    await expect(page.getByText("Posted since checkpoint")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Statement" })).toBeVisible();
  });

  test("old ?open= links land on the details page", async ({ page }) => {
    await page.goto(`/wallets?open=${WALLET}`);
    await expect(page).toHaveURL(new RegExp(`/wallets/${WALLET}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Acme" })).toBeVisible();
  });

  test("the shard Total row has cell padding and the shards agree with the live balance", async ({ page }) => {
    await page.goto(`/wallets/${WALLET}`);
    await expect(page.getByText("Shards agree with the live balance")).toBeVisible();
    const totalCell = page.locator("tfoot td").first();
    await expect(totalCell).toHaveText("Total");
    const padding = await totalCell.evaluate((cell) => parseFloat(getComputedStyle(cell).paddingInlineStart));
    expect(padding).toBeGreaterThanOrEqual(14);
  });

  test("the statement is paginated by the server and totals describe the whole result", async ({ page }) => {
    await page.goto(`/wallets/${WALLET}?tab=statement`);
    await expect(page.getByText("Payment 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Payment 25", { exact: true })).toBeVisible();
    await expect(page.getByText("Payment 26", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: /totals of the filtered lines/i })).toContainText(String(STATEMENT_TOTAL));

    await page.getByRole("button", { name: /next page/i }).first().click();
    await expect(page.getByText("Payment 26", { exact: true })).toBeVisible();
    await expect(page.getByText("Payment 1", { exact: true })).toHaveCount(0);
    expect(calls.some((entry) => entry.includes("/statement") && entry.includes("page=2"))).toBe(true);
  });

  test("the tab is kept in the address so a reload lands on the same tab", async ({ page }) => {
    await page.goto(`/wallets/${WALLET}`);
    await page.getByRole("tab", { name: "Statement" }).click();
    await expect(page).toHaveURL(/tab=statement/);
    await page.reload();
    await expect(page.getByText("Payment 1", { exact: true })).toBeVisible();
  });

  test("a journal entry opens in a drawer above everything else", async ({ page }) => {
    await page.goto(`/wallets/${WALLET}?tab=statement`);
    await page.getByRole("button", { name: /open journal entry/i }).first().click();
    const drawer = page.locator("aside.v-navigation-drawer--active", { hasText: "Double-entry lines" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Double-entry lines")).toBeVisible();
  });

  test("a journal entry opened from the GL account drawer stacks above that drawer and its lines are paginated", async ({ page }) => {
    await page.goto(`/wallets/${WALLET}`);
    await page.getByRole("button", { name: /inspect gl account/i }).first().click();
    const glDrawer = page.getByRole("complementary", { name: "GL account" });
    await expect(glDrawer).toBeVisible();
    await expect(glDrawer.getByText("2 shards wide", { exact: false })).toBeVisible();
    await expect(glDrawer.getByText(/checkpoint behind/i)).toBeVisible();
    await expect(glDrawer.getByRole("button", { name: /next page/i }).first()).toBeVisible();
    expect(calls.some((entry) => entry.includes(`/finance/gl-accounts/${GL_ACCOUNT}/lines`))).toBe(true);

    await glDrawer.getByRole("button", { name: /open journal entry/i }).first().click();
    const entryDrawer = page.locator("aside.v-navigation-drawer--active", { hasText: "Double-entry lines" });
    await expect(entryDrawer).toBeVisible();
    // the element at the centre of the entry drawer is inside it, i.e. nothing covers it
    const onTop = await entryDrawer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return element.contains(hit);
    });
    expect(onTop).toBe(true);
  });

  test("filtering by side is sent to the server", async ({ page }) => {
    await page.goto(`/wallets/${WALLET}?tab=statement`);
    await expect(page.getByText("Payment 1", { exact: true })).toBeVisible();
    if (!(await page.locator(".pg-table-filters__grid").first().isVisible())) await page.locator(".pg-filter-trigger:visible").first().click();
    await page.getByRole("combobox", { name: "Side", exact: true }).first().click();
    await page.getByRole("option", { name: "Debit" }).click();
    await expect.poll(() => calls.some((entry) => entry.includes("/statement") && entry.includes("direction=DEBIT"))).toBe(true);
  });

  test("a frozen wallet shows a banner and the restore action; the status history lists the freeze", async ({ page }) => {
    await page.goto(`/wallets/${FROZEN_WALLET}`);
    await expect(page.getByText(/this wallet is frozen/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /request unfreeze/i })).toBeVisible();
    await page.getByRole("tab", { name: "Status history" }).click();
    await expect(page.getByText("Suspicious payout pattern")).toBeVisible();
    await expect(page.getByText("finance@example.ly")).toBeVisible();
  });

  test("a shard that failed its proof can be repaired from the GL drawer: preview first, then the recompute with the plan hash", async ({ page }) => {
    failingShard = true;
    await page.goto(`/wallets/${WALLET}`);
    await page.getByRole("button", { name: /inspect gl account/i }).first().click();
    const glDrawer = page.getByRole("complementary", { name: "GL account" });
    await expect(glDrawer.getByText(/checkpoint proof failed/i)).toBeVisible();
    await glDrawer.getByRole("button", { name: /^repair$/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Repair shard")).toBeVisible();
    await expect(dialog.getByText(/recomputed from the journal/i)).toBeVisible();
    await expect(dialog.getByText("Correction")).toBeVisible();
    await dialog.getByLabel(/reason/i).fill("too short");
    await dialog.getByRole("button", { name: /recompute from journal/i }).click();
    expect(repairCalls).toHaveLength(0); // client-side validation
    await dialog.getByLabel(/reason/i).fill("Shard drifted by half a dinar after the incident");
    await dialog.getByRole("button", { name: /recompute from journal/i }).click();
    await expect.poll(() => repairCalls.length).toBe(1);
    expect(repairCalls[0]!.body).toMatchObject({ reason: "Shard drifted by half a dinar after the incident", planHash: "a".repeat(64) });
  });
});
