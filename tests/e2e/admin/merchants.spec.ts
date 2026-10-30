import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const merchant = {
  id: "mch_1",
  legalName: "Acme Trading LLC",
  tradeName: "Acme Store",
  taxId: "TAX-1",
  registrationNo: "REG-1",
  businessCategory: "Retail",
  status: "ACTIVE",
  kybStatus: "VERIFIED",
  riskTier: "STANDARD",
  onboardingChannel: "SELF_SERVICE",
  country: "LY",
  contactEmail: "acme@example.com",
  contactPhone: "+218910000000",
  negativeBalanceCeiling: "0.0000",
  commissionReceivableCeiling: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  suspendedAt: null,
};

test.beforeEach(async ({ page }) => {
  await seedSession(page, ADMIN_KEY, adminSession);
});

test("merchant editing uses a form instead of a raw JSON patch", async ({ page }) => {
  let submitted: any = null;

  await page.route("**/api/v1/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.includes("/merchants")) {
      await route.fulfill(json(200, {}));
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/propose-edit")) {
      submitted = request.postDataJSON();
      await route.fulfill(json(202, { status: "PENDING_REVIEW", approvalRequestId: "apr_1" }));
      return;
    }
    if (/\/merchants\/[^/]+$/.test(url.pathname)) {
      await route.fulfill(json(200, { merchant }));
      return;
    }
    await route.fulfill(json(200, { merchants: [merchant], total: 1, page: 1, pageSize: 200 }));
  });

  await page.goto("/merchants");
  await expect(page.locator("table")).toContainText("Acme Store");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();

  await expect(page.getByText("JSON-Patch", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Legal Name")).toHaveValue("Acme Trading LLC");
  await page.getByLabel("Trade Name").fill("Acme Store Updated");
  await page.getByLabel("Contact Email").fill("updated@example.com");
  await page.getByRole("button", { name: "Submit For Approval" }).click();

  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted.patch).toEqual(
    expect.arrayContaining([
      { op: "replace", path: "/tradeName", value: "Acme Store Updated" },
      { op: "replace", path: "/contactEmail", value: "updated@example.com" },
    ]),
  );
  expect(submitted.patch).toHaveLength(2);
});
