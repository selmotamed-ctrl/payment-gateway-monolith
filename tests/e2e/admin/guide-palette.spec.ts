import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, mockApi, seedSession } from "../fixtures";

test.describe("admin guide command palette", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    await mockApi(page);
    await page.goto("/guide");
    await expect(page.getByRole("heading", { name: "Interactive Guide" })).toBeVisible();
  });

  test("Ctrl+Shift+K opens, Enter navigates and Escape closes with focus restored", async ({ page }) => {
    await page.keyboard.press("Control+Shift+k");
    const input = page.getByRole("combobox", { name: /Search the guide/ });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill("UNKNOWN");
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/guide\/(a|glossary)\//);

    await page.goto("/guide");
    await expect(page.getByRole("heading", { name: "Interactive Guide" })).toBeVisible();
    await page.keyboard.press("Control+Shift+k");
    await expect(page.getByRole("combobox", { name: /Search the guide/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: /Search the guide/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /Search guide/ })).toBeFocused();
  });

  test("Ctrl+Shift+K opens the guide palette from a non-guide screen", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: /Search everything/ })).toBeVisible();
    await page.keyboard.press("Control+Shift+k");

    const input = page.getByRole("combobox", { name: /Search the guide/ });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("typing only filters results and Enter opens the highlighted result", async ({ page }) => {
    await page.keyboard.press("Control+Shift+k");
    const input = page.getByRole("combobox", { name: /Search the guide/ });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    await input.pressSequentially("merchant", { delay: 30 });
    await expect(input).toHaveValue("merchant");
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole("option").first()).toBeVisible();

    // No printable key may navigate: the palette stays open on /guide until Enter.
    await page.waitForTimeout(300);
    await expect(input).toBeVisible();
    await expect(page).toHaveURL(/\/guide$/);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/guide\/(a|glossary)\//);
  });

  test("clicking a result row opens it", async ({ page }) => {
    await page.keyboard.press("Control+Shift+k");
    const input = page.getByRole("combobox", { name: /Search the guide/ });
    await input.fill("merchant");
    const first = page.getByRole("listbox").getByRole("option").first();
    await expect(first).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page).toHaveURL(/\/guide$/);

    await first.click();
    await expect(page).toHaveURL(/\/guide\/(a|glossary)\//);
  });

  test("the ESC badge never overlaps the search input", async ({ page }) => {
    await page.keyboard.press("Control+Shift+k");
    const input = page.getByRole("combobox", { name: /Search the guide/ });
    await expect(input).toBeVisible();
    const badge = page.locator(".guide-search-header .pg-kbd-badge");
    await expect(badge).toHaveText("ESC");

    const inputBox = await input.boundingBox();
    const badgeBox = await badge.boundingBox();
    expect(inputBox).not.toBeNull();
    expect(badgeBox).not.toBeNull();
    expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(badgeBox!.x + 1);

    // The palette header is a flex row with an ESC badge, never a second close X.
    await expect(page.locator(".guide-search-header .pg-dialog__close")).toHaveCount(0);
  });
});
