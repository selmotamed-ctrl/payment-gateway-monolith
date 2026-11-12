# EMPLOYEE ACADEMY — COMPLETE DESIGN, IMPLEMENTATION SPEC & FULL CONTENT · VERSION 1.0

**Subtitle:** A structured, role-based training and certification programme for every person who works in the Payment Gateway Platform Back Office, built to take someone with **no** payments, accounting, compliance or software background to safe, certified independence.

**Target repository:** `selmotamed-ctrl/payment-gateway-monolith` (primary work in `admin-front`, supporting endpoints in `admin-back` and `core-back`, tests in `tests/`).
**Companion file:** `design/07-guides-and-academy/guide_system_design_and_content.md` (the Interactive Guide). The Academy **teaches and tests**; the Guide is the **reference**. Every lesson points to Guide articles by id. The two share one progress record (defined here, §A-3).
**Supersedes:** `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` §11 (the old 8-module Academy). The Merchant Guide and the Checkout Help Center are **out of scope** and must not be touched.

> **2026-11-04 repository note (corrections made while implementing; PART III content untouched).** The Academy v1.0 rebuild is implemented per this spec with the reconciliations below. Where this spec and the code differ, `project-design/parts/03-admin-front/03-guide-and-academy.md` is canonical.
> * **Paths.** This repository has no `src/` under `core-back`/`admin-back`: use `core-back/engine/academy/*`, `core-back/api/internal/academy.ts`, `core-back/content/academy/{exam-bank,catalog}.json` and `admin-back/api/protected/academy.ts` (§II-1 updated).
> * **No migration.** `users.academy_progress_json` already exists (it held the *old* academy shape). Reading a row without `schema:1` starts a fresh record that keeps only `guideRead`; the old fields are dropped (§II-5, §II-7).
> * **Labs: 15, not 14** (§II-13 A-3). **Panels** may be title-only scenario statements (§II-2.6).
> * **Server-only exam state** (open session question ids, option mapping, last attempt's questions) is stored in the same JSON column under a reserved `_server` key that no endpoint ever returns; the single-column rule of §II-7 therefore still holds (§II-5, §II-9).
> * **`guideRead` un-reading** uses a tombstone entry `{ v: "", at }` because merges never delete keys (§II-5).
> * **Integrity statement.** `POST /exams/:examId/start` requires `{ integrityAccepted: true }` and records `integrityAcceptedAt` (§II-6).
> * **Server catalog.** The extractor also emits `core-back/content/academy/catalog.json` (track → lessons/labs/exam, lesson and lab titles; no questions) so eligibility and the team view can be computed server-side (§II-2.4).
> * **Authority.** `GET /team` and the team route require the `SECURITY_ADMIN` *role* (enforced in the router via `routesRoles`, in `admin-back` and again in `core-back`).
> * **Fix logs** live in `design/07-guides-and-academy/academy_content_fixes.md` and `academy_content_questions.md` (not directly under `design/`).

**Implementation order across both files:** Academy **A-1** (progress record) → Guide **G-0 … G-4** → Academy **A-0, A-2 … A-6** → Guide **G-5, G-6**. (A-1 only needs the backend and the progress hook, so the Guide's read-tracking can be built on it.)

---

## CONTENTS

- **PART 0 — Rules for the implementing agent (OpenCode)**
- **PART I — Product design:** purpose, audience, pedagogy, tracks and certification, information architecture
- **PART II — Technical specification:** files, content format and extractor, types, progress record (§A-3), backend endpoints, exam engine, lab engine, pages and components, tests, quality bars, phased task list
- **PART III — The content** (this is the product; it is copied verbatim into the app)
  - III-A Tracks and badges · III-B Modules and lessons · III-C Question bank · III-D Exam blueprints · III-E Labs · III-F Optional live drills (Fake Rails) · III-G Trainer and manager guide · III-H Learner texts

---

# PART 0 — READ THIS FIRST: RULES FOR THE IMPLEMENTING AGENT

You are implementing the training programme that decides whether a person is allowed to approve payments, move money or handle suspicious-activity matters. A weak or wrong Academy produces people who *believe* they are competent. Therefore:

1. **PART III is the single source of truth. Copy it. Never rewrite, shorten, translate, re-order or "improve" it.** You do not decide what a lesson says, what a question asks, which answer is right, how a lab is scored or what an exam contains. If you think something is wrong or missing, follow rule 5.
2. **Content is extracted by a script, not retyped.** Write `admin-front/scripts/extract-academy-content.ts` (§II-2) which reads this file from `design/` and emits JSON. No lesson, question or lab text may be pasted into `.ts`/`.tsx`.
3. **Answer keys never reach the browser.** The extractor writes **two** outputs: (a) learner content *without* exam answer keys to `admin-front/src/content/academy/generated/`, and (b) the exam bank *with* keys to `core-back/content/academy/exam-bank.json`. Exams are started, graded and recorded **only by `core-back`**. Lesson checks and labs are *practice* and are graded in the browser (their keys are in the learner content on purpose).
4. **The Academy does not grant authority.** It records progress and badges. It must never change `is_maker`, `is_checker`, a role or an authority. Management uses the team view (§II-8) to decide.
5. **Verification procedure for content mismatches.** When you implement a lab or a lesson that names a button, screen or menu item in **bold**, compare the label with the real `t("...")` string in `admin-front`. For each mismatch: (a) change **only the label text** in this design file, (b) append `itemId | old label | new label | file:line` to `design/07-guides-and-academy/academy_content_fixes.md`, (c) never change any explanation, option correctness or score. If a statement of *behaviour* looks wrong, do **not** edit it: append it to `design/07-guides-and-academy/academy_content_questions.md` and continue. Never block on a content question.
6. **Counts must match.** After extraction the generated `meta.json.counts` must equal §II-2.5 exactly; the content test fails the build otherwise.
7. **Money math uses `decimal.js` only. No `eval`, no `new Function`, no `vm`.** Labs are pure client-side code with **no network calls** (except progress saving, §A-3). Labs must work with the Fake Rails service switched off.
8. **Do not touch** `merchant-front`, `checkout-front`, `merchant-back`, `checkout-back`, or ledger/engine code. Backend changes are limited to §II-6 and §II-7.
9. **Definition of Done for every phase:** `bun run type-check` and `bun run build` in `admin-front` (and `bun run type-check` in `core-back` and `admin-back` for backend phases) pass; the named unit and Playwright tests pass; no new `console.error` in the e2e run; the phase checkbox in §II-12 is ticked **only after** its verification command succeeded.
10. **Keep the project conventions:** Vue 3 TSX with `dc()` from `kt-dc`; Vuetify 3; Arabic RTL default with English LTR; `@/` alias; no CSS that scales or transforms `#app`.
11. **New dependencies allowed (and only these):** none beyond those already added by the Guide (`markdown-it`, `minisearch`). `decimal.js` must already be present; if it is not, add it.
12. **Never display or log** a question's answer key, an exam's correct options, or another user's answers outside the team view of §II-8.

---

# PART I — PRODUCT DESIGN

## I-1. Why this is being rebuilt

The previous Academy was a side attraction: eight short modules and a quiz, easy to finish without understanding anything. This platform moves real money. A new employee who approves the wrong request, guesses on an `UNKNOWN` payment, tells a suspect they are under investigation or pastes a secret into a chat can cause losses and legal problems that no later correction undoes. The Academy exists to make sure that, **before** a person receives authority, they have (1) understood the system from zero, (2) practised the decisions in a safe simulation, and (3) proved it in an exam that cannot be passed by luck.

## I-2. Audience

Everyone who signs in to the Back Office, assumed to know **nothing** about payments, accounting, compliance or software: new hires, people moving between roles, and existing staff who must recertify. Language level: plain English (Arabic version later, with the glossary terms' `ar=` renderings from the Guide). Never rely on a term the learner has not met; the Academy links every key term to the Guide glossary.

## I-3. Pedagogy: Learn → See → Do → Prove

| Stage | What the learner does | Where |
| :--- | :--- | :--- |
| **Learn** | Reads a short lesson and the Guide articles it names. | Lesson page |
| **Check** | Answers 2 quick questions per lesson; every answer is explained, right or wrong. | Lesson page (practice, browser-graded) |
| **Do** | Works a simulated desk (lab) with real-looking records and the real button names, receives immediate feedback on every decision. | Lab runner (browser-graded) |
| **Prove** | Sits a certification exam built from a question bank, with critical items. | Exam runner (server-graded) |

### Design principles
1. **Decisions, not trivia.** Most questions are situations: *"You see X. What do you do?"* Memorising a definition is never enough to pass.
2. **Every answer is explained.** Wrong answers teach. No question is a trick.
3. **Critical items.** A small set of rules protects money and people (never guess on `UNKNOWN`, never tip off, never share a password, never approve your own work…). Missing **any** critical item in an exam fails the whole exam, whatever the percentage.
4. **Safe failure.** Labs can be repeated without limit; nothing a learner does in the Academy touches real data.
5. **Honesty over speed.** No countdown pressure in labs. The exam has a generous time limit only to prevent abandoned sessions.
6. **Plain consequences.** Feedback says what would really happen ("the customer pays twice") rather than "incorrect".
7. **One record.** Progress in the Guide and the Academy is one record, so reading, practice and certification are visible in one place.

## I-4. Tracks, badges and what certification means

There is one **Foundation** track that **everyone** completes, then **one role track** per job. Each track = lessons + labs + an exam. A role exam can be taken only after the learner holds the Foundation badge, has finished the track's lessons and passed the track's labs (score ≥ 80%).

| Track id | Who | Badge id |
| :--- | :--- | :--- |
| `FOUNDATION` | Everyone | `FOUNDATION_CERTIFIED` |
| `OPERATOR` | Operators | `CERTIFIED_OPERATOR` |
| `SUPPORT` | Support agents | `CERTIFIED_SUPPORT` |
| `FINANCE` | Finance officers | `CERTIFIED_FINANCE` |
| `COMPLIANCE` | Compliance analysts | `CERTIFIED_COMPLIANCE` |
| `MLRO` | Money Laundering Reporting Officers | `CERTIFIED_MLRO` |
| `GATEWAY_ADMIN` | Gateway administrators | `CERTIFIED_GATEWAY_ARCHITECT` |
| `SECURITY_ADMIN` | Security administrators | `CERTIFIED_SECURITY_ADMIN` |

* A badge is valid for **12 months** (`expiresAt`). After expiry, or when the Academy's `meta.json.recertifyFrom` major version is newer than the badge's version, the badge shows **Recertification required** and the learner retakes the track's exam (lessons and labs stay available for revision; they are not forced again).
* **Certification is evidence, not permission.** The platform does not switch authorities on or off based on badges. Management decides; the team view (§II-8) gives them the facts. The recommended policy, for management to adopt or change, is in §III-G.

## I-5. Information architecture and routes

| Route name | Path | Page |
| :--- | :--- | :--- |
| `AdminAcademy` | `/academy` | **My learning**: current track, next step, progress rings, badges and expiry dates, "Continue" button. |
| `AdminAcademyTracks` | `/academy/tracks` | All tracks, what each covers, prerequisites, estimated hours. |
| `AdminAcademyTrack` | `/academy/track/:trackId` | A track: modules in order, each with lessons, labs and the exam, with lock/ready/done states. |
| `AdminAcademyModule` | `/academy/module/:moduleId` | A module: objectives, its lessons, its labs. |
| `AdminAcademyLesson` | `/academy/lesson/:lessonId` | One lesson with required reading and its 2 checks. |
| `AdminAcademyLab` | `/academy/lab/:labId` | The lab runner. |
| `AdminAcademyExam` | `/academy/exam/:examId` | Exam briefing, runner and results. |
| `AdminAcademyCertificate` | `/academy/certificate/:badgeId` | Printable certificate. |
| `AdminAcademyTeam` | `/academy/team` | Manager view (`SECURITY_ADMIN` only). |
| `AdminAcademyHelp` | `/academy/help` | How the Academy works, scoring, integrity statement, trainer guide link (III-H). |

None of these routes needs an authority except `AdminAcademyTeam` (role `SECURITY_ADMIN`). Every route name above must be **added to the `routeNames` list of the `Academy` screen entry in the Guide's `context-map`** (`design/07-guides-and-academy/guide_system_design_and_content.md` §III-F.3), and logged in `design/07-guides-and-academy/academy_content_fixes.md`.

---

# PART II — TECHNICAL SPECIFICATION

## II-1. Files to create, change, delete

```text
admin-front/
  scripts/extract-academy-content.ts                 NEW  (§II-2)
  package.json                                       CHANGE  script "content:academy"
  src/content/academy/generated/*.json               NEW  (generated, committed; NO exam keys)
  src/content/academy/index.ts                       NEW  typed lazy loaders
  src/components/academy/
      AcademyShell.tsx  ProgressRing.tsx  TrackCard.tsx  ModuleList.tsx  BadgeChip.tsx
      LessonView.tsx  LessonCheck.tsx  ReadingList.tsx
      lab/LabRunner.tsx  lab/PanelView.tsx  lab/ChoiceTask.tsx  lab/MultiTask.tsx
      lab/LedgerTask.tsx  lab/OrderTask.tsx  lab/ChecklistTask.tsx  lab/NumericTask.tsx  lab/LabResult.tsx
      exam/ExamBriefing.tsx  exam/ExamRunner.tsx  exam/ExamResult.tsx
      CertificateView.tsx  TeamTable.tsx  useAcademyProgress.ts  progressMerge.ts  labScoring.ts
  src/pages/academy/{index,tracks,track,module,lesson,lab,exam,certificate,team,help}.tsx   REWRITE/NEW
  src/router/index.ts                                CHANGE  add the routes of §I-5
  src/layouts/sections.tsx                           CHANGE  "Learning" keeps AdminGuide & AdminAcademy
core-back/
  content/academy/exam-bank.json                     NEW  (generated, committed; WITH keys; never served)
  content/academy/catalog.json                       NEW  (generated, committed; track/lesson/lab ids and titles, no questions)
  engine/academy/{types,catalog,progress,examEngine,grading,team}.ts   NEW
  api/internal/academy.ts                            NEW  (router mounted by api/internal/admin.ts)
  prisma/schema.prisma                               UNCHANGED  (users.academy_progress_json already exists; new shape only)
admin-back/
  api/protected/academy.ts                           CHANGE  proxy to core-back over the existing mTLS channel
tests/unit/academy-*.test.ts   tests/e2e/admin/academy-*.spec.ts     NEW
design/07-guides-and-academy/academy_content_fixes.md, academy_content_questions.md        NEW (empty headers)
```

Follow the existing patterns for admin routes, authentication, the Double-Check Rule and Prisma migrations: locate a small existing admin endpoint (for example the settings endpoints) and mirror its structure exactly. Do not invent new infrastructure.

## II-2. Content format and the extractor

### II-2.1 Block syntax (everything in PART III uses exactly this)

The file is parsed line by line between the two marker lines `<!-- CONTENT:BEGIN -->` and `<!-- CONTENT:END -->` (each marker is a whole line by itself; mentions of them inside other text are not markers). Text outside blocks (headings, blank lines) is ignored. A block starts with a line `@@kind key=value …` and ends with a line `@@end`, except one-line blocks noted below. Attribute values with spaces are in double quotes.

| Block | Header attributes | Body |
| :--- | :--- | :--- |
| `@@track` (one line) | `id title badge hours="…" requires=ID,… :: description` (`requires=-` means none) | none |
| `@@module` (one line) | `id title minutes :: objective sentence` | none |
| `@@lesson` | `id module order title minutes tracks=A,B reading=b00-01,…` | Markdown with the fixed section headings of §II-2.2 |
| `@@q` | `id module type difficulty critical exam lesson tracks refs` | Question body (§II-2.3) |
| `@@lab` | `id module title minutes tracks refs` | A fenced `json` block (§II-10) |
| `@@exam` | `id track` | A fenced `json` block (§II-9) |
| `@@drill` | `id title rail minutes refs` | Markdown steps (optional live drills, III-F) |
| `@@page` | `id title` | Markdown (learner texts, trainer guide) |

Attribute meanings: `tracks` is a comma list of track ids or `ALL`; `refs` and `reading` are Guide article ids and **must exist** in `guide_system_design_and_content.md`; `critical` and `exam` are `true`/`false`; `lesson` (on a question) is the lesson id for a practice check, or absent for exam-pool questions; `type` is `single`, `multi`, `order`, `number` or `truefalse`; `difficulty` is 1, 2 or 3.

### II-2.2 Lesson body: fixed sections

Every lesson body contains exactly these level-3 headings in this order: `### You will be able to`, `### Key ideas`, `### A worked example`, `### Common mistakes`, `### Read now`, `### Check yourself`. The `### Read now` section lists the reading articles as `[[a:ID]]` links (resolved to Guide routes). The `### Check yourself` section is a line `Questions: q-…, q-…` naming the lesson's two practice questions. Markdown dialect: the same as the Guide (§II-2.2 of the Guide file), including `:::note|tip|warning|danger` callouts and `[[g:slug]]` glossary links.

### II-2.3 Question body

```text
@@q id=q-m5-014 module=m5 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,SUPPORT refs=b07-03
Stem: The situation or question, in one or more lines.
- [ ] Wrong option text :: short note shown after the answer (optional)
- [x] Correct option text :: short note (optional)
Why: The explanation of the right answer (mandatory), in plain words.
@@end
```
* `single`: exactly one `[x]`; `multi`: two or more `[x]` (graded all-or-nothing in exams); `truefalse`: two options `True`/`False`; `order`: the options are written **in the correct order** with numbers `1.` `2.` …; the runtime shuffles them; `number`: no options; a line `Answer: 97.0000` and an optional `Tolerance: 0`, compared with `decimal.js`.
* 3 to 5 options for `single` and `multi`. The runtime shuffles options (never `All of the above`/`None of the above`; none are used).
* Question ids are `q-<module>-<nnn>` for exam-pool questions and `c-<lesson-id>-<n>` for lesson checks (for example `c-l-m5-3-1`).

### II-2.4 `scripts/extract-academy-content.ts` — required behaviour

1. Read `design/07-guides-and-academy/academy_system_design_and_content.md` and `design/07-guides-and-academy/guide_system_design_and_content.md` (only to resolve article ids).
2. Parse all blocks. Fail with a clear message on: unknown block kind, missing `@@end`, duplicate id, unresolved reference (article id, module, lesson, question, lab, track), a lesson missing a fixed section, a `single` question without exactly one correct option, a `multi` question with fewer than two, a question without `Why:`, an `order` question with fewer than 3 items, a `number` question without `Answer:`, invalid JSON in a `@@lab` or `@@exam` block.
3. Emit to `admin-front/src/content/academy/generated/`: `meta.json`, `tracks.json`, `modules.json`, `lessons.en.json` (each with `html` rendered by `markdown-it` and `plainText`), `checks.en.json` (lesson-check questions **with** keys), `labs.en.json` (**with** keys), `drills.en.json`, `pages.en.json`. The `@@page` with id `lab-vectors` is also emitted verbatim as `lab-vectors.json` (its fenced JSON) for the scoring tests.
4. Emit to `core-back/content/academy/exam-bank.json` the exam-pool questions (`exam=true`) **with** keys and the exam blueprints, and to `core-back/content/academy/catalog.json` the track/module/lesson/lab ids, titles and exam ids (no question content). Emit to `admin-front` a `exam-blueprints.public.json` with only: exam id, track, question count, pass mark, time limit, module composition — **never** question ids.
5. `meta.json` contains `contentVersion` (`1.0.0`), `recertifyFrom` (`1.0.0`), `counts`, `generatedAt` and a content hash.
6. Deterministic output: stable ordering; running twice gives identical files.

### II-2.5 EXPECTED COUNTS (the content test asserts these)

| Item | Count | Source |
| :--- | :--- | :--- |
| Tracks | 8 | `@@track` lines |
| Modules | 11 | `@@module` lines |
| Lessons | 50 | `@@lesson` blocks (20 Foundation, 30 role) |
| Lesson checks (practice questions) | 100 | `@@q` with `lesson=` (exactly 2 per lesson) |
| Exam-pool questions | 223 | `@@q` with `exam=true` (208 single, 13 number, 2 order) |
| Critical exam-pool questions | 43 | `critical=true` among exam-pool questions |
| Labs | 16 | `@@lab` blocks |
| Lab tasks | 92 | sum of tasks in all labs |
| Exams | 8 | `@@exam` blocks (one per track) |
| Live drills | 11 | `@@drill` blocks |
| Pages | 7 | `@@page` blocks (including `lab-vectors`) |

`meta.json.counts` must equal this table exactly. A content change that changes a count is allowed only together with an update of this table in the same commit.

### II-2.6 TypeScript types (create in `src/content/academy/index.ts`)

```ts
export type TrackId = "FOUNDATION"|"OPERATOR"|"SUPPORT"|"FINANCE"|"COMPLIANCE"|"MLRO"|"GATEWAY_ADMIN"|"SECURITY_ADMIN";
export interface Track { id:TrackId; title:string; badge:string; hours:string; requires:TrackId[]; description:string; moduleIds:string[]; lessonIds:string[]; labIds:string[]; examId:string }
export interface Module { id:string; title:string; minutes:number; objective:string; lessonIds:string[]; labIds:string[] }
export interface Lesson { id:string; module:string; order:number; title:string; minutes:number; tracks:string[]; reading:string[]; html:string; plainText:string; checkIds:string[] }
export type QType = "single"|"multi"|"order"|"number"|"truefalse";
export interface QOption { id:string; text:string; correct?:boolean; note?:string }   // `correct` present only in practice content
export interface Question { id:string; module:string; type:QType; difficulty:1|2|3; critical:boolean; refs:string[]; stem:string; options:QOption[]; answer?:string; tolerance?:string; why?:string }
export interface ExamBlueprint { id:string; track:TrackId; questionCount:number; passPercent:number; timeLimitMinutes:number; composition:{module:string; count:number}[]; criticalPick:number; cooldownMinutes:number }
export type Panel = { title:string } & ( {rows:[string,string][]} | {table:{columns:string[]; rows:string[][]}} | {timeline:{t:string; text:string; flag?:"warn"|"ok"|"bad"}[]} | {text:string} | {} );   // a title-only panel is a plain scenario statement
export type LabTask = ChoiceTask|MultiTask|LedgerTask|OrderTask|ChecklistTask|NumericTask;   // §II-10
export interface Lab { id:string; module:string; title:string; minutes:number; tracks:string[]; refs:string[]; briefing:string; passPercent:number; tasks:LabTask[] }
```

## II-3. Loading, routing, layout

* Content JSON is loaded with dynamic `import()`; total gzip size of everything in `generated/` must stay below **600 KB** (test asserts).
* Routes are added to the explicit router table. Layout follows the Guide's conventions (RTL/LTR logical properties, max reading width 820 px, 16 px base, skeleton while loading, never a blank page, never scale `#app`).
* **My learning (`/academy`):** shows (1) the learner's **active track** (the first track whose badge is missing; the learner may switch), (2) a single big **Continue** button that opens the next incomplete step in the order *lesson → its checks → next lesson … → module lab → … → exam*, (3) progress rings for lessons, labs and the exam, (4) badges with expiry and a clear **Recertification required** state, (5) the Guide reading progress ("Articles read: x of y recommended for your track").
* **Track page:** modules in order; each lesson shows `todo / in progress / done`; labs show best score; the exam shows **Locked** with the exact missing prerequisites listed in words, or **Ready**. Learners may open any lesson or lab at any time (the order is a recommendation); only the **exam** is gated.
* **Lesson page:** title, minutes, objectives, the lesson body, **Read now** list (each article shows a ✓ when it is marked read in the progress record), the two practice checks with immediate explanation, and a **Mark lesson complete** button that is enabled only when both checks were answered (any outcome) **and** every article under *Read now* has been opened or marked read.
* **Help text for learners** on every page footer: "Stuck? Open the Guide article, or ask your trainer." No network.

## II-4. Practice checks (lesson questions)

* Presented one at a time, answers shuffled, immediate result: green/red, the explanation (`Why:`), per-option notes, and the linked Guide article. A wrong answer may be retried; the lesson stores `checkScore` = number of checks answered correctly on the **first** try (0–2).
* The check result never blocks progress. Its purpose is learning. (Blocking is done by labs and exams.)

## II-5. Progress record (§A-3) — shared with the Guide

Stored in the existing user table as `users.academy_progress_json JSON NULL` (migration adds the column; default `NULL` = empty record). Shape:

```ts
export interface AcademyProgress {
  schema: 1;
  rev: number;                                  // incremented by the server on every write
  startedAt: string; updatedAt: string;         // ISO-8601 UTC
  contentVersion: string;                       // meta.contentVersion at last write
  activeTrack?: TrackId;
  guideRead: Record<string,{ v:string; at:string }>;                 // Guide article id → content version read
  lessons:   Record<string,{ at:string; v:string; checkScore:0|1|2 }>;
  labs:      Record<string,{ bestScore:number; attempts:number; passedAt?:string; criticalErrors:number; v:string }>;
  exams:     Record<string,{ attempts:ExamAttemptSummary[]; open?:OpenExamSession; passedAt?:string; v:string }>;
  badges:    { id:string; track:TrackId; earnedAt:string; expiresAt:string; v:string }[];
  integrityAcceptedAt?: string;                 // server-written when the learner accepts the integrity statement
}
export interface ExamAttemptSummary { at:string; scorePercent:number; passed:boolean; criticalMissed:number; moduleScores:Record<string,number>; durationSeconds:number }
export interface OpenExamSession { sessionId:string; startedAt:string; expiresAt:string }  // question ids live only on the server
```

Rules:
* **Size limit** 64 KB (server rejects larger; the limit covers the whole stored JSON including the reserved `_server` key).
* **Server-only state** (`_server`: open exam sessions with question ids and opaque option ids, the previous attempt's question ids, failure counters) is kept in the same JSON column and is never returned by any endpoint or written by a client patch.
* **Old rows:** a stored value without `schema:1` is the old academy's shape; it is replaced by a fresh record that carries over only `guideRead`.
* **Un-reading a Guide article** is a tombstone `guideRead[id] = { v:"", at }` (merges never delete keys; the later `at` wins). `v === ""` means "not read".
* **Lab entries** merge per id: `bestScore` max, `attempts` max, `passedAt` earliest, and `criticalErrors`/`v` from the entry with the higher `bestScore` (tie: fewer critical errors).
* The browser may write **only** `guideRead`, `lessons`, `labs` and `activeTrack`, through `PUT /api/v1/admin/academy/progress` with `{ baseRev, patch }`. `patch` is a partial object merged by key (never deleting keys) and the server **ignores** any `exams`, `badges` or `contentVersion` content in a client patch.
* `exams` and `badges` are written **only** by the server as a result of exam start/submit (§II-6).
* **Concurrency:** if `baseRev` differs from the stored `rev` the server answers `409` with the current record; `progressMerge.ts` merges (union of keys; for the same key keep the entry with the later `at`; for `bestScore` keep the maximum; for `attempts` keep the maximum) and retries once.
* **Offline fallback:** the hook keeps the last known record in `localStorage` key `pg.academy.progress` and a queue of unsent patches; failure to save never blocks learning and shows a small "not saved yet" indicator.
* The Guide writes `guideRead` through the same hook (Guide §II-12 phase G-5).

## II-6. Backend endpoints (`core-back` owns data and grading; `admin-back` proxies)

All routes are under `/api/v1/admin/academy/` in `admin-back`, require a signed-in admin, no extra authority except the team route, and are forwarded to `core-back` which **re-checks identity and role** (Double-Check Rule). Every write is audited with action codes `ACADEMY_PROGRESS`, `ACADEMY_EXAM_STARTED`, `ACADEMY_EXAM_SUBMITTED`, `ACADEMY_BADGE_ISSUED`.

| Method and path | Purpose |
| :--- | :--- |
| `GET  /progress` | Returns `{ progress, rev }` for the caller (creates an empty record on first read). |
| `PUT  /progress` | `{ baseRev, patch }` as above; returns the new record. |
| `GET  /exams/:examId/eligibility` | Returns `{ eligible, missing:[{kind,id,text}], cooldownUntil?, reviewRequired?:moduleId[] }`. |
| `POST /exams/:examId/start` | Body `{ integrityAccepted:true }` (required). Checks eligibility, builds the question set (§II-9), stores the open session server-side, returns `{ sessionId, expiresAt, questions:[{qid, type, stem, options:[{oid,text}]}] }` **without keys and without `critical`**. Option ids are opaque and re-generated per session. |
| `POST /exams/:examId/submit` | `{ sessionId, answers }`. Grades on the server, records the attempt, issues a badge if passed, returns the full result with explanations (§II-9). One submission per session. |
| `GET  /team` | `SECURITY_ADMIN` only: the team table of §II-8. |

Errors: `403` (not allowed), `404`, `409` (progress revision), `422` (exam not eligible, session expired or already used), `413` (record too large). Rate limit: 60 requests/minute per user.

## II-7. Database change

**No migration is needed in this repository:** `users.academy_progress_json JSON NULL` already exists. The Academy changes only the *shape* stored in it (and adds the reserved `_server` key). No other tables.

## II-8. Team view (`AdminAcademyTeam`, `SECURITY_ADMIN` only)

A read-only table of all staff accounts: name, role(s), active track, lessons completed / required, labs passed / required, **badges with expiry**, last activity date, and a coloured status (`Not started`, `In progress`, `Exam ready`, `Certified`, `Expiring within 30 days`, `Recertification required`). A filter by role and status, and a CSV export of the visible table. The view shows **no** question text, answers or per-question results. Opening it is audited.

## II-9. Exam engine (core-back)

**Blueprint data** (`@@exam` JSON in §III-D):

```json
{ "id":"exam-operator", "track":"OPERATOR", "questionCount":35, "passPercent":80, "timeLimitMinutes":90,
  "composition":[{"module":"m4","count":6}, …], "criticalPick":6, "cooldownMinutes":30 }
```

**Building a question set (deterministic from a seed):** `seed = hash(userId + examId + attemptNumber)`.
1. Eligible pool per module = exam-pool questions (`exam=true`) whose `tracks` contains the exam's track or `ALL`.
2. From each module's pool pick `count` questions with a seeded shuffle, **preferring questions not used in the learner's previous attempt**.
3. `criticalPick`: ensure at least that many **critical** questions are included in total (swap non-critical picks inside the same module for critical ones from the same pool until reached, never exceeding the module's `count`).
4. Difficulty mix: unchanged by the engine (the pool authors balanced difficulty); do not weight.
5. Shuffle question order and option order with the seed. For `order` questions, shuffle the items.
6. Never repeat a question within one exam.

**Grading:** each question is worth 1 point. `single`, `truefalse`: exact. `multi`: all-or-nothing. `order`: exact sequence. `number`: `Decimal` equality within tolerance. Unanswered = wrong. `scorePercent = round(100 × points / questionCount)` (half up). **Pass** = `scorePercent ≥ passPercent` **and** `criticalMissed == 0`.

**Result payload** (only after submit): `{ passed, scorePercent, criticalMissed, moduleScores, durationSeconds, items:[{ qid, correct, yourAnswer, correctAnswer, why, optionNotes, refs, critical }], reviewRequired:moduleId[] }`. `moduleScores` is the percentage per module; `reviewRequired` lists modules below 70%.

**Eligibility rules:**
* Foundation exam: all Foundation lessons completed and Foundation labs passed.
* Role exams: Foundation badge present and **not expired**; all of the track's lessons completed; all of the track's labs passed (`bestScore ≥ 80` and `criticalErrors` recorded for the passing attempt = 0).
* After a failed attempt: a **cooldown** of `cooldownMinutes` before the next start. After **3 consecutive failures**, `reviewRequired` modules must each have their lessons re-opened (their `lessons[id].at` newer than the last failed attempt) before the next start.
* Only one open session per user per exam. A session expires at `timeLimitMinutes`; submitting after expiry is accepted only if received within 2 minutes of expiry, otherwise the attempt counts as failed with score 0.
* A passing result **replaces** any expired badge for the same track and issues a new badge with `expiresAt = passedAt + 12 months`.

## II-10. Lab engine (browser)

A lab is JSON (§III-E). The runner shows the **briefing**, then the tasks **one at a time**. For each task the learner sees one or more **panels** (a mock record) and a **prompt**, makes the decision, presses **Check**, and immediately sees the **feedback** and the points; then **Next**. Labs are deterministic: no randomness, no timers.

```ts
interface TaskBase { id:string; title:string; panels:Panel[]; prompt:string; points:number; hint?:string; refs?:string[] }
interface ChoiceTask extends TaskBase { kind:"choice"; options:{ id:string; label:string; correct:boolean; critical?:boolean; feedback:string }[] }
interface MultiTask  extends TaskBase { kind:"multi";  options:{ id:string; label:string; correct:boolean; feedback:string }[]; criticalWrong?:string[] }
interface LedgerTask extends TaskBase { kind:"ledger"; accounts:string[]; expected:{ account:string; side:"DR"|"CR"; amount:string }[]; feedback:string }
interface OrderTask  extends TaskBase { kind:"order";  items:{ id:string; label:string }[]; correctOrder:string[]; feedback:string }
interface ChecklistTask extends TaskBase { kind:"checklist"; items:{ id:string; label:string; shouldTick:boolean; why:string }[]; criticalWrong?:string[] }
interface NumericTask extends TaskBase { kind:"numeric"; answer:string; tolerance:string; unit?:string; feedback:string }
```

**Scoring (`labScoring.ts`, pure functions, unit-tested):**
* `choice`: full `points` if the chosen option is `correct`, else 0. If the chosen option has `critical:true` the task is a **critical error**.
* `multi`: `points × max(0, (correctSelected − wrongSelected) / totalCorrect)`; any id in `criticalWrong` selected is a critical error.
* `ledger`: for each expected line, the learner's debit or credit cell (the side given) must equal `amount` (Decimal); every account **not** in `expected` must be empty or zero. Score = `points × max(0, (matchedLines − extraNonZeroCells) / expectedLines)`. A live badge shows **Balanced** or **NOT BALANCED** (Σ debit = Σ credit).
* `order`: full points if the sequence is exact; else `points × (correctPositions / n)` rounded down to 1 decimal.
* `checklist`: each item is right when ticked iff `shouldTick`. Score = `points × (rightItems / totalItems)`; any item id in `criticalWrong` that is wrongly ticked is a **critical error**.
* `numeric`: Decimal equality within tolerance → full points.
* A task's `hint` costs 1 point (never below 0) and is shown only on request.
* **Lab score** = `round(100 × sum(task scores) / sum(task points))`. **Pass** = score ≥ `passPercent` (80) **and** zero critical errors in that attempt. A lab can be repeated without limit; the progress record keeps `bestScore`, `attempts`, `passedAt` (first pass), and `criticalErrors` of the **best passing** attempt.
* The result page lists every task with right/wrong, the feedback text, the guide references, and **what would have happened in real life**.

**Mock-screen rendering rules:** panels are plain, read-only cards using the real button names in **bold** in prompts and options. Never render live data. Show a persistent **TRAINING — nothing here is real** ribbon and a `SANDBOX` badge.

## II-11. Tests (create all)

**Unit (`tests/unit`, Vitest):**
* `academy-content.test.ts`: re-runs the extractor to a temp dir and compares to committed output; asserts EXPECTED COUNTS; every reference resolves; every lesson has the fixed sections; every question valid; every `@@q lesson=` id is named by exactly one lesson; every lesson names exactly two checks; every module has ≥ 1 lesson; every track's lists resolve; each exam blueprint's `composition` counts sum to `questionCount` and every module pool has **at least 1.25 ×** the requested count (after filtering by track); `criticalPick` ≤ available critical questions; gzip size below the limit; **no answer key** appears in any file under `admin-front/src/content/academy/generated/` for exam-pool questions (grep the ids).
* `academy-lab-scoring.test.ts`: the **lab vectors** of §III-E.0 and the scoring rules of §II-10 (each task kind).
* `academy-exam-engine.test.ts` (in `core-back` tests): deterministic set for a fixed seed; no repeats; prefers unseen questions; `criticalPick` satisfied; grading of each question type; critical-miss fails a 100 % score minus one; cooldown; review-required after 3 failures; expired session; second submit refused; keys and `critical` flags absent from the start payload.
* `academy-progress.test.ts`: merge rules; client cannot write `exams`/`badges`; 64 KB limit; `409` merge-retry.

**E2E (`tests/e2e/admin`, Playwright):**
* `academy-learning.spec.ts`: sign in; open `/academy`; **Continue** opens the first lesson; answer both checks; the **Mark lesson complete** button is disabled until the reading is opened; complete; reload; progress persisted.
* `academy-lab.spec.ts`: run `lab-approval-desk` choosing the right answers; pass; run again choosing a critical-error option; fail with the critical-error message; best score preserved.
* `academy-exam.spec.ts`: seed a user with all prerequisites; start `exam-foundation`; assert the network response contains no `correct` field; answer; submit; result page shows explanations; badge appears; certificate page prints.
* `academy-team.spec.ts`: non-`SECURITY_ADMIN` gets 403/hidden; `SECURITY_ADMIN` sees the table and exports CSV.
* `academy-a11y.spec.ts`: keyboard-only completion of one lesson check and one lab task; focus order correct; RTL screenshot has no overlap at 360 px and 1280 px.

## II-12. Quality bars

* Lighthouse a11y ≥ 95 on `/academy`, a lesson page and the lab runner. Every interactive element keyboard reachable; results announced with `aria-live`; colours never the only signal (✓/✗ icons and text).
* First lesson render < 500 ms after route enter (content lazy-loaded; skeleton).
* Labs and lessons work with the network blocked (except saving). Saving failures never lose progress (queue).
* No exam content in the browser until `start`; closing and reopening the tab resumes the **same** open session (the server returns the same questions) until it expires.

## II-13. Phased task list for OpenCode (tick only after verification)

* [ ] **A-1 Progress record and endpoints.** No migration (column exists); `core-back` progress service, `admin-back` proxy for `GET/PUT /progress`, `useAcademyProgress`, `progressMerge`. *Verify:* `bun run test:unit -- academy-progress`.
* [ ] **A-0 Content pipeline.** `extract-academy-content.ts`, `content:academy`, generated JSON, both outputs, `academy-content.test.ts`. *Verify:* `cd admin-front && bun run content:academy && cd ../tests && bun run test:unit -- academy-content`.
* [ ] **A-2 Learner experience.** Router entries, My learning, tracks, track, module, lesson pages, checks, reading integration with the Guide progress, `AcademyShell`, badges display. *Verify:* build + `academy-learning.spec.ts`.
* [ ] **A-3 Lab engine and labs.** `labScoring.ts`, six task components, runner, results, the 15 labs. *Verify:* `academy-lab-scoring` + `academy-lab.spec.ts`.
* [ ] **A-4 Exams.** `core-back` exam engine, eligibility, start/submit, grading, badge issuance; exam runner and results UI; certificate page. *Verify:* `academy-exam-engine` + `academy-exam.spec.ts`.
* [ ] **A-5 Team view and help.** `GET /team`, team table, CSV, help page with III-H texts, optional live-drill pages (III-F). *Verify:* `academy-team.spec.ts`.
* [ ] **A-6 Audit.** Run the verification procedure of Part 0 rule 5 over every lab and lesson; fill `academy_content_fixes.md` / `academy_content_questions.md`; add Academy route names to the Guide's context map; full test run; add a short note to `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §17: "Academy v1.0 replaced by design/07-guides-and-academy/academy_system_design_and_content.md".

---

# PART III — THE CONTENT

<!-- CONTENT:BEGIN -->
## III-A. Tracks and badges

@@track id=FOUNDATION title="Foundation (everyone)" badge=FOUNDATION_CERTIFIED hours="9-12" requires=- :: What the platform is, how money moves, who may do what, the two-person rule, confidentiality, security habits. Everyone completes this before a role track.
@@track id=OPERATOR title="Operator" badge=CERTIFIED_OPERATOR hours="11-15" requires=FOUNDATION :: Join requests, KYB, payments in operation, UNKNOWN, cases, incidents.
@@track id=SUPPORT title="Support agent" badge=CERTIFIED_SUPPORT hours="6-7" requires=FOUNDATION :: Reading payments, answering customers and merchants safely, never revealing confidential reasons.
@@track id=FINANCE title="Finance officer" badge=CERTIFIED_FINANCE hours="10-13" requires=FOUNDATION :: The ledger, commission, reconciliation, cash-outs, adjustments, disputes, drift.
@@track id=COMPLIANCE title="Compliance analyst" badge=CERTIFIED_COMPLIANCE hours="5-7" requires=FOUNDATION :: KYB review, screening, rules, cases, restrictions, reporting, confidentiality.
@@track id=MLRO title="Money Laundering Reporting Officer" badge=CERTIFIED_MLRO hours="5-6" requires=FOUNDATION :: Case approvals, emergency ratification, rule approval, regulatory reporting.
@@track id=GATEWAY_ADMIN title="Gateway administrator" badge=CERTIFIED_GATEWAY_ARCHITECT hours="10-13" requires=FOUNDATION :: Gateways, rails, routes, engine, signatures, amounts, wizard, AI import, gates, runbooks.
@@track id=SECURITY_ADMIN title="Security administrator" badge=CERTIFIED_SECURITY_ADMIN hours="6-7" requires=FOUNDATION :: Approvals of gateway changes, deployment, certificates and secrets, incidents.

## III-B. Modules and lessons

@@module id=m0 title="Orientation and the rules of the house" minutes=47 :: You understand how training works and can apply the Ten Golden Rules.
@@module id=m1 title="How money moves" minutes=90 :: You can explain payments, switches, gateways, Libyan money, how computers talk and how trust works.
@@module id=m2 title="The platform map" minutes=55 :: You know the platform's parts, the merchant-application-wallet-link chain, roles and confidentiality.
@@module id=m3 title="Governance: the two-person rule" minutes=65 :: You can act as a safe maker or checker and write a real reason.
@@module id=m4 title="Merchants and onboarding" minutes=80 :: You can review a join request, handle KYB and help merchants without leaking secrets.
@@module id=m5 title="Payments in operation" minutes=155 :: You can read any payment, handle UNKNOWN and answer customers correctly.
@@module id=m6 title="Money and the ledger" minutes=165 :: You can read and build journal entries and handle reconciliation, cash-outs, adjustments and disputes.
@@module id=m7 title="AML and confidentiality" minutes=125 :: You can explain AML, decide screening matches, handle cases and never tip off.
@@module id=m8 title="Gateways, rails and the engine" minutes=165 :: You can configure and review a gateway safely.
@@module id=m9 title="When things go wrong" minutes=75 :: You can follow the runbooks, hand over and report mistakes.
@@module id=m10 title="Security and deployment" minutes=95 :: You can resist social engineering, handle data and understand the deployment model.

@@lesson id=l-m0-1 module=m0 order=1 title="Welcome: how the Academy works and what is expected of you" minutes=3 tracks=FOUNDATION reading=b00-01,b00-02,b00-04
### You will be able to
- Say what the platform does in one sentence.
- Explain how Learn, Check, Do and Prove fit together.
- Explain why the Guide and the Academy are not two separate systems and why neither replaces the other.
- Say what happens when you miss one critical exam question.

### Key ideas
- **The platform lets approved businesses take payments and keeps exact books of the money.** A business that takes payments here is called a **merchant**. Every movement of money is written into our books.
- **The Guide is the reference. The Academy teaches and tests.** They are not two separate systems. They share one progress record, so an article you mark as read counts in the Academy too. The Academy does not replace the Guide, because the Guide holds the full detail.
- **Learn, Check, Do and Prove are four steps.** Lessons teach (Learn). Short checks give you instant feedback (Check). Labs let you practise decisions (Do). Exams prove you are ready (Prove). Nothing in the Academy touches real money or real data.
- **A critical exam question protects money or people.** If you miss even one critical question, the exam fails, whatever your percentage. A high score cannot cancel a mistake that could hurt someone. A missed ordinary question only lowers your score.
- **A certificate is evidence for your manager.** It does not switch on any permission by itself. Management may ask for it before your account is made a maker or a checker, but it is your manager and the account settings that give rights.
- **Being slow is acceptable. Guessing with other people's money is not.** If you are not sure, stop and ask.

### A worked example
Ali joins the company as an operator.
1. On day 1 he reads the Welcome article and "How to use this guide". He reads ten glossary terms he did not know.
2. He opens the Academy and presses **Continue**. Because the Academy and the Guide share one progress record, the articles he marked as read are already counted.
3. He does the lessons, answers the checks, and uses the labs for his track. He does not touch a live screen until his manager says he may.
4. In week 2 he sits the final exam for his track. Suppose he scores 95 percent but missed one critical question. The exam fails, because one critical miss fails the exam whatever the score.
5. When he passes, his manager reads the certificate as proof that he is ready. His account rights still come from the account settings, not from the badge.

Notice the order: reading first, practice second, proof last, and real authority only after that.

### Common mistakes
- Skipping the reading because the lesson looks short. The lesson is a summary, and the Guide holds the detail you need.
- Treating checks as a test to be rushed. They exist to teach you, so rushing wastes them.
- Thinking a badge gives you new permissions. It is evidence only, so you still cannot act until your account is switched on.
- Believing a high score can make up for one wrong critical answer. It cannot: the exam still fails.

### Read now
- [[a:b00-01|Welcome]]
- [[a:b00-02|How to use this guide]]
- [[a:b00-04|Your first week]]

### Check yourself
Questions: c-l-m0-1-1, c-l-m0-1-2
@@end

@@lesson id=l-m0-2 module=m0 order=2 title="The Ten Golden Rules" minutes=3 tracks=FOUNDATION reading=b00-03,b03-06
### You will be able to
- Recite the ten rules and say why each exists.
- Name the three most common serious breaches.
- Say what counts as proof that a customer has paid.
- Apply a rule to a short situation.

### Key ideas
- **Protect your access (rules 1 and 8).** Rule 1: never share your password, one-time codes or session. Nobody legitimate asks for them, not even IT. Rule 8: never paste secrets such as API keys, tokens, passwords or card numbers into chat, email, tickets or screenshots.
- **Keep the two-person rule honest (rules 2, 3 and 9).** Rule 2: never approve something you cannot explain in one sentence. Rule 3: never approve your own work, and never help anyone get around the two-person rule. Rule 9: always write a real reason. "ok" is not a reason.
- **Trust the system, not the message (rules 4 and 5).** Rule 4: amounts come only from the system, never from a message, screenshot or call. Rule 5: a page saying "Paid" proves nothing, because screens and browser messages can be faked. Only a payment that our server has verified with the payment company counts. A screenshot with the right reference is still only a picture, and a phone call is only a claim.
- **Do not guess (rules 6 and 10).** Rule 6: `UNKNOWN` is a payment status that means we do not know whether money moved. Never guess: do not mark it failed, do not ask the customer to pay again, and use **Inquire** to ask the partner. Rule 10: when unsure, stop and escalate, which means you ask the right person for help.
- **Never tip off (rule 7).** Never reveal or hint that an anti-money-laundering review exists. Telling someone they are being investigated is called tipping-off, and it can be a crime.
- **Three breaches are the most common serious ones: rules 1, 6 and 7.** They are sharing credentials, guessing on `UNKNOWN`, and tipping off. Late reports, long reasons, slow approvals, your laptop or your language are not on this list.

### A worked example
Noon Mart calls Ali, the operator. Layla's payment of 25.500 LYD for a phone case is not showing, and Noon Mart wants to release the goods.
1. Layla sends Noon Mart a screenshot with "Payment successful" and the reference. Noon Mart forwards it to Ali.
2. Ali applies rule 5. He does not trust the screenshot. He looks the payment up in the platform by its reference.
3. The status says `UNKNOWN`. Rule 6 applies, so he does not mark it failed and does not ask Layla to pay again. He uses **Inquire** to ask the partner.
4. The partner confirms the payment. The status becomes `SUCCEEDED`, and only now does Ali tell Noon Mart that the payment is confirmed.
5. Noon Mart asks, "Is Layla under any review?" Ali answers nothing about it. That is rule 7.

Notice that Ali used only the platform's verified status, never a picture, a call or a guess.

### Common mistakes
- Learning the rules as slogans. Then you cannot apply them to a new situation.
- Believing a rule can be relaxed when someone senior is in a hurry. It cannot, so refuse politely and ask the proper person.
- Treating rule 10 as weakness. It is the rule that protects you, because being slow is acceptable and being wrong with other people's money is not.

### Read now
- [[a:b00-03|The Ten Golden Rules]]
- [[a:b03-06|Safe-working habits that prevent most mistakes]]

### Check yourself
Questions: c-l-m0-2-1, c-l-m0-2-2
@@end

@@lesson id=l-m0-3 module=m0 order=3 title="Reading a screen safely" minutes=3 tracks=FOUNDATION reading=b03-04,b03-06,b01-08
### You will be able to
- Check the environment badge, the merchant, the amount, the currency and the status before acting.
- Explain why two open tabs are dangerous.
- Say your action in one sentence before you click.
- Explain why you write the reason before you press the button.

### Key ideas
- **Read the SANDBOX or LIVE badge first.** The platform has two separate worlds. `SANDBOX` is a practice world where nothing real moves. `LIVE` is the real world with real money and real customers. Acting on live data while you believe it is practice, or the reverse, is a classic mistake. The colour theme and the screen language do not tell you which world you are in, so they are never the first check.
- **Read the whole row, not just one cell.** Check the merchant name, the amount, the currency, the status and the date. Amounts show three decimals for LYD, so never round in your head. Status chips use colour, but read the word.
- **Work one task at a time.** Most wrong-merchant and wrong-amount mistakes happen when two tabs are open. The platform does not forbid a second tab, and it does not slow the browser. The danger is that you mix up two screens that look the same.
- **Say the action in one sentence before you approve.** Use this shape: "I am approving X for merchant Y because Z." If you cannot say it, you do not understand the request yet.
- **Write the reason first.** If you cannot write a real reason, you are not ready to act.
- **Use the ? drawer and the safeguard checklist at the moment of risk.** The **?** button opens a side panel that explains the screen. A safeguard checklist is a short list of boxes that appears before a risky button. It exists to slow you down for ten seconds when mistakes happen.

### A worked example
Ali has two tabs open: a 25.500 LYD payment for Noon Mart and a refund request. He is about to approve the refund.
1. He closes the Noon Mart tab, because one task at a time is safer.
2. He reads the badge first: `LIVE`. He knows it is `LIVE` because he reads it now, not because he remembers the morning in sandbox.
3. He reads the whole row: merchant Al-Nour Bakery, 250.000 LYD, status as expected, original payment duplicated.
4. He writes the reason first and then says the sentence: "I am approving a 250.000 LYD refund to Al-Nour Bakery because the original payment was duplicated."
5. He opens the checklist, ticks only what he really checked, and only then presses **Approve**.

Notice that Ali checked the world, the row and his own words before the button, and never after it.

### Common mistakes
- Clicking the first row without reading the merchant. The refund can go to the wrong business.
- Assuming the badge is `SANDBOX` because you were in sandbox earlier. You may then change real money believing it is practice.
- Keeping two tabs open "to save time". This is how a wrong merchant or a wrong amount slips through.
- Leaving a half-finished decision at shift end. The next person does not know what you checked, so leave a handover note instead.

### Read now
- [[a:b03-04|Reading tables, filters, search and statuses safely]]
- [[a:b03-06|Safe-working habits that prevent most mistakes]]
- [[a:b01-08|Sandbox versus Live]]

### Check yourself
Questions: c-l-m0-3-1, c-l-m0-3-2
@@end

@@lesson id=l-m1-1 module=m1 order=1 title="From cash to electronic money" minutes=15 tracks=FOUNDATION reading=b01-01,b01-02
### You will be able to
- Explain in everyday words why handing over cash and sending electronic money are not the same event.
- Name the nine ways a customer can pay on this platform.
- Say why the platform must ask the partner what really happened instead of trusting the customer's phone.
- Explain what settlement is and why it comes days after a payment succeeds.

### Key ideas
- **Cash and electronic money work differently.** When you hand a baker a 10 LYD note, the payment is finished at once. With a wallet app, no paper moves. A trusted record-keeper lowers the customer's number and raises the shop's number. Cash is not forbidden. It simply has no middle party.
- **We must ask the record-keeper what really happened.** The customer's phone can show "Payment successful", but a message such as "I paid" is only a hint. Customers are not lying. Only the record-keeper knows the truth, so the platform asks it.
- **Success and settlement happen at different times.** When the partner clearly confirms, the platform checks the answer and records `SUCCEEDED`. The partner usually pays us in one batch some days later. This is settlement. Some partners pay the merchant directly instead.
- **The platform supports nine collection modes.** These are nine ways a customer can complete a payment, such as an SMS code (OTP), the payment company's own page, a QR code or a pay code. The Read-now article lists all nine. Each mode has its own traps. For example, a customer can approve after the time limit.
- **The customer never tells us the amount.** The amount comes from the payment link in our own database, not from the customer or the browser. Nobody can edit the page to pay 1 LYD for a 100 LYD order.
- **A timeout is not a failure.** If the partner goes silent, the money may or may not have moved. The attempt becomes `UNKNOWN`. The platform does not guess. It keeps the slot and keeps checking. If the partner cannot be asked, the answer comes from the settlement statement or an operator decision with evidence.

### A worked example
Layla buys a 100.000 LYD jacket from Noon Mart and pays with Sadad. The amount comes from Noon Mart's payment link, not from Layla's phone.
1. **At checkout:** Sadad confirms the charge. The platform does not take the "Paid" screen on trust. It verifies the answer itself, marks the attempt `SUCCEEDED` and writes it into our books: Noon Mart's balance on our system goes up and our commission is recorded. The real cash has not reached our bank account yet.
2. **Days later (settlement):** Sadad pays us in one batch and sends a statement, its own list of what it settled. We reconcile: we compare the statement with our records line by line. Layla's payment appears on both sides, so the two records agree.

Notice that the customer, the merchant and the platform each see a different part of the same story. Layla sees "Paid". Noon Mart sees its balance rise. The platform keeps a partner reference, a settlement line and a ledger entry, and they must agree.

### Common mistakes
- **Confusing a succeeded payment with settled cash.** `SUCCEEDED` means the platform verified the partner's answer. The cash often arrives days later, in a batch.
- **Trusting the customer's phone.** "I paid" or a return link is only a hint. Check our own records and ask the partner.
- **Assuming every payment method behaves alike.** A redirect, an SMS code and a QR scan fail in different ways.
- **Guessing after a timeout.** The answer is `UNKNOWN`, not "try again".

### Read now
- [[a:b01-01|What a payment really is]]
- [[a:b01-02|Ways people pay (the nine ways the platform supports)]]

### Check yourself
Questions: c-l-m1-1-1, c-l-m1-1-2
@@end

@@lesson id=l-m1-2 module=m1 order=2 title="Who is involved: switches, gateways and aggregators" minutes=15 tracks=FOUNDATION reading=b01-03,b02-06
### You will be able to
- Describe a switch, a gateway and an aggregator in one sentence each.
- Explain the difference between a direct route and an aggregator route.
- Name our first-party rail.
- Say which route a payment that is already running uses when its route fails.

### Key ideas
- **A switch is a shared network.** It connects many banks and wallets so they can pay each other. In Libya, Moamalat runs the national switch for cards. A **gateway** is one technical door to one payment company. An **aggregator** is a company that offers one door to many methods. DPay, Plutu and MyPay are aggregators. An aggregator is not a bank's vault and not the customer's wallet app.
- **Direct is shorter, aggregator is wider.** A direct route has fewer companies in the money path. An aggregator is faster to start because it needs one contract. But it adds one company, one more fee and one more thing that can fail.
- **A rail is what the customer picks.** The rail is the button the customer sees, such as Sadad. It is not the technical door. The **gateway** is the door. A **credential set** holds our secret identifiers and says where the money lands. A **route** links a rail to a gateway through a credential set. One rail can have several routes, for example a direct one and one through an aggregator.
- **NeomPay is our own first-party wallet platform.** The platform trusts it over mutual TLS. Both sides show a digital identity card before they talk.
- **A running payment keeps the route it started with.** The attempt records its settings when it starts. If a route keeps failing, an automatic safety switch called the circuit breaker stops new payments from using it, and only new payments move to the next healthy route.
- **Every extra company is another place for delay or failure.** An aggregator route adds one more such place.

### A worked example
Edfali can be reached directly or through an aggregator. Layla starts to pay Noon Mart 25.500 LYD with Edfali on the direct route. Then the direct Edfali door times out again and again.
1. After repeated partner faults, the circuit breaker (the automatic safety switch) opens. The direct route's health becomes `OPEN_BREAKER`.
2. Customers stop seeing the direct route. New Edfali payments use the aggregator route.
3. Layla's payment stays on the direct route, the one it started with. If Edfali stays silent, it may become `UNKNOWN`. The platform does not guess. It keeps checking.

Notice that the breaker changes where the next payments go. It does not move a payment that is already running.

### Common mistakes
- **Confusing the rail with the gateway.** The customer picks the rail. The gateway is the technical door behind it.
- **Assuming every gateway can be asked for a payment's status.** Some cannot. For those, the truth comes from the settlement statement or an operator decision with evidence.
- **Thinking a backup route fixes a running payment.** It only changes where new payments go.

### Read now
- [[a:b01-03|Switches, gateways and aggregators]]
- [[a:b02-06|The four layers]]

### Check yourself
Questions: c-l-m1-2-1, c-l-m1-2-2
@@end

@@lesson id=l-m1-3 module=m1 order=3 title="Libyan money and the 1000-times danger" minutes=20 tracks=FOUNDATION reading=b01-01,b06-04
### You will be able to
- State that 1 Libyan dinar equals 1000 dirhams.
- Explain how a wrong scale makes an amount 1000 times wrong.
- Read a worked rounding example.
- Know exactly what to do if a customer reports a 1000-times error.

### Key ideas
- **Libyan money has three decimals.** One LYD is 1000 dirhams, not 100 and not 10. So 10.500 LYD is ten dinars and five hundred dirhams.
- **Partners write amounts in different ways.** Some want `10.500`, some want `10.50`, and some want a whole number of dirhams: `10500`. The same money looks different on the wire.
- **A wrong scale is silent and huge.** Sending `10500` to a partner that expects `10.50` asks the customer for ten thousand five hundred dinars, not ten and a half. Sending `10.50` to a partner that expects dirhams charges ten dirhams, not ten dinars.
- **The platform stores exact decimals with four places.** It converts to the partner's format only at the last moment. The gateway's scale, precision, rounding and format settings control the conversion.
- **Before a gateway goes live, contract tests must pass.** For example, a dirham-integer gateway must turn `10.50 LYD` into `"10500"`. A two-decimal gateway with `NEAREST` rounding must turn `76.255` into `"76.26"`.
- **A 1000-times error is a priority-1 incident (P1).** Stop, do not retry, and tell the Gateway Admin and the Security Admin.

### A worked example
A link is for 76.255 LYD. The partner accepts two decimals.
- With `NEAREST` rounding, the partner receives `76.26`.
- With `DOWN` rounding, it receives `76.25`.
- With `UP` rounding, it receives `76.26`.

The wire amount can differ from our exact amount because of rounding. The route's mismatch policy handles the difference. It is not ignored.

### Common mistakes
- **Using ordinary calculator rounding.** It is not the same as the gateway's configured precision and rounding mode.
- **Retrying after a 1000-times error.** A retry can charge the customer again. Stop and treat it as an incident.
- **Waiting to see if it repeats.** A wrong scale is silent, so waiting only delays the report.
- **Assuming all partners use the same format.** The contract test exists because they do not.

### Read now
- [[a:b01-01|What a payment really is]]
- [[a:b06-04|Amounts]]

### Check yourself
Questions: c-l-m1-3-1, c-l-m1-3-2
@@end

@@lesson id=l-m1-4 module=m1 order=4 title="How computers talk" minutes=3 tracks=FOUNDATION reading=b01-06,b13-01
### You will be able to
- Describe a request and a response.
- Explain a webhook, polling and an inquiry.
- Explain why a timeout is dangerous.
- Read the first digit of a status code and say what it means.

### Key ideas
- **A server waits for requests and answers them. An API is the menu.** Think of a restaurant: our system is the waiter and the payment company is the kitchen. "One coffee for table 5" is a **request**. "Ok, coming" or "we have no coffee" is the **response**. The **API** lists which requests the kitchen accepts and which answers it gives.
- **A status code is a number in the answer, and its first digit tells the story.** `2xx` (for example `200`) means fine. `4xx` means you asked wrongly. `5xx` means the other side broke. `429` is a `4xx` code that means you are asking too fast.
- **A timeout is silence, and silence on a money step means we do not know.** Maybe the request never arrived. Maybe it arrived, the money moved, and only the reply was lost. From our side these two look identical. So the payment becomes `UNKNOWN`. It is not "failed" and it is not "succeeded", and we never retry it blindly.
- **A webhook is the partner calling us.** It is not a form that a customer fills in, and it is not a password. It is the kitchen phoning us when the order is ready. Anyone could phone us and pretend to be a partner, so the platform stores the webhook first, exactly as received. Only after that does it check the signature, the sender and the timestamp. Without those checks, a webhook proves nothing.
- **Polling asks again and again. An inquiry is one read-only question about one payment.** The inquiry is the safest way to learn the truth after silence, because it asks without changing anything.
- **An idempotent request has the same effect if you send it twice.** "Set the temperature to 20" is idempotent. "Add one degree" is not. A money request is not safe to repeat unless the partner guarantees it, and we never assume a partner does.

### A worked example
Layla pays 25.500 LYD for a phone case at Noon Mart. The platform asks Sadad to take the money.
1. The platform sends the request: "take 25.500 LYD from Layla's wallet".
2. The platform waits, but no reply comes. The request times out.
3. Maybe Sadad never received the request. Maybe Sadad took the 25.500 LYD and only the reply was lost. The platform cannot tell which is true.
4. The platform marks the payment `UNKNOWN`. It does not send the request a second time, because we cannot assume the partner treats a repeated "take 25.500 LYD" safely, and Layla could be charged twice.
5. The platform makes an inquiry: one read-only question about this one payment. It also stores any webhook that Sadad sends, exactly as received, and then checks its signature before believing it.

Notice that the platform never guessed. It waited until it could read the truth.

### Common mistakes
- Treating a `500` error on a money step as "failed". The other side broke, but the money may have moved, so the status is `UNKNOWN`.
- Believing a webhook without checking its signature. A forged webhook could claim "paid".
- Retrying a money request after a timeout. The customer may be charged twice.

### Read now
- [[a:b01-06|How computers talk]]
- [[a:b13-01|Codes and messages you may meet, and what they mean]]

### Check yourself
Questions: c-l-m1-4-1, c-l-m1-4-2
@@end

@@lesson id=l-m1-5 module=m1 order=5 title="Trust and secrets" minutes=3 tracks=FOUNDATION reading=b01-07,b11-01
### You will be able to
- Explain a password, MFA, a token, encryption, a hash and a signature in plain words.
- Say why secrets are write-only on this platform.
- Explain mutual TLS in one sentence.
- Say what a signature proves and what it does not prove.

### Key ideas
- **A password proves you know something. MFA adds a second proof.** MFA means multi-factor authentication. It is usually a six-digit code sent by SMS to the phone number on your account. Both are required for every admin. Never share the code.
- **A token or API key is a password for software.** It is a long secret string that lets a program prove who it is. Anyone who has it can act as that program. Ours start with `pg_live_` and are shown once.
- **Encryption locks data. A hash is a fingerprint.** Encryption means only someone with the key can read the data, and everything secret that we store is encrypted. A hash is a one-way fingerprint: the same data always gives the same fingerprint, a tiny change gives a completely different one, and you cannot go back from the fingerprint to the data.
- **A signature proves who sent a message and that nobody changed it.** Think of a wax seal. In the digital version both sides know a shared secret. The sender computes a seal over the message, and the receiver computes it again and compares. A signature does not hide the message. Encryption does that, which is a different job.
- **Secrets are write-only.** You can replace a stored secret but you can never read it back, not even as an administrator, not even after MFA. Logs do not reveal it either: stored secrets are encrypted and shown masked, and outbound call logs have secrets scrubbed.
- **Mutual TLS means both sides show a digital ID card.** A certificate is that ID card, issued by an authority we trust. On an ordinary website only the server shows its ID. In mutual TLS (mTLS) both sides show one. Our own services use it, so that only they can talk to the core.
- **Rotation changes a secret.** We rotate on a schedule or immediately after a leak. The system allows a short overlap where both secrets work, so nothing breaks.

### A worked example
Sadad sends a webhook that says Layla's payment of 25.500 LYD succeeded. The webhook carries a signature.
1. The platform stores the message exactly as it arrived.
2. It takes those exact characters and our shared secret, and computes the signature again.
3. Case A: the two signatures match. The message came from someone who knows the secret and was not changed on the way.
4. Case B: one character differs, for example upper-case instead of lower-case. The new signature is completely different, so the two do not match. The platform does not believe the message.
5. Later, a key leaks. Someone with the right authority rotates it at once. For a short overlap the old and the new key both work, so no payment stops.

Notice that nobody ever needed to read a secret. The platform compared seals and replaced a key.

### Common mistakes
- Pasting a secret into a chat "for a minute". Anyone who sees it can act as your program.
- Believing hidden or masked data can be revealed by asking nicely. Secrets are write-only for everyone.
- Mixing up a hash and encryption, or a signature and encryption. Only encryption locks content; a hash and a signature do not.

### Read now
- [[a:b01-07|Secrets and trust]]
- [[a:b11-01|How attackers think, and what protects us]]

### Check yourself
Questions: c-l-m1-5-1, c-l-m1-5-2
@@end

@@lesson id=l-m2-1 module=m2 order=1 title="The platform's parts" minutes=15 tracks=FOUNDATION reading=b02-01,b02-02,b02-03
### You will be able to
- Name the three audiences and the services that serve them.
- Explain why public services hold no database access or master key.
- Follow the life of a payment across the services in order.

### Key ideas
- **Three audiences, one engine.** Payers use the checkout website, merchants use the Merchant Portal and staff use the Back Office. All three reach the same engine, `core-back`. It holds the rules, the records and the connections to the payment companies.
- **Seven services are kept separate.** There are four server programs (`core-back`, `admin-back`, `merchant-back`, `checkout-back`) and three browser applications. A break-in at the public checkout cannot reach the database, the keys or the ledger.
- **Only the core holds database access and the master key.** The core is also the only service that posts to the ledger or calls payment companies. The checkout and the merchant portal hold none of these. They only pass requests on.
- **Our own services still prove who they are.** They use mutual TLS: both sides show a digital ID card. The core also re-checks every request, even from our own admin program. It checks the user, what the user may do and whether a maker is also the checker.
- **Success and the books move together.** When a payment becomes `SUCCEEDED`, the new state and the journal entry are written in one database transaction. Both happen together or neither happens.

### A worked example
Layla opens a 25.500 LYD payment link at an online shop and pays with Sadad.
1. Her browser talks to `checkout-back`. It sends the core only the link key, the method and what she typed. It never sends an amount. The core reads the amount from the link.
2. The core runs its safety checks, creates the payment attempt and reserves a slot on the link.
3. The core asks Sadad to text a code. Layla types it, and the core sends Sadad the confirm request.
4. The core checks Sadad's answer. Then, in one transaction, it writes `SUCCEEDED` and the journal entry.
5. Days later, Sadad pays us in one batch and sends a statement. We compare it with our records line by line.

Notice that only the core decides and records. The checkout only passes Layla's request on.

### Common mistakes
- **Thinking the admin program is trusted blindly.** The core re-checks even requests from our own admin service.
- **Thinking the checkout or merchant portal can decide or post money.** They hold no database password, no encryption key and no power to post money. The core decides.
- **Thinking the books are written later.** The ledger entry is not written the next morning or when the merchant asks. It is written in the same transaction as the success.

### Read now
- [[a:b02-01|The big picture]]
- [[a:b02-02|The seven services and why they are separated]]
- [[a:b02-03|The life of a payment, step by step]]

### Check yourself
Questions: c-l-m2-1-1, c-l-m2-1-2
@@end

@@lesson id=l-m2-2 module=m2 order=2 title="Merchants, applications, wallets and links" minutes=20 tracks=FOUNDATION reading=b01-04,b05-06,b05-07,b03-09
### You will be able to
- Explain the relationships between a merchant, an application, a wallet and a payment link.
- State why an application has exactly one wallet.
- Describe single-use and multi-use links and how a slot protects them.
- Explain why a link can narrow, but never widen, the application's payment methods.

### Key ideas
- **A merchant is a checked business.** It has users, wallets and applications.
- **An application is one place the merchant takes payments.** It might be a website, an app or a branch. Every application is assigned to **exactly one wallet**, so a payment can never be ambiguous about where the money goes. Many applications may share one wallet.
- **A wallet is a balance on our books.** It is a number we owe the merchant, not a bank account. It is **calculated** from ledger lines and is not a stored number that someone can edit.
- **Each wallet has its own page.** On **Wallets**, open a wallet to read its balance, its paged statement of ledger lines, the shards behind the balance and the history of its status. You can only read the numbers. The one change you may make is to freeze the wallet, and a second person must approve restoring it.
- **A payment link requests one fixed amount.** The merchant sets the amount and currency when the link is created. They are never taken from the customer. The link may narrow the application's list of payment methods, but it can never widen it.
- **A slot stops double payment.** A single-use link can be paid once. A multi-use link can be paid a set number of times, or without limit. An attempt reserves a slot before it starts. `confirmed_count` and `active_locked_count` together may never exceed the use limit.
- **API tokens start with `pg_live_` and are shown once.** The merchant sees the token only when it is created. We store only a fingerprint, so staff never see a token and must never ask for one. If a token leaks, the merchant revokes it in the portal and creates a new one.

### A worked example
Noon Mart has two applications, a website and a mobile app. Both are assigned to the same wallet, so they feed one balance.
- The website application allows Sadad and Edfali. A link made from it may allow only Sadad. It cannot add MobiCash, because a link can never widen the application's list.
- Noon Mart makes a single-use link for 25.500 LYD. Layla starts to pay, so her attempt reserves the only slot. A second customer who opens the link sees "Payment in progress".
- Now take a multi-use link with 3 uses. Two payments have succeeded and one is running. 2 + 1 = 3, so a fourth customer cannot start.

### Common mistakes
- **Thinking an application can pay into any wallet.** Each application has exactly one wallet, and that link is fixed.
- **Asking a merchant to read a token to you.** Staff cannot see a token, not even a masked one. Tell the merchant to revoke it and create a new one.
- **Assuming a link can add a payment method the application does not allow.** It can only narrow the list.
- **Trying to correct a wallet number that looks wrong.** The page only reads the ledger. If the shards differ from the live balance, tell Finance.

### Read now
- [[a:b01-04|Merchants, applications, wallets, payment links and POS]]
- [[a:b05-06|Applications and wallets]]
- [[a:b05-07|Payment links, POS terminals and API tokens]]
- [[a:b03-09|The Wallets screen and the wallet page]]

### Check yourself
Questions: c-l-m2-2-1, c-l-m2-2-2
@@end

@@lesson id=l-m2-3 module=m2 order=3 title="Roles, confidentiality zones and the double-check" minutes=20 tracks=FOUNDATION reading=b02-05,b03-02,b13-03
### You will be able to
- Name the seven staff roles.
- Explain what you may and may not see, and why confidentiality zones exist.
- Explain the Double-Check Rule in one sentence.
- Handle a request to look at data you are not allowed to see.

### Key ideas
- **Your role is a label for your job family.** The seven roles are `GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO` and `SUPPORT`. `SUPPORT` is read-only: it can look at merchants, history and payment status, but it has no money and no AML data.
- **Your authorities decide what you can really do.** An authority is a specific permission on your account. An account with no authorities can do nothing, so no authority means no access. Your account also has maker and checker switches, which decide whether you may propose or decide sensitive changes.
- **Some data is need-to-know.** AML means anti-money-laundering. AML screenings, matches, cases and reports are confidential. Only `COMPLIANCE`, `MLRO` and, for audit, `SECURITY_ADMIN` may see them. `SUPPORT` can see that a merchant is suspended, but never why.
- **The Double-Check Rule means the core does not trust anyone blindly.** The core is the part of the platform that makes every decision. It re-checks who the user is, what the user may do and whether a maker is also acting as the checker. It does this even for requests from our own admin program. It is not about clicking twice, and it is not about two screens showing the same data.
- **Merchants do not see our side of the table.** They never see gateway costs, our margin, screening results or risk tier.

### A worked example
Layla pays Noon Mart, and later Noon Mart is suspended. A support agent opens the merchant record.

1. The agent sees `SUSPENDED`. The agent does not see the reason, because `SUPPORT` has no AML data.
2. A Noon Mart owner calls and asks why. The reason may be confidential, so the agent says only that the account is restricted, that no further details can be given, and where the support address in the notice is.
3. The agent does not guess, does not hint and does not say that anyone is checking the account.
4. A colleague offers to share a login so the agent can look at the case. The agent refuses. The agent's own account has no authority for that data, so the agent has no access.
5. The agent tells the manager about the offer.

Notice two things. The agent sees the state but not the reason. The answer comes from the approved wording, not from the agent's own idea of what is safe.

### Common mistakes
- **Using a colleague's account because yours lacks a button.** No authority means no access, and borrowing an account does not change that. Tell your manager instead.
- **Discussing an AML matter with someone who has no need to know.** Telling someone that they are under review is called tipping-off. It is forbidden and can be a crime.
- **Thinking your role alone decides what you can do.** The role is only a label. Your authorities and your maker and checker switches are what count.
- **Thinking a bug or a hacked admin program can skip the checks.** The core re-checks every request, so it refuses a request that should not pass.

### Read now
- [[a:b02-05|Who can see and do what]]
- [[a:b03-02|Your account]]
- [[a:b13-03|Roles at a glance]]

### Check yourself
Questions: c-l-m2-3-1, c-l-m2-3-2
@@end

@@lesson id=l-m3-1 module=m3 order=1 title="The maker and checker rule" minutes=3 tracks=FOUNDATION reading=b04-01,b04-05
### You will be able to
- Explain why two people are required.
- State who may approve what, in typical cases.
- Explain why you never approve your own request.
- Say what pressing **Approve** really does.

### Key ideas
- **A maker proposes and a different person, the checker, decides.** This is the four-eyes principle. It applies to anything that moves money, changes who gets money, or changes how risky payments are handled. A "different person" means a different account, and waiting a day does not change that.
- **Two people give three benefits.** A second pair of eyes catches honest mistakes. Nobody can quietly steal or bend the rules alone. If something goes wrong later, it is clear who proposed, who approved and what they were told. So the rule protects you as much as the company.
- **The system enforces the rule three times.** The database refuses a request whose checker equals its maker. The approval service checks again in code. The API middleware checks a third time, whatever the screen sends. So self-approval is impossible by design.
- **Approving also executes the change.** Pressing **Approve** is not an opinion and it does not send the request back. The change happens in that step. So read first.
- **Asking a colleague to click Approve unseen is the same offence.** The system blocks your own account, but a colleague who clicks without reading makes the control fail even though the system allowed it.
- **Who approves depends on the action.** The table below shows typical cases. Your real ability to act as maker or checker also depends on the switches on your own account.

| Action | Typical maker | Required checker |
| :--- | :--- | :--- |
| Refund, chargeback, manual credit or debit | `FINANCE`, `OPERATOR` | A different `FINANCE` user |
| AML case resolution (release, void, freeze) | `COMPLIANCE` | `MLRO` |
| AML rule change | `COMPLIANCE`, `FINANCE` | `MLRO` |
| Velocity rule change | `COMPLIANCE`, `FINANCE` | `SECURITY_ADMIN` or `FINANCE` |
| Gateway version going live | `GATEWAY_ADMIN` | `SECURITY_ADMIN` |
| Staff role or authority change | `SECURITY_ADMIN` | A different `SECURITY_ADMIN` |

The `MLRO` is the Money Laundering Reporting Officer, the senior person who owns the final decisions on suspicious activity. AML means anti-money-laundering. A velocity rule limits how often or how much money may move within a time window.

### A worked example
Layla paid Noon Mart 25.500 LYD twice by mistake, and Noon Mart agrees the second payment must be refunded.
1. Huda, from finance, proposes a refund of 25.500 LYD with a reason.
2. Huda opens the request and tries to approve it herself. The system refuses, because the checker cannot be the maker.
3. Huda asks a colleague to "just click Approve". This is wrong, even if the system would allow it, because the colleague has not read the request.
4. Instead, another `FINANCE` user opens **Details**, compares the values and reads the reason. Then that person approves.
5. The approval executes the refund in the same step, and the record shows who proposed and who approved.

Notice that two different people each looked at the facts.

### Common mistakes
- Treating approval as a formality. The change is executed the moment you approve.
- Approving because the maker is senior or in a hurry.
- Asking a colleague for a blind approval to save time. It defeats the control and is the same offence as self-approval.
- Waiting a day and then approving your own request. The block is about who you are, not about time.

### Read now
- [[a:b04-01|Why two people]]
- [[a:b04-05|Who approves what]]

### Check yourself
Questions: c-l-m3-1-1, c-l-m3-1-2
@@end

@@lesson id=l-m3-2 module=m3 order=2 title="Descriptive versus sensitive, and the life of an approval" minutes=3 tracks=FOUNDATION reading=b04-02,b04-03
### You will be able to
- Tell a descriptive field from a sensitive one.
- Describe the states of an approval request.
- Say what happens when a request goes out of date.
- Say what the system shows while a request is still pending.

### Key ideas
- **Not every edit needs a second person.** The system splits fields into two classes. **Descriptive** fields are harmless to money and risk, for example a trade name, a display name or a logo. They are edited directly, and the change is still logged.
- **Sensitive fields need a maker and a checker.** A field is sensitive when it changes money flow, compliance or attack surface. Examples are the payout bank details, the tax ID, the risk tier and an application's assigned wallet.
- **An approval request shows what would change.** It holds who proposed, the old value and the new value (the diff), and the maker's reason. The checker reads the diff and the reason before deciding.
- **A request moves through states.** It starts as `DRAFT`. When the maker submits it, it becomes `PENDING_REVIEW`. If the checker approves, it becomes `APPROVED` and is then `EXECUTED` in the same step. If the checker rejects it with a written reason, it becomes `REJECTED` and the maker may draft again. The maker may also withdraw it before a checker acts.
- **A request lasts seven days, and it dies if the record changed.** After seven days a pending request returns to draft. If the record changed after the request was made, the request is out of date (stale). It is never applied, and the maker creates a new request from the current values. This stops an old request from silently overwriting a newer change. The checker must not approve it "to save time".
- **Until a request is executed, the current value stays in force.** A pending request has changed nothing. After approval, the change applies to new payments only. Payments already in progress keep the configuration they started with.

### A worked example
Noon Mart asks to change its payout bank account. This is a sensitive field, so it needs two people. The dates are an example.
1. On 1 November, Ali proposes the change as the maker. The request holds the old account, the new account and his reason.
2. The request is `PENDING_REVIEW`. Noon Mart is still paid into the old account, because the current value stays in force.
3. Omar opens **Review** and compares the two values. The new account is in a different person's name,. He rejects the request and writes why. The state is `REJECTED`.
4. On 2 November, Ali drafts a corrected request. Before any checker acts, another approved change edits the merchant record. Ali's request is now out of date. It cannot be approved, so Ali creates a new one from the current values.
5. If nobody decides on the new request, it returns to draft after seven days.

Notice that nothing changed in the real data until a checker approved, and an old request never overwrote a newer change.

### Common mistakes
- Approving without opening **Review**. You cannot judge a diff you have not read.
- Believing a pending request already changed the data. The current value is still in force.
- Approving a stale request to save time. It would overwrite newer data, so the maker must re-create it.
- Thinking a logo or display name needs approval, or that a risk-tier change can be made directly. The first is descriptive, the second is sensitive.

### Read now
- [[a:b04-02|Descriptive versus sensitive fields]]
- [[a:b04-03|The life of an approval request]]

### Check yourself
Questions: c-l-m3-2-1, c-l-m3-2-2
@@end

@@lesson id=l-m3-3 module=m3 order=3 title="Emergency actions and the asymmetry principle" minutes=3 tracks=FOUNDATION reading=b04-04,b09-06
### You will be able to
- State the asymmetry principle.
- Explain emergency suspension and ratification.
- List actions that reduce risk and actions that increase it.
- Say what happens if nobody ratifies a suspension in time.

### Key ideas
- **Actions that reduce risk may happen immediately and be approved afterwards. Actions that increase risk or move money always need approval first.** This is the asymmetry principle. It is uneven on purpose. Waiting can be the real danger when risk must go down, so we act first. When risk or money could go the wrong way, a mistake is hard to undo, so we ask first.
- **Three actions may be immediate:** suspending a merchant, tightening an AML (anti-money-laundering) or velocity rule, and pausing a route. A route is the path a payment takes to a partner. A velocity rule limits how often or how much money may move.
- **These actions need approval first:** reinstating a merchant, loosening a rule, releasing held money, paying a cash-out, and refunds or adjustments. Each one could let risk back in or send money out.
- **An emergency suspension must be ratified within 24 hours.** The system opens an approval request in "emergency ratification" mode. To ratify means to review the suspension and confirm it, or to revoke it. The reviewer is the `MLRO` (Money Laundering Reporting Officer) or a different `COMPLIANCE` user. The `COMPLIANCE` reviewer must be a different user.
- **If nobody ratifies in time, the suspension stays in force.** An alert fires, and the suspension is never reversed automatically. The system fails safe: the merchant stays restricted, not open. It does not lift by itself, and the merchant is not deleted.
- **Immediate does not mean casual.** A suspension stops a business from being paid. Use it when delay is the hazard, write the reason, and expect review.

### A worked example
A screening check returns a confirmed sanctions match on an active merchant. This is an example timeline.
1. On Monday at 10:00, Omar from compliance suspends the merchant by the emergency path. He writes a real reason. The 24-hour clock starts and ends on Tuesday at 10:00.
2. Cash-out is frozen, and held money stays held. The merchant sees only a generic message with no AML reason.
3. On Monday afternoon, a different `COMPLIANCE` colleague opens the request, checks Omar's reason and the evidence, and ratifies it.
4. Suppose nobody had done this by Tuesday at 10:00. An alert would fire. The merchant would stay suspended until a person decided.
5. Later, the case is cleared. To reinstate the merchant, a different `COMPLIANCE` user or the `MLRO` must approve first. Reinstatement is never an emergency action.

Notice the asymmetry. Suspending took one person. Reinstating needed a second person's approval before it happened.

### Common mistakes
- Using emergency suspension as a bargaining tool. It stops a business from being paid, so it needs a real reason.
- Thinking reinstatement can be an emergency action. It never can, because it increases risk.
- Thinking an unratified suspension lifts by itself. It stays in force and an alert fires.
- Paying a cash-out first and asking for approval later. Cash-outs move money, so approval comes first.

### Read now
- [[a:b04-04|Emergency actions, ratification and the asymmetry principle]]
- [[a:b09-06|Restricting a merchant]]

### Check yourself
Questions: c-l-m3-3-1, c-l-m3-3-2
@@end

@@lesson id=l-m3-4 module=m3 order=4 title="Reasons and safeguard checklists" minutes=3 tracks=FOUNDATION reading=b04-06,b03-06,b04-07
### You will be able to
- Write a reason that would survive an audit.
- Use a safeguard checklist at the moment of action.
- Know that everything you do is recorded and cannot be edited.
- Say what must never appear inside a reason.

### Key ideas
- **A good reason lets a stranger understand your decision months later.** Auditors, regulators, your successor and sometimes you will read it, and none of them was there. A good reason has four parts: what you checked, what you found, what you decided, and why.
- **"ok", "as discussed" and "as requested" are not reasons.** They say nothing about what you looked at.
- **Write the reason first, then act.** If you cannot write a real reason, you are not ready to act. Before approving, also say in one sentence what you are approving and why.
- **A safeguard checklist is a short list that appears before a risky button.** Tick only what you have really checked. The ticks are not recorded anywhere. They exist to slow you down for ten seconds at the moment when mistakes happen. The **?** drawer also lists them.
- **A reason must never contain secrets.** Do not write passwords, OTPs (one-time codes), full card numbers or national ID numbers. For AML (anti-money-laundering) matters, write nothing that a merchant could later read. The platform keeps AML notes confidential, but never write more than needed.
- **Every action is recorded, and the record cannot be edited.** The audit log keeps who did what, to which object, the state before and after, the linked approval request and the time. It is append-only, which means new lines can be added but old lines cannot be changed. Managers cannot edit it, and waiting a day does not change that. The change log (old and new value of each field) and the approval request add two more records. Your approval is not private.

### A worked example
Noon Mart asks to change its payout bank account, and Huda, a Finance user, is the checker.
1. Huda opens **Details** and compares the old and new account. She reads the maker's reason.
2. She opens the letter from the bank. The account holder matches the legal name. The old account was closed at the merchant's written request.
3. She writes the reason first. The weak version would be "approved per request". The strong version is: "Checked the bank letter: account holder matches the legal name; old account closed per merchant's written request; approving." It names what she checked, what she found, what she decided and why.
4. She says the sentence to herself, opens the checklist, and ticks only what she really checked.
5. She presses **Approve**. The audit log now holds her name, the before and after state and the time, and the approval request holds her reason. Nobody can edit the log later.

Notice two things. The strong reason holds no secret, and someone who was not in the room can read the whole story.

### Common mistakes
- Writing the reason after the click. You then explain a decision you have already made.
- Ticking boxes without checking. A checklist you do not read gives no protection.
- Writing a reason like "ok" or "as discussed". An auditor learns nothing from it.
- Believing an audit record can be fixed later. It cannot, so be careful before you act, and report an error at once.

### Read now
- [[a:b04-06|Writing a reason that survives an audit]]
- [[a:b03-06|Safe-working habits that prevent most mistakes]]
- [[a:b04-07|Audit trails]]

### Check yourself
Questions: c-l-m3-4-1, c-l-m3-4-2
@@end

@@lesson id=l-m4-1 module=m4 order=1 title="Merchant states and risk tiers" minutes=15 tracks=OPERATOR,SUPPORT,FINANCE reading=b05-01,b02-04
### You will be able to
- Name the five merchant lifecycle states and what each allows.
- Name the suspension reason codes.
- Explain risk tier and KYB status as separate ideas.
- Decide what happens to a payment that is already running when a merchant is suspended.

### Key ideas
- **A merchant is always in exactly one state.** The states are `PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED` and `CLOSED`. The state decides whether payments, cash-outs and API keys work. Only `ACTIVE` allows new live payments. A `PENDING` merchant may use the sandbox only.
- **`SUSPENDED` blocks new business but keeps the balance.** New payments and cash-outs are blocked. API keys return a generic error and POS screens show a neutral message. A payment that is still pending finishes on the configuration it started with.
- **Every suspension carries one reason code.** The only codes are `AML`, `FRAUD`, `KYB_EXPIRED`, `COMMISSION_CEILING`, `MERCHANT_REQUEST` and `OTHER`. AML means anti-money-laundering. The merchant gets a generic notice, and for an AML cause the notice gives no reason at all.
- **KYB status is not the lifecycle state.** KYB means Know Your Business: the checking of a business. The KYB statuses are `UNVERIFIED`, `PENDING`, `VERIFIED` and `REJECTED`. They are separate from the five merchant states.
- **Risk tier says how strictly rules apply.** The tiers are `LOW`, `STANDARD` and `HIGH`. A higher tier means lower hold thresholds, shorter review deadlines and more frequent KYB refreshes. Changing the tier is a sensitive edit and needs a second person.
- **`PENDING` is a merchant state. `PENDING_REVIEW` is an approval state.** They are different things on different screens.

### A worked example
Noon Mart is `ACTIVE`. Its registry certificate has an expiry date.

1. Thirty days before that date, and again seven days before, Noon Mart gets a notice.
2. The date passes. The document becomes `EXPIRED`. Noon Mart is still `ACTIVE`.
3. More than 30 days later the document is still expired, and two people have not extended it. The platform moves Noon Mart to `SUSPENDED` with reason `KYB_EXPIRED`.
4. New payments and cash-outs stop. The balance stays. A payment that Layla had already started, still pending, finishes on the configuration it started with.
5. To reinstate Noon Mart, a different `COMPLIANCE` or `MLRO` user must approve first.

Notice that expiry alone does not suspend the merchant. The suspension comes after the 30-day wait, and the balance is kept.

### Common mistakes
- **Closing a merchant that still has a balance.** Closing is refused while a balance remains or a dispute is open. To pause a merchant, suspend it.
- **Mixing up `PENDING` and `PENDING_REVIEW`.** One is a merchant state and the other is an approval state, so you will look on the wrong screen.
- **Using a reason code that is not on the list.** Only the six codes exist.
- **Treating KYB status as the merchant state.** Each has its own values, so a KYB value such as `VERIFIED` never answers what the merchant may do now.

### Read now
- [[a:b05-01|What a merchant is]]
- [[a:b02-04|The life of a merchant]]

### Check yourself
Questions: c-l-m4-1-1, c-l-m4-1-2
@@end

@@lesson id=l-m4-2 module=m4 order=2 title="Reviewing a join request" minutes=25 tracks=OPERATOR,COMPLIANCE,MLRO reading=b05-02,b05-03,b05-10
### You will be able to
- List the seven checks of a join request.
- Choose between requesting information, rejecting and approving.
- Say when a second reviewer is required.
- Handle a duplicate document or bank account without rejecting automatically.

### Key ideas
- **A reviewer completes seven checks, never fewer.** They are applicant identity, the business exists, beneficial owners, screening result, category and volume, payout account, and risk tier. Not three and not twelve: all seven must be completed.
- **Request information pauses the deadline.** Say exactly which document or fact is missing. The deadline is recomputed when the applicant answers. Never mention screening to the applicant. Naming the missing document is allowed and needed.
- **A rejection carries a reason code.** A code that could reveal a screening result is shown to the applicant as `POLICY`.
- **Four eyes are risk-based, and the system decides.** The default policy requires a second reviewer when any of these is true: high risk, a screening result that is not clear, a politically exposed owner, a high-risk category, high volume, a payout account mismatch or a previous rejection. A clean, low-risk case does not need one.
- **Approval is atomic.** The join request becomes `APPROVED`, the merchant becomes `ACTIVE`, KYB becomes `VERIFIED` and the risk tier is set, all in one step. If any part fails, nothing changes.
- **A duplicate is a signal, not a verdict.** A match on a document, owner, phone or bank account does not reject automatically. It adds a second reviewer, shows you the related records and raises the proposed tier by one level.

### A worked example
Ali, an operator, opens Noon Mart's join request.

1. The registry certificate, tax certificate and profile show the same legal name. Checks 1 and 2 are good.
2. Screening is `CLEAR`. Check 4 is good.
3. The bank letter names a different company. Check 6 fails, and a mismatch forces a second person to approve.
4. Ali asks for a corrected letter. He writes only: "The bank letter does not match the legal name." He does not mention screening.
5. The deadline pauses until Noon Mart answers. Then it is recomputed.

Notice that Ali names the exact problem and nothing else, and that the payout mismatch brings in a second reviewer without any decision from Ali.

### Common mistakes
- **Telling an applicant that a screening result was the reason.** This reveals confidential screening information, which is tipping off.
- **Approving to meet a deadline.** The seven checks come first, so a skipped check can put a bad business on the platform.
- **Treating a duplicate as an automatic rejection.** The system adds a second reviewer and shows the related records instead.
- **Showing a revealing reason code to a rejected applicant.** Show `POLICY` where a precise code could reveal a screening result.

### Read now
- [[a:b05-02|The onboarding journey and the join request state machine]]
- [[a:b05-03|Working the Join Requests queue, step by step]]
- [[a:b05-10|Re-application, duplicate detection and periodic KYB refresh]]

### Check yourself
Questions: c-l-m4-2-1, c-l-m4-2-2
@@end

@@lesson id=l-m4-3 module=m4 order=3 title="KYB documents and beneficial owners" minutes=20 tracks=OPERATOR,COMPLIANCE reading=b05-04,b05-05
### You will be able to
- Say what a beneficial owner is and state the default threshold.
- Describe the five checks the system makes on every uploaded document.
- Choose the right action for a duplicate file, an unreadable file and a screening result that is not `CLEAR`.
- Explain why an `ERROR` from screening blocks approval.

### Key ideas
- **A beneficial owner is a real person behind the business.** The system records anyone who holds 25% or more of the ownership or voting rights. It also records anyone who controls the business, such as a director, managing partner or authorised signatory. Every holder at or above 25% counts, not only the largest shareholder. An ordinary employee does not count.
- **The threshold is 25% by default.** It is set by the platform setting `aml.owner_threshold_percent`. A threshold of 5% would list too many people. A threshold of 75% would miss most real owners. If nobody reaches the threshold, the most senior manager is recorded as the controller and the reason is written down.
- **Every upload gets the same five checks.** The system checks type and size, scans for viruses, stores the file encrypted with a fingerprint and records the expiry date. It also raises a duplicate flag if an unrelated merchant uploaded the same file. A reviewer cannot open a file until the scan is clean. Statuses: a document is `UPLOADED` (received), `ACCEPTED`, `REJECTED` or `EXPIRED` (the expiry date passed); an owner is `NOT_SCREENED`, `CLEAR`, `POTENTIAL_MATCH` or `CONFIRMED_MATCH`.
- **A duplicate adds review. It does not accuse.** Add the finding to the notes, require a second reviewer and escalate to Compliance. Never tell the applicant that they are suspected, and never approve both merchants without looking.
- **If screening is not `CLEAR`, you do not approve and you do not discuss it.** A name that resembles a listed name may be a different person, so Compliance decides each match. Screening details are confidential. Tell the applicant only that the application is under review.
- **Screening that returns `ERROR` fails closed.** `ERROR` means the screening provider was unavailable. The request cannot be approved until screening succeeds. It is not approved, because that would skip a safety check. It is not rejected either, because nobody has found anything wrong.

### A worked example
Ali reviews the join request from Noon Mart. The owners hold 60%, 30% and 10%.
1. The first two owners are at or above 25%, so both are beneficial owners. The 10% owner is not, unless that person controls the business.
2. The commercial registry file passes the type check and the virus scan. The system raises a duplicate flag, because an unrelated merchant uploaded the same file.
3. Ali does not accuse anyone. He adds the finding to the notes, a second reviewer is required, and he escalates to Compliance.
4. A second document is blurred and Ali cannot read it, so he does not accept it.
5. Screening returns `POTENTIAL_MATCH` for one owner. Ali does not approve and does not discuss it. He writes "waiting for Compliance" in the notes. Omar in Compliance decides whether the match is real.

Notice that Ali never decides a match himself, and he never says the word "screening" to the applicant.

### Common mistakes
- **Accepting a document you cannot read, or that looks edited.** The business then rests on evidence nobody checked.
- **Copying documents to chat or e-mail.** The files contain identity data and must stay inside the platform.
- **Treating a duplicate flag as proof of fraud.** You may wrongly accuse an honest applicant.
- **Approving "with a note" when screening is not clear.** Only Compliance can decide a match, so the approval is not allowed.

### Read now
- [[a:b05-04|KYB documents and beneficial owners]]
- [[a:b05-05|Screening during onboarding]]

### Check yourself
Questions: c-l-m4-3-1, c-l-m4-3-2
@@end

@@lesson id=l-m4-4 module=m4 order=4 title="Merchant tools and helping merchants safely" minutes=20 tracks=OPERATOR,SUPPORT reading=b05-07,b05-08,b05-09
### You will be able to
- Explain what a payment link, a POS screen and an API token are.
- Tell a caller what to do when a token leaked or when a bank account must change.
- State what you may say to a merchant and what you must never say.
- Say who can suspend and who can reinstate a merchant, and when a merchant can be closed.

### Key ideas
- **A payment link asks for one fixed amount.** It has a key, which is the secret part of its web address. It also has an amount, a fee bearer (who pays our commission), a use limit and an optional expiry. The merchant sets the amount when the link is created. The customer never sets it.
- **A POS screen is a display for the shop counter.** It shows the payment to the customer and the cashier in real time. A screen idle for 15 minutes is disconnected. The limit is not 1 minute and it is not a week. The payment itself continues on the server. When the screen reconnects, it shows the current state.
- **An API token lets the merchant's software create payment links without a person.** A token is shown once, when it is created, and we store only a fingerprint. So support never sees a token value and must never ask for one. If a merchant says a token leaked, tell them to revoke it in their own portal and create a new one.
- **Identify the person before you discuss anything.** A phone caller is not proof of identity. Ask the merchant to raise the request in their own portal, where the system knows who they are. Chat is not the portal either.
- **Never reveal AML, screening, risk tier, gateway cost or our margin.** AML means anti-money-laundering. Even a hint that a review exists can be a crime, which is called tipping-off. Say only what the screen says. If you are unsure, say nothing and ask Compliance.
- **Suspension is fast, reinstatement is slow.** One authorised person can suspend at once, because delay is the hazard. A second person must ratify (confirm) the suspension within 24 hours. Reinstatement increases risk, so it needs prior approval by a different Compliance or MLRO user. It is never an emergency action. Closing a merchant is allowed only when the balance is zero and no dispute is open.

### A worked example
Ali takes a phone call from a man who says he owns Noon Mart. Ali asks him to raise every request in the Noon Mart portal, where the system knows who he is. The man then writes from the portal, so he is now identified.
1. The man asks Ali to change the payout bank account. Ali does not do it now. He says: "That change needs a written request in your portal and a second-person approval. It cannot be done by phone."
2. The identified man asks why the account is restricted. Ali says: "Your account is currently restricted. I cannot give further details. Please contact the support address in your notice." He does not say "Compliance flagged you".
3. The man adds that an API token leaked. Ali tells him to revoke it in his portal and create a new one. He does not ask him to send the token.

Notice that every answer sends the caller back to the portal or to a fixed sentence. You never improvise a reason.

### Common mistakes
- **Saying "compliance flagged you".** This is tipping-off, and it can be a crime.
- **Changing bank details after a phone request.** The caller may not be the owner, and the payouts could go to the wrong account.
- **Asking the merchant to read out or send a token.** Support must never see token values.
- **Treating reinstatement as urgent.** It always needs prior approval by a different Compliance or MLRO user.

### Read now
- [[a:b05-07|Payment links, POS terminals and API tokens]]
- [[a:b05-08|The Merchants screen]]
- [[a:b05-09|Helping a merchant safely]]

### Check yourself
Questions: c-l-m4-4-1, c-l-m4-4-2
@@end

@@lesson id=l-m5-1 module=m5 order=1 title="Reading a payment" minutes=20 tracks=OPERATOR,SUPPORT,FINANCE,COMPLIANCE,GATEWAY_ADMIN reading=b07-01
### You will be able to
- Tell our reference from the gateway reference, the provider reference and the network reference.
- Work out the total charged amount from the requested amount and the surcharge.
- Use the step log and the pinned configuration as evidence.
- Talk to a partner without exposing customer data.

### Key ideas
- **An attempt is one try to pay a link.** A link can have several attempts. For example, the customer tried twice, or a first try failed.
- **Four references name one payment for four parties.** Our reference is ours. We quote it to anyone, including partners. The gateway reference is the one we send to the partner as our identifier. The provider reference is the partner's own transaction number, so you use it to ask the partner about this payment. The network reference belongs to a third network, such as a card switch, and is for card disputes.
- **The total charged amount is the requested amount plus the surcharge.** The requested amount is the amount of the link. The surcharge is extra the payer pays when the fee bearer says so, and it is 0 otherwise. The settled amount is what the partner says it took.
- **Check the environment first.** `SANDBOX` is test and `LIVE` is real money.
- **Every attempt is pinned.** The gateway version, route, credential set and commission profile are fixed when the attempt starts. They never change for that attempt, even if a gateway is edited later.
- **The step log is the evidence.** Each call to the partner is recorded with the request (secrets removed), the answer, the HTTP status, the duration and the outcome. When something is unclear, read it.

### A worked example
Layla pays Noon Mart 25.500 LYD with Sadad. Sadad support asks which payment you mean.

1. You open the payment and check that the environment is `LIVE`.
2. You copy our reference. You quote it to Sadad, and you say nothing about Layla's name or phone number.
3. To ask Sadad about this payment, you use the provider reference, which is Sadad's own number.
4. Suppose the link carried a 0.500 LYD surcharge, as an example. The total charged amount is 25.500 + 0.500 = 26.000 LYD. The settled amount is whatever Sadad says it took, so you compare it with 26.000.
5. If the two sides disagree, you read the step log before you decide anything.

Notice that every number you give comes from a reference field, not from the customer.

### Common mistakes
- **Quoting a customer's name or phone number instead of a reference.** Names are not unique, and you expose customer data to the partner.
- **Assuming the requested amount is what the payer was asked to pay.** The total charged amount is the requested amount plus the surcharge.
- **Assuming a pinned configuration follows later edits.** It never changes for that attempt, so read it as a record of what that attempt used.
- **Editing a record to make it match.** The ledger is append-only; corrections are new approved entries.

### Read now
- [[a:b07-01|Reading a payment]]

### Check yourself
Questions: c-l-m5-1-1, c-l-m5-1-2
@@end

@@lesson id=l-m5-2 module=m5 order=2 title="The fourteen payment states" minutes=25 tracks=OPERATOR,SUPPORT,FINANCE reading=b07-02,b13-02
### You will be able to
- List the 14 payment states in their two groups.
- Say which states keep the link slot reserved and which release it.
- Say what a human should do in each kind of state.
- Explain why `UNKNOWN` is never turned into `FAILED`.

### Key ideas
- **Every payment attempt is in exactly one of 14 states.** Eleven describe progress: `CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, `VERIFYING`, `UNKNOWN`, `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED` and `BLOCKED`. Three describe what happened after success: `PARTIALLY_REFUNDED`, `REFUNDED` and `DISPUTED`. Eleven plus three is 14, so a count of 13 is wrong. The number 5 is also wrong for our states. Five is the number of statuses a partner can report back to us, which is a different list.
- **The link slot is a place reserved on the payment link for one payment.** It stops one invoice from being paid twice. Only `FAILED`, `EXPIRED`, `CANCELLED` and `BLOCKED` release it. `SUCCEEDED` and the three after-success states keep it as used. All other states keep it reserved.
- **`UNKNOWN` keeps the slot.** We do not know whether money moved, and the first payment might have succeeded. If the slot were released, a second payment could be a double charge. `FAILED` and `CANCELLED` are not like this. They are two of the four states that release the slot.
- **Movement is forward only, and uncertainty never becomes failure.** A timeout or an unreadable answer is `UNKNOWN`, never `FAILED`. A later event never changes `SUCCEEDED` back to a failure. If two trusted sources disagree, the attempt freezes in `UNKNOWN` and a priority-1 conflict case opens.
- **Success and its ledger entry happen together or not at all.** There is no `SUCCEEDED` without its journal entry. A partial refund moves a successful payment to `PARTIALLY_REFUNDED`, and `REFUNDED` follows when the whole payment is returned.
- **In most states a human does nothing.** In `UNKNOWN`, follow the UNKNOWN procedure. In `BLOCKED`, the customer sees only a generic message such as "cannot process this payment". Never explain the real reason, because it may be an AML (anti-money-laundering) rule or a watch-list.

### A worked example
Layla pays 25.500 LYD for a phone case at Noon Mart. The link is single-use.
1. The attempt is `CREATED` and then `INITIATING`. The slot is reserved. Layla's Sadad code is requested and the attempt waits in `AWAITING_CUSTOMER`.
2. Layla types the code. The attempt moves to `AUTHORIZING`, and the confirm request goes to Sadad.
3. The confirm request times out. The attempt moves to `UNKNOWN`, not `FAILED`. No money is posted.
4. A second person opens the same link. They see "Payment in progress", because `UNKNOWN` still holds the slot.
5. The next Sadad statement shows the payment. The attempt becomes `SUCCEEDED`, and the journal entry is written in the same transaction.
6. Later, part of the amount is returned. The state becomes `PARTIALLY_REFUNDED`.

Notice that the slot was reserved from step 1 to step 5 and that nobody had to guess.

### Common mistakes
- **Reading `EXPIRED` as proof that the customer did not pay.** `EXPIRED` releases the slot, but a late success can still arrive.
- **Marking an old `UNKNOWN` as failed.** The first payment may have succeeded, and the customer may be charged twice.
- **Explaining a `BLOCKED` payment to the customer.** The real reason is confidential.
- **Thinking that `PARTIALLY_REFUNDED` is a failure.** It is an after-success state, and the payment stays counted as used.

### Read now
- [[a:b07-02|The fourteen payment states, one by one]]
- [[a:b13-02|Every status in one place]]

### Check yourself
Questions: c-l-m5-2-1, c-l-m5-2-2
@@end

@@lesson id=l-m5-3 module=m5 order=3 title="UNKNOWN: exactly what to do" minutes=30 tracks=OPERATOR,SUPPORT,FINANCE,GATEWAY_ADMIN reading=b07-03,b07-09,b00-03
### You will be able to
- Explain why `UNKNOWN` exists.
- Follow the procedure in the correct order.
- Say when you may resolve an `UNKNOWN` payment by hand.
- List the four things you must never do.

### Key ideas
- **`UNKNOWN` means we asked a partner to take money and did not get a clear answer.** The partner is the payment company that moves the money. The request may never have arrived, or the money may have moved and the reply was lost. These cases look the same to us, so the platform records "we do not know".
- **While `UNKNOWN`, the platform holds and keeps watching.** The link slot stays reserved and no money is posted. The platform keeps asking the partner and listens for its webhook, a message the partner sends us. It also waits for the settlement statement, the partner's list of payments.
- **Guessing is dangerous in both directions.** If you say "failed" and the customer pays again, the customer may pay twice. If you say "succeeded" and the merchant ships, the merchant may lose the goods.
- **The procedure has a fixed order.** First, check the environment badge, because a `SANDBOX` case does not involve real money. Second, open the case in Operator Cases and read the step log. Third, press **Inquire** once. Fourth, if the partner has no status question, do not press again. Note the references. Wait for the next statement, or contact the partner's support with the provider reference and our reference. Fifth, resolve by hand only with evidence.
- **Inquire is the safe first action.** It is read-only and cannot move money. If the partner answers clearly, the platform resolves the attempt itself. Partners often need a minimum payment age, so press once and wait. "Not found" does not mean "failed". After an outage, run Bulk Inquiry only for the affected route and period.
- **Hand resolution needs partner evidence and a second person.** Evidence is a statement line or a written reply from the partner. Choose **Mark succeeded** or **Mark failed**, write a reason and use the checklist. If you have evidence the customer was not charged and the link must be freed, use **Release reservation**.
- **Four things are never allowed.** Never mark it failed because it is old. Never ask the customer to pay again. Never re-send an OTP (one-time code) or repeat the confirm, which may start a second payment. Never resolve from a screenshot or a call. The target is that 95% of `UNKNOWN` attempts are resolved within 24 hours.

### A worked example
Layla pays 25.500 LYD at Noon Mart, and the confirm step times out. In this example the partner offers no status question.
1. Ali sees `UNKNOWN`. The badge does not say `SANDBOX`.
2. He opens the case. The step log shows our confirm request and no answer.
3. He presses **Inquire** once. The screen says an inquiry is impossible.
4. He does not press again. He notes our reference and the provider reference. He tells Layla: "We are confirming your payment with your payment provider. Please do not pay again." He tells Noon Mart: "This payment is being confirmed with the payment company. It is not yet counted as paid."
5. The next statement has a 25.500 LYD line for Layla. With that evidence and a second person, Huda in Finance marks it succeeded and writes a reason.

Notice that nobody guessed and the final answer came from the partner.

### Common mistakes
- **Pressing Inquire repeatedly.** It does not help and may be rate-limited.
- **Telling the merchant the payment succeeded.** The merchant may ship unpaid goods.
- **Marking it failed because it is old.** The customer may then pay a second time.
- **Resolving from a screenshot or a call.** Neither is partner evidence. A customer's insistence is not partner evidence either.

### Read now
- [[a:b07-03|UNKNOWN]]
- [[a:b07-09|Inquiry]]
- [[a:b00-03|The Ten Golden Rules]]

### Check yourself
Questions: c-l-m5-3-1, c-l-m5-3-2
@@end

@@lesson id=l-m5-4 module=m5 order=4 title="Operator cases and inquiry" minutes=25 tracks=OPERATOR,FINANCE reading=b07-04,b07-09
### You will be able to
- Name the seven case kinds and say which one is always priority 1.
- Work cases in the right order by priority and deadline.
- Use Inquire and Bulk Inquiry correctly.
- Decide what to do when evidence is missing.

### Key ideas
- **An operator case is a task the system creates when a payment or a statement line needs a human.** Each case has a kind, a priority, a deadline and an owner. It moves from `OPEN` to `IN_PROGRESS`, then to `PENDING_CHECKER` (waiting for a second person), then to `RESOLVED`.
- **There are seven kinds.** `UNKNOWN`: an attempt is in `UNKNOWN`. `HELD`: money is held, for example by an AML (anti-money-laundering) rule. `CONFLICT`: two trusted sources disagree. `MISMATCH`: the partner's amount or currency differs from ours. `LATE_SUCCESS`: a confirmation arrived after the payment expired or failed. `MANUAL_REVIEW`: something needs a person's judgement. `UNMATCHED_STATEMENT`: a statement line matches none of our payments.
- **`CONFLICT` is priority 1 by definition.** Both sources are trusted, so neither wins, and nothing is posted. Do not resolve it alone. Escalate it. The other kinds, such as `MANUAL_REVIEW` and `UNMATCHED_STATEMENT`, are not priority 1 by definition.
- **Work the highest priority and the nearest deadline first.** Priorities are `P1` (highest), `P2` and `P3`. The deadline is called the SLA. Leave a handover note for any case still open at the end of your shift.
- **Assign the case to yourself first, then write what you did.** This stops two people from acting on the same case. Keep notes as you go. A resolution is a money decision.
- **An inquiry asks the partner for the true status.** It is read-only and cannot move money. Many partners need a minimum payment age, so press **Inquire** once and wait. Bulk Inquiry (the **Inquire selected** button) sends many calls to the partner. Use it for the affected route and period only, never for every route and never while the partner is down. You choose the filter. The customer does not.
- **If evidence is missing, leave the case open and escalate.** Leaving it open is safe. Guessing is not.

### A worked example
Sadad had an outage for two hours, for example from 10:00 to 12:00. Ali opens Operator Cases.
1. He sees many `UNKNOWN` cases, one `CONFLICT` case and one `MANUAL_REVIEW` case. He starts with the `P1` `CONFLICT` case.
2. He assigns it to himself. A webhook says Layla's 25.500 LYD payment is paid, but the inquiry says failed. Nothing is posted. He does not resolve it alone and escalates it.
3. When Sadad is working again, he opens the checklist and runs Bulk Inquiry for the Sadad route and the 10:00 to 12:00 window. He does not select other routes.
4. One case still has no evidence from the partner. He leaves it open, writes what he did and adds a handover note for the next shift.

Notice that Ali uses the smallest filter that covers the problem and never forces a resolution.

### Common mistakes
- **Bulk-inquiring every route "in case".** It sends many calls to the partner.
- **Resolving a conflict case alone.** A wrong choice can credit money that never arrived or lead to a second payment.
- **Working a case without assigning it.** Two people may act on the same item.
- **Closing a case without evidence.** A wrong "succeeded" or "failed" is a money error.

### Read now
- [[a:b07-04|The Operator Cases screen]]
- [[a:b07-09|Inquiry]]

### Check yourself
Questions: c-l-m5-4-1, c-l-m5-4-2
@@end

@@lesson id=l-m5-5 module=m5 order=5 title="Webhooks, expiry, slots and OTP" minutes=25 tracks=OPERATOR,GATEWAY_ADMIN reading=b07-05,b07-06,b07-07
### You will be able to
- Describe the steps that happen when a partner calls us with a webhook.
- Explain slot reservation, expiry and the grace window.
- State the OTP rules, including the default number of tries.
- Say where the money goes when a late confirmation arrives for a link that is already paid.

### Key ideas
- **A webhook is a message a partner sends us about a payment.** It arrives at a secret address that belongs to one gateway and one environment. The platform stores the raw message first, exactly as received, and answers the partner quickly. A background worker then checks the signature, the sender's IP address and the timestamp. Duplicates are ignored for seven days. An out-of-order message never downgrades `SUCCEEDED`.
- **Few webhook situations need you to act.** If a message arrives before the payment record is saved, the worker retries for about 60 seconds. A spike of messages about unknown references may be an attack or a partner mix-up, so tell the Security Admin. A sandbox webhook that arrives at the live address is rejected and raises an alert.
- **A slot is reserved before an attempt starts.** The slot is the place on the link for one payment. It stops one invoice from being paid twice. While it is reserved, another customer sees "Payment in progress". `UNKNOWN` keeps the slot.
- **An attempt expires at the smaller of two limits.** The limits are the partner's session time and the platform's ceiling for that mode. The platform then makes one last inquiry, if the partner can be asked, and moves the attempt to `EXPIRED`.
- **The grace window accepts late confirmations.** After expiry, the platform keeps listening for 24 hours by default. The window is unlimited for partners that cannot be asked. If the slot is still free, the attempt becomes `SUCCEEDED` and a priority-2 alert is raised. If another attempt already paid the single-use link, the money goes to the `SUSPENSE` account and a refund is drafted. The merchant wallet is wrong because it would credit the invoice twice. `TREASURY` is wrong because it is our own money, and this money does not belong to anyone yet.
- **OTP has strict rules.** OTP means one-time code, the code sent by SMS. The default is three tries, and the third wrong code fails the payment. Gateways can change this number. Resend has a cooldown and a cap. Wrong codes never trip the circuit breaker, because they are customer mistakes. A timeout during confirm is never a wrong code. It becomes `UNKNOWN`, and the same code is never submitted again.

### A worked example
Layla pays 25.500 LYD at Noon Mart with a push request on a single-use link. She is late.
1. The attempt reaches its time limit. The platform makes a last inquiry and then marks it `EXPIRED`. The slot is released.
2. Later Layla approves the push request on her phone. The partner sends a webhook.
3. The platform stores and checks it. The grace window is open and the slot is free.
4. The attempt becomes `SUCCEEDED`, the money is posted and a priority-2 alert is raised.
5. If another customer had paid the link in between, the same late confirmation would go to `SUSPENSE` and a refund would be drafted.

Notice that a late payment is neither lost nor credited twice.

### Common mistakes
- **Telling customers to keep pressing resend.** Resends are limited. Tell them to wait for the countdown, check the phone number and use resend once. The payment company's support handles SMS delivery.
- **Telling a customer to pay again when the code never arrives.** Paying again is not the fix for a missing SMS.
- **Treating an OTP timeout as a wrong code.** The code could be submitted twice and start a second payment.

### Read now
- [[a:b07-05|Webhooks and the inbox in operation]]
- [[a:b07-06|Slot reservation, single-use links, expiry and the grace window]]
- [[a:b07-07|OTP behaviour]]

### Check yourself
Questions: c-l-m5-5-1, c-l-m5-5-2
@@end

@@lesson id=l-m5-6 module=m5 order=6 title="Late success, conflicts, mismatches and the deducted-money call" minutes=30 tracks=OPERATOR,SUPPORT,FINANCE reading=b07-08,b07-12
### You will be able to
- Say what the platform does with a late success, a conflict and a mismatch.
- Follow the steps of the deducted-money call in order.
- Choose the right answer for each payment status on a customer call.
- Say what you must never promise.

### Key ideas
- **A late success is a confirmation that arrives after the payment was marked `EXPIRED` or `FAILED`.** The customer may have approved late or the partner may have been slow. If the link slot is free, the attempt becomes `SUCCEEDED` and the entry is posted. If the link was already paid, the money goes to the `SUSPENSE` account and a refund is drafted. `SUSPENSE` holds money that does not clearly belong to anyone yet. Finance processes the refund through the normal two-person route.
- **Conflicting trusted signals post nothing.** For example, a verified webhook says "paid" but our status question says "failed". Both sources are trusted, so neither wins. The attempt stays `UNKNOWN`, and a priority-1 `CONFLICT` case opens. Escalate it. Resolution needs evidence from the partner.
- **A mismatch is a success with a wrong amount or currency.** The route's mismatch policy decides. Within the tolerance, the payment is accepted. Beyond it, the money is held in `SUSPENSE` and a `MISMATCH` case opens. Compare the partner's statement line with the attempt: amount, currency, date. Do not credit or refund by hand. Propose an adjustment through Finance with a written reason.
- **In the deducted-money call, read the status, not the story.** Stay calm and do not blame. Ask for the payment reference, look it up, and check the environment and the status. Do not ask the customer to pay again. If the customer says money was deducted and the status is not `SUCCEEDED`, open or update an operator case with the reference and the time. Then say what happens next and when you will reply.
- **Each status has its own answer.** `SUCCEEDED`: "We confirm your payment. The merchant has been credited." Do not say "no record" and do not ask for a new payment. `AWAITING_CUSTOMER` or `VERIFYING`: it is in progress, do not pay again. `UNKNOWN`: we are confirming with the payment provider, do not pay again. `FAILED`, `EXPIRED` or `CANCELLED`: we have no confirmed payment, keep your receipt and reference, because a late confirmation may still arrive. `BLOCKED`: "We cannot process this payment", and nothing more. Not found: ask the customer to check the reference.
- **Never confirm from a screenshot, an SMS or a call, and never promise outcomes.** A "Paid" screen can be faked. You may promise only what you will check and when you will reply. Never promise a refund time or that the payment will succeed. Never refund "to be nice". Refunding a payment that succeeded later loses money. Crediting a payment that never arrived also loses money.

### A worked example
Layla phones platform support. She says 25.500 LYD left her Sadad wallet.
1. Ali says: "I will check this with your reference." He asks for the payment reference and does not ask for a password or code.
2. He looks it up. The status is `FAILED`.
3. He says: "We have no confirmed payment. If your provider shows a deduction, keep your receipt and your reference. A late confirmation may still arrive. If it does, we will credit the merchant or return the money."
4. He does not refund and does not ask Layla to pay again.
5. He opens a case with the reference and the time, and tells Layla when he will reply.

Notice that Ali answers from the status and promises nothing about money.

### Common mistakes
- **Refunding "to be nice".** If the payment succeeds later, we lose money.
- **Asking the customer to pay again.** The customer may pay twice.
- **Promising a refund time.** You do not control the outcome.

### Read now
- [[a:b07-08|Late success, conflicts and amount mismatches]]
- [[a:b07-12|Procedure]]

### Check yourself
Questions: c-l-m5-6-1, c-l-m5-6-2
@@end

@@lesson id=l-m6-1 module=m6 order=1 title="Double-entry bookkeeping from zero" minutes=25 tracks=OPERATOR,FINANCE reading=b08-01,b01-09
### You will be able to
- Explain debit and credit as directions, not as good and bad.
- State the four promises of the ledger.
- Read a simple journal entry and check that it balances.
- Explain why a wallet balance is calculated, not stored.

### Key ideas
- **Every movement is written on two sides.** In every journal entry the total debits equal the total credits. If the totals are not equal, the system refuses to save the entry. So debits never exceed credits, and credits never exceed debits.
- **Debit and credit are directions.** Think of the left column and the right column. They do not mean "money in" or "money out" on their own. For an account that holds things we have, such as cash, a debit increases the balance. For an account that records what we owe or earned, a credit increases it.
- **The ledger keeps four promises.** Entries are balanced. The ledger is append-only. Each event creates its entry exactly once. Wallet balances are not stored.
- **A mistake is fixed by a new entry.** Nobody edits a number or deletes a line. A correction is a new approved entry that offsets the old one.
- **A wallet balance is calculated from the lines.** That is why it cannot drift from the books. If a number on a screen looks wrong, stop and escalate. Do not change it.

### A worked example
Layla pays Noon Mart 100 LYD. Our commission is 3 LYD, so the merchant is credited 97 LYD.
- Debit `GATEWAY_CLEARING` 100 LYD: the partner owes us 100 LYD.
- Credit `MERCHANT_WALLET` 97 LYD: we now owe the merchant 97 LYD.
- Credit `PLATFORM_INCOME` 3 LYD: we earned our commission.

Check the totals. The debit is 100. The credits are 97 + 3 = 100. The entry balances.

Later the partner pays us. A second entry, the settlement sweep, moves the money from clearing to treasury. The merchant's wallet line is not touched, and the first entry is never changed.

Notice that one line sits on the debit side and two lines sit on the credit side, yet the totals are equal.

### Common mistakes
- **Trying to "balance" by editing a number.** Nobody edits a number, and nobody deletes a line. The fix is a new approved entry that offsets it.
- **Treating a debit as always "money in" or a credit as always "money out".** The meaning depends on the type of account.
- **Treating the wallet balance as a separate stored number.** It is calculated from the ledger lines, so it cannot drift from the books.

### Read now
- [[a:b08-01|Double-entry bookkeeping from zero]]
- [[a:b01-09|Why we write money down twice (a first look)]]

### Check yourself
Questions: c-l-m6-1-1, c-l-m6-1-2
@@end

@@lesson id=l-m6-2 module=m6 order=2 title="The eleven accounts and the equation" minutes=25 tracks=OPERATOR,FINANCE reading=b08-02,b08-05
### You will be able to
- Name the eleven GL (general ledger) accounts and sort them into groups.
- State the ledger equation in words.
- Say which money is ours and which money is only passing through.
- Say what you do when the drift is not zero.

### Key ideas
- **The platform has eleven kinds of GL account, in three groups.** An account is a named place in the books where amounts are recorded. Some older design documents list ten. The code has eleven, because `GATEWAY_FEE_EXPENSE` has its own account. Five is wrong.
- **Group 1: things we have.** `TREASURY` is our real money in our own bank and cash. `GATEWAY_CLEARING` is money a payment company has collected for us but not yet paid to us. `COMMISSION_RECEIVABLE` is commission we earned on payments that went straight to the merchant, which the merchant owes us. The last two are claims, not cash.
- **Group 2: things we owe or are still deciding.** `MERCHANT_WALLET` is what we owe a merchant. `AML_HOLD` is money held while Compliance decides. `CHARGEBACK_RESERVE` is money set aside while a dispute is open. `SUSPENSE` is money that arrived but does not clearly belong yet. `GATEWAY_FEE_ACCRUAL` is a payment company's fee we already know about but have not paid.
- **Group 3: earned and cost.** `PLATFORM_INCOME` is commission we have earned. `PROVIDER_FEE_EXPENSE` is a payment company's fee deducted straight from a payment. `GATEWAY_FEE_EXPENSE` is a payment company's fee recognised when the payment is confirmed.
- **Money in wallet, hold, reserve and suspense is not ours.** It is only on its way somewhere. `TREASURY` is our real money.
- **The ledger equation always holds.** In words: what we have equals what we owe plus what we earned minus what it cost us. Every entry is balanced, so this must always be true. A scheduled job recomputes it and reports the drift, which is the difference between the two sides. The expected drift is 0.0000 LYD. A small positive drift is not acceptable.
- **Any drift is a priority-1 incident.** Tell your manager and Finance at once. Automatic payouts stop until the cause is understood. Follow runbook RB-04. Never edit numbers to make it balance. Corrections are new approved adjustments.

### A worked example
This example uses invented numbers. Layla pays 25.500 LYD for a phone case at Noon Mart. Suppose the commission is 0.500 LYD.
1. Sadad has collected 25.500 LYD for us but has not paid it yet. `GATEWAY_CLEARING` holds 25.500 LYD, which is a claim we have.
2. Noon Mart's wallet is credited 25.000 LYD, which we owe. `PLATFORM_INCOME` shows 0.500 LYD, which we earned.
3. The two sides agree: 25.500 LYD equals 25.000 + 0.500 LYD. The drift is 0.0000 LYD.

Later the monitor shows a drift of 12.5000 LYD.
4. Ali treats it as priority 1 and tells his manager and Finance.
5. He does not cash out any merchant, because automatic payouts have stopped. He follows RB-04 and edits nothing.

Notice that the drift is never explained away, and the fix is always a new approved entry.

### Common mistakes
- **Cashing out manually while payouts are stopped.** You may move money that the books cannot support.
- **Editing a number to make the drift disappear.** The error stays hidden.
- **Waiting a week to see if the drift goes away.** Any drift is priority 1.
- **Counting `SUSPENSE` or `AML_HOLD` money as ours.** The money may belong to someone else after the decision.

### Read now
- [[a:b08-02|The eleven accounts]]
- [[a:b08-05|The ledger equation and what to do when it does not hold]]

### Check yourself
Questions: c-l-m6-2-1, c-l-m6-2-2
@@end

@@lesson id=l-m6-3 module=m6 order=3 title="Commission, fee bearers and rounding" minutes=20 tracks=FINANCE reading=b08-03
### You will be able to
- Distinguish commission (our revenue) from the gateway fee (our cost) and calculate net revenue.
- Calculate what the customer pays, what the merchant is credited and our net for each fee bearer.
- List the order in which the platform looks for a commission profile.
- Say what the customer sees when no profile covers a rail.

### Key ideas
- **Commission and gateway fee are two different amounts.** Commission is what we charge the merchant, so it is our revenue. The gateway fee is what the partner (the payment company that moves the money) charges us, so it is our cost. Commission is not a tip from the customer. Net revenue is commission minus gateway fee.
- **The fee bearer decides who pays the commission.** Every payment link has a fee bearer. With `MERCHANT_ABSORBS` (the default) the customer pays the link amount and the commission is taken out of the merchant's share. With `PAYER_SURCHARGE` the commission is added on top, so the customer pays more and the merchant gets the full link amount. With `SPLIT` 50/50 each side carries half. For surcharge and split, the checkout page must show the added fee before the customer confirms.
- **Our net does not change with the fee bearer.** The fee bearer only moves the commission between the customer and the merchant. Our commission is the same, and so is the gateway fee we pay.
- **The most specific live commission profile applies.** A commission profile says how to calculate the commission for a rail: a flat fee, a percentage, tiers by amount, or a mix, with a minimum and a maximum. The platform tries, in order: merchant + application + rail, then merchant + rail, then platform default + rail. Any other order, or a random choice, is not allowed.
- **No profile means the customer does not see the rail.** If no live profile covers a rail at that amount, the rail is hidden. It is not offered for free, and it is not shown with a warning.
- **Commission on held money is not income yet.** When compliance holds a payment, we do not count its commission as income until the hold is released.

### A worked example
Noon Mart creates a 100.000 LYD link (an example amount). The commission is 3.000 LYD and the partner's gateway fee is 0.800 LYD.
1. With `MERCHANT_ABSORBS`, Layla pays 100.000. Noon Mart is credited 100.000 − 3.000 = 97.000.
2. With `PAYER_SURCHARGE`, Layla pays 100.000 + 3.000 = 103.000. Noon Mart is credited the full 100.000.
3. With `SPLIT`, each side carries 1.500. Layla pays 101.500 and Noon Mart is credited 98.500.
4. In all three cases we earn 3.000 commission and pay 0.800 gateway fee. Our net is 3.000 − 0.800 = 2.200.

A second example uses a different link: 250.000 LYD with a 2% commission under `MERCHANT_ABSORBS`. The commission is 5.000, so the merchant is credited 245.000.

Notice that the customer's total and the merchant's credit change with the fee bearer, but our 2.200 net on the first link never does.

### Common mistakes
- **Mixing up commission and gateway fee.** Then net revenue is calculated from the wrong numbers.
- **Thinking the fee bearer changes our net.** The surcharge makes the customer pay more, but we earn the same commission and pay the same gateway fee.
- **Forgetting that no profile means the rail is hidden.** The customer cannot choose that rail at all.
- **Counting commission on held money as income.** Revenue is overstated until the hold is released.

### Read now
- [[a:b08-03|Commission, fee bearers and rounding, with worked numbers]]

### Check yourself
Questions: c-l-m6-3-1, c-l-m6-3-2
@@end

@@lesson id=l-m6-4 module=m6 order=4 title="How each payment is posted" minutes=25 tracks=FINANCE reading=b08-04,b08-12
### You will be able to
- Write the debit and credit lines of the main journal entries for a 100.000 LYD payment.
- Explain why a repeated webhook cannot credit a merchant twice.
- Explain where an AML-held payment is posted and why no commission is booked yet.

### Key ideas
- **Every success writes one balanced journal entry.** A journal entry lists debits and credits, and the two totals must be equal. The entry is written in the same database transaction as the `SUCCEEDED` state. Which entry we use depends on how the money travels.
- **Entry 1: the partner takes its fee at source.** The partner deducts its 1.000 fee before paying us. Debit `TREASURY` (our real money) 99.000 and `PROVIDER_FEE_EXPENSE` 1.000. Credit `MERCHANT_WALLET` (what we owe the merchant) 97.000 and `PLATFORM_INCOME` 3.000.
- **Entries 2 and 5: the partner holds the money and pays later.** The partner owes us the cash, so we debit `GATEWAY_CLEARING`, the balance the partner owes us. The partner's 0.800 fee is accrued, which means recorded now and paid later. Entry 5 is the same, but the payer surcharge makes the customer pay 103.000, and the merchant gets the full 100.000.
- **Entries 6 and 13: no clearing step.** In entry 6 the partner pays the merchant directly, so we hold no cash. We book only our commission as `COMMISSION_RECEIVABLE` against `PLATFORM_INCOME`; it is netted later. In entry 13, the first-party partner NeomPay, the money goes straight to `TREASURY`.
- **A unique pair stops double credits.** Each entry is tied to its payment by a pair: the type and the id. If a webhook is repeated, the database refuses the second entry. We do not rely on a person to notice, and webhooks do repeat.
- **An AML-held payment goes to `AML_HOLD`.** Entry 7 books the money there and recognises no commission. Only on release does the money move to the merchant and income.

### A worked example
Layla pays Noon Mart a 100.000 LYD link (an example amount). The commission is 3% and the partner's fee is 0.800. The partner will pay us later.
1. Entry 2 debits `GATEWAY_CLEARING` 100.000 and `GATEWAY_FEE_EXPENSE` 0.800. The debits total 100.800.
2. It credits `MERCHANT_WALLET` 97.000, `PLATFORM_INCOME` 3.000 and `GATEWAY_FEE_ACCRUAL` 0.800. The credits also total 100.800.
3. Later the statement arrives and the partner pays us the net 99.200. That settlement entry (entry 3) debits `TREASURY` 99.200 and `GATEWAY_FEE_ACCRUAL` 0.800, and credits `GATEWAY_CLEARING` 100.000. The partner paid the net amount.
4. Now take a different 100.000 LYD payment that an AML rule holds. Entry 7 debits `GATEWAY_CLEARING` 100.000 and credits `AML_HOLD` 100.000. `MERCHANT_WALLET` and `PLATFORM_INCOME` get nothing yet.
5. When the hold is released, `AML_HOLD` is debited 100.000. `MERCHANT_WALLET` is credited 97.000 and `PLATFORM_INCOME` 3.000.

Notice that the commission appears as income only at step 5, after release.

### Common mistakes
- **Posting commission on held money.** Income is overstated while the money may still be returned to the payer.
- **Crediting `MERCHANT_WALLET` or `PLATFORM_INCOME` for an AML-held payment.** The credit belongs in `AML_HOLD`, so this makes the merchant look paid too early.
- **Booking cash for a direct-to-merchant payment.** We never held that cash; only the commission receivable is ours.
- **Thinking duplicates need a manual check.** The unique pair already refuses a second entry, so a person is not the safeguard.

### Read now
- [[a:b08-04|How each kind of payment is posted]]
- [[a:b08-12|All fifteen worked journal entries (plus one)]]

### Check yourself
Questions: c-l-m6-4-1, c-l-m6-4-2
@@end

@@lesson id=l-m6-5 module=m6 order=5 title="Settlement and reconciliation" minutes=25 tracks=FINANCE reading=b08-06,b08-10,b10-05
### You will be able to
- Explain T+N and name the three settlement targets.
- Read the five reconciliation results and choose the action for each.
- Put the settlement cycle for platform clearing in order.
- Say what you do, and never do, when a statement does not match.

### Key ideas
- **A statement is the partner's record; reconciliation compares it to our books.** If the two differ, one of us is wrong and we must find out which. Dates need care: the statement may use Libya time while we store UTC. Convert deliberately with the source's time zone setting, because ignoring it creates false mismatches.
- **Each statement line gets one of five results.** `MATCHED`: both records agree. `AMOUNT_MISMATCH`: same payment, different amount, so check fee or rounding. `MISSING_LOCALLY`: the partner shows a payment we do not have, which may be a late success or an `UNKNOWN` we can now resolve. `DUPLICATE`: the same line twice, so check it and ignore the copy. `MISSING_AT_GATEWAY` is explained next.
- **`MISSING_AT_GATEWAY` is the most serious result.** We say a payment succeeded, but the partner shows nothing. We may have credited money we did not receive, so escalate it before any payout.
- **Money arrives later, and the target says who is paid.** T+N means the payment day plus N days, so T+2 is two days later. `PLATFORM_CLEARING`: the partner pays us. `MERCHANT_DIRECT`: the partner pays the merchant, and we book only our commission receivable. `PROVIDER_HELD`: the partner keeps the money for now, as the route's rules say.
- **Settlement has a fixed order.** First the payment is confirmed (clearing debited, wallet credited). Then the statement arrives. Then the settlement sweep moves money from clearing to treasury. Last, a fee true-up posts any difference between the real fee and the accrued fee.
- **A mismatch is solved by finding the cause, never by editing.** Never edit a statement file or a number to make it balance. Corrections are approved adjustments. If drift appears, automatic payouts stop and runbook RB-04 applies: treat it as P1, inspect each problem line, and resume payouts only when the drift is understood and zero and your manager agrees.

### A worked example
Layla pays a 100.000 LYD link (an example amount) at Noon Mart through a partner that settles at T+2. The partner's fee is 0.800.
1. Entry 2 debits clearing 100.000. It credits the wallet 97.000, income 3.000 and fee accrual 0.800.
2. Two days later the statement shows the line as 100.000 with a 0.800 fee, so the net is 99.200. The amount agrees with ours, so the result is `MATCHED`.
3. The settlement sweep debits treasury 99.200 and the fee accrual 0.800, and credits clearing 100.000.
4. On another payment the real fee is 0.900, not the accrued 0.800. The true-up debits fee expense 0.100 and credits the accrual 0.100.
5. Huda then finds a payment we marked succeeded that the statement does not show. It is `MISSING_AT_GATEWAY`. She escalates it and edits nothing.

Notice that every difference is handled by a posted entry (the sweep or the true-up) or an escalation, never by editing a file.

### Common mistakes
- **Ignoring time zones when comparing dates.** A payment near midnight can sit on different dates, and a false mismatch appears.
- **Editing the statement file or a ledger number.** The books then hide the real problem.
- **Ignoring lines that do not match.** An unresolved `MISSING_AT_GATEWAY` may be money we never received.
- **Treating `MISSING_AT_GATEWAY` like `MISSING_LOCALLY`.** The first means we may have credited money we did not receive; the second may only be a late success.

### Read now
- [[a:b08-06|Reconciliation]]
- [[a:b08-10|Settlement]]
- [[a:b10-05|RB-04 Reconciliation or ledger drift]]

### Check yourself
Questions: c-l-m6-5-1, c-l-m6-5-2
@@end

@@lesson id=l-m6-6 module=m6 order=6 title="Cash-outs and adjustments" minutes=25 tracks=FINANCE reading=b08-07,b08-08
### You will be able to
- Describe the cash-out states and who does what at each step.
- Name the merchants who cannot cash out and the bank account a cash-out is paid to.
- List the adjustment types and states.
- Correct a wrong adjustment, and refuse one that breaks the rules.

### Key ideas
- **A cash-out is a merchant's request to receive its wallet balance in a real bank account.** The wallet is only a number on our books. The states are `PENDING` (waiting for Finance), `PROCESSING` (Finance started), `COMPLETE` (the bank transfer is made), `SUBTRACTED` (the amount is taken off the wallet) and `REJECTED` (Finance refused).
- **Two different Finance people are needed.** One person processes the cash-out, makes the bank transfer outside the platform and marks it complete. A different Finance user approves and executes the final subtraction. The wallet is reduced only at that last step. The same person, or the merchant, never approves it.
- **The bank details snapshot is a copy taken when the request is made.** If the merchant changes its bank account later, the payout still goes to the snapshot, not the new account.
- **Some merchants cannot cash out.** A suspended merchant, a merchant with a negative balance and a merchant with unresolved AML (anti-money-laundering) matters must be refused. You do not pay half. Cash-outs also stop automatically when the ledger shows drift.
- **An adjustment is any money movement that is not an ordinary successful payment, and it always needs two people.** The types are `REFUND`, `CHARGEBACK`, `MANUAL_CREDIT`, `MANUAL_DEBIT`, `CORRECTION` and `CASHOUT_SUBTRACTION`. The states are `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `EXECUTING` and `EXECUTED`, or `REJECTED`.
- **An executed adjustment is never edited or deleted.** A wrong one is offset by a new one. The **Reverse** button proposes that offsetting adjustment, and it needs its own approval. A refund can never exceed the original payment, so check the amount and the currency first.

### A worked example
Noon Mart asks to cash out its wallet balance.
1. The request is `PENDING`. The platform saves a snapshot of Noon Mart's bank details.
2. The next day Noon Mart changes its bank account. Huda opens the request and still reads the old snapshot, so the payout goes there.
3. Huda checks that the account is verified, the merchant is `ACTIVE`, the balance is enough, and no negative balance or hold applies. She processes the cash-out, makes the bank transfer and marks it `COMPLETE`.
4. A different Finance user uses Approve and execute. The amount is taken off the wallet and the request becomes `SUBTRACTED`.
5. Separately, an executed refund for Layla's 25.500 LYD payment was for the wrong amount, for example 20.000 LYD. Nobody edits it. Huda uses Reverse with a written reason, and a different Finance user approves the offsetting adjustment.

Notice that the wallet balance changes only at the last approval, and no step edits an old record.

### Common mistakes
- **Splitting one adjustment into several to avoid review.** Four refunds of 500.000 LYD instead of one refund of 2000.000 LYD is forbidden, even if you document it. It is a way to avoid review, and it is never allowed.
- **Editing or deleting an executed adjustment.** The only correct fix is a new offsetting adjustment with its own approval.
- **Paying a merchant with a negative balance, even in part.** A negative balance blocks cash-out completely.
- **Paying to the merchant's new bank account.** The request keeps the snapshot it started with.

### Read now
- [[a:b08-07|Cash-outs]]
- [[a:b08-08|Adjustments]]

### Check yourself
Questions: c-l-m6-6-1, c-l-m6-6-2
@@end

@@lesson id=l-m6-7 module=m6 order=7 title="Disputes, chargebacks and negative balances" minutes=20 tracks=FINANCE reading=b08-09,b08-13
### You will be able to
- Describe how a dispute reaches us and its lifecycle.
- Explain who approves a chargeback and when money moves.
- Calculate a merchant's wallet after a chargeback and explain what happens if the balance is too low.
- Name what a negative balance blocks.

### Key ideas
- **A dispute (chargeback) means someone says a payment should be returned.** The payer, or the payer's bank or card scheme, makes the claim, and the money may be taken back from us. It reaches us by a verified partner message, a statement line flagged as a chargeback, or manual entry by Finance. It is unique per gateway and partner dispute reference, so a repeated message cannot create a second one.
- **A dispute follows a lifecycle.** It runs `OPENED`, `EVIDENCE_REQUESTED`, `EVIDENCE_SUBMITTED`, then ends as `WON`, `LOST`, `EXPIRED` or `WITHDRAWN`. If the evidence deadline passes with no evidence, it becomes `EXPIRED`, which is treated as lost unless the rail's rules say otherwise.
- **The system drafts the chargeback, but only a human approves it.** The system creates the adjustment in a waiting state. A human Finance checker must approve it. The system can never approve or execute, and the partner does not approve it either. Until a human approves, no money moves.
- **The money follows the outcome.** When approved, the wallet and income are reduced and the money goes to `CHARGEBACK_RESERVE`. If the dispute is lost, the reserve goes out to the payer or scheme. If it is won, the reserve returns to the merchant and income. On an AML-held payment the chargeback is handled against the hold, not the wallet.
- **A chargeback cannot push the wallet below the negative-balance ceiling.** For a new merchant the ceiling is zero. If posting would break it, the adjustment does not execute and it is not silently dropped. A P1 case opens, the merchant is told about the shortfall, and Finance chooses: collect the money (invoice), net it against pending cash-outs, or suspend the merchant.
- **A negative balance is recovered by netting and it blocks actions.** Each confirmed payment first reduces what the merchant owes. The merchant cannot cash out, and suspension release and closure are blocked until the balance is zero or an approved manual debit or correction writes it off.

### A worked example
Layla's 100.000 LYD payment (an example amount) at Noon Mart is disputed. The commission was 3.000, so the merchant's share was 97.000. The wallet holds only 40.000.
1. The dispute opens. The system drafts the chargeback. Nothing moves, and the wallet still shows 40.000.
2. A Finance checker approves. The wallet would fall to 40.000 − 97.000 = −57.000.
3. Noon Mart is new, so its ceiling is zero. The adjustment does not execute, and a P1 case opens.
4. Finance chooses to collect, net or suspend.
5. If the ceiling had been raised, by two-person approval, to at least 57.000, the adjustment would post and the wallet would show −57.000. Noon Mart could not cash out until later payments net the debt to zero.

Notice that a human decides every step that moves money, and the ceiling limits how negative the wallet can go.

### Common mistakes
- **Assuming the system approves chargebacks automatically.** A drafted chargeback waits for a human Finance checker, and no money moves before then.
- **Letting an evidence deadline pass.** The dispute becomes `EXPIRED`, which is treated as lost.
- **Expecting an over-ceiling chargeback to post anyway, or to disappear.** It stays unexecuted until Finance chooses an action.
- **Subtracting the whole payment from the wallet.** The wallet is reduced by the merchant share (97.000 here), not by the full 100.000.

### Read now
- [[a:b08-09|Disputes and chargebacks]]
- [[a:b08-13|Negative balances and ceilings]]

### Check yourself
Questions: c-l-m6-7-1, c-l-m6-7-2
@@end

@@lesson id=l-m7-1 module=m7 order=1 title="Anti-money-laundering from zero" minutes=20 tracks=FOUNDATION reading=b09-01,b01-10
### You will be able to
- Define money laundering and name its three stages in order.
- Explain why a fast payment platform is a target.
- List the main anti-money-laundering activities.
- Say who does what in AML, and why everyone is a sensor.

### Key ideas
- **Money laundering makes money from crime look legitimate.** Crimes such as fraud, theft, bribery and smuggling produce money that a criminal cannot spend openly without questions. Laundering hides where it came from. It is not moving money between our own accounts, and it is not a refund.
- **There are three stages: placement, layering, integration.** Placement puts the dirty money into the financial system, for example many small payments through a shop that does not really sell much. Layering moves it around so its origin is hard to follow, with many transfers, accounts and payment methods. Integration brings it back as apparently clean money, such as a "legitimate" business payout to a bank account. Words like "start, middle, end" or "buy, sell, hold" are not the stages. Promotion (advertising) and reconciliation (matching statements) are not laundering stages either.
- **A payment platform is attractive to criminals.** We are fast, we handle many small payments, we connect many payment methods and we pay out to bank accounts. A criminal who makes a fake shop receive payments and then cash out has laundered money through us.
- **AML (anti-money-laundering) is the set of rules and activities that detect and stop this.** It covers six activities. KYB (Know Your Business) checks that a business really exists and who owns it. Screening compares names against lists such as sanctions lists. Rules watch for suspicious patterns. Cases are where people investigate and decide. Reporting tells the authorities when the law requires. Record keeping proves what was done. A PEP is a politically exposed person. A PEP match gets extra review.
- **Everyone is a sensor; each role has a job.** If something looks wrong, you report it. Compliance analysts investigate and propose decisions. The MLRO (Money Laundering Reporting Officer) is the senior person who owns the final decisions and the contact with the authorities. The system screens, flags, holds and records, but it does not decide to accuse anyone.
- **Failing to run these controls has legal weight.** It can lead to fines, loss of our licence and personal liability.

### A worked example
This is an invented example of a fake shop.
1. A criminal opens a shop that sells almost nothing. Accomplices send 400 payments of 25.000 LYD each, 10000.000 LYD in total. This is placement: dirty money enters the system as small, normal-looking payments.
2. The money is moved through other accounts and payment methods so that nobody can follow it. This is layering.
3. The shop cashes out to a bank account as a "business payout". This is integration: the money now looks like sales.
4. Ali, an operator, sees that the volume looks nothing like what the shop declared. He does not accuse anyone. He reports the facts, so that Compliance can investigate.

Notice that no single payment was suspicious. Only the pattern, the fast cash-out and the declared business did not fit.

### Common mistakes
- **Thinking AML is only Compliance's problem.** Then nobody reports the odd pattern they saw first.
- **Waiting for proof before reporting.** You only need to report; Compliance and the MLRO decide.
- **Thinking the system decides who is guilty.** The system flags and holds; people decide.
- **Confusing laundering with moving money between our own accounts.** Then ordinary internal transfers are mistaken for crime, or the real pattern is missed.

### Read now
- [[a:b09-01|Anti-money-laundering from zero]]
- [[a:b01-10|Rules about risky money]]

### Check yourself
Questions: c-l-m7-1-1, c-l-m7-1-2
@@end

@@lesson id=l-m7-2 module=m7 order=2 title="The seven layers and the rules" minutes=25 tracks=COMPLIANCE,MLRO reading=b09-02,b09-04
### You will be able to
- Name the seven layers of the AML program and say which one runs on the payment path.
- Distinguish velocity rules from AML rules, and name the four AML actions.
- Pick the rule type that detects many payments just below a threshold.
- Explain how a rule change is controlled.

### Key ideas
- **The AML program has seven layers.** They are onboarding screening, ongoing screening, transaction-time checks, transaction monitoring, case management, regulatory reporting, and record keeping and governance. The first two check names when a business joins and later. The last three review, report and keep proof.
- **Only cheap local checks run on the payment path.** Payments have a strict speed budget. So the transaction-time check inside the start-of-payment guard uses quick local data, such as merchant status, risk tier and a local copy of the watch-list. Slower work, such as structuring checks, runs at or after confirmation and in a daily batch.
- **A velocity rule limits how often or how much; an AML rule looks for suspicious patterns.** A velocity rule can only `REJECT` (the attempt becomes `BLOCKED`) or `FLAG`. It never moves money. An AML rule can hold money or open cases.
- **There are four AML actions.** `HOLD` puts the money into `AML_HOLD` and opens a case. `FLAG` lets the payment go ahead and opens a review case. `BLOCK` blocks the attempt. `CASE_ONLY` opens a case and leaves the money untouched.
- **AML rule types detect different things.** `STRUCTURING` finds many payments just below a threshold. Splitting is an attempt to avoid the limit. `SINGLE_AMOUNT` is one large payment, and `CUMULATIVE_WINDOW` is a total or count in a rolling window. `RISK_TIER` uses a lower amount for riskier merchants. `RAIL` sets limits for one rail. A rail we cannot ask for payment status has a lower threshold, because we cannot easily verify its payments. `COUNTERPARTY_COUNTRY` and `MERCHANT_DIRECT_AMOUNT` cover cross-border cards and cases where we hold no cash.
- **Rules follow the subject, and changes need two people.** A subject is the merchant, the owner or the payer identifier, so splitting a sale across links does not avoid a rule. The MLRO approves AML rule changes. An emergency tightening may start at once and is ratified within 24 hours. Loosening never skips review. A dry run replays recent payments to show how many holds and cases a new rule would create.

### A worked example
The thresholds here are invented. Suppose the review threshold is 10000.000 LYD.
1. Over one day, one payer identifier sends nine payments of 9500.000 LYD to the same merchant, through three different links.
2. Each payment is below 10000.000, so a `SINGLE_AMOUNT` rule sees nothing.
3. Rules follow the subject, not the link. The payments add up to 9 × 9500.000 = 85500.000 LYD.
4. A `STRUCTURING` rule sees many payments just below the threshold. With the `HOLD` action, the money goes to `AML_HOLD` and a case opens.
5. Omar wants a quieter version of the rule. He proposes it, a dry run shows the holds it would have caused, and the MLRO must approve it before it starts.

Notice that the splitting did not work, and a looser rule cannot start without review.

### Common mistakes
- **Loosening a rule to reduce workload.** Real patterns may pass unseen, and loosening still needs review.
- **Believing only large single payments matter.** Many payments just below the limit are the structuring pattern.
- **Expecting a velocity rule to hold money.** It can only reject or flag.
- **Putting slow checks on the payment path.** The speed budget allows only cheap local checks there.

### Read now
- [[a:b09-02|The seven layers of the AML program]]
- [[a:b09-04|Rules]]

### Check yourself
Questions: c-l-m7-2-1, c-l-m7-2-2
@@end

@@lesson id=l-m7-3 module=m7 order=3 title="Screening and cases" minutes=30 tracks=COMPLIANCE,MLRO reading=b09-03,b09-05
### You will be able to
- Read the four screening results and decide a potential match with a written rationale.
- Describe the case lifecycle and the four ways a case ends.
- Say who approves a case resolution and when money moves.
- Give the default deadline for each severity and what makes a case `CRITICAL`.

### Key ideas
- **Screening compares names against official lists, and each result needs an action.** The results are `CLEAR` (no match), `POTENTIAL_MATCH` (a possible match, which a person must decide), `CONFIRMED_MATCH` (a real match) and `ERROR` (the provider is unavailable). If an `ERROR` happens at onboarding, the request cannot be approved until screening succeeds.
- **You decide each match on evidence, and you write the reason.** `FALSE_POSITIVE` means a different person. `TRUE_MATCH` means the match is real. `ESCALATED` refers it to the MLRO. Never ignore a match. Never mark it false because the merchant is important to management. You may suppress future matches, but you must set an expiry date. Suppression also ends if the person's identifying data changes.
- **A list update re-screens every active subject.** A new match on an active merchant opens a case and restricts cash-out at once. Payments continue unless the case is `CRITICAL`.
- **A case moves from maker to checker.** The path is `OPEN`, `IN_REVIEW`, `PENDING_CHECKER`, then `RELEASED`, `REJECTED_VOID`, `FROZEN` or `ESCALATED_STR`. A Compliance analyst (the maker) investigates and proposes. The MLRO (the checker, never the same person) approves. Only then does money move, and the posting is part of the same step. The system and the merchant never approve.
- **Each resolution has a money effect.** Release sends the held money to the merchant and income, and the commission becomes income at that moment. Void and return sends the money back to the payer, and no commission was ever recognised. Freeze changes only the case state; the money stays in `AML_HOLD`. Escalate to STR creates a draft suspicious-activity report (STR). A chargeback on a held payment goes against the hold, not the wallet.
- **Severity sets the deadline.** The defaults are `CRITICAL` 4 hours, `HIGH` 1 business day, `MEDIUM` 3 business days and `LOW` 5 business days. A velocity flag plus an AML rule hit on the same payment, or a sanctions `CONFIRMED_MATCH`, makes a case `CRITICAL`.

### A worked example
Omar in Compliance gets a `POTENTIAL_MATCH`: an applicant's owner has the same name as a listed person.
1. Omar compares date of birth, nationality and ID number. All three differ.
2. He chooses `FALSE_POSITIVE` and writes the rationale: what he compared and why they are different people.
3. He sets `suppress_future` with an expiry date, so the same pair does not reopen at every periodic screening. He does not tell the applicant.
4. Another case holds a 100.000 LYD payment with 3.000 LYD commission. Omar proposes a release.
5. Nothing moves yet. The MLRO approves. Only then does the merchant wallet receive 97.000 and income receive 3.000.
6. If a case were `CRITICAL` at 10:00, the default deadline would be 14:00 the same day.

Notice that each decision is written down with evidence, and money moves only after a second person approves.

### Common mistakes
- **Marking a match false because the merchant is important.** Importance is irrelevant, and a real sanctions match could be missed.
- **Releasing held money on the analyst's say-so.** The maker proposes and only the MLRO's approval moves money.
- **Suppressing a match without an expiry date.** The match stays hidden with no date to look at it again.
- **Approving an applicant after a screening `ERROR`.** The system fails closed, so approval waits until screening succeeds.

### Read now
- [[a:b09-03|Screening]]
- [[a:b09-05|Cases]]

### Check yourself
Questions: c-l-m7-3-1, c-l-m7-3-2
@@end

@@lesson id=l-m7-4 module=m7 order=4 title="Restricting merchants and regulatory reporting" minutes=25 tracks=COMPLIANCE,MLRO reading=b09-06,b09-07
### You will be able to
- Explain emergency suspension, its 24-hour ratification and what happens if nobody ratifies.
- Say what a confirmed sanctions match or a new list match does to a merchant.
- Describe the report types and the report lifecycle.
- Explain why a provisional reporting rule can never file.

### Key ideas
- **Emergency suspension is for cases where delay is the danger.** One authorised person suspends at once. The system opens an approval request with a 24-hour clock. A different person from `COMPLIANCE`, or the `MLRO`, must ratify (confirm) or revoke it in that time. If nobody does, a priority-2 alert fires and the suspension stays in force. It is never reversed automatically. This is fail safe: restricted, not open.
- **Screening outcomes decide how a merchant is restricted.** A sanctions `CONFIRMED_MATCH` means emergency suspension, frozen cash-out, held money staying in hold and a suspicious-activity report draft. Nothing more happens until the MLRO decides. Taking no action, or sending a friendly explanation, is wrong. A new match after a list update opens a case and restricts cash-out at once, and payments continue unless the case is `CRITICAL`.
- **Reinstating a restricted merchant is never an emergency action.** It increases risk, so it needs prior approval from a different `COMPLIANCE` or `MLRO` user.
- **A reporting rule is data, and it is `PROVISIONAL` or `CONFIRMED`.** It says when a report is triggered and cites its source. A `PROVISIONAL` rule can never produce a live filing, and the database refuses it. Until the Central Bank's thresholds, formats, deadlines and receiving channel are confirmed in writing, the platform is in internal-only mode. It can detect, hold and record, but it cannot file. It does not stop all payments.
- **There are three report types.** `LARGE_TRANSACTION` comes from a rule and can be drafted automatically. `SUSPICIOUS_ACTIVITY` comes from a case and is always reviewed by a person. `PERIODIC_RETURN` comes from a schedule.
- **A report has a lifecycle, and a saved report is read-only.** It runs `DRAFT`, `PENDING_CHECKER`, `APPROVED` (content frozen), `SUBMITTED`, then `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY`. `COMPLIANCE` proposes and the `MLRO` approves. A correction is a new linked report. The existence of a report is never disclosed to the subject.

### A worked example
A list update gives a `POTENTIAL_MATCH` on an active merchant.
1. Omar decides it is a real sanctions match, so the result is `CONFIRMED_MATCH`. An authorised person suspends the merchant at once, at 09:00 on Monday. The 24-hour clock ends at 09:00 on Tuesday.
2. Cash-out is frozen. Any held money stays in hold. A suspicious-activity report draft is created. The merchant sees only a generic message, with no reason.
3. Before Tuesday 09:00, a different Compliance person ratifies the suspension. Had nobody done so, a priority-2 alert would fire and the merchant would stay suspended.
4. Omar proposes the report and the MLRO approves it. The content is now frozen. While the Central Bank's requirements are unconfirmed, it cannot be filed, because the platform is in internal-only mode.
5. Separately, imagine a report that was already submitted and needs a correction. Omar creates a new linked report.

Notice that every safety default keeps the merchant restricted, and no step tells the merchant why.

### Common mistakes
- **Filing from a provisional rule, even after a delay or with approval.** The database refuses it. Rules stay `PROVISIONAL` until the requirements are confirmed in writing.
- **Treating a missed ratification as a lifted suspension.** The suspension stays in force and only an alert fires.
- **Reinstating a merchant as an emergency.** Reinstating raises risk, so it needs prior approval.
- **Editing or deleting a saved report to correct it.** Saved reports are read-only; a new linked report is the correction.

### Read now
- [[a:b09-06|Restricting a merchant]]
- [[a:b09-07|Regulatory reporting]]

### Check yourself
Questions: c-l-m7-4-1, c-l-m7-4-2
@@end

@@lesson id=l-m7-5 module=m7 order=5 title="Confidentiality, tipping-off and reporting suspicion" minutes=25 tracks=FOUNDATION reading=b09-08,b09-10
### You will be able to
- Define tipping-off.
- Say exactly what you may tell a merchant or customer, and which words you must never use.
- Name who may see AML-confidential data.
- Report suspicion correctly, and refuse pressure to skip a control.

### Key ideas
- **Tipping-off is telling someone, directly or by hint, that they are or may be under suspicion, or that a report exists about them.** It is forbidden. It can be a crime and can ruin an investigation.
- **AML data is confidential.** This covers screenings, matches, cases, rule hits that opened cases, reports and AML suspension reasons. Only `COMPLIANCE`, `MLRO` and, for audit, `SECURITY_ADMIN` may see it. `SUPPORT` can see that a merchant is suspended, never why. Every read of an AML case is logged.
- **Use only the approved wording.** For a restricted merchant: "Your account is currently restricted. Please contact the support address in your notice." For a blocked payment: "We cannot process this payment." For an application, ask only for the specific documents or details needed. Where a precise rejection code could reveal a screening result, show the neutral code `POLICY`. Never show a code that names screening or sanctions.
- **Never use risky words, hints or invented reasons.** Never say "compliance", "investigation", "screening", "sanctions", "suspicious" or "report" to a merchant or customer in connection with them. Never hint, for example "we need to double-check you for security reasons", when the true reason is AML. Never put AML information in a merchant-visible note, message, e-mail or ticket, or in chat or personal notes. Never discuss it with colleagues who do not need to know.
- **If someone asks "am I under investigation?", give only the generic wording.** Do not say yes, do not say no, and do not say "I cannot tell you because...". Then tell your manager and Compliance. This rule outranks helpfulness: being unhelpful to a customer is acceptable, and tipping off is not. Merchant notification templates cannot contain AML variables, and this is checked at saving.
- **If you notice something suspicious, report it. You do not need to be sure.** Do not confront the person. Write down the facts. Tell Compliance the same day, or your manager if you cannot reach Compliance. Keep it secret and continue as normal.

### A worked example
Ali's screen shows that a merchant is suspended, but not why.
1. The merchant phones and asks, "Is my account restricted because of compliance?"
2. Ali says only: "Your account is currently restricted. Please contact the support address in your notice." He does not say yes, no or "it is a technical issue".
3. He puts nothing about AML in the ticket. He tells his manager and Omar in Compliance.
4. Layla's 25.500 LYD payment is blocked and she asks why. Ali says only: "We cannot process this payment."
5. Another day, Ali sees a merchant ask several times to move its payout to an account in another person's name. He does not warn the merchant. He writes the merchant name, references, dates and what was said. He tells Omar the same day, nobody else, and treats the merchant as normal.

Notice that Ali never confirms, denies or explains. He reports only to Compliance.

### Common mistakes
- **Hinting "it is for security reasons" when the true reason is AML.** A hint is still tipping-off.
- **Warning the merchant, or discussing it in team chat.** This can ruin an investigation.
- **Using words such as "investigation" or "sanctions" with a merchant.** They reveal the reason.
- **Approving a colleague's request unread because they asked.** Refuse, and report it to Compliance or your manager.

### Read now
- [[a:b09-08|Confidentiality and tipping-off]]
- [[a:b09-10|If you notice something suspicious]]

### Check yourself
Questions: c-l-m7-5-1, c-l-m7-5-2
@@end

@@lesson id=l-m8-1 module=m8 order=1 title="Gateways, rails, routes and versions" minutes=25 tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN reading=b06-01,b06-11,b02-06
### You will be able to
- Describe the four layers (Gateway, Credential Set, Rail, Route) and say which one the customer sees.
- Name the four gateway kinds and the risk class that needs an executive signature.
- Explain what happens to a payment that is already running when a new version goes live.
- Name the route statuses and health values, and say what `DRAINING` does.

### Key ideas
- **Four layers keep changes small.** Think of a restaurant with several card terminals. The **Gateway** is one terminal and its manual: one technical door to one partner. The **Credential Set** is whose account and key card sits in that terminal. The **Rail** is the sign the customer picks, such as "Mobile wallet". The **Route** is the rule that links a rail to a gateway. Because they are separate, one can change without touching the others.
- **A gateway has one of four kinds.** `DIRECT` means we connect to the payment company itself (Moamalat, Sadad). `AGGREGATOR` means one company offers many methods through one door (DPay, Plutu, MyPay). `NATIVE_ADAPTER` is a built-in adapter for something that does not fit the normal model, and it is rare. `INTERNAL` is a first-party system we operate ourselves (NeomPay). Only these four kinds exist, so a word such as `SANDBOX` is not a kind.
- **A gateway with no way to check payments is `HIGH_RISK`.** The risk class is `NORMAL` or `HIGH_RISK`. It is `HIGH_RISK` when a gateway offers neither a signed webhook nor a status question. Going live with it needs a signed executive risk acceptance.
- **A live version is never edited.** All the settings of a gateway are stored as a version, which is a sealed snapshot. Nobody can change it in place, not even a Gateway Admin and not even in the wizard. Editing creates a new `DRAFT`. The stages are `DRAFT`, `SANDBOX_VERIFIED` (passed the sandbox tests), `PENDING_APPROVAL` (waits for a `SECURITY_ADMIN`), `LIVE`, `SUPERSEDED` (replaced) and `ROLLED_BACK` (withdrawn).
- **Promotion affects new payments only.** Each payment attempt remembers the version it started on and finishes there. So configuration can change while money is moving.
- **A route has a status and a health value.** Status is what staff choose: `ACTIVE`, `PAUSED` or `DRAINING`. Health is what the platform measures: `HEALTHY`, `DEGRADED` or `OPEN_BREAKER`. A `DRAINING` route finishes the payments it is running and takes no new ones.

### A worked example
Layla pays 25.500 LYD at Noon Mart. She picks the Sadad rail, and a route sends the payment to the `sadad` gateway.
1. At 11:59 her payment starts. The attempt records the live version, for example version 4.
2. Earlier, a Gateway Admin needed to change a setting. The live version 4 could not be edited, so the change became a new draft, version 5.
3. Version 5 passed the sandbox tests (`SANDBOX_VERIFIED`) and a `SECURITY_ADMIN` approved it (`PENDING_APPROVAL`). At noon it was promoted to `LIVE`, and version 4 became `SUPERSEDED`.
4. Layla's payment finishes on version 4. Her next payment, at 12:01, starts on version 5.
5. Later, staff set the Sadad route to `DRAINING` before maintenance. Payments in progress finish, and new customers no longer get that route.

Notice that nobody edited anything live, and no running payment changed its rules halfway.

### Common mistakes
- **Trying to edit a live gateway in place.** It is not possible. Every edit becomes a new draft that must be verified and approved first.
- **Deleting a rail that was ever used.** Used rails are never deleted, because the payment history must remain readable. Use the **blocked** switch instead. Renaming is not the rule either.
- **Thinking promotion moves running payments.** It does not. Only new payments use the new version.

### Read now
- [[a:b06-01|Gateways in depth]]
- [[a:b06-11|Rails and Routes]]
- [[a:b02-06|The four layers]]

### Check yourself
Questions: c-l-m8-1-1, c-l-m8-1-2
@@end

@@lesson id=l-m8-2 module=m8 order=2 title="Collection modes and confirmation channels" minutes=25 tracks=OPERATOR,GATEWAY_ADMIN reading=b06-02,b06-07
### You will be able to
- Describe the main trap of the OTP, redirect, embedded, push and QR modes.
- Rank confirmation channels from strong to hint-only.
- List the five facts the platform checks before it believes a confirmation.
- Explain the weak-channel rule and what the wizard does about it.

### Key ideas
- **A collection mode is the way the customer proves the payment, and each mode has a trap.** In `OTP_PULL`, the customer types a code from an SMS. The confirm step is the money step. A timeout there is `UNKNOWN`, which means we cannot tell whether the money moved. It is never "failed". In `REDIRECT` and `EMBEDDED`, the customer pays on the partner's page or in a small window on ours, and the customer's return is only a hint. In `PUSH_APPROVAL` and `QR_DISPLAY`, the customer taps Approve or scans a code, and may approve after our time limit.
- **A hint is a message that makes us ask, not proof.** The partner is the payment company that really moves the money. A "success" that arrives through the customer's browser can be faked, so we must ask the partner. This is why a customer who closes the browser after a redirect may still have paid.
- **A channel is a way for the result to reach us.** A signed `WEBHOOK` (the partner calls our secret address) is strong. `POLL` (we ask repeatedly) is strong because we asked the source. A `STATEMENT` is strong but slow. A synchronous answer, the reply to our own confirm call, is strong if it is clear. An `OPERATOR` decision under two-person control is the last resort. `RETURN_URL` and `BROWSER_CALLBACK` are hints only.
- **We believe only what we can verify ourselves.** Five facts must all match: the status is success, our reference, the amount within the route's tolerance, the currency and the environment (sandbox or live). If any one fails, we do not believe the message.
- **Weak methods are forced to ask the partner first.** The weak ones are `SHARED_TOKEN`, `IP_ONLY`, return URLs and browser callbacks. For them the switch `must_inquire` is on, so nothing is believed until the partner answers. This adds a check; it never skips one.
- **The wizard enforces the rule.** If someone saves a weak channel with `must_inquire` off, the wizard refuses to save.

### A worked example
Layla pays 25.500 LYD at Noon Mart through a rail that uses redirect (an example rail).
1. Layla is sent to the payment company's page and pays.
2. Her browser returns to our page carrying a "success" message. This is a return URL, so it is only a hint.
3. The platform asks the partner. The answer says: status success, our reference, 25.500 LYD, currency LYD, environment live. All five facts match, so the payment is trusted.
4. On another day she closes the browser right after paying. No return message arrives, but the signed webhook does, and the payment is confirmed. She had paid all along.
5. With Sadad, Layla types her SMS code. The confirm call times out. The result is `UNKNOWN`, not failed, because we cannot tell whether the money moved.

Notice that the browser never decided the outcome. The partner did.

### Common mistakes
- **Trusting the browser's own "done" message.** Browser messages can be faked.
- **Ignoring a return URL completely.** It is a hint, not noise. It is the cue to ask the partner.
- **Treating a timeout on the confirm step as a failure.** Money may have moved.
- **Thinking a weak channel skips checks or pays faster.** The rule does the opposite: it forces a question first.

### Read now
- [[a:b06-02|The nine collection modes in depth]]
- [[a:b06-07|Confirmation channels and how much each one is trusted]]

### Check yourself
Questions: c-l-m8-2-1, c-l-m8-2-2
@@end

@@lesson id=l-m8-3 module=m8 order=3 title="The engine: phases, steps and the retry boundary" minutes=30 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b06-03,b06-08,b06-17
### You will be able to
- Name the ten engine phases and say which one is the money step.
- Explain the four labels on a step.
- State the retry boundary and why it exists.
- Explain what happens when no status rule matches.

### Key ideas
- **A gateway is a recipe, not a program.** The engine inside `core-back` follows a stored recipe. Nobody writes code to add a gateway. The recipe has ten **phases**, and each phase is an ordered list of **steps**. Five phases need a short explanation. `CREDENTIAL_CHECK` is a harmless test call. `PRE_INITIATE` holds optional read-only checks. `INITIATE` starts the payment. `SUBMIT` is the money step, also called confirm. `VERIFY` asks the partner for the real status. The other five are `CANCEL`, `REFUND`, `VOID`, `CAPTURE` and `SETTLEMENT_FETCH`.
- **Every web step carries four labels.** `side_effect` says what the call can cause outside, for example moving money. `retry_policy` says whether the engine may repeat it: `SAFE`, `SAFE_WITH_COOLDOWN` or `NEVER`. `idempotency_config` says whether the partner guarantees that a repeated request has no extra effect. `point_of_no_return` says that after this step the customer cannot simply be told "try again".
- **The retry boundary: a money step is never retried automatically.** This holds after a timeout, a dropped connection or a server error. From our side, two cases look identical: the request never arrived, or it arrived and only the reply was lost. Retrying could pay twice. Its `retry_policy` must be `NEVER`, so `SAFE` and `SAFE_WITH_COOLDOWN` are both refused, and the attempt becomes `UNKNOWN`. The save-time validator refuses a recipe that breaks this rule, unless an idempotency key is supported and proven.
- **Status rules turn the partner's words into ours.** Partners write "00", "Approved" or "PAID". Rules map them to our five statuses: `AWAITING_CUSTOMER`, `VERIFYING`, `SUCCEEDED`, `FAILED` or `UNKNOWN`. Rules are checked in order and the first match wins. If no rule matches on a money step, the result is `UNKNOWN`, never `FAILED` or `SUCCEEDED`. When we do not understand, we do not guess.
- **Error classes explain what went wrong.** `RETRYABLE_OTP` is a mistyped code. `TERMINAL_DECLINE` is final. `LIMIT_EXCEEDED` is a customer or merchant limit. `GATEWAY_FAULT` means the partner is broken. `AMBIGUOUS` means we cannot tell. Only gateway faults count toward the circuit breaker. A wrong OTP never does.
- **A value from an earlier answer cannot be used on the first step.** There is no earlier answer yet, so the validator rejects it.

### A worked example
Layla pays 25.500 LYD at Noon Mart with Sadad.
1. `INITIATE` asks Sadad to send an SMS code. Layla types it.
2. `SUBMIT`, the money step, sends the confirm request. The connection drops.
3. The engine does not repeat the request, because `retry_policy` is `NEVER`. The attempt becomes `UNKNOWN`. It stays `UNKNOWN` until someone asks the partner (`VERIFY`), a statement arrives, or an operator decides with evidence.
4. In another case, Sadad answers the confirm call with a code that no rule matches. The result is `UNKNOWN`, not `FAILED`.
5. In another recipe, a Gateway Admin marks a money step `SAFE` to make the tests pass. The save-time validator refuses it.

Notice that nobody guessed, and nobody risked a second payment.

### Common mistakes
- **Marking a money step `SAFE` to make tests pass.** The validator refuses it, and a retry could pay twice.
- **Mapping an unexpected answer to `FAILED`.** Without a matching rule, the result must be `UNKNOWN`, because the money may have moved.
- **Counting a wrong OTP toward the circuit breaker.** Customer mistakes never trip it.
- **Using an earlier answer on the first step.** The validator rejects it.

### Read now
- [[a:b06-03|The engine]]
- [[a:b06-08|Status rules and error maps]]
- [[a:b06-17|Fourteen engine safeguards in plain language]]

### Check yourself
Questions: c-l-m8-3-1, c-l-m8-3-2
@@end

@@lesson id=l-m8-4 module=m8 order=4 title="Amounts, forms and signatures in practice" minutes=30 tracks=GATEWAY_ADMIN reading=b06-04,b06-05,b06-06
### You will be able to
- Set scale, precision and rounding so an amount is written the way a gateway expects.
- Explain the three sensitivity levels and say where a full card number may live.
- Diagnose a signature failure by checking the three common causes.

### Key ideas
- **One dinar is 1000 dirhams, and gateways disagree on how to write money.** Our books use three decimals (10.500). Many wallet gateways want two decimals (10.50). Moamalat wants whole dirhams (10500). Every gateway has a **scale** (multiply by 1, 100 or 1000 before sending), a **precision** (0, 2 or 3 decimals on the wire) and a **rounding** rule. A mistake here is 1000 times wrong and it is silent.
- **Rounding applies when precision is below three decimals.** The choices are `NONE`, `NEAREST`, `UP` and `DOWN`. For 76.255 LYD on a two-decimal gateway, `NEAREST` gives 76.26, `UP` gives 76.26 and `DOWN` gives 76.25.
- **Each form field has a sensitivity level.** `NORMAL` is ordinary data. `SENSITIVE` covers personal or wallet identifiers and is masked in logs and screens. `PAN` is a full card number.
- **A full card number is never stored.** It stays in memory for one outbound call and is then wiped. It never reaches the database or a log. A rail with a `PAN` field needs a PCI (Payment Card Industry) scope review before it goes live.
- **Normalisers clean what the customer types.** They turn Arabic digits into ordinary digits and put phone numbers into the style the gateway needs. Our server checks the field. It does not trust the browser.
- **A signature is an all-or-nothing recipe.** It states the algorithm (for example `HMAC_SHA256`) and how the key is written (`UTF8`, `HEX` or `BASE64`). It states which fields go in, in what order, and how the result is written (`HEX_LOWER`, `HEX_UPPER` or `BASE64`). One different character gives a completely different result, never a nearly right one. The common causes of failure are wrong key encoding, wrong field order or field set, and wrong output case. During key rotation, two secret versions stay valid during the overlap, which avoids downtime.

### A worked example
A Gateway Admin sets up a new gateway for Noon Mart payments.
1. The gateway wants two-decimal strings with `NEAREST` rounding. Layla's 25.500 LYD is sent as "25.50". A second gateway wants whole dirhams, so it receives 25500.
2. The Admin runs the signing test, and the signature never matches.
3. The Admin checks the three causes. The field order is right and the output case is right.
4. The partner's documents say the key is written in hexadecimal. Our recipe treats it as plain text, so the key bytes are different and the whole signature is different.
5. The Admin sets the key encoding to `HEX`. The signature now matches the partner's own sample.

Notice that the fix was one setting. Retrying would not have helped, because the same recipe gives the same wrong result.

### Common mistakes
- **Testing a signing recipe with your own made-up sample.** You prove nothing about what the partner will accept. Use the partner's sample.
- **Retrying more when a signature fails.** The same recipe gives the same wrong result each time.
- **Sending 10500 to a gateway that expects 10.50.** The customer is asked to pay ten thousand five hundred dinars. If you see this, stop, do not retry, and report a P1 incident.

### Read now
- [[a:b06-04|Amounts]]
- [[a:b06-05|Customer forms]]
- [[a:b06-06|Signatures and crypto profiles in practice]]

### Check yourself
Questions: c-l-m8-4-1, c-l-m8-4-2
@@end

@@lesson id=l-m8-5 module=m8 order=5 title="Why a payment method is visible or hidden" minutes=25 tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN reading=b06-12,b06-11
### You will be able to
- List the nine conditions that make a rail visible.
- Diagnose a missing payment method by walking down the conditions.
- Explain what the circuit breaker is and what does and does not trip it.

### Key ideas
- **A rail is shown only when all nine conditions are true.** A rail is the payment method the customer sees, such as Sadad. Lines 1 to 3 are about permission. Line 1: the application allows the rail. Line 2: the link allows it. Line 3: a live commission profile covers it. Lines 4 to 8 are about the route. Line 4: at least one route is `ACTIVE`. Line 5: that route is `HEALTHY`. Line 6: the amount is inside the route's limits and daily cap. Line 7: the route is outside a maintenance window and its scope includes this merchant, application, risk tier and channel. Line 8: the route's credential set is `VERIFIED`. Line 9 is about the rail itself: the rail's currency matches the link and the rail is not blocked. One failing line is enough to hide the rail.
- **Conditions 4 to 8 must be satisfied by one single route.** A route is the link between a rail and a gateway. If route A is active but over its limit, and route B is within limits but paused, the rail stays hidden. The conditions cannot be shared between two routes.
- **To diagnose, walk down the list.** The first failing line is the answer. The most common causes are line 5, where the breaker is open, and line 6, where the amount is above the maximum. Next come line 3, where no commission profile covers the amount, and line 1, the application's list.
- **The circuit breaker moves customers away from a failing route.** The platform measures every route all the time. When a partner fails repeatedly, the breaker opens and the route's health becomes `OPEN_BREAKER`. Customers stop seeing the route. New payments use the next healthy route if there is one. A small test call repeats until the partner recovers.
- **Only partner faults trip the breaker.** A customer who types a wrong OTP is a customer mistake, so it never counts. A large amount is not a fault either. It can hide a rail through line 6, but it does not open the breaker.
- **A route can also be `DRAINING`.** It finishes the payments it is running and takes no new ones.

### A worked example
Noon Mart makes a payment link for 3000.000 LYD. Layla opens it and cannot see Sadad. Ali, the operator, walks down the list for the Sadad route.
1. The application and the link both allow Sadad (lines 1 and 2).
2. A live commission profile covers this amount (line 3).
3. The route is `ACTIVE` and `HEALTHY` (lines 4 and 5).
4. The route's maximum is 2000.000 LYD. The link asks for 3000.000 LYD, so line 6 fails.

Layla's usual 25.500 LYD payment passes line 6 and Sadad is visible. Two other cases use the same method. If Edfali's direct route is nearly at its daily cap, a small amount fits and a large one does not, which is also line 6. For example, if Sadad vanishes only between 02:00 and 03:00, the cause is line 7, a maintenance window or scope.

Notice that Ali did not guess. He stopped at the first failing line.

### Common mistakes
- **Raising a limit only to "make it appear".** Editing a route changes fees, limits and who sees a method, and route edits need `SECURITY_ADMIN` approval. Find out why the line fails first.
- **Blaming the wrong condition.** Line 6 is limits and daily cap. Currency, the application list and the credential check are different lines.
- **Expecting wrong OTPs or large amounts to open the breaker.** They never do.
- **Mixing conditions across routes.** Lines 4 to 8 must be true together on one route.

### Read now
- [[a:b06-12|The visible-rails formula]]
- [[a:b06-11|Rails and Routes]]

### Check yourself
Questions: c-l-m8-5-1, c-l-m8-5-2
@@end

@@lesson id=l-m8-6 module=m8 order=6 title="The wizard, AI import and the twelve gates" minutes=30 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b06-13,b06-14,b06-16
### You will be able to
- Name the eight wizard steps and say which one holds the simulator and approval.
- Follow the four stages of the safe AI import and say what you may give the AI.
- Explain why a gateway that passes all verification layers is still not live.
- List the twelve go-live gates and say who reads the results.

### Key ideas
- **The wizard has eight steps, and each one is saved into a draft.** Nothing you do in it changes a live payment. The steps are: 1) Identity & Basics, 2) Environments & Auth, 3) Customer Catalog, 4) Crypto Profiles. Then come 5) Flow Builder, 6) Client Action & Channels, 7) Status Rules & Costs and 8) Simulator & Approval. Step 8 is where you inspect the built requests, run the automatic scenarios and submit for approval.
- **AI import has four stages.** The Smart AI Integration screen helps you draft a gateway from a long partner document. You download a kit from the Back Office. You give it to an AI assistant in your own browser, and it returns a file. You upload the file and the platform verifies it. Last you type the real secrets into the platform and import the result. The platform itself never calls an outside AI.
- **Never give the AI a real secret.** Give it only the names of the credentials, or dummy sandbox values. A masked secret is still a secret, and a real sandbox secret is not allowed either.
- **The platform verifies the file in four layers.** Layer 1 checks the schema and version. Layer 2 checks meaning and security. Layer 3 runs an offline simulation with the sample requests and answers inside the file. Layer 4 checks for a collision with an existing gateway or rail code. The step types `WAIT`, `ASSERT` and `BRANCH` cannot be imported. You add them later in the wizard's flow editor. `HTTP`, `COMPUTE` and `RENDER` can be imported.
- **A passed check is not approval.** An imported gateway arrives as a draft: the version is `DRAFT`, the route is `PAUSED` and the credential set is `UNTESTED`. It still needs the live credential check, the gates and a second person.
- **Twelve gates must all pass before a version is `LIVE`.** There are not five or twenty. Gates 1 to 5 are: two-person approval, the 15-scenario suite, and the amount, reference and signature contract tests. Gates 6 to 8 are: channel strength, a named rollback version, and a preview of limits, commission and statement parser. Gates 9 to 12 are: the evidence level, the PCI review for card-number fields, a canary plan, and alerts with runbooks. The platform runs gates 2 to 5, and the approver must read their results.

### A worked example
A Gateway Admin adds a new wallet gateway (an example) so Noon Mart can offer it.
1. She downloads the kit and gives the AI the kit and the partner's documents. She names the credentials only.
2. The AI returns a file. It passes all four verification layers.
3. She types the real secrets and imports. The version is `DRAFT`, the route is `PAUSED` and the credential set is `UNTESTED`.
4. The amount test must show that 10.50 LYD becomes 10500 for a gateway that wants whole dirhams.
5. A second person, a `SECURITY_ADMIN`, reads the gate results. Only when all twelve gates pass can the version go `LIVE`.

Notice that passing the checks only started the process.

### Common mistakes
- **Treating a passed check as approval.**
- **Pasting a masked or sandbox secret into the AI.** Both are forbidden. Give only names or dummy values.
- **Approving without reading the gate results.** The approver is the last human check.

### Read now
- [[a:b06-13|The Add-a-Gateway wizard]]
- [[a:b06-14|Smart AI Integration]]
- [[a:b06-16|The twelve go-live gates, in plain words]]

### Check yourself
Questions: c-l-m8-6-1, c-l-m8-6-2
@@end

@@lesson id=l-m9-1 module=m9 order=1 title="Incident principles and the first three runbooks" minutes=30 tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN reading=b10-01,b10-02,b10-03,b10-04
### You will be able to
- Apply the seven incident principles, starting with "stop the harm first".
- Choose the right runbook for what you see on the dashboard.
- Follow RB-01 (outage), RB-02 (signature or sender change) and RB-03 (UNKNOWN backlog).
- Say which actions may be immediate and which must be reviewed.

### Key ideas
- **An incident is anything that threatens money, customers or trust.** A runbook is a written procedure for one kind of incident. Seven principles guide all of them. The first three are these. **Stop the harm first and understand later**, because pausing a route is reversible and a wrong payment is not. **Never guess with money**, so use the evidence screens: the step log, the inbox and the statement. **Tell people early**, because reporting quickly is never punished. Finding someone to blame, or waiting, is never the first step.
- **The other four principles keep teams safe.** **One person leads**, so two people never act on the same item. **Do not work around controls**, because two-person rules still apply. **Write as you go**: time, what you saw, what you did, who agreed. **Hand over in writing** at the end of a shift.
- **RB-01, an outage.** A route's health shows `OPEN_BREAKER` and customers miss a payment method. The circuit breaker is the platform's automatic switch that hides a failing route. You confirm it is real and tell the Gateway Admin. You never re-enable the route while the partner still fails, and you never edit gateway settings to "try something".
- **RB-02, a changed signature or sender.** The partner may have changed how it signs or moved its servers. Never accept unsigned messages to get things moving, because that is what an attacker wants. The Gateway Admin confirms the change with the partner in writing. The new secret or address is added with an overlap, so old and new both work. A Security Admin approves it. Then you replay the stored messages. The raw messages were kept unchanged in the inbox, so nothing is lost.
- **RB-03, a backlog of `UNKNOWN` payments.** `UNKNOWN` means we cannot yet tell whether the money moved. First find the pattern by route and period. Then run Bulk Inquiry for the affected route. Never mass-resolve by hand, because every manual resolution is a two-person decision with evidence.
- **Pausing is quick, resuming is reviewed.** Pausing reduces risk and may be immediate. Resuming goes through the normal review.

### A worked example
The Sadad partner starts to fail while Layla is paying 25.500 LYD at Noon Mart.
1. Layla's payment started before the breaker opened. It finishes on its original settings, but it may end as `UNKNOWN`.
2. Ali, the operator, sees `OPEN_BREAKER`. He confirms it is real and tells the Gateway Admin and his manager.
3. He does not re-enable the route. New payments use the next healthy route if there is one. If Sadad has no other route, customers simply stop seeing Sadad.
4. Later the Unknown Backlog tile has grown. Ali filters Operator Cases by route and period and runs Bulk Inquiry for the Sadad route. Most attempts resolve when the partner answers.
5. For any case that cannot be asked, he waits for the next statement or an operator decision with evidence from two people.

Notice that Ali never guessed and never worked alone.

### Common mistakes
- **Editing gateway settings to "try something" during an outage.** You may change money behaviour with no review.
- **Accepting unsigned messages when signatures fail.** An attacker can then send false confirmations.
- **Marking all `UNKNOWN` payments as failed.** Some may have been paid.

### Read now
- [[a:b10-01|Incident principles]]
- [[a:b10-02|RB-01 Gateway outage and the circuit breaker]]
- [[a:b10-03|RB-02 Partner changed its signature or sender address]]
- [[a:b10-04|RB-03 A backlog of UNKNOWN payments]]

### Check yourself
Questions: c-l-m9-1-1, c-l-m9-1-2
@@end

@@lesson id=l-m9-2 module=m9 order=2 title="Ledger drift and credential failures" minutes=25 tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN reading=b10-05,b10-06
### You will be able to
- Follow RB-04 when the books show drift, and say what the platform stops.
- Follow RB-05 when a credential set is `FAILING`.
- Say what the platform did by itself in each case.
- Explain why secrets are rotated with an overlap.

### Key ideas
- **Drift means our own ledger equation does not balance.** The ledger is our book of every money movement. The invariant screen shows a drift other than 0.0000. Reconciliation is a separate check that compares our records with the partner's statement, and it shows problem lines. The problem lines are `MISSING_AT_GATEWAY` (we say success, the partner shows nothing), `MISSING_LOCALLY` (the partner shows a payment we do not have) and `AMOUNT_MISMATCH` (same payment, different amount).
- **The platform stops automatic payouts. It does not stop logins or the sandbox.** Treat drift as P1, the most urgent priority, and tell your manager and the Security Admin. Do not cash out manually while payouts are stopped.
- **Inspect each problem line, and start with the serious ones.** `MISSING_AT_GATEWAY` is the most serious, because we may have credited money we did not receive. Re-run the statement ingest and check that the file and its time zone are right. Post fee variances through the true-up, and resolve unmatched items through approved adjustments only.
- **Never edit a number to make it balance.** Corrections are approved adjustments. Resume payouts only when the drift is understood and zero, and your manager agrees.
- **A `FAILING` credential set removes its route from selection.** A credential set holds the secrets for one gateway. When it turns `FAILING`, customers no longer see the route, and failures mention authentication. The route is not deleted and not promoted. Payments already running continue on their original credentials.
- **Replace the secret with two people, then run the credential check.** Enter the new secret in the write-only credential field. Run `CREDENTIAL_CHECK`. When it passes, the set becomes `VERIFIED` and the route returns. Plan future rotations as an overlap, with two versions valid at once, which avoids downtime.

### A worked example
Huda in finance sees the invariant drift is not zero, and automatic payouts have stopped.
1. She treats it as P1 and tells her manager and the Security Admin. She does not cash out by hand.
2. She re-runs the statement ingest. The file and its time zone are correct.
3. One problem line is `MISSING_AT_GATEWAY`: Layla's 25.500 LYD payment at Noon Mart was credited by us, but the Sadad statement shows nothing. This is the most serious kind.
4. She resolves it through an approved adjustment and never edits a number.
5. The drift is zero and her manager agrees, so payouts resume.

Later, the Sadad credential set turns `FAILING` because its secret expired. A Gateway Admin replaces the secret with a second person's approval and runs `CREDENTIAL_CHECK`. It passes, and the route returns.

Notice that nobody changed a number or worked alone.

### Common mistakes
- **Cashing out manually while payouts are stopped.** Money may leave while the books are wrong.
- **Editing a number to make the books balance.** The real problem stays hidden.
- **Treating `MISSING_AT_GATEWAY` as low priority.** We may have credited money we never received.
- **Rotating a secret without an overlap.** Downtime can result. Use an overlap.

### Read now
- [[a:b10-05|RB-04 Reconciliation or ledger drift]]
- [[a:b10-06|RB-05 Credentials or tokens expired or failing]]

### Check yourself
Questions: c-l-m9-2-1, c-l-m9-2-2
@@end

@@lesson id=l-m9-3 module=m9 order=3 title="Handover, mistakes and leaks" minutes=20 tracks=FOUNDATION reading=b10-07,b10-08,b10-09
### You will be able to
- Write a handover note that holds all five things the next shift needs.
- Report a mistake step by step, and say how a wrong approval is corrected.
- Respond to a suspected leak.
- Explain why reporting quickly is never punished.

### Key ideas
- **A handover note protects the next person.** At the end of a shift, write what is open and why, with case numbers or references. Write what you already tried, what you are waiting for and from whom, anything risky, and anything you promised to a merchant or customer. A half-reviewed approval is an example of "risky".
- **Never leave half a decision without a note, and never hand over a secret.** Do not approve a half-reviewed item only to clear it. Hand it over with a note. Tell the next person about anything that could not wait.
- **When you make a mistake, stop and tell your manager.** Do not try to undo it by clicking more, and do not wait. Then tell the role that owns the area. Write what you did, which screen, which item and the time. Finally, tell your manager what would have stopped you.
- **Never edit history.** A money mistake is fixed by a new approved adjustment that offsets the old entry. An approval that is wrong but not yet executed can be rejected or withdrawn: tell the maker, who is the person who made the request. Once it is executed, only a new entry offsets it.
- **A suspected leak goes to the Security Admin at once.** Signs are someone else's activity under your account, an unexpected MFA request, or a secret pasted where it should not be. Do not wait to be sure, and do not hide it. A leaked secret works for anyone until it is replaced.
- **Reporting quickly is never punished. Hiding is.** This is why the first step is always to tell someone. If you do not know whom, use the escalation ladder: your team lead or manager, then the role named by the runbook, then the MLRO (the money-laundering reporting officer) for anti-money-laundering decisions.

### A worked example
Ali, the operator, is about to finish his shift.
1. Earlier he approved the wrong row. He stopped, told his manager, and did not click more to undo it.
2. He wrote what happened: the screen, the item and the time. The approval was already executed, so the owner of the area proposed a new entry to offset it.
3. Now an approval is half reviewed. He writes a handover note: what is open and why, what he tried, what he waits for, the risk, and a promise he made to Noon Mart. He does not approve it only to clear it.
4. A colleague pasted a token into a team chat. She told the Security Admin at once. The token was replaced, and she wrote down what was exposed, where and for how long.

Notice that every person spoke up first and nobody tried to fix things quietly.

### Common mistakes
- **Quietly trying to undo a mistake with more clicks.** The people who can fix it do not hear about it.
- **Deleting a leaked token and saying nothing.** The secret may still be used until it is replaced.
- **Writing a password in a handover note.** A note is shared, so the secret is exposed.
- **Leaving a half-reviewed approval without a note.** The next person cannot know what is risky.

### Read now
- [[a:b10-07|A secret may have leaked, or an account may be taken over]]
- [[a:b10-08|Shift handover and the escalation ladder]]
- [[a:b10-09|You made a mistake]]

### Check yourself
Questions: c-l-m9-3-1, c-l-m9-3-2
@@end

@@lesson id=l-m10-1 module=m10 order=1 title="How attackers think, and phishing" minutes=20 tracks=FOUNDATION reading=b11-01,b11-02,b11-03
### You will be able to
- Name what attackers want and why they go after people first.
- Recognise the six common tricks and answer each one correctly.
- Apply the password, MFA and device rules.
- Say which part of our defence is yours.

### Key ideas
- **Attackers want money, information or disruption, and the easiest way in is usually a person.** Money means stealing it or moving it. Information means identities and secrets. Disruption means stopping us from working. Our system has many layers of defence, such as separate services and two-person approval. Those protect against attacks on the system. You protect against attacks on you.
- **Social engineering means tricking a person into doing something.** It works because people want to be helpful and fear upsetting someone with authority. There are six tricks. Urgency says "the CEO needs this payout now". Authority says "I am from IT". Fake support says "read me the code on your phone". A fake link arrives in an e-mail: do not click it, but type the address yourself and report the message. A favour says "approve mine and I will approve yours". Pretext means a caller knows some details, but details do not prove identity.
- **Never give a password or one-time code to anyone.** A one-time code is the short number sent to your phone to prove it is you. Nobody legitimate asks for it. Giving half of it is still giving it. For an unusual request, verify through a second channel you already know, not the number the caller gives you. Then report it to the Security Admin, even if you did not click.
- **Protect your account and your device.** Use a long, unique password and MFA (multi-factor authentication: a second proof such as a phone code) always. Never share your login, even with a locked-out colleague for five minutes. Refuse, and ask the Security Admin to help your colleague. Lock your screen when you step away. Report a lost device the same minute.
- **Use the Back Office only from the office network or the approved VPN.** A VPN is a protected link into the office network. The Back Office is limited to the office network by design. A café, a shared computer or a personal computer is not allowed. Sensitive actions ask you to sign in again. That is protection, not a bug.

### A worked example
Ali, the operator, is the target of several tricks in one day.
1. An e-mail "from IT" arrives with a login page link and a message that says it is urgent. Ali does not click. He types the address himself and reports the message.
2. A caller then says he is from IT and needs the code on Ali's phone to "fix the account". Ali refuses. Nobody legitimate asks for a code.
3. Ali reports the call to the Security Admin, even though he gave nothing.
4. A colleague is locked out and asks to use Ali's login for five minutes. Ali refuses and asks the Security Admin to help her.
5. Later Ali works from a café. He cannot reach the Back Office, because it is available only from the office network or the approved VPN.

Notice that every trick used pressure or helpfulness, and every correct answer was to slow down.

### Common mistakes
- **Clicking a link in an e-mail instead of typing the address.** A fake login page can steal your password.
- **Giving a code, even half of one.** The attacker can then sign in as you.
- **Sharing your login for a short time.** Anyone using it acts as you.
- **Working from a café, or from a shared or personal computer.** It is not allowed.

### Read now
- [[a:b11-01|How attackers think, and what protects us]]
- [[a:b11-02|Phishing, impersonation and social engineering]]
- [[a:b11-03|Passwords, MFA, sessions and devices]]

### Check yourself
Questions: c-l-m10-1-1, c-l-m10-1-2
@@end

@@lesson id=l-m10-2 module=m10 order=2 title="Handling data and conduct" minutes=20 tracks=FOUNDATION reading=b11-04,b11-05,b05-04
### You will be able to
- Say what counts as sensitive data and what you may send in chat.
- Explain the rules for screenshots, exports and masked values.
- State the conduct rules, including what to do with a gift.
- Handle a business document that is unreadable or appears twice.

### Key ideas
- **Sensitive data is more than passwords.** It includes national ID numbers, phone numbers, bank details, documents, any anti-money-laundering (AML) information, anything secret, and anything that identifies a customer. **Quote references, not names or numbers.** A reference points to the payment without exposing the person.
- **Never put secrets in chat, tickets or e-mail.** That means passwords, one-time codes, API keys, certificate keys, card numbers and national ID numbers. Look at data inside the platform. Do not copy it to personal notes, phones or e-mail. Share it only with people who need it for the task. Report accidental exposure at once and do not hide it.
- **A screenshot copies data out of our controls.** Take one only when policy allows, store it only where allowed, and delete it when finished. Never include a secret, a code or AML information. Delete exports when you are done.
- **Masked values are masked on purpose.** A phone number shown as `091*****78` stays masked. Do not try to reveal it, and do not ask others to.
- **Conduct rules protect you.** Do not use another person's account, even with permission. Do not approve what you cannot explain. Do not look at records out of curiosity, because every read is logged. Do not accept gifts or favours from merchants, partners or applicants. If anyone pushes you to bypass a control, report the pressure.
- **Business documents follow the same care.** KYB (Know Your Business) is the checking of a business, and documents are the evidence. Never copy them out of the platform. Never accept a document you cannot read. If the same registry certificate appears under two unrelated merchants, note it, require a second reviewer and escalate. Do not accuse anyone. A beneficial owner is a real person who holds 25% or more, or who controls the business. If nobody reaches 25%, the most senior manager is recorded as the controller. It is not only the largest shareholder, and it is not any employee.

### A worked example
Huda in finance needs help with Layla's 25.500 LYD payment at Noon Mart.
1. She asks Ali about the payment. She sends the reference only, not Layla's name or phone number.
2. Ali replies in chat. A token is visible on his screen, so he does not send a screenshot.
3. The customer's phone shows as `091*****78`. Huda leaves it masked.
4. A merchant applicant offers Ali a small gift for a faster approval. Ali refuses and reports it.
5. During a KYB review, the same registry certificate is found under two unrelated merchants. Ali notes it, asks for a second reviewer and escalates without accusing either merchant.

Notice that each choice used a reference, a refusal, or a report. None used a shortcut.

### Common mistakes
- **Posting a screenshot with a token in a team chat.** The token is now exposed and must be treated as leaked.
- **Sending a customer's name and phone number to ask a quick question.** Personal data spreads to places we do not control.
- **Accepting a small gift, or accepting it later.** Gifts and favours are never accepted, even small ones.
- **Accepting an unreadable document to meet a deadline.** An unreadable or edited document is never accepted.

### Read now
- [[a:b11-04|Handling data]]
- [[a:b11-05|Conduct and insider risk]]
- [[a:b05-04|KYB documents and beneficial owners]]

### Check yourself
Questions: c-l-m10-2-1, c-l-m10-2-2
@@end

@@lesson id=l-m10-3 module=m10 order=3 title="Deployment, environments and secrets" minutes=30 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b12-01,b12-02,b12-03,b12-04,b12-05,b12-06
### You will be able to
- Describe the five server roles and who may connect to each.
- Explain who holds which key and why a hacked edge host gains little.
- Explain what the deployment tool does when the end-to-end check fails (it stops, and rollback is manual).
- Explain Fake Rails, the parallel sandbox plane and why the live engine can never reach it.

### Key ideas
- **The platform has five server roles, on one to five physical servers.** The roles are database, core, admin, merchant and checkout. The core is the service that holds the rules and the money records. The three outer services (admin, merchant, checkout) are called edge hosts. The database host never shares an address with the core.
- **Each role accepts connections only from a few places.** The database accepts only the core. The core accepts only the three edge hosts. The Back Office is LAN-only, which means the office network only. If it were on the internet, an attacker anywhere could try passwords on it. On the office network, the attacker must first get inside.
- **Mutual TLS means both sides show an identity card.** Our own authority signs the cards. The authority's private key never leaves the deployment workstation. Each edge host gets the authority's public certificate and only its own client certificate and key. So a hacked checkout host cannot pose as the admin or merchant service.
- **Only the core holds the database credentials and the master key.** The master key protects every stored secret. Edge hosts never receive either. The file `deploy.env` drives deployment and contains secrets, so it is never committed to a repository and never pasted into chat.
- **A deployment runs twelve steps in order.** Before database changes, it takes a compressed backup. Restoring it is a manual operator decision. Near the end, an end-to-end check makes each edge prove its identity to the core with a mutual-TLS handshake. If it fails, the tool stops with an error. The new release stays current. The previous release is still on disk, but going back is a manual step by an operator. There is no automatic rollback. A plain `pm2 restart` keeps the release path the service already uses.
- **Fake Rails imitates payment companies for drills and never receives live credentials.** It can behave badly on purpose, with timeouts, wrong codes or forged messages. In a production installation it runs only in the **parallel sandbox plane**: a separate `pg-core-sandbox` process, a separate `payment_gateway_sandbox` database and a hard fence between the planes. The live engine receives no Fake Rails host, a `pg_test_` token is refused on the live plane, a `pg_live_` token is refused on the sandbox plane, and the database rejects a sandbox row on the live database. The portals switch worlds with the **LIVE | SANDBOX** control, and every sandbox link starts with `sbx_`.

### A worked example
Layla pays 25.500 LYD at Noon Mart. The checkout host handles her page.
1. An attacker breaks into the checkout host. He looks for the database credentials and the master key. They are not there, because only the core holds them.
2. He tries to act as the admin service. The host has only the checkout client certificate, so the core refuses.
3. A Gateway Admin deploys a new release. The tool first takes a compressed backup, because database changes are pending.
4. At the end-to-end check an edge fails its identity check. The tool stops with an error. The new release stays live, so the operators decide whether to roll back by hand.
5. For a drill, the team switches the portal to SANDBOX and uses the Fake Rails account manager or the checkout inspector. The sandbox process and database are separate, so nothing the drill does can reach live money or the live ledger.

Notice that each protection limits the damage from one failure. None depends on a single secret staying safe.

### Common mistakes
- **Committing `deploy.env` to a repository.** It holds secrets, and they are then exposed to everyone who can read it.
- **Keeping the authority's private key on every server.** Anyone who held it could create identity cards for any service.
- **Running Fake Rails on the live plane, or giving it live secrets.** It is a test tool; the live plane is fenced away from it and the live database refuses sandbox rows.
- **Opening the Back Office to a café or the internet.** Only the office network or approved VPN is allowed.

### Read now
- [[a:b12-01|Where each part runs]]
- [[a:b12-02|Network protection]]
- [[a:b12-03|Certificates and mutual TLS]]
- [[a:b12-04|Configuration and secrets]]
- [[a:b12-05|The twelve-step deployment, in plain words]]
- [[a:b12-06|Test environments]]

### Check yourself
Questions: c-l-m10-3-1, c-l-m10-3-2
@@end


@@lesson id=l-m10-4 module=m10 order=4 title="Backups, point-in-time recovery and restore drills" minutes=25 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b12-07,b12-09,b12-10,b12-11
### You will be able to
- Explain the difference between a full backup, a delta backup and continuous WAL archiving.
- Read the five summary tiles and the three restore-drill checks on the **Backups** screen.
- Explain why a backup policy change needs a second Security Admin and why the off-site vault never deletes by default.

### Key ideas
- **Three layers work together.** A **full backup** copies the whole database. A **delta backup** copies only what changed since the previous backup. **WAL archiving** copies every change continuously. WAL is the write-ahead log: the database writes each change there before it changes any number.
- **Point-in-time recovery (PITR) uses all three.** Restore the full backup and the deltas. Then replay the archived WAL to a chosen second. Only the WAL covers the hours after the last scheduled backup.
- **The default timing is always in UTC.** The full backup runs weekly (Sunday 02:00). The delta backup runs daily (02:00). The restore drill runs weekly (Sunday 04:00).
- **The backup daemon makes and stores the copies.** It is a separate service. Depending on the engine, it runs on the primary's host or on a separate host. It keeps compressed, AES-256-GCM encrypted copies in a local repository, an S3 or MinIO bucket and an optional off-site vault. The vault never deletes by default, so an attacker who controls the daemon cannot erase the off-site history.
- **A backup nobody has restored is only a hope.** The **restore drill** restores into an isolated scratch cluster and replays WAL to a target time. It runs exactly three checks on the restored data: **Double-entry zero drift**, **Sharded balance parity** and **Audit hash chain**. Then it destroys the scratch cluster, so production is never touched.
- **A failed check is a priority-1 incident.** Follow the card. If a ledger check failed, tell Finance and the Security Admin. If the audit chain failed, escalate to the Security Admin and never delete, prune or alter any backup or audit record.
- **The five tiles are WAL archive lag, Daemon status, Storage targets, Last backup and Latest restore drill.** WAL archive lag is healthy up to the threshold (default 300 s), Attention above it and Critical above twice the threshold. A green Last backup tile does not prove the copy can be restored. Only a passed restore drill does.
- **Policy changes need two Security Admins.** **Edit policy** creates a `BACKUP_POLICY` approval request. A different Security Admin must approve it, so one stolen account cannot shorten retention and erase history.

### A worked example
Layla pays Noon Mart 25.500 LYD on Tuesday at 14:20 UTC.
1. The weekly full backup ran on Sunday at 02:00 UTC. Deltas ran on Monday and Tuesday at 02:00.
2. On Tuesday at 14:35 UTC the primary disk fails. The WAL archive lag was 2 seconds, so the archive holds everything except the last few seconds.
3. The people who run the servers restore the full backup and the two deltas. Then they replay WAL up to the moment before the fault.
4. Layla's payment came hours after the last delta, but the WAL carries it. Almost every settled payment and audit record is recovered, all except the last few seconds.
5. The weekly drill had already shown that these steps pass all three checks.

Notice that the nightly copies alone would have lost Layla's payment. The WAL closes that gap.

### Common mistakes
- **Ignoring a rising WAL archive lag.** Unarchived WAL fills the database disk.
- **Believing a policy change took effect after Save Changes.** It is still waiting for a second Security Admin.
- **Treating Drill failed as a minor warning.** Find the cause. We have no proof that recovery works until a drill passes all three checks.

### Read now
- [[a:b12-07|Releases, rollback, backups and health checks]]
- [[a:b12-09|Backups from zero]]
- [[a:b12-10|The Backups screen]]
- [[a:b12-11|Operating backups safely]]

### Check yourself
Questions: c-l-m10-4-1, c-l-m10-4-2
@@end


## III-C. Question bank

@@q id=q-m0-001 module=m0 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b00-03
Stem: Which rule says an unknown outcome must never be guessed?
- [x] UNKNOWN means we do not know; never guess.
- [ ] Always write a real reason.
- [ ] Amounts come only from the system.
Why: Rule 6: no guessing; use Inquire.
@@end

@@q id=q-m0-002 module=m0 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b00-03
Stem: A senior colleague in a hurry asks you to approve her own request. What do you do?
- [x] Refuse and ask the proper second person.
- [ ] Approve once because she is senior.
- [ ] Approve and add a reason.
Why: Never approve your own work or help anyone around the two-person rule.
@@end

@@q id=q-m0-003 module=m0 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b00-03
Stem: Someone claiming to be IT asks for your one-time code. What do you do?
- [x] Refuse and report it to the Security Admin.
- [ ] Give it, since he is IT.
- [ ] Give half of it.
Why: Nobody legitimate asks for passwords, codes or sessions.
@@end

@@q id=q-m0-004 module=m0 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b03-06
Stem: What should you do when you are unsure?
- [x] Stop and escalate.
- [ ] Click the safest-looking option.
- [ ] Ask a customer.
Why: Being slow is acceptable; being wrong with other people's money is not.
@@end

@@q id=c-l-m0-1-1 module=m0 type=single difficulty=1 critical=false exam=false lesson=l-m0-1 tracks=FOUNDATION refs=b00-02
Stem: What is the Academy's relationship to the Guide?
- [x] The Guide is the reference; the Academy teaches and tests.
- [ ] They are two separate systems with separate progress.
- [ ] The Academy replaces the Guide.
Why: They share one progress record: the Guide is the reference, the Academy teaches and tests it.
@@end

@@q id=c-l-m0-1-2 module=m0 type=single difficulty=1 critical=false exam=false lesson=l-m0-1 tracks=FOUNDATION refs=b00-04
Stem: What happens if you miss one critical question in an exam?
- [x] The exam fails, whatever your percentage.
- [ ] Nothing, only the score drops.
- [ ] You lose one point.
Why: Critical questions protect money or people, so missing any one fails the exam.
@@end

@@q id=c-l-m0-2-1 module=m0 type=single difficulty=1 critical=false exam=false lesson=l-m0-2 tracks=FOUNDATION refs=b00-03
Stem: Which three breaches does the guide call the most common serious ones?
- [x] Sharing credentials, guessing on UNKNOWN, tipping off.
- [ ] Late reports, long reasons, slow approvals.
- [ ] Using a laptop, using Arabic, using the menu.
Why: Rules 1, 6 and 7 are the most common serious breaches.
@@end

@@q id=c-l-m0-2-2 module=m0 type=single difficulty=1 critical=false exam=false lesson=l-m0-2 tracks=FOUNDATION refs=b00-03
Stem: A customer sends a screenshot saying "Payment successful". What counts as proof?
- [x] The payment's status in the platform, verified by our server.
- [ ] The screenshot, if it shows the reference.
- [ ] A phone call from the customer.
Why: Only a payment our server has verified with the payment company counts.
@@end

@@q id=c-l-m0-3-1 module=m0 type=single difficulty=1 critical=false exam=false lesson=l-m0-3 tracks=FOUNDATION refs=b03-06
Stem: What do you check first on a payment screen?
- [x] The SANDBOX or LIVE badge.
- [ ] The colour theme.
- [ ] The language.
Why: Acting on live data believing it is practice, or the reverse, is a classic mistake.
@@end

@@q id=c-l-m0-3-2 module=m0 type=single difficulty=1 critical=false exam=false lesson=l-m0-3 tracks=FOUNDATION refs=b03-06
Stem: Why is working with two tabs open dangerous?
- [x] Most wrong-merchant and wrong-amount mistakes happen that way.
- [ ] The platform forbids it.
- [ ] It slows the browser.
Why: One task at a time prevents mixing up merchants and amounts.
@@end

@@q id=q-m1-001 module=m1 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b06-04
Stem: Which is the correct scale idea? One dinar equals
- [x] 1000 dirhams.
- [ ] 100 dirhams.
- [ ] 10 dirhams.
Why: Hence three decimals.
@@end

@@q id=q-m1-002 module=m1 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b06-04
Stem: A gateway wants whole dirhams. 10.500 LYD should be sent as
- [x] 10500
- [ ] 10.50
- [ ] 1050
Why: 10.500 LYD is 10500 dirhams.
@@end

@@q id=q-m1-003 module=m1 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b01-06
Stem: A request to take money gets no reply. What status results?
- [x] UNKNOWN
- [ ] FAILED
- [ ] SUCCEEDED
Why: Silence on a money step is uncertainty, never failure.
@@end

@@q id=q-m1-004 module=m1 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b01-06
Stem: Which statement about a webhook is true?
- [x] It is stored exactly as received before anything else happens.
- [ ] It is trusted because it comes from a partner.
- [ ] It proves payment without signature checks.
Why: Raw storage first; verification follows.
@@end

@@q id=q-m1-005 module=m1 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b01-07
Stem: A hash is
- [x] a one-way fingerprint of data.
- [ ] a reversible lock.
- [ ] a password.
Why: The same data always gives the same hash; it cannot be reversed.
@@end

@@q id=q-m1-006 module=m1 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b01-07
Stem: Mutual TLS means
- [x] both sides show a digital ID card.
- [ ] only the server proves itself.
- [ ] data is never encrypted.
Why: It is used between our own services.
@@end

@@q id=q-m1-007 module=m1 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b01-03
Stem: Why can an aggregator route be slower or riskier than a direct route?
- [x] One more company is in the money path.
- [ ] Aggregators are illegal.
- [ ] They never use passwords.
Why: Every extra company is another place for delay or failure.
@@end

@@q id=q-m1-008 module=m1 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b01-02
Stem: Which is only a hint, not proof of payment?
- [x] The customer returning from the partner's page.
- [ ] A verified signed webhook.
- [ ] Our own status question's clear answer.
Why: Browser and return messages can be faked.
@@end

@@q id=q-m1-009 module=m1 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b01-08
Stem: A sandbox webhook reaches the live address. What happens?
- [x] It is rejected and raises an alert.
- [ ] It is processed as live.
- [ ] It is silently ignored.
Why: Environments are kept completely separate.
@@end

@@q id=q-m1-010 module=m1 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b01-06
Stem: An idempotent request is one that
- [x] has the same effect if sent twice.
- [ ] is always signed.
- [ ] is always fast.
Why: We never assume partners support it unless proven.
@@end

@@q id=q-m1-011 module=m1 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b01-05
Stem: Who decides which fee bearer applies to a link?
- [x] The link's configuration; it is not chosen by the customer.
- [ ] The customer at checkout.
- [ ] The payment company.
Why: Fee bearer is set on the link by the merchant's setup.
@@end

@@q id=c-l-m1-1-1 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-1 tracks=FOUNDATION refs=b01-01
Stem: Why must we verify an electronic payment ourselves?
- [x] A record-keeper changed the numbers, so only that record-keeper's answer is real.
- [ ] Because customers always lie.
- [ ] Because cash is not allowed.
Why: With electronic money the truth lives with the record-keeper, so we must ask it.
@@end

@@q id=c-l-m1-1-2 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-1 tracks=FOUNDATION refs=b01-02
Stem: Who tells the platform the amount of a payment?
- [x] The payment link in our own database.
- [ ] The customer.
- [ ] The browser.
Why: Amounts come only from the system.
@@end

@@q id=c-l-m1-2-1 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-2 tracks=FOUNDATION refs=b01-03
Stem: What is an aggregator?
- [x] A company offering one door to many payment methods.
- [ ] A bank's vault.
- [ ] The customer's wallet app.
Why: It adds one more company in the money path.
@@end

@@q id=c-l-m1-2-2 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-2 tracks=FOUNDATION refs=b02-06
Stem: What is a rail?
- [x] What the customer sees and picks, such as Sadad.
- [ ] The technical door to a partner.
- [ ] A secret key.
Why: A gateway is the technical door; a rail is the customer-facing method.
@@end

@@q id=c-l-m1-3-1 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-3 tracks=FOUNDATION refs=b06-04
Stem: How many dirhams are in one dinar?
- [x] 1000
- [ ] 100
- [ ] 10
Why: The dinar has three decimals because it is 1000 dirhams.
@@end

@@q id=c-l-m1-3-2 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-3 tracks=FOUNDATION refs=b06-04
Stem: A customer says they were asked for 1000 times the amount. First action?
- [x] Stop, treat as P1 and tell the Gateway Admin and Security Admin.
- [ ] Ask them to try again.
- [ ] Wait to see if it repeats.
Why: A wrong scale is silent and costly; do not retry.
@@end

@@q id=c-l-m1-4-1 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-4 tracks=FOUNDATION refs=b01-06
Stem: What is a webhook?
- [x] A partner calling us to say something happened.
- [ ] A form the customer fills.
- [ ] A type of password.
Why: We store it first, then check signature, sender and timestamp.
@@end

@@q id=c-l-m1-4-2 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-4 tracks=FOUNDATION refs=b01-06
Stem: A request to take money times out. What do we know?
- [x] Nothing: money may or may not have moved.
- [ ] It failed.
- [ ] It succeeded.
Why: Silence on a money step means UNKNOWN.
@@end

@@q id=c-l-m1-5-1 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-5 tracks=FOUNDATION refs=b01-07
Stem: What does a signature prove?
- [x] The message came from someone with the shared secret and was not changed.
- [ ] The message is polite.
- [ ] The message is encrypted.
Why: One different character gives a completely different signature.
@@end

@@q id=c-l-m1-5-2 module=m1 type=single difficulty=1 critical=false exam=false lesson=l-m1-5 tracks=FOUNDATION refs=b01-07
Stem: Can an administrator read a stored secret?
- [x] No. Secrets are write-only.
- [ ] Yes, with MFA.
- [ ] Yes, in the audit log.
Why: Secrets can be replaced but never read back.
@@end

@@q id=q-m2-001 module=m2 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b02-02
Stem: Why do public services hold no database credentials?
- [x] So a break-in there cannot open the database.
- [ ] To save memory.
- [ ] Because databases are public.
Why: Separation limits damage.
@@end

@@q id=q-m2-002 module=m2 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b05-06
Stem: An application is assigned to
- [x] exactly one wallet.
- [ ] any wallet at payment time.
- [ ] several wallets.
Why: This keeps money destinations unambiguous.
@@end

@@q id=q-m2-003 module=m2 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b02-05
Stem: Who may see AML cases?
- [x] COMPLIANCE, MLRO and, for audit, SECURITY_ADMIN.
- [ ] Everyone.
- [ ] Only merchants.
Why: Confidentiality zones apply.
@@end

@@q id=q-m2-004 module=m2 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b02-03
Stem: Where does a payment's amount come from?
- [x] The payment link in our database.
- [ ] The customer's browser.
- [ ] A phone call.
Why: Never take an amount from a message or screenshot.
@@end

@@q id=q-m2-005 module=m2 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b03-02
Stem: You have no authority for a screen. What does that mean?
- [x] You cannot access it; do not use a colleague's account.
- [ ] You may use it read-only.
- [ ] It will open after a day.
Why: No authority means no access.
@@end

@@q id=q-m2-006 module=m2 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b05-06
Stem: A merchant's wallet balance is
- [x] calculated from ledger lines.
- [ ] typed in by Finance.
- [ ] stored and editable.
Why: This prevents it drifting from the books.
@@end

@@q id=c-l-m2-1-1 module=m2 type=single difficulty=1 critical=false exam=false lesson=l-m2-1 tracks=FOUNDATION refs=b02-02
Stem: Which part holds database credentials and the master key?
- [x] Only the core.
- [ ] The checkout.
- [ ] The merchant portal.
Why: Public services hold none, so a break-in there does not open the database.
@@end

@@q id=c-l-m2-1-2 module=m2 type=single difficulty=1 critical=false exam=false lesson=l-m2-1 tracks=FOUNDATION refs=b02-03
Stem: When is the ledger entry written for a successful payment?
- [x] In the same transaction as the success.
- [ ] The next morning.
- [ ] When the merchant asks.
Why: Success and posting happen together or not at all.
@@end

@@q id=c-l-m2-2-1 module=m2 type=single difficulty=1 critical=false exam=false lesson=l-m2-2 tracks=FOUNDATION refs=b05-06
Stem: How many wallets does an application have?
- [x] Exactly one.
- [ ] Any number.
- [ ] None until approved.
Why: This makes it unambiguous where a payment's money goes.
@@end

@@q id=c-l-m2-2-2 module=m2 type=single difficulty=1 critical=false exam=false lesson=l-m2-2 tracks=FOUNDATION refs=b05-07
Stem: Can staff see a merchant's API token?
- [x] No. It is shown once to the merchant.
- [ ] Yes, masked.
- [ ] Yes, on the Merchants screen.
Why: We store only a fingerprint.
@@end

@@q id=c-l-m2-3-1 module=m2 type=single difficulty=1 critical=false exam=false lesson=l-m2-3 tracks=FOUNDATION refs=b02-05
Stem: What may SUPPORT see about a suspended merchant?
- [x] That it is suspended, never why.
- [ ] The full reason.
- [ ] The screening result.
Why: AML data is confidential.
@@end

@@q id=c-l-m2-3-2 module=m2 type=single difficulty=1 critical=false exam=false lesson=l-m2-3 tracks=FOUNDATION refs=b02-05
Stem: What does the Double-Check Rule mean?
- [x] The core re-checks identity, role and rules even for requests from our own admin program.
- [ ] Every click is made twice.
- [ ] Two screens show the same data.
Why: No service is trusted blindly.
@@end

@@q id=q-m3-001 module=m3 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b04-01
Stem: Why does the platform require two people for sensitive changes?
- [x] It catches mistakes and stops one person acting alone.
- [ ] To slow the work.
- [ ] Because managers prefer it.
Why: It also creates a clear record of who proposed and who approved.
@@end

@@q id=q-m3-002 module=m3 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b04-01
Stem: You made a request. Your colleague offers to click Approve without reading to speed things up. You
- [x] refuse; that defeats the control.
- [ ] accept, since it is allowed by the system.
- [ ] accept if the amount is small.
Why: A blind approval is the same offence as approving your own work.
@@end

@@q id=q-m3-003 module=m3 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b04-02
Stem: Which change needs two people?
- [x] Changing a merchant's risk tier.
- [ ] Changing a merchant's logo.
- [ ] Changing your theme.
Why: Risk tier is sensitive.
@@end

@@q id=q-m3-004 module=m3 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b04-03
Stem: How long does an approval request last?
- [x] Seven days.
- [ ] One hour.
- [ ] Forever.
Why: After that it returns to draft.
@@end

@@q id=q-m3-005 module=m3 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b04-04
Stem: Which must be approved BEFORE it happens?
- [x] Reinstating a suspended merchant.
- [ ] Suspending a merchant.
- [ ] Pausing a failing route.
Why: Risk-increasing actions need approval first.
@@end

@@q id=q-m3-006 module=m3 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b04-04
Stem: Within what time must an emergency suspension be ratified?
- [x] 24 hours.
- [ ] 1 hour.
- [ ] 30 days.
Why: By the MLRO or a different Compliance user.
@@end

@@q id=q-m3-007 module=m3 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b04-06
Stem: Which reason is acceptable for approving a bank change?
- [x] Checked the bank letter; holder matches the legal name; old account closed per written request.
- [ ] ok
- [ ] per boss
Why: A good reason says what you checked and why.
@@end

@@q id=q-m3-008 module=m3 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b04-03
Stem: A request shows a record that changed after it was made. The checker should
- [x] not approve; the maker creates a new request.
- [ ] approve to save time.
- [ ] edit the request.
Why: Stale requests must be re-made from current values.
@@end

@@q id=q-m3-009 module=m3 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b03-06
Stem: Before approving you should
- [x] say in one sentence what you are approving and why.
- [ ] check how many people are waiting.
- [ ] approve then read.
Why: If you cannot explain it, reject or ask.
@@end

@@q id=q-m3-010 module=m3 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b04-07
Stem: Your approval will be
- [x] recorded with your name and reason in an uneditable audit trail.
- [ ] private.
- [ ] deleted after a year.
Why: Everything you do is recorded.
@@end

@@q id=q-m3-011 module=m3 type=single difficulty=3 critical=false exam=true tracks=FOUNDATION refs=b04-05
Stem: Who is the typical checker for an AML case resolution?
- [x] The MLRO.
- [ ] An operator.
- [ ] Support.
Why: Compliance proposes; the MLRO approves; only then does money move.
@@end

@@q id=q-m3-101 module=m3 type=single difficulty=2 critical=false exam=true tracks=SECURITY_ADMIN refs=b04-05
Stem: A gateway version going LIVE is typically proposed by GATEWAY_ADMIN and approved by
- [x] SECURITY_ADMIN.
- [ ] OPERATOR.
- [ ] SUPPORT.
Why: Credentials, routes and payout-bank edits too.
@@end

@@q id=q-m3-102 module=m3 type=single difficulty=2 critical=false exam=true tracks=SECURITY_ADMIN refs=b04-05
Stem: A staff role or authority change is proposed by SECURITY_ADMIN and approved by
- [x] a different SECURITY_ADMIN.
- [ ] the same one.
- [ ] FINANCE.
Why: Sessions are revoked.
@@end

@@q id=q-m3-103 module=m3 type=single difficulty=2 critical=false exam=true tracks=SECURITY_ADMIN refs=b04-04
Stem: Which reduces risk and may be immediate?
- [x] Pausing a route.
- [ ] Releasing held money.
- [ ] A refund.
Why: Asymmetry principle.
@@end

@@q id=q-m3-104 module=m3 type=single difficulty=2 critical=false exam=true tracks=SECURITY_ADMIN refs=b04-07
Stem: Your approvals are
- [x] part of an immutable audit trail.
- [ ] private.
- [ ] editable by you.
Why: Every action is recorded.
@@end

@@q id=q-m3-105 module=m3 type=single difficulty=2 critical=false exam=true tracks=SECURITY_ADMIN refs=b04-05
Stem: An AML rule change is approved by
- [x] the MLRO.
- [ ] Support.
- [ ] a merchant.
Why: Velocity rules by SECURITY_ADMIN or FINANCE.
@@end

@@q id=c-l-m3-1-1 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-1 tracks=FOUNDATION refs=b04-01
Stem: Who may approve a request you made?
- [x] A different person.
- [ ] You, after waiting a day.
- [ ] Anyone, including you.
Why: The system blocks self-approval and asking a colleague to click blindly is the same offence.
@@end

@@q id=c-l-m3-1-2 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-1 tracks=FOUNDATION refs=b04-01
Stem: What does pressing Approve do?
- [x] Approves and executes the change.
- [ ] Only records your opinion.
- [ ] Sends the request back.
Why: Approving also executes.
@@end

@@q id=c-l-m3-2-1 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-2 tracks=FOUNDATION refs=b04-02
Stem: Which is a sensitive field?
- [x] A merchant's payout bank details.
- [ ] A display name.
- [ ] A logo.
Why: Sensitive fields change money flow, compliance or attack surface.
@@end

@@q id=c-l-m3-2-2 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-2 tracks=FOUNDATION refs=b04-03
Stem: A request is out of date because the record changed. What now?
- [x] The maker creates a new request from the current values.
- [ ] The checker approves it anyway.
- [ ] It is executed automatically.
Why: Stale requests are never applied.
@@end

@@q id=c-l-m3-3-1 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-3 tracks=FOUNDATION refs=b04-04
Stem: Which action may be immediate and ratified afterwards?
- [x] Suspending a merchant.
- [ ] Reinstating a merchant.
- [ ] Paying a cash-out.
Why: Risk-reducing actions may be immediate; risk-increasing ones need approval first.
@@end

@@q id=c-l-m3-3-2 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-3 tracks=FOUNDATION refs=b04-04
Stem: Nobody ratifies an emergency suspension in 24 hours. What happens?
- [x] An alert fires and the suspension stays in force.
- [ ] It lifts automatically.
- [ ] The merchant is deleted.
Why: The system fails safe.
@@end

@@q id=c-l-m3-4-1 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-4 tracks=FOUNDATION refs=b04-06
Stem: Which is a good reason?
- [x] Checked bank letter: holder matches legal name; approving.
- [ ] ok
- [ ] As discussed.
Why: A reason says what you checked and why you decided.
@@end

@@q id=c-l-m3-4-2 module=m3 type=single difficulty=1 critical=false exam=false lesson=l-m3-4 tracks=FOUNDATION refs=b04-07
Stem: Can an audit record be edited?
- [x] No. It is append-only.
- [ ] Yes, by managers.
- [ ] Yes, within a day.
Why: Everything you do is recorded and cannot be altered.
@@end

@@q id=q-m4-001 module=m4 type=single difficulty=1 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b05-01
Stem: Which state allows new live payments?
- [x] ACTIVE
- [ ] PENDING
- [ ] SUSPENDED
Why: Pending merchants may use sandbox only.
@@end

@@q id=q-m4-002 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-03
Stem: A bank letter names a different company from the merchant's legal name. Best action?
- [x] Request information, asking for a letter in the legal name, mentioning nothing else.
- [ ] Approve and note it.
- [ ] Reject and say it was a compliance issue.
Why: Check 6 fails; a mismatch also forces a second approver.
@@end

@@q id=q-m4-003 module=m4 type=single difficulty=3 critical=false exam=true tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-03
Stem: Which is NOT among the seven checks?
- [x] The applicant's social-media following.
- [ ] Beneficial owners identified.
- [ ] Payout account belongs to the business.
Why: The seven checks are identity, business exists, owners, screening, category and volume, payout account, risk tier.
@@end

@@q id=q-m4-004 module=m4 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,COMPLIANCE refs=b05-03
Stem: An applicant is rejected because of a screening result. What reason code may the applicant see?
- [x] POLICY
- [ ] SCREENING_HIT
- [ ] SANCTIONS
Why: Revealing codes are shown as POLICY.
@@end

@@q id=q-m4-005 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-03
Stem: Which of these requires a second reviewer under the default risk-based policy?
- [x] A payout account that does not match the legal name.
- [ ] A normal bakery application with clear screening and low risk.
- [ ] An applicant who uploaded a clear registry certificate.
Why: A payout mismatch forces a second reviewer; a clean low-risk case does not.
@@end

@@q id=q-m4-006 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE refs=b05-04
Stem: The same registry certificate file appears under two unrelated merchants. You
- [x] note it, require a second reviewer and escalate; do not accuse anyone.
- [ ] approve both.
- [ ] tell the applicant they are suspected of fraud.
Why: Duplicates do not reject automatically; they add review.
@@end

@@q id=q-m4-007 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE refs=b05-04
Stem: A document you cannot read arrives. You
- [x] do not accept it.
- [ ] accept it to meet the deadline.
- [ ] accept after a phone call.
Why: Never accept an unreadable or edited document.
@@end

@@q id=q-m4-008 module=m4 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,SUPPORT refs=b05-09
Stem: A merchant calls asking why it was suspended for AML reasons. The safe answer
- [x] is the generic restriction sentence, nothing more.
- [ ] is the screening result.
- [ ] is the case number.
Why: AML reasons are never given to merchants.
@@end

@@q id=q-m4-009 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b05-07
Stem: A merchant says its API token leaked. You tell them to
- [x] revoke it in their portal and create a new one.
- [ ] send you the token.
- [ ] wait.
Why: Support never sees token values.
@@end

@@q id=q-m4-010 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-08
Stem: Reinstating a merchant requires
- [x] prior approval by a different Compliance or MLRO user.
- [ ] an emergency action by one person.
- [ ] nothing.
Why: Reinstatement increases risk; it is never an emergency.
@@end

@@q id=q-m4-011 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-08
Stem: A merchant is closed only when
- [x] the balance is zero and no dispute is open.
- [ ] it asks.
- [ ] it has a negative balance.
Why: A negative balance blocks closure.
@@end

@@q id=q-m4-012 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-02
Stem: An applicant has been inactive for 30 days. The join request
- [x] expires.
- [ ] is approved.
- [ ] is rejected.
Why: INFO_REQUESTED pauses the deadline; inactivity expires it.
@@end

@@q id=q-m4-013 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,COMPLIANCE refs=b05-10
Stem: A required document expired more than 30 days ago. The merchant is
- [x] suspended with reason KYB_EXPIRED unless two people extend it.
- [ ] closed.
- [ ] promoted.
Why: Re-verification is periodic.
@@end

@@q id=q-m4-014 module=m4 type=single difficulty=3 critical=false exam=true tracks=OPERATOR,SUPPORT refs=b05-06
Stem: A link's rail list may
- [x] only narrow the application's list.
- [ ] widen it.
- [ ] replace it.
Why: Links never widen the application's list.
@@end

@@q id=q-m4-015 module=m4 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b05-01
Stem: PENDING_REVIEW is
- [x] an approval state, not a merchant state.
- [ ] a merchant state.
- [ ] a payment state.
Why: Do not confuse them.
@@end

@@q id=q-m4-016 module=m4 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-05
Stem: Screening at onboarding is not CLEAR. As an operator you
- [x] do not approve and do not discuss it; Compliance decides.
- [ ] approve with a note.
- [ ] tell the applicant.
Why: Confidential; fail closed.
@@end

@@q id=q-m4-017 module=m4 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b05-04
Stem: Who counts as a beneficial owner?
- [x] A person holding 25% or more, or controlling the business.
- [ ] Only the largest shareholder.
- [ ] Any employee.
Why: If nobody reaches the threshold, the most senior manager is recorded as controller.
@@end

@@q id=q-m4-018 module=m4 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,SUPPORT,FINANCE,COMPLIANCE refs=b05-09
Stem: A caller says he is the owner and asks for the merchant's bank details. You
- [x] verify identity through the portal first; a phone call is not proof.
- [ ] read them.
- [ ] ask for the token.
Why: Identify the person before discussing anything.
@@end

@@q id=c-l-m4-1-1 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-1 tracks=OPERATOR,SUPPORT,FINANCE refs=b05-01
Stem: Which merchant state blocks new payments but keeps the balance?
- [x] SUSPENDED
- [ ] ACTIVE
- [ ] PENDING
Why: A suspended merchant cannot take new payments or cash out; the balance is kept.
@@end

@@q id=c-l-m4-1-2 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-1 tracks=OPERATOR,SUPPORT,FINANCE refs=b05-01
Stem: Which is a valid suspension reason code?
- [x] KYB_EXPIRED
- [ ] BORED
- [ ] SLOW
Why: Reasons: AML, FRAUD, KYB_EXPIRED, COMMISSION_CEILING, MERCHANT_REQUEST, OTHER.
@@end

@@q id=c-l-m4-2-1 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-2 tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-03
Stem: How many checks does a join request review have?
- [x] Seven
- [ ] Three
- [ ] Twelve
Why: All seven must be completed and recorded.
@@end

@@q id=c-l-m4-2-2 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-2 tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-03
Stem: When you request information from an applicant you must NOT mention
- [x] screening.
- [ ] the missing document.
- [ ] the deadline pause.
Why: Never reveal screening to an applicant.
@@end

@@q id=c-l-m4-3-1 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-3 tracks=OPERATOR,COMPLIANCE refs=b05-04
Stem: The default beneficial-owner threshold is
- [x] 25%
- [ ] 5%
- [ ] 75%
Why: Anyone holding 25% or more, or who controls the business.
@@end

@@q id=c-l-m4-3-2 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-3 tracks=OPERATOR,COMPLIANCE refs=b05-05
Stem: Screening returns ERROR at onboarding. What happens?
- [x] The request cannot be approved until screening succeeds.
- [ ] It is approved.
- [ ] It is rejected automatically.
Why: Fail closed.
@@end

@@q id=c-l-m4-4-1 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-4 tracks=OPERATOR,SUPPORT refs=b05-09
Stem: A caller asks you to change a merchant's bank account. You say
- [x] it needs a written request in the portal and second-person approval.
- [ ] I will do it now.
- [ ] Send it by chat.
Why: Sensitive changes cannot be done by phone.
@@end

@@q id=c-l-m4-4-2 module=m4 type=single difficulty=1 critical=false exam=false lesson=l-m4-4 tracks=OPERATOR,SUPPORT refs=b05-07
Stem: A POS screen idle for how long is disconnected?
- [x] 15 minutes
- [ ] 1 minute
- [ ] A week
Why: The payment continues on the server.
@@end

@@q id=q-m5-001 module=m5 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-03
Stem: An attempt is UNKNOWN. The customer asks to pay again. You
- [x] say do not pay again; we are confirming.
- [ ] allow a second payment.
- [ ] mark it failed.
Why: A second payment could be a double charge.
@@end

@@q id=q-m5-002 module=m5 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,SUPPORT,FINANCE,GATEWAY_ADMIN refs=b07-03
Stem: A confirm step times out. Resulting status?
- [x] UNKNOWN
- [ ] FAILED
- [ ] CANCELLED
Why: Uncertainty never becomes failure.
@@end

@@q id=q-m5-003 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE refs=b07-03
Stem: The partner offers no status question for an UNKNOWN payment. Best action?
- [x] Note both references and wait for the statement or contact the partner.
- [ ] Press Inquire repeatedly.
- [ ] Mark it failed.
Why: The truth comes from the statement or evidence from the partner.
@@end

@@q id=q-m5-004 module=m5 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-03
Stem: Which action is forbidden for UNKNOWN?
- [x] Re-sending an OTP.
- [ ] Opening the case.
- [ ] Reading the step log.
Why: Re-sending may start a second payment.
@@end

@@q id=q-m5-005 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-02
Stem: Which state releases the link slot?
- [x] EXPIRED
- [ ] UNKNOWN
- [ ] VERIFYING
Why: Only FAILED, EXPIRED, CANCELLED and BLOCKED release it.
@@end

@@q id=q-m5-006 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-02
Stem: BLOCKED. What does the customer see?
- [x] A generic message only.
- [ ] The AML rule that fired.
- [ ] The merchant's risk tier.
Why: Never explain the real reason.
@@end

@@q id=q-m5-007 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-12
Stem: A customer insists they paid; our status is VERIFYING. You
- [x] say it is in progress and not to pay again.
- [ ] confirm payment.
- [ ] refund.
Why: Read the status, not the claim.
@@end

@@q id=q-m5-008 module=m5 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,SUPPORT refs=b07-12
Stem: A customer shows a phone screen saying Paid. You
- [x] read the platform's status; the screen proves nothing.
- [ ] confirm it.
- [ ] release goods.
Why: Customer screens can be faked.
@@end

@@q id=q-m5-009 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN refs=b07-08
Stem: A verified webhook says paid; an inquiry says failed. What opens?
- [x] A P1 CONFLICT case, with nothing posted.
- [ ] A P3 note.
- [ ] A refund.
Why: Neither trusted source wins.
@@end

@@q id=q-m5-010 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE refs=b07-08
Stem: Late success on an already-paid single-use link. Where does the money go?
- [x] SUSPENSE, with a refund drafted.
- [ ] The wallet.
- [ ] TREASURY.
Why: It must not credit twice.
@@end

@@q id=q-m5-011 module=m5 type=single difficulty=1 critical=false exam=true tracks=OPERATOR,FINANCE refs=b07-04
Stem: You start working a case. First, you
- [x] assign it to yourself.
- [ ] resolve it.
- [ ] close it.
Why: This avoids two people acting on the same item.
@@end

@@q id=q-m5-012 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE refs=b07-04
Stem: You lack evidence to resolve a case. You
- [x] leave it open and escalate.
- [ ] resolve it as failed.
- [ ] resolve it as succeeded.
Why: Leaving it open is safe.
@@end

@@q id=q-m5-013 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE refs=b07-09
Stem: After an outage you run Bulk Inquiry for
- [x] the affected route and period.
- [ ] all routes forever.
- [ ] only successful payments.
Why: It sends many calls.
@@end

@@q id=q-m5-014 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT refs=b07-07
Stem: A customer says the OTP never arrived. You tell them to
- [x] wait for the countdown and use resend once.
- [ ] press resend repeatedly.
- [ ] pay again.
Why: Repeated resends are limited.
@@end

@@q id=q-m5-015 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,GATEWAY_ADMIN refs=b07-05
Stem: An unknown webhook address spikes. You tell
- [x] the Security Admin.
- [ ] nobody.
- [ ] the customer.
Why: It may be an attack or a partner mix-up.
@@end

@@q id=q-m5-016 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-06
Stem: A single-use link has an UNKNOWN attempt. Another customer tries to pay it. They see
- [x] Payment in progress.
- [ ] Success.
- [ ] A discount.
Why: The slot stays reserved.
@@end

@@q id=q-m5-017 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,GATEWAY_ADMIN refs=b07-06
Stem: The default grace window for late confirmations is
- [x] 24 hours.
- [ ] 5 minutes.
- [ ] 30 days.
Why: Unlimited for partners that cannot be asked.
@@end

@@q id=q-m5-018 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-01
Stem: Which reference belongs to the partner?
- [x] Provider reference
- [ ] Reference
- [ ] Gateway reference
Why: Provider reference is the partner's own transaction number.
@@end

@@q id=q-m5-019 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-02
Stem: After a successful payment, a partial refund is executed. State?
- [x] PARTIALLY_REFUNDED
- [ ] REFUNDED
- [ ] FAILED
Why: Then REFUNDED when whole.
@@end

@@q id=q-m5-020 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,COMPLIANCE refs=b07-04
Stem: A MISMATCH case means
- [x] the partner's amount or currency differs from ours.
- [ ] a late success.
- [ ] an unknown payment.
Why: Beyond tolerance the money is held in SUSPENSE.
@@end

@@q id=q-m5-021 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-12
Stem: You may promise a customer
- [x] what you will check and when you will reply.
- [ ] a refund time.
- [ ] that it will succeed.
Why: Never promise outcomes you do not control.
@@end

@@q id=q-m5-022 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT refs=b07-11
Stem: A POS cashier asks if a customer paid. You tell them to
- [x] wait for SUCCEEDED before releasing goods.
- [ ] release now.
- [ ] trust the customer's phone.
Why: Only verified payments count.
@@end

@@q id=q-m5-023 module=m5 type=single difficulty=3 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE,GATEWAY_ADMIN refs=b07-03
Stem: What proportion of UNKNOWN attempts should resolve within 24 hours?
- [x] 95%
- [ ] 50%
- [ ] 100% instantly
Why: This is the service target.
@@end

@@q id=q-m5-024 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN refs=b07-05
Stem: A webhook arrives before the payment record is saved. The platform
- [x] retries finding the payment for about a minute.
- [ ] deletes it.
- [ ] pays twice.
Why: The raw message was stored first.
@@end

@@q id=q-m5-025 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,FINANCE refs=b07-12
Stem: Status SUCCEEDED but the customer says unpaid. You say
- [x] we confirm your payment; the merchant is credited.
- [ ] we have no record.
- [ ] pay again.
Why: Read the status.
@@end

@@q id=q-m5-026 module=m5 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,GATEWAY_ADMIN refs=b07-07
Stem: A timeout during OTP confirm is treated as
- [x] UNKNOWN, never a wrong code.
- [ ] a wrong code.
- [ ] success.
Why: The same code is never resubmitted.
@@end

@@q id=c-l-m5-1-1 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-1 tracks=OPERATOR,SUPPORT,FINANCE,COMPLIANCE,GATEWAY_ADMIN refs=b07-01
Stem: Which reference do you quote to a partner?
- [x] Our reference or the provider reference.
- [ ] The customer's name.
- [ ] The customer's phone.
Why: References, never names.
@@end

@@q id=c-l-m5-1-2 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-1 tracks=OPERATOR,SUPPORT,FINANCE,COMPLIANCE,GATEWAY_ADMIN refs=b07-01
Stem: The pinned configuration of an attempt
- [x] never changes for that attempt.
- [ ] updates whenever a gateway is edited.
- [ ] is chosen by the customer.
Why: It records the version, route, credentials and profile it started with.
@@end

@@q id=c-l-m5-2-1 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-2 tracks=OPERATOR,SUPPORT,FINANCE refs=b07-02
Stem: How many payment states are there?
- [x] 14
- [ ] 13
- [ ] 5
Why: The code has 14.
@@end

@@q id=c-l-m5-2-2 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-2 tracks=OPERATOR,SUPPORT,FINANCE refs=b07-02
Stem: Which state keeps the link slot reserved?
- [x] UNKNOWN
- [ ] FAILED
- [ ] CANCELLED
Why: The first payment might have succeeded.
@@end

@@q id=c-l-m5-3-1 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-3 tracks=OPERATOR,SUPPORT,FINANCE,GATEWAY_ADMIN refs=b07-03
Stem: First action on an UNKNOWN payment?
- [x] Press Inquire once and read the step log.
- [ ] Mark it failed.
- [ ] Ask the customer to pay again.
Why: Inquire is read-only and cannot move money.
@@end

@@q id=c-l-m5-3-2 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-3 tracks=OPERATOR,SUPPORT,FINANCE,GATEWAY_ADMIN refs=b07-03
Stem: You may resolve UNKNOWN by hand when
- [x] you have evidence from the partner and a second person.
- [ ] it is older than a day.
- [ ] the customer insists.
Why: Evidence plus two people.
@@end

@@q id=c-l-m5-4-1 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-4 tracks=OPERATOR,FINANCE refs=b07-04
Stem: Which case kind is priority 1 by definition?
- [x] CONFLICT
- [ ] MANUAL_REVIEW
- [ ] UNMATCHED_STATEMENT
Why: Two trusted sources disagree; nothing is posted.
@@end

@@q id=c-l-m5-4-2 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-4 tracks=OPERATOR,FINANCE refs=b07-09
Stem: Bulk Inquiry should be limited to
- [x] the affected route and period.
- [ ] every route.
- [ ] the customer's choice.
Why: It sends many calls to the partner.
@@end

@@q id=c-l-m5-5-1 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-5 tracks=OPERATOR,GATEWAY_ADMIN refs=b07-07
Stem: How many wrong OTP tries by default?
- [x] 3
- [ ] 1
- [ ] 10
Why: The third wrong code fails the payment.
@@end

@@q id=c-l-m5-5-2 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-5 tracks=OPERATOR,GATEWAY_ADMIN refs=b07-06
Stem: A late confirmation arrives; the single-use link was already paid by another attempt. The money goes to
- [x] SUSPENSE, with a refund drafted.
- [ ] the merchant's wallet.
- [ ] TREASURY directly.
Why: It does not belong to anyone yet.
@@end

@@q id=c-l-m5-6-1 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-6 tracks=OPERATOR,SUPPORT,FINANCE refs=b07-12
Stem: The status is FAILED but the customer says money was deducted. You
- [x] say no confirmed payment, ask them to keep the receipt, and open a case.
- [ ] refund immediately.
- [ ] ask them to pay again.
Why: A late confirmation may still arrive; never refund on a call.
@@end

@@q id=c-l-m5-6-2 module=m5 type=single difficulty=1 critical=false exam=false lesson=l-m5-6 tracks=OPERATOR,SUPPORT,FINANCE refs=b07-08
Stem: A webhook says paid but the inquiry says failed. The payment
- [x] stays UNKNOWN with a P1 conflict case.
- [ ] becomes SUCCEEDED.
- [ ] becomes FAILED.
Why: Neither trusted source wins.
@@end

@@q id=q-m6-001 module=m6 type=single difficulty=1 critical=false exam=true tracks=OPERATOR,FINANCE refs=b08-01
Stem: Which statement is true of every journal entry?
- [x] Total debits equal total credits.
- [ ] Debits are always larger.
- [ ] Credits are always larger.
Why: Unbalanced entries are refused.
@@end

@@q id=q-m6-002 module=m6 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,FINANCE refs=b08-01
Stem: How do you correct a wrong ledger entry?
- [x] Add a new approved entry that offsets it.
- [ ] Edit the amount.
- [ ] Delete the entry.
Why: The ledger is append-only; nobody edits numbers.
@@end

@@q id=q-m6-003 module=m6 type=single difficulty=1 critical=false exam=true tracks=OPERATOR,FINANCE refs=b08-02
Stem: Which account holds money we owe a merchant?
- [x] MERCHANT_WALLET
- [ ] TREASURY
- [ ] PLATFORM_INCOME
Why: A wallet is what we owe, calculated from lines.
@@end

@@q id=q-m6-004 module=m6 type=single difficulty=1 critical=false exam=true tracks=OPERATOR,FINANCE refs=b08-02
Stem: Which account is our real money?
- [x] TREASURY
- [ ] SUSPENSE
- [ ] AML_HOLD
Why: Hold, reserve and suspense are not ours.
@@end

@@q id=q-m6-005 module=m6 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,FINANCE refs=b08-05
Stem: The ledger drift shows 12.5000. First action?
- [x] Treat as P1, tell your manager and Finance, do not cash out.
- [ ] Edit a number to balance.
- [ ] Wait a week.
Why: Automatic payouts stop and RB-04 applies.
@@end

@@q id=q-m6-006 module=m6 type=number difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-03
Stem: A 100.000 LYD link, 3.000 commission, PAYER_SURCHARGE. How much does the customer pay?
Answer: 103.0000
Why: Customer pays link plus commission.
@@end

@@q id=q-m6-007 module=m6 type=number difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-03
Stem: A 100.000 LYD link, 3.000 commission, SPLIT 50/50. How much does the customer pay?
Answer: 101.5000
Why: Half of the commission is added.
@@end

@@q id=q-m6-008 module=m6 type=number difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-03
Stem: A 100.000 LYD link, 3.000 commission, 0.800 gateway fee. Net revenue?
Answer: 2.2000
Why: Commission minus gateway fee.
@@end

@@q id=q-m6-009 module=m6 type=number difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-03
Stem: 250.000 LYD link, 2% commission, MERCHANT_ABSORBS. How much is the merchant credited?
Answer: 245.0000
Why: Commission is 5.0000; the merchant gets 245.0000.
@@end

@@q id=q-m6-010 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-03
Stem: Which commission profile is used first?
- [x] Merchant + application + rail.
- [ ] Platform default + rail.
- [ ] Any random one.
Why: The most specific live profile wins.
@@end

@@q id=q-m6-011 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-03
Stem: No live commission profile covers a rail at the amount. The customer
- [x] does not see that rail.
- [ ] pays zero commission.
- [ ] sees it with a warning.
Why: This is condition 3 of the visible-rails formula.
@@end

@@q id=q-m6-012 module=m6 type=number difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-04
Stem: Entry 2: 100 LYD, 3% commission, 0.8 fee. What is the total of the debits?
Answer: 100.8000
Why: Debit clearing 100 and gateway fee expense 0.8.
@@end

@@q id=q-m6-013 module=m6 type=number difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-04
Stem: Entry 3 settlement: 100 LYD, fee 0.8. How much is debited to TREASURY?
Answer: 99.2000
Why: The partner paid us the net amount.
@@end

@@q id=q-m6-014 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-04
Stem: A repeated webhook cannot double-credit a merchant because
- [x] each entry is tied to its payment by a unique pair.
- [ ] webhooks never repeat.
- [ ] a human checks them.
Why: The database refuses a second entry.
@@end

@@q id=q-m6-015 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-04
Stem: An AML-held payment is confirmed. Which account receives the credit?
- [x] AML_HOLD
- [ ] MERCHANT_WALLET
- [ ] PLATFORM_INCOME
Why: No commission is recognised until release.
@@end

@@q id=q-m6-016 module=m6 type=single difficulty=2 critical=true exam=true tracks=FINANCE refs=b08-06
Stem: A statement lacks a payment we marked succeeded. The result is
- [x] MISSING_AT_GATEWAY, the most serious.
- [ ] MATCHED.
- [ ] DUPLICATE.
Why: We may have credited money we did not receive.
@@end

@@q id=q-m6-017 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-06
Stem: A statement line shows a payment we do not have. The result is
- [x] MISSING_LOCALLY.
- [ ] MATCHED.
- [ ] MISSING_AT_GATEWAY.
Why: It may be a late success or an UNKNOWN.
@@end

@@q id=q-m6-018 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-06
Stem: The statement is in Libya time; our system stores UTC. You
- [x] convert deliberately using the source's time zone setting.
- [ ] ignore it.
- [ ] edit the file dates.
Why: Time zones cause false mismatches.
@@end

@@q id=q-m6-019 module=m6 type=order difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-07
Stem: Put the cash-out steps in order.
1. Open the request and read the bank snapshot
2. Process the cash-out with its checklist
3. Make the real bank transfer
4. Mark it complete
5. A different Finance user approves and executes the subtraction
Why: Two different people; the wallet is subtracted only at the end.
@@end

@@q id=q-m6-020 module=m6 type=single difficulty=2 critical=true exam=true tracks=FINANCE refs=b08-07
Stem: A merchant has a negative balance and asks for a cash-out. You
- [x] refuse; it cannot cash out.
- [ ] pay half.
- [ ] pay it anyway.
Why: Negative balance blocks cash-out.
@@end

@@q id=q-m6-021 module=m6 type=single difficulty=3 critical=false exam=true tracks=FINANCE refs=b08-07
Stem: The merchant changed its bank account after requesting a cash-out. The payout goes to
- [x] the snapshot from request time.
- [ ] the new account.
- [ ] either account.
Why: Cash-outs keep the details they started with.
@@end

@@q id=q-m6-022 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-08
Stem: A refund can never exceed
- [x] the original payment.
- [ ] the wallet balance.
- [ ] the commission.
Why: Also check amount and currency.
@@end

@@q id=q-m6-023 module=m6 type=single difficulty=2 critical=true exam=true tracks=FINANCE refs=b08-08
Stem: An executed refund was for the wrong amount. You
- [x] propose an offsetting adjustment with a reason.
- [ ] edit the executed one.
- [ ] delete it.
Why: Executed adjustments are never edited.
@@end

@@q id=q-m6-024 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-08
Stem: You split one 2000 LYD refund into four 500 LYD refunds to avoid review. This is
- [x] forbidden.
- [ ] clever.
- [ ] allowed if documented.
Why: Splitting to avoid review is never allowed.
@@end

@@q id=q-m6-025 module=m6 type=single difficulty=2 critical=true exam=true tracks=FINANCE refs=b08-09
Stem: The system drafts a chargeback adjustment. Money moves
- [x] only after a human Finance checker approves.
- [ ] at once.
- [ ] after 24 hours.
Why: The system can never approve or execute.
@@end

@@q id=q-m6-026 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-09
Stem: A dispute's evidence deadline passes with no evidence. The dispute
- [x] becomes EXPIRED, treated as lost unless rules say otherwise.
- [ ] is won.
- [ ] disappears.
Why: Deadlines matter.
@@end

@@q id=q-m6-027 module=m6 type=number difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-13
Stem: Wallet holds 40; a 100 LYD chargeback with 3 LYD commission is approved and posts. Wallet after?
Answer: -57.0000
Why: Wallet minus the merchant share: 40 − 97 = −57 (allowed only within the ceiling).
@@end

@@q id=q-m6-028 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-13
Stem: A new merchant's negative-balance ceiling is zero. A chargeback exceeds the wallet. The adjustment
- [x] does not execute; a P1 case opens.
- [ ] posts.
- [ ] is rejected silently.
Why: Finance chooses to collect, net or suspend.
@@end

@@q id=q-m6-029 module=m6 type=single difficulty=3 critical=false exam=true tracks=FINANCE refs=b08-10
Stem: Settlement target MERCHANT_DIRECT means the partner pays
- [x] the merchant; we book only our commission receivable.
- [ ] us.
- [ ] nobody.
Why: Entry 6.
@@end

@@q id=q-m6-030 module=m6 type=order difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-10
Stem: Order the settlement cycle for platform clearing.
1. Payment confirmed (clearing debited, wallet credited)
2. Statement arrives
3. Settlement sweep to treasury
4. Fee true-up if the actual fee differs
Why: Entries 2, 3, 4 in sequence.
@@end

@@q id=q-m6-031 module=m6 type=single difficulty=2 critical=false exam=true tracks=FINANCE refs=b08-11
Stem: Which is a merchant NEVER shown?
- [x] Gateway costs and our margin.
- [ ] Its own gross.
- [ ] Its own net.
Why: Merchants see only their own figures.
@@end

@@q id=q-m6-032 module=m6 type=single difficulty=3 critical=false exam=true tracks=FINANCE refs=b08-05
Stem: Which is enforced by the database?
- [x] The approver of a request is never its maker.
- [ ] Every payment is fast.
- [ ] Every merchant is happy.
Why: Along with positive amounts, slot limits and one success per group.
@@end

@@q id=c-l-m6-1-1 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-1 tracks=OPERATOR,FINANCE refs=b08-01
Stem: In every journal entry
- [x] total debits equal total credits.
- [ ] debits exceed credits.
- [ ] credits exceed debits.
Why: Unbalanced entries are refused.
@@end

@@q id=c-l-m6-1-2 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-1 tracks=OPERATOR,FINANCE refs=b08-01
Stem: How is a mistake in the ledger fixed?
- [x] By a new approved entry that offsets it.
- [ ] By editing the number.
- [ ] By deleting the line.
Why: The ledger is append-only.
@@end

@@q id=c-l-m6-2-1 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-2 tracks=OPERATOR,FINANCE refs=b08-02
Stem: How many GL account kinds exist?
- [x] Eleven
- [ ] Ten
- [ ] Five
Why: GATEWAY_FEE_EXPENSE is the eleventh.
@@end

@@q id=c-l-m6-2-2 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-2 tracks=OPERATOR,FINANCE refs=b08-05
Stem: The ledger drift is expected to be
- [x] 0.0000 LYD
- [ ] small but positive
- [ ] whatever it is
Why: Any drift is a priority-1 incident.
@@end

@@q id=c-l-m6-3-1 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-3 tracks=FINANCE refs=b08-03
Stem: Commission is
- [x] what we charge the merchant.
- [ ] what the partner charges us.
- [ ] the customer's tip.
Why: Gateway fee is our cost.
@@end

@@q id=c-l-m6-3-2 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-3 tracks=FINANCE refs=b08-03
Stem: Under PAYER_SURCHARGE on a 100 LYD link with 3 LYD commission, the customer pays
- [x] 103
- [ ] 100
- [ ] 97
Why: The merchant gets the full 100.
@@end

@@q id=c-l-m6-4-1 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-4 tracks=FINANCE refs=b08-04
Stem: A repeated webhook cannot double-credit because
- [x] each entry has a unique pair tying it to its payment.
- [ ] webhooks are never repeated.
- [ ] a human checks each.
Why: The database refuses a second entry.
@@end

@@q id=c-l-m6-4-2 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-4 tracks=FINANCE refs=b08-04
Stem: An AML-held payment is posted to
- [x] AML_HOLD with no commission recognised.
- [ ] MERCHANT_WALLET.
- [ ] PLATFORM_INCOME.
Why: Commission is recognised on release.
@@end

@@q id=c-l-m6-5-1 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-5 tracks=FINANCE refs=b08-06
Stem: Which reconciliation result is the most serious?
- [x] MISSING_AT_GATEWAY
- [ ] MATCHED
- [ ] DUPLICATE
Why: We may have credited money we did not receive.
@@end

@@q id=c-l-m6-5-2 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-5 tracks=FINANCE refs=b08-06
Stem: If a statement file does not match, you
- [x] find the cause; never edit the file.
- [ ] edit the file.
- [ ] ignore the lines.
Why: Corrections are approved adjustments.
@@end

@@q id=c-l-m6-6-1 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-6 tracks=FINANCE refs=b08-07
Stem: Who approves the final subtraction of a cash-out?
- [x] A different Finance user from the one who processed it.
- [ ] The same user.
- [ ] The merchant.
Why: Two people.
@@end

@@q id=c-l-m6-6-2 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-6 tracks=FINANCE refs=b08-08
Stem: An executed adjustment was wrong. You
- [x] propose an offsetting adjustment.
- [ ] edit it.
- [ ] delete it.
Why: Executed adjustments are never edited.
@@end

@@q id=c-l-m6-7-1 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-7 tracks=FINANCE refs=b08-09
Stem: Who approves a drafted chargeback?
- [x] A human Finance checker.
- [ ] The system.
- [ ] The partner.
Why: The system drafts but never approves.
@@end

@@q id=c-l-m6-7-2 module=m6 type=single difficulty=1 critical=false exam=false lesson=l-m6-7 tracks=FINANCE refs=b08-13
Stem: A chargeback would breach the merchant's negative-balance ceiling. What happens?
- [x] It does not post and a P1 case opens.
- [ ] It posts anyway.
- [ ] It is dropped.
Why: Finance chooses to collect, net or suspend.
@@end

@@q id=q-m7-001 module=m7 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b09-08
Stem: A merchant asks, "Is my account restricted because of compliance?" You say
- [x] "Your account is currently restricted. Please contact the support address in your notice."
- [ ] "Yes, compliance flagged you."
- [ ] "No, it is a technical issue."
Why: Give only the generic wording; never confirm, deny or invent.
@@end

@@q id=q-m7-002 module=m7 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b09-01
Stem: Money laundering means
- [x] making money from crime look legitimate.
- [ ] moving money between our own accounts.
- [ ] refunding a payment.
Why: The three stages are placement, layering and integration.
@@end

@@q id=q-m7-003 module=m7 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b09-10
Stem: You notice a merchant's activity that looks suspicious. You
- [x] write the facts and tell Compliance the same day, telling nobody else.
- [ ] warn the merchant.
- [ ] discuss it in team chat.
Why: Do not confront; keep it confidential.
@@end

@@q id=q-m7-004 module=m7 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b09-08
Stem: Which word may you use with a merchant about its restriction?
- [x] Restricted
- [ ] Investigation
- [ ] Sanctions
Why: Never mention compliance, investigation, screening, sanctions, suspicious or report.
@@end

@@q id=q-m7-005 module=m7 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b09-08
Stem: Tipping-off is
- [x] telling someone, directly or by hint, that they are under suspicion.
- [ ] a type of tip.
- [ ] late reporting.
Why: It can be a crime.
@@end

@@q id=q-m7-006 module=m7 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b09-01
Stem: Who is a sensor in the AML programme?
- [x] Everyone.
- [ ] Only Compliance.
- [ ] Only the MLRO.
Why: Everyone reports what looks wrong.
@@end

@@q id=q-m7-101 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-02
Stem: Which layer runs on the payment path using cheap local checks?
- [x] Transaction-time check.
- [ ] Regulatory reporting.
- [ ] Records.
Why: Payments have a strict speed budget.
@@end

@@q id=q-m7-102 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-04
Stem: A velocity rule never
- [x] moves money.
- [ ] rejects.
- [ ] flags.
Why: Velocity actions are REJECT or FLAG.
@@end

@@q id=q-m7-103 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-04
Stem: Which AML action puts money into AML_HOLD?
- [x] HOLD
- [ ] FLAG
- [ ] CASE_ONLY
Why: FLAG opens a case with the payment proceeding.
@@end

@@q id=q-m7-104 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-04
Stem: Rules evaluate by
- [x] subject, so splitting across links does not avoid them.
- [ ] link only.
- [ ] rail only.
Why: Subjects: merchant, owner, payer identifier.
@@end

@@q id=q-m7-105 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-04
Stem: Who approves an AML rule change?
- [x] The MLRO.
- [ ] Support.
- [ ] The merchant.
Why: Two people always.
@@end

@@q id=q-m7-106 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-04
Stem: A dry-run of a proposed rule shows
- [x] how many holds and cases it would have created.
- [ ] the merchant's name.
- [ ] nothing.
Why: A noisy rule is caught first.
@@end

@@q id=q-m7-107 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-03
Stem: You mark a possible match FALSE_POSITIVE and suppress future matches. You must also
- [x] set an expiry date.
- [ ] delete the screening.
- [ ] tell the merchant.
Why: Suppression ends if identifying data changes.
@@end

@@q id=q-m7-108 module=m7 type=single difficulty=2 critical=true exam=true tracks=COMPLIANCE,MLRO refs=b09-03
Stem: Screening returns ERROR at onboarding. The request
- [x] cannot be approved until screening succeeds.
- [ ] is approved.
- [ ] is rejected.
Why: Fail closed.
@@end

@@q id=q-m7-109 module=m7 type=single difficulty=2 critical=true exam=true tracks=COMPLIANCE,MLRO refs=b09-03
Stem: A merchant is marked important by management and has a possible sanctions match. You
- [x] decide on evidence; importance is irrelevant; escalate if it may be real.
- [ ] mark it false.
- [ ] wait.
Why: Never mark false because the merchant is important.
@@end

@@q id=q-m7-110 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-03
Stem: Documents are sent to the screening provider
- [x] never; only fields needed for matching.
- [ ] always.
- [ ] on request.
Why: Privacy.
@@end

@@q id=q-m7-111 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-03
Stem: A new list update matches an active merchant. Cash-out is
- [x] restricted at once; payments continue unless CRITICAL.
- [ ] unaffected.
- [ ] paid faster.
Why: A case opens.
@@end

@@q id=q-m7-112 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-05
Stem: The deadline for a CRITICAL case is by default
- [x] 4 hours.
- [ ] 5 days.
- [ ] 1 month.
Why: HIGH is 1 business day.
@@end

@@q id=q-m7-113 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-05
Stem: A velocity FLAG and an AML rule hit on the same payment make the case
- [x] CRITICAL.
- [ ] LOW.
- [ ] MEDIUM.
Why: Correlated signals raise severity.
@@end

@@q id=q-m7-114 module=m7 type=single difficulty=2 critical=true exam=true tracks=COMPLIANCE,MLRO refs=b09-05
Stem: An analyst proposes releasing held money. Money moves
- [x] only after MLRO approval.
- [ ] immediately.
- [ ] after 7 days.
Why: Maker proposes; checker approves.
@@end

@@q id=q-m7-115 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-05
Stem: Release of an AML hold
- [x] recognises the commission as income at that point.
- [ ] returns money to the payer.
- [ ] posts nothing.
Why: Void and return is the other resolution.
@@end

@@q id=q-m7-116 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-05
Stem: A chargeback on an AML-held payment is processed
- [x] against the hold, not the wallet.
- [ ] against the wallet.
- [ ] ignored.
Why: Void and return.
@@end

@@q id=q-m7-117 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-06
Stem: If nobody ratifies an emergency suspension in 24 hours
- [x] an alert fires and it stays in force.
- [ ] it lifts.
- [ ] the merchant is closed.
Why: Fail safe.
@@end

@@q id=q-m7-118 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-06
Stem: Reinstating a restricted merchant is
- [x] never an emergency action.
- [ ] immediate.
- [ ] allowed by Support.
Why: It increases risk.
@@end

@@q id=q-m7-119 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-07
Stem: Which report type is always reviewed by a person?
- [x] SUSPICIOUS_ACTIVITY
- [ ] PERIODIC_RETURN
- [ ] LARGE_TRANSACTION
Why: Triggered by a case.
@@end

@@q id=q-m7-120 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-07
Stem: Until the regulator's requirements are confirmed in writing, the platform
- [x] works in internal-only mode and cannot file.
- [ ] files anyway.
- [ ] stops all payments.
Why: Rules stay PROVISIONAL.
@@end

@@q id=q-m7-121 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-07
Stem: A submitted report needs a correction. You
- [x] create a new linked report.
- [ ] edit the saved report.
- [ ] delete it.
Why: Saved reports are read-only.
@@end

@@q id=q-m7-122 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-08
Stem: Which people may see AML-confidential data?
- [x] COMPLIANCE, MLRO and, for audit, SECURITY_ADMIN.
- [ ] Everyone.
- [ ] SUPPORT.
Why: Every read is logged.
@@end

@@q id=q-m7-123 module=m7 type=single difficulty=2 critical=true exam=true tracks=COMPLIANCE,MLRO refs=b09-08
Stem: A rejection reason that could reveal screening is shown as
- [x] POLICY.
- [ ] SCREENING.
- [ ] SANCTIONS.
Why: Neutral wording.
@@end

@@q id=q-m7-124 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-08
Stem: May a merchant notification template contain AML variables?
- [x] No; it is checked when the template is saved.
- [ ] Yes.
- [ ] Yes if masked.
Why: Templates cannot contain AML variables.
@@end

@@q id=q-m7-125 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-09
Stem: Retention is by default
- [x] 5 years after the relationship ends.
- [ ] 30 days.
- [ ] forever.
Why: A setting to be confirmed.
@@end

@@q id=q-m7-126 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-09
Stem: A request to delete personal data during the retention period
- [x] does not override the regulatory period.
- [ ] deletes everything now.
- [ ] is ignored with no answer.
Why: Ledger entries remain; they hold no personal data.
@@end

@@q id=q-m7-127 module=m7 type=single difficulty=1 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-01
Stem: The three stages of laundering are
- [x] placement, layering, integration.
- [ ] start, middle, end.
- [ ] buy, sell, hold.
Why: A fake shop and quick cash-out is placement.
@@end

@@q id=q-m7-128 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-10
Stem: A colleague asks you to approve without reading. You
- [x] refuse and report it to Compliance or your manager.
- [ ] approve.
- [ ] ignore it.
Why: Report pressure to bypass controls.
@@end

@@q id=q-m7-129 module=m7 type=single difficulty=3 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-02
Stem: A rail with no status question has a lower AML threshold because
- [x] we cannot verify its payments easily.
- [ ] it is cheap.
- [ ] it is old.
Why: Rail-specific rules exist for such rails.
@@end

@@q id=q-m7-130 module=m7 type=single difficulty=2 critical=false exam=true tracks=COMPLIANCE,MLRO refs=b09-05
Stem: The system never
- [x] moves AML money without a human decision.
- [ ] opens cases.
- [ ] holds money.
Why: The system screens, flags, holds and records; it does not decide to accuse.
@@end

@@q id=c-l-m7-1-1 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-1 tracks=FOUNDATION refs=b09-01
Stem: Which is a stage of money laundering?
- [x] Placement
- [ ] Promotion
- [ ] Reconciliation
Why: Placement, layering, integration.
@@end

@@q id=c-l-m7-1-2 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-1 tracks=FOUNDATION refs=b09-01
Stem: Who is a sensor for suspicious activity?
- [x] Everyone.
- [ ] Only the MLRO.
- [ ] Only the system.
Why: You report; Compliance investigates.
@@end

@@q id=c-l-m7-2-1 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-2 tracks=COMPLIANCE,MLRO refs=b09-04
Stem: Which rule type detects many payments just below a threshold?
- [x] STRUCTURING
- [ ] SINGLE_AMOUNT
- [ ] RAIL
Why: Splitting to avoid a threshold is structuring.
@@end

@@q id=c-l-m7-2-2 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-2 tracks=COMPLIANCE,MLRO refs=b09-04
Stem: Loosening an AML rule
- [x] never skips review.
- [ ] is immediate.
- [ ] needs no approval.
Why: Only tightening may be immediate.
@@end

@@q id=c-l-m7-3-1 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-3 tracks=COMPLIANCE,MLRO refs=b09-03
Stem: Decide a possible match as a different person. Disposition?
- [x] FALSE_POSITIVE, with a written rationale.
- [ ] TRUE_MATCH.
- [ ] Ignore it.
Why: Always record evidence.
@@end

@@q id=c-l-m7-3-2 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-3 tracks=COMPLIANCE,MLRO refs=b09-05
Stem: Who approves an AML case resolution?
- [x] The MLRO.
- [ ] The analyst.
- [ ] The merchant.
Why: Money moves only after approval.
@@end

@@q id=c-l-m7-4-1 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-4 tracks=COMPLIANCE,MLRO refs=b09-07
Stem: A PROVISIONAL reporting rule can
- [x] never produce a live filing.
- [ ] file after a day.
- [ ] file with approval.
Why: The database refuses it.
@@end

@@q id=c-l-m7-4-2 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-4 tracks=COMPLIANCE,MLRO refs=b09-06
Stem: A confirmed sanctions match on an active merchant leads to
- [x] emergency suspension and frozen cash-out.
- [ ] a polite email.
- [ ] no action.
Why: A suspicious-activity draft is created.
@@end

@@q id=c-l-m7-5-1 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-5 tracks=FOUNDATION refs=b09-08
Stem: A merchant asks if it is under investigation. You say
- [x] only the generic restriction sentence, and tell Compliance.
- [ ] yes.
- [ ] no.
Why: Never confirm, deny or hint.
@@end

@@q id=c-l-m7-5-2 module=m7 type=single difficulty=1 critical=false exam=false lesson=l-m7-5 tracks=FOUNDATION refs=b09-10
Stem: You notice something suspicious. First step?
- [x] Write down the facts and tell Compliance the same day.
- [ ] Warn the merchant.
- [ ] Post it in chat.
Why: Keep it confidential.
@@end

@@q id=q-m8-001 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-01
Stem: Which is NOT a gateway kind?
- [x] SANDBOX
- [ ] DIRECT
- [ ] AGGREGATOR
Why: Kinds: DIRECT, AGGREGATOR, NATIVE_ADAPTER, INTERNAL.
@@end

@@q id=q-m8-002 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-01
Stem: A new version is promoted at noon. A payment that started at 11:59 finishes on
- [x] the old version.
- [ ] the new version.
- [ ] neither.
Why: Each attempt is pinned.
@@end

@@q id=q-m8-003 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-01
Stem: A gateway has neither a signed webhook nor a status question. Its risk class is
- [x] HIGH_RISK.
- [ ] NORMAL.
- [ ] RETIRED.
Why: Going live needs a signed executive risk acceptance.
@@end

@@q id=q-m8-004 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,GATEWAY_ADMIN refs=b06-02
Stem: In an OTP rail, which step is the money step?
- [x] Confirm.
- [ ] Start.
- [ ] Resend.
Why: A timeout there is UNKNOWN.
@@end

@@q id=q-m8-005 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-02
Stem: Redirect payments: the customer closes the browser. Can they still have paid?
- [x] Yes.
- [ ] No.
- [ ] Only on Fridays.
Why: The return is only a hint.
@@end

@@q id=q-m8-006 module=m8 type=number difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-03
Stem: How many engine phases are there?
Answer: 10
Why: Ten: CREDENTIAL_CHECK, PRE_INITIATE, INITIATE, SUBMIT, VERIFY, CANCEL, REFUND, VOID, CAPTURE, SETTLEMENT_FETCH.
@@end

@@q id=q-m8-007 module=m8 type=single difficulty=3 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-03
Stem: A value taken from an earlier answer on the FIRST step is
- [x] rejected by the validator.
- [ ] allowed.
- [ ] encrypted.
Why: There is no earlier answer yet.
@@end

@@q id=q-m8-008 module=m8 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-03
Stem: The retry boundary says a money step is never retried after
- [x] a timeout, dropped connection or server error.
- [ ] a wrong OTP only.
- [ ] a success.
Why: From our side lost requests and lost replies look identical.
@@end

@@q id=q-m8-009 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-08
Stem: Status rules are evaluated
- [x] in order; first match wins.
- [ ] randomly.
- [ ] all at once.
Why: No match on a money step is UNKNOWN.
@@end

@@q id=q-m8-010 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-08
Stem: Which error class counts toward the circuit breaker?
- [x] GATEWAY_FAULT.
- [ ] RETRYABLE_OTP.
- [ ] LIMIT_EXCEEDED.
Why: Customer mistakes do not.
@@end

@@q id=q-m8-011 module=m8 type=number difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN refs=b06-04
Stem: A gateway wants whole dirhams. 10.50 LYD is sent as (digits only)
Answer: 10500
Why: 10.50 LYD is 10500 dirhams.
@@end

@@q id=q-m8-012 module=m8 type=number difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN refs=b06-04
Stem: 76.255 LYD to a two-decimal gateway with NEAREST rounding is
Answer: 76.26
Why: Half rounds up: 76.26.
@@end

@@q id=q-m8-013 module=m8 type=number difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN refs=b06-04
Stem: 76.255 LYD to a two-decimal gateway with DOWN rounding is
Answer: 76.25
Why: Truncated to 76.25.
@@end

@@q id=q-m8-014 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN refs=b06-05
Stem: A rail with a PAN field needs
- [x] a PCI scope review before going live.
- [ ] nothing.
- [ ] a bigger font.
Why: Card numbers never touch a database or log.
@@end

@@q id=q-m8-015 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN refs=b06-06
Stem: Signature never matches; the partner's key is hexadecimal and ours is treated as text. Fix?
- [x] Set key encoding to HEX.
- [ ] Retry more.
- [ ] Ignore the signature.
Why: Wrong key encoding is the most common cause.
@@end

@@q id=q-m8-016 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN refs=b06-06
Stem: Which is NOT a common cause of signature failure?
- [x] The customer's phone model.
- [ ] Wrong field order.
- [ ] Wrong output case.
Why: Key encoding, field order and set, output case.
@@end

@@q id=q-m8-017 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-07
Stem: Which confirmation is a hint only?
- [x] Browser callback.
- [ ] Signed webhook.
- [ ] Our status question.
Why: Browser messages can be faked.
@@end

@@q id=q-m8-018 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-07
Stem: The five facts verified before trusting a confirmation are
- [x] status, reference, amount, currency, environment.
- [ ] name, phone, address, age, city.
- [ ] time, date, month, year, day.
Why: All five must match.
@@end

@@q id=q-m8-019 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN refs=b06-09
Stem: A credential set whose settlement target is MERCHANT_DIRECT means the partner pays
- [x] the merchant.
- [ ] us.
- [ ] nobody.
Why: We record only our commission as owed.
@@end

@@q id=q-m8-020 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-09
Stem: A secret works only for
- [x] the hosts listed for that gateway.
- [ ] any host.
- [ ] any user.
Why: Secrets are host-pinned.
@@end

@@q id=q-m8-021 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN refs=b06-10
Stem: A rollback version is named
- [x] when a version is promoted.
- [ ] never.
- [ ] after an outage.
Why: It is a required gate.
@@end

@@q id=q-m8-022 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-11
Stem: A route that is DRAINING
- [x] finishes running payments and takes no new ones.
- [ ] takes all new payments.
- [ ] is deleted.
Why: Status values: ACTIVE, PAUSED, DRAINING.
@@end

@@q id=q-m8-023 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-12
Stem: A merchant's customers cannot see Sadad on a 3000 LYD link; the route maximum is 2000. Which visible-rails condition fails?
- [x] Within limits.
- [ ] Currency.
- [ ] Application list.
Why: Condition 6: the amount is outside the route's limits.
@@end

@@q id=q-m8-024 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-12
Stem: Edfali's direct route is nearly at its daily cap. A small amount fits, a larger one does not. Which condition?
- [x] Within limits and daily cap.
- [ ] Maintenance window.
- [ ] Currency.
Why: Condition 6 includes the daily cap.
@@end

@@q id=q-m8-025 module=m8 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-12
Stem: Sadad vanishes only between 02:00 and 03:00. Which condition?
- [x] Maintenance window or scope.
- [ ] Credential verified.
- [ ] Commission profile.
Why: Condition 7.
@@end

@@q id=q-m8-026 module=m8 type=number difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-13
Stem: How many steps does the Add-a-Gateway wizard have?
Answer: 8
Why: Eight.
@@end

@@q id=q-m8-027 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-13
Stem: Which wizard step contains the Simulator and Approval?
- [x] Step 8.
- [ ] Step 1.
- [ ] Step 4.
Why: Submitting step 8 opens the safeguard.
@@end

@@q id=q-m8-028 module=m8 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-14
Stem: An AI-generated spec passes all four verification layers. Is the gateway live?
- [x] No. It is a draft needing the credential check, gates and a second person.
- [ ] Yes.
- [ ] Yes after a day.
Why: Passed checks are not approval.
@@end

@@q id=q-m8-029 module=m8 type=single difficulty=3 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-14
Stem: Which step types cannot be imported by AI import?
- [x] WAIT, ASSERT, BRANCH.
- [ ] HTTP.
- [ ] COMPUTE.
Why: Add them in the wizard's flow editor.
@@end

@@q id=q-m8-030 module=m8 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-14
Stem: What should you give an AI assistant about credentials?
- [x] Only their names, or dummy sandbox values.
- [ ] The live secret.
- [ ] The master key.
Why: Real secrets are typed into the platform.
@@end

@@q id=q-m8-031 module=m8 type=number difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-16
Stem: Gate 3 contract test: 10.50 LYD for a dirham-integer gateway must give
Answer: 10500
Why: 10500.
@@end

@@q id=q-m8-032 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-16
Stem: Who must read the gate results before approving?
- [x] The approver.
- [ ] Nobody.
- [ ] The merchant.
Why: Never approve without reading them.
@@end

@@q id=q-m8-033 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-17
Stem: Why are money steps never retried automatically? (safeguard)
- [x] To avoid paying twice.
- [ ] To save time.
- [ ] To reduce cost.
Why: Safeguard 7.
@@end

@@q id=q-m8-034 module=m8 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-02
Stem: A weak confirmation channel is saved without must-inquire. The wizard
- [x] refuses to save.
- [ ] saves it.
- [ ] emails you.
Why: Save-time safety checks.
@@end

@@q id=q-m8-035 module=m8 type=single difficulty=3 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-15
Stem: A gateway built only from vendor pages has evidence level
- [x] UNVERIFIED.
- [ ] VERIFIED.
- [ ] INTERNAL.
Why: It needs extra evidence or a signed risk acceptance.
@@end

@@q id=q-m8-036 module=m8 type=single difficulty=1 critical=false exam=true tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-15
Stem: Our own first-party wallet rail is
- [x] NeomPay.
- [ ] Sadad.
- [ ] Moamalat.
Why: It posts straight to treasury.
@@end

@@q id=c-l-m8-1-1 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-1 tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-01
Stem: Can a live gateway be edited in place?
- [x] No. Editing creates a new draft version.
- [ ] Yes, by Gateway Admins.
- [ ] Yes, in the wizard.
Why: Versions are immutable.
@@end

@@q id=c-l-m8-1-2 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-1 tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-11
Stem: A rail that was ever used is
- [x] blocked, never deleted.
- [ ] deleted.
- [ ] renamed.
Why: History must remain.
@@end

@@q id=c-l-m8-2-1 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-2 tracks=OPERATOR,GATEWAY_ADMIN refs=b06-07
Stem: A return-URL says success. It is
- [x] a hint; we ask the partner.
- [ ] proof.
- [ ] ignored forever.
Why: Hints make us ask.
@@end

@@q id=c-l-m8-2-2 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-2 tracks=OPERATOR,GATEWAY_ADMIN refs=b06-07
Stem: Weak channels are forced to
- [x] ask the partner before anything is believed.
- [ ] skip checks.
- [ ] pay faster.
Why: must_inquire.
@@end

@@q id=c-l-m8-3-1 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-3 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-03
Stem: A step that moves money must have retry policy
- [x] NEVER.
- [ ] SAFE.
- [ ] SAFE_WITH_COOLDOWN.
Why: Retrying could pay twice.
@@end

@@q id=c-l-m8-3-2 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-3 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-08
Stem: No status rule matches on a money step. Result?
- [x] UNKNOWN.
- [ ] FAILED.
- [ ] SUCCEEDED.
Why: When we do not understand we do not guess.
@@end

@@q id=c-l-m8-4-1 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-4 tracks=GATEWAY_ADMIN refs=b06-04
Stem: A hex secret treated as text makes the signature
- [x] completely different.
- [ ] slightly different.
- [ ] the same.
Why: Key encoding matters.
@@end

@@q id=c-l-m8-4-2 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-4 tracks=GATEWAY_ADMIN refs=b06-05
Stem: A full card number is kept
- [x] in memory only for one call.
- [ ] in the database.
- [ ] in logs.
Why: It needs a PCI scope review.
@@end

@@q id=c-l-m8-5-1 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-5 tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-12
Stem: How many conditions must hold for a rail to be visible?
- [x] Nine.
- [ ] Two.
- [ ] One.
Why: Walk down the table.
@@end

@@q id=c-l-m8-5-2 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-5 tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-11
Stem: What trips the circuit breaker?
- [x] Partner faults, not customer mistakes.
- [ ] Wrong OTPs.
- [ ] Large amounts.
Why: Customer mistakes never count.
@@end

@@q id=c-l-m8-6-1 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-6 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-14
Stem: May you paste a real secret into the AI assistant?
- [x] Never.
- [ ] Yes if masked.
- [ ] Yes if sandbox only.
Why: Give only credential names.
@@end

@@q id=c-l-m8-6-2 module=m8 type=single difficulty=1 critical=false exam=false lesson=l-m8-6 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-16
Stem: How many go-live gates are there?
- [x] Twelve.
- [ ] Five.
- [ ] Twenty.
Why: All must pass.
@@end

@@q id=q-m9-001 module=m9 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b10-09
Stem: You approved the wrong row. First action?
- [x] Stop and tell your manager.
- [ ] Click more to undo it.
- [ ] Say nothing.
Why: Do not edit history; the correction is a new approved entry.
@@end

@@q id=q-m9-002 module=m9 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b10-07
Stem: You pasted a token into a team chat. What now?
- [x] Tell the Security Admin immediately.
- [ ] Delete it and say nothing.
- [ ] Wait for a reply.
Why: A leaked secret is usable until replaced.
@@end

@@q id=q-m9-003 module=m9 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b10-08
Stem: At shift end you have an open approval you half reviewed. You
- [x] leave a clear handover note.
- [ ] leave it silently.
- [ ] approve it quickly.
Why: No half-finished decisions without a note.
@@end

@@q id=q-m9-101 module=m9 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-01
Stem: Which action may be immediate during an incident?
- [x] Pausing a failing route.
- [ ] Resuming it.
- [ ] Releasing held money.
Why: Pausing reduces risk.
@@end

@@q id=q-m9-102 module=m9 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-01
Stem: Two people work the same item. Which principle was broken?
- [x] One person leads.
- [ ] Write as you go.
- [ ] Hand over.
Why: Agree who does what.
@@end

@@q id=q-m9-103 module=m9 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-02
Stem: A circuit breaker is open on a route. You
- [x] do not re-enable it while the partner fails; tell the Gateway Admin.
- [ ] re-enable it.
- [ ] edit the gateway.
Why: The platform moves traffic to the next route.
@@end

@@q id=q-m9-104 module=m9 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-03
Stem: A valid signature arrives from an unlisted IP address. Likely cause?
- [x] The partner moved servers, or an attack.
- [ ] A holiday.
- [ ] A bug in the customer's phone.
Why: Confirm with the partner in writing.
@@end

@@q id=q-m9-105 module=m9 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-04
Stem: A backlog of UNKNOWN payments. You first
- [x] find the pattern by route and period.
- [ ] mark all failed.
- [ ] ask customers to retry.
Why: Then Bulk Inquiry the affected route.
@@end

@@q id=q-m9-106 module=m9 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-04
Stem: You mass-resolve UNKNOWN cases by hand without evidence. This is
- [x] forbidden.
- [ ] efficient.
- [ ] normal after an outage.
Why: Every manual resolution is a two-person decision with evidence.
@@end

@@q id=q-m9-107 module=m9 type=single difficulty=2 critical=true exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-05
Stem: RB-04 ledger drift: you
- [x] never edit a number; corrections are approved adjustments.
- [ ] edit the number.
- [ ] hide it.
Why: Resume payouts only when zero and your manager agrees.
@@end

@@q id=q-m9-108 module=m9 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-05
Stem: MISSING_AT_GATEWAY lines appear during drift. Priority?
- [x] The most serious: we may have credited money not received.
- [ ] The least.
- [ ] Ignore.
Why: Inspect each line.
@@end

@@q id=q-m9-109 module=m9 type=single difficulty=2 critical=false exam=true tracks=FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-06
Stem: Rotating a secret with overlap means
- [x] both versions work for a time.
- [ ] downtime.
- [ ] nothing changes.
Why: No payments fail while the partner switches.
@@end

@@q id=q-m9-110 module=m9 type=single difficulty=3 critical=false exam=true tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-02
Stem: A payment started before the breaker opened. It
- [x] finishes on its original settings.
- [ ] is cancelled.
- [ ] is refunded.
Why: Running payments are not disturbed; some may become UNKNOWN.
@@end

@@q id=q-m9-111 module=m9 type=single difficulty=2 critical=false exam=true tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-08
Stem: The next shift needs
- [x] what is open, what you tried, what you wait for, anything risky, promises made.
- [ ] nothing.
- [ ] your password.
Why: Never hand over a secret.
@@end

@@q id=q-m9-112 module=m9 type=single difficulty=3 critical=false exam=true tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-03
Stem: After the new signing secret is approved, stored messages can be
- [x] replayed without asking the partner to resend.
- [ ] deleted.
- [ ] ignored.
Why: Raw bytes are kept.
@@end

@@q id=c-l-m9-1-1 module=m9 type=single difficulty=1 critical=false exam=false lesson=l-m9-1 tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-01
Stem: The first incident principle is
- [x] Stop the harm first, understand later.
- [ ] Find who to blame.
- [ ] Wait.
Why: Pausing is reversible; a wrong payment is not.
@@end

@@q id=c-l-m9-1-2 module=m9 type=single difficulty=1 critical=false exam=false lesson=l-m9-1 tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-03
Stem: Signature failures spike. You must NOT
- [x] accept unsigned messages to get things moving.
- [ ] tell the Gateway Admin.
- [ ] check the inbox.
Why: That is what an attacker wants.
@@end

@@q id=c-l-m9-2-1 module=m9 type=single difficulty=1 critical=false exam=false lesson=l-m9-2 tracks=FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-05
Stem: Ledger drift stops
- [x] automatic payouts.
- [ ] logins.
- [ ] sandbox.
Why: Resume only when the drift is zero.
@@end

@@q id=c-l-m9-2-2 module=m9 type=single difficulty=1 critical=false exam=false lesson=l-m9-2 tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-06
Stem: A credential set turns FAILING. The route is
- [x] removed from selection.
- [ ] promoted.
- [ ] deleted.
Why: Replace the secret with two-person approval and run the credential check.
@@end

@@q id=c-l-m9-3-1 module=m9 type=single difficulty=1 critical=false exam=false lesson=l-m9-3 tracks=FOUNDATION refs=b10-09
Stem: You made a mistake. First step?
- [x] Stop and tell your manager.
- [ ] Click more to hide it.
- [ ] Wait.
Why: Reporting quickly is never punished.
@@end

@@q id=c-l-m9-3-2 module=m9 type=single difficulty=1 critical=false exam=false lesson=l-m9-3 tracks=FOUNDATION refs=b10-08
Stem: What belongs in a handover note?
- [x] What is open, what you tried, what you wait for, risks, promises.
- [ ] Your password.
- [ ] Nothing.
Why: Never hand over a secret.
@@end

@@q id=q-m10-001 module=m10 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b11-02
Stem: An email with a login page link arrives "from IT". You
- [x] do not click; type the address yourself and report it.
- [ ] click and log in.
- [ ] forward it to everyone.
Why: Fake links are a common trick.
@@end

@@q id=q-m10-002 module=m10 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b11-04
Stem: To ask a colleague about a payment you send
- [x] the reference only.
- [ ] the customer's name and phone.
- [ ] a screenshot with the token.
Why: Quote references, not personal data.
@@end

@@q id=q-m10-003 module=m10 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b11-03
Stem: Where may you use the Back Office?
- [x] From the office network or approved VPN.
- [ ] From any café.
- [ ] From a shared computer.
Why: It is LAN-only by design.
@@end

@@q id=q-m10-004 module=m10 type=single difficulty=2 critical=false exam=true tracks=FOUNDATION refs=b11-05
Stem: A merchant offers you a gift for faster approval. You
- [x] refuse and report it.
- [ ] accept if small.
- [ ] accept and approve.
Why: Do not accept gifts or favours; report pressure.
@@end

@@q id=q-m10-005 module=m10 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b11-03
Stem: A colleague is locked out and asks to use your login for five minutes. You
- [x] refuse; ask the Security Admin.
- [ ] allow it once.
- [ ] share your password but not your code.
Why: Never share credentials.
@@end

@@q id=q-m10-006 module=m10 type=single difficulty=1 critical=false exam=true tracks=FOUNDATION refs=b11-04
Stem: Masked data such as 091*****78 should
- [x] stay masked; do not try to reveal it.
- [ ] be unmasked if you ask nicely.
- [ ] be copied for reference.
Why: It is masked on purpose.
@@end

@@q id=q-m10-101 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-01
Stem: Which host never shares an address with the core?
- [x] The database host.
- [ ] The checkout host.
- [ ] The admin host.
Why: A rule that never changes.
@@end

@@q id=q-m10-102 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-01
Stem: Who may connect to the core's port?
- [x] Only the three edge hosts.
- [ ] The internet.
- [ ] Any office PC.
Why: Mutual TLS also applies.
@@end

@@q id=q-m10-103 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-02
Stem: Why is the Back Office LAN-only?
- [x] An attacker would first need to get inside the network.
- [ ] To save bandwidth.
- [ ] Because of colours.
Why: It is never reachable from the internet.
@@end

@@q id=q-m10-104 module=m10 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-03
Stem: Each edge host receives
- [x] its own client certificate and key only.
- [ ] all keys.
- [ ] the authority's private key.
Why: A compromised checkout cannot impersonate admin or merchant.
@@end

@@q id=q-m10-105 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-04
Stem: Only the core holds
- [x] database credentials and the master key.
- [ ] the checkout key.
- [ ] the SSH password of everyone.
Why: Edges never receive them.
@@end

@@q id=q-m10-106 module=m10 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-04
Stem: deploy.env should
- [x] never be committed to a repository.
- [ ] be committed.
- [ ] be pasted into chat.
Why: It contains secrets.
@@end

@@q id=q-m10-107 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-05
Stem: In the twelve-step deployment, the end-to-end check fails. The tool
- [x] stops with an error, leaves the new release current and keeps the previous release on disk for a manual rollback.
- [ ] returns to the previous release automatically.
- [ ] deletes the previous release.
Why: There is no automatic rollback. Going back is a manual action by an operator.
@@end

@@q id=q-m10-108 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-05
Stem: Before database changes, a deployment
- [x] takes a compressed backup.
- [ ] deletes the database.
- [ ] does nothing.
Why: Backups are kept protected.
@@end

@@q id=q-m10-109 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-06
Stem: Fake Rails in production requires
- [x] explicit switches; production must leave them off.
- [ ] nothing.
- [ ] a phone call.
Why: It is protected by guards.
@@end

@@q id=q-m10-110 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-07
Stem: Rollback means
- [x] pointing the current link at the previous release and restarting the backend services from that release's folder.
- [ ] rebuilding the release.
- [ ] editing the database.
Why: Releases are immutable. A plain restart would reuse the new release's path, and database changes only go forward.
@@end

@@q id=q-m10-111 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-08
Stem: Payment timers live in
- [x] the database, so a crash does not lose them.
- [ ] memory.
- [ ] the browser.
Why: Workers pick up due items.
@@end

@@q id=q-m10-112 module=m10 type=single difficulty=3 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-07
Stem: The ledger integrity target is
- [x] 100%, zero drift.
- [ ] 90%.
- [ ] 99%.
Why: Service objectives are in b12-07.
@@end

@@q id=q-m10-113 module=m10 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-09,b12-10
Stem: On the Backups screen **Last backup** is Passed (from 02:00 UTC), but **WAL archive lag** is 4,200 s (Critical, threshold 300 s) and one storage target is Failed. What is the real risk?
- [ ] There is no risk, because the 02:00 backup passed.
- [x] Recent changes are not safely archived, and unarchived WAL piles up on the database disk until archiving resumes.
- [ ] Every older backup in the bucket has been deleted.
Why: A passed nightly backup says nothing about the last hours. High archive lag means a disaster now would lose more than a few seconds, and the database keeps what it could not deliver.
@@end

@@q id=q-m10-114 module=m10 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-10
Stem: A restore drill ends Drill failed. Double-entry zero drift and Sharded balance parity show Passed, but Audit hash chain shows Failed. What do you do?
- [ ] Ignore it, because the money checks passed.
- [ ] Delete the audit database so the next drill passes.
- [x] Treat it as a priority-1 incident: escalate to the Security Admin, keep every backup and do not alter audit records.
Why: A failed audit chain means an audit row may be changed, damaged or missing. Backups are the evidence, so they must be kept.
@@end

@@q id=q-m10-115 module=m10 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-11
Stem: Why does lowering **Full retention days** need a second Security Admin?
- [x] So one compromised or mistaken account cannot shorten the history that recovery and investigations depend on.
- [ ] Because cron expressions must be typed by two people at the same time.
- [ ] Because the backup daemon cannot store retention settings.
Why: Policy changes use maker-checker (`BACKUP_POLICY`), and the checker must be a different Security Admin.
@@end

@@q id=q-m10-116 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-10
Stem: What does a restore drill do to the production database?
- [ ] It restores the latest backup over production to prove it works.
- [ ] It pauses production for a few minutes so the checks are exact.
- [x] Nothing: it restores into an isolated scratch cluster with archiving switched off, then destroys that cluster.
Why: The scratch cluster listens on the loopback address only and cannot write into the real archive, so production is never touched.
@@end

@@q id=q-m10-117 module=m10 type=single difficulty=2 critical=false exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-11
Stem: You click **Run backup now** while a restore drill is already running. What happens?
- [ ] The drill is cancelled and the backup starts at once.
- [ ] Both run at the same time to save time.
- [x] The backup is queued and runs after the drill, in order.
Why: Only one backup or drill job runs at a time; extra requests wait in order, and a repeated request with the same Idempotency-Key is not run twice.
@@end

@@q id=c-l-m10-1-1 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-1 tracks=FOUNDATION refs=b11-02
Stem: Someone phones asking for your one-time code. You
- [x] refuse and report it.
- [ ] give it.
- [ ] give half.
Why: Nobody legitimate asks.
@@end

@@q id=c-l-m10-1-2 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-1 tracks=FOUNDATION refs=b11-03
Stem: Where may you use the Back Office?
- [x] Office network or approved VPN.
- [ ] Any café.
- [ ] A shared PC.
Why: It is LAN-only by design.
@@end

@@q id=c-l-m10-2-1 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-2 tracks=FOUNDATION refs=b11-04
Stem: Which is safe to send in chat about a payment?
- [x] The reference.
- [ ] The customer's phone number.
- [ ] A token.
Why: Quote references, not personal data.
@@end

@@q id=c-l-m10-2-2 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-2 tracks=FOUNDATION refs=b11-05
Stem: A merchant offers a gift. You
- [x] refuse and report.
- [ ] accept.
- [ ] accept later.
Why: Never accept gifts or favours.
@@end

@@q id=c-l-m10-3-1 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-3 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-03
Stem: Where does the certificate authority's private key stay?
- [x] On the deployment workstation.
- [ ] On every server.
- [ ] On the checkout host.
Why: The core gets only the authority's public certificate.
@@end

@@q id=c-l-m10-3-2 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-3 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-06
Stem: Fake Rails must
- [x] never run in production.
- [ ] run in production.
- [ ] hold live secrets.
Why: It imitates payment companies for drills.
@@end

@@q id=c-l-m10-4-1 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-4 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-09
Stem: Which mechanism lets the platform recover changes made hours after the last scheduled backup?
- [x] Continuously archived WAL replayed on top of the full and delta backups (point-in-time recovery).
- [ ] Asking merchants to re-enter the day's payments.
- [ ] Clearing the browser cache in reverse.
Why: Archived WAL records every change between backups, so recovery can be replayed to a chosen moment.
@@end

@@q id=c-l-m10-4-2 module=m10 type=single difficulty=2 critical=false exam=false lesson=l-m10-4 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-10
Stem: Which three checks must pass in the scratch cluster for a restore drill to pass?
- [x] Double-entry zero drift, Sharded balance parity and Audit hash chain.
- [ ] CPU under 50 percent, disk under 50 percent and ten active merchants.
- [ ] Checkout logo loaded, Arabic translation present and an email sent.
Why: The drill runs exactly these three invariant checks, signs the report and destroys the scratch cluster.
@@end


## III-D. Exam blueprints

@@exam id=exam-foundation track=FOUNDATION
```json
{
 "id": "exam-foundation",
 "track": "FOUNDATION",
 "questionCount": 24,
 "passPercent": 80,
 "timeLimitMinutes": 60,
 "composition": [
  {
   "module": "m0",
   "count": 2
  },
  {
   "module": "m1",
   "count": 5
  },
  {
   "module": "m2",
   "count": 3
  },
  {
   "module": "m3",
   "count": 6
  },
  {
   "module": "m7",
   "count": 3
  },
  {
   "module": "m9",
   "count": 2
  },
  {
   "module": "m10",
   "count": 3
  }
 ],
 "criticalPick": 5,
 "cooldownMinutes": 30
}
```
@@end

@@exam id=exam-operator track=OPERATOR
```json
{
 "id": "exam-operator",
 "track": "OPERATOR",
 "questionCount": 28,
 "passPercent": 80,
 "timeLimitMinutes": 75,
 "composition": [
  {
   "module": "m4",
   "count": 5
  },
  {
   "module": "m5",
   "count": 11
  },
  {
   "module": "m6",
   "count": 2
  },
  {
   "module": "m8",
   "count": 3
  },
  {
   "module": "m9",
   "count": 7
  }
 ],
 "criticalPick": 6,
 "cooldownMinutes": 30
}
```
@@end

@@exam id=exam-support track=SUPPORT
```json
{
 "id": "exam-support",
 "track": "SUPPORT",
 "questionCount": 18,
 "passPercent": 80,
 "timeLimitMinutes": 50,
 "composition": [
  {
   "module": "m4",
   "count": 4
  },
  {
   "module": "m5",
   "count": 11
  },
  {
   "module": "m8",
   "count": 3
  }
 ],
 "criticalPick": 4,
 "cooldownMinutes": 30
}
```
@@end

@@exam id=exam-finance track=FINANCE
```json
{
 "id": "exam-finance",
 "track": "FINANCE",
 "questionCount": 28,
 "passPercent": 80,
 "timeLimitMinutes": 75,
 "composition": [
  {
   "module": "m4",
   "count": 2
  },
  {
   "module": "m5",
   "count": 5
  },
  {
   "module": "m6",
   "count": 16
  },
  {
   "module": "m9",
   "count": 5
  }
 ],
 "criticalPick": 6,
 "cooldownMinutes": 30
}
```
@@end

@@exam id=exam-compliance track=COMPLIANCE
```json
{
 "id": "exam-compliance",
 "track": "COMPLIANCE",
 "questionCount": 28,
 "passPercent": 80,
 "timeLimitMinutes": 75,
 "composition": [
  {
   "module": "m4",
   "count": 9
  },
  {
   "module": "m7",
   "count": 19
  }
 ],
 "criticalPick": 6,
 "cooldownMinutes": 30
}
```
@@end

@@exam id=exam-mlro track=MLRO
```json
{
 "id": "exam-mlro",
 "track": "MLRO",
 "questionCount": 24,
 "passPercent": 80,
 "timeLimitMinutes": 65,
 "composition": [
  {
   "module": "m4",
   "count": 3
  },
  {
   "module": "m7",
   "count": 21
  }
 ],
 "criticalPick": 5,
 "cooldownMinutes": 30
}
```
@@end

@@exam id=exam-gateway-admin track=GATEWAY_ADMIN
```json
{
 "id": "exam-gateway-admin",
 "track": "GATEWAY_ADMIN",
 "questionCount": 28,
 "passPercent": 80,
 "timeLimitMinutes": 75,
 "composition": [
  {
   "module": "m5",
   "count": 4
  },
  {
   "module": "m8",
   "count": 18
  },
  {
   "module": "m9",
   "count": 4
  },
  {
   "module": "m10",
   "count": 2
  }
 ],
 "criticalPick": 6,
 "cooldownMinutes": 30
}
```
@@end

@@exam id=exam-security-admin track=SECURITY_ADMIN
```json
{
 "id": "exam-security-admin",
 "track": "SECURITY_ADMIN",
 "questionCount": 24,
 "passPercent": 80,
 "timeLimitMinutes": 65,
 "composition": [
  {
   "module": "m3",
   "count": 4
  },
  {
   "module": "m8",
   "count": 7
  },
  {
   "module": "m9",
   "count": 4
  },
  {
   "module": "m10",
   "count": 9
  }
 ],
 "criticalPick": 5,
 "cooldownMinutes": 30
}
```
@@end


## III-E. Labs

### III-E.0 Lab scoring vectors

@@page id=lab-vectors title="Lab scoring vectors"
```json
{
 "vectors": [
  {
   "id": "LV1",
   "name": "choice correct",
   "task": {
    "kind": "choice",
    "points": 10,
    "options": [
     {
      "id": "a",
      "correct": true
     },
     {
      "id": "b",
      "correct": false
     }
    ]
   },
   "answer": {
    "selected": "a"
   },
   "expectedScore": "10",
   "criticalError": false
  },
  {
   "id": "LV2",
   "name": "choice wrong",
   "task": {
    "kind": "choice",
    "points": 10,
    "options": [
     {
      "id": "a",
      "correct": true
     },
     {
      "id": "b",
      "correct": false
     }
    ]
   },
   "answer": {
    "selected": "b"
   },
   "expectedScore": "0",
   "criticalError": false
  },
  {
   "id": "LV3",
   "name": "choice critical option",
   "task": {
    "kind": "choice",
    "points": 10,
    "options": [
     {
      "id": "a",
      "correct": true
     },
     {
      "id": "b",
      "correct": false,
      "critical": true
     }
    ]
   },
   "answer": {
    "selected": "b"
   },
   "expectedScore": "0",
   "criticalError": true
  },
  {
   "id": "LV4",
   "name": "multi 3 right 1 wrong of 5",
   "task": {
    "kind": "multi",
    "points": 10,
    "options": [
     {
      "id": "a",
      "correct": true
     },
     {
      "id": "b",
      "correct": true
     },
     {
      "id": "c",
      "correct": true
     },
     {
      "id": "d",
      "correct": true
     },
     {
      "id": "e",
      "correct": true
     },
     {
      "id": "f",
      "correct": false
     }
    ]
   },
   "answer": {
    "selected": [
     "a",
     "b",
     "c",
     "f"
    ]
   },
   "expectedScore": "4",
   "criticalError": false
  },
  {
   "id": "LV5",
   "name": "multi never below zero",
   "task": {
    "kind": "multi",
    "points": 10,
    "options": [
     {
      "id": "a",
      "correct": true
     },
     {
      "id": "b",
      "correct": true
     },
     {
      "id": "c",
      "correct": false
     },
     {
      "id": "d",
      "correct": false
     }
    ]
   },
   "answer": {
    "selected": [
     "c",
     "d"
    ]
   },
   "expectedScore": "0",
   "criticalError": false
  },
  {
   "id": "LV6",
   "name": "multi critical wrong",
   "task": {
    "kind": "multi",
    "points": 10,
    "criticalWrong": [
     "d"
    ],
    "options": [
     {
      "id": "a",
      "correct": true
     },
     {
      "id": "b",
      "correct": true
     },
     {
      "id": "c",
      "correct": false
     },
     {
      "id": "d",
      "correct": false
     }
    ]
   },
   "answer": {
    "selected": [
     "a",
     "b",
     "d"
    ]
   },
   "expectedScore": "5",
   "criticalError": true
  },
  {
   "id": "LV7",
   "name": "ledger 4 of 5 lines right and 1 extra cell",
   "task": {
    "kind": "ledger",
    "points": 15,
    "accounts": [
     "GATEWAY_CLEARING",
     "GATEWAY_FEE_EXPENSE",
     "MERCHANT_WALLET",
     "PLATFORM_INCOME",
     "GATEWAY_FEE_ACCRUAL",
     "TREASURY"
    ],
    "expected": [
     {
      "account": "GATEWAY_CLEARING",
      "side": "DR",
      "amount": "103.0000"
     },
     {
      "account": "GATEWAY_FEE_EXPENSE",
      "side": "DR",
      "amount": "0.8000"
     },
     {
      "account": "MERCHANT_WALLET",
      "side": "CR",
      "amount": "100.0000"
     },
     {
      "account": "PLATFORM_INCOME",
      "side": "CR",
      "amount": "3.0000"
     },
     {
      "account": "GATEWAY_FEE_ACCRUAL",
      "side": "CR",
      "amount": "0.8000"
     }
    ]
   },
   "answer": {
    "cells": {
     "GATEWAY_CLEARING": {
      "DR": "103"
     },
     "GATEWAY_FEE_EXPENSE": {
      "DR": "0.8"
     },
     "MERCHANT_WALLET": {
      "CR": "100"
     },
     "PLATFORM_INCOME": {
      "CR": "3"
     },
     "GATEWAY_FEE_ACCRUAL": {
      "CR": "0.9"
     },
     "TREASURY": {
      "DR": "5"
     }
    }
   },
   "expectedScore": "9",
   "criticalError": false,
   "note": "Matched lines: 4 (the accrual 0.9 is wrong). Extra non-zero cells: 1 (TREASURY). (4-1)/5 x 15 = 9."
  },
  {
   "id": "LV8",
   "name": "ledger perfect, balanced",
   "task": {
    "kind": "ledger",
    "points": 15,
    "accounts": [
     "TREASURY",
     "GATEWAY_FEE_ACCRUAL",
     "GATEWAY_CLEARING"
    ],
    "expected": [
     {
      "account": "TREASURY",
      "side": "DR",
      "amount": "99.2000"
     },
     {
      "account": "GATEWAY_FEE_ACCRUAL",
      "side": "DR",
      "amount": "0.8000"
     },
     {
      "account": "GATEWAY_CLEARING",
      "side": "CR",
      "amount": "100.0000"
     }
    ]
   },
   "answer": {
    "cells": {
     "TREASURY": {
      "DR": "99.20"
     },
     "GATEWAY_FEE_ACCRUAL": {
      "DR": "0.80"
     },
     "GATEWAY_CLEARING": {
      "CR": "100"
     }
    }
   },
   "expectedScore": "15",
   "criticalError": false
  },
  {
   "id": "LV9",
   "name": "order 4 of 6 positions right",
   "task": {
    "kind": "order",
    "points": 12,
    "correctOrder": [
     "a",
     "b",
     "c",
     "d",
     "e",
     "f"
    ]
   },
   "answer": {
    "order": [
     "a",
     "b",
     "c",
     "d",
     "f",
     "e"
    ]
   },
   "expectedScore": "8.0",
   "criticalError": false,
   "note": "Positions 1-4 are right; 5 and 6 are swapped: 4/6 x 12 = 8.0."
  },
  {
   "id": "LV10",
   "name": "order exact",
   "task": {
    "kind": "order",
    "points": 12,
    "correctOrder": [
     "a",
     "b",
     "c"
    ]
   },
   "answer": {
    "order": [
     "a",
     "b",
     "c"
    ]
   },
   "expectedScore": "12",
   "criticalError": false
  },
  {
   "id": "LV11",
   "name": "checklist 5 of 6 items right",
   "task": {
    "kind": "checklist",
    "points": 10,
    "items": [
     {
      "id": "1",
      "shouldTick": true
     },
     {
      "id": "2",
      "shouldTick": true
     },
     {
      "id": "3",
      "shouldTick": true
     },
     {
      "id": "4",
      "shouldTick": true
     },
     {
      "id": "5",
      "shouldTick": false
     },
     {
      "id": "6",
      "shouldTick": true
     }
    ]
   },
   "answer": {
    "ticked": [
     "1",
     "2",
     "3",
     "4",
     "5",
     "6"
    ]
   },
   "expectedScore": "8.3333",
   "criticalError": false
  },
  {
   "id": "LV12",
   "name": "checklist critical item ticked",
   "task": {
    "kind": "checklist",
    "points": 10,
    "criticalWrong": [
     "5"
    ],
    "items": [
     {
      "id": "1",
      "shouldTick": true
     },
     {
      "id": "5",
      "shouldTick": false
     }
    ]
   },
   "answer": {
    "ticked": [
     "1",
     "5"
    ]
   },
   "expectedScore": "5",
   "criticalError": true
  },
  {
   "id": "LV13",
   "name": "numeric exact",
   "task": {
    "kind": "numeric",
    "points": 10,
    "answer": "-57.0000",
    "tolerance": "0"
   },
   "answer": {
    "value": "-57"
   },
   "expectedScore": "10",
   "criticalError": false
  },
  {
   "id": "LV14",
   "name": "numeric wrong",
   "task": {
    "kind": "numeric",
    "points": 10,
    "answer": "10500",
    "tolerance": "0"
   },
   "answer": {
    "value": "10.5"
   },
   "expectedScore": "0",
   "criticalError": false
  },
  {
   "id": "LV15",
   "name": "hint costs one point",
   "task": {
    "kind": "choice",
    "points": 10,
    "options": [
     {
      "id": "a",
      "correct": true
     }
    ]
   },
   "answer": {
    "selected": "a",
    "hintUsed": true
   },
   "expectedScore": "9",
   "criticalError": false
  },
  {
   "id": "LV16",
   "name": "lab pass needs 80 and no critical error",
   "labTasks": [
    {
     "points": 10,
     "score": "10"
    },
    {
     "points": 10,
     "score": "10"
    },
    {
     "points": 10,
     "score": "10"
    },
    {
     "points": 10,
     "score": "10"
    },
    {
     "points": 10,
     "score": "0"
    }
   ],
   "criticalErrors": 0,
   "expectedLabScore": 80,
   "expectedPassed": true
  },
  {
   "id": "LV17",
   "name": "high score but a critical error fails",
   "labTasks": [
    {
     "points": 10,
     "score": "10"
    },
    {
     "points": 10,
     "score": "10"
    }
   ],
   "criticalErrors": 1,
   "expectedLabScore": 100,
   "expectedPassed": false
  },
  {
   "id": "LV18",
   "name": "lab score rounds half up",
   "labTasks": [
    {
     "points": 12,
     "score": "10"
    },
    {
     "points": 12,
     "score": "10"
    },
    {
     "points": 12,
     "score": "10"
    }
   ],
   "criticalErrors": 0,
   "expectedLabScore": 83,
   "expectedPassed": true,
   "note": "30/36 = 83.33 rounds to 83."
  }
 ]
}
```
@@end

@@lab id=lab-flow-tracer module=m2 title="Flow Tracer: follow one payment from link to ledger" minutes=20 tracks=FOUNDATION refs=b02-03,b01-02,b00-03
```json
{
 "id": "lab-flow-tracer",
 "module": "m2",
 "title": "Flow Tracer: follow one payment from link to ledger",
 "minutes": 20,
 "tracks": [
  "FOUNDATION"
 ],
 "refs": [
  "b02-03",
  "b01-02",
  "b00-03"
 ],
 "briefing": "You are watching one payment travel through the platform. Nothing here is real. Your job: put the steps in order, and spot where the platform refuses to trust the browser.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "t1",
   "kind": "order",
   "title": "Order the life of a payment",
   "panels": [
    {
     "title": "Payment link",
     "rows": [
      [
       "Link",
       "PL-48213"
      ],
      [
       "Amount",
       "100.000 LYD"
      ],
      [
       "Fee bearer",
       "MERCHANT_ABSORBS"
      ],
      [
       "Use",
       "Single-use"
      ]
     ]
    }
   ],
   "prompt": "Put these steps in the order they happen.",
   "points": 12,
   "items": [
    {
     "id": "a",
     "label": "The platform guards check the merchant, limits and rules"
    },
    {
     "id": "b",
     "label": "A slot is reserved on the link"
    },
    {
     "id": "c",
     "label": "The engine starts the payment with the partner"
    },
    {
     "id": "d",
     "label": "The customer completes the payment with the partner"
    },
    {
     "id": "e",
     "label": "Our server verifies the result with the partner"
    },
    {
     "id": "f",
     "label": "Success and the ledger entry are written in one transaction"
    }
   ],
   "correctOrder": [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f"
   ],
   "feedback": "Guards run first, the slot is reserved before any attempt, and success and posting are one transaction."
  },
  {
   "id": "t2",
   "kind": "choice",
   "title": "A tampered amount",
   "panels": [
    {
     "title": "What the browser sent",
     "rows": [
      [
       "Link",
       "PL-48213"
      ],
      [
       "amount (in the web address)",
       "1.000"
      ]
     ]
    },
    {
     "title": "What the database holds",
     "rows": [
      [
       "Link amount",
       "100.000 LYD"
      ]
     ]
    }
   ],
   "prompt": "The web address shows an amount of 1.000. What does the platform do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Charges 1.000 because the customer asked for it",
     "correct": false,
     "feedback": "The amount never comes from the browser.",
     "critical": true
    },
    {
     "id": "b",
     "label": "Ignores it and uses the link's amount from its own database",
     "correct": true,
     "feedback": "Correct. Amounts come only from the system."
    },
    {
     "id": "c",
     "label": "Asks the merchant to confirm 1.000",
     "correct": false,
     "feedback": "There is nothing to confirm; the browser is not a source of amounts."
    }
   ]
  },
  {
   "id": "t3",
   "kind": "choice",
   "title": "A tampered return address",
   "panels": [
    {
     "title": "The customer's browser comes back from the partner's page",
     "rows": [
      [
       "Return address",
       "…/return?status=success"
      ],
      [
       "Our server's own check with the partner",
       "not yet done"
      ]
     ]
    }
   ],
   "prompt": "The return address says success. What do we do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Mark the payment SUCCEEDED",
     "correct": false,
     "feedback": "A return address is only a hint and can be changed by anyone.",
     "critical": true
    },
    {
     "id": "b",
     "label": "Ask the partner what really happened, and wait for its answer",
     "correct": true,
     "feedback": "Correct. Hints make us ask; only verified answers count."
    },
    {
     "id": "c",
     "label": "Mark it FAILED because it is unverified",
     "correct": false,
     "feedback": "Unverified is not failed. We ask."
    }
   ]
  },
  {
   "id": "t4",
   "kind": "choice",
   "title": "Which proof counts?",
   "panels": [
    {
     "title": "Four pieces of evidence",
     "table": {
      "columns": [
       "Evidence",
       "Source"
      ],
      "rows": [
       [
        "A screenshot of a Paid screen",
        "Customer"
       ],
       [
        "A signed webhook that passes all checks and matches reference, amount, currency, environment",
        "Partner"
       ],
       [
        "A phone call from the customer",
        "Customer"
       ],
       [
        "A return address with status=success",
        "Browser"
       ]
      ]
     }
    }
   ],
   "prompt": "Which one can make the payment SUCCEEDED?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "The screenshot",
     "correct": false,
     "feedback": "Screens can be faked."
    },
    {
     "id": "b",
     "label": "The verified signed webhook",
     "correct": true,
     "feedback": "Correct, if the five facts match."
    },
    {
     "id": "c",
     "label": "The phone call",
     "correct": false,
     "feedback": "Never from a call."
    },
    {
     "id": "d",
     "label": "The return address",
     "correct": false,
     "feedback": "Only a hint."
    }
   ]
  },
  {
   "id": "t5",
   "kind": "choice",
   "title": "Where does the money get written?",
   "panels": [
    {
     "title": "The payment just succeeded",
     "rows": [
      [
       "Amount",
       "100.000 LYD"
      ],
      [
       "Commission",
       "3.000 LYD"
      ],
      [
       "Merchant credited",
       "97.000 LYD"
      ]
     ]
    }
   ],
   "prompt": "When is the ledger entry written?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "In the same database transaction as the success",
     "correct": true,
     "feedback": "Correct. There is no state where a payment is SUCCEEDED without its entry."
    },
    {
     "id": "b",
     "label": "Tomorrow morning in a batch",
     "correct": false,
     "feedback": "Success and posting are one transaction."
    },
    {
     "id": "c",
     "label": "When Finance clicks a button",
     "correct": false,
     "feedback": "Finance does not post ordinary payments."
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-approval-desk module=m3 title="Approval Desk: be the checker" minutes=30 tracks=FOUNDATION refs=b04-01,b04-02,b04-03,b04-06,b00-03
```json
{
 "id": "lab-approval-desk",
 "module": "m3",
 "title": "Approval Desk: be the checker",
 "minutes": 30,
 "tracks": [
  "FOUNDATION"
 ],
 "refs": [
  "b04-01",
  "b04-02",
  "b04-03",
  "b04-06",
  "b00-03"
 ],
 "briefing": "You are the checker. Four requests are waiting. For each, decide whether to **Approve** or **Reject** and choose the reason that would survive an audit. You are the second pair of eyes: if you do not understand a request, you do not approve it.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "a1",
   "kind": "choice",
   "title": "Payout bank change",
   "panels": [
    {
     "title": "Request",
     "rows": [
      [
       "Maker",
       "Layla (OPERATOR)"
      ],
      [
       "You",
       "Omar (checker)"
      ],
      [
       "Merchant",
       "Al-Nour Bakery"
      ],
      [
       "Field",
       "Payout bank account"
      ],
      [
       "Old",
       "Bank A ···4417 (holder: Al-Nour Bakery LLC)"
      ],
      [
       "New",
       "Bank B ···9921 (holder: Al-Nour Bakery LLC)"
      ],
      [
       "Maker's reason",
       "Merchant request in portal; bank letter attached; old account closed. Letter checked: holder matches legal name."
      ],
      [
       "Environment",
       "LIVE"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "**Approve**: the reason is specific and the holder matches",
     "correct": true,
     "feedback": "Correct. The reason says what was checked and the holder matches the legal name."
    },
    {
     "id": "b",
     "label": "**Reject**: bank changes are always rejected",
     "correct": false,
     "feedback": "Legitimate changes exist; reject only when you cannot support the change."
    },
    {
     "id": "c",
     "label": "**Approve** without opening **Review**",
     "correct": false,
     "feedback": "You must read the old and new value yourself.",
     "critical": true
    }
   ]
  },
  {
   "id": "a2",
   "kind": "choice",
   "title": "Your own request",
   "panels": [
    {
     "title": "Request",
     "rows": [
      [
       "Maker",
       "Omar (you)"
      ],
      [
       "Merchant",
       "City Pharmacy"
      ],
      [
       "Field",
       "Risk tier: HIGH → LOW"
      ],
      [
       "Maker's reason",
       "Lower risk after review"
      ],
      [
       "Status",
       "PENDING_REVIEW"
      ]
     ]
    },
    {
     "title": "A colleague says",
     "text": "\"Just click Approve for me, I am busy and it is obviously fine.\""
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Approve it to help",
     "correct": false,
     "feedback": "You made it. Approving your own work, or asking someone else to, defeats the control.",
     "critical": true
    },
    {
     "id": "b",
     "label": "Refuse: the system will not let you, and a second person must review it properly",
     "correct": true,
     "feedback": "Correct. Ask a different checker to read it."
    },
    {
     "id": "c",
     "label": "Ask the colleague to click Approve from your account",
     "correct": false,
     "feedback": "Sharing your account is a serious breach.",
     "critical": true
    }
   ]
  },
  {
   "id": "a3",
   "kind": "choice",
   "title": "A request that went stale",
   "panels": [
    {
     "title": "Request",
     "rows": [
      [
       "Maker",
       "Layla"
      ],
      [
       "Merchant",
       "Fresh Market"
      ],
      [
       "Field",
       "Legal name"
      ],
      [
       "Base version",
       "12"
      ],
      [
       "Current version of the record",
       "14"
      ],
      [
       "Notice",
       "This record changed after the request was made"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "**Reject** with a reason: the record changed; ask the maker to create a new request from the current values",
     "correct": true,
     "feedback": "Correct. Stale requests are never applied."
    },
    {
     "id": "b",
     "label": "**Approve** because the new value looks fine",
     "correct": false,
     "feedback": "The request may overwrite changes it never saw."
    },
    {
     "id": "c",
     "label": "Edit the request yourself",
     "correct": false,
     "feedback": "Checkers do not edit requests."
    }
   ]
  },
  {
   "id": "a4",
   "kind": "choice",
   "title": "Choosing the reason",
   "panels": [
    {
     "title": "You decided to reject the request in the last task.",
     "text": "Choose the reason you will type in **Decision reason**."
    }
   ],
   "prompt": "Which reason is best?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "\"no\"",
     "correct": false,
     "feedback": "A reason must say what you checked and why."
    },
    {
     "id": "b",
     "label": "\"Record changed since request (v12 vs v14). Maker to re-submit from current values.\"",
     "correct": true,
     "feedback": "Correct: specific, checkable, helpful."
    },
    {
     "id": "c",
     "label": "\"compliance flagged this merchant\"",
     "correct": false,
     "feedback": "Never reveal AML or compliance matters in a reason a merchant might read.",
     "critical": true
    }
   ]
  },
  {
   "id": "a5",
   "kind": "checklist",
   "title": "The safeguard checklist",
   "panels": [
    {
     "title": "You are about to approve a 250.000 LYD refund.",
     "rows": [
      [
       "Merchant",
       "Olive House"
      ],
      [
       "Original payment",
       "250.000 LYD, SUCCEEDED, LIVE"
      ],
      [
       "Refund requested",
       "250.000 LYD"
      ],
      [
       "Maker's reason",
       "Duplicate charge; customer paid twice; first payment verified in the step log"
      ],
      [
       "Maker",
       "Layla (a different person)"
      ],
      [
       "Dispute on this payment",
       "none"
      ]
     ]
    }
   ],
   "prompt": "Tick only the statements you have really verified from this record.",
   "points": 10,
   "items": [
    {
     "id": "c1",
     "label": "I read the old and new value in **Review**",
     "shouldTick": true,
     "why": "You have this record in front of you."
    },
    {
     "id": "c2",
     "label": "The amount and currency match the original payment",
     "shouldTick": true,
     "why": "250.000 LYD both."
    },
    {
     "id": "c3",
     "label": "The maker's reason makes sense",
     "shouldTick": true,
     "why": "It names the duplicate and the evidence."
    },
    {
     "id": "c4",
     "label": "The environment badge is LIVE",
     "shouldTick": true,
     "why": "It is."
    },
    {
     "id": "c5",
     "label": "I confirmed the customer's identity by phone",
     "shouldTick": false,
     "why": "Nothing in the record supports this; do not tick what you did not do."
    },
    {
     "id": "c6",
     "label": "The maker is a different person from me",
     "shouldTick": true,
     "why": "Stated in the request (you are the checker)."
    }
   ],
   "criticalWrong": [
    "c5"
   ]
  }
 ]
}
```
@@end

@@lab id=lab-security-desk module=m10 title="Security Desk: spot the trick" minutes=25 tracks=FOUNDATION refs=b11-02,b11-03,b11-04,b10-07,b09-10
```json
{
 "id": "lab-security-desk",
 "module": "m10",
 "title": "Security Desk: spot the trick",
 "minutes": 25,
 "tracks": [
  "FOUNDATION"
 ],
 "refs": [
  "b11-02",
  "b11-03",
  "b11-04",
  "b10-07",
  "b09-10"
 ],
 "briefing": "Six messages arrive during your shift. For each, choose the safe response.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "s1",
   "kind": "choice",
   "title": "The helpful caller",
   "panels": [
    {
     "title": "Phone call",
     "text": "\"Hi, this is Karim from IT. We are fixing a login fault. Please read me the code on your phone so I can finish the repair.\""
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Read the code; he is from IT",
     "correct": false,
     "feedback": "Nobody legitimate ever asks for a code.",
     "critical": true
    },
    {
     "id": "b",
     "label": "Refuse, end the call, and report it to the Security Admin",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "c",
     "label": "Read half the code",
     "correct": false,
     "feedback": "Never share any part of it.",
     "critical": true
    }
   ]
  },
  {
   "id": "s2",
   "kind": "choice",
   "title": "The urgent email",
   "panels": [
    {
     "title": "Email",
     "text": "\"URGENT from the CEO: process this payout today and do not discuss it with anyone. Details in the link below.\""
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Click the link and process it",
     "correct": false,
     "feedback": "Urgency plus secrecy is a classic trick."
    },
    {
     "id": "b",
     "label": "Do not click; use the normal screens and verify through a number you already know; report it",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "c",
     "label": "Forward it to the team",
     "correct": false,
     "feedback": "Do not spread it; report it to Security."
    }
   ]
  },
  {
   "id": "s3",
   "kind": "choice",
   "title": "The leaked token",
   "panels": [
    {
     "title": "Team chat",
     "text": "A colleague posts a screenshot of a merchant's API token by mistake and asks if anyone saw it."
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Say nothing",
     "correct": false,
     "feedback": "A leaked secret is usable until replaced."
    },
    {
     "id": "b",
     "label": "Tell the Security Admin immediately; the merchant revokes and replaces the token",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "c",
     "label": "Delete the message and hope",
     "correct": false,
     "feedback": "Deleting does not unleak a secret."
    }
   ]
  },
  {
   "id": "s4",
   "kind": "choice",
   "title": "The favour",
   "panels": [
    {
     "title": "A merchant's owner says",
     "text": "\"If you approve my cash-out today I will send you a nice gift.\""
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Accept and approve",
     "correct": false,
     "feedback": "Never accept gifts or favours.",
     "critical": true
    },
    {
     "id": "b",
     "label": "Decline, process nothing outside the normal checks, and report the offer",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "c",
     "label": "Accept and wait until after approval",
     "correct": false,
     "feedback": "Same offence."
    }
   ]
  },
  {
   "id": "s5",
   "kind": "checklist",
   "title": "What is safe to put in team chat?",
   "panels": [
    {
     "title": "You need help from a colleague on one payment."
    }
   ],
   "prompt": "Tick only what you may safely send.",
   "points": 10,
   "items": [
    {
     "id": "k1",
     "label": "The payment reference",
     "shouldTick": true,
     "why": "References are safe."
    },
    {
     "id": "k2",
     "label": "The customer's full phone number",
     "shouldTick": false,
     "why": "Do not share personal data in chat."
    },
    {
     "id": "k3",
     "label": "The merchant's API token",
     "shouldTick": false,
     "why": "Never."
    },
    {
     "id": "k4",
     "label": "A screenshot that shows a one-time code",
     "shouldTick": false,
     "why": "Never."
    },
    {
     "id": "k5",
     "label": "The status you read in the platform",
     "shouldTick": true,
     "why": "Safe."
    }
   ],
   "criticalWrong": [
    "k3",
    "k4"
   ]
  },
  {
   "id": "s6",
   "kind": "choice",
   "title": "The suspicious merchant",
   "panels": [
    {
     "title": "What you noticed",
     "text": "Two merchants share the same owner phone number and uploaded the same registry certificate, and one of them asks you what amount triggers a review."
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Tell them the threshold",
     "correct": false,
     "feedback": "That reveals how to avoid detection and may tip them off.",
     "critical": true
    },
    {
     "id": "b",
     "label": "Give no information, write down the facts, and tell Compliance the same day",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "c",
     "label": "Warn both merchants",
     "correct": false,
     "feedback": "Do not confront or warn.",
     "critical": true
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-kyb-desk module=m4 title="KYB Desk: review five join requests" minutes=35 tracks=OPERATOR,COMPLIANCE,MLRO refs=b05-03,b05-04,b05-05,b05-10
```json
{
 "id": "lab-kyb-desk",
 "module": "m4",
 "title": "KYB Desk: review five join requests",
 "minutes": 35,
 "tracks": [
  "OPERATOR",
  "COMPLIANCE",
  "MLRO"
 ],
 "refs": [
  "b05-03",
  "b05-04",
  "b05-05",
  "b05-10"
 ],
 "briefing": "You review join requests. For each, choose the right action. Remember: never tell an applicant about screening, and a second reviewer is required in the cases the policy lists.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "k1",
   "kind": "choice",
   "title": "The clean request",
   "panels": [
    {
     "title": "Join request JR-1001",
     "rows": [
      [
       "Business",
       "Salma Stationery LLC"
      ],
      [
       "Identity verified",
       "Yes"
      ],
      [
       "Registry and tax certificates",
       "Names and numbers agree"
      ],
      [
       "Owners",
       "2 declared, both with ID; articles confirm 60/40"
      ],
      [
       "Screening",
       "CLEAR"
      ],
      [
       "Category / volume",
       "Stationery shop / modest"
      ],
      [
       "Payout account",
       "Holder: Salma Stationery LLC"
      ],
      [
       "Proposed risk",
       "LOW"
      ],
      [
       "Four-eyes policy",
       "RISK_BASED, no trigger fired"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "**Approve**",
     "correct": true,
     "feedback": "All seven checks pass and no second-person trigger fired."
    },
    {
     "id": "b",
     "label": "**Reject** for safety",
     "correct": false,
     "feedback": "There is no reason to reject."
    },
    {
     "id": "c",
     "label": "Request information about screening",
     "correct": false,
     "feedback": "Never mention screening.",
     "critical": true
    }
   ]
  },
  {
   "id": "k2",
   "kind": "choice",
   "title": "The bank letter",
   "panels": [
    {
     "title": "Join request JR-1002",
     "rows": [
      [
       "Business",
       "Noor Electronics LLC"
      ],
      [
       "Bank letter holder",
       "Noor Trading FZE"
      ],
      [
       "All other checks",
       "Pass"
      ],
      [
       "Screening",
       "CLEAR"
      ]
     ]
    }
   ],
   "prompt": "What is the right action?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "**Request information**: ask for a bank letter in the merchant's legal name",
     "correct": true,
     "feedback": "A mismatched payout account fails check 6 and forces a second reviewer; ask for the right letter."
    },
    {
     "id": "b",
     "label": "Approve; the names are similar",
     "correct": false,
     "feedback": "A payout account must belong to the business (or a documented related party)."
    },
    {
     "id": "c",
     "label": "Reject and say screening found an issue",
     "correct": false,
     "feedback": "False and forbidden: never mention screening.",
     "critical": true
    }
   ]
  },
  {
   "id": "k3",
   "kind": "choice",
   "title": "The duplicate document",
   "panels": [
    {
     "title": "Join request JR-1003",
     "rows": [
      [
       "Business",
       "Green Valley Trading"
      ],
      [
       "Registry certificate fingerprint",
       "Identical to a file uploaded by Bright Star LLC"
      ],
      [
       "Same owner phone",
       "No"
      ],
      [
       "Screening",
       "CLEAR"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Accuse the applicant of fraud",
     "correct": false,
     "feedback": "A duplicate does not reject automatically and you do not accuse.",
     "critical": true
    },
    {
     "id": "b",
     "label": "Note the finding, review the related records, require a second reviewer and escalate to Compliance",
     "correct": true,
     "feedback": "Correct. The duplicate flag adds review and raises the proposed tier."
    },
    {
     "id": "c",
     "label": "Approve; documents are just files",
     "correct": false,
     "feedback": "A duplicate is a serious warning sign."
    }
   ]
  },
  {
   "id": "k4",
   "kind": "choice",
   "title": "A possible match",
   "panels": [
    {
     "title": "Join request JR-1004",
     "rows": [
      [
       "Business",
       "Alamal Logistics"
      ],
      [
       "Screening",
       "POTENTIAL_MATCH (owner)"
      ],
      [
       "Other checks",
       "Pass"
      ]
     ]
    }
   ],
   "prompt": "You are an operator. What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Do not approve and do not discuss it; note it is waiting for Compliance and let the second-reviewer rule work",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Approve because it is probably a false positive",
     "correct": false,
     "feedback": "Only Compliance decides matches.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Tell the applicant to explain the match",
     "correct": false,
     "feedback": "Never discuss screening with the applicant.",
     "critical": true
    }
   ]
  },
  {
   "id": "k5",
   "kind": "multi",
   "title": "Which findings force a second reviewer? (risk-based policy)",
   "panels": [
    {
     "title": "Candidates"
    }
   ],
   "prompt": "Select all that force a second reviewer.",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Proposed risk is HIGH",
     "correct": true,
     "feedback": "Yes."
    },
    {
     "id": "b",
     "label": "The payout account does not match",
     "correct": true,
     "feedback": "Yes, always."
    },
    {
     "id": "c",
     "label": "The business sells stationery",
     "correct": false,
     "feedback": "No."
    },
    {
     "id": "d",
     "label": "Screening is not CLEAR",
     "correct": true,
     "feedback": "Yes."
    },
    {
     "id": "e",
     "label": "An owner is a politically exposed person",
     "correct": true,
     "feedback": "Yes."
    },
    {
     "id": "f",
     "label": "The applicant was rejected before",
     "correct": true,
     "feedback": "Yes."
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-payment-reading module=m5 title="Reading a Payment: six attempts" minutes=30 tracks=OPERATOR,SUPPORT refs=b07-01,b07-02,b07-03,b07-12
```json
{
 "id": "lab-payment-reading",
 "module": "m5",
 "title": "Reading a Payment: six attempts",
 "minutes": 30,
 "tracks": [
  "OPERATOR",
  "SUPPORT"
 ],
 "refs": [
  "b07-01",
  "b07-02",
  "b07-03",
  "b07-12"
 ],
 "briefing": "Six payments are on your screen. For each, choose what you do or say. You never see passwords or codes here and nothing is real.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "p1",
   "kind": "choice",
   "title": "SUCCEEDED",
   "panels": [
    {
     "title": "Attempt A-2001",
     "rows": [
      [
       "Environment",
       "LIVE"
      ],
      [
       "Status",
       "SUCCEEDED"
      ],
      [
       "Amount",
       "50.000 LYD"
      ],
      [
       "Ledger entry",
       "posted"
      ]
     ]
    }
   ],
   "prompt": "A merchant asks if it was paid. You say:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "\"We confirm the payment; your wallet is credited.\"",
     "correct": true,
     "feedback": "Correct: read from the status."
    },
    {
     "id": "b",
     "label": "\"Probably paid.\"",
     "correct": false,
     "feedback": "Do not guess."
    },
    {
     "id": "c",
     "label": "\"Ask the customer.\"",
     "correct": false,
     "feedback": "The status answers it."
    }
   ]
  },
  {
   "id": "p2",
   "kind": "choice",
   "title": "FAILED but the customer insists",
   "panels": [
    {
     "title": "Attempt A-2002",
     "rows": [
      [
       "Environment",
       "LIVE"
      ],
      [
       "Status",
       "FAILED"
      ],
      [
       "Reason",
       "Insufficient funds"
      ],
      [
       "Customer says",
       "Money was deducted from my phone"
      ]
     ]
    }
   ],
   "prompt": "You:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Say we have no confirmed payment, ask them to keep the receipt, and open a case with the reference and time",
     "correct": true,
     "feedback": "Correct: a late confirmation may still arrive."
    },
    {
     "id": "b",
     "label": "Refund them now",
     "correct": false,
     "feedback": "Never refund on a call.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Ask them to pay again",
     "correct": false,
     "feedback": "They may be charged twice.",
     "critical": true
    }
   ]
  },
  {
   "id": "p3",
   "kind": "choice",
   "title": "UNKNOWN",
   "panels": [
    {
     "title": "Attempt A-2003",
     "rows": [
      [
       "Environment",
       "LIVE"
      ],
      [
       "Status",
       "UNKNOWN"
      ],
      [
       "Last step",
       "Confirm: timeout after 15 seconds"
      ],
      [
       "Age",
       "40 minutes"
      ],
      [
       "Link",
       "single-use, slot reserved"
      ]
     ]
    }
   ],
   "prompt": "What is the first thing you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Open the case, read the step log, press **Inquire** once",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Mark it failed because it is 40 minutes old",
     "correct": false,
     "feedback": "Age is not evidence.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Re-send the OTP",
     "correct": false,
     "feedback": "That may start a second payment.",
     "critical": true
    }
   ]
  },
  {
   "id": "p4",
   "kind": "choice",
   "title": "UNKNOWN on a rail that cannot be asked",
   "panels": [
    {
     "title": "Attempt A-2004",
     "rows": [
      [
       "Status",
       "UNKNOWN"
      ],
      [
       "Rail",
       "a wallet whose partner offers no status question"
      ],
      [
       "Inquire",
       "Not possible on this rail"
      ]
     ]
    }
   ],
   "prompt": "Best action?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Note our reference and the provider reference; wait for the statement or contact the partner's support",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Keep pressing Inquire",
     "correct": false,
     "feedback": "It will not work."
    },
    {
     "id": "c",
     "label": "Tell the customer to pay again",
     "correct": false,
     "feedback": "Forbidden.",
     "critical": true
    }
   ]
  },
  {
   "id": "p5",
   "kind": "choice",
   "title": "BLOCKED",
   "panels": [
    {
     "title": "Attempt A-2005",
     "rows": [
      [
       "Status",
       "BLOCKED"
      ],
      [
       "Customer asks",
       "Why can't I pay?"
      ]
     ]
    }
   ],
   "prompt": "You say:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "\"We cannot process this payment.\"",
     "correct": true,
     "feedback": "Correct: nothing more."
    },
    {
     "id": "b",
     "label": "\"A compliance rule stopped it.\"",
     "correct": false,
     "feedback": "Never reveal the reason.",
     "critical": true
    },
    {
     "id": "c",
     "label": "\"Your phone is on a watch-list.\"",
     "correct": false,
     "feedback": "Never.",
     "critical": true
    }
   ]
  },
  {
   "id": "p6",
   "kind": "choice",
   "title": "A screenshot",
   "panels": [
    {
     "title": "A cashier says",
     "text": "\"The customer shows Paid on her phone. Should I release the goods?\""
    },
    {
     "title": "Attempt A-2006",
     "rows": [
      [
       "Status",
       "VERIFYING"
      ]
     ]
    }
   ],
   "prompt": "You tell the cashier:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Wait until the status shows SUCCEEDED",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Release; the phone says Paid",
     "correct": false,
     "feedback": "A page saying Paid proves nothing.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Ask the customer to pay cash too",
     "correct": false,
     "feedback": "Not needed; wait."
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-incident-unknown module=m5 title="Incident Simulator: a switch timeout" minutes=40 tracks=OPERATOR,FINANCE refs=b07-03,b07-04,b07-08,b10-02,b10-04
```json
{
 "id": "lab-incident-unknown",
 "module": "m5",
 "title": "Incident Simulator: a switch timeout",
 "minutes": 40,
 "tracks": [
  "OPERATOR",
  "FINANCE"
 ],
 "refs": [
  "b07-03",
  "b07-04",
  "b07-08",
  "b10-02",
  "b10-04"
 ],
 "briefing": "A national switch had a timeout. Three payments are UNKNOWN and one webhook disagrees with an inquiry. Resolve each safely without double-crediting.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "i1",
   "kind": "choice",
   "title": "Where do you start?",
   "panels": [
    {
     "title": "Dashboard",
     "rows": [
      [
       "Open Circuit Breakers",
       "1"
      ],
      [
       "Unknown Backlog",
       "3"
      ],
      [
       "Oldest",
       "20 min"
      ]
     ]
    }
   ],
   "prompt": "First step?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Confirm the breaker and tell the Gateway Admin and your manager",
     "correct": true,
     "feedback": "Correct (RB-01)."
    },
    {
     "id": "b",
     "label": "Re-enable the route",
     "correct": false,
     "feedback": "Never while the partner is failing.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Mark all three failed",
     "correct": false,
     "feedback": "Never guess.",
     "critical": true
    }
   ]
  },
  {
   "id": "i2",
   "kind": "choice",
   "title": "Attempt U1",
   "panels": [
    {
     "title": "U1",
     "rows": [
      [
       "Status",
       "UNKNOWN"
      ],
      [
       "Partner",
       "supports status question"
      ]
     ]
    }
   ],
   "prompt": "Action?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Press **Inquire** once and read the step log",
     "correct": true,
     "feedback": "Correct; the platform resolves it if the partner answers clearly."
    },
    {
     "id": "b",
     "label": "Press Inquire ten times",
     "correct": false,
     "feedback": "Repeating does not help."
    },
    {
     "id": "c",
     "label": "Resolve by hand as succeeded",
     "correct": false,
     "feedback": "You have no evidence.",
     "critical": true
    }
   ]
  },
  {
   "id": "i3",
   "kind": "choice",
   "title": "Attempt U2",
   "panels": [
    {
     "title": "U2",
     "rows": [
      [
       "Status",
       "UNKNOWN"
      ],
      [
       "Partner",
       "no status question"
      ],
      [
       "Statement",
       "arrives tomorrow"
      ]
     ]
    }
   ],
   "prompt": "Action?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Leave the case open, note references, wait for the statement or evidence from the partner",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Resolve as failed",
     "correct": false,
     "feedback": "Forbidden without evidence.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Ask the customer to pay again",
     "correct": false,
     "feedback": "Forbidden.",
     "critical": true
    }
   ]
  },
  {
   "id": "i4",
   "kind": "choice",
   "title": "Attempt U3 with evidence",
   "panels": [
    {
     "title": "U3",
     "rows": [
      [
       "Status",
       "UNKNOWN"
      ],
      [
       "Evidence",
       "Partner support replied in writing: payment completed, provider reference matches ours, amount and currency match"
      ]
     ]
    }
   ],
   "prompt": "You may now:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Use **Resolve as succeeded** with a reason naming the evidence, with a second person approving",
     "correct": true,
     "feedback": "Correct, using the checklist."
    },
    {
     "id": "b",
     "label": "Mark succeeded alone and quietly",
     "correct": false,
     "feedback": "A second person is required.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Ignore the evidence",
     "correct": false,
     "feedback": "The evidence supports resolution."
    }
   ]
  },
  {
   "id": "i5",
   "kind": "choice",
   "title": "The conflict",
   "panels": [
    {
     "title": "Case C1 (P1 CONFLICT)",
     "rows": [
      [
       "Verified webhook",
       "paid"
      ],
      [
       "Our inquiry",
       "failed"
      ],
      [
       "Posted to ledger",
       "nothing"
      ]
     ]
    }
   ],
   "prompt": "You:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Escalate to a senior operator and the Gateway Admin; resolution needs partner evidence",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Resolve as succeeded because the webhook is signed",
     "correct": false,
     "feedback": "Both sources are trusted; neither wins.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Resolve as failed",
     "correct": false,
     "feedback": "Same reason.",
     "critical": true
    }
   ]
  },
  {
   "id": "i6",
   "kind": "order",
   "title": "After the breaker closes",
   "panels": [
    {
     "title": "Recovery"
    }
   ],
   "prompt": "Order the follow-up.",
   "points": 10,
   "items": [
    {
     "id": "a",
     "label": "Check the Unknown Backlog tile"
    },
    {
     "id": "b",
     "label": "Run Bulk Inquiry on the affected route and period using the checklist"
    },
    {
     "id": "c",
     "label": "Resolve remaining cases only with evidence and a second person"
    },
    {
     "id": "d",
     "label": "Write a handover note"
    }
   ],
   "correctOrder": [
    "a",
    "b",
    "c",
    "d"
   ],
   "feedback": "Backlog first, then targeted inquiry, then evidence-based resolution, then hand over."
  }
 ]
}
```
@@end

@@lab id=lab-customer-calls module=m5 title="Customer Calls: say the right thing" minutes=30 tracks=SUPPORT refs=b05-09,b07-12,b09-08,b07-10
```json
{
 "id": "lab-customer-calls",
 "module": "m5",
 "title": "Customer Calls: say the right thing",
 "minutes": 30,
 "tracks": [
  "SUPPORT"
 ],
 "refs": [
  "b05-09",
  "b07-12",
  "b09-08",
  "b07-10"
 ],
 "briefing": "Six callers. For each, choose the safest helpful answer. Support is read-only: you never move money and you never reveal why.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "c1",
   "kind": "choice",
   "title": "Merchant: why am I restricted?",
   "panels": [
    {
     "title": "Merchant record",
     "rows": [
      [
       "Status",
       "SUSPENDED"
      ],
      [
       "Reason (confidential)",
       "AML"
      ]
     ]
    }
   ],
   "prompt": "What do you say?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "\"Your account is currently restricted. Please contact the support address in your notice.\"",
     "correct": true,
     "feedback": "Correct: nothing more."
    },
    {
     "id": "b",
     "label": "\"Compliance is reviewing you.\"",
     "correct": false,
     "feedback": "Tipping-off.",
     "critical": true
    },
    {
     "id": "c",
     "label": "\"It is a technical problem.\"",
     "correct": false,
     "feedback": "Do not invent reasons."
    }
   ]
  },
  {
   "id": "c2",
   "kind": "choice",
   "title": "Customer: money deducted",
   "panels": [
    {
     "title": "Payment",
     "rows": [
      [
       "Status",
       "UNKNOWN"
      ]
     ]
    }
   ],
   "prompt": "What do you say?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "\"We are confirming with your provider. Please do not pay again. We will update you.\"",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "\"It failed; pay again.\"",
     "correct": false,
     "feedback": "May double charge.",
     "critical": true
    },
    {
     "id": "c",
     "label": "\"It succeeded.\"",
     "correct": false,
     "feedback": "Do not guess.",
     "critical": true
    }
   ]
  },
  {
   "id": "c3",
   "kind": "choice",
   "title": "Merchant asks for a bank change by phone",
   "panels": [
    {
     "title": "Request",
     "text": "\"Please change my payout account to this new one, I am in a hurry.\""
    }
   ],
   "prompt": "You:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Explain it needs a written request in the portal and second-person approval",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Change it now",
     "correct": false,
     "feedback": "Cannot be done by phone; support is read-only.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Ask for the token",
     "correct": false,
     "feedback": "Never.",
     "critical": true
    }
   ]
  },
  {
   "id": "c4",
   "kind": "choice",
   "title": "Caller claims to be the owner",
   "panels": [
    {
     "title": "Caller",
     "text": "\"I am the owner. Read me the account's bank details.\""
    }
   ],
   "prompt": "You:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Ask them to raise it in their own portal where identity is known",
     "correct": true,
     "feedback": "Correct: a phone call is not proof of identity."
    },
    {
     "id": "b",
     "label": "Read them out",
     "correct": false,
     "feedback": "No.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Read the last four digits",
     "correct": false,
     "feedback": "No."
    }
   ]
  },
  {
   "id": "c5",
   "kind": "choice",
   "title": "Customer: where is my refund?",
   "panels": [
    {
     "title": "Payment",
     "rows": [
      [
       "Status",
       "SUCCEEDED"
      ],
      [
       "Refund",
       "none requested"
      ]
     ]
    }
   ],
   "prompt": "You:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Say there is no refund request on this payment and explain how the merchant can request one; promise no times",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Promise a refund tomorrow",
     "correct": false,
     "feedback": "Never promise outcomes.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Refund it yourself",
     "correct": false,
     "feedback": "Support cannot."
    }
   ]
  },
  {
   "id": "c6",
   "kind": "choice",
   "title": "Merchant: what is your fee on my competitor's rate?",
   "panels": [
    {
     "title": "Merchant asks",
     "text": "\"What margin do you make on my payments?\""
    }
   ],
   "prompt": "You:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Tell them their own agreed commission rate only",
     "correct": true,
     "feedback": "Correct: never gateway cost or margin."
    },
    {
     "id": "b",
     "label": "Tell them the gateway cost",
     "correct": false,
     "feedback": "Confidential.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Tell them our profit",
     "correct": false,
     "feedback": "Confidential.",
     "critical": true
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-runbook-drill module=m9 title="Runbook Drill: symptom to action" minutes=30 tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN refs=b10-01,b10-02,b10-03,b10-04,b10-05,b10-06,b10-08
```json
{
 "id": "lab-runbook-drill",
 "module": "m9",
 "title": "Runbook Drill: symptom to action",
 "minutes": 30,
 "tracks": [
  "OPERATOR",
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN"
 ],
 "refs": [
  "b10-01",
  "b10-02",
  "b10-03",
  "b10-04",
  "b10-05",
  "b10-06",
  "b10-08"
 ],
 "briefing": "Match symptoms to runbooks, order the steps, and write a good handover.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "r1",
   "kind": "choice",
   "title": "Pick the runbook",
   "panels": [
    {
     "title": "Symptom",
     "text": "Alerts show a spike of signature failures from one partner. Payments stay in VERIFYING."
    }
   ],
   "prompt": "Which runbook?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "RB-02: partner changed its signature or sender address",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "RB-04: ledger drift",
     "correct": false,
     "feedback": "Not related."
    },
    {
     "id": "c",
     "label": "RB-05: credentials expired",
     "correct": false,
     "feedback": "Different symptom."
    }
   ]
  },
  {
   "id": "r2",
   "kind": "choice",
   "title": "Pick the runbook",
   "panels": [
    {
     "title": "Symptom",
     "text": "The invariant screen shows drift of 12.5000 and automatic payouts have stopped."
    }
   ],
   "prompt": "Which runbook?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "RB-04",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "RB-01",
     "correct": false,
     "feedback": "That is the outage runbook."
    },
    {
     "id": "c",
     "label": "RB-03",
     "correct": false,
     "feedback": "That is the UNKNOWN backlog."
    }
   ]
  },
  {
   "id": "r3",
   "kind": "order",
   "title": "Order RB-02",
   "panels": [
    {
     "title": "Signature failures"
    }
   ],
   "prompt": "Put the steps in order.",
   "points": 12,
   "items": [
    {
     "id": "a",
     "label": "Do not accept unsigned messages"
    },
    {
     "id": "b",
     "label": "Gateway Admin confirms the change with the partner in writing"
    },
    {
     "id": "c",
     "label": "Add the new secret version or address with overlap (two people)"
    },
    {
     "id": "d",
     "label": "Replay the stored messages"
    },
    {
     "id": "e",
     "label": "Record the change and the evidence"
    }
   ],
   "correctOrder": [
    "a",
    "b",
    "c",
    "d",
    "e"
   ],
   "feedback": "Never accept unsigned messages; confirm; add with overlap; replay; record."
  },
  {
   "id": "r4",
   "kind": "choice",
   "title": "A credential set is FAILING",
   "panels": [
    {
     "title": "Route",
     "rows": [
      [
       "Route health",
       "removed from selection"
      ],
      [
       "Credential set",
       "FAILING"
      ]
     ]
    }
   ],
   "prompt": "Right action?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Replace the secret through two-person approval and run the credential check",
     "correct": true,
     "feedback": "Correct (RB-05)."
    },
    {
     "id": "b",
     "label": "Force the route back on",
     "correct": false,
     "feedback": "It would fail again."
    },
    {
     "id": "c",
     "label": "Edit the gateway",
     "correct": false,
     "feedback": "Not the cause."
    }
   ]
  },
  {
   "id": "r5",
   "kind": "multi",
   "title": "A good handover note",
   "panels": [
    {
     "title": "Shift end"
    }
   ],
   "prompt": "Which items belong in a handover note?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "What is open and why (case numbers)",
     "correct": true,
     "feedback": "Yes."
    },
    {
     "id": "b",
     "label": "What you already tried",
     "correct": true,
     "feedback": "Yes."
    },
    {
     "id": "c",
     "label": "What you are waiting for and from whom",
     "correct": true,
     "feedback": "Yes."
    },
    {
     "id": "d",
     "label": "Your password so they can continue",
     "correct": false,
     "feedback": "Never."
    },
    {
     "id": "e",
     "label": "Anything risky or half-reviewed",
     "correct": true,
     "feedback": "Yes."
    },
    {
     "id": "f",
     "label": "Anything you promised to a merchant",
     "correct": true,
     "feedback": "Yes."
    }
   ],
   "criticalWrong": [
    "d"
   ]
  }
 ]
}
```
@@end

@@lab id=lab-ledger-balancing module=m6 title="Ledger Balancing Lab" minutes=45 tracks=FINANCE refs=b08-01,b08-03,b08-04,b08-12
```json
{
 "id": "lab-ledger-balancing",
 "module": "m6",
 "title": "Ledger Balancing Lab",
 "minutes": 45,
 "tracks": [
  "FINANCE"
 ],
 "refs": [
  "b08-01",
  "b08-03",
  "b08-04",
  "b08-12"
 ],
 "briefing": "Build the journal lines yourself. Enter debit or credit amounts (four decimals not needed) for the accounts that move; leave the others empty. Every entry must balance. Use 100.000 LYD links, 3% commission, and the fees given.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "g1",
   "kind": "ledger",
   "title": "Entry 5: payer surcharge",
   "panels": [
    {
     "title": "Event",
     "rows": [
      [
       "Link amount",
       "100.000 LYD"
      ],
      [
       "Fee bearer",
       "PAYER_SURCHARGE"
      ],
      [
       "Commission",
       "3.000 (3%)"
      ],
      [
       "Gateway fee accrued",
       "0.800"
      ],
      [
       "Settlement",
       "Platform clearing"
      ]
     ]
    }
   ],
   "prompt": "Post the confirmation. The customer pays link plus commission; the merchant is credited the full link amount.",
   "points": 15,
   "accounts": [
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "MERCHANT_WALLET",
    "PLATFORM_INCOME",
    "GATEWAY_FEE_ACCRUAL",
    "GATEWAY_FEE_EXPENSE",
    "PROVIDER_FEE_EXPENSE",
    "AML_HOLD",
    "CHARGEBACK_RESERVE",
    "SUSPENSE"
   ],
   "expected": [
    {
     "account": "GATEWAY_CLEARING",
     "side": "DR",
     "amount": "103.0000"
    },
    {
     "account": "GATEWAY_FEE_EXPENSE",
     "side": "DR",
     "amount": "0.8000"
    },
    {
     "account": "MERCHANT_WALLET",
     "side": "CR",
     "amount": "100.0000"
    },
    {
     "account": "PLATFORM_INCOME",
     "side": "CR",
     "amount": "3.0000"
    },
    {
     "account": "GATEWAY_FEE_ACCRUAL",
     "side": "CR",
     "amount": "0.8000"
    }
   ],
   "feedback": "Clearing 103.0000 and fee expense 0.8000 on the debit side; wallet 100.0000, income 3.0000 and fee accrual 0.8000 on the credit side. Both sides total 103.8000."
  },
  {
   "id": "g2",
   "kind": "ledger",
   "title": "Entry 3: the T+1 settlement sweep",
   "panels": [
    {
     "title": "Event",
     "rows": [
      [
       "Original payment",
       "100.000 LYD, MERCHANT_ABSORBS (Entry 2)"
      ],
      [
       "Accrued fee",
       "0.800"
      ],
      [
       "Statement shows",
       "99.200 net settled"
      ]
     ]
    }
   ],
   "prompt": "Post the sweep.",
   "points": 15,
   "accounts": [
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "MERCHANT_WALLET",
    "PLATFORM_INCOME",
    "GATEWAY_FEE_ACCRUAL",
    "GATEWAY_FEE_EXPENSE",
    "PROVIDER_FEE_EXPENSE",
    "AML_HOLD",
    "CHARGEBACK_RESERVE",
    "SUSPENSE"
   ],
   "expected": [
    {
     "account": "TREASURY",
     "side": "DR",
     "amount": "99.2000"
    },
    {
     "account": "GATEWAY_FEE_ACCRUAL",
     "side": "DR",
     "amount": "0.8000"
    },
    {
     "account": "GATEWAY_CLEARING",
     "side": "CR",
     "amount": "100.0000"
    }
   ],
   "feedback": "The partner paid 99.2000 to treasury; the accrued fee clears; the clearing claim of 100.0000 is closed."
  },
  {
   "id": "g3",
   "kind": "ledger",
   "title": "Entry 4: fee true-up",
   "panels": [
    {
     "title": "Event",
     "rows": [
      [
       "Accrued fee",
       "0.800"
      ],
      [
       "Actual fee on the statement",
       "0.900"
      ]
     ]
    }
   ],
   "prompt": "Post the variance.",
   "points": 15,
   "accounts": [
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "MERCHANT_WALLET",
    "PLATFORM_INCOME",
    "GATEWAY_FEE_ACCRUAL",
    "GATEWAY_FEE_EXPENSE",
    "PROVIDER_FEE_EXPENSE",
    "AML_HOLD",
    "CHARGEBACK_RESERVE",
    "SUSPENSE"
   ],
   "expected": [
    {
     "account": "GATEWAY_FEE_EXPENSE",
     "side": "DR",
     "amount": "0.1000"
    },
    {
     "account": "GATEWAY_FEE_ACCRUAL",
     "side": "CR",
     "amount": "0.1000"
    }
   ],
   "feedback": "The extra 0.1000 is a cost and a liability."
  },
  {
   "id": "g4",
   "kind": "ledger",
   "title": "Entry 9: a full refund with commission reversed",
   "panels": [
    {
     "title": "Event",
     "rows": [
      [
       "Original payment",
       "100.000 LYD, commission 3.000"
      ],
      [
       "Refund",
       "Full, commission reversed"
      ],
      [
       "Paid from",
       "Treasury"
      ]
     ]
    }
   ],
   "prompt": "Post the refund.",
   "points": 15,
   "accounts": [
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "MERCHANT_WALLET",
    "PLATFORM_INCOME",
    "GATEWAY_FEE_ACCRUAL",
    "GATEWAY_FEE_EXPENSE",
    "PROVIDER_FEE_EXPENSE",
    "AML_HOLD",
    "CHARGEBACK_RESERVE",
    "SUSPENSE"
   ],
   "expected": [
    {
     "account": "MERCHANT_WALLET",
     "side": "DR",
     "amount": "97.0000"
    },
    {
     "account": "PLATFORM_INCOME",
     "side": "DR",
     "amount": "3.0000"
    },
    {
     "account": "TREASURY",
     "side": "CR",
     "amount": "100.0000"
    }
   ],
   "feedback": "The merchant's share and our commission are reversed; 100.0000 leaves treasury."
  },
  {
   "id": "g5",
   "kind": "numeric",
   "title": "Wallet after a chargeback",
   "panels": [
    {
     "title": "Event",
     "rows": [
      [
       "Wallet balance before",
       "40.000"
      ],
      [
       "Chargeback",
       "100.000 LYD payment, commission 3.000"
      ],
      [
       "Merchant share reversed",
       "97.000"
      ]
     ]
    }
   ],
   "prompt": "What is the wallet balance after the chargeback posts (allowed because the ceiling permits)?",
   "points": 10,
   "answer": "-57.0000",
   "tolerance": "0",
   "feedback": "40 − 97 = −57. The ledger equation still holds; the merchant now owes us 57.",
   "unit": "LYD"
  },
  {
   "id": "g6",
   "kind": "choice",
   "title": "The equation",
   "panels": [
    {
     "title": "Drift screen",
     "rows": [
      [
       "Drift",
       "12.5000 LYD"
      ],
      [
       "Payouts",
       "stopped automatically"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Treat as P1, tell your manager and Finance, never edit a number",
     "correct": true,
     "feedback": "Correct (RB-04)."
    },
    {
     "id": "b",
     "label": "Edit PLATFORM_INCOME by 12.5 to balance",
     "correct": false,
     "feedback": "Never.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Resume payouts",
     "correct": false,
     "feedback": "Only when zero.",
     "critical": true
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-cashout-adjustments module=m6 title="Cash-outs and Adjustments Desk" minutes=40 tracks=FINANCE refs=b08-07,b08-08,b08-09,b08-13
```json
{
 "id": "lab-cashout-adjustments",
 "module": "m6",
 "title": "Cash-outs and Adjustments Desk",
 "minutes": 40,
 "tracks": [
  "FINANCE"
 ],
 "refs": [
  "b08-07",
  "b08-08",
  "b08-09",
  "b08-13"
 ],
 "briefing": "You are Finance. Work the queue: decide, tick the checklist truthfully, and fix mistakes the correct way.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "h1",
   "kind": "checklist",
   "title": "Process a cash-out",
   "panels": [
    {
     "title": "Cash-out CO-77",
     "rows": [
      [
       "Merchant",
       "Olive House (ACTIVE)"
      ],
      [
       "Amount",
       "500.000 LYD"
      ],
      [
       "Wallet balance",
       "620.000 LYD"
      ],
      [
       "Bank snapshot",
       "Olive House LLC, Bank A ···2210"
      ],
      [
       "Merchant's verified bank (current)",
       "Olive House LLC, Bank A ···2210"
      ],
      [
       "Ledger drift",
       "0.0000"
      ],
      [
       "Open holds",
       "none"
      ],
      [
       "You processed it?",
       "not yet"
      ]
     ]
    }
   ],
   "prompt": "Tick only what you can verify from this record.",
   "points": 10,
   "items": [
    {
     "id": "a",
     "label": "Destination is the merchant's verified account in its legal name",
     "shouldTick": true,
     "why": "Snapshot and verified account agree."
    },
    {
     "id": "b",
     "label": "The merchant is ACTIVE",
     "shouldTick": true,
     "why": "Yes."
    },
    {
     "id": "c",
     "label": "The amount does not exceed the balance",
     "shouldTick": true,
     "why": "500 ≤ 620."
    },
    {
     "id": "d",
     "label": "The ledger drift is zero and payouts are not halted",
     "shouldTick": true,
     "why": "Yes."
    },
    {
     "id": "e",
     "label": "The merchant phoned and said it is urgent",
     "shouldTick": false,
     "why": "Urgency is not a check."
    },
    {
     "id": "f",
     "label": "I may also approve the final subtraction myself",
     "shouldTick": false,
     "why": "A different Finance user must."
    }
   ],
   "criticalWrong": [
    "f"
   ]
  },
  {
   "id": "h2",
   "kind": "choice",
   "title": "Bank details changed",
   "panels": [
    {
     "title": "Cash-out CO-78",
     "rows": [
      [
       "Snapshot bank",
       "Bank A ···1111"
      ],
      [
       "Merchant's bank today",
       "Bank B ···9999 (changed yesterday)"
      ]
     ]
    }
   ],
   "prompt": "Which account does this cash-out pay?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "The snapshot from request time",
     "correct": true,
     "feedback": "Cash-outs keep the details they started with."
    },
    {
     "id": "b",
     "label": "The new account",
     "correct": false,
     "feedback": "Not without a new request."
    },
    {
     "id": "c",
     "label": "Whichever the merchant prefers",
     "correct": false,
     "feedback": "No."
    }
   ]
  },
  {
   "id": "h3",
   "kind": "choice",
   "title": "Refund too large",
   "panels": [
    {
     "title": "Refund request",
     "rows": [
      [
       "Original payment",
       "250.000 LYD"
      ],
      [
       "Requested refund",
       "300.000 LYD"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Reject or ask the maker to correct it; a refund can never exceed the original",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Approve 300",
     "correct": false,
     "feedback": "Impossible.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Split it into 250 + 50",
     "correct": false,
     "feedback": "Splitting does not make it valid.",
     "critical": true
    }
   ]
  },
  {
   "id": "h4",
   "kind": "choice",
   "title": "A wrong executed adjustment",
   "panels": [
    {
     "title": "Adjustment ADJ-9",
     "rows": [
      [
       "Status",
       "EXECUTED"
      ],
      [
       "Amount",
       "150.000 LYD"
      ],
      [
       "Problem",
       "Should have been 105.000"
      ]
     ]
    }
   ],
   "prompt": "How do you correct it?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Propose an offsetting adjustment with **Reverse** and a reason; a different Finance user approves",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Edit ADJ-9",
     "correct": false,
     "feedback": "Never edited.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Delete ADJ-9",
     "correct": false,
     "feedback": "Never deleted.",
     "critical": true
    }
   ]
  },
  {
   "id": "h5",
   "kind": "choice",
   "title": "Chargeback larger than the balance",
   "panels": [
    {
     "title": "Dispute DSP-5",
     "rows": [
      [
       "Chargeback",
       "100.000 LYD"
      ],
      [
       "Wallet",
       "40.000"
      ],
      [
       "Negative-balance ceiling",
       "0"
      ]
     ]
    }
   ],
   "prompt": "What happens and what do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "It will not post; a P1 case opens; choose collect, net or suspend",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Post it and let the wallet go negative",
     "correct": false,
     "feedback": "The ceiling forbids it.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Ignore it",
     "correct": false,
     "feedback": "Evidence deadlines matter."
    }
   ]
  },
  {
   "id": "h6",
   "kind": "choice",
   "title": "Who approves a drafted chargeback?",
   "panels": [
    {
     "title": "Draft",
     "rows": [
      [
       "Created by",
       "SYSTEM_AUTOMATION"
      ],
      [
       "Status",
       "PENDING_REVIEW"
      ]
     ]
    }
   ],
   "prompt": "Who may approve?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "A human FINANCE checker",
     "correct": true,
     "feedback": "The system can never approve or execute."
    },
    {
     "id": "b",
     "label": "The system after 24 hours",
     "correct": false,
     "feedback": "No.",
     "critical": true
    },
    {
     "id": "c",
     "label": "The merchant",
     "correct": false,
     "feedback": "No."
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-reconciliation-desk module=m6 title="Reconciliation Desk" minutes=35 tracks=FINANCE refs=b08-06,b10-05,b08-10
```json
{
 "id": "lab-reconciliation-desk",
 "module": "m6",
 "title": "Reconciliation Desk",
 "minutes": 35,
 "tracks": [
  "FINANCE"
 ],
 "refs": [
  "b08-06",
  "b10-05",
  "b08-10"
 ],
 "briefing": "A statement has just loaded. Classify each line and choose what to do. Never edit a file to make it match.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "e1",
   "kind": "choice",
   "title": "Line 1",
   "panels": [
    {
     "title": "Ours vs statement",
     "table": {
      "columns": [
       "",
       "Ours",
       "Statement"
      ],
      "rows": [
       [
        "Reference",
        "P-500",
        "P-500"
       ],
       [
        "Amount",
        "100.000",
        "100.000"
       ],
       [
        "Fee",
        "0.800",
        "0.800"
       ]
      ]
     }
    }
   ],
   "prompt": "Result?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "MATCHED",
     "correct": true,
     "feedback": "Everything agrees."
    },
    {
     "id": "b",
     "label": "AMOUNT_MISMATCH",
     "correct": false,
     "feedback": "Amounts agree."
    },
    {
     "id": "c",
     "label": "MISSING_AT_GATEWAY",
     "correct": false,
     "feedback": "It is present."
    }
   ]
  },
  {
   "id": "e2",
   "kind": "choice",
   "title": "Line 2",
   "panels": [
    {
     "title": "Ours vs statement",
     "table": {
      "columns": [
       "",
       "Ours",
       "Statement"
      ],
      "rows": [
       [
        "Reference",
        "P-501",
        "(no line)"
       ],
       [
        "Status",
        "SUCCEEDED, 100.000",
        "—"
       ]
      ]
     }
    }
   ],
   "prompt": "Result and urgency?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "MISSING_AT_GATEWAY, the most serious: escalate before any payout",
     "correct": true,
     "feedback": "We may have credited money we did not receive."
    },
    {
     "id": "b",
     "label": "MISSING_LOCALLY",
     "correct": false,
     "feedback": "We have it; they do not."
    },
    {
     "id": "c",
     "label": "MATCHED",
     "correct": false,
     "feedback": "No line."
    }
   ]
  },
  {
   "id": "e3",
   "kind": "choice",
   "title": "Line 3",
   "panels": [
    {
     "title": "Ours vs statement",
     "table": {
      "columns": [
       "",
       "Ours",
       "Statement"
      ],
      "rows": [
       [
        "Reference",
        "(none)",
        "P-777"
       ],
       [
        "Amount",
        "—",
        "50.000"
       ]
      ]
     }
    }
   ],
   "prompt": "Result?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "MISSING_LOCALLY",
     "correct": true,
     "feedback": "Check for a late success or an UNKNOWN attempt we can now resolve."
    },
    {
     "id": "b",
     "label": "DUPLICATE",
     "correct": false,
     "feedback": "Not a duplicate."
    },
    {
     "id": "c",
     "label": "MATCHED",
     "correct": false,
     "feedback": "We have no record."
    }
   ]
  },
  {
   "id": "e4",
   "kind": "choice",
   "title": "Line 4",
   "panels": [
    {
     "title": "Ours vs statement",
     "table": {
      "columns": [
       "",
       "Ours",
       "Statement"
      ],
      "rows": [
       [
        "Reference",
        "P-502",
        "P-502"
       ],
       [
        "Fee accrued",
        "0.800",
        "0.950"
       ]
      ]
     }
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Post a fee variance true-up for 0.150 (Entry 4) through the normal route",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Edit the statement to 0.800",
     "correct": false,
     "feedback": "Never.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Ignore it",
     "correct": false,
     "feedback": "Costs would drift."
    }
   ]
  },
  {
   "id": "e5",
   "kind": "choice",
   "title": "Dates look off by a day",
   "panels": [
    {
     "title": "Note",
     "text": "The partner's file uses Libya time and the platform stores UTC."
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Check the source's time zone setting before concluding there is a mismatch",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Edit all dates",
     "correct": false,
     "feedback": "Never edit.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Reject the file",
     "correct": false,
     "feedback": "Check the setting first."
    }
   ]
  },
  {
   "id": "e6",
   "kind": "choice",
   "title": "The same file again",
   "panels": [
    {
     "title": "Upload",
     "text": "You uploaded the same statement file earlier today."
    }
   ],
   "prompt": "What happens?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "It is refused: the file fingerprint is unique",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "It doubles the matches",
     "correct": false,
     "feedback": "No."
    },
    {
     "id": "c",
     "label": "It overwrites",
     "correct": false,
     "feedback": "No."
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-compliance-desk module=m7 title="Compliance Desk" minutes=45 tracks=COMPLIANCE,MLRO refs=b09-03,b09-05,b09-06,b09-07,b09-08
```json
{
 "id": "lab-compliance-desk",
 "module": "m7",
 "title": "Compliance Desk",
 "minutes": 45,
 "tracks": [
  "COMPLIANCE",
  "MLRO"
 ],
 "refs": [
  "b09-03",
  "b09-05",
  "b09-06",
  "b09-07",
  "b09-08"
 ],
 "briefing": "You are Compliance. Decide with evidence, propose with a rationale, and keep everything confidential.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "m1",
   "kind": "choice",
   "title": "An Arabic name match",
   "panels": [
    {
     "title": "Candidate",
     "rows": [
      [
       "Subject",
       "Owner of Alamal Logistics"
      ],
      [
       "Name (Arabic)",
       "محمد علي الأحمد"
      ],
      [
       "Listed person",
       "Same name, born 1961, nationality X"
      ],
      [
       "Owner",
       "Born 1989, nationality Libyan, ID verified"
      ],
      [
       "Score",
       "0.83"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "**Disposition** FALSE_POSITIVE with the compared attributes as the rationale; suppression with an expiry date",
     "correct": true,
     "feedback": "Correct. Date of birth and nationality differ."
    },
    {
     "id": "b",
     "label": "TRUE_MATCH because the score is high",
     "correct": false,
     "feedback": "A score is not a decision."
    },
    {
     "id": "c",
     "label": "Ignore it",
     "correct": false,
     "feedback": "Every match must be decided.",
     "critical": true
    }
   ]
  },
  {
   "id": "m2",
   "kind": "choice",
   "title": "A true PEP hit",
   "panels": [
    {
     "title": "Candidate",
     "rows": [
      [
       "Subject",
       "Beneficial owner"
      ],
      [
       "Listed",
       "PEP: same name, same date of birth, same ID prefix"
      ],
      [
       "Merchant",
       "Al-Reef Trading"
      ]
     ]
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Mark TRUE_MATCH and escalate to the MLRO; raise the severity at least HIGH",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Mark FALSE_POSITIVE to keep the merchant happy",
     "correct": false,
     "feedback": "Never because of importance.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Phone the merchant to ask about it",
     "correct": false,
     "feedback": "Tipping-off.",
     "critical": true
    }
   ]
  },
  {
   "id": "m3",
   "kind": "choice",
   "title": "What do you tell the merchant?",
   "panels": [
    {
     "title": "Merchant calls",
     "text": "\"Is this about compliance? My cash-out is frozen.\""
    }
   ],
   "prompt": "You say:",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "\"Your account is currently restricted. Please contact the support address in your notice.\"",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "\"It is a sanctions check.\"",
     "correct": false,
     "feedback": "Tipping-off.",
     "critical": true
    },
    {
     "id": "c",
     "label": "\"No, it is not compliance.\"",
     "correct": false,
     "feedback": "A false denial is also wrong."
    }
   ]
  },
  {
   "id": "m4",
   "kind": "multi",
   "title": "What raises case severity?",
   "panels": [
    {
     "title": "Case"
    }
   ],
   "prompt": "Select all the inputs that raise severity.",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "A velocity FLAG and an AML rule hit on the same payment",
     "correct": true,
     "feedback": "Correlated signals: CRITICAL."
    },
    {
     "id": "b",
     "label": "A PEP possible match",
     "correct": true,
     "feedback": "At least HIGH."
    },
    {
     "id": "c",
     "label": "Merchant risk tier HIGH",
     "correct": true,
     "feedback": "One level up."
    },
    {
     "id": "d",
     "label": "The merchant's logo colour",
     "correct": false,
     "feedback": "Irrelevant."
    },
    {
     "id": "e",
     "label": "The same subject already has an open case",
     "correct": true,
     "feedback": "One level up."
    }
   ]
  },
  {
   "id": "m5",
   "kind": "choice",
   "title": "Proposing a resolution",
   "panels": [
    {
     "title": "Case",
     "rows": [
      [
       "Severity",
       "MEDIUM"
      ],
      [
       "Held",
       "100.000 LYD"
      ],
      [
       "Investigation",
       "Payments consistent with declared business; customer confirmed in writing"
      ]
     ]
    }
   ],
   "prompt": "What do you propose?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "**Propose resolution** release with a written rationale; the MLRO approves; money moves only after approval",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Release it yourself",
     "correct": false,
     "feedback": "Maker cannot approve.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Tell the merchant it is released",
     "correct": false,
     "feedback": "Do not discuss the case.",
     "critical": true
    }
   ]
  },
  {
   "id": "m6",
   "kind": "choice",
   "title": "A provisional reporting rule",
   "panels": [
    {
     "title": "Report",
     "rows": [
      [
       "Rule",
       "PROVISIONAL"
      ],
      [
       "Status",
       "DRAFT"
      ]
     ]
    }
   ],
   "prompt": "Can this be filed live?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "No. A provisional rule can never produce a live filing",
     "correct": true,
     "feedback": "The database refuses it."
    },
    {
     "id": "b",
     "label": "Yes after the MLRO approves",
     "correct": false,
     "feedback": "Still refused.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Yes if urgent",
     "correct": false,
     "feedback": "No."
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-build-a-rail module=m8 title="Build-a-Rail Lab: configure a two-step OTP rail" minutes=45 tracks=GATEWAY_ADMIN refs=b06-03,b06-04,b06-07,b06-08,b06-13,b06-14
```json
{
 "id": "lab-build-a-rail",
 "module": "m8",
 "title": "Build-a-Rail Lab: configure a two-step OTP rail",
 "minutes": 45,
 "tracks": [
  "GATEWAY_ADMIN"
 ],
 "refs": [
  "b06-03",
  "b06-04",
  "b06-07",
  "b06-08",
  "b06-13",
  "b06-14"
 ],
 "briefing": "You are configuring a simulated two-step OTP rail (Edfali/Sadad style). Make safe choices. Nothing here is real.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "b1",
   "kind": "numeric",
   "title": "Amount scale",
   "panels": [
    {
     "title": "Partner docs",
     "rows": [
      [
       "Amount format",
       "Integer of dirhams"
      ],
      [
       "Our amount",
       "10.500 LYD"
      ]
     ]
    }
   ],
   "prompt": "What must the wire amount be (digits only)?",
   "points": 10,
   "answer": "10500",
   "tolerance": "0",
   "feedback": "10.500 LYD is 10500 dirhams. Sending 10.50 would charge ten dirhams; sending 10500 to a dinar gateway would charge 10500 dinars.",
   "unit": "dirhams"
  },
  {
   "id": "b2",
   "kind": "choice",
   "title": "Retry policy on the confirm step",
   "panels": [
    {
     "title": "Step",
     "rows": [
      [
       "Phase",
       "SUBMIT"
      ],
      [
       "side_effect",
       "MOVES_MONEY"
      ],
      [
       "Idempotency",
       "not proven"
      ]
     ]
    }
   ],
   "prompt": "Which retry policy?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "NEVER",
     "correct": true,
     "feedback": "Correct; a lost reply and a lost request look identical."
    },
    {
     "id": "b",
     "label": "SAFE",
     "correct": false,
     "feedback": "Could pay twice.",
     "critical": true
    },
    {
     "id": "c",
     "label": "SAFE_WITH_COOLDOWN",
     "correct": false,
     "feedback": "Still repeats the money step.",
     "critical": true
    }
   ]
  },
  {
   "id": "b3",
   "kind": "choice",
   "title": "Channel strength",
   "panels": [
    {
     "title": "Partner",
     "rows": [
      [
       "Webhook",
       "unsigned, shared token in the address"
      ],
      [
       "Status question",
       "available"
      ]
     ]
    }
   ],
   "prompt": "How do you set the channel?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Mark it weak and turn on must_inquire so we ask the partner before believing",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Trust the webhook alone",
     "correct": false,
     "feedback": "A shared token is weak.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Disable all channels",
     "correct": false,
     "feedback": "Then nothing confirms."
    }
   ]
  },
  {
   "id": "b4",
   "kind": "order",
   "title": "Status rules order",
   "panels": [
    {
     "title": "Rules"
    }
   ],
   "prompt": "Order the rules the way they must be evaluated: first match wins.",
   "points": 10,
   "items": [
    {
     "id": "a",
     "label": "Explicit success code → SUCCEEDED"
    },
    {
     "id": "b",
     "label": "Explicit decline codes → FAILED"
    },
    {
     "id": "c",
     "label": "Pending codes → VERIFYING"
    },
    {
     "id": "d",
     "label": "Anything else on a money step → UNKNOWN"
    }
   ],
   "correctOrder": [
    "a",
    "b",
    "c",
    "d"
   ],
   "feedback": "Specific rules first; the catch-all on a money step is UNKNOWN, never FAILED."
  },
  {
   "id": "b5",
   "kind": "multi",
   "title": "Find the mistakes",
   "panels": [
    {
     "title": "Draft recipe summary",
     "table": {
      "columns": [
       "Setting",
       "Value"
      ],
      "rows": [
       [
        "Money step retry",
        "SAFE"
       ],
       [
        "First step uses a value from an earlier answer",
        "yes"
       ],
       [
        "Weak channel must_inquire",
        "off"
       ],
       [
        "Amount format",
        "dirham integer, scale 1000"
       ],
       [
        "Request host",
        "an allowed https host"
       ]
      ]
     }
    }
   ],
   "prompt": "Select all settings that the wizard would REFUSE to save.",
   "points": 12,
   "options": [
    {
     "id": "a",
     "label": "Money step retry SAFE",
     "correct": true,
     "feedback": "Money steps must be NEVER."
    },
    {
     "id": "b",
     "label": "Value from an earlier answer on the first step",
     "correct": true,
     "feedback": "There is no earlier answer."
    },
    {
     "id": "c",
     "label": "Weak channel with must_inquire off",
     "correct": true,
     "feedback": "Must ask the partner."
    },
    {
     "id": "d",
     "label": "Amount format dirham integer with scale 1000",
     "correct": false,
     "feedback": "Fine for a dirham gateway."
    },
    {
     "id": "e",
     "label": "Request host an allowed https host",
     "correct": false,
     "feedback": "Fine."
    }
   ]
  },
  {
   "id": "b6",
   "kind": "choice",
   "title": "AI import",
   "panels": [
    {
     "title": "Situation",
     "text": "The AI returned a spec. It passed layers 1–3. Layer 4 says the gateway code already exists."
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Choose New Version (draft); the draft still needs the credential check, gates and a second person",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Publish it live",
     "correct": false,
     "feedback": "Passed checks are not approval.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Paste the live secret into the AI to fix it",
     "correct": false,
     "feedback": "Never.",
     "critical": true
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-rails-visibility module=m8 title="Why Is the Payment Method Missing?" minutes=30 tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN refs=b06-12,b06-11
```json
{
 "id": "lab-rails-visibility",
 "module": "m8",
 "title": "Why Is the Payment Method Missing?",
 "minutes": 30,
 "tracks": [
  "OPERATOR",
  "SUPPORT",
  "GATEWAY_ADMIN"
 ],
 "refs": [
  "b06-12",
  "b06-11"
 ],
 "briefing": "For each report, find the FIRST visible-rails condition that fails. Conditions: 1 application list, 2 link list, 3 commission profile, 4 route active, 5 route healthy, 6 limits and daily cap, 7 maintenance or scope, 8 credential verified, 9 currency and blocked.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "v1",
   "kind": "choice",
   "title": "Edfali at 100 LYD",
   "panels": [
    {
     "title": "Facts",
     "rows": [
      [
       "Link amount",
       "100 LYD"
      ],
      [
       "Edfali direct route",
       "ACTIVE, HEALTHY, max 1000, daily cap 20000, already 19950 today"
      ],
      [
       "Edfali aggregator route",
       "OPEN_BREAKER"
      ],
      [
       "Application list",
       "all"
      ],
      [
       "Commission profile",
       "live"
      ]
     ]
    }
   ],
   "prompt": "Why is Edfali hidden?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Condition 6: the daily cap would be exceeded",
     "correct": true,
     "feedback": "19950 + 100 > 20000."
    },
    {
     "id": "b",
     "label": "Condition 9: currency",
     "correct": false,
     "feedback": "Currency matches."
    },
    {
     "id": "c",
     "label": "Condition 2: link list",
     "correct": false,
     "feedback": "No list."
    }
   ]
  },
  {
   "id": "v2",
   "kind": "choice",
   "title": "Sadad at 02:30",
   "panels": [
    {
     "title": "Facts",
     "rows": [
      [
       "Sadad direct route",
       "ACTIVE, HEALTHY, within limits, maintenance 02:00–03:00"
      ],
      [
       "Time",
       "02:30"
      ]
     ]
    }
   ],
   "prompt": "Why is Sadad hidden?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Condition 7: maintenance window",
     "correct": true,
     "feedback": "Outside 02:00–03:00 it returns."
    },
    {
     "id": "b",
     "label": "Condition 5: unhealthy",
     "correct": false,
     "feedback": "It is healthy."
    },
    {
     "id": "c",
     "label": "Condition 8: credentials",
     "correct": false,
     "feedback": "Verified."
    }
   ]
  },
  {
   "id": "v3",
   "kind": "choice",
   "title": "Sadad for 3000 LYD",
   "panels": [
    {
     "title": "Facts",
     "rows": [
      [
       "Link amount",
       "3000 LYD"
      ],
      [
       "Sadad route maximum",
       "2000"
      ]
     ]
    }
   ],
   "prompt": "Which condition fails?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Condition 6",
     "correct": true,
     "feedback": "Amount above the maximum."
    },
    {
     "id": "b",
     "label": "Condition 3",
     "correct": false,
     "feedback": "Profile exists."
    },
    {
     "id": "c",
     "label": "Condition 1",
     "correct": false,
     "feedback": "No list."
    }
   ]
  },
  {
   "id": "v4",
   "kind": "choice",
   "title": "Application whitelist",
   "panels": [
    {
     "title": "Facts",
     "rows": [
      [
       "Application whitelist",
       "Sadad only"
      ],
      [
       "Customer looks for",
       "Moamalat Card"
      ]
     ]
    }
   ],
   "prompt": "Condition?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Condition 1",
     "correct": true,
     "feedback": "The application does not allow it."
    },
    {
     "id": "b",
     "label": "Condition 6",
     "correct": false,
     "feedback": "Limits fine."
    },
    {
     "id": "c",
     "label": "Condition 9",
     "correct": false,
     "feedback": "Currency fine."
    }
   ]
  },
  {
   "id": "v5",
   "kind": "choice",
   "title": "NeomPay is not shown",
   "panels": [
    {
     "title": "Facts",
     "rows": [
      [
       "NeomPay route",
       "ACTIVE, HEALTHY, verified"
      ],
      [
       "Live commission profile",
       "none"
      ]
     ]
    }
   ],
   "prompt": "Condition?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Condition 3",
     "correct": true,
     "feedback": "No commission profile covers it."
    },
    {
     "id": "b",
     "label": "Condition 5",
     "correct": false,
     "feedback": "Healthy."
    },
    {
     "id": "c",
     "label": "Condition 8",
     "correct": false,
     "feedback": "Verified."
    }
   ]
  },
  {
   "id": "v6",
   "kind": "choice",
   "title": "Visa/Mastercard on a LYD link",
   "panels": [
    {
     "title": "Facts",
     "rows": [
      [
       "Rail currency",
       "USD"
      ],
      [
       "Link currency",
       "LYD"
      ],
      [
       "Everything else",
       "fine"
      ]
     ]
    }
   ],
   "prompt": "Condition?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Condition 9",
     "correct": true,
     "feedback": "Currency differs."
    },
    {
     "id": "b",
     "label": "Condition 4",
     "correct": false,
     "feedback": "Active."
    },
    {
     "id": "c",
     "label": "Condition 7",
     "correct": false,
     "feedback": "Fine."
    }
   ]
  },
  {
   "id": "v7",
   "kind": "choice",
   "title": "What would you NOT do?",
   "panels": [
    {
     "title": "A merchant is annoyed"
    }
   ],
   "prompt": "Which action is wrong?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Raise the route's maximum to make a test pass",
     "correct": true,
     "feedback": "Limits are money rules; never change them to pass a test."
    },
    {
     "id": "b",
     "label": "Walk down the table to find the first failing condition",
     "correct": false,
     "feedback": "Right approach."
    },
    {
     "id": "c",
     "label": "Tell the Gateway Admin about a breaker",
     "correct": false,
     "feedback": "Right."
    }
   ]
  }
 ]
}
```
@@end

@@lab id=lab-gate-review module=m8 title="Go-Live Gate Review: be the approver" minutes=40 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b06-16,b06-13,b06-14,b06-10
```json
{
 "id": "lab-gate-review",
 "module": "m8",
 "title": "Go-Live Gate Review: be the approver",
 "minutes": 40,
 "tracks": [
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN"
 ],
 "refs": [
  "b06-16",
  "b06-13",
  "b06-14",
  "b06-10"
 ],
 "briefing": "A gateway version has been submitted. You are the Security Admin. Read the evidence and decide.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "q1",
   "kind": "multi",
   "title": "Read the gate results",
   "panels": [
    {
     "title": "Submission GV-31",
     "table": {
      "columns": [
       "Gate",
       "Result"
      ],
      "rows": [
       [
        "1 Two-person approval",
        "pending your approval"
       ],
       [
        "2 15-scenario suite",
        "green"
       ],
       [
        "3 Amount contract test",
        "FAILED: 10.50 LYD produced \"10.50\" for a dirham-integer gateway"
       ],
       [
        "4 Reference format",
        "green"
       ],
       [
        "5 Signature contract test",
        "green"
       ],
       [
        "6 Channel strength",
        "green"
       ],
       [
        "7 Rollback version",
        "named GV-29"
       ],
       [
        "9 Evidence level",
        "UNVERIFIED, no risk acceptance"
       ],
       [
        "11 Canary plan",
        "missing"
       ]
      ]
     }
    }
   ],
   "prompt": "Select every problem that should stop approval.",
   "points": 12,
   "options": [
    {
     "id": "a",
     "label": "Amount contract test failed",
     "correct": true,
     "feedback": "Gate 3."
    },
    {
     "id": "b",
     "label": "Evidence level UNVERIFIED with no acceptance",
     "correct": true,
     "feedback": "Gate 9."
    },
    {
     "id": "c",
     "label": "Canary plan missing",
     "correct": true,
     "feedback": "Gate 11."
    },
    {
     "id": "d",
     "label": "15-scenario suite green",
     "correct": false,
     "feedback": "Good."
    },
    {
     "id": "e",
     "label": "Rollback version named",
     "correct": false,
     "feedback": "Good."
    }
   ]
  },
  {
   "id": "q2",
   "kind": "choice",
   "title": "Decision",
   "panels": [
    {
     "title": "Your decision"
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Reject with a reason listing the failed gates",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Approve; the maker is senior",
     "correct": false,
     "feedback": "Never approve what fails a gate.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Approve and fix later",
     "correct": false,
     "feedback": "Never.",
     "critical": true
    }
   ]
  },
  {
   "id": "q3",
   "kind": "choice",
   "title": "An imported draft",
   "panels": [
    {
     "title": "Draft",
     "rows": [
      [
       "Source",
       "AI import"
      ],
      [
       "Route",
       "PAUSED"
      ],
      [
       "Credential set",
       "UNTESTED"
      ]
     ]
    }
   ],
   "prompt": "What is still required?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "The live credential check, the twelve gates and a second person",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Nothing; it is imported",
     "correct": false,
     "feedback": "It is only a draft.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Only the preview",
     "correct": false,
     "feedback": "Not enough."
    }
   ]
  },
  {
   "id": "q4",
   "kind": "choice",
   "title": "A running payment during promotion",
   "panels": [
    {
     "title": "Facts",
     "text": "You approve the new version at noon. A payment started at 11:59."
    }
   ],
   "prompt": "Which version does that payment finish on?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "The old version",
     "correct": true,
     "feedback": "Each attempt is pinned."
    },
    {
     "id": "b",
     "label": "The new version",
     "correct": false,
     "feedback": "No."
    },
    {
     "id": "c",
     "label": "It restarts",
     "correct": false,
     "feedback": "No."
    }
   ]
  },
  {
   "id": "q5",
   "kind": "choice",
   "title": "Rollback",
   "panels": [
    {
     "title": "Facts",
     "text": "The new version misbehaves after promotion."
    }
   ],
   "prompt": "What do you do?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Pause the route if needed and roll back to the named version through the normal review",
     "correct": true,
     "feedback": "Correct."
    },
    {
     "id": "b",
     "label": "Edit the live version",
     "correct": false,
     "feedback": "Not possible.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Delete the gateway",
     "correct": false,
     "feedback": "No.",
     "critical": true
    }
   ]
  }
 ]
}
```
@@end


@@lab id=lab-backup-dr-desk module=m10 title="Backup and Recovery Desk: read the screen, judge the drill" minutes=25 tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-09,b12-10,b12-11,b10-05
```json
{
 "id": "lab-backup-dr-desk",
 "module": "m10",
 "title": "Backup and Recovery Desk: read the screen, judge the drill",
 "minutes": 25,
 "tracks": [
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN"
 ],
 "refs": [
  "b12-09",
  "b12-10",
  "b12-11",
  "b10-05"
 ],
 "briefing": "You are on duty at the Backups screen. Read the tiles, know what a restore drill checks, react to a failed drill and review a policy change.",
 "passPercent": 80,
 "tasks": [
  {
   "id": "b1",
   "kind": "choice",
   "title": "Read the tiles",
   "panels": [
    {
     "title": "Backups screen, summary tiles",
     "rows": [
      [
       "WAL archive lag",
       "4,200 s (alert threshold 300 s): Critical"
      ],
      [
       "Daemon status",
       "Reachable: Healthy"
      ],
      [
       "Storage targets",
       "2/3: Attention"
      ],
      [
       "Last backup",
       "Passed, 02:00 UTC today"
      ],
      [
       "Latest restore drill",
       "Drill passed, Sunday 04:00 UTC"
      ]
     ]
    }
   ],
   "prompt": "What is the most urgent problem?",
   "points": 10,
   "options": [
    {
     "id": "a",
     "label": "Archiving is far behind and one storage target has failed, so recent changes are not safely stored",
     "correct": true,
     "feedback": "Correct. A passed nightly backup does not cover the last hours; WAL piles up on the database disk."
    },
    {
     "id": "b",
     "label": "Nothing: the last backup passed and the last drill passed",
     "correct": false,
     "feedback": "Both are old news. The lag tile is Critical and a target is down.",
     "critical": true
    },
    {
     "id": "c",
     "label": "The daemon is unreachable",
     "correct": false,
     "feedback": "Daemon status says Reachable."
    }
   ]
  },
  {
   "id": "b2",
   "kind": "multi",
   "title": "What a drill checks",
   "panels": [
    {
     "title": "Restore drill",
     "text": "The daemon restores the latest backup chain into a scratch cluster, replays WAL to the target time and then checks the restored data."
    }
   ],
   "prompt": "Which checks are part of every restore drill?",
   "points": 12,
   "options": [
    {
     "id": "a",
     "label": "Double-entry zero drift",
     "correct": true,
     "feedback": "Yes. Debits equal credits in the restored ledger."
    },
    {
     "id": "b",
     "label": "Sharded balance parity",
     "correct": true,
     "feedback": "Yes. Shard totals match the journal lines."
    },
    {
     "id": "c",
     "label": "Audit hash chain, including a gap-free sequence",
     "correct": true,
     "feedback": "Yes. Every audit record is present, in order and untampered."
    },
    {
     "id": "d",
     "label": "Checkout page loads in Arabic",
     "correct": false,
     "feedback": "Not a drill check."
    },
    {
     "id": "e",
     "label": "Production CPU stays under 50 percent",
     "correct": false,
     "feedback": "The drill does not run on production."
    }
   ]
  },
  {
   "id": "b3",
   "kind": "order",
   "title": "Order the drill",
   "panels": [
    {
     "title": "What the daemon does during a drill"
    }
   ],
   "prompt": "Put the steps in order.",
   "points": 12,
   "items": [
    {
     "id": "a",
     "label": "Restore the latest backup chain into an isolated scratch cluster (loopback, port 55432, archiving off)"
    },
    {
     "id": "b",
     "label": "Replay archived WAL to the target time (default: now minus 5 minutes)"
    },
    {
     "id": "c",
     "label": "Wait until recovery has finished"
    },
    {
     "id": "d",
     "label": "Run the three invariant checks"
    },
    {
     "id": "e",
     "label": "Sign the report with HMAC-SHA256"
    },
    {
     "id": "f",
     "label": "Destroy the scratch cluster"
    }
   ],
   "correctOrder": [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f"
   ],
   "feedback": "Restore, replay, wait for recovery, check, sign, destroy. Checks run only after recovery has finished, and no customer data is left behind."
  },
  {
   "id": "b4",
   "kind": "choice",
   "title": "A failed drill",
   "panels": [
    {
     "title": "Latest restore drill: Drill failed",
     "rows": [
      [
       "Double-entry zero drift",
       "Passed"
      ],
      [
       "Sharded balance parity",
       "Passed"
      ],
      [
       "Audit hash chain",
       "Failed"
      ]
     ]
    }
   ],
   "prompt": "What is the right reaction?",
   "points": 12,
   "options": [
    {
     "id": "a",
     "label": "Priority-1 incident: escalate to the Security Admin, keep every backup and do not alter audit records",
     "correct": true,
     "feedback": "Correct. An audit chain failure may mean tampering or damage."
    },
    {
     "id": "b",
     "label": "Ignore it: the money checks passed",
     "correct": false,
     "feedback": "Any failed check is priority 1.",
     "critical": true
    },
    {
     "id": "c",
     "label": "Delete the audit database and run another drill",
     "correct": false,
     "feedback": "Never destroy evidence.",
     "critical": true
    },
    {
     "id": "d",
     "label": "Run drills until one passes and file only that one",
     "correct": false,
     "feedback": "Hiding a failure is as bad as the failure."
    }
   ]
  },
  {
   "id": "b5",
   "kind": "checklist",
   "title": "Review a policy change",
   "panels": [
    {
     "title": "You are the second Security Admin. Request BACKUP_POLICY, PENDING_REVIEW.",
     "rows": [
      [
       "Maker",
       "Omar (a different person)"
      ],
      [
       "Changed field",
       "Full retention days: 56 to 1"
      ],
      [
       "Other fields",
       "unchanged"
      ],
      [
       "Maker's reason",
       "Free up disk space"
      ]
     ]
    }
   ],
   "prompt": "Tick only the statements the record supports.",
   "points": 10,
   "items": [
    {
     "id": "c1",
     "label": "I am a different person from the maker",
     "shouldTick": true,
     "why": "Stated in the request; the checker must differ from the maker."
    },
    {
     "id": "c2",
     "label": "The change cuts the history we can recover from to about one day",
     "shouldTick": true,
     "why": "Retention goes from 56 days to 1."
    },
    {
     "id": "c3",
     "label": "The maker has confirmed with the Security team that one day is enough",
     "shouldTick": false,
     "why": "Nothing in the record says so; do not tick what you did not verify."
    },
    {
     "id": "c4",
     "label": "Approving will apply the change to the daemon and write BACKUP_POLICY_UPDATED to the audit log",
     "shouldTick": true,
     "why": "That is what approval does."
    },
    {
     "id": "c5",
     "label": "The Alert lag threshold is also changing",
     "shouldTick": false,
     "why": "Only Full retention days differs."
    }
   ],
   "criticalWrong": [
    "c3"
   ]
  },
  {
   "id": "b6",
   "kind": "numeric",
   "title": "The restore chain",
   "panels": [
    {
     "title": "Defaults",
     "rows": [
      [
       "Full backup",
       "Sunday 02:00 UTC"
      ],
      [
       "Delta backup",
       "Monday to Saturday 02:00 UTC"
      ],
      [
       "Disk failure",
       "Wednesday 14:35 UTC"
      ]
     ]
    }
   ],
   "prompt": "How many backups (the full plus the deltas) form the restore chain before WAL is replayed?",
   "points": 10,
   "answer": "4",
   "tolerance": "0",
   "feedback": "One full (Sunday) plus deltas on Monday, Tuesday and Wednesday 02:00. Each delta builds on the previous one. WAL then covers the time after Wednesday 02:00."
  }
 ]
}
```
@@end


## III-F. Optional live drills (Fake Rails, staging only)

@@drill id=drill-wrong-otp title="Wrong code, then the right code" rail=edfali minutes=15 refs=b07-07,b06-08
### Setup
Staging environment, Fake Rails running, rail `edfali` healthy (0% failure). A trainer sits with the learner. Use only test phone numbers.
### Do
1. Start a payment on a single-use link and choose the OTP rail.
2. Enter the OTP `000000`.
3. Enter the correct OTP shown in the Fake Rails dashboard.
### Expect
* After step 2 the checkout stays on the code screen and shows a retryable error. No new SMS is sent. The attempt returns to `AWAITING_CUSTOMER`.
* After step 3 the attempt becomes `SUCCEEDED` and the ledger entry exists.
### Debrief questions
Why did the wrong code not trip the circuit breaker? How many tries are allowed by default? What would a third wrong code do?
@@end

@@drill id=drill-insufficient-funds title="Insufficient funds" rail=edfali minutes=10 refs=b06-08,b07-02
### Setup
As in the first drill.
### Do
Start a payment with a phone number ending `9901`, or use OTP `999999`.
### Expect
The attempt ends `FAILED` with a customer message about funds. The link slot is released and the link can be tried again.
### Debrief questions
Which error classification is this? Why is it not a gateway fault?
@@end

@@drill id=drill-limit-exceeded title="Limit exceeded" rail=sadad minutes=10 refs=b06-08,b07-02
### Setup
Rail `sadad` healthy.
### Do
Start a payment with a phone number ending `9902`.
### Expect
The attempt ends `FAILED` with a limit message. Nothing is posted.
### Debrief questions
Does a customer limit count toward the circuit breaker?
@@end

@@drill id=drill-confirm-500 title="Server error on the money step" rail=sadad minutes=20 refs=b07-03,b06-03
### Setup
Rail `sadad` healthy. Open Operator Cases in the Back Office on staging.
### Do
Start a payment with a phone number ending `9905` (or OTP `500500`) and confirm.
### Expect
The attempt becomes `UNKNOWN` (not `FAILED`). The link slot stays reserved. An operator case of kind `UNKNOWN` appears. The step log shows the server error.
### Debrief questions
Why is a server error on a money step not a failure? What do you do first? What must you not do?
@@end

@@drill id=drill-confirm-timeout title="Silence on the money step" rail=sadad minutes=20 refs=b07-03,b07-09
### Setup
As above.
### Do
Start a payment with a phone number ending `9906` (or OTP `408408`) and confirm. The partner hangs for 20 seconds.
### Expect
After the step's time limit the attempt becomes `UNKNOWN`. Press **Inquire**; practise reading the step log.
### Debrief questions
How long did the step wait? What would a retry have risked?
@@end

@@drill id=drill-malformed-200 title="An answer nobody understands" rail=sadad minutes=15 refs=b06-08,b07-03
### Setup
As above.
### Do
Start a payment with a phone number ending `9907`. The partner answers 200 with an unexpected body.
### Expect
No status rule matches on the money step, so the attempt becomes `UNKNOWN`.
### Debrief questions
Why is "no rule matched" treated as unknown rather than failed?
@@end

@@drill id=drill-webhook-replay title="Duplicate and forged webhooks" rail=edfali minutes=20 refs=b07-05,b06-06
### Setup
Complete a successful payment. Open the transaction in the Fake Rails portal.
### Do
1. Use **Trigger Webhook Replay**.
2. Use **Send Forged-Signature Webhook**.
### Expect
The replay is absorbed: no second ledger entry and the attempt stays `SUCCEEDED`. The forged message is rejected and a signature-failure alert is raised.
### Debrief questions
Why can a repeated webhook not double-credit? What would a spike of such failures mean in production?
@@end

@@drill id=drill-breaker title="A partner outage and the circuit breaker" rail=sadad minutes=25 refs=b10-02,b06-11
### Setup
Rails `sadad` direct and an aggregator route both configured. Fake Rails: set the direct rail to **Full Outage 503**.
### Do
Start several payments. Watch the Dashboard Route health card entry **Open breaker** and the customer's choices.
### Expect
After repeated faults the direct route's health becomes `OPEN_BREAKER`, the customer stops seeing it, and new payments use the next healthy route. Some payments in flight may become `UNKNOWN`. When you restore the rail the breaker closes.
### Debrief questions
Which runbook applies? What do you tell the Gateway Admin? What must you not do while the partner is failing?
@@end

@@drill id=drill-statement-anomalies title="Statement anomalies" rail=edfali minutes=30 refs=b08-06,b10-05
### Setup
Make several successful payments. In the Fake Rails portal open the Settlement Statement Generator.
### Do
Generate a statement with: omit one transaction; add one unrecorded transaction; inject a fee variance. Load it on the Reconciliation screen.
### Expect
The omitted payment shows `MISSING_AT_GATEWAY`; the extra shows `MISSING_LOCALLY`; the fee variance shows `AMOUNT_MISMATCH`.
### Debrief questions
Which result is the most serious and why? What entry fixes the fee variance? Why must you never edit the file?
@@end

@@drill id=drill-dispute title="An upstream dispute" rail=moamalat minutes=25 refs=b08-09,b08-08
### Setup
A successful card payment on staging.
### Do
In the Fake Rails portal use **Open Upstream Chargeback/Dispute Webhook**. Open Disputes and Adjustments in the Back Office.
### Expect
A dispute opens, the payment becomes `DISPUTED`, and a chargeback adjustment is drafted by the system and waits for a human Finance checker. No money has moved yet.
### Debrief questions
Who may approve the drafted chargeback? What happens if the wallet is too small?
@@end


@@drill id=drill-pitr-recovery title="Point-in-time recovery rehearsal and a silent daemon" rail=none minutes=30 refs=b12-09,b12-10,b12-11
### Setup
Staging environment only, with the backup daemon running, **Daemon status** **Reachable** and at least one full backup already **Passed** on **Operations**, **Backups**. A Security Admin (`security:write`) sits with the learner, and the people who run the staging servers are available. Fake Rails is running so payments can be created. This drill does not use a payment rail; no rail is involved. Never run it in production.
### Do
1. Open **Operations**, **Backups**. Note **WAL archive lag**, **Last backup** and **Latest restore drill**.
2. Make several test payments with Fake Rails so the ledger has fresh data.
3. Click **Run backup now**, choose **Backup target** **PostgreSQL core** and **Backup kind** **Delta**, and wait until the row in **Scheduled backups** reads **Passed**.
4. Make a few more payments, then wait at least six minutes. The drill replays WAL to now minus 5 minutes by default.
5. Click **Run restore drill**, confirm, and press **Refresh** until **Latest restore drill** shows a result. Read **Target time**, **Replayed LSN**, **Duration**, **Journal lines** and the three badges.
6. Ask the server team to stop the backup daemon service on staging for two minutes. Press **Refresh**.
7. Ask them to start it again and press **Refresh** until **Daemon status** is **Reachable**.
### Expect
* After step 3 the delta backup moves from **Queued** to **Running** to **Passed**, with **Size** and **Duration** filled and **Error** empty.
* After step 5 the result is **Drill passed** and **Double-entry zero drift**, **Sharded balance parity** and **Audit hash chain** each read **Passed**. **Journal lines** is not empty.
* After step 6 **Daemon status** reads **Unreachable**, the red banner about the unreachable daemon appears, and **Run backup now**, **Run restore drill** and **Edit policy** are disabled.
* After step 7 the buttons return and **WAL archive lag** falls back below the **Alert threshold**.
### Debrief questions
Why is one drill pass worth more than a green **Last backup** tile? Why did the drill not touch the staging database? Which payments were inside the restore point and which were not, and why? What does PostgreSQL do with WAL it could not deliver while the daemon was silent, and what would a long outage risk?
@@end

## III-G. Trainer and manager guide, III-H. Learner texts

@@page id=page-how-it-works title="How the Academy works"
## Learn, check, do, prove
1. **Learn.** Each lesson is a short summary with the Guide articles you must read.
2. **Check.** Two quick questions after every lesson. Every answer is explained, whether you were right or wrong.
3. **Do.** Labs are simulated desks. You make real decisions with real button names, and you get immediate feedback. You can repeat any lab as often as you like.
4. **Prove.** The exam decides your badge.

## What you must complete
* **Foundation** first. Everyone does it.
* Then **your role track**.
* You may open any lesson or lab at any time. Only the exam is locked, until you have finished the lessons and passed the labs of the track.

## Exams
* Every exam has a pass mark of 80% **and** critical questions. A critical question protects money or people. Missing any one of them fails the exam, whatever your percentage.
* The exam is graded by the server. You see the explanations after you submit.
* After a failed exam you wait 30 minutes. After three failures in a row you must revisit the lessons of the modules where you scored below 70%.
* Your badge is valid for 12 months. When it expires, or when the Academy content changes in a major way, you retake the exam.

## What a badge means
A badge says you passed the programme. It does not give you any permission. Your manager decides about authorities.

## Nothing here is real
Labs and lessons use made-up data and the sandbox. Nothing you do in the Academy touches real money or real people.
@@end

@@page id=page-scoring title="How scoring works"
## Lessons
Each lesson has two checks. They never block you. Their job is to teach.

## Labs
Each task has points. After you press **Check** you see the result, the explanation and what would have happened in real life. The lab score is the percentage of points earned. To pass you need **80% or more** and **no critical error**. A critical error is a choice that would be seriously harmful in real life (for example guessing on an unknown payment, or sharing a secret). Using a hint costs one point.

## Exams
One point per question. Pass mark 80% and no critical question missed. Multi-answer questions are all-or-nothing. Number questions must match exactly. Ordering questions must be in the exact order.
@@end

@@page id=page-integrity title="Integrity statement"
You will be asked to confirm this before your first exam.

I will take every exam alone, from my own knowledge, without help, notes from another person, or a copy of questions or answers.
I will not share any exam question or answer with anyone, in any form.
I understand that a certificate obtained dishonestly would put real money and real people at risk, and that dishonesty is a conduct breach.
I understand that if I do not know something, saying so is always better than guessing.
@@end

@@page id=page-learner-faq title="Learner questions"
**Do I need to read the Guide articles?** Yes. The lesson is a summary; the reading is the substance. The lesson cannot be marked complete until you have opened the reading.

**Can I open any lesson I like?** Yes. Only exams are locked.

**What if I fail a lab?** Repeat it. Read the feedback first; every wrong answer says what would have happened.

**What if I fail the exam?** Read the explanations, revisit the lessons of the modules where you scored below 70%, wait 30 minutes and try again. The questions will not be the same set.

**Can the exam be skipped?** No.

**Does my badge change what I can do in the system?** No. Your manager decides.

**What if something in the Academy looks wrong?** Use **Report a problem**. Do not guess; ask your trainer.

**Is there a time limit in labs?** No.
@@end

@@page id=page-certificate title="Certificate text"
This certifies that **{name}** completed the Employee Academy track **{track}** and passed the certification exam on **{passedAt}**.

Content version: **{contentVersion}** · Valid until **{expiresAt}**.

This certificate is evidence of training. It does not grant any permission in the system.
@@end

@@page id=page-trainer title="Trainer and manager guide"
## Purpose
This guide is for the person who trains a new employee, and for the manager who decides what that employee may do.

## Before the employee starts
* Create the account with **no** maker, checker or other authority beyond reading the Guide and the Academy.
* Tell the employee that nothing they do in the Academy touches real data.
* Book a trainer (a certified person in the same role) for the first two weeks.

## The first week (suggested)
| Day | Employee | Trainer |
| :--- | :--- | :--- |
| 1 | Foundation modules 0 and 1 (orientation, how money moves). Read the Ten Golden Rules aloud. | Check the employee can say Rules 1, 6 and 7 without looking. |
| 2 | Foundation modules 2 and 3. Lab: **Approval Desk**. | Sit with them for the lab; ask them to explain each decision in one sentence. |
| 3 | Foundation: AML basics, confidentiality, mistakes and handover, security. Labs: **Flow Tracer**, **Security Desk**. | Role-play a phishing call. |
| 4 | **Foundation exam.** | Do not help. Debrief the explanations afterwards. |
| 5 | Begin the role track. Shadow a certified colleague. | Walk through one real, low-risk screen together, read-only. |

## Weeks 2 and 3
Complete the role track's modules and labs, one module per day or two. The employee sits with a certified colleague for part of each day, observing and then doing supervised read-only tasks. The role exam is taken at the end.

## Recommended authority policy (management decides)
1. **No authority** until the Foundation badge **and** the role badge are held and valid.
2. **Maker before checker.** Grant maker first. Grant checker only after at least ten supervised maker actions with no serious errors.
3. **Supervised first actions.** The first ten sensitive actions are done with a certified colleague watching.
4. **Review a sample.** The manager reads the reasons of the employee's first twenty approvals.
5. **Withdraw on breach.** A serious breach (sharing credentials, guessing on UNKNOWN, tipping off) suspends authorities pending retraining.

## Sign-off checklist
* [ ] Foundation badge earned (date: ______)
* [ ] Role badge earned (date: ______)
* [ ] Ten supervised actions done, no serious errors (date: ______)
* [ ] First twenty reasons reviewed (date: ______)
* [ ] Manager approves authorities: maker / checker (circle) (date: ______)

## If the employee fails
Treat it as a coaching signal, not a disciplinary one. Look at the module scores in the result, sit with the employee over the weak modules and the related Guide articles, then let them retake.

## Recertification
Badges last 12 months. When the Academy's major version changes, the team view shows **Recertification required**. Allow time in the calendar.

## Live drills (optional)
On staging only, a trainer can run the live drills of section III-F with the Fake Rails service. They are never run in production.
@@end

@@lesson id=l-m10-5 module=m10 order=5 title="Shared Object & Asset Storage: multi-node vault, locks, quarantine and legal holds" minutes=20 tracks=GATEWAY_ADMIN,SECURITY_ADMIN,COMPLIANCE reading=b12-12,b12-13
### You will be able to
- Explain why uploaded files are stored in the shared `pg-object-storage-daemon` vault (`OBJECT_STORAGE_NODE`) rather than inside PostgreSQL or on individual core nodes.
- Explain how `storage_object_locks`, `retain_until` and `legal_hold` work together to prevent premature deletion.
- Explain why `QUARANTINE_PENDING_AV` objects have `retain_until = NULL` until the malware scan succeeds.

### Key ideas
- **Storage is always shared across nodes.** Every `core-back` node and `backup-daemon` connects over mTLS to `OBJECT_STORAGE_NODE` (`pg-object-storage-daemon`). Configuring multiple core nodes without `OBJECT_STORAGE_NODE` is rejected by deployment validation (`MULTI_NODE_SHARED_STORAGE_REQUIRED`).
- **One upload = one encrypted `.v1.enc` envelope (`pgos1`).** Files are encrypted in 64 KiB `AES-256-GCM` chunks with a unique per-object DEK wrapped by `OBJECT_STORAGE_KEK_KEYRING`.
- **Multiple records can lock the same object.** `storage_object_locks` tracks every domain holder (`KYB_DOCUMENT`, `RECON_RUN`, `REG_REPORT_OUTPUT`, `REPORT_ASSET_ENTRY`, `CATALOG_ASSET`, `RAIL_LOGO`, `DISPUTE_ATTACHMENT`, `AML_CASE_EVIDENCE`). PostgreSQL trigger `storage_objects_guard_trg` blocks purging while any active lock exists.
- **Quarantine comes before compliance retention.** Untrusted uploads start in `QUARANTINE_PENDING_AV` with `retain_until = NULL`. Only after `AvScanWorker` marks the file `CLEAN` does `promote()` activate the object and stamp `retain_until`.
- **Backups verify object parity and KEK decryption.** `backup-daemon` syncs immutable `.v1.enc` blobs over mTLS, checks manifest parity against `ACTIVE` database rows, and tests decryption using the escrowed KEK keyring during weekly restore drills.

### A worked example
1. An admin uploads a bank logo on `core-1` (`CATALOG_ASSET` lock) and assigns it to two payment rails (`RAIL_LOGO` locks).
2. `core-2` serves the logo immediately over mTLS from `obj-1`.
3. Later, an admin tries to purge the logo while one rail still uses it. PostgreSQL trigger `storage_objects_guard_trg` rejects the purge (`STORAGE_OBJECT_LOCKED`) because an active `RAIL_LOGO` lock remains.

### Common mistakes
- Leaving `OBJECT_STORAGE_NODE` empty when scaling `CORE_NODES` past one server.
- Expecting a `QUARANTINE_PENDING_AV` KYB file to be downloadable before `AvScanWorker` finishes.

### Read now
- [[a:b12-12|Shared Object & Asset Storage: how files, locks, quarantine and retention work]]
- [[a:b12-13|Operating the Object & Asset Storage screen]]

### Check yourself
Questions: c-l-m10-5-1, c-l-m10-5-2
@@end

@@q id=c-l-m10-5-1 module=m10 type=single difficulty=1 critical=false exam=false lesson=l-m10-5 tracks=GATEWAY_ADMIN,SECURITY_ADMIN,COMPLIANCE refs=b12-12
Stem: What happens if an operator configures two `CORE_NODES` in `deploy.env` and leaves `OBJECT_STORAGE_NODE` empty?
- [x] Deployment validation fails with `MULTI_NODE_SHARED_STORAGE_REQUIRED` because core nodes are forbidden from storing blobs on their own local disks.
- [ ] Each core node stores half of the uploaded files on its own local disk.
- [ ] Files are stored inside PostgreSQL `BYTEA` columns instead.
Why: Every multi-node deployment must point all core nodes and the backup daemon at the shared `OBJECT_STORAGE_NODE` server.
@@end

@@q id=c-l-m10-5-2 module=m10 type=single difficulty=2 critical=false exam=false lesson=l-m10-5 tracks=GATEWAY_ADMIN,SECURITY_ADMIN,COMPLIANCE refs=b12-12,b12-13
Stem: When is the multi-year compliance `retain_until` timestamp stamped on a newly uploaded KYB document?
- [x] Only when `promote()` activates the object after the antivirus scan passes (`CLEAN`).
- [ ] Before the file is scanned for malware.
- [ ] Only when a Legal Hold is placed.
Why: Stamping compliance retention before AV scanning would make malware undeletable; retention is stamped at promotion time.
@@end

@@q id=q-m10-118 module=m10 type=single difficulty=2 critical=true exam=true tracks=GATEWAY_ADMIN,SECURITY_ADMIN refs=b12-12
Stem: An asset in `storage_objects` has two active locks (`CATALOG_ASSET` and `RAIL_LOGO`). If the catalog entry is released while the payment rail still uses the logo, can the object be purged?
- [x] No; `storage_objects_guard_trg` forbids transitioning to `PURGED` while any active lock (`released_at IS NULL`) remains.
- [ ] Yes; releasing the first lock deletes the file from disk immediately.
- [ ] Yes, if an administrator passes a PostgreSQL session GUC override.
Why: There are no GUC backdoors, and an object cannot be purged until active locks reach zero, `legal_hold` is false, and `retain_until` has expired.
@@end

<!-- CONTENT:END -->
