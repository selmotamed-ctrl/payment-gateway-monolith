import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
});

const merchant = (id: string, name: string) => ({
    id,
    legalName: `${name} LLC`,
    tradeName: name,
    taxId: `TAX-${id}`,
    registrationNo: `REG-${id}`,
    businessCategory: "Retail",
    status: "ACTIVE",
    kybStatus: "VERIFIED",
    riskTier: "STANDARD",
    onboardingChannel: "SELF_SERVICE",
    country: "LY",
    contactEmail: `${id}@example.com`,
    contactPhone: "+218910000000",
    negativeBalanceCeiling: "0.0000",
    commissionReceivableCeiling: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    suspendedAt: null,
    activatedAt: "2026-01-02T00:00:00.000Z",
    pendingApprovalCount: 0,
});

const merchants = [merchant("mch_1", "Acme Store"), merchant("mch_2", "Beta Market")];

test.beforeEach(async ({ page }) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    await page.route("**/api/v1/admin/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/merchants")) {
            await route.fulfill(json(200, { merchants, total: merchants.length, page: 1, pageSize: 200 }));
            return;
        }
        const detail = /\/merchants\/([^/]+)$/.exec(url.pathname);
        if (detail) {
            await route.fulfill(json(200, { merchant: merchants.find((entry) => entry.id === detail[1]) ?? merchants[0] }));
            return;
        }
        await route.fulfill(json(200, {}));
    });
});

const actionCell = (page: import("@playwright/test").Page) =>
    page.locator("tbody .pg-col-actions").first();

const openContextMenu = async (page: import("@playwright/test").Page, rowIndex = 0) => {
    const row = page.locator("tbody tr").nth(rowIndex);
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "Row actions" })).toBeVisible();
    await row.locator("td").nth(2).click({ button: "right" });
    // Wait for the *active* menu: the previous one may still be in its close transition.
    const menu = page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]').last();
    await expect(menu).toBeVisible();
    return menu;
};

test("the action column is sticky at both ends of a wide table", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/merchants");
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
        expect(wrapperBox, "table wrapper geometry").not.toBeNull();
        expect(cellBox, "action cell geometry").not.toBeNull();
        expect(cellBox!.x, "action cell starts inside the scroll viewport").toBeGreaterThanOrEqual(wrapperBox!.x - 1);
        expect(
            cellBox!.x + cellBox!.width,
            "action cell ends inside the scroll viewport",
        ).toBeLessThanOrEqual(wrapperBox!.x + wrapperBox!.width + 1);
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

test("right-click opens the row actions at the pointer and runs them", async ({ page }) => {
    await page.goto("/merchants");
    const menu = await openContextMenu(page);

    await expect(menu.getByRole("menuitem", { name: "Inspect" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Open" }).click();
    await expect(page).toHaveURL(/\/merchants\/mch_1/);
});

test("the right-click menu opens at the pointer, not at the top-left of the page", async ({ page }) => {
    await page.goto("/merchants");
    for (const rowIndex of [0, 1]) {
        const cell = page.locator("tbody tr").nth(rowIndex).locator("td").nth(2);
        await expect(cell).toBeVisible();
        await cell.scrollIntoViewIfNeeded(); // the click scrolls the row into view: measure where it will actually be
        const box = (await cell.boundingBox())!;
        const click = { x: box.x + 24, y: box.y + 8 };
        await cell.click({ button: "right", position: { x: 24, y: 8 } });
        const menu = page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]').last();
        await expect(menu).toBeVisible();
        // Vuetify animates the overlay in and may flip it near an edge: wait for it to settle, then compare.
        await page.waitForTimeout(350);
        const rect = (await menu.boundingBox())!;
        const viewport = page.viewportSize()!;
        const rtl = (await page.evaluate(() => getComputedStyle(document.documentElement).direction)) === "rtl";
        const nearX = rtl ? Math.abs(rect.x + rect.width - click.x) : Math.abs(rect.x - click.x);
        const flippedUp = rect.y + rect.height <= click.y + 12;
        const nearY = flippedUp ? Math.abs(rect.y + rect.height - click.y) : Math.abs(rect.y - click.y);
        expect(nearX, `menu x (${rect.x}) is next to the pointer x (${click.x}) for row ${rowIndex}`).toBeLessThan(24);
        expect(nearY, `menu y (${rect.y}) is next to the pointer y (${click.y}) for row ${rowIndex}`).toBeLessThan(24);
        expect(rect.x + rect.width, "menu stays inside the viewport").toBeLessThanOrEqual(viewport.width + 1);
        await page.keyboard.press("Escape");
        await expect(page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]')).toHaveCount(0);
    }
});

test("only one row menu is open at a time", async ({ page }) => {
    await page.goto("/merchants");
    await openContextMenu(page, 0);
    await expect(page.getByRole("menu", { name: "Row actions" })).toHaveCount(1);

    await openContextMenu(page, 1);
    await expect(page.locator('.v-menu.v-overlay--active [role="menu"][aria-label="Row actions"]')).toHaveCount(1);
});

test("Shift+F10 opens the row actions and Escape closes them", async ({ page }) => {
    await page.goto("/merchants");
    const trigger = page.locator("tbody tr").first().getByRole("button", { name: "Row actions" });
    await trigger.focus();
    await page.keyboard.press("Shift+F10");

    const menu = page.getByRole("menu", { name: "Row actions" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
});

test("a right-click on a link keeps the native context menu", async ({ page }) => {
    await page.goto("/merchants");
    const row = page.locator("tbody tr").first();
    await expect(row).toBeVisible();

    const prevented = await row.evaluate((element) => {
        const link = document.createElement("a");
        link.href = "#";
        link.textContent = "native target";
        element.querySelector("td")?.appendChild(link);
        const event = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 20,
        });
        return !link.dispatchEvent(event);
    });

    expect(prevented).toBe(false);
    await expect(page.getByRole("menu", { name: "Row actions" })).toHaveCount(0);
});

test("the sticky action column flips in RTL and the context menu is translated", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/merchants");
    await page.getByRole("button", { name: "Language" }).click();
    await page.getByText("العربية", { exact: true }).click();

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const wrapper = page.locator(".table-wrapper").first();
    await expect(wrapper).toBeVisible();
    const wrapperBox = await wrapper.boundingBox();
    const cellBox = await actionCell(page).boundingBox();
    expect(wrapperBox).not.toBeNull();
    expect(cellBox).not.toBeNull();
    expect(cellBox!.x, "action cell is pinned to the left in RTL").toBeLessThanOrEqual(wrapperBox!.x + 1);

    const row = page.locator("tbody tr").first();
    await expect(row.locator(".pg-col-actions button[aria-haspopup='menu']").first()).toBeVisible();
    await row.locator("td").nth(2).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "إجراءات الصف" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "فتح" })).toBeVisible();
});

test("the sticky actions are reachable on a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/merchants");

    const trigger = actionCell(page).getByRole("button", { name: "Row actions" });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.getByRole("menu", { name: "Row actions" })).toBeVisible();
});
