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

@@lesson id=l-m0-1 module=m0 order=1 title="Welcome: how the Academy works and what is expected of you" minutes=12 tracks=FOUNDATION reading=b00-01,b00-02,b00-04
### You will be able to
- Say what the platform does in one sentence.
- Explain how Learn, Check, Do and Prove fit together.
- Know that nothing in the Academy touches real money or real data.

### Key ideas
- The platform lets approved businesses (**merchants**) take payments and keeps exact books of the money.
- The Guide is the reference. The Academy teaches and tests. They share one progress record.
- Lessons teach, checks give instant feedback, labs let you practise decisions, exams prove you are ready.
- A *critical* exam question protects money or people. Missing **one** critical question fails the exam, whatever your score.
- Certification is evidence for your manager. It does not switch any permission on by itself.
- Being slow is acceptable. Guessing with other people's money is not.

### A worked example
Sara joins as an operator. On day one she reads the Welcome article, opens the Academy and presses **Continue**. She does not touch a live screen until her manager tells her she may.

### Common mistakes
- Skipping the reading because the lesson looks short. The lesson is a summary, the Guide holds the detail.
- Treating checks as a test to be rushed. Their purpose is to teach you.
- Thinking a badge gives you new permissions.

### Read now
- [[a:b00-01]]
- [[a:b00-02]]
- [[a:b00-04]]

### Check yourself
Questions: c-l-m0-1-1, c-l-m0-1-2
@@end

@@lesson id=l-m0-2 module=m0 order=2 title="The Ten Golden Rules" minutes=20 tracks=FOUNDATION reading=b00-03,b03-06
### You will be able to
- Recite the ten rules and say why each exists.
- Name the three most common serious breaches.
- Apply a rule to a short situation.

### Key ideas
- Rule 1: never share your password, one-time codes or session. Nobody legitimate asks for them.
- Rule 2: never approve something you cannot explain in one sentence.
- Rule 3: never approve your own work and never help anyone around the two-person rule.
- Rule 4: amounts come only from the system, never from a message, screenshot or call.
- Rule 5: a page saying "Paid" proves nothing. Only server-verified payments count.
- Rule 6: `UNKNOWN` means we do not know. Never guess. Rule 7: never reveal or hint at an anti-money-laundering review. Rule 8: never paste secrets. Rule 9: always write a real reason. Rule 10: when unsure, stop and escalate.
- The most common serious breaches are sharing credentials, guessing on `UNKNOWN`, and tipping off.

### A worked example
A customer sends a screenshot showing "Payment successful" and asks you to release the goods. Rule 5 applies: you look the payment up by its reference and read its status. If the status is not `SUCCEEDED`, the screenshot proves nothing.

### Common mistakes
- Learning the rules as slogans. You must be able to apply them to a new situation.
- Believing a rule can be relaxed when someone senior is in a hurry. It cannot.
- Treating rule 10 as weakness. It is the rule that protects you.

### Read now
- [[a:b00-03]]
- [[a:b03-06]]

### Check yourself
Questions: c-l-m0-2-1, c-l-m0-2-2
@@end

@@lesson id=l-m0-3 module=m0 order=3 title="Reading a screen safely" minutes=15 tracks=FOUNDATION reading=b03-04,b03-06,b01-08
### You will be able to
- Check the environment badge, the merchant, the amount, the currency and the status before acting.
- Explain why two open tabs are dangerous.
- Say your action in one sentence before you click.

### Key ideas
- Always read the **SANDBOX/LIVE** badge first. Acting on live data believing it is practice, or the reverse, is a classic mistake.
- Read the whole row: merchant name, amount, currency, status, date.
- Work one task at a time. Most wrong-merchant mistakes happen with two tabs open.
- Say the action in one sentence before approving: "I am approving X for merchant Y because Z."
- Write the reason first. If you cannot write a real reason you are not ready to act.
- Use the **?** drawer and the safeguard checklist at the moment of risk.

### A worked example
You are about to approve a refund. You read: merchant Al-Nour Bakery, 250.000 LYD, `LIVE`, original payment duplicated. You say it in one sentence, then open the checklist. Only then do you press **Approve**.

### Common mistakes
- Clicking the first row without reading the merchant.
- Assuming the badge is `SANDBOX` because you were in sandbox earlier.
- Leaving a half-finished decision at shift end.

### Read now
- [[a:b03-04]]
- [[a:b03-06]]
- [[a:b01-08]]

### Check yourself
Questions: c-l-m0-3-1, c-l-m0-3-2
@@end

@@lesson id=l-m1-1 module=m1 order=1 title="From cash to electronic money" minutes=15 tracks=FOUNDATION reading=b01-01,b01-02
### You will be able to
- Explain a payment as a change of numbers agreed by a trusted record-keeper.
- Name the nine ways customers can pay.
- Say why an electronic payment needs verification.

### Key ideas
- With cash, handing it over **is** the payment. With electronic money, a record-keeper changes two numbers.
- Because a record-keeper is involved, we must **ask** it what really happened.
- The platform supports nine collection modes: OTP pull, redirect, embedded, push approval, QR, pay code, deep link, manual and hybrid.
- Each mode has its own traps (for example a customer approving after the time limit).
- The customer never tells us the amount. The payment link does.

### A worked example
A customer pays a shop with a wallet app. The shop's screen is waiting. The wallet company changes the customer's number and the shop's number. Only when our server has verified that change do we call the payment successful.

### Common mistakes
- Thinking the customer's phone proves the payment.
- Thinking all payment methods behave alike.

### Read now
- [[a:b01-01]]
- [[a:b01-02]]

### Check yourself
Questions: c-l-m1-1-1, c-l-m1-1-2
@@end

@@lesson id=l-m1-2 module=m1 order=2 title="Who is involved: switches, gateways and aggregators" minutes=15 tracks=FOUNDATION reading=b01-03,b02-06
### You will be able to
- Describe a switch, a gateway and an aggregator in one sentence each.
- Explain the difference between direct and aggregator routes.
- Name our first-party rail.

### Key ideas
- A **switch** is a shared network connecting many banks and wallets. A **gateway** is one door to one payment company. An **aggregator** is a company offering one door to many methods.
- Direct routes have fewer companies in the money path; aggregator routes add one more.
- A **rail** is what the customer picks. A **route** connects a rail to a gateway.
- NeomPay is our own first-party wallet platform, trusted over mutual TLS.
- Every extra company in the path is another place a payment can be delayed.

### A worked example
Edfali can be reached directly or through an aggregator. If the direct door fails, the platform can use the aggregator door for new payments. Payments already running finish on the door they started with.

### Common mistakes
- Confusing the rail (what the customer sees) with the gateway (the technical door).
- Assuming every gateway offers a way to ask for a payment's status. Some do not.

### Read now
- [[a:b01-03]]
- [[a:b02-06]]

### Check yourself
Questions: c-l-m1-2-1, c-l-m1-2-2
@@end

@@lesson id=l-m1-3 module=m1 order=3 title="Libyan money and the 1000-times danger" minutes=20 tracks=FOUNDATION reading=b01-01,b06-04
### You will be able to
- State that 1 LYD = 1000 dirhams.
- Explain how a wrong scale makes an amount 1000 times wrong.
- Know what to do if a customer reports it.

### Key ideas
- The Libyan dinar (LYD) has three decimals because one dinar is 1000 dirhams.
- Some partners want `10.500`, some `10.50`, and some want whole dirhams `10500`.
- Sending `10500` where `10.50` is expected asks the customer for ten thousand five hundred dinars.
- The platform stores exact decimals with four places and converts only at the last moment.
- Before a gateway goes live, contract tests must pass, for example `10.50 LYD → "10500"` for a dirham-integer gateway.
- If anyone reports an amount 1000 times wrong: stop, treat as P1, tell the Gateway Admin and Security Admin, do not retry.

### A worked example
A link is for 76.255 LYD. A two-decimal gateway with `NEAREST` rounding receives `76.26`. With `DOWN` it would receive `76.25`. The difference is handled by the route's mismatch policy, never ignored.

