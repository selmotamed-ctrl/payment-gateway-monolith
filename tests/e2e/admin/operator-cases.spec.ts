import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const operatorSession = {
  ...adminSession,
  userInfo: {
    ...adminSession.userInfo,
    role: "OPERATOR",
    isMaker: true,
    isChecker: false,
    authoritiesMap: {
      "case:read": true,
      "operator:read": true,
      "case:write": true,
      "attempt:inquire": true,
      "attempt:read": true,
    },
  },
};

const summary = {
  id: "oc_1",
  caseId: "oc_1",
  caseRef: "PA-1001",
  caseReferenceSource: "ATTEMPT_REFERENCE",
  caseType: "UNKNOWN",
  kind: "UNKNOWN",
  priority: "P1",
  state: "OPEN",
  attemptId: "att_1",
  attemptReference: "PA-1001",
  attemptStatus: "UNKNOWN",
  attemptSubstatus: null,
  merchantId: "mch_1",
  merchantTradeName: "Acme Store",
  merchantLegalName: "Acme Trading LLC",
  merchantName: "Acme Store",
  merchantStatus: "ACTIVE",
  merchantRiskTier: "STANDARD",
  railId: "rail_1",
  railCode: "moamalat",
  railNameEn: "Moamalat",
  gatewayId: "gw_1",
  gatewayCode: "moamalat-gw",
  gatewayName: "Moamalat Gateway",
  routeId: "route_1",
  requestedAmount: "100.0000",
  chargedAmount: "100.0000",
  settledAmount: null,
  statementAmount: null,
  statementFee: null,
  currency: "LYD",
  providerReference: "PRV-1001",
  gatewayReference: "GW-1001",
  linkSlot: {
    id: "link_1",
    key: "link-key-1",
    state: "PENDING",
    useCount: 1,
    confirmedCount: 0,
    activeLockedCount: 1,
    infiniteUse: false,
  },
  reconciliationItemId: null,
  reconciliationResult: null,
  approvalRequestId: null,
  approvalState: null,
  assigneeUserId: null,
  assigneeEmail: null,
  openedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  slaDueAt: "2026-01-01T04:00:00.000Z",
  gatewaySupportsStatusCheck: true,
  inquiryEligibility: { eligible: true, reason: "ELIGIBLE" },
  resolutionNotes: null,
};

test.beforeEach(async ({ page }) => {
  await seedSession(page, ADMIN_KEY, operatorSession);
});

test("filters by merchant name and runs a bulk inquiry with case ids", async ({ page }) => {
  let listRequests = 0;
  let listQuery: URLSearchParams | null = null;
  let bulkBody: any = null;

  await page.route("**/api/v1/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/operator-cases/bulk-inquire")) {
      bulkBody = request.postDataJSON();
      await route.fulfill(
        json(200, {
          requested: 1,
          scheduled: 1,
          skipped: 0,
          results: [
            {
              caseId: "oc_1",
              caseRef: "PA-1001",
              attemptId: "att_1",
              attemptReference: "PA-1001",
              status: "SCHEDULED",
              reason: "ELIGIBLE",
              message: "Gateway inquiry scheduled",
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/operator-cases")) {
      listRequests += 1;
      listQuery = url.searchParams;
      await route.fulfill(json(200, { cases: [summary], total: 1, page: 1, pageSize: 20 }));
      return;
    }
    if (url.pathname.includes("/options/")) {
      await route.fulfill(json(200, { items: [] }));
      return;
    }
    await route.fulfill(json(200, {}));
  });

  await page.goto("/operator-cases");
  await expect(page.getByText("Acme Store").first()).toBeVisible();
  await expect(page.getByText("PA-1001").first()).toBeVisible();
  await expect(page.getByText("Link slot").first()).toBeVisible();

  await page.getByLabel("Merchant name").fill("Acme");
  await expect.poll(() => listQuery?.get("merchantName")).toBe("Acme");
  expect(listRequests).toBeGreaterThan(0);

  await page.getByLabel("Select case PA-1001").check();
  await expect(page.getByRole("button", { name: /Inquire selected \(1\)/ })).toBeEnabled();
  await page.getByRole("button", { name: /Inquire selected \(1\)/ }).click();

  await expect.poll(() => bulkBody).not.toBeNull();
  expect(bulkBody.caseIds).toEqual(["oc_1"]);
  await expect(page.getByText("Bulk inquiry result")).toBeVisible();
  await expect(page.getByText("Gateway inquiry scheduled")).toBeVisible();
});

test("opens the case details page and shows the narrative and identifiers", async ({ page }) => {
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/operator-cases/oc_1")) {
      await route.fulfill(json(200, { operatorCase: summary }));
      return;
    }
    if (url.pathname.includes("/options/")) {
      await route.fulfill(json(200, { items: [] }));
      return;
    }
    await route.fulfill(json(200, {}));
  });

  await page.goto("/operator-cases/oc_1");
  await expect(page.getByText("What this case means")).toBeVisible();
  await expect(page.getByText("Unknown outcome").first()).toBeVisible();
  await expect(page.getByText("All identifiers")).toBeVisible();
  await expect(page.getByText("Operator case ID").first()).toBeVisible();
  await expect(page.getByText("oc_1").first()).toBeVisible();
  await expect(page.getByText("Database identifiers")).toBeVisible();
  await expect(page.getByText("Payment attempt ID").first()).toBeVisible();
  await expect(page.getByText("att_1").first()).toBeVisible();
});
