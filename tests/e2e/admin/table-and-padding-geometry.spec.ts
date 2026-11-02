import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN_KEY, adminSession, mockApi, seedSession } from "../fixtures";

const GEOMETRY_PAGES = [
  "/dashboard",
  "/join-requests",
  "/kyb",
  "/merchants",
  "/approvals",
  "/users",
  "/adjustments",
  "/cashouts",
  "/reconciliation",
  "/gateways",
  "/rails",
  "/routes",
  "/settings/platform",
];

const ROUTE_ROW = {
  id: "route-1",
  railCode: "sadad",
  railName: "Sadad",
  gatewayCode: "sadad-gw",
  gatewayName: "Sadad Gateway",
  credentialPolicy: "PLATFORM",
  priority: 1,
  weight: 100,
  costModel: {},
  minAmount: "1.0000",
  maxAmount: "5000.0000",
  dailyCapAmount: "25000.0000",
  status: "ACTIVE",
  healthState: "HEALTHY",
  scope: {},
};

const readPadding = async (locator: Locator): Promise<{ left: number; top: number }> =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      left: Number.parseFloat(style.paddingLeft) || 0,
      top: Number.parseFloat(style.paddingTop) || 0,
    };
  });

const visibleElements = async (locator: Locator): Promise<Locator[]> => {
  const count = await locator.count();
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const element = locator.nth(index);
    if (await element.isVisible()) visible.push(element);
  }
  return visible;
};

const ensureExpandedFilters = async (page: Page): Promise<Locator | null> => {
  const existing = await visibleElements(page.locator(".pg-table-filters"));
  if (existing.length > 0) return existing[0];

  const trigger = page.locator(".pg-filter-trigger:visible").first();
  if ((await trigger.count()) === 0) return null;

  await trigger.click();
  await page.waitForTimeout(250);
  const expanded = await visibleElements(page.locator(".pg-table-filters"));
  return expanded[0] ?? null;
};

const expectPaddingAtLeast = async (
  page: Page,
  selector: string,
  route: string,
  minimumTop: number,
  minimumLeft: number,
): Promise<void> => {
  const elements = await visibleElements(page.locator(selector));
  for (const [index, element] of elements.entries()) {
    const padding = await readPadding(element);
    expect(padding.top, `${route} ${selector}[${index}] paddingTop`).toBeGreaterThanOrEqual(minimumTop);
    expect(padding.left, `${route} ${selector}[${index}] paddingLeft`).toBeGreaterThanOrEqual(minimumLeft);
  }
};

const expectCompactRows = async (table: Locator, label: string): Promise<void> => {
  const rows = table.locator("tbody tr");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const box = await rows.nth(index).boundingBox();
    expect(box, `${label} row ${index} must be rendered`).not.toBeNull();
    expect(box!.height, `${label} row ${index} height`).toBeLessThanOrEqual(44);
  }
};

const expectDisciplinedActions = async (table: Locator, label: string): Promise<void> => {
  const cells = table.locator(".pg-col-actions");
  const count = await cells.count();
  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    const buttonCount = await cell.locator("button:visible").count();
    const scrollHeight = await cell.evaluate((element) => element.scrollHeight);
    expect(buttonCount, `${label} action cell ${index} visible buttons`).toBeLessThanOrEqual(2);
    expect(scrollHeight, `${label} action cell ${index} scrollHeight`).toBeLessThanOrEqual(40);
  }
};

const expectAlignedFilterControls = async (filters: Locator): Promise<boolean> => {
  const grid = filters.locator(".pg-table-filters__grid").first();
  if ((await grid.count()) === 0 || !(await grid.isVisible())) return false;

  const boxes = await grid.locator(".v-field").evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { height: rect.height, y: rect.y };
      }),
  );

  if (boxes.length < 2) return false;

  const sorted = [...boxes].sort((a, b) => a.y - b.y);
  const rows: Array<Array<{ height: number; y: number }>> = [];
  for (const box of sorted) {
    const current = rows[rows.length - 1];
    if (current && Math.abs(box.y - current[0].y) <= 2) current.push(box);
    else rows.push([box]);
  }

  const sharedRows = rows.filter((row) => row.length >= 2);
  expect(sharedRows.length, "at least one filter row must contain multiple controls").toBeGreaterThan(0);

  for (const row of sharedRows) {
    const positions = row.map((box) => box.y);
    expect(Math.max(...positions) - Math.min(...positions), "filter row y alignment").toBeLessThanOrEqual(2);
    for (const box of row) {
      expect(box.height, "filter control height").toBeGreaterThanOrEqual(34);
      expect(box.height, "filter control height").toBeLessThanOrEqual(40);
    }
  }

  return true;
};