### Common mistakes
- Doing amount arithmetic with ordinary calculator rounding and assuming it matches.
- Retrying a payment after a 1000-times error.

### Read now
- [[a:b01-01]]
- [[a:b06-04]]

### Check yourself
Questions: c-l-m1-3-1, c-l-m1-3-2
@@end

@@lesson id=l-m1-4 module=m1 order=4 title="How computers talk" minutes=20 tracks=FOUNDATION reading=b01-06,b13-01
### You will be able to
- Describe a request and a response.
- Explain a webhook, polling and an inquiry.
- Explain why a timeout is dangerous.

### Key ideas
- A **server** waits for requests and answers them. An **API** is the menu of what you may ask.
- A **webhook** is a partner calling us to say something happened. **Polling** is asking again and again. An **inquiry** is one read-only question about one payment.
- Status codes are the first digit of the answer: 2xx fine, 4xx you asked wrongly, 5xx they broke.
- A **timeout** is silence. On a money step, silence means we do not know whether money moved, so the payment becomes `UNKNOWN`.
- An **idempotent** request has the same effect if sent twice. We never assume partners support it.
- A webhook is stored in our inbox exactly as received before anything else happens.

### A worked example
We ask a wallet company to take 100 LYD. The reply never arrives. The request may have been lost, or it may have worked and only the reply was lost. From our side these look identical, so the payment is `UNKNOWN`.

### Common mistakes
- Treating a 500 error on a money step as "failed".
- Believing a webhook without checking its signature.

### Read now
- [[a:b01-06]]
- [[a:b13-01]]

### Check yourself
Questions: c-l-m1-4-1, c-l-m1-4-2
@@end

@@lesson id=l-m1-5 module=m1 order=5 title="Trust and secrets" minutes=20 tracks=FOUNDATION reading=b01-07,b11-01
### You will be able to
- Explain a password, MFA, a token, encryption, a hash and a signature in plain words.
- Say why secrets are write-only on this platform.
- Explain mutual TLS in one sentence.

### Key ideas
- **MFA** adds a second proof, usually a six-digit code sent by SMS to the phone number on your account. Never share it.
- A **token** or API key is a secret string that proves identity. Ours start with `pg_live_` and are shown once.
- **Encryption** locks data so only a key holder can read it. A **hash** is a one-way fingerprint.
- A **signature** is a seal proving a message came from someone who knows a shared secret and was not changed.
- **Mutual TLS** means both sides show a digital ID card. It is used between our own services.
- Secrets are **write-only**: you can replace them, never read them back.
- Key **rotation** changes a secret on schedule or after a leak, with an overlap so nothing breaks.

### A worked example
A partner's webhook arrives with a signature. We recompute the signature from the exact bytes and our shared secret. If it matches, the message is genuine and unchanged. If one character differs, the result is completely different.

### Common mistakes
- Pasting a secret into a chat "just for a minute".
- Believing hidden or masked data can be revealed by asking nicely.

### Read now
- [[a:b01-07]]
- [[a:b11-01]]

### Check yourself
Questions: c-l-m1-5-1, c-l-m1-5-2
@@end

@@lesson id=l-m2-1 module=m2 order=1 title="The platform's parts" minutes=15 tracks=FOUNDATION reading=b02-01,b02-02,b02-03
### You will be able to
- Name the three audiences and the services that serve them.
- Explain why public services hold no database access.
- Follow the life of a payment in order.

### Key ideas
- Three audiences, one engine: merchants, payers and staff all reach the same core.
- Seven services are kept separate so a break-in at one door does not open the others.
- Only the core holds database access and the master encryption key.
- Our own services prove who they are to each other with certificates (mutual TLS).
- A payment starts from a link, passes guards, reserves a slot, talks to a partner, is verified, and is posted to the ledger in the same transaction as success.

### A worked example
If someone broke into the public checkout service, they would still have no database credentials and no master key, and could not impersonate the admin or merchant service.

### Common mistakes
- Thinking the admin program is trusted blindly by the core. The core re-checks everything.

### Read now
- [[a:b02-01]]
- [[a:b02-02]]
- [[a:b02-03]]

### Check yourself
Questions: c-l-m2-1-1, c-l-m2-1-2
@@end

@@lesson id=l-m2-2 module=m2 order=2 title="Merchants, applications, wallets and links" minutes=20 tracks=FOUNDATION reading=b01-04,b05-06,b05-07
### You will be able to
- Explain the relationships between merchant, application, wallet and link.
- State why an application has exactly one wallet.
- Describe single-use and multi-use links.

### Key ideas
- A **merchant** is a checked business. An **application** is one place it takes payments. A **wallet** is its balance on our books.
- Every application is assigned to **exactly one** wallet, so a payment can never be ambiguous about where money goes.
- A **payment link** requests one fixed amount. A link may narrow the application's list of payment methods but never widen it.
- A single-use link allows one successful payment. A slot is reserved before each attempt.
- A wallet's balance is **calculated** from ledger lines, not stored as an editable number.
- API tokens start with `pg_live_`, are shown once and are never visible to staff.

### A worked example
A bakery has two applications, a website and a shop counter, both assigned to one wallet. Both feed the same balance. A link created from the shop application can only offer payment methods the application allows.

### Common mistakes
- Thinking an application could pay into any wallet.
- Asking a merchant to read a token to you.

### Read now
- [[a:b01-04]]
- [[a:b05-06]]
- [[a:b05-07]]

### Check yourself
Questions: c-l-m2-2-1, c-l-m2-2-2
@@end

@@lesson id=l-m2-3 module=m2 order=3 title="Roles, confidentiality zones and the double-check" minutes=20 tracks=FOUNDATION reading=b02-05,b03-02,b13-03
### You will be able to
- Name the seven staff roles.
- Explain what you may and may not see.
- Explain the Double-Check Rule.

### Key ideas
- Roles: `GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`.
- `SUPPORT` is read-only. Only `COMPLIANCE`, `MLRO` and, for audit, `SECURITY_ADMIN` may see AML data.
- Your account has authorities and maker/checker switches. No authority means no access.
- The **Double-Check Rule**: the core re-checks identity, role and rules even for requests from our own admin program.
- Merchants never see gateway costs, our margin, screening or risk tier.

### A worked example
A support agent can see that a merchant is suspended but never why. If asked, the agent says only that the account is restricted and points to the support address in the notice.

### Common mistakes
- Using a colleague's account because yours lacks a button.
- Discussing AML matters with someone who has no need to know.

### Read now
- [[a:b02-05]]
- [[a:b03-02]]
- [[a:b13-03]]

### Check yourself
Questions: c-l-m2-3-1, c-l-m2-3-2
@@end

@@lesson id=l-m3-1 module=m3 order=1 title="The maker and checker rule" minutes=15 tracks=FOUNDATION reading=b04-01,b04-05
### You will be able to
- Explain why two people are required.
- State who may approve what, in typical cases.
- Explain why you never approve your own request.

### Key ideas
- A **maker** proposes a sensitive change. A **checker**, a different person, decides.
- It catches honest mistakes, stops one person acting alone, and creates a record of who proposed and who approved.
- The rule is enforced by the database, the approval service and the API.
- Approving **also executes** the change.
- Your real ability to act as maker or checker depends on the switches on your own account.
- Asking a colleague to click **Approve** without reading is the same offence as approving your own work.

### A worked example
Finance proposes a refund. Only a different `FINANCE` user can approve it. If the same account tries, the system refuses. If a colleague approves without reading, the control has failed even though the system allowed it.

### Common mistakes
- Treating approval as a formality.
- Approving because the maker is senior or in a hurry.

### Read now
- [[a:b04-01]]
- [[a:b04-05]]

### Check yourself
Questions: c-l-m3-1-1, c-l-m3-1-2
@@end

@@lesson id=l-m3-2 module=m3 order=2 title="Descriptive versus sensitive, and the life of an approval" minutes=20 tracks=FOUNDATION reading=b04-02,b04-03
### You will be able to
- Tell a descriptive field from a sensitive one.
- Describe the states of an approval request.
- Say what happens when a request goes out of date.

