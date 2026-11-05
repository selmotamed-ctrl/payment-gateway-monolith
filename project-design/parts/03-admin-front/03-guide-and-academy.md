---
id: admin-ui.guide
title: Admin Guide and Academy
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: working-tree
code:
  - admin-front/scripts/extract-guide-content.ts
  - admin-front/scripts/extract-academy-content.ts
  - admin-front/src/content/guide/**
  - admin-front/src/components/guide/**
  - admin-front/src/pages/guide/**
  - admin-front/src/content/academy/**
  - admin-front/src/components/academy/**
  - admin-front/src/pages/academy/**
  - admin-front/src/constants/i18nAcademy/**
  - admin-front/src/styles/academy/**
  - admin-front/src/components/academy/ui/**
  - admin-back/api/protected/academy.ts
  - core-back/api/internal/academy.ts
  - core-back/engine/academy/**
  - core-back/content/academy/**
design_sources:
  - design/07-guides-and-academy/guide_system_design_and_content.md
  - design/07-guides-and-academy/academy_system_design_and_content.md
  - design/07-guides-and-academy/academy_content_fixes.md
  - design/07-guides-and-academy/academy_content_questions.md
  - design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md
tests:
  - tests/unit/guide-content.test.ts
  - tests/unit/guide-search.test.ts
  - tests/unit/guide-widgets.test.ts
  - tests/unit/academy-content.test.ts
  - tests/unit/academy-lab-scoring.test.ts
  - tests/unit/academy-progress-merge.test.ts
  - tests/unit/academy-next-step.test.ts
  - tests/unit/academy-lesson-body.test.ts
  - tests/e2e/admin/guide-reader.spec.ts
  - tests/e2e/admin/guide-palette.spec.ts
  - tests/e2e/admin/guide-context.spec.ts
  - tests/e2e/admin/guide-safeguard.spec.ts
  - tests/e2e/admin/academy-learning.spec.ts
  - tests/e2e/admin/academy-lab.spec.ts
  - tests/e2e/admin/academy-exam.spec.ts
  - tests/e2e/admin/academy-team.spec.ts
  - tests/e2e/admin/academy-a11y.spec.ts
  - admin-front/src/content/__tests__/content-completeness.test.ts
  - core-back/test/academy-exam-engine.test.ts
  - core-back/test/academy-progress.test.ts
  - core-back/test/academy-team.test.ts
  - admin-back/test/academy-progress.test.ts
gaps:
  - The five Academy Playwright specs (`tests/e2e/admin/academy-*.spec.ts`) have been written and listed but not yet run against a live stack (their assertions were replayed against a mocked API after the 2026-11-05 visual redesign, see 7.6): they need a back-office account with a known password and MFA off (seeded accounts are `INVITED`, MFA required). The Prisma-backed academy store (compare-and-swap on `users.updated_at`) is exercised only through fake-store tests.
  - The Arabic article set (`articles.ar.json`) is not supplied; the loader falls back to English and the reader shows an "Arabic version pending" chip. Academy lesson/lab/exam CONTENT is English only (spec I-2); the Academy UI chrome is bilingual.
  - Labs are practice and are graded in the browser by design; their results are recorded but are not independently verified by the server. Only exams are server-graded.
  - Academy content labels that do not match the built UI and behaviour doubts are recorded in `design/07-guides-and-academy/academy_content_fixes.md` and `academy_content_questions.md` (for example the unbuilt **Reverse** adjustment action and the Fake Rails drill labels, which follow the older Fake Rails design).
  - Guide content label mismatches and two safeguard cards with no matching UI action are recorded in `guide_content_fixes.md` and `guide_content_questions.md`.
---

# Admin Guide and Academy

## 1. Purpose and scope

This part owns two employee learning products in `admin-front`:

- The Admin Interactive Guide at `/guide/**`: 14 books, 125 articles, glossary, safeguard cards, situation playbook, 140-case catalog, five simulators, reading paths, search palette, contextual help and read tracking.
- The Employee Academy under `/academy/**`: eight tracks, lessons with practice checks, simulated labs, server-graded certification exams, 12-month badges, certificates and a `SECURITY_ADMIN` team view.

It does not own the merchant guide or the checkout help center. The future-guide design is now implemented; its detailed implementation notes live in `06-guide-v2.md`.

## 2. Guide content pipeline

The canonical content is `design/07-guides-and-academy/guide_system_design_and_content.md` (a root duplicate with CRLF line endings is also accepted as a fallback).

`admin-front/scripts/extract-guide-content.ts` (`bun run content:guide`) parses only the `<!-- CONTENT:BEGIN -->` … `<!-- CONTENT:END -->` region, validates every cross-reference, enforces the design counts, and emits committed JSON into `admin-front/src/content/guide/generated/`:

| Artifact | Count / notes |
| :--- | :--- |
| `books.json` | 14 books |
| `articles.en.json` | 125 articles with headings, plain text, roles, UI status and related ids |
| `glossary.en.json` | 151 terms with aliases, Arabic term and related slugs |
| `cards.en.json` | 22 cards and 99 required checklist items |
| `playbook.en.json` | 29 situations with screens, cases and articles |
| `paths.json` | 8 reading paths (`ALL` plus seven staff roles) |
| `faq.en.json` | 58 quick answers |
| `data.json` | `ledger-events`, `visible-rails`, `attempt-transitions` |
| `context-map.json` | 23 screens plus the `General` fallback |
| `error-codes.en.json` | 19 codes parsed from `b13-01` |
| `edge-cases.en.json` | 140 rows parsed from the v4.1 design |
| `meta.json` | `contentVersion`, deterministic `generatedAt`, counts and source SHA-256 |

The extractor output is deterministic and byte-stable. The content test re-runs it into a temporary directory and fails on drift, count changes, unresolved links, empty bodies, external URLs, missing context-map routes, missing widgets or a gzip total above 400 KB.

## 3. Guide reader and navigation

Eight routes are registered with no authority gate:

| Route name | Path | Page |
| :--- | :--- | :--- |
| `AdminGuide` | `/guide` | Home: start here, role path, continue reading, books, tools, playbook |
| `AdminGuideBook` | `/guide/book/:bookId` | Ordered article list with per-book progress |
| `AdminGuideArticle` | `/guide/a/:articleId` | Reader with book outline, TOC, glossary, widgets, report and read toggle |
| `AdminGuideGlossary` | `/guide/glossary/:slug?` | A–Z glossary and deep-linkable term detail |
| `AdminGuideTools` | `/guide/tools/:tool?` | Five client-only simulators |
| `AdminGuidePlaybook` | `/guide/playbook/:id?` | Situation cards and linked cases/articles |
| `AdminGuideCards` | `/guide/cards/:id?` | Safeguard card catalog |
| `AdminGuideEdgeCases` | `/guide/edge-cases` | Filterable 140-case catalog |

`MarkdownView` uses `markdown-it` (`html:false`, `linkify:false`) and adds callouts, diagram fences, table scrolling, stable heading ids, article/card/situation/glossary links, glossary auto-linking (first occurrence per article, never in headings, links, code or table headers) and widget placeholders. The glossary popover is keyboard reachable and focus-trapped.

## 4. Search and contextual help

`GuideSearch.ts` builds a lazy MiniSearch index over articles, terms, cards, situations, edge cases, quick answers and error codes. Both index and query normalisation lowercase text, strip Arabic diacritics/tatweel, unify alef/ya/ta-marbuta and convert Arabic-Indic digits. Searches use prefix matching, fuzzy 0.2 and `AND` with an `OR` fallback; results are grouped with at most eight per type.

`GuideSearchPalette` is mounted in the default layout. Ctrl/Cmd+K opens the guide palette on `/guide/**` and the global record palette elsewhere; the app-bar trigger and drawer "Search guide…" button also open the guide palette. Recent documents are stored under `pg.guide.recent`.

`PageHeader` automatically renders `ContextHelpButton`; a shared `ContextHelpDrawer` resolves the current route (parent-first) through `context-map.json`, shows the screen summary, safeguard cards, situations and articles, and never unmounts the page. `SafeguardDialog` is mounted globally and `useSafeguard(cardId).confirm()` blocks 22 risky actions until every required box is ticked; Cancel resolves `false` without sending a request.

## 5. Simulators

Five deterministic client-only tools live in `components/guide/widgets/`:

- `TransformSandbox` uses the closed operation library and `decimal.js` rounding.
- `CryptoLab` computes HMAC-SHA256 and shows the exact canonical string, key byte length and output encoding.
- `LedgerExplorer` evaluates the 16 journal events with a tokenizer/`Decimal` expression engine (no `eval`).
- `VisibleRailsExplainer` implements the nine predicates and route-level checks.
- `AttemptStateExplorer` implements the teaching transition table, including `SAME` events and `UNKNOWN`.

Each tool has a Reset button, an explanation panel, bilingual labels and states that it is a teaching tool, not a real system. Unit tests cover the published transform, signature, ledger, visible-rails and attempt-state vectors.

## 6. Progress record

One JSON record per user in `users.academy_progress_json` (the column pre-dates the rebuild; no migration). It is shared by the Guide and the Academy.

```ts
AcademyProgress { schema:1; rev; startedAt; updatedAt; contentVersion; activeTrack?; integrityAcceptedAt?;
  guideRead: Record<articleId,{v,at}>; lessons: Record<lessonId,{at,v,checkScore:0|1|2}>;
  labs: Record<labId,{bestScore,attempts,passedAt?,criticalErrors,v}>;
  exams: Record<examId,{attempts[],open?,passedAt?,v}>; badges: {id,track,earnedAt,expiresAt,v}[] }
```

- **Browser-writable keys** are only `guideRead`, `lessons`, `labs` and `activeTrack`, through `PUT /api/v1/admin/academy/progress` with `{ baseRev, patch }`. The server ignores `exams`, `badges`, `contentVersion`, `rev`, `schema`, `integrityAcceptedAt` and `_server` in a patch, and drops lesson/lab ids that are not in the catalog.
- **Server-written keys** are `exams`, `badges`, `integrityAcceptedAt`, `rev`, `contentVersion`.
- **Merge rules** (server `engine/academy/progress.ts` and client `components/academy/progressMerge.ts` agree): lessons keep the later `at`; labs keep the max `bestScore`/`attempts`, the earliest `passedAt`, and `criticalErrors`/`v` from the best entry; `guideRead` keeps the later `at`. Keys are never deleted: un-reading a Guide article writes a tombstone `{ v: "", at }`.
- **Concurrency:** a stale `baseRev` returns `409 ACADEMY_REV_CONFLICT` with `details:{progress,rev}`; the client refetches, merges and retries once. `rev` also bumps on exam start/submit. The store compare-and-swaps on `User.updatedAt` (retry up to 4, then `ACADEMY_BUSY`).
- **Server-only state** lives in the same JSON under the reserved key `_server` (open exam sessions with question ids and opaque option ids, previous attempt's question ids, attempt counters, last submitted session ids). `publicProgress()` is the only exit and strips it, including from `GET /users/:id`. Stored size limit 64 KB (`413 ACADEMY_PROGRESS_TOO_LARGE`).
- **Legacy rows** (no `schema:1`, the pre-rebuild academy shape) are replaced by a fresh record that carries over only `guideRead`.
- **Client:** `useAcademyProgress` keeps the last record and a queue of unsent patches in `localStorage["pg.academy.progress"]`; a failed save never blocks learning and shows a "not saved yet" indicator. `useGuideProgress` (the Guide's hook) is a thin layer over it and one-time migrates `pg.guide.read`.

## 7. Academy (rebuilt 2026-11-04)

Specification: `design/07-guides-and-academy/academy_system_design_and_content.md` (Parts 0-II are the spec, Part III is the content; the file carries a dated repository note listing the reconciliations made during implementation).

### 7.1 Content pipeline

`admin-front/scripts/extract-academy-content.ts` (`bun scripts/extract-academy-content.ts`) parses only the `<!-- CONTENT:BEGIN -->` … `<!-- CONTENT:END -->` whole-line markers, validates every block and reference, deep-validates lab JSON, and writes deterministic output:

| Output | Content | Audience |
| :--- | :--- | :--- |
| `admin-front/src/content/academy/generated/` | `meta`, `tracks`, `modules`, `lessons.en` (markdown `body`, rendered `html`, `plainText`), `checks.en` (98 practice questions WITH keys), `labs.en` (WITH keys), `drills.en`, `pages.en`, `lab-vectors`, `exam-blueprints.public` (no question ids) | browser |
| `core-back/content/academy/exam-bank.json` | 218 exam-pool questions WITH keys + 8 blueprints | server only, never served |
| `core-back/content/academy/catalog.json` | tracks → lesson/lab/exam ids, lesson/lab titles, badge ids; no questions | server (eligibility, team view) |

Counts (asserted by `academy-content.test.ts`): 8 tracks, 11 modules, 49 lessons (20 Foundation + 29 role), 98 checks, 218 exam-pool questions (203 single, 13 number, 2 order; 40 critical), 15 labs / 86 tasks, 8 exams, 10 drills, 7 pages (+ `lab-vectors`). Generated output is ~75 KB gzipped (budget 600 KB). Exam-pool question ids never appear under `admin-front/src/content/academy/generated/`.

### 7.2 Tracks, badges, routes

`FOUNDATION` (everyone) plus one role track per back-office role (`OPERATOR`, `SUPPORT`, `FINANCE`, `COMPLIANCE`, `MLRO`, `GATEWAY_ADMIN`, `SECURITY_ADMIN`; the role enum and track ids coincide). A user's required tracks = Foundation + their role track. Badges last 12 months and show **Recertification required** when expired or when `meta.recertifyFrom` major is newer than the badge's `v`. Certification is evidence, not permission: nothing in the platform switches authorities on a badge.

| Route name | Path | Notes |
| :--- | :--- | :--- |
| `AdminAcademy` | `/academy` | My learning: active track, **Continue**, rings, badges, Guide reading progress |
| `AdminAcademyTracks` / `AdminAcademyTrack` | `/academy/tracks`, `/academy/track/:trackId` | modules, lesson/lab state, exam Locked (missing prerequisites in words) / Ready |
| `AdminAcademyModule` / `AdminAcademyLesson` | `/academy/module/:moduleId`, `/academy/lesson/:lessonId` | lesson = body, Read now list, two checks, **Mark lesson complete** (needs both checks answered and every reading article opened or read) |
| `AdminAcademyLab` | `/academy/lab/:labId` | lab runner |
| `AdminAcademyExam` | `/academy/exam/:examId` | briefing → runner → result |
| `AdminAcademyCertificate` | `/academy/certificate/:badgeId` | printable |
| `AdminAcademyTeam` | `/academy/team` | `SECURITY_ADMIN` only (`routesRoles`, `admin-back`, `core-back`) |
| `AdminAcademyHelp` | `/academy/help` | learner texts, trainer guide, optional live drills (staging only) |

All ten route names are in the Guide context map's `Academy` screen. No route has an authority gate except Team.

### 7.3 Labs (browser)

`components/academy/labScoring.ts` is pure and unit-tested against the 18 published vectors. Six task kinds: choice, multi, ledger, order, checklist, numeric. Rules: hint costs 1 point (floor 0); multi `max(0,(right-wrong)/totalCorrect)`; ledger compares Decimal cells per expected line and penalises non-zero cells on unexpected accounts, with a live Balanced/NOT BALANCED badge; order partial credit rounded down to 1 decimal; any critical option/wrong id is a critical error. Lab score = round(100·earned/possible); pass = ≥ `passPercent` (80) and zero critical errors. Labs are deterministic (no shuffle, no timers), make no network calls except saving progress, and show a "TRAINING — nothing here is real" ribbon and a `SANDBOX` badge. `progress.labs` keeps best score, attempts, first pass and the critical-error count of the best attempt.

### 7.4 Exams (server)

Endpoints under `/api/v1/admin/academy/` (admin-back proxy → `core-back` `/internal/admin/academy/`): `GET progress`, `PUT progress`, `GET exams/:examId/eligibility`, `POST exams/:examId/start`, `POST exams/:examId/submit`, `GET team`. admin-back rate-limits 60 requests/minute per user (`429 ACADEMY_RATE_LIMITED`). Merchant principals get `403 ACADEMY_BACK_OFFICE_ONLY`.

- **Eligibility:** role exams need a valid (not expired, not below `recertifyFrom`) Foundation badge; every lesson of the track completed; every lab of the track passed (`bestScore ≥ passPercent` and `criticalErrors == 0`, else `lab_critical`). Cooldown after a failed attempt (`cooldownMinutes`). After 3 consecutive failures each module below 70 % in the last attempt needs one of its lessons re-opened after that attempt. `missing[].text` names lessons and labs by title.
- **Start** requires `{ integrityAccepted: true }` (records `integrityAcceptedAt`; `page-integrity` is shown in the briefing). One open session per user per exam; a live session is returned again (`resumed:true`) with the same questions and option ids. The set is built deterministically from `sha256(userId:examId:attemptNumber)` → mulberry32: per-module seeded shuffle preferring questions not in the previous attempt, a floor of `criticalPick` critical questions (swaps inside the same module), seeded order shuffles, opaque random option ids per session. Starting consumes the attempt number and remembers the set even if never submitted (an abandoned session cannot be replayed for free). The start payload has no `correct`, `critical`, explanation, notes or refs.
- **Submit** grades 1 point per question (single/truefalse exact, multi all-or-nothing, order exact sequence, number `decimal.js` within tolerance, unanswered wrong). `scorePercent` rounds half up; pass = `scorePercent ≥ passPercent` and `criticalMissed == 0`. One submission per session (`422 ACADEMY_SESSION_USED`); a submit after expiry + 2 minutes is a failed attempt scored 0 (`expired:true`). A pass issues the track badge (`expiresAt` = +12 calendar months, replaces an older badge). Result items carry the answer, correct answer, `why`, option notes, refs and critical flag.
- **Audit:** `ACADEMY_PROGRESS` (key counts), `ACADEMY_EXAM_STARTED`, `ACADEMY_EXAM_SUBMITTED` (score, pass, critical missed, attempt number only), `ACADEMY_BADGE_ISSUED`, `ACADEMY_TEAM_VIEWED`. Answers and question ids are never logged.
- **Error codes:** 403 `ACADEMY_TEAM_FORBIDDEN`/`ACADEMY_BACK_OFFICE_ONLY`, 404 `ACADEMY_EXAM_NOT_FOUND`, 409 `ACADEMY_REV_CONFLICT`/`ACADEMY_BUSY`, 413 `ACADEMY_PROGRESS_TOO_LARGE`, 422 `ACADEMY_NOT_ELIGIBLE`/`ACADEMY_INTEGRITY_REQUIRED`/`ACADEMY_SESSION_EXPIRED`/`ACADEMY_SESSION_USED`.

### 7.5 Team view

`GET team` (`SECURITY_ADMIN` role, audited) returns one row per back-office user (`merchantId` null, status not `DISABLED`): name (email local part), role, maker/checker flags, required tracks, lessons/labs done vs required, badges with expiry, last activity and a status with precedence `RECERTIFICATION_REQUIRED` > `EXPIRING_SOON` (within 30 days) > `CERTIFIED` > `EXAM_READY` > `IN_PROGRESS` > `NOT_STARTED`. No question text, answers or per-question results. The page filters by role/status/search and exports the visible rows as CSV with a formula-injection guard.

### 7.6 Visual system v2 (2026-11-05)

The first rebuild (7.1-7.5) was functionally complete but visually foreign: it injected a private UI kit (`.ac-btn`, `.ac-chip`, `.ac-card`, `.ac-nav`, `.ac-skel`) through a runtime `<style innerHTML>` on every page, used glyph/emoji icons, mixed `--pg-*` and `--v-theme-*` tokens, and capped the whole Academy at `max-inline-size: 820px` inside the 1600 px `ScreenContainer` (the system container; the 820 px figure is the Guide's *reading measure*, not a page width). v2 re-expresses the same screens, content and behaviour in the admin design system (`00-ui-system.md`).

**Frame.** `components/academy/AcademyShell.tsx` renders `ScreenContainer > .ac-wrap > [page header, section toolbar, body, footer]`. Each page file passes its own `PageHeader` through the `header` render prop (the compliance gate requires the literal `PageHeader` in every route entry). The toolbar holds `ui/AcademyNav` (a segmented-tabs look built from real links; keeps `nav[aria-label="Academy sections"]`, the section stays lit on sub-pages, `aria-current="page"` only on the exact route) and the "not saved yet" `MetaPill`. The shell still loads the progress record on mount and flushes unsent patches on leave.

**Width and layout.** No page-level cap. Pages are grids: `.ac-grid` (auto-fill cards, `--ac-min`), `.ac-split` (main + sticky `.ac-aside`, one column below 1100 px; `.ac-split--reading` caps the main column at 920 px for the lesson, exam runner and review), `.ac-hero` (My learning). Only reading text has a measure (`.ac-prose`, 75 ch).

**Styles.** `src/styles/academy/{base,learner,lesson,lab,exam,team}.css`, imported once through `styles/academy/index.css` from `main.ts`. Tokens only (`--pg-*`), logical properties, flat hairline surfaces, no gradients, `prefers-reduced-motion` honoured, RTL via logical properties and `.ac-flip` for directional icons. The runtime `<style>` block is gone.

**Components.** Pages compose the shared primitives (`PageHeader`, `SurfaceCard`, `StatusBadge`, `MetaPill`, `MetricStrip`, `SegmentedTabs`, `EmptyState`, `DescriptionList`, `VBtn`) plus Academy atoms in `components/academy/ui/`: `StateIcon` (MDI state marker, always paired with words), `ProgressBar`, `Callout` (inline status message), `IconTile`, `trackMeta` (track icons, badge-state → tone). `BadgeChip` is now a `StatusBadge` inside `span.ac-chip[data-track]`; `ProgressRing` is a thin flat ring. Date helpers live in `components/academy/format.ts`.

**Screens (what changed).**

| Route | v2 |
| :--- | :--- |
| `/academy` | Hero card (active track, next-step sentence, one primary **Continue** link, three rings) + split: your tracks (progress, badge, make active) / certificates list with links, Guide reading, quick links. |
| `/academy/tracks` | Filter tabs (All · For my role · Certified) over a card grid with icon, badge state, facts, progress and Required/Active markers. |
| `/academy/track/:id` | Summary + timeline-style module cards; sticky **Exam readiness** aside (status, facts, missing prerequisites in words, exam link). |
| `/academy/module/:id` | Module list with "Up next" marker and previous/next module links. |
| `/academy/lesson/:id` | 75 ch article, Read now, progressive practice checks, finish card; sticky aside with the lesson checklist and the module outline; previous/next tiles. |
| `/academy/lab/:id` | Calm TRAINING/SANDBOX strip (warning tokens, no solid fill), task stage + sticky lab-progress aside, panels grid, token-based answer rows, ledger as a unified-table look with a Balanced badge, task-by-task result. |
| `/academy/exam/:id` | Briefing facts strip + requirements + integrity + coverage; runner with sticky timer/progress/question navigator aside; result with verdict, metrics, filterable review (All · Incorrect · Critical). |
| `/academy/certificate/:id` | Formal sheet (print CSS unchanged) + status/actions aside. |
| `/academy/team` | Status summary strip + the unified table surface (`pg-table-card`/toolbar/footer), `StatusBadge` statuses and mini progress bars; CSV export unchanged. |
| `/academy/help` | Topic rail + `.ac-prose` page; live drills as expandable cards. |

**Defects fixed while verifying the redesign.** (1) Strings with `{placeholders}` were translated without their values (`fmt(t("Continue: lesson {title}"), …)`), but vue-i18n consumes placeholders at translation time, so titles, counts and "x of y" rendered blank; every call now passes the values to `t(key, values)` (`fmt` removed) and content titles are bidi-isolated (`format.ts` `isolate`) inside Arabic sentences. (2) Lesson bodies end with the structural `### Read now` / `### Check yourself` sections (a link list and raw check ids) that the page renders as its own cards; `components/academy/lessonBody.ts` `lessonProse()` stops the displayed prose before them (the content itself is untouched; unit test `tests/unit/academy-lesson-body.test.ts`). (3) The old `.ac-btn` painted a fixed white label on `--pg-accent-primary`, which is near-white in dark mode. (4) `kt-dc` `dc((props) => …)` only declares runtime props when the options argument lists them (`{ props: [...] }`); the exam, certificate and team components now do. (5) Partial-credit lab points are shown with at most two decimals (`pts()`). (6) An independent review of the redesign found and fixed: authored English (`dir="auto"`) sitting at the far edge of RTL option rows (Chrome resolves `text-align: match-parent` to the element's own start, so `html[dir="rtl"]` rules in `base.css` state `right` outright), the lesson checklist reporting "0 of 0 / done" before the checks had loaded (totals now come from `lesson.checkIds`), the exam runner's visual order differing from its DOM order on narrow screens (the aside now follows the question in both; a visual-only clock repeats in the question header), the Team person cell losing its `th scope="row"` role, and the Team 403 state losing its heading.

**Test hooks kept** (see `tests/e2e/admin/academy-*.spec.ts`, `academy-live.ts`): `.ac-wrap`, `.ac-nav`, `.ac-card` (never nested, so the overlap check holds), `.ac-chip[data-track]`, `aria-busy` skeletons, every heading/button/label/region name the specs query. No logic file changed (`useAcademyProgress`, `progressMerge`, `nextStep`, `labScoring`, `useEligibility`, `readingOpened`).

## 8. Contracts and invariants

1. The design file content is the single source of truth; article prose is never retyped into TSX.
2. Generated JSON is committed and byte-stable; count changes require updating the design table and meta counts.
3. Guide content contains no live data, external links or secrets.
4. Guide routes have no authority gate; every admin may read the guide.
5. Money math in simulators uses `decimal.js`; no `eval`, `new Function` or `vm`.
6. Safeguards never replace existing confirmations or maker-checker rules.
7. Opening contextual help must not reset the current form.
8. The guide and Academy share one progress record; a save from either page preserves the other's fields.
9. Exam keys, `critical` flags and explanations never reach the browser before submit; the browser cannot write `exams` or `badges`.
10. The Academy never changes `is_maker`, `is_checker`, a role or an authority.
11. Academy content is never retyped into TSX; labels are corrected only in the design file and logged in `academy_content_fixes.md`.
12. The Academy composes the shared admin primitives and `src/styles/academy/*.css`; it defines no parallel button/chip/card kit, applies no page-width cap (only `.ac-prose` has a measure), never nests `.ac-card` (the e2e `layoutProblems` helper asserts no overlap) and keeps `PageHeader` literally present in every `pages/academy/*.tsx` entry (UI compliance gate).
13. Strings with `{placeholders}` are translated with their values (`t("Continue: lesson {title}", { title })`); never format after translating. Authored English content interpolated into a translated sentence is wrapped with `isolate()`.

## 9. Verification

```bash
cd admin-front && bun run content:guide && bun run content:academy && bun run type-check && bun run test:unit && bun run build
cd ../tests && bunx vitest run unit/guide- unit/academy-
cd ../core-back && bun run typecheck && bun test test/academy-
cd ../admin-back && bun run typecheck && bun test test/academy-progress.test.ts test/admin-surface.test.ts
cd ../tests && bunx playwright test --project=admin e2e/admin/guide-*.spec.ts e2e/admin/academy-*.spec.ts   # needs a deployed stack
```
