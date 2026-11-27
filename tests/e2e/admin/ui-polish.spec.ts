import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, adminSession, mockApi, seedSession } from "../fixtures";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const merchant = {
  id: "mch_1",
  legalName: "Acme Trading LLC",
  tradeName: "Acme Store",
  taxId: "TAX-1",
  registrationNo: "REG-1",
  businessCategory: "Retail",
  status: "ACTIVE",
  kybStatus: "VERIFIED",
  riskTier: "STANDARD",
  onboardingChannel: "SELF_SERVICE",
  country: "LY",
  contactEmail: "acme@example.com",
  contactPhone: "+218910000000",
  negativeBalanceCeiling: "0.0000",
  commissionReceivableCeiling: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  suspendedAt: null,
  wallets: [],
  applications: [],
  users: [],
  accessTokens: [],
  credentialSets: [],
  beneficialOwners: [],
  kybDocuments: [],
  revalidations: [],
  joinRequests: [],
  amlCases: [],
  pendingChanges: [],
  pendingApprovalCount: 0,
  redactedFields: [],
  version: 1,
  displayName: "Acme Store",
};

const mockMerchantApi = async (page: Page, rows: unknown[] = [merchant]) => {
  await page.route("**/api/v1/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (/\/merchants\/mch_1$/.test(url.pathname)) {
      await route.fulfill(json(200, { merchant }));
      return;
    }
    if (url.pathname.endsWith("/merchants")) {
      await route.fulfill(json(200, { merchants: rows, total: rows.length, page: 1, pageSize: 200 }));
      return;
    }
    await route.fulfill(json(200, {}));
  });
};

test.beforeEach(async ({ page }) => {
  await seedSession(page, ADMIN_KEY, adminSession);
});

test("merchant detail gives every section one end-aligned header and one expand/collapse command", async ({ page }) => {
  await mockMerchantApi(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/merchants/mch_1");

  const sections = page.locator(".merchant-section");
  await expect(sections.first()).toBeVisible();
  const count = await sections.count();
  expect(count).toBeGreaterThan(4);

  const first = sections.first();
  const cardStyle = await first.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(cardStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(cardStyle.border).toBe("1px");
  expect(parseFloat(cardStyle.radius)).toBeGreaterThan(0);

  const headerBox = await first.locator(".merchant-section__header").boundingBox();
  const metaBox = await first.locator(".merchant-section__meta").boundingBox();
  expect(headerBox).toBeTruthy();
  expect(metaBox).toBeTruthy();
  // The chevron sits at the inline end, not in the middle of a half-width cell.
  expect(metaBox!.x).toBeGreaterThan(headerBox!.x + headerBox!.width - 60);

  const pageHeaderActions = page.locator(".pg-page-header__actions");
  const actionsFit = await pageHeaderActions.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
    height: element.getBoundingClientRect().height,
  }));
  expect(actionsFit.scroll).toBeLessThanOrEqual(actionsFit.client + 1);
  expect(actionsFit.height).toBeGreaterThan(38);

  const suspend = page.getByRole("button", { name: "Suspend", exact: true });
  await expect(suspend).toHaveClass(/pg-btn--outlined/);
  expect(
    await suspend.evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgb(220, 38, 38)");

  await expect(first.locator(".merchant-section__header")).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  for (let index = 0; index < count; index += 1) {
    await expect(sections.nth(index).locator(".merchant-section__header")).toHaveAttribute("aria-expanded", "false");
  }
  await expect(page.locator(".merchant-section__body")).toHaveCount(0);

  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  for (let index = 0; index < count; index += 1) {
    await expect(sections.nth(index).locator(".merchant-section__header")).toHaveAttribute("aria-expanded", "true");
  }

  // Table-only sections have no body padding: the table card is the surface.
  const flushBody = sections.filter({ has: page.locator(".pg-table-card") }).first().locator(".merchant-section__body");
  await expect(flushBody).toHaveCSS("padding", "0px");
});

