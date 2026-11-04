import { expect, test, type Page } from "@playwright/test";
import {
  ADMIN_URL,
  EMAILS,
  READY,
  SKIP_REASON,
  apiLogin,
  authHeaders,
  content,
  escapeRegExp,
  getProgress,
  injectSession,
  normalise,
  putProgress,
  unwrap,
  type BankQuestion,
} from "./academy-live";

const EXAM_ID = "exam-foundation";
const FORBIDDEN_KEYS = ["correct", "critical", "why", "answer", "explanation", "note"];

/** Every key (at any depth) that must never be in the start payload. */
const forbiddenKeysIn = (value: unknown, path = "$"): string[] => {
  if (Array.isArray(value)) return value.flatMap((item, i) => forbiddenKeysIn(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      ...(FORBIDDEN_KEYS.includes(key) ? [`${path}.${key}`] : []),
      ...forbiddenKeysIn(child, `${path}.${key}`),
    ]);
  }
  return [];
};

const questionHeading = (page: Page) => page.locator('h2[id^="stem-"]');

/** Answers the question on screen from the server-side key (read in the test process, matched by stem text). */
const answerCurrent = async (page: Page, bank: Map<string, BankQuestion>): Promise<string> => {
  const stem = normalise(await questionHeading(page).innerText());
  const q = bank.get(stem);
  if (!q) throw new Error(`question not found in exam-bank.json by stem: "${stem.slice(0, 60)}"`);
  if (q.type === "single" || q.type === "truefalse") {
    const right = q.options.find((o) => o.correct)!;
    await page.getByRole("radio", { name: right.text, exact: true }).check();
  } else if (q.type === "number") {
    await page.getByLabel("Your answer (a number; use a dot for decimals)").fill(q.answer!);
  } else if (q.type === "order") {
    // The bank lists the options in the correct order.
    const wanted = q.options.map((o) => o.text);
    const labels = async (): Promise<string[]> =>
      page.locator('button[aria-label^="Move up: "]').evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? "").replace(/^Move up: /, "")));
    for (let target = 0; target < wanted.length; target += 1) {
      let current = await labels();
      let at = current.indexOf(wanted[target]!);
      while (at > target) {
        await page.getByRole("button", { name: `Move up: ${wanted[target]}`, exact: true }).click();
        current = await labels();
        at = current.indexOf(wanted[target]!);
      }
    }
    expect(await labels()).toEqual(wanted);
    const keep = page.getByRole("button", { name: "Keep this order as my answer" });
    if (await keep.isVisible()) await keep.click();
  } else {
    throw new Error(`exam question type ${q.type} is not driven by this spec`);
  }
  return stem;
};

