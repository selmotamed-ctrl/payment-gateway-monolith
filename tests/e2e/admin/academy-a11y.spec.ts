import { expect, test } from "@playwright/test";
import {
  ADMIN_URL,
  EMAILS,
  READY,
  SKIP_REASON,
  activeInfo,
  apiLogin,
  content,
  injectSession,
  layoutProblems,
  normalise,
  optionName,
  tabUntil,
  stripInline,
} from "./academy-live";

test.describe("academy accessibility (live stack)", () => {
  test.skip(!READY, SKIP_REASON);
  test.use({ baseURL: ADMIN_URL });

  test("a lesson check is completed by keyboard alone, in document focus order, with a live result", async ({ page, request }) => {
    const session = await apiLogin(request, EMAILS.learner);
    await injectSession(page, session);
    // Any lesson works; use the first lesson of the first module so the expected content is known.
    const lesson = content.lessons().find((l) => l.id === "l-m0-1")!;
    const check = content.checks().find((c) => c.id === lesson.checkIds[0])!;
    const right = check.options.find((o) => o.correct)!;

    await page.goto(`/academy/lesson/${lesson.id}`);
    await expect(page.getByRole("heading", { name: lesson.title }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Practice check 1" })).toBeVisible();

    // Tab (never click) to the right option, recording every stop. Reading links must come before the checks.
    const stops = await tabUntil(page, (s) => s.tag === "button" && optionName(right.text).test(s.name));
    const indexes = stops.map((s) => s.index);
    const optionStop = stops.length - 1;
    if (lesson.reading.length > 0) {
      const linkStop = stops.findIndex((s) => s.tag === "a" && s.index > 0);
      expect(linkStop, "a reading link is focusable before the practice check").toBeGreaterThanOrEqual(0);
      expect(linkStop).toBeLessThan(optionStop);
    }
    // Focus order follows the DOM order (no positive tabindex / focus jumps) in the content area.
    const tail = indexes.slice(Math.max(0, indexes.length - 6));
    expect([...tail].sort((x, y) => x - y)).toEqual(tail);

    await page.keyboard.press("Space");
    const live = page.getByRole("region", { name: "Practice check 1" }).locator('[aria-live="polite"]');
    await expect(live).toContainText("Correct.");
    // The next check is revealed and reachable by keyboard.
    await expect(page.getByRole("region", { name: "Practice check 2" })).toBeVisible();
    const second = content.checks().find((c) => c.id === lesson.checkIds[1])!;
    const secondRight = second.options.find((o) => o.correct)!;
    await tabUntil(page, (s) => s.tag === "button" && optionName(secondRight.text).test(s.name));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Practice check 2" }).locator('[aria-live="polite"]')).toContainText("Correct.");
  });

  test("a lab task is completed by keyboard alone; focus moves to the task heading; results are announced", async ({ page, request }) => {
    const session = await apiLogin(request, EMAILS.learner);
    await injectSession(page, session);
    const lab = content.labs().find((l) => l.id === "lab-approval-desk")!;
    const task = lab.tasks[0]!;
    expect(task.kind).toBe("choice");
    const correct = task.options!.find((o) => o.correct)!;

    await page.goto(`/academy/lab/${lab.id}`);
    await expect(page.getByRole("button", { name: /^(Start lab|Start again)$/ })).toBeVisible();
    await tabUntil(page, (s) => s.tag === "button" && /^(Start lab|Start again)$/.test(s.name));
    await page.keyboard.press("Enter");

    // Focus is moved to the task heading (programmatic focus, tabindex -1).
    await expect.poll(async () => (await activeInfo(page)).inHeading, { timeout: 5_000 }).toBe(true);
    expect(normalise((await activeInfo(page)).name)).toContain(stripInline(task.title));

    // Tab into the radio group and pick the right option with arrow keys + Space.
    await tabUntil(page, (s) => s.tag === "input" && s.type === "radio");
    for (let guard = 0; guard < (task.options?.length ?? 1) + 1 && (await activeInfo(page)).value !== correct.id; guard += 1) {
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Space");
    await expect(page.locator(`input[type="radio"][value="${correct.id}"]`)).toBeChecked();

    await tabUntil(page, (s) => s.tag === "button" && s.name === "Check");
    await page.keyboard.press("Enter");
    // The outcome is inside an aria-live region.
    const announced = page.locator('[aria-live="polite"][role="status"]').filter({ hasText: /points/ }).first();
    await expect(announced).toContainText("Correct");
    await tabUntil(page, (s) => s.tag === "button" && s.name === "Next");
  });

  for (const width of [360, 1280]) {
    test(`Arabic RTL layout has no overflow or overlap at ${width}px`, async ({ page, request }) => {
      const session = await apiLogin(request, EMAILS.learner);
      await injectSession(page, session, "ar");
      await page.setViewportSize({ width, height: 900 });
      const lesson = content.lessons()[0]!;
      const pages: [string, string][] = [
        ["home", "/academy"],
        ["tracks", "/academy/tracks"],
        ["lesson", `/academy/lesson/${lesson.id}`],
        ["lab", "/academy/lab/lab-approval-desk"],
        ["exam", "/academy/exam/exam-foundation"],
      ];
      for (const [name, path] of pages) {
        await page.goto(path);
        await expect(page.locator(".ac-wrap").first()).toBeVisible();
        // Wait out skeletons: cards are present once content has loaded.
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
        expect(await page.evaluate(() => document.documentElement.dir), `${name} direction`).toBe("rtl");
        expect(await layoutProblems(page), `${name} at ${width}px`).toEqual([]);
        // Screenshots are evidence only (no pixel comparison).
        await page.screenshot({ path: `test-results/academy-rtl-${name}-${width}.png`, fullPage: true });
      }
    });
  }
});