### Key ideas
- **Descriptive** fields (a trade name, a logo) are edited directly and logged.
- **Sensitive** fields change money flow, compliance or attack surface (bank details, tax ID, risk tier, wallet assignment) and need two people.
- An approval request shows who proposed, what would change (old and new value) and why.
- States: `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `EXECUTED`, `REJECTED`. A request lasts seven days.
- If the record changed since the request was made, the request is out of date and the maker must create a new one.
- Until a request is executed, the current value stays in force.

### A worked example
A merchant's payout bank account is being changed. The diff shows the old account and the new one in a different person's name. The checker rejects it with a reason.

### Common mistakes
- Approving without opening **Review**.
- Believing a pending request already changed the data.

### Read now
- [[a:b04-02]]
- [[a:b04-03]]

### Check yourself
Questions: c-l-m3-2-1, c-l-m3-2-2
@@end

@@lesson id=l-m3-3 module=m3 order=3 title="Emergency actions and the asymmetry principle" minutes=15 tracks=FOUNDATION reading=b04-04,b09-06
### You will be able to
- State the asymmetry principle.
- Explain emergency suspension and ratification.
- List actions that reduce risk and actions that increase it.

### Key ideas
- Actions that **reduce risk** may happen immediately and be approved afterwards. Actions that **increase risk or move money** always need approval first.
- Immediate: suspending a merchant, tightening a rule, pausing a route.
- Approval first: reinstating a merchant, loosening a rule, releasing held money, cash-outs, refunds, adjustments.
- An emergency suspension must be ratified within 24 hours by the MLRO or a different `COMPLIANCE` user.
- If nobody ratifies, an alert fires and the suspension **stays in force**. It fails safe.
- Immediate does not mean casual. Write the reason and expect review.

### A worked example
A confirmed sanctions match appears on an active merchant. A Compliance user suspends it at once. A different Compliance user reviews and ratifies within the day.

### Common mistakes
- Using emergency suspension as a bargaining tool.
- Thinking reinstatement can be an emergency action. It never can.

### Read now
- [[a:b04-04]]
- [[a:b09-06]]

### Check yourself
Questions: c-l-m3-3-1, c-l-m3-3-2
@@end

@@lesson id=l-m3-4 module=m3 order=4 title="Reasons and safeguard checklists" minutes=15 tracks=FOUNDATION reading=b04-06,b03-06,b04-07
### You will be able to
- Write a reason that would survive an audit.
- Use a safeguard checklist at the moment of action.
- Know that everything you do is recorded.

### Key ideas
- A good reason states what you checked, what you found and why you decided, so a stranger can understand it months later.
- "ok" and "as discussed" are not reasons.
- Safeguard checklists appear before risky buttons. Tick only what you have really checked.
- A reason must never contain secrets or, for merchant-visible notes, AML information.
- Every action is written to an audit trail that cannot be edited.

### A worked example
Weak: "approved per request". Strong: "Checked the bank letter: account holder matches the legal name; old account closed per merchant's written request; approving."

### Common mistakes
- Writing the reason after the click.
- Ticking boxes without checking.

### Read now
- [[a:b04-06]]
- [[a:b03-06]]
- [[a:b04-07]]

### Check yourself
Questions: c-l-m3-4-1, c-l-m3-4-2
@@end

@@lesson id=l-m4-1 module=m4 order=1 title="Merchant states and risk tiers" minutes=15 tracks=OPERATOR,SUPPORT,FINANCE reading=b05-01,b02-04
### You will be able to
- Name the five merchant states and what each allows.
- Name the suspension reason codes.
- Explain risk tier and KYB status.

### Key ideas
- States: `PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED`, `CLOSED`.
- A `SUSPENDED` merchant cannot take new payments or cash out. Its balance is kept.
- Suspension carries one reason: `AML`, `FRAUD`, `KYB_EXPIRED`, `COMMISSION_CEILING`, `MERCHANT_REQUEST` or `OTHER`.
- KYB status is separate: `UNVERIFIED`, `PENDING`, `VERIFIED`, `REJECTED`.
- Risk tier `LOW`, `STANDARD` or `HIGH` changes how strictly rules apply. Changing it is a sensitive edit.
- `PENDING` is a merchant state. `PENDING_REVIEW` is an approval state. Do not confuse them.

### A worked example
A merchant is `SUSPENDED` with reason `KYB_EXPIRED`. New payments are blocked, but a payment already running finishes on the settings it started with. The merchant's notice says only that the account is restricted.

### Common mistakes
- Closing a merchant that still has a balance.
- Mixing up `PENDING` and `PENDING_REVIEW`.

### Read now
- [[a:b05-01]]
- [[a:b02-04]]

### Check yourself
Questions: c-l-m4-1-1, c-l-m4-1-2
@@end

@@lesson id=l-m4-2 module=m4 order=2 title="Reviewing a join request" minutes=25 tracks=OPERATOR,COMPLIANCE,MLRO reading=b05-02,b05-03,b05-10
### You will be able to
- List the seven checks of a join request.
- Choose between request information, reject and approve.
- Say when a second reviewer is required.

### Key ideas
- Seven checks: applicant identity, business exists, beneficial owners, screening result, category and volume, payout account, risk tier.
- **Request information** pauses the deadline. Say exactly what is missing. Never mention screening.
- A rejection carries a reason code. A code that could reveal a screening result is shown to the applicant as `POLICY`.
- The default four-eyes policy is risk-based: high risk, a screening result that is not clear, a politically exposed owner, a high-risk category, high volume, a payout account mismatch or a previous rejection all require a second reviewer.
- Approval makes the merchant active in one atomic step. If any part fails nothing changes.
- A duplicate document, owner, phone or bank account does not reject automatically. It adds a second reviewer and raises the proposed tier.

### A worked example
A bank letter names a different company from the legal name. Check 6 fails. You request information, asking for a letter in the merchant's own legal name, and say nothing else.

### Common mistakes
- Telling an applicant a screening result was the reason.
- Approving to meet a deadline.

### Read now
- [[a:b05-02]]
- [[a:b05-03]]
- [[a:b05-10]]

### Check yourself
Questions: c-l-m4-2-1, c-l-m4-2-2
@@end

@@lesson id=l-m4-3 module=m4 order=3 title="KYB documents and beneficial owners" minutes=20 tracks=OPERATOR,COMPLIANCE reading=b05-04,b05-05
### You will be able to
- Say what a beneficial owner is and the default threshold.
- Describe what the system does to every upload.
- Handle a possible screening match at onboarding.

### Key ideas
- A **beneficial owner** is a real person who holds 25% or more (default) or controls the business.
- Every upload is type-checked, virus-scanned, stored encrypted with a fingerprint, and flagged if the same file belongs to an unrelated merchant.
- Document statuses: `UPLOADED`, `ACCEPTED`, `REJECTED`, `EXPIRED`.
- Owner screening statuses: `NOT_SCREENED`, `CLEAR`, `POTENTIAL_MATCH`, `CONFIRMED_MATCH`.
- If screening is not clear, do not approve and do not discuss it. Compliance decides each match.
- Screening that returns `ERROR` fails closed: the request cannot be approved until screening succeeds.

### A worked example
The same commercial registry file appears under two unrelated merchants. The duplicate flag is raised. You do not accuse anyone: you add the finding to the notes, a second reviewer is required, and you escalate to Compliance.

### Common mistakes
- Accepting a document you cannot read.
- Copying documents to chat or e-mail.

### Read now
- [[a:b05-04]]
- [[a:b05-05]]

### Check yourself
Questions: c-l-m4-3-1, c-l-m4-3-2
@@end

@@lesson id=l-m4-4 module=m4 order=4 title="Merchant tools and helping merchants safely" minutes=20 tracks=OPERATOR,SUPPORT reading=b05-07,b05-08,b05-09
### You will be able to
- Explain payment links, POS and tokens.
- State what you may and may not say to a merchant.
- Know who can suspend and reinstate.

### Key ideas
- Payment links have a key, an amount, a fee bearer, a use limit and an optional expiry.
- A POS screen idle for 15 minutes is disconnected. The payment continues on the server.
- Support never sees token values and must never ask for one.
- Identify the person before discussing anything. Phone callers are not proof of identity.
- Never reveal AML, screening, risk tier, gateway cost or our margin.
- Suspension takes effect at once and needs ratification within 24 hours. Reinstatement needs prior approval by a different Compliance or MLRO user.

### A worked example
A merchant asks why its account is restricted. The safe answer: "Your account is currently restricted. I cannot give further details. Please contact the support address in your notice."

### Common mistakes
- Saying "compliance flagged you".
- Changing bank details after a phone request.

### Read now
- [[a:b05-07]]
- [[a:b05-08]]
- [[a:b05-09]]

### Check yourself
Questions: c-l-m4-4-1, c-l-m4-4-2
@@end

@@lesson id=l-m5-1 module=m5 order=1 title="Reading a payment" minutes=20 tracks=OPERATOR,SUPPORT,FINANCE,COMPLIANCE,GATEWAY_ADMIN reading=b07-01
### You will be able to
- Tell our reference from the partner's.
- Read the amount fields.
- Use the step log as evidence.

### Key ideas
- An **attempt** is one try to pay a link. A link can have many.
- Reference is ours. Gateway reference is what we send. Provider reference is the partner's. Network reference belongs to a third network.
- Requested amount plus surcharge gives the total charged. Settled amount is what the partner says it took.
- Environment (`SANDBOX`/`LIVE`) is the first thing to check.
- Each attempt is pinned to the gateway version, route, credential set and commission profile it started with.
- The step log records each call with secrets removed. When something is unclear it is the evidence.

### A worked example
A partner asks for the transaction number. You give your provider reference or our reference. You do not describe the customer.

### Common mistakes
- Quoting a customer's name instead of a reference.

### Read now
- [[a:b07-01]]

### Check yourself
Questions: c-l-m5-1-1, c-l-m5-1-2
@@end

@@lesson id=l-m5-2 module=m5 order=2 title="The fourteen payment states" minutes=25 tracks=OPERATOR,SUPPORT,FINANCE reading=b07-02,b13-02
### You will be able to
- List the 14 states.
- Say which states keep or release the link slot.
- Say what a human should do in each state.

### Key ideas
- Progress: `CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, `VERIFYING`, `UNKNOWN`, `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`. After success: `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`.
- The slot is released only by `FAILED`, `EXPIRED`, `CANCELLED` or `BLOCKED`. It stays reserved through `UNKNOWN`.
- Movement is forward only. If two trusted sources disagree the payment freezes in `UNKNOWN` and a priority-1 conflict opens.
- Uncertainty never becomes failure.
- Success and its ledger entry happen together or not at all.
- `BLOCKED` shows the customer only a generic message. Never explain the real reason.

