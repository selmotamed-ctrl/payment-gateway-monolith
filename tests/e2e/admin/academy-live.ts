import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_KEY } from "../fixtures";

/**
 * Shared helpers for the Employee Academy LIVE specs (`academy-*.spec.ts`).
 *
 * These specs need the deployed stack (admin-front + admin-back + core-back + seeded users), so they are
 * skipped unless `E2E_LIVE=1` and `PG_PASSWORD` are set. No credential is hard-coded: emails default to the
 * seeded back-office accounts (not secrets), the password comes only from the environment.
 *
 *   E2E_LIVE=1 PG_PASSWORD=... [E2E_ADMIN_URL=https://host:8443] bunx playwright test --project=admin e2e/admin/academy-*.spec.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const generated = resolve(here, "../../../admin-front/src/content/academy/generated");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export const ADMIN_URL = (process.env.E2E_ADMIN_URL ?? process.env.PG_ADMIN_URL ?? "http://127.0.0.1:5101").replace(/\/+$/, "");
export const LIVE = process.env.E2E_LIVE === "1";
export const PASSWORD = process.env.PG_PASSWORD ?? "";
export const READY = LIVE && PASSWORD.length > 0;
export const SKIP_REASON = "set E2E_LIVE=1 and PG_PASSWORD (deployed stack with the Academy rebuild) to run the Academy live specs";

export const EMAILS = {
  learner: process.env.PG_ACADEMY_LEARNER_EMAIL ?? "operator@payment-gateway.internal",
  exam: process.env.PG_ACADEMY_EXAM_EMAIL ?? "support@payment-gateway.internal",
  securityAdmin: process.env.PG_ACADEMY_SECURITY_EMAIL ?? "security-admin@payment-gateway.internal",
  nonAdmin: process.env.PG_ACADEMY_NONADMIN_EMAIL ?? "finance@payment-gateway.internal",
};

// ---------------------------------------------------------------------------------------------------------
// Content (read from the generated files at test time; answers are never hard-coded)
// ---------------------------------------------------------------------------------------------------------

export interface TrackJson { id: string; examId: string; moduleIds: string[]; lessonIds: string[]; labIds: string[] }
export interface ModuleJson { id: string; lessonIds: string[]; labIds: string[] }
export interface LessonJson { id: string; title: string; reading: string[]; checkIds: string[] }
export interface CheckJson { id: string; stem: string; options: { id: string; text: string; correct: boolean }[] }
export interface LabOption { id: string; label: string; correct?: boolean; critical?: boolean }
export interface LabItem { id: string; label: string; shouldTick: boolean }
export interface LabTaskJson { id: string; kind: string; title: string; options?: LabOption[]; items?: LabItem[] }
export interface LabJson { id: string; title: string; passPercent: number; tasks: LabTaskJson[] }
export interface BankQuestion {
  id: string;
  type: "single" | "multi" | "truefalse" | "order" | "number";
  stem: string;
  options: { id: string; text: string; correct?: boolean }[];
  answer?: string;
}

export const content = {
  tracks: () => readJson<TrackJson[]>(`${generated}/tracks.json`),
  modules: () => readJson<ModuleJson[]>(`${generated}/modules.json`),
  lessons: () => readJson<LessonJson[]>(`${generated}/lessons.en.json`),
  checks: () => readJson<CheckJson[]>(`${generated}/checks.en.json`),
  labs: () => readJson<LabJson[]>(`${generated}/labs.en.json`),
  meta: () => readJson<{ contentVersion: string }>(`${generated}/meta.json`),
  /** The server-side answer key. A test process may read it; the browser never can. */
  bank: () => readJson<{ questions: BankQuestion[] }>(resolve(here, "../../../core-back/content/academy/exam-bank.json")).questions,
};

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const normalise = (value: string): string => value.replace(/\s+/g, " ").trim();
/** Lab labels are authored with inline markdown (`**bold**`); the UI renders them without the markers. */
export const stripInline = (value: string): string => value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");

// ---------------------------------------------------------------------------------------------------------
// Sessions and API
// ---------------------------------------------------------------------------------------------------------

export interface Session {
  token: string;
  refreshToken: string | null;
  userInfo: Record<string, unknown> & { role: string; id: string };
}

export const unwrap = <T>(body: unknown): T => {
  const record = body as { data?: unknown } | null;
  return (record && typeof record === "object" && "data" in record && record.data && typeof record.data === "object" ? record.data : body) as T;
};

const sessions = new Map<string, Session>();

/** Signs in through the public API (cached per email so the login rate limiter is not hit repeatedly). */
export const apiLogin = async (request: APIRequestContext, email: string): Promise<Session> => {
  const cached = sessions.get(email);
  if (cached) return cached;
  const response = await request.post(`${ADMIN_URL}/api/v1/admin/auth/login`, {
    data: { identifier: email, password: PASSWORD },
    headers: { "X-Client-Channel": "admin" },
  });
  expect(response.status(), `login ${email}`).toBe(200);
  const payload = unwrap<{ token?: string; refreshToken?: string | null; userInfo?: Record<string, unknown>; mfaRequired?: boolean }>(await response.json());
  if (payload.mfaRequired) throw new Error(`${email} requires MFA; use an account without MFA for the Academy live specs`);
  expect(payload.token, "login token").toBeTruthy();
  const info = payload.userInfo ?? {};
  const session: Session = {
    token: String(payload.token),
    refreshToken: payload.refreshToken ?? null,
    userInfo: {
      id: String(info.id ?? ""),
      name: (info.name as string) ?? "",
      username: (info.username as string) ?? "",
      role: String(info.role ?? ""),
      email: (info.email as string) ?? null,
      phone: (info.phone as string) ?? null,
      authoritiesMap: (info.authoritiesMap as Record<string, boolean>) ?? {},
      isMaker: Boolean(info.isMaker),
      isChecker: Boolean(info.isChecker),
    },
  };
  sessions.set(email, session);
  return session;
};

