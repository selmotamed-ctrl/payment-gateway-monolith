import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const overview = {
  configured: true,
  daemonReachable: true,
  generatedAt: "2026-11-03T10:00:00.000Z",
  engineMode: "wal-g",
  healthy: true,
  wal: {
    archiveLagSeconds: 2,
    currentLsn: "0/16B3748",
    lastArchivedLsn: "0/16B3700",
    lagBytes: 72,
  },
  targets: [
    { id: "primary-s3", name: "Primary S3 bucket", kind: "s3", healthy: true, detail: "writable" },
    { id: "offsite-ssh", name: "Offsite SSH vault", kind: "ssh", healthy: true, detail: "reachable" },
  ],
  schedule: {
    fullCron: "0 2 * * 0",
    deltaCron: "0 2 * * 1-6",
    drillCron: "0 4 * * 0",
    fullRetentionDays: 56,
    walRetentionDays: 14,
    alertLagSeconds: 60,
  },
  policy: {
    fullCron: "0 2 * * 0",
    deltaCron: "0 2 * * 1-6",
    drillCron: "0 4 * * 0",
    fullRetentionDays: 56,
    walRetentionDays: 14,
    alertLagSeconds: 60,
  },
  backups: [
    {
      id: "run-1",
      target: "postgres_core",
      kind: "full",
      engine: "wal-g",
      status: "PASSED",
      startedAt: "2026-11-01T02:00:00.000Z",
      completedAt: "2026-11-01T02:04:00.000Z",
      durationMs: 240000,
      sizeBytes: 1073741824,
    },
  ],
  latestDrill: {
    id: "drill-1",
    status: "PASSED",
    startedAt: "2026-11-01T04:00:00.000Z",
    completedAt: "2026-11-01T04:06:00.000Z",
    durationMs: 360000,
    targetTime: "2026-11-01T03:55:00.000Z",
    replayedLsn: "0/16B3748",
    doubleEntryDrift: "0.0000",
    balanceMismatches: 0,
    auditBrokenLinks: 0,
    journalLineCount: 1000000,
    checks: {
      doubleEntry: { ok: true, detail: "zero drift" },
      balanceParity: { ok: true, detail: "0 mismatches" },
      auditChain: { ok: true, detail: "0 broken links" },
    },
  },
  drills: [],
  localCatalog: { backups: [], drills: [] },
};

test.beforeEach(async ({ page }) => {
  await seedSession(page, ADMIN_KEY, adminSession);
});

test("renders live backup health, schedule and restore drill verification", async ({ page }) => {
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/system/backups/overview")) {
      await route.fulfill(json(200, overview));
      return;
    }
    await route.fulfill(json(200, {}));
  });

  await page.goto("/system/backups");
  await expect(page.locator(".pg-page").first()).toBeVisible();
  await expect(page.getByText("Backup management", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("wal-g", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Primary S3 bucket", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("PASSED", { exact: false }).first()).toBeVisible();
});

test("triggers a backup with the selected target and kind", async ({ page }) => {
  const triggers: unknown[] = [];
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/system/backups/overview")) {
      await route.fulfill(json(200, overview));
      return;
    }
    if (url.pathname.endsWith("/system/backups/trigger")) {
      triggers.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill(json(202, { backupJobId: "job-1", acceptedAt: new Date().toISOString() }));
      return;
    }
    await route.fulfill(json(200, {}));
  });

  await page.goto("/system/backups");
  await page.getByRole("button", { name: /run backup now/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /run backup/i }).click();
  // "every target, full" is the heaviest combination: the page asks for a second confirmation before it sends anything.
  await expect(page.getByText(/can load production databases/i)).toBeVisible();
  await page.getByRole("dialog").last().getByRole("button", { name: /run backup now/i }).click();
  await expect.poll(() => triggers.length).toBeGreaterThan(0);
  expect(triggers[0]).toMatchObject({ target: "all", kind: "full" });
});
