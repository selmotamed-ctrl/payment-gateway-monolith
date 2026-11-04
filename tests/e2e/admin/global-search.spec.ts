import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, mockApi, seedSession } from "../fixtures";

const searchResponse = {
  query: "acme",
  groups: [
    {
      type: "merchant",
      truncated: false,
      items: [
        {
          id: "merchant-1",
          title: "Acme Store",
          subtitle: "Active merchant · retail",
          reference: "merchant-1",
          status: "ACTIVE",
          merchantId: "merchant-1",
        },
      ],
    },
  ],
  total: 1,
  tookMs: 3,
  partial: false,
};

test.describe("admin global deep search", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, ADMIN_KEY, adminSession);
    await mockApi(page, { "/search": searchResponse });
  });

  test("the app bar opens the deep palette while the drawer keeps guide search", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");

    const trigger = page.getByRole("button", { name: "Search everything (Ctrl+K)" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const input = page.getByRole("combobox", { name: /Search everything/ });
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.getByRole("button", { name: "Search guide…" }).click();
    await expect(page.getByRole("combobox", { name: /Search the guide/ })).toBeVisible();
  });

  test("Ctrl+K searches records with debounce and Enter opens the exact record", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Search everything (Ctrl+K)" })).toBeVisible();
    await page.keyboard.press("Control+k");

    const input = page.getByRole("combobox", { name: /Search everything/ });
    await input.fill("acme");

    await expect(page.locator(".pg-command-group__header", { hasText: "Merchants" })).toBeVisible();
    await expect(page.locator(".pg-command-item", { hasText: "Acme Store" })).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/merchants\/merchant-1/);
  });

  test("one-character queries still search local pages and explain the record minimum", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Search everything (Ctrl+K)" })).toBeVisible();
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox", { name: /Search everything/ });
    await input.fill("m");

    await expect(page.getByText(/Type at least 2 characters/)).toBeVisible();
    await expect(page.locator(".pg-command-item", { hasText: "Merchants" })).toBeVisible();
  });

  test("mobile keeps an accessible icon trigger and a usable palette", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");

    const trigger = page.getByRole("button", { name: "Search everything (Ctrl+K)" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    await expect(page.getByRole("combobox", { name: /Search everything/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Records" })).toBeVisible();
  });

  test("audit log deep links open the exact record drawer", async ({ page }) => {
    await seedSession(page, ADMIN_KEY, {
      ...adminSession,
      userInfo: {
        ...adminSession.userInfo,
        authoritiesMap: {
          ...adminSession.userInfo.authoritiesMap,
          "security:read": true,
        },
      },
    });
    await mockApi(page, {
      "/audit-logs/audit-1": {
        auditLog: {
          id: "audit-1",
          createdAt: "2026-01-01T10:00:00.000Z",
          actorId: "admin-1",
          actorEmail: "admin@pgtest.lan",
          role: "GATEWAY_ADMIN",
          action: "MERCHANT_UPDATED",
          entityType: "MERCHANT",
          entityId: "merchant-1",
          beforeJson: {},
          afterJson: {},
          approvalRequestId: null,
        },
      },
    });
    await page.goto("/audit-logs?open=audit-1");
    await expect(page.getByText("MERCHANT_UPDATED", { exact: true })).toBeVisible();
  });
});
