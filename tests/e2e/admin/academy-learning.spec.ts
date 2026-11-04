import { expect, test } from "@playwright/test";
import {
  ADMIN_URL,
  EMAILS,
  READY,
  SKIP_REASON,
  apiLogin,
  content,
  getProgress,
  optionName,
  uiLogin,
} from "./academy-live";

test.describe("academy learning journey (live stack)", () => {
  test.skip(!READY, SKIP_REASON);
  test.use({ baseURL: ADMIN_URL });

  test("Continue opens the next lesson, checks and reading gate completion, progress persists", async ({ page, request, context }) => {
    test.setTimeout(120_000);
    const session = await apiLogin(request, EMAILS.learner);
    const before = await getProgress(request, session);

    await uiLogin(page, EMAILS.learner);
    await page.goto("/academy");
    await expect(page.getByRole("heading", { name: "My learning" }).first()).toBeVisible();

    // Continue -> the first lesson that is not complete yet.
    const cont = page.getByRole("link", { name: /^Continue: / }).first();
    await expect(cont).toBeVisible();
    const label = (await cont.innerText()).trim();
    test.skip(!/^Continue: lesson /.test(label), `next step is not a lesson ("${label}"): this learner already finished every lesson`);
    await cont.click();
    await expect(page).toHaveURL(/\/academy\/lesson\/[^/]+$/);
    const lessonId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
    expect(before.lessons[lessonId], "Continue must open a lesson that is not complete yet").toBeUndefined();
    if (Object.keys(before.lessons).length === 0) {
      expect(lessonId, "a learner with no progress starts at the first lesson").toBe("l-m0-1");
    }

    const lesson = content.lessons().find((l) => l.id === lessonId);
    expect(lesson, `lesson ${lessonId} exists in the generated content`).toBeTruthy();
    const checks = lesson!.checkIds.map((id) => content.checks().find((c) => c.id === id)!);
    expect(checks).toHaveLength(2);
    await expect(page.getByRole("heading", { name: lesson!.title }).first()).toBeVisible();

    const complete = page.getByRole("button", { name: "Mark lesson complete" });
    await expect(complete).toBeDisabled();

    // Answer both checks: a wrong option first (retry is allowed), then the right one.
    for (const [index, check] of checks.entries()) {
      const section = page.getByRole("region", { name: `Practice check ${index + 1}` });
      await expect(section).toBeVisible();
      await expect(section.getByText(check.stem, { exact: true })).toBeVisible();
      const right = check.options.find((o) => o.correct)!;
      await section.getByRole("button", { name: optionName(right.text) }).click();
      await expect(section.getByText("✓ Correct.").first()).toBeVisible();
    }
    // Reading not opened yet (lessons that list reading) -> still disabled.
    if (lesson!.reading.length > 0) {
      await expect(complete).toBeDisabled();
      await expect(page.getByText("Open every article in the Read now list.")).toBeVisible();
      const links = page.getByRole("region", { name: "Read now" }).getByRole("link");
      expect(await links.count()).toBe(lesson!.reading.length);
      for (let i = 0; i < lesson!.reading.length; i += 1) {
        const popup = context.waitForEvent("page");
        await links.nth(i).click();
        const opened = await popup;
        await opened.close();
      }
    }
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(page.getByText("Lesson complete.").first()).toBeVisible();

    // Persisted on the server...
    await expect
      .poll(async () => (await getProgress(request, session)).lessons[lessonId]?.checkScore, { timeout: 15_000 })
      .toBe(2);
    const after = await getProgress(request, session);
    expect(after.lessons[lessonId]).toBeTruthy();

    // ...and after a reload the lesson is still complete.
    await page.reload();
    await expect(page.getByText("Lesson complete.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark lesson complete" })).toHaveCount(0);
  });
});
