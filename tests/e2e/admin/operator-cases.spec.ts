import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, confirmSafeguard, seedSession } from "../fixtures";

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
  caseRef: "CASE-2026-00001",
  caseReference: "CASE-2026-00001",
  caseReferenceSource: "CASE_NUMBER",
  subjectRef: "PA-1001",
  caseType: "ATTEMPT_UNKNOWN",
  caseTypeLabelKey: "operatorCase.type.ATTEMPT_UNKNOWN",
  caseGroup: "PAYMENTS",
  domain: "PAYMENTS",
  source: "ENGINE",
  confidentiality: "NORMAL",
  title: "Payment outcome unknown",
  summary: "The gateway has not given a definitive result for this payment attempt.",
  subjectType: "PAYMENT_ATTEMPT",
  subjectId: "att_1",
  subjectLabel: null,
  availableActions: [
    { code: "ACKNOWLEDGE", labelKey: "operatorCase.action.ACKNOWLEDGE", requiresApproval: false, fields: ["notes"] },
    { code: "INQUIRE", labelKey: "operatorCase.action.INQUIRE", requiresApproval: false, fields: ["reason", "notes"] },
    { code: "MARK_SUCCEEDED", labelKey: "operatorCase.action.MARK_SUCCEEDED", requiresApproval: true, fields: ["providerReference", "settledAmount", "reason", "notes"] },
    { code: "MARK_FAILED", labelKey: "operatorCase.action.MARK_FAILED", requiresApproval: true, fields: ["reason", "notes"] },
    { code: "CLOSE_CASE", labelKey: "operatorCase.action.CLOSE_CASE", requiresApproval: true, fields: ["resolutionCode", "reference", "reason", "notes"] },
  ],
  resolvedAt: null,
  resolvedByEmail: null,
  resolutionCode: null,
  resolutionSummary: null,
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
  await page.getByLabel("Merchant name").fill("Acme");
  await expect.poll(() => listQuery?.get("merchantName")).toBe("Acme");
  expect(listRequests).toBeGreaterThan(0);

  await page.getByLabel("Select case CASE-2026-00001").check();
  await expect(page.getByRole("button", { name: /Inquire selected \(1\)/ })).toBeEnabled();
  await page.getByRole("button", { name: /Inquire selected \(1\)/ }).click();
  const checklist = page.getByLabel("Inquiry eligibility reviewed");
  if ((await checklist.count()) > 0) {
    for (const label of [
      "Inquiry eligibility reviewed",
      "Attempt status verified",
      "Gateway inquiry support confirmed",
      "Inquiry scope confirmed",
    ]) {
      await page.getByLabel(label).check();
    }
  }
  await page.getByRole("button", { name: /^Inquire \(1\)$/ }).click();
  await confirmSafeguard(page);

  await expect.poll(() => bulkBody).not.toBeNull();
  expect(bulkBody.caseIds).toEqual(["oc_1"]);
  await expect(page.getByText("Bulk inquiry result")).toBeVisible();
  await expect(page.getByText("Gateway inquiry scheduled")).toBeVisible();
});

test("opens the case details page, acknowledges it, and shows the narrative and identifiers", async ({ page }) => {
  let acknowledgeBody: any = null;
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/operator-cases/oc_1/acknowledge")) {
      acknowledgeBody = route.request().postDataJSON();
      await route.fulfill(json(200, { id: "oc_1", state: "IN_PROGRESS" }));
      return;
    }
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
  await expect(page.getByText("Payment outcome unknown").first()).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect.poll(() => acknowledgeBody).not.toBeNull();
  await expect(page.getByText("Acknowledged").first()).toBeVisible();
  await expect(page.getByText("Technical identifiers")).toBeVisible();
  await page.getByText("Technical identifiers").click();
  const openPanel = page.locator(".pg-expansion-panel--open > .pg-expansion__body").first();
  await expect(openPanel.getByText("Operator case ID").first()).toBeVisible();
  await expect(openPanel.getByText("oc_1").first()).toBeVisible();
  await expect(openPanel.getByText("Payment attempt ID").first()).toBeVisible();
  await expect(openPanel.getByText("att_1").first()).toBeVisible();
});