/** Puts the session in localStorage before any page script runs (no secrets are logged). */
export const injectSession = async (page: Page, session: Session, locale: "en" | "ar" = "en"): Promise<void> => {
  await page.addInitScript(
    ([key, value, lang]) => {
      window.localStorage.setItem("locale-name", lang as string);
      window.localStorage.setItem(key as string, JSON.stringify(value));
    },
    [ADMIN_KEY, session, locale] as const,
  );
};

export const authHeaders = (session: Session): Record<string, string> => ({
  Authorization: `Bearer ${session.token}`,
  "X-Client-Channel": "admin",
});

export interface ProgressJson {
  rev: number;
  lessons: Record<string, { at: string; v: string; checkScore: number }>;
  labs: Record<string, { bestScore: number; attempts: number; passedAt?: string; criticalErrors: number; v: string }>;
  exams: Record<string, { attempts: unknown[]; open?: { sessionId: string; expiresAt: string }; passedAt?: string }>;
  badges: { id: string; track: string; expiresAt: string }[];
  [key: string]: unknown;
}

export const getProgress = async (request: APIRequestContext, session: Session): Promise<ProgressJson> => {
  const response = await request.get(`${ADMIN_URL}/api/v1/admin/academy/progress`, { headers: authHeaders(session) });
  expect(response.status(), "GET academy progress").toBe(200);
  const body = unwrap<{ progress?: ProgressJson } & ProgressJson>(await response.json());
  return (body.progress ?? body) as ProgressJson;
};

/** Merge-writes the allowed progress keys, retrying once on a revision conflict. */
export const putProgress = async (request: APIRequestContext, session: Session, patch: Record<string, unknown>): Promise<ProgressJson> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getProgress(request, session);
    const response = await request.put(`${ADMIN_URL}/api/v1/admin/academy/progress`, {
      headers: authHeaders(session),
      data: { baseRev: current.rev, patch },
    });
    if (response.status() === 409) continue;
    expect(response.status(), "PUT academy progress").toBe(200);
    const body = unwrap<{ progress?: ProgressJson } & ProgressJson>(await response.json());
    return (body.progress ?? body) as ProgressJson;
  }
  throw new Error("progress PUT kept conflicting");
};

// ---------------------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------------------

/** Real sign-in through the login form (same selectors as `e2e-live/live.spec.ts`). */
export const uiLogin = async (page: Page, email: string): Promise<void> => {
  await page.addInitScript(() => window.localStorage.setItem("locale-name", "en"));
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByLabel("Email or phone").fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
};

/** Accessible name of a single-choice lesson check option: text, plus the tag appended once picked. */
export const optionName = (text: string): RegExp => new RegExp(`^${escapeRegExp(text)}(\\s+(Correct|Not correct))?$`);

export interface ActiveInfo { tag: string; type: string; value: string; name: string; role: string; index: number; inHeading: boolean }

export const activeInfo = (page: Page): Promise<ActiveInfo> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: "", type: "", value: "", name: "", role: "", index: -1, inHeading: false };
    const all = Array.from(document.querySelectorAll("*"));
    return {
      tag: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type ?? "",
      value: (el as HTMLInputElement).value ?? "",
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim(),
      role: el.getAttribute("role") ?? "",
      index: all.indexOf(el),
      inHeading: /^h[1-6]$/.test(el.tagName.toLowerCase()),
    };
  });

/** Presses Tab until the predicate matches the focused element; returns every stop visited (keyboard only). */
export const tabUntil = async (page: Page, matches: (info: ActiveInfo) => boolean, max = 120): Promise<ActiveInfo[]> => {
  const stops: ActiveInfo[] = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Tab");
    const info = await activeInfo(page);
    stops.push(info);
    if (matches(info)) return stops;
  }
  throw new Error(`keyboard focus never reached the target within ${max} Tab presses`);
};

/** Collects horizontal layout problems among the Academy building blocks. */
export const layoutProblems = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const problems: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) problems.push(`page scrolls horizontally (${doc.scrollWidth} > ${doc.clientWidth})`);
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".ac-card, .ac-nav, .ac-btn"));
    for (const el of blocks) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.left < -1 || r.right > window.innerWidth + 1) problems.push(`${el.className} outside viewport (${Math.round(r.left)}..${Math.round(r.right)})`);
    }
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".ac-card")).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 2 && r.height > 2);
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = cards[i]!;
        const b = cards[j]!;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) problems.push(`cards ${i} and ${j} overlap (${Math.round(w)}x${Math.round(h)})`);
      }
    }
    return problems;
  });
