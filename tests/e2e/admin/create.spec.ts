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

test("creates a gateway and opens its wizard", async ({ page }) => {
  let posted: any = null;
  await page.route("**/api/v1/admin/**", (route) =>
    route.fulfill(json(200, {})),
  );
  await page.route("**/api/v1/admin/gateways", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      await route.fulfill(json(201, { id: "gw-1", code: "test-gw", status: "DRAFT" }));
      return;
    }
    await route.fulfill(json(200, { gateways: [] }));
  });

  await page.goto("/gateways");
  await expect(page.getByRole("button", { name: "New Gateway" })).toBeVisible();
  await page.getByRole("button", { name: "New Gateway" }).click();

  await page.getByLabel("Gateway Code").fill("test-gw");
  await page.getByLabel("Gateway", { exact: true }).fill("Test Gateway");
  await page.getByLabel("Operator").fill("Test Operator");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page).toHaveURL(/\/gateways\/wizard\/gw-1/);
  expect(posted).toMatchObject({
    code: "test-gw",
    name: "Test Gateway",
    operator: "Test Operator",
    kind: "DIRECT",
    country: "LY",
    riskClass: "NORMAL",
  });
});

test("creates a rail from the Rails page", async ({ page }) => {
  let posted: any = null;
  await page.route("**/api/v1/admin/**", (route) => route.fulfill(json(200, {})));
  await page.route("**/api/v1/admin/rails*", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      await route.fulfill(json(201, { id: "rail-1", code: "test-rail" }));
      return;
    }
    await route.fulfill(json(200, { rails: [] }));
  });

  await page.goto("/rails");
  await page.getByRole("button", { name: "Add Rail" }).click();
  await page.getByLabel("Rail Code").fill("test-rail");
  await page.getByLabel("Label (English)").fill("Test Rail");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page.getByRole("button", { name: "Create", exact: true })).toHaveCount(0);
  expect(posted).toMatchObject({ code: "test-rail", name: "Test Rail", collectionMode: "REDIRECT", active: true });
});

test("creates a route from the Routes page", async ({ page }) => {
  let posted: any = null;
  await page.route("**/api/v1/admin/**", (route) => route.fulfill(json(200, {})));
  await page.route("**/api/v1/admin/rails*", (route) =>
    route.fulfill(json(200, { rails: [{ id: "rail-1", code: "sadad", nameEn: "Sadad" }] })),
  );
  await page.route("**/api/v1/admin/gateways", (route) =>
    route.fulfill(json(200, { gateways: [{ id: "gw-1", code: "sadad-gw", name: "Sadad Gateway" }] })),
  );
  await page.route("**/api/v1/admin/routes", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      await route.fulfill(json(201, { id: "route-1", status: "ACTIVE" }));
      return;
    }
    await route.fulfill(json(200, { routes: [] }));
  });

  await page.goto("/routes");
  await page.getByRole("button", { name: "Add Route" }).click();
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Create", exact: true }).click();

  expect(posted).toMatchObject({
    railId: "rail-1",
    gatewayId: "gw-1",
    credentialPolicy: "PLATFORM",
    environment: "live",
  });
});

test("the existing row dialogs open (v-model fix)", async ({ page }) => {
  await page.route("**/api/v1/admin/**", (route) => route.fulfill(json(200, {})));
  await page.route("**/api/v1/admin/rails*", (route) => {
    if (route.request().url().includes("/fields")) {
      return route.fulfill(json(200, { fields: [] }));
    }
    return route.fulfill(
      json(200, {
        rails: [
          {
            id: "rail-1",
            code: "sadad",
            nameEn: "Sadad",
            nameAr: "سداد",
            collectionMode: "OTP_PULL",
            currency: "LYD",
            minAmount: "1.0000",
            maxAmount: "5000.0000",
            capabilities: [],
            fields: [],
          },
        ],
      }),
    );
  });

  await page.goto("/rails");
  await page.getByRole("button", { name: "Customer Catalog" }).click();
  await expect(page.getByText("Sadad (sadad)")).toBeVisible();
});

test("the gateway table filters by the search box", async ({ page }) => {
  await page.route("**/api/v1/admin/**", (route) => route.fulfill(json(200, {})));
  const gateways = [
    { id: "g1", code: "alpha_gw", name: "Alpha", operator: "A", country: "LY", kind: "DIRECT", verificationState: "VERIFIED", riskClass: "NORMAL", aliases: [], versions: [] },
    { id: "g2", code: "beta_gw", name: "Beta", operator: "B", country: "LY", kind: "DIRECT", verificationState: "VERIFIED", riskClass: "NORMAL", aliases: [], versions: [] },
    { id: "g3", code: "gamma_gw", name: "Gamma", operator: "C", country: "LY", kind: "DIRECT", verificationState: "VERIFIED", riskClass: "NORMAL", aliases: [], versions: [] },
  ];
  const searches: string[] = [];
  await page.route("**/api/v1/admin/gateways*", (route) => {
    const search = new URL(route.request().url()).searchParams.get("search") ?? "";
    searches.push(search);
    const rows = search ? gateways.filter((row) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase())) : gateways;
    return route.fulfill(json(200, { gateways: rows, total: rows.length, page: 1, pageSize: 200 }));
  });

  await page.goto("/gateways");
  await expect(page.locator("table")).toContainText("alpha_gw");
  await page.getByPlaceholder("Search").fill("beta");
  await expect.poll(() => searches).toContain("beta");
  await expect(page.locator("table")).toContainText("beta_gw");
  await expect(page.locator("table")).not.toContainText("alpha_gw");
});
