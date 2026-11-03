---
id: admin-ui.guide
title: Admin Guide and Academy
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - admin-front/src/content/guide/**
  - admin-front/src/content/academy/**
  - admin-front/src/pages/guide/**
  - admin-front/src/pages/academy/**
  - admin-front/src/components/guide/**
design_sources:
  - design/complete_zero_to_hero_guides_and_academy_specification.md
  - design/guide_system_design_and_content (2).md
  - design/payment_gateway_deployment_and_guides_architecture.md
tests:
  - admin-front/src/content/__tests__/content-completeness.test.ts
  - tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts
  - tests/e2e/admin/global-search.spec.ts
gaps:
  - Guide v2 (14 books, 125 articles, five simulators, context map, safeguard cards, playbook and read tracking) is not implemented; only the 12-book baseline ships.
  - Chapter 9.4 is stored inside Book 7's chapter array, so Book 9 has only 9.1-9.3 and the Merchant help mapping to Book 9/9.4 resolves to no chapter.
  - The guide reference lists 10 GL account entries while the core enum has 11 account types; the guide entry combines provider fee and gateway fee expense into one label.
  - Academy progress is persisted as JSON on the user row but mastery, badges and certification are computed only in the browser; the backend does not validate the mastery gate.
  - There is no server-issued certificate or immutable certification record beyond the stored progress JSON and export audit.
  - Arabic coverage is not complete across every chapter body and academy lesson.
---

# Admin Guide and Academy

## 1. Purpose and scope

This part owns the admin interactive guide and the employee academy:

- The `admin-front` guide content modules under `src/content/guide`.
- The guide page at `/guide`, its global search modal, bookmarks, glossary, simulators, role checklists, and contextual-help data source.
- The academy content modules under `src/content/academy`.
- The academy page at `/academy`, its lessons, labs, quizzes, mastery gate, tracks, badges, team certification view and exports.

It does not own the merchant guide or checkout help center. It also does not present the future guide v2 specification as current behavior. The v2 workstream is recorded separately in `project-design/parts/09-future-and-unimplemented/01-guide-v2.md`.

## 2. Design intent (extracted and synthesized from ./design)

The implemented baseline is the "zero-to-hero" specification in `design/complete_zero_to_hero_guides_and_academy_specification.md`:

1. **The guide is an operational manual, not a feature tour.** Every chapter explains the concept, the exact workflow, the screen to use, and the human error to avoid.
2. **The reader is assumed to know nothing.** The glossary defines every banking, accounting, compliance and software term with an analogy and a fatal-error warning.
3. **The academy is a flight simulator.** A learner reads lessons, passes an interactive lab with fatal traps, then scores 100% on a verification quiz before a module counts as mastered.
4. **The guide and academy share a learning model.** Roles, tracks, badges and progress are visible to the learner and to management.
5. **The guide is searchable and contextual.** Global search covers books, glossary, statuses, GL accounts, runbooks, error codes, edge cases and simulators; the shell help drawer maps the current route to a chapter.
6. **Content is data, not hard-coded prose in TSX.** Books, chapters, glossary entries and academy modules live in typed content modules so the UI can render, search and test them.
7. **Every claim must be testable.** The content-completeness test asserts book count, chapter depth, glossary counts, status/collection/channel/runbook counts, edge-case count, module count, lesson depth, lab traps, quiz count and track definitions.

The future guide v2 specification in `design/guide_system_design_and_content (2).md` goes further: 14 books (0-13), 125 articles, a 23-screen context map, safeguard cards, a symptom playbook, reading paths, read tracking, five simulators and an edge-case catalog. It is not the current implementation.

## 3. As-built architecture

### 3.1 Content modules

| Module | Contents |
| :--- | :--- |
| `admin-front/src/content/guide/types.ts` | `GuideBook`, `GuideChapter`, glossary/reference/search types. |
| `admin-front/src/content/guide/booksPart1.ts` | Books 1-6 and their chapters. |
| `admin-front/src/content/guide/booksPart2.ts` | Books 7-12 and their chapters. |
| `admin-front/src/content/guide/glossaryData.ts` | Glossary terms, GL accounts, attempt statuses, collection modes, confirmation channels, runbooks, edge cases and error codes. |
| `admin-front/src/content/guide/index.ts` | Aggregates books/chapters, exposes lookups, simulator ids and `GUIDE_ROUTE_HELP`. |
| `admin-front/src/content/guide/search.ts` | Builds and scores the in-memory search index. |
| `admin-front/src/content/academy/types.ts` | Modules, lessons, labs, quizzes, tracks, badges and progress types. |
| `admin-front/src/content/academy/modulesTrackA.ts` | Modules M1-M4. |
| `admin-front/src/content/academy/modulesTrackB.ts` | Modules M5-M8. |
| `admin-front/src/content/academy/index.ts` | Aggregates modules/tracks and computes mastery, badges and track percentages. |

### 3.2 The 12 books and 27 chapters

| Book | Title | Chapters |
| :--- | :--- | :--- |
| 1 | Welcome to the Platform — How Money, Data, and Security Work From Zero | 1.1, 1.2 |
| 2 | Roles, Authorities & the Four-Eyes (Maker-Checker) Governance Rule | 2.1, 2.2, 2.3, 2.4 |
| 3 | The Four-Layer Payment Catalog (Gateway -> Credential Set -> Rail -> Route) | 3.1, 3.2 |
| 4 | Collection Modes (Axis A) & Confirmation Channels (Axis B) — Why We Never Trust the Browser | 4.1, 4.2 |
| 5 | The Universal Flow Engine, `TransformPipe[]` & Cryptographic Signing | 5.1, 5.2, 5.3 |
| 6 | The 8-Step "Add-a-Gateway" Wizard & Smart AI Integration Importer | 6.1, 6.2 |
| 7 | The 14-State Attempt Lifecycle & Resolving `UNKNOWN`, `CONFLICT`, and `HELD` Cases (`RB-01` to `RB-05`) | 7.1, 7.2, plus the misplaced 9.4 |
| 8 | Double-Entry Accounting, Clearing Accounts, Fee Bearers & Statement Reconciliation | 8.1, 8.2 |
| 9 | Merchant Onboarding, KYB Document Verification & Duplicate Detection | 9.1, 9.2, 9.3 |
| 10 | The 7-Layer AML & Compliance Program, Screening Dispositions & CBL Reporting | 10.1 |
| 11 | Disputes, Chargebacks, Refunds, Cash-Outs & Negative Balance Ceilings | 11.1, 11.2 |
| 12 | Platform Profitability, Liquidity, Solvency & The 12 Go-Live Gates | 12.1 |

The total is 27 chapter objects. The 9.4 object (`book-9-chapter-9.4`, merchant lifecycle/support) is physically inside `BOOKS_PART_2[0]`, which is Book 7. `findChapter(9, "9.4")` therefore returns `undefined`, while Book 7's table of contents renders a 9.4 chapter under Book 7. This is a content-placement bug, not a missing chapter body.

### 3.3 Reference and glossary counts

| Collection | Count | Notes |
| :--- | :--- | :--- |
| `GLOSSARY_TERMS` | 24 | Zero-assumption terms with definition, analogy and fatal-error warning. |
| `GL_ACCOUNT_DEFINITIONS` | 10 entries | Covers 11 core enum types because `PROVIDER_FEE_EXPENSE / GATEWAY_FEE_EXPENSE` is one combined label. |
| `ATTEMPT_STATUS_DEFINITIONS` | 14 | Matches the core attempt lifecycle. |
| `COLLECTION_MODE_DEFINITIONS` | 9 | OTP pull, redirect, embedded, push, QR, pay code, deep link, manual, hybrid. |
| `CONFIRMATION_CHANNEL_DEFINITIONS` | 7 | Zero-trust versus server-trusted channels. |
| `RUNBOOK_DEFINITIONS` | 5 | `RB-01` to `RB-05`. |
| `EDGE_CASE_DEFINITIONS` | 140 | The guide's edge-case registry. |
| `ERROR_CODE_GLOSSARY` | 5 | Canonical error categories such as `RETRYABLE_OTP`, `LIMIT_EXCEEDED`, `GATEWAY_FAULT`, `AMBIGUOUS`. |

The UI glossary headings say "10 GL account types", "9 collection modes" and "7 confirmation channels". The GL label is consistent with the content module but not with the core enum's 11 types; the guide therefore undercounts the canonical GL account types by representing the two fee-expense labels as one entry.

### 3.4 Guide page surfaces

`admin-front/src/pages/guide/index.tsx` provides four view modes:

1. **Books** — 12-book tree, selected book summary, tags, human-error warning, SOP checklist, expandable chapters, "where to click" route pills, previous/next book, bookmark, copy link, and Markdown download.
2. **Glossary** — filterable glossary plus expandable sections for 14 statuses, GL accounts, 9 collection modes, 7 confirmation channels, error codes, 5 runbooks and 140 edge cases.
3. **Simulators** — three interactive widgets: `TransformPlayground`, `CryptoSignatureLab`, `LedgerTAccountVisualizer`. The same widgets are embedded inline in chapters 5.2, 5.3 and 8.2.
4. **Checklists** — five role-based daily checklists: support, operations, compliance, finance, gateway architect.

Additional guide behavior:

- Global search modal opened by the shell (`Ctrl+K`/`Cmd+K`), searching books, chapters, glossary, errors, GL accounts, statuses, collection modes, channels, runbooks, edge cases and simulators.
- Bookmark persistence in `localStorage` key `admin-guide-bookmarks`.
- Daily checklist persistence in `localStorage` key `admin-guide-daily-checklists`.
- Bookmark import/export as JSON, with unknown book ids skipped and an optional replace mode.
- Deep links via `?entry=`, `?book=`, `?chapter=`, `?search=1`.
- Route help mapping in `GUIDE_ROUTE_HELP` (29 entries), consumed by the shell drawer.

### 3.5 Academy content

| Module | Focus | Lessons | Quiz questions |
| :--- | :--- | :--- | :--- |
| M1 | Foundations: digital payments, links, slots, zero-trust | 3 | 8 |
| M2 | Four-eyes governance and field control | 2 | 8 |
| M3 | Merchant onboarding, KYB forensics, beneficial owners, duplicates | 2 | 8 |
| M4 | Double-entry accounting, fee bearers, clearing, reconciliation | 2 | 8 |
| M5 | Rail engine, 8-step wizard, smart AI importer | 2 | 8 |
| M6 | `UNKNOWN`, outages, circuit breakers, runbooks | 2 | 8 |
| M7 | AML program, Arabic name matching, velocity, no tipping-off | 2 | 8 |
| M8 | Disputes, chargebacks, refunds, ceilings, go-live gates | 2 | 8 |

Totals: 8 modules, 17 lessons, 8 labs with at least one fatal option, and 64 quiz questions (8 per module).

### 3.6 Academy page and mastery gate

`admin-front/src/pages/academy/index.tsx` provides:

- Track tabs with live progress percentages.
- Module selection and three steps: lessons, interactive lab, verification quiz.
- Lesson completion tracking.
- Lab scenarios with fatal-error feedback; a fatal option does not pass the lab.
- Quiz submission with 100% required to pass; immediate score and explanations.
- Badge computation from track definitions.
- Team certification accordion with per-user completion percentage and badges.
- Summary health panel (`usersWithProgress`, not started, modules/lessons/labs, badges, active last 7 days).
- Two XLSX exports: academy summary and team certifications.

Mastery is computed client-side in `admin-front/src/content/academy/index.ts`:

- `moduleLessonsComplete` — every lesson id is in `completedLessonIds`.
- `moduleLabPassed` — the module lab id is in `completedLabIds` with `passed: true`.
- `moduleQuizPerfect` — the quiz score is 100%.
- `moduleMastered` — all three are true.
- `earnedBadges` — all modules in a track are mastered; `MASTER_OPERATOR` additionally requires all labs passed and all quizzes perfect.
- `trackProgressPercent` — mastered modules divided by track modules.

Progress persistence uses `GET/PUT v1/admin/academy/progress`. It stores completed lesson ids, lab results, quiz scores, earned badges and last module id on the authenticated user row. Legacy `completedModules` data is converted into the new shape on load.

### 3.7 Academy reporting and authority

- Self progress endpoints: authenticated user, no extra authority.
- Team overview: `GET v1/admin/academy/progress/overview`, backend requires `user:read`.
- Summary: `GET v1/admin/academy/progress/overview/summary`, backend requires `user:read`.
- Summary export: `GET .../summary/export`, backend requires `user:read` and writes an `ACADEMY_SUMMARY_EXPORTED` audit entry.
- Certification export: `GET .../overview/export`, backend requires `user:read` and writes an `ACADEMY_CERTIFICATIONS_EXPORTED` audit entry.
- UI route `/academy` has no router authority gate, so the page opens for any authenticated admin; the reporting calls fail without `user:read`.

## 4. Contracts and invariants

1. **Current guide counts are 12 books and 27 chapters.** The content test asserts 12 books; it does not assert exactly 27 chapters, so the count is verified by code inspection.
2. **The current academy counts are 8 modules, 17 lessons, 64 quizzes.** The content test asserts 8 modules and exactly 8 quizzes per module.
3. **A module is mastered only by lessons + passed lab + 100% quiz.** No UI button can skip the gate.
4. **Badges are derived, not manually granted.** `earnedBadges` merges stored badges with newly earned track badges.
5. **Guide/search content must be typed and testable.** New content goes into the content modules, not inline JSX.
6. **The guide is allowed for all admins.** It contains no live data or secrets by design.
7. **Academy progress is per user.** Team views aggregate the same JSON shape.
8. **The guide v2 specification is not current authority.** It must not be described as shipped.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Guide content | `admin-front/src/content/guide/**` |
| Academy content | `admin-front/src/content/academy/**` |
| Guide page | `admin-front/src/pages/guide/index.tsx` |
| Academy page | `admin-front/src/pages/academy/index.tsx` |
| Guide drawer/search | `admin-front/src/components/guide/**` |
| Route help map | `admin-front/src/content/guide/index.ts` |
| Progress APIs | `v1/admin/academy/progress`, `/overview`, `/overview/summary`, `/overview/export` |
| Local storage | `admin-guide-bookmarks`, `admin-guide-daily-checklists` |
| Future v2 destination | `project-design/parts/09-future-and-unimplemented/01-guide-v2.md` |

## 6. Operational usage

- Add a book or chapter: append to `booksPart1.ts` or `booksPart2.ts`, keep the id/number/title/body/tags shape, and update `GUIDE_ROUTE_HELP` if a screen should point to it.
- Add a glossary entry: add to the appropriate array in `glossaryData.ts`; the search index and glossary UI pick it up automatically.
- Add an academy module: add to a track module file, keep 8 quiz questions and at least one fatal lab option, then update the track definitions if the module belongs to a track.
- Re-run `bun test src/content/__tests__/content-completeness.test.ts` after content changes.
- Fix the 9.4 bug by moving the chapter object into Book 9 (or by changing the mapping to the actual book); do not duplicate the body.
- Treat guide v2 as a separate future implementation, not as a content edit to the current modules.

## 7. Status and deviations

### Implemented

- 12 books, 27 chapters, 24 glossary terms, 14 statuses, 9 collection modes, 7 channels, 5 runbooks, 140 edge cases and 5 error codes.
- Three interactive simulators with inline chapter embeds.
- Five role-based daily checklists with local persistence.
- Global guide search, bookmarks, import/export, deep links and Markdown download.
- 29-entry contextual route map.
- 8 academy modules, 17 lessons, 8 labs, 64 quizzes, 6 certification tracks.
- Client-side mastery gate, badge derivation and track progress.
- Progress persistence and team overview/summary/certification exports with backend `user:read` gating.

### Partial

- The guide is content-rich but not fully bilingual; many chapters have Arabic bodies and many do not.
- Academy assessment is client-computed. The backend accepts the posted progress JSON and does not independently verify answers, lab outcomes or mastery.
- Certification is a computed badge, not a server-issued certificate with an immutable registry.
- The guide v2 work is not merged; the current guide does not have v2's articles, context map, safeguard cards, playbook or read tracking.

### Guide v2 comparison (future, not current)

| Area | Current implementation | Guide v2 target |
| :--- | :--- | :--- |
| Books | 12 (1-12) | 14 (0-13) |
| Articles/chapters | 27 chapter objects | 125 articles |
| Context model | 29-entry route map | 23-screen context map with fallback |
| Simulators | 3 | 5 |
| Safeguard cards | none | Per-screen safeguard checklists |
| Situation playbook | none | Symptom-to-action playbook |
| Reading paths/progress | Bookmarks and role checklists only | Role reading paths and read tracking |
| Edge cases | 140 | 140-case catalog plus v2 presentation |

### Missing / deferred

- **Guide v2 is missing.** Target: 14 books (0-13), 125 articles, 23 context-map screens, five simulators, reading paths, safeguard cards, symptom playbook, read tracking and a full edge-case catalog. See `project-design/parts/09-future-and-unimplemented/01-guide-v2.md` and `design/guide_system_design_and_content (2).md`.
- No server-side quiz/lab validation.
- No immutable certification record or expiry/re-certification cycle.
- No completion tracking tied to route-level or authority-level access grants.
- No Arabic content completeness gate.

### Known bugs / risks

- **Content-placement bug:** Chapter 9.4 lives under Book 7, so Book 9/9.4 help resolution fails and Book 7 shows an out-of-sequence chapter.
- **Count gap:** The guide displays 10 GL entries while the core enum has 11 types. The combined `PROVIDER_FEE_EXPENSE / GATEWAY_FEE_EXPENSE` entry hides the distinction.
- **Security gap:** A client could POST arbitrary progress JSON because mastery is not recomputed server-side. The stored progress is training data, not an authorization authority.
- **Reporting gap:** `/academy` is open to all authenticated admins, but team overview/export fail without `user:read`; the page does not explain this before the request.
- **Documentation risk:** The v2 specification must not be presented as current; it is future/unimplemented.

## 8. Verification and tests

- `admin-front/src/content/__tests__/content-completeness.test.ts` asserts:
  - 12 books with depth, SOP checklist and human-error warnings.
  - Glossary/reference counts: 10 GL entries, 14 statuses, 9 collection modes, 7 channels, 5 runbooks, 140 edge cases, at least 5 error codes.
  - Search coverage for books, errors, GL accounts, statuses, runbooks, edge cases and simulators.
  - 8 academy modules, at least 2 lessons per module, one lab per module with a fatal option, exactly 8 quizzes per module (64 total), and six track definitions.
- `tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts` includes `/guide` and `/academy`.
- `tests/e2e/admin/global-search.spec.ts` covers the shell search split between records and guide search.

The content test is a Bun test and does not require PostgreSQL. The Playwright surface checks require the running stack.

## 9. Source references

### Old design sections

- `design/complete_zero_to_hero_guides_and_academy_specification.md` — implemented 12-book/8-module baseline.
- `design/guide_system_design_and_content (2).md` — future guide v2 workstream, not current.
- `design/payment_gateway_deployment_and_guides_architecture.md` — deployment and guide architecture context.

### Code paths

- `admin-front/src/content/guide/booksPart1.ts`
- `admin-front/src/content/guide/booksPart2.ts`
- `admin-front/src/content/guide/glossaryData.ts`
- `admin-front/src/content/guide/index.ts`
- `admin-front/src/content/guide/search.ts`
- `admin-front/src/content/academy/modulesTrackA.ts`
- `admin-front/src/content/academy/modulesTrackB.ts`
- `admin-front/src/content/academy/index.ts`
- `admin-front/src/pages/guide/index.tsx`
- `admin-front/src/pages/academy/index.tsx`
- `admin-front/src/components/guide/**`

### Generated appendices

- `project-design/appendices/test-inventory.md`
- `project-design/appendices/api-route-matrix.md`

## 10. Change history

- 2026-11-03 — Initial canonical guide/academy part. Confirms 12 books/27 chapters, 24 glossary terms, 10 GL entries covering 11 core types, 8 academy modules/17 lessons/64 quizzes, the client-side mastery gate, and the unimplemented guide v2 workstream.
