import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const complianceSession = {
  ...adminSession,
  userInfo: {
    ...adminSession.userInfo,
    role: "COMPLIANCE",
    authoritiesMap: {
      ...adminSession.userInfo.authoritiesMap,
      "case:read": true,
      "operator:read": true,
      "case:write": true,
      "attempt:inquire": true,
      "attempt:read": true,
      "dispute:read": true,
    },
  },
};

const operatorCase = {
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
  await seedSession(page, ADMIN_KEY, complianceSession);
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/operator-cases")) {
      await route.fulfill(json(200, { cases: [operatorCase], total: 1, page: 1, pageSize: 20 }));
      return;
    }
    await route.fulfill(json(200, {}));
  });
});

const routes = [
  { path: "/approvals", name: "Approvals" },
  { path: "/operator-cases", name: "OperatorCases" },
  { path: "/cashouts", name: "CashOuts" },
  { path: "/gateways/wizard/version-1", name: "GatewayWizard" },
  { path: "/aml/cases", name: "AmlCases" },
];

for (const route of routes) {
  test(`context help opens with at least one card on ${route.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(route.path);
    const button = page.getByRole("button", { name: "How this page works" });
    await expect(button).toBeVisible();
    await button.click();
    const drawer = page.locator(".guide-context-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".guide-context-card").first()).toBeVisible();
  });
}

test("opening help preserves form state and closing keeps it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/operator-cases");
  const merchantFilter = page.getByRole("textbox", { name: "Merchant name" });
  await expect(merchantFilter).toBeVisible();
  await merchantFilter.fill("Acme keeps typing");
  await page.getByRole("button", { name: "How this page works" }).click();
  await expect(page.locator(".guide-context-drawer")).toBeVisible();
  await page.getByRole("button", { name: "Close help" }).click();
  await expect(merchantFilter).toHaveValue("Acme keeps typing");
});
