import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, mockApi, seedSession } from "../fixtures";

test.describe("admin guide command palette", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    await mockApi(page);
    await page.goto("/guide");
    await expect(page.getByRole("heading", { name: "Interactive Guide" })).toBeVisible();
  });

  test("Ctrl+K opens, Enter navigates and Escape closes with focus restored", async ({ page }) => {
    await page.keyboard.press("Control+k");
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
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("combobox", { name: /Search the guide/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: /Search the guide/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /Search guide/ })).toBeFocused();
  });
});
