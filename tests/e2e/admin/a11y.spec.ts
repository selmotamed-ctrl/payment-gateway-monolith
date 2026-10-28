import { expect, test, type Page } from "@playwright/test";
import { ADMIN_KEY, MERCHANT_KEY, adminSession, merchantSession, mockApi, seedSession } from "../fixtures";

const unnamedButtons = async (page: Page) =>
  page.locator("button").evaluateAll((elements) =>
    elements
      .filter((element) => {
        const text = (element.textContent ?? "").trim();
        const label = element.getAttribute("aria-label");
        const title = element.getAttribute("title");
        return !text && !label && !title;
      })
      .map((element) => element.outerHTML.slice(0, 120)),
  );

const imagesWithoutAlt = async (page: Page) =>
  page.locator("img:not([alt])").evaluateAll((elements) => elements.length);

test("admin shell: every app-bar button has an accessible name and images have alt", async ({ page }) => {
  await seedSession(page, ADMIN_KEY, adminSession);
  await mockApi(page);
  await page.goto("/dashboard");
  await expect(page.locator(".pg-app-bar")).toBeVisible();
  expect(await unnamedButtons(page)).toEqual([]);
  expect(await imagesWithoutAlt(page)).toBe(0);
  // Exactly one main landmark.
  expect(await page.locator("main").count()).toBe(1);
});

test("admin login: form controls are labelled", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto("/login");
  await expect(page.getByLabel("Email or phone")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  expect(await imagesWithoutAlt(page)).toBe(0);
});