### A worked example
A timeout on the confirm step moves `AUTHORIZING` to `UNKNOWN`, never to `FAILED`.

### Common mistakes
- Reading `EXPIRED` as proof the customer did not pay. A late success can still arrive.

### Read now
- [[a:b07-02]]
- [[a:b13-02]]

### Check yourself
Questions: c-l-m5-2-1, c-l-m5-2-2
@@end

@@lesson id=l-m5-3 module=m5 order=3 title="UNKNOWN: exactly what to do" minutes=30 tracks=OPERATOR,SUPPORT,FINANCE,GATEWAY_ADMIN reading=b07-03,b07-09,b00-03
### You will be able to
- Explain why UNKNOWN exists.
- Follow the procedure in order.
- List what you must never do.

### Key ideas
- `UNKNOWN` means we asked a partner to take money and did not get a clear answer.
- The slot stays reserved, no money is posted, and the platform keeps asking, listens for webhooks and waits for the statement.
- Guessing is dangerous: "failed" plus a second payment means the customer paid twice; "succeeded" plus shipped goods can mean the merchant lost goods.
- Procedure: check the badge, open the case, read the step log, press **Inquire** once, then wait for a statement or contact the partner with the references.
- Resolve by hand only with **evidence from the partner** and a second person, using the checklist.
- Never mark it failed because it is old. Never ask the customer to pay again. Never re-send an OTP. Never resolve from a screenshot or call.
- Target: 95% of `UNKNOWN` resolved within 24 hours.

### A worked example
A confirm times out. You press **Inquire**; the partner has no status question. You note both references and wait for the next statement. The statement shows the payment, so Finance resolves it with that evidence.

### Common mistakes
- Pressing Inquire repeatedly.
- Telling the merchant the payment succeeded.

### Read now
- [[a:b07-03]]
- [[a:b07-09]]
- [[a:b00-03]]

### Check yourself
Questions: c-l-m5-3-1, c-l-m5-3-2
@@end

@@lesson id=l-m5-4 module=m5 order=4 title="Operator cases and inquiry" minutes=25 tracks=OPERATOR,FINANCE reading=b07-04,b07-09
### You will be able to
- Name the seven case kinds.
- Use priorities and deadlines.
- Use Inquire and Bulk Inquiry correctly.

### Key ideas
- Kinds: `UNKNOWN`, `HELD`, `CONFLICT`, `MISMATCH`, `LATE_SUCCESS`, `MANUAL_REVIEW`, `UNMATCHED_STATEMENT`.
- Priority `P1` is the most urgent. Work highest priority and nearest deadline first.
- Assign a case to yourself before working it. Write what you did in the notes.
- An inquiry is read-only and cannot move money. Many partners need a minimum age on a payment first.
- **Inquire selected** sends many calls. Use it only for the affected route and period, never while the partner is down.
- If evidence is missing, leave the case open and escalate. Leaving it open is safe.

### A worked example
After an outage you run **Inquire selected** for one route and a two-hour window, not for all routes.

### Common mistakes
- Bulk-inquiring everything "just in case".
- Resolving a conflict case alone.

### Read now
- [[a:b07-04]]
- [[a:b07-09]]

### Check yourself
Questions: c-l-m5-4-1, c-l-m5-4-2
@@end

@@lesson id=l-m5-5 module=m5 order=5 title="Webhooks, expiry, slots and OTP" minutes=25 tracks=OPERATOR,GATEWAY_ADMIN reading=b07-05,b07-06,b07-07
### You will be able to
- Describe what happens when a partner calls us.
- Explain slot reservation and the grace window.
- Describe OTP rules.

### Key ideas
- Webhooks arrive at a secret address, are stored exactly as received, answered quickly, then checked for signature, sender and timestamp.
- Duplicates are ignored for seven days. `SUCCEEDED` is never downgraded by an out-of-order message.
- A slot is reserved before an attempt starts so one invoice cannot be paid twice.
- An attempt expires at the smaller of the partner's limit and the platform ceiling, after a last inquiry. Late confirmations are accepted during the grace window.
- OTP: three tries by default, resend cooldowns, wrong codes never trip the circuit breaker, and a timeout is never a wrong code.
- A webhook from the sandbox arriving at the live address is rejected and alerts.

### A worked example
A customer approves a push request after the payment expired. A verified late success arrives; the slot is free, so it is posted and a P2 alert is raised.

### Common mistakes
- Telling customers to keep pressing resend.

### Read now
- [[a:b07-05]]
- [[a:b07-06]]
- [[a:b07-07]]

### Check yourself
Questions: c-l-m5-5-1, c-l-m5-5-2
@@end

@@lesson id=l-m5-6 module=m5 order=6 title="Late success, conflicts, mismatches and the deducted-money call" minutes=30 tracks=OPERATOR,SUPPORT,FINANCE reading=b07-08,b07-12
### You will be able to
- Handle late success, conflict and mismatch.
- Follow the deducted-money procedure.
- Say what never to promise.

### Key ideas
- Late success with a free slot is posted. If the link was already paid, the money goes to `SUSPENSE` and a refund is drafted.
- Conflicting trusted signals post nothing and open a P1 conflict case.
- A mismatch beyond tolerance holds the money in `SUSPENSE` and opens a `MISMATCH` case.
- Deducted-money call: ask for the reference, look it up, read the status, and answer from the status table.
- Never ask the customer to pay again. Never confirm from a screenshot, SMS or call. Never promise refund times.
- If the status is not `SUCCEEDED` and money was deducted, open or update a case with the reference and time.