test("table and filter chrome are flat, inputs use a monochrome focus outline and autocomplete keeps multi-select open", async ({ page }) => {
  await mockMerchantApi(page);
  await page.goto("/merchants");
  await expect(page.locator("table")).toContainText("Acme Store");

  const tableCard = await page.locator(".pg-table-card").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(tableCard).toEqual({ border: "0px", radius: "0px" });

  const actionsCell = await page.locator(".pg-table-card .pg-col-actions").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, border: style.borderInlineStartWidth };
  });
  expect(actionsCell.shadow).toBe("none");
  expect(parseFloat(actionsCell.border)).toBeGreaterThanOrEqual(2);

  const filters = page.locator(".pg-table-filters").first();
  await expect(filters).toBeVisible();
  const filterFrame = await filters.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(filterFrame).toEqual({ border: "0px", radius: "0px" });

  const search = page.getByRole("searchbox", { name: "Search" }).first();
  await search.focus();
  await page.waitForTimeout(200);
  const focus = await search.evaluate((element) => {
    const style = getComputedStyle(element.closest(".pg-control-box") as HTMLElement);
    return { outline: style.outlineColor, width: style.outlineWidth, shadow: style.boxShadow };
  });
  expect(focus).toMatchObject({ outline: "rgb(15, 23, 42)", width: "2px", shadow: "none" });

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.getByRole("searchbox", { name: "Search" }).first().focus();
  await page.waitForTimeout(200);
  const darkFocus = await page.getByRole("searchbox", { name: "Search" }).first().evaluate((element) => {
    const style = getComputedStyle(element.closest(".pg-control-box") as HTMLElement);
    return { outline: style.outlineColor, shadow: style.boxShadow };
  });
  expect(darkFocus).toEqual({ outline: "rgb(228, 228, 231)", shadow: "none" });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  const status = page.getByRole("combobox", { name: "Status", exact: true }).first();
  await status.click();
  const panel = page.locator(".pg-ac-panel").first();
  await expect(panel).toBeVisible();
  const panelFrame = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { radius: style.borderTopLeftRadius, padding: style.paddingTop, border: style.borderTopWidth };
  });
  expect(panelFrame).toEqual({ radius: "0px", padding: "0px", border: "1px" });

  const option = panel.locator("[role=option]").first();
  const optionNode = await option.elementHandle();
  await option.hover();
  await page.waitForTimeout(150);
  // Hover must be CSS-only: the option node survives and the panel is not rebuilt.
  expect(await optionNode!.evaluate((element) => element.isConnected)).toBe(true);
  const optionBox = await option.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(optionBox!.width).toBeGreaterThan(panelBox!.width - 4);
  const optionTone = await option.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(optionTone).not.toBe("rgba(0, 0, 0, 0)");

  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
  // The filter selection triggers a table refresh. The menu must survive it.
  await page.waitForTimeout(800);
  await expect(panel).toBeVisible();
  // The list is patched in place; selecting does not replace the option nodes.
  expect(await optionNode!.evaluate((element) => element.isConnected)).toBe(true);

  await panel.locator("[role=option]").nth(1).click();
  await page.waitForTimeout(800);
  await expect(panel).toBeVisible();
  const trigger = page.locator("[data-pg-autocomplete]").first();
  const chipState = await trigger.evaluate((element) => {
    const values = element.querySelector(".pg-ac-values") as HTMLElement;
    return {
      labels: [...element.querySelectorAll(".pg-ac-chip__label")].map((node) => node.textContent),
      overflow: element.querySelector(".pg-ac-chip--overflow")?.textContent,
      triggerHeight: element.clientHeight,
      triggerScroll: element.scrollHeight,
      valuesWrap: getComputedStyle(values).flexWrap,
    };
  });
  expect(chipState.labels).toEqual(["PENDING"]);
  expect(chipState.overflow).toBe("+1");
  expect(chipState.triggerScroll).toBeLessThanOrEqual(chipState.triggerHeight + 1);
  expect(chipState.valuesWrap).toBe("nowrap");
});