test.describe("academy foundation exam (live stack)", () => {
  test.skip(!READY, SKIP_REASON);
  test.use({ baseURL: ADMIN_URL });

  test("start hides the key, reload resumes, submit grades, badge and certificate appear", async ({ page, request }) => {
    test.setTimeout(300_000);
    const session = await apiLogin(request, EMAILS.exam);
    await injectSession(page, session);

    // --- seed every prerequisite for exam-foundation through the progress API (what a learner would have done)
    const foundation = content.tracks().find((t) => t.id === "FOUNDATION")!;
    const version = content.meta().contentVersion;
    const at = new Date().toISOString();
    await putProgress(request, session, {
      lessons: Object.fromEntries(foundation.lessonIds.map((id) => [id, { at, v: version, checkScore: 2 }])),
      labs: Object.fromEntries(foundation.labIds.map((id) => [id, { bestScore: 100, attempts: 1, passedAt: at, criticalErrors: 0, v: version }])),
    });
    const eligibility = unwrap<{ eligible: boolean; missing: { kind: string; text: string }[]; cooldownUntil?: string }>(
      await (await request.get(`${ADMIN_URL}/api/v1/admin/academy/exams/${EXAM_ID}/eligibility`, { headers: authHeaders(session) })).json(),
    );
    test.skip(eligibility.missing.some((m) => m.kind === "cooldown"), `exam cooldown active until ${eligibility.cooldownUntil}: re-run later or use another PG_ACADEMY_EXAM_EMAIL`);
    expect(eligibility.missing.filter((m) => m.kind !== "open_session").map((m) => m.text), "prerequisites are seeded").toEqual([]);

    const bank = new Map(content.bank().map((q) => [normalise(q.stem), q]));

    // --- briefing: integrity statement must be accepted
    await page.goto(`/academy/exam/${EXAM_ID}`);
    await expect(page.getByRole("heading", { name: "Integrity statement" })).toBeVisible();
    const startButton = page.getByRole("button", { name: /^(Start exam|Resume exam)$/ });
    await expect(startButton).toBeDisabled();
    await page.getByRole("checkbox", { name: /I have read and I agree to this integrity statement/ }).check();
    await expect(startButton).toBeEnabled();

    const startResponse = page.waitForResponse((r) => r.url().includes(`/academy/exams/${EXAM_ID}/start`) && r.request().method() === "POST");
    await startButton.click();
    const started = await startResponse;
    expect(started.status()).toBe(200);
    const startBody = await started.json();
    const first = unwrap<{ sessionId: string; questionCount: number; questions: { qid: string; stem: string; options: unknown[] }[] }>(startBody);

    // --- the browser must never receive the key: deep scan of the whole start response
    expect(forbiddenKeysIn(startBody), "start response must not contain correct/critical/why (or other key material)").toEqual([]);
    expect(first.questions.length).toBe(first.questionCount);
    expect(first.questionCount).toBeGreaterThan(0);
    const firstStem = normalise(first.questions[0]!.stem);
    await expect(questionHeading(page)).toBeVisible();
    expect(normalise(await questionHeading(page).innerText())).toBe(firstStem);

    // --- reloading mid-exam resumes the SAME session (same first question)
    await answerCurrent(page, bank);
    const resumeResponse = page.waitForResponse((r) => r.url().includes(`/academy/exams/${EXAM_ID}/start`) && r.request().method() === "POST");
    await page.reload();
    const resumed = unwrap<{ sessionId: string; resumed: boolean; questions: { qid: string; stem: string }[] }>(await (await resumeResponse).json());
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.resumed).toBe(true);
    expect(resumed.questions[0]!.qid).toBe(first.questions[0]!.qid);
    await expect(questionHeading(page)).toBeVisible();
    expect(normalise(await questionHeading(page).innerText())).toBe(normalise(resumed.questions[0]!.stem));
    expect(normalise(resumed.questions[0]!.stem)).toBe(firstStem);

    // --- answer every question (the first one again is harmless), then submit
    for (let i = 0; i < first.questionCount; i += 1) {
      await expect(page.getByText(new RegExp(`Question ${i + 1} / ${first.questionCount}`)).first()).toBeVisible();
      await answerCurrent(page, bank);
      if (i < first.questionCount - 1) await page.getByRole("button", { name: "Next", exact: true }).click();
    }
    await page.getByRole("button", { name: "Submit exam" }).click();
    await expect(page.getByRole("heading", { name: "Submit your exam?" })).toBeVisible();
    await expect(page.getByText(/0 unanswered/)).toBeVisible();
    const submitResponse = page.waitForResponse((r) => r.url().includes(`/academy/exams/${EXAM_ID}/submit`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Submit answers" }).click();
    const result = unwrap<{ passed: boolean; scorePercent: number; badge?: { id: string }; items: { why: string }[] }>(await (await submitResponse).json());
    expect(result.passed, `scored ${result.scorePercent}%`).toBe(true);
    expect(result.badge?.id).toBeTruthy();
    expect(result.items.length).toBe(first.questionCount);

    // --- result page: pass banner, explanations, certificate link
    await expect(page.getByText(/You passed/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your answers, question by question" })).toBeVisible();
    await expect(page.getByText("Why: ", { exact: false }).first()).toBeVisible();
    expect(result.items.some((item) => item.why.length > 0)).toBe(true);
    await expect(page.getByRole("link", { name: "View certificate" })).toBeVisible();

    // --- server recorded it
    await expect.poll(async () => (await getProgress(request, session)).badges.some((b) => b.id === result.badge!.id), { timeout: 15_000 }).toBe(true);

    // --- badge on /academy (the Foundation row shows "Certified")
    await page.goto("/academy");
    await expect(page.locator('.ac-chip[data-track="FOUNDATION"]').filter({ hasText: /Certified/ }).first()).toBeVisible();

    // --- certificate page renders and offers printing (the dialog itself is blocked in headless)
    await page.goto(`/academy/certificate/${result.badge!.id}`);
    await expect(page.getByRole("heading", { name: "Certificate of completion" })).toBeVisible();
    await expect(page.getByText(new RegExp(`ID: ${escapeRegExp(result.badge!.id)}`))).toBeVisible();
    await expect(page.getByRole("button", { name: "Print certificate" })).toBeEnabled();
  });
});
