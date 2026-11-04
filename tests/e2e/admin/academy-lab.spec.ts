import { expect, test, type Page } from "@playwright/test";
import {
  ADMIN_URL,
  EMAILS,
  READY,
  SKIP_REASON,
  apiLogin,
  content,
  getProgress,
  injectSession,
  stripInline,
  type LabJson,
  type LabTaskJson,
} from "./academy-live";

const LAB_ID = "lab-approval-desk";

/** Answers one lab task from the generated key. `pickCritical` chooses a CRITICAL-error option when the task has one. */
const answerTask = async (page: Page, task: LabTaskJson, pickCritical: boolean): Promise<boolean> => {
  let critical = false;
  if (task.kind === "choice") {
    const options = task.options ?? [];
    const target = pickCritical ? (options.find((o) => o.critical) ?? options.find((o) => o.correct)) : options.find((o) => o.correct);
    critical = Boolean(pickCritical && target?.critical);
    await page.locator(`input[type="radio"][name="choice-${task.id}"][value="${target!.id}"]`).check();
  } else if (task.kind === "checklist") {
    for (const item of task.items ?? []) {
      const box = page.locator(`input[type="checkbox"][value="${item.id}"]`);
      if (item.shouldTick) await box.check();
      else await box.uncheck();
    }
  } else if (task.kind === "multi") {
    for (const option of task.options ?? []) {
      const box = page.locator(`input[type="checkbox"][value="${option.id}"]`);
      if (option.correct) await box.check();
    }
  } else {
    throw new Error(`lab task kind "${task.kind}" is not driven by this spec (${LAB_ID} only uses choice/checklist)`);
  }
  return critical;
};

const runLab = async (page: Page, lab: LabJson, pickCritical: boolean): Promise<{ sawCritical: boolean }> => {
  await page.goto(`/academy/lab/${LAB_ID}`);
  const start = page.getByRole("button", { name: /^(Start lab|Start again)$/ });
  await expect(start).toBeVisible();
  await start.click();
  let sawCritical = false;
  let criticalDone = false;
  for (const [index, task] of lab.tasks.entries()) {
    await expect(page.getByRole("heading", { name: stripInline(task.title) }).first()).toBeVisible();
    const critical = await answerTask(page, task, pickCritical && !criticalDone);
    if (critical) criticalDone = true;
    await page.getByRole("button", { name: "Check", exact: true }).click();
    const status = page.getByRole("status").filter({ hasText: /points/ }).first();
    await expect(status).toBeVisible();
    if (critical) {
      await expect(page.getByRole("alert").filter({ hasText: "Critical error" }).first()).toBeVisible();
      sawCritical = true;
    }
    const last = index === lab.tasks.length - 1;
    await page.getByRole("button", { name: last ? "See results" : "Next", exact: true }).click();
  }
  return { sawCritical };
};

test.describe("academy lab approval desk (live stack)", () => {
  test.skip(!READY, SKIP_REASON);
  test.use({ baseURL: ADMIN_URL });

  test("passes with the right answers, fails on a critical error, keeps the best score", async ({ page, request }) => {
    test.setTimeout(180_000);
    const lab = content.labs().find((l) => l.id === LAB_ID)!;
    expect(lab, "lab exists in generated/labs.en.json").toBeTruthy();
    expect(lab.tasks.some((t) => (t.options ?? []).some((o) => o.critical)), "lab has a critical option to pick").toBe(true);

    const session = await apiLogin(request, EMAILS.learner);
    await injectSession(page, session);
    const before = (await getProgress(request, session)).labs[LAB_ID];

    // Run 1: every right answer -> pass.
    await runLab(page, lab, false);
    await expect(page.getByRole("heading", { name: "Lab passed" })).toBeVisible();
    await expect(page.getByText(/Score: 100%/)).toBeVisible();
    await expect(page.getByText("Failed because of a critical error")).toHaveCount(0);
    await expect
      .poll(async () => (await getProgress(request, session)).labs[LAB_ID]?.bestScore, { timeout: 15_000 })
      .toBe(100);
    const passed = (await getProgress(request, session)).labs[LAB_ID]!;
    expect(passed.passedAt).toBeTruthy();
    expect(passed.criticalErrors).toBe(0);

    // Run 2: choose a CRITICAL-error option on one task -> fail with the critical-error message.
    const second = await runLab(page, lab, true);
    expect(second.sawCritical).toBe(true);
    await expect(page.getByRole("heading", { name: "Lab not passed yet" })).toBeVisible();
    const alert = page.getByRole("alert").filter({ hasText: "Failed because of a critical error" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("You cannot pass a lab with a critical error");

    // Best score is preserved (server merge keeps the max and the earliest pass).
    await expect
      .poll(async () => (await getProgress(request, session)).labs[LAB_ID]?.attempts, { timeout: 15_000 })
      .toBeGreaterThanOrEqual((before?.attempts ?? 0) + 2);
    const after = (await getProgress(request, session)).labs[LAB_ID]!;
    expect(after.bestScore).toBe(100);
    expect(after.passedAt).toBeTruthy();
    expect(after.criticalErrors).toBe(0);

    await page.goto(`/academy/lab/${LAB_ID}`);
    await expect(page.getByText(/Your best score: 100%/)).toBeVisible();
    await expect(page.getByText(/Passed/).first()).toBeVisible();
  });
});