test("help drawer owns the whole viewport and merchant help sections sit on the page canvas", async ({ page }) => {
  await mockMerchantApi(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/merchants");
  await page.getByRole("button", { name: "How this page works" }).first().click();
  const drawer = page.locator(".guide-context-drawer");
  await expect(drawer).toBeVisible();
  const geometry = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: window.innerHeight };
  });
  expect(geometry.top).toBe(0);
  expect(geometry.height).toBe(geometry.viewport);
  expect(geometry.bottom).toBe(geometry.viewport);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  const helpPanel = page.locator(".pg-expansion").first();
  await helpPanel.scrollIntoViewIfNeeded();
  await expect(helpPanel).toBeVisible();
  expect(await helpPanel.evaluate((element) => Boolean(element.closest(".pg-card")))).toBe(false);
  const header = helpPanel.locator(".pg-expansion__header").first();
  await header.hover();
  await page.waitForTimeout(160);
  const headerTone = await header.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(headerTone).not.toBe("rgba(0, 0, 0, 0)");
  await header.click();
  const body = helpPanel.locator(".pg-expansion-panel--open > .pg-expansion__body").first();
  await expect(body).toBeVisible();
  const bodyPad = await body.evaluate((element) => getComputedStyle(element).paddingTop);
  expect(parseFloat(bodyPad)).toBeGreaterThanOrEqual(12);

  const refresh = page.getByRole("button", { name: "Refresh", exact: true }).first();
  await expect(refresh).toHaveClass(/pg-btn--tonal/);
  const refreshStyle = await refresh.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderTopWidth };
  });
  expect(refreshStyle.background).toBe("rgb(255, 255, 255)");
  expect(refreshStyle.border).toBe("1px");
});

test("an empty table has no nested rounded body frame", async ({ page }) => {
  await mockMerchantApi(page, []);
  await page.goto("/merchants");
  await expect(page.locator(".pg-table-empty-row")).toBeVisible();
  const flat = await page.locator(".pg-table-card").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(flat).toEqual({ border: "0px", radius: "0px" });
  const medallion = await page.locator(".pg-table-empty-row .pg-empty__medallion").evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(medallion).toEqual({ border: "0px", radius: "0px" });
});

test("the filter surface opens on a phone instead of staying permanently empty", async ({ page }) => {
  await mockMerchantApi(page);
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto("/merchants");
  await expect(page.locator("table")).toContainText("Acme Store");
  await expect(page.locator(".pg-table-filters")).toHaveCount(0);
  await page.getByRole("button", { name: /Filters/ }).first().click();
  await expect(page.locator(".pg-table-filters")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Status", exact: true }).first()).toBeVisible();
});

test("Review attention is an outlined danger utility, not a filled red block", async ({ page }) => {
  const row = {
    id: "set-1",
    key: "custom.unknown_key",
    scope: "GLOBAL",
    version: 1,
    valueJson: { enabled: true },
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await page.route("**/api/v1/admin/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/settings")) {
      return route.fulfill(json(200, { settings: [row] }));
    }
    return route.fulfill(json(200, {}));
  });
  await page.goto("/settings/platform");
  const review = page.getByRole("button", { name: "Review attention", exact: true });
  await expect(review).toBeVisible();
  await expect(review).toHaveClass(/pg-btn--outlined-danger/);
  const style = await review.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, border: computed.borderTopWidth, borderColor: computed.borderTopColor };
  });
  expect(style.background).toBe("rgba(0, 0, 0, 0)");
  expect(style.border).toBe("1px");
  expect(style.borderColor).not.toBe("rgba(0, 0, 0, 0)");
});


