import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

test.beforeEach(async ({ page }) => {
  await seedSession(page, ADMIN_KEY, adminSession);
});

test("the profitability page requests a supported period and renders the report", async ({ page }) => {
  const periods: string[] = [];

  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/finance/profitability")) {
      await route.fulfill(json(200, {}));
      return;
    }
    periods.push(url.searchParams.get("period") ?? "");
    await route.fulfill(
      json(200, {
        period: "last_30d",
        currency: "LYD",
        grossCommissionRevenue: "10.0000",
        gatewayCostRealized: "1.0000",
        gatewayCostAccrued: "0.5000",
        netRevenue: "9.0000",
        chargebackLosses: "0.0000",
        netContribution: "9.0000",
        commissionReceivable: "2.0000",
        byRail: [{ railCode: "sadad", gross: "10.0000", cost: "1.0000", net: "9.0000" }],
        byDay: [{ day: "2026-01-01", gross: "10.0000", cost: "1.0000", net: "9.0000" }],
        byGateway: [{ gatewayCode: "sadad-gw", gross: "10.0000", cost: "1.0000", net: "9.0000" }],
      }),
    );
  });

  await page.goto("/finance/profitability");
  await expect(page.getByText("Net Contribution", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("sadad-gw", { exact: true })).toBeVisible();
  expect(periods).toContain("last_30d");
});
