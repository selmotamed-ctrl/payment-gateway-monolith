import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const object = {
  id: "11111111-1111-4111-8111-111111111111",
  bucket: "HOT",
  namespace: "KYB_DOCUMENTS",
  storageKey: "kyb/kyb.pdf",
  status: "ACTIVE",
  detectedMimeType: "application/pdf",
  originalFilename: "kyb.pdf",
  byteSize: "1024",
  sha256Hex: "abc123",
  ownerMerchantId: null,
  retainUntil: null,
  legalHold: false,
  legalHoldReason: null,
  gcEligibleAt: null,
  avScanStatus: "CLEAN",
  avSignature: "eicar",
  scrubErrorCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  activeLocks: [],
};

test("object storage uses shared page surfaces and filter toolbar", async ({ page }) => {
  await seedSession(page, ADMIN_KEY, {
    ...adminSession,
    userInfo: {
      ...adminSession.userInfo,
      authoritiesMap: {
        ...adminSession.userInfo.authoritiesMap,
        "system:storage:read": true,
        "system:storage:admin": true,
        "system:storage:legal-hold": true,
      },
    },
  });
  await page.route("**/api/v1/admin/object-storage/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/summary")) {
      await route.fulfill(json(200, {
        health: { ok: true, mode: "FS_LOCAL", rootDirOrUrl: "/var/lib/pg", freeBytes: 1024, latencyMs: 2 },
        activeKekVersion: 1,
        countsByStatus: { ACTIVE: 3, QUARANTINE_PENDING_AV: 1 },
        bytesByNamespace: { KYB_DOCUMENTS: { objects: 1, bytes: "1024" } },
        activeLocksCount: 0,
        legalHoldCount: 1,
        quarantinePendingCount: 1,
        scrubErrorsCount: 0,
        scrubErrorObjects: 0,
        totalObjects: 4,
      }));
      return;
    }
    if (url.pathname.endsWith("/objects")) {
      await route.fulfill(json(200, { objects: [object], total: 1 }));
      return;
    }
    await route.fulfill(json(200, { accessLogs: [], total: 0 }));
  });
  await page.goto("/system/object-storage");
  await expect(page.getByRole("heading", { name: "Object & Asset Storage" })).toBeVisible();
  await page.getByRole("tab", { name: "Object explorer" }).click();
  await expect(page.getByRole("table", { name: "Storage objects" })).toBeVisible();
  await expect(page.locator(".pg-table-card")).toHaveCount(1);
  await expect(page.locator(".pg-table-filters__grid")).toBeVisible();
  await page.screenshot({ path: "/tmp/opencode/object-storage-objects.png", fullPage: true });
});