test("the KPI strip is one framed surface with square wrapping cells", async ({ page }) => {
  await mockApi(page, {
    "/stats/overview": {
      attemptsByState: { CREATED: 3, SUCCEEDED: 12, FAILED: 1 },
      unknownBacklog: 2,
      unknownOldestAgeSeconds: 90,
      openCircuitBreakers: 1,
      webhookInboxLagSeconds: 0,
      reconciliationMatchRate: "98.4",
      approvalQueueAgeing: [
        { domain: "MERCHANT", oldestHours: 30, count: 3 },
        { domain: "FINANCE", oldestHours: 80, count: 1 },
        { domain: "AML", oldestHours: 4, count: 2 },
      ],
      routeHealth: { healthy: 8, degraded: 2, openBreaker: 1, forced: 1, conflicts: 0 },
      joinRequestSlaBreaches: 0,
      amlSlaBreaches: 1,
      merchantsActive: 7,
      merchantsPending: 2,
    },
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard");
  const strip = page.locator(".pg-metric-strip").first();
  await expect(strip).toBeVisible();
  const geometry = await strip.evaluate((element) => {
    const parent = getComputedStyle(element);
    const tile = element.querySelector(".pg-metric-tile") as HTMLElement;
    const child = getComputedStyle(tile);
    return {
      gap: parent.rowGap,
      parentRadius: parseFloat(parent.borderTopLeftRadius),
      parentBackground: parent.backgroundColor,
      childRadius: parseFloat(child.borderTopLeftRadius),
      childBorder: child.borderTopWidth,
      childMarginInlineEnd: child.marginInlineEnd,
      childMarginBottom: child.marginBottom,
      childBackground: child.backgroundColor,
    };
  });
  expect(geometry.gap).toBe("1px");
  expect(geometry.parentRadius).toBeGreaterThan(0);
  expect(geometry.childRadius).toBe(0);
  expect(geometry.childBorder).toBe("0px");
  expect(geometry.childMarginInlineEnd).toBe("0px");
  expect(geometry.childMarginBottom).toBe("0px");
  expect(geometry.parentBackground).not.toBe(geometry.childBackground);

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const dark = await strip.evaluate((element) => ({
    parent: getComputedStyle(element).backgroundColor,
    child: getComputedStyle(element.querySelector(".pg-metric-tile") as HTMLElement).backgroundColor,
  }));
  expect(dark.parent).not.toBe(dark.child);
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  const routeCard = page.locator(".pg-dash-card", { hasText: "Route health" }).first();
  await expect(routeCard.getByText("Open breaker")).toBeVisible();
  await expect(routeCard.locator(".pg-health__row")).toHaveCount(3);
  await expect(routeCard.locator(".pg-health__bar")).toBeVisible();
  const routeButton = routeCard.getByRole("button", { name: "Open routes" });
  const routeBox = await routeCard.boundingBox();
  const buttonBox = await routeButton.boundingBox();
  expect(routeBox!.y + routeBox!.height - (buttonBox!.y + buttonBox!.height)).toBeLessThan(40);

  const queueCard = page.locator(".pg-dash-card", { hasText: "Approval queue by domain" }).first();
  await expect(queueCard.locator(".pg-approval-row")).toHaveCount(3);
  const approvalsButton = queueCard.getByRole("button", { name: "Open approvals" });
  const queueBox = await queueCard.boundingBox();
  const approvalsBox = await approvalsButton.boundingBox();
  expect(queueBox!.y + queueBox!.height - (approvalsBox!.y + approvalsBox!.height)).toBeLessThan(40);
});

test("a selected checkbox keeps its selected surface on hover", async ({ page }) => {
  await mockApi(page);
  await page.goto("/dashboard");
  const input = page.locator(".pg-chk__native").first();
  if ((await input.count()) === 0) return;
  await input.check();
  const box = input.locator("xpath=..").locator(".pg-chk__box");
  const before = await box.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(before).not.toBe("rgba(0, 0, 0, 0)");
  await box.hover();
  const after = await box.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(after).toBe(before);
});


test("dashboard checklists and the no-padding table header keep their insets", async ({ page }) => {
  await mockApi(page);
  await page.goto("/dashboard");
  const checklist = page.locator(".pg-card-text", { hasText: "Snapshot export checklist" }).first();
  await expect(checklist).toBeVisible();
  const spacing = await checklist.evaluate((element) => {
    const items = Array.from(element.children).find((child) => child.tagName === "DIV") as HTMLElement;
    return {
      titleGap: getComputedStyle(element).rowGap,
      itemGap: getComputedStyle(items).rowGap,
    };
  });
  expect(spacing.titleGap).toBe("4px");
  expect(spacing.itemGap).toBe("2px");

  const recent = page.locator(".pg-card", { hasText: "Recent attempts" }).first();
  const headerPadding = await recent.locator(".pg-card__header").evaluate((element) => getComputedStyle(element).paddingInlineStart);
  expect(parseFloat(headerPadding)).toBeGreaterThanOrEqual(16);
});


test("segmented tabs never create a vertical scroll region", async ({ page }) => {
  await mockApi(page);
  await page.goto("/dashboard");
  const tabs = page.locator(".pg-segmented").first();
  await expect(tabs).toBeVisible();
  const metrics = await tabs.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(metrics.overflowY).toBe("hidden");
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
});

test("search palettes paint one surface and no dialog frame", async ({ page }) => {
  await mockApi(page);
  await page.goto("/dashboard");
  await expect(page.locator(".pg-metric-strip")).toBeVisible();
  await page.keyboard.press("Control+k");
  const globalSurface = page.locator(".pg-command-surface");
  await expect(globalSurface).toBeVisible();
  const global = await page.evaluate(() => {
    const dialog = document.querySelector(".pg-command-dialog") as HTMLElement;
    const surface = document.querySelector(".pg-command-surface") as HTMLElement;
    const body = dialog?.querySelector(".pg-dialog__body") as HTMLElement;
    return {
      dialogBorder: getComputedStyle(dialog).borderTopWidth,
      dialogBackground: getComputedStyle(dialog).backgroundColor,
      dialogShadow: getComputedStyle(dialog).boxShadow,
      bodyPadding: getComputedStyle(body).paddingTop,
      surfaceBorder: getComputedStyle(surface).borderTopWidth,
      surfaceShadow: getComputedStyle(surface).boxShadow,
    };
  });
  expect(global.dialogBorder).toBe("0px");
  expect(global.dialogBackground).toBe("rgba(0, 0, 0, 0)");
  expect(global.dialogShadow).toBe("none");
  expect(global.bodyPadding).toBe("0px");
  expect(global.surfaceBorder).not.toBe("0px");
  expect(global.surfaceShadow).not.toBe("none");

  await page.keyboard.press("Escape");
  await expect(globalSurface).toBeHidden();
  await page.keyboard.press("Control+Shift+k");
  const guideSurface = page.locator(".guide-search-surface");
  await expect(guideSurface).toBeVisible();
  const guide = await page.evaluate(() => {
    const dialog = document.querySelector(".guide-search-dialog") as HTMLElement;
    const surface = document.querySelector(".guide-search-surface") as HTMLElement;
    return {
      dialogBorder: getComputedStyle(dialog).borderTopWidth,
      dialogBackground: getComputedStyle(dialog).backgroundColor,
      surfaceBorder: getComputedStyle(surface).borderTopWidth,
      surfaceShadow: getComputedStyle(surface).boxShadow,
    };
  });
  expect(guide.dialogBorder).toBe("0px");
  expect(guide.dialogBackground).toBe("rgba(0, 0, 0, 0)");
  expect(guide.surfaceBorder).not.toBe("0px");
  expect(guide.surfaceShadow).not.toBe("none");
});

test("navigation moves the active marker and keeps focus on the clicked route", async ({ page }) => {
  await mockMerchantApi(page);
  await page.goto("/dashboard");
  const merchants = page.locator('.pg-nav-item[href="/merchants"]').first();
  const dashboard = page.locator('.pg-nav-item[href="/dashboard"]').first();
  await expect(dashboard).toHaveClass(/pg-list-item--active/);
  await merchants.click();
  await expect(page).toHaveURL(/\/merchants$/);
  await expect(merchants).toHaveClass(/pg-list-item--active/);
  await expect(merchants).toHaveAttribute("aria-current", "page");
  await expect(dashboard).not.toHaveClass(/pg-list-item--active/);
  const focused = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    return { tag: element?.tagName, href: element?.getAttribute?.("href"), className: (element?.className || "").toString() };
  });
  expect(focused.tag).toBe("A");
  expect(focused.href).toBe("/merchants");
  expect(focused.className).toContain("pg-list-item--active");
});