### A worked example
Customer says money was deducted; status is `FAILED`. You say you have no confirmed payment, ask them to keep their receipt, and open a case. You do not refund.

### Common mistakes
- Refunding "just to be nice".

### Read now
- [[a:b07-08]]
- [[a:b07-12]]

### Check yourself
Questions: c-l-m5-6-1, c-l-m5-6-2
@@end

@@lesson id=l-m6-1 module=m6 order=1 title="Double-entry bookkeeping from zero" minutes=25 tracks=OPERATOR,FINANCE reading=b08-01,b01-09
### You will be able to
- Explain debit and credit.
- State the four promises of the ledger.
- Read a simple journal entry.

### Key ideas
- Every movement is written on two sides. In every journal entry the **total debits equal the total credits**.
- Debit and credit are directions, not good and bad.
- Promises: balanced entries, append-only, exactly once, no stored wallet balances.
- A mistake is fixed by a new approved entry that offsets it. Nobody edits a number.
- A wallet's balance is calculated from lines.

### A worked example
A customer pays 100 LYD with 3% commission. Debit clearing 100; credit wallet 97 and income 3.

### Common mistakes
- Trying to "balance" by editing a number.

### Read now
- [[a:b08-01]]
- [[a:b01-09]]

### Check yourself
Questions: c-l-m6-1-1, c-l-m6-1-2
@@end

@@lesson id=l-m6-2 module=m6 order=2 title="The eleven accounts and the equation" minutes=25 tracks=OPERATOR,FINANCE reading=b08-02,b08-05
### You will be able to
- Name the eleven GL accounts.
- State the ledger equation in words.
- Say what to do when it does not hold.

### Key ideas
- Things we have: `TREASURY`, `GATEWAY_CLEARING`, `COMMISSION_RECEIVABLE`.
- Things we owe or are deciding: `MERCHANT_WALLET`, `AML_HOLD`, `CHARGEBACK_RESERVE`, `SUSPENSE`, `GATEWAY_FEE_ACCRUAL`.
- Earned and cost: `PLATFORM_INCOME`, `PROVIDER_FEE_EXPENSE`, `GATEWAY_FEE_EXPENSE`.
- Money in wallet, hold, reserve and suspense is not ours.
- What we have equals what we owe plus what we earned minus what it cost us. The drift must be 0.0000.
- Any drift is P1; automatic payouts stop.

### A worked example
Drift shows 12.5000. You tell your manager and Finance, do not cash out, and follow RB-04. You do not edit anything.

### Common mistakes
- Cashing out manually while payouts are stopped.

### Read now
- [[a:b08-02]]
- [[a:b08-05]]

### Check yourself
Questions: c-l-m6-2-1, c-l-m6-2-2
@@end

@@lesson id=l-m6-3 module=m6 order=3 title="Commission, fee bearers and rounding" minutes=20 tracks=FINANCE reading=b08-03
### You will be able to
- Distinguish commission from gateway fee.
- Calculate customer pays, merchant gets and our net for each fee bearer.
- Explain how commission is chosen.

### Key ideas
- Commission is our revenue. Gateway fee is our cost. Net revenue is commission minus gateway fee.
- `MERCHANT_ABSORBS`: customer pays 100, merchant gets 97. `PAYER_SURCHARGE`: customer pays 103, merchant gets 100. `SPLIT` 50/50: customer pays 101.5, merchant gets 98.5 (3 commission, 100 link).
- The most specific live commission profile applies: merchant+application+rail, then merchant+rail, then platform default+rail.
- Commission on held money is not income until released.

### A worked example
For a 100 LYD link, 3 LYD commission, 0.8 gateway fee: our net is 2.2 under every fee bearer.

### Common mistakes
- Forgetting that no profile means the rail is hidden.

### Read now
- [[a:b08-03]]

### Check yourself
Questions: c-l-m6-3-1, c-l-m6-3-2
@@end

@@lesson id=l-m6-4 module=m6 order=4 title="How each payment is posted" minutes=25 tracks=FINANCE reading=b08-04,b08-12
### You will be able to
- Write the journal lines of the main entries.
- Say why duplicates cannot double-credit.
- Explain AML hold posting.

### Key ideas
- Entry 1: fee taken at source. Entry 2: partner holds money, fee accrued. Entry 5: payer surcharge. Entry 6: direct to merchant, commission receivable. Entry 13: NeomPay straight to treasury.
- Each entry is tied to its payment by a unique pair, so a repeated webhook cannot post twice.
- An AML-held payment goes to `AML_HOLD` with no commission until release.
- Success and posting are one transaction.

### A worked example
Entry 2 for 100 LYD, 3%, fee 0.8: debit clearing 100 and gateway fee expense 0.8; credit wallet 97, income 3 and fee accrual 0.8.

### Common mistakes
- Posting commission on held money.

### Read now
- [[a:b08-04]]
- [[a:b08-12]]

### Check yourself
Questions: c-l-m6-4-1, c-l-m6-4-2
@@end

@@lesson id=l-m6-5 module=m6 order=5 title="Settlement and reconciliation" minutes=25 tracks=FINANCE reading=b08-06,b08-10,b10-05
### You will be able to
- Explain T+N and settlement targets.
- Read the five reconciliation results.
- Explain the settlement sweep and fee true-up.

### Key ideas
- A statement is the partner's record. Reconciliation matches it to our books.
- Results: `MATCHED`, `AMOUNT_MISMATCH`, `MISSING_AT_GATEWAY`, `MISSING_LOCALLY`, `DUPLICATE`.
- `MISSING_AT_GATEWAY` is the most serious: we may have credited money we did not receive.
- Settlement sweep moves money from clearing to treasury. If the real fee differs from accrued, a true-up posts the difference.
- Settlement targets: `PLATFORM_CLEARING`, `MERCHANT_DIRECT`, `PROVIDER_HELD`.
- Never edit a statement file to make it match.

### A worked example
A statement lacks a payment we marked succeeded. That is `MISSING_AT_GATEWAY`: escalate before any payout.

### Common mistakes
- Ignoring time zones when comparing dates.

### Read now
- [[a:b08-06]]
- [[a:b08-10]]
- [[a:b10-05]]

### Check yourself
Questions: c-l-m6-5-1, c-l-m6-5-2
@@end

@@lesson id=l-m6-6 module=m6 order=6 title="Cash-outs and adjustments" minutes=25 tracks=FINANCE reading=b08-07,b08-08
### You will be able to
- Describe the cash-out states and who does what.
- List adjustment types and states.
- Correct a wrong adjustment properly.

### Key ideas
- Cash-out: `PENDING`, `PROCESSING`, `COMPLETE`, `SUBTRACTED`, `REJECTED`. A different Finance user approves the final subtraction.
- The bank details snapshot is a copy at request time.
- Suspended, negative-balance or held merchants cannot cash out.
- Adjustments: `REFUND`, `CHARGEBACK`, `MANUAL_CREDIT`, `MANUAL_DEBIT`, `CORRECTION`, `CASHOUT_SUBTRACTION`; always two people.
- An executed adjustment is never edited; **Reverse** proposes an offsetting one.
- A refund can never exceed the original payment.

### A worked example
A refund was proposed for the wrong amount and executed. You propose an offsetting adjustment with a reason; a different Finance user approves.

### Common mistakes
- Splitting one adjustment into several to avoid review.

### Read now
- [[a:b08-07]]
- [[a:b08-08]]

### Check yourself
Questions: c-l-m6-6-1, c-l-m6-6-2
@@end

@@lesson id=l-m6-7 module=m6 order=7 title="Disputes, chargebacks and negative balances" minutes=20 tracks=FINANCE reading=b08-09,b08-13
### You will be able to
- Describe the dispute lifecycle.
- Explain who approves a chargeback.
- Explain what happens when the balance is too low.

