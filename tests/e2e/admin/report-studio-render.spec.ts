import { expect, test } from "@playwright/test";
import { ADMIN_KEY, adminSession, mockApi, seedSession } from "../fixtures";

const session = {
  ...adminSession,
  userInfo: {
    ...adminSession.userInfo,
    authoritiesMap: {
      ...adminSession.userInfo.authoritiesMap,
      "report_engine:author": true,
      "report_engine:run": true,
      "reports.draft": true,
      "reports.studio": true,
      "report:review": true,
      "report:approve": true,
      "security:write": true,
      "security:read": true,
    },
  },
};

const catalogSpec = {
  spec_kind: "REPORT_DESCRIPTOR",
  spec_version: "1.0",
  report: { code: "ledger-statement", version: 1, category: "LEDGER", audience_scope: "INTERNAL", classification: "INTERNAL" },
  page_layout: {
    paper_size: "A4",
    orientation: "PORTRAIT",
    margins_mm: { top: 26, right: 14, bottom: 24, left: 14 },
    header_mode: "GLOBAL_DEFAULT",
    footer_mode: "GLOBAL_DEFAULT",
    allow_runtime_chrome_selection: false,
    global_scoped_css: "",
  },
  required_assets: [],
  i18n: { default_locale: "en", prompt_user_when_multi_locale: false, locales: { en: { "report.title": "Ledger Statement" } } },
  inputs: [],
  datasets: [],
  transforms: [],
  sections: [],
};

test.beforeEach(async ({ page }) => {
  await seedSession(page, ADMIN_KEY, session);
  await mockApi(page);
});

test("Report Studio step 1 stacks its actions and step 2 keeps its upload body", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/reports/studio");

  const stepOne = page.locator(".pg-card", { hasText: "Step 1 — AI Authoring Transcript" }).first();
  const input = stepOne.locator(".pg-control-box").first();
  const actions = stepOne.locator(".pg-btn").first().locator("xpath=..");
  await expect(input).toBeVisible();
  await expect(actions).toBeVisible();
  const inputBox = await input.boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(actionsBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height - 1);

  const stepTwo = page.locator(".pg-card", { hasText: "Step 2 — Upload Spec and Optional Asset Bundle" }).first();
  await expect(stepTwo).toBeVisible();
  await expect(stepTwo.locator(".pg-dropzone")).toHaveCount(2);
  await expect(stepTwo.locator(".pg-json-editor")).toBeVisible();
  await expect(stepTwo.getByRole("button", { name: "Verify Spec (5 Layers)" })).toBeVisible();

  const bodyChildren = await stepTwo.locator(".pg-card__body").evaluate((element) => element.children.length);
  expect(bodyChildren).toBeGreaterThan(0);
});

test("Report Headers & Footers keeps the chrome upload body", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/reports/chrome");

  const upload = page.locator(".pg-card", { hasText: "Upload Chrome Spec" }).first();
  await expect(upload).toBeVisible();
  await expect(upload.locator(".pg-dropzone")).toHaveCount(2);
  await expect(upload.locator(".pg-json-editor")).toBeVisible();
  await expect(upload.getByRole("button", { name: "Verify & Save" })).toBeVisible();
  const bodyChildren = await upload.locator(".pg-card__body").evaluate((element) => element.children.length);
  expect(bodyChildren).toBeGreaterThan(0);
});


test("the report run drawer checklist is flush with the body inset, not its own frame", async ({ page }) => {
  await mockApi(page, {
    "/report-engine/catalog": {
      reports: [{
        id: "rep-1",
        code: "ledger-statement",
        version: 1,
        category: "LEDGER",
        audienceScope: "BACKOFFICE_INTERNAL",
        supportedLocales: ["en"],
        defaultLocale: "en",
        authorityMode: "INFERRED",
        inferredRoles: [],
        inferredAuthorities: [],
        conflictStatus: "NONE",
        spec: catalogSpec,
      }],
      total: 1,
    },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/reports/catalog");
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  const checklist = page.locator(".pg-slideover .pg-checklist").first();
  await expect(checklist).toBeVisible();
  const layout = await checklist.evaluate((element) => {
    const body = element.closest(".pg-slideover__body") as HTMLElement;
    const title = element.querySelector(".pg-checklist__title") as HTMLElement;
    const hint = element.querySelector(".pg-checklist__hint") as HTMLElement;
    const row = element.querySelector(".pg-checklist__row") as HTMLElement;
    const label = row.querySelector(".pg-chk__label") as HTMLElement;
    const rect = (node: HTMLElement) => node.getBoundingClientRect();
    return {
      rootBorder: getComputedStyle(element).borderTopWidth,
      bodyLeft: rect(body).left,
      checklistLeft: rect(element).left,
      titleLeft: rect(title).left,
      hintLeft: rect(hint).left,
      rowLeft: rect(row).left,
      topGap: rect(label).top - rect(row).top,
      bottomGap: rect(row).bottom - rect(label).bottom,
    };
  });
  expect(layout.rootBorder).toBe("0px");
  for (const left of [layout.titleLeft, layout.rowLeft, layout.hintLeft]) {
    expect(Math.abs(left - layout.checklistLeft)).toBeLessThanOrEqual(1);
    expect(left - layout.bodyLeft).toBeGreaterThanOrEqual(16);
  }
  expect(Math.abs(layout.topGap - layout.bottomGap)).toBeLessThanOrEqual(2);
});