test("a row action menu is the topmost layer over the table header", async ({ page }) => {
  await mockMerchantApi(page, Array.from({ length: 6 }, (_, index) => ({ ...merchant, id: `mch_${index}`, tradeName: `Acme ${index}` })));
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto("/merchants");
  await page.locator("tbody tr").nth(2).getByRole("button", { name: "Row actions" }).click();
  const panel = page.locator(".pg-row-actions__panel");
  await expect(panel).toBeVisible();
  const layer = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const points: Array<{ x: number; y: number }> = [];
    for (let column = 1; column <= 4; column += 1) {
      for (let row = 1; row <= 4; row += 1) {
        points.push({
          x: rect.left + (rect.width * column) / 5,
          y: rect.top + (rect.height * row) / 5,
        });
      }
    }
    const visible = points.filter(({ x, y }) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      return Boolean(hit && element.contains(hit));
    }).length;
    return {
      zIndex: getComputedStyle(element).zIndex,
      visible,
      total: points.length,
      inFloatingLayer: element.parentElement?.hasAttribute("data-pg-floating-layer") ?? false,
    };
  });
  expect(layer.zIndex).toBe("1200");
  expect(layer.inFloatingLayer).toBe(true);
  expect(layer.visible).toBe(layer.total);
  const rowOutline = await page.locator("tbody tr").nth(2).evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(rowOutline).toBe("none");
});