### Key ideas
- A dispute reaches us through a partner message, a statement or manual entry, and is unique per gateway and dispute reference.
- Lifecycle: `OPENED`, `EVIDENCE_REQUESTED`, `EVIDENCE_SUBMITTED`, then `WON`, `LOST`, `EXPIRED` or `WITHDRAWN`.
- The system drafts the chargeback; a human Finance checker must approve. Until then no money moves.
- If a chargeback would breach the merchant's negative-balance ceiling it does not post and a P1 case opens.
- A negative balance is recovered by netting and blocks cash-out, suspension release and closure.

### A worked example
A chargeback of 100 LYD arrives; the wallet holds 40 and the ceiling is zero. It does not post; Finance chooses to collect, net or suspend.

### Common mistakes
- Assuming the system approves chargebacks automatically.

### Read now
- [[a:b08-09]]
- [[a:b08-13]]

### Check yourself
Questions: c-l-m6-7-1, c-l-m6-7-2
@@end

@@lesson id=l-m7-1 module=m7 order=1 title="Anti-money-laundering from zero" minutes=20 tracks=FOUNDATION reading=b09-01,b01-10
### You will be able to
- Define money laundering and its three stages.
- Explain why a payment platform is a target.
- Say who does what in AML.

### Key ideas
- Money laundering makes money from crime look legitimate: placement, layering, integration.
- A fast platform with many small payments and payouts is attractive to criminals.
- Everyone is a sensor. Compliance investigates. The MLRO owns final decisions. The system screens, flags, holds and records.
- Failing to run controls can mean fines, loss of licence and personal liability.

### A worked example
A fake shop receiving many small payments and cashing out quickly is a classic placement pattern.

### Common mistakes
- Thinking AML is only Compliance's problem.

### Read now
- [[a:b09-01]]
- [[a:b01-10]]

### Check yourself
Questions: c-l-m7-1-1, c-l-m7-1-2
@@end

@@lesson id=l-m7-2 module=m7 order=2 title="The seven layers and the rules" minutes=25 tracks=COMPLIANCE,MLRO reading=b09-02,b09-04
### You will be able to
- Name the seven layers.
- Distinguish velocity rules from AML rules.
- Explain rule change control.

### Key ideas
- Layers: onboarding screening, ongoing screening, transaction-time checks, monitoring, case management, reporting, records.
- Velocity rules limit how often or how much. AML rules detect patterns and can hold money or open cases.
- AML actions: `HOLD`, `FLAG`, `BLOCK`, `CASE_ONLY`.
- Rules evaluate by subject, so splitting a sale across links does not avoid a threshold.
- Every rule change needs two people; the MLRO approves AML rules. Tightening may be immediate; loosening never skips review. A dry run shows impact first.

### A worked example
Many payments just below a threshold trigger the structuring rule even if each is small.

### Common mistakes
- Loosening a rule to reduce workload.

### Read now
- [[a:b09-02]]
- [[a:b09-04]]

### Check yourself
Questions: c-l-m7-2-1, c-l-m7-2-2
@@end

@@lesson id=l-m7-3 module=m7 order=3 title="Screening and cases" minutes=30 tracks=COMPLIANCE,MLRO reading=b09-03,b09-05
### You will be able to
- Decide a screening match properly.
- Describe the case lifecycle.
- Explain severity and deadlines.

### Key ideas
- Results: `CLEAR`, `POTENTIAL_MATCH`, `CONFIRMED_MATCH`, `ERROR`. Decide each match: `FALSE_POSITIVE`, `TRUE_MATCH` or `ESCALATED`, with a written rationale.
- Case lifecycle: `OPEN`, `IN_REVIEW`, `PENDING_CHECKER`, then `RELEASED`, `REJECTED_VOID`, `FROZEN` or `ESCALATED_STR`.
- An analyst proposes; the MLRO approves; only then does money move.
- Default deadlines: `CRITICAL` 4 hours, `HIGH` 1 business day, `MEDIUM` 3, `LOW` 5.
- A velocity flag plus an AML rule hit on the same payment, or a sanctions confirmed match, makes a case `CRITICAL`.

### A worked example
A name matches a listed person. You compare date of birth, nationality and ID, find they differ, mark `FALSE_POSITIVE` with the evidence and an expiry on the suppression.

### Common mistakes
- Marking a match false because the merchant is important.

### Read now
- [[a:b09-03]]
- [[a:b09-05]]

### Check yourself
Questions: c-l-m7-3-1, c-l-m7-3-2
@@end

@@lesson id=l-m7-4 module=m7 order=4 title="Restricting merchants and regulatory reporting" minutes=25 tracks=COMPLIANCE,MLRO reading=b09-06,b09-07
### You will be able to
- Explain emergency suspension for AML.
- Describe report types and lifecycle.
- Explain why provisional rules cannot file.

### Key ideas
- A confirmed sanctions match leads to emergency suspension, frozen cash-out and a suspicious-activity draft.
- A new match after a list update opens a case and restricts cash-out at once.
- Reports: `LARGE_TRANSACTION`, `SUSPICIOUS_ACTIVITY`, `PERIODIC_RETURN`. Lifecycle: `DRAFT`, `PENDING_CHECKER`, `APPROVED`, `SUBMITTED`, then acknowledged or rejected.
- A `PROVISIONAL` reporting rule can never produce a live filing; the database refuses it.
- Until requirements are confirmed in writing the platform is in internal-only mode.
- The existence of a report is never disclosed to the subject.

### A worked example
A report needs correction after submission. You create a new linked report; the saved one is read-only.

### Common mistakes
- Filing from a provisional rule.

### Read now
- [[a:b09-06]]
- [[a:b09-07]]

### Check yourself
Questions: c-l-m7-4-1, c-l-m7-4-2
@@end

@@lesson id=l-m7-5 module=m7 order=5 title="Confidentiality, tipping-off and reporting suspicion" minutes=25 tracks=FOUNDATION reading=b09-08,b09-10
### You will be able to
- Define tipping-off.
- Say exactly what you may tell a merchant or customer.
- Report suspicion correctly.

### Key ideas
- Tipping-off is telling someone, directly or by hint, that they are or may be under suspicion. It can be a crime.
- AML data is confidential: only `COMPLIANCE`, `MLRO` and, for audit, `SECURITY_ADMIN` may see it.
- Allowed wording: "Your account is currently restricted. Please contact the support address in your notice." Blocked payments: "We cannot process this payment."
- Never use the words compliance, investigation, screening, sanctions, suspicious or report with a merchant or customer.
- If asked "am I under investigation?" give only the generic wording and tell your manager and Compliance.
- If you notice something suspicious: do not confront, write down the facts, tell Compliance the same day, keep it secret, carry on normally.

### A worked example
A merchant asks, "Is this about compliance?" You do not confirm or deny. You say only the generic sentence and inform Compliance.

### Common mistakes
- Hinting "it is for security reasons" when the true reason is AML.

### Read now
- [[a:b09-08]]
- [[a:b09-10]]

### Check yourself
Questions: c-l-m7-5-1, c-l-m7-5-2
@@end

@@lesson id=l-m8-1 module=m8 order=1 title="Gateways, rails, routes and versions" minutes=25 tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN reading=b06-01,b06-11,b02-06
### You will be able to
- Describe the four layers.
- Explain versions and promotion.
- Name route statuses and health.

### Key ideas
- Gateway (technical door), Credential Set (secrets), Rail (what customers pick), Route (links a rail to a gateway).
- Gateway kinds: `DIRECT`, `AGGREGATOR`, `NATIVE_ADAPTER`, `INTERNAL`.
- Configuration is stored as immutable versions: `DRAFT`, `SANDBOX_VERIFIED`, `PENDING_APPROVAL`, `LIVE`, `SUPERSEDED`, `ROLLED_BACK`.
- Promoting a version affects new payments only. Running payments finish on the version they started with.
- Route status `ACTIVE`, `PAUSED`, `DRAINING`; health `HEALTHY`, `DEGRADED`, `OPEN_BREAKER`.
- A rail that was ever used is blocked, never deleted.

