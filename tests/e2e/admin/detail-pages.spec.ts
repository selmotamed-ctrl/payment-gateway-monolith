import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adminSession, seedSession } from "../fixtures";

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const joinRequestDetail = readFixture("join-request-detail.json");
const kybDocumentDetail = readFixture("kyb-document-detail.json");

const joinRequestId = "10be6c18-d37b-747e-8889-00000000062d";
const kybDocumentId = "5864932b-c751-4cba-b6df-f197312847e0";

test.beforeEach(async ({ page }) => {
  await seedSession(page, "PAYMENT_GATEWAY:ADMIN:USER", adminSession);
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/v1/admin/join-requests/${joinRequestId}`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(joinRequestDetail) });
      return;
    }
    if (url.pathname === `/api/v1/admin/kyb-documents/${kybDocumentId}`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(kybDocumentDetail) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
});

/**
 * Regression for the Vapor migration: a `dc` page that snapshots loaded data
 * inside its render function must opt into `rerender: true`, otherwise the
 * loading branch never flips and the page reports "not found" after a
 * successful API response.
 */
test("join request detail renders the loaded record", async ({ page }) => {
  await page.goto(`/join-requests/${joinRequestId}`);
  await expect(page.getByText("Request at a glance")).toBeVisible();
  await expect(page.getByText("Approval blockers")).toBeVisible();
  await expect(page.getByText("Join request not found")).toHaveCount(0);
});

test("KYB document detail renders the loaded record", async ({ page }) => {
  await page.goto(`/kyb/${kybDocumentId}`);
  await expect(page.getByText("Document identity", { exact: true })).toBeVisible();
  await expect(page.getByText("Status and integrity", { exact: true })).toBeVisible();
  await expect(page.getByText("KYB document not found")).toHaveCount(0);
});