test("the app shell owns the viewport and only the main canvas scrolls", async ({ page }) => {
  await mockMerchantApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const route of ["/dashboard", "/merchants", "/system/backups"]) {
    await page.goto(route);
    await page.waitForTimeout(250);
    const metrics = await page.evaluate(() => {
      const main = document.querySelector(".pg-main") as HTMLElement;
      const app = document.querySelector(".pg-app") as HTMLElement;
      return {
        doc: document.scrollingElement?.scrollHeight ?? 0,
        inner: window.innerHeight,
        appHeight: Math.round(app.getBoundingClientRect().height),
        mainScrollable: main.scrollHeight > main.clientHeight,
        mainOverflow: getComputedStyle(main).overflowY,
      };
    });
    expect(metrics.doc).toBeLessThanOrEqual(metrics.inner + 1);
    expect(metrics.appHeight).toBeLessThanOrEqual(metrics.inner + 1);
    expect(metrics.mainOverflow).toBe("auto");
    expect(metrics.mainScrollable).toBe(true);
  }
  await page.goto("/merchants");
  await page.waitForTimeout(200);
  await page.locator(".pg-main").click({ position: { x: 500, y: 300 } });
  const focused = await page.evaluate(() => document.activeElement?.className?.toString() ?? "");
  expect(focused).not.toContain("pg-main");
});


test("the summary export checklist merges with its card and rows are vertically symmetric", async ({ page }) => {
  await mockApi(page, {
    "/approvals": { approvals: [], total: 0, page: 1, pageSize: 200 },
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/approvals");
  const card = page.locator(".pg-summary-export").first();
  await expect(card).toBeVisible();
  const checklist = card.locator(".pg-checklist").first();
  await expect(checklist).toBeVisible();

  const layout = await checklist.evaluate((element) => {
    const body = element.closest(".pg-card__body") as HTMLElement;
    const title = element.querySelector(".pg-checklist__title") as HTMLElement;
    const list = element.querySelector(".pg-checklist__list") as HTMLElement;
    const hint = element.querySelector(".pg-checklist__hint") as HTMLElement;
    const row = list.querySelector(".pg-checklist__row") as HTMLElement;
    const label = row.querySelector(".pg-chk__label") as HTMLElement;
    const field = row.querySelector(".pg-checkbox-field") as HTMLElement;
    const rect = (node: HTMLElement) => node.getBoundingClientRect();
    return {
      rootBorder: getComputedStyle(element).borderTopWidth,
      listBorder: getComputedStyle(list).borderTopWidth,
      bodyLeft: rect(body).left,
      checklistLeft: rect(element).left,
      titleLeft: rect(title).left,
      rowLeft: rect(row).left,
      hintLeft: rect(hint).left,
      topGap: rect(label).top - rect(row).top,
      bottomGap: rect(row).bottom - rect(label).bottom,
      fieldHeight: Math.round(rect(field).height),
    };
  });

  expect(layout.rootBorder).toBe("0px");
  expect(layout.listBorder).toBe("0px");
  for (const left of [layout.titleLeft, layout.rowLeft, layout.hintLeft]) {
    expect(Math.abs(left - layout.checklistLeft)).toBeLessThanOrEqual(1);
    expect(left - layout.bodyLeft).toBeGreaterThanOrEqual(16);
  }
  expect(Math.abs(layout.topGap - layout.bottomGap)).toBeLessThanOrEqual(2);
  expect(layout.fieldHeight).toBeLessThanOrEqual(22);
});