const backupCase = {
  ...summary,
  id: "oc_backup",
  caseId: "oc_backup",
  caseRef: "CASE-2026-00010",
  caseReference: "CASE-2026-00010",
  caseReferenceSource: "CASE_NUMBER",
  subjectRef: "all",
  caseType: "BACKUP_FAILED",
  caseTypeLabelKey: "operatorCase.type.BACKUP_FAILED",
  caseGroup: "PLATFORM",
  domain: "OPERATIONS",
  source: "PLATFORM_MONITOR",
  confidentiality: "NORMAL",
  title: "The latest all backup failed",
  summary: "Backup 7b174ce9 (delta, pg-native) of all failed: OBJECT_STORAGE_BACKUP_PARITY_ERROR",
  subjectType: "BACKUP_TARGET",
  subjectId: "all",
  subjectLabel: "all",
  availableActions: [
    { code: "ACKNOWLEDGE", labelKey: "operatorCase.action.ACKNOWLEDGE", requiresApproval: false, fields: ["notes"] },
    { code: "OPEN_SOURCE", labelKey: "operatorCase.action.OPEN_SOURCE", requiresApproval: false },
    { code: "CLOSE_CASE", labelKey: "operatorCase.action.CLOSE_CASE", requiresApproval: true, fields: ["resolutionCode", "reference", "reason", "notes"] },
  ],
  attemptId: null,
  attemptReference: null,
  attemptStatus: null,
  attemptSubstatus: null,
  merchantId: null,
  merchantTradeName: "",
  merchantLegalName: "",
  merchantName: "",
  railId: null,
  railCode: "",
  railNameEn: "",
  gatewayId: null,
  gatewayCode: "",
  gatewayName: "",
  routeId: null,
  requestedAmount: null,
  chargedAmount: null,
  settledAmount: null,
  statementAmount: null,
  statementFee: null,
  currency: null,
  providerReference: null,
  gatewayReference: null,
  linkSlot: null,
  reconciliationItemId: null,
  reconciliationResult: null,
  inquiryEligibility: { eligible: false, reason: "NO_ATTEMPT" },
  events: [
    {
      id: "evt_1",
      caseId: "oc_backup",
      createdAt: "2026-01-01T00:00:00.000Z",
      eventType: "OPENED",
      actorType: "SYSTEM",
      actorUserId: null,
      actorEmail: null,
      summary: "The latest all backup failed",
    },
  ],
};

test("a backup case reads as a backup, not a payment attempt", async ({ page }) => {
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/operator-cases/oc_backup")) {
      await route.fulfill(json(200, { operatorCase: backupCase }));
      return;
    }
    if (url.pathname.endsWith("/operator-cases")) {
      await route.fulfill(json(200, { cases: [backupCase], total: 1, page: 1, pageSize: 20 }));
      return;
    }
    if (url.pathname.includes("/options/")) {
      await route.fulfill(json(200, { items: [] }));
      return;
    }
    await route.fulfill(json(200, {}));
  });

  await page.goto("/operator-cases");
  await expect(page.getByText("Backup failed").first()).toBeVisible();
  await expect(page.getByText("The latest all backup failed").first()).toBeVisible();

  await page.goto("/operator-cases/oc_backup");
  await expect(page.getByText("Case context", { exact: true })).toBeVisible();
  await expect(page.getByText("The latest all backup failed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open backups" })).toBeVisible();
  await expect(page.getByText("Resolve as succeeded")).toHaveCount(0);
  await expect(page.getByText("Resolve as failed and release reservation")).toHaveCount(0);

  await page.getByRole("button", { name: "Propose resolution" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Resolution outcome*", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Evidence reference")).toBeVisible();
  await expect(dialog.getByText("Provider reference")).toHaveCount(0);
  await expect(dialog.getByText("Settled amount")).toHaveCount(0);
});