### A worked example
A new version is promoted at noon. A payment that started at 11:59 finishes on the old version.

### Common mistakes
- Editing a live gateway in place. It is not possible.

### Read now
- [[a:b06-01]]
- [[a:b06-11]]
- [[a:b02-06]]

### Check yourself
Questions: c-l-m8-1-1, c-l-m8-1-2
@@end

@@lesson id=l-m8-2 module=m8 order=2 title="Collection modes and confirmation channels" minutes=25 tracks=OPERATOR,GATEWAY_ADMIN reading=b06-02,b06-07
### You will be able to
- Describe each collection mode and its main trap.
- Rank confirmation channels by trust.
- Explain the weak-channel rule.

### Key ideas
- OTP pull: the confirm step is the money step. Redirect and embedded: the customer's return is only a hint. Push and QR: the customer may approve after the limit.
- Channels: webhook (strong when signed), return URL (hint), browser callback (hint), poll, statement, operator, synchronous answer.
- We believe only what we can verify ourselves: status, reference, amount, currency and environment must all match.
- Weak methods (`SHARED_TOKEN`, `IP_ONLY`, return URLs, browser callbacks) are forced to ask the partner first (`must_inquire`).
- The wizard refuses to save a weak channel with that switch off.

### A worked example
A return-URL arrives saying success. The platform ignores it as proof and asks the partner instead.

### Common mistakes
- Trusting the browser's own "done" message.

### Read now
- [[a:b06-02]]
- [[a:b06-07]]

### Check yourself
Questions: c-l-m8-2-1, c-l-m8-2-2
@@end

@@lesson id=l-m8-3 module=m8 order=3 title="The engine: phases, steps and the retry boundary" minutes=30 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b06-03,b06-08,b06-17
### You will be able to
- Name the ten phases.
- Explain the four labels on a step.
- State the retry boundary.

### Key ideas
- Phases: `CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`.
- Step labels: `side_effect`, `retry_policy`, `idempotency_config`, `point_of_no_return`.
- A step that moves money is never retried automatically after a timeout, dropped connection or server error: the attempt becomes `UNKNOWN`.
- Status rules are checked in order and the first match wins. If no rule matches on a money step the result is `UNKNOWN`.
- Error classes: `RETRYABLE_OTP`, `TERMINAL_DECLINE`, `LIMIT_EXCEEDED`, `GATEWAY_FAULT`, `AMBIGUOUS`. Only gateway faults count toward the circuit breaker.
- A value from an earlier answer can never be used on the first step.

### A worked example
A recipe whose money step has `retry_policy` other than `NEVER` is refused at save time unless an idempotency key is proven.

### Common mistakes
- Marking a money step `SAFE` to make tests pass.

### Read now
- [[a:b06-03]]
- [[a:b06-08]]
- [[a:b06-17]]

### Check yourself
Questions: c-l-m8-3-1, c-l-m8-3-2
@@end

@@lesson id=l-m8-4 module=m8 order=4 title="Amounts, forms and signatures in practice" minutes=30 tracks=GATEWAY_ADMIN reading=b06-04,b06-05,b06-06
### You will be able to
- Configure scale, precision and rounding.
- Explain sensitivity levels.
- Diagnose a signature failure.

### Key ideas
- Scale 1, 100 or 1000; precision 0, 2 or 3; rounding `NONE`, `NEAREST`, `UP`, `DOWN`.
- Field sensitivity: `NORMAL`, `SENSITIVE`, `PAN` (full card number, memory only, needs a PCI review).
- Normalisers clean input, for example Arabic digits and phone formats.
- Signature algorithms include `HMAC_SHA256`; key encoding `UTF8`, `HEX` or `BASE64`; output `HEX_LOWER`, `HEX_UPPER` or `BASE64`.
- Common failures: wrong key encoding, wrong field order or set, wrong output case.
- Rotation keeps two secret versions valid during overlap.

### A worked example
A signature never matches. The partner's key is hexadecimal but our recipe treats it as text. Changing the key encoding to `HEX` fixes it.

### Common mistakes
- Testing a signing recipe with your own made-up sample instead of the partner's.

### Read now
- [[a:b06-04]]
- [[a:b06-05]]
- [[a:b06-06]]

### Check yourself
Questions: c-l-m8-4-1, c-l-m8-4-2
@@end

@@lesson id=l-m8-5 module=m8 order=5 title="Why a payment method is visible or hidden" minutes=25 tracks=OPERATOR,SUPPORT,GATEWAY_ADMIN reading=b06-12,b06-11
### You will be able to
- List the nine visible-rails conditions.
- Diagnose a missing method.
- Explain the circuit breaker.

### Key ideas
- A rail is shown only if all nine conditions hold: application list, link list, commission profile, an active route, healthy route, within limits and daily cap, outside maintenance and in scope, credential verified, currency matches and not blocked.
- Conditions 4 to 8 must be satisfied by one single route.
- The circuit breaker opens when a partner fails repeatedly; customers stop seeing the route and new payments use the next healthy one.
- Customer mistakes never trip the breaker.
- Walk down the table; the first failing line is the answer.

### A worked example
A merchant's customers cannot see Sadad for a 3000 LYD link. The route's maximum is 2000: condition 6 fails.

### Common mistakes
- Raising a limit to "make it appear".

### Read now
- [[a:b06-12]]
- [[a:b06-11]]

### Check yourself
Questions: c-l-m8-5-1, c-l-m8-5-2
@@end

@@lesson id=l-m8-6 module=m8 order=6 title="The wizard, AI import and the twelve gates" minutes=30 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b06-13,b06-14,b06-16
### You will be able to
- Name the eight wizard steps.
- Explain the safe AI import workflow.
- List the twelve go-live gates.

### Key ideas
- Steps: Identity & Basics, Environments & Auth, Customer Catalog, Crypto Profiles, Flow Builder, Client Action & Channels, Status Rules & Costs, Simulator & Approval.
- AI import: download the kit, ask the AI, upload and verify, add secrets and import as a draft. Never give the AI a real secret.
- Four verification layers: schema, meaning and security, offline simulation, collision check.
- An imported gateway arrives as a draft with a paused route and untested credentials.
- Gates: two-person approval; 15-scenario suite; amount, reference and signature contract tests; channel strength; rollback; limits/commission/statement preview; evidence level; PCI review; canary; alerts and runbooks.
- The approver must read the gate results.

### A worked example
A spec passes layers 1 to 3 but its route would be live. It is not: it is a draft and still needs the credential check, the gates and a second person.

### Common mistakes
- Treating a passed check as approval.

### Read now
- [[a:b06-13]]
- [[a:b06-14]]
- [[a:b06-16]]

### Check yourself
Questions: c-l-m8-6-1, c-l-m8-6-2
@@end

@@lesson id=l-m9-1 module=m9 order=1 title="Incident principles and the first three runbooks" minutes=30 tracks=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN reading=b10-01,b10-02,b10-03,b10-04
### You will be able to
- Apply the seven incident principles.
- Choose the right runbook.
- Follow RB-01, RB-02 and RB-03.

### Key ideas
- Stop the harm first, never guess with money, tell people early, one person leads, do not bypass controls, write as you go, hand over in writing.
- RB-01 outage: confirm, tell the Gateway Admin, do not re-enable a failing route.
- RB-02 signature or sender change: never accept unsigned messages; add the new secret or address with overlap; replay stored messages.
- RB-03 UNKNOWN backlog: find the pattern, Bulk Inquiry the affected route, do not mass-resolve by hand.
- Pausing is risk-reducing and may be immediate; resuming goes through review.

### A worked example
Signature failures spike. You do not accept unsigned messages. The Gateway Admin confirms the change with the partner in writing.

### Common mistakes
- Editing gateway settings to "try something" during an outage.

### Read now
- [[a:b10-01]]
- [[a:b10-02]]
- [[a:b10-03]]
- [[a:b10-04]]

### Check yourself
Questions: c-l-m9-1-1, c-l-m9-1-2
@@end