test.describe("admin table and padding geometry", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedSession(page, ADMIN_KEY, adminSession);
  });

  test("pages keep screen, section, toolbar and filter padding", async ({ page }) => {
    test.setTimeout(90_000);
    await mockApi(page);

    for (const route of GEOMETRY_PAGES) {
      await page.goto(route);

      const screen = page.locator(".pg-screen-container").first();
      await expect(screen, `${route} must render .pg-screen-container`).toBeVisible();
      const screenPadding = await readPadding(screen);
      expect(screenPadding.top, `${route} .pg-screen-container paddingTop`).toBeGreaterThanOrEqual(16);
      expect(screenPadding.left, `${route} .pg-screen-container paddingLeft`).toBeGreaterThanOrEqual(16);

      await expectPaddingAtLeast(page, ".pg-section-fields__body", route, 12, 16);
      await expectPaddingAtLeast(page, ".pg-table-toolbar", route, 12, 16);

      const filters = await ensureExpandedFilters(page);
      if (filters) {
        const filterPadding = await readPadding(filters);
        expect(filterPadding.top, `${route} .pg-table-filters paddingTop`).toBeGreaterThanOrEqual(12);
        expect(filterPadding.left, `${route} .pg-table-filters paddingLeft`).toBeGreaterThanOrEqual(16);
      }

      const table = page.locator(".pg-table-card").first();
      if ((await table.count()) > 0 && (await table.isVisible())) {
        await expectCompactRows(table, route);
        await expectDisciplinedActions(table, route);
      }
    }
  });

  test("section fields bodies keep padded interiors", async ({ page }) => {
    await mockApi(page);
    await page.goto("/routes");
    await expect(page.locator(".pg-screen-container").first()).toBeVisible();

    await page.getByRole("button", { name: /Add Route/i }).first().click();
    await expect(page.locator(".pg-section-fields__body").first()).toBeVisible();
    const bodies = await visibleElements(page.locator(".pg-section-fields__body"));
    expect(bodies.length, "/routes form must render .pg-section-fields__body").toBeGreaterThan(0);

    for (const [index, body] of bodies.entries()) {
      const padding = await readPadding(body);
      expect(padding.top, `section fields body ${index} paddingTop`).toBeGreaterThanOrEqual(12);
      expect(padding.left, `section fields body ${index} paddingLeft`).toBeGreaterThanOrEqual(16);
    }
  });

  test("compact rows, row actions and expanded filters obey v2 geometry", async ({ page }) => {
    await mockApi(page, {
      "/admin/routes": { routes: [ROUTE_ROW], total: 1, page: 1, pageSize: 20 },
    });

    await page.goto("/routes");

    const screen = page.locator(".pg-screen-container").first();
    await expect(screen).toBeVisible();
    const screenPadding = await readPadding(screen);
    expect(screenPadding.top).toBeGreaterThanOrEqual(16);
    expect(screenPadding.left).toBeGreaterThanOrEqual(16);

    const table = page.locator(".pg-table-card").first();
    await expect(table).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expectCompactRows(table, "/routes");

    const actionCells = table.locator(".pg-col-actions");
    expect(await actionCells.count(), "/routes must render .pg-col-actions cells").toBeGreaterThan(0);
    await expectDisciplinedActions(table, "/routes");

    const filters = await ensureExpandedFilters(page);
    expect(filters, "/routes must render expanded table filters").not.toBeNull();
    if (filters) {
      const filterPadding = await readPadding(filters);
      expect(filterPadding.top, "/routes .pg-table-filters paddingTop").toBeGreaterThanOrEqual(12);
      expect(filterPadding.left, "/routes .pg-table-filters paddingLeft").toBeGreaterThanOrEqual(16);
      expect(await expectAlignedFilterControls(filters), "/routes filter controls must align").toBe(true);
    }
  });
});
