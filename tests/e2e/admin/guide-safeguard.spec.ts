import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const approval = {
  id: "approval-1",
  subjectType: "MERCHANT",
  subjectId: "merchant-1",
  domain: "MERCHANT",
  kind: "EDIT",
  state: "PENDING_REVIEW",
  mode: "MAKER_CHECKER",
  baseVersion: 1,
  makerUserId: "admin-2",
  makerName: "Other Maker",
  checkerName: "",
  makerReason: "Update trade name from a verified document",
  rejectionReason: null,
  riskAcceptanceNote: null,
  payloadDiff: { tradeName: ["Old Name", "New Name"] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  ratifyDueAt: null,
  expired: false,
  ageHours: 1,
  expiresInHours: null,
  subjectContext: {
    contextType: "MERCHANT",
    id: "merchant-1",
    legalName: "Acme Trading LLC",
    tradeName: "Acme Store",
    status: "ACTIVE",
  },
  canCheck: true,
  canApprove: true,
  checkBlockedReason: null,
};

test.beforeEach(async ({ page }) => {
  await seedSession(page, ADMIN_KEY, adminSession);
});

test("Approve asks for the safeguard checklist and Cancel sends no request", async ({ page }) => {
  let approveRequests = 0;
  await page.route("**/api/v1/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/approvals/approval-1/approve")) {
      approveRequests += 1;
      await route.fulfill(json(200, { status: "EXECUTED" }));
      return;
    }
    if (url.pathname.endsWith("/approvals/approval-1")) {
      await route.fulfill(json(200, { approval }));
      return;
    }
    if (url.pathname.endsWith("/approvals")) {
      await route.fulfill(json(200, { approvals: [approval], total: 1, page: 1, pageSize: 20 }));
      return;
    }
    await route.fulfill(json(200, {}));
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/approvals?open=approval-1");
  await expect(page.getByText("MERCHANT", { exact: true }).first()).toBeVisible();

  for (const label of [
    "Diff reviewed",
    "Subject context reviewed",
    "Maker/checker separation verified",
    "Risk assessed",
  ]) {
    const checkbox = page.getByLabel(label);
    if ((await checkbox.count()) > 0) {
      await checkbox.check();
    }
  }

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const safeguard = page.locator(".guide-safeguard");
  await expect(safeguard).toBeVisible();
  const continueButton = safeguard.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeDisabled();

  const checks = safeguard.locator(".guide-safeguard-check input[type=checkbox]");
  const count = await checks.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await checks.nth(index).check();
  }
  await expect(continueButton).toBeEnabled();

  await safeguard.getByRole("button", { name: "Cancel" }).click();
  await expect(safeguard).toBeHidden();
  expect(approveRequests).toBe(0);
});