@@lesson id=l-m9-2 module=m9 order=2 title="Ledger drift and credential failures" minutes=25 tracks=OPERATOR,FINANCE,GATEWAY_ADMIN,SECURITY_ADMIN reading=b10-05,b10-06
### You will be able to
- Follow RB-04.
- Follow RB-05.
- Know what the platform did automatically.

### Key ideas
- Drift: P1, payouts stop automatically, re-run the statement ingest, inspect problem lines, never edit numbers, resume only when zero.
- Credential `FAILING`: the route is removed from selection; replace the secret (two people) and run the credential check.
- Rotate secrets with an overlap to avoid downtime.
- Running payments continue on their original credentials.

### A worked example
A credential set turns `FAILING`. You replace the secret through the proper approval and run the credential check; it becomes `VERIFIED` and the route returns.

### Common mistakes
- Cashing out manually while payouts are stopped.

### Read now
- [[a:b10-05]]
- [[a:b10-06]]

### Check yourself
Questions: c-l-m9-2-1, c-l-m9-2-2
@@end

@@lesson id=l-m9-3 module=m9 order=3 title="Handover, mistakes and leaks" minutes=20 tracks=FOUNDATION reading=b10-07,b10-08,b10-09
### You will be able to
- Write a good handover note.
- Report a mistake properly.
- Respond to a suspected leak.

### Key ideas
- Handover note: what is open and why, what you tried, what you wait for, anything risky, anything you promised.
- Never leave a half-finished approval without a note. Never hand over a secret.
- Mistake: stop, tell your manager, write what happened, do not edit history. A wrong executed approval is offset by a new entry.
- Suspected leak: tell the Security Admin immediately, change your password from a clean device, write what was exposed.
- Reporting quickly is never punished. Hiding is.

### A worked example
You approved the wrong row. You stop, tell your manager, and the owner of the area proposes the correction.

### Common mistakes
- Quietly trying to undo it with more clicks.

### Read now
- [[a:b10-07]]
- [[a:b10-08]]
- [[a:b10-09]]

### Check yourself
Questions: c-l-m9-3-1, c-l-m9-3-2
@@end

@@lesson id=l-m10-1 module=m10 order=1 title="How attackers think, and phishing" minutes=20 tracks=FOUNDATION reading=b11-01,b11-02,b11-03
### You will be able to
- Recognise the common tricks.
- Apply the password and MFA rules.
- Say what protects us.

### Key ideas
- Attackers want money, information or disruption, and the easiest way is usually a person.
- Tricks: urgency, authority, fake support asking for codes, fake links, favours, pretext.
- Never give a password or one-time code. Verify unusual requests through a second channel you already know.
- Back Office only from the office network or approved VPN; lock your screen; report a lost device the same minute.
- Sensitive actions ask you to sign in again. That is protection, not a bug.

### A worked example
A caller says he is from IT and needs your code to "fix your account". You refuse and report it to the Security Admin.

### Common mistakes
- Clicking a link in an e-mail instead of typing the address.

### Read now
- [[a:b11-01]]
- [[a:b11-02]]
- [[a:b11-03]]

### Check yourself
Questions: c-l-m10-1-1, c-l-m10-1-2
@@end

@@lesson id=l-m10-2 module=m10 order=2 title="Handling data and conduct" minutes=20 tracks=FOUNDATION reading=b11-04,b11-05,b05-04
### You will be able to
- Handle sensitive data correctly.
- Explain screenshots and exports rules.
- State the conduct rules.

### Key ideas
- Sensitive: national ID numbers, phone numbers, bank details, documents, AML information, anything secret.
- Quote references, not names. Do not copy data to personal notes, phones or e-mail. Delete exports when done.
- A screenshot copies data out of our controls. Never include secrets, codes or AML information.
- Masked values are masked on purpose.
- Never use another person's account. Do not look at records out of curiosity: every read is logged. Do not accept gifts from merchants or applicants.
- Report pressure to bypass a control.

### A worked example
You need to ask a colleague about a payment. You send the reference only, not the customer's name or phone.

### Common mistakes
- Posting a screenshot with a token in a team chat.

### Read now
- [[a:b11-04]]
- [[a:b11-05]]
- [[a:b05-04]]

### Check yourself
Questions: c-l-m10-2-1, c-l-m10-2-2
@@end

@@lesson id=l-m10-3 module=m10 order=3 title="Deployment, environments and secrets" minutes=30 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b12-01,b12-02,b12-03,b12-04,b12-05,b12-06
### You will be able to
- Describe the server model and firewall rules.
- Explain who holds which key.
- Explain Fake Rails and why it never runs in production.

### Key ideas
- Five roles: database, core, admin, merchant, checkout, on one to five servers. The database host never shares an address with the core.
- The core accepts connections only from the three edge hosts; the Back Office is LAN-only.
- The authority's private key never leaves the deployment workstation. Each edge gets only its own client certificate.
- Only the core holds database credentials and the master key.
- Deployment runs twelve steps in order, with an end-to-end check and automatic return to the previous release.
- Fake Rails imitates payment companies for drills and must never run in production.

### A worked example
A compromised checkout server cannot reach the database or impersonate the admin service, because it has neither the credentials nor the certificate.

### Common mistakes
- Committing deploy.env to a repository.

### Read now
- [[a:b12-01]]
- [[a:b12-02]]
- [[a:b12-03]]
- [[a:b12-04]]
- [[a:b12-05]]
- [[a:b12-06]]

### Check yourself
Questions: c-l-m10-3-1, c-l-m10-3-2
@@end


@@lesson id=l-m10-4 module=m10 order=4 title="Backups, point-in-time recovery and restore drills" minutes=25 tracks=GATEWAY_ADMIN,SECURITY_ADMIN reading=b12-07,b12-09,b12-10,b12-11
### You will be able to
- Explain the difference between a full backup, a delta backup and continuous WAL archiving.
- Read the five summary tiles and the three restore-drill checks on the **Backups** screen.
- Explain why a backup policy change needs a second Security Admin and why the off-site vault never deletes by default.

### Key ideas
- A **full backup** copies the whole database; a **delta backup** copies only what changed since the previous backup; **WAL archiving** copies every change continuously, so we can recover to a chosen second. That is **point-in-time recovery (PITR)**.
- Default timing, always in UTC: full weekly (Sunday 02:00), delta daily (02:00), restore drill weekly (Sunday 04:00).
- The **backup daemon** runs on the same host as the primary database or on a dedicated backup host. It keeps compressed, AES-256-GCM encrypted copies in a local repository, an S3 or MinIO bucket and an optional off-site vault.
- A backup nobody has restored is only a hope. The **restore drill** restores into an isolated scratch cluster, replays WAL to a target time and runs exactly three checks: **Double-entry zero drift**, **Sharded balance parity** and **Audit hash chain**. Any failed check is a priority-1 incident.
- **Edit policy** needs two Security Admins (`BACKUP_POLICY` approval), so one stolen account cannot shorten retention and erase history.

### A worked example
The weekly full backup ran on Sunday at 02:00 UTC and deltas ran on Monday and Tuesday at 02:00. On Tuesday at 14:35 UTC the primary disk fails. WAL archive lag was 2 seconds, so the archive holds everything except the last few seconds. The people who run the servers restore the full backup, the two deltas and then replay WAL up to the moment before the fault. Every settled payment and audit record is recovered, and the weekly drill had already shown that the same steps pass all three checks.

### Common mistakes
- Ignoring a rising **WAL archive lag** until unarchived WAL fills the database disk.
- Believing a policy change took effect after **Save Changes**, when it is still waiting for a second Security Admin.
- Treating **Drill failed** as a minor warning instead of finding which check failed.

### Read now
- [[a:b12-07]]
- [[a:b12-09]]
- [[a:b12-10]]
- [[a:b12-11]]

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
- [x] returns to the previous release automatically.
- [ ] continues.
- [ ] deletes the backup.
Why: Old releases remain.
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
- [x] switching the current link to the previous release and restarting.
- [ ] rebuilding.
- [ ] editing the database.
Why: One atomic step.
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
<!-- CONTENT:END -->
