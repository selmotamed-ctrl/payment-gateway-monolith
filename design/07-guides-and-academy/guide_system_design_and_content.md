# ADMIN INTERACTIVE GUIDE — COMPLETE DESIGN, IMPLEMENTATION SPEC & FULL CONTENT · VERSION 1.0


> **2026-11-04 repository note.** Admin Guide v1.0 from this spec is **implemented** (`admin-front/src/pages/guide/**`, `src/components/guide/**`, committed corpus in `src/content/guide/generated/`); see `project-design/parts/03-admin-front/06-guide-v2.md`. Content-label corrections made during implementation are logged in `guide_content_fixes.md` and open behaviour questions in `guide_content_questions.md` (same folder). The companion Academy spec is `academy_system_design_and_content.md`.

**Subtitle:** The employee-grade, zero-assumption, searchable reference for the whole Payment Gateway Platform — rebuilt from the ground up to replace the current `admin-front` `/guide`.

**Target repository:** `selmotamed-ctrl/payment-gateway-monolith` (primary work in `admin-front`, small supporting changes in `admin-back` and `core-back`, tests in `tests/`).
**Companion file:** `design/07-guides-and-academy/academy_system_design_and_content.md` (the Employee Academy). The Academy and this Guide share one progress record (defined in the Academy file, §A-3). **Implement Academy phase A-1 before Guide phase G-4.**
**Supersedes:** `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` §9, §10 and §11 for the Admin Guide only. The Merchant Guide (`merchant-front`) and the Checkout Help Center (`checkout-front`) are **out of scope** and must not be touched by this work.

---

## CONTENTS

- **PART 0 — READ THIS FIRST: Rules for the implementing agent (OpenCode)**
- **PART I — PRODUCT DESIGN:** purpose, audience, principles, scope, information architecture
- **PART II — TECHNICAL SPECIFICATION:** content format, extraction, data types, components, widgets with test vectors, contextual help, safeguard cards, search, progress, i18n, tests, phased task list
- **PART III — THE CONTENT** (this is the product; it is copied verbatim into the app)
  - III-A Books 0–13 (articles)
  - III-B Glossary
  - III-C Safeguard Cards
  - III-D Situation Playbook
  - III-E Reading Paths by Role
  - III-F Data blocks (ledger events, simulator data, context map)
  - III-G Quick answers (FAQ)

---

# PART 0 — READ THIS FIRST: RULES FOR THE IMPLEMENTING AGENT

You are implementing a safety-critical training and reference system for people who will move real money. The people who read it may know **nothing** about payments, accounting, compliance or software. The most expensive failure is a human acting wrongly because the guide was unclear or wrong. Therefore:

1. **The content in PART III is the single source of truth. Copy it. Never rewrite, summarize, shorten, "improve", translate, merge or re-order it.** You may not decide what the guide says. If you believe something is missing or wrong, follow rule 5.
2. **Content is extracted by a script, not retyped.** You will write `admin-front/scripts/extract-guide-content.ts` (spec in §II-2) which reads this very file from `design/` and emits JSON. You never paste article text into `.ts`/`.tsx` files.
3. **Use the real UI labels.** Where an article names a button, screen or menu item in **bold** it uses the label currently in the code (`t("...")` strings). If you discover a label in an article that does not exist in the code, follow rule 5 (verification procedure).
4. **Money math uses `decimal.js` only. No `eval`, no `new Function`, no `Function(...)`, no `vm`.** Simulators are pure client-side code with no network calls.
5. **Verification procedure for content mismatches.** When implementing, you must open each screen file named in the *Screen-to-Article map* (§III-F.3) and compare the bold UI labels in the linked articles with the strings in the source. For each mismatch: (a) change **only the label text** inside the design file's article, (b) append a line to `design/07-guides-and-academy/guide_content_fixes.md` (`articleId | old label | new label | file:line`), (c) never change any explanation. If a statement of *behaviour* (not label) looks wrong, do **not** edit it: append it to `design/07-guides-and-academy/guide_content_questions.md` and continue. Never block on a content question.
6. **Counts must match.** After extraction the generated metadata must equal the numbers in §II-2.5 (EXPECTED COUNTS). The content test fails the build otherwise.
7. **Source-of-truth numbers from code (already verified against the repository):** the database enum `AttemptStatus` has **14** values; `GlAccountType` has **11** values (it includes `GATEWAY_FEE_EXPENSE`); the Add-a-Gateway wizard in code has **8** steps named *Identity & Basics, Environments & Auth, Customer Catalog, Crypto Profiles, Flow Builder, Client Action & Channels, Status Rules & Costs, Simulator & Approval*. Older design documents say "13 states" and "10 GL types": the guide uses the code numbers (14 and 11). Do not "fix" the content back to 13 or 10.
8. **Do not touch** `merchant-front`, `checkout-front`, `merchant-back`, `checkout-back`, or any ledger/engine code. Backend changes are limited to those listed in §II-9.
9. **Definition of Done for every phase:** `bun run type-check` and `bun run build` in `admin-front` pass; `bun run test:unit` and the named Playwright specs in `tests/` pass; no new `console.error` in the e2e run; the phase checklist in §II-12 is ticked in this file (`[ ]` → `[x]`) **only after** the verification command succeeded.
10. **Keep the project conventions:** Vue 3 TSX with `dc()` from `kt-dc`; Vuetify 3; `unplugin-vue-components` before `vueJsx()`; Vue I18n/Vuetify locale with Arabic RTL default; `@/` alias; no new global CSS that scales or transforms `#app`.
11. **New dependencies allowed (and only these):** `markdown-it` and `minisearch` in `admin-front`. Nothing else.

---

# PART I — PRODUCT DESIGN

## I-1. Why this is being rebuilt

The current guide is a searchable list of ten short "books" plus three simulators. It reads like a feature tour. It assumes the reader already knows what a gateway, a ledger, an OTP, a webhook or AML is. A new employee cannot learn the platform from it, and nothing in it stops a tired operator from clicking the wrong button.

The new Guide has three jobs, in this order of importance:

1. **Prevent human error at the moment of action.** Every screen has a "?" drawer; every risky action shows a checklist before it executes.
2. **Teach from zero.** Anyone who can read can understand the whole system, A to Z, with no prior knowledge. Every unfamiliar word is explained where it first appears and again in the glossary.
3. **Be the reference during incidents.** Calm, step-by-step runbooks, a symptom-to-action playbook and a plain-language catalog of the 140 edge cases.

## I-2. Audience

| Audience | What they need | How the guide serves them |
| :--- | :--- | :--- |
| Brand-new employee, any role, no background | Vocabulary, the big picture, safety rules | Book 0 → Book 1 → Book 2, glossary tooltips everywhere |
| `OPERATOR`, `SUPPORT` | Daily queues, reading statuses, what to do about `UNKNOWN` | Books 3, 5, 7, 10 |
| `FINANCE` | Ledger, settlement, cash-outs, refunds, disputes | Books 4, 7, 8 |
| `COMPLIANCE`, `MLRO` | AML program, cases, reporting, confidentiality | Books 4, 5, 9 |
| `GATEWAY_ADMIN`, `SECURITY_ADMIN` | Gateways, rails, routes, credentials, deployment, security | Books 4, 6, 11, 12 |
| Management | One place to see the rules everybody is held to | Book 0 (Golden Rules), Book 4, Book 13 |

All seven admin roles can open every article. Roles only change **recommendation** ("Recommended for you") and the reading path. The guide contains **no live data, no real thresholds, no real names, no secrets**; it explains rules, not records, so it is safe for everyone to read.

## I-3. Writing principles (already applied to PART III; use them to judge any future edit)

1. **Zero assumed knowledge.** Define every term at first use, in a short parenthesis or sentence. Never write "obviously", "simply", "just".
2. **Say who, where, what, why, and what if I get it wrong.** Instructions name the role, the exact screen, the exact button, the reason, and the recovery.
3. **Short sentences, concrete numbers.** Use real examples (100 LYD, 3% commission) rather than abstractions.
4. **One meaning per word.** The same concept is always called the same thing (see glossary). UI labels appear in **bold** exactly as on screen.
5. **Honest about gaps.** If a feature exists in the design but has no screen yet, the article says so (`ui=NOT_YET` banner) and names who performs it today.
6. **Safety first, in plain voice.** Warnings use the `warning` / `danger` callouts and explain the consequence, not just the rule.
7. **No secrets, no live data, no external links.** The platform's admin side is LAN-only; the guide never links outside it.
8. **Versioned.** Every build carries `contentVersion`; reading progress records the version read so a major change can request a re-read.

## I-4. Scope

**In scope:** the Admin Guide (`/guide/**`), global command palette (Ctrl/Cmd+K), contextual "?" drawer on every admin screen, safeguard checklists on risky actions, five simulators, glossary with auto-linking, symptom playbook, 140-case catalog, reading paths, read-tracking, English content (Arabic-ready).

**Out of scope:** Merchant Guide, Checkout Help, any change to payment, ledger or engine behaviour, server-side search, analytics, external links, AI/LLM features.

**Arabic:** the platform is Arabic-first (RTL). This file ships **English content in full** plus an Arabic term table (the `ar=` attribute in the glossary) so translation is consistent. The loader must support `articles.ar.json` and show English with a visible "Arabic version pending" chip until it exists (§II-8). Do **not** machine-translate; translation is a separate human-reviewed work package.

## I-5. Information architecture

```text
/guide                      Home: search, "Start here", reading path for my role, continue reading, books, tools, "I'm stuck"
/guide/book/:bookId         One book: summary, ordered article list, progress ring
/guide/a/:articleId         Article reader (TOC, glossary tooltips, mark-as-read, prev/next)
/guide/glossary/:slug?      A–Z glossary with filter; one entry deep-linkable
/guide/tools/:tool?         Simulators gallery (transform, crypto, ledger, visible-rails, attempt-states)
/guide/playbook/:id?        "What you may see, and what to do" — situation cards
/guide/cards/:id?           Safeguard cards (checklists for risky actions)
/guide/edge-cases           The full 140-case catalog with filters
(global)  Ctrl/Cmd+K        Command palette (articles, glossary, cards, situations, error codes, edge cases)
(global)  "?" in PageHeader Contextual drawer for the current screen
```

Book list (IDs are fixed): **0** Start Here · **1** Foundations from Zero · **2** The Platform Map · **3** Working in the Back Office · **4** Governance: Four Eyes · **5** Merchants · **6** Gateways, Rails & the Engine · **7** Payments in Operation · **8** Money & the Ledger · **9** Risk, AML & Compliance · **10** When Things Go Wrong · **11** Security for Everyone · **12** Deployment & Hosting · **13** Reference.

---

# PART II — TECHNICAL SPECIFICATION

## II-1. Files to create, change, delete

```text
admin-front/
  scripts/extract-guide-content.ts                  NEW  (spec §II-2)
  package.json                                      CHANGE  add scripts: "content:guide", deps markdown-it, minisearch
  src/content/guide/generated/*.json                NEW  (generated, committed)
  src/content/guide/index.ts                        NEW  typed lazy loaders (§II-3)
  src/components/guide/                             REPLACE entire folder contents:
      MarkdownView.tsx  GlossaryPopover.tsx  ArticleToc.tsx  BookCard.tsx  ReadingPath.tsx
      GuideSearch.ts (index+query)  GuideSearchPalette.tsx
      ContextHelpButton.tsx  ContextHelpDrawer.tsx
      SafeguardDialog.tsx  useSafeguard.ts
      StuckPanel.tsx  ReadToggle.tsx  UiStatusBanner.tsx
      widgets/TransformSandbox.tsx  widgets/CryptoLab.tsx  widgets/LedgerExplorer.tsx
      widgets/VisibleRailsExplainer.tsx  widgets/AttemptStateExplorer.tsx
      widgets/engine/{transforms.ts, crypto.ts, ledger.ts, visibleRails.ts, attemptStates.ts, safeAmount.ts}
  src/pages/guide/{index,book,article,glossary,tools,playbook,cards,edge-cases}.tsx
  src/components/PageHeader/index.tsx               CHANGE  mount <ContextHelpButton/> (§II-6)
  src/layouts/default.tsx                           CHANGE  mount <GuideSearchPalette/> + Ctrl/Cmd+K listener
  src/router/index.ts                               CHANGE  add the 8 routes (names in §I-5)
  src/layouts/sections.tsx                          CHANGE  "Learning" section keeps AdminGuide & AdminAcademy; no authority needed
  src/components/guide/content.ts                   DELETE (old embedded content)
  src/pages/guide/index.tsx                         REWRITE
tests/unit/guide-*.test.ts                          NEW
tests/e2e/admin/guide-*.spec.ts                     NEW
design/07-guides-and-academy/guide_content_fixes.md, guide_content_questions.md   NEW (empty headers, filled per rule 5)
```

The existing `ledger.ts` and `transform.ts` in `components/guide/` may be reused as the starting point of `widgets/engine/ledger.ts` and `transforms.ts` **only if** they pass the vectors in §II-5. Otherwise rewrite them.

## II-2. Content format and the extractor

### II-2.1 Block syntax (everything in PART III uses exactly this)

All content blocks begin with a line that starts with `@@` and end with `@@end` (except one-line `@@term` and `@@term`-style lines). **Attributes** are `key=value` or `key="value with spaces"`. Parsing rule for attributes: regex `([a-zA-Z_][\w-]*)=("([^"\\]|\\.)*"|[^\s]+)`.

| Block | Opening line | Body | Closed by |
| :--- | :--- | :--- | :--- |
| Book | `@@book id=2 title="..." audience="..." summary="..."` | none | (single line) |
| Article | `@@article id=b02-03 book=2 order=3 title="..." roles=ALL minutes=6 ui=AVAILABLE related=b07-01,b08-02` | Markdown | `@@end` |
| Term | `@@term slug=ledger term="Ledger" aliases="books;general ledger" ar="دفتر الأستاذ" related=double-entry :: Short definition.` | none | (single line) |
| Card | `@@card id=sg-approve-adjustment title="..." screen=Approvals risk=HIGH irreversible=true` | Markdown with 4 fixed bold headings (§II-7) | `@@end` |
| Situation | `@@situation id=s-unknown-attempt title="..." screens=OperatorCases cases=5,8,20 articles=b07-03` | Markdown | `@@end` |
| Path | `@@path role=OPERATOR title="..." :: b00-01,b00-03,...` (`role` is a staff role or `ALL` for the new-employee path) | none | (single line) |
| Data | `@@data id=ledger-events` | one fenced ```json block | `@@end` |
| Map | `@@map id=context-map` | one fenced ```json block | `@@end` |
| FAQ | `@@faq id=q-001 article=b07-03` | first line `Q: ...` then answer text | `@@end` |

Lines outside blocks (headings such as `### BOOK 4`, blank lines) are ignored. Inside `@@data` and `@@map` only the single fenced `json` block is read. `roles` is `ALL` or a comma list from `GATEWAY_ADMIN,SECURITY_ADMIN,FINANCE,OPERATOR,COMPLIANCE,MLRO,SUPPORT`. `ui` is `AVAILABLE`, `PARTIAL` or `NOT_YET`. IDs are lowercase `[a-z0-9-]`.

### II-2.2 Markdown dialect inside article bodies

* CommonMark + tables (via `markdown-it`, `html:false`, `linkify:false`, `typographer:false`).
* **Callout containers** (implemented by you as a small `markdown-it` core/block rule, no extra package): a line `:::note`, `:::tip`, `:::warning`, `:::danger`, `:::example`, `:::do`, `:::dont`, optionally followed by a title (`:::warning Never do this`), content lines, closing line `:::`. Render as `<aside class="callout callout-{type}" role="note">` with an icon and a visible type label (Note / Tip / Warning / Danger / Example / Do / Don't) — meaning must not rely on color alone.
* **Widget placeholder:** a line `{{widget:ledger-explorer}}` (allowed ids: `transform-sandbox`, `crypto-lab`, `ledger-explorer`, `visible-rails`, `attempt-states`). Replaced by the component.
* **Article link:** `[[a:b07-03]]` → link to the article using its title; `[[a:b07-03|custom text]]` → custom text. **Card link:** `[[c:sg-approve-adjustment]]`. **Situation link:** `[[s:s-unknown-attempt]]`. **Glossary link:** `[[g:ledger]]` (explicit; auto-linking also exists, §II-4).
* Fenced code blocks tagged ` ```diagram ` render monospace, `dir="ltr"`, horizontally scrollable; they are used for text diagrams.
* Headings inside articles start at `###` (the page supplies the `##` title). Every heading gets a stable id = slug of its text, de-duplicated with `-2`, `-3`.
* Tables are wrapped in an `overflow-x:auto` container. No raw HTML, no images, no external links (an `http(s)://` link in content fails the content test).

### II-2.3 `scripts/extract-guide-content.ts` — required behaviour

Run with `bun run content:guide`. Steps:

1. Locate the design file: `design/07-guides-and-academy/guide_system_design_and_content.md` (relative to repo root, found via `../design/` from `admin-front`). If absent: print an error and exit 1.
2. Read the file as UTF-8, normalise `\r\n` to `\n`. **Only parse content between the two marker lines `<!-- CONTENT:BEGIN -->` and `<!-- CONTENT:END -->` (each marker is a whole line by itself; mentions of them inside other text are not markers)** (markers exist in PART III).
3. Parse blocks line by line with the grammar above. Unknown `@@` keywords, duplicate ids, a missing `@@end`, or an unparsable JSON fence → exit 1 with file line number.
4. Validate cross-references: every `related`, `[[a:]]`, `[[c:]]`, `[[s:]]`, `[[g:]]`, `articles=`, `article=`, path entry and context-map id must exist.
5. Emit into `src/content/guide/generated/`: `books.json`, `articles.en.json` (array of `{id, book, order, title, roles, minutes, ui, related, body, headings[], plainText}`), `glossary.en.json`, `cards.en.json` (with parsed `checklist: string[]` from lines beginning `- [ ] `), `playbook.en.json`, `paths.json`, `faq.en.json`, `data.json` (`{ [id]: parsedJson }`), `context-map.json`, `meta.json` (`{contentVersion, generatedAt, counts, sourceSha256}`). `contentVersion` is the value of the `<!-- CONTENT_VERSION: x.y.z -->` marker (initially `1.0.0`).
6. Also generate `error-codes.en.json` from article `b13-01`: for every table row whose first cell is a single backticked token, emit `{code, where, meaning, action}` (the four cells, markdown stripped). Then generate `edge-cases.en.json` by parsing the 140-row tables of Section 13 of the repository file matched by glob `design/payment-gateway-refined-design-v4*.md` (the file in the repo is named `payment-gateway-refined-design-v4.1.md`). Row format: `| **N** | scenario | resolution | severity |`; group headings are `### **Group X: Name (Cases a–b)**`. Strip markdown bold and backslash escapes (`\_`, `\#`, `\\+`, `\\-`). Output `{n, group, groupName, scenario, resolution, severity}`; must yield exactly **140** rows or exit 1.
7. Generated files are **committed**. A unit test (§II-10) re-runs the extractor in a temp dir and asserts byte equality with the committed output, so a design edit without regeneration fails CI.

### II-2.4 TypeScript types (create in `src/content/guide/index.ts`)

```ts
export type Role = "GATEWAY_ADMIN"|"SECURITY_ADMIN"|"FINANCE"|"OPERATOR"|"COMPLIANCE"|"MLRO"|"SUPPORT";
export type UiStatus = "AVAILABLE"|"PARTIAL"|"NOT_YET";
export interface Book { id:string; title:string; audience:string; summary:string }
export interface Article { id:string; book:number; order:number; title:string; roles:"ALL"|Role[]; minutes:number;
  ui:UiStatus; related:string[]; body:string; headings:{id:string;text:string;level:number}[]; plainText:string }
export interface Term { slug:string; term:string; aliases:string[]; ar?:string; related:string[]; short:string }
export interface Card { id:string; title:string; screen:string; risk:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"; irreversible:boolean;
  body:string; checklist:string[] }
export interface Situation { id:string; title:string; screens:string[]; cases:number[]; articles:string[]; body:string }
export interface ContextScreen { screenId:string; routeNames:string[]; pageDir:string; summary:string; articles:string[]; cards:string[]; situations:string[] }
export interface EdgeCase { n:number; group:string; groupName:string; scenario:string; resolution:string; severity:"Low"|"Med"|"High" }
export const loadArticles: (lang:"en"|"ar") => Promise<Article[]>; // dynamic import(); falls back to en
```

### II-2.5 EXPECTED COUNTS (the content test asserts these)

| Item | Count | Source |
| :--- | :--- | :--- |
| Books | 14 | `@@book` blocks |
| Articles | 135 | `@@article` blocks |
| Glossary terms | 151 | `@@term` lines |
| Safeguard cards | 25 | `@@card` blocks (the 22 ids in §II-7 plus `sg-trigger-backup`, `sg-run-restore-drill`, `sg-update-backup-policy`) |
| Safeguard checklist items | 112 | lines `- [ ] ` inside cards |
| Situations | 32 | `@@situation` blocks |
| Reading paths | 8 | `@@path` lines (`ALL` plus the 7 staff roles) |
| Quick answers (FAQ) | 58 | `@@faq` blocks |
| Data blocks | 3 | `ledger-events` (16 events), `visible-rails` (7 vectors), `attempt-transitions` |
| Context map screens | 26 | `screens` array of `context-map` |
| Error codes (from b13-01) | 19 | first-column backticked tokens |
| Edge cases | 140 | parsed from the repository's v4 design file |

`meta.json.counts` must equal this table exactly. A change of content that changes a count is allowed only together with an update of this table in the same commit.

## II-3. Loading, routing, layout

* Content JSON is loaded with dynamic `import()` so it is not in the main bundle. Total gzip size of all generated JSON must stay below 400 KB (test asserts).
* Routes are added to the explicit `createRouter` table in `src/router/index.ts` (the project does not use file-based routing for admin). Names: `AdminGuide`, `AdminGuideBook`, `AdminGuideArticle`, `AdminGuideGlossary`, `AdminGuideTools`, `AdminGuidePlaybook`, `AdminGuideCards`, `AdminGuideEdgeCases`. They need **no** authority (`routesAuthorities` entry `[]`), because every admin must be able to read the guide.
* Layout of an article page (desktop ≥ 1280px): left = book outline (collapsible), centre = article (max width 820px, line-height 1.7, base font 16px), right = "On this page" TOC. Below 960px: single column, TOC becomes a collapsible panel at the top. The page must work in RTL and LTR (use logical CSS properties: `margin-inline-start`, etc.). Text diagrams stay LTR.
* Every article page shows: breadcrumb (Guide › Book › Article), reading time (`minutes`), "Recommended for" role chips, `UiStatusBanner` when `ui` is not `AVAILABLE`, content version + "Report a problem" (copies `article id + contentVersion + screen URL` to clipboard; no network), `ReadToggle` ("Mark as read", also auto-marks when the reader has scrolled to the end and spent ≥ 25% of `minutes` on the page), previous/next, and "Related" list.

## II-4. Glossary auto-linking and popovers

* Build a matcher from every term's `term` and `aliases` (case-insensitive, whole word, longest match first; Arabic and Latin boundaries handled with Unicode-aware lookarounds).
* When rendering an article body, wrap the **first occurrence per article** of each term in `<button class="gl-term" data-slug="...">`. Do **not** wrap inside headings, code, links, table header cells, callout titles, or the term's own glossary page.
* Click/Enter/Space opens a popover (`role="dialog"`, focus-trapped, Esc closes): term, `short` definition, Arabic term (if any), "Open in glossary", related terms. It never navigates away by itself. Hover alone must not be the only way to read the definition (touch/keyboard users).

## II-5. Search and command palette

* Index with `minisearch`: fields `title` (boost 5), `headings` (3), `aliases` (4), `plainText` (1); options `prefix:true`, `fuzzy:0.2`, `combineWith:"AND"` falling back to `"OR"` if zero results. Document types: `article`, `term`, `card`, `situation`, `edge-case`, `faq`, `error-code` (the codes in article b13-01).
* Normalise **both** index text and query: lowercase; strip Arabic diacritics and tatweel; unify alef variants (أ إ آ → ا), ya/alef-maqsura (ى → ي), ta-marbuta (ة → ه); convert Arabic-Indic digits to ASCII (reuse `src/utils/arabic.ts`). Underscores in codes are searchable with or without (`LIMIT_EXCEEDED`, `limit exceeded`).
* Results are grouped by type with the type name visible; max 8 per type; keyboard: ↑ ↓ Enter, Esc closes, Tab moves between groups. Empty query shows "Recent" (last 8 opened, stored in `localStorage` key `pg.guide.recent`, wrapped in try/catch) and the five most-read **Golden Rule** articles.
* The index is built lazily on first palette open (target < 150 ms for the full corpus; test measures the build and fails above 1000 ms on CI).
* Palette is global: mounted in `layouts/default.tsx`; shortcut Ctrl+K / Cmd+K; also a magnifier button in the app bar for touch users. It must not open while the user is typing in an input unless they press the shortcut explicitly.

## II-6. Contextual help (the "?" drawer)

* `PageHeader` renders `<ContextHelpButton/>` **automatically** (icon `mdi-help-circle-outline`, accessible name "How this page works") using the current route **name**. Pages never wire it by hand.
* The map `context-map.json` (from `@@map id=context-map`, §III-F.3) has `{ fallbackScreenId, screens: ContextScreen[] }` where `ContextScreen = { screenId, routeNames: string[], pageDir, summary, articles: string[], cards: string[], situations: string[] }`. A route name is looked up by `routeNames`; an unknown name uses the `fallbackScreenId` entry. `pageDir` is the source folder under `admin-front/src/` used by the verification procedure of Part 0 rule 5.
* Drawer (right side in LTR, left in RTL; non-modal; width 420px; does not unmount the page, form state is preserved): (1) **What this screen is for** (`summary`, 2–4 sentences), (2) **Before you act** — the cards for this screen, each collapsed with title + risk badge, (3) **Common problems** — situations, (4) **Learn more** — articles, (5) "Open the whole guide".
* Acceptance: a test enumerates every named route in `router/index.ts` except `Login` and `NotFound` and asserts the name appears in some screen's `routeNames`; adding a screen without an entry fails the build. **Route names in the map are best guesses made without access to the router.** In phase G-4, for every router name that is not listed, add it to the `routeNames` of the screen whose `pageDir` matches the page file that route renders (changing only that list), append the change to `design/07-guides-and-academy/guide_content_fixes.md`, and if no screen fits add it to `General`. Never invent summaries, articles or cards.

## II-7. Safeguard cards at the moment of action

A **card** is a short checklist for a risky action. Body of every card has exactly these four bold headings in this order: `**What this does**`, `**Check first**` (a list of `- [ ] ` items), `**Never**` (bullets), `**If you made a mistake**`.

* `useSafeguard(cardId)` returns `confirm(): Promise<boolean>`. It opens `SafeguardDialog` showing the four sections; every `Check first` item is a required checkbox; the **Continue** button is disabled until all are ticked; **Cancel** resolves `false`. Ticks are client-side only (nothing is stored or sent in v1) and reset every time.
* Integrate (call `await confirm()` immediately before the existing request) at these action points. Find them by the UI label shown; if a label is not found, record a question per rule 5 and continue.

| Card id | Screen file | Action label to guard |
| :--- | :--- | :--- |
| `sg-approve-request` | `pages/approvals` | **Approve** |
| `sg-reject-request` | `pages/approvals` | **Reject** |
| `sg-propose-adjustment` | `pages/adjustments` | **Propose** |
| `sg-reverse-adjustment` | `pages/adjustments` | **Reverse** |
| `sg-process-cashout` | `pages/cashouts` | **Process**, **Approve and execute** |
| `sg-reject-cashout` | `pages/cashouts` | **Reject and release** |
| `sg-resolve-unknown` | `pages/operator-cases` | resolution **Mark succeeded** / **Mark failed** |
| `sg-release-reservation` | `pages/operator-cases` | resolution **Release reservation** |
| `sg-bulk-inquiry` | `pages/operator-cases` | **Bulk Inquiry** |
| `sg-approve-join-request` | `pages/join-requests` | **Approve** |
| `sg-reject-join-request` | `pages/join-requests` | **Reject** |
| `sg-suspend-merchant` | `pages/merchants` | **Suspend Merchant** |
| `sg-reinstate-merchant` | `pages/merchants` | **Reinstate Merchant** |
| `sg-edit-merchant-sensitive` | `pages/merchants` | **Submit For Approval** |
| `sg-aml-propose-resolution` | `pages/aml/cases` | **Propose** |
| `sg-aml-disposition` | `pages/aml/screenings` | **Disposition** → **Save** |
| `sg-aml-rule-change` | `pages/aml/rules` | **Create** / **Save** |
| `sg-aml-report` | `pages/aml/reports` | **Create** / **Save** |
| `sg-submit-gateway-version` | `components/gateway-wizard` + wizard page | Step 8 submit for approval |
| `sg-edit-route` | `pages/routes` | **Save** / **Create** |
| `sg-ai-import-draft` | `pages/gateways/ai-import` | creating the draft |
| `sg-run-reconciliation` | `pages/reconciliation` | **Run File** |
| `sg-trigger-backup` | `pages/system/backups` | **Run backup now** (card content only; the confirmation guard is not wired into the page yet) |
| `sg-run-restore-drill` | `pages/system/backups` | **Run restore drill** (card content only; not wired yet) |
| `sg-update-backup-policy` | `pages/system/backups` | **Save Changes** in **Edit backup policy** (card content only; not wired yet) |

If the existing code uses a different mechanism (`AwaitedConfirmationDialog`), call `confirm()` first and keep the existing dialog afterwards. Never remove an existing confirmation.

## II-8. Internationalisation

* UI chrome strings (buttons, headings of guide pages) go through the existing locale system with English and Arabic entries; add both. Keep Arabic UI strings short and conventional.
* Content: `loadArticles("ar")` tries `articles.ar.json`; if missing, returns English and the reader shows a chip "Arabic version pending" (and `lang="en" dir="ltr"` on the article container so English renders correctly inside an RTL page).
* The `ar=` attribute of glossary terms is displayed in popovers and glossary page in both languages; it is the **mandatory** Arabic rendering when the Arabic content is produced later.

## II-9. Backend changes (minimal)

The Guide itself has no backend. Read-tracking reuses the Academy progress record (Academy file §A-3). The Guide requires only that Academy phase A-1 is done. **No schema/migration change** is needed (the progress column is JSON).

## II-10. Tests (create all)

**Unit (`tests/unit`, Vitest):**
* `guide-content.test.ts`: re-runs the extractor to a temp directory and compares to committed output; asserts EXPECTED COUNTS; asserts every `related`/link resolves; asserts no article has an empty body; asserts no `http://`/`https://` in any article; asserts glossary slugs unique; asserts every card has a non-empty `checklist`; asserts every route name in the router (except `Login`, `NotFound`) has a context-map entry; asserts every card id in §II-7 exists; asserts every `{{widget:...}}` id is implemented; asserts total gzip size < 400 KB.
* `guide-search.test.ts`: queries `UNKNOWN`, `unknown`, `limit exceeded`, `LIMIT_EXCEEDED`, `maker checker`, `ledger`, `HMAC`, `الدفع` (no crash), `٠٩١` (digits normalised) and asserts expected top-3 article/term types; asserts index build < 1000 ms.
* `guide-widgets.test.ts`: all vectors in §II-5.1 to §II-5.4 (below) must match exactly.

**E2E (`tests/e2e/admin`, Playwright):**
* `guide-reader.spec.ts`: open `/guide`; search "unknown"; open an article; glossary popover opens by keyboard; mark as read; reload; read state persisted; no horizontal overflow at 360px and 1280px; Arabic RTL screenshot has no overlap.
* `guide-palette.spec.ts`: Ctrl+K opens, type, Enter navigates, Esc closes, focus returns.
* `guide-context.spec.ts`: for each of the 5 routes `Approvals`, `OperatorCases`, `Cashouts`, `GatewayWizard`, `AmlCases` (log in as a role that can open it), the "?" drawer opens, shows ≥ 1 card, and form input typed before opening is still there after closing.
* `guide-safeguard.spec.ts`: on `Approvals`, clicking **Approve** opens the safeguard dialog; **Continue** is disabled until all boxes are ticked; Cancel makes **no** request (assert via route interception).

## II-11. Quality bars

* Lighthouse a11y ≥ 95 on `/guide` and an article page; all interactive elements reachable by keyboard; popover/drawer/dialog focus management correct; contrast ≥ AA in both themes.
* First article render < 500 ms after route enter on a mid laptop (content is lazy-loaded; show a skeleton, never a blank page).
* The page never scales `#app` and never overflows horizontally.

## II-12. Phased task list for OpenCode (tick only after verification)

* [ ] **G-0 Pipeline.** Write `extract-guide-content.ts`, add `content:guide`, generate JSON, add `guide-content.test.ts`. *Verify:* `cd admin-front && bun run content:guide && cd ../tests && bun run test:unit -- guide-content`.
* [ ] **G-1 Reader.** Router entries, pages `index/book/article/glossary/cards/playbook/edge-cases`, `MarkdownView` (callouts, widget placeholders, diagrams, TOC), glossary auto-link + popover, `UiStatusBanner`, reading paths, `StuckPanel`. *Verify:* build + `guide-reader.spec.ts`.
* [ ] **G-2 Search.** `GuideSearch`, palette, global shortcut. *Verify:* `guide-search.test.ts`, `guide-palette.spec.ts`.
* [ ] **G-3 Simulators.** Five widgets + engines + `tools` page. *Verify:* `guide-widgets.test.ts`.
* [ ] **G-4 Context help + safeguards.** `ContextHelpButton/Drawer`, `PageHeader` integration, `useSafeguard` + dialog + the 22 integrations in §II-7. *Verify:* `guide-context.spec.ts`, `guide-safeguard.spec.ts`, the route-coverage unit test.
* [ ] **G-5 Progress.** After Academy phase A-1: `ReadToggle` persists to the progress record (`guideRead`), "Continue reading", per-book progress rings, graceful offline fallback to `localStorage` key `pg.guide.read`. *Verify:* `guide-reader.spec.ts` read-persistence step.
* [ ] **G-6 Cleanup & audit.** Delete old `content.ts`; run the verification procedure of Part 0 rule 5 over all screens; fill `guide_content_fixes.md` / `guide_content_questions.md`; full test run; update `design/90-archive/delivery-logs/opencode_technical_delivery_design.md` §17 with a short note "Guide v1.0 replaced by design/07-guides-and-academy/guide_system_design_and_content.md".

## II-13. Simulator specifications and test vectors

All simulators: client-only, deterministic, keyboard accessible, a **Reset** button, an **Explain this result** panel that narrates each step in plain language, bilingual UI labels, `decimal.js` for money. They must visibly state "Teaching tool — not connected to any real system."

### II-13.1 `transform-sandbox` (Transform pipeline)

Input: a JSON/text sample and an ordered list of operations from the **closed library**: `scale(factor)`, `div_decimal(divisor,places)`, `round(mode)`, `format_decimal(places)`, `to_int`, `to_number`, `to_string`, `concat(text)`, `lowercase`, `uppercase`, `trim`, `pad_left(length,char)`, `pad_right(length,char)`, `substring(start,end)`, `mask(visible_start,visible_end)`, `arabic_digits_to_ascii`, `phone_normalize(style: LOCAL_09|INTL_218|E164)`, `base64_encode`, `hex_lower`, `hex_upper`, `url_encode`, `json_encode`, `xml_escape`, `sha256`. It shows the value after every operation. Money operations use `Decimal` with `ROUND_HALF_UP` for `NEAREST`, `ROUND_UP` for `UP`, `ROUND_DOWN` for `DOWN`. Unknown operation → inline error, never a thrown exception.

Test vectors (input → pipeline → expected output):

| # | Input | Pipeline | Expected |
| :-- | :--- | :--- | :--- |
| T1 | `10.50` | `scale(1000) → to_int → to_string` | `10500` |
| T2 | `76.255` | `format_decimal(2)` with `round(NEAREST)` first | `76.26` |
| T3 | `76.255` | `round(DOWN)` to 2 places then `format_decimal(2)` | `76.25` |
| T4 | `٠٩١٢٣٤٥٦٧٨` | `arabic_digits_to_ascii` | `0912345678` |
| T5 | `+218912345678` | `phone_normalize(LOCAL_09)` | `0912345678` |
| T6 | `0912345678` | `phone_normalize(INTL_218)` | `218912345678` |
| T7 | `0912345678` | `phone_normalize(E164)` | `+218912345678` |
| T8 | `0912345678` | `mask(3,2)` | `091*****78` |
| T9 | `5` | `pad_left(10,"0")` | `0000000005` |
| T10 | `a&b<c` | `xml_escape` | `a&amp;b&lt;c` |
| T11 | `MID=1&TID=2&Amt=10500` | `sha256` → `hex_lower` | `c88bf5122e21ae0d4276e271860775a2ea936ea8ea657f057c29188a921f24d0` |
| T12 | `0.001` | `scale(1000) → to_int` | `1` |

### II-13.2 `crypto-lab` (Signature lab)

Modes: `SORTED_KEY_VALUE_AMP`, `SORTED_VALUES_HASH`, `TIMESTAMP_DOT_RAW_BODY`, `RAW_BODY`. Key encodings `UTF8|HEX|BASE64`; output encodings `HEX_LOWER|HEX_UPPER|BASE64`. Uses `crypto.subtle` HMAC-SHA256. Shows, in order: (1) the fields, (2) the **exact canonical string** that will be hashed (visible characters, with a toggle to reveal invisible characters), (3) the key as bytes length (never the key text after the first 4 characters when the "mask" option is on), (4) the output. Provide "Compare with partner's signature" input that says **MATCH / NO MATCH** and, on NO MATCH, lists the three most common causes (wrong key encoding, wrong field order or inclusion, wrong output case).

Vectors (HMAC-SHA256):

| # | Mode | Key (encoding) | Input | Canonical string | Output encoding | Expected |
| :-- | :--- | :--- | :--- | :--- | :--- | :--- |
| C1 | `SORTED_KEY_VALUE_AMP` | `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` (HEX) | `MerchantReference=1234567890, AmountTrxn=10500, MerchantId=10081014649, TerminalId=99179395, DateTimeLocalTrxn=202610311030` | `AmountTrxn=10500&DateTimeLocalTrxn=202610311030&MerchantId=10081014649&MerchantReference=1234567890&TerminalId=99179395` | `HEX_UPPER` | `8694D44C6AADF96FD26CAEDC8D491DF1D230E2E87B104C8E5F59D0AE8103D7A7` |
| C1b | same as C1 | same | same | same | `HEX_LOWER` | `8694d44c6aadf96fd26caedc8d491df1d230e2e87b104c8e5f59d0ae8103d7a7` |
| C2 | `TIMESTAMP_DOT_RAW_BODY` | `whsec_teaching_key` (UTF8) | timestamp `1761900000`, body `{"event":"payment.completed","id":"evt_001","amount":"100.00"}` | `1761900000.{"event":"payment.completed","id":"evt_001","amount":"100.00"}` | `HEX_LOWER` | `964e8b23d675fe23f4809bdea2b940c058c084ba9bbfacfea21ee6bfba1c56e5` |
| C3 | `SORTED_VALUES_HASH` | `teaching_secret` (UTF8) | `transaction_id=T1001, amount=10.50, status=approved` | `10.50approvedT1001` (values concatenated in alphabetical order of key) | `HEX_UPPER` | `463780F6809FB37551F390521DA47A570F82D68FBB5CD63F1B1B853487CD61CD` |
| C4 | `RAW_BODY` | `teaching_secret` (UTF8) | body `{"status":"paid","ref":"R-77"}` | the body bytes exactly | `BASE64` | `X67eZeei+tBYGebSBABV3f26mTgmmAP+6cRan61vTpM=` |

These are *teaching* vectors (field names borrowed from public partner styles); the tool must label them "example data, not a real partner's contract".

### II-13.3 `ledger-explorer` (T-accounts)

Data: the 16 events in `@@data id=ledger-events` (§III-F.1). Inputs: link amount `A` (default `100`), commission rate `rate` percent (default `3`), gateway fee `fee` (default `0.8`), provider fee `provFee` (default `1`), surcharge `sur` (default = commission when the event says so), wallet start balance (event 15 only, default `40`). Derived: `comm = round4(A × rate / 100)` (ROUND_HALF_UP). Amount expressions are `IDENT ((+|-) IDENT)*` over the variable names (`A, comm, fee, provFee, sur, net, var, hold, walletStart`); evaluate with a tiny tokenizer + `Decimal`, **no eval**. Show each journal entry as two columns (Debit | Credit) per GL account, with totals and a green **Balanced** / red **NOT BALANCED** badge (Σdebit == Σcredit to 4 decimals), plus a running check of the system-wide equation using the account classes in the data file. Include an "Explain" sentence per line (`why` field). Each event contains one or more `entries` (separately balanced journal entries, for example confirmation then release); show each, then the cumulative equation after the whole event. `derived` formulas are evaluated in order; `sur` defaults to the computed `comm`; `showBalance` (event E15) adds one extra displayed line. Default-value expectation: every event balances; the equation holds after each event starting from zero balances. Vector: event `E02` with defaults must produce debits `GATEWAY_CLEARING 100.0000`, `GATEWAY_FEE_EXPENSE 0.8000`; credits `MERCHANT_WALLET 97.0000`, `PLATFORM_INCOME 3.0000`, `GATEWAY_FEE_ACCRUAL 0.8000`; totals `100.8000` each.

### II-13.4 `visible-rails` and `attempt-states`

* `visible-rails`: implements the 9-predicate resolution from the data block `visible-rails` (§III-F.2). The user changes link amount, currency, the application's rail whitelist, time of day, and each sample route's status/health/limits. For each rail the tool shows **Visible** or **Hidden because:** followed by the first failing predicate in plain language. Vectors in the data block (`vectors` array) must pass.
* `attempt-states`: implements the teaching transition table in `@@data id=attempt-transitions`. The user clicks events (e.g., "Customer enters wrong OTP", "Gateway times out on confirm"; an event with `to:"SAME"` leaves the state unchanged and only shows its note); the tool shows the new state, whether the link slot is still reserved, whether money was posted, and what a human should do. States not reachable by an event are disabled. The tool states: "Teaching model — the real engine in `core-back` is authoritative."

---

<!-- CONTENT_VERSION: 1.0.0 -->
<!-- CONTENT:BEGIN -->

# PART III — THE CONTENT

*(Everything between `<!-- CONTENT:BEGIN -->` and `<!-- CONTENT:END -->` is parsed by the extractor. Do not add other `@@` lines. Headings inside articles are deliberately `###`.)*

## III-A. Books and articles

@@book id=0 title="Start Here" audience="Everyone, on day one" summary="What this system is, how to use this guide, and the ten rules that protect money and people."
@@book id=1 title="Foundations from Zero" audience="Anyone with no payments, accounting, compliance or software background" summary="Plain-language meaning of every basic idea the rest of the guide builds on."
@@book id=2 title="The Platform Map" audience="Everyone" summary="The whole system on one page: who uses it, which parts exist, why they are separated, and the life of a payment and of a merchant."
@@book id=3 title="Working in the Back Office" audience="Every staff member" summary="Signing in, understanding your role, reading screens safely, and working in a way that prevents mistakes."
@@book id=4 title="Governance: Four Eyes" audience="Every staff member; essential for makers and checkers" summary="Why two people must agree, which changes need approval, and how to write a decision that can be audited."
@@book id=5 title="Merchants" audience="Operators, compliance, support" summary="How a business joins, is checked, is configured, is supported, and is suspended."
@@book id=6 title="Gateways, Rails & the Engine" audience="Gateway admins, security admins, operators who need to understand failures" summary="How a payment partner is plugged in without writing code, and how it is kept safe."
@@book id=7 title="Payments in Operation" audience="Operators, support, finance" summary="What happens to a payment from start to finish, and how to handle the ones that do not finish."
@@book id=8 title="Money & the Ledger" audience="Finance; everyone who handles money screens" summary="Double-entry bookkeeping from zero, every account, every worked entry, settlement, refunds and disputes."
@@book id=9 title="Risk, AML & Compliance" audience="Compliance, MLRO; essential awareness for all" summary="Anti-money-laundering in plain language, the cases we handle, and what we must never say."
@@book id=10 title="When Things Go Wrong" audience="Operators, finance, gateway and security admins" summary="Calm, step-by-step procedures for outages, stuck payments, drift and attacks."
@@book id=11 title="Security for Everyone" audience="Every staff member" summary="How attackers think, what protects us, and what you must never do."
@@book id=12 title="Deployment & Hosting" audience="Security admins, gateway admins, engineers" summary="Where each part runs, how servers are protected, how releases are made and undone."
@@book id=13 title="Reference" audience="Everyone, when looking something up" summary="Statuses, codes, roles, gates, situations and quick answers."

### BOOK 0 — START HERE

@@article id=b00-01 book=0 order=1 title="Welcome: what this system is and why this guide exists" roles=ALL minutes=2 ui=AVAILABLE related=b00-02,b00-03,b02-01
### In one sentence
This platform lets shops and businesses in Libya accept payments from many different payment methods through one single system, and keeps exact, auditable records of every dinar that moves.

### What the platform does
A customer wants to pay a shop. The customer might use a mobile wallet, a bank app, a card, or a code sent by SMS. Each of those is run by a different company with different technical rules. The platform sits in the middle: the shop connects once to us, and we connect to all the others. The customer sees a simple payment page. Behind it, our system talks to the right payment company, waits for a trustworthy answer, and then writes the money movement into our books.

### Why a guide this long?
Because the work is serious. The people reading this may be new to payments, to accounting, to compliance or to software. A wrong click can pay the wrong person, release held money, or tell a suspect that we are investigating them. This guide exists so that **nobody has to guess**.

### What you will find
* **Books 1–2** explain the world from zero: payments, computers, trust, money records, compliance, and the parts of our platform.
* **Books 3–5** teach you how to work in the Back Office, how approvals work, and how merchants are handled.
* **Books 6–9** go deep: gateways, payments, the ledger (our accounting books), and anti-money-laundering.
* **Books 10–12** are for emergencies, security and hosting.
* **Book 13** is a reference: tables, codes, a symptom playbook and quick answers.

:::tip How to start
If today is your first day, read Book 0 and Book 1 in order. They take about two hours and make everything else easier. Then follow the reading path for your role (button on the guide home page).
:::
@@end

@@article id=b00-02 book=0 order=2 title="How to use this guide" roles=ALL minutes=2 ui=AVAILABLE related=b00-01,b13-04
### The five ways to find things
1. **Search everywhere.** Press **Ctrl+K** (Mac: **Cmd+K**) on any screen. Type a word, an error code such as `UNKNOWN`, or a symptom such as "money deducted". Results are grouped: articles, glossary terms, checklists, situations, edge cases.
2. **The "?" button.** At the top of every screen there is a round **?** button. It opens a side panel that explains the screen you are on, lists the checklists for the risky buttons on it, and links to the right chapters. The page behind it is not reset, so you will not lose what you typed.
3. **Dotted-underlined words.** Any word with a dotted underline is a defined term. Click it to see a short meaning and a link to the glossary. Each term is underlined only the first time it appears in an article.
4. **"I'm stuck".** On the guide home page, pick what you are seeing (for example "a payment is stuck in UNKNOWN"). You get the situation card with what is happening and what to do.
5. **Books.** Read in order when you are learning.

### Safety checklists before risky buttons
When you press a risky button (approving a refund, releasing money, going live with a gateway) a checklist appears first. Tick each box honestly. The ticks are not recorded anywhere; they exist to slow you down for ten seconds at the moment mistakes happen.

### Marking progress
Each article has a **Mark as read** switch. Your progress feeds the Employee Academy. Articles you read are remembered; if an article changes in a major way you will be asked to read it again.

### If something here is wrong
Every article has **Report a problem**. It copies a short note (article and version) to your clipboard. Paste it to your manager or the person who maintains this guide. Never guess: if the guide and the screen disagree, stop and ask.
@@end

@@article id=b00-03 book=0 order=3 title="The Ten Golden Rules" roles=ALL minutes=3 ui=AVAILABLE related=b04-01,b07-03,b09-08,b11-03
Every rule here exists because someone, somewhere, lost money or trust by breaking it. Read them until you can say them without looking.

1. **Never share your password, your one-time codes, or your session.** Not with your manager, not with IT, not with "support". Nobody legitimate will ever ask.
2. **Never approve something you cannot explain in one sentence.** If you do not understand what the request will change, reject it with a reason or ask the person who made it.
3. **Never approve your own work, and never help someone get around the two-person rule.** The system blocks the same account from approving its own request. Asking a colleague to click "Approve" without reading is the same offence.
4. **Amounts come only from the system.** Never take an amount from a customer's message, screenshot, phone call or email. The platform reads the amount from the payment link in its own database.
5. **A page saying "Paid" proves nothing.** Customers' screens, return links and browser messages can be faked. Only a payment that our server has verified with the payment company counts. Never tell a customer "your payment is confirmed" from a screenshot.
6. **`UNKNOWN` means we do not know. Never guess.** Do not mark it failed because it is old. Do not ask the customer to pay again. Do not re-send an OTP. Use **Inquire**, then follow Book 7.
7. **Never reveal or hint that an anti-money-laundering review exists.** Not to a merchant, not to a customer, not to a colleague who has no need to know. This is called *tipping-off* and it can be a crime.
8. **Never paste secrets anywhere.** API keys, tokens, passwords, certificate keys, card numbers, OTPs do not belong in chat, email, tickets, screenshots or this guide.
9. **Always write a real reason.** "ok" or "as discussed" is not a reason. A good reason says what you checked and why you decided (Book 4, article on reasons).
10. **When unsure, stop and escalate.** Being slow is acceptable. Being wrong with other people's money is not. Never "fix" books by editing numbers; corrections are new, approved entries.

:::danger Rules 1, 6 and 7 are the most common serious breaches
If you remember nothing else: do not share credentials, do not guess on `UNKNOWN`, do not tip off.
:::
@@end

@@article id=b00-04 book=0 order=4 title="Your first week: a suggested plan" roles=ALL minutes=2 ui=AVAILABLE related=b00-02
| Day | Do this | Why |
| :--- | :--- | :--- |
| 1 | Read Books 0 and 1. Open the glossary and read ten terms you did not know. | Vocabulary makes everything else faster. |
| 2 | Read Book 2 (the map) and Book 3 (the Back Office). Sign in with MFA and open every screen in your menu, without changing anything. | See what is real before you act. |
| 3 | Read Book 4 (Governance). Do Academy modules 1–4. | You must understand the two-person rule before you touch anything. |
| 4 | Read the books for your role (see **Reading paths**). Use the simulators in **Tools**. | Learn by trying safely. |
| 5 | Read Book 10 (When things go wrong) and the Playbook. Do the Academy labs for your track. | You will meet an incident sooner than you expect. |
| Week 2 | Sit with a colleague while they work. Do the Academy final exam for your track. | Certification before real authority. |

:::note Before you receive maker or checker rights
Management may require your Academy certificate before your account is switched on as a maker or checker. See the Employee Academy.
:::
@@end

### BOOK 1 — FOUNDATIONS FROM ZERO

@@article id=b01-01 book=1 order=1 title="What a payment really is" roles=ALL minutes=2 ui=AVAILABLE related=b01-02,b01-05
### The simplest case: cash
When you buy bread with cash, value moves from your hand to the baker's hand. There is nobody in the middle. Both people can see it happened.

### Electronic payments add a record-keeper
When the payment is electronic, no cash moves. Instead some institution (a bank, a mobile-wallet company, a telecom operator) lowers a number in the payer's account and raises a number in the receiver's account. A payment is therefore **a change of numbers that a trusted record-keeper agrees to**.

### The people and companies involved
* **Payer** (also called customer, buyer, *end client*): the person paying.
* **Merchant**: the business being paid. A shop, a school, a clinic.
* **Payer's institution**: where the payer's money lives (a bank, a wallet, a telecom account).
* **Payment company** (switch, gateway, wallet operator): the company that can tell the payer's institution "move this much".
* **Us, the platform**: we connect merchants to many payment companies and keep our own exact record of what happened.
* **The regulator**: in Libya the **Central Bank of Libya (CBL)** sets rules for payments and reporting.

### Libyan money in this system
The currency is the Libyan dinar, written **LYD**. One dinar has 1000 dirhams, so amounts have **three decimal places**: `10.500` LYD is ten dinars and five hundred dirhams. Some payment companies use only two decimals (`10.50`), and some want the amount in dirhams (`10500`). Mixing these up makes an amount **1000 times too big or too small**. This is one of the most dangerous mistakes in payments (see Book 6, amounts).

:::example A small story
Layla buys a phone case for 25.500 LYD from an online shop. She chooses "Sadad" on the payment page, types her mobile number, receives an SMS code, types it, and sees "Paid". Behind the scenes: our platform asked the Sadad company to take 25.500 from Layla's account, waited for a verified answer, then wrote it into our books: the shop's balance on our system goes up, our commission is recorded, and everything balances.
:::
@@end

@@article id=b01-02 book=1 order=2 title="Ways people pay (the nine ways the platform supports)" roles=ALL minutes=2 ui=AVAILABLE related=b06-02
The platform calls the way a customer completes a payment a **collection mode**. There are nine:

| Mode | In everyday words | Example |
| :--- | :--- | :--- |
| `OTP_PULL` | We ask the payment company to text the customer a code; the customer types it on our page. | Sadad, Edfali, MobiCash |
| `REDIRECT` | We send the customer to the payment company's own page to pay, and they come back. | MyPay, T-LYNC, 3-D Secure card pages |
| `EMBEDDED` | The payment company's small window opens on top of our page. | Moamalat card lightbox |
| `PUSH_APPROVAL` | The customer gets a notification in their wallet app and taps Approve. | NeomPay, Hawelli, GPay |
| `QR_DISPLAY` | We show a QR code; the customer scans it with their bank or wallet app. | OnePay, LYPay |
| `PAY_CODE` | We show a short code; the customer enters it in their app or sends it by SMS. | Yussor Pay code |
| `DEEP_LINK` | A button opens the customer's wallet app with the payment ready. | wallet apps on phones |
| `MANUAL` | The customer transfers money by bank transfer or at an agent; a person confirms it. | bank transfer |
| `HYBRID` | One method offering several of the above; the customer chooses. | Yussor Pay, Sahara Pay, NeomPay |

:::note
Knowing the mode tells you what the customer is doing and what could go wrong. For example a customer can close the browser during `REDIRECT`, and the payment can still succeed. Book 6 explains each mode's traps.
:::
@@end

@@article id=b01-03 book=1 order=3 title="Switches, gateways and aggregators: who connects to whom" roles=ALL minutes=2 ui=AVAILABLE related=b02-06,b06-15
### Switch
A **switch** is a shared network that connects many banks and wallets so they can pay each other. In Libya, the national switch for cards is operated by Moamalat.

### Gateway
A **gateway** is *one technical door* to *one payment company*. "Connecting to Sadad" means building and configuring the door to Sadad: its web addresses, how we prove who we are, what data it wants, how it answers.

### Aggregator
An **aggregator** is a company that offers *one door to many payment methods*. DPay, Plutu and MyPay are aggregators. Using one is faster to start (one contract) but adds one more company between us and the money, one more fee, and one more thing that can fail.

### Direct versus aggregator
| | Direct gateway | Aggregator |
| :--- | :--- | :--- |
| Contracts | One per payment company | One for many |
| Money path | Fewer companies | An extra company in the chain |
| If it fails | Only that rail is affected | Everything behind it can be affected |

In our platform both are just **routes** to the same customer-facing method, so Operations can switch between them without changing a single merchant link. That is why the platform separates the *door* (gateway) from the *button the customer sees* (rail) — see [[a:b02-06|The four layers]].
@@end

@@article id=b01-04 book=1 order=4 title="Merchants, applications, wallets, payment links and POS" roles=ALL minutes=2 ui=AVAILABLE related=b05-06,b05-07
These five words describe how a business uses the platform. Learn their relationships, because many mistakes come from mixing them up.

```diagram
Merchant (the business)
  ├── Wallets      (where its money balance lives on our books)
  ├── Applications (one per website/app/shop channel)
  │      ├── is linked to EXACTLY ONE wallet
  │      ├── Payment links (a request to pay one amount)
  │      ├── POS terminals → POS screens (in-store displays)
  │      └── Access tokens (keys for the merchant's own software)
  └── Users        (owners, staff, cashiers)
```

* **Merchant**: the legal business we onboarded and verified.
* **Wallet**: the merchant's balance **on our platform**. It is not a bank account; it is a number on our books that we owe the merchant. The merchant can request a **cash-out** to receive that money in its real bank account.
* **Application**: one place where the merchant takes payments (a website, an app, a branch). Each application is tied to exactly one wallet, so a payment can never be ambiguous about where its money goes.
* **Payment link**: a request to pay a specific amount, with a unique key. **Single-use** links can be paid once; **multi-use** links can be paid many times.
* **POS**: "point of sale", the in-shop counter. A POS **terminal** is the place; a POS **screen** is a display paired to it that shows the current payment in real time.
* **Access token**: a secret key (it starts with `pg_live_`) that lets the merchant's own software create links through our API. It is shown once and never again.
@@end

@@article id=b01-05 book=1 order=5 title="Fees, commission and who pays" roles=ALL minutes=2 ui=AVAILABLE related=b08-03
Two different fees exist and they are easy to confuse:

* **Commission** (or *platform commission*): what **we** charge the merchant for using the platform. It is our revenue.
* **Gateway fee** (or *provider fee*): what the **payment company charges us**. It is our cost.

We keep **net revenue = commission − gateway fee**.

### Who bears the commission? (the "fee bearer")
For each payment, the rules say who effectively pays our commission. Example: a link for **100.000 LYD**, commission **3.000 LYD**, gateway fee **0.800 LYD**:

| Fee bearer | Customer pays | Merchant is credited | Our commission | Our net after gateway fee |
| :--- | :--- | :--- | :--- | :--- |
| `MERCHANT_ABSORBS` (default) | 100.000 | 97.000 | 3.000 | 2.200 |
| `PAYER_SURCHARGE` | 103.000 | 100.000 | 3.000 | 2.200 |
| `SPLIT` (50/50) | 101.500 | 98.500 | 3.000 | 2.200 |

:::warning The customer must see the surcharge before confirming
With `PAYER_SURCHARGE` or `SPLIT` the payment page must show the added fee before the customer confirms. If a customer says they were charged more than they expected, check the fee bearer of that payment first.
:::
@@end

@@article id=b01-06 book=1 order=6 title="How computers talk: servers, requests, APIs, webhooks" roles=ALL minutes=2 ui=AVAILABLE related=b06-03,b07-05
You do not need to be a programmer, but you must understand these ideas to understand why a payment can be "uncertain".

### Server
A **server** is a computer that waits for requests and answers them. Our platform is several servers (Book 2).

### Request and response
Think of a restaurant. The waiter (our system) tells the kitchen (the payment company) "one coffee for table 5". That is a **request**. The kitchen replies "ok, coming" or "we have no coffee". That is the **response**.

### API
An **API** is the menu and the rules for ordering: which requests the kitchen accepts and what answers it gives. Each payment company publishes its own API.

### Status codes
Responses carry a number. `200` means OK. Numbers in the `400`s mean "you asked wrongly". Numbers in the `500`s mean "we broke". `429` means "you are asking too fast".

### Timeout: the dangerous silence
Sometimes nothing comes back. Maybe the request never arrived. Maybe it arrived, the money moved, and only the reply was lost. **From our side the two look identical.** That is why a silence on a money step becomes `UNKNOWN` and is never retried blindly.

### Webhook
A **webhook** is the kitchen phoning *us* when the order is ready, instead of us asking. Payment companies send webhooks to say "this payment succeeded". Because anyone could phone us pretending to be them, we verify every webhook (next article).

### Polling and inquiry
**Polling** is us asking again and again "is it ready?". An **inquiry** is one such question about one payment. Inquiry is the safest way to learn the truth.

### Idempotency
A request is **idempotent** if sending it twice has the same effect as sending it once. "Set the temperature to 20" is idempotent; "add one degree" is not. Money requests must never be repeated unless the partner guarantees idempotency.

### JSON
**JSON** is the text format most APIs use: `{ "amount": "10.50", "status": "ok" }`. A **selector** like `result.transaction_id` is a path that picks one value out of it.
@@end

@@article id=b01-07 book=1 order=7 title="Secrets and trust: passwords, tokens, MFA, encryption, signatures, certificates" roles=ALL minutes=2 ui=AVAILABLE related=b11-02,b11-03,b06-06
### Passwords and MFA
A **password** proves you know something. **MFA** (multi-factor authentication) adds a second proof, usually a six-digit code sent by SMS to the phone number registered on your account. Both are required for every admin here.

### One-time code (OTP)
An **OTP** is a code valid once for a short time. Customers get OTPs by SMS to confirm a payment. Staff receive their MFA code by SMS as well.

### Token and API key
A **token** or **API key** is a long secret string that lets a program prove who it is. It is a password for software. Anyone who has it can act as that program.

### Encryption
**Encryption** locks data so that only someone with the key can read it. Everything secret we store (partner passwords, national IDs) is encrypted. Stored secrets are **write-only**: you can replace them but never read them back, not even as an administrator.

### Hash
A **hash** is a fingerprint of data. The same data always gives the same fingerprint; a tiny change gives a completely different one; you cannot go backwards from the fingerprint to the data. We use hashes to detect duplicate documents.

### Signature (HMAC)
A **signature** proves a message really came from someone who knows a shared secret and was not altered. Imagine a wax seal pressed with a stamp only the sender owns. An **HMAC** is the common digital version: both sides know a secret key; the sender computes a seal over the message; the receiver recomputes it and compares. If even one character differs (a different field order, upper-case instead of lower-case) the seals do not match. Many "payment confirmed" failures are really "the seal was computed slightly differently". The **Crypto Lab** in Tools lets you see this.

### Certificate and mTLS
A **certificate** is a digital ID card issued by an authority we trust. In ordinary web browsing only the *server* shows its ID. In **mutual TLS (mTLS)** *both* sides show an ID. Our internal services use mTLS so that only our own services can talk to the core, even inside our own network.

### Key rotation
Changing a secret on a schedule, or immediately after a leak, is **rotation**. The system supports an overlap where old and new secrets both work briefly so that nothing breaks.
@@end

@@article id=b01-08 book=1 order=8 title="Sandbox versus Live: test money and real money" roles=ALL minutes=1 ui=AVAILABLE related=b06-10,b12-06
Every payment company gives us two worlds:

* **SANDBOX**: a practice world. Nothing real moves. Used to build and test.
* **LIVE**: the real world. Real money, real customers, real consequences.

The two worlds have **different** web addresses, **different** secrets and **different** webhook addresses. The platform keeps them completely separate: a sandbox payment can never be posted to the real books, and a sandbox webhook sent to the live address is rejected and raises an alert.

:::warning Always check the badge
Before you act on any payment, case or gateway screen, check whether it says `SANDBOX` or `LIVE`. Acting on live data believing it is practice (or the reverse) is a classic mistake. Never use real customer data in sandbox.
:::

A merchant who has not yet been approved may use the sandbox only. A **Fake Rails** testing service exists for internal drills; it must never run in production (Book 12).
@@end

@@article id=b01-09 book=1 order=9 title="Why we write money down twice (a first look)" roles=ALL minutes=1 ui=AVAILABLE related=b08-01
Suppose Ali gives Sara 10 LYD. A careless notebook might say "Sara +10". But where did the 10 come from? If you only write one side, you cannot tell whether you are missing something.

**Double-entry bookkeeping** writes *both sides* of every movement: "Ali −10 **and** Sara +10". The two sides always add up to zero. If they ever do not, you know instantly that a mistake exists and roughly where.

Our platform does this for every payment, refund, cash-out and fee. We call the notebook the **ledger**. Each page is a **journal entry**, each line is a **journal line**, and each account (for example "Treasury" or "Merchant wallet") is a **GL account**. The key promise: **in every journal entry, total debits equal total credits**. Entries are never edited or deleted; mistakes are fixed by adding new, approved entries.

Book 8 teaches this fully with every account and 15 worked examples. For now remember: **if numbers on our screens do not balance, stop and escalate**.
@@end

@@article id=b01-10 book=1 order=10 title="Rules about risky money: KYB, AML, sanctions, PEPs, regulators" roles=ALL minutes=2 ui=AVAILABLE related=b09-01,b05-04
* **KYB** (Know Your Business): checking that a business really exists, who owns it, and that its documents are genuine, *before* we let it use the platform.
* **Beneficial owner**: a real person who owns or controls a business. The system records anyone with **25% or more** ownership (the default threshold) and anyone who controls it, such as a director.
* **AML** (Anti-Money-Laundering): the set of rules and activities that stop criminals from using us to hide the origin of money.
* **Sanctions list**: an official list of people, companies and countries we are forbidden to deal with.
* **PEP** (Politically Exposed Person): someone with a prominent public role. Not forbidden, but riskier, so extra care applies.
* **Adverse media**: negative news about a person or business.
* **Screening**: automatically comparing names against those lists. A *potential match* is only a possible hit; a person must decide whether it is real.
* **Regulator**: the authority that sets and checks the rules. Here, mainly the **CBL**.
* **MLRO**: the *Money Laundering Reporting Officer*, the senior person who owns suspicious-activity decisions.

:::danger Tipping-off
It is forbidden to tell a person or business that they are under suspicion or that a report exists. Everything we say to merchants and customers about restrictions is deliberately generic. See [[a:b09-08|Confidentiality and tipping-off]].
:::
@@end

### BOOK 2 — THE PLATFORM MAP

@@article id=b02-01 book=2 order=1 title="The big picture: three audiences, one engine" roles=ALL minutes=2 ui=AVAILABLE related=b02-02,b02-03
:::summary Big picture in 20 seconds
Three groups of people use three different websites: payers, merchants and staff. All three websites sit on one engine, called core-back. Only that engine can touch the money, the records and the payment companies.
:::

Think of three doors into one building. Payers use one door, merchants use a second door and staff use a third door. Behind all three doors there is **one engine**. It holds the rules, the records and the connections to the payment companies.

Each website has two parts. The **front** is the screens you see in the browser. The **back** is the program on a server that answers the front. The picture shows the three websites, their backs and the engine.

```diagram
 PAYERS (anonymous)        MERCHANTS                    STAFF (you)
 Checkout website          Merchant Portal website      Back Office website
 pay.<domain>              merchant.<domain>            admin.internal (office network only)
        │                         │                            │
        ▼                         ▼                            ▼
  checkout-back             merchant-back                 admin-back
        └───────────────┬─────────┴──────────────┬────────────┘
                        ▼   (secure private link, both sides prove identity)
                    core-back  ── the engine, the only part with the database
                        │
          ┌─────────────┴──────────────┐
          ▼                            ▼
       DATABASE                External payment companies
```

### Who uses each website
* **Payers** only pay. They never log in.
* **Merchants** run their business: links, balance, team, disputes and cash-outs.
* **Staff** (you) review merchants, handle exceptions and configure payment companies. You also move money under two-person control and watch risk.

### Why one engine matters
The engine is called **core-back**. It is the only part that can read or write the database. It is also the only part that holds encryption keys, posts to the ledger or calls payment companies.

Everything else must ask the engine. The engine double-checks every request. For example, when Layla pays Noon Mart, the checkout website only passes her request on. The engine decides whether the payment may go ahead. The next article, [[a:b02-02|the seven services]], shows why the parts are kept apart.
@@end

@@article id=b02-02 book=2 order=2 title="The seven services and why they are separated" roles=ALL minutes=3 ui=AVAILABLE related=b11-01,b12-01
:::summary Big picture in 20 seconds
The platform is seven programs: four servers and three browser apps. They are kept apart so that a break-in at the public checkout cannot reach the database, the keys or the ledger.
:::

The platform is seven programs. Four of them are "backs". A back runs on a server. Three of them are "fronts". A front runs in a browser.

Each website has a front and a back, and the engine has only a back. So the count is four backs (`core-back`, `admin-back`, `merchant-back`, `checkout-back`) and three fronts (`admin-front`, `merchant-front`, `checkout-front`). That makes seven.

### The seven programs at a glance
Read the table one row per group of users. The last column is the most important: only one program may touch the database.

| Program | Who uses it | Where it can be reached from | Can it touch the database? |
| :--- | :--- | :--- | :--- |
| `core-back` (port 4000) | Only our other programs | Private network only; never from the internet | **Yes, the only one** |
| `admin-back` (4101) + `admin-front` | Staff | Office network only (not forwarded by the router) | No |
| `merchant-back` (4102) + `merchant-front` | Merchants and their software | Public internet, encrypted | No |
| `checkout-back` (4103) + `checkout-front` | Payers and payment-company webhooks | Public internet, encrypted | No |

A **webhook** is a message that a payment company sends to us to say that something happened. A **port** is the numbered door of a server that a program listens on.

### Why so strict?
Imagine that an attacker takes over the public checkout website. The checkout holds **no database password, no encryption key and no power to post money**. So the attacker gets almost nothing.

The attacker would still have to defeat the core. The core accepts requests only from our own programs, and only when they show the right digital ID card. This check is called **mTLS** (mutual TLS): both sides prove who they are. Then the core re-checks every detail itself.

### The Double-Check Rule
The core does not trust even a request from our own admin program. It re-validates each request again. For example, it checks:
* the data shape: are the fields the ones it expects?
* who the user is;
* what the user is allowed to do;
* whether a maker is also trying to be the checker;
* whether a link really has that amount.

If the outer program is wrong, hacked or buggy, the core still refuses the request.

:::tip What this means for you
If an action is refused with a message like "forbidden", the core made that decision. It is not a screen glitch. Do not look for another way around. See [[a:b03-07|When a button is missing or an action is refused]].
:::
@@end

@@article id=b02-03 book=2 order=3 title="The life of a payment, step by step" roles=ALL minutes=9 ui=AVAILABLE related=b07-01,b07-02,b06-04,b08-04
:::summary Big picture in 20 seconds
A payment is a chain of 13 steps in four parts: the request, the safety checks, the money and the proof, and what happens after the customer has paid. Knowing the chain tells you where a payment is now and where its proof is recorded.
:::

A payment is not one event. It is a chain of **13 steps**, and most steps leave a record. Knowing the chain lets you answer two questions when someone asks about a payment: **where is it now?** and **where can I see the proof?** To read the records themselves, see [[a:b07-01|Reading a payment]].

We follow one example. **Layla** buys a phone case for **25.500 LYD** from an online shop and pays with **Sadad**, a mobile wallet. You met her in [[a:b01-01|What a payment really is]]. Sadad is our **partner**: the payment company that really moves the money. Our **core** makes every decision and writes every record. You can read about it in [[a:b02-01|The big picture]].

Read the picture from top to bottom. The numbers match the steps below it, where each new word is explained.

```diagram
CUSTOMER & SHOP               OUR CORE                       PARTNER (SADAD)
───────────────               ────────                       ───────────────
 1 Shop makes a link     ──►     stores the link
 2 Customer opens it     ──►     shows the right methods
 3 Picks Sadad, types    ──►   4 runs the guards, makes
   her phone number              the attempt, holds a slot
                               5 asks Sadad to start     ──► sends an SMS code
 6 Gets the SMS code     ◄──     shows "type your code"
 7 Types the code        ──►     asks Sadad to confirm   ──► takes the money
                               8 reads the answer        ◄── replies
                               9 checks five facts
                              10 writes SUCCEEDED + books
11 Sees "Paid"           ◄──     tells page, shop and POS
                              12 reads the statement     ◄── pays us days later
13 Shop cashes out       ──►     Finance pays the shop
```

### Part 1: The request (steps 1 to 3)
Someone asks to pay. No money moves yet.

1. **The merchant creates a payment link** with an amount and a currency, in the Merchant Portal or through the API. The platform stores it with a unique secret key.
   * *Recorded:* the payment link. **The amount lives here and nowhere else.**
2. **The customer opens the link** on the checkout website. The core decides **which payment methods to show**. We call these methods *rails*, and [[a:b02-06|The four layers]] explains them. A method appears only if all three of these are true:
   * the merchant allows it;
   * a fee is agreed for it;
   * a healthy *route* can carry this amount. A route is a working connection to a partner. The rule is in [[a:b06-12|The visible-rails formula]].
3. **The customer picks a method and fills in a short form.** For Sadad, she types her mobile number. The checkout sends the core only three things: the **link key**, the **method** and **what she typed**. **It never sends an amount.** The core reads the amount from the link, so nobody can change the price by editing the page or the web address.

### Part 2: Safety checks and the start (steps 4 to 6)
Now the core decides whether this payment may go ahead, and starts it with the partner.

4. **The core runs its safety checks ("guards") and creates the attempt.** The guards run together, in one protected step:
   * Is the merchant active, not suspended?
   * Is this customer sending too many requests too fast?
   * Do the quick anti-money-laundering (AML) rules allow it?
   * Is a **slot** free on the link? A slot is a reservation that stops a single-use link from being paid twice at once.

   If all guards pass, the core creates the **payment attempt** and reserves the slot. An attempt is one try to pay this link, and a link can have several. If a safety check fails, nothing goes to the partner and the attempt ends as `BLOCKED`. If only the slot is taken, the customer sees "Payment in progress".
   * *Recorded:* the attempt, with its **pinned configuration**. That means the exact versions of the settings it started with: gateway, route, credentials and commission. A setting edited a minute later does not change this payment.
5. **The core starts the payment with the partner.** For Sadad, it asks Sadad to text a one-time code to Layla's phone. This code is called an **OTP**.
   * *Recorded:* every request we send and the partner's answer, with secrets removed, in the **step log**.
6. **The customer is told what to do next:** "type the code we sent you". Other methods ask her to scan a QR code, approve in her wallet app or pay on the partner's own page. Waiting is normal, and nobody should tell her to pay again. If she walks away, the attempt ends as `EXPIRED` when its time limit passes. The details are in [[a:b07-06|Slot reservation, single-use links, expiry and the grace window]].

### Part 3: The money and the proof (steps 7 to 11)
The customer finishes, the partner answers, and we check the answer before we believe it.

7. **The customer completes the payment.** Layla types the code, and the core sends the partner the **confirm** request. This is the **money step**: the one request that makes money move.
   * **The core never repeats the money step automatically**, not after a timeout and not after a dropped connection. If the reply is lost, "it never arrived" and "it arrived and the money moved" look the same to us. A repeat could charge her twice. See [[a:b06-03|The engine]] for how the core handles this.
   * Other methods end differently: the customer pays inside the partner's own app or page, and the partner tells us. From step 8 on, the story is the same. The methods are in [[a:b06-02|The nine collection modes in depth]].
8. **The partner answers.** There are only three kinds of answer. Every partner uses its own words, so the core uses rules to translate them into our standard **states**. A state is a one-word label that says where an attempt is. There are 14 states, and [[a:b07-02|The fourteen payment states, one by one]] lists them. The translation rules are in [[a:b06-08|Status rules and error maps]].

| The partner's answer | What the core does | The attempt's state |
| :--- | :--- | :--- |
| **Clear success** | Goes on to step 9 and checks it before believing it. | `SUCCEEDED`, after steps 9 and 10 |
| **Clear failure** | Ends the attempt and frees the slot. | `FAILED` |
| **Unclear**: no reply, an error, or a reply we cannot read | **Does not guess.** Keeps the slot, posts no money and keeps checking. See [[a:b07-03]]. | `UNKNOWN` |

9. **The core checks the success itself.** It believes a success only after it has verified **five facts**:
   * the status really says success;
   * our reference number matches;
   * the amount matches, within a small tolerance;
   * the currency matches;
   * the environment matches (test or real).

   A message from the customer's browser, such as "I paid" or a return link, is only a **hint**. It makes the core ask the partner. It is never proof. See [[a:b06-07|Confirmation channels and how much each one is trusted]].
10. **The core writes it into the books.** In **one** database transaction, the attempt becomes `SUCCEEDED` **and** the **journal entry** is written. The journal entry is the accounting record in our books, which we call the *ledger*. It credits the shop's wallet, records our commission and keeps everything balanced. Both happen together or neither happens.
    * *Recorded:* the new state and the journal entry. The shop's balance is calculated from the ledger, so it now includes this payment. See [[a:b08-04|How each kind of payment is posted]].
11. **Everyone is told.** Layla's page changes to "Paid". The shop's POS screen updates if it has one. The merchant is notified through the **outbox**, a safe queue that makes sure each message is sent once.

### Part 4: After the customer has paid (steps 12 and 13)
The customer is finished. The money still has to travel, and our books must agree with the partner's.

12. **Later, the partner pays us.** A partner usually pays in one batch some days after the customers paid. "T+N" means the payment day plus N days. The partner also sends a **statement**, its own list of what it settled. We **reconcile**: we compare the statement with our records line by line, and any difference becomes a case for Finance. See [[a:b08-06|Reconciliation]]. Some partners pay the merchant directly instead, as [[a:b08-10|Settlement]] explains.
13. **The merchant cashes out.** The shop's wallet is only a number on our books: what we owe the shop. To get that money into its real bank account, the shop requests a **cash-out**. Finance processes it under two-person control. See [[a:b08-07|Cash-outs]].

:::tip If you remember only three things
1. **The server decides, not the browser.** The amount comes from the link, and a success is believed only after the server's own five checks.
2. **Unsure is never "failed".** If we do not know whether money moved, the state is `UNKNOWN`, and nobody guesses.
3. **Success and the books move together.** There is no success without its journal entry.
:::
@@end

@@article id=b02-04 book=2 order=4 title="The life of a merchant" roles=ALL minutes=4 ui=AVAILABLE related=b05-01,b05-02
:::summary Big picture in 20 seconds
A merchant moves through a lifecycle: register, verify the business (KYB), get reviewed and become active. Later the merchant can be suspended or closed when something changes. Each state changes what the merchant can do.
:::

Every merchant on the platform has a story. It starts when a business owner registers, and it can last for years. Staff touch this story at several points, and each point has its own screen.

We follow **Noon Mart**, the online shop from the payment story. You can read the full rules of each state in [[a:b05-01|What a merchant is]], and the onboarding steps in detail in [[a:b05-02|The onboarding journey]].

### Chapter 1: Noon Mart joins
1. **Registration.** The owner opens the public landing page and registers with a phone number, an e-mail address or a Google account. The owner must verify that phone, e-mail or account. You do not see this step in the Back Office. It happens on the merchant side.
2. **Business profile and KYB.** KYB means **Know Your Business**: we check that the business is real and we know who owns it. The owner enters the business details, uploads documents and declares the owners. You see this work on the **Join Requests** and **KYB Review** screens.
3. **Submission.** The owner submits. The platform creates a **join request**, which is the formal record of the application. A review clock starts. This clock is called the **SLA**, the deadline we promise for the review. An automatic screening also runs.

### Chapter 2: Staff decide
4. **Review.** A reviewer checks the documents, the owners, the screening and the risk. If something is missing, the reviewer may ask Noon Mart for more information. While the shop answers, the clock pauses. You work on this on the **Join Requests** screen.
5. **Decision.** The reviewer approves or rejects. Some cases need a second person to agree. For example, a Compliance colleague may be that second person. You see this on **Join Requests** and on **Approvals**.

### Chapter 3: Noon Mart trades
6. **Active merchant.** After approval, Noon Mart is **active**. It can now have wallets, applications, payment links, POS screens and API tokens. You find it on the **Merchants** screen.
7. **Daily life.** Layla and other customers pay. Noon Mart handles disputes, cash-outs and statements. You meet this stage on many screens.

### Chapter 4: When something changes
8. **Special events.** The business can be suspended, reinstated or closed. Noon Mart must also refresh its KYB from time to time. You manage all of this on the **Merchants** screen.

A merchant is always in exactly one state: `PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED` or `CLOSED`. A new merchant is `PENDING` until its join request is approved. A rejected request ends as `REJECTED`. A suspension or a closing changes what the merchant can do. The details are in [[a:b05-01|What a merchant is]].

### The same story as a table
Read the table from top to bottom. It follows the chapters above. The last column tells you which screen to open.

| Stage | What happens | Where you see it |
| :--- | :--- | :--- |
| Landing & registration | A person registers with phone, e-mail or Google and verifies it. | (merchant side) |
| Business profile & KYB | They enter business details, upload documents, declare owners. | **Join Requests**, **KYB Review** |
| Submission | A *join request* is submitted; a review clock (SLA) starts; an automatic screening runs. | **Join Requests** |
| Review | A reviewer checks documents, owners, screening and risk. May ask for more information (the clock pauses). | **Join Requests** |
| Decision | Approve or reject; some cases need a second person. | **Join Requests**, **Approvals** |
| Active merchant | Wallet(s), applications, links, POS, API tokens. | **Merchants** |
| Daily life | Payments, disputes, cash-outs, statements. | many screens |
| Special events | Suspension, reinstatement, closing, periodic KYB refresh. | **Merchants** |
@@end

@@article id=b02-05 book=2 order=5 title="Who can see and do what: interfaces and confidentiality zones" roles=ALL minutes=4 ui=AVAILABLE related=b04-05,b09-08
:::summary Big picture in 20 seconds
Not every part of the platform sees the same data. Payers, merchants and staff each have their own interface, and AML data, gateway costs and secrets stay inside strict confidentiality zones.
:::

Think of a bank building. Customers use the front counter. Staff use a door with a lock. Some rooms, such as the vault, are closed even to most staff. The platform works in the same way. There are different **interfaces**, which are the doors into the platform. There are also **confidentiality zones**, which are the rooms that only a few people may enter.

### The interfaces: six doors
Each door is built for one kind of user and has its own way to prove who you are. Here are the six doors, with Noon Mart as our example:
* Layla opens **Checkout** to pay. She does not sign in. The link key in her link is her key.
* Noon Mart's owner uses the **Merchant Portal** to run the shop. The owner signs in with a phone number, an e-mail address or a Google account, and then with **MFA**. MFA (multi-factor authentication) means a second proof after the password, such as a code.
* Huda, Ali and Omar use the **Back Office**, the site you are reading now. They sign in with a username, a password and MFA.
* Noon Mart's own software uses the **Merchant API** to create links automatically. It sends a token that starts with `pg_live_`. The merchant may also set an **IP allow-list**, a list of network addresses that are allowed to use the token.
* A display in the shop shows live payments on a **POS screen**. Each screen has its own token and a 15-minute idle limit.
* Payment companies send us messages through **inbound callbacks**. A callback is a message that a payment company sends to us. We accept it only after we check it.

The table puts the same facts in one place. Read each row from left to right: who uses the door, how they prove who they are, and what the door is for.

| Interface | Users | How they sign in | Purpose |
| :--- | :--- | :--- | :--- |
| Merchant Portal | merchants, staff, cashiers | phone/e-mail/Google + MFA | run the business |
| Checkout | anonymous payers | none; the link key is the key | pay |
| Back Office (this) | staff | username/password + MFA | operate and govern |
| Merchant API | merchants' software | `pg_live_` token, optional IP allow-list | automate links |
| POS screens | in-store displays | per-screen token, 15-minute idle limit | live payment display |
| Inbound callbacks | payment companies | signatures, IP allow-lists, secret path tokens | deliver verified events |

### Confidentiality zones: what you must not look at or say
A confidentiality zone is a kind of data with a strict rule about who may see it. You must not look at, copy or talk about this data unless the rule lets you.

* **AML-CONFIDENTIAL:** screenings, matches, cases and reports. AML means anti-money-laundering. Only `COMPLIANCE`, `MLRO` and, for audit, `SECURITY_ADMIN` may see this data. `SUPPORT` can see *that* a merchant is suspended, but never *why*. You can read about the roles in [[a:b03-02|Your account: roles and authorities]].
* **Gateway cost and platform margin:** merchants never see them.
* **Secrets:** nobody can read a stored secret. You can only replace it.
* **Personal data:** national IDs, phone numbers and documents are encrypted. Lists show them masked, and every read is logged.

For example, a `SUPPORT` colleague opens Noon Mart's record and sees "suspended". The colleague can see the fact, but the reason stays hidden.

:::warning
If you can see something you believe you should not, close it and tell your manager. Do not copy it anywhere.
:::
@@end

@@article id=b02-06 book=2 order=6 title="The four layers: Gateway, Credential Set, Rail, Route" roles=ALL minutes=4 ui=AVAILABLE related=b06-01,b06-11,b06-12
:::summary Big picture in 20 seconds
Four layers explain every gateway connection. The Gateway is the technical door, and the Credential Set says whose account and secret are used. The Rail is the button the customer sees, and the Route is the rule that connects a Rail to a Gateway.
:::

When Layla pays Noon Mart with Sadad, four different things work together. We keep them as four separate layers so that we can change one without touching the others.

### The four layers in one example
Here is the example, layer by layer. The names are an illustration.
1. **The Gateway** is the technical connection to Sadad. It holds the web addresses we call, how we log in, the steps of a payment and how to read Sadad's answers. It is one door to one partner.
2. **The Credential Set** holds the secret identifiers for our account at Sadad, for one environment, for example the real one. The platform can own a set, or a merchant can own one. Each set also says where the money lands. We call this the *settlement target*.
3. **The Rail** is the button Layla sees on the payment page. It has a name in Arabic and English, a logo, the form she fills in and the limits. In our example it is the "Sadad" button.
4. **The Route** is the rule that links the "Sadad" button to the Sadad gateway through a credential set. The route also carries a priority, a cost, limits, health and scope.

### The same layers as a table
Think of a restaurant that can be paid through several terminals. The analogy has a limit: a terminal is a box on a table, while a gateway is a set of software settings. Read the table one row per layer. The last column names the screen where staff manage it.

| Layer | The restaurant analogy | In the platform | Screen |
| :--- | :--- | :--- | :--- |
| **Gateway** | one payment terminal and its manual | one technical door to one partner: web addresses, how we log in, the steps, how to read its answers | **Gateways** |
| **Credential Set** | whose merchant account and key card is in that terminal | the secret identifiers for one gateway in one environment, owned by the platform or by a merchant, with a *settlement target* (where the money lands) | (inside Gateway Wizard step 2) |
| **Rail** | the sign on the door: "Cards", "Mobile wallet" | what the customer sees and picks: name in Arabic and English, logo, the form they fill, limits | **Rails** |
| **Route** | the rule "for cards use Terminal A first, Terminal B if A is broken" | the link between a rail and a gateway through a credential set, with priority, cost, limits, health and scope | **Routes** |

### Why four layers?
Things change independently. Each change touches only one layer:
* A partner changes its web address: you edit the **gateway**.
* A merchant brings its own account: you add a new **credential set**.
* Customers need a new button: you add a **rail**.
* Traffic must move from an aggregator to a direct partner: you change the **route**. An aggregator is a company that offers many payment methods through one door.

Nothing else is touched. Links already created keep working.

### Settlement target: who ends up holding the money
The settlement target answers one question: after Layla pays, who receives the money from the partner? There are three answers.
* `PLATFORM_CLEARING`: the partner pays **us**. We credit the merchant's wallet.
* `MERCHANT_DIRECT`: the partner pays **the merchant** directly. We only record our commission as owed to us.
* `PROVIDER_HELD`: the partner holds the funds for now.
@@end

@@article id=b02-07 book=2 order=7 title="Where the information is kept: a plain tour of the database" roles=ALL minutes=3 ui=AVAILABLE related=b02-02
:::summary Big picture in 20 seconds
The database is a set of record groups: business and money, gateway setup, what customers see, the engine’s recipes, what happened, people and compliance, and background work. You never need the table names to do your job.
:::

Think of the database as a large filing room. Each **table** is one drawer that holds one kind of record, such as merchants or payment attempts. The database has **76 tables**. You never need their names to do your job. But knowing what kinds of things are stored makes sense of the screens.

### What one payment touches
When Layla pays Noon Mart 25.500 LYD, several drawers are used:
* the **payment link** that Noon Mart created (group A);
* the **rail** and **route** that decided which methods she saw (group C);
* the **attempt** and its **step log** (group E);
* the **journal entry** in the ledger (group A).

The groups are listed in the table below.

### The seven groups
Read the table one group per row. The "Size" column is the number of tables in that group. The last column says in plain words what the group stores.

| Group | Size | What it stores (in plain words) |
| :--- | :--- | :--- |
| **A. Business & money** | 20 | merchants, users, sign-in code checks (MFA), applications, wallets, tokens and their IP allow-lists, payment links, POS terminals and POS screens, the ledger accounts, journal entries, commission and velocity rules, AML cases, adjustments, cash-outs, approval requests |
| **B. Gateway setup** | 7 | gateways, versions, test-evidence for versions, environments and addresses, how to log in to partners, amount settings, credential sets |
| **C. What customers see** | 4 | logos, rails, form fields, routes |
| **D. The engine's recipes** | 13 | signing recipes, flows and steps, parameters, outputs, status and error mappings, confirmation channels, polling, widgets, redirects, statement parsers, manual-transfer instructions |
| **E. What happened** | 11 | attempts and attempt groups, step logs, incoming webhooks, operator cases, inquiry schedules, reconciliation, health samples, change logs, audit log |
| **F. People, compliance, disputes, settings** | 14 | identities, join requests, KYB documents, KYB re-check requests, beneficial owners, screenings and matches, AML rules, reporting rules and reports, disputes, notification templates and notifications, platform settings |
| **G. Background work & operations** | 7 | background jobs, outbox queues (safe queues for messages), backup records and restore drills, daily summary numbers for merchants and routes |

### Three properties that matter to everyone
1. **Money is stored with 4 decimal places** and never as a floating-point number. A floating-point number is a kind of number that computers round a little, so it is not safe for money.
2. **The ledger is append-only.** Nothing is ever edited or deleted. Corrections are new entries.
3. **A merchant's balance is not a stored number.** It is calculated from the ledger lines, so it can never drift from the books.

:::refs
- [[a:b08-01|Why double-entry bookkeeping makes lost money impossible]]
- [[a:b12-08|The database, timers and workers in plain words]]
:::
@@end

### BOOK 3 — WORKING IN THE BACK OFFICE

@@article id=b03-01 book=3 order=1 title="Signing in, MFA, sessions, language and theme" roles=ALL minutes=1 ui=AVAILABLE related=b03-02,b11-03
1. Open the Back Office address your manager gave you. It only works from the office network (or an approved VPN). If it does not open from home, that is intentional.
2. Enter your e-mail and password. Then enter the six-digit **MFA** code sent by SMS to the phone number registered on your account. If your account has no phone number, ask the Security Admin before your first sign-in.
3. Sessions are short on purpose. Use **Sign out** when you finish: it ends the session on the server, not only in the browser. If you are signed out, sign in again; do not ask anyone to extend it.
4. Language and theme controls are in the top bar. Switching language re-translates menu and screens immediately; Arabic is right-to-left. Numbers and money keep their meaning in both.

:::danger Never
Never share your password or MFA code. Never leave a signed-in screen unattended; lock your computer. Never sign in on a shared computer. If you suspect someone knows your password, tell the Security Admin immediately (Book 11).
:::
@@end

@@article id=b03-02 book=3 order=2 title="Your account: roles, authorities and the maker and checker switches" roles=ALL minutes=2 ui=AVAILABLE related=b04-01,b04-05
### Role
Your **role** is your job family. The seven staff roles are:

| Role | Typical duties |
| :--- | :--- |
| `GATEWAY_ADMIN` | build and test gateway integrations; propose going live |
| `SECURITY_ADMIN` | approve gateway versions and credential changes; manage staff accounts and permissions |
| `FINANCE` | cash-outs, adjustments, refunds, reconciliation, commission proposals, profit and liquidity views, disputes |
| `OPERATOR` | work operator cases (stuck payments), first review of join requests, merchant support actions |
| `COMPLIANCE` | KYB and AML review, screening dispositions, case proposals, report drafts |
| `MLRO` | final approval of AML decisions and regulatory reports; ratifies emergency suspensions |
| `SUPPORT` | read-only look at merchants, history and payment status; no money, no AML data |

### Authorities
A role is only a label. What you can actually do is decided by your **authorities** — a list of specific permissions on your account. **An account with no authorities can do nothing**, whatever its role. The authority list is closed: nobody can grant an authority they do not hold, and nobody can change their own account; both go through the approval flow.

### Maker and checker switches
Two switches on your account decide whether you may *propose* sensitive changes (**maker**) and/or *decide* them (**checker**). Roles come with typical settings, but **your account's switches are what count**. You can never be both for the same request.

:::note How to find out what you can do
Your menu only shows screens you may open. Buttons you cannot use are hidden or refused. If you need something you cannot see, ask your manager; the Security Admin changes permissions under two-person control.
:::

### The Admin Users screen
`SECURITY_ADMIN` can list, invite, edit and disable staff accounts on **Admin Users**. Changing a role, an authority, a maker/checker flag or activating an account creates an approval for a different `SECURITY_ADMIN`; nobody can change their own account. The detail page shows the account's current authorities and its recent changes.
@@end

@@article id=b03-03 book=3 order=3 title="The menu, screen by screen" roles=ALL minutes=5 ui=AVAILABLE related=b03-05,b03-02,b03-07,b13-02
:::summary Big picture in 20 seconds
The menu on the left groups every Back Office screen into seven sections: Overview, Onboarding, Governance, Operations, Finance, Gateways and Learning. You only see the screens your authorities allow, so your menu is shorter than this article. Use the tables below to find out what a screen is for, who normally uses it, and which article explains it in full.
:::

### How the menu works
* **The menu is personal.** A screen appears only if your account holds the authority to open it. A missing screen is not an error. If you need one, see [[a:b03-07|When a button is missing or an action is refused]].
* **A section with no visible screens disappears.** For example, a `SUPPORT` account has no Finance section at all.
* **The menu is only a door.** Even if a screen opens, every button on it is checked again by the core. Opening a screen never means you may change things on it.
* **Every screen has a "?" button** in its header. It opens a short explanation of the screen and links to the right articles.
* **Press Ctrl+K (Cmd+K on a Mac)** to search for a screen, an article or a glossary term.

The "Typically used by" column describes the usual job, not a rule. What you can really do is decided by your authorities ([[a:b03-02|Your account]]).

### Overview
| Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- |
| **Dashboard** | health of the platform at a glance | everyone | [[a:b03-05]] |

### Onboarding
This section is about merchants: who they are, where their money lands and where they take payments.

| Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- |
| **Join Requests** | review businesses applying to join | OPERATOR, COMPLIANCE | [[a:b05-03]] |
| **KYB Review** | check uploaded documents and beneficial owners | COMPLIANCE, OPERATOR | [[a:b05-04]] |
| **Merchants** | look up, edit, suspend, reinstate | OPERATOR, COMPLIANCE, SUPPORT (read) | [[a:b05-08]] |
| **Wallets** | every merchant's balance, shards and statement; freeze a wallet | OPERATOR, COMPLIANCE, SUPPORT (read) | [[a:b03-09]] |
| **Applications & Channels** | applications, payment links and POS terminals; allow-lists and tokens | OPERATOR, COMPLIANCE, SUPPORT (read) | [[a:b03-10]] |

### Governance
This section is about control: who decides, who is on the team and what is recorded.

| Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- |
| **Approvals** | decide requests made by others | checkers | [[a:b04-03]] |
| **Audit Log** | search and export the audit trail | SECURITY_ADMIN | [[a:b04-07]] |
| **Admin Users** | staff accounts, roles, authorities, maker/checker flags | SECURITY_ADMIN | [[a:b03-02]] |
| **AML Cases** | investigate suspicious activity | COMPLIANCE, MLRO | [[a:b09-05]] |
| **AML Screenings** | decide matches against sanctions and watch lists | COMPLIANCE, MLRO | [[a:b09-03]] |
| **AML Rules** | the rules that raise alerts | COMPLIANCE, MLRO | [[a:b09-04]] |
| **AML Reports** | regulatory reports | COMPLIANCE, MLRO | [[a:b09-07]] |

### Operations
This section is about the day-to-day running of payments and of the platform itself.

| Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- |
| **Transactions & Webhooks** | every payment attempt and every message a partner sent us | OPERATOR, SUPPORT (limited view) | [[a:b03-11]] |
| **Operator Cases** | stuck, conflicting or odd payments | OPERATOR | [[a:b07-04]] |
| **Inquiry Schedule** | when the platform asks a partner for a payment's status | OPERATOR | [[a:b07-09]] |
| **Disputes** | chargebacks and disputes | FINANCE | [[a:b08-09]] |
| **Adjustments** | refunds, chargebacks, corrections | FINANCE | [[a:b08-08]] |
| **Cash-Outs** | merchant payouts | FINANCE | [[a:b08-07]] |
| **Reconciliation** | match partner statements to our books | FINANCE | [[a:b08-06]] |
| **Backups** | backup engine, WAL archive lag, storage targets, schedule, last backup and restore drill | SECURITY_ADMIN | [[a:b12-10]] |
| **Jobs & Outbox** | delivery health of background work: outbox, audit outbox, jobs, notifications | SECURITY_ADMIN | [[a:b03-14]] |
| **Platform Settings** | versioned platform settings, export and restore | SECURITY_ADMIN, GATEWAY_ADMIN | [[a:b12-07]] |
| **Checkout Help** | the help payers see at checkout | admins | [[a:b07-10]] |

### Finance
This section is about the money itself and whether the books are right.

| Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- |
| **Pricing & Limits** | commission profiles and velocity rules | FINANCE | [[a:b08-03]] |
| **Profitability** | what the platform earns | FINANCE | [[a:b08-11]] |
| **Liquidity** | whether there is enough cash to cover payouts | FINANCE | [[a:b08-11]] |
| **Journal Entries** | read every double-entry posting and its balance check | FINANCE | [[a:b03-13]] |
| **Ledger Audit & Invariant** | ledger integrity checks, per-account shards and checkpoints | FINANCE | [[a:b08-11]] |

### Gateways
This section is about the connections to payment partners.

| Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- |
| **Gateways** | partner connections, versions and go-live | GATEWAY_ADMIN | [[a:b06-01]] |
| **Credential Sets** | the vault of login details we hold for each partner | GATEWAY_ADMIN | [[a:b03-12]] |
| **Rails** | the payment methods a customer can pick | GATEWAY_ADMIN | [[a:b06-11]] |
| **Routes** | which gateway serves which rail, in what order | GATEWAY_ADMIN | [[a:b06-11]] |

### Learning
| Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- |
| **Interactive Guide** | this guide | everyone | [[a:b00-02]] |
| **Employee Academy** | training, labs and exams | everyone | [[a:b13-04]] |

Inside the Academy, `SECURITY_ADMIN` also sees a **Team** tab that shows everyone's training progress. It has no menu entry of its own and is read-only.

### Screens you reach from another screen
Some screens have no menu entry. You open them from a row or a button:
* **Merchant detail**, from **Merchants** ([[a:b05-08|The Merchants screen]]).
* **Join request detail** and **new join request**, from **Join Requests** ([[a:b05-03|Working the Join Requests queue, step by step]]).
* **KYB document review**, from **KYB Review** ([[a:b05-04|KYB documents and beneficial owners]]).
* **Operator case detail**, from **Operator Cases** ([[a:b07-04|The Operator Cases screen]]).
* **Admin user detail**, from **Admin Users** ([[a:b03-02|Your account]]).
* **The Add-a-Gateway wizard** and **Smart AI Integration**, from **Gateways** ([[a:b06-13|The Add-a-Gateway wizard]], [[a:b06-14|Smart AI Integration]]).

:::note A screen that is missing is not a fault
If a screen is missing from *your* menu, your account does not hold its authority. Do not ask a colleague to do it "from their account". Ask your manager, and the Security Admin will change permissions under two-person control.
:::
@@end

@@article id=b03-04 book=3 order=4 title="Reading tables, filters, search and statuses safely" roles=ALL minutes=1 ui=AVAILABLE related=b13-01
### Tables
Most screens are tables. You can search, filter, sort and export. Filters and sorting are applied by the server, so you are always looking at complete results, not just the visible page.

### Habits
* **Check the date range and filters before drawing a conclusion.** A forgotten filter can hide the very case you need.
* **Statuses are colored chips, but never rely on color alone.** Read the word.
* **Amounts show currency.** Three decimals for LYD. Never round in your head.
* **Times** are shown in your local time; the system stores UTC. Partners may use Libya time (`Africa/Tripoli`). When comparing a partner statement to our screens, convert deliberately.
* **Masked values** (like `091*****78`) are masked on purpose. Do not try to unmask them.
* **Copying references:** every payment has a reference. When talking to a partner, quote the reference, not the customer's name.

:::tip Exporting
Exports contain personal and financial data. Save them only where company policy allows, delete them afterwards, and never e-mail them to personal accounts.
:::
@@end

@@article id=b03-05 book=3 order=5 title="The Dashboard: every tile explained" roles=ALL minutes=2 ui=AVAILABLE related=b07-03,b10-02
| Tile | Meaning | What to do if it looks bad |
| :--- | :--- | :--- |
| **Active Merchants** | merchants currently allowed to take payments | none; context |
| **Pending** | applications or approvals waiting | work the queue; see Join Requests / Approvals |
| **Unknown Backlog** and **Oldest** | number of payments in `UNKNOWN` and the age of the oldest | rising numbers or old items: Book 7, article on `UNKNOWN`; runbook RB-03 |
| **Open Circuit Breakers** | payment routes automatically switched off because the partner is failing | runbook RB-01; tell the Gateway Admin |
| **Join Request SLA** | onboarding reviews at risk of being late | assign and review |
| **AML SLA** | compliance cases near or past their deadline | compliance team; escalate to MLRO |
| **Webhook Inbox Lag** | delay between receiving a partner's message and processing it | if high: tell Engineering; RB-02 if signatures fail |
| **Attempts By State** | how many payments are in each state | a growing `VERIFYING` or `UNKNOWN` bar is a warning |
| **Approval Queue Ageing** | how long approvals have been waiting | checkers: clear old items or reassign |
| **Live** badge | the screen is auto-refreshing | none |

:::note
The dashboard is a smoke alarm, not a diagnosis. When a tile worries you, open the screen it points to and read the individual items.
:::
@@end

@@article id=b03-09 book=3 order=6 title="The Wallets screen and the wallet page: balances, statements, shards and freezing" roles=OPERATOR,COMPLIANCE,SUPPORT minutes=4 ui=AVAILABLE related=b05-06,b08-02,b08-07,b04-04
:::summary Big picture in 20 seconds
**Wallets** lists every merchant's wallet. Each wallet has its own page with the balance, the full paged statement, the shards behind the balance and the history of its status. The one thing you can change is the status: freezing is immediate, and unfreezing needs a second person.
:::

### What a wallet is, in one minute
A **wallet** is a merchant's balance on our books. It belongs to one merchant and one currency, for example Noon Mart in `LYD`. The balance is not a number someone typed. It is **calculated from the ledger** every time you look. For the full idea, see [[a:b05-06|Applications and wallets]].

### Opening the screen
**Wallets** is in the **Onboarding** section. It opens for accounts that may read merchants (`merchants.read` or `support.read_merchant`). Buttons that change something need the extra authority to write merchants (`merchant:write`). Without it you can look, but you will not see "Freeze wallet".

### The tiles at the top
| Tile | Meaning | What to do if it looks bad |
| :--- | :--- | :--- |
| **Total wallets** | all wallets on the platform | none; context |
| **Active wallets** | wallets that can be used normally | none; context |
| **Frozen wallets** | wallets held back. The badge says **Contained** when there is at least one, **Clear** when there are none | check each one is frozen on purpose |
| **Wallets with pending cash-outs** | wallets with a payout waiting. The badge says **Pending** or **Clear** | see [[a:b08-07]] (Cash-outs) |
| **Total balance · LYD** | the sum of live balances, one tile per currency | none; context |

If your role may not see money, the balance tile shows **Restricted**. If the tiles fail to load, the strip is hidden and the table still works.

### The table
Each row is one wallet. The columns are **Wallet**, **Merchant**, **Currency**, **Status**, **Live balance**, **Checkpoint**, **GL account**, **Applications**, **Pending cash-outs**, **Created** and **Action**.

* A wallet's **Status** is `PENDING`, `ACTIVE`, `FROZEN` or `CLOSED`.
* **Live balance** is the sum of the wallet's ledger shards right now. A positive number is money we owe the merchant.
* **Checkpoint** is the balance saved at the last checkpoint, written with the same sign as the live balance. The platform saves checkpoints by itself, so the live balance is normally only a little ahead of it, by whatever was posted since then.
* **GL account** is the ledger account behind the wallet.
* You can filter by **Status**, **Currency**, **Merchant** and **Created**, and search by text.
* **Inspect** (or the wallet ID) opens the wallet page. **Inspect GL account** in the row menu opens the ledger account in a side panel ([[a:b03-13|Journal Entries]]).

### The wallet page
Each wallet has its own page, so you can bookmark it, share the link and use the browser's Back button. Old links of the form `Wallets?open=…` land on the same page. The header shows the merchant, the status, **Freeze wallet** or **Request unfreeze**, **Back to wallets** and **Refresh**.

* If the wallet is `FROZEN`, a banner says so and says whether a request to restore it is already waiting.
* If a request about the wallet is waiting for approval, a **Pending approvals** list appears with a link to **Approvals**.
* Four tiles show **Live balance**, **Checkpoint balance** (with the time it was taken), **Posted since checkpoint** and **Pending cash-outs**.

Below the tiles are four tabs. The tab you choose is kept in the address, so a reload opens the same tab.

1. **Overview and shards.** The wallet's details and its **Shards**. A busy account is split into several parts, called **shards**, so that many payments can post at the same moment. A wallet normally has one shard; a wallet that is paid very often can be spread over more (the **Shard width** in the details tells you how many). Each shard's balance is shown with the same sign as the live balance, and the **Total** row adds them up. A green note says "Shards agree with the live balance". If it says "Shards differ from the live balance" and shows a **Drift**, tell Finance. Do not try to fix it. See [[a:b08-05|The ledger equation]].
2. **Statement.** Every ledger posting to the wallet, newest first, in pages of 10, 25, 50 or 100 lines. Above the table, **Lines**, **Total debits**, **Total credits** and **Net change** describe the **whole** result of your filters, not only the visible page. A **Net change** of +135.000 means the wallet grew by 135.000 over those lines. You can filter by **Side** (debit or credit), **Reference type** and **Posted** (a date range), and search the memo or the reference. Each row shows **Posted**, **Reference type**, **Memo**, **Debit**, **Credit** and **Journal entry**. When the line came from a payment, an adjustment, an AML case or a dispute, the **Reference type** is a link to that record. The **Journal entry** link opens the whole entry in a side panel, on top of the page.
3. **Links and cash-outs.** The applications that pay into this wallet, and its recent cash-outs, with a button to **Open cash-outs**.
4. **Status history.** Every freeze and restore of this wallet: **When**, **Action**, **Change** (for example `ACTIVE → FROZEN`), **Reason**, **By** (who, and in which role) and a link to the approval when there was one. You can filter by **Action** and **When**.

### Freezing and unfreezing
| Action | When it appears | What happens |
| :--- | :--- | :--- |
| **Freeze wallet** | the wallet is `ACTIVE` | applied **at once**. A frozen wallet cannot be debited by cash-outs until it is restored |
| **Request unfreeze** | the wallet is `FROZEN` | creates an **approval request**. A different checker must approve it before anything changes |

Both ask for a **Reason** of 10 to 500 characters, which goes into the audit trail and then into **Status history**. Freezing is fast on purpose and unfreezing is slow on purpose. It is easy to stop money and hard to release it. This is the asymmetry principle in [[a:b04-04|Emergency actions]]. A wallet that is `PENDING` or `CLOSED` has no action.

If a change to the wallet is already waiting for approval, a second request is refused with "A change to this wallet is already awaiting approval."

### What `SUPPORT` and similar roles see
Accounts without financial visibility see **Restricted** instead of the live balance, the checkpoint, the shards and the recent cash-outs. The **Statement** tab shows a lock and the text "The ledger statement is hidden for your role." In **Status history**, the change and the reason show **Restricted** for accounts without sensitive access. This is intended. Do not try to get the numbers another way.

:::tip A safe habit
Before you freeze, read the merchant name and the currency on the page, then write the reason as a sentence: "Freezing Noon Mart LYD wallet because AML case 1042 is open." A reason you cannot write is a sign to stop.
:::
@@end

@@article id=b03-10 book=3 order=7 title="The Applications & Channels screen: applications, payment links and POS terminals" roles=OPERATOR,COMPLIANCE,SUPPORT minutes=4 ui=AVAILABLE related=b05-06,b05-07,b04-02,b04-03
:::summary Big picture in 20 seconds
**Applications & Channels** shows every place where merchants take payments: their applications, payment links and POS terminals. Stopping something is immediate. Anything that could widen who can pay, or where money lands, goes to a second person.
:::

### Opening the screen
It is in the **Onboarding** section, after **Wallets**. It uses the same access rule as **Merchants**: you need to be allowed to read merchants. The screen title is **Applications**. Change buttons need the authority to write merchants (`merchant:write`).

The concepts are explained in [[a:b05-06|Applications and wallets]] and [[a:b05-07|Payment links, POS terminals and API tokens]]. This article is about the screen.

### The tiles
| Tile | Meaning | What to do |
| :--- | :--- | :--- |
| **Applications** | all applications | none; context |
| **Active** | applications that can take payments | none; context |
| **Suspended** | stopped applications. The badge says **Contained** when there is at least one | check each one is suspended on purpose |
| **Pending activation** | applications waiting to go live. The badge says **Pending** | see [[a:b05-02]] (the onboarding journey) |
| **Without rail whitelist** | applications that accept every active rail. The badge says **Review** when there are any | confirm that "all rails" is really intended |

### Three tabs
The tabs are **Applications**, **Payment links** and **POS terminals**. Each tab has its own search, filters and paging. You can open a tab directly with `?tab=links` or `?tab=pos` in the address.

**Applications tab.** Columns: **Application**, **Merchant**, **Status**, **Settlement wallet**, **Monthly volume**, **Rail whitelist**, **Redirect domains**, **API tokens**, **Links / POS**, **Created**, **Action**. The **Rail whitelist** cell says **All rails** when no list is set, **No rails** when the list is empty (payments are blocked), or shows the allowed rails. Application status is `DRAFT`, `PENDING`, `ACTIVE`, `SUSPENDED` or `CLOSED`.

**Payment links tab.** Columns: **Link**, **Application**, **Merchant**, **Amount**, **Fee bearer**, **Uses**, **State**, **Expires**, **Created**, **Action**. A link's **State** is `PENDING`, `COMPLETED`, `EXPIRED` or `CANCELLED`. **Uses** reads "n / ∞" for a link that can be paid many times.

**POS terminals tab.** Columns: **Terminal**, **Application**, **Merchant**, **Status**, **Screens**, **Last active**, **Created**, **Action**. A terminal is `ACTIVE`, `INACTIVE` or `BLOCKED`.

### What you can do
Every action opens a box that asks for a **Reason** (10 to 500 characters). The box tells you whether the change is **immediate** or **submitted for four-eyes approval**.

| Where | Action | When | Immediate or approval |
| :--- | :--- | :--- | :--- |
| Application | **Suspend application** | `ACTIVE` | immediate |
| Application | **Request reactivation** | `SUSPENDED` | approval |
| Application | **Edit policy** | any status except `CLOSED` | approval |
| Application drawer | **Revoke token** | token not already revoked | immediate, cannot be undone |
| Payment link | **Cancel link** | `PENDING` | immediate, cannot be undone |
| POS terminal | **Deactivate terminal** | `ACTIVE` | immediate |
| POS terminal | **Block terminal** | `ACTIVE` or `INACTIVE` | immediate |
| POS terminal | **Request reactivation** | `INACTIVE` or `BLOCKED` | approval |

The pattern is the one from [[a:b04-02|Descriptive versus sensitive fields]]: a change that makes things **more restricted** is applied at once and audited. A change that **loosens** things or changes what an application may accept needs a different person to approve it. After you submit an approval, a banner says "Submitted for approval. The change is not applied until an independent checker approves it." with a button to **Open Approvals**. See [[a:b04-03|The life of an approval request]].

Two more rules to know:
* A `BLOCKED` terminal can only leave that state through an approved reactivation.
* You cannot suspend an application and change its configuration in the same request. Suspending is immediate; the configuration change is not.

### Edit application policy
**Edit policy** opens a form with three parts, and its button is **Submit for approval**.
* **Settlement wallet:** only active wallets of the same merchant and the same currency are offered.
* **Rail whitelist:** **All active rails**, **Selected rails only** or **No rails (payments blocked)**. Choosing **No rails** warns you that the application cannot accept any payment.
* **Redirect domains:** a hostname or an `https` origin without a path, separated by commas or new lines. The limit is 100 domains.

If you change nothing, the form says "Nothing changed: the request matches the current configuration."

### The application drawer
Click **Inspect** to open a panel with four tabs: **Configuration and allowlists**, **API tokens**, **Payment links** and **POS terminals**.
* **Configuration** shows the settlement wallet (with a link to open it on **Wallets**), the rail whitelist and the redirect domains. A **Pending approvals** card appears if something is waiting. While a change is waiting, **Request reactivation** and **Edit policy** are disabled with the message "A change to this entity is already awaiting approval."
* **API tokens** lists each token by name and its last four characters only (for example `****a91f`), its scopes, whether an IP allow-list is on, when it was last used, when it expires and its status. The full token is never shown.

### What is hidden
Roles without sensitive access (for example `SUPPORT`) see **Restricted** for **Redirect domains**, and for **Monthly volume** and **Expected monthly volume**.

:::warning Revoke and Cancel cannot be undone
A revoked token stops working at once and the merchant must create a new one. A cancelled payment link can never be paid again. Check the name, the merchant and the environment before you confirm.
:::
@@end

@@article id=b03-11 book=3 order=8 title="The Transactions & Webhooks screen: attempts, step logs and partner messages" roles=OPERATOR,SUPPORT minutes=4 ui=AVAILABLE related=b07-01,b07-02,b07-05,b07-09
:::summary Big picture in 20 seconds
**Transactions & Webhooks** is the place to look up any payment attempt and any message a partner sent us. It is mostly for reading. The only action that touches a payment is **Schedule inquiry**, and it is for payments stuck in `UNKNOWN` or `VERIFYING`.
:::

### Opening the screen
It is in the **Operations** section. You need one of: permission to read merchants, support access to merchants, or `attempt:read`. The screen's subtitle says: "Every payment attempt and provider callback across all merchants."

What you actually see depends on your role. `OPERATOR` and `SUPPORT` can read attempts. `SUPPORT` sees a **redacted** view: amounts, partner references and the ledger entry show **Restricted**, and the search box does not match partner references.

### Two tabs
* **Payment attempts** (the default).
* **Inbound webhooks**. Open it directly with `?tab=inbound`.

You can also open one attempt directly with `?open=<attempt id>`. Several other screens link here that way.

### Payment attempts: the tiles
The tiles cover the last 24 hours.

| Tile | Counts these states | What to do if it looks bad |
| :--- | :--- | :--- |
| **Attempts (24h)** | all attempts | none; context |
| **Settled** | `SUCCEEDED` | none |
| **In flight / verifying** | `CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, `VERIFYING`, `UNKNOWN` | a growing number: [[a:b07-03]] (UNKNOWN) |
| **Failed** | `FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED` | look for one rail or gateway behind most of them |
| **Escalated to case** | attempts whose operator case is not yet resolved | work the queue in **Operator Cases** |

### Payment attempts: the table
Columns: **Reference**, **Status**, **Amount**, **Merchant**, **Rail**, **Provider reference**, **Ledger entry** and **Actions**.
* Click the **Reference** to open the drawer. The reference is what you quote to a partner, never the customer's name.
* A **Case** badge next to the status means an operator case is open on this attempt.
* **Ledger entry** opens the journal entry ([[a:b03-13|Journal Entries]]).
* Filters: **Status**, **Rail**, **Gateway**, **Merchant**, **Application**, **Currency**, **Amount** (a range) and **Created** (a date range). The status list shows all fourteen states from [[a:b07-02|The fourteen payment states]].
* The newest attempts come first. There is no Excel export on this screen.

Each row has **Inspect**, and a menu with **Schedule inquiry** and **Open merchant**.

### The attempt drawer
The drawer is titled **Transaction detail** and shows the reference, the status, the environment (`SANDBOX` or `LIVE`) and the mode. It has four tabs.

1. **Summary.** The facts in blocks: **Payment** (who, which rail and gateway, when it expires, fee bearer, settlement target), **Amounts and references** (requested, surcharge, total charged, settled, gateway fee, platform commission, net to merchant, and the partner's references), **Customer fields (masked)**, and links to any **Operator cases**, **Disputes** and **Adjustments** on this attempt. How to read these fields is in [[a:b07-01|Reading a payment]].
2. **Step logs.** One card per call the engine made to the partner, with the phase, the HTTP code, the outcome and how long it took. Open a card to read the request and the response as labelled rows. **Payloads are redacted**: secrets show a **Redacted** chip. Long payloads are cut off after 120 rows.
3. **Inbound webhooks.** The messages the partner sent about this attempt. Click one to open it.
4. **Checkout retry group.** All attempts of the same payer on the same payment link, oldest first. It explains the common story: the customer failed on one rail, then paid on another. Your attempt is marked **This attempt**. If none of the payer's attempts succeeded, the tab says so.

### Inbound webhooks: the table
Columns: **Received**, **Gateway**, **Signature**, **Source IP**, **Attempt**, **Processing result** and **Actions**.
* **Signature** is **Verified** or **Unverified**, with the reason under it. Unverified rows have a red background. A spike of these is the signal for runbook [[a:b10-03|RB-02]].
* **Attempt** is a link, or **Unmatched** when the message does not belong to any payment we know.
* **Processing result** reads **Not processed** until the background worker has handled it.
* Filters: **Gateway**, **Signature** (**Verified** or **Unverified**), **Unmatched only** and **Received**.

The webhook drawer shows the verdict (**Signature verified** or **Signature not verified**, **Matched to attempt** or **Unmatched**), the details, the **Headers** (secrets are removed before they leave the server) and a **Body preview** with the size and the first characters of its hash. The full story of what happens to a message is in [[a:b07-05|Webhooks and the inbox]].

### What you can do from the drawer
| Button | Who and when | What it does |
| :--- | :--- | :--- |
| **Schedule inquiry** | `attempt:inquire`; status `UNKNOWN` or `VERIFYING` | immediate. Asks the partner about this payment within about a second and moves any open case to in progress. Refused if the attempt cannot be asked |
| **Create refund / adjustment** | `finance:write`; status `SUCCEEDED`, `PARTIALLY_REFUNDED` or `DISPUTED` | only opens **Adjustments** with this payment filled in. Nothing is created here |
| **Record dispute** | `dispute:write`; same states | only opens **Disputes** with this payment filled in |

**Schedule inquiry** is audited. Read [[a:b07-09|Inquiry]] first, because some rails cannot be asked at all.

:::warning Look, do not fix
Nothing on this screen changes a payment's status by hand. If a payment looks wrong, open a case or follow [[a:b07-12|the customer-says-money-was-deducted procedure]]. Never guess a status from the partner's words alone.
:::
@@end

@@article id=b03-12 book=3 order=9 title="The Credential Sets screen: the vault of partner logins" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=4 ui=AVAILABLE related=b06-09,b06-01,b10-06,b11-04
:::summary Big picture in 20 seconds
**Credential Sets** is the vault where we keep the logins and secrets that partners gave us. You can create, replace, test and withdraw a set. You can never read a secret back, not even your own.
:::

### Opening the screen
It is in the **Gateways** section, between **Gateways** and **Rails**. It opens for accounts with `credentials.manage` or `gateways.edit`. The page says: "Provider credentials held in the vault. Secrets are write-only and are never displayed."

To create, replace, test or withdraw a set you need the authority to write credentials or gateways. Without it you see the list but no buttons. What a credential set is, and why secrets are write-only, is in [[a:b06-09|Credentials and Credential Sets]]. This article is about the screen.

### The table
Columns: **Gateway**, **Environment**, **Owner**, **External merchant ID**, **Settlement target**, **Status**, **Last verified**, **Expires** and **Actions**.
* **Environment:** `LIVE` is shown in a warning colour, because it is real money.
* **Owner:** **Platform** (our own account with the partner) or **Merchant** (the merchant's own account, shown with the merchant).
* **Status:** `UNTESTED`, `VERIFIED`, `FAILING` or `REVOKED`.
* **Expires** shows **Expires soon** within 14 days and **Expired** after the date. Plan the replacement before it expires. See [[a:b10-06|RB-05]].
* Filters: **Gateway code**, **Environment**, **Owner**, **Status** and **Created**.
* Open one set directly with `?highlight=<id>`. Search results and the merchant page link here that way.

### The drawer
Click **View** to open the set. It shows its identity, status, settlement target, **Last verified** and **Expires**. A blue note repeats the rule: stored secrets are write-only.

The **Stored entries** table lists only the **Key** and **Type** of each entry. The **Value** column shows **Secret, hidden** or **Write-only**. The values themselves are never sent to your browser.

### What you can do
Every action here is applied **immediately**. This screen does not create an approval request.

| Action | What it does |
| :--- | :--- |
| **New credential set** | stores a new set. It starts as `UNTESTED`. You choose the gateway, the environment, the owner, the settlement target and the entries |
| **Verify** | runs the live credential check at once. A pass makes the set `VERIFIED`. A failure leaves it `FAILING` and shows "Verification failed" with the partner's reason |
| **Rotate secrets** | replaces **every** entry. The set goes back to `UNTESTED`, so verify it again |
| **Revoke** | withdraws the set for good. It needs a reason of 10 to 500 characters, which is recorded in the audit trail |

A `REVOKED` set has no actions. To replace it, create a new set.

### Creating a set
1. Choose the **Gateway** and the **Environment** (default `SANDBOX`).
2. Choose the **Owner**. Choosing **Platform** suggests `PLATFORM_CLEARING` as the settlement target. Choosing **Merchant** suggests `MERCHANT_DIRECT` and asks for the **Owning merchant**.
3. Optionally fill the **External merchant ID**: the merchant identifier at the partner.
4. Fill the **Credential entries**. Each row has a **Key**, a **Type** (`HEADER`, `QUERY`, `BODY` or `CERTIFICATE`), a value and a **Secret** switch that is on by default. You can have up to 40 entries. A key cannot be repeated with the same type.
5. Click **Create credential set**, then **Verify**.

The screen says "Verify it before it is trusted". An `UNTESTED` set does not make its route visible to customers. See [[a:b06-12|the visible-rails formula]].

### Rotating
**Rotate secrets** keeps your keys, types and secret switches, but every value is blank, because the old values cannot be shown. You must **type every value again**, not only the one that changed. If you leave one out, the form refuses.

:::danger Never type a secret anywhere else
Type secrets only into this form. Never paste them into chat, a ticket or an e-mail, and never take a screenshot of the form while it is filled. If you think a secret leaked, follow [[a:b10-07|A secret may have leaked]].
:::

:::note The two-person rule
[[a:b06-09|Credentials and Credential Sets]] says credential changes need two people. On this screen the buttons act immediately and are audited. Until that is settled, treat every action here as serious and check the gateway, the environment and the owner twice before you confirm.
:::
@@end

@@article id=b03-13 book=3 order=10 title="The Journal Entries screen: reading the ledger line by line" roles=FINANCE minutes=4 ui=AVAILABLE related=b08-01,b08-02,b08-05,b08-12
:::summary Big picture in 20 seconds
**Journal Entries** is the ledger opened for reading. Each row is one posting that moved money between accounts, and each shows whether its debits equal its credits. Nothing here can be edited. The two actions, **Run checkpoint rollup** and **Set shard count**, belong to an account, not to an entry.
:::

### Before you start
If double-entry is new to you, read [[a:b08-01|Double-entry bookkeeping from zero]] first. In short: every posting has lines, and the total of the **debit** lines must equal the total of the **credit** lines. The ledger is **append-only**. A mistake is corrected by a new entry, never by changing an old one.

### Opening the screen
It is in the **Finance** section. You need `profit.read` or `liquidity.read`. The screen is titled "Journal Entries" with the subtitle "Append-only double-entry postings of the ledger, with their balance check."

### The tiles
| Tile | Meaning | What to do if it looks bad |
| :--- | :--- | :--- |
| **Journal entries** | all entries ever posted | none; context |
| **Entries (24h)** | entries posted in the last day | none; context |
| **Volume posted (24h)** | the total of debit lines in the last day, per currency. With several currencies it says "N currencies" | none; context |
| **Unbalanced entries** | entries from the last 7 days whose debits and credits differ. The badge says **Passed** at zero and **Failed** otherwise | **Failed** is serious. Go to [[a:b08-05]] (the ledger equation) and runbook [[a:b10-05]] (RB-04) |

The tiles do not follow the filters.

### The table
Columns: **Entry ID**, **Reference type**, **Reference**, **Memo**, **Lines**, **Total debit**, **Total credit**, **Balance**, **Posted at** and **Actions**.
* **Reference type** says what caused the entry: `PAYMENT_ATTEMPT`, `ADJUSTMENT`, `AML_RELEASE`, `AML_VOID`, `SETTLEMENT_SWEEP`, `FEE_VARIANCE`, `COMMISSION_NETTING` or `DISPUTE_OUTCOME`. The postings are explained in [[a:b08-04|How each kind of payment is posted]].
* **Balance** says **Balanced** or **Unbalanced**. An entry with no lines at all counts as **Unbalanced**, because it is broken.
* Filters: **Reference type**, **GL account ID** and **Posted** (a date range).
* The newest entries come first. There is no Excel export.
* `?glAccountId=<id>` opens the screen already filtered to one account. **Ledger Audit & Invariant** links here that way. `?open=<id>` opens one entry.

### The entry drawer
Click a row to open **Journal entry**. It shows the entry's identity, **Reference type**, **Reference**, **Posted at**, **Memo** and **Currency**.

The **Double-entry lines** table is a T-account: **GL account**, **Currency**, **Debit** and **Credit**, with a **Totals** row. Each line has an amount on one side only, and credit lines are indented. Next to the badge you see **Σ Debits = Σ Credits**, or **Σ Debits ≠ Σ Credits** with the **Difference**.

The **Reference** is a link when the entry came from a payment, an adjustment, an AML case or a dispute. **Open record** takes you there. Other references stay as text.

### The GL account drawer
Click a **GL account** on any line to open that account. The account types are in [[a:b08-02|The eleven accounts]].
* **Natural balance** is the balance read the way that account type is normally read, so a credit-natural account is not shown as a confusing negative.
* **Checkpoint balance** is the total of the saved balances of all the account's shards. **Posted since last checkpoint** is what was added afterwards. The platform saves checkpoints **by itself** every few minutes, so you never have to do it for the numbers to be right.
* The badges at the top say how many shards the account is spread over ("16 shards wide") and whether its checkpoints are **up to date**, **behind** or **failed their proof**.
* **Shards** lists every part of the account. For each shard you see its **Balance**, its **Lines** (how many postings it has taken, counted without gaps), **Pending** (postings since its last checkpoint), its **Checkpoint** balance and **Checkpoint age**, and its **Status**. The **Total** row adds them up. A shard marked **not routed** no longer receives new postings but still counts.
* **Lines** lists every posting to the account, newest first, in pages. It has the same filters, search, totals and paging as the wallet **Statement** in [[a:b03-09|The Wallets screen and the wallet page]], and each line links back to its entry.
* Drawers open from drawers: an entry opens an account, and an account's lines open entries. The drawer you opened last is always the one on top.

### How checkpoints and shards work, in plain words
A busy account receives many postings at the same moment, and each shard can only take one posting at a time. So the platform splits a busy account into several **shards** and shares the postings between them. The account's balance is the total of its shards.

Each shard numbers its postings 1, 2, 3, … without skipping any number. A **checkpoint** records "this shard's balance was X after posting number N". Before the platform moves a checkpoint forward it **proves** two things: that every posting between the old and the new number really exists, and that the old checkpoint plus those postings equals the shard's balance. If the proof fails, the checkpoint stays where it was, a priority-1 case opens and the shard shows **GAP** or **PARITY** in its status.

When an account becomes very busy, a background process can give it **more shards**. This changes only where new postings go. Old postings and old balances stay where they are, so nothing is moved and nothing can be lost. Wallets start with one shard; the main platform accounts start with sixteen.

### The actions
Accounts with finance write access (`finance:write`) see two actions in the GL account drawer. Both are applied **immediately**, need a **Reason** of at least 10 characters, and are audited.
* **Run checkpoint rollup** checks every shard of the account right now and moves its checkpoint forward. Payments are not slowed down. A shard whose postings do not add up is **not** moved: the box names that shard and shows the **Shard total**, the **Journal total** and the **Drift**, or the number of postings it found against the number it expected. A refusal is a finding, not an obstacle. Do not retry it blindly: use **Repair** on that shard (see below) and report it as in [[a:b08-05|The ledger equation]].
* **Set shard count** tells the platform how many shards new postings are shared between (1 to 256). Making the number larger adds shards. Making it smaller only stops new postings going to the extra shards. Use it only when Engineering asks you to.

### Repairing a shard that failed its proof
A failed shard shows **GAP** or **PARITY** and a **Repair** button (for accounts with `finance:write`). The shard's balance is only a running total of the permanent journal lines, so the journal is always right. **Repair** works out the shard's balance again **from the journal** and shows you the correction **before** anything changes: the balance the shard holds, the balance the journal says, and the difference. It never creates a ledger entry, because a new entry would change the journal and leave the shard just as wrong.
* **Postings complete and in order** (usually **PARITY**: only the stored balance or checkpoint is off). **Recompute from journal** fixes it at once. It needs a **Reason**, is audited, and is refused if the shard changed since you looked. The platform also does this **by itself** when a shard has failed the check three times in a row, as long as the correction is small (up to 100.0000 by default). It never does it for a **GAP**.
* **A posting is missing or a number is used twice** (**GAP**). Recomputing could remove money the shard really holds, so the button becomes **Request approval**. A different user must approve it in **Approvals**. After approval the shard continues from its highest number and the damaged history is kept as a documented exception.
* If the journal itself is wrong, for example a payment was never booked, that is not a shard problem: correct it as an adjustment ([[a:b08-08|Adjustments]]), never by editing a shard.

:::tip Using the screen for a question
"Where did Noon Mart's 25.500 LYD go?" Open **Transactions & Webhooks**, find the payment, click its **Ledger entry**, and read the lines. Every payment you can name has an entry you can read.
:::
@@end

@@article id=b03-14 book=3 order=11 title="The Jobs & Outbox screen: is background work keeping up?" roles=SECURITY_ADMIN minutes=4 ui=AVAILABLE related=b12-08,b07-05,b10-01,b03-05
:::summary Big picture in 20 seconds
**Jobs & Outbox** shows whether the platform's background work is keeping up: events waiting to be published, audit records waiting to be shipped, background jobs and failed notifications. Two of its tabs are monitors only. On the other two you can put a failed item back in the queue.
:::

### Why this screen exists
Much of the platform's work happens after you click: a payment's events are published, audit records are shipped to the audit store, reconciliations and adjustments run in the background, and messages go out to people. If a worker falls behind, nothing breaks loudly. Items just wait. This screen makes the waiting visible. Background workers are explained in [[a:b12-08|The database, timers and workers]].

### Opening the screen
It is in the **Operations** section. You need the authority `security:read`. To **Re-queue** or **Retry** you also need `security:write`. Without it you see **—** in the **Actions** column. The page is titled **System Jobs & Outbox**.

### The tiles
| Tile | Meaning | What to do if it looks bad |
| :--- | :--- | :--- |
| **Unpublished outbox events** | events saved but not yet published. It shows the age of the oldest | see the badge colours below |
| **Audit outbox queued** | audit records waiting to be shipped, with the age of the oldest | the same |
| **Background jobs (24h)** | jobs created in the last day, with how many are queued, running and succeeded | none; context |
| **Failed jobs (24h)** | jobs that failed in the last day. **Review** when above zero, **Clear** at zero | open the **Background jobs** tab |
| **Failed notifications** | all-time count of notifications that failed. **Review** or **Clear** | open the **Notifications** tab |

The two backlog tiles carry a badge: **Healthy** when nothing waits, **Draining** while something waits but the oldest item is under 15 minutes old, and **Backlog** (red) when the oldest item is older than 15 minutes. A **Backlog** that does not go away means a worker is stuck. Tell Engineering and follow [[a:b10-01|Incident principles]].

### Four tabs
Open one directly with `?tab=outbox`, `?tab=audit`, `?tab=jobs` or `?tab=notifications`.

**Transactional outbox** (monitor only). When the platform saves a business change, it also saves an *event* in the same step, so the two cannot disagree. A worker then reads these events and updates the dashboards. Columns: **Event**, **Topic**, **Aggregate**, **Aggregate ID**, **Merchant**, **Status**, **Age**, **Created** and **Published at**. Status is **Published** or **Unpublished**.

**Audit outbox** (monitor only). Audit records waiting to be copied to the audit store and added to its tamper-evident chain. Columns: **Record**, **Action**, **Entity type**, **Entity ID**, **Actor role**, **Status**, **Lease until**, **Created** and **Shipped at**. Status is **Shipped** or **Queued**. Before-and-after data and the actor's e-mail are never shown. See [[a:b04-07|Audit trails]].

**Background jobs.** Columns: **Job**, **Type**, **Reference**, **State**, **Attempts**, **Available at**, **Last error** and **Actions**. The types are `RECONCILIATION_RUN` and `ADJUSTMENT_EXECUTION`. The states are `QUEUED`, `RUNNING`, `SUCCEEDED` and `FAILED`. **FAILED means the job used all its attempts and will not run again by itself.**

**Notifications.** The table is titled **Failed notifications** and shows only failed ones until you change **Status** to see all. Columns: **Notification**, **Template**, **Channel**, **Language**, **Recipient** (masked), **Status**, **Attempts**, **Next attempt** and **Actions**. Channels are `SMS`, `EMAIL` and `IN_APP`. Statuses are `QUEUED`, `SENT`, `DELIVERED`, `FAILED` and `SUPPRESSED`.

Every tab has its own filters and the newest rows first.

### What you can do
| Action | On | What happens |
| :--- | :--- | :--- |
| **Re-queue** | a `FAILED` background job | puts the job back in the queue with its attempts reset to zero. Refused if the job is not `FAILED` |
| **Retry** | a `FAILED` notification | queues the notification again for delivery. Refused if it is not `FAILED` |

Both are **immediate**, need no second person, ask for a **Reason** of at least 10 characters and are audited.

There is **no retry** on the two outbox tabs. The screen says: "This is a monitor: the worker republishes events itself, there is nothing to retry by hand." If the numbers do not fall, the fix is in the worker, not in this screen.

:::warning Find out why before you re-queue
A job that failed may fail again for the same reason. Read the **Last error** first. If you do not understand it, ask Engineering before you click **Re-queue**.
:::
@@end


@@article id=b03-15 book=3 order=15 title="Reports: the catalog, the studio and shared headers and footers" roles=SECURITY_ADMIN,FINANCE,COMPLIANCE,OPERATOR minutes=4 ui=AVAILABLE related=b03-13,b03-14,b12-08
:::summary Big picture in 20 seconds
The Reporting section has four screens. **Report Catalog** runs a published report and prints or exports it. **Report Studio** verifies a report definition written by an AI, previews a draft and publishes it. **Headers & Footers** stores the reusable page chrome. **Merchant Reports** lets staff review merchant-authored reports, their execution history and suspend a merchant's Studio. A report is declarative: it never contains raw SQL, and every query runs read-only.
:::

### Why reports are separate from dashboards
A dashboard shows a live summary. A report is a document: it has a title, a period, a language, a page header and footer, and a verification hash. You can print it as a vector PDF or export its data. The report engine executes only the declarative query definition that was verified and published. It cannot write to the database.

### Report Catalog
Open **Reporting → Catalog**. Only reports your role can run are listed. Choose a report, fill its inputs in the side panel, choose the output language and any header/footer, then click **Generate Report**. The preview shows the exact paginated pages; **Print** opens the browser's vector PDF dialog and **Export Excel** downloads one sheet per dataset. If the report has a merchant input, the merchant is chosen there; a merchant report generated for a merchant is limited to that merchant's data.

### Report Studio
Open **Reporting → Studio**. First download the AI transcript. It contains the live schema, the allowed query vocabulary and the bilingual rules. Give it to the external AI, then paste the JSON it returns and verify it. The scorecard shows five layers: schema and translations, query safety and partition pruning, authority inference, asset and HTML safety, and a read-only dry run. If a layer fails, copy the repair prompt back to the AI. When everything passes, generate a draft preview, then save it as verified or publish it. A conflict between domains is shown as a warning; a Security Admin can attach an authority override with a written justification.

### Headers & Footers
Open **Reporting → Headers & Footers**. A header or footer is its own reusable spec with a bilingual template and optional logo assets. Only one published header and one published footer can be the global default. A report can use the global default, a specific registered chrome, an inline template, or none.

### Merchant Reports
Open **Reporting → Merchant Reports** to review the reports merchants authored in their own Studio. Each row names the merchant and report, and **Executions** shows that merchant's run history. With `security:write`, **Suspend Studio** immediately blocks that merchant's runner and Studio until **Resume Studio** is used. The platform-wide switch and whether merchants may attach asset bundles are the `merchant_reports.policy` setting in **Platform Settings**.

### Safety rules
* A report spec never contains raw SQL; the engine compiles the declarative query.
* `journal_lines` queries must include a bounded `created_at` range.
* Credential ciphertext, password hashes and other forbidden secrets are never selectable.
* A merchant-facing report must be filtered by the merchant scope input on every merchant-scoped model.
* Report execution is recorded with the actor, language, row count, duration and verification hash.

:::tip If a report will not run
Read the diagnostic code and its **How to fix** line. Do not edit the JSON by guesswork. In the Studio, the same diagnostic is available as a copyable repair prompt for the AI.
:::
@@end

@@article id=b03-06 book=3 order=12 title="Safe-working habits that prevent most mistakes" roles=ALL minutes=1 ui=AVAILABLE related=b00-03,b04-06
1. **One task at a time.** Finish or deliberately park the current item before opening another. Most wrong-merchant, wrong-amount mistakes happen when two tabs are open.
2. **Read the whole line before you click.** Merchant name, amount, currency, environment badge, status.
3. **Say it out loud (or in your head) in one sentence** before approving: "I am approving a 250.000 LYD refund to merchant X because the original payment was duplicated."
4. **Use the "?" drawer and the checklist.** The checklist exists for exactly this moment.
5. **Write the reason first.** If you cannot write a real reason, you are not ready to act.
6. **No half-finished decisions at shift end.** Leave a handover note (Book 10).
7. **Never act on chat or phone instructions alone.** Ask the person to raise the request in the proper screen so it has an audit trail.
8. **When you notice an error, report it at once.** Reporting quickly is never punished; hiding is.
9. **Do not test on live.** Use sandbox or the Academy labs.
10. **Take breaks.** Fatigue is the largest cause of clicking the wrong row.
@@end

@@article id=b03-07 book=3 order=13 title="When a button is missing or an action is refused" roles=ALL minutes=2 ui=AVAILABLE related=b02-02,b03-02
| What you see | Likely reason | What to do |
| :--- | :--- | :--- |
| A menu item is missing | You do not have the authority. | Ask your manager. Do not ask a colleague to share their account. |
| A button is disabled | Wrong state (already decided) or missing authority or you are the maker. | Read the status chip; read the tooltip. |
| "Forbidden" or `403` | The core refused: role, authority, or two-person rule. | Do not retry. Ask the Security Admin. |
| "Session expired" / sent to login | Short session or signed out elsewhere. | Sign in again. Re-check what you were doing; nothing is saved automatically. |
| "The request is out of date" | Someone changed the item after the request was made (`base_version` mismatch). | The maker must create a new request from the current values. |
| An approval expired | Requests last seven days. | The maker re-submits if still needed. |
| "Cannot approve your own request" | Two-person rule. | Ask a different checker. |

:::warning
Never try to "work around" a refusal by using another person's session, changing the URL, or asking someone else to approve without reading. That is a serious conduct breach.
:::
@@end

@@article id=b03-08 book=3 order=14 title="Features that are only partially available" roles=ALL minutes=1 ui=PARTIAL related=b04-05
Almost every Back Office control now has a screen. One area is still partial:

| Capability | Status | What to do today |
| :--- | :--- | :--- |
| Statement source creation (the columns of a partner statement) | partial | Finance edits an existing source in **Reconciliation**; a new source is created through engineering |

:::note
If a screen changes, this article is updated. If an article elsewhere tells you to click something that is missing, treat it as this article's topic and ask.
:::
@@end

### BOOK 4 — GOVERNANCE: FOUR EYES

@@article id=b04-01 book=4 order=1 title="Why two people: the maker and checker rule" roles=ALL minutes=2 ui=AVAILABLE related=b04-02,b04-03,b00-03
:::summary Big picture in 20 seconds
For risky changes, one person proposes and a different person decides. This protects the company and protects you. The system enforces it three times, so one person can never approve their own request.
:::

Some company cheques need two signatures. One person cannot sign them alone. The platform uses the same idea for the most sensitive work.

### The idea
Some work is sensitive. It moves money, changes who gets money, or changes how risky payments are handled. For this work, **one person proposes (the maker) and a different person decides (the checker)**. This is called the **four-eyes principle**.

### A short example
Layla asks Noon Mart for a refund of 25.500 LYD. Ali, an operator, proposes the refund. He is the maker. Huda from Finance reads the request and decides. She is the checker. Ali cannot approve his own refund, and he cannot ask Huda to approve it without reading it.

### Why it protects you as much as the company
* Honest mistakes are caught by a second pair of eyes.
* Nobody can quietly steal or bend the rules alone.
* If something later goes wrong, it is clear who proposed and who approved. It is also clear **what they were told**.

### How it is enforced: three independent layers
Three separate checks stop self-approval. If one fails, the next still holds.
1. The database refuses a request whose checker equals its maker.
2. The approval service checks it again in code.
3. The API middleware checks it a third time, regardless of what the screen sends.

:::danger Self-approval is impossible by design and forbidden by conduct
Trying to approve your own request is a serious breach. Asking a colleague to approve it unseen is a serious breach too. This is true even though the system will block the first attempt.
:::
@@end

@@article id=b04-02 book=4 order=2 title="Descriptive versus sensitive fields" roles=ALL minutes=2 ui=AVAILABLE related=b04-03,b05-06
:::summary Big picture in 20 seconds
Not every edit needs a second person. A change to a harmless detail, such as a display name, is applied directly and logged. A change that touches money, compliance or security needs a maker and a checker.
:::

Not every edit needs a second person. The system splits all fields into two classes, and the class decides the path of the change.

* **Descriptive** fields are harmless to money and risk. Examples are a trade name, a logo and a display name. You edit them directly, and the change is still recorded.
* **Sensitive** fields change the money flow, the compliance posture or the attack surface. The attack surface is everything that an attacker could try to use. A sensitive change needs a maker and a checker.

### An example with Noon Mart
Ali changes Noon Mart's display name. The name is **descriptive**, so the change is saved at once and logged.

Then Noon Mart asks to change its **payout bank details**, the bank account where cash-outs go. This field is **sensitive**. Ali proposes the change as the maker. A checker must approve it before it takes effect. Until then, the old bank details stay in force.

### The table of fields
Find the entity in the first column. The second column lists the fields you may edit directly. The third column lists the fields that need approval. A dash means that there is nothing in that class.

| Entity | Descriptive (direct, logged) | Sensitive (approval needed) |
| :--- | :--- | :--- |
| Merchant | trade name, display name, logo, support contact; contact phone/e-mail (after verifying the new value) | legal name, tax ID, registration no., business category, **payout bank details**, risk tier, KYB status override, commission-receivable ceiling, negative-balance ceiling, status |
| Application | name, description; expected volume (a big increase opens a review case) | **assigned wallet, rail whitelist, redirect-domain allow-list**, resuming after a platform pause |
| Wallet | — | status (currency can never change) |
| Staff user | name, language, notification preferences | role, authorities, maker/checker flags, application scope |
| Access token | create (needs fresh sign-in), revoke (immediate) | disabling the IP allow-list |
| POS | names, locations | — |

### What a pending sensitive change does
:::note
A pending sensitive change leaves the **current value in force** until it is approved and executed. Approved changes apply to **new** payments only. Payments already in progress keep the configuration they started with.
:::
@@end

@@article id=b04-03 book=4 order=3 title="The life of an approval request" roles=ALL minutes=2 ui=AVAILABLE related=b04-06,b03-07
:::summary Big picture in 20 seconds
An approval request is drafted by a maker with an exact before-and-after diff and a reason. A different checker then approves or rejects it. Approving executes the change in the same step, so an approved request never hangs.
:::

An approval request is a formal question: "May we make this change?" It travels through a few states, and each state tells you who must act next.

### The path of a request
The diagram shows the states. Read it from left to right. A request starts as a draft and goes to review. It is then executed, or rejected. After a rejection the maker may re-draft it.

```diagram
DRAFT ──submit──► PENDING_REVIEW ──checker approves──► APPROVED ──executes atomically──► EXECUTED
   ▲                    │
   └────── REJECTED ◄───┘ (checker rejects with a reason; maker may re-draft)
```

### What each person does
* **Maker** creates a request. It holds a *diff* and a reason. A diff shows exactly what would change, from the old value to the new value.
* **Checker** sees the diff, the reason and the field class. Approving **executes the change in the same step**, so an approved request never "hangs".
* **Rejecting** requires a written reason. The maker sees it.
* **Withdrawing:** the maker may withdraw before a checker acts.

### When a request stops being valid
* **Stale requests:** the item may change after the request was drafted. Then its `base_version` no longer matches. The request is invalidated and returns to draft. This stops an old request from silently overwriting a newer change.
* **Expiry:** pending requests expire after 7 days and return to draft.

### A worked example
Ali drafts a request to change Noon Mart's payout bank details. The diff shows the old account and the new account. His reason says that the owner asked by phone. The request is now `PENDING_REVIEW`. Huda from Finance opens it, compares the old and new values and approves. The new bank details take effect in the same step. If Huda had rejected it, she would have written a reason, and Ali would see it.

### What you see on the Approvals screen
On the **Approvals** screen you see the requests that are waiting for a checker. Each row shows the **Maker**, the subject and the **Details**. The buttons are **Approve** and **Reject**, and a **Decision Reason** field goes with them.

:::do Before you approve
Open **Details**. Compare old and new values. Check that the maker's reason makes sense. Check the merchant name, amount and currency. Then open the checklist [[c:sg-approve-request|Approve a request from another person]].
:::
@@end

@@article id=b04-04 book=4 order=4 title="Emergency actions, ratification and the asymmetry principle" roles=ALL minutes=2 ui=AVAILABLE related=b05-08,b09-06
:::summary Big picture in 20 seconds
Actions that reduce risk may happen at once and be approved afterwards. Actions that increase risk or move money always need approval first. An emergency suspension must be reviewed within 24 hours.
:::

Most changes wait for a second person. But sometimes waiting is the danger. Imagine that you see signs of fraud at a merchant. You should be able to stop the risk now and let a second person review it afterwards. You should never be able to start a risk or move money without approval.

### The asymmetry principle
The word "asymmetry" means that the two directions are not treated the same. Reducing risk is fast. Increasing risk is slow and checked.

> Actions that **reduce risk** may happen immediately and be approved afterwards. Actions that **increase risk or move money** always need approval first.

Read the table by columns. The left column lists actions that make the platform safer. The right column lists actions that make it riskier or move money.

| Reduces risk (may be immediate, then ratified) | Increases risk or moves money (approval first) |
| :--- | :--- |
| suspending a merchant | reinstating a merchant |
| tightening an AML or velocity rule | loosening a rule |
| pausing a route | releasing held money |
| | paying a cash-out; refunds; adjustments |

To **ratify** means to review an action that already happened and confirm it. The first column is "act now, ratify later". The second column is "approve first, act later".

### Emergency suspension
An authorised user may suspend a merchant at once. The system then creates a request in **emergency ratification** mode. An `MLRO` or a *different* `COMPLIANCE` user must review it within **24 hours**.

If nobody ratifies in time, alerts fire and the suspension **stays in force**. The system fails safe, never open. It is never reversed automatically.

### An example
Omar sees strong signs of fraud at Noon Mart and suspends it at once. Noon Mart stops being paid. The system asks the `MLRO` or another `COMPLIANCE` user to review the suspension within 24 hours. Reinstating Noon Mart later is the opposite direction. That needs approval first.

:::warning
"Immediate" does not mean "casual". Suspension stops a business from being paid. Use it when delay is the hazard, write the reason, and expect your decision to be reviewed.
:::
@@end

@@article id=b04-05 book=4 order=5 title="Who approves what: the four-eyes action matrix" roles=ALL minutes=3 ui=AVAILABLE related=b04-01,b03-02
:::summary Big picture in 20 seconds
This table shows, for each sensitive action, who usually proposes it, who must approve it and what happens next. Use it to find the right checker. Your own account switches decide what you can really do.
:::

When you must approve or propose something, you ask three questions. Who usually proposes it? Who must approve it? What happens when it is approved? The table answers all three, one action per row.

### How to read the table
* **Action** is what is being done.
* **Typical maker** is the role that usually proposes it. The maker is the person who asks for the change.
* **Required checker** is the role that must approve it. The checker must be a different person from the maker.
* **Effect** is what the system does after approval.

Role names such as `FINANCE` and `MLRO` are explained in [[a:b03-02|Your account: roles and authorities]].

### A worked example: who approves what
**Example 1: a refund.** Layla returns the phone case. Ali, an operator, drafts a refund of 25.500 LYD. Find "Adjustment: refund..." in the table. The maker may be `FINANCE` or `OPERATOR`, so Ali may propose it. The checker must be `FINANCE`, and a different person. So Huda approves. The effect is that a journal entry is posted.

**Example 2: an AML case.** Omar from `COMPLIANCE` wants to release a held payment. Find "AML case resolution". The required checker is `MLRO`, so the case goes to the `MLRO`. Omar cannot approve his own request. The effect is that a ledger entry is posted.

### The matrix
| Action | Typical maker | Required checker | Effect |
| :--- | :--- | :--- | :--- |
| Adjustment: refund, chargeback, manual credit/debit, correction | FINANCE, OPERATOR, or the system (for chargeback drafts) | FINANCE (a different person) | journal entry posted |
| Cash-out marked complete → subtracted | FINANCE | FINANCE (different person) | wallet reduced |
| Commission profile create/change | FINANCE | FINANCE or SECURITY_ADMIN | new version effective from a date |
| Sensitive merchant fields | OPERATOR, COMPLIANCE, MERCHANT_ADMIN (request) | COMPLIANCE or FINANCE, by field | field updated, logged |
| Sensitive application fields | MERCHANT_ADMIN or OPERATOR | OPERATOR (different) or COMPLIANCE for risk | applies to new payments |
| Velocity / AML rule change | COMPLIANCE, FINANCE | SECURITY_ADMIN/FINANCE for velocity; MLRO for AML | new rule version |
| AML case resolution (release/void/freeze) | COMPLIANCE | MLRO | ledger entry posted |
| Regulatory report submission | COMPLIANCE | MLRO | report frozen, marked submitted |
| Join request decision | OPERATOR or COMPLIANCE | per the four-eyes policy (see Merchants) | merchant activated or rejected |
| Merchant suspension | OPERATOR, COMPLIANCE | emergency: immediate, ratified within 24 h by MLRO or another COMPLIANCE | merchant suspended |
| Merchant reinstatement | OPERATOR, COMPLIANCE | COMPLIANCE or MLRO (different), never emergency | merchant active |
| Gateway version going LIVE; credentials, routes, payout-bank edits | GATEWAY_ADMIN | SECURITY_ADMIN | version promoted, security alert |
| Staff account / role / authority change | SECURITY_ADMIN | a different SECURITY_ADMIN | permissions re-read on the next request; a disabled account is refused |
| Compliance platform settings | COMPLIANCE, FINANCE | MLRO or SECURITY_ADMIN | new setting version |

:::note
Your real ability to act as maker or checker depends on the switches on your own account, not only on this typical table. See [[a:b03-02|Your account: roles, authorities and the switches]].
:::
@@end

@@article id=b04-06 book=4 order=6 title="Writing a reason that survives an audit" roles=ALL minutes=2 ui=AVAILABLE related=b04-03,b04-07
:::summary Big picture in 20 seconds
A reason is read months later by people who were not there. Write what you checked, what you found, what you decided and why. Never put passwords or personal numbers in it.
:::

A reason is read months later by people who were not there: auditors, regulators, your successor, and sometimes you. An **audit** is a later check that looks at what happened and why. Write your reason so that a stranger can understand it.

### The four parts of a good reason
A good reason has four parts: **what you checked**, **what you found**, **what you decided** and **why**.

Here is one reason built from the four parts. "I checked the partner statement of 30 Oct" is what you checked. "The line for ref PA-7712 shows 100.000 settled" is what you found. "Marking resolved" is what you decided. "It matches our attempt" is why we can mark it resolved.

### Weak and strong reasons
Read each row from left to right. The weak reason leaves a stranger with questions. The strong reason answers them.

| Weak | Strong |
| :--- | :--- |
| "ok" | "Checked partner statement of 30 Oct: line for ref PA-7712 shows 100.000 settled. Matches our attempt. Marking resolved." |
| "as requested" | "Merchant asked by phone (call logged ticket 4471) to change payout account; new account letter attached and in merchant's legal name. Submitting for approval." |
| "customer paid" | "Customer sent bank transfer receipt; statement line not yet visible; keeping case open until next statement import on 1 Nov." |
| "rejected" | "Rejected: the new bank account is in a different person's name; no related-party documentation attached." |

:::dont Do not include
Passwords, one-time codes (OTPs), full card numbers and national ID numbers. For anti-money-laundering (AML) matters, never write anything that a merchant could later read. The platform keeps AML notes confidential, but never write more than you need.
:::
@@end

@@article id=b04-07 book=4 order=7 title="Audit trails: what is recorded about every action" roles=ALL minutes=2 ui=AVAILABLE related=b04-06,b11-03
:::summary Big picture in 20 seconds
Everything you do that changes something is recorded in three independent places: the audit log, the detail change log and the approval requests. Payment activity has its own trail as well. The audit log cannot be edited.
:::

An audit trail is the footprints you leave when you work. Anyone with the right access can follow them later and see what happened, who did it and why. Knowing this helps you work with care.

### The three places
Everything you do that changes something is recorded in three independent places:

* **Audit log**: who (user and role), what action, which object, the state before and after, the linked approval request, and when. It cannot be edited.
* **Detail change log**: for every changed field, the old value and the new value, who, when, and from which route (portal, admin, API or system). It also holds the request id and the IP. Support uses it to answer "what did this field say last month?". Secrets and national IDs are stored encrypted and shown masked.
* **Approval requests**: the maker, the checker, the reasons, the diff and the timing.

### An example
Ali changes Noon Mart's display name. The detail change log keeps the old name and the new name, with Ali's name, the time and the route. Next month someone asks, "What did the name say last month?" Support can answer from that log.

### The payment trail
Payment activity has its own forensic trail. A forensic trail is a record that can be used to investigate later. Every outbound call to a partner is logged, with secrets scrubbed. Every inbound webhook is stored *before* processing and is never deleted.

:::note Searching these logs
The **Audit Log** screen lets `SECURITY_ADMIN` filter by actor, action, object and date and export the result. Ask the Security Admin if you need an audit extract.
:::
@@end


### BOOK 5 — MERCHANTS

@@article id=b05-01 book=5 order=1 title="What a merchant is: states, risk tiers and what each state allows" roles=ALL minutes=4 ui=AVAILABLE related=b05-02,b05-08,b02-04
:::summary Big picture in 20 seconds
A merchant is a business we have checked and allowed to take payments. It is always in exactly one state (`PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED` or `CLOSED`), and the state decides whether payments, cash-outs and API keys work.
:::

### A merchant is a checked business
Think of Noon Mart, an online shop. Before it can sell through us, we check who owns it and what it sells. After we approve it, Noon Mart is a **merchant** on the platform.

Everything Noon Mart owns on the platform hangs under one merchant record: wallets, applications, payment links, staff accounts and API keys. When you look up a merchant on the **Merchants** screen, you are looking at the root of all of it.

### The five lifecycle states
A merchant is always in exactly one state. The state is the answer to a simple question: "What may this business do right now?"

The first table shows how a merchant gets each state, and what happens to its balance.

| State | When a merchant gets it | Balance |
| :--- | :--- | :--- |
| `PENDING` | Registered, not yet approved. | None. |
| `ACTIVE` | Join request approved. | Normal. |
| `SUSPENDED` | A staff member suspended it (reasons below). | Kept, but frozen for payout. |
| `REJECTED` | Join request rejected. | None. |
| `CLOSED` | Merchant asked, or we decided, after the balance reached zero and no dispute is open. | Must be zero; closure is refused otherwise. |

The second table shows what each state allows. A **cash-out** is a request to move the merchant's wallet balance into its real bank account.

| State | New payments | Payments already in progress | Cash-out | API keys and POS |
| :--- | :--- | :--- | :--- | :--- |
| `PENDING` | Blocked on `LIVE`; allowed on `SANDBOX` if the platform setting allows it (default: allowed). | None. | Blocked. | `SANDBOX` only. |
| `ACTIVE` | Allowed. | Normal. | Allowed. | Allowed. |
| `SUSPENDED` | Blocked. | See the note below the table. | Blocked. | API keys return a generic error; POS screens show a neutral message. |
| `REJECTED` | Blocked. | None. | None. | None. |
| `CLOSED` | Blocked. | Must be zero. | One final payout, then blocked. | Revoked. |

For a `SUSPENDED` merchant, payments that were already confirmed are posted according to compliance policy. Payments that are still pending finish on the configuration they started with.

Every suspension carries one reason code. The codes are `AML` (anti-money-laundering), `FRAUD`, `KYB_EXPIRED`, `COMMISSION_CEILING`, `MERCHANT_REQUEST` and `OTHER`.

:::note Words that look similar
**`PENDING`** is a merchant state. **`PENDING_REVIEW`** and **`PENDING_CHECKER`** are approval states. They are different things on different screens. See [[a:b13-02|Every status in one place]].
:::

### KYB status: has the business been checked?
**KYB** (Know Your Business) is the checking of a business. Every merchant has a **KYB status** that is separate from its lifecycle state. The values are `UNVERIFIED`, `PENDING`, `VERIFIED` and `REJECTED`.

A merchant becomes `VERIFIED` only when two things are true. Every *required* document is accepted, and every beneficial owner has been screened and cleared (or a person has recorded a decision on each possible match). Changing this status by hand is a **sensitive** edit and needs two people. The rule is explained in [[a:b04-02|Descriptive versus sensitive fields]].

### Risk tier: how risky is this business?
The **risk tier** is our own judgement of how risky a business is. The values are `LOW`, `STANDARD` and `HIGH`. A higher tier means stricter rules: lower hold thresholds, shorter review deadlines and more frequent KYB refreshes.

The reviewer proposes the tier during onboarding. Changing it later is a **sensitive** edit.

### Two ceilings you will see
A ceiling is a limit that we set for a merchant.
* **Commission-receivable ceiling**: for merchants who receive money directly, the most commission we allow them to owe us before action is needed. Direct receipt is explained in [[a:b08-10|Settlement]].
* **Negative-balance ceiling**: how far below zero a merchant's wallet may go after a refund or chargeback. The default for new merchants is `0`, which means the wallet may not go negative. See [[a:b08-13|Negative balances and ceilings]].
@@end

@@article id=b05-02 book=5 order=2 title="The onboarding journey and the join request state machine" roles=ALL minutes=5 ui=AVAILABLE related=b05-03,b05-04,b02-04
:::summary Big picture in 20 seconds
Onboarding is eight stages, from the public landing page to the first live payment. The join request moves through review states, may pause for more information, and can need a second person to approve.
:::

### The story in one paragraph
Noon Mart, an online shop, wants to take payments through us. Its owner opens our public page, registers and fills in the business details. Then the owner submits the application. A reviewer checks it and either approves it, rejects it or asks for more information. When Noon Mart is approved, it can start to set up and take live payments.

### The eight stages
Two short terms first. KYB means Know Your Business: the checking of a business. SLA means service-level agreement; here it is the time limit for the review.

The table shows the stages in order. The last column shows what the system writes down at each stage.

| # | Stage | What happens | What the system records |
| :-- | :--- | :--- | :--- |
| 1 | Landing | The public page explains the product and has a **Start Now** button. Existing merchants sign in from the same page. | nothing |
| 2 | Register or sign in | The applicant registers with a phone number, an e-mail address or a Google account and must verify it. | a user and an identity |
| 3 | Business profile and KYB | The applicant enters business details, uploads documents and declares owners. | merchant (`PENDING`), documents, owners |
| 4 | Submission | The applicant submits. A **join request** is created, a review deadline (SLA) starts and an automatic screening is queued. | join request, screening |
| 5 | Review | A reviewer checks identity, documents and screening against a checklist. The reviewer may ask for more information, which pauses the clock. | join request status |
| 6 | Decision | Approve or reject. Some decisions need a second person. | join request, approval request |
| 7 | Notification | The applicant is told by SMS and/or e-mail in their language. | notification |
| 8 | First sign-in and setup | An approved merchant creates wallets, applications and payment links. Live traffic starts only when the merchant is `ACTIVE`. | merchant (`ACTIVE`) |

### What a join request is
A **join request** is the formal record of one onboarding attempt. A merchant can have several over time. For example, one may be rejected and a corrected one sent later. But **only one may be open at a time**.

### The join request states
A join request is always in one state. The table says what each state means for the applicant and for the reviewer.

| State | Meaning |
| :--- | :--- |
| `DRAFT` | The applicant is still filling it in. |
| `SUBMITTED` | Sent in; waiting for a reviewer. |
| `IN_REVIEW` | A reviewer is working on it. |
| `INFO_REQUESTED` | The reviewer asked the applicant for something. **The clock is paused.** |
| `PENDING_CHECKER` | A reviewer decided, and a second person must confirm (four-eyes). |
| `APPROVED` | Done; the merchant is activated. |
| `REJECTED` | Done; the applicant is told, in neutral words. |
| `WITHDRAWN` | The applicant cancelled it. |
| `EXPIRED` | Nothing happened for 30 days. |

The diagram shows the moves between states. Read it from left to right. From `IN_REVIEW`, the reviewer can take one of four ways out.

```diagram
DRAFT → SUBMITTED → IN_REVIEW ─┬─ approve (no second person) ───────────► APPROVED
                       ▲       ├─ approve (second person needed) ─► PENDING_CHECKER ─┬─► APPROVED
                       │       │                                                      └─► IN_REVIEW (checker returns it)
                       │       ├─ reject ───────────────────────────────────────────► REJECTED
              applicant│       └─ request information ─► INFO_REQUESTED ─► (applicant answers) ─► IN_REVIEW
              answers  │
        withdraw at any open stage ─► WITHDRAWN        30 days of inactivity ─► EXPIRED
```

### An example path
This is an example, not a real case. Noon Mart submits, and the request becomes `SUBMITTED`. A reviewer opens it and the state becomes `IN_REVIEW`. The reviewer sees that the bank letter is not signed and asks for a signed one. The state becomes `INFO_REQUESTED` and the clock stops. Noon Mart uploads the signed letter, the state goes back to `IN_REVIEW`, and the clock starts again with a recomputed deadline. The reviewer approves. If the system says a second person is needed, the state becomes `PENDING_CHECKER` first. After the second person confirms, it becomes `APPROVED`.

### Rules worth memorising
1. Only one open join request per merchant.
2. `INFO_REQUESTED` pauses the deadline. The deadline is recomputed when the applicant answers.
3. The default review deadline is **2 business days** for `LOW` or `STANDARD` proposed risk and **5 business days** for `HIGH`.
4. The applicant sees only the status and the information we asked for. **Reviewer notes and screening results are never shown to the applicant.**
5. A rejection carries a reason code from a fixed list. Examples are `INCOMPLETE_DOCUMENTS`, `UNVERIFIABLE_BUSINESS`, `PROHIBITED_ACTIVITY` and `POLICY`. Any code that could reveal a screening outcome is shown to the applicant as the neutral code `POLICY`.
6. A rejected applicant may apply again only after fixing the cause. A new request is linked to the old one, and duplicate checks apply. See [[a:b05-10|Re-application, duplicate detection and periodic KYB refresh]].
7. When approval needs a second person, approving and the second person's approval happen as one action. So an approved request never "hangs" half-done.
@@end

@@article id=b05-03 book=5 order=3 title="Working the Join Requests queue, step by step" roles=OPERATOR,COMPLIANCE minutes=6 ui=AVAILABLE related=b05-04,b05-05,b04-05
:::summary Big picture in 20 seconds
A reviewer completes seven checks on each join request, then chooses one of four actions. The system, not the reviewer, decides whether a second person must also approve.
:::

This article is for reviewers. You use the **Join Requests** screen. Each line in the queue is a business that wants to become a merchant.

### Before you start
* Check the **SANDBOX/LIVE** badge. Join requests concern real businesses, so you should be on the live side.
* Check the deadline column. Work the requests closest to their deadline first, but never skip a check to save time.

### The seven checks (you must complete all seven)
Work down the table in order. The last column tells you what a good result looks like.

| # | Check | How to do it | What "good" looks like |
| :-- | :--- | :--- | :--- |
| 1 | Applicant identity verified | Open the applicant's contact details; confirm the phone or e-mail was verified at registration. | Identity shows as verified. |
| 2 | Business exists and is registered | Open the documents; compare names and numbers on the commercial registry certificate and tax certificate with the profile the applicant typed. | Legal name, registration number and tax ID agree everywhere. |
| 3 | Beneficial owners identified | Compare the declared owners with the articles of association. Anyone holding 25% or more (the default threshold) must be listed, and so must anyone who controls the business. | Every owner and controller is present and each has an identity document. |
| 4 | Screening result reviewed | Read the overall screening result. | `CLEAR`, or a possible match that Compliance has already decided. See [[a:b05-05]]. |
| 5 | Category and volume make sense | Compare the business category and expected monthly volume with the description of what is sold. | A bakery expecting a small monthly volume; not a bakery expecting the volume of a bank. |
| 6 | Payout account belongs to the business | Open the bank letter; the account holder must be the merchant's legal name (or a documented related party). | Names match. A mismatch forces a second person to approve, whatever the policy. |
| 7 | Risk tier proposed | Choose `LOW`, `STANDARD` or `HIGH` from what you saw. | A tier you can justify in one sentence. |

A **beneficial owner** is a real person behind the business. **Screening** is the automatic comparison of names with sanctions and other lists. The next article, [[a:b05-04|KYB documents and beneficial owners]], covers owners in detail.

### An example review
This is an example. Ali, an operator, opens the join request from Noon Mart. The registry certificate, tax certificate and profile all show the same legal name (check 2). The screening result is `CLEAR` (check 4). But the bank letter shows an account holder with a different name (check 6). Ali cannot approve alone: a mismatch forces a second person to approve. If Ali approves, the request moves to `PENDING_CHECKER`. Ali can also ask Noon Mart for a corrected letter. If he asks, he writes only "the bank letter does not match the legal name". He does not mention screening.

### Your four possible actions
1. **Request information.** Write exactly what is missing (for example "the bank letter is not signed"). Do not mention screening. The deadline pauses until the applicant answers.
2. **Reject.** Choose the reason code and write an internal note. See [[a:b04-06|Writing a reason that survives an audit]]. Open the checklist [[c:sg-reject-join-request|Reject a join request]] first.
3. **Approve.** Open the checklist [[c:sg-approve-join-request|Approve a join request]] first. If the system says a second person is needed, the request moves to `PENDING_CHECKER`.
4. **Hand over.** If you cannot finish, leave a note and release the assignment so someone else can.

### When a second person is required
You do not decide whether a second person is needed; the system does. The decision follows the platform setting `join_request.four_eyes_policy`. The setting has three values.

| Value | Meaning |
| :--- | :--- |
| `ALWAYS` | Every approval and every rejection needs a second reviewer. |
| `RISK_BASED` (recommended default) | A second reviewer is needed if **any** of the triggers below is true. Rejections of such cases also need a second reviewer. |
| `NEVER` | One reviewer decides. Not recommended for a regulated payment platform. |

With `RISK_BASED`, the triggers are:
* the proposed risk is `HIGH`;
* screening is not `CLEAR`;
* an owner is a politically exposed person (PEP: someone with a prominent public role);
* the business category is on the high-risk list;
* the expected volume is above the configured threshold;
* the payout account does not match;
* the applicant was rejected before.

The system records which triggers fired.

### What approval does (all at once, or not at all)
When the approval goes through, these things happen together:
1. The join request becomes `APPROVED`.
2. The merchant becomes `ACTIVE`, KYB becomes `VERIFIED`, and the risk tier is set.
3. Default velocity and AML posture for that tier applies automatically.
4. The platform's default commission profile is already in force, so rails become offerable as soon as the merchant creates an application. A rail is a payment method the customer can pick, for example Sadad.
5. Audit records are written.
6. An approval message is queued for the applicant.

If any part fails, nothing changes and the request stays as it was.

:::danger Never
Never tell an applicant that screening or compliance was part of a rejection or a request for information. See [[a:b09-08|Confidentiality and tipping-off]].
:::
@@end

@@article id=b05-04 book=5 order=4 title="KYB documents and beneficial owners" roles=OPERATOR,COMPLIANCE minutes=4 ui=AVAILABLE related=b05-03,b05-10,b01-10
:::summary Big picture in 20 seconds
We never take a business's word for who it is. Documents are the evidence, and we also record and screen the real people who own a large share of the business or control it.
:::

### What KYB documents are for
**KYB** (Know Your Business) is the checking of a business. The documents are the evidence. When Noon Mart applies, we ask for papers that prove it exists, who owns it and where its money should go.

### Required documents
The list depends on the business category, but usually includes:
* commercial registry certificate,
* tax certificate,
* articles of association (for companies),
* identity document of each beneficial owner and each authorised signatory,
* proof of address,
* a bank letter confirming the payout account,
* a sector licence if the activity is regulated.

### What the system does to each upload
Every file goes through these steps:
1. It checks type and size limits.
2. It scans for viruses. A reviewer cannot open a file until it is clean.
3. It stores the file encrypted, with a fingerprint (`sha256`). A fingerprint is a short code made from the file; if the file changes, the code changes. Files are never overwritten; a replacement is a new file.
4. It records the expiry date if the document has one.
5. **It raises a duplicate flag if the same file was uploaded by an unrelated merchant.**

### Document statuses
Each document has one status. The table says what each status tells you.

| Status | Meaning |
| :--- | :--- |
| `UPLOADED` | Received, not reviewed. |
| `ACCEPTED` | A reviewer accepted it. |
| `REJECTED` | A reviewer rejected it, with a reason code. |
| `EXPIRED` | The expiry date passed. |

### Beneficial owners
A **beneficial owner** is a real person behind the business. The system records two kinds of person:
* anyone holding **25% or more** of ownership or voting rights (the default threshold, set by the platform setting `aml.owner_threshold_percent`), and
* anyone who **controls** the business (director, managing partner, authorised signatory).

If nobody reaches the threshold, the most senior manager is recorded as the controller and the reason is written down.

Here is an example. Three people own Noon Mart: Sara holds 60%, Karim holds 30% and Hana holds 10%. Sara and Karim reach the 25% threshold, so both are recorded. Hana holds less than 25%. She is recorded only if she also controls the business, for example as a director.

### Owner screening status
Each owner has a screening status. Screening is the comparison of a name with sanctions and other lists. The statuses are:
* `NOT_SCREENED`: the owner has not been compared yet.
* `CLEAR`: no candidate match.
* `POTENTIAL_MATCH`: a name resembles a listed name; Compliance must decide.
* `CONFIRMED_MATCH`: a person decided the match is real.

Names are stored in Arabic and, where available, Latin letters. National ID numbers are encrypted and shown masked. For the screening process, see [[a:b05-05|what a reviewer may and may not do]].

### Changes after approval
Adding or changing an owner after approval is a **sensitive** change. It needs two people and triggers a new screening. History is kept. Old owners are not deleted; they get an end date.

### What you must never do
* Never accept a document you cannot read, or that looks edited.
* Never accept an owner's national ID as proof of address.
* Never copy documents out of the platform to chat, e-mail or personal storage.
@@end

@@article id=b05-05 book=5 order=5 title="Screening during onboarding: what a reviewer may and may not do" roles=OPERATOR,COMPLIANCE minutes=3 ui=PARTIAL related=b09-03,b09-08,b05-03
:::summary Big picture in 20 seconds
Every join request is screened automatically. A merchant cannot be approved until screening succeeds and the result is `CLEAR` or Compliance has decided each possible match. If the result is not `CLEAR`, an operator does not discuss it and never tells the applicant.
:::

### What screening is
Screening means comparing names with lists of people and companies that need extra care. When a join request is submitted, the platform does this automatically for the business and its owners. It compares them with sanctions lists, politically-exposed-person lists, adverse-media sources and our own internal watch-list.

A false positive is a name that looks like a listed name but is a different person. The MLRO is the senior owner of suspicious-activity decisions. "Fail closed" means that when the check cannot run, the answer is "no", not "yes".

The result is one of four overall results. Read the table from left to right: the result, what it means, and what happens next.

| Result | Meaning | What happens next |
| :--- | :--- | :--- |
| `CLEAR` | No candidate matches. | The review continues normally. |
| `POTENTIAL_MATCH` | A name resembles a listed name. It may be a different person. | A **Compliance** analyst decides whether each possible match is a false positive, a true match or needs escalation. Until that is done the merchant **cannot be approved**. |
| `CONFIRMED_MATCH` | A person decided the match is real. | If it is a sanctions match, the merchant is suspended through the emergency path and the case goes to the MLRO. |
| `ERROR` | The screening provider was unavailable. | **Fail closed**: the request cannot be approved until screening succeeds. |

### Your role if you are an operator
Suppose Ali, an operator, sees that Noon Mart's screening result is `POTENTIAL_MATCH`. These are the rules:
* You may be able to see only the overall result. The details of matches are **AML-confidential** (Book 9). AML means anti-money-laundering.
* If the result is not `CLEAR`, do not approve and do not discuss it. Write in the internal notes that the request is waiting for Compliance, and let the second-reviewer rule apply.
* Do not tell the applicant anything about screening. Use only generic wording such as "your application is under review".

### Your role if you are Compliance
Decide each possible match with a written rationale. See [[a:b09-03|Screening]].

:::note Why this article is marked partial
The screening provider is a management decision that is still being made, and some screens may show less detail than described in Book 9. If a screen differs from this article, stop and ask.
:::
@@end

@@article id=b05-06 book=5 order=6 title="Applications and wallets: the rules that keep money pointing at the right place" roles=ALL minutes=3 ui=AVAILABLE related=b05-07,b04-02,b01-04
:::summary Big picture in 20 seconds
Each application pays into exactly one wallet, and the rules around it exist so that nobody can send money to the wrong place. Changes that could redirect money need two people.
:::

### The idea: each place that takes payments has one wallet
Imagine Noon Mart has a website and a mobile app. Each is a place where customers pay. We call each one an **application**. Each application has one wallet, which is Noon Mart's balance on our books. Several applications can share the same wallet. The wallet is a number we calculate, not a box of cash. The rules below make sure every payment has one clear place to land.

### The relationships
The diagram shows what hangs under a merchant. Read it from the top down.

```diagram
Merchant ─┬─ Users (owners, staff, cashiers)
          ├─ Wallets ─────────── (balance is calculated from the ledger, never typed in)
          ├─ Applications ── each one assigned to EXACTLY ONE wallet
          │      ├─ Payment links
          │      ├─ POS terminals → POS screens
          │      └─ API access tokens
          └─ Credential sets (only for merchants who use their own payment-company accounts)
```

### The rules, with the reason for each
1. **Exactly one wallet per application.** If an application could pay into "any" wallet, nobody could say where a given payment's money should land. The rule is built into the database, so no screen or program can break it. Many applications may share one wallet. The wallet of a payment link is copied from its application when the link is created and can never change afterwards.
2. **The rail whitelist.** A rail is a payment method the customer can pick. An application may list which rails it allows. *No list* means "all rails", but the other conditions of the visible-rails formula still apply. See [[a:b06-12|The visible-rails formula]]. *An empty list is refused*, because it would silently turn off payments. A payment link may **narrow** the application's list but never widen it.
3. **The redirect-domain allow-list.** After paying, a customer can be sent back to the merchant's website. Only domains on this list are allowed. Without it, an attacker could create a link that sends paying customers to a fake page.
4. **Descriptive versus sensitive.** Some edits are direct and some need two people. The rules are in the list below.
5. **Approved changes affect new payments only.** A payment already started keeps the settings it began with.

For rule 4, this is what is direct and what needs two people:
* Changing the application's name or description is direct.
* Changing the **assigned wallet**, the **rail whitelist** or the **redirect-domain allow-list** needs two people.
* Pausing an application is direct.
* Resuming after the *platform* paused it needs two people.
* A large increase in expected volume opens a review case automatically.

For example, Noon Mart's application allows Sadad and Edfali. A payment link made from it may allow only Sadad. It may not add MobiCash, because a link can never widen the application's list.

### Wallets
A **wallet** is the merchant's balance on our books. It belongs to one merchant and one currency (`LYD`). The currency can never be changed. Only the wallet's **status** can be changed, and that needs two people. The balance is **calculated** from ledger lines every time it is displayed. It is not a stored number that someone could edit. Each wallet has its own page with its statement; see [[a:b03-09|The Wallets screen and the wallet page]].
@@end

@@article id=b05-07 book=5 order=7 title="Payment links, POS terminals and API tokens" roles=ALL minutes=3 ui=AVAILABLE related=b05-06,b07-06,b07-11
:::summary Big picture in 20 seconds
A payment link fixes the amount and the rules for one purchase. A POS terminal shows payments in a shop. An API token lets the merchant’s software act without a person signing in. All three belong to an application.
:::

### Three ways a merchant takes a payment
Noon Mart can take a payment in three ways. It can send Layla a **payment link** for her 25.500 LYD phone case. It can use a **POS terminal** at a shop counter. Or its own software can create links by itself with an **API token**. Each one belongs to one of Noon Mart's applications.

### Payment links
A **payment link** is a request to pay one fixed amount. The link has these parts:
* a unique **key** (the secret part of its web address),
* an **amount** and **currency**, set by the merchant when the link is created and never taken from the customer,
* a **fee bearer**: who pays our commission. See [[a:b01-05|Fees, commission and who pays]],
* a **use limit**: **single-use** (one successful payment) or **multi-use** (a set number of payments, or unlimited),
* an optional **expiry**,
* an optional **redirect address** (only for single-use links, and only to an allowed domain),
* an optional **rail list** that can only narrow the application's list. A rail is a payment method the customer can pick.

### The link's state and its two counters
A link's state is `PENDING`, `COMPLETED`, `EXPIRED` or `CANCELLED`.

The link also keeps two counters. They help the platform to stop a link from being paid too many times.
* `confirmed_count` is the number of payments that succeeded.
* `active_locked_count` is the number of payments that were started and are not finished.

The rule is that these two together may never exceed the use limit. This is the *slot reservation*. It is explained in [[a:b07-06|Slot reservation, single-use links, expiry and the grace window]].

Here is an example. A multi-use link allows 3 payments. Two payments have succeeded, so `confirmed_count` is 2. A third customer has started to pay and has not finished, so `active_locked_count` is 1. Now 2 + 1 = 3, which equals the limit. A fourth customer cannot start a payment. If the third payment fails, its slot is released and a new payment can start.

### POS terminals and screens
A **POS terminal** is a counter in a shop. A **POS screen** is a display paired to the terminal. It shows the payment in real time, for example a QR code for the customer and the result for the cashier.

A screen that is idle for **15 minutes** is disconnected. The payment itself continues on the server. Reconnecting shows the current state, and a cashier can look the payment up by its reference.

### API access tokens
A merchant's own software can create links through the Merchant API. It proves who it is with a **token**. These are the rules for tokens:
* The token starts with `pg_live_`.
* It is **shown once**, when created, and never again. We store only a fingerprint.
* Creating a token requires the merchant user to sign in again.
* A token may be limited to listed IP address ranges. **Adding** addresses is direct; **turning the limit off** needs two people.
* Revoking is immediate.

:::warning If a merchant says "my token leaked"
Tell them to revoke it immediately in their portal and create a new one. Support staff never see token values and must never ask for one.
:::
@@end

@@article id=b05-08 book=5 order=8 title="The Merchants screen: look up, edit, suspend and reinstate" roles=OPERATOR,COMPLIANCE,SUPPORT minutes=3 ui=AVAILABLE related=b04-02,b04-04,b05-09
:::summary Big picture in 20 seconds
On the Merchants screen you look up a merchant and change its details. Some edits are direct, sensitive edits need a second person, and suspending is fast while reinstating is slow, because reinstating raises risk.
:::

### Looking up a merchant
You can search by name, tax ID or registration number. Open the record to see:
* its state, KYB status and risk tier,
* its applications and wallets,
* the **field history**: every past value of every field, with who changed it and when.

`SUPPORT` can see descriptive data and field history only.

### Editing: direct or with approval
There are three kinds of edit.
* **Descriptive fields** (trade name, display name, logo, support contact): edit directly. The change is recorded.
* **Contact phone and e-mail**: edited directly, but the *new* value must first be verified with a code or link.
* **Sensitive fields**: use **Submit For Approval**, which creates a request for a second person. Until it is approved, the current value stays in force.

The sensitive fields are legal name, tax ID, registration number, business category, payout bank details, risk tier, KYB status override, the two ceilings and status. Open the checklist [[c:sg-edit-merchant-sensitive|Submit a sensitive merchant change]] first.

:::warning Payout bank details
The bank account must be in the merchant's legal name (or a documented related party). A mismatch forces a second person to approve regardless of any setting. Cash-outs already in progress keep the bank details they started with.
:::

### Suspending a merchant: **Suspend Merchant**
Suppose an authorised person such as Omar sees a serious reason to stop Noon Mart. He cannot wait for a second person, because delay is the hazard. So one authorised person can suspend a merchant, and it takes effect immediately.

Then a second person must **ratify** the suspension within 24 hours. To ratify is to review a decision that was already made and confirm it. See [[a:b04-04|Emergency actions, ratification and the asymmetry principle]].

Choose the reason code honestly and write the reason. See [[a:b04-06|Writing a reason that survives an audit]]. Open the checklist [[c:sg-suspend-merchant|Suspend a merchant]] first.

What suspension does:
* New payments are blocked.
* Cash-out is blocked.
* API tokens and POS screens return a neutral message.
* The balance is kept.
* A merchant notification is sent in generic wording. **If the cause is AML (anti-money-laundering), the merchant's message contains no reason at all.**

### Reinstating a merchant: **Reinstate Merchant**
Reinstatement *increases* risk, so it always needs prior approval by a different `COMPLIANCE` or `MLRO` user. It is never an emergency action. Open the checklist [[c:sg-reinstate-merchant|Reinstate a merchant]] first.

### Closing a merchant
Closing is allowed only when the balance is zero and no dispute is open. A merchant with a negative balance cannot close until it is repaid or written off by an approved adjustment.
@@end

@@article id=b05-09 book=5 order=9 title="Helping a merchant safely: what to say and what never to say" roles=OPERATOR,SUPPORT,COMPLIANCE minutes=3 ui=AVAILABLE related=b09-08,b05-08,b03-04
:::summary Big picture in 20 seconds
Help the merchant, but say only what the screen shows. Never reveal AML, screening, risk tier, gateway cost or our margin. Even a hint that a review exists can be a crime.
:::

Imagine that someone from Noon Mart phones you. The shop is upset because its account is restricted, and asks why. You want to help. But some true things must never be said to a merchant. This article gives you the rules and the safe words to use.

### Principles
1. **Identify the person before you discuss anything.** Phone callers are not proof of identity. Ask the merchant to raise the request in their own portal where the system knows who they are.
2. **Use the reference, not the story.** Ask for the payment reference and look it up yourself.
3. **Say only what the screen says.** If you did not see it, do not say it.
4. **Never reveal AML, screening, risk tier, gateway cost or our margin.** Merchants do not see these.
5. **Never promise an outcome.** Say what you will check and when you will reply.

### Sentences you can use
Find the situation in the left column and use the wording on the right.

| Situation | Safe wording |
| :--- | :--- |
| The merchant is suspended and asks why | "Your account is currently restricted. I cannot give further details. Please contact the support address in your notice." |
| A payment is in `UNKNOWN` | "We are confirming this payment with the payment company. It can take some time. Please do not ask the customer to pay again." |
| A payout is delayed | "Your request is in the review queue. I will tell you its current status." |
| The merchant asks about our fee | "Your commission for this payment was X. That is the rate agreed in your profile." |
| The merchant asks to change the bank account | "That change needs a written request in your portal and a second-person approval. It cannot be done by phone." |

### Sentences you must never use
Each of these either reveals a review or asks for a secret.
* "You are under investigation."
* "Compliance flagged you."
* "The system thinks you are high risk."
* "Just give me your password / token and I will fix it."

:::danger Tipping-off
Tipping-off means telling someone, directly or by hint, that they are or may be under suspicion, or that a report has been made about them. Even a hint that a review exists can be a crime. If you are unsure whether something may be said, say nothing and ask Compliance. See [[a:b09-08|Confidentiality and tipping-off]].
:::
@@end

@@article id=b05-10 book=5 order=10 title="Re-application, duplicate detection and periodic KYB refresh" roles=OPERATOR,COMPLIANCE minutes=2 ui=AVAILABLE related=b05-03,b05-04
:::summary Big picture in 20 seconds
A new application is compared with every merchant we have ever had, and approved merchants are re-checked on a schedule. Businesses change, so an old check is not enough.
:::

### Duplicate and related-party detection
On every submission the platform compares the applicant with all current and past merchants, to find related parties. It compares these items:
* tax ID,
* registration number,
* an owner's national ID,
* payout bank account,
* phone,
* device fingerprint,
* document fingerprints.

A match does **not** reject the applicant automatically. It does three things:
* it adds a second-person requirement,
* it shows you the related records,
* it raises the proposed risk tier by one level.

Links to related parties are kept after a rejection, so a rejected applicant cannot simply reapply under a new name.

### Periodic KYB refresh
KYB (Know Your Business) is the checking of a business. After approval we repeat it from time to time. The rules are:
* A document with an expiry date triggers notices 30 days and 7 days before it expires, then becomes `EXPIRED`.
* A merchant with a required document expired for more than 30 days is moved to `SUSPENDED` (`KYB_EXPIRED`), unless two people extend it.
* Re-verification happens every year for `HIGH`, every two years for `STANDARD` and every three years for `LOW` (configurable).
* A change of owner, legal name, payout account, business category, or a large jump in volume opens a manual review case and a new screening.

Here is an example of the document rule. Noon Mart's registry certificate has an expiry date. Thirty days before that date, Noon Mart gets its first notice. Seven days before, it gets the second notice. After the date has passed, the document becomes `EXPIRED`. If it is still expired more than 30 days later, Noon Mart is moved to `SUSPENDED` with the reason `KYB_EXPIRED`, unless two people extend it.

### Why it matters
Businesses change. A check done three years ago says nothing about who owns the business today.
@@end


### BOOK 6 — GATEWAYS, RAILS & THE ENGINE

@@article id=b06-01 book=6 order=1 title="Gateways in depth: kinds, statuses, versions and the Gateways screen" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=3 ui=AVAILABLE related=b02-06,b06-10,b06-13
:::summary Big picture in 20 seconds
A gateway is the stored record of one connection to one outside payment company. Its settings are never edited in place: every change is a new sealed version that goes live only after approval, so payments in progress are never disturbed.
:::

### What a gateway is
When Layla pays Noon Mart with Sadad, our platform must talk to Sadad's computers. A **gateway** is our record of that one connection. Each outside system we connect to has its own gateway record. The record holds the facts we need to know about the connection and the rules for using it.

### What a gateway record holds
Read this list as the "identity card" of a gateway. For Sadad it would start with the code `sadad`.
* A unique **code**, for example `sadad`.
* A name, the operating company and the country.
* **Aliases**: other spellings people use for the same partner, such as `Edfali`, `Edfaa Li` and `Adfali`.
* A **kind**: how we connect (see the next table).
* A **verification state** and a **risk class**: how sure we are about the partner's behaviour, and how risky it is.

### The four kinds
The kind says who is on the other side of the connection. Use this table to look up a kind.

| Kind | Meaning | Example |
| :--- | :--- | :--- |
| `DIRECT` | We connect to the payment company itself. | Moamalat, Sadad |
| `AGGREGATOR` | We connect to a company that offers many methods through one door. | DPay, Plutu, MyPay |
| `NATIVE_ADAPTER` | A built-in adapter for something that does not fit the declarative model. | rare |
| `INTERNAL` | A first-party system we operate ourselves. | NeomPay |

### How sure are we? Verification state and risk class
These two labels tell you how much care a gateway needs.
* **Verification state**: `VERIFIED` means its behaviour was confirmed from official documents or a public software kit. `UNVERIFIED` means it was built from a vendor page or partial information, so extra caution applies.
* **Risk class**: `NORMAL` or `HIGH_RISK`. A gateway is `HIGH_RISK` when it offers **neither** a signed webhook **nor** a way to ask for a payment's status. In plain words: we would have no safe way to learn what really happened.
* Going live with a `HIGH_RISK` gateway needs a signed executive risk acceptance, mandatory statement reconciliation and extra operator approval above a threshold.

### The life of a gateway: its status
A gateway moves through these statuses in order: `DRAFT` → `SANDBOX_VERIFIED` → `PENDING_APPROVAL` → `LIVE`. Later it may be `SUSPENDED` or `RETIRED`.

### Why a gateway is never edited in place
Imagine we edit the live settings while Layla is in the middle of paying. Her payment could break halfway. So we never do that.

All the configuration of a gateway (addresses, steps, signing recipes, status rules and so on) is stored as an **immutable version**. A version is a sealed snapshot with a content fingerprint. Editing creates a **new draft version**. The live version is untouched until the new one is approved and promoted.

Each version has its own state. This table shows the life of a version.

| Version state | Meaning |
| :--- | :--- |
| `DRAFT` | Being built. |
| `SANDBOX_VERIFIED` | Passed the test suite on sandbox. |
| `PENDING_APPROVAL` | Submitted; waiting for a `SECURITY_ADMIN` to approve. |
| `LIVE` | In use for new payments. |
| `SUPERSEDED` | Replaced by a newer live version. |
| `ROLLED_BACK` | Withdrawn in favour of its named rollback version. |

Every payment attempt records the version it started with. Promoting a new version affects **new** payments only. Payments already started finish on the old version. That is how a configuration can change safely while money is moving.

:::tip On the Gateways screen
**New Gateway** creates a record and opens its wizard; see [[a:b06-13|the Add-a-Gateway wizard]]. **Smart AI Integration** starts the AI-assisted import; see [[a:b06-14|Smart AI Integration]].
:::
@@end

@@article id=b06-02 book=6 order=2 title="The nine collection modes in depth: what the customer does, what can go wrong" roles=GATEWAY_ADMIN,OPERATOR,SUPPORT minutes=4 ui=AVAILABLE related=b01-02,b06-07,b07-12
:::summary Big picture in 20 seconds
A collection mode is the way a customer pays: typing a code, being sent to another page, tapping Approve and so on. Each of the nine modes has its own way of telling us the result and its own traps.
:::

### What a collection mode is
Customers do not all pay in the same way. Some type a code, some scan a QR code, some leave our page. The **collection mode** is our name for one of these ways. There are nine modes, and every rail uses one of them.

Two words appear often below. A **webhook** is a message the payment company sends to our secret address. A **status question** is our own call that asks the payment company "what happened to this payment?".

### One mode, step by step: `OTP_PULL`
Layla pays 25.500 LYD at Noon Mart with Sadad. Here is what happens in the `OTP_PULL` mode.
1. Layla types her phone number. Sadad sends her an SMS code.
2. Layla types the code on our page.
3. We send the code to Sadad. This is the **confirm step**, and it is the step that moves the money.
4. Sadad answers. The answer arrives straight away on the same call.

Now the trap. Suppose the answer to step 3 never arrives because the connection dropped. We cannot tell whether Sadad took the money. So the result is `UNKNOWN`, never "failed". We must ask, not guess. Also, wrong codes are limited (default 3 tries). Some gateways have a status question, and we can ask it. Some have none, so only statements or an operator can settle the doubt.

### The nine modes in one table
For each mode, the table lists what the customer does, how we learn the result, and the traps. "Hint" means a message that makes us **ask** the payment company. A hint never proves payment by itself.

| Mode | Customer does | How we learn the result | Traps |
| :--- | :--- | :--- | :--- |
| `OTP_PULL` | Types a phone number, receives an SMS code, types the code. | The confirm step answers immediately; some gateways also send a webhook; some offer a status question. | The confirm step is the money step. A timeout there is `UNKNOWN`, never "failed". Wrong codes are limited (default 3 tries). Some gateways have **no** status question, so only statements or an operator can settle doubt. |
| `REDIRECT` | Leaves our page, pays on the payment company's page, returns. | Signed webhook and/or a status question. The return to our page is only a hint. | The customer can close the browser and still have paid. The return address can be tampered with. |
| `EMBEDDED` | Pays inside a small window (lightbox or frame) on top of our page. | Webhook and/or status question. The window's own "done" message is only a hint. | Browser messages can be faked. Scripts for the window must be pinned and approved. |
| `PUSH_APPROVAL` | Taps **Approve** in their wallet app. | Webhook or polling. | Customer may approve after our time limit. That becomes a late success; see [[a:b07-08]]. |
| `QR_DISPLAY` | Scans a QR code with a bank or wallet app. | Webhook, status question, and sometimes a short synchronous answer. | Same late-approval trap. QR codes expire. |
| `PAY_CODE` | Enters a short code in their app or sends it by SMS. | Webhook or statement. | Few gateways offer status questions. |
| `DEEP_LINK` | Taps a button that opens their wallet app. | Webhook or status question. Browser callback is a hint. | The app may not be installed. |
| `MANUAL` | Transfers money by bank or at an agent. A person confirms. | Statement or an operator. | Slowest and most error-prone. Always needs a reference the customer must copy exactly. |
| `HYBRID` | Chooses among several of the above. | Depends on the chosen sub-mode. | Each sub-mode has its own traps. |

### Which channels each mode may use
Every mode supports a different set of ways to confirm. The save-time checks of the wizard **reject** combinations that make no sense, for example a `MANUAL` rail with a webhook. Weak confirmation methods are always forced to also ask the payment company. See [[a:b06-07|confirmation channels and how much each one is trusted]].

### Time limits by mode (platform ceilings)
Each mode has a ceiling: the longest time a payment session may last. Read the table as "this mode may last at most this long".

| Mode | Ceiling |
| :--- | :--- |
| `OTP_PULL` | 20 minutes |
| `REDIRECT` | 30 minutes |
| `QR_DISPLAY`, `PUSH_APPROVAL` | 15 minutes |
| `MANUAL` | as configured |

A gateway with a shorter session can only **tighten** the limit. The effective limit is always the smaller of the two. For example, an `OTP_PULL` gateway with a 10-minute session has an effective limit of 10 minutes, because 10 is smaller than 20.
@@end

@@article id=b06-03 book=6 order=3 title="The engine: ten phases, steps, side effects and the retry boundary" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=6 ui=AVAILABLE related=b06-04,b06-06,b06-17
:::summary Big picture in 20 seconds
A gateway is a stored recipe, not new code: ten phases and a series of small steps tell the engine how to talk to a partner. The money step is never retried automatically after a timeout.
:::

### The idea: a recipe, not a program
Think of a cooking recipe. It lists small actions in order, and any cook can follow it. A gateway works the same way. It is described as a **recipe** that the **engine** follows. The engine is the part of `core-back` that runs recipes. Nobody writes code to add a gateway.

A recipe has two levels. It is divided into **phases**, which are like chapters ("start the payment", "confirm it", "ask for the status"). Each phase is an ordered list of **steps**, which are the single small actions.

### One recipe, step by step: Layla pays with Sadad
Here is a simplified recipe for a gateway like direct Sadad, where the customer types an SMS code and the gateway offers a status question. It is an illustration. The real recipe is different for each gateway. Layla pays 25.500 LYD at Noon Mart.

1. **`INITIATE` phase.** One `HTTP` step calls Sadad and asks it to send an SMS code to Layla's phone. This call sends a notification, but no money moves.
2. **`SUBMIT` phase.** Layla types the code. One `HTTP` step sends the code and the amount to Sadad. This is the **money step**: Sadad takes 25.500 LYD from her wallet. This step is marked to be tried only once.
3. **`VERIFY` phase.** If we are unsure what happened, one `HTTP` step asks the gateway for the real status. This call only reads. It moves nothing.

Now the important moment. Suppose the answer to step 2 never comes back. We do not know whether Sadad took the money. The engine does **not** repeat step 2. It marks the attempt `UNKNOWN`, and then step 3 (or a statement, or an operator) finds out the truth. The rest of this article explains the pieces behind this story.

### The ten phases
Every recipe may use these ten phases. Read the table as "when does the engine use this phase".

| Phase | Purpose |
| :--- | :--- |
| `CREDENTIAL_CHECK` | Prove our credentials work (a harmless test call). Also used to test whether a failed route has recovered. |
| `PRE_INITIATE` | Optional checks before starting (is the subscriber eligible? lock a quote?). Read-only. |
| `INITIATE` | Start the payment (for example ask the payment company to send an SMS code). |
| `SUBMIT` | The **money step**: complete the payment with the code or evidence. Also called confirm. |
| `VERIFY` | Ask the payment company what the real status is. Read-only. Also called inquire. |
| `CANCEL` | Cancel a payment that has not completed. |
| `REFUND` | Return money after an approved refund. |
| `VOID` | Cancel before settlement. |
| `CAPTURE` | Complete a previously authorised card payment. |
| `SETTLEMENT_FETCH` | Fetch the settlement statement. |

### The six step types
Each step in a phase has one type. The type says what kind of action the step is.

| Step type | What it does |
| :--- | :--- |
| `HTTP` | Calls a web address. |
| `COMPUTE` | Calculates something locally, with no network call. |
| `RENDER` | Prepares what the customer sees. |
| `WAIT` | Pauses for a set time. |
| `ASSERT` | Stops if a condition is false. |
| `BRANCH` | Takes one path or another, depending on a condition. |

### Four labels every HTTP step carries
An `HTTP` step reaches the outside world, so it carries four labels. They tell the engine how careful to be. Use this table to look up a label.

| Label | Values | Meaning |
| :--- | :--- | :--- |
| `side_effect` | `READ_ONLY`, `SENDS_NOTIFICATION`, `MOVES_MONEY` | What the call can cause in the outside world. |
| `retry_policy` | `SAFE`, `SAFE_WITH_COOLDOWN`, `NEVER` | Whether the engine may repeat it. |
| `idempotency_config` | none, header, or body field | Whether the payment company guarantees that repeating a request has no extra effect, and how we send the key. |
| `point_of_no_return` | true or false | After this step, the customer cannot simply be told "try again". |

### The retry boundary: the most important engine rule
A step that **moves money** must **never** be retried automatically after a timeout, a dropped connection or a server error. The reason is this. From our side, "the request never arrived" and "it arrived, money moved, and only the reply was lost" look the same. Retrying could pay twice.

So the attempt becomes `UNKNOWN`. It is then resolved by asking; see [[a:b07-03|what to do when a payment is UNKNOWN]].

The save-time validator **refuses** a recipe where a money step is not `NEVER`-retry. The only exception is a gateway that supports an idempotency key, when that has been proven.

### Where each value in a request comes from
Each field of a request has a **source**. The source can be:
* the gateway's settings, or the route's settings,
* the stored credentials,
* the attempt (amount, reference),
* a field the customer typed,
* a value saved by an earlier step, or the answer of an earlier step,
* a constant, the current time, or a random value,
* a computed value,
* a **cryptographic signature**.

One rule protects you from mistakes. A value from "the answer of an earlier step" can never be used on the first step, because there is no earlier answer yet. The validator rejects that.

### What comes out of a step
The engine extracts values from the partner's answer and stores them in one of these ways.
* `STATE`: encrypted and kept on the attempt.
* `PUBLIC`: may be shown to the customer's browser.
* Special slots: the provider's reference, the settled amount, the provider fee and the network reference.

A **required** value that is missing after a money step makes the attempt `UNKNOWN`, never `FAILED`. We do not call a payment failed when we cannot read the answer.

### Time limits and size limits
Each outbound call has a time limit. It is 10 seconds for authentication and status questions, and 15 seconds for start, confirm and refund. Answers are read as plain text first. They are capped at 2 MB and nested no deeper than 64 levels. XML external entities are disabled.
@@end

@@article id=b06-04 book=6 order=4 title="Amounts: scales, decimals, rounding and the 1000-times danger" roles=ALL minutes=2 ui=AVAILABLE related=b01-01,b06-05,b08-03
:::summary Big picture in 20 seconds
Payment companies write the same amount in different ways, and a wrong choice makes the customer pay 1000 times too much or too little. Every gateway has amount settings that convert our exact amount at the last moment, and a contract test checks them before go-live.
:::

### Why this is dangerous
One dinar is 1000 dirhams. Payment companies disagree on how to write money. Take an amount of 10.500 LYD. This table shows the three ways it can be written.

| Style | 10.500 LYD is written | Used by |
| :--- | :--- | :--- |
| Three-decimal string | `"10.500"` | our own books, NeomPay |
| Two-decimal string | `"10.50"` | most mobile-wallet gateways |
| Integer of dirhams | `"10500"` | Moamalat |

Now see what a wrong choice does. If our system sends `10500` to a gateway that expects `10.50`, the customer is asked to pay **ten thousand five hundred dinars**. If it sends `10.50` to a gateway that expects dirhams, the customer pays **ten dirhams**. Both mistakes are 1000 times wrong, and both are silent.

### The amount pipeline
The platform keeps every amount as an exact decimal (four decimal places in the database). It converts the amount only at the last moment, just before sending it. Every gateway has four amount settings that control this conversion:
* **scale**: multiply by 1, 100 or 1000 before sending,
* **precision**: how many decimals the wire format has (0, 2 or 3),
* **rounding**: `NONE`, `NEAREST`, `UP` or `DOWN` when precision is lower than three decimals,
* **format**: a decimal string, an integer in small units, or a number.

### Worked rounding
A two-decimal gateway cannot write three decimals, so we must round. Say the amount is `76.255` LYD. The result depends on the rounding setting:
* rounding `NEAREST` gives `76.26`,
* rounding `DOWN` gives `76.25`,
* rounding `UP` gives `76.26`.

Rounding changes the amount a little. When the gateway's wire amount differs from our exact amount because of rounding, the difference is handled by the route's *mismatch policy*. It is not ignored.

### How it is tested
Before a gateway can go live, a **contract test** must pass. It uses fixed examples with known answers:
* `10.50 LYD → "10500"` for a dirham-integer gateway,
* `76.255 → "76.26"` for a two-decimal gateway with `NEAREST` rounding.

This test is one of the 12 go-live gates; see [[a:b06-16|the twelve go-live gates in plain words]].

### Try it
Use the sandbox below to see how a value changes at each operation. It is a teaching tool only.

{{widget:transform-sandbox}}

:::danger If a customer says "I was asked for a thousand times more" or "much less"
Stop. Do not retry. Report it as a P1 incident immediately; see [[a:b10-01|incident principles]]. The gateway's amount settings may be wrong.
:::
@@end

@@article id=b06-05 book=6 order=5 title="Customer forms: rail fields, normalisers and sensitivity" roles=GATEWAY_ADMIN,OPERATOR minutes=3 ui=AVAILABLE related=b06-04,b11-04
:::summary Big picture in 20 seconds
Each rail shows the customer a small form, and each field of that form has a type, rules, a cleaning step (normaliser) and a sensitivity level. The server checks every field itself and never trusts the browser.
:::

### What a rail field is
A **rail** is what the customer picks, such as "Sadad". When Layla picks the Sadad rail at Noon Mart, our page shows her a small **form**. The form asks for what Sadad needs: first her mobile number, later the SMS code. Each question on the form is a **field**.

### One form, step by step: Layla types her number
Here is what happens to one field.
1. The Sadad rail has a field for the mobile number, with type `phone`.
2. Layla types her number using Arabic digits: `٠٩١٢٣٤٥٦٧٨`.
3. A **normaliser** cleans the input. This one, `arabic_digits_to_ascii`, turns it into `0912345678`.
4. The rules are checked on the cleaned value: the pattern, the length and whether the field is required.
5. The server runs this check. The customer's browser may also check, but the server never trusts the browser.

Without the normaliser, a valid number typed with Arabic digits could fail the pattern check, and Layla would be told her number is wrong.

### What each field defines
Use this list to see everything a field can set.
* A key (its internal name).
* A type: `phone`, `number`, `string`, `otp`, `birth_year`, `card_number`, `pan`, `from_list`.
* Labels and placeholders in Arabic and English.
* Rules: a pattern (regex), minimum and maximum length or value, whether it is required, its order on screen.
* A **normaliser**, which cleans the input before checking it.
* A **sensitivity** level.

### Normalisers
Customers type in many ways. A normaliser converts them to one form.
* `arabic_digits_to_ascii`: turns `٠٩١٢٣٤٥٦٧٨` into `0912345678`.
* `phone_normalize`: converts a phone number to one style. The style depends on what the gateway needs. This table shows the three styles for the same number.

| Style | The same number is written |
| :--- | :--- |
| `LOCAL_09` | `0912345678` |
| `INTL_218` | `218912345678` |
| `E164` | `+218912345678` |

### Sensitivity levels
Some data must be hidden, and some must never be stored. The sensitivity level tells the platform how to treat a field. Two terms appear in the table. PAN means primary account number, the long number printed on a card. PCI is the card industry's security standard. Use the table to look up a level.

| Level | Meaning |
| :--- | :--- |
| `NORMAL` | Ordinary data. |
| `SENSITIVE` | Personal or wallet identifiers. Masked in logs and screens. |
| `PAN` | A full card number. Kept **in memory only** for the single outbound call and wiped immediately; never written to any database or log. A rail with a `PAN` field requires a separate PCI scope review before it can go live. |

### Why validation happens on our server
The form's rules are compiled into a checker inside `core-back`. The customer's browser may also check, so the customer sees mistakes quickly. But the server never trusts the browser, because anyone can change what a browser sends.
@@end

@@article id=b06-06 book=6 order=6 title="Signatures and crypto profiles in practice" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=4 ui=AVAILABLE related=b01-07,b07-05,b10-03
:::summary Big picture in 20 seconds
A crypto profile is a signing recipe: which secret, which fields, in what order, with which algorithm and encoding. One profile signs what we send; another checks what the partner sends back.
:::

### Why we sign messages
A signature is like a seal made with a secret. When we send a request to a payment company, we add a seal. For the `HMAC` algorithms, both sides know the secret. So the company can make the same seal and compare. If it matches, the company knows the request really came from us and nobody changed it. Other algorithms, such as `RSA_SHA256`, check the signature in a different way. The same idea works in the other direction for messages the company sends to us.

### What a crypto profile is
A **crypto profile** is a signing or checking *recipe*. It says:
* which secret to use and how the secret is written,
* which fields to include, in what order, and how to join them,
* which algorithm to use,
* how to write the result.

There are two kinds:
* **Outbound signing**: we sign what we send.
* **Inbound verification**: we check what the payment company sends us.

### One signature, step by step
This is an invented example, to show the order of the work. Layla pays 25.500 LYD, and the partner expects a signature.
1. We take the fields to sign: `amount=25.500`, `currency=LYD`, `reference=PAY-1001`.
2. We sort the fields by name and join them as `name=value` with `&`. This is the mode `SORTED_KEY_VALUE_AMP`. The text is `amount=25.500&currency=LYD&reference=PAY-1001`.
3. We read the secret using the key encoding the partner uses (for example `HEX`).
4. We run the algorithm (for example `HMAC_SHA256`) on the text with the secret.
5. We write the result in the output encoding (for example `HEX_LOWER`) and send it with the request.

With an `HMAC` algorithm, the partner repeats the same steps on its side and compares the result. If even one character differs anywhere, the result is completely different and the partner rejects the request.

### The settings that matter
Steps 2 to 5 above are settings of the profile (step 1 is the list of fields). This table lists the choices for each setting.

| Setting | Choices |
| :--- | :--- |
| Algorithm | `HMAC_SHA256`, `HMAC_SHA512`, `RSA_SHA256`, `SHA256` |
| Key encoding | `UTF8` (text as typed), `HEX` (the key is written in hexadecimal and must be converted to bytes first), `BASE64` |
| Canonical string mode | `SORTED_KEY_VALUE_AMP` (fields sorted by name, written `name=value`, joined with `&`), `SORTED_VALUES_HASH` (values only, joined in the alphabetical order of their names), `TEMPLATE_STRING`, `JSON_CANONICAL`, `RAW_BODY` (the exact bytes received), `TIMESTAMP_DOT_RAW_BODY` (timestamp, a dot, then the exact body) |
| Output encoding | `HEX_LOWER`, `HEX_UPPER`, `BASE64` |

### Why signatures fail
A signature is all-or-nothing. If one character differs, the result is completely different. The three most common causes:
1. **Wrong key encoding.** A hex key treated as text produces a different key.
2. **Wrong field order or wrong field set.** One extra field, or a field in the wrong place.
3. **Wrong output case.** `ABCD…` versus `abcd…`.

### Inbound checks beyond the signature
When a payment company calls us, the signature is not the only check. We also check:
* the secret path in the web address,
* the sender's IP address against an allow-list,
* a timestamp within 5 minutes,
* that we have not seen this exact message before (duplicates are ignored for 7 days).

Signatures are compared in constant time. This means attackers cannot learn the answer by measuring how long the comparison takes.

### Rotation without downtime
Rotation means replacing a secret with a new one. A credential set may hold two secret versions at the same time. During rotation both work, so no payments fail while the payment company switches.

### Try it
The lab below shows the exact text that is hashed. It uses example data only.

{{widget:crypto-lab}}

:::warning Secrets
Never type a real production secret into any tool, chat or this guide. Real secrets are entered only in the credential fields of the Gateway Wizard, and are write-only.
:::
@@end

@@article id=b06-07 book=6 order=7 title="Confirmation channels and how much each one is trusted" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=3 ui=AVAILABLE related=b06-02,b07-05,b02-03
:::summary Big picture in 20 seconds
A browser returning from a bank page is only a hint. Core believes a success only after the server checks five facts, and it ranks confirmation channels by how much it can trust them.
:::

### The problem: who can we believe?
Suppose Layla pays Noon Mart and her phone shows "Paid". Should we believe the phone? No. A browser or an app can be wrong, closed too early, or even faked. We need the news to come from a source we can check ourselves. A **confirmation channel** is a way the news of a payment result reaches us. Some channels are strong and some are weak.

### The key rule
**We believe only what we can verify ourselves.** Anything a customer's browser tells us is a *hint*. A hint makes us ask the payment company, but it proves nothing.

A confirmation counts as trusted only after the server has checked five facts:
1. The status is success.
2. Our reference matches.
3. The amount matches, within the route's tolerance.
4. The currency matches.
5. The environment (sandbox or live) matches.

For Layla, this means: success, our reference for her payment, 25.500 LYD (within the route's tolerance), all in the live environment. If one fact is wrong, we do not believe the confirmation.

### The channels
This table shows how much each channel is trusted. Look at the last column first.

| Channel | What it is | Trust |
| :--- | :--- | :--- |
| `WEBHOOK` | The payment company calls our secret address. | Strong when signed. |
| `RETURN_URL` | The customer comes back from the payment company's page. | **Hint only.** |
| `BROWSER_CALLBACK` | The payment window tells our page it is done. | **Hint only.** |
| `POLL` | We ask repeatedly. | Strong (we asked the source). |
| `STATEMENT` | A settlement file arrives later. | Strong, but slow. |
| `OPERATOR` | A person decides under two-person control. | Last resort. |
| Synchronous answer | The reply to the confirm call itself. | Strong if the answer is clear. |

### Verification methods for incoming messages
When a message arrives, we must check that it is real. Each method is either strong or weak.
* Strong: `HMAC_BODY`, `HASH_FIELDS`, `SORTED_VALUES_HASH`, `RSA`.
* Weak: `SHARED_TOKEN`, `IP_ONLY`, and `NONE_PLUS_INQUIRY`.

### The weak-channel rule
Weak methods (`SHARED_TOKEN`, `IP_ONLY`, return URLs and browser callbacks) are **forced to ask the payment company** before anything is believed. The setting for this is `must_inquire`, and it is on. The wizard refuses to save a weak channel with that switch off.

### Polling policy
Some rails rely on asking. For them, a polling policy sets how we ask:
* the first check comes after 5 seconds,
* then the waits between checks grow longer,
* we keep asking for a maximum of 15 minutes,
* we stop early when the payment reaches a final state.

### What this means for you
If a customer says "my phone says Paid", the platform still waits for its own verification. Follow [[a:b07-12|the procedure for this case]].
@@end

@@article id=b06-08 book=6 order=8 title="Status rules and error maps: turning a partner's words into ours" roles=GATEWAY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b07-02,b13-01,b06-03
:::summary Big picture in 20 seconds
Every partner describes outcomes in its own words, so status rules and error maps translate them into our five statuses and our error classes. When no rule matches on a money step, the result is `UNKNOWN`: we never guess.
:::

### The problem: many languages, one meaning
Every payment company describes outcomes differently: "00", "Approved", "PAID", "ok". All of these may mean "the payment worked". The platform needs one vocabulary, so that staff screens, reports and the ledger all speak the same language. Two tools do the translation: status rules for outcomes and error maps for errors.

### Status rules
A **status rule** looks at a value in the partner's answer and decides which of our five **canonical statuses** it means. "Canonical" means "our one official word". The five are in this table.

| Canonical status | In plain words |
| :--- | :--- |
| `AWAITING_CUSTOMER` | We are waiting for the customer to act. |
| `VERIFYING` | We are checking the result. |
| `SUCCEEDED` | The payment worked. |
| `FAILED` | The payment did not work. |
| `UNKNOWN` | We cannot tell. |

Rules are checked in order and **the first match wins**. If **no rule matches on a money step, the result is `UNKNOWN`**. A malformed answer, an unexpected answer and silence all end up as `UNKNOWN`. This is deliberate: when we do not understand, we do not guess.

For example, imagine Sadad answers Layla's payment with the word "Approved". A rule that says "Approved means `SUCCEEDED`" matches first. If Sadad answers with a word that no rule knows, the money step ends as `UNKNOWN`. It does not become `FAILED`, because Layla's money may have moved.

### Error maps
An **error map** takes a partner's error code and gives it several labels. One label is about the **circuit breaker**. The circuit breaker is the automatic switch that takes a route out of use when the partner keeps failing.

An error map gives:
* a **canonical error** (our name for it),
* a **classification**: `RETRYABLE_OTP` (customer mistyped a code; they may try again), `TERMINAL_DECLINE` (final), `LIMIT_EXCEEDED` (customer or merchant limit), `GATEWAY_FAULT` (the partner is broken), `AMBIGUOUS` (we cannot tell),
* whether it counts toward the OTP lockout,
* whether it counts toward the **circuit breaker**,
* a message for the customer in Arabic and English,
* a hint for operators.

### Why the classification matters
Imagine Layla mistypes her SMS code ten times. That is her mistake, not the partner's. It must never "break" a payment route for everyone else. Only `GATEWAY_FAULT` and ambiguous results count toward the circuit breaker. Customer mistakes do not.
@@end

@@article id=b06-09 book=6 order=9 title="Credentials and Credential Sets: write-only secrets, ownership and settlement target" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b02-06,b10-06,b11-04
:::summary Big picture in 20 seconds
A credential set holds the identifiers and secrets for one gateway in one environment. Secrets are write-only, encrypted and tied to approved hosts, and a set must pass a live check before customers can see its route.
:::

### What a credential set is
To use Sadad, we need a login: an account number and a secret key that Sadad gave us. A **credential set** is the bundle of these identifiers and secrets for one gateway in one environment (`SANDBOX` or `LIVE`). For example, it may hold the merchant ID, the terminal ID and a secret key.

### Who owns it: `owner_type`
The owner is the company whose account with the payment company it is.
* `PLATFORM`: our own account with the payment company.
* `MERCHANT`: the merchant's own account (they entered it themselves).

### Where the money lands: `settlement_target`
Each set also says where the partner sends the money. Imagine Layla pays Noon Mart 25.500 LYD. With `PLATFORM_CLEARING`, Sadad pays us and we credit Noon Mart's wallet. With `MERCHANT_DIRECT`, Sadad pays Noon Mart directly. This table gives all three values.

| Value | Meaning |
| :--- | :--- |
| `PLATFORM_CLEARING` | The partner pays **us**; we credit the merchant's wallet. |
| `MERCHANT_DIRECT` | The partner pays **the merchant**; we record only our commission as owed to us. |
| `PROVIDER_HELD` | The partner holds the funds for the moment. |

### Status
A set has one of these statuses:
* `UNTESTED`: just saved.
* `VERIFIED`: the live credential check passed.
* `FAILING`: it stopped working; the route is automatically removed from selection.
* `REVOKED`: the set is withdrawn; new payments cannot use it.

### The rules that protect secrets
Secrets are the most dangerous data in the system, so six rules protect them.
1. **Write-only.** You can replace a secret; nobody can read it back, not even an administrator.
2. **Encrypted at rest** with a key that exists only on the core server.
3. **Host-pinned.** A secret works only for the hosts listed for that gateway. If someone changed a step's web address to an outside host, the secret would not be supplied.
4. **Credential changes need two people** (`GATEWAY_ADMIN` proposes, `SECURITY_ADMIN` approves).
5. **Two merchants cannot register the same gateway account.**
6. **Sandbox and live never share** secrets, secret paths or webhook secrets.

### The live credential check
The **CREDENTIAL_CHECK** button on the wizard's second step makes one harmless call to prove the credentials work. A passed check moves the set to `VERIFIED`. A set that is not `VERIFIED` makes its route invisible to customers; see [[a:b06-12|the visible-rails formula]].
@@end

@@article id=b06-10 book=6 order=10 title="Sandbox, live, rollback and what changes for new versus running payments" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=3 ui=AVAILABLE related=b01-08,b06-01,b12-06
:::summary Big picture in 20 seconds
Every gateway version has a test environment (`SANDBOX`) and a real one (`LIVE`), kept apart. A change to a live version affects new payments only; payments already running finish on the settings they started with.
:::

A gateway version is a sealed set of settings. Before a version touches real money, we test it in a place where real money does not exist. When it goes live, we keep a way back. This article explains both, and then shows what a change does and does not touch.

### Two environments per gateway
Each version has a `SANDBOX` environment for testing and a `LIVE` environment for real payments. Each environment has its own:

* web addresses,
* **allowed hosts** (the only hosts the gateway may call),
* **allowed sender IP addresses** (the addresses the partner's messages may come from),
* secrets,
* webhook secret path (the private part of the address where the partner sends its messages to us).

A webhook that arrives at the wrong environment's address is rejected and raises an alert. A sandbox payment can never create a live ledger entry.

### The path to live
A version moves through these steps, in this order:

1. Build it as a draft.
2. Test it on sandbox.
3. Pass the automatic checks.
4. Name a rollback version.
5. Submit it for approval.
6. Get it approved by `SECURITY_ADMIN`.
7. The version is promoted to live.

The 12 gates are in [[a:b06-16|The twelve go-live gates, in plain words]].

### Rollback
Every promotion names a **rollback version**: the version to return to if the new one misbehaves. Rolling back creates a new promotion in the opposite direction. Payments already running are not disturbed; they finish on the version they started with.

### Canary
A **canary plan** is a small first step. Before sending all traffic to a new version, the plan limits it to a percentage of traffic or to a list of merchants. A canary plan is a required gate.

### A worked example
This example uses invented version numbers.

1. Layla starts a 25.500 LYD payment at Noon Mart. It runs on version 3 of the Sadad gateway.
2. While she is typing her SMS code, version 4 is promoted to live.
3. Layla's payment still finishes on version 3. It was pinned to version 3 when it started.
4. The next customer who starts a payment gets version 4.
5. Version 4 misbehaves. The team rolls back to version 3. This is a new promotion in the opposite direction.
6. Any payment started on version 4 finishes on version 4. Only new payments use version 3 again.

Notice that a promotion or a rollback never changes a payment that is already running.

### What changes immediately and what does not
Read the table from the left: the first column is what you changed, the second says who feels it.

| Change | Takes effect for |
| :--- | :--- |
| New live version | New payments only |
| New route priority, pause or resume | New payments only |
| Secret rotation | New calls; both versions work during the overlap |
| Pausing a route | Customers stop seeing it at once; running payments finish |
| Credential set `REVOKED` or route `DRAINING` | New payments only; running payments finish on their pinned settings |
@@end

@@article id=b06-11 book=6 order=11 title="Rails and Routes: priority, cost, limits, health, scope and the circuit breaker" roles=GATEWAY_ADMIN,FINANCE,OPERATOR minutes=4 ui=AVAILABLE related=b06-12,b10-02,b02-06
:::summary Big picture in 20 seconds
A rail is what the customer picks; a route is one technical path to a partner. Routes carry priority, cost, limits, health and scope, and the circuit breaker moves traffic away from a failing route automatically.
:::

When Layla pays at Noon Mart she sees a button such as "Sadad". Behind a button, the platform may have more than one way to reach the partner. This article names the two layers: the button is a rail, and each way to reach the partner is a route.

### Rails
A **rail** is what the customer sees and picks. It has:

* a code, names in Arabic and English, and a logo,
* a collection mode, a currency, and minimum and maximum amounts,
* a display order,
* a **blocked** switch,
* capabilities (refund, partial refund, void, capture, recurring) with a refund window in days.

A rail that was ever used is **never deleted**; use **blocked** instead. On the **Rails** screen, **Add Rail** creates one.

### Routes
A **route** connects one rail to one gateway through a credential policy. One rail may have several routes (for example a direct route and an aggregator route), and the platform chooses among them. The table lists what you can set on a route. The first column is the setting; the second says what it means.

| Setting | Meaning |
| :--- | :--- |
| Credential policy | `PLATFORM` (our account), `MERCHANT_REQUIRED` (the merchant's own account), or `MERCHANT_OR_PLATFORM` |
| Priority and routing strategy | `STRICT_PRIORITY`, `EFFECTIVE_COST` (cheapest expected cost) or `WEIGHTED` (share of traffic) |
| Cost model | Flat fee, percentage, minimum, maximum, and whether the fee is accrued at confirmation |
| Mismatch policy | Tolerance for amount differences and what to do about underpayment or overpayment |
| Limits | Minimum amount, maximum amount, daily cap |
| Status | `ACTIVE`, `PAUSED`, `DRAINING` (finish what is running, take nothing new) |
| Health | `HEALTHY`, `DEGRADED`, `OPEN_BREAKER` |
| Maintenance windows | Times when the route is unavailable |
| Scope | Which merchants, applications, risk tiers and channels (`WEB`, `API`, `POS`) may use it |

On the **Routes** screen, **Add Route** picks a rail and a gateway, a priority and an optional maximum amount.

### How the platform chooses between routes
Only routes that are allowed to carry the payment take part. A route is out if it is not `ACTIVE`, is not healthy, is outside its limits, is in a maintenance window, is out of scope, or has no verified credential set. After that, the routing strategy orders the routes that are left:

* `STRICT_PRIORITY`: the route with the higher priority number comes first.
* `EFFECTIVE_COST`: the route with the lowest expected fee for this amount comes first. If two routes cost the same, the higher priority number wins.
* `WEIGHTED`: the weight on each route is used, as the table above says (share of traffic).

### A worked example
All numbers here are invented for the example. Imagine a wallet rail at Noon Mart that has two routes.

| | Route A (direct) | Route B (aggregator) |
| :--- | :--- | :--- |
| Priority | 20 | 10 |
| Fee | 0.100 LYD plus 1% | 1%, minimum 0.300 LYD |
| Maximum amount | 100.000 LYD | none |

Layla pays 25.500 LYD.

1. Route A costs 0.100 + 1% of 25.500 (0.255) = **0.355 LYD**.
2. Route B costs 1% of 25.500 = 0.255, which is below its minimum, so it costs **0.300 LYD**.
3. With `STRICT_PRIORITY`, route A is first, because 20 is higher than 10.
4. With `EFFECTIVE_COST`, route B is first, because 0.300 is lower than 0.355.

Now a customer pays 150.000 LYD. Route A is out, because 150.000 is above its maximum of 100.000. Only route B is left. Its fee is 1% of 150.000 = **1.500 LYD**, which is above its minimum, so the minimum does not apply.

The same happens if route A's health becomes `OPEN_BREAKER`: it drops out and route B carries the payment.

### The circuit breaker
A circuit breaker is a safety switch, like the one in a home electrical panel. It cuts a failing path so the damage does not spread.

The platform measures each route continuously: successes, definite failures, ambiguous results, rate-limit errors and response times. When a partner is failing, the **circuit breaker opens** automatically. Then:

1. The route's health becomes `OPEN_BREAKER`.
2. Customers stop seeing the route.
3. New payments use the next healthy route.
4. A small test call is repeated until the partner recovers.

Only partner faults count; customer mistakes do not. The procedure for staff is [[a:b10-02|RB-01 Gateway outage and the circuit breaker]].

### Routes change money behaviour
Editing a route can change fees, limits and who sees a payment method. Route edits are guarded by a checklist, so open [[c:sg-edit-route|the checklist for creating or changing a route]] first. Credential, route and payout-bank edits need `SECURITY_ADMIN` approval.
@@end

@@article id=b06-12 book=6 order=12 title="The visible-rails formula: why a customer does or does not see a payment method" roles=ALL minutes=4 ui=AVAILABLE related=b02-06,b05-06,b07-12
:::summary Big picture in 20 seconds
Core shows a payment method only when every one of nine conditions is true, and the route conditions must be satisfied by one single route. The first failing condition is the answer to “why can’t my customer see this method?”.
:::

When Layla opens a payment link from Noon Mart, she sees a short list of payment methods. The platform builds that list each time. A payment method is called a rail, and each rail has one or more routes. [[a:b06-11|The article on rails and routes]] explains both. For each rail, the core asks nine yes-or-no questions. One "no" hides the rail.

### The nine conditions
A rail is shown only if **every one** of these conditions is true. Read the table from top to bottom. The right-hand column says the same thing in plain words.

| # | Condition | In plain words |
| :--- | :--- | :--- |
| 1 | The application allows the rail | The merchant's application whitelist includes it (or has no whitelist). |
| 2 | The link allows the rail | The link's own list includes it (or has none). |
| 3 | A live commission profile covers it | We have an agreed fee for this merchant/application and rail at this amount. |
| 4 | At least one route is `ACTIVE` | The route is switched on. A `PAUSED` or `DRAINING` route does not count. |
| 5 | That route is `HEALTHY` | The circuit breaker is not open and it is not degraded. |
| 6 | The amount is inside the route's limits | Minimum, maximum, and the daily cap is not exceeded. |
| 7 | Not in a maintenance window, and the route's scope includes this merchant, application, risk tier and channel | The route is not switched off for maintenance, and it is allowed for this merchant, application, risk tier and channel. |
| 8 | The route's credential set is `VERIFIED` | The credentials the route uses have been tested and are good. |
| 9 | The rail's currency matches the link and the rail is not blocked | The link and the rail use the same currency, and nobody has blocked the rail. |

The conditions on the route (4 to 8) must all be satisfied **by one single route**. It is not enough that one route is `ACTIVE` and a different route is `HEALTHY`.

### A worked example
Noon Mart sends Layla a link for 25.500 LYD. The Sadad rail has one route. Its limits are a minimum of 1.000 LYD and a maximum of 100.000 LYD, with a daily cap of 1,000.000 LYD. All the numbers in this example are invented.

**Case 1: everything is true.** The application and the link both allow Sadad. A commission profile covers 25.500 LYD. The route is `ACTIVE`, `HEALTHY`, in scope, outside maintenance, and its credentials are `VERIFIED`. The amount is inside the limits. The currency is LYD and the rail is not blocked. Layla sees Sadad.

**Case 2: the amount is too large.** The link is for 150.000 LYD. Condition 6 fails, because 150.000 is above the maximum of 100.000. Sadad is hidden.

**Case 3: the daily cap.** The route has already processed 990.000 LYD today. A new 25.500 LYD link would bring the day to 990.000 + 25.500 = 1,015.500 LYD, which is above the cap of 1,000.000. Condition 6 fails again, although the amount alone is inside the limits.

**Case 4: no single route passes.** Imagine a different rail that has two routes. Route 1 is `ACTIVE` but its circuit breaker is open, so it fails condition 5. Route 2 is `HEALTHY` but `PAUSED`, so it fails condition 4. Each condition is true for some route, but no one route passes all of them. That rail is hidden.

### Using this to diagnose
A merchant says "my customers cannot see Sadad". Walk down the table. The first failing line is the answer. Most often it is line 5 (breaker open), line 6 (amount above the maximum), line 3 (no commission profile for the amount) or line 1 (the application's list).

The widget below lets you try it yourself. Change the amount, the currency, the time, the lists or a route's health, and watch which line fails.

{{widget:visible-rails}}
@@end

@@article id=b06-13 book=6 order=13 title="The Add-a-Gateway wizard: all eight steps" roles=GATEWAY_ADMIN minutes=5 ui=AVAILABLE related=b06-14,b06-16,b06-03
:::summary Big picture in 20 seconds
The wizard builds a new gateway in eight steps, and every step is saved into a draft version, so nothing here can change a live payment. Step 8 tests the draft and sends it for approval.
:::

Adding a gateway is like filling in a long form for a new partner. You describe who the partner is, where it lives, what the customer types, how we sign messages, and what each answer means. The wizard splits that form into eight steps so you can do one part at a time.

Open **Gateways** and choose **New Gateway** (or open an existing gateway). The wizard has eight steps, in this order. Each step is saved as part of a **draft version**; nothing you do here changes a live payment. [[a:b06-01|Gateways in depth]] explains versions and the other words used on this page.

### Words you will meet in the steps
* A **rail** is the payment method the customer picks. A **credential set** is the group of secrets we use to log in to the partner.
* A **crypto profile** is a recipe for signing our messages to the partner, and for checking the partner's signatures.
* A **channel** is a way the platform hears about a payment result, for example the customer's browser coming back, a webhook, or polling. A **weak channel** is one we cannot trust alone. The platform must still *ask the partner* for the real status.
* The **amount scale** is the unit the partner expects. For example, a partner may want whole dirhams, and 1 LYD is 1000 dirhams. So 25.500 LYD is sent as `25500`. A wrong scale is the "1000-times error": the partner would charge 1000 times too much or too little.

### The eight steps
Read each row as one step. The last column is a trap to avoid at that step.

| Step | Name | What you do | The trap to avoid |
| :--- | :--- | :--- | :--- |
| 1 | Identity & Basics | Code, name, operator, country, aliases, kind, verification state, risk class. | Choosing `NORMAL` for a gateway that has neither signed webhooks nor a status question. |
| 2 | Environments & Auth | Sandbox and live addresses, allowed hosts, allowed sender IPs, the authentication method, and the credential set. Run **CREDENTIAL_CHECK**. | Putting a live address in the sandbox section, or the reverse. |
| 3 | Customer Catalog | Build the rail and its form fields in Arabic and English, with patterns and normalisers. | A phone pattern that rejects valid numbers. |
| 4 | Crypto Profiles | Build signing and checking recipes; test them with the partner's own sample. | Testing with your own made-up sample instead of the partner's. |
| 5 | Flow Builder | Build the steps of each phase with parameters, transforms, side effects and retry rules. | Forgetting `NEVER` retry on the money step. |
| 6 | Client Action & Channels | Choose what the customer sees next; set confirmation channels and polling. | Leaving a weak channel without the *must ask the partner* switch. |
| 7 | Status Rules & Costs | Map partner codes to statuses and messages; set amount scale, precision, rounding; route cost; statement format. | Wrong scale (the 1000-times error). |
| 8 | Simulator & Approval | Inspect the built requests, run the 15 automatic scenarios and contract tests, name a rollback version, submit for approval. | Submitting without reading the preview. |

A few of these rows have a short explanation behind them:

* **Step 1 trap.** A gateway with neither a signed webhook nor a status question is `HIGH_RISK`, not `NORMAL`.
* **Step 3 patterns and normalisers.** A pattern says what a valid phone number looks like. A normaliser tidies what the customer typed into one standard form.
* **Step 5.** The step types and the retry rules are explained in [[a:b06-03|The engine: ten phases, steps, side effects and the retry boundary]].

### Step 8: simulator and approval
Submitting step 8 is a guarded action: open [[c:sg-submit-gateway-version|Submit a gateway version for approval]] first. After submission a `SECURITY_ADMIN` reviews it.

The simulator runs **15 automatic scenarios**. They are:

1. happy path
2. wrong code then success
3. expired code
4. insufficient funds
5. customer limit hit
6. cancel
7. server error on confirm
8. timeout on confirm
9. unreadable answer
10. duplicate webhook
11. out-of-order webhook
12. late webhook after expiry
13. amount mismatch
14. a three-decimal rounding case
15. a webhook sent to the wrong environment

:::note Save-time safety checks
The wizard refuses to save any of these:
* a money step with automatic retry,
* an answer-based value on the first step,
* weak channels without verification,
* web addresses to hosts that are not allowed.
:::
@@end

@@article id=b06-14 book=6 order=14 title="Smart AI Integration: adding a gateway with an AI assistant, safely" roles=GATEWAY_ADMIN minutes=4 ui=AVAILABLE related=b06-13,b06-16
:::summary Big picture in 20 seconds
Smart AI Integration lets you use an AI assistant in your own browser to draft a gateway's configuration. The platform never calls an outside AI, never gives it a secret, and checks the result before saving it as a draft.
:::

A new partner usually sends a long technical document. Copying it by hand takes hours, and typing mistakes are easy. With this feature, an AI assistant reads the document and writes a first draft of the settings for you. The platform then checks that draft strictly, and a person still approves it.

### Why this exists
**Smart AI Integration** lets you use any AI assistant **in your own browser** to draft the configuration, while the platform checks the result. The platform itself **never calls an outside AI** and never sends it any secret. The wizard is described in [[a:b06-13|The Add-a-Gateway wizard]].

### The four stages
Read the table from top to bottom. The column "Where" tells you which stage happens inside our platform (Back Office) and which happens outside it.

| Stage | Where | What happens |
| :--- | :--- | :--- |
| 1. Download the kit | Back Office | The platform generates one document (the *kit*) from its own live rules: the exact format the AI must produce, the allowed lists, two complete examples, and a place to paste the partner's documents. |
| 2. Ask the AI | Your browser, outside the platform | You give the AI the kit plus the partner's documents. It returns one file, `integration-spec.json`. |
| 3. Upload and verify | Back Office | The platform checks the file in four layers (below). If it fails, it gives you a ready-made **repair message** to paste back to the AI. |
| 4. Add secrets and import | Back Office | You type the real secrets into the platform; it saves the whole configuration as a **draft** and runs the credential check. |

### The four verification layers
The platform checks the AI's file in four layers.

1. **Schema and version.** The file has the right shape and version.
2. **Meaning and security.** The platform checks these rules:
    * web addresses use `https`, point only to allowed hosts and never to private network addresses;
    * no value from an earlier answer is used on the first step;
    * money steps never retry;
    * every signature refers to a declared recipe;
    * weak channels must ask the partner;
    * at least one test example is included.
3. **Offline simulation.** The platform runs the real engine against the **sample requests and answers inside the file itself**. It checks that the result matches what the file claims: the final status, the extracted values, the signature and the amount sent. No network and no database are used.
4. **Collision check.** The platform looks for a gateway or rail with the same code. If one exists, you can choose *Create New* or *New Version*.

### Safety rules you must follow
1. **Never paste a real secret into the AI.** Give it only the *names* of the credentials (or dummy sandbox values). The file declares which credentials are needed; you type the real values into the platform afterwards.
2. **Everything arrives as a draft.** The version is `DRAFT`, the route is `PAUSED`, the credential set is `UNTESTED`. It still needs the live credential check, the 12 gates and a second person. [[a:b06-16|The twelve go-live gates, in plain words]] lists the gates.
3. **Read the preview.** The platform shows what will be created. Compare it with the partner's document yourself.
4. Some step types (`WAIT`, `ASSERT`, `BRANCH`) cannot be imported; add them in the wizard's flow editor afterwards.

Creating the draft is a guarded action: open [[c:sg-ai-import-draft|Create a draft from an AI-generated spec]] first.

:::warning The AI can be confidently wrong
The test examples in the file (the test vectors) catch many mistakes. But an AI can invent a selector, which is the path that picks a value out of the partner's answer. It can also choose the wrong amount scale. A weak example would not expose either mistake. The 12 gates and the human reviewer are still required.
:::
@@end

@@article id=b06-15 book=6 order=15 title="Direct, aggregator and first-party: the gateway landscape and evidence levels" roles=GATEWAY_ADMIN,OPERATOR,SUPPORT minutes=5 ui=AVAILABLE related=b01-03,b06-01,b06-16
:::summary Big picture in 20 seconds
The design covers twenty integrations in three families: direct, aggregator and first-party. Each has an evidence level that says how well we know its real behaviour, and weak evidence needs extra proof before going live.
:::

To take Layla's 25.500 LYD, the platform can talk to the wallet company itself. That is a **direct** integration. Or it can talk to a company that offers many wallets through one door. That is an **aggregator**. Or it can talk to our own wallet system. That is **first-party**.

The platform's design covers twenty integrations. The table below is a map, not a promise that each is live today: what is live depends on what your administrators have configured and approved. Use it to understand the *shape* of each.

### The three families
* **Direct.** We connect to the payment company itself. Examples: Moamalat, Sadad.
* **Aggregator.** We connect to a company that offers many methods through one door. Examples: DPay, Plutu, MyPay.
* **First-party.** The system is our own. The example is NeomPay. In the gateway record this kind is called `INTERNAL`. [[a:b06-01|Gateways in depth]] explains the kinds.

### How to read the table
Each row is one gateway. The column "Typical mode(s)" says how the customer pays. The last column gives the main thing to remember about that gateway. The table is a lookup list, so you do not have to read it from top to bottom.

These are the modes in plain words. [[a:b06-02|The nine collection modes in depth]] gives the details.

* `OTP_PULL`: the customer receives an SMS code and types it on our page.
* `REDIRECT`: the customer goes to the payment company's own page and comes back.
* `EMBEDDED`: the payment company's small window opens on top of our page.
* `PUSH_APPROVAL` (push): the customer taps Approve in a wallet app.
* `QR_DISPLAY` (QR): the customer scans a QR code.
* `HYBRID`: one method that offers several of the above.

Other words in the table:

* A **status question** is a read-only question to the partner about one payment. Without it, only statements or an operator can settle a doubt.
* A **signed webhook** is a message from the partner to us, with a signature that proves who sent it.
* An **idempotency key** lets us send the same request twice with the effect of once.
* **Mutual TLS** means both sides show a digital ID card.
* **Dirhams**: 1 LYD is 1000 dirhams.

| Gateway | Typical mode(s) | In one line |
| :--- | :--- | :--- |
| Moamalat NPG | `EMBEDDED` or `REDIRECT` | National switch for cards; amounts in dirhams as whole numbers; secret key in hexadecimal; always ask the partner for status. |
| LYPay (CBL instant payment) | `QR_DISPLAY`, `PUSH_APPROVAL` | Central Bank instant payment; a short window (about 5 seconds) for an immediate answer, otherwise a signed webhook. |
| Numo Pay | `EMBEDDED`, push, QR | Moamalat's payment button; built from vendor pages, so treated cautiously. |
| Sadad | `OTP_PULL` (two steps) | Almadar Aljadeed wallet; SMS code; no status question on the aggregator. |
| Libyana Pay | `OTP_PULL`, `REDIRECT` | Libyana wallet; partial information only. |
| Edfali / Edfaa Li | `OTP_PULL` (two steps) | BCD Bank wallet; 4-digit code; **no status question** so statements are essential. |
| MobiCash | `OTP_PULL`, QR | Wahda Bank / Masarat wallet. |
| Tadawul / T-LYNC | `REDIRECT` | Hosted page; browser and callback are hints only; always asks the partner. |
| OnePay | QR, pay code, OTP | Central Bank cross-bank payment. |
| Yussor Pay, Sahara Pay, Masrefy Pay | `HYBRID` / `OTP_PULL`, QR | Bank wallets on the Masarat network. |
| Hawelli | `HYBRID` | Push, QR, deep link; built from partial information. |
| GPay Libya | push, QR | Signed requests; vendor information only. |
| Google Pay | `EMBEDDED` | Tokenised card sheet that settles through a card rail. |
| Visa / Mastercard (MPGS) | `REDIRECT` or `EMBEDDED` | 3-D Secure cards; card data never touches our server. |
| Evo Pay (evowallet.net) | QR, push | Not the same company as EVO Payments International. |
| DPay | `REDIRECT` and per-method | Aggregator; supports an idempotency key; signed webhooks. |
| Plutu, MyPay | `OTP_PULL`, `REDIRECT` | Aggregators; no public status question. |
| NeomPay | `HYBRID` (push, code, QR) | **First-party**: our own wallet platform, trusted over mutual TLS; posts straight to the treasury. |

### Evidence level
Each gateway carries an **evidence level** describing how well its behaviour is known. The less we know, the more proof we need before going live.

* `VERIFIED`: from official documents or a public software kit.
* `PARTIAL`: some of the behaviour is known, not all of it.
* `UNVERIFIED`: from a vendor page only.
* `INTERNAL (FIRST-PARTY)`: our own system, tested against the operator's staging environment.

A gateway that is not `VERIFIED` needs extra evidence or a signed risk acceptance before going live. This is gate 9 in [[a:b06-16|The twelve go-live gates, in plain words]].

### A worked example: why the one-line notes matter
Layla pays 25.500 LYD at Noon Mart with Edfali. She types her 4-digit code. The confirm call times out, so we do not know whether the money moved.

For a gateway with a status question, we would ask the partner and get the answer. Edfali has **no status question**. So the attempt cannot be settled by asking. Only the statement or an operator can settle the doubt. That is why the table says "statements are essential" for Edfali.

Now compare Moamalat. Its row says "always ask the partner for status", so the platform asks the partner whenever it is unsure.
@@end

@@article id=b06-16 book=6 order=16 title="The twelve go-live gates, in plain words" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=4 ui=AVAILABLE related=b06-13,b06-10,b13-05
:::summary Big picture in 20 seconds
A gateway version cannot become `LIVE` until all twelve gates pass. The gates prove that someone else approved it, that the tests are green, and that the money rules, evidence and safety nets are in place.
:::

Before a pilot flies passengers, a checklist must be complete. No single item is optional. Our go-live gates work the same way: twelve checks, and one failure stops the version.

A gateway version cannot become `LIVE` until **all twelve** gates pass. Gate 1 is about people: a second person must approve. Gates 2 to 5 are tests that the platform runs. The other gates check the partner evidence, the money rules and the safety nets.

### How to read the table
Each row is one gate. "What it proves" says what the gate shows. "What a failure usually means" is the most likely cause when the gate is red. An empty last cell means there is no usual cause to list.

| # | Gate | What it proves | What a failure usually means |
| :-- | :--- | :--- | :--- |
| 1 | Two-person approval | A different person from the maker approved. | You tried to approve your own work. |
| 2 | 15-scenario sandbox suite is green | The behaviours listed in [[a:b06-13]] work. | A status rule or retry setting is wrong. |
| 3 | Amount pipeline contract test is green | `10.50 → "10500"` (dirhams) and `76.255 → "76.26"` (two decimals, nearest). | Wrong scale, precision or rounding. |
| 4 | Reference format contract test is green | Our reference uses the allowed characters, length and is unique. | Partner rejects or truncates our reference. |
| 5 | Signature contract test is green | Our signatures match captured real partner samples. | Key encoding, field order or case. |
| 6 | Channel strength is enforced | Every weak channel asks the partner. | A hint channel is trusted alone. |
| 7 | A rollback version is named | We know where to go back to. | |
| 8 | Route limits, commission profile and statement parser are previewed | Money rules are visible before they apply. | |
| 9 | Evidence level is `VERIFIED` (or a signed `HIGH_RISK` acceptance; or, for first-party rails, a green suite against the operator's staging) | We know how the partner really behaves. | Built from vendor pages only. |
| 10 | PCI scope review passed for any rail with a card-number field | Card data handling is compliant. | |
| 11 | Canary traffic plan configured | New versions start small. | |
| 12 | Route alerts and runbooks are wired | If it fails, someone is told and knows what to do. | |

### Gate words in plain language
* A **contract test** is an automatic test that compares what we send, or what we expect, with a fixed correct answer.
* The **amount pipeline** is what happens to an amount before we send it to the partner: its scale, precision and rounding. A partner may want dirhams as whole numbers (1 LYD is 1000 dirhams), or only two decimals.
* A **reference** is the payment code we send to the partner so both sides can find the same payment.
* A **weak channel** is a way of learning the result that is only a hint, such as the customer's browser coming back. The platform must still ask the partner.
* **Evidence level** says how well we know the partner. [[a:b06-15|The gateway landscape and evidence levels]] lists the four levels.
* **PCI** is the payment-card security standard. The review applies to any rail where the customer types a card number.
* A **canary plan** limits a new version to a small share of traffic or a few merchants. See [[a:b06-10|Sandbox, live, rollback and what changes for new versus running payments]].

### A worked example: gate 3 with real numbers
These two examples come from the gate itself. A partner takes dirhams as whole numbers, so 10.50 LYD becomes `"10500"`.

* If the scale were wrong and the platform sent `"10.50"`, the partner would read 10.50 dirhams. That is 1000 times too small.
* A second partner takes two decimals and rounds to the nearest. So 76.255 LYD becomes `"76.26"`. A version that cut the digits instead would send `"76.25"`, and the contract test would turn red.

Following the same rule, Layla's 25.500 LYD payment at Noon Mart would be sent as `"25500"` to the first partner.

:::note Who checks what
Gate 1 is enforced by the database, the approval service and the API; you cannot bypass it. Gates 2 to 5 are run by the platform; you read the results. The rest are confirmed by the approver. Never approve a version for which you did not read the gate results.
:::
@@end

@@article id=b06-17 book=6 order=17 title="Fourteen engine safeguards in plain language" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=5 ui=AVAILABLE related=b06-03,b11-01
:::summary Big picture in 20 seconds
The gateway engine has fourteen built-in safeguards. They protect money and secrets even when someone makes a configuration mistake or an outside party misbehaves. You do not operate them, but knowing them explains many refusals.
:::

Think of the safety rules in a bank branch: a time lock on the safe, a camera, a limit on cash at the counter. The staff do not run them each day, but they explain why some things are not allowed. The engine has the same kind of rules.

The engine is the part of the core that follows each gateway's recipe and talks to the partners. [[a:b06-03|The engine: ten phases, steps, side effects and the retry boundary]] describes it. These fourteen safeguards protect it even if someone makes a configuration mistake or an outside party misbehaves.

### How to read the table
Each row is one safeguard. The column "Safeguard" is the technical name. "What it prevents" is the problem it stops. "In plain words" says the same thing in everyday language.
| # | Safeguard | What it prevents | In plain words |
| :-- | :--- | :--- | :--- |
| 1 | Safe path-setting for building requests | A crafted field name corrupting the program's own data. | A tricky field name cannot reach into the engine's own data. |
| 2 | One shared, cached connection per gateway account | Duplicate connections and runaway timers under load. | Each gateway account reuses one connection instead of opening many. |
| 3 | Single refresh of an expired token | A stampede of token requests when many payments hit an expired token at once. | When a login token expires, one request gets a new token, not many. |
| 4 | Randomised token refresh timing | Every server refreshing at the same moment. | Servers refresh at slightly different times. |
| 5 | Saving a new refresh token before using it | Losing a login session after a restart. | The new token is stored first, so a restart does not lose the login. |
| 6 | A time limit on every outbound call | A stuck partner freezing us. | Every call to a partner has a deadline. |
| 7 | No automatic retry of money steps | Paying twice. | A money step is never repeated by the engine on its own. |
| 8 | Reading answers as text first, with size limits | Oversized or malicious answers; XML attacks. | An answer is read as plain text and checked for size before it is used. |
| 9 | Removing secrets from every log | Secrets ending up in logs. | Logs never show a secret. |
| 10 | Blocking requests to private addresses, and checking redirects | A configuration being used to attack our own network. | A gateway setting cannot point the engine at our own internal network, even through a redirect. |
| 11 | Secrets tied to allowed hosts | Stolen or misdirected secrets. | A secret can only be sent to the hosts that are allowed for it. |
| 12 | Broadcasting changes to every server within seconds | Servers disagreeing about the current configuration. | When settings change, every server hears about it within seconds. |
| 13 | Correct escaping for each destination (JSON, XML, address, header) | Injection of extra fields or commands. | A value is written safely for where it goes, so it cannot add extra fields or commands. |
| 14 | Re-checking the final web address after substitution | A value turning a safe address into a dangerous one. | After values are filled in, the finished address is checked again. |

A fifteenth safeguard applies between our own services: each service proves its identity with a certificate, and the core re-checks everything it is sent. [[a:b02-02|The seven services and why they are separated]] explains why.

### A worked example: a partner stops answering
The time limits are the engine's own. [[a:b06-03|The engine article]] lists them.

1. Layla pays 25.500 LYD at Noon Mart with direct Sadad. She types her code and the engine sends the confirm call, which is the money step.
2. The partner does not answer. Safeguard 6 applies: every call has a time limit, 15 seconds for a confirm call, so we do not wait forever.
3. After 15 seconds the call ends. Safeguard 7 applies: the engine does not repeat the money step on its own, because the first attempt may have moved money.
4. The payment becomes `UNKNOWN`. The platform asks the partner for the status if it can. Otherwise a statement or an operator settles it.

A second example uses invented numbers. A token expires while 40 payments arrive. Safeguard 3 means one refresh request, not 40. Safeguard 4 means the servers do not all refresh in the same second.
@@end


### BOOK 7 — PAYMENTS IN OPERATION

@@article id=b07-01 book=7 order=1 title="Reading a payment: references, amounts and every field you will see" roles=OPERATOR,SUPPORT,FINANCE minutes=5 ui=AVAILABLE related=b07-02,b01-05,b02-03
:::summary Big picture in 20 seconds
Each payment attempt has several references, amounts, a state and a history. Read them in the order below and you will know what happened without guessing.
:::

Think of a payment screen as a case file. At the top are the numbers that identify the file. Then come the amounts, then the state, then the history. This article shows you each part and what to do with it.

### One word: attempt
Each time a customer tries to pay a link, the platform records a **payment attempt**. A link can have several attempts. For example, the customer tried twice, or a first try failed. The things you inspect on screen are attempts.

### The four references: never confuse them
A reference is a number that names one payment. Four different numbers exist because four different parties each keep their own record. Read the table to see whose number each one is and when to quote it.

| Field | Whose number it is | Use it for |
| :--- | :--- | :--- |
| Reference | Ours | Quoting to anyone, including partners. Unique. |
| Gateway reference | The one we send to the partner as our identifier | Matching with the partner's records. |
| Provider reference | The partner's own transaction number | Asking the partner about this payment. |
| Network reference | A third network's number (for example a card switch) | Card disputes. |

:::tip Quote the reference
When you speak to a partner or a colleague, say the reference. Never identify a payment by the customer's name.
:::

### The amounts
All amounts are in LYD, with up to four decimals. Read the rows as a list of every amount you may see. The first three describe what the payer is asked to pay. The last rows describe what was taken, the fees and what the merchant is credited.

| Field | Meaning |
| :--- | :--- |
| Requested amount | The amount of the link. |
| Surcharge amount | Extra the payer pays when the fee bearer says so (0 otherwise). |
| Total charged amount | What the payer is asked to pay: requested plus surcharge. |
| Gateway amount (wire) | The text we actually sent to the partner after scale and rounding (for example `"10500"`). |
| Settled amount | What the partner says was taken. |
| Gateway fee | The partner's fee, if reported. |
| Platform commission | Our fee. |
| Net merchant amount | What the merchant is credited. |

The fee bearer is the rule that says who pays our commission. To learn more, read [[a:b01-05|how fees and commission work]]. Here is an example with invented numbers. Noon Mart makes a 100.000 LYD link, and the fee bearer says the payer pays the surcharge. The requested amount is 100.000, the surcharge amount is 3.000, and the total charged amount is 103.000. The platform commission is 3.000 and the net merchant amount is 100.000.

### Other fields
* **Environment**: `SANDBOX` (test) or `LIVE` (real money). Check it first.
* **Mode** and sub-mode: the collection mode used.
* **Status** and **substatus**: the state of the attempt, with a more precise reason, for example `OTP_REQUIRED`. Every state is explained in [[a:b07-02|The fourteen payment states, one by one]].
* **OTP attempts**: how many code tries were used.
* **Expires at** and **grace expires at**: the payment's time limit, and the later time until which a late confirmation is still accepted. See [[a:b07-06|Slot reservation, single-use links, expiry and the grace window]].
* **Pinned configuration**: the gateway version, route, credential set and commission profile this attempt started with. They never change for this attempt.
* **Customer fields (masked)**: what the customer typed, with sensitive parts hidden.

### The step log: your evidence
Each outbound call to the partner is recorded with the request (secrets removed), the answer text, the HTTP status, the duration and the outcome. When something is unclear, the step log is the evidence.

### What you do when you open a payment
1. **Environment.** What you see: `SANDBOX` or `LIVE`. What it means: only `LIVE` involves real money. What you do: check this before anything else.
2. **References.** What you see: four numbers. What it means: each belongs to a different party. What you do: copy the Reference to quote it, and the Provider reference to ask the partner.
3. **Status.** What you see: a state and maybe a substatus. What it means: where the payment is now. What you do: look it up in the states article and follow its last column.
4. **Step log.** What you see: the calls we made and the answers. What it means: the evidence of what happened. What you do: read it before you decide anything.
@@end

@@article id=b07-02 book=7 order=2 title="The fourteen payment states, one by one" roles=ALL minutes=4 ui=AVAILABLE related=b07-03,b07-06,b13-02
:::summary Big picture in 20 seconds
Every payment attempt is in one of 14 states. Eleven describe progress, and the last three describe what happened after success; only SUCCEEDED writes money to the ledger.
:::

A parcel has a tracking status: "packed", "on the way", "delivered". A payment attempt has a status too, and it is called its **state**. The state tells you where the payment is now, whether the link slot is held, consumed by a success or free again, and whether money has been written to our books. Those books are the **ledger**.

Every attempt is in one of **14 states**. The first eleven describe progress; the last three describe what happened after success.

### What each state means and what you do
Read each row from left to right. "Link slot" tells you whether the slot on the payment link is reserved, used by a success, or released. Slots are explained in [[a:b07-06|their own article]]. "Money posted?" tells you whether the ledger has an entry. The last column is the action for a person.

| State | Plain meaning | Link slot | Money posted? | What a human should do |
| :--- | :--- | :--- | :--- | :--- |
| `CREATED` | The attempt exists; guards passed; nothing sent to the partner yet. | Reserved | No | Nothing. Seconds only. If it stays, escalate. |
| `INITIATING` | The engine is starting the payment with the partner. | Reserved | No | Nothing. |
| `AWAITING_CUSTOMER` | Waiting for the customer: type the code, approve, scan, pay on the partner's page. | Reserved | No | Nothing. Do not nudge the customer to pay again. |
| `AUTHORIZING` | The money step is in flight right now. | Reserved | Not yet | Nothing. If it stays here, it will become `UNKNOWN` by itself. |
| `VERIFYING` | We believe something happened but must confirm with the partner. | Reserved | Not yet | Nothing, unless it stays long (dashboard bar growing). |
| `UNKNOWN` | **We do not know** whether money moved. | **Still reserved** | No | Follow [[a:b07-03]]. |
| `SUCCEEDED` | Verified success. | Used (counted as confirmed) | **Yes**, in the same transaction | Nothing. |
| `FAILED` | A clear, final failure. | Released | No | Nothing. If a customer insists they paid, see [[a:b07-12]]. |
| `EXPIRED` | The time limit passed with no confirmation (after a last check with the partner). | Released | No | Nothing. A late success can still arrive: [[a:b07-08]]. |
| `CANCELLED` | Cancelled by the customer or by the system. | Released | No | Nothing. |
| `BLOCKED` | A guard stopped it (velocity limit, watch-list, AML rule, merchant not allowed). The customer sees only "cannot process this payment". | Released | No | Never explain the real reason to the customer. |
| `PARTIALLY_REFUNDED` | Part of a successful payment was returned. | Used | Yes, refund posted | See Book 8. |
| `REFUNDED` | The whole payment was returned. | Used | Yes, refund posted | See Book 8. |
| `DISPUTED` | A dispute or chargeback was opened. The payment is not "undone"; the dispute is handled separately. | Used | Yes | See [[a:b08-09]]. |

### An example: Layla pays 25.500 LYD
Layla pays 25.500 LYD to Noon Mart with Sadad. One possible path is this. The attempt is `CREATED`, then `INITIATING` while we ask Sadad to send the code. It becomes `AWAITING_CUSTOMER` while Layla types the code. It becomes `AUTHORIZING` while the money step runs. Then it becomes `SUCCEEDED`, and the ledger entry is written in the same moment. If Sadad had not answered clearly at the money step, the attempt would have become `UNKNOWN` instead, and nothing would be posted.

### Three rules about movement
1. **Forward only.** `SUCCEEDED` is never changed back to a failure by a later event. If two trusted sources disagree, the attempt freezes in `UNKNOWN` and a priority-1 conflict case opens.
2. **Uncertainty never becomes failure.** A timeout, an unreadable answer or an unexpected answer is `UNKNOWN`, never `FAILED`.
3. **Success and the ledger entry happen together or not at all.** There is no state where an attempt is `SUCCEEDED` without its journal entry.

### Try the state machine
Click events and watch the state, the link slot and the money.

{{widget:attempt-states}}
@@end

@@article id=b07-03 book=7 order=3 title="UNKNOWN: what it means and exactly what to do" roles=ALL minutes=6 ui=AVAILABLE related=b07-04,b07-09,b10-04,b00-03
:::summary Big picture in 20 seconds
UNKNOWN means we sent a charge request and did not get a clear answer. The money may or may not have moved, so the slot stays reserved, nothing is posted, and the platform keeps asking the partner until the truth is known.
:::

This is the most important operational article. Read it twice.

Imagine you post a letter with cash inside and the post office never says "delivered". The letter may be lost, or it may have arrived and the receipt got lost. You cannot tell which one is true. A payment in `UNKNOWN` is in the same position, and you must not guess.

### What `UNKNOWN` means
We asked a payment company to take money, and we did **not** receive a clear answer. The request may never have arrived. It may have arrived and the money moved, but the reply was lost. **From our side, these cases look identical.** So the platform records exactly that: *we do not know*.

### An example
Layla pays 25.500 LYD to Noon Mart with Sadad. She types her code, and our platform sends the confirm request. Sadad's answer never comes back. The attempt moves to `UNKNOWN`. Maybe Sadad took 25.500 LYD from Layla and the reply was lost. Maybe Sadad never received the request. We cannot see the difference, so we wait for evidence.

### What `UNKNOWN` holds
* The **link slot stays reserved**. A single-use link cannot be paid again by another attempt while this one is unresolved. This prevents two payments for one invoice.
* **No money is posted.** The merchant's balance does not change.
* The attempt continues to be watched: the platform keeps asking the partner, listens for its webhook, and waits for the settlement statement.

### Why guessing is dangerous
Read each row as: "if you guess this, and the guess is wrong, this is the damage".

| If you guess... | ...and you are wrong | Result |
| :--- | :--- | :--- |
| "Failed", and ask the customer to pay again | The first payment actually succeeded | The customer paid **twice**. |
| "Succeeded", and the merchant ships the goods | The money never moved | The merchant **lost goods** and we owe money we do not have. |
| Re-send the OTP or press confirm again | The first confirm worked | A **second** payment is started. |

### What the platform does on its own
You do not have to start any of this. It happens while you work.
1. Asks the partner again, with increasing delays, if the partner offers a status question.
2. Accepts a signed webhook from the partner.
3. Compares against the partner's settlement statement when it arrives.
4. Opens an **operator case** with a deadline.

### What you do (operators)
Follow the steps in order. For each step you see what you will find, what it means, and what you do.

1. **Check the environment badge.**
   * What you see: `SANDBOX` or `LIVE` on the attempt.
   * What it means: `SANDBOX` cases do not matter to real money.
   * What you do: note that `SANDBOX` cases do not matter to real money. Continue with the steps below.
2. **Open the case** in **Operator Cases**.
   * What you see: the case and its step log.
   * What it means: the step log shows what we sent, what came back, and how long it took.
   * What you do: read the step log first.
3. **Press Inquire on the attempt.** This asks the partner for the real status. See [[a:b07-09|how an inquiry works]].
   * What you see: the partner's answer.
   * What it means: if the partner clearly answers, the platform resolves the attempt itself.
   * What you do: nothing else. You do not need to do anything more.
4. **If the partner has no status question** (some wallets do not), do not keep pressing.
   * What you see: the screen says an inquiry is not possible.
   * What it means: the truth will come only from the next statement or from the partner's support.
   * What you do: note the reference. Then wait for the next statement, which is explained in [[a:b08-06|Reconciliation]]. Or contact the partner's support quoting the **provider reference** and **our reference**.
5. **Resolve by hand only when you have evidence** from the partner (a statement line, a written reply).
   * What you see: written proof from the partner.
   * What it means: you can now decide, but it is a two-person decision.
   * What you do: open the checklist [[c:sg-resolve-unknown|Resolve an UNKNOWN payment by hand]] first. Then choose **Mark succeeded** or **Mark failed** and write a reason. [[a:b04-06|Writing a reason that survives an audit]] shows how.
6. **If you have evidence that the customer was not charged and the link must be freed,** use **Release reservation**.
   * What you see: proof that no charge happened.
   * What it means: the slot can be given back so the link can be paid again.
   * What you do: use **Release reservation** with its checklist: [[c:sg-release-reservation|Release a link reservation]].

### What you tell people
These are the words to use. The first row is for the customer and the second is for the merchant.

| To the customer | "We are confirming your payment with your payment provider. Please do not pay again. We will update you." |
| :--- | :--- |
| To the merchant | "This payment is being confirmed with the payment company. It is not yet counted as paid." |

### What you must never do
* Never mark it failed because it is old.
* Never ask the customer to pay again.
* Never re-send an OTP or repeat the confirm.
* Never resolve it from a screenshot or a phone call.

### How long is normal?
The target is that **95% of `UNKNOWN` attempts are resolved within 24 hours**. A rising number or an old one on the dashboard is a warning; follow [[a:b10-04|RB-03 A backlog of UNKNOWN payments]].

:::danger The rule
`UNKNOWN` means we do not know. Do not guess. Use **Inquire**, then follow this article.
:::
@@end

@@article id=b07-04 book=7 order=4 title="The Operator Cases screen: kinds, priorities, deadlines and resolutions" roles=OPERATOR,FINANCE,SUPPORT minutes=4 ui=AVAILABLE related=b07-03,b07-08,b07-09
:::summary Big picture in 20 seconds
An operator case is a task the system gives you when a payment or a statement line needs a person. Work the highest priority and nearest deadline first, and never resolve a payment case without evidence.
:::

Think of Operator Cases as your task list. The system adds a task every time it cannot finish something by itself. This article explains how to read each task and what you can do with it.

### What an operator case is
An **operator case** is a task created by the system when a payment or a statement line needs a human. Each case has a kind, a priority, a deadline and an owner.

### The seven kinds
The kind tells you why the case exists. Find the kind in the first column, then read what usually triggers it and what you usually do.

| Kind | Created when | Typical action |
| :--- | :--- | :--- |
| `UNKNOWN` | An attempt is in `UNKNOWN`. | Inquire; follow [[a:b07-03]]. |
| `HELD` | Money is being held (for example by an AML rule). | Follow the instruction in the case. AML holds are decided by Compliance and the MLRO. |
| `CONFLICT` | Two trusted sources disagree (for example a webhook says paid, an inquiry says failed). Priority 1. | Do not resolve alone; escalate. |
| `MISMATCH` | The partner's amount or currency differs from ours. | See [[a:b07-08]]. |
| `LATE_SUCCESS` | A confirmation arrived after the payment had expired or failed. | See [[a:b07-08]]. |
| `MANUAL_REVIEW` | Something needs a person's judgement (for example a big volume jump). | Review as instructed in the case. |
| `UNMATCHED_STATEMENT` | A statement line matches none of our payments. | Reconciliation: [[a:b08-06]]. |

AML means anti-money-laundering. The MLRO is the money-laundering reporting officer.

### Priority and deadline
Every case has a priority: `P1` (highest), `P2` or `P3`. Every case also has a deadline, called the **SLA** (service-level agreement: the time by which the case must be handled). Work the highest priority and nearest deadline first. Leave a handover note for any case still open at the end of your shift. [[a:b10-08|Shift handover and the escalation ladder]] explains how.

### The four states of a case
A case moves in this order: `OPEN` → `IN_PROGRESS` → `PENDING_CHECKER` → `RESOLVED`. `PENDING_CHECKER` means the case is waiting for a second person to check it.

### The actions on the screen
* **Inquire**: ask the partner for the status of one attempt.
* **Bulk Inquiry**: ask the partner about many attempts at once, for example after an outage. Use it carefully: it sends many calls to the partner. Open the checklist [[c:sg-bulk-inquiry|Run a bulk inquiry]] first.
* **Resolution**: record how the case ended. For an `UNKNOWN` case the choices are **Mark succeeded**, **Mark failed**, and **Release reservation**. Each needs a written reason and a second person.

### What you do with a case
1. **Assign the case to yourself** before working it.
   * What you see: the case shows its owner, called the assignee.
   * What it means: if two people work the same item, they may act twice.
   * What you do: assign the case to yourself.
2. **Write what you did** in the resolution notes as you go.
   * What you see: the notes field on the case.
   * What it means: the next person can only see what you wrote.
   * What you do: add a note after each action.
3. **Treat a resolution as a money decision.**
   * What you see: the choices to resolve the case.
   * What it means: a wrong "succeeded" credits money that never arrived; a wrong "failed" can lead to a second payment.
   * What you do: choose only with evidence, and write the reason.
4. **If evidence is missing, leave the case open** and escalate.
   * What you see: no proof from the partner yet.
   * What it means: the truth is still unknown.
   * What you do: leave it open and escalate. Leaving it open is safe; guessing is not.
@@end

@@article id=b07-05 book=7 order=5 title="Webhooks and the inbox in operation" roles=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN minutes=3 ui=AVAILABLE related=b06-07,b10-03,b01-06
:::summary Big picture in 20 seconds
A webhook is a message a partner sends us about a payment. We store every message first, then check it in the background, so every message we receive is kept and most odd cases need no action from you.
:::

Sometimes the partner does not wait for us to ask. It calls us and says "this payment succeeded". That call is a **webhook**. The place where we keep every message we receive is the **inbox**. This article shows what happens to a message and what you should do when something looks odd.

### What happens when a partner calls us
For example, a partner sends a webhook saying that Layla's 25.500 LYD payment to Noon Mart succeeded. These are the steps.
1. The call arrives at a **secret address** that belongs to one gateway and one environment.
2. The raw message is **stored first**, exactly as received, before anything else happens. Nothing is ever deleted from this inbox.
3. The platform answers the partner quickly with the reply the partner expects (in a few milliseconds), so the partner does not keep retrying.
4. A background worker then checks the signature, the sender's IP address and the timestamp, works out which payment it belongs to, and decides what it means. The signature is a code calculated from the message and a secret. It proves the message came from the partner.
5. Duplicates are ignored safely (the same message is recognised for seven days).

### What you may see
Read the first column as what you see, the second as what it means, and the third as what you do.

| What you see | What it means | What you do |
| :--- | :--- | :--- |
| Message arrives before the payment record is saved | The worker retries finding the payment for about 60 seconds. | Nothing unless an alert fires. |
| Message about a reference we do not know | Stored with no payment attached; nothing changes. | A spike may mean an attack or a partner mix-up; tell the Security Admin. |
| Duplicate message | Absorbed; answer is OK again. | Nothing. |
| Out-of-order messages | `SUCCEEDED` is never downgraded. | Nothing. |
| Message from the sandbox arrives at the live address | Rejected; priority-2 security alert. | Tell the Gateway Admin and Security Admin. |
| A spike of signature failures | The partner may have changed how it signs. | Runbook [[a:b10-03]]. |
| A valid signature from an unlisted IP address | The partner may have changed servers. | Runbook [[a:b10-03]]. |
| Weak channel (hint only) | The platform asks the partner before believing. | Nothing. |

A **weak channel** is a source that gives only a hint, for example a message that can be faked. The platform never believes it until it has asked the partner.

### Replay
Because the raw bytes are kept, once a corrected signing recipe is approved the platform can **replay** the stored messages without asking the partner to send them again.

### The dashboard tile
**Webhook Inbox Lag** is the time between receiving and processing. The target is under 30 seconds for most messages. A high value means the workers are behind; tell Engineering.
@@end

@@article id=b07-06 book=7 order=6 title="Slot reservation, single-use links, expiry and the grace window" roles=OPERATOR,SUPPORT,FINANCE minutes=4 ui=AVAILABLE related=b05-07,b07-03,b07-08
:::summary Big picture in 20 seconds
A payment link has a fixed number of slots, and a payment attempt must hold one before it starts. The slot is kept while the result is uncertain, which stops the same invoice being paid twice.
:::

Think of a single table in a restaurant. While one group has the table, nobody else can sit there. Even if the group has gone to wash their hands, the table stays theirs until they are clearly finished. A payment link works the same way, and the "table" is called a **slot**. Unlike a table, a slot stays held until we know the result, even if the customer has gone.

### The problem this solves
A single-use link must be paid **once**. But a customer might open it in two tabs, or two people might open it, or a payment might be in doubt while someone else tries. Without a rule, the same invoice could be paid twice.

### The rule: reserve a slot before starting
When an attempt starts, it reserves one **slot** on the link, in one indivisible step. A single-use link has one slot. While the slot is reserved, nobody else can start a competing payment; they see "Payment in progress".

The slot is **released** only when the attempt reaches `FAILED`, `EXPIRED`, `CANCELLED` or `BLOCKED`. It is **kept through `UNKNOWN`**, because the first payment might have succeeded.

### Expiry
Each attempt has a time limit. The attempt expires at the **smaller** of two times: the partner's session time, and the platform's ceiling for that mode. See [[a:b06-02|The nine collection modes in depth]] for the ceilings. When time is up, the platform first asks the partner one last time (if the partner supports it). Only then does it move the attempt to `EXPIRED`.

### The grace window
After expiry, the platform keeps listening for late confirmations for a **grace period**. The default is 24 hours, and it is unlimited for partners that cannot be asked. Suppose a verified success arrives in the grace window. There are two cases, as in [[a:b07-08|Late success, conflicts and amount mismatches]].
* **The slot is still free.** The attempt becomes `SUCCEEDED`, the money is posted, and a priority-2 alert is raised.
* **The link was already paid by another attempt.** The money goes to the `SUSPENSE` account and a refund is drafted.

### Multi-use links
The same rule applies with more slots. `confirmed_count + active_locked_count` may never exceed the number of uses. The first number counts the payments that succeeded. The second counts the slots that are reserved right now. For example, a link with 3 uses can have 2 confirmed payments and 1 reserved slot, but not 2 confirmed and 2 reserved.

### What the customer does and what happens
Customers do many unexpected things. Read the first column as what you see or hear, and the second as what the platform does for you.

| Behaviour | Result |
| :--- | :--- |
| Closes the browser mid-payment | The page resumes from the server's state when reopened; the platform asks the partner at expiry. |
| Reloads or presses Back on the code screen | No second start; resend obeys the cooldown. |
| Opens the link on two devices | The second sees "Payment in progress". |
| Switches payment method mid-way | The first attempt is cancelled or watched; the new one joins the same group, and only one success per group is possible. |
| Presses retry while the earlier attempt is `UNKNOWN` | Blocked until it resolves. |

### What you do
1. **A customer or cashier reports "Payment in progress".**
   * What it means: another attempt holds the slot.
   * What you do: ask for the payment reference, look it up, and read the status. If it says `UNKNOWN`, follow [[a:b07-03|UNKNOWN]]. If it is in progress (`AWAITING_CUSTOMER` or `VERIFYING`), tell the customer to wait and not to pay again, as in [[a:b07-12|the procedure for a customer who says they paid]].
2. **A customer cannot press retry.**
   * What it means: the earlier attempt is `UNKNOWN`, so the platform keeps the slot until it resolves.
   * What you do: do not ask the customer to pay again. Follow [[a:b07-03|UNKNOWN]].
@@end

@@article id=b07-07 book=7 order=7 title="OTP behaviour: wrong codes, resend, lockouts and attacks" roles=OPERATOR,SUPPORT minutes=3 ui=AVAILABLE related=b06-08,b07-06,b11-03
:::summary Big picture in 20 seconds
A customer gets a limited number of tries at the one-time code (3 by default), and a timeout is never a wrong code. Know the rules so you can explain them and spot abuse.
:::

An OTP (one-time password) is a short code sent by SMS that works once. Many wallets use it to prove that the real owner is paying. This article explains the rules around the code, what the customer sees, and what you tell a customer who has a problem.

### The OTP flow
In an `OTP_PULL` rail the customer first asks the partner to send a code (the **start** step), then types it (the **confirm** step). A rail is one payment method, such as Sadad. For example, Layla chooses Sadad, taps to receive her code, and then types the code on the payment page.

### Rules
1. **Three tries.** A wrong code that the partner marks as retryable returns the customer to the code screen without sending a new SMS. After the third wrong code the payment becomes `FAILED`. The number is a setting per gateway; the default is 3.
2. **Resend cooldown.** A new SMS cannot be requested again before the gateway's cooldown ends, and the number of resends is capped. This stops customers (or attackers) draining SMS credit.
3. **Wrong codes never trip the circuit breaker.** The circuit breaker is a safety switch that stops using a payment route when it keeps failing. Wrong codes are customer mistakes, so they never count as route failures. See [[a:b06-08|Status rules and error maps]].
4. **A timeout during confirm is never a wrong code.** It becomes `UNKNOWN`, and the same code is never submitted again.
5. **Time limit.** The code screen has a countdown. The effective time limit is the smaller of the partner's code lifetime and the platform's 20-minute ceiling.

### What you see, what it means, what you do
| What you see | What it means | What you do |
| :--- | :--- | :--- |
| Customer typed a wrong code once or twice | The partner marked it retryable. The customer is back on the code screen with no new SMS. | Tell the customer to type the code again, carefully. |
| Payment is `FAILED` after wrong codes | The customer used up the allowed tries (3 by default). | Nothing. `FAILED` is final for this attempt, and the slot is released. |
| Customer cannot get a new SMS | The cooldown has not ended, or the resend cap was reached. | Ask the customer to wait for the countdown and use the resend button once. If it still fails, the payment company's own support handles SMS delivery. |
| Payment is `UNKNOWN` after the customer typed a code | The confirm step timed out. It is not a wrong code. | Follow [[a:b07-03]]. Never ask for the same code again. |

### What you tell a customer who says "the code never came"
Do not ask them to tap resend repeatedly. Ask them to wait for the countdown, check the phone number they typed, and use the page's resend button once. If it still fails, the payment company's own support handles SMS delivery.

### Abuse protection
The platform limits how fast one customer, device or network address can try. A daily SMS budget alarm also exists to detect SMS pumping. SMS pumping is an attack that triggers thousands of SMS messages.
@@end

@@article id=b07-08 book=7 order=8 title="Late success, conflicts and amount mismatches" roles=OPERATOR,FINANCE minutes=3 ui=AVAILABLE related=b07-04,b07-06,b08-08
:::summary Big picture in 20 seconds
Sometimes the partner's answer comes too late, disagrees with another answer, or shows a different amount. The platform posts money only when the evidence is clear; otherwise it holds it or leaves the payment in `UNKNOWN`. You collect evidence and never credit or refund by hand.
:::

Most payments are simple: we ask, the partner answers, we post the money. Three things can go wrong with that picture. The answer can come late, two trusted answers can disagree, or the amount can be different from what we asked. Most of them open an operator case, and this article shows what to do for each.

### Late success
A confirmation arrives **after** the payment was marked `EXPIRED` or `FAILED`. Cause: the customer approved late, or the partner was slow. For example, Layla types her Sadad code for 25.500 LYD after the time limit. What happens next depends on the link.
* If the slot is free: the attempt becomes `SUCCEEDED` and the entry is posted. A priority-2 alert is raised.
* If the link is already satisfied: the money is parked in `SUSPENSE` and a refund adjustment is drafted for a person to approve. `SUSPENSE` is the account for money that arrived but does not clearly belong to anyone yet.
* Operators confirm the case notes and let Finance process the refund through the normal two-person route. Never refund from a phone call.

### Conflicting signals
Example: a verified webhook says "paid" but our status question says "failed". Both are trusted, so **neither wins**. Nothing is posted, the attempt stays in `UNKNOWN`, and a **priority-1 `CONFLICT` case** opens. Escalate to a senior operator and the Gateway Admin. Resolution needs evidence from the partner.

### Amount mismatches
The partner confirms success but the amount or currency is not what we asked. The route's **mismatch policy** decides what happens.
* Within the tolerance: accepted.
* Beyond the tolerance: the money is held in `SUSPENSE` and a `MISMATCH` case opens.

### Which case, and what you do
Find your situation in the first column. The case kinds are explained in [[a:b07-04|The Operator Cases screen]].

| What you see | What it means | What you do |
| :--- | :--- | :--- |
| `LATE_SUCCESS` case | A confirmation came after `EXPIRED` or `FAILED`. | Read the notes. If money is in `SUSPENSE`, Finance handles the refund with two people. |
| `CONFLICT` case (priority 1) | Two trusted answers disagree. | Do not resolve alone. Escalate to a senior operator and the Gateway Admin. |
| `MISMATCH` case | Amount or currency differs beyond the tolerance. | Follow the three steps below. |

### What you do for a mismatch case
1. **Read the case notes and the step log.**
   * What you see: what we asked and what the partner answered.
   * What it means: this is your evidence.
2. **Compare the partner's statement line with the attempt** (amount, currency, date).
   * What you see: the two records side by side.
   * What it means: any difference is the reason for the case.
3. **Do not credit or refund by hand.** Propose an adjustment through Finance with a written reason. See [[a:b08-08|Adjustments]].
   * What it means: only Finance, with two people and a written reason, may credit or refund.
@@end

@@article id=b07-09 book=7 order=9 title="Inquiry: how to ask a partner safely, and rails that cannot be asked" roles=OPERATOR minutes=3 ui=AVAILABLE related=b07-03,b06-07,b10-04
:::summary Big picture in 20 seconds
An inquiry asks the partner for the true status of a payment, and it can never move money. Press it once and wait; some partners cannot be asked at all.
:::

When you are not sure what happened to a payment, the safest move is to ask the people who hold the money. An inquiry is that question. This article shows when it runs, how to use it, and what to do when the partner has no way to answer.

### What an inquiry is
An **inquiry** asks the partner "what is the true status of this payment?" using a read-only step. It cannot move money. It is the safest tool you have.

### When it runs
* automatically at expiry,
* automatically for channels that must ask before believing,
* automatically on a polling schedule,
* when you press **Inquire** on an attempt,
* when you press **Bulk Inquiry** for many attempts.

### Rules for using it
1. **One press, then wait.** Partners often need a minimum age on a payment before they will report a status. Pressing repeatedly does not help and may be rate-limited. Rate-limited means the partner refuses calls that come too often.
2. **Bulk Inquiry** sends many calls. Use it after an outage, filtered to the affected route and period. Open [[c:sg-bulk-inquiry|Run a bulk inquiry]] first.
3. **Read the answer in the step log.** "Not found" is not the same as "failed". Many partners answer "not found" for a payment that is still being processed.

### What you see, what it means, what you do
For example, Layla's 25.500 LYD payment is `UNKNOWN`, the partner can answer a status question, and Ali presses **Inquire**.

| What you see | What it means | What you do |
| :--- | :--- | :--- |
| The partner clearly says paid or failed | The truth is known. | Nothing more. The platform resolves the attempt itself. |
| "Not found" in the step log | The partner may still be processing. It does not mean "failed". | Do not mark it failed. Wait. |
| The screen says an inquiry is impossible | The partner has no status question. | Follow the section below about rails with no status question. |

### The Inquiry Schedule screen
**Inquiry Schedule** lists the persisted automatic inquiries (scheduled, running, settled and stopped) with the attempt, route and next run. An operator can run one now, retry a failed, expired or cancelled inquiry, or cancel a schedule. These actions change the inquiry plan, not the payment attempt itself.

### Rails with no status question
A rail is a payment method the customer picks. The partner behind it decides whether we can ask. Some partners (some wallets, and some aggregator routes) offer **no way to ask**. For these:
* an inquiry is impossible; the screen will say so;
* the customer page stays on "Confirming your payment";
* the truth comes from the settlement statement, which [[a:b08-06|Reconciliation]] explains, or from a decision by an operator with evidence;
* these gateways are flagged for extra attention, and large amounts may need operator approval.
@@end

@@article id=b07-10 book=7 order=10 title="Checkout Help: what payers see and what you can configure" roles=GATEWAY_ADMIN,OPERATOR,SUPPORT minutes=3 ui=AVAILABLE related=b07-12,b09-08,b03-03
:::summary Big picture in 20 seconds
Checkout Help is the Help drawer on the payment page. An administrator controls which contact options appear. It never decides anything about money.
:::

A payer who is confused may call someone or pay again. The Help drawer is there to answer first. This article shows what the payer sees and what an administrator can change.

### What the payer sees
On the checkout page, a **Help** drawer shows:
* **A step-by-step guide for the chosen payment method**, with what the customer needs before starting and what to do if it fails.
* **State-aware advice**: different text while waiting, when something is uncertain, after a failure, after expiry or after cancellation.
* **A one-tap "copy payment reference" button.**
* **Frequently asked questions**, in Arabic and English.
* **Contact options**: WhatsApp, phone, e-mail, the merchant's own contact, and working hours, **only if the administrator turned them on**.

### What you configure
The **Checkout Help** screen (under Settings) lets an administrator do these things:
* turn support on or off;
* set the channels and working hours;
* choose whether to show the platform's contact and the merchant's contact;
* edit the platform FAQ (frequently asked questions).

A live preview shows what a payer sees. If support is turned **off**, the whole contact block disappears.

### Rules for content
1. **Use official company contact details only.** Never a personal number.
2. **Write in both Arabic and English.**
3. **Never reveal internal reasons.** A blocked payment shows only "cannot process this payment". The page never confirms whether a phone number or wallet exists.
4. **Never promise refund times** you do not control.
5. Settings are versioned and audited like other changes.

### What the payer's help can and cannot do
Read the two columns as the limit of the Help drawer.

| It can | It cannot |
| :--- | :--- |
| Explain the steps | Confirm a payment |
| Calm the payer | Change an amount |
| Let a customer quote a reference | Give refunds |

Confirming, changing amounts and refunds stay with staff.

### What you do
1. **A payer says the Help page showed the wrong contact.**
   * What it means: the platform contact settings may be wrong, or the merchant's own contact is wrong.
   * What you do: tell the administrator and quote the payment reference. Do not change it yourself.
2. **A payer asks for a refund time.**
   * What it means: the Help page cannot promise one.
   * What you do: do not promise a time you do not control. Tell the payer that staff will reply, and note the reference.
@@end

@@article id=b07-11 book=7 order=11 title="POS screens and live updates" roles=OPERATOR,SUPPORT minutes=2 ui=AVAILABLE related=b05-07,b07-06
:::summary Big picture in 20 seconds
The checkout page and the POS screen both receive state changes live, so the customer and the cashier see the same result within moments. When a cashier asks for help, read the status in the platform, not the customer's claim.
:::

A POS (point of sale) screen is the screen at the shop counter. A cashier uses it to take payments. This article explains how the screen stays up to date and how you help a cashier who is not sure whether a customer has paid.

### How live updates work
When an attempt's state changes, the core announces it. The core is the central part of the platform that runs payments. The checkout page receives the news as a live stream, and the POS screen receives it through a live connection. So the customer and the cashier see the same result within moments.

### What a cashier sees
A screen paired to a terminal shows the current payment, for example a QR code and then "Paid" or "Failed". A screen idle for 15 minutes is disconnected; it reconnects and shows the current state. A long power or internet outage does not lose payments: all state and timers are held on the server, and expired payments release their slots by themselves.

### How to help a cashier
Here is an example. Layla shows a "Paid" screen on her phone at a shop counter, but the POS screen still shows the QR code. The cashier calls you. Follow the steps, from what you see to what you do.
1. **Ask for the payment reference** shown on the screen or receipt.
   * What it means: the reference lets you find the exact payment.
2. **Look the reference up and read the status**, not the customer's claim.
   * What it means: only the status in the platform is proof.
3. **If it says `SUCCEEDED`,** the merchant is credited.
   * What you do: tell the cashier.
4. **If it says `UNKNOWN` or `VERIFYING`,** the payment is not confirmed yet.
   * What you do: tell the cashier to **wait** and not to hand over goods until it shows paid. Then follow [[a:b07-12|the procedure for a customer who says they paid]].

:::warning
A customer showing a "Paid" screen on their phone is not proof of payment. This is rule 5 in [[a:b00-03|The Ten Golden Rules]].
:::
@@end

@@article id=b07-12 book=7 order=12 title="Procedure: a customer says their money was deducted, or that they paid" roles=OPERATOR,SUPPORT minutes=3 ui=AVAILABLE related=b07-03,b07-09,b00-03
:::summary Big picture in 20 seconds
When a customer says "my money was taken" or "I paid", ask for the payment reference, look up the status, and say only what the status allows. Never ask the customer to pay again.
:::

This is the most common call you will receive. Follow the steps in order. The table below shows, for each status, what it means and what you say.

### The steps
1. **Be calm and do not blame.** Say: "I will check this with your reference."
2. **Ask for the payment reference.** It is shown on the checkout page, and the page has a copy button. Do not ask for passwords or codes.
3. **Look it up** and check the **environment** and **status**. Use the table in the next section.
4. **Do not ask them to pay again.**
5. **Create or update an operator case** if the customer claims deduction and the status is not `SUCCEEDED`, noting the reference and the time.
6. **Never say "your payment is confirmed" from a screenshot, an SMS or a call.** Only a status you read in the platform counts.
7. **Tell them what happens next** and when you will reply. Then actually reply.

### What you see and what you say
For example, Layla calls us and says Sadad took 25.500 LYD but Noon Mart shows no order. Ali looks up her reference. Find the status you see in the first column. The second column says what it means, and the third says what you say and do.

| Status you see | What it means | What you say / do |
| :--- | :--- | :--- |
| `SUCCEEDED` | We have verified the payment. | "We confirm your payment. The merchant has been credited." |
| `AWAITING_CUSTOMER` or `VERIFYING` | The payment is still in progress. | "It is in progress. Please do not pay again. Wait for the page to update." |
| `UNKNOWN` | We are not sure. | "We are confirming with your payment provider. Please do not pay again. We will update you." Then follow [[a:b07-03]]. |
| `FAILED`, `EXPIRED`, `CANCELLED` | We did not receive confirmation. | "We have no confirmed payment. If your provider shows a deduction, keep your receipt and your reference; a late confirmation may still arrive and, if it does, we will credit the merchant or return the money." Open a case if money was deducted. |
| `BLOCKED` | A guard stopped it. | "We cannot process this payment." Nothing more. Do not explain. |
| Not found | Wrong reference or wrong environment. | Ask the customer to check the reference. |

:::note Why we do not "just refund"
If we refund a payment that actually succeeded later, we lose money. If we credit a payment that never arrived, we lose money. Waiting for evidence protects the customer, the merchant and us.
:::
@@end


### BOOK 8 — MONEY & THE LEDGER

@@article id=b08-01 book=8 order=1 title="Double-entry bookkeeping from zero" roles=ALL minutes=4 ui=AVAILABLE related=b08-02,b08-05,b01-09
:::summary Big picture in 20 seconds
Double-entry bookkeeping writes every money movement on two sides, and the two sides must be equal. That is how the platform notices a mistake the moment it happens.
:::

### The notebook problem
Imagine you keep a notebook of who has how much. Ali gives Sara 10 LYD and you write "Sara +10". Later you find the notebook says there is 10 LYD more in the world than there should be. Where did it come from? With one-sided notes you cannot tell.

### The idea: every movement has two sides
**Double-entry bookkeeping** writes both sides of every movement. Ali's side goes down, Sara's side goes up. The two sides must match, so a mistake shows up at once.

### The words
Five words are enough to read every ledger screen in this platform.

* **Account**: a named place where an amount is tracked, for example "Treasury" or "Merchant wallet of shop X". In our system an account is a **GL account**. GL stands for *general ledger*, the book of all accounts.
* **Journal entry**: one page of the book. It describes one event, for example "a customer paid 100 LYD".
* **Journal line**: one row on that page. It has an account, a direction and an amount.
* **Direction**: every line is a **debit** or a **credit**.
* **Ledger**: all journal entries together.

### Debit and credit are not "good" and "bad"
They are only two directions. Think of them as the *left column* and the *right column*. The only rule that matters is this:

**In every journal entry, the total of the debits equals the total of the credits.**

If the totals are not equal, the system refuses to save the entry.

### What a balance means
The balance of an account is the sum of its lines. For accounts that hold things we *have* (cash in the bank), debits increase the balance. For accounts that record things we *owe* or *earned*, credits increase it. You do not calculate this by hand, because the screens do it. You only need to know the shape.

### A first example
In this book we use one sale for every example. Layla pays Noon Mart 100 LYD. Our commission is 3 LYD, so the merchant is credited 97 LYD. The payment company has collected the money but will pay us later. The ledger shows amounts with four decimal places, so 100 LYD appears as 100.0000.

Read the table row by row. The "Why" column says what each line means.

| Account | Debit | Credit | Why |
| :--- | :--- | :--- | :--- |
| Gateway clearing | 100.0000 | | We are owed 100 by the payment company. |
| Merchant wallet | | 97.0000 | We now owe the merchant 97. |
| Platform income | | 3.0000 | We earned 3. |
| **Total** | **100.0000** | **100.0000** | Balanced. |

Check it yourself: the credits are 97.0000 + 3.0000 = 100.0000, and the one debit is 100.0000.

### Four promises the ledger keeps
1. **Balanced entries.** Debits equal credits, always.
2. **Append-only.** Nothing is edited or deleted. A mistake is fixed by adding a new, approved entry that offsets it.
3. **Exactly once.** Each payment, adjustment or sweep can create its entry only once. The database refuses a duplicate.
4. **No stored balances for wallets.** A merchant's balance is calculated from lines, so it cannot drift from the books.

### Try it
The explorer below shows all the standard events as two columns and checks the balance.

{{widget:ledger-explorer}}

:::danger Never "fix" numbers
If a number on a screen looks wrong, stop and escalate. Nobody edits numbers. Corrections are new, approved entries, as [[a:b08-08|the adjustments article]] explains.
:::
@@end

@@article id=b08-02 book=8 order=2 title="The eleven accounts: what each one means" roles=FINANCE,COMPLIANCE,OPERATOR minutes=4 ui=AVAILABLE related=b08-01,b08-05
:::summary Big picture in 20 seconds
The ledger has 11 kinds of account, in three groups: things we have, things we owe, and things we earned or spent. Know which group an account is in and you know what its balance means.
:::

### What an account is for
An account answers one question about money: "How much do we have, owe or earn in this place?" The platform has eleven kinds of account.

Each account has a code name in capital letters, such as `TREASURY`. The table below gives the plain meaning of each code name, so you do not need to remember the codes.

### The three groups
* **Things we have.** Real money, or money that someone owes us. A **claim** is money that someone owes us but has not paid yet.
* **Things we owe.** Money that belongs to someone else, or that is not decided yet. Some of it is waiting for a decision.
* **Earned and cost.** This group has two labels. "Earned" is what we earned (commission). "Cost" is what it cost us (payment company fees).

### The eleven accounts
Read the table one row at a time. "One per" says how many accounts of this kind exist, for example one for the whole platform or one for each wallet. For `GATEWAY_CLEARING`, the environment is test or live, and the credential set is the partner login keys used.

| Account | Plain meaning | One per... | Belongs to |
| :--- | :--- | :--- | :--- |
| `TREASURY` | Our real money in our own bank and cash. | platform | we have |
| `GATEWAY_CLEARING` | Money a payment company has collected for us but not yet paid to us. | gateway + environment + credential set | we have (a claim) |
| `COMMISSION_RECEIVABLE` | Commission we earned on payments that went straight to the merchant. The merchant owes it to us. | platform (one account for all merchants) | we have (a claim) |
| `MERCHANT_WALLET` | What we owe a merchant. | wallet | we owe |
| `AML_HOLD` | Money held while compliance decides. | platform | we owe (to be decided) |
| `CHARGEBACK_RESERVE` | Money set aside while a dispute is open. | platform | we owe (to be decided) |
| `SUSPENSE` | Money that arrived but does not clearly belong yet. Two examples are a late success on a paid link and a mismatch above tolerance. | platform | we owe (to be decided) |
| `GATEWAY_FEE_ACCRUAL` | Fees the payment company will take later but we already know about. | platform | we owe |
| `PLATFORM_INCOME` | Commission we have earned. | platform | earned |
| `PROVIDER_FEE_EXPENSE` | A payment company's fee deducted straight from a payment. | platform | cost |
| `GATEWAY_FEE_EXPENSE` | A payment company's fee recognised when the payment is confirmed (and later corrected if the real fee differs). | platform | cost |

### One sale, five accounts
Layla pays Noon Mart 100.0000 LYD (an example). The payment company has the money but will pay us later. Our commission is 3.0000, and the payment company's fee is 0.8000. After the payment is confirmed, the accounts look like this:

1. `GATEWAY_CLEARING` goes up by 100.0000. This is a claim: the payment company owes us.
2. `MERCHANT_WALLET` goes up by 97.0000. We owe Noon Mart this amount.
3. `PLATFORM_INCOME` goes up by 3.0000. This is our commission.
4. `GATEWAY_FEE_EXPENSE` goes up by 0.8000. This is the cost of the payment company's fee.
5. `GATEWAY_FEE_ACCRUAL` goes up by 0.8000. We know we will owe this fee later.

Debits are 100.0000 + 0.8000 = 100.8000. Credits are 97.0000 + 3.0000 + 0.8000 = 100.8000. [[a:b08-04|How each kind of payment is posted]] shows this entry in debit and credit form.

### A reading rule
Money in `MERCHANT_WALLET`, `AML_HOLD`, `CHARGEBACK_RESERVE` and `SUSPENSE` is **not ours**. It is only on its way somewhere. That is why commission on held money is not counted as income until the money is released. See [[a:b09-05|how cases move money]].

:::note 11, not 10
Older design documents list ten account kinds. The code has eleven, because gateway fees recognised at confirmation have their own account. The guide uses eleven.
:::
@@end

@@article id=b08-03 book=8 order=3 title="Commission, fee bearers and rounding, with worked numbers" roles=FINANCE,OPERATOR,SUPPORT minutes=3 ui=AVAILABLE related=b01-05,b08-04
:::summary Big picture in 20 seconds
We charge the merchant a commission, and the payment company charges us a fee. The fee bearer decides who pays the commission: the merchant, the payer or both. In the example below, our net revenue is the same in every case.
:::

### Two separate fees
Two different fees exist. Do not mix them up.

* **Commission**: what we charge the merchant. It is our revenue.
* **Gateway fee**: what the payment company charges us. It is our cost.
* **Net revenue** = commission − gateway fee.

For example, with a 3.000 LYD commission and a 0.800 LYD gateway fee, net revenue is 3.000 − 0.800 = 2.200 LYD.

### How commission is chosen
A **commission profile** says how to calculate the commission for a rail. A rail is one payment method. The profile can be a flat fee, a percentage, tiers by amount, or a mix, with a minimum and a maximum.

Profiles are **effective-dated**, which means they start on a date. They are also **versioned**, so old payments always show the profile they used.

The profile used is the most specific one that exists, in this order:
1. this merchant + this application + this rail,
2. this merchant + this rail,
3. the platform default + this rail.

If no profile covers a rail at that amount, the rail is hidden from the customer. See [[a:b06-12|the visible-rails formula]].

### Who pays it: the fee bearer
Every payment link has a **fee bearer**. The fee bearer is the party that pays our commission.

Example: Noon Mart makes a 100.000 LYD link. The commission is 3.000 LYD and the gateway fee is 0.800 LYD. Read each row from left to right.

| Fee bearer | Customer pays | Merchant is credited | Our commission | Our net after gateway fee |
| :--- | :--- | :--- | :--- | :--- |
| `MERCHANT_ABSORBS` (default) | 100.000 | 97.000 | 3.000 | 2.200 |
| `PAYER_SURCHARGE` | 103.000 | 100.000 | 3.000 | 2.200 |
| `SPLIT` (50/50) | 101.500 | 98.500 | 3.000 | 2.200 |

How the numbers come about:
* `MERCHANT_ABSORBS`: the merchant pays all 3.000, so it receives 100.000 − 3.000 = 97.000.
* `PAYER_SURCHARGE`: the customer pays the 3.000 on top, so it pays 100.000 + 3.000 = 103.000 and the merchant receives the full 100.000.
* `SPLIT`: each side pays half, 1.500. The customer pays 100.000 + 1.500 = 101.500 and the merchant receives 100.000 − 1.500 = 98.500.

With `PAYER_SURCHARGE` or `SPLIT` the checkout page must show the added fee before the customer confirms. Book 8 ledger tables show the same amounts with four decimals, so 100.000 appears as 100.0000.

### Rounding
Money is stored with four decimal places. Commission is rounded using the profile's rounding mode. The teaching tools in this guide round half up to four places.

Example: 3% of 25.5550 LYD is 0.76665. Rounding half up to four places gives 0.7667.

### Revenue is not recognised early
Commission on money held by compliance is **not** counted as income until the hold is released.

:::note Where to change it
Commission profiles and velocity rules are managed on the **Pricing & Limits** screen. Changes are versioned and go through the approval flow. See [[a:b04-05|who approves what]].
:::
@@end

@@article id=b08-04 book=8 order=4 title="How each kind of payment is posted" roles=FINANCE,OPERATOR minutes=4 ui=AVAILABLE related=b08-12,b08-10,b02-03
:::summary Big picture in 20 seconds
Every successful payment writes one balanced journal entry in the same transaction, and the entry depends on how the money travels. The examples use the same 100 LYD sale and 3% commission.
:::

### The question behind every entry
When a payment succeeds, the ledger must record where the money is now. The answer depends on who holds the money, when the payment company pays us, and who pays the fee.

When an attempt becomes `SUCCEEDED`, one journal entry is written in the **same database transaction**. An attempt is one try to pay. Which entry is written depends on how the money travels.

### How to read the tables
Each example below is a small table with a **Debit** column on the left and a **Credit** column on the right. The debit total equals the credit total. We write "Entry 1", "Entry 2" and so on to match the numbers in [[a:b08-12|the full list of fifteen entries]].

All examples use one sale: Layla pays Noon Mart a 100.0000 LYD link, and our commission is 3% (3.0000). Under most tables, a check line adds up both sides.

### A. Platform holds the money, fee taken from the payment (Entry 1)
The platform holds the money. The payment company deducts its 1.0000 fee before it pays us. So we receive 100.0000 − 1.0000 = 99.0000 in treasury.

| Debit | Credit |
| :--- | :--- |
| `TREASURY` 99.0000 | `MERCHANT_WALLET` 97.0000 |
| `PROVIDER_FEE_EXPENSE` 1.0000 | `PLATFORM_INCOME` 3.0000 |

Check: debits 99.0000 + 1.0000 = 100.0000. Credits 97.0000 + 3.0000 = 100.0000.

### B. Platform holds the money, settled later (Entry 2)
The payment company will pay us later, so the 100.0000 waits in clearing. The payment company charges 0.8000, which we accrue. To accrue a fee means to record it now and pay it later.

| Debit | Credit |
| :--- | :--- |
| `GATEWAY_CLEARING` 100.0000 | `MERCHANT_WALLET` 97.0000 |
| `GATEWAY_FEE_EXPENSE` 0.8000 | `PLATFORM_INCOME` 3.0000 |
| | `GATEWAY_FEE_ACCRUAL` 0.8000 |

Check: debits 100.0000 + 0.8000 = 100.8000. Credits 97.0000 + 3.0000 + 0.8000 = 100.8000.

### C. Payer surcharge (Entry 5)
The customer pays the commission on top. Layla pays 103.0000, and the merchant gets the full 100.0000.

| Debit | Credit |
| :--- | :--- |
| `GATEWAY_CLEARING` 103.0000 | `MERCHANT_WALLET` 100.0000 |
| `GATEWAY_FEE_EXPENSE` 0.8000 | `PLATFORM_INCOME` 3.0000 |
| | `GATEWAY_FEE_ACCRUAL` 0.8000 |

Check: debits 103.0000 + 0.8000 = 103.8000. Credits 100.0000 + 3.0000 + 0.8000 = 103.8000.

### D. Money goes straight to the merchant (Entry 6)
The payment company pays the merchant directly. We hold no cash. We book only the commission we are owed, which is a claim on the merchant.

| Debit | Credit |
| :--- | :--- |
| `COMMISSION_RECEIVABLE` 3.0000 | `PLATFORM_INCOME` 3.0000 |

Later, we net that claim against money we owe the merchant. This is a second entry:

| Debit | Credit |
| :--- | :--- |
| `MERCHANT_WALLET` 3.0000 | `COMMISSION_RECEIVABLE` 3.0000 |

### E. First-party NeomPay (Entry 13)
NeomPay is our own payment method. It posts straight to treasury, so there is no clearing step.

| Debit | Credit |
| :--- | :--- |
| `TREASURY` 100.0000 | `MERCHANT_WALLET` 97.0000 |
| | `PLATFORM_INCOME` 3.0000 |

Check: debits 100.0000. Credits 97.0000 + 3.0000 = 100.0000.

### F. Held by an AML rule (Entry 7)
AML means anti-money-laundering. At confirmation the money goes to `AML_HOLD` and **no commission is recognised**. On release it moves to the merchant and to income. See [[a:b09-05|how cases move money]].

### Why "exactly once" matters
Each entry is tied to its payment by a unique pair: the type and the id. If a webhook is repeated, a second entry is refused. So a duplicate message can never double-credit a merchant.
@@end

@@article id=b08-05 book=8 order=5 title="The ledger equation and what to do when it does not hold" roles=FINANCE,SECURITY_ADMIN,OPERATOR minutes=3 ui=AVAILABLE related=b08-01,b10-05,b08-11
:::summary Big picture in 20 seconds
One equation must hold across the whole platform at every moment: what we have equals what we owe plus what we earned minus what it cost us. If the two sides differ, that is a priority-1 incident, and nobody edits numbers to fix it.
:::

### The equation
Every journal entry balances, so the whole ledger balances too. This gives one equation. The left side is what we have. The right side is what we owe, earned and spent.

**Treasury + all clearing accounts + all commission receivable**
**=**
**all merchant wallets + platform income − provider fee expense − gateway fee expense + gateway fee accrual + AML hold + chargeback reserve + suspense**

In words: *what we have equals what we owe plus what we earned minus what it cost us.* Because every entry is balanced, this must always be true.

### A worked example
Take the sale from [[a:b08-04|How each kind of payment is posted]]: Layla pays Noon Mart 100.0000 LYD, and the entry is Entry 2. The numbers are examples.

* Left side: clearing 100.0000. Treasury and commission receivable are 0.0000. Total 100.0000.
* Right side: merchant wallet 97.0000 + platform income 3.0000 − gateway fee expense 0.8000 + gateway fee accrual 0.8000 = 100.0000.

Both sides are 100.0000, so the **drift** is 0.0000. Fee expense is subtracted because a cost reduces what we earned.

### Four rules enforced by the database
The database itself refuses to save data that breaks these rules. Read each row as: the rule, and the kind of database protection that enforces it.

| # | Rule | Enforced by |
| :--- | :--- | :--- |
| 1 | Every journal line amount is greater than zero | a check constraint |
| 2 | One link slot count never exceeds the allowed uses | a check constraint |
| 3 | At most one success per attempt group | a check constraint |
| 4 | The approver of a request is never its maker | a trigger on the approval table (plus two code checks) |

In plain words, rule 2 means a payment link that allows 3 uses cannot have more than 3 uses confirmed or in progress. The exception is a link that allows unlimited use. Rule 3 means the same payer, identified by a fingerprint, can succeed only once on one link. A check constraint is a rule the database tests on every save. A trigger is a small program the database runs on every save.

### The monitor
A scheduled job recomputes the equation continuously and reports the **drift**, the difference between the two sides. The expected value is **0.0000 LYD**.

### If drift is not zero
1. This is a **priority-1 incident**. Tell your manager and Finance immediately.
2. **Automatic payouts stop** until the cause is understood.
3. Follow [[a:b10-05|RB-04 Reconciliation or ledger drift]].
4. **Never edit numbers** or try to "make it balance". Corrections are new approved adjustments.

### Read the screens
The invariant screen shows the latest result, the drift and when it last ran. See [[a:b08-11|profitability, liquidity and the invariant screens]].
@@end

@@article id=b08-06 book=8 order=6 title="Reconciliation: matching partner statements to our books" roles=FINANCE minutes=4 ui=AVAILABLE related=b08-10,b10-05,b07-09
:::summary Big picture in 20 seconds
Reconciliation compares each payment company's statement with our own books, line by line. Where they differ, one of us is wrong, and Finance finds out which before more money moves.
:::

### Why we reconcile
A payment company is another record-keeper. We also call it the **partner**, because it really moves the money. Our books say what *we* think happened. Its **statement** says what *it* thinks happened. If the two differ, one of us is wrong, and we must find out which.

For example, our books say Layla paid Noon Mart 100.0000 LYD. The statement from the payment company should show the same payment with the same amount. This check is called **reconciliation**.

### Statement sources
A **statement source** describes where statements come from and how to read them. It records:
* where the statements come from: `API`, `SFTP` or `UPLOAD`,
* how often they arrive,
* the file format: CSV, XLSX or JSON,
* the encoding and the separator,
* which row has the headers and which column holds which field,
* the date format and the **time zone**,
* the **settlement lag**: how many days the partner takes to pay us. For example, T+2 means two days after the payment day.

### Running it
On the **Reconciliation** screen:
1. Choose a source.
2. Choose or upload the file.
3. Use **Run File**.

A live preview shows how the columns will be read before anything is matched. The same file cannot be loaded twice for the same source. Another source may load the same bytes, because each source keeps its own fingerprint. Open the checklist [[c:sg-run-reconciliation|Run a statement file]] first.

### The results for each line
Every statement line gets one result. Read the table to see what each result means and what you usually do.

| Result | Meaning | Usual action |
| :--- | :--- | :--- |
| `MATCHED` | Our payment and the statement line agree. | none |
| `AMOUNT_MISMATCH` | Same payment, different amount. | Check fee or rounding; propose an adjustment or fee true-up. |
| `MISSING_AT_GATEWAY` | We say succeeded; the partner shows nothing. | **Serious**: we may have credited money we did not receive. Escalate. |
| `MISSING_LOCALLY` | The partner shows a payment we do not have. | May be a late success or an `UNKNOWN` we can now resolve. |
| `DUPLICATE` | The same line twice. | Ignore the duplicate after checking. |

Problem lines can open operator cases of kind `UNMATCHED_STATEMENT` or `MISMATCH`.

### What happens when a statement settles
Settling means the partner has paid us. Two entries can follow. Both start from the example sale of 100.0000 LYD.

* The **settlement sweep** moves money from `GATEWAY_CLEARING` to `TREASURY` and clears the accrued fee (Entry 3). Example: the statement shows 99.2000 net. Treasury is debited 99.2000 and the fee accrual 0.8000. Clearing is credited 100.0000. Check: 99.2000 + 0.8000 = 100.0000.
* If the actual fee differs from the accrued fee, a **fee variance true-up** posts the difference to `GATEWAY_FEE_EXPENSE` (Entry 4). Example, in a different case: the actual fee is 0.9000 and we accrued 0.8000. The difference is 0.9000 − 0.8000 = 0.1000.

### Time zones
The partner's statement may be in Libya time. Our system stores UTC. Convert deliberately when you compare dates. The source's time zone setting does this for you.

### Targets and danger signs
The target is that 99% of statements are loaded within 4 hours of becoming available. If drift appears, automatic payouts stop and runbook [[a:b10-05|RB-04 Reconciliation or ledger drift]] applies.

:::note Partial
New statement sources are created by engineering today. See [[a:b03-08|features that are only partially available]]. You choose an existing source on the screen.
:::
@@end

@@article id=b08-07 book=8 order=7 title="Cash-outs: paying a merchant its balance" roles=FINANCE,OPERATOR minutes=2 ui=AVAILABLE related=b08-08,b04-05,b08-13
:::summary Big picture in 20 seconds
A cash-out pays a merchant the money in its wallet, into its real bank account. One Finance person processes it, and a different Finance person approves the final step. Nothing leaves the wallet until that last step.
:::

### What a cash-out is
A merchant's wallet is a number on our books. It says how much we owe the merchant. A **cash-out** is the merchant's request to receive that money in its real bank account.

Example: Noon Mart has at least 100.0000 LYD in its wallet and asks to cash out 100.0000 LYD. At the end, the wallet goes down by 100.0000 and our treasury goes down by 100.0000 (Entry 8).

### States
A cash-out moves through these states: `PENDING` → `PROCESSING` → `COMPLETE` → `SUBTRACTED`, or `REJECTED`.

| State | Meaning |
| :--- | :--- |
| `PENDING` | Requested; waiting for Finance. |
| `PROCESSING` | Finance has started paying it. |
| `COMPLETE` | The bank transfer has been made. |
| `SUBTRACTED` | A second Finance person approved, and the amount was taken off the merchant's wallet. |
| `REJECTED` | Finance refused it. |

### The steps on the **Cash-Outs** screen
1. Open the request and read the **bank details snapshot**. It is a copy of the bank details as they were when the request was made. If the merchant later changes its bank account, a request already made keeps the old snapshot.
2. Check four things: the destination is the merchant's verified bank account, the merchant is `ACTIVE`, the wallet has enough balance, and no negative balance or hold applies.
3. Use **Process**. Open the checklist [[c:sg-process-cashout|Process or approve a cash-out]] first.
4. Make the real bank transfer outside the platform, using the bank's own controls.
5. Mark it complete.
6. A **different** Finance user uses **Approve and execute** to subtract the amount. The ledger entry is a wallet debit and a treasury credit (Entry 8). The same checklist applies.
7. If it must be refused, use **Reject and release**. Open [[c:sg-reject-cashout|Reject a cash-out]] first. Nothing has been subtracted before the final step, so the merchant's balance is unchanged.

### Rules
* A merchant who is suspended, has a negative balance, or has unresolved AML matters **cannot cash out**. AML means anti-money-laundering.
* Cash-outs stop automatically when the ledger equation shows drift. See [[a:b08-05|the ledger equation and what to do when it does not hold]].
* The person who processes it is not the person who approves the subtraction.
@@end

@@article id=b08-08 book=8 order=8 title="Adjustments: refunds, chargebacks, manual entries and corrections" roles=FINANCE,OPERATOR minutes=3 ui=AVAILABLE related=b08-09,b04-05,b08-07
:::summary Big picture in 20 seconds
An adjustment is any money movement that is not an ordinary successful payment. It is the only way to change the books after the fact, and it always needs two people.
:::

### What an adjustment is
An **adjustment** is any money movement that is not an ordinary successful payment. Examples are a refund, a dispute outcome and a correction. It is the only way to change books after the fact, and it **always needs two people**: one proposes it and a different one approves it.

### Types
Each adjustment has one type. Use the table to pick the right one.

| Type | Use |
| :--- | :--- |
| `REFUND` | Return money to the payer. |
| `CHARGEBACK` | A dispute outcome; usually drafted by the system. |
| `MANUAL_CREDIT` | Add money to an account in exceptional, documented cases. |
| `MANUAL_DEBIT` | Remove money from an account in exceptional, documented cases. |
| `CORRECTION` | Fix an earlier mistake. |
| `CASHOUT_SUBTRACTION` | The last step of a cash-out. |

### States
An adjustment moves through these states: `DRAFT` → `PENDING_REVIEW` → `APPROVED` → `EXECUTING` → `EXECUTED`, or `REJECTED`.

`EXECUTING` is used for refunds that must be sent to the payment company. The adjustment stays there while the refund call is in flight or uncertain, and the platform reconciles it.

### On the **Adjustments** screen
* **Propose** creates an adjustment. Choose the type, the target account and the amount. Choose whether to reverse the commission, and write the reason. See [[a:b04-06|writing a reason that survives an audit]]. Open the checklist [[c:sg-propose-adjustment|Propose an adjustment]] first.
* A different `FINANCE` user approves it from **Approvals**.
* **Reverse** proposes a new adjustment that offsets an earlier one. It does not edit or delete the earlier one, and it needs its own approval. Open [[c:sg-reverse-adjustment|Reverse an adjustment]] first.

### Commission on refunds: a worked example
A full refund usually reverses the commission too (Entry 9). This can be set per rail and per merchant.

Example: Layla returns her purchase, and Noon Mart's 100.0000 LYD sale is refunded in full. The merchant's wallet is debited the net amount, 97.0000. Platform income is debited the commission, 3.0000. Treasury (or clearing) is credited 100.0000. Check: 97.0000 + 3.0000 = 100.0000.

### Rules
1. **Executed adjustments are never edited.** A wrong one is offset by a new one.
2. **Check the amount and the currency** before proposing. A refund can never exceed the original payment.
3. **Link a refund to any dispute** on the same payment so the same money is not returned twice.
4. **The system drafts chargebacks, but never approves them.** A human checker is required before any money moves.
@@end

@@article id=b08-09 book=8 order=9 title="Disputes and chargebacks" roles=FINANCE,OPERATOR minutes=3 ui=AVAILABLE related=b08-08,b08-13,b04-05
:::summary Big picture in 20 seconds
A dispute is a claim that a payment should be returned. The system drafts the chargeback, but no money moves until a human Finance checker approves it. The money waits in a reserve until the dispute is won or lost.
:::

### What a dispute is
A **dispute** (or **chargeback**) happens when a payer, or the payer's bank or card scheme, says a payment should be returned. The payment company tells us, and the money may be taken back from us.

For example, Layla tells her bank that she did not make her 100.0000 LYD payment to Noon Mart. The bank asks for the money back, and the payment company tells us.

### How a dispute reaches us
A dispute can arrive in three ways. Read the table to see each channel.

| Channel | How |
| :--- | :--- |
| Partner message | A verified webhook says a dispute opened. |
| Statement | A settlement line is flagged as a chargeback or reversal. |
| Manual | Finance enters one received by e-mail or through a partner portal. |

A dispute is unique per gateway and partner dispute reference. So a repeated message or a re-loaded statement cannot create a second dispute.

### The lifecycle
A dispute moves through these states: `OPENED` → `EVIDENCE_REQUESTED` → `EVIDENCE_SUBMITTED` → `WON`, `LOST`, `EXPIRED` or `WITHDRAWN`.

* When a dispute opens, the payment's state becomes `DISPUTED`. It is not undone.
* There is an **evidence deadline**. If it passes without evidence, the dispute becomes `EXPIRED`, which is treated as lost unless the rail's rules say otherwise.
* A refund already issued is linked to the dispute.

### How the system drafts the chargeback
1. A dispute is created.
2. A **system drafting identity** creates a chargeback adjustment in a waiting state.
3. A human `FINANCE` checker must approve it. The system can never approve or execute.
4. Until a human approves, **no money moves** and the merchant's wallet is untouched. A priority-2 case opens if the request is still waiting shortly before the evidence deadline.

### What the money does
The ledger records each moment of a dispute. The example is the same 100.0000 LYD sale: the merchant wallet holds 97.0000 of it and income holds 3.0000 of commission.

| Moment | Entry |
| :--- | :--- |
| Dispute approved for reserve | Wallet and income reduced; money goes to `CHARGEBACK_RESERVE` (Entry 10, first part). |
| Dispute lost | Reserve goes out to the payer or scheme (Entry 10, second part). |
| Dispute won | Reserve returns to the merchant and income (Entry 12). |
| Dispute on an AML-held payment | Handled against the hold (Entry 11), not the wallet. |

With the example numbers:
* Approved for reserve: wallet −97.0000, income −3.0000, `CHARGEBACK_RESERVE` +100.0000.
* Lost: `CHARGEBACK_RESERVE` −100.0000, treasury −100.0000.
* Won: `CHARGEBACK_RESERVE` −100.0000, wallet +97.0000, income +3.0000.

### When the merchant's balance is too low
The wallet may hold less than the amount to reserve. See [[a:b08-13|negative balances and ceilings]].
@@end

@@article id=b08-10 book=8 order=10 title="Settlement: clearing, T+N, direct-to-merchant and held-by-provider" roles=FINANCE minutes=2 ui=AVAILABLE related=b02-06,b08-06,b08-04
:::summary Big picture in 20 seconds
A payment company usually pays us days after the customer pays. Until then, the money sits in a clearing balance: a note on our books that the partner owes us. Finance watches its age, because an old balance means the partner is late.
:::

### Why money is not instant
A payment company collects the customer's money and typically pays us in a batch some days later. When the payment company pays out the money, that is called **settlement**. **T+N** means "the payment day plus N days".

Example: Layla pays on Monday. With T+2, the payment company pays us on Wednesday. Between Monday and Wednesday, the money is on its way.

### Three settlement targets
The settlement target says who the partner pays. Read each row from left to right.

| Target | Who the partner pays | What we book |
| :--- | :--- | :--- |
| `PLATFORM_CLEARING` | Us | A clearing balance owed by the partner, then a settlement sweep to treasury. |
| `MERCHANT_DIRECT` | The merchant | Only our commission (a receivable) which is netted later. |
| `PROVIDER_HELD` | The partner keeps it for now | Per the route's rules. |

### The settlement cycle for platform clearing
The sale is the usual one: Layla pays Noon Mart 100.0000 LYD, and the commission is 3.0000.

1. **Payment confirmed**: debit clearing, credit wallet and income and fee accrual (Entry 2). Example: clearing 100.0000 is debited. Wallet 97.0000, income 3.0000 and fee accrual 0.8000 are credited. The fee expense of 0.8000 is debited.
2. **Statement arrives**: the **settlement sweep** debits treasury (the net amount) and the fee accrual, and credits clearing (Entry 3). Example: treasury 99.2000 and fee accrual 0.8000 are debited. Clearing 100.0000 is credited.
3. **Fee differs**: the **true-up** debits fee expense and credits the accrual (Entry 4). Example, in a different case: the real fee is 0.9000, the accrued fee was 0.8000, and 0.1000 is posted.

### Clearing ageing
Finance watches how old each clearing balance is. A clearing balance older than the partner's settlement lag means the partner has not paid us on time. Raise it as drift. See [[a:b10-05|RB-04 Reconciliation or ledger drift]].

### Why merchants may be paid before we are
We credit the merchant's wallet at confirmation. If we cash out before the partner settles, we are using our own treasury. For example, Noon Mart cashes out on Tuesday, but the payment company pays us on Wednesday. For that day, our own money covers it. The liquidity screen shows whether cover is enough. See [[a:b08-11|profitability, liquidity and the invariant screens]].
@@end

@@article id=b08-11 book=8 order=11 title="Profitability, liquidity and the invariant screens" roles=FINANCE minutes=3 ui=AVAILABLE related=b08-05,b08-10,b03-03
:::summary Big picture in 20 seconds
The profit and liquidity screens show how much we earn and whether we have enough cash to pay what we owe. Every figure is computed from the ledger lines, so a report that disagrees with the ledger is a bug in the report.
:::

### Where the numbers come from
All figures on these screens are **computed from the ledger lines**. There are no hand-maintained totals. If a report disagrees with the ledger, the report has a bug.

### Profit definitions
Each measure below is built from ledger accounts. Read the "Meaning" column as a short recipe.

| Measure | Meaning |
| :--- | :--- |
| Gross commission revenue | Credits to platform income minus debits to it (reversals). |
| Gateway cost (realised) | Provider fee expense plus gateway fee expense, net of true-ups. |
| Gateway cost (accrued, unsettled) | The fee accrual balance, shown separately. |
| Net revenue | Gross commission minus realised gateway cost. |
| Chargeback losses | Reserve paid out on lost disputes, net of commission reversed. |
| Refund commission reversed | Debits to income from refunds, shown as contra-revenue. |
| Net contribution | Net revenue minus chargeback losses. |
| Commission receivable | Commission earned but not yet netted. |

Example: Layla's 100.0000 LYD sale at Noon Mart earns 3.0000 commission, and the payment company fee is 0.8000. Gross commission revenue is 3.0000. Realised gateway cost is 0.8000. Net revenue is 3.0000 − 0.8000 = 2.2000.

### The liquidity panels
Liquidity means having enough cash, at the right time, to pay what we owe. Each panel has a "when to worry" signal.

| Panel | What it shows | When to worry |
| :--- | :--- | :--- |
| Invariant status | The latest drift and when it ran. | Any non-zero drift. |
| Treasury cover | Treasury plus clearing versus wallets plus holds plus reserves. | Below the floor. |
| Clearing ageing | Clearing per gateway, by age. | Older than the settlement lag. |
| Cash-out queue | Pending amounts and forecast. | Demand above available cash. |
| Holds and reserves | AML hold and chargeback reserve, oldest item. | Aged beyond deadlines. |
| Receivables | Commission receivable and negative merchant balances versus ceilings. | Ceiling approached. |

For example, treasury 500.0000 plus clearing 100.0000 is 600.0000. If wallets are 450.0000, holds 50.0000 and reserves 20.0000, that side is 520.0000. We have more on the left than we owe on the right, so cover is above 520.0000. Whether it is above the floor depends on the floor your Finance lead has set. These numbers are only an example.

### Who sees what
Merchants see their own gross, commission and net, **never** gateway costs or our margin.
@@end

@@article id=b08-12 book=8 order=12 title="All fifteen worked journal entries (plus one)" roles=FINANCE minutes=3 ui=AVAILABLE related=b08-01,b08-04
:::summary Big picture in 20 seconds
This is the reference table of the fifteen standard journal entries plus the late-success event (entry 16). Use it with the ledger explorer to see every debit and credit for a 100 LYD sale.
:::

### How to read the table
Each row is one journal entry: an event, the accounts debited and the accounts credited. In every row the debits add up to the credits. For the plain meaning of each account name, see [[a:b08-02|the eleven accounts]].

Each row uses a 100.0000 LYD link and 3% commission unless said otherwise. The example is Layla paying Noon Mart 100.0000 LYD: the merchant gets 97.0000 and the commission is 3.0000. Entries 6, 7 and 10 have two parts, shown as "a" and "b".

### Find your entry
* Money coming in from a payment: entries 1, 2, 5, 6, 7 and 13.
* Settlement from the payment company: entries 3 and 4.
* Cash-outs and refunds: entries 8, 9 and 14.
* Holds and disputes: entries 7, 10, 11, 12 and 15.
* An extra event in the explorer: entry 16.

### The entries
Account names are the code names from [[a:b08-02|the eleven accounts]]. Amounts have four decimal places.

| # | Event | Debits | Credits |
| :-- | :--- | :--- | :--- |
| 1 | Money in treasury, fee deducted at source (1.0000 fee) | `TREASURY` 99.0000; `PROVIDER_FEE_EXPENSE` 1.0000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 |
| 2 | Money with the partner, fee accrued (0.8000) | `GATEWAY_CLEARING` 100.0000; `GATEWAY_FEE_EXPENSE` 0.8000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000; `GATEWAY_FEE_ACCRUAL` 0.8000 |
| 3 | Settlement sweep (statement shows 99.2000 net) | `TREASURY` 99.2000; `GATEWAY_FEE_ACCRUAL` 0.8000 | `GATEWAY_CLEARING` 100.0000 |
| 4 | Fee true-up (actual 0.9000 vs accrued 0.8000) | `GATEWAY_FEE_EXPENSE` 0.1000 | `GATEWAY_FEE_ACCRUAL` 0.1000 |
| 5 | Payer surcharge (103.0000 charged) | `GATEWAY_CLEARING` 103.0000; `GATEWAY_FEE_EXPENSE` 0.8000 | `MERCHANT_WALLET` 100.0000; `PLATFORM_INCOME` 3.0000; `GATEWAY_FEE_ACCRUAL` 0.8000 |
| 6a | Direct to merchant: at confirmation | `COMMISSION_RECEIVABLE` 3.0000 | `PLATFORM_INCOME` 3.0000 |
| 6b | Direct to merchant: later, at netting | `MERCHANT_WALLET` 3.0000 | `COMMISSION_RECEIVABLE` 3.0000 |
| 7a | AML hold: at confirmation | `GATEWAY_CLEARING` 100.0000 | `AML_HOLD` 100.0000 |
| 7b | AML hold: later, at release | `AML_HOLD` 100.0000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 |
| 8 | Cash-out subtracted | `MERCHANT_WALLET` 100.0000 | `TREASURY` 100.0000 |
| 9 | Full refund, commission reversed | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 | `TREASURY` (or clearing) 100.0000 |
| 10a | Chargeback reserved | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 | `CHARGEBACK_RESERVE` 100.0000 |
| 10b | Chargeback lost, later | `CHARGEBACK_RESERVE` 100.0000 | `TREASURY` 100.0000 |
| 11 | AML hold voided and returned | `AML_HOLD` 100.0000 | `TREASURY` (or clearing) 100.0000 |
| 12 | Chargeback won | `CHARGEBACK_RESERVE` 100.0000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 |
| 13 | NeomPay confirmation | `TREASURY` 100.0000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 |
| 14 | NeomPay full refund | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 | `TREASURY` 100.0000 |
| 15 | Chargeback with only 40.0000 in the wallet | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 | `CHARGEBACK_RESERVE` 100.0000 |
| 16 | Late success on an already-paid link (the explorer's extra event) | `GATEWAY_CLEARING` 100.0000 | `SUSPENSE` 100.0000 |

**Reading entry 15.** The wallet goes from +40.0000 to −57.0000, because 40.0000 − 97.0000 = −57.0000. The ledger equation still holds: a negative wallet is arithmetically the same as the merchant owing us money. See [[a:b08-13|negative balances and ceilings]].

### Try it
The explorer below lets you change the amounts.

{{widget:ledger-explorer}}
@@end

@@article id=b08-13 book=8 order=13 title="Negative balances and ceilings" roles=FINANCE,OPERATOR,COMPLIANCE minutes=2 ui=AVAILABLE related=b08-09,b05-01,b08-07
:::summary Big picture in 20 seconds
A refund or chargeback can be larger than a merchant's wallet. A per-merchant ceiling limits how far below zero the wallet may go. For new merchants the ceiling is 0, so such an adjustment stops and Finance decides what to do.
:::

### The situation
A chargeback or refund can be larger than the merchant's wallet balance.

Example: Noon Mart's wallet holds 40.0000 LYD. A chargeback of 100.0000 LYD arrives: 97.0000 from the wallet and 3.0000 from income. If the wallet pays 97.0000, it falls from +40.0000 to −57.0000. A negative wallet means the merchant owes us money.

### The rules
1. The adjustment still posts in full (Entry 15) as long as the wallet does not go below the merchant's **negative-balance ceiling**. The ceiling is the lowest balance we allow. For new merchants it is `0`, so by default the adjustment cannot post if it would push the wallet below zero. The ceiling is raised per merchant, by two-person approval, as trust grows.
2. If posting would break the ceiling, the adjustment **does not execute**. A priority-1 operator case opens and the merchant is told about the shortfall. Finance then chooses one of three actions:
   * collect the money (invoice),
   * net it against pending cash-outs,
   * or suspend the merchant. See [[a:b05-08|the Merchants screen]].
3. A negative balance is recovered by **netting** against future payments: each confirmed payment first reduces what is owed. The merchant's statement shows "amount owed to platform". For example, if Noon Mart is at −57.0000 and a new payment credits it 97.0000, the wallet becomes −57.0000 + 97.0000 = +40.0000.
4. A merchant with a negative balance **cannot cash out**. Suspension and closure are blocked until the balance returns to zero or is written off by an approved manual debit or correction.
@@end


### BOOK 9 — RISK, AML & COMPLIANCE

@@article id=b09-01 book=9 order=1 title="Anti-money-laundering from zero: what it is and why it concerns everyone" roles=ALL minutes=3 ui=AVAILABLE related=b09-02,b09-10,b01-10
:::summary Big picture in 20 seconds
Criminals try to make stolen money look clean, and a payment platform is a place they can try it. Anti-money-laundering (AML) is how we detect and stop that. Everyone on the team has a part.
:::

Imagine a thief who has a large amount of cash from fraud. If he spends it openly, people ask where it came from. So he looks for a way to make it look normal. A payment platform can be that way, if we are not careful.

### What money laundering is
Some money comes from crime: fraud, theft, bribery, smuggling. A criminal cannot spend large sums of such money openly without questions. **Money laundering** is making that money look like it came from a normal source.

It is usually described in three stages:
1. **Placement**: getting the dirty money into the financial system. For example, many small payments through a shop that does not really sell much.
2. **Layering**: moving the money around so that its origin is hard to follow. For example, many transfers, many accounts, many payment methods.
3. **Integration**: bringing the money back as apparently clean money. For example, a "legitimate" business payout to a bank account.

### Why a payment platform is a target
A platform like ours is fast, handles many small payments, connects many payment methods, and pays out to bank accounts. A criminal who can make a fake shop receive payments and then cash out has laundered money through us.

### What AML means for us
**AML** (anti-money-laundering) is the set of rules and activities that detect and stop this. It includes these parts:
* Knowing who our merchants really are. This is KYB, see [[a:b05-04|KYB documents and beneficial owners]].
* Checking names against official lists. This is **screening**, see [[a:b09-03|how screening works]].
* Watching payments for suspicious patterns. These are the **rules**, see [[a:b09-04|how the rules work]].
* Investigating and deciding. These are **cases**, see [[a:b09-05|how cases work]].
* Telling the authorities when the law requires it. This is **reporting**, see [[a:b09-07|regulatory reporting]].
* Keeping records, see [[a:b09-09|records, retention and immutability]].

### Who does what
* **Everyone** is a sensor. If something looks wrong, you report it. See [[a:b09-10|what to do if you notice something suspicious]].
* **Compliance** analysts investigate and propose decisions.
* The **MLRO** (Money Laundering Reporting Officer) is the senior person who owns the final decisions and the contact with the authorities.
* **The system** screens, flags, holds and records. It does not decide to accuse anyone.

### Why this has legal weight
Failing to run these controls can lead to fines, loss of our licence and personal liability. **Tipping-off** (warning a suspect) can itself be a crime. See [[a:b09-08|what you may say, and to whom]].
@@end

@@article id=b09-02 book=9 order=2 title="The seven layers of the AML program" roles=COMPLIANCE,MLRO,OPERATOR minutes=3 ui=AVAILABLE related=b09-03,b09-04,b09-05
:::summary Big picture in 20 seconds
Our anti-money-laundering (AML) program has seven layers, from onboarding checks to record keeping. The quick checks run inside the payment itself. The slow checks run after it, so payments stay fast.
:::

Think of airport security. One check happens at the door, one at the gate, and some happen later by people who review the cameras. Our AML program works in a similar way.

### The seven layers
Read the table from top to bottom. L1 and L2 look at who the merchant is. L3 and L4 look at payments. L5 to L7 handle decisions, reporting and proof. The **guard** is the set of checks at the start of a payment.

| Layer | Purpose | When it runs |
| :--- | :--- | :--- |
| L1 Onboarding screening | Is the business or any owner sanctioned, politically exposed or in negative news? | When a join request is submitted; again when an owner changes. |
| L2 Ongoing screening | Has anything changed since approval? | Periodically by risk tier, and whenever a watch-list is updated. |
| L3 Transaction-time check | Is this merchant or payer allowed to transact right now? | On the payment path, inside the start-of-payment guard, using cheap local checks. |
| L4 Transaction monitoring | Do patterns or amounts break thresholds? | At confirmation and in daily batch analysis. |
| L5 Case management | Review, decide and document. | Continuously. |
| L6 Regulatory reporting | Report what the law requires. | When a rule or a case requires it. |
| L7 Record keeping and governance | Prove what was done and why. | Continuously. |

### How the payment path stays fast
Payments have a strict speed budget. A payer waits while we work, so we cannot run every check at that moment. So the work is split into three steps.

1. **Inside the guard (fast, local):** merchant status, risk tier, velocity limits, a local copy of the watch-list, and the cheap AML rules. A hard watch-list match makes the attempt `BLOCKED`. The customer sees only a generic message.
2. **At or after confirmation (deferred):** name screening of the payer where a name is available, structuring checks and pattern rules. A hit turns the posting into an AML hold (for money we hold) or a case (for money paid directly to the merchant).
3. **Daily batch:** structuring, many-to-one and one-to-many patterns, sudden activity after dormancy, rapid in-and-out movement, and a merchant's activity compared with its declared volume.

### When a payment method requires a live screening call
Sometimes a payment method (a rail) legally requires a screening call during the payment. Then a strict timeout applies. The default is 800 milliseconds. Each rail has a policy for when the call is too slow:
* **Fail closed**: block the payment.
* **Fail open and flag**: let the payment continue and open a case.

The default is fail open and flag below the rail's screening threshold, and fail closed above it.
@@end

@@article id=b09-03 book=9 order=3 title="Screening: lists, matches and how to decide them" roles=COMPLIANCE,MLRO minutes=3 ui=AVAILABLE related=b09-05,b05-05,b09-08
:::summary Big picture in 20 seconds
Screening compares names and data against official lists. When a name looks similar, a person must decide if it is the same person. You record the decision and the reason, and the system keeps proof of what was checked.
:::

Omar works in compliance. On Monday the system shows him a screening result for a new merchant owner. The owner's name looks very close to a name on a sanctions list. Omar does not know yet if it is the same person. This article explains what he sees and what he decides.

### What is screened
Screening checks four kinds of subject. Read the table to see which data is used and when it runs.

| Subject | Data used | When |
| :--- | :--- | :--- |
| Merchant (legal entity) | Legal and trade name, registration number, country, activity | Onboarding, periodic, list update, name change |
| Beneficial owner, controller, signatory | Full name (Arabic and Latin), date of birth, nationality, national ID, declared PEP status | Onboarding, owner change, periodic, list update |
| Payer | Phone, wallet ID, card alias, device and IP fingerprint, and a name only where the rail returns one | At transaction time (against the cached watch-list) |
| Payment attempt | Amount, rail, merchant risk tier, cumulative behaviour | Rule engine |

Only the fields needed for matching are sent to the screening provider. **Documents are never sent.**

### The lists
A **watch-list** is a list of people and companies we must be careful with. We screen against these lists:
* International sanctions lists applicable to the operator.
* National or Central Bank lists.
* Politically-exposed-person (PEP) lists. A PEP is a person with a prominent public role. A PEP is allowed, but is treated as higher risk.
* Adverse-media sources, which are news reports about crime.
* An **internal watch-list** that we maintain, for example offboarded merchants.

### Arabic names
Names in Arabic script have many spellings in Latin letters. So the matching normalises Arabic (marks, letter variants, digits), sends both Arabic and a best Latin spelling where possible, and records a match score.

Before go-live, a fixed set of Arabic test names is run.

### The four results
Every screening ends with one result. Read the table to see what each result means and what you do.

| Result | Meaning | Action |
| :--- | :--- | :--- |
| `CLEAR` | No match | none |
| `POTENTIAL_MATCH` | A possible match | Decide each match |
| `CONFIRMED_MATCH` | A real match | Sanctions: emergency suspension, see [[a:b09-06]] |
| `ERROR` | Provider unavailable | At onboarding: **cannot approve** until fixed |

### How Omar decides a match
A `POTENTIAL_MATCH` is a question, not an answer. Omar opens the screening and reviews each candidate with its list, score and attributes. He compares what he can: date of birth, nationality and ID. Then he uses **Disposition** and **Save**. Before he starts, he opens the checklist [[c:sg-aml-disposition|Decide a screening match]].

Disposition has three choices:
* `FALSE_POSITIVE`: a different person. You may set `suppress_future` with an **expiry date**, so the same pair does not reopen on every periodic screening. Suppression ends automatically if the person's identifying data changes.
* `TRUE_MATCH`: the match is real.
* `ESCALATED`: refer to the MLRO.

Always write the rationale: what you compared (date of birth, nationality, ID) and why you decided.

### What the system keeps as proof
Each screening stores exactly which list versions were checked and a fingerprint of the input. This is called reproducibility. A past decision can be replayed against the lists that were in force at that time.

### What happens when a list changes
When a list changes, all active subjects are re-screened. A new match on an active merchant opens a case and **restricts cash-out immediately**. Payments continue unless severity is `CRITICAL`. See [[a:b09-05|how cases work]] for what happens next.
@@end

@@article id=b09-04 book=9 order=4 title="Rules: velocity limits, AML rules and how they change" roles=COMPLIANCE,MLRO,FINANCE minutes=3 ui=AVAILABLE related=b09-05,b04-05
:::summary Big picture in 20 seconds
Velocity rules limit how often or how much. AML rules look for suspicious patterns and can hold money or open cases. Every rule change needs two people, and a dry-run shows the effect before it goes live.
:::

Think of a shop owner who watches the till. One rule says "no more than a few sales from the same person in an hour". Another says "look closely when many payments are just under the limit". Our platform has the same two kinds of watching.

### Two different tools
* **Velocity rules** limit *how often or how much* in a window. For example, no more than N payments from one phone number in an hour. The action is `REJECT` (the attempt becomes `BLOCKED`) or `FLAG`. Velocity rules never move money.
* **AML rules** look for suspicious *patterns or amounts*. Their actions can hold money or open cases.

### AML rule types
Each AML rule has a type. Read the table to see what each type detects.

| Type | What it detects |
| :--- | :--- |
| `SINGLE_AMOUNT` | One payment above an amount. |
| `CUMULATIVE_WINDOW` | A total or count per subject in a rolling window. |
| `STRUCTURING` | Many payments just below a threshold (splitting to avoid it). |
| `RISK_TIER` | A payment above a lower amount for riskier merchants. |
| `COUNTERPARTY_COUNTRY` | Cross-border exposure on international card rails. |
| `RAIL` | Limits specific to a rail (for example one that cannot be asked for status). |
| `MERCHANT_DIRECT_AMOUNT` | A threshold hit where we hold no cash. |

### Rule actions
When an AML rule hits, it does one of four actions. `AML_HOLD` is the place where held money waits for a decision.

| Action | Effect |
| :--- | :--- |
| `HOLD` | Money goes to `AML_HOLD` and a case opens. |
| `FLAG` | The payment proceeds; a review case opens. |
| `BLOCK` | The attempt is `BLOCKED`. |
| `CASE_ONLY` | A case opens; money is untouched. |

### Subjects, not links
Rules evaluate by *subject*: the merchant, the owner or the payer identifier. So splitting a big sale across links, applications or rails does not avoid a threshold.

### How a rule change is controlled
* **Every rule change needs two people.** The `MLRO` approves AML rules. See [[a:b04-05|who approves what]].
* **Tightening** in an emergency may be activated at once and ratified within 24 hours.
* **Loosening** never skips review.
* A **dry-run** replays recent payments against a proposed rule. It shows how many holds and cases the rule would have made, so a noisy rule is caught first.
* Open the checklist [[c:sg-aml-rule-change|Create or change an AML rule]] before **Create** or **Save** on the **AML Rules** screen.

### Rule quality
A rule whose precision falls is flagged for retuning. Precision falls when many holds end in release. The flag is there so reviewers are not buried in noise.

:::note Where to change it
The **AML Rules** screen manages AML rules. **Velocity rules** are managed on the **Pricing & Limits** screen. Both need a second person, see [[a:b04-05|who approves what]].
:::
@@end

@@article id=b09-05 book=9 order=5 title="Cases: lifecycle, severity, deadlines and what money does" roles=COMPLIANCE,MLRO minutes=3 ui=AVAILABLE related=b09-06,b08-04,b04-05
:::summary Big picture in 20 seconds
A case is the file we open when something looks suspicious. One analyst proposes a resolution, and the MLRO must approve it. Money moves only after that approval, and the severity sets the deadline.
:::

Omar in compliance sees a new case. A rule found that Noon Mart received many payments just below a limit, and the system held that money. Omar studies the payments and writes his notes. He proposes to release the money. He cannot release it himself. The MLRO must approve first, and only then does the money move.

### The case lifecycle
A case moves through these states: `OPEN` → `IN_REVIEW` → `PENDING_CHECKER` → one of four endings: `RELEASED`, `REJECTED_VOID`, `FROZEN` or `ESCALATED_STR`.

1. A rule hit, a screening match, a combined event or an analyst's referral creates the case. The system computes a **severity** and a deadline.
2. A `COMPLIANCE` analyst (the maker) investigates, records notes, and uses **Propose** to suggest a resolution. Open the checklist [[c:sg-aml-propose-resolution|Propose an AML case resolution]] first.
3. An `MLRO` (the checker, never the same person) approves. **Only then does money move.**
4. The resolution and the ledger posting are one atomic step. Atomic means they happen together or not at all.

### The four resolutions
The analyst proposes one resolution and the MLRO approves it. Read the table to see what each one does to the money. Entry 7 and Entry 11 are ledger entries, explained in Book 8.

| Resolution | Effect |
| :--- | :--- |
| Release | The held money goes to the merchant and income (Entry 7, release). Commission becomes income now. |
| Void and return | The money is returned to the payer (Entry 11). No commission was ever recognised. |
| Freeze | Only the case state changes; the money stays in `AML_HOLD`. |
| Escalate to STR | A suspicious-activity report draft is created. Details: [[a:b09-07]] |

### How severity is decided
Severity is the case's urgency level: `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`. It starts from the rule's base level. Then these inputs raise it. They are stored, so the result can be explained.

| Input | Effect |
| :--- | :--- |
| A velocity `FLAG` and an AML rule hit on the same payment | `CRITICAL` |
| A sanctions `CONFIRMED_MATCH` | `CRITICAL`; merchant restricted |
| A PEP `POTENTIAL_MATCH` | At least `HIGH` |
| Merchant risk tier `HIGH` | One level up |
| Amount many times the declared monthly volume | One level up |
| The same subject already has an open case | One level up |
| Money paid directly to the merchant (we hold no cash) | No change; action is case only |

### Default deadlines
Severity sets how fast the case must be resolved.

| Severity | Default deadline |
| :--- | :--- |
| `CRITICAL` | 4 hours |
| `HIGH` | 1 business day |
| `MEDIUM` | 3 business days |
| `LOW` | 5 business days |

Breaches raise alerts. A case cannot be closed without a written rationale and, for holds, a ledger outcome.

### A dispute on held money
A chargeback is a payer's dispute that takes money back. A chargeback on an AML-held payment is processed against the hold (void and return). It never touches the merchant's wallet.
@@end

@@article id=b09-06 book=9 order=6 title="Restricting a merchant: suspension, emergency ratification and screening outcomes" roles=COMPLIANCE,MLRO,OPERATOR minutes=2 ui=AVAILABLE related=b04-04,b05-08,b09-03
:::summary Big picture in 20 seconds
We can suspend a merchant in the normal way or, in an emergency, at once by one person. An emergency suspension must be reviewed by another person within 24 hours. If nobody does, the merchant stays restricted. The merchant is told only a generic message.
:::

Sometimes waiting is dangerous. Suppose Omar sees a sanctions match on a merchant's owner. He cannot wait for a long review, because delay is the danger. So the platform has a fast path. The price of speed is a second look afterwards.

### The two paths to suspension
1. **Standard**: a reasoned decision, reviewed in the usual way.
2. **Emergency**: one authorised person suspends at once, because delay is the danger. The system creates an approval request in *emergency ratification* mode and a clock of **24 hours**.

### What ratification means
To ratify is to confirm after the fact. A different person from `COMPLIANCE`, or the `MLRO`, must review the emergency suspension within 24 hours. That person either **ratifies** it or **revokes** it.

If nobody does, a priority-2 alert fires and the suspension **stays in force**. It is never reversed automatically. This is fail safe: restricted, not open.

### Screening outcomes that restrict a merchant
Read the table to see what each screening outcome does to the merchant. For how screening results are decided, see [[a:b09-03|screening and disposition]].

| Outcome | Result |
| :--- | :--- |
| Sanctions `CONFIRMED_MATCH` | Immediate suspension by the emergency path; cash-out frozen; held money stays in hold; a suspicious-activity draft is created; nothing more happens until the MLRO decides. |
| `POTENTIAL_MATCH` | Each match must be decided. Until then an applicant cannot be approved, or an existing merchant's cash-out is held. |
| New match after a list update | A case opens; cash-out is restricted at once; payments continue unless the case is `CRITICAL`. |

### Reinstating a merchant
Reinstatement increases risk. So it needs prior approval by a different `COMPLIANCE` or `MLRO` user. It is never an emergency action.

### What the merchant is told
Only a generic message. If the cause is AML, there is **no reason** in the message. See [[a:b09-08|what you may say, and to whom]].
@@end

@@article id=b09-07 book=9 order=7 title="Regulatory reporting: large-transaction and suspicious-activity reports" roles=COMPLIANCE,MLRO minutes=2 ui=AVAILABLE related=b09-05,b09-08,b04-05
:::summary Big picture in 20 seconds
Some activity must be reported to the authority. Each reporting rule is `PROVISIONAL` until it is `CONFIRMED` in writing, and a provisional rule can never produce a live filing. Until then the platform can detect, hold and record, but cannot file.
:::

Omar in compliance escalates a case on Noon Mart to a suspicious-activity report. A draft is created. After Omar proposes it, the MLRO approves it. Then comes the question that matters most: do we know what the Central Bank really requires? If the answer is not confirmed in writing, the report can be prepared but never filed. The rest of this article shows how the platform enforces this.

### Reporting is configuration, not code
We must not guess what the authority requires. Every reporting parameter is **data** that can be confirmed and changed.

### Reporting rules
A **reporting rule** says, per authority and report type, when a report is triggered. It can use an amount, a window and conditions. The rule also cites the **source**: the circular or written instruction that justifies it.

Each rule is `PROVISIONAL` or `CONFIRMED`. **A provisional rule can never produce a live filing**; the database refuses it.

### Report types
There are three types of report. Read the table to see what starts each one.

| Type | Triggered by |
| :--- | :--- |
| `LARGE_TRANSACTION` | A rule (can be drafted automatically). |
| `SUSPICIOUS_ACTIVITY` (STR) | A case. Always reviewed by a person. |
| `PERIODIC_RETURN` | A schedule. |

### The life of a report
A report moves through these states:

`DRAFT` → `PENDING_CHECKER` → `APPROVED` (content frozen, fingerprint stored) → `SUBMITTED` → `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY`.

If the authority rejects a report, it is corrected by a new linked report.

Submission is a two-person action: `COMPLIANCE` proposes, `MLRO` approves. On the **AML Reports** screen, **Create** and **Save** are guarded by the checklist [[c:sg-aml-report|Create or save a regulatory report]].

### Internal-only mode
Until the Central Bank's thresholds, formats, deadlines and receiving channel are confirmed in writing, rules stay `PROVISIONAL`. The platform works in **internal-only mode**. In this mode it can detect, hold and record, but it cannot file.

### Confidentiality
The existence of a suspicious-activity report is never disclosed to the subject. The subject is the person or business the report is about. See [[a:b09-08|what you may say, and to whom]]. The saved report is read-only; a correction is a new report.
@@end

@@article id=b09-08 book=9 order=8 title="Confidentiality and tipping-off: what you may say, and to whom" roles=ALL minutes=2 ui=AVAILABLE related=b00-03,b05-09,b02-05
:::summary Big picture in 20 seconds
Never tell anyone, directly or by hint, that they are or may be under suspicion, or that a report exists. Use only generic wording. Being unhelpful is acceptable. Tipping off is not.
:::

A merchant calls support and asks, "Why is my account restricted? Am I under investigation?" The caller is worried and you want to help. This is the exact moment where one friendly sentence can ruin an investigation. This article tells you what you may say and what you must never say.

### What tipping-off is
**Tipping-off** means telling someone, directly or by hint, that they are or may be under suspicion, or that a report has been made about them. It is forbidden. It can be a crime, and it can ruin an investigation.

### What is confidential
Screenings, matches, cases, rule hits that opened cases, reports, and the reasons for AML suspensions. This is called **AML-confidential**.

Only `COMPLIANCE`, `MLRO` and (for audit) `SECURITY_ADMIN` may see it. `SUPPORT` can see *that* a merchant is suspended, never *why*. Every read of an AML case is logged.

### What you may say to a merchant or customer
These are examples of allowed wording. Read the table to find your situation.

| Situation | Allowed wording |
| :--- | :--- |
| A merchant is restricted | "Your account is currently restricted. Please contact the support address in your notice." |
| A customer's payment is blocked | "We cannot process this payment." |
| An application needs more information | Only the specific documents or details requested. |
| A rejection | The neutral code `POLICY` where a more precise code could reveal a screening result. |

### What you must never say or do
* Never say "compliance", "investigation", "screening", "sanctions", "suspicious" or "report" to a merchant or customer in connection with them.
* Never hint ("we need to double-check you for security reasons") when the true reason is AML.
* Never discuss AML matters with colleagues who have no need to know.
* Never put AML information in a merchant-visible note, message, e-mail or ticket.
* Never copy AML information to chat or personal notes.

### How the system helps
Notification templates for merchants and the public **cannot contain AML variables**. This is checked when a template is saved. Checkout never reveals the internal reason for a block.

### If someone asks you directly
If a merchant or customer asks "am I under investigation?" the answer is always the generic one above. Do not say yes, do not say no, and do not say "I cannot tell you because...". Tell your manager and Compliance.

:::danger This rule outranks helpfulness
Being unhelpful to a customer is acceptable. Tipping off is not.
:::
@@end

@@article id=b09-09 book=9 order=9 title="Records, retention and immutability" roles=COMPLIANCE,MLRO,SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b04-07,b09-08
:::summary Big picture in 20 seconds
We keep AML records for 5 years after the relationship ends by default. Report payloads, screening results and case decisions are never edited; a correction is a new record. Every decision can be replayed, and national ID numbers and documents are encrypted.
:::

An auditor asks: "Why did you release this payment last year?" We must be able to show exactly what we knew, what rules and lists we used, and who decided. That is why we keep records, and why we do not change these records afterwards.

### Records kept
We keep KYB records, screenings, rule versions, cases, reports and the audit trail.

### How long we keep them
By default **5 years after the end of the relationship**. This is a setting to be confirmed against Central Bank requirements.

A request to delete personal data does not override a regulatory retention period. After the period, personal data is erased or irreversibly anonymised. Ledger entries remain, because they contain no personal data.

### Immutability
Immutable means it cannot be changed. Frozen report payloads, screening results and case decisions are append-only. You can only add to them. A correction is a new record that refers to the old one.

### Reproducibility
A decision can be replayed. The rule version, the list versions and the input fingerprint are stored with it.

### Protection
National ID numbers and document contents are encrypted, shown masked and every read is logged.
@@end

@@article id=b09-10 book=9 order=10 title="If you notice something suspicious: what every employee should do" roles=ALL minutes=2 ui=AVAILABLE related=b09-01,b09-08,b03-06
:::summary Big picture in 20 seconds
You do not need to be sure. If something looks wrong, tell Compliance the same day and keep it secret. Do not confront the person and do not change how you treat them.
:::

You only need to report. You are not accusing anyone; you are giving Compliance a reason to look.

### Examples that deserve a report
* A merchant's real activity looks nothing like what it described. For example, a small clothes shop with the volume of a supermarket.
* Many payments just below a limit, repeated.
* A merchant asks to change its payout bank account several times, or to an account in another person's name.
* Someone offers you money or favours to approve something, or to skip a step.
* A colleague asks you to approve their own request, or to approve without reading.
* Two merchants that share the same phone, address, owner or documents.
* A customer or merchant asks unusual questions about our checks. For example, "what amount triggers a review?"
* You are asked to move money outside the normal screens, by phone or chat.

### What to do
1. **Do not confront the person.** Do not warn them, do not tell them you are suspicious.
2. **Write down** what you saw: the merchant name, reference numbers, dates, who said what. Facts only.
3. **Tell Compliance** (or your manager if you cannot reach Compliance) the same day, in person or by the agreed internal channel. Do not put it in a merchant-visible place.
4. **Keep the secret.** Tell nobody else.
5. **Continue normally** with the merchant. Do not change how you treat them.

Step 1 and step 4 protect the investigation. A warning, even a kind one, can be tipping-off. Read [[a:b09-08|what you may say, and to whom]] for the exact rules.

:::note You will not be punished for a good-faith report that turns out to be nothing
Silence is the danger. If you are unsure, report.
:::
@@end


### BOOK 10 — WHEN THINGS GO WRONG

@@article id=b10-01 book=10 order=1 title="Incident principles: stay calm, protect money, write things down" roles=ALL minutes=2 ui=AVAILABLE related=b10-08,b10-09,b03-06
:::summary Big picture in 20 seconds
An incident is anything that threatens money, customers or trust. In every incident: stop the harm first, never guess with money, tell people early, and write down what you do.
:::

Read this page first when something goes wrong and you are not sure what to do. It gives the seven rules that apply to every incident. At the end, a table points you to the runbook (the step-by-step guide) for your situation.

An **incident** is anything that threatens money, customers or trust: a partner is down, payments are stuck, numbers do not balance, a secret may have leaked.

### Seven principles
1. **Stop the harm first, understand later.** Pausing a route or a payout is reversible: you can resume it later. A wrong payment is not reversible.
2. **Never guess with money.** Use the evidence screens: the step log, the inbox, the statement.
3. **Tell people early.** Tell your manager and the role named in the runbook. Reporting quickly is never punished.
4. **One person leads.** Agree who is doing what. Do not have two people act on the same item.
5. **Do not work around controls.** Two-person rules apply during incidents too. Only risk-*reducing* actions may be immediate, as explained in [[a:b04-04|emergency actions and the asymmetry principle]].
6. **Write as you go.** Write the time, what you saw, what you did, and who agreed.
7. **Hand over in writing**, as described in [[a:b10-08|shift handover and the escalation ladder]].

### How urgent is it?
Cases and alerts carry a priority: `P1`, `P2` or `P3`. `P1` is the most urgent. The platform already defines some examples. A conflict between trusted signals is `P1`. A late success is `P2`. A ledger drift is treated as `P1`.

### Which runbook do you open?
Find what you see in the left column. The right column names the runbook to open.

| You see | Open |
| :--- | :--- |
| A payment method disappeared; many failures at one partner | [[a:b10-02]] |
| Signature failures, or a valid message from an unknown address | [[a:b10-03]] |
| Many payments in `UNKNOWN` | [[a:b10-04]] |
| The ledger equation shows drift; statement and books disagree | [[a:b10-05]] |
| A route went `FAILING`; token or credentials expired | [[a:b10-06]] |
| A password, key or token may have leaked | [[a:b10-07]] |
| You made a mistake | [[a:b10-09]] |
| The customer says an amount was 1000 times wrong | Stop; P1; [[a:b06-04]] |
@@end

@@article id=b10-02 book=10 order=2 title="RB-01 Gateway outage and the circuit breaker" roles=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b06-11,b10-04,b03-05
:::summary Big picture in 20 seconds
Use this runbook when a payment method disappears or a route shows `OPEN_BREAKER`. The platform has already hidden the failing route. Your job is to confirm, tell the Gateway Admin, and not turn the route back on by hand.
:::

Think of a circuit breaker in a house. When something is wrong, it switches the power off so the damage does not spread. Our platform does the same for a partner that keeps failing. Unlike a house breaker, ours tests the partner again in the background and closes by itself. The partner is the payment company that really moves the money.

### What you see
The dashboard tile **Open Circuit Breakers** is above zero. Customers report that a payment method is missing. A route's health shows `OPEN_BREAKER`.

### What the platform did by itself
After repeated partner faults the **circuit breaker opened**. The route is hidden. New payments move to the next healthy route (for example from a direct route to an aggregator). Small recovery tests repeat in the background.

### What you do
1. **Confirm it is real.** Open the route and look at its health measures. Check the environment.
2. **Tell the Gateway Admin** and your manager.
3. **Do not re-enable the route by hand** while the partner is still failing.
4. **Expect** payments already running to finish on their original settings, and some to become `UNKNOWN`.
5. When the breaker closes, check the **Unknown Backlog** tile. If it grew, run [[a:b10-04|RB-03 A backlog of UNKNOWN payments]].
6. **Tell merchants** (through your manager) only that a payment method is temporarily unavailable.

### Gateway Admin follow-up
Contact the partner and check whether the problem is on their side. If the route must stay off for a long time, pause it deliberately and record why. Pausing is a risk-reducing action and may be immediate. Resuming goes through the normal review.

### What not to do
Do not edit gateway settings to "try something" during an outage. Do not ask customers to retry repeatedly.
@@end

@@article id=b10-03 book=10 order=3 title="RB-02 Partner changed its signature or sender address" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b06-06,b07-05,b10-02
:::summary Big picture in 20 seconds
Use this runbook when signature checks suddenly fail, or a valid message arrives from an unknown address. Never accept unsigned messages; confirm the change with the partner in writing, add the new secret or address through two people, then replay the stored messages.
:::

A partner proves that a message is really from them by adding a **signature** (a code calculated from the message and a secret). We check the signature on each signed message. If the partner changes how it signs, or moves to new servers, our check starts to fail even though the message is honest.

### What you see
An alert about a **spike of signature failures**, or a **valid signature from an address not on our list**. Payments that depend on webhooks stay in `VERIFYING` or become `UNKNOWN`.

### What it usually means
The partner changed how it signs (field order, algorithm, case) or moved its servers.

### What the platform did
The raw messages were stored in the inbox unchanged, so nothing is lost.

### What you do
1. **Do not accept unsigned messages** to "get things moving". That is what an attacker wants.
2. **Gateway Admin:** contact the partner through the official contact and confirm the change in writing.
3. **Add the new secret version or address range** through the two-person route: Gateway Admin proposes, Security Admin approves. Keep an overlap, so the old and the new both work.
4. **Replay** the stored messages once the new recipe is approved.
5. Check that attempts resolve. Then follow [[a:b10-04|RB-03 A backlog of UNKNOWN payments]] for what remains.
6. Record the change and the evidence.

### Warning
If the partner says it changed nothing, treat the event as a possible attack and tell the Security Admin. See [[a:b10-07|a secret may have leaked or an account may be taken over]].
@@end

@@article id=b10-04 book=10 order=4 title="RB-03 A backlog of UNKNOWN payments" roles=OPERATOR,FINANCE minutes=1 ui=AVAILABLE related=b07-03,b07-09,b10-02
:::summary Big picture in 20 seconds
Use this runbook when more and more payments sit in `UNKNOWN`, which means we do not yet know the true result. Find the pattern, ask the partner with Bulk Inquiry, and never mass-resolve by hand.
:::

An `UNKNOWN` payment is one where the partner has not told us clearly whether it succeeded or failed. A few are normal. A growing pile means something is wrong, often at one partner or in one time window.

### What you see
**Unknown Backlog** and **Oldest** on the dashboard are rising, or the `UNKNOWN` bar in **Attempts By State** is growing.

### Steps
1. **Find the pattern.** Filter **Operator Cases** by route and period. Is it one partner? One time window?
2. **If one partner is failing**, follow [[a:b10-02|RB-01 Gateway outage and the circuit breaker]] too.
3. **Run Bulk Inquiry** for the affected route and period, as in [[c:sg-bulk-inquiry|Run a bulk inquiry]]. Most attempts resolve by themselves when the partner answers.
4. **For rails that cannot be asked**, keep the customer page on "Confirming your payment". Resolve through the next statement or an operator decision with evidence. [[a:b07-09|Inquiry]] explains which rails cannot be asked.
5. **Prioritise** by amount and by age.
6. **Do not mass-resolve by hand.** Every manual resolution is a two-person decision with evidence.
7. **Report** progress to your manager at agreed intervals.

### When it is finished
The backlog is back to normal, the oldest item is recent, and cases carry notes of how each was resolved.
@@end

@@article id=b10-05 book=10 order=5 title="RB-04 Reconciliation or ledger drift: payouts stop" roles=FINANCE,SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b08-05,b08-06,b10-01
:::summary Big picture in 20 seconds
Use this runbook when the ledger shows drift or reconciliation shows many mismatched lines. Payouts have stopped; treat it as `P1`, correct items only through approved routes, and never edit a number to make it balance.
:::

Our ledger has a platform-wide equation: what we have must equal what we owe plus what we earned minus what it cost us. **Drift** is the difference between the two sides. It must be 0.0000 LYD. **Reconciliation** compares our records with the partner's statement. When either one fails, we cannot trust our own numbers, so the platform stops paying money out until people understand why.

### What you see
The invariant screen shows a drift other than 0.0000, or reconciliation shows many `MISSING_AT_GATEWAY`, `MISSING_LOCALLY` or `AMOUNT_MISMATCH` lines.

### What the platform did
**Automatic payouts stopped.**

### Steps
1. **Treat it as `P1`** and tell your manager and the Security Admin.
2. **Do not cash out manually** while payouts are stopped.
3. **Re-run the statement ingest** and check that the file and its time zone are right. See [[a:b08-06|reconciliation]].
4. **Inspect each problem line.** `MISSING_AT_GATEWAY` is the most serious: we may have credited money we did not receive.
5. **Post fee variances** to the fee expense through the true-up, as described in [[a:b08-10|settlement]].
6. **Resolve unmatched items** through approved adjustments only.
7. **Never edit a number** to make it balance.
8. **Resume payouts** only when the drift is understood and zero, and your manager agrees.
@@end

@@article id=b10-06 book=10 order=6 title="RB-05 Credentials or tokens expired or failing" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b06-09,b10-02
:::summary Big picture in 20 seconds
Use this runbook when a credential set turns `FAILING` and its route disappears from customers' choices. Find the cause, replace the secret with two people, run `CREDENTIAL_CHECK`, and plan future rotations so old and new versions overlap.
:::

A **credential set** is the group of secrets and tokens we use to log in to a partner. Secrets expire, partners rotate them, and passwords change. When the login stops working, payments through that partner would fail, so the platform takes the route out of the customer's list.

### What you see
A credential set turns `FAILING`. Its route disappears from customers' choices. Failures mention authentication.

### What the platform did
The route was removed from selection. Payments already running continue on their original credentials.

### Steps
1. **Check the cause:** expired secret, rotated token, changed password at the partner, or a merchant's own account problem (for merchant-owned credentials).
2. **Replace the secret** through the credential field (write-only). The change needs two people.
3. **Run `CREDENTIAL_CHECK`.** When it passes, the set becomes `VERIFIED` and the route returns.
4. **For merchant-owned accounts**, tell the merchant through your manager that its account needs attention.
5. **Plan rotations** so they overlap (two versions at once), to avoid downtime.
@@end

@@article id=b10-07 book=10 order=7 title="A secret may have leaked, or an account may be taken over" roles=ALL minutes=2 ui=AVAILABLE related=b11-03,b11-02,b10-01
:::summary Big picture in 20 seconds
Use this runbook if you think a password, key or token has leaked, or someone else is using an account. Tell the Security Admin immediately; do not wait to be sure, and do not hide it.
:::

A **secret** is anything that proves who you are or lets a system in: a password, a key, a token, a code. If a stranger gets one, the stranger can act as you. You may be wrong about the leak, and that is fine. Reporting a false alarm costs little. Waiting costs a lot.

### Signs
* Someone else's activity under your account.
* An unexpected MFA request (MFA is the extra check after your password).
* You pasted a secret somewhere you should not have.
* A merchant says its token leaked.
* A partner says our secret was exposed.

### What to do at once
1. **Tell the Security Admin immediately.** Do not wait to be sure.
2. **Do not try to hide it or fix it quietly.**
3. **Change your own password** if it is your account, from a clean device, and tell the Security Admin so sessions can be revoked.
4. **For a merchant token:** the merchant revokes it in its portal and creates a new one.
5. **For a partner secret:** the Gateway Admin and Security Admin rotate it with an overlap, as in [[a:b10-06|RB-05 Credentials or tokens expired or failing]].
6. **Write down** what was exposed, where, and for how long.

### Why speed matters
A leaked secret is usable until someone replaces it.
@@end

@@article id=b10-08 book=10 order=8 title="Shift handover and the escalation ladder" roles=ALL minutes=1 ui=AVAILABLE related=b03-06,b10-01
:::summary Big picture in 20 seconds
Use this page at the end of every shift and whenever you are stuck. Leave a written note for the next person, and escalate up the ladder: your manager, the role named in the runbook, then the MLRO for AML decisions.
:::

Work on the platform does not stop when your shift ends. The next person cannot read your mind, so what is not written down is lost. A short, clear note prevents repeated work and half-finished approvals.

### The handover note
At the end of a shift, write for the next person:
* what is open and why (case numbers or references),
* what you already tried,
* what you are waiting for and from whom,
* anything risky (an approval half-reviewed, a partner not answering),
* anything you promised to a merchant or customer.

### The escalation ladder
To escalate means to pass a problem to someone with more authority or the right skill. Go up in this order:
1. Your team lead or manager.
2. The role named by the runbook: Gateway Admin for partner issues, Security Admin for security, Finance for money, Compliance for AML (anti-money-laundering).
3. The MLRO (the money-laundering reporting officer, who owns AML decisions).

### Rules
* Never leave a half-finished approval or resolution without a note.
* Tell the next person about anything that could not wait.
* Do not hand over a secret.
@@end

@@article id=b10-09 book=10 order=9 title="You made a mistake: how to report and recover" roles=ALL minutes=1 ui=AVAILABLE related=b03-06,b08-08,b04-06
:::summary Big picture in 20 seconds
Use this runbook the moment you think you made a mistake. Stop, tell your manager at once, write down what happened, and never edit history.
:::

Everyone makes mistakes. Hiding them is what makes them expensive. This runbook shows you what to do in the first minutes, and how the mistake is fixed afterwards.

### Steps
1. **Stop.** Do not try to undo it by clicking more.
2. **Tell your manager at once**, then the role that owns the area.
3. **Write what happened**: what you did, which screen, which item, the time.
4. **Do not edit history.** Money mistakes are fixed by a new approved adjustment that offsets the old one. See [[a:b08-08|adjustments]].
5. **Wrong approval** (before execution): tell the maker. The request can be rejected or withdrawn if it is not yet executed. Once executed, it is offset by a new entry.
6. **Information sent to the wrong person**: tell Security and Compliance now.
7. **Learn from it:** tell your manager what would have stopped you.

### What the platform tells you
Reporting quickly is never punished. Hiding is.
@@end

### BOOK 11 — SECURITY FOR EVERYONE

@@article id=b11-01 book=11 order=1 title="How attackers think, and what protects us" roles=ALL minutes=3 ui=AVAILABLE related=b02-02,b06-17,b11-02
:::summary Big picture in 20 seconds
Attackers want money, information or disruption, and they try the easiest way first, which is usually a person. Our seven layers of defence protect the system. You protect against tricks aimed at you.
:::

Imagine a shop with a strong steel door and a window left open. A thief does not try the door. Attackers think the same way. They look for the weakest point, and in most companies the weakest point is a person who is rushed, helpful or afraid of upsetting someone. This article shows how attackers think, what protects the platform, and where your part begins.

### Attackers want three things
**Money** (steal it or move it), **information** (identities, secrets) and **disruption** (stop us working). They try the easiest way, and the easiest way is usually a person.

### A way to think: six questions (STRIDE)
STRIDE is a checklist of six kinds of attack. Each letter is one kind. Read the table row by row: the first column names the attack, the second says it in plain words, and the third gives an example from our platform.

| Threat | In plain words | Example here |
| :--- | :--- | :--- |
| Spoofing | Pretending to be someone | A forged webhook claiming "paid"; a fake support call |
| Tampering | Changing data | Changing `?status=success` in a return address |
| Repudiation | Denying an action | "I never approved that" |
| Information disclosure | Leaking data | A pasted secret; an exported file |
| Denial of service | Making us unavailable | Flooding the checkout |
| Elevation of privilege | Getting more power | Using another person's account |

### Our layers of defence
The platform uses seven layers, so that if one fails, another still protects us. You do not operate most of them, but you should know they exist.
1. **Separation of services:** the public parts hold no database access and no secrets.
2. **Mutual identity checks** between our own services.
3. **Double-checking in the core**, even for requests from our own admin program.
4. **Two-person approval** for sensitive actions.
5. **Immutable records** of what was done. Immutable means nobody can change them afterwards.
6. **Secret handling:** encrypted, write-only, host-pinned, scrubbed from logs.
7. **Verification of everything inbound:** secret address, sender address, signature, timestamp, duplicate checks and a question back to the partner.

### Your part
The layers protect against attackers who attack the system. You protect against attackers who attack **you**: phishing, pressure, trickery. Read next about [[a:b11-02|phishing, impersonation and social engineering]].

### What you do
* Remember that the easiest target is a person, so slow down when something feels urgent.
* Use the normal screens and the two-person approval, even when you are in a hurry.
@@end

@@article id=b11-02 book=11 order=2 title="Phishing, impersonation and social engineering" roles=ALL minutes=2 ui=AVAILABLE related=b11-03,b10-07
:::summary Big picture in 20 seconds
Social engineering means tricking a person, and it works because people want to help and fear upsetting authority. Never give a password or one-time code to anyone. Verify unusual requests through a second channel you already know.
:::

Suppose your phone rings. The caller says they are from IT, sounds friendly, and knows your name. He asks you to read out the code you just received on your phone. Nothing about the call looks dangerous, and that is exactly why the trick works. This article shows the common tricks and what you do about each one.

**Social engineering** is tricking a person into doing something. It works because people want to be helpful and are afraid of upsetting authority.

### Common tricks
Find the trick in the first column. The last column says what you do. For example, a message says "The CEO needs this payout now". That is the first row: slow down.

| Trick | Example | Your response |
| :--- | :--- | :--- |
| Urgency | "The CEO needs this payout now." | Slow down. Urgent requests use the normal screens. |
| Authority | "I'm from the bank / IT / the regulator." | Verify through a known number, not the one they give. |
| Fake support | "Read me the code on your phone." | Never. Nobody legitimate asks for a code. |
| Fake link | An e-mail with a login page | Do not click; type the address yourself. |
| A favour | "Approve my request, I'll approve yours." | Refuse and report. See [[a:b09-10]]. |
| Pretext | A caller who knows some details | Details do not prove identity. |

A pretext is a made-up story that makes the request seem normal. The caller may know your name or your merchant, but that does not prove who they are.

### Rules
* Never give a password or one-time code to anyone, ever.
* Never act on instructions given only by chat or phone. See [[a:b03-06|safe-working habits that prevent most mistakes]].
* Verify unusual requests through a second channel you already know.
* Report suspicious messages to the Security Admin even if you did not click.

### What you do when you are not sure
1. Stop. Do not click, reply or read out any code.
2. Contact the person through a number or channel you already know.
3. Report the message to the Security Admin, even if nothing happened.
@@end

@@article id=b11-03 book=11 order=3 title="Passwords, MFA, sessions and devices: the rules" roles=ALL minutes=1 ui=AVAILABLE related=b01-07,b03-01,b10-07
:::summary Big picture in 20 seconds
Nine everyday rules protect your account and the platform. The short version: a long unique password, MFA always, never share a secret, lock your screen, and report a lost device immediately.
:::

Your account is your key to the platform. These nine rules keep the key in your hands. **MFA** (multi-factor authentication) is the extra check after your password, for example a code sent to your phone. A **session** is the time you stay signed in.

1. **Unique, long password.** Never reuse one from elsewhere. Use an approved password manager if your company provides one.
2. **MFA always.** Keep your phone secure. If you lose it, tell the Security Admin immediately.
3. **Never share** your password, code or session. Not with a manager, IT or "support".
4. **Lock your screen** whenever you step away.
5. **Do not sign in on shared or personal computers.**
6. **Back Office only from the office network** (or the approved VPN).
7. **Short sessions are normal.** Sign in again; do not ask for an extension. Use **Sign out** when you finish; it revokes the session on the server.
8. **Report a lost device or a suspected leak** the same minute. Follow [[a:b10-07|what to do when a secret may have leaked or an account may be taken over]].
9. **Sensitive actions re-ask for sign-in** (for example creating an API token). This is protection, not a bug.
@@end

@@article id=b11-04 book=11 order=4 title="Handling data: personal data, exports, screenshots and chat" roles=ALL minutes=2 ui=AVAILABLE related=b03-04,b09-08,b05-04
:::summary Big picture in 20 seconds
Customer and company data stays inside our platform. Quote references, not names or numbers. Never copy data into chat, personal notes, phones or e-mail, and report any accidental exposure at once.
:::

Every time data leaves the platform, we lose control of it. A phone number pasted into a chat group can be forwarded, saved and seen by people who should never see it. The rules below keep data where we can protect it.

### What counts as sensitive
National ID numbers, phone numbers, bank details, documents, any AML (anti-money-laundering) information, anything secret, and anything that identifies a customer.

### Rules
Read each row from left to right. The left column is what you do. The right column is the habit it replaces.

| Do | Do not |
| :--- | :--- |
| Quote references. | Quote names and numbers in chat. |
| Look at data inside the platform. | Copy it to personal notes, phones or e-mail. |
| Delete exports when done. | Keep exports in downloads folders. |
| Share only with people who need it for the task. | Forward "for information". |
| Report accidental exposure at once. | Hide it. |

A reference is a case number or an item id. For example, in chat write the case number, not the customer's name and phone number. The colleague can open the case in the platform and see what they are allowed to see.

### Screenshots
A screenshot copies data out of our controls. Take one only when policy allows, store it only where allowed, and delete it when finished. Never include a secret, a code or AML information.

### Masking
Masked values (like `091*****78`) are masked on purpose. Do not try to reveal them.

### Never put into chat, tickets or e-mail
Passwords, one-time codes, API keys, certificate keys, card numbers, national ID numbers.

### What you do if data goes to the wrong place
Report it at once. See [[a:b10-09|how to report and recover from a mistake]] for the steps.
@@end

@@article id=b11-05 book=11 order=5 title="Conduct and insider risk: protecting yourself and the company" roles=ALL minutes=1 ui=AVAILABLE related=b00-03,b04-01,b09-10
:::summary Big picture in 20 seconds
Most staff-related losses start as small shortcuts that become habits. Follow six simple rules: never use another person's account, never approve what you cannot explain, and report any pressure to bypass a control. These rules also protect you.
:::

An **insider risk** is a risk that comes from inside the company, from staff, and not from a stranger. The rules below stop the small habits that cause the damage.

### Why it exists
Most losses involving staff are not dramatic. They are small shortcuts that become habits: approving without reading, sharing a login "to help", skipping a checklist.

### The rules that protect you
* **Do not use another person's account**, even with their permission.
* **Do not approve what you cannot explain.** See [[a:b00-03|the Ten Golden Rules]].
* **Do not ask others to approve unseen.**
* **Do not look at records out of curiosity.** Every read is logged.
* **Do not accept gifts or favours** from merchants, partners or applicants.
* **Report pressure.** If anyone pushes you to bypass a control, report it.

### Why two-person control protects you
When something goes wrong, the record shows who proposed, who approved and what they were told. A reason written well and a checklist followed protect you. Learn how in [[a:b04-06|writing a reason that survives an audit]].

### Consequences
Breaking these rules can lead to disciplinary action, and for some acts (tipping-off, theft, falsifying records) to legal action.
@@end

### BOOK 12 — DEPLOYMENT & HOSTING

@@article id=b12-01 book=12 order=1 title="Where each part runs: the one-to-five server model" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=3 ui=AVAILABLE related=b02-02,b12-02,b12-05
:::summary Big picture in 20 seconds
The platform is made of five roles: database, core, admin, merchant and checkout. Each role can have its own server or share one, but the rules about who may connect to whom never change.
:::

A **role** is one job that a server does. We have five jobs. In a large installation every job has its own machine. In a small one, one machine does several jobs. The access rules below stay the same in both cases.

### The five roles
Read the table by row. The last column tells you who is allowed to open a connection to that role. The admin, merchant and checkout hosts are called the **edge hosts** because they sit at the edge, where staff, merchants and payers connect. The core accepts connections only from the three edge hosts.

| Role | What runs there | Who may connect to it |
| :--- | :--- | :--- |
| Database host | The PostgreSQL 18 database | **Only** the core host |
| Core host | `core-back` (port 4000, mutual-TLS) | **Only** the three edge hosts |
| Admin host | `admin-back` (4101, local only) and the Back Office pages through a LAN-only web server | Office network only |
| Merchant host | `merchant-back` (4102, local only) and the merchant portal through a public web server | The public internet, encrypted |
| Checkout host | `checkout-back` (4103, local only) and the checkout through a public web server | The public internet, encrypted |

Three terms in the table:
* **Mutual TLS** means both sides of a connection prove who they are with certificates. [[a:b12-03|How the certificates work]] is explained later in this book.
* **Local only** means the service listens on its own machine and nobody else can reach that port directly.
* **LAN-only** means the web server answers only inside the office network (the local area network).

### One to five physical servers
The five roles can each have their own server, or share. The deployment tool groups roles by address: roles given the same server address run on the same server.
* **Five servers:** every role isolated.
* **Two servers:** for example core, admin and database on an internal server, and merchant and checkout on a public server.
* **One server:** all roles on one machine (for small or staging use), still with separate ports and mutual-TLS.

### Rules that never change
These rules hold on one server and on five. Each rule keeps an attacker from reaching more than they must.
* The **database host never shares an address with the core**.
* Only the core has database credentials and the master encryption key.
* The edge servers never receive database variables or the master key.
* The Back Office is never reachable from the internet and its port is never forwarded by the router.
@@end

@@article id=b12-02 book=12 order=2 title="Network protection: firewalls, LAN-only access and TLS" roles=SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b12-01,b12-03
:::summary Big picture in 20 seconds
Every server has a firewall that opens only the connections its role needs. Staff screens stay on the office network, and public portals use encrypted connections.
:::

A **firewall** is a gatekeeper on each server. It decides which network connections may come in. Anything not allowed is blocked. **SSH** is the remote login that administrators use to manage a server, so it is always open.

### Firewall rules per role
Read the table by row. "Open inbound" lists what may connect to the server from outside. "Blocked" says what is refused. A **range** is a group of addresses, for example the whole office network.

| Role | Open inbound | Blocked |
| :--- | :--- | :--- |
| Database | SSH, and the database port **only from the core's address** | everything else |
| Core | SSH, and port 4000 **only from the admin, merchant and checkout addresses** | the public internet |
| Admin | SSH, and the Back Office port **only from the office network ranges** | everything not on the LAN; port 4101 is local-only |
| Merchant | SSH, 80 and 443; 4102 is local-only | direct access to 4102 |
| Checkout | SSH, 80 and 443; 4103 is local-only | direct access to 4103 |

If several roles share a server, the rules are combined for that server. The SSH rule is always present and the firewall is enabled last, so a deployment can never lock itself out.

### TLS for the public portals
**TLS** is the encryption you see as the padlock in a browser. Public portals use encrypted connections (TLS 1.3, HSTS, strict content rules). HSTS tells browsers to always use the encrypted address.

Web servers are configured so live-update streams are not buffered. A buffer would hold data back; without one, screens that update by themselves receive each update at once. Each portal's ports and whether TLS is on come from configuration. When TLS is turned off, the operator is responsible for the certificate set-up.

### Why Back Office is LAN-only
If staff screens were on the internet, an attacker anywhere could try passwords against them. On the office network, the attacker must first get inside.
@@end

@@article id=b12-03 book=12 order=3 title="Certificates and mutual TLS: who holds which key" roles=SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b01-07,b12-02,b12-04
:::summary Big picture in 20 seconds
Our services check each other's identity cards (certificates) before they talk. Each server holds only the cards it needs, so one stolen server cannot pretend to be another.
:::

When two people meet for the first time, each can show an identity card. Our services do the same. A **certificate** is a digital identity card, and a **certificate authority** is the office that issues and signs the cards. We run our own internal authority.

### The idea
Between our own services, **both sides show an identity card** (this is mutual TLS). The core accepts a connection only if two things are true:
* the card is signed by our own internal authority, **and**
* the name on the card matches the channel. The admin service may use only the admin channel, and so on.

### The cards
The deployment tool creates an internal certificate authority and four certificates:
* the **core** certificate (valid for the core's private address, the local address and an internal name),
* a client certificate for **admin-back**, one for **merchant-back**, one for **checkout-back**.

### Least privilege
**Least privilege** means each server gets only the access it needs.
* The authority's **private key never leaves the deployment workstation**.
* The core host receives only the authority's public certificate and its own certificate and key.
* Each edge host receives only the authority's public certificate and **its own** client certificate and key.
* So a compromised checkout server cannot impersonate the admin or merchant service, and has no database access or master key.

### Rotation
To **rotate** a certificate means to replace it with a new one before the old one expires. Certificates can be rotated with a flag on the deployment tool. The tool inspects validity dates and prints expiry dates in its audit summary. Track the expiry dates.
@@end

@@article id=b12-04 book=12 order=4 title="Configuration and secrets: deploy.env, the master key and what never leaves the core" roles=SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b12-03,b11-04
:::summary Big picture in 20 seconds
One file, `deploy.env`, drives every deployment, and it is checked before any server is touched. The database connection and the master key live only on the core and are never written to an edge server.
:::

A **secret** is a value that must stay private, such as a password or a key. The deployment needs many of them. This article says where they live, how they travel and what you must never do with them.

### The configuration file
Deployment is driven by one file, `deploy.env`. It is **validated before the first server is contacted**, so a typing mistake stops the deployment early. The check covers:
* addresses, ranges, domain names, ports and database names,
* that the database address matches the engine,
* certificate paths,
* that merchant and checkout use different domains,
* that ports are distinct.

### What the core alone holds
* the database connection,
* the **master encryption key** that protects every stored secret.

Neither is ever written to an edge server.

### How secrets travel
Secrets are streamed to the server over an encrypted connection, so they never rest on the deployment workstation's disk. The shared environment file on each server is readable only by its owner.

### Rules
1. **Never commit** `deploy.env` or any key to a repository.
2. **Never paste** configuration values into chat or tickets.
3. Treat the master key as the most valuable secret: losing it makes stored secrets unreadable; leaking it exposes them.
4. A change to secrets or certificates is a **security change**: two people.
@@end

@@article id=b12-05 book=12 order=5 title="The twelve-step deployment, in plain words" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=5 ui=AVAILABLE related=b12-06,b12-07,b12-01
:::summary Big picture in 20 seconds
A deployment installs one new release in twelve fixed steps: check, build, secure, back up, switch the core, switch the outer services, then verify. If the final check fails, the old release is still on disk and you switch back by hand.
:::

A **release** is one dated version of the platform's programs. Deploying means putting a new release on the servers and starting it. The tool always runs the steps **in the same order**, so that the core and database changes are ready *before* the outer services switch over.

### The story of one release
Here is one deployment day in plain words. The step numbers match the table in the next section.

**Before anything changes (steps 1 to 4).**
* The tool reads the configuration file and prints a map: which service goes on which server. If the file is wrong, the tool stops here and no server is touched.
* It builds the three web apps (admin, merchant and checkout) on the deployment workstation.
* It makes sure the certificates exist and are valid.
* It prepares each server: it installs the software that is needed and sets the firewall rules.

**Protect the data first (step 5).** The tool checks the database. If this release carries database changes that are not yet applied, it first saves a compressed backup. That backup is the safety copy for what comes next.

**Switch the services, one tier at a time (steps 6 to 9).** The order is core, admin, merchant, checkout. For each one the tool does the same things:
1. It copies the new release into a new dated folder next to the old ones.
2. It installs what the release needs. For the core, it also applies the database changes.
3. It points the `current` link at the new folder and restarts the service.
4. It checks that the service answers.

The old release is not touched. It stays in its own folder.

**Prove it works, then tidy up (steps 10 to 12).** Each outer service makes a mutual-TLS connection to the core and must get an OK. Then the tool removes the oldest releases and prints a summary.

### What "undo" means
Undo means **going back to the previous release's programs**. Because the old folder is still there, you point the `current` link back at it, then stop and start the service from that old folder. A plain restart keeps running the new release.

What the tool does if the end-to-end check fails: it stops with an error, and the new release stays in use. The old release stays on disk, so you switch back by hand. The steps are in [[a:b12-07|the article on releases and rollback]].

Undo does **not** reverse database changes. Database changes only go forward. If a release changed the database, going back changes only the programs. The backup from step 5 is the safety copy. Restoring it is a decision for the operators, not something the tool does for you.

### The twelve steps
Read the table in order. The left column is the step number, the middle is its short name, and the right says what the tool does. The tool's own log can show up to fourteen step numbers, because it also numbers the optional Fake Rails steps and a release-count line. The end-to-end check is step 12 there. The order is the same.

| # | Step | What it does |
| :-- | :--- | :--- |
| 1 | Validate and plan | Checks the configuration and prints a map of which service goes on which server. |
| 2 | Build the three web apps | Compiles admin, merchant and checkout. |
| 3 | Ensure certificates | Creates or checks the internal authority and certificates. |
| 4 | Prepare servers | Installs required software and sets firewall rules. |
| 5 | Database check and backup | Verifies the database; if changes are pending, takes a compressed backup first. |
| 6 | Deploy the core | Copies the release, installs, migrates the database, switches to the new release and checks health. |
| 7 | Deploy admin | Same for the Back Office; LAN-only web server. |
| 8 | Deploy merchant | Same for the merchant portal; public web server. |
| 9 | Deploy checkout | Same for the checkout; public web server. |
| 10 | End-to-end check | Each edge completes a mutual-TLS handshake with the core and receives OK. A failure stops the deployment; the previous release stays on disk for a manual return. |
| 11 | Prune old releases | Keeps the most recent few (default five). |
| 12 | Audit summary | Prints the release, hosts and certificate expiry dates. |

### Useful modes
* A **dry run** prints every action without doing it. Use it first.
* `--only` deploys one tier.
* `--update` and `--fresh` choose the mode.
@@end

@@article id=b12-06 book=12 order=6 title="Test environments: sandbox and the Fake Rails service" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=1 ui=AVAILABLE related=b01-08,b06-10,b12-07
:::summary Big picture in 20 seconds
We test in two safe places: the partner's sandbox and our own Fake Rails service. Fake Rails must never run in production and never receives live credentials. No test environment may hold real customer data.
:::

Before real money moves, we need a place where mistakes cost nothing. There are two such places.

### Sandbox
Every gateway has a sandbox environment on the partner's side. A gateway is our set-up for one payment company, and the partner is that payment company. The sandbox is the partner's practice environment. It is where building and testing happen. For the difference between sandbox and live, see [[a:b06-10|Sandbox, live, rollback and what changes for new versus running payments]].

### Fake Rails
**Fake Rails** is our own internal testing service that **imitates payment companies**. It can be configured to behave badly on purpose, so we can practise and test how the platform reacts. The bad behaviours are:
* timeouts,
* wrong codes,
* duplicate or forged messages,
* conflicting answers.

The Employee Academy labs use it.

### Rules
* Fake Rails must **never run in production**. It is protected by explicit switches and allowed-host lists; a production deployment must leave them off.
* Never point live credentials at it.
* Never use real customer data in any test environment.
* Always check the **SANDBOX/LIVE** badge before acting.
@@end

@@article id=b12-07 book=12 order=7 title="Releases, rollback, backups and health checks" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=3 ui=AVAILABLE related=b12-05,b12-08,b12-09,b12-10,b12-11
:::summary Big picture in 20 seconds
Every release stays in its own folder, so going back means switching one link and starting the service from the old folder. Backups, health checks and service targets tell you whether the system is safe and really "up".
:::

This article is a map of what keeps a deployment safe: releases you can return to, backups you can restore, settings that are tracked, and checks that prove the system works.

### Releases
Each deployment creates a dated release folder. A `current` link points to the release in use. Switching is one atomic step, which means it happens all at once and there is no half-switched state. Services are restarted through a process manager.

### Rollback
A **rollback** is a return to the previous release. Because old releases remain, going back is switching the link and starting the service again from the old release folder. A plain restart keeps running the new release. If the end-to-end check fails during deployment, the deployment stops with an error and the new release stays current, so you do this by hand. The tool does not switch back by itself.

### Backups
A **backup** is a saved copy of the database that you can restore after a disaster. Before database changes, a compressed backup is saved. The rest of this section is about the **Backups** screen.
* The screen shows the engine, the schedule, the latest full and delta backups and the latest restore drill.
* `SECURITY_ADMIN` can start a backup or a drill and propose a policy change. A second person must approve the policy.
* A drill restores into an isolated scratch database and checks the ledger invariants without touching production.
* Keep backups protected like production data.

For more, read [[a:b12-09|Backups from zero]], [[a:b12-10|The Backups screen]] and [[a:b12-11|Operating backups safely]].

### Platform settings
**Platform Settings** lists every setting key with its versions and effective date. `SECURITY_ADMIN` can create or edit a setting, export a settings backup and preview a restore. Sensitive changes go through approval. Payer-facing checkout copy stays on **Checkout Help**. `merchant_reports.policy` controls whether the merchant report runner/Studio is enabled and whether merchants may attach asset bundles; the merchant AI transcript always states the current asset policy. It is explained in [[a:b07-10|the Checkout Help article]].

### Health checks
A **health check** asks a service "are you working?". The tool checks:
* the core over mutual TLS,
* each edge service's health address,
* each edge's handshake with the core on its own channel,
* each public address.

Use these results before telling anyone the system is "up".

### Targets (service objectives)
A service objective is a number we aim to meet. Read the table as "measure, then target". A synchronous rail is a payment company that gives its answer in the reply to our confirm call. For example, 95% under 4 seconds means that 95 out of every 100 confirmations finish in less than 4 seconds.

| Measure | Target |
| :--- | :--- |
| Starting payments | 99.9% available |
| Confirm to final state (synchronous rails) | 95% under 4 seconds |
| Webhook processing | 95% under 30 seconds |
| `UNKNOWN` resolved | 95% within 24 hours |
| Statements loaded | 99% within 4 hours |
| Ledger integrity | 100% (zero drift) |
@@end

@@article id=b12-08 book=12 order=8 title="The database, timers and workers in plain words" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=1 ui=AVAILABLE related=b02-07,b12-01,b07-06
:::summary Big picture in 20 seconds
One PostgreSQL database holds the money records, and only the core connects to it. Timers are stored in the database too, so a restart or a crash loses no payment's timers.
:::

A payment platform must remember two things even after a crash: the money records and the clocks that are running on payments. We keep both in the database.

### What is stored, and who may connect
* The database is **PostgreSQL 18**. Only the core connects to it.
* Money is stored as exact decimals with four places, never as approximate numbers.

### Timers and workers
A **timer** is a note that says "do this later": for example when a payment expires, or when to ask the partner again. A **worker** is a background program that does the work when a timer is due.
* **Timers live in the database.** Workers on any server pick up due items.
* A database feature lets two workers avoid taking the same item.
* This means a restart or a crash does not lose a payment's timers.
* A terminal change is applied **at most once**, even if two servers pick the same item. A terminal change moves a payment into its final state.

### Keeping all servers in step
* Configuration changes are announced to all servers so none keeps an old copy.
* The weakest guarantee of this design is time: servers must keep correct clocks. Timestamps are stored in UTC.
@@end


@@article id=b12-09 book=12 order=9 title="Backups from zero: full backups, delta backups, WAL archiving and point-in-time recovery" roles=SECURITY_ADMIN,GATEWAY_ADMIN,FINANCE minutes=6 ui=AVAILABLE related=b12-07,b12-08,b12-10,b12-11
:::summary Big picture in 20 seconds
We keep a weekly full copy, a daily delta copy and a continuous change log of the database. Together they let us restore to an exact moment and lose at most a few seconds, while archiving is healthy and the copies have been proven restorable.
:::

### What a backup is for
A **backup** is a saved copy of the database that we can use after a disaster, such as a hardware fault, a fire or a bad mistake. Using the copy to rebuild the database is called a **restore**.

A copy is **restorable** when we have really restored it and the result works: the data is complete and the books still balance. A copy that nobody has restored may be empty or damaged. That is why this article, and the weekly test restore (the restore drill), care about restorable copies and not only about copies.

### Why one copy per night is not enough
Imagine a shop that photographs its cash register once a night at 02:00. If a fire destroys the register at 18:00, every sale made since 02:00 is gone. For a payment platform the same loss would be far worse: customers have already paid at partner companies, and our books would no longer match reality. So the platform combines **three layers** that work together all the time.

### The three layers at a glance
Read the table by row. The shop analogy column shows the same idea in shop terms. WAL and LSN are explained in the next section.

| Layer | Plain meaning | Shop analogy | How often |
| :--- | :--- | :--- | :--- |
| **Full backup** | A complete, checked copy of the database. | Photographing every page of the ledger. | Weekly (default Sunday 02:00 UTC) and on demand. |
| **Delta backup** | A smaller copy holding only the parts that changed since the previous backup. | Photographing only the pages written today. | Daily (default Monday to Saturday 02:00 UTC). |
| **WAL archiving** | A continuous copy of the database's change log, the **WAL**. | A flight recorder that records every pen stroke. | Continuously. The alert threshold defaults to 300 seconds. |

### WAL and LSN in plain words
Before PostgreSQL changes any number on disk, it first writes the change into a numbered, never-rewritten log. This log is called the **WAL** (write-ahead log). Each position in the log has an address called an **LSN** (log sequence number). Every finished WAL segment is copied to the backup daemon continuously. That copying is **WAL archiving**.

The full and delta copies are the starting point. The WAL tells you everything that happened after them.

### Point-in-time recovery
**Point-in-time recovery (PITR)** means this:
1. Restore the latest full backup and its deltas.
2. Replay the archived WAL forward to an exact moment, for example one second before a mistake or a hardware fault.

The platform proves that this works by doing it every week in a **restore drill**. You can follow the drill on [[a:b12-10|the Backups screen]].

### Schedules and checks
A **cron expression** is a short schedule written as five fields. The default full backup is `0 2 * * 0`, which means 02:00 on Sunday. All schedules run in **UTC**. A backup is checked with `pg_verifybackup` before it is encrypted and stored.

### How little can be lost
WAL reaches the daemon in two independent ways:
* The database pushes each completed WAL segment to the backup daemon over mutual TLS, using a dedicated **WAL-archive certificate** that can do nothing else.
* The daemon also streams WAL continuously with `pg_receivewal`.

Because of this, a disaster loses at most a few seconds of changes, not the time since the last nightly copy. This is only true while the **WAL archive lag** tile is healthy. You can see that tile on [[a:b12-10|the Backups screen]].

### What is backed up
* The **core database** (all money, ledger, approvals and configuration).
* The **audit database**. It may live inside the same PostgreSQL cluster as the core database. Then it is protected by the core physical backup plus a separate logical dump. Or it may run in its own dedicated cluster, which is then backed up on its own.
* **Redis** can also be chosen as a backup target on the **Backups** screen.

### Where the daemon runs
The **backup daemon** is a separate service that makes and stores the copies and runs the restore drills. Its engine is chosen at deployment. Read the table by row.

| Engine | What it is | Where it runs |
| :--- | :--- | :--- |
| `pg-native` | The new built-in engine. It needs no external backup tool and is the default-capable choice. | On the same host as the primary database, or on a dedicated backup host that talks to the primary over the PostgreSQL replication protocol. |
| `wal-g` | An external backup tool. | On the same host as the primary. |
| `barman` | An external backup tool. | On a separate host. |

A dedicated backup host has one more benefit: restore drills use that host's own processor and disk, so production payments are not slowed down.

### How the copies are protected
* Every artifact is compressed (`zstd`) and encrypted with **AES-256-GCM** before it is stored. Without the backup encryption key the copies cannot be read. So the Security Admin must keep the key safe, and it must also be recoverable separately from the servers it protects.
* Copies are stored in up to **three tiers**: a **local repository** on the daemon host, an **S3 or MinIO bucket**, and an optional **off-site vault** reached over SSH or rclone.
* The off-site vault **never deletes by default**, so an attacker who controls the daemon cannot erase the off-site history.

:::warning A copy nobody has restored is only a hope
A backup that has never been restored might be empty, corrupt or missing the newest data. That is why the weekly restore drill exists. Never assume backups work because the **Last backup** tile is green.
:::
@@end

@@article id=b12-10 book=12 order=10 title="The Backups screen: every tile, target, LSN and restore drill check" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=6 ui=AVAILABLE related=b12-09,b12-11,b08-11,b10-05
:::summary Big picture in 20 seconds
The Backups screen shows whether copies of the database are being made and whether a restore drill has proved they work. A failed drill check is a priority-1 incident.
:::

### What this screen is for
The screen answers two questions. First: are backup copies being made and stored now? The tiles and cards answer this. Second: could we really restore them? The **restore drill** answers this. A copy is **restorable** when a drill has restored it and the checks passed. If you are new to backups, read [[a:b12-09|backups from zero]] first for the words WAL and LSN.

### Opening the screen
Open **Operations**, then **Backups**. The page title is **Backup management**, with the badge **Disaster recovery**. The menu entry appears for staff with `security:read` or `gateway:read`.

The action buttons **Run backup now**, **Run restore drill** and **Edit policy** appear only for staff with `security:write` (the Security Admin). **Refresh** reloads the screen for everyone.

Two banners can appear above the tiles:
* **Backup management is not configured for this environment.** The platform has no backup daemon set up here.
* **The backup daemon is unreachable. Backup and drill actions are disabled until connectivity returns.** The three action buttons are greyed out. See [[s:s-backup-daemon-unreachable|The Backups screen says the backup daemon is unreachable]].

### The five summary tiles
Read the table by row: the tile name, what it shows, and how its status is decided.

| Tile | What it shows | How to read it |
| :--- | :--- | :--- |
| **WAL archive lag** | Seconds since the newest change was safely archived, and the **Alert threshold**. | **Healthy** up to the threshold (default 300 s). **Attention** above it. **Critical** above twice the threshold. See [[s:s-wal-archive-lag-high]]. |
| **Daemon status** | **Reachable** or **Unreachable**: whether the core can talk to the backup daemon over mutual TLS. | **Healthy** or **Failed** badge. |
| **Storage targets** | Healthy targets over total targets, for example `3/3`. | **Healthy** only when every target is healthy, otherwise **Attention**. |
| **Last backup** | Time of the newest backup and its status. | **Passed**, **Running**, **Queued** or **Failed**; **No backups yet** on a new system. |
| **Latest restore drill** | Time of the newest drill and its result. | **Drill passed**, **Drill failed**, **Pending**; **No restore drill yet** before the first one. |

### The cards below the tiles
Most cards give the detail behind a tile. The last two show the schedule and the backup list.

**WAL archive lag**
* Fields: **Archive lag**, **Current LSN**, **Last archived LSN**, **Lag bytes** and **Alert threshold**.
* **Current LSN** is where the database is writing now. **Last archived LSN** is the newest position safely archived. **Lag bytes** is how much is waiting.
* When archiving keeps up, the two LSNs are close together and **Lag bytes** is small.

**Daemon status**
* **Reachable** or **Unreachable**, **Generated at**, **Engine mode** (`pg-native`, `wal-g` or `barman`), **Configured** and **Overall health**.

**Storage targets**
* One row per target with a **Healthy** or **Failed** badge, its kind and a detail line.

**Backup schedule**
* **Full cron**, **Delta cron**, **Drill cron**, **Full retention days**, **WAL retention days** and **Alert lag threshold**.
* Changing these needs two people. See [[a:b12-11|how to operate backups safely]].

**Latest restore drill**
* The result, the drill id, **Started**, **Target time**, **Replayed LSN**, **Duration**, **Journal lines** and three check badges.

**Scheduled backups**
* A table with **Backup ID**, **Target**, **Kind**, **Engine**, **Status**, **Started**, **Completed**, **Duration**, **Size** and **Error**.

### What a restore drill does
A backup that has never been restored is only a wish. A drill proves recovery works, without touching production. It has four stages:
1. The daemon restores the latest backup chain into an **isolated scratch cluster**. This is a temporary database server used only for the test. It runs on the loopback address (port 55432). Archiving is switched off in that cluster, so it can never write into the real archive.
2. It replays the archived WAL up to a **target time** (default: now minus 5 minutes) and waits until recovery has finished.
3. It runs exactly **three invariant checks** (below).
4. It signs the report with HMAC-SHA256 and **destroys the scratch cluster**, so no customer data is left behind.

Drills run every week by default (Sunday 04:00 UTC) and on demand.

### The three invariant checks
An invariant is something that must always be true. Read the table by row. Each check looks at the restored copy.

| Badge | Plain meaning | If it fails |
| :--- | :--- | :--- |
| **Double-entry zero drift** | In the restored database, total debits equal total credits (drift `0.0000`). | The restored ledger does not balance. Priority 1. |
| **Sharded balance parity** | Every shard of every account adds up to its own journal lines, its checkpoint agrees with those lines, and the numbering of its postings has no gaps. | Some account balance disagrees with the journal. Priority 1. |
| **Audit hash chain** | Every audit record is present, in an unbroken sequence with no gaps, and each record's fingerprint still matches the one before it. | An audit row was changed, damaged or removed. Priority 1. |

### What the drill result means for you
Each badge reads `<check>: Passed`, `<check>: Failed` or `<check>: Pending`. **Any failed check is a priority-1 incident**. See [[s:s-restore-drill-failed|A restore drill failed]] for what to do.

A drill can also end as **Drill failed** with a red error text and no failed check. This happens, for example, when the backup could not be fetched or the scratch cluster could not start. It means we currently have no proof that recovery works.

The double-entry check is also run on live data on the **Ledger Audit & Invariant** screen under **Finance**. See [[a:b08-11|Profitability, liquidity and the invariant screens]] and [[a:b10-05|RB-04 Reconciliation or ledger drift]]. The drill adds the same proof for the restored copy, plus parity and the audit chain.

:::note Reading a drill result
The drill checks a restored copy. A failure can mean the copy is damaged or that production already has the problem. Always compare with the live invariant screen before deciding which.
:::
@@end

@@article id=b12-11 book=12 order=11 title="Operating backups safely: manual runs, restore drills and two-person policy changes" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=3 ui=AVAILABLE related=b12-09,b12-10,b04-03,b12-07
:::summary Big picture in 20 seconds
Security Admins can start a backup or a restore drill when the daemon is reachable. Changing the backup policy needs two different people, so one stolen account cannot weaken the backups.
:::

This article is for the person who uses the Backups screen to act, not only to look. It says who may do what, what each action does and what the screen will never do.

### Who may do what
* View the screen: `security:read` or `gateway:read`.
* **Run backup now**, **Run restore drill**, **Edit policy**: `security:write` (Security Admin). Authorities are checked by the core; the screen only hides the buttons.
* The actions are disabled while the **Daemon status** is **Unreachable** or the system is not configured.

### One job at a time
The daemon runs only **one backup or drill job at a time**. If you request another while one is running, it is **queued** and runs in order. Every request carries an **Idempotency-Key**. This is a unique label for the request. A repeated click or a retry of the same request is therefore not run twice.

### Run backup now
Use it before risky work, such as:
* a major configuration or routing change,
* server maintenance,
* a firewall or operating-system change,
* a certificate rotation.

The form asks for two choices:
* a **Backup target**: **All targets**, **PostgreSQL core**, **Audit database** or **Redis**,
* a **Backup kind**: **Full** or **Delta**.

**All targets** with **Full** asks for an extra confirmation because it reads every database and can load production. The backup runs in the background. Watch the **Scheduled backups** table go from **Queued** to **Running** to **Passed**. Checklist: [[c:sg-trigger-backup|Run a backup now]].

### Run restore drill
A restore drill rehearses a recovery in a scratch copy. The button asks you to confirm, then queues a drill. What the drill does is explained in [[a:b12-10|the Backups screen article]]. It can take several minutes. Run one after any change to the backup setup, and whenever you need fresh proof. Checklist: [[c:sg-run-restore-drill|Run a restore drill]].

### Changing the policy needs two people
The **policy** is the backup schedule and retention settings. An attacker who takes over one administrator account may try to **weaken the backups**, for example by cutting retention so old copies disappear before anyone notices. So **Edit policy** never changes anything on its own. Two roles take part: the maker asks for the change and the checker approves it.
1. **Maker (Security Admin #1)** edits the form. All six fields are required: three five-field UTC cron expressions (**Full cron**, **Delta cron**, **Drill cron**), **Full retention days** (1 to 3650), **WAL retention days** (1 to 3650) and **Alert lag threshold** in seconds (1 to 86400). **Save Changes** creates a `BACKUP_POLICY` approval request in `PENDING_REVIEW` and shows its id.
2. **Checker (a different Security Admin, `security:write`)** reviews it on the **Approvals** screen. Approving applies the new policy to the daemon and writes a `BACKUP_POLICY_UPDATED` audit record. The maker can never approve their own request. Unapproved requests expire after 7 days.

For the approval screen, read [[a:b04-03|the life of an approval request]]. Checklist: [[c:sg-update-backup-policy|Change the backup schedule or retention]].

:::note What this screen does not do
There is no **restore production** button. The screen takes backups and rehearses recovery in a scratch cluster. A real recovery is a deliberate, planned procedure carried out by the people who run the servers, using the same backup chain and WAL that the drill has proved. Rehearse it; do not improvise it.
:::
@@end


### BOOK 13 — REFERENCE

@@article id=b13-01 book=13 order=1 title="Codes and messages you may meet, and what they mean" roles=ALL minutes=3 ui=PARTIAL related=b13-02,b06-08,b03-07
This table lists codes that appear in the platform's documentation. If you meet a code that is not here, copy it exactly, do not guess, and ask your manager.

| Code | Where you meet it | What it means | What to do |
| :--- | :--- | :--- | :--- |
| `UNKNOWN` | A payment status | We do not know whether money moved. | [[a:b07-03]] |
| `LIMIT_EXCEEDED` | Error classification | A customer or merchant limit was reached. | Explain the limit; do not retry in a loop. |
| `RETRYABLE_OTP` | Error classification | The customer typed a wrong code and may try again. | Nothing; three tries by default. |
| `TERMINAL_DECLINE` | Error classification | A final refusal by the partner. | Nothing; the payment failed. |
| `GATEWAY_FAULT` | Error classification | The partner is broken. Counts toward the circuit breaker. | [[a:b10-02]] |
| `AMBIGUOUS` | Error classification | We cannot tell what happened. Treated as `UNKNOWN` on money steps. | [[a:b07-03]] |
| `INSUFFICIENT_FUNDS` | Customer-facing reason | The customer's account did not have enough. | Tell the customer to use another method. |
| `LINK_NOT_AVAILABLE` | Starting a payment | The link expired, was cancelled or has no free slot. | Merchant creates a new link, or wait if a payment is in progress. |
| `VALIDATION_FAILED` | Back Office or portal request | The request shape was wrong (for example a field name). | Report with the screen; do not retry blindly. |
| `SCHEMA_INVALID` | AI import check | The spec file has the wrong shape. | Use the repair message ([[a:b06-14]]). |
| `STEP_TYPE_NOT_IMPORTABLE` | AI import check | A step type must be added in the wizard instead. | [[a:b06-14]] |
| `INVALID_ATTEMPT_TRANSITION` | Engine log | An event tried an illegal state change. | Report to Engineering. |
| `FORBIDDEN_SERVICE_IDENTITY` | Core log | A service used the wrong certificate or channel. | Security Admin. |
| `403` | Any screen | The core refused: role, authority or the two-person rule. | [[a:b03-07]] |
| `401` | Any screen | Not signed in or session ended. | Sign in again. |
| `409` | Partner answer | A conflict (for example the same request body changed). | Gateway Admin. |
| `422` | Partner answer | The partner rejected the data (for example a duplicate reference). | Gateway Admin. |
| `429` | Partner answer | Too many requests too quickly. | Do not retry in a loop. |
| `500` | Any answer | The other side broke. On a money step this becomes `UNKNOWN`. | [[a:b07-03]] |
@@end

@@article id=b13-02 book=13 order=2 title="Every status in one place" roles=ALL minutes=2 ui=AVAILABLE related=b07-02,b05-01,b13-01
| Object | Values |
| :--- | :--- |
| Payment attempt (14) | `CREATED`, `INITIATING`, `AWAITING_CUSTOMER`, `AUTHORIZING`, `VERIFYING`, `UNKNOWN`, `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED` |
| Canonical status from a partner (5) | `AWAITING_CUSTOMER`, `VERIFYING`, `SUCCEEDED`, `FAILED`, `UNKNOWN` |
| Payment link | `PENDING`, `COMPLETED`, `EXPIRED`, `CANCELLED` |
| Merchant | `PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED`, `CLOSED` |
| Merchant KYB | `UNVERIFIED`, `PENDING`, `VERIFIED`, `REJECTED` |
| Risk tier | `LOW`, `STANDARD`, `HIGH` |
| Join request | `DRAFT`, `SUBMITTED`, `IN_REVIEW`, `INFO_REQUESTED`, `PENDING_CHECKER`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `EXPIRED` |
| KYB document | `UPLOADED`, `ACCEPTED`, `REJECTED`, `EXPIRED` |
| Owner screening | `NOT_SCREENED`, `CLEAR`, `POTENTIAL_MATCH`, `CONFIRMED_MATCH` |
| Approval request | `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `EXECUTED`, `REJECTED` |
| Adjustment | `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `EXECUTING`, `EXECUTED`, `REJECTED` |
| Cash-out | `PENDING`, `PROCESSING`, `COMPLETE`, `SUBTRACTED`, `REJECTED` |
| Dispute | `OPENED`, `EVIDENCE_REQUESTED`, `EVIDENCE_SUBMITTED`, `WON`, `LOST`, `EXPIRED`, `WITHDRAWN` |
| Operator case | `OPEN`, `IN_PROGRESS`, `PENDING_CHECKER`, `RESOLVED` |
| Operator case kind | `UNKNOWN`, `HELD`, `CONFLICT`, `MISMATCH`, `LATE_SUCCESS`, `MANUAL_REVIEW`, `UNMATCHED_STATEMENT` |
| AML case | `OPEN`, `IN_REVIEW`, `PENDING_CHECKER`, `RELEASED`, `REJECTED_VOID`, `FROZEN`, `ESCALATED_STR` |
| Screening result | `CLEAR`, `POTENTIAL_MATCH`, `CONFIRMED_MATCH`, `ERROR` |
| Match disposition | `UNREVIEWED`, `FALSE_POSITIVE`, `TRUE_MATCH`, `ESCALATED` |
| Regulatory report | `DRAFT`, `PENDING_CHECKER`, `APPROVED`, `SUBMITTED`, `ACKNOWLEDGED`, `REJECTED_BY_AUTHORITY` |
| Gateway | `DRAFT`, `SANDBOX_VERIFIED`, `PENDING_APPROVAL`, `LIVE`, `SUSPENDED`, `RETIRED` |
| Gateway version | `DRAFT`, `SANDBOX_VERIFIED`, `PENDING_APPROVAL`, `LIVE`, `SUPERSEDED`, `ROLLED_BACK` |
| Route status | `ACTIVE`, `PAUSED`, `DRAINING` |
| Route health | `HEALTHY`, `DEGRADED`, `OPEN_BREAKER` |
| Credential set | `UNTESTED`, `VERIFIED`, `FAILING`, `REVOKED` |
| Reconciliation line | `MATCHED`, `AMOUNT_MISMATCH`, `MISSING_AT_GATEWAY`, `MISSING_LOCALLY`, `DUPLICATE` |
| Notification | `QUEUED`, `SENT`, `DELIVERED`, `FAILED`, `SUPPRESSED` |
@@end

@@article id=b13-03 book=13 order=3 title="Roles at a glance" roles=ALL minutes=1 ui=AVAILABLE related=b03-02,b04-05
| Role | Can propose (maker) | Can decide (checker) | Sees AML data | Moves money |
| :--- | :---: | :---: | :---: | :---: |
| `GATEWAY_ADMIN` | yes | no | no | no |
| `SECURITY_ADMIN` | yes | yes | audit only | no |
| `FINANCE` | yes | yes | no | yes (with two people) |
| `OPERATOR` | yes | no | no | no |
| `COMPLIANCE` | yes | no | yes | proposes holds and releases |
| `MLRO` | yes | yes | yes | approves holds and releases |
| `SUPPORT` | no | no | no | no |

This is the *typical* pattern. Your account's own maker and checker switches and authorities decide what you can really do ([[a:b03-02|Your account]]). Merchant-side roles are `MERCHANT_ADMIN`, `MERCHANT_STAFF` and `MERCHANT_CASHIER`.
@@end

@@article id=b13-04 book=13 order=4 title="About this guide: version, updates and the Academy" roles=ALL minutes=1 ui=AVAILABLE related=b00-02,b00-01
* Every build of the guide has a **content version**. Your reading progress records the version you read, so a major change can ask you to read again.
* The guide explains **rules, not records**. It contains no live data, no real thresholds, no names and no secrets.
* If the guide and the screen disagree, **stop and ask**; use **Report a problem** on the article.
* Some features exist in the design but have no screen yet. Those articles show a banner. See [[a:b03-08|Features that are only partially available]].
* The **Employee Academy** teaches the same material as lessons, practice labs and exams. Your progress is shared between the Guide and the Academy.
* The Merchant Guide and the Checkout Help are separate documents for other audiences.
@@end

@@article id=b13-05 book=13 order=5 title="Numbers and time limits to remember" roles=ALL minutes=2 ui=AVAILABLE related=b06-16,b07-06
| What | Value |
| :--- | :--- |
| Decimal places for money in the books | 4 (LYD shown with 3) |
| Wrong OTP tries (default) | 3 |
| OTP payment time ceiling | 20 minutes |
| Redirect payment ceiling | 30 minutes |
| QR and push ceiling | 15 minutes |
| Late-confirmation grace (default) | 24 hours |
| Webhook timestamp tolerance | 5 minutes |
| Webhook duplicate memory | 7 days |
| Approval request lifetime | 7 days |
| Emergency suspension ratification | 24 hours |
| Join request inactive expiry | 30 days |
| Join review deadline | 2 business days (`LOW`/`STANDARD`), 5 (`HIGH`) |
| Beneficial owner threshold (default) | 25% |
| AML case deadlines (default) | `CRITICAL` 4 h, `HIGH` 1 day, `MEDIUM` 3 days, `LOW` 5 days |
| POS screen idle limit | 15 minutes |
| Outbound call limits | 10 s (auth, status), 15 s (start, confirm, refund) |
| Maximum response size | 2 MB |
| Retention (default) | 5 years after the relationship ends |
| KYB refresh | `HIGH` yearly, `STANDARD` 2 years, `LOW` 3 years |
| Document expiry notices | 30 and 7 days before |
| Go-live gates | 12 |
| Automatic sandbox scenarios | 15 |
| Database tables | 64 |
| Edge cases catalogued | 140 |
@@end


## III-B. Glossary

@@term slug=payment term="Payment" aliases="transaction" ar="دفعة" related=attempt :: A change of numbers that a trusted record-keeper agrees to: money leaves the payer's account and arrives in the receiver's.
@@term slug=payer term="Payer" aliases="customer;end client;buyer" ar="الدافع" related=merchant :: The person who pays. Anonymous on our platform; they never sign in.
@@term slug=merchant term="Merchant" aliases="business;shop" ar="التاجر" related=application,wallet :: A business that we checked and allowed to take payments.
@@term slug=application term="Application" aliases="app" ar="التطبيق" related=wallet,payment-link :: One place where a merchant takes payments (a website, an app, a branch). Linked to exactly one wallet.
@@term slug=wallet term="Wallet" aliases="merchant wallet" ar="المحفظة" related=ledger :: A merchant's balance on our books. A number we owe the merchant, calculated from the ledger, not a bank account.
@@term slug=payment-link term="Payment link" aliases="link" ar="رابط الدفع" related=slot,fee-bearer :: A request to pay one fixed amount, with a secret key. Single-use or multi-use.
@@term slug=pos term="POS" aliases="point of sale;terminal" ar="نقطة البيع" related=payment-link :: The in-shop counter. A terminal is the place; a screen is a display paired to it.
@@term slug=access-token term="Access token" aliases="API key;token;pg_live" ar="رمز الوصول" related=secret :: A secret string (starting `pg_live_`) that lets a merchant's software create links. Shown once.
@@term slug=lyd term="LYD" aliases="Libyan dinar;dinar" ar="الدينار الليبي" related=dirham :: The Libyan dinar. 1 LYD = 1000 dirhams, so amounts have three decimals.
@@term slug=dirham term="Dirham" aliases="dirhams" ar="درهم" related=lyd,scale :: One thousandth of a dinar.
@@term slug=scale term="Amount scale" aliases="scale;minor units" ar="مقياس المبلغ" related=dirham,rounding :: The multiplier used to write an amount for a partner (1, 100 or 1000). A wrong scale makes an amount 1000 times wrong.
@@term slug=rounding term="Rounding" aliases="round" ar="التقريب" related=scale :: Cutting extra decimals: nearest, up, down, or none.
@@term slug=commission term="Commission" aliases="platform commission;fee" ar="العمولة" related=fee-bearer,gateway-fee :: What we charge the merchant. Our revenue.
@@term slug=gateway-fee term="Gateway fee" aliases="provider fee" ar="رسوم البوابة" related=commission :: What the payment company charges us. Our cost.
@@term slug=fee-bearer term="Fee bearer" aliases="who pays the fee" ar="متحمل الرسوم" related=commission :: Who effectively pays our commission: the merchant absorbs it, the payer pays a surcharge, or it is split.
@@term slug=net-revenue term="Net revenue" aliases="net" ar="صافي الإيراد" related=commission,gateway-fee :: Commission minus gateway fee.
@@term slug=gateway term="Gateway" aliases="payment gateway;door" ar="البوابة" related=rail,route,credential-set :: One technical door to one payment company: its addresses, login, steps and how to read its answers.
@@term slug=switch term="Switch" aliases="national switch" ar="شبكة الدفع" related=gateway :: A shared network that connects many banks and wallets. In Libya, Moamalat runs the national card switch.
@@term slug=aggregator term="Aggregator" aliases="payment aggregator" ar="المجمّع" related=gateway :: A company offering one door to many payment methods. One more company in the money path.
@@term slug=rail term="Rail" aliases="payment method;channel" ar="وسيلة الدفع" related=route,collection-mode :: What the customer sees and picks (for example Sadad). Has a form, limits and logo.
@@term slug=route term="Route" aliases="rail route" ar="المسار" related=rail,gateway :: The link between a rail and a gateway through a credential policy, with priority, cost, limits and health.
@@term slug=credential-set term="Credential set" aliases="credentials" ar="مجموعة بيانات الاعتماد" related=secret,settlement-target :: The secret identifiers for one gateway in one environment, owned by the platform or by a merchant.
@@term slug=settlement-target term="Settlement target" aliases="settlement" ar="وجهة التسوية" related=clearing :: Where the money lands: platform clearing, merchant direct, or provider held.
@@term slug=collection-mode term="Collection mode" aliases="mode" ar="نمط التحصيل" related=otp,redirect,hybrid :: How the customer completes a payment: OTP, redirect, embedded, push, QR, pay code, deep link, manual, or hybrid.
@@term slug=otp term="OTP" aliases="one-time password;one-time code;code" ar="رمز لمرة واحدة" related=mfa :: A code valid once for a short time, usually sent by SMS.
@@term slug=redirect term="Redirect" aliases="hosted page" ar="إعادة التوجيه" related=collection-mode :: Sending the customer to the payment company's own page and back.
@@term slug=hybrid term="Hybrid" aliases="HYBRID" ar="مختلط" related=collection-mode :: A rail that offers several collection modes at once.
@@term slug=qr term="QR code" aliases="QR" ar="رمز الاستجابة السريعة" related=collection-mode :: A square code scanned by a bank or wallet app to start a payment.
@@term slug=push-approval term="Push approval" aliases="PUSH_APPROVAL" ar="الموافقة عبر الإشعار" related=collection-mode :: The customer taps Approve in their wallet app.
@@term slug=api term="API" aliases="interface" ar="واجهة برمجية" related=request :: The menu and rules for asking a computer system to do things.
@@term slug=request term="Request and response" aliases="request;response" ar="طلب واستجابة" related=api :: A message sent and the answer received.
@@term slug=server term="Server" aliases="back" ar="الخادم" related=api :: A computer that waits for requests and answers them.
@@term slug=webhook term="Webhook" aliases="callback;notification call" ar="ويب هوك" related=inbox,signature :: A payment company phoning us to say something happened.
@@term slug=inbox term="Webhook inbox" aliases="inbound events;inbox" ar="صندوق الوارد" related=webhook :: Where every incoming message is stored first, exactly as received, and never deleted.
@@term slug=polling term="Polling" aliases="poll" ar="الاستعلام الدوري" related=inquiry :: Asking again and again whether something is ready.
@@term slug=inquiry term="Inquiry" aliases="inquire;status check;status question" ar="استعلام" related=polling :: One read-only question to a partner about one payment. The safest way to learn the truth.
@@term slug=idempotency term="Idempotency" aliases="idempotent;idempotency key" ar="عدم التكرار" related=retry :: A request is idempotent if sending it twice has the effect of once.
@@term slug=retry term="Retry" aliases="retries" ar="إعادة المحاولة" related=idempotency :: Repeating a request. Forbidden for money steps.
@@term slug=timeout term="Timeout" aliases="silence" ar="انتهاء المهلة" related=unknown :: No answer within the time limit. On a money step it makes a payment unknown.
@@term slug=json term="JSON" aliases="" ar="جيسون" related=selector :: A text format for data, like `{"amount":"10.50"}`.
@@term slug=selector term="Selector" aliases="dot path" ar="المحدد" related=json :: A path such as `result.transaction_id` that picks one value out of an answer.
@@term slug=sandbox term="Sandbox" aliases="SANDBOX;test environment" ar="بيئة تجريبية" related=live :: A practice world where nothing real moves.
@@term slug=live term="Live" aliases="LIVE;production" ar="البيئة الحية" related=sandbox :: The real world: real money, real customers.
@@term slug=fake-rails term="Fake Rails" aliases="fake rails service" ar="" related=sandbox :: Our internal service that imitates payment companies for drills. Never in production.
@@term slug=attempt term="Payment attempt" aliases="attempt" ar="محاولة دفع" related=payment-state,reference :: One try to pay a link, with its own state, references and pinned configuration.
@@term slug=payment-state term="Payment state" aliases="status;state" ar="حالة الدفع" related=attempt :: One of 14 states of an attempt (for example `UNKNOWN`, `SUCCEEDED`).
@@term slug=unknown term="UNKNOWN" aliases="unknown state" ar="غير معروف" related=inquiry,slot :: We do not know whether money moved. Never guess; use Inquire.
@@term slug=reference term="Reference" aliases="payment reference" ar="المرجع" related=attempt :: Our unique number for a payment. Quote it, never the customer's name.
@@term slug=slot term="Slot reservation" aliases="slot;active locked count" ar="حجز الخانة" related=payment-link :: A reservation on a link taken before a payment starts, so one invoice cannot be paid twice.
@@term slug=pinned term="Pinned configuration" aliases="pinned" ar="الإعدادات المثبتة" related=gateway-version :: The version of settings an attempt started with. Later edits do not change it.
@@term slug=expiry term="Expiry" aliases="expires at;time limit" ar="انتهاء الصلاحية" related=grace :: When a payment stops waiting. The smaller of the partner's and the platform's limit.
@@term slug=grace term="Grace window" aliases="grace period" ar="فترة السماح" related=late-success :: Time after expiry in which a late confirmation is still accepted.
@@term slug=late-success term="Late success" aliases="LATE_SUCCESS" ar="نجاح متأخر" related=grace :: A confirmation arriving after the payment expired or failed.
@@term slug=money-step term="Money step" aliases="MOVES_MONEY;submit;confirm" ar="خطوة نقل الأموال" related=retry :: The step that completes a payment. Never retried automatically.
@@term slug=hint term="Hint" aliases="hints" ar="تلميح" related=trusted-confirmation :: A browser or return-address message that makes us ask the partner; it never proves payment.
@@term slug=trusted-confirmation term="Trusted confirmation" aliases="verified" ar="تأكيد موثوق" related=hint :: Success checked by our server on five facts: status, reference, amount, currency and environment.
@@term slug=canonical-status term="Canonical status" aliases="canonical" ar="الحالة الموحدة" related=status-rule :: Our standard five-word vocabulary for a partner's answers.
@@term slug=status-rule term="Status rule" aliases="status rules" ar="قاعدة الحالة" related=canonical-status :: Maps a partner answer to a canonical status. First match wins.
@@term slug=error-map term="Error map" aliases="error mapping" ar="خريطة الأخطاء" related=circuit-breaker :: Gives a partner's error code a classification and customer message.
@@term slug=circuit-breaker term="Circuit breaker" aliases="breaker;OPEN_BREAKER" ar="قاطع الدائرة" related=route :: Automatically hides a failing route and moves traffic to the next one.
@@term slug=operator-case term="Operator case" aliases="case" ar="حالة تشغيلية" related=unknown :: A task created by the system when a payment or statement needs a human.
@@term slug=flow term="Flow" aliases="recipe" ar="التدفق" related=phase,step :: The recipe for one phase of a gateway: an ordered list of steps.
@@term slug=phase term="Phase" aliases="phases" ar="المرحلة" related=flow :: One of ten parts of a gateway recipe, such as INITIATE, SUBMIT or VERIFY.
@@term slug=step term="Step" aliases="flow step" ar="خطوة" related=flow :: One action inside a phase: call a web address, compute a value, render something.
@@term slug=transform term="Transform" aliases="TransformPipe;pipeline" ar="التحويل" related=scale :: A small safe operation applied to a value, from a closed library.
@@term slug=normaliser term="Normaliser" aliases="normalizer;normaliser" ar="المُطبِّع" related=rail-field :: Cleans what a customer types (for example Arabic digits) before checking it.
@@term slug=rail-field term="Rail field" aliases="field" ar="حقل" related=rail :: One input of a rail's customer form.
@@term slug=sensitivity term="Sensitivity" aliases="PAN;sensitive field" ar="الحساسية" related=rail-field :: How carefully a field is treated: normal, sensitive or full card number.
@@term slug=pan term="PAN" aliases="card number" ar="رقم البطاقة" related=sensitivity :: The full card number. Kept in memory only for one call.
@@term slug=crypto-profile term="Crypto profile" aliases="signing profile" ar="ملف التشفير" related=signature :: A recipe for signing or checking messages.
@@term slug=signature term="Signature" aliases="HMAC;seal" ar="التوقيع" related=crypto-profile,secret :: A seal proving a message came from someone who knows a shared secret and was not changed.
@@term slug=hash term="Hash" aliases="fingerprint" ar="البصمة" related=signature :: A fingerprint of data: same data, same fingerprint; cannot be reversed.
@@term slug=encryption term="Encryption" aliases="encrypt" ar="التشفير" related=secret :: Locking data so only someone with the key can read it.
@@term slug=secret term="Secret" aliases="API key;password;credential" ar="سر" related=encryption :: Anything that proves identity: passwords, keys, tokens, certificate keys. Write-only on this platform.
@@term slug=write-only term="Write-only" aliases="" ar="للكتابة فقط" related=secret :: A secret you can replace but never read back.
@@term slug=mtls term="mTLS" aliases="mutual TLS" ar="التحقق المتبادل" related=certificate :: Both sides show a digital ID card. Used between our own services.
@@term slug=certificate term="Certificate" aliases="cert" ar="شهادة رقمية" related=mtls :: A digital ID card issued by an authority we trust.
@@term slug=rotation term="Rotation" aliases="key rotation" ar="تدوير المفاتيح" related=secret :: Changing a secret on schedule or after a leak, with an overlap period.
@@term slug=ssrf term="SSRF" aliases="server-side request forgery" ar="" related=safeguard :: An attack that makes our server call addresses it should not. Blocked by the engine.
@@term slug=safeguard term="Safeguard" aliases="engineering safeguard" ar="ضمانة" related=ssrf :: One of the engine protections against mistakes and attacks.
@@term slug=gateway-version term="Gateway version" aliases="version" ar="إصدار البوابة" related=gateway :: An immutable snapshot of a gateway's configuration.
@@term slug=go-live-gates term="Go-live gates" aliases="gates" ar="بوابات الإطلاق" related=gateway-version :: The twelve checks every version must pass before going live.
@@term slug=rollback term="Rollback" aliases="rollback version" ar="التراجع" related=gateway-version :: Returning to an earlier version.
@@term slug=canary term="Canary" aliases="canary plan" ar="الإطلاق التجريبي" related=gateway-version :: Starting a new version with a small share of traffic.
@@term slug=evidence-level term="Evidence level" aliases="verified;unverified" ar="مستوى الإثبات" related=gateway :: How well a gateway's behaviour is known.
@@term slug=visible-rails term="Visible rails" aliases="visible rails formula" ar="الوسائل الظاهرة" related=rail :: The rule deciding which payment methods a customer sees.
@@term slug=maker term="Maker" aliases="proposer" ar="المُنشئ" related=checker :: The person who proposes a sensitive change.
@@term slug=checker term="Checker" aliases="approver" ar="المُراجِع" related=maker :: The different person who decides it.
@@term slug=four-eyes term="Four-eyes principle" aliases="maker-checker;two-person rule;maker checker" ar="مبدأ العينين" related=maker,checker :: One proposes, another decides. Never the same person.
@@term slug=approval term="Approval request" aliases="approval" ar="طلب موافقة" related=four-eyes :: The record of a proposed change, its reason, its diff and its decision.
@@term slug=diff term="Diff" aliases="difference" ar="الفرق" related=approval :: What would change, old value to new value.
@@term slug=sensitive-field term="Sensitive field" aliases="sensitive" ar="حقل حساس" related=descriptive-field :: A field whose change needs two people.
@@term slug=descriptive-field term="Descriptive field" aliases="descriptive" ar="حقل وصفي" related=sensitive-field :: A harmless field edited directly and logged.
@@term slug=ratification term="Ratification" aliases="ratify;emergency ratification" ar="المصادقة اللاحقة" related=asymmetry :: Second-person confirmation, within 24 hours, of an emergency action.
@@term slug=asymmetry term="Asymmetry principle" aliases="" ar="مبدأ عدم التماثل" related=ratification :: Risk-reducing actions may be immediate; risk-increasing or money-moving ones need approval first.
@@term slug=authority term="Authority" aliases="permission" ar="الصلاحية" related=role :: A specific permission on an account. No authorities means no access.
@@term slug=role term="Role" aliases="staff role" ar="الدور" related=authority :: A job family, such as FINANCE or OPERATOR.
@@term slug=audit-log term="Audit log" aliases="audit trail" ar="سجل التدقيق" related=change-log :: The unchangeable record of who did what, when.
@@term slug=change-log term="Detail change log" aliases="field history" ar="سجل التغييرات" related=audit-log :: Old and new value of every changed field.
@@term slug=ledger term="Ledger" aliases="books;general ledger" ar="دفتر الأستاذ" related=double-entry :: All journal entries: our accounting books. Append-only.
@@term slug=double-entry term="Double-entry bookkeeping" aliases="double entry" ar="القيد المزدوج" related=ledger :: Writing both sides of every movement so they must match.
@@term slug=journal-entry term="Journal entry" aliases="entry" ar="قيد يومية" related=journal-line :: One page of the ledger describing one event.
@@term slug=journal-line term="Journal line" aliases="line" ar="سطر القيد" related=journal-entry :: One row: an account, a direction and an amount.
@@term slug=debit term="Debit" aliases="Dr" ar="مدين" related=credit :: One of two directions of a line. Not "bad".
@@term slug=credit term="Credit" aliases="Cr" ar="دائن" related=debit :: The other direction.
@@term slug=gl-account term="GL account" aliases="account;general ledger account" ar="حساب الأستاذ" related=ledger :: A named place where an amount is tracked. There are 11 kinds.
@@term slug=treasury term="Treasury" aliases="TREASURY" ar="الخزينة" related=gl-account :: Our real money.
@@term slug=clearing term="Gateway clearing" aliases="GATEWAY_CLEARING;clearing" ar="حساب المقاصة" related=settlement-target :: Money a partner holds for us but has not paid yet.
@@term slug=suspense term="Suspense" aliases="SUSPENSE" ar="حساب معلق" related=late-success :: Money that arrived but does not clearly belong yet.
@@term slug=aml-hold term="AML hold" aliases="AML_HOLD" ar="حجز مكافحة غسل الأموال" related=aml :: Money held while compliance decides.
@@term slug=chargeback-reserve term="Chargeback reserve" aliases="CHARGEBACK_RESERVE" ar="احتياطي الاسترداد" related=chargeback :: Money set aside while a dispute is open.
@@term slug=invariant term="Ledger invariant" aliases="invariant;drift" ar="ثابت الدفتر" related=ledger :: The equation that must always hold; the difference is the drift.
@@term slug=settlement term="Settlement" aliases="T+N;settle" ar="التسوية" related=reconciliation :: The partner paying us collected money, usually days later.
@@term slug=reconciliation term="Reconciliation" aliases="reconcile;statement" ar="المطابقة" related=settlement :: Matching a partner's statement to our books.
@@term slug=adjustment term="Adjustment" aliases="refund;correction" ar="تسوية يدوية" related=four-eyes :: Any non-standard money movement; always two people.
@@term slug=cashout term="Cash-out" aliases="payout;cashout" ar="سحب الرصيد" related=wallet :: A merchant's request to be paid its balance into its bank.
@@term slug=refund term="Refund" aliases="refunds" ar="استرداد" related=adjustment :: Returning money to the payer.
@@term slug=chargeback term="Chargeback" aliases="dispute" ar="رد المبلغ المتنازع عليه" related=dispute :: A payer or its bank taking money back through the card or payment network.
@@term slug=dispute term="Dispute" aliases="disputes" ar="نزاع" related=chargeback :: A case that a payment should be returned.
@@term slug=statement term="Statement" aliases="settlement statement" ar="كشف الحساب" related=reconciliation :: A partner's file listing what it processed.
@@term slug=netting term="Netting" aliases="net" ar="المقاصة بين الأرصدة" related=cashout :: Offsetting what two sides owe each other.
@@term slug=kyb term="KYB" aliases="know your business" ar="اعرف عميلك التجاري" related=beneficial-owner :: Checking that a business is real before allowing it.
@@term slug=join-request term="Join request" aliases="join requests" ar="طلب الانضمام" related=kyb :: The record of one onboarding attempt.
@@term slug=sla term="SLA" aliases="deadline;service level" ar="مهلة الخدمة" related=operator-case :: The deadline attached to a case or review.
@@term slug=beneficial-owner term="Beneficial owner" aliases="UBO;owner" ar="المستفيد الحقيقي" related=kyb :: A real person who owns 25% or more, or controls, a business.
@@term slug=risk-tier term="Risk tier" aliases="risk" ar="مستوى المخاطر" related=merchant :: LOW, STANDARD or HIGH: how risky a merchant is judged to be.
@@term slug=aml term="AML" aliases="anti-money-laundering;money laundering" ar="مكافحة غسل الأموال" related=screening :: Rules and activities that stop criminals hiding the origin of money.
@@term slug=screening term="Screening" aliases="name screening" ar="الفحص" related=sanctions,pep :: Comparing names against official and internal lists.
@@term slug=sanctions term="Sanctions list" aliases="sanctions" ar="قوائم العقوبات" related=screening :: An official list of people, companies and countries we must not deal with.
@@term slug=pep term="PEP" aliases="politically exposed person" ar="شخص سياسي ممثل للمخاطر" related=screening :: Someone with a prominent public role. Allowed, but riskier.
@@term slug=adverse-media term="Adverse media" aliases="negative news" ar="أخبار سلبية" related=screening :: Negative news about a person or business.
@@term slug=potential-match term="Potential match" aliases="POTENTIAL_MATCH;possible match" ar="تطابق محتمل" related=screening :: A name resembling a listed name. A person must decide.
@@term slug=false-positive term="False positive" aliases="FALSE_POSITIVE" ar="إيجابي كاذب" related=potential-match :: A possible match decided to be a different person.
@@term slug=velocity term="Velocity rule" aliases="velocity" ar="قاعدة السرعة" related=aml-rule :: A limit on how often or how much within a time window.
@@term slug=aml-rule term="AML rule" aliases="AML rules" ar="قاعدة مكافحة غسل الأموال" related=velocity :: A declarative pattern or amount rule that can hold money or open a case.
@@term slug=structuring term="Structuring" aliases="smurfing" ar="تجزئة العمليات" related=aml-rule :: Splitting amounts to stay under a threshold.
@@term slug=aml-case term="AML case" aliases="compliance case" ar="قضية امتثال" related=mlro :: A review of a suspected issue, with severity, deadline and decision.
@@term slug=mlro term="MLRO" aliases="money laundering reporting officer" ar="مسؤول الإبلاغ عن غسل الأموال" related=aml :: The senior owner of suspicious-activity decisions.
@@term slug=str term="STR" aliases="suspicious activity report;SAR" ar="بلاغ اشتباه" related=mlro :: A report to the authority about suspicious activity.
@@term slug=tipping-off term="Tipping-off" aliases="tip off;tipping off" ar="التنبيه" related=aml :: Telling someone they are under suspicion. Forbidden.
@@term slug=aml-confidential term="AML-confidential" aliases="confidential" ar="سري" related=tipping-off :: Data only Compliance, the MLRO and audit may see.
@@term slug=cbl term="CBL" aliases="Central Bank of Libya" ar="مصرف ليبيا المركزي" related=aml :: The Central Bank of Libya, our regulator.
@@term slug=retention term="Retention" aliases="record keeping" ar="الاحتفاظ بالسجلات" related=aml :: How long records must be kept.
@@term slug=mfa term="MFA" aliases="multi-factor;2FA" ar="التحقق متعدد العوامل" related=otp :: A second proof of identity, usually a six-digit code sent by SMS to your registered phone.
@@term slug=phishing term="Phishing" aliases="social engineering" ar="التصيد" related=secret :: Tricking a person into giving away secrets or acting wrongly.
@@term slug=runbook term="Runbook" aliases="RB" ar="دليل الإجراءات" related=incident :: A step-by-step procedure for a known incident.
@@term slug=incident term="Incident" aliases="" ar="حادثة" related=runbook :: Anything threatening money, customers or trust.
@@term slug=outbox term="Outbox" aliases="notification outbox" ar="صندوق الصادر" related=notification :: A safe queue that ensures a message is sent once.
@@term slug=notification term="Notification" aliases="notifications" ar="إشعار" related=outbox :: An SMS, e-mail or in-app message about an event.
@@term slug=spec term="Integration spec" aliases="integration-spec.json;spec" ar="مواصفات التكامل" related=gateway :: The JSON file an AI drafts for the Smart AI Integration.
@@term slug=test-vector term="Test vector" aliases="test vectors" ar="مثال اختبار" related=spec :: A sample request and answer used to check a result offline.

## III-C. Safeguard cards

@@card id=sg-approve-request title="Approve a request from another person" screen=Approvals risk=HIGH irreversible=true
**What this does**
You are approving a change proposed by someone else. Approving also **executes** the change immediately.

**Check first**
- [ ] I opened **Details** and read the old value and the new value.
- [ ] I understand what this will change, and can say it in one sentence.
- [ ] The merchant name, amount and currency are the ones I expect.
- [ ] The maker's reason makes sense and is more than "ok".
- [ ] I am not the maker, and nobody asked me to approve without reading.
- [ ] The environment badge is correct (`SANDBOX` or `LIVE`).

**Never**
- Never approve something you cannot explain.
- Never approve because someone is waiting or in a hurry.
- Never approve on the strength of a phone call or chat message.

**If you made a mistake**
Tell your manager and the owner of the area at once. A change that was executed is corrected by a new approved change, not by editing. See [[a:b10-09|You made a mistake]].
@@end

@@card id=sg-reject-request title="Reject a request" screen=Approvals risk=MEDIUM irreversible=false
**What this does**
You are refusing a proposed change. The maker will see your **Decision Reason** and may re-draft.

**Check first**
- [ ] I wrote a real reason: what I checked and why I refused.
- [ ] My reason contains no password, code or confidential detail.
- [ ] The reason does not mention AML or screening if a merchant could read it.
- [ ] I checked that this is the right request, not a similar one.

**Never**
- Never reject with "no" or "ok".
- Never reject to punish or to avoid work.

**If you made a mistake**
The maker can create a new request. If you rejected the wrong one, tell the maker straight away so they re-submit.
@@end

@@card id=sg-propose-adjustment title="Propose an adjustment" screen=Adjustments risk=HIGH irreversible=true
**What this does**
You are proposing a money movement: a refund, a chargeback, a manual credit or debit, or a correction. A different Finance user must approve it.

**Check first**
- [ ] I found the original payment by its **reference**.
- [ ] The amount does not exceed the original payment, and the currency is the same.
- [ ] I chose the correct type and the correct account.
- [ ] I decided deliberately whether the commission is reversed.
- [ ] I checked whether a dispute already covers this payment, so money is not returned twice.
- [ ] My reason says what I checked, what I found and why ([[a:b04-06|Writing a reason that survives an audit]]).

**Never**
- Never propose from a screenshot, phone call or chat alone.
- Never split one adjustment into several to avoid review.

**If you made a mistake**
If it is still pending, withdraw it. If it was executed, propose an offsetting adjustment with **Reverse**. Never edit an executed adjustment.
@@end

@@card id=sg-reverse-adjustment title="Reverse an adjustment" screen=Adjustments risk=HIGH irreversible=true
**What this does**
You are proposing a new adjustment that cancels the effect of an earlier one. The earlier one stays in the books.

**Check first**
- [ ] I confirmed the earlier adjustment is the wrong one, by reading its details.
- [ ] I understand the money will move in the opposite direction.
- [ ] I wrote the reason, including what went wrong the first time.
- [ ] The merchant name, amount and currency match the earlier adjustment.

**Never**
- Never reverse to hide a mistake without telling your manager.
- Never reverse the same adjustment twice.

**If you made a mistake**
Withdraw the pending reversal if it is wrong, and tell Finance. See [[a:b08-08|Adjustments]].
@@end

@@card id=sg-process-cashout title="Process or approve a cash-out" screen=Cashouts risk=CRITICAL irreversible=true
**What this does**
You are starting or finalising a payout of a merchant's balance to a real bank account. It cannot be undone by the platform.

**Check first**
- [ ] The destination is the merchant's verified bank account in its legal name (check the snapshot).
- [ ] The merchant is `ACTIVE`: not suspended, no negative balance, no hold.
- [ ] The amount is no more than the wallet balance.
- [ ] The ledger invariant shows zero drift and payouts are not halted.
- [ ] I am not the person who made the bank transfer (for the final approval).
- [ ] I read the amount aloud once: the figure, the merchant and the bank.

**Never**
- Never change the bank details yourself.
- Never process because a merchant phoned and said it is urgent.
- Never approve and execute your own processing.

**If you made a mistake**
Tell your manager and the Security Admin immediately. If a wrong transfer was made at the bank, contact the bank at once. Books are corrected by approved adjustments.
@@end

@@card id=sg-reject-cashout title="Reject a cash-out" screen=Cashouts risk=MEDIUM irreversible=false
**What this does**
You are refusing a payout request. Nothing has been subtracted from the wallet yet.

**Check first**
- [ ] I wrote the reason clearly.
- [ ] I checked the reason does not reveal AML or screening matters.
- [ ] I told or will tell the merchant only a generic reason.

**Never**
- Never reject for an AML reason in words the merchant could read.

**If you made a mistake**
The merchant can request again. If rejected by mistake, tell Finance so it is re-handled.
@@end

@@card id=sg-resolve-unknown title="Resolve an UNKNOWN payment by hand" screen=OperatorCases risk=CRITICAL irreversible=true
**What this does**
You are deciding that an uncertain payment **succeeded** or **failed**. This credits money or frees a link, and it needs a second person.

**Check first**
- [ ] I pressed **Inquire** and read the answer in the step log.
- [ ] I have **evidence from the partner**: a statement line or a written reply naming our reference or the provider reference.
- [ ] The amount and currency in the evidence match the attempt.
- [ ] The environment is `LIVE` and this is the right attempt.
- [ ] My reason names the evidence ([[a:b04-06|Writing a reason that survives an audit]]).

**Never**
- Never resolve because it is old.
- Never resolve from a customer's screenshot or phone call.
- Never ask the customer to pay again.

**If you made a mistake**
Tell your manager and Finance. A wrongly credited payment or a wrongly failed one is corrected by a new approved adjustment. See [[a:b07-03|UNKNOWN]].
@@end

@@card id=sg-release-reservation title="Release a link reservation" screen=OperatorCases risk=HIGH irreversible=true
**What this does**
You are freeing the slot held by an uncertain payment so that the link can be used again.

**Check first**
- [ ] I have evidence that **no money moved** for this attempt.
- [ ] I understand the customer could still pay twice if I am wrong.
- [ ] The case notes explain the evidence.

**Never**
- Never release while the partner might still confirm.
- Never release to satisfy an impatient merchant.

**If you made a mistake**
If the customer paid again, handle the second payment as an overpayment through Finance ([[a:b07-08|Late success, conflicts and amount mismatches]]) and tell your manager.
@@end

@@card id=sg-bulk-inquiry title="Run a bulk inquiry" screen=OperatorCases risk=MEDIUM irreversible=false
**What this does**
You are asking a partner about many payments at once. It sends many calls and may be rate-limited.

**Check first**
- [ ] I limited it to the affected route and time window.
- [ ] The partner is up (not in an open circuit-breaker period).
- [ ] I am not repeating a bulk inquiry I just ran.
- [ ] The environment is correct.

**Never**
- Never run it against all routes "just in case".
- Never run it while the partner is down.

**If you made a mistake**
Stop and tell the Gateway Admin if the partner starts refusing calls.
@@end

@@card id=sg-approve-join-request title="Approve a join request" screen=JoinRequests risk=HIGH irreversible=false
**What this does**
You are approving a business to take live payments. The merchant becomes active at once, or after a second reviewer if one is required.

**Check first**
- [ ] All seven checks are done and recorded.
- [ ] Screening is `CLEAR`, or a possible match was decided by Compliance.
- [ ] The payout account is in the merchant's legal name.
- [ ] The proposed risk tier is justified.
- [ ] No unresolved duplicate or related-party flag.
- [ ] I am not pressured by a deadline or a sales request.

**Never**
- Never approve with an incomplete checklist.
- Never discuss screening with the applicant.

**If you made a mistake**
Tell Compliance. An approved merchant can be suspended; a wrongly approved one is reviewed under [[a:b05-08|The Merchants screen]].
@@end

@@card id=sg-reject-join-request title="Reject a join request" screen=JoinRequests risk=HIGH irreversible=false
**What this does**
You are refusing an application. The applicant gets a neutral reason code and may apply again after correcting the cause.

**Check first**
- [ ] I chose the reason code that fits, knowing a revealing code will be shown as `POLICY`.
- [ ] My internal note states what I checked.
- [ ] I am not rejecting because of a screening result without Compliance involvement.

**Never**
- Never tell the applicant about screening.
- Never reject for a personal reason.

**If you made a mistake**
A wrongful rejection can be corrected by a new request linked to the old one. Tell your manager.
@@end

@@card id=sg-suspend-merchant title="Suspend a merchant" screen=Merchants risk=CRITICAL irreversible=false
**What this does**
You are stopping a business from taking payments and cashing out. It takes effect now and must be ratified within 24 hours.

**Check first**
- [ ] Delay would cause harm (fraud, sanctions, expired documents, merchant request).
- [ ] I chose the correct reason code.
- [ ] I wrote the reason so a stranger can understand it.
- [ ] I know who will ratify it.
- [ ] I will not tell the merchant the real reason if it is AML.

**Never**
- Never suspend casually or as a bargaining tool.
- Never tell the merchant it is because of compliance.

**If you made a mistake**
Ask a `COMPLIANCE` or `MLRO` user to review immediately. Reinstatement needs prior approval.
@@end

@@card id=sg-reinstate-merchant title="Reinstate a merchant" screen=Merchants risk=CRITICAL irreversible=false
**What this does**
You are letting a suspended business take payments and cash out again. This increases risk, so a different Compliance or MLRO user must approve first.

**Check first**
- [ ] The reason for suspension is resolved and documented.
- [ ] Compliance agrees (without telling the merchant why it was restricted).
- [ ] Documents are current.
- [ ] No open case or hold is unresolved.

**Never**
- Never reinstate on a merchant's request alone.
- Never use the emergency path.

**If you made a mistake**
Suspend again if reinstated by mistake and tell Compliance.
@@end

@@card id=sg-edit-merchant-sensitive title="Submit a sensitive merchant change" screen=Merchants risk=HIGH irreversible=false
**What this does**
You are asking a second person to approve a change to a sensitive field such as payout bank details, tax ID or risk tier.

**Check first**
- [ ] The change was requested in the merchant's own portal or in writing, not by phone.
- [ ] The new bank account is in the merchant's legal name.
- [ ] Supporting documents are attached.
- [ ] I wrote the reason and the old and new values are correct.

**Never**
- Never edit payout details after a phone request.
- Never include secrets in the reason.

**If you made a mistake**
Withdraw the request before a checker acts. If executed wrongly, submit a corrective change and tell Security.
@@end

@@card id=sg-aml-propose-resolution title="Propose an AML case resolution" screen=AmlCases risk=CRITICAL irreversible=true
**What this does**
You are proposing to release, void, freeze or escalate a case. The MLRO approves. Money moves only after approval.

**Check first**
- [ ] I reviewed all evidence and the rule that caused the case.
- [ ] My rationale states what I found and why the resolution is right.
- [ ] The rationale contains nothing a merchant could later read.
- [ ] I considered whether a report is required.
- [ ] I am not the checker.

**Never**
- Never tell the merchant or customer anything about the case.
- Never release to meet a deadline.

**If you made a mistake**
Withdraw before the MLRO acts. Tell the MLRO if you proposed in error.
@@end

@@card id=sg-aml-disposition title="Decide a screening match" screen=AmlScreenings risk=HIGH irreversible=false
**What this does**
You are deciding whether a possible name match is a false positive, a true match or needs escalation.

**Check first**
- [ ] I compared date of birth, nationality, ID and other attributes.
- [ ] I wrote the evidence for my decision.
- [ ] If I suppress future matches I set an expiry date.
- [ ] If it may be a sanctions match I will escalate, not decide alone.

**Never**
- Never mark a match false because the merchant is large or important.
- Never discuss the result outside Compliance.

**If you made a mistake**
Tell the MLRO immediately; a wrong disposition can be re-opened.
@@end

@@card id=sg-aml-rule-change title="Create or change an AML rule" screen=AmlRules risk=CRITICAL irreversible=false
**What this does**
You are changing the rules that hold money and open cases. The MLRO must approve.

**Check first**
- [ ] I ran the dry-run and read how many holds and cases it would create.
- [ ] I know whether this tightens or loosens the rule.
- [ ] If loosening, I accept that it needs full review.
- [ ] The scope is correct.

**Never**
- Never loosen a rule to reduce workload.
- Never test on live.

**If you made a mistake**
Withdraw the proposal. If activated wrongly, propose the corrective change with the MLRO.
@@end

@@card id=sg-aml-report title="Create or save a regulatory report" screen=AmlReports risk=CRITICAL irreversible=true
**What this does**
You are drafting or saving a report to the authority. Once approved and submitted it is frozen.

**Check first**
- [ ] The reporting rule is `CONFIRMED`, not `PROVISIONAL`.
- [ ] Facts in the report match the case.
- [ ] The report is stored as confidential.
- [ ] No other system or person is told about it.

**Never**
- Never tell the subject.
- Never file from a provisional rule.

**If you made a mistake**
Corrections are new linked reports. Tell the MLRO.
@@end

@@card id=sg-submit-gateway-version title="Submit a gateway version for approval" screen=GatewayWizard risk=CRITICAL irreversible=false
**What this does**
You are asking a Security Admin to approve a configuration for live money.

**Check first**
- [ ] I read the compiled request preview and the amount pipeline results.
- [ ] The 15-scenario suite and contract tests are green.
- [ ] The money step cannot retry automatically.
- [ ] Every weak channel must ask the partner.
- [ ] I named a rollback version and a canary plan.
- [ ] I did not use a real secret in any example.

**Never**
- Never submit with a failing gate.
- Never skip reading the preview.

**If you made a mistake**
Withdraw the submission. If it went live badly, roll back to the named version and follow [[a:b10-02|RB-01 Gateway outage and the circuit breaker]].
@@end

@@card id=sg-edit-route title="Create or change a route" screen=Routes risk=HIGH irreversible=false
**What this does**
You are changing which payment methods customers see, how traffic is split and what fees apply.

**Check first**
- [ ] I know which rail and gateway this route joins.
- [ ] Minimum, maximum and daily cap are correct and in LYD.
- [ ] The credential policy and scope are what I intend.
- [ ] The cost model matches the contract.
- [ ] I know this affects only new payments.

**Never**
- Never raise a limit to make a test pass.
- Never resume a route with an open breaker without the Gateway Admin.

**If you made a mistake**
Revert the change through the normal review; pause the route if customers are harmed.
@@end

@@card id=sg-ai-import-draft title="Create a draft from an AI-generated spec" screen=GatewayAiImport risk=HIGH irreversible=false
**What this does**
You are saving the AI-generated configuration as a **draft**. Nothing goes live.

**Check first**
- [ ] The four verification layers all passed.
- [ ] I read the preview and compared it with the partner's own document.
- [ ] I typed secrets only into the platform's fields, never into the AI.
- [ ] I chose Create New or New Version deliberately.

**Never**
- Never paste a real secret into an AI.
- Never treat a passed check as approval.

**If you made a mistake**
Delete or supersede the draft; it has no effect on payments.
@@end

@@card id=sg-run-reconciliation title="Run a statement file" screen=Reconciliation risk=HIGH irreversible=false
**What this does**
You are matching a partner's statement against our books. Problem lines open cases.

**Check first**
- [ ] The file is the right partner, the right period and the right source.
- [ ] The preview shows columns read correctly (amount, fee, date, time zone).
- [ ] This file has not been loaded before.
- [ ] I know what to do with mismatches ([[a:b08-06|Reconciliation]]).

**Never**
- Never edit the file to make it match.
- Never run a file from an unknown source.

**If you made a mistake**
Tell Finance. A wrong run is corrected through cases and adjustments, never by editing.
@@end

@@card id=sg-trigger-backup title="Run a backup now" screen=SystemBackups risk=MEDIUM irreversible=false
**What this does**
You ask the backup daemon to take a **Full** or **Delta** backup of one store or of all stores right now. It runs in the background and is queued behind any job already running.

**Check first**
- [ ] **Daemon status** says **Reachable** and the banner about an unreachable daemon is not shown.
- [ ] **Storage targets** shows every target **Healthy**.
- [ ] I know why I need it now (for example before maintenance, a configuration change or a certificate rotation).
- [ ] I chose the right **Backup target** and **Backup kind**. **All targets** with **Full** loads production, so I will do it when the platform is calm.

**Never**
- Never click **Run backup now** repeatedly to "make it go faster"; extra requests are queued behind the first.
- Never treat a started backup as finished. Wait for **Passed**.

**If you made a mistake**
A backup cannot harm data, only load the system. If you started the wrong one, let it finish and tell the Security Admin. If it ends **Failed**, read the **Error** column and see [[a:b12-10|The Backups screen]].
@@end

@@card id=sg-run-restore-drill title="Run a restore drill" screen=SystemBackups risk=MEDIUM irreversible=false
**What this does**
You ask the daemon to restore the latest backup chain into an isolated scratch cluster, replay the archived WAL to a target time and run the three invariant checks. Production is not touched and the scratch cluster is destroyed afterwards.

**Check first**
- [ ] **Daemon status** says **Reachable**.
- [ ] I understand it can take several minutes and runs after any job already running.
- [ ] I will read the result in **Latest restore drill** and will not assume success.
- [ ] I know that a failed check is a priority-1 incident ([[s:s-restore-drill-failed|A restore drill failed]]).

**Never**
- Never ignore a **Drill failed** result because the money checks passed.
- Never delete or prune backups to make a drill pass.

**If you made a mistake**
An extra drill is harmless. If a result is red, follow [[s:s-restore-drill-failed|A restore drill failed]] at once.
@@end

@@card id=sg-update-backup-policy title="Change the backup schedule or retention" screen=SystemBackups risk=HIGH irreversible=false
**What this does**
You propose new cron schedules (Full, Delta, Drill), retention (**Full retention days**, **WAL retention days**) or the **Alert lag threshold**. A second Security Admin must approve before anything changes.

**Check first**
- [ ] I have a written reason, for example a change of agreed recovery targets.
- [ ] Every cron expression has five fields and is in UTC.
- [ ] Retention is not lowered: shorter retention can destroy the history we need for recovery or an investigation.
- [ ] The **Alert lag threshold** is not raised just to hide a warning.
- [ ] I will ask a different Security Admin to review the `BACKUP_POLICY` request on **Approvals** ([[a:b12-11|Operating backups safely]]).

**Never**
- Never ask someone to approve a policy change without telling them what it does.
- Never use a second account of your own as the checker.

**If you made a mistake**
Before it is approved, ask for the request to be rejected and submit a corrected one. After approval, submit and approve a new change that restores the old values; the audit log keeps both.
@@end

## III-D. Situation Playbook

@@situation id=s-unknown-attempt title="A payment is stuck in UNKNOWN" screens=OperatorCases,Dashboard cases=5,8,20,77 articles=b07-03,b07-09,b10-04
### What you are seeing
An attempt shows `UNKNOWN`, or the **Unknown Backlog** tile is rising.
### What it means
We did not get a clear answer from the partner. Money may or may not have moved.
### What to do
1. Check the environment badge.
2. Open the case and read the step log.
3. Press **Inquire** once.
4. If the partner cannot be asked, wait for the statement or ask the partner's support with our reference and the provider reference.
5. Resolve by hand only with evidence and a second person ([[c:sg-resolve-unknown|Resolve an UNKNOWN payment by hand]]).
### What not to do
Do not mark it failed because it is old. Do not ask the customer to pay again. Do not re-send an OTP.
@@end

@@situation id=s-customer-deducted title="A customer says money was deducted" screens=OperatorCases cases=1,5,10,19 articles=b07-12,b07-03,b07-08
### What it means
The customer's bank or wallet shows a deduction. Our status may be anything.
### What to do
Ask for the reference, look it up and follow the table in [[a:b07-12|Procedure]]. If our status is not `SUCCEEDED`, create or update a case with the reference and time.
### What not to do
Do not promise a refund. Do not say "confirmed" from a screenshot.
@@end

@@situation id=s-method-missing title="A customer cannot see a payment method" screens=Routes,Rails cases=49,53,58,34 articles=b06-12,b06-11,b10-02
### What it means
One of the nine conditions of the visible-rails formula is failing.
### What to do
Walk down the table in [[a:b06-12|The visible-rails formula]]: application list, link list, commission profile, route active, route healthy, limits and daily cap, maintenance and scope, credential verified, currency and blocked flag.
### What not to do
Do not widen limits or resume a route to "make it appear".
@@end

@@situation id=s-breaker-open title="A circuit breaker is open" screens=Dashboard,Routes cases=50,53,54,56 articles=b10-02,b06-11
### What to do
Confirm it, tell the Gateway Admin and your manager, and let traffic move to the next route. When it closes, check the Unknown Backlog.
### What not to do
Do not re-enable the route while the partner is failing.
@@end

@@situation id=s-amount-wrong title="An amount is 1000 times too large or too small" screens=GatewayWizard cases=33,45 articles=b06-04,b10-01
### What it means
The gateway's amount scale or precision is wrong.
### What to do
Stop. Treat as P1. Tell the Gateway Admin and Security Admin. Pause the route (a risk-reducing action). Do not retry payments.
@@end

@@situation id=s-signature-fail title="Signature failures or webhooks from an unknown address" screens=Dashboard cases=22,23,27,30 articles=b10-03,b06-06,b07-05
### What to do
Follow [[a:b10-03|RB-02 Partner changed its signature or sender address]]. Never accept unsigned messages to get things moving.
@@end

@@situation id=s-late-success title="A confirmation arrived after the payment expired" screens=OperatorCases cases=10,19,41,136 articles=b07-08,b07-06
### What to do
If the slot was free, the platform posted it and raised a P2 alert. If the link was already paid, the money is in `SUSPENSE` and a refund is drafted; Finance approves through the normal route.
@@end

@@situation id=s-conflict title="A webhook and an inquiry disagree" screens=OperatorCases cases=20 articles=b07-08,b07-03
### What to do
Nothing was posted. This is a P1 conflict case. Escalate to a senior operator and the Gateway Admin; resolution needs partner evidence.
@@end

@@situation id=s-amount-mismatch title="The partner's amount differs from ours" screens=OperatorCases,Reconciliation cases=25,32,38,45 articles=b07-08,b08-06
### What to do
Read the route's mismatch policy result and the case. Compare with the statement. Propose any correction through Finance.
@@end

@@situation id=s-statement-lines title="A statement has lines that do not match" screens=Reconciliation cases=42,47,102 articles=b08-06,b10-05
### What to do
Check the file, source and time zone. `MISSING_AT_GATEWAY` is the most serious. Never edit the file.
@@end

@@situation id=s-ledger-drift title="The ledger invariant shows drift" screens=FinanceInvariant cases=97,110,140 articles=b08-05,b10-05
### What to do
Treat as P1. Payouts stop automatically. Follow [[a:b10-05|RB-04 Reconciliation or ledger drift]]. Never edit numbers.
@@end

@@situation id=s-cashout-request title="A merchant asks for a payout" screens=Cashouts cases=111,48 articles=b08-07,b08-13
### What to do
Check the snapshot of bank details, merchant state, balance and holds. Process with a checklist; a different Finance user approves the subtraction.
@@end

@@situation id=s-chargeback-arrives title="A chargeback or dispute arrives" screens=Disputes,Adjustments cases=40,126,128 articles=b08-09,b08-08
### What to do
Check the evidence deadline. The system drafts the adjustment; a human Finance checker must approve before any money moves.
@@end

@@situation id=s-negative-balance title="A refund or chargeback exceeds the merchant's balance" screens=Adjustments,Merchants cases=48 articles=b08-13
### What to do
If it would breach the ceiling, it does not post; a P1 case opens. Finance chooses to collect, net or suspend.
@@end

@@situation id=s-merchant-restricted title="A merchant asks why it is restricted" screens=Merchants cases=130,65 articles=b09-08,b05-09
### What to say
"Your account is currently restricted. Please contact the support address in your notice." Nothing more. Tell Compliance.
@@end

@@situation id=s-aml-match title="A screening shows a possible match" screens=AmlScreenings,JoinRequests cases=122,123,124 articles=b09-03,b05-05
### What to do
Compliance decides each match with a written rationale. Do not approve a merchant until matches are decided. Never discuss it outside Compliance.
@@end

@@situation id=s-emergency-suspension title="An emergency suspension needs ratification" screens=Merchants,Approvals cases=127,65 articles=b09-06,b04-04
### What to do
A different Compliance user or the MLRO reviews within 24 hours. If nobody does, a P2 alert fires and the suspension stays in force.
@@end

@@situation id=s-join-duplicate title="A join request looks like a past applicant" screens=JoinRequests cases=118,120,121 articles=b05-10,b05-03
### What to do
A second reviewer is required. Review the related records. Do not tell the applicant why.
@@end

@@situation id=s-token-leak title="A merchant says its API token leaked" screens=Merchants cases=88 articles=b05-07,b10-07
### What to do
The merchant revokes it in its portal and creates a new one. Never ask for the token value.
@@end

@@situation id=s-credential-failing title="A credential set turned FAILING" screens=Gateways cases=60,62 articles=b10-06,b06-09
### What to do
Follow [[a:b10-06|RB-05 Credentials or tokens expired or failing]]: replace the secret through two-person approval and run the credential check.
@@end

@@situation id=s-approval-refused title="A button is missing or an action was refused" screens=Approvals cases=75 articles=b03-07,b03-02
### What to do
Read [[a:b03-07|When a button is missing or an action is refused]]. Do not work around it.
@@end

@@situation id=s-approval-expired title="An approval expired or is out of date" screens=Approvals cases=70,75 articles=b04-03,b03-07
### What to do
The maker creates a new request from the current values.
@@end

@@situation id=s-pos-offline title="A POS screen went offline" screens=Dashboard cases=14,105,115 articles=b07-11
### What to do
The payment continues on the server. Look it up by reference.
@@end

@@situation id=s-otp-not-arriving title="The customer says the code never arrived" screens=OperatorCases cases=2,96,83 articles=b07-07
### What to do
Ask them to wait for the countdown, check the number and use resend once.
@@end

@@situation id=s-wrong-approval title="I approved or proposed the wrong thing" screens=Approvals,Adjustments cases=101,113 articles=b10-09,b08-08
### What to do
Stop. Tell your manager. Do not edit; offset with a new approved entry.
@@end

@@situation id=s-secret-pasted title="I pasted a secret in the wrong place" screens=Dashboard cases=76,88 articles=b10-07,b11-04
### What to do
Tell the Security Admin now. The secret must be rotated.
@@end

@@situation id=s-sandbox-live title="I am not sure if this is sandbox or live" screens=Dashboard cases=71,26 articles=b01-08,b06-10
### What to do
Stop. Read the badge. If still unsure, ask before acting.
@@end

@@situation id=s-gateway-live-bad title="A new gateway version is misbehaving" screens=GatewayWizard,Gateways cases=68,69 articles=b06-10,b10-02
### What to do
Pause the route, then roll back to the named rollback version through the normal review.
@@end

@@situation id=s-reference-rejected title="The partner rejects our reference" screens=GatewayWizard cases=72,114 articles=b06-16,b06-03
### What to do
Tell the Gateway Admin; the reference format contract test (gate 4) is the place to fix it.
@@end

@@situation id=s-backup-daemon-unreachable title="The Backups screen says the backup daemon is unreachable" screens=SystemBackups,Dashboard articles=b12-09,b12-10,b12-11
### What it means
The core cannot talk to the backup daemon over mutual TLS. **Run backup now**, **Run restore drill** and **Edit policy** are disabled. Scheduled backups and WAL archiving may not be happening.

### What to do
1. Do not guess and do not try to fix servers yourself. Tell the Security Admin and the people who run the servers.
2. Ask them to check that the backup daemon service is running on its host, that its certificate and the core's backup client certificate are valid, and that the network path from the core to the daemon is open.
3. Remember that the database keeps WAL segments it has not yet delivered. A long outage can fill the database disk, so do not leave this overnight.
4. When **Daemon status** returns to **Reachable**, press **Refresh**, confirm **WAL archive lag** drains and check **Last backup**. If a scheduled backup was missed, a Security Admin can run a **Delta** ([[c:sg-trigger-backup|Run a backup now]]).
@@end

@@situation id=s-wal-archive-lag-high title="WAL archive lag is Attention or Critical" screens=SystemBackups articles=b12-09,b12-10
### What it means
**Attention** means the lag is above the **Alert threshold** (default 300 s). **Critical** means above twice the threshold. Recent changes are not yet safely archived, so a disaster now would lose more than a few seconds.

### What to do
1. Read **Archive lag**, **Lag bytes**, **Current LSN** and **Last archived LSN**. Press **Refresh** twice a minute apart: is the lag falling or growing?
2. Open **Storage targets** and **Daemon status**. A **Failed** target (for example the S3 or MinIO bucket) or an **Unreachable** daemon is the usual cause. See [[s:s-backup-daemon-unreachable|The Backups screen says the backup daemon is unreachable]].
3. Tell the Security Admin and the people who run the servers. Until archiving catches up, WAL piles up on the database disk.
4. Do not raise the **Alert lag threshold** to silence the warning.
5. Confirm recovery: **Archive lag** back under the threshold and the tile **Healthy**.
@@end

@@situation id=s-restore-drill-failed title="A restore drill failed" screens=SystemBackups,Finance articles=b12-10,b10-05,b08-11
### What it means
Any failed check is a **priority-1 incident**. Read the three badges in **Latest restore drill**.

### What to do
1. **Double-entry zero drift** or **Sharded balance parity** failed: tell Finance and the Security Admin. Open **Ledger Audit & Invariant** under **Finance** to see whether production also drifts, then follow RB-04 ([[a:b10-05|RB-04 Reconciliation or ledger drift]], [[a:b08-05|The ledger equation and what to do when it does not hold]]).
2. **Audit hash chain** failed: escalate immediately to the Security Admin. Do not delete, prune or alter any backup, and do not touch audit records.
3. **Drill failed** with a red error text and no failed check (the backup could not be fetched or the scratch cluster did not start): we have no proof that recovery works. Ask the people who run the servers to fix the cause, then run another drill ([[c:sg-run-restore-drill|Run a restore drill]]) and confirm all three badges read **Passed**.
4. Write down the drill id, the time and what you saw, in the incident record.
@@end

## III-E. Reading Paths by Role

@@path role=ALL title="New employee: day one to day five" :: b00-01,b00-02,b00-03,b00-04,b01-01,b01-02,b01-03,b01-04,b01-05,b01-06,b01-07,b01-08,b01-09,b01-10,b02-01,b02-02,b02-03,b02-06,b03-01,b03-02,b04-01,b04-03,b04-06,b11-02,b10-01
@@path role=OPERATOR title="Operator" :: b00-03,b03-05,b03-07,b04-03,b05-03,b05-04,b05-08,b05-09,b07-01,b07-02,b07-03,b07-04,b07-09,b07-12,b10-04,b09-08
@@path role=SUPPORT title="Support" :: b00-03,b05-09,b05-08,b07-01,b07-02,b07-03,b07-12,b09-08,b13-01
@@path role=FINANCE title="Finance" :: b04-05,b08-01,b08-02,b08-03,b08-04,b08-05,b08-06,b08-07,b08-08,b08-09,b08-10,b08-11,b08-13,b10-05,b07-03
@@path role=COMPLIANCE title="Compliance" :: b05-03,b05-04,b05-05,b09-01,b09-02,b09-03,b09-04,b09-05,b09-06,b09-07,b09-08,b09-09,b09-10,b04-04
@@path role=MLRO title="MLRO" :: b09-01,b09-05,b09-06,b09-07,b09-08,b04-04,b04-05,b09-04
@@path role=GATEWAY_ADMIN title="Gateway Admin" :: b06-01,b06-02,b06-03,b06-04,b06-05,b06-06,b06-07,b06-08,b06-09,b06-10,b06-11,b06-12,b06-13,b06-14,b06-16,b12-09,b12-10,b10-02,b10-03,b10-06
@@path role=SECURITY_ADMIN title="Security Admin" :: b04-05,b06-16,b06-17,b11-01,b11-03,b12-01,b12-02,b12-03,b12-04,b12-05,b12-07,b12-09,b12-10,b12-11,b10-03,b10-07

## III-F. Data blocks

### III-F.1 Ledger events (used by the ledger-explorer widget)

@@data id=ledger-events
```json
{
  "defaults": {"A":"100","rate":"3","fee":"0.8","provFee":"1","sur":"comm","var":"0.1","walletStart":"40"},
  "derived": {"comm":"round4(A*rate/100)","net":"A-comm","hold":"A"},
  "accounts": [
    {"id":"TREASURY","class":"LEFT","normal":"DEBIT"},
    {"id":"GATEWAY_CLEARING","class":"LEFT","normal":"DEBIT"},
    {"id":"COMMISSION_RECEIVABLE","class":"LEFT","normal":"DEBIT"},
    {"id":"MERCHANT_WALLET","class":"RIGHT_PLUS","normal":"CREDIT"},
    {"id":"PLATFORM_INCOME","class":"RIGHT_PLUS","normal":"CREDIT"},
    {"id":"GATEWAY_FEE_ACCRUAL","class":"RIGHT_PLUS","normal":"CREDIT"},
    {"id":"AML_HOLD","class":"RIGHT_PLUS","normal":"CREDIT"},
    {"id":"CHARGEBACK_RESERVE","class":"RIGHT_PLUS","normal":"CREDIT"},
    {"id":"SUSPENSE","class":"RIGHT_PLUS","normal":"CREDIT"},
    {"id":"PROVIDER_FEE_EXPENSE","class":"RIGHT_MINUS","normal":"DEBIT"},
    {"id":"GATEWAY_FEE_EXPENSE","class":"RIGHT_MINUS","normal":"DEBIT"}
  ],
  "equation": "sum(LEFT) == sum(RIGHT_PLUS) - sum(RIGHT_MINUS), each balance = debits-credits for DEBIT-normal accounts and credits-debits for CREDIT-normal accounts",
  "events": [
    {"id":"E01","title":"Fee taken at source (Entry 1)","entries":[{"label":"Confirmation","lines":[
      {"account":"TREASURY","side":"DR","amount":"A-provFee","why":"We hold the money after the partner took its fee."},
      {"account":"PROVIDER_FEE_EXPENSE","side":"DR","amount":"provFee","why":"The partner's fee is our cost."},
      {"account":"MERCHANT_WALLET","side":"CR","amount":"A-comm","why":"We now owe the merchant the amount minus our commission."},
      {"account":"PLATFORM_INCOME","side":"CR","amount":"comm","why":"Our commission is earned."}]}]},
    {"id":"E02","title":"Partner holds the money, fee accrued (Entry 2)","entries":[{"label":"Confirmation","lines":[
      {"account":"GATEWAY_CLEARING","side":"DR","amount":"A","why":"The partner owes us the full amount."},
      {"account":"GATEWAY_FEE_EXPENSE","side":"DR","amount":"fee","why":"The partner's fee is recognised as a cost now."},
      {"account":"MERCHANT_WALLET","side":"CR","amount":"A-comm","why":"We owe the merchant the net amount."},
      {"account":"PLATFORM_INCOME","side":"CR","amount":"comm","why":"Our commission is earned."},
      {"account":"GATEWAY_FEE_ACCRUAL","side":"CR","amount":"fee","why":"We will pay the fee later, so we record that we owe it."}]}]},
    {"id":"E03","title":"Settlement sweep (Entry 3)","entries":[{"label":"Statement settles","lines":[
      {"account":"TREASURY","side":"DR","amount":"A-fee","why":"The partner paid us the net amount."},
      {"account":"GATEWAY_FEE_ACCRUAL","side":"DR","amount":"fee","why":"The accrued fee is now settled."},
      {"account":"GATEWAY_CLEARING","side":"CR","amount":"A","why":"The partner no longer owes us."}]}]},
    {"id":"E04","title":"Fee true-up (Entry 4)","entries":[{"label":"Variance","lines":[
      {"account":"GATEWAY_FEE_EXPENSE","side":"DR","amount":"var","why":"The real fee was higher than accrued."},
      {"account":"GATEWAY_FEE_ACCRUAL","side":"CR","amount":"var","why":"We owe the extra amount."}]}]},
    {"id":"E05","title":"Payer surcharge (Entry 5)","entries":[{"label":"Confirmation","lines":[
      {"account":"GATEWAY_CLEARING","side":"DR","amount":"A+sur","why":"The payer paid the link amount plus the surcharge."},
      {"account":"GATEWAY_FEE_EXPENSE","side":"DR","amount":"fee","why":"The partner's fee is a cost."},
      {"account":"MERCHANT_WALLET","side":"CR","amount":"A","why":"The merchant gets the full link amount."},
      {"account":"PLATFORM_INCOME","side":"CR","amount":"sur","why":"The surcharge is our commission."},
      {"account":"GATEWAY_FEE_ACCRUAL","side":"CR","amount":"fee","why":"We owe the partner's fee later."}]}]},
    {"id":"E06","title":"Direct to merchant (Entry 6)","entries":[
      {"label":"At confirmation","lines":[
        {"account":"COMMISSION_RECEIVABLE","side":"DR","amount":"comm","why":"The merchant owes us the commission."},
        {"account":"PLATFORM_INCOME","side":"CR","amount":"comm","why":"We earned it."}]},
      {"label":"At netting","lines":[
        {"account":"MERCHANT_WALLET","side":"DR","amount":"comm","why":"We take the commission off what we owe the merchant."},
        {"account":"COMMISSION_RECEIVABLE","side":"CR","amount":"comm","why":"The receivable is cleared."}]}]},
    {"id":"E07","title":"AML hold and release (Entry 7)","entries":[
      {"label":"At confirmation","lines":[
        {"account":"GATEWAY_CLEARING","side":"DR","amount":"A","why":"The partner owes us the amount."},
        {"account":"AML_HOLD","side":"CR","amount":"hold","why":"The money is held; no commission yet."}]},
      {"label":"At release","lines":[
        {"account":"AML_HOLD","side":"DR","amount":"hold","why":"The hold ends."},
        {"account":"MERCHANT_WALLET","side":"CR","amount":"A-comm","why":"The merchant is credited."},
        {"account":"PLATFORM_INCOME","side":"CR","amount":"comm","why":"Commission is recognised only now."}]}]},
    {"id":"E08","title":"Cash-out subtracted (Entry 8)","entries":[{"label":"Subtraction","lines":[
      {"account":"MERCHANT_WALLET","side":"DR","amount":"A","why":"We owe the merchant less."},
      {"account":"TREASURY","side":"CR","amount":"A","why":"Our cash left to the merchant's bank."}]}]},
    {"id":"E09","title":"Full refund (Entry 9)","entries":[{"label":"Refund","lines":[
      {"account":"MERCHANT_WALLET","side":"DR","amount":"A-comm","why":"The merchant's share is returned."},
      {"account":"PLATFORM_INCOME","side":"DR","amount":"comm","why":"Our commission is reversed."},
      {"account":"TREASURY","side":"CR","amount":"A","why":"The money goes back to the payer."}]}]},
    {"id":"E10","title":"Chargeback reserved, then lost (Entry 10)","entries":[
      {"label":"At dispute","lines":[
        {"account":"MERCHANT_WALLET","side":"DR","amount":"A-comm","why":"The merchant's share is set aside."},
        {"account":"PLATFORM_INCOME","side":"DR","amount":"comm","why":"Commission reversed."},
        {"account":"CHARGEBACK_RESERVE","side":"CR","amount":"A","why":"Money held for the dispute."}]},
      {"label":"If lost","lines":[
        {"account":"CHARGEBACK_RESERVE","side":"DR","amount":"A","why":"The reserve is used."},
        {"account":"TREASURY","side":"CR","amount":"A","why":"The money leaves to the payer or scheme."}]}]},
    {"id":"E11","title":"AML hold voided and returned (Entry 11)","entries":[{"label":"Void","lines":[
      {"account":"AML_HOLD","side":"DR","amount":"hold","why":"The hold ends."},
      {"account":"TREASURY","side":"CR","amount":"hold","why":"The money is returned to the payer."}]}]},
    {"id":"E12","title":"Chargeback won (Entry 12)","entries":[{"label":"Release reserve","lines":[
      {"account":"CHARGEBACK_RESERVE","side":"DR","amount":"A","why":"The reserve is released."},
      {"account":"MERCHANT_WALLET","side":"CR","amount":"A-comm","why":"The merchant gets its share back."},
      {"account":"PLATFORM_INCOME","side":"CR","amount":"comm","why":"Commission is restored."}]}]},
    {"id":"E13","title":"NeomPay confirmation (Entry 13)","entries":[{"label":"Confirmation","lines":[
      {"account":"TREASURY","side":"DR","amount":"A","why":"First-party money goes straight to treasury."},
      {"account":"MERCHANT_WALLET","side":"CR","amount":"A-comm","why":"The merchant is credited."},
      {"account":"PLATFORM_INCOME","side":"CR","amount":"comm","why":"Commission earned."}]}]},
    {"id":"E14","title":"NeomPay refund (Entry 14)","entries":[{"label":"Refund","lines":[
      {"account":"MERCHANT_WALLET","side":"DR","amount":"A-comm","why":"The merchant's share is returned."},
      {"account":"PLATFORM_INCOME","side":"DR","amount":"comm","why":"Commission reversed."},
      {"account":"TREASURY","side":"CR","amount":"A","why":"The money returns to the payer's wallet."}]}]},
    {"id":"E15","title":"Chargeback with too little in the wallet (Entry 15)","showBalance":{"label":"Merchant wallet after","expr":"walletStart-A+comm"},"entries":[{"label":"Chargeback approved","lines":[
      {"account":"MERCHANT_WALLET","side":"DR","amount":"A-comm","why":"The wallet may go negative up to its ceiling."},
      {"account":"PLATFORM_INCOME","side":"DR","amount":"comm","why":"Commission reversed."},
      {"account":"CHARGEBACK_RESERVE","side":"CR","amount":"A","why":"Money set aside for the dispute."}]}]},
    {"id":"E16","title":"Late success on an already-paid link","entries":[{"label":"Parked","lines":[
      {"account":"GATEWAY_CLEARING","side":"DR","amount":"A","why":"The partner collected the money."},
      {"account":"SUSPENSE","side":"CR","amount":"A","why":"It does not belong to anyone yet; a refund is drafted for approval."}]}]}
  ]
}
```
@@end

### III-F.2 Visible rails and attempt transitions

@@data id=visible-rails
```json
{
  "evaluationOrder": ["1","2","3","routes(4-8)","9"],
  "predicates": [
    {"n":1,"id":"application-whitelist","fails":"The merchant's application does not allow this payment method."},
    {"n":2,"id":"link-whitelist","fails":"This payment link does not allow this payment method."},
    {"n":3,"id":"commission-profile","fails":"No live commission profile covers this payment method at this amount."},
    {"n":4,"id":"route-active","fails":"No route for this payment method is active."},
    {"n":5,"id":"route-healthy","fails":"The route is not healthy (degraded or its circuit breaker is open)."},
    {"n":6,"id":"limits","fails":"The amount is outside the route's minimum or maximum, or it would pass the route's daily cap."},
    {"n":7,"id":"maintenance-scope","fails":"The route is in a maintenance window, or this merchant, application, risk tier or channel is outside its scope."},
    {"n":8,"id":"credential-verified","fails":"The route's credential set is not verified."},
    {"n":9,"id":"currency-blocked","fails":"The payment method's currency differs from the link's currency, or the method is blocked."}
  ],
  "rule": "Predicates 1,2,3 and 9 are checked on the rail. Predicates 4-8 are checked per route in order 4,5,6,7,8; a route passes only if all five pass. The rail is visible if at least one route passes. If hidden, report the first failing predicate in order 1,2,3, then the best route's failure (the route that passed the most of 4-8, first in list on ties), then 9.",
  "defaults": {"amount":"100","currency":"LYD","applicationWhitelist":null,"linkWhitelist":null,"timeOfDay":"12:00"},
  "rails": [
    {"code":"sadad","name":"Sadad","currency":"LYD","blocked":false,"commissionProfile":true,"routes":[
      {"id":"sadad-direct","status":"ACTIVE","health":"HEALTHY","min":"1","max":"2000","dailyCap":"50000","dailyProcessed":"10000","maintenance":[{"from":"02:00","to":"03:00"}],"scopeOk":true,"credential":"VERIFIED"}]},
    {"code":"moamalat_card","name":"Moamalat Card","currency":"LYD","blocked":false,"commissionProfile":true,"routes":[
      {"id":"moamalat-direct","status":"ACTIVE","health":"HEALTHY","min":"5","max":"100000","dailyCap":"500000","dailyProcessed":"100000","maintenance":[],"scopeOk":true,"credential":"VERIFIED"}]},
    {"code":"edfali","name":"Edfali","currency":"LYD","blocked":false,"commissionProfile":true,"routes":[
      {"id":"edfali-direct","status":"ACTIVE","health":"HEALTHY","min":"1","max":"1000","dailyCap":"20000","dailyProcessed":"19950","maintenance":[],"scopeOk":true,"credential":"VERIFIED"},
      {"id":"edfali-aggregator","status":"ACTIVE","health":"OPEN_BREAKER","min":"1","max":"1000","dailyCap":"100000","dailyProcessed":"0","maintenance":[],"scopeOk":true,"credential":"VERIFIED"}]},
    {"code":"visa_usd","name":"Visa / Mastercard (USD)","currency":"USD","blocked":false,"commissionProfile":true,"routes":[
      {"id":"mpgs-usd","status":"ACTIVE","health":"HEALTHY","min":"1","max":"5000","dailyCap":"100000","dailyProcessed":"0","maintenance":[],"scopeOk":true,"credential":"VERIFIED"}]},
    {"code":"neompay","name":"NeomPay","currency":"LYD","blocked":false,"commissionProfile":false,"routes":[
      {"id":"neompay-internal","status":"ACTIVE","health":"HEALTHY","min":"1","max":"20000","dailyCap":"500000","dailyProcessed":"0","maintenance":[],"scopeOk":true,"credential":"VERIFIED"}]}
  ],
  "vectors": [
    {"id":"V1","input":{},"expected":{"sadad":"VISIBLE","moamalat_card":"VISIBLE","edfali":"HIDDEN:6","visa_usd":"HIDDEN:9","neompay":"HIDDEN:3"}},
    {"id":"V2","input":{"timeOfDay":"02:30"},"expected":{"sadad":"HIDDEN:7","moamalat_card":"VISIBLE","edfali":"HIDDEN:6","visa_usd":"HIDDEN:9","neompay":"HIDDEN:3"}},
    {"id":"V3","input":{"amount":"3000"},"expected":{"sadad":"HIDDEN:6","moamalat_card":"VISIBLE","edfali":"HIDDEN:6","visa_usd":"HIDDEN:9","neompay":"HIDDEN:3"}},
    {"id":"V4","input":{"applicationWhitelist":["sadad"]},"expected":{"sadad":"VISIBLE","moamalat_card":"HIDDEN:1","edfali":"HIDDEN:1","visa_usd":"HIDDEN:1","neompay":"HIDDEN:1"}},
    {"id":"V5","input":{"amount":"40"},"expected":{"sadad":"VISIBLE","moamalat_card":"VISIBLE","edfali":"VISIBLE","visa_usd":"HIDDEN:9","neompay":"HIDDEN:3"}},
    {"id":"V6","input":{"linkWhitelist":["moamalat_card","sadad"],"routeOverrides":{"sadad-direct":{"health":"OPEN_BREAKER"}}},"expected":{"sadad":"HIDDEN:5","moamalat_card":"VISIBLE","edfali":"HIDDEN:2","visa_usd":"HIDDEN:2","neompay":"HIDDEN:2"}},
    {"id":"V7","input":{"currency":"USD"},"expected":{"sadad":"HIDDEN:9","moamalat_card":"HIDDEN:9","edfali":"HIDDEN:6","visa_usd":"VISIBLE","neompay":"HIDDEN:3"}}
  ]
}
```
@@end

@@data id=attempt-transitions
```json
{
  "initial": "CREATED",
  "states": [
    {"id":"CREATED","slot":"reserved","money":"none","human":"Nothing to do. Seconds only; escalate if it stays."},
    {"id":"INITIATING","slot":"reserved","money":"none","human":"Nothing to do."},
    {"id":"AWAITING_CUSTOMER","slot":"reserved","money":"none","human":"Nothing to do. Never nudge the customer to pay again."},
    {"id":"AUTHORIZING","slot":"reserved","money":"none","human":"Nothing to do. It will become UNKNOWN by itself if the partner is silent."},
    {"id":"VERIFYING","slot":"reserved","money":"none","human":"Nothing to do unless it stays long."},
    {"id":"UNKNOWN","slot":"reserved","money":"none","human":"We do not know. Use Inquire, then follow the UNKNOWN article. Never guess."},
    {"id":"SUCCEEDED","slot":"consumed","money":"posted","human":"Nothing to do. Verified and posted together."},
    {"id":"FAILED","slot":"released","money":"none","human":"If a customer insists they paid, follow the deducted-money procedure."},
    {"id":"EXPIRED","slot":"released","money":"none","human":"A late success can still arrive during the grace window."},
    {"id":"CANCELLED","slot":"released","money":"none","human":"Nothing to do."},
    {"id":"BLOCKED","slot":"released","money":"none","human":"Never explain the real reason to the customer."},
    {"id":"PARTIALLY_REFUNDED","slot":"consumed","money":"posted-partly-reversed","human":"See Book 8."},
    {"id":"REFUNDED","slot":"consumed","money":"posted-reversed","human":"See Book 8."},
    {"id":"DISPUTED","slot":"consumed","money":"posted","human":"A dispute is open. Handled by Finance; the payment is not undone."}
  ],
  "events": [
    {"id":"ev-guard-block","label":"A guard blocks it before it starts (limit, watch-list, AML rule)","from":["CREATED"],"to":"BLOCKED","note":"The customer sees only a generic message."},
    {"id":"ev-start","label":"The engine starts the payment with the partner","from":["CREATED"],"to":"INITIATING"},
    {"id":"ev-start-ok","label":"The partner accepted the start (SMS code sent, QR shown)","from":["INITIATING"],"to":"AWAITING_CUSTOMER"},
    {"id":"ev-start-refused","label":"The partner clearly refuses to start","from":["INITIATING"],"to":"FAILED"},
    {"id":"ev-customer-submits","label":"The customer enters the code and the engine sends the confirm step","from":["AWAITING_CUSTOMER"],"to":"AUTHORIZING"},
    {"id":"ev-wrong-otp","label":"Customer enters a wrong code (retryable, tries left)","from":["AUTHORIZING"],"to":"AWAITING_CUSTOMER","note":"No new SMS is sent."},
    {"id":"ev-wrong-otp-last","label":"Customer enters the third wrong code","from":["AUTHORIZING"],"to":"FAILED"},
    {"id":"ev-confirm-success","label":"The partner clearly says success and the five facts match","from":["AUTHORIZING"],"to":"SUCCEEDED","note":"The journal entry is written in the same transaction."},
    {"id":"ev-confirm-decline","label":"The partner clearly declines (for example insufficient funds)","from":["AUTHORIZING"],"to":"FAILED"},
    {"id":"ev-confirm-timeout","label":"The gateway times out or answers with an error or unreadable text on confirm","from":["AUTHORIZING"],"to":"UNKNOWN","note":"Never FAILED. The same code is never resubmitted."},
    {"id":"ev-confirm-processing","label":"The partner says it is processing","from":["AUTHORIZING"],"to":"VERIFYING"},
    {"id":"ev-return-hint","label":"The customer returns from the partner's page, or the browser says done (a hint)","from":["CREATED","AWAITING_CUSTOMER"],"to":"VERIFYING","note":"We must ask the partner; the hint proves nothing."},
    {"id":"ev-webhook-success","label":"A verified webhook says paid and the five facts match","from":["AWAITING_CUSTOMER","VERIFYING","UNKNOWN"],"to":"SUCCEEDED"},
    {"id":"ev-inquiry-success","label":"An inquiry clearly says paid and the five facts match","from":["VERIFYING","UNKNOWN"],"to":"SUCCEEDED"},
    {"id":"ev-inquiry-failed","label":"An inquiry clearly says failed","from":["VERIFYING","UNKNOWN"],"to":"FAILED"},
    {"id":"ev-polling-exhausted","label":"Polling ends with no clear answer","from":["VERIFYING"],"to":"UNKNOWN"},
    {"id":"ev-conflict","label":"A verified webhook and an inquiry disagree","from":["VERIFYING","AWAITING_CUSTOMER"],"to":"UNKNOWN","note":"Nothing is posted. A priority-1 conflict case opens."},
    {"id":"ev-expire","label":"Time runs out and the last inquiry finds nothing","from":["AWAITING_CUSTOMER"],"to":"EXPIRED"},
    {"id":"ev-cancel","label":"The customer cancels or switches payment method","from":["AWAITING_CUSTOMER"],"to":"CANCELLED"},
    {"id":"ev-late-success","label":"A verified success arrives late and the link slot is still free","from":["EXPIRED","FAILED"],"to":"SUCCEEDED","note":"A priority-2 alert is raised."},
    {"id":"ev-late-success-paid","label":"A verified success arrives late but the single-use link was already paid","from":["EXPIRED","FAILED"],"to":"SAME","note":"The money is parked in SUSPENSE and a refund is drafted for approval."},
    {"id":"ev-customer-retry","label":"The customer presses retry while the payment is unknown","from":["UNKNOWN"],"to":"SAME","note":"Blocked on the server; the slot is still reserved."},
    {"id":"ev-operator-success","label":"An operator marks it succeeded with evidence and a second person approves","from":["UNKNOWN"],"to":"SUCCEEDED"},
    {"id":"ev-operator-failed","label":"An operator marks it failed with evidence and a second person approves","from":["UNKNOWN"],"to":"FAILED"},
    {"id":"ev-refund-partial","label":"A partial refund is approved and executed","from":["SUCCEEDED"],"to":"PARTIALLY_REFUNDED"},
    {"id":"ev-refund-full","label":"A full refund is approved and executed","from":["SUCCEEDED","PARTIALLY_REFUNDED"],"to":"REFUNDED"},
    {"id":"ev-dispute","label":"The partner opens a dispute","from":["SUCCEEDED","PARTIALLY_REFUNDED"],"to":"DISPUTED"}
  ]
}
```
@@end

## III-F.3 Context map and screen-to-article map

@@map id=context-map
```json
{
 "fallbackScreenId": "General",
 "screens": [
  {
   "screenId": "Dashboard",
   "routeNames": [
    "Dashboard",
    "Home"
   ],
   "pageDir": "pages/dashboard",
   "summary": "A smoke alarm for the platform: how many merchants, what is waiting, how many payments are stuck, which routes are switched off, and how late the queues are. It shows tiles, not details; open the screen a tile points to.",
   "articles": [
    "b03-05",
    "b07-03",
    "b10-02"
   ],
   "cards": [],
   "situations": [
    "s-unknown-attempt",
    "s-breaker-open",
    "s-sandbox-live"
   ]
  },
  {
   "screenId": "JoinRequests",
   "routeNames": [
    "JoinRequests",
    "JoinRequestNew",
    "JoinRequestDetail",
    "KybReview",
    "KybReviewDetail"
   ],
   "pageDir": "pages/join-requests",
   "summary": "The queue of businesses applying to join. You check seven things, then approve, reject or ask for information. Approval makes the business active and able to take live payments.",
   "articles": [
    "b05-02",
    "b05-03",
    "b05-04",
    "b05-05",
    "b05-10"
   ],
   "cards": [
    "sg-approve-join-request",
    "sg-reject-join-request"
   ],
   "situations": [
    "s-join-duplicate",
    "s-aml-match"
   ]
  },
  {
   "screenId": "Merchants",
   "routeNames": [
    "Merchants",
    "MerchantDetail",
    "Applications"
   ],
   "pageDir": "pages/merchants",
   "summary": "Look up a merchant, see its state and history, edit descriptive fields, submit sensitive changes for approval, suspend or reinstate it.",
   "articles": [
    "b05-01",
    "b05-08",
    "b05-09",
    "b04-02",
    "b04-04",
    "b03-10"
   ],
   "cards": [
    "sg-suspend-merchant",
    "sg-reinstate-merchant",
    "sg-edit-merchant-sensitive"
   ],
   "situations": [
    "s-merchant-restricted",
    "s-emergency-suspension",
    "s-token-leak"
   ]
  },
  {
   "screenId": "Wallets",
   "routeNames": [
    "Wallets",
    "WalletDetail"
   ],
   "pageDir": "pages/wallets",
   "summary": "Every merchant's wallet: live and checkpoint balance, the paginated statement of ledger postings, the shards behind the balance, assigned applications, cash-outs and status history. Freezing is immediate; restoring a frozen wallet needs a second person.",
   "articles": [
    "b03-09",
    "b05-06",
    "b04-04",
    "b08-07"
   ],
   "cards": [],
   "situations": []
  },
  {
   "screenId": "Approvals",
   "routeNames": [
    "Approvals"
   ],
   "pageDir": "pages/approvals",
   "summary": "Requests waiting for a checker. You see who proposed, what would change and why. Approving executes the change at once. You can never approve your own request.",
   "articles": [
    "b04-01",
    "b04-03",
    "b04-05",
    "b04-06"
   ],
   "cards": [
    "sg-approve-request",
    "sg-reject-request"
   ],
   "situations": [
    "s-approval-refused",
    "s-approval-expired",
    "s-wrong-approval"
   ]
  },
  {
   "screenId": "AmlCases",
   "routeNames": [
    "AmlCases"
   ],
   "pageDir": "pages/aml/cases",
   "summary": "Confidential compliance cases with severity and deadlines. An analyst proposes a resolution; the MLRO approves; only then does money move. Never discuss a case outside Compliance.",
   "articles": [
    "b09-05",
    "b09-06",
    "b09-08"
   ],
   "cards": [
    "sg-aml-propose-resolution"
   ],
   "situations": [
    "s-aml-match",
    "s-emergency-suspension"
   ]
  },
  {
   "screenId": "AmlScreenings",
   "routeNames": [
    "AmlScreenings"
   ],
   "pageDir": "pages/aml/screenings",
   "summary": "Results of name screening against official and internal lists. Each possible match must be decided with a written rationale.",
   "articles": [
    "b09-03",
    "b05-05"
   ],
   "cards": [
    "sg-aml-disposition"
   ],
   "situations": [
    "s-aml-match"
   ]
  },
  {
   "screenId": "AmlRules",
   "routeNames": [
    "AmlRules"
   ],
   "pageDir": "pages/aml/rules",
   "summary": "The rules that hold money and open cases. Every change needs the MLRO. Tightening may be immediate; loosening never skips review.",
   "articles": [
    "b09-04"
   ],
   "cards": [
    "sg-aml-rule-change"
   ],
   "situations": []
  },
  {
   "screenId": "AmlReports",
   "routeNames": [
    "AmlReports"
   ],
   "pageDir": "pages/aml/reports",
   "summary": "Draft, review and submit reports to the authority. A provisional rule can never produce a live filing.",
   "articles": [
    "b09-07",
    "b09-08"
   ],
   "cards": [
    "sg-aml-report"
   ],
   "situations": []
  },
  {
   "screenId": "AmlReportingStudio",
   "routeNames": [
    "AmlReportingStudio"
   ],
   "pageDir": "pages/aml/reporting-studio",
   "summary": "Upload and version the XML XSD and XLSX workbook contracts, map report fields, simulate output and submit schema changes for four-eyes approval.",
   "articles": [
    "b09-07",
    "b09-08"
   ],
   "cards": [
    "sg-aml-report"
   ],
   "situations": []
  },
  {
   "screenId": "Incidents",
   "routeNames": [
    "Incidents"
   ],
   "pageDir": "pages/incidents",
   "summary": "Operational incidents with a response timeline, responders, corrective actions, communications and the regulatory report. High-severity and security incidents need a postmortem before close.",
   "articles": [
    "b09-07",
    "b09-08"
   ],
   "cards": [],
   "situations": []
  },
  {
   "screenId": "FilingAdapters",
   "routeNames": [
    "FilingAdapters"
   ],
   "pageDir": "pages/filing-adapters",
   "summary": "The manual or HTTPS channel used to file an approved regulatory report. Manual remains the default; an HTTP adapter stores only an encrypted auth secret.",
   "articles": [
    "b09-07",
    "b09-08"
   ],
   "cards": [],
   "situations": []
  },
  {
   "screenId": "OperatorCases",
   "routeNames": [
    "OperatorCases",
    "OperatorCaseDetail",
    "GatewayInquirySchedules",
    "Transactions"
   ],
   "pageDir": "pages/operator-cases",
   "summary": "Tasks for payments and statement lines that need a human: unknown, conflict, mismatch, late success. Inquire first; resolve by hand only with evidence and a second person.",
   "articles": [
    "b07-03",
    "b07-04",
    "b07-08",
    "b07-09",
    "b03-11"
   ],
   "cards": [
    "sg-resolve-unknown",
    "sg-release-reservation",
    "sg-bulk-inquiry"
   ],
   "situations": [
    "s-unknown-attempt",
    "s-customer-deducted",
    "s-late-success",
    "s-conflict",
    "s-amount-mismatch"
   ]
  },
  {
   "screenId": "Disputes",
   "routeNames": [
    "Disputes"
   ],
   "pageDir": "pages/disputes",
   "summary": "Disputes and chargebacks with evidence deadlines. The system drafts the money movement; a human Finance checker must approve it.",
   "articles": [
    "b08-09",
    "b08-08"
   ],
   "cards": [],
   "situations": [
    "s-chargeback-arrives"
   ]
  },
  {
   "screenId": "Adjustments",
   "routeNames": [
    "Adjustments"
   ],
   "pageDir": "pages/adjustments",
   "summary": "Refunds, chargebacks, manual credits and debits and corrections. Always two people. An executed adjustment is never edited; it is offset by a new one.",
   "articles": [
    "b08-08",
    "b08-13",
    "b04-05"
   ],
   "cards": [
    "sg-propose-adjustment",
    "sg-reverse-adjustment"
   ],
   "situations": [
    "s-negative-balance",
    "s-wrong-approval"
   ]
  },
  {
   "screenId": "Cashouts",
   "routeNames": [
    "Cashouts",
    "CashOuts"
   ],
   "pageDir": "pages/cashouts",
   "summary": "Merchant payout requests. Check the bank snapshot, process, make the real transfer, and a different Finance user approves the subtraction.",
   "articles": [
    "b08-07",
    "b08-13"
   ],
   "cards": [
    "sg-process-cashout",
    "sg-reject-cashout"
   ],
   "situations": [
    "s-cashout-request"
   ]
  },
  {
   "screenId": "Reconciliation",
   "routeNames": [
    "Reconciliation"
   ],
   "pageDir": "pages/reconciliation",
   "summary": "Match a partner's statement file against our books. Problem lines open cases. Never edit a file to make it match.",
   "articles": [
    "b08-06",
    "b08-10",
    "b10-05"
   ],
   "cards": [
    "sg-run-reconciliation"
   ],
   "situations": [
    "s-statement-lines",
    "s-ledger-drift"
   ]
  },
  {
   "screenId": "Finance",
   "routeNames": [
    "Profitability",
    "Liquidity",
    "Invariant",
    "FinanceProfitability",
    "FinanceLiquidity",
    "FinanceInvariant",
    "PricingControls",
    "JournalEntries"
   ],
   "pageDir": "pages/finance",
   "summary": "Profit, cash cover and ledger integrity, all computed from the ledger. Any drift in the invariant is a priority-1 incident.",
   "articles": [
    "b08-05",
    "b08-11",
    "b10-05",
    "b03-13"
   ],
   "cards": [],
   "situations": [
    "s-ledger-drift",
    "s-restore-drill-failed"
   ]
  },
  {
   "screenId": "Gateways",
   "routeNames": [
    "Gateways",
    "CredentialSets"
   ],
   "pageDir": "pages/gateways",
   "summary": "The list of payment-company integrations. Create a gateway, open its wizard, or start the AI-assisted import. Gateways are versioned; the live version is never edited in place.",
   "articles": [
    "b06-01",
    "b06-13",
    "b06-14",
    "b06-16",
    "b03-12"
   ],
   "cards": [],
   "situations": [
    "s-credential-failing",
    "s-gateway-live-bad"
   ]
  },
  {
   "screenId": "GatewayWizard",
   "routeNames": [
    "GatewayWizard",
    "GatewayEdit"
   ],
   "pageDir": "pages/gateways/wizard",
   "summary": "The eight-step wizard that builds a gateway as a draft version. Nothing here changes live payments until a Security Admin approves and promotes it.",
   "articles": [
    "b06-13",
    "b06-03",
    "b06-04",
    "b06-06",
    "b06-16"
   ],
   "cards": [
    "sg-submit-gateway-version"
   ],
   "situations": [
    "s-amount-wrong",
    "s-reference-rejected",
    "s-gateway-live-bad"
   ]
  },
  {
   "screenId": "GatewayAiImport",
   "routeNames": [
    "GatewayAiImport",
    "AiImport"
   ],
   "pageDir": "pages/gateways/ai-import",
   "summary": "Draft a gateway with an AI assistant in your own browser. The platform verifies the result offline and saves it only as a draft. Never give the AI a real secret.",
   "articles": [
    "b06-14"
   ],
   "cards": [
    "sg-ai-import-draft"
   ],
   "situations": []
  },
  {
   "screenId": "Rails",
   "routeNames": [
    "Rails"
   ],
   "pageDir": "pages/rails",
   "summary": "What customers see and pick. A rail has a form, limits and a collection mode. A rail that was ever used is blocked, never deleted.",
   "articles": [
    "b06-11",
    "b06-05",
    "b06-02"
   ],
   "cards": [],
   "situations": [
    "s-method-missing"
   ]
  },
  {
   "screenId": "Routes",
   "routeNames": [
    "Routes",
    "GatewayRoutes"
   ],
   "pageDir": "pages/routes",
   "summary": "Connects a rail to a gateway with priority, cost, limits, health and scope. Changes alter which methods customers see and what fees apply.",
   "articles": [
    "b06-11",
    "b06-12",
    "b10-02"
   ],
   "cards": [
    "sg-edit-route"
   ],
   "situations": [
    "s-method-missing",
    "s-breaker-open"
   ]
  },
  {
   "screenId": "CheckoutHelp",
   "routeNames": [
    "CheckoutHelp",
    "SettingsCheckoutHelp",
    "AdminCheckoutHelp"
   ],
   "pageDir": "pages/settings/checkout-help",
   "summary": "The help and contact details payers see at checkout. Use official company contacts only, in Arabic and English.",
   "articles": [
    "b07-10"
   ],
   "cards": [],
   "situations": []
  },
  {
   "screenId": "Guide",
   "routeNames": [
    "AdminGuide",
    "AdminGuideBook",
    "AdminGuideArticle",
    "AdminGuideGlossary",
    "AdminGuideTools",
    "AdminGuidePlaybook",
    "AdminGuideCards",
    "AdminGuideEdgeCases"
   ],
   "pageDir": "pages/guide",
   "summary": "The Interactive Guide: books, glossary, tools, situations, checklists and the 140 edge cases.",
   "articles": [
    "b00-02",
    "b13-04"
   ],
   "cards": [],
   "situations": []
  },
  {
   "screenId": "Academy",
   "routeNames": [
    "AdminAcademy",
    "AdminAcademyTracks",
    "AdminAcademyTrack",
    "AdminAcademyModule",
    "AdminAcademyLesson",
    "AdminAcademyLab",
    "AdminAcademyExam",
    "AdminAcademyCertificate",
    "AdminAcademyTeam",
    "AdminAcademyHelp"
   ],
   "pageDir": "pages/academy",
   "summary": "The Employee Academy: lessons, labs and exams for your track.",
   "articles": [
    "b00-04",
    "b13-04"
   ],
   "cards": [],
   "situations": []
  },
  {
   "screenId": "SystemObjectStorage",
   "routeNames": [
    "SystemObjectStorage"
   ],
   "pageDir": "pages/system/object-storage",
   "summary": "Shared Object & Asset Storage console: inspect mTLS storage daemon health, browse encrypted objects and their active record locks, review AV quarantine items, place or lift legal holds, and audit every allowed or denied file read.",
   "articles": [
    "b12-12",
    "b12-13",
    "b12-10"
   ],
   "cards": [
    "sg-place-legal-hold"
   ],
   "situations": []
  },
  {
   "screenId": "SystemBackups",
   "routeNames": [
    "SystemBackups"
   ],
   "pageDir": "pages/system/backups",
   "summary": "Backup and disaster-recovery control: WAL archive lag, daemon and storage-target health, the backup schedule, scheduled backups and the latest restore drill with its three invariant checks. Viewing needs security:read or gateway:read; running a backup or a drill and proposing a policy change need security:write, and a policy change needs a second Security Admin.",
   "articles": [
    "b12-07",
    "b12-09",
    "b12-10",
    "b12-11"
   ],
   "cards": [
    "sg-trigger-backup",
    "sg-run-restore-drill",
    "sg-update-backup-policy"
   ],
   "situations": [
    "s-backup-daemon-unreachable",
    "s-wal-archive-lag-high",
    "s-restore-drill-failed"
   ]
  },
  {
   "screenId": "Reports",
   "routeNames": [
    "ReportsCatalog",
    "ReportsStudio",
    "ReportsChrome",
    "ReportsMerchantReports",
    "ReportsNeedsMigration",
    "ReportsChromeNeedsMigration"
   ],
   "pageDir": "pages/reports",
   "summary": "The reporting workspace: run a published report with its inputs and language, verify and publish a declarative report definition, manage reusable bilingual headers and footers, and oversee merchant-authored reports and their execution history.",
   "articles": [
    "b03-15",
    "b03-13",
    "b03-14"
   ],
   "cards": [],
   "situations": []
  },
  {
   "screenId": "General",
   "routeNames": [
    "Users",
    "Settings",
    "Profile",
    "AdminUsers",
    "AdminUserDetail",
    "AuditLog",
    "AdminPlatformSettings",
    "JobsOutbox"
   ],
   "pageDir": "(any other page)",
   "summary": "This screen is not described individually yet. Check your role and the environment badge, read before you click, and ask if unsure.",
   "articles": [
    "b03-02",
    "b03-03",
    "b03-06",
    "b03-07",
    "b03-08",
    "b03-14"
   ],
   "cards": [],
   "situations": [
    "s-approval-refused",
    "s-sandbox-live"
   ]
  }
 ]
}
```
@@end

## III-G. Quick answers

@@faq id=q-001 article=b07-03
Q: What does UNKNOWN mean?
We asked the payment company to take money and did not get a clear answer. We do not know whether money moved. Do not guess: press Inquire, then follow the UNKNOWN article.
@@end

@@faq id=q-002 article=b07-03
Q: Can I mark an old UNKNOWN as failed?
No. Age is not evidence. Resolve it by hand only with evidence from the partner (a statement line or a written reply) and a second person.
@@end

@@faq id=q-003 article=b07-12
Q: A customer says they paid but I see FAILED. What do I say?
Say you have no confirmed payment. Ask them to keep their receipt and reference, and not to pay again. Open a case. A late confirmation may still arrive.
@@end

@@faq id=q-004 article=b07-03
Q: Should I ask the customer to pay again?
No. If the first payment actually succeeded they would pay twice.
@@end

@@faq id=q-005 article=b07-12
Q: Can I confirm a payment from a screenshot?
No. Only a status you read in the platform counts. Screens on customers' phones can be faked.
@@end

@@faq id=q-006 article=b07-09
Q: What if the partner has no status question?
The screen will say an inquiry is not possible. Wait for the next statement, or ask the partner's support with our reference and the provider reference.
@@end

@@faq id=q-007 article=b07-06
Q: Why can't another customer pay a single-use link while one payment is unknown?
The first payment might have succeeded. The slot stays reserved so one invoice cannot be paid twice.
@@end

@@faq id=q-008 article=b07-07
Q: How many wrong OTP tries are allowed?
Three by default. The third wrong code fails the payment.
@@end

@@faq id=q-009 article=b07-08
Q: What is a late success?
A confirmation that arrives after the payment expired or failed. If the slot is free it is posted; if the link was already paid, the money is parked in SUSPENSE and a refund is drafted.
@@end

@@faq id=q-010 article=b07-08
Q: What happens when a webhook and an inquiry disagree?
Nothing is posted, the payment stays UNKNOWN and a priority-1 conflict case opens.
@@end

@@faq id=q-011 article=b06-04
Q: Why do amounts have three decimals?
One dinar is 1000 dirhams. Some partners use two decimals or whole dirhams, so the amount settings must be exact or the amount is 1000 times wrong.
@@end

@@faq id=q-012 article=b06-04
Q: A customer was asked for 1000 times the amount. What now?
Stop, treat it as P1, tell the Gateway Admin and Security Admin, pause the route and do not retry.
@@end

@@faq id=q-013 article=b06-12
Q: Why does a customer not see a payment method?
One of the nine visible-rails conditions fails. Walk down the table to find the first one.
@@end

@@faq id=q-014 article=b06-11
Q: What is a circuit breaker?
An automatic switch-off of a failing route. Customers stop seeing it and new payments use the next route. Only partner faults count, not customer mistakes.
@@end

@@faq id=q-015 article=b06-01
Q: Can I edit a live gateway?
No. Editing creates a new draft version. The live version stays untouched until the new one is approved and promoted.
@@end

@@faq id=q-016 article=b06-14
Q: Can I paste the partner's secret key into the AI?
Never. Give the AI only the names of the credentials. Type the real secrets into the platform afterwards.
@@end

@@faq id=q-017 article=b06-14
Q: Does an AI-generated spec go live automatically?
No. It arrives as a draft with a paused route and an untested credential set. It still needs the credential check, the 12 gates and a second person.
@@end

@@faq id=q-018 article=b06-16
Q: How many go-live gates are there?
Twelve. A version cannot go live until all pass.
@@end

@@faq id=q-019 article=b06-06
Q: Why do signatures fail?
Usually the key encoding, the field order or set, or the upper or lower case of the result.
@@end

@@faq id=q-020 article=b06-09
Q: Can an administrator read a stored secret?
No. Secrets are write-only: you can replace them but never read them back.
@@end

@@faq id=q-021 article=b04-01
Q: Why must a second person approve?
It catches honest mistakes, prevents one person acting alone, and creates a clear record of who proposed and who approved.
@@end

@@faq id=q-022 article=b04-03
Q: How long does an approval request last?
Seven days. After that it returns to draft and the maker must re-submit.
@@end

@@faq id=q-023 article=b03-07
Q: The system says Forbidden. What do I do?
The core refused: role, authority or the two-person rule. Do not retry or work around it. Ask your manager or the Security Admin.
@@end

@@faq id=q-024 article=b04-02
Q: What is the difference between descriptive and sensitive fields?
Descriptive fields (for example a trade name) are edited directly. Sensitive fields change money flow, compliance or attack surface and need two people.
@@end

@@faq id=q-025 article=b04-04
Q: What is an emergency suspension?
One authorised person suspends a merchant at once. A different Compliance user or the MLRO must ratify it within 24 hours. It stays in force if nobody does.
@@end

@@faq id=q-026 article=b04-06
Q: What makes a good reason?
What you checked, what you found, what you decided and why, written so a stranger can understand it months later.
@@end

@@faq id=q-027 article=b05-03
Q: How many checks does a join request review need?
Seven. All must be completed and recorded.
@@end

@@faq id=q-028 article=b05-03
Q: When does a second reviewer have to approve a join request?
When the platform setting requires it. The default risk-based policy requires it for high risk, an unclear screening result, a politically exposed owner, a high-risk category, high volume, a payout account mismatch or a previous rejection.
@@end

@@faq id=q-029 article=b05-06
Q: Why does an application have exactly one wallet?
So a payment can never be ambiguous about where its money goes.
@@end

@@faq id=q-030 article=b05-07
Q: Can I see a merchant's API token?
No. It is shown once to the merchant when created. Never ask for it.
@@end

@@faq id=q-031 article=b05-08
Q: What happens when a merchant is suspended?
New payments and cash-outs are blocked, tokens and POS screens return a neutral message, and the balance is kept.
@@end

@@faq id=q-032 article=b05-09
Q: A merchant asks why it was restricted. What do I say?
Say only that the account is restricted and to contact the support address in the notice. Never mention compliance or investigation.
@@end

@@faq id=q-033 article=b08-01
Q: What does double-entry mean?
Every movement is written on two sides that must add up. If they do not, the system refuses the entry.
@@end

@@faq id=q-034 article=b08-01
Q: Can a ledger entry be edited?
No. The ledger is append-only. A mistake is corrected by a new approved entry that offsets it.
@@end

@@faq id=q-035 article=b08-02
Q: How many kinds of GL account are there?
Eleven.
@@end

@@faq id=q-036 article=b08-03
Q: What is the difference between commission and gateway fee?
Commission is what we charge the merchant. Gateway fee is what the payment company charges us.
@@end

@@faq id=q-037 article=b08-05
Q: What does ledger drift mean?
The two sides of the ledger equation differ. It must always be zero. Any drift is a priority-1 incident and automatic payouts stop.
@@end

@@faq id=q-038 article=b08-06
Q: What is MISSING_AT_GATEWAY?
We say a payment succeeded but the partner's statement does not show it. This is the most serious reconciliation result.
@@end

@@faq id=q-039 article=b08-07
Q: Who approves the subtraction of a cash-out?
A different Finance user from the one who processed it.
@@end

@@faq id=q-040 article=b08-08
Q: How do I fix a wrong adjustment?
Never edit it. Propose a new adjustment that offsets it, which also needs approval.
@@end

@@faq id=q-041 article=b08-09
Q: Who approves a chargeback?
A human Finance checker. The system may draft it but can never approve it.
@@end

@@faq id=q-042 article=b08-13
Q: What if a chargeback is bigger than the merchant's balance?
If it would pass the merchant's negative-balance ceiling it does not post and a priority-1 case opens. Finance chooses to collect, net or suspend.
@@end

@@faq id=q-043 article=b09-01
Q: What is money laundering?
Making money from crime look like it came from a legitimate source, usually through placement, layering and integration.
@@end

@@faq id=q-044 article=b09-08
Q: What is tipping-off?
Telling someone, directly or by hint, that they are under suspicion or that a report exists. It is forbidden and can be a crime.
@@end

@@faq id=q-045 article=b09-08
Q: May Support see why a merchant is suspended?
No. Support can see that a merchant is suspended, never why.
@@end

@@faq id=q-046 article=b09-03
Q: What happens on a possible screening match?
A Compliance analyst decides each match. An applicant cannot be approved until then.
@@end

@@faq id=q-047 article=b09-05
Q: Who approves an AML case resolution?
The MLRO, never the same person as the analyst who proposed it. Money moves only after approval.
@@end

@@faq id=q-048 article=b09-07
Q: Can we file a report from a provisional rule?
No. The database refuses it. Until the Central Bank's requirements are confirmed the platform works in internal-only mode.
@@end

@@faq id=q-049 article=b09-10
Q: I think something is suspicious. What do I do?
Do not confront anyone. Write down the facts and tell Compliance the same day. Keep it confidential.
@@end

@@faq id=q-050 article=b10-01
Q: Which runbook do I use?
Use the table in the incident principles article: breaker for outages, RB-02 for signatures, RB-03 for UNKNOWN backlog, RB-04 for drift, RB-05 for credentials.
@@end

@@faq id=q-051 article=b10-05
Q: Why did payouts stop?
The ledger equation shows drift. Automatic payouts stop until the cause is understood and the drift is zero.
@@end

@@faq id=q-052 article=b10-07
Q: I think my password leaked. What now?
Tell the Security Admin immediately and change your password from a clean device. Do not wait to be sure.
@@end

@@faq id=q-053 article=b11-03
Q: Can I share my login with a colleague who is locked out?
Never. Ask the Security Admin.
@@end

@@faq id=q-054 article=b12-01
Q: Why can't I open the Back Office from home?
It is LAN-only by design. It is not reachable from the internet.
@@end

@@faq id=q-055 article=b12-06
Q: What is Fake Rails?
Our internal service that imitates payment companies for drills. It must never run in production.
@@end

@@faq id=q-056 article=b01-08
Q: What is the difference between sandbox and live?
Sandbox is a practice world; nothing real moves. Live is real money. Always check the badge before acting.
@@end

@@faq id=q-057 article=b13-04
Q: What if the guide and the screen disagree?
Stop and ask. Use Report a problem on the article.
@@end

@@faq id=q-058 article=b00-03
Q: What are the most serious breaches?
Sharing credentials, guessing on UNKNOWN and tipping-off.
@@end




@@article id=b12-12 book=12 order=12 title="Shared Object & Asset Storage: how files, locks, quarantine and retention work" roles=SECURITY_ADMIN,GATEWAY_ADMIN,COMPLIANCE,FINANCE minutes=4 ui=AVAILABLE related=b12-09,b12-10,b12-13
:::summary Big picture in 20 seconds
Every uploaded document, statement, report output and brand logo lives in the encrypted Shared Object Storage vault (`OBJECT_STORAGE_NODE`), never inside PostgreSQL table rows and never on individual core nodes.
:::

### Why files never live on core nodes or inside PostgreSQL
In a multi-node deployment, several `core-back` servers and a dedicated `backup-daemon` server work together. If `core-1` saved a KYB PDF on its own disk, `core-2` and `backup-1` could not read it. Therefore:
* The deploy engine requires a shared **Object Storage Node** (`OBJECT_STORAGE_NODE`, running `pg-object-storage-daemon` over mTLS on port `4095`). If someone configures multiple core nodes without `OBJECT_STORAGE_NODE`, deployment refuses to start (`MULTI_NODE_SHARED_STORAGE_REQUIRED`).
* Every file is encrypted in 64 KiB `AES-256-GCM` chunks (`pgos1`) with its own 256-bit Data Encryption Key (DEK) wrapped by the Key Encryption Keyring (`OBJECT_STORAGE_KEK_KEYRING`).
* PostgreSQL stores only the small control-plane ledger: `storage_objects`, `storage_object_locks` and `storage_object_access_logs`.

### Shared multi-record locks (`storage_object_locks`)
One file can be locked by more than one record at the same time. For example, a payment rail logo uploaded into the Asset Catalog (`CATALOG_ASSET`) and assigned to two payment rails (`RAIL_LOGO`) has three active locks.
* Database trigger `storage_objects_guard_trg` forbids deleting rows from `storage_objects` and forbids transitioning an object to `PURGED` while **any** active lock (`released_at IS NULL`) exists, while `legal_hold = true`, or while `retain_until` is in the future.
* When the last active lock is released, the object enters a 24-hour grace window (`gc_eligible_at`). After 24 hours (and after `retain_until` expires), `GcWorker` moves the ciphertext file to `.trash/YYYY-MM-DD/` for 7 days before permanent removal.

### Two-stage retention and malware quarantine
When a merchant or operator uploads a KYB document, dispute attachment or AML evidence file:
1. It is staged and bound in `QUARANTINE_PENDING_AV` state with `retain_until = NULL`. While in quarantine, nobody can download it (`423 STORAGE_OBJECT_QUARANTINED`).
2. `AvScanWorker` decrypts and scans the file. If clean, it promotes the object to `ACTIVE` and stamps its compliance retention window (`retain_until`). If infected, it releases the lock and marks the object `QUARANTINE_REJECTED` so malware never receives a 7-year compliance lock.
@@end

@@article id=b12-13 book=12 order=13 title="Operating the Object & Asset Storage screen: legal holds, KEK rotation and maintenance jobs" roles=SECURITY_ADMIN,GATEWAY_ADMIN,COMPLIANCE minutes=3 ui=AVAILABLE related=b12-12,b12-10,b12-11
:::summary Big picture in 20 seconds
Use `/system/object-storage` to inspect shared storage health, check active locks on any file, place or lift legal holds, and trigger maintenance jobs (`Integrity Scrub`, `KEK Rewrap`, `Lock Reconcile`, `GC`).
:::

### Who may do what on `/system/object-storage`
* **View health, objects, locks and access logs:** `system:storage:read`.
* **Place or lift a Legal Hold:** `system:storage:legal-hold` (Security Admin / Compliance).
* **Trigger maintenance jobs (`scrub`, `rewrap`, `reconcile-locks`, `gc`, `sweep`):** `system:storage:admin`.

### Placing and lifting a Legal Hold
During an investigation, dispute or audit, a Compliance or Security Admin can place a **Legal Hold** on any object with a mandatory written reason. While `legal_hold = true`, database trigger `storage_objects_guard_trg` and `GcWorker` refuse to purge the object even if all domain locks are released and `retain_until` has passed. Checklist: [[c:sg-place-legal-hold|Place or lift a storage legal hold]].

### Zero-downtime KEK key rotation (`RewrapWorker`)
When IT rotates `OBJECT_STORAGE_KEK_KEYRING` from `v1` to `v2`, the encrypted `.v1.enc` files on disk do not need to be rewritten. Running the **KEK Rewrap** job unwraps each object's 32-byte DEK with `v1` and re-wraps it with `v2` in `storage_objects`.
@@end

@@card id=sg-place-legal-hold title="Place or lift a storage legal hold" screen=SystemObjectStorage risk=HIGH irreversible=false
**What this does**
Freezes or unfreezes a stored object against garbage collection and purging.

**Check first**
- [ ] Confirm the exact `objectId` and inspect its active `storage_object_locks` holders first.
- [ ] Record the case reference or regulatory request ID in the legal hold reason.
- [ ] Confirm that the requester has the `system:storage:legal-hold` authority.

**Never**
- Never place a hold without a written reason and a case reference.
- Never lift a hold while the investigation or court order is still open.

**If you made a mistake**
Lift the hold with a correcting reason. The audit trail keeps both actions.
@@end

@@term slug=object-storage-vault term="Object Storage Vault" aliases="OBJECT_STORAGE_NODE;pg-object-storage-daemon" ar="خزنة تخزين الكائنات" related=storage-object-lock,legal-hold :: The dedicated mTLS service (`pg-object-storage-daemon`) that stores chunk-encrypted (`pgos1`) files shared across all core-back nodes and backup-daemon.

@@term slug=storage-object-lock term="Storage Object Lock" aliases="storage_object_locks;holder lock" ar="قفل كائن التخزين" related=object-storage-vault,legal-hold :: An append-only reference in `storage_object_locks` binding a business record (such as `KYB_DOCUMENT` or `RAIL_LOGO`) to a `StorageObject` so it cannot be purged while in use.

@@term slug=legal-hold term="Legal Hold" aliases="legal_hold" ar="حجز قانوني" related=object-storage-vault,storage-object-lock :: A compliance flag on `storage_objects` that freezes an asset against garbage collection or purging regardless of lock count or retention expiry.

@@faq id=q-059 article=b12-12
Q: Can two core-back servers store uploaded files on their own local disks?
No. Multi-node deployments must configure `OBJECT_STORAGE_NODE` so every core server and backup daemon reads and writes to the shared mTLS storage vault.
@@end

@@faq id=q-060 article=b12-13
Q: Why can't I download a newly uploaded KYB document right away?
It is in `QUARANTINE_PENDING_AV` until the antivirus scan worker verifies it is clean and promotes it to `ACTIVE`.
@@end

<!-- CONTENT:END -->
