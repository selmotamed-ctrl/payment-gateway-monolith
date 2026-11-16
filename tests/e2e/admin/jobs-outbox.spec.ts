import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const emptyList = (key: string) => ({ [key]: [], total: 0, page: 1, pageSize: 25 });

test.beforeEach(async ({ page }) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
    });
    (page as unknown as { __jobsOutboxErrors: string[] }).__jobsOutboxErrors = errors;

    await page.route("**/api/v1/admin/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/system/jobs-outbox/summary")) {
            await route.fulfill(json(200, {
                unpublishedOutbox: 0,
                oldestUnpublishedOutboxAt: null,
                auditOutboxQueued: 0,
                oldestAuditOutboxAt: null,
                jobs24h: { queued: 0, running: 0, succeeded: 0, failed: 0 },
                failedNotifications: 0,
                ledger: { shardsBehind: 0, maxPendingLines: "0", failedShards: 0 },
            }));
            return;
        }
        if (url.pathname.endsWith("/system/outbox")) return route.fulfill(json(200, emptyList("outbox")));
        if (url.pathname.endsWith("/system/audit-outbox")) return route.fulfill(json(200, emptyList("auditOutbox")));
        if (url.pathname.endsWith("/system/jobs")) return route.fulfill(json(200, emptyList("jobs")));
        if (url.pathname.endsWith("/system/notifications")) return route.fulfill(json(200, emptyList("notifications")));
        await route.fulfill(json(200, {}));
    });
});

test("all four jobs and outbox tabs render without an undefined filter list", async ({ page }) => {
    await page.goto("/system/jobs-outbox");
    await expect(page.getByRole("heading", { name: "System Jobs & Outbox" })).toBeVisible();
    await expect(page.getByText("Transactional outbox", { exact: true }).first()).toBeVisible();

    for (const tab of ["Audit outbox", "Background jobs", "Notifications", "Transactional outbox"]) {
        await page.getByRole("tab", { name: tab }).click();
        await expect(page.locator(".pg-table-toolbar")).toBeVisible();
        await expect(page.getByText(/No Data Found|There are no items to display/).first()).toBeVisible();
    }

    const errors = (page as unknown as { __jobsOutboxErrors: string[] }).__jobsOutboxErrors;
    expect(errors.filter((message) => /reduce|Cannot read properties of undefined/.test(message))).toEqual([]);
});
