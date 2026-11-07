import { expect, test } from "@playwright/test";
import { MERCHANT_KEY, merchantSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const link = (index: number) => ({
    id: `lnk_${index}`,
    linkKey: `lnk_${index}`,
    description: `Payment link ${index}`,
    amount: "25.0000",
    currency: "LYD",
    useCount: 5,
    confirmedCount: 1,
    activeLockedCount: 0,
    status: "ACTIVE",
    expiresAt: "2026-12-01T00:00:00.000Z",
    redirectUrl: null,
    railWhitelist: ["edfali"],
    applicationId: "app_1",
    createdAt: "2026-10-01T00:00:00.000Z",
});

test.beforeEach(async ({ page }) => {
    await seedSession(page, MERCHANT_KEY, merchantSession);
    await page.route("**/api/v1/**", async (route) => {
        await route.fulfill(json(200, {}));
    });
    // Registered last: Playwright matches the newest route first.
    await page.route("**/api/v1/merchant/links*", async (route) => {
        await route.fulfill(json(200, { links: [link(1), link(2)], total: 2, page: 1, pageSize: 200 }));
    });
});

const actionCell = (page: import("@playwright/test").Page) =>
    page.locator("tbody .pg-col-actions").first();

test("the payment links action column is sticky at both ends of the table", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/portal/links");
    const wrapper = page.locator(".table-wrapper").first();
    await expect(wrapper).toBeVisible();

    const metrics = await wrapper.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    await expect(actionCell(page)).toBeVisible();

    const assertPinned = async () => {
        const wrapperBox = await wrapper.boundingBox();
        const cellBox = await actionCell(page).boundingBox();
        expect(wrapperBox).not.toBeNull();
        expect(cellBox).not.toBeNull();
        expect(cellBox!.x).toBeGreaterThanOrEqual(wrapperBox!.x - 1);
        expect(cellBox!.x + cellBox!.width).toBeLessThanOrEqual(wrapperBox!.x + wrapperBox!.width + 1);
        await expect(actionCell(page).getByRole("button", { name: "Row actions" })).toBeVisible();
    };

    await wrapper.evaluate((element) => {
        element.scrollLeft = 0;
    });
    await assertPinned();
    await wrapper.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
    });
    await assertPinned();
});

test("right-click opens the payment link actions including the primary action", async ({ page }) => {
    await page.goto("/portal/links");
    const row = page.locator("tbody tr").first();
    await expect(row).toBeVisible();
    // The handler lives on the <tr>. A native MouseEvent keeps the assertion
    // immune to sticky-cell hit testing while the admin suite covers a real
    // right-click.
    await expect(row.getByRole("button", { name: "Row actions" })).toBeVisible();
    await row.evaluate((element) => {
        element.dispatchEvent(
            new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: 320,
                clientY: 280,
                button: 2,
            }),
        );
    });

    const menu = page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]').last();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Generate QR" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]')).toHaveCount(0);
});

test("Shift+F10 opens the payment link actions and Escape closes them", async ({ page }) => {
    await page.goto("/portal/links");
    const trigger = page.locator("tbody tr").first().getByRole("button", { name: "Row actions" });
    await trigger.focus();
    await page.keyboard.press("Shift+F10");

    const menu = page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]').last();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]')).toHaveCount(0);
});
