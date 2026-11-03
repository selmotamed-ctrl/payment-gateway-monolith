# ADMIN INTERACTIVE GUIDE — COMPLETE DESIGN, IMPLEMENTATION SPEC & FULL CONTENT · VERSION 1.0

**Subtitle:** The employee-grade, zero-assumption, searchable reference for the whole Payment Gateway Platform — rebuilt from the ground up to replace the current `admin-front` `/guide`.

**Target repository:** `selmotamed-ctrl/payment-gateway-monolith` (primary work in `admin-front`, small supporting changes in `admin-back` and `core-back`, tests in `tests/`).
**Companion file:** `design/academy_system_design_and_content.md` (the Employee Academy). The Academy and this Guide share one progress record (defined in the Academy file, §A-3). **Implement Academy phase A-1 before Guide phase G-4.**
**Supersedes:** `design/payment_gateway_deployment_and_guides_architecture.md` §9, §10 and §11 for the Admin Guide only. The Merchant Guide (`merchant-front`) and the Checkout Help Center (`checkout-front`) are **out of scope** and must not be touched by this work.

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
5. **Verification procedure for content mismatches.** When implementing, you must open each screen file named in the *Screen-to-Article map* (§III-F.3) and compare the bold UI labels in the linked articles with the strings in the source. For each mismatch: (a) change **only the label text** inside the design file's article, (b) append a line to `design/guide_content_fixes.md` (`articleId | old label | new label | file:line`), (c) never change any explanation. If a statement of *behaviour* (not label) looks wrong, do **not** edit it: append it to `design/guide_content_questions.md` and continue. Never block on a content question.
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
design/guide_content_fixes.md, guide_content_questions.md   NEW (empty headers, filled per rule 5)
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

1. Locate the design file: `design/guide_system_design_and_content.md` (relative to repo root, found via `../design/` from `admin-front`). If absent: print an error and exit 1.
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
| Articles | 125 | `@@article` blocks |
| Glossary terms | 151 | `@@term` lines |
| Safeguard cards | 22 | `@@card` blocks (exactly the 22 ids in §II-7) |
| Safeguard checklist items | 99 | lines `- [ ] ` inside cards |
| Situations | 29 | `@@situation` blocks |
| Reading paths | 8 | `@@path` lines (`ALL` plus the 7 staff roles) |
| Quick answers (FAQ) | 58 | `@@faq` blocks |
| Data blocks | 3 | `ledger-events` (16 events), `visible-rails` (7 vectors), `attempt-transitions` |
| Context map screens | 23 | `screens` array of `context-map` |
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
* Acceptance: a test enumerates every named route in `router/index.ts` except `Login` and `NotFound` and asserts the name appears in some screen's `routeNames`; adding a screen without an entry fails the build. **Route names in the map are best guesses made without access to the router.** In phase G-4, for every router name that is not listed, add it to the `routeNames` of the screen whose `pageDir` matches the page file that route renders (changing only that list), append the change to `design/guide_content_fixes.md`, and if no screen fits add it to `General`. Never invent summaries, articles or cards.

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
* [ ] **G-6 Cleanup & audit.** Delete old `content.ts`; run the verification procedure of Part 0 rule 5 over all screens; fill `guide_content_fixes.md` / `guide_content_questions.md`; full test run; update `design/opencode_technical_delivery_design.md` §17 with a short note "Guide v1.0 replaced by design/guide_system_design_and_content.md".

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

In our platform both are just **routes** to the same customer-facing method, so Operations can switch between them without changing a single merchant link. That is why the platform separates the *door* (gateway) from the *button the customer sees* (rail) — see [[a:b02-06]].
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
A **password** proves you know something. **MFA** (multi-factor authentication) adds a second proof, usually a six-digit code from an app on your phone. Both are required for every admin here.

### One-time code (OTP)
An **OTP** is a code valid once for a short time. Customers get OTPs by SMS to confirm a payment. Staff use OTPs for MFA.

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
It is forbidden to tell a person or business that they are under suspicion or that a report exists. Everything we say to merchants and customers about restrictions is deliberately generic. See [[a:b09-08]].
:::
@@end

### BOOK 2 — THE PLATFORM MAP

@@article id=b02-01 book=2 order=1 title="The big picture: three audiences, one engine" roles=ALL minutes=1 ui=AVAILABLE related=b02-02,b02-03
Three groups of people use the platform. Each has its own website, but all three sit on top of **one engine** that holds the rules, the records and the connections to payment companies.

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

* **Payers** only pay. They never log in.
* **Merchants** run their business: links, balance, team, disputes, cash-outs.
* **Staff** (you) review merchants, handle exceptions, move money under two-person control, configure payment companies, watch risk.

The engine, called **core-back**, is the only part that can read or write the database, hold encryption keys, post to the ledger or call payment companies. Everything else must ask it, and it double-checks everything.
@@end

@@article id=b02-02 book=2 order=2 title="The seven services and why they are separated" roles=ALL minutes=2 ui=AVAILABLE related=b11-01,b12-01
The platform is seven programs (four "backs" that run on servers and three "fronts" that run in a browser).

| Program | Who uses it | Where it can be reached from | Can it touch the database? |
| :--- | :--- | :--- | :--- |
| `core-back` (port 4000) | Only our other programs | Private network only; never from the internet | **Yes — the only one** |
| `admin-back` (4101) + `admin-front` | Staff | Office network only (not forwarded by the router) | No |
| `merchant-back` (4102) + `merchant-front` | Merchants and their software | Public internet, encrypted | No |
| `checkout-back` (4103) + `checkout-front` | Payers and payment-company webhooks | Public internet, encrypted | No |

### Why so strict?
Imagine the public checkout website is attacked and an attacker takes it over. Because it holds **no database password, no encryption key, no ability to post money**, the attacker gets almost nothing. They would still have to defeat the core, which accepts only requests from programs that show the right digital ID card (mTLS) and then re-checks every detail itself.

### The Double-Check Rule
Even a request from our own admin program is not trusted. The core re-validates: the data shape, who the user is, what they are allowed to do, whether a maker is also trying to be the checker, whether a link really has that amount. If the outer program is wrong, hacked or buggy, the core still refuses.

:::tip What this means for you
If an action is refused with a message like "forbidden", the core made that decision. It is not a screen glitch. Do not look for another way around; see [[a:b03-07]].
:::
@@end

@@article id=b02-03 book=2 order=3 title="The life of a payment, step by step" roles=ALL minutes=3 ui=AVAILABLE related=b07-01,b06-04,b08-04
Follow one payment from start to finish. Each step names what the system **records**, because that is what you will later inspect.

1. **The merchant creates a payment link** with an amount and currency. *Recorded:* a payment link with a unique key. The amount lives here and nowhere else.
2. **The customer opens the link** on the checkout website. The checkout asks the core for the link. The core decides which payment methods (rails) to show using the *visible rails formula* (Book 7).
3. **The customer picks a method and fills a form** (for example mobile number). The browser sends only the link key, the method and the form values. **It never sends an amount.**
4. **The core runs guards** in one safe step: is the merchant active, is the customer sending too many requests, do cheap anti-money-laundering rules allow it, and is there still a free slot on this link? *Recorded:* a **payment attempt**, with the exact configuration versions it started with *pinned* to it, so later edits cannot change a payment in progress. A slot on the link is reserved.
5. **The engine starts the payment with the partner** (for example asks it to text an OTP). *Recorded:* each outgoing request and its cleaned (secrets removed) answer in the step log.
6. **The customer is told what to do next** (type the OTP, scan the QR, approve in the app).
7. **The customer completes it.** For an OTP rail, the engine sends the **confirm step**. This is the **money step**: it is never retried automatically.
8. **The partner answers** — success, a clear failure, or uncertainty (silence, an error, an unreadable answer). Rules map the partner's wording into our standard statuses. Uncertainty always becomes `UNKNOWN`.
9. **Trusted confirmation.** We only believe success when the server has verified five facts: the status is success; our reference matches; the amount matches (within a tolerance); the currency matches; the environment matches. Browser messages and return links are *hints* that make us ask the partner, nothing more.
10. **Posting.** In **one** database transaction the attempt becomes `SUCCEEDED` and the journal entry is written. Either both happen or neither.
11. **Everyone is told.** The customer's page updates live; a POS screen updates; the merchant is notified through a safe outbox so a message is never sent twice.
12. **Later, the partner settles to us.** Partners usually pay us in a batch days later (T+N). A **statement** arrives; we **reconcile** it against our records.
13. **The merchant requests a cash-out** of its wallet; Finance processes it under two-person control.

```diagram
Link → Visible rails → Guards → Attempt(pinned) → INITIATE → Customer acts → SUBMIT(money step)
   → verified? ── yes ─► SUCCEEDED + journal entry (one transaction) ─► notify
        │
        └─ unsure ─► UNKNOWN ─► inquiry / webhook / statement / operator decides
```
@@end

@@article id=b02-04 book=2 order=4 title="The life of a merchant" roles=ALL minutes=1 ui=AVAILABLE related=b05-01,b05-02
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

@@article id=b02-05 book=2 order=5 title="Who can see and do what: interfaces and confidentiality zones" roles=ALL minutes=2 ui=AVAILABLE related=b04-05,b09-08
### The interfaces
| Interface | Users | How they sign in | Purpose |
| :--- | :--- | :--- | :--- |
| Merchant Portal | merchants, staff, cashiers | phone/e-mail/Google + MFA | run the business |
| Checkout | anonymous payers | none; the link key is the key | pay |
| Back Office (this) | staff | username/password + MFA | operate and govern |
| Merchant API | merchants' software | `pg_live_` token, optional IP allow-list | automate links |
| POS screens | in-store displays | per-screen token, 15-minute idle limit | live payment display |
| Inbound callbacks | payment companies | signatures, IP allow-lists, secret path tokens | deliver verified events |

### Confidentiality zones (what you must not look at or say)
* **AML-CONFIDENTIAL:** screenings, matches, cases, reports. Only `COMPLIANCE`, `MLRO` and (for audit) `SECURITY_ADMIN`. `SUPPORT` can see *that* a merchant is suspended, never *why*.
* **Gateway cost and platform margin:** merchants never see them.
* **Secrets:** nobody can read a stored secret. You can only replace it.
* **Personal data:** national IDs, phone numbers, documents are encrypted, masked in lists, and every read is logged.

:::warning
If you can see something you believe you should not, close it and tell your manager. Do not copy it anywhere.
:::
@@end

@@article id=b02-06 book=2 order=6 title="The four layers: Gateway, Credential Set, Rail, Route" roles=ALL minutes=2 ui=AVAILABLE related=b06-01,b06-11,b06-12
Think of a restaurant that can be paid through several terminals.

| Layer | The restaurant analogy | In the platform | Screen |
| :--- | :--- | :--- | :--- |
| **Gateway** | one payment terminal and its manual | one technical door to one partner: web addresses, how we log in, the steps, how to read its answers | **Gateways** |
| **Credential Set** | whose merchant account and key card is in that terminal | the secret identifiers for one gateway in one environment, owned by the platform or by a merchant, with a *settlement target* (where the money lands) | (inside Gateway Wizard step 2) |
| **Rail** | the sign on the door: "Cards", "Mobile wallet" | what the customer sees and picks: name in Arabic and English, logo, the form they fill, limits | **Rails** |
| **Route** | the rule "for cards use Terminal A first, Terminal B if A is broken" | the link between a rail and a gateway through a credential set, with priority, cost, limits, health and scope | **Routes** |

Why four layers? Because things change independently: a partner changes its web address (edit the gateway), a merchant brings its own account (a new credential set), a new button for customers (a rail), or traffic must move from an aggregator to a direct partner (change the route) — and nothing else is touched. Links already created keep working.

**Settlement target** (who ends up holding the money):
* `PLATFORM_CLEARING`: the partner pays **us**; we credit the merchant's wallet.
* `MERCHANT_DIRECT`: the partner pays **the merchant** directly; we only record our commission as owed to us.
* `PROVIDER_HELD`: the partner holds the funds for now.
@@end

@@article id=b02-07 book=2 order=7 title="Where the information is kept: a plain tour of the database" roles=ALL minutes=2 ui=AVAILABLE related=b02-02
The database has **64 tables**. You never need their names to do your job, but knowing what kinds of things are stored makes sense of the screens.

| Group | Size | What it stores (in plain words) |
| :--- | :--- | :--- |
| **A. Business & money** | 18 | merchants, users, applications, wallets, tokens, payment links, POS, the ledger accounts and journal entries, commission and velocity rules, AML cases, adjustments, cash-outs, approval requests |
| **B. Gateway setup** | 6 | gateways, versions, environments and addresses, how to log in to partners, amount settings, credential sets |
| **C. What customers see** | 4 | logos, rails, form fields, routes |
| **D. The engine's recipes** | 13 | signing recipes, flows and steps, parameters, outputs, status and error mappings, confirmation channels, polling, widgets, redirects, statement parsers, manual-transfer instructions |
| **E. What happened** | 10 | attempts, step logs, incoming webhooks, operator cases, reconciliation, health samples, change logs, audit log |
| **F. People, compliance, disputes, settings** | 13 | identities, join requests, KYB documents, beneficial owners, screenings and matches, AML rules, reporting rules and reports, disputes, notification templates and notifications, platform settings |

Three properties matter to everyone:
1. **Money is stored with 4 decimal places** and never as a floating-point number.
2. **The ledger is append-only.** Nothing is ever edited or deleted; corrections are new entries.
3. **A merchant's balance is not a stored number.** It is calculated from the ledger lines, so it can never drift from the books.
@@end

### BOOK 3 — WORKING IN THE BACK OFFICE

@@article id=b03-01 book=3 order=1 title="Signing in, MFA, sessions, language and theme" roles=ALL minutes=1 ui=AVAILABLE related=b03-02,b11-03
1. Open the Back Office address your manager gave you. It only works from the office network (or an approved VPN). If it does not open from home, that is intentional.
2. Enter your e-mail and password. Then enter the six-digit **MFA** code from your authenticator app.
3. Sessions are short on purpose. If you are signed out, sign in again; do not ask anyone to extend it.
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
A role is only a label. What you can actually do is decided by your **authorities** — a list of specific permissions on your account. **An account with no authorities can do nothing**, whatever its role.

### Maker and checker switches
Two switches on your account decide whether you may *propose* sensitive changes (**maker**) and/or *decide* them (**checker**). Roles come with typical settings, but **your account's switches are what count**. You can never be both for the same request.

:::note How to find out what you can do
Your menu only shows screens you may open. Buttons you cannot use are hidden or refused. If you need something you cannot see, ask your manager; the Security Admin changes permissions under two-person control.
:::
@@end

@@article id=b03-03 book=3 order=3 title="The menu, screen by screen" roles=ALL minutes=2 ui=AVAILABLE related=b03-05,b13-02
| Section | Screen | What it is for | Typically used by | Read more |
| :--- | :--- | :--- | :--- | :--- |
| Overview | **Dashboard** | health at a glance | everyone | [[a:b03-05]] |
| Onboarding | **Join Requests** | review businesses applying to join | OPERATOR, COMPLIANCE | [[a:b05-03]] |
| Onboarding | **KYB Review** | check uploaded documents | COMPLIANCE, OPERATOR | [[a:b05-04]] |
| Onboarding | **Merchants** | look up, edit, suspend, reinstate | OPERATOR, COMPLIANCE, SUPPORT (read) | [[a:b05-08]] |
| Governance | **Approvals** | decide requests made by others | checkers | [[a:b04-03]] |
| Governance | **AML Cases / Screenings / Rules / Reports** | the compliance program | COMPLIANCE, MLRO | Book 9 |
| Operations | **Operator Cases** | stuck, conflicting or odd payments | OPERATOR | [[a:b07-04]] |
| Operations | **Disputes** | chargebacks and disputes | FINANCE | [[a:b08-09]] |
| Operations | **Adjustments** | refunds, chargebacks, corrections | FINANCE | [[a:b08-08]] |
| Operations | **Cash-Outs** | merchant payouts | FINANCE | [[a:b08-07]] |
| Operations | **Reconciliation** | match partner statements to our books | FINANCE | [[a:b08-06]] |
| Operations | **Checkout Help** | the help payers see at checkout | admins | [[a:b07-10]] |
| Finance | **Profitability / Liquidity / Invariant** | profit, cash cover, ledger integrity | FINANCE | [[a:b08-11]] |
| Gateways | **Gateways / Rails / Routes** | partner connections | GATEWAY_ADMIN | Book 6 |
| Learning | **Interactive Guide / Employee Academy** | this guide and training | everyone | — |

You only see the screens your authorities allow. A screen that is missing from *your* menu is not an error.
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

@@article id=b03-06 book=3 order=6 title="Safe-working habits that prevent most mistakes" roles=ALL minutes=1 ui=AVAILABLE related=b00-03,b04-06
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

@@article id=b03-07 book=3 order=7 title="When a button is missing or an action is refused" roles=ALL minutes=2 ui=AVAILABLE related=b02-02,b03-02
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

@@article id=b03-08 book=3 order=8 title="Features that do not have a screen yet" roles=ALL minutes=2 ui=PARTIAL related=b04-05
The design includes several controls that are **not yet available as Back Office screens**. When you meet one of these topics, you cannot do it yourself by clicking; here is who does it today.

| Capability | Status | Who performs it now |
| :--- | :--- | :--- |
| Creating or changing staff accounts, roles and authorities | no screen | Security Admin, through engineering tools under two-person control |
| Commission profile creation and changes | no screen | Finance proposes; engineering applies through the approval flow |
| Velocity rule changes | no screen | Finance/Compliance propose; engineering applies |
| Searching the audit log | no screen | Security Admin via engineering tools |
| Platform settings other than **Checkout Help** | no screen | engineering, under approval where the setting is sensitive |
| Statement source creation (the columns of a partner statement) | partial | Finance chooses an existing source in **Reconciliation**; new sources through engineering |

:::note
If the screens change, this article is updated. If an article elsewhere tells you to click something that is missing, treat it as this article's topic and ask.
:::
@@end

### BOOK 4 — GOVERNANCE: FOUR EYES

@@article id=b04-01 book=4 order=1 title="Why two people: the maker and checker rule" roles=ALL minutes=1 ui=AVAILABLE related=b04-02,b04-03,b00-03
### The idea
For anything that moves money, changes who gets money, or changes how risky payments are handled, **one person proposes (the maker) and a different person decides (the checker)**. This is called the **four-eyes principle**.

### Why it protects you as much as the company
* Honest mistakes are caught by a second pair of eyes.
* Nobody can quietly steal or bend the rules alone.
* If something later goes wrong, it is clear who proposed and who approved, and **what they were told**.

### How it is enforced (three independent layers)
1. The database refuses a request whose checker equals its maker.
2. The approval service checks it again in code.
3. The API middleware checks it a third time, regardless of what the screen sends.

:::danger Self-approval is impossible by design and forbidden by conduct
Trying to approve your own request, or asking a colleague to approve it unseen, is a serious breach even though the system will block the first attempt.
:::
@@end

@@article id=b04-02 book=4 order=2 title="Descriptive versus sensitive fields" roles=ALL minutes=2 ui=AVAILABLE related=b04-03,b05-06
Not every edit needs a second person. The system splits fields into two classes.

* **Descriptive**: harmless to money and risk (a trade name, a logo, a display name). Edited directly; the change is still recorded.
* **Sensitive**: changes money flow, compliance posture or attack surface. Needs maker + checker.

| Entity | Descriptive (direct, logged) | Sensitive (approval needed) |
| :--- | :--- | :--- |
| Merchant | trade name, display name, logo, support contact; contact phone/e-mail (after verifying the new value) | legal name, tax ID, registration no., business category, **payout bank details**, risk tier, KYB status override, commission-receivable ceiling, negative-balance ceiling, status |
| Application | name, description; expected volume (a big increase opens a review case) | **assigned wallet, rail whitelist, redirect-domain allow-list**, resuming after a platform pause |
| Wallet | — | status (currency can never change) |
| Staff user | name, language, notification preferences | role, authorities, maker/checker flags, application scope |
| Access token | create (needs fresh sign-in), revoke (immediate) | disabling the IP allow-list |
| POS | names, locations | — |

:::note
A pending sensitive change leaves the **current value in force** until it is approved and executed. Approved changes apply to **new** payments only; payments already in progress keep the configuration they started with.
:::
@@end

@@article id=b04-03 book=4 order=3 title="The life of an approval request" roles=ALL minutes=2 ui=AVAILABLE related=b04-06,b03-07
```diagram
DRAFT ──submit──► PENDING_REVIEW ──checker approves──► APPROVED ──executes atomically──► EXECUTED
   ▲                    │
   └────── REJECTED ◄───┘ (checker rejects with a reason; maker may re-draft)
```
* **Maker** creates a request holding a *diff* — exactly what would change, old value to new value — and a reason.
* **Checker** sees the diff, the reason and the field class. Approving **executes the change in the same step**, so an approved request never "hangs".
* **Stale requests:** if the item changed after the request was drafted (`base_version` no longer matches), the request is invalidated and returns to draft. This stops an old request from silently overwriting a newer change.
* **Expiry:** pending requests expire after 7 days and return to draft.
* **Withdrawing:** the maker may withdraw before a checker acts.
* **Rejecting** requires a written reason; the maker sees it.

On the **Approvals** screen you see requests that are waiting for a checker with their **Maker**, subject, **Details**, and the buttons **Approve** and **Reject** (with **Decision Reason**).

:::do Before you approve
Open **Details**. Compare old and new values. Check that the maker's reason makes sense. Check the merchant name, amount, currency. Then open the checklist [[c:sg-approve-request]].
:::
@@end

@@article id=b04-04 book=4 order=4 title="Emergency actions, ratification and the asymmetry principle" roles=ALL minutes=1 ui=AVAILABLE related=b05-08,b09-06
### The asymmetry principle
> Actions that **reduce risk** may happen immediately and be approved afterwards. Actions that **increase risk or move money** always need approval first.

| Reduces risk (may be immediate, then ratified) | Increases risk or moves money (approval first) |
| :--- | :--- |
| suspending a merchant | reinstating a merchant |
| tightening an AML or velocity rule | loosening a rule |
| pausing a route | releasing held money |
| | paying a cash-out; refunds; adjustments |

### Emergency suspension
An authorised user may suspend a merchant at once. The system creates a request in **emergency ratification** mode that must be reviewed within **24 hours** by `MLRO` or a *different* `COMPLIANCE` user. If nobody ratifies in time, alerts fire and the suspension **stays in force** (it fails safe, never open). It is never reversed automatically.

:::warning
"Immediate" does not mean "casual". Suspension stops a business from being paid. Use it when delay is the hazard, write the reason, and expect your decision to be reviewed.
:::
@@end

@@article id=b04-05 book=4 order=5 title="Who approves what: the four-eyes action matrix" roles=ALL minutes=2 ui=AVAILABLE related=b04-01,b03-02
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
| Staff account / role / authority change | SECURITY_ADMIN | a different SECURITY_ADMIN | permissions updated, sessions revoked |
| Compliance platform settings | COMPLIANCE, FINANCE | MLRO or SECURITY_ADMIN | new setting version |

:::note
Your real ability to act as maker or checker depends on the switches on your own account (article b03-02), not only on this typical table.
:::
@@end

@@article id=b04-06 book=4 order=6 title="Writing a reason that survives an audit" roles=ALL minutes=1 ui=AVAILABLE related=b04-03,b04-07
A reason is read months later by people who were not there: auditors, regulators, your successor, sometimes you. Write it so a stranger can understand it.

A good reason has four parts: **what you checked**, **what you found**, **what you decided**, **why**.

| Weak | Strong |
| :--- | :--- |
| "ok" | "Checked partner statement of 30 Oct: line for ref PA-7712 shows 100.000 settled. Matches our attempt. Marking resolved." |
| "as requested" | "Merchant asked by phone (call logged ticket 4471) to change payout account; new account letter attached and in merchant's legal name. Submitting for approval." |
| "customer paid" | "Customer sent bank transfer receipt; statement line not yet visible; keeping case open until next statement import on 1 Nov." |
| "rejected" | "Rejected: the new bank account is in a different person's name; no related-party documentation attached." |

:::dont Do not include
Passwords, OTPs, full card numbers, national ID numbers. And for AML matters, nothing a merchant could later read: the platform keeps AML notes confidential, but never write more than needed.
:::
@@end

@@article id=b04-07 book=4 order=7 title="Audit trails: what is recorded about every action" roles=ALL minutes=1 ui=PARTIAL related=b04-06,b11-03
Everything you do that changes something is recorded in three independent places:

* **Audit log**: who (user and role), what action, which object, the state before and after, the linked approval request, when. Cannot be edited.
* **Detail change log**: for every changed field, the old value and new value, who, when, from which route (portal, admin, API, system), the request id and IP. Support uses it to answer "what did this field say last month?". Secrets and national IDs are stored encrypted and shown masked.
* **Approval requests**: the maker, the checker, the reasons, the diff, the timing.

Payment activity has its own forensic trail: every outbound call to a partner is logged (secrets scrubbed) and every inbound webhook is stored *before* processing and never deleted.

:::note Searching these logs
A screen for searching the audit log is not yet available (article b03-08). Ask the Security Admin.
:::
@@end


### BOOK 5 — MERCHANTS

@@article id=b05-01 book=5 order=1 title="What a merchant is: states, risk tiers and what each state allows" roles=ALL minutes=3 ui=AVAILABLE related=b05-02,b05-08,b02-04
### Merchant, in one paragraph
A **merchant** is a business that has been checked by us and is allowed to take payments through the platform. Everything a merchant owns (wallets, applications, payment links, staff accounts, API keys) hangs under that one record. When you look up a merchant in the **Merchants** screen you are looking at the root of all of it.

### The five lifecycle states
A merchant is always in exactly one state. The state decides what the merchant can do.

| State | When a merchant gets it | New payments | Payments already in progress | Cash-out | API keys and POS | Balance |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `PENDING` | Registered, not yet approved | Blocked on `LIVE`; allowed on `SANDBOX` if the platform setting allows it (default: allowed) | none | Blocked | `SANDBOX` only | none |
| `ACTIVE` | Join request approved | Allowed | Normal | Allowed | Allowed | Normal |
| `SUSPENDED` | A staff member suspended it (reasons below) | Blocked | Payments already confirmed are posted according to compliance policy; payments still pending finish on the configuration they started with | Blocked | API keys return a generic error; POS screens show a neutral message | Kept, but frozen for payout |
| `REJECTED` | Join request rejected | Blocked | none | none | none | none |
| `CLOSED` | Merchant asked, or we decided, after the balance reached zero and no dispute is open | Blocked | Must be zero | One final payout, then blocked | Revoked | Must be zero; closure is refused otherwise |

Suspension always carries one reason code: `AML`, `FRAUD`, `KYB_EXPIRED`, `COMMISSION_CEILING`, `MERCHANT_REQUEST` or `OTHER`.

:::note Words that look similar
**`PENDING`** is a merchant state. **`PENDING_REVIEW`** and **`PENDING_CHECKER`** are approval states. They are different things on different screens. See [[a:b13-02]].
:::

### KYB status
Separate from the lifecycle state, every merchant has a **KYB status**: `UNVERIFIED`, `PENDING`, `VERIFIED` or `REJECTED`. A merchant becomes `VERIFIED` only when every *required* document is accepted and every beneficial owner has been screened and cleared (or a person has recorded a decision on each possible match). Overriding this status by hand is a **sensitive** edit and needs two people ([[a:b04-02]]).

### Risk tier
Each merchant has a **risk tier**: `LOW`, `STANDARD` or `HIGH`. The tier is our judgement of how risky the business is. It changes how strictly rules apply: higher tiers get lower hold thresholds, shorter review deadlines and more frequent KYB refreshes. The reviewer proposes the tier during onboarding; changing it later is a **sensitive** edit.

### Two ceilings you will see
* **Commission-receivable ceiling**: for merchants who receive money directly (see [[a:b08-10]]), the most commission we allow them to owe us before action is needed.
* **Negative-balance ceiling**: how far below zero a merchant's wallet may go after a refund or chargeback. The default for new merchants is `0`, meaning the wallet may not go negative. See [[a:b08-13]].
@@end

@@article id=b05-02 book=5 order=2 title="The onboarding journey and the join request state machine" roles=ALL minutes=4 ui=AVAILABLE related=b05-03,b05-04,b02-04
### The eight stages
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
A **join request** is the formal record of one onboarding attempt. A merchant can have several over time (for example one rejected, then a corrected one), but **only one may be open at a time**.

### The join request states
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

```diagram
DRAFT → SUBMITTED → IN_REVIEW ─┬─ approve (no second person) ───────────► APPROVED
                       ▲       ├─ approve (second person needed) ─► PENDING_CHECKER ─┬─► APPROVED
                       │       │                                                      └─► IN_REVIEW (checker returns it)
                       │       ├─ reject ───────────────────────────────────────────► REJECTED
              applicant│       └─ request information ─► INFO_REQUESTED ─► (applicant answers) ─► IN_REVIEW
              answers  │
        withdraw at any open stage ─► WITHDRAWN        30 days of inactivity ─► EXPIRED
```

### Rules worth memorising
1. Only one open join request per merchant.
2. `INFO_REQUESTED` pauses the deadline; the deadline is recomputed when the applicant answers. The default review deadline is **2 business days** for `LOW` or `STANDARD` proposed risk and **5 business days** for `HIGH`.
3. The applicant sees only the status and the information we asked for. **Reviewer notes and screening results are never shown to the applicant.**
4. A rejection carries a reason code from a fixed list (for example `INCOMPLETE_DOCUMENTS`, `UNVERIFIABLE_BUSINESS`, `PROHIBITED_ACTIVITY`, `POLICY`). Any code that could reveal a screening outcome is shown to the applicant as the neutral code `POLICY`.
5. A rejected applicant may apply again only after fixing the cause. A new request is linked to the old one, and duplicate checks apply ([[a:b05-10]]).
6. When approval needs a second person, approving and the second person's approval happen as one action, so an approved request never "hangs".
@@end

@@article id=b05-03 book=5 order=3 title="Working the Join Requests queue, step by step" roles=OPERATOR,COMPLIANCE minutes=4 ui=AVAILABLE related=b05-04,b05-05,b04-05
This article is for reviewers. You use the **Join Requests** screen.

### Before you start
* Check the **SANDBOX/LIVE** badge. Join requests concern real businesses, so you should be on the live side.
* Check the deadline column. Work the requests closest to their deadline first, but never skip a check to save time.

### The seven checks (you must complete all seven)
| # | Check | How to do it | What "good" looks like |
| :-- | :--- | :--- | :--- |
| 1 | Applicant identity verified | Open the applicant's contact details; confirm the phone or e-mail was verified at registration. | Identity shows as verified. |
| 2 | Business exists and is registered | Open the documents; compare names and numbers on the commercial registry certificate and tax certificate with the profile the applicant typed. | Legal name, registration number and tax ID agree everywhere. |
| 3 | Beneficial owners identified | Compare the declared owners with the articles of association. Anyone holding 25% or more (the default threshold) must be listed, and so must anyone who controls the business. | Every owner and controller is present and each has an identity document. |
| 4 | Screening result reviewed | Read the overall screening result. | `CLEAR`, or a possible match that Compliance has already decided. See [[a:b05-05]]. |
| 5 | Category and volume make sense | Compare the business category and expected monthly volume with the description of what is sold. | A bakery expecting a small monthly volume; not a bakery expecting the volume of a bank. |
| 6 | Payout account belongs to the business | Open the bank letter; the account holder must be the merchant's legal name (or a documented related party). | Names match. A mismatch forces a second person to approve, whatever the policy. |
| 7 | Risk tier proposed | Choose `LOW`, `STANDARD` or `HIGH` from what you saw. | A tier you can justify in one sentence. |

### Your four possible actions
1. **Request information.** Write exactly what is missing (for example "the bank letter is not signed"). Do not mention screening. The deadline pauses until the applicant answers.
2. **Reject.** Choose the reason code and write an internal note (see [[a:b04-06]]). Open the checklist [[c:sg-reject-join-request]] first.
3. **Approve.** Open the checklist [[c:sg-approve-join-request]] first. If the system says a second person is needed, the request moves to `PENDING_CHECKER`.
4. **Hand over.** If you cannot finish, leave a note and release the assignment so someone else can.

### When a second person is required
The platform setting `join_request.four_eyes_policy` has three values:

| Value | Meaning |
| :--- | :--- |
| `ALWAYS` | Every approval and every rejection needs a second reviewer. |
| `RISK_BASED` (recommended default) | A second reviewer is needed if **any** of these is true: proposed risk is `HIGH`; screening is not `CLEAR`; an owner is a politically exposed person; the business category is on the high-risk list; expected volume is above the configured threshold; the payout account does not match; the applicant was rejected before. Rejections of such cases also need a second reviewer. |
| `NEVER` | One reviewer decides. Not recommended for a regulated payment platform. |

The system records which triggers fired. You do not decide whether a second person is needed; the system does.

### What approval does (all at once, or not at all)
1. The join request becomes `APPROVED`.
2. The merchant becomes `ACTIVE`, KYB becomes `VERIFIED`, the risk tier is set.
3. Default velocity and AML posture for that tier applies automatically.
4. The platform's default commission profile is already in force, so rails become offerable as soon as the merchant creates an application.
5. Audit records are written.
6. An approval message is queued for the applicant.

If any part fails, nothing changes and the request stays as it was.

:::danger Never
Never tell an applicant that screening or compliance was part of a rejection or a request for information. See [[a:b09-08]].
:::
@@end

@@article id=b05-04 book=5 order=4 title="KYB documents and beneficial owners" roles=OPERATOR,COMPLIANCE minutes=3 ui=AVAILABLE related=b05-03,b05-10,b01-10
### What KYB documents are for
**KYB** (Know Your Business) is the checking of a business. The documents are the evidence. We never take a business's word for who it is.

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
1. Checks type and size limits.
2. Scans for viruses. A reviewer cannot open a file until it is clean.
3. Stores it encrypted with a fingerprint (`sha256`). Files are never overwritten; a replacement is a new file.
4. Records the expiry date if the document has one.
5. **Raises a duplicate flag if the same file was uploaded by an unrelated merchant.**

### Document statuses
| Status | Meaning |
| :--- | :--- |
| `UPLOADED` | Received, not reviewed. |
| `ACCEPTED` | A reviewer accepted it. |
| `REJECTED` | A reviewer rejected it, with a reason code. |
| `EXPIRED` | The expiry date passed. |

### Beneficial owners
A **beneficial owner** is a real person behind the business. The system records:
* anyone holding **25% or more** of ownership or voting rights (the default threshold, set by the platform setting `aml.owner_threshold_percent`), and
* anyone who **controls** the business (director, managing partner, authorised signatory).

If nobody reaches the threshold, the most senior manager is recorded as the controller and the reason is written down.

Each owner has a screening status: `NOT_SCREENED`, `CLEAR`, `POTENTIAL_MATCH` or `CONFIRMED_MATCH`. Names are stored in Arabic and, where available, Latin letters. National ID numbers are encrypted and shown masked.

### Changes after approval
Adding or changing an owner after approval is a **sensitive** change: it needs two people and triggers a new screening. History is kept; old owners are not deleted, they get an end date.

### What you must never do
* Never accept a document you cannot read, or that looks edited.
* Never accept an owner's national ID as proof of address.
* Never copy documents out of the platform to chat, e-mail or personal storage.
@@end

@@article id=b05-05 book=5 order=5 title="Screening during onboarding: what a reviewer may and may not do" roles=OPERATOR,COMPLIANCE minutes=2 ui=PARTIAL related=b09-03,b09-08,b05-03
### What screening is
When a join request is submitted, the platform automatically compares the business and its owners with sanctions lists, politically-exposed-person lists, adverse-media sources and our own internal watch-list. The possible overall results are:

| Result | Meaning | What happens next |
| :--- | :--- | :--- |
| `CLEAR` | No candidate matches. | The review continues normally. |
| `POTENTIAL_MATCH` | A name resembles a listed name. It may be a different person. | A **Compliance** analyst decides whether each possible match is a false positive, a true match or needs escalation. Until that is done the merchant **cannot be approved**. |
| `CONFIRMED_MATCH` | A person decided the match is real. | If it is a sanctions match, the merchant is suspended through the emergency path and the case goes to the MLRO. |
| `ERROR` | The screening provider was unavailable. | **Fail closed**: the request cannot be approved until screening succeeds. |

### Your role if you are an operator
* You may be able to see only the overall result. The details of matches are **AML-confidential** (Book 9).
* If the result is not `CLEAR`, do not approve and do not discuss it. Write in the internal notes that the request is waiting for Compliance, and let the second-reviewer rule do its work.
* Do not tell the applicant anything about screening. Use only generic wording such as "your application is under review".

### Your role if you are Compliance
Decide each possible match with a written rationale (see [[a:b09-03]]).

:::note Why this article is marked partial
The screening provider is a management decision that is still being made, and some screens may show less detail than described in Book 9. If a screen differs from this article, stop and ask.
:::
@@end

@@article id=b05-06 book=5 order=6 title="Applications and wallets: the rules that keep money pointing at the right place" roles=ALL minutes=2 ui=AVAILABLE related=b05-07,b04-02,b01-04
### The relationships
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
2. **The rail whitelist.** An application may list which payment methods (rails) it allows. *No list* means "all rails", but the other conditions of the visible-rails formula still apply ([[a:b06-12]]). *An empty list is refused*, because it would silently turn off payments. A payment link may **narrow** the application's list but never widen it.
3. **The redirect-domain allow-list.** After paying, a customer can be sent back to the merchant's website. Only domains on this list are allowed. Without it, an attacker could create a link that sends paying customers to a fake page.
4. **Descriptive versus sensitive.** Changing the application's name or description is direct. Changing the **assigned wallet**, the **rail whitelist** or the **redirect-domain allow-list** needs two people. Pausing an application is direct; resuming after the *platform* paused it needs two people. A large increase in expected volume opens a review case automatically.
5. **Approved changes affect new payments only.** A payment already started keeps the settings it began with.

### Wallets
A **wallet** is the merchant's balance on our books. It belongs to one merchant and one currency (`LYD`); the currency can never be changed. Only the wallet's **status** can be changed, and that needs two people. The balance is **calculated** from ledger lines every time it is displayed; it is not a stored number that someone could edit.
@@end

@@article id=b05-07 book=5 order=7 title="Payment links, POS terminals and API tokens" roles=ALL minutes=2 ui=AVAILABLE related=b05-06,b07-06,b07-11
### Payment links
A **payment link** is a request to pay one fixed amount. It has:
* a unique **key** (the secret part of its web address),
* an **amount** and **currency**, set by the merchant when the link is created and never taken from the customer,
* a **fee bearer** (who pays our commission; see [[a:b01-05]]),
* a **use limit**: **single-use** (one successful payment) or **multi-use** (a set number of payments, or unlimited),
* an optional **expiry**,
* an optional **redirect address** (only for single-use links, and only to an allowed domain),
* an optional **rail list** that can only narrow the application's list.

A link's state is `PENDING`, `COMPLETED`, `EXPIRED` or `CANCELLED`. The link keeps two counters: `confirmed_count` (payments that succeeded) and `active_locked_count` (payments started and not finished). The rule is that these two together may never exceed the use limit. That is the *slot reservation*, explained in [[a:b07-06]].

### POS terminals and screens
A **POS terminal** is a counter in a shop. A **POS screen** is a display paired to the terminal that shows the payment in real time (for example a QR code for the customer, and the result for the cashier). A screen that is idle for **15 minutes** is disconnected. The payment itself continues on the server; reconnecting shows the current state, and a cashier can look the payment up by its reference.

### API access tokens
A merchant's own software can create links through the Merchant API using a **token**:
* The token starts with `pg_live_`.
* It is **shown once**, when created, and never again. We store only a fingerprint.
* Creating a token requires the merchant user to sign in again.
* A token may be limited to listed IP address ranges. **Adding** addresses is direct; **turning the limit off** needs two people.
* Revoking is immediate.

:::warning If a merchant says "my token leaked"
Tell them to revoke it immediately in their portal and create a new one. Support staff never see token values and must never ask for one.
:::
@@end

@@article id=b05-08 book=5 order=8 title="The Merchants screen: look up, edit, suspend and reinstate" roles=OPERATOR,COMPLIANCE,SUPPORT minutes=2 ui=AVAILABLE related=b04-02,b04-04,b05-09
### Looking up a merchant
Search by name, tax ID or registration number. Open the record to see its state, KYB status, risk tier, applications, wallets and the **field history** (every past value of every field, with who changed it and when). `SUPPORT` can see descriptive data and field history only.

### Editing
* **Descriptive fields** (trade name, display name, logo, support contact): edit directly. The change is recorded.
* **Contact phone and e-mail**: edited directly, but the *new* value must first be verified with a code or link.
* **Sensitive fields** (legal name, tax ID, registration number, business category, payout bank details, risk tier, KYB status override, the two ceilings, status): use **Submit For Approval**, which creates a request for a second person. Open the checklist [[c:sg-edit-merchant-sensitive]] first. Until approved, the current value stays in force.

:::warning Payout bank details
The bank account must be in the merchant's legal name (or a documented related party). A mismatch forces a second person to approve regardless of any setting. Cash-outs already in progress keep the bank details they started with.
:::

### Suspending a merchant: **Suspend Merchant**
Suspension takes effect immediately by one authorised person, because delay is the hazard. It then needs a second person to **ratify** it within 24 hours ([[a:b04-04]]). Choose the reason code honestly and write the reason ([[a:b04-06]]). Open the checklist [[c:sg-suspend-merchant]] first.

What suspension does: new payments are blocked; cash-out is blocked; API tokens and POS screens return a neutral message; the balance is kept. A merchant notification is sent in generic wording. **If the cause is AML, the merchant's message contains no reason at all.**

### Reinstating a merchant: **Reinstate Merchant**
Reinstatement *increases* risk, so it always needs prior approval by a different `COMPLIANCE` or `MLRO` user. It is never an emergency action. Open the checklist [[c:sg-reinstate-merchant]] first.

### Closing a merchant
Closing is allowed only when the balance is zero and no dispute is open. A merchant with a negative balance cannot close until it is repaid or written off by an approved adjustment.
@@end

@@article id=b05-09 book=5 order=9 title="Helping a merchant safely: what to say and what never to say" roles=OPERATOR,SUPPORT,COMPLIANCE minutes=2 ui=AVAILABLE related=b09-08,b05-08,b03-04
### Principles
1. **Identify the person before you discuss anything.** Phone callers are not proof of identity. Ask the merchant to raise the request in their own portal where the system knows who they are.
2. **Use the reference, not the story.** Ask for the payment reference and look it up yourself.
3. **Say only what the screen says.** If you did not see it, do not say it.
4. **Never reveal AML, screening, risk tier, gateway cost or our margin.** Merchants do not see these.
5. **Never promise an outcome.** Say what you will check and when you will reply.

### Sentences you can use
| Situation | Safe wording |
| :--- | :--- |
| The merchant is suspended and asks why | "Your account is currently restricted. I cannot give further details. Please contact the support address in your notice." |
| A payment is in `UNKNOWN` | "We are confirming this payment with the payment company. It can take some time. Please do not ask the customer to pay again." |
| A payout is delayed | "Your request is in the review queue. I will tell you its current status." |
| The merchant asks about our fee | "Your commission for this payment was X. That is the rate agreed in your profile." |
| The merchant asks to change the bank account | "That change needs a written request in your portal and a second-person approval. It cannot be done by phone." |

### Sentences you must never use
* "You are under investigation."
* "Compliance flagged you."
* "The system thinks you are high risk."
* "Just give me your password / token and I will fix it."

:::danger Tipping-off
Even a hint that a review exists can be a crime. If you are unsure whether something may be said, say nothing and ask Compliance. See [[a:b09-08]].
:::
@@end

@@article id=b05-10 book=5 order=10 title="Re-application, duplicate detection and periodic KYB refresh" roles=OPERATOR,COMPLIANCE minutes=2 ui=AVAILABLE related=b05-03,b05-04
### Duplicate and related-party detection
On every submission the platform compares the applicant with all current and past merchants on these items: tax ID, registration number, an owner's national ID, payout bank account, phone, device fingerprint and document fingerprints. A match does **not** reject the applicant automatically. It:
* adds a second-person requirement,
* shows you the related records,
* raises the proposed risk tier by one level.

Links to related parties are kept after a rejection, so a rejected applicant cannot simply reapply under a new name.

### Periodic KYB refresh
* A document with an expiry date triggers notices 30 days and 7 days before it expires, then becomes `EXPIRED`.
* A merchant with a required document expired for more than 30 days is moved to `SUSPENDED` (`KYB_EXPIRED`), unless two people extend it.
* Re-verification happens every year for `HIGH`, every two years for `STANDARD` and every three years for `LOW` (configurable).
* A change of owner, legal name, payout account, business category, or a large jump in volume opens a manual review case and a new screening.

### Why it matters
Businesses change. A check done three years ago says nothing about who owns the business today.
@@end


### BOOK 6 — GATEWAYS, RAILS & THE ENGINE

@@article id=b06-01 book=6 order=1 title="Gateways in depth: kinds, statuses, versions and the Gateways screen" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=3 ui=AVAILABLE related=b02-06,b06-10,b06-13
### What a gateway record holds
A **gateway** is one technical integration with one outside system. The record holds: a unique **code** (for example `sadad`), a name, the operating company, the country, **aliases** (other spellings people use, such as `Edfali`, `Edfaa Li`, `Adfali`), a **kind**, a **verification state** and a **risk class**.

### The four kinds
| Kind | Meaning | Example |
| :--- | :--- | :--- |
| `DIRECT` | We connect to the payment company itself. | Moamalat, Sadad |
| `AGGREGATOR` | We connect to a company that offers many methods through one door. | DPay, Plutu, MyPay |
| `NATIVE_ADAPTER` | A built-in adapter for something that does not fit the declarative model. | rare |
| `INTERNAL` | A first-party system we operate ourselves. | NeomPay |

### Verification state and risk class
* **Verification state**: `VERIFIED` means its behaviour was confirmed from official documents or a public software kit. `UNVERIFIED` means it was built from a vendor page or partial information, so extra caution applies.
* **Risk class**: `NORMAL` or `HIGH_RISK`. A gateway is `HIGH_RISK` when it offers **neither** a signed webhook **nor** a way to ask for a payment's status. Going live with such a gateway needs a signed executive risk acceptance, mandatory statement reconciliation and extra operator approval above a threshold.

### Gateway status
`DRAFT` → `SANDBOX_VERIFIED` → `PENDING_APPROVAL` → `LIVE`; later it may be `SUSPENDED` or `RETIRED`.

### Versions: why a gateway is never edited in place
All the configuration of a gateway (addresses, steps, signing recipes, status rules and so on) is stored as an **immutable version**. A version is a sealed snapshot with a content fingerprint. Editing creates a **new draft version**; the live version is untouched until the new one is approved and promoted.

| Version state | Meaning |
| :--- | :--- |
| `DRAFT` | Being built. |
| `SANDBOX_VERIFIED` | Passed the test suite on sandbox. |
| `PENDING_APPROVAL` | Submitted; waiting for a `SECURITY_ADMIN` to approve. |
| `LIVE` | In use for new payments. |
| `SUPERSEDED` | Replaced by a newer live version. |
| `ROLLED_BACK` | Withdrawn in favour of its named rollback version. |

Every payment attempt records the version it started with. Promoting a new version affects **new** payments only; payments already started finish on the old version. That is how a configuration can change safely while money is moving.

:::tip On the Gateways screen
**New Gateway** creates a record and opens its wizard ([[a:b06-13]]). **Smart AI Integration** starts the AI-assisted import ([[a:b06-14]]).
:::
@@end

@@article id=b06-02 book=6 order=2 title="The nine collection modes in depth: what the customer does, what can go wrong" roles=GATEWAY_ADMIN,OPERATOR,SUPPORT minutes=3 ui=AVAILABLE related=b01-02,b06-07,b07-12
For each mode this article lists the customer's actions, how we learn the result, and the traps. "Hint" means a message that makes us **ask** the payment company; it never proves payment by itself.

| Mode | Customer does | How we learn the result | Traps |
| :--- | :--- | :--- | :--- |
| `OTP_PULL` | Types a phone number, receives an SMS code, types the code. | The confirm step answers immediately; some gateways also send a webhook; some offer a status question. | The confirm step is the money step. A timeout there is `UNKNOWN`, never "failed". Wrong codes are limited (default 3 tries). Some gateways have **no** status question, so only statements or an operator can settle doubt. |
| `REDIRECT` | Leaves our page, pays on the payment company's page, returns. | Signed webhook and/or a status question. The return to our page is only a hint. | The customer can close the browser and still have paid. The return address can be tampered with. |
| `EMBEDDED` | Pays inside a small window (lightbox or frame) on top of our page. | Webhook and/or status question. The window's own "done" message is only a hint. | Browser messages can be faked. Scripts for the window must be pinned and approved. |
| `PUSH_APPROVAL` | Taps **Approve** in their wallet app. | Webhook or polling. | Customer may approve after our time limit. That becomes a late success ([[a:b07-08]]). |
| `QR_DISPLAY` | Scans a QR code with a bank or wallet app. | Webhook, status question, and sometimes a short synchronous answer. | Same late-approval trap. QR codes expire. |
| `PAY_CODE` | Enters a short code in their app or sends it by SMS. | Webhook or statement. | Few gateways offer status questions. |
| `DEEP_LINK` | Taps a button that opens their wallet app. | Webhook or status question. Browser callback is a hint. | The app may not be installed. |
| `MANUAL` | Transfers money by bank or at an agent. A person confirms. | Statement or an operator. | Slowest and most error-prone. Always needs a reference the customer must copy exactly. |
| `HYBRID` | Chooses among several of the above. | Depends on the chosen sub-mode. | Each sub-mode has its own traps. |

### Which channels each mode may use
Every mode supports a different set of ways to confirm. The save-time checks of the wizard **reject** combinations that make no sense (for example a `MANUAL` rail with a webhook). Weak confirmation methods are always forced to also ask the payment company ([[a:b06-07]]).

### Time limits by mode (platform ceilings)
| Mode | Ceiling |
| :--- | :--- |
| `OTP_PULL` | 20 minutes |
| `REDIRECT` | 30 minutes |
| `QR_DISPLAY`, `PUSH_APPROVAL` | 15 minutes |
| `MANUAL` | as configured |

A gateway with a shorter session (for example 10 minutes) can only **tighten** the limit. The effective limit is always the smaller of the two.
@@end

@@article id=b06-03 book=6 order=3 title="The engine: ten phases, steps, side effects and the retry boundary" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=4 ui=AVAILABLE related=b06-04,b06-06,b06-17
### The idea: a recipe, not a program
Every gateway is described as a **recipe** that the engine (inside `core-back`) follows. Nobody writes code to add a gateway. The recipe is divided into **phases**, and each phase is an ordered list of **steps**.

### The ten phases
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

### Step types
`HTTP` (call a web address), `COMPUTE` (calculate something locally with no network call), `RENDER` (prepare what the customer sees), `WAIT`, `ASSERT` (stop if a condition is false), `BRANCH`.

### Four labels every HTTP step carries
| Label | Values | Meaning |
| :--- | :--- | :--- |
| `side_effect` | `READ_ONLY`, `SENDS_NOTIFICATION`, `MOVES_MONEY` | What the call can cause in the outside world. |
| `retry_policy` | `SAFE`, `SAFE_WITH_COOLDOWN`, `NEVER` | Whether the engine may repeat it. |
| `idempotency_config` | none, header, or body field | Whether the payment company guarantees that repeating a request has no extra effect, and how we send the key. |
| `point_of_no_return` | true or false | After this step, the customer cannot simply be told "try again". |

### The retry boundary (the most important engine rule)
A step that **moves money** must **never** be retried automatically after a timeout, a dropped connection or a server error. The reason: from our side, "the request never arrived" and "it arrived, money moved, and only the reply was lost" look the same. Retrying could pay twice. Instead the attempt becomes `UNKNOWN` and is resolved by asking ([[a:b07-03]]).

The save-time validator **refuses** a recipe where a money step is not `NEVER`-retry, unless the gateway supports an idempotency key and that has been proven.

### Where each value in a request comes from
Each field of a request has a **source**: the gateway's settings, the route's settings, the stored credentials, the attempt (amount, reference), a field the customer typed, a value saved by an earlier step, the answer of an earlier step, a constant, the current time, a random value, a computed value, or a **cryptographic signature**. A value from "the answer of an earlier step" can never be used on the first step; the validator rejects that.

### What comes out of a step
Values extracted from an answer are stored as: `STATE` (encrypted, kept on the attempt), `PUBLIC` (may be shown to the customer's browser), or special slots for the provider's reference, the settled amount, the provider fee and the network reference. A **required** value that is missing after a money step makes the attempt `UNKNOWN`, never `FAILED`.

### Time limits and size limits
Each outbound call has a time limit (10 seconds for authentication and status questions, 15 seconds for start, confirm and refund). Answers are read as plain text first, capped at 2 MB, and nested no deeper than 64 levels; XML external entities are disabled.
@@end

@@article id=b06-04 book=6 order=4 title="Amounts: scales, decimals, rounding and the 1000-times danger" roles=ALL minutes=2 ui=AVAILABLE related=b01-01,b06-05,b08-03
### Why this is dangerous
One dinar is 1000 dirhams. Payment companies disagree on how to write money:

| Style | 10.500 LYD is written | Used by |
| :--- | :--- | :--- |
| Three-decimal string | `"10.500"` | our own books, NeomPay |
| Two-decimal string | `"10.50"` | most mobile-wallet gateways |
| Integer of dirhams | `"10500"` | Moamalat |

If our system sends `10500` to a gateway that expects `10.50`, the customer is asked to pay **ten thousand five hundred dinars**. If it sends `10.50` to a gateway that expects dirhams, the customer pays **ten dirhams**. Both mistakes are 1000 times wrong, and both are silent.

### The amount pipeline
Every gateway has four amount settings:
* **scale**: multiply by 1, 100 or 1000 before sending,
* **precision**: how many decimals the wire format has (0, 2 or 3),
* **rounding**: `NONE`, `NEAREST`, `UP` or `DOWN` when precision is lower than three decimals,
* **format**: a decimal string, an integer in small units, or a number.

The platform keeps the amount as an exact decimal (four decimal places in the database) and converts only at the last moment.

### Worked rounding
A two-decimal gateway receives `76.255` LYD:
* rounding `NEAREST` gives `76.26`,
* rounding `DOWN` gives `76.25`,
* rounding `UP` gives `76.26`.

When the gateway's wire amount differs from our exact amount because of rounding, the difference is handled by the route's *mismatch policy*, not ignored.

### How it is tested
Before a gateway can go live, a **contract test** must pass using fixed examples such as `10.50 LYD → "10500"` for a dirham-integer gateway and `76.255 → "76.26"` for a two-decimal gateway with `NEAREST` rounding. This is one of the 12 go-live gates ([[a:b06-16]]).

### Try it
Use the sandbox below to see how a value changes at each operation. It is a teaching tool only.

{{widget:transform-sandbox}}

:::danger If a customer says "I was asked for a thousand times more" or "much less"
Stop. Do not retry. Report it as a P1 incident immediately ([[a:b10-01]]): the gateway's amount settings may be wrong.
:::
@@end

@@article id=b06-05 book=6 order=5 title="Customer forms: rail fields, normalisers and sensitivity" roles=GATEWAY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b06-04,b11-04
### What a rail field is
A **rail** (what the customer picks) has a small **form**: one **field** per thing the customer must enter, such as a mobile number, a birth year, an OTP code or a card ID.

### What each field defines
* a key (its internal name),
* a type: `phone`, `number`, `string`, `otp`, `birth_year`, `card_number`, `pan`, `from_list`,
* labels and placeholders in Arabic and English,
* rules: a pattern (regex), minimum and maximum length or value, whether it is required, its order on screen,
* a **normaliser**, which cleans the input before checking it,
* a **sensitivity** level.

### Normalisers
Customers type in many ways. Normalisers convert them to one form:
* `arabic_digits_to_ascii`: turns `٠٩١٢٣٤٥٦٧٨` into `0912345678`.
* `phone_normalize`: converts a phone number to one style: `LOCAL_09` (`0912345678`), `INTL_218` (`218912345678`) or `E164` (`+218912345678`), depending on what the gateway needs.

### Sensitivity levels
| Level | Meaning |
| :--- | :--- |
| `NORMAL` | Ordinary data. |
| `SENSITIVE` | Personal or wallet identifiers. Masked in logs and screens. |
| `PAN` | A full card number. Kept **in memory only** for the single outbound call and wiped immediately; never written to any database or log. A rail with a `PAN` field requires a separate PCI scope review before it can go live. |

### Why validation happens on our server
The form's rules are compiled into a checker inside `core-back`. The customer's browser may also check, but the server never trusts the browser.
@@end

@@article id=b06-06 book=6 order=6 title="Signatures and crypto profiles in practice" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b01-07,b07-05,b10-03
### What a crypto profile is
A **crypto profile** is a signing or checking *recipe*: which secret to use, how the secret is written, which fields to include, in what order, how to join them, which algorithm, and how to write the result. There are two kinds: **outbound signing** (we sign what we send) and **inbound verification** (we check what the payment company sends us).

### The settings that matter
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
When a payment company calls us, we also check: the secret path in the web address, the sender's IP address against an allow-list, a timestamp within 5 minutes, and that we have not seen this exact message before (duplicates are ignored for 7 days). Comparison of signatures is done in constant time so attackers cannot learn the answer by timing.

### Rotation without downtime
A credential set may hold two secret versions at the same time. During rotation both work, so no payments fail while the payment company switches.

### Try it
The lab below shows the exact text that is hashed. It uses example data only.

{{widget:crypto-lab}}

:::warning Secrets
Never type a real production secret into any tool, chat or this guide. Real secrets are entered only in the credential fields of the Gateway Wizard, and are write-only.
:::
@@end

@@article id=b06-07 book=6 order=7 title="Confirmation channels and how much each one is trusted" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b06-02,b07-05,b02-03
### The key rule
**We believe only what we can verify ourselves.** Anything a customer's browser tells us is a *hint* that makes us ask the payment company. A confirmation counts as trusted only after the server has checked five facts: the status is success, our reference matches, the amount matches (within the route's tolerance), the currency matches, and the environment (sandbox or live) matches.

### The channels
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
`HMAC_BODY`, `HASH_FIELDS`, `SORTED_VALUES_HASH`, `RSA` (strong); `SHARED_TOKEN`, `IP_ONLY`, and `NONE_PLUS_INQUIRY` (weak).

### The weak-channel rule
Weak methods (`SHARED_TOKEN`, `IP_ONLY`, return URLs and browser callbacks) are **forced to ask the payment company** before anything is believed (`must_inquire` is on). The wizard refuses to save a weak channel with that switch off.

### Polling policy
For rails that rely on asking, a polling policy sets: the first check after 5 seconds, then increasing waits, up to a maximum of 15 minutes, stopping early on a final state.

### What this means for you
If a customer says "my phone says Paid", the platform still waits for its own verification. See [[a:b07-12]].
@@end

@@article id=b06-08 book=6 order=8 title="Status rules and error maps: turning a partner's words into ours" roles=GATEWAY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b07-02,b13-01,b06-03
### The problem
Every payment company describes outcomes differently: "00", "Approved", "PAID", "ok". The platform needs one vocabulary.

### Status rules
A **status rule** looks at a value in the partner's answer and decides which of our five **canonical statuses** it means: `AWAITING_CUSTOMER`, `VERIFYING`, `SUCCEEDED`, `FAILED` or `UNKNOWN`. Rules are checked in order and **the first match wins**. If **no rule matches on a money step, the result is `UNKNOWN`**. A malformed answer, an unexpected answer and silence all end up as `UNKNOWN`. This is deliberate: when we do not understand, we do not guess.

### Error maps
An **error map** takes a partner's error code and gives it:
* a **canonical error** (our name for it),
* a **classification**: `RETRYABLE_OTP` (customer mistyped a code; they may try again), `TERMINAL_DECLINE` (final), `LIMIT_EXCEEDED` (customer or merchant limit), `GATEWAY_FAULT` (the partner is broken), `AMBIGUOUS` (we cannot tell),
* whether it counts toward the OTP lockout,
* whether it counts toward the **circuit breaker**,
* a message for the customer in Arabic and English,
* a hint for operators.

### Why the classification matters
A customer typing the wrong code ten times must never "break" a payment route. Only `GATEWAY_FAULT` and ambiguous results count toward the circuit breaker. Customer mistakes do not.
@@end

@@article id=b06-09 book=6 order=9 title="Credentials and Credential Sets: write-only secrets, ownership and settlement target" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b02-06,b10-06,b11-04
### What a credential set is
A **credential set** is the bundle of identifiers and secrets for one gateway in one environment (`SANDBOX` or `LIVE`): for example the merchant ID, the terminal ID and a secret key.

### Who owns it: `owner_type`
* `PLATFORM`: our own account with the payment company.
* `MERCHANT`: the merchant's own account (they entered it themselves).

### Where the money lands: `settlement_target`
| Value | Meaning |
| :--- | :--- |
| `PLATFORM_CLEARING` | The partner pays **us**; we credit the merchant's wallet. |
| `MERCHANT_DIRECT` | The partner pays **the merchant**; we record only our commission as owed to us. |
| `PROVIDER_HELD` | The partner holds the funds for the moment. |

### Status
`UNTESTED` (just saved), `VERIFIED` (the live credential check passed), `FAILING` (it stopped working; the route is automatically removed from selection), `REVOKED`.

### The rules that protect secrets
1. **Write-only.** You can replace a secret; nobody can read it back, not even an administrator.
2. **Encrypted at rest** with a key that exists only on the core server.
3. **Host-pinned.** A secret works only for the hosts listed for that gateway. If someone changed a step's web address to an outside host, the secret would not be supplied.
4. **Credential changes need two people** (`GATEWAY_ADMIN` proposes, `SECURITY_ADMIN` approves).
5. **Two merchants cannot register the same gateway account.**
6. **Sandbox and live never share** secrets, secret paths or webhook secrets.

### The live credential check
The **CREDENTIAL_CHECK** button on the wizard's second step makes one harmless call to prove the credentials work. A passed check moves the set to `VERIFIED`. A set that is not `VERIFIED` makes its route invisible to customers ([[a:b06-12]]).
@@end

@@article id=b06-10 book=6 order=10 title="Sandbox, live, rollback and what changes for new versus running payments" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b01-08,b06-01,b12-06
### Two environments per gateway
Each version has a `SANDBOX` environment and a `LIVE` environment. Each has its own web addresses, **allowed hosts**, **allowed sender IP addresses**, secrets and webhook secret path. A webhook that arrives at the wrong environment's address is rejected and raises an alert; a sandbox payment can never create a live ledger entry.

### The path to live
Build as a draft, test on sandbox, pass the automatic checks, name a rollback version, submit for approval, get approved by `SECURITY_ADMIN`, and then the version is promoted to live. The 12 gates are in [[a:b06-16]].

### Rollback
Every promotion names a **rollback version**: the version to return to if the new one misbehaves. Rolling back creates a new promotion in the opposite direction. Payments already running are not disturbed; they finish on the version they started with.

### Canary
Before sending all traffic to a new version, a **canary plan** limits it to a percentage of traffic or a list of merchants. A canary plan is a required gate.

### What changes immediately and what does not
| Change | Takes effect for |
| :--- | :--- |
| New live version | New payments only |
| New route priority, pause or resume | New payments only |
| Secret rotation | New calls; both versions work during the overlap |
| Pausing a route | Customers stop seeing it at once; running payments finish |
| Credential set `REVOKED` or route `DRAINING` | New payments only; running payments finish on their pinned settings |
@@end

@@article id=b06-11 book=6 order=11 title="Rails and Routes: priority, cost, limits, health, scope and the circuit breaker" roles=GATEWAY_ADMIN,FINANCE,OPERATOR minutes=2 ui=AVAILABLE related=b06-12,b10-02,b02-06
### Rails
A **rail** is what the customer sees and picks. It has a code, names in Arabic and English, a logo, a collection mode, a currency, minimum and maximum amounts, a display order, a **blocked** switch and capabilities (refund, partial refund, void, capture, recurring) with a refund window in days. A rail that was ever used is **never deleted**; use **blocked** instead. On the **Rails** screen, **Add Rail** creates one.

### Routes
A **route** connects one rail to one gateway through a credential policy. One rail may have several routes (for example a direct route and an aggregator route), and the platform chooses among them.

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

### The circuit breaker
The platform measures each route continuously: successes, definite failures, ambiguous results, rate-limit errors and response times. When a partner is failing, the **circuit breaker opens** automatically: the route's health becomes `OPEN_BREAKER`, customers stop seeing it, and new payments use the next healthy route. A small test call is repeated until the partner recovers. Only partner faults count; customer mistakes do not. The procedure for staff is [[a:b10-02]].

### Routes change money behaviour
Editing a route can change fees, limits and who sees a payment method. Route edits are guarded by a checklist ([[c:sg-edit-route]]) and credential, route and payout-bank edits need `SECURITY_ADMIN` approval.
@@end

@@article id=b06-12 book=6 order=12 title="The visible-rails formula: why a customer does or does not see a payment method" roles=ALL minutes=2 ui=AVAILABLE related=b02-06,b05-06,b07-12
When a customer opens a payment link, the core decides which payment methods to show. A rail is shown only if **every one** of the following conditions is true:

| # | Condition | In plain words |
| :--- | :--- | :--- |
| 1 | The application allows the rail | The merchant's application whitelist includes it (or has no whitelist). |
| 2 | The link allows the rail | The link's own list includes it (or has none). |
| 3 | A live commission profile covers it | We have an agreed fee for this merchant/application and rail at this amount. |
| 4 | At least one route is `ACTIVE` | |
| 5 | That route is `HEALTHY` | The circuit breaker is not open and it is not degraded. |
| 6 | The amount is inside the route's limits | Minimum, maximum, and the daily cap is not exceeded. |
| 7 | Not in a maintenance window, and the route's scope includes this merchant, application, risk tier and channel | |
| 8 | The route's credential set is `VERIFIED` | |
| 9 | The rail's currency matches the link and the rail is not blocked | |

The conditions on the route (4 to 8) must all be satisfied **by one single route**.

### Using this to diagnose
A merchant says "my customers cannot see Sadad". Walk down the table. The first failing line is the answer. Most often it is line 5 (breaker open), line 6 (amount above the maximum), line 3 (no commission profile for the amount) or line 1 (the application's list).

{{widget:visible-rails}}
@@end

@@article id=b06-13 book=6 order=13 title="The Add-a-Gateway wizard: all eight steps" roles=GATEWAY_ADMIN minutes=3 ui=AVAILABLE related=b06-14,b06-16,b06-03
Open **Gateways** and choose **New Gateway** (or open an existing gateway). The wizard has eight steps, in this order. Each step is saved as part of a **draft version**; nothing you do here changes a live payment.

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

Submitting step 8 is a guarded action: open [[c:sg-submit-gateway-version]] first. After submission a `SECURITY_ADMIN` reviews it. The **15 automatic scenarios** are: happy path; wrong code then success; expired code; insufficient funds; customer limit hit; cancel; server error on confirm; timeout on confirm; unreadable answer; duplicate webhook; out-of-order webhook; late webhook after expiry; amount mismatch; a three-decimal rounding case; and a webhook sent to the wrong environment.

:::note Save-time safety checks
The wizard refuses to save: a money step with automatic retry, an answer-based value on the first step, weak channels without verification, and web addresses to hosts that are not allowed.
:::
@@end

@@article id=b06-14 book=6 order=14 title="Smart AI Integration: adding a gateway with an AI assistant, safely" roles=GATEWAY_ADMIN minutes=3 ui=AVAILABLE related=b06-13,b06-16
### Why this exists
Filling the eight-step wizard from a long document by hand takes hours and typing mistakes are easy. **Smart AI Integration** lets you use any AI assistant **in your own browser** to draft the configuration, while the platform checks the result. The platform itself **never calls an outside AI** and never sends it any secret.

### The four stages
| Stage | Where | What happens |
| :--- | :--- | :--- |
| 1. Download the kit | Back Office | The platform generates one document (the *kit*) from its own live rules: the exact format the AI must produce, the allowed lists, two complete examples, and a place to paste the partner's documents. |
| 2. Ask the AI | Your browser, outside the platform | You give the AI the kit plus the partner's documents. It returns one file, `integration-spec.json`. |
| 3. Upload and verify | Back Office | The platform checks the file in four layers (below). If it fails, it gives you a ready-made **repair message** to paste back to the AI. |
| 4. Add secrets and import | Back Office | You type the real secrets into the platform; it saves the whole configuration as a **draft** and runs the credential check. |

### The four verification layers
1. **Schema and version**: the file has the right shape and version.
2. **Meaning and security**: web addresses use `https`, point only to allowed hosts and never to private network addresses; no value from an earlier answer on the first step; money steps never retry; every signature refers to a declared recipe; weak channels must ask the partner; at least one test example is included.
3. **Offline simulation**: the platform runs the real engine against the **sample requests and answers inside the file itself** and checks that the result matches what the file claims: the final status, the extracted values, the signature and the amount sent. No network and no database are used.
4. **Collision check**: whether a gateway or rail with that code already exists, so you can choose *Create New* or *New Version*.

### Safety rules you must follow
1. **Never paste a real secret into the AI.** Give it only the *names* of the credentials (or dummy sandbox values). The file declares which credentials are needed; you type the real values into the platform afterwards.
2. **Everything arrives as a draft.** The version is `DRAFT`, the route is `PAUSED`, the credential set is `UNTESTED`. It still needs the live credential check, the 12 gates and a second person.
3. **Read the preview.** The platform shows what will be created. Compare it with the partner's document yourself.
4. Some step types (`WAIT`, `ASSERT`, `BRANCH`) cannot be imported; add them in the wizard's flow editor afterwards.

Creating the draft is a guarded action: open [[c:sg-ai-import-draft]] first.

:::warning The AI can be confidently wrong
Test vectors catch many mistakes, but an AI can invent a selector or the wrong amount scale in a way a weak example would not expose. The 12 gates and the human reviewer are still required.
:::
@@end

@@article id=b06-15 book=6 order=15 title="Direct, aggregator and first-party: the gateway landscape and evidence levels" roles=GATEWAY_ADMIN,OPERATOR,SUPPORT minutes=3 ui=AVAILABLE related=b01-03,b06-01,b06-16
The platform's design covers twenty integrations. This table is a map, not a promise that each is live today: what is live depends on what your administrators have configured and approved. Use it to understand the *shape* of each.

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
Each gateway carries an **evidence level** describing how well its behaviour is known:
* `VERIFIED` (from official documents or a public software kit),
* `PARTIAL`,
* `UNVERIFIED` (vendor page only),
* `INTERNAL (FIRST-PARTY)` (our own system, tested against the operator's staging environment).

A gateway that is not `VERIFIED` needs extra evidence or a signed risk acceptance before going live (gate 9, [[a:b06-16]]).
@@end

@@article id=b06-16 book=6 order=16 title="The twelve go-live gates, in plain words" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b06-13,b06-10,b13-05
A gateway version cannot become `LIVE` until **all twelve** gates pass.

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

:::note Who checks what
Gate 1 is enforced by the database, the approval service and the API; you cannot bypass it. Gates 2 to 5 are run by the platform; you read the results. The rest are confirmed by the approver. Never approve a version for which you did not read the gate results.
:::
@@end

@@article id=b06-17 book=6 order=17 title="Fourteen engine safeguards in plain language" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b06-03,b11-01
These protect the engine even if someone makes a configuration mistake or an outside party misbehaves. You do not operate them, but knowing them explains many refusals.

| # | Safeguard | What it prevents |
| :-- | :--- | :--- |
| 1 | Safe path-setting for building requests | A crafted field name corrupting the program's own data. |
| 2 | One shared, cached connection per gateway account | Duplicate connections and runaway timers under load. |
| 3 | Single refresh of an expired token | A stampede of token requests when many payments hit an expired token at once. |
| 4 | Randomised token refresh timing | Every server refreshing at the same moment. |
| 5 | Saving a new refresh token before using it | Losing a login session after a restart. |
| 6 | A time limit on every outbound call | A stuck partner freezing us. |
| 7 | No automatic retry of money steps | Paying twice. |
| 8 | Reading answers as text first, with size limits | Oversized or malicious answers; XML attacks. |
| 9 | Removing secrets from every log | Secrets ending up in logs. |
| 10 | Blocking requests to private addresses, and checking redirects | A configuration being used to attack our own network. |
| 11 | Secrets tied to allowed hosts | Stolen or misdirected secrets. |
| 12 | Broadcasting changes to every server within seconds | Servers disagreeing about the current configuration. |
| 13 | Correct escaping for each destination (JSON, XML, address, header) | Injection of extra fields or commands. |
| 14 | Re-checking the final web address after substitution | A value turning a safe address into a dangerous one. |

A fifteenth safeguard applies between our own services: each service proves its identity with a certificate, and the core re-checks everything it is sent ([[a:b02-02]]).
@@end


### BOOK 7 — PAYMENTS IN OPERATION

@@article id=b07-01 book=7 order=1 title="Reading a payment: references, amounts and every field you will see" roles=OPERATOR,SUPPORT,FINANCE minutes=3 ui=AVAILABLE related=b07-02,b01-05,b02-03
### One word: attempt
Each time a customer tries to pay a link, the platform records a **payment attempt**. A link can have several attempts (the customer tried twice; a first try failed). The things you inspect are attempts.

### The references (never confuse them)
| Field | Whose number it is | Use it for |
| :--- | :--- | :--- |
| Reference | Ours | Quoting to anyone, including partners. Unique. |
| Gateway reference | The one we send to the partner as our identifier | Matching with the partner's records. |
| Provider reference | The partner's own transaction number | Asking the partner about this payment. |
| Network reference | A third network's number (for example a card switch) | Card disputes. |

### The amounts (all in LYD with up to four decimals)
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

### Other fields
* **Environment**: `SANDBOX` or `LIVE`. Check it first.
* **Mode** and sub-mode: the collection mode used.
* **Status** and **substatus**: the state ([[a:b07-02]]) with a more precise reason, for example `OTP_REQUIRED`.
* **OTP attempts**: how many code tries were used.
* **Expires at** and **grace expires at**: the payment's time limit, and the later time until which a late confirmation is still accepted ([[a:b07-06]]).
* **Pinned configuration**: the gateway version, route, credential set and commission profile this attempt started with. They never change for this attempt.
* **Customer fields (masked)**: what the customer typed, with sensitive parts hidden.

### The step log
Each outbound call to the partner is recorded with the request (secrets removed), the answer text, the HTTP status, the duration and the outcome. When something is unclear, the step log is the evidence.

:::tip Quote the reference
When you speak to a partner or a colleague, say the reference. Never identify a payment by the customer's name.
:::
@@end

@@article id=b07-02 book=7 order=2 title="The fourteen payment states, one by one" roles=ALL minutes=3 ui=AVAILABLE related=b07-03,b07-06,b13-02
Every attempt is in one of **14 states**. The first eleven describe progress; the last three describe what happened after success.

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
| `EXPIRED` | The time limit passed with no confirmation (after a last check with the partner). | Released | No | Nothing; a late success can still arrive ([[a:b07-08]]). |
| `CANCELLED` | Cancelled by the customer or by the system. | Released | No | Nothing. |
| `BLOCKED` | A guard stopped it (velocity limit, watch-list, AML rule, merchant not allowed). The customer sees only "cannot process this payment". | Released | No | Never explain the real reason to the customer. |
| `PARTIALLY_REFUNDED` | Part of a successful payment was returned. | Used | Yes, refund posted | See Book 8. |
| `REFUNDED` | The whole payment was returned. | Used | Yes, refund posted | See Book 8. |
| `DISPUTED` | A dispute or chargeback was opened. The payment is not "undone"; the dispute is handled separately. | Used | Yes | See [[a:b08-09]]. |

### Three rules about movement
1. **Forward only.** `SUCCEEDED` is never changed back to a failure by a later event. If two trusted sources disagree, the attempt freezes in `UNKNOWN` and a priority-1 conflict case opens.
2. **Uncertainty never becomes failure.** A timeout, an unreadable answer or an unexpected answer is `UNKNOWN`, never `FAILED`.
3. **Success and the ledger entry happen together or not at all.** There is no state where an attempt is `SUCCEEDED` without its journal entry.

### Try the state machine
Click events and watch the state, the link slot and the money.

{{widget:attempt-states}}
@@end

@@article id=b07-03 book=7 order=3 title="UNKNOWN: what it means and exactly what to do" roles=ALL minutes=4 ui=AVAILABLE related=b07-04,b07-09,b10-04,b00-03
This is the most important operational article. Read it twice.

### What `UNKNOWN` means
We asked a payment company to take money, and we did **not** receive a clear answer. The request may never have arrived. It may have arrived and the money moved, but the reply was lost. **From our side, these cases look identical.** So the platform records exactly that: *we do not know*.

### What `UNKNOWN` holds
* The **link slot stays reserved**. A single-use link cannot be paid again by another attempt while this one is unresolved. This prevents two payments for one invoice.
* **No money is posted.** The merchant's balance does not change.
* The attempt continues to be watched: the platform keeps asking the partner, listens for its webhook, and waits for the settlement statement.

### Why guessing is dangerous
| If you guess... | ...and you are wrong | Result |
| :--- | :--- | :--- |
| "Failed", and ask the customer to pay again | The first payment actually succeeded | The customer paid **twice**. |
| "Succeeded", and the merchant ships the goods | The money never moved | The merchant **lost goods** and we owe money we do not have. |
| Re-send the OTP or press confirm again | The first confirm worked | A **second** payment is started. |

### What the platform does on its own
1. Asks the partner again, with increasing delays, if the partner offers a status question.
2. Accepts a signed webhook from the partner.
3. Compares against the partner's settlement statement when it arrives.
4. Opens an **operator case** with a deadline.

### What you do (operators)
1. **Check the environment badge.** `SANDBOX` cases do not matter to real money.
2. **Open the case** in **Operator Cases**. Read the step log: what did we send, what came back, how long it took.
3. Press **Inquire** on the attempt. This asks the partner for the real status ([[a:b07-09]]). If the partner clearly answers, the platform resolves the attempt itself. You do not need to do anything else.
4. If the partner has **no status question** (some wallets do not), do not keep pressing. Note the reference, and wait for the next statement ([[a:b08-06]]) or contact the partner's support quoting the **provider reference** and **our reference**.
5. Resolve by hand **only** when you have **evidence** from the partner (a statement line, a written reply). Choose **Mark succeeded** or **Mark failed** and write a reason ([[a:b04-06]]). This is a two-person decision. Open the checklist [[c:sg-resolve-unknown]] first.
6. If you have evidence that the customer was **not** charged and the link must be freed, use **Release reservation** with its checklist ([[c:sg-release-reservation]]).

### What you tell people
| To the customer | "We are confirming your payment with your payment provider. Please do not pay again. We will update you." |
| :--- | :--- |
| To the merchant | "This payment is being confirmed with the payment company. It is not yet counted as paid." |

### What you must never do
* Never mark it failed because it is old.
* Never ask the customer to pay again.
* Never re-send an OTP or repeat the confirm.
* Never resolve it from a screenshot or a phone call.

### How long is normal?
The target is that **95% of `UNKNOWN` attempts are resolved within 24 hours**. A rising number or an old one on the dashboard is a warning; follow [[a:b10-04]].

:::danger The rule
`UNKNOWN` means we do not know. Do not guess. Use **Inquire**, then follow this article.
:::
@@end

@@article id=b07-04 book=7 order=4 title="The Operator Cases screen: kinds, priorities, deadlines and resolutions" roles=OPERATOR,FINANCE,SUPPORT minutes=3 ui=AVAILABLE related=b07-03,b07-08,b07-09
### What an operator case is
An **operator case** is a task created by the system when a payment or a statement line needs a human. Each case has a kind, a priority, a deadline and an owner.

### The seven kinds
| Kind | Created when | Typical action |
| :--- | :--- | :--- |
| `UNKNOWN` | An attempt is in `UNKNOWN`. | Inquire; follow [[a:b07-03]]. |
| `HELD` | Money is being held (for example by an AML rule). | Follow the instruction in the case. AML holds are decided by Compliance and the MLRO. |
| `CONFLICT` | Two trusted sources disagree (for example a webhook says paid, an inquiry says failed). Priority 1. | Do not resolve alone; escalate. |
| `MISMATCH` | The partner's amount or currency differs from ours. | See [[a:b07-08]]. |
| `LATE_SUCCESS` | A confirmation arrived after the payment had expired or failed. | See [[a:b07-08]]. |
| `MANUAL_REVIEW` | Something needs a person's judgement (for example a big volume jump). | Review as instructed in the case. |
| `UNMATCHED_STATEMENT` | A statement line matches none of our payments. | Reconciliation ([[a:b08-06]]). |

### Priority
`P1` (highest), `P2`, `P3`. Each case has a deadline (**SLA**). Work the highest priority and nearest deadline first. Leave a handover note for any case still open at the end of your shift ([[a:b10-08]]).

### States
`OPEN` → `IN_PROGRESS` → `PENDING_CHECKER` (waiting for a second person) → `RESOLVED`.

### The actions on the screen
* **Inquire**: ask the partner for the status of one attempt.
* **Bulk Inquiry**: ask the partner about many attempts at once, for example after an outage. Use it carefully: it sends many calls to the partner. Open the checklist [[c:sg-bulk-inquiry]] first.
* **Resolution**: record how the case ended. For an `UNKNOWN` case the choices are **Mark succeeded**, **Mark failed**, and **Release reservation**. Each needs a written reason and a second person.

### Rules
1. **Assign the case to yourself** before working it, so two people do not act on the same item.
2. **Write what you did** in the resolution notes as you go.
3. **A resolution is a money decision.** A wrong "succeeded" credits money that never arrived; a wrong "failed" can lead to a second payment.
4. **If evidence is missing, leave the case open** and escalate. Leaving it open is safe; guessing is not.
@@end

@@article id=b07-05 book=7 order=5 title="Webhooks and the inbox in operation" roles=OPERATOR,GATEWAY_ADMIN,SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b06-07,b10-03,b01-06
### What happens when a partner calls us
1. The call arrives at a **secret address** that belongs to one gateway and one environment.
2. The raw message is **stored first**, exactly as received, before anything else happens. Nothing is ever deleted from this inbox.
3. The platform answers the partner quickly with the reply the partner expects (in a few milliseconds), so the partner does not keep retrying.
4. A background worker then checks the signature, the sender's IP address and the timestamp, works out which payment it belongs to, and decides what it means.
5. Duplicates are ignored safely (the same message is recognised for seven days).

### What you may see
| Situation | What it means | What to do |
| :--- | :--- | :--- |
| Message arrives before the payment record is saved | The worker retries finding the payment for about 60 seconds. | Nothing unless an alert fires. |
| Message about a reference we do not know | Stored with no payment attached; nothing changes. | A spike may mean an attack or a partner mix-up; tell the Security Admin. |
| Duplicate message | Absorbed; answer is OK again. | Nothing. |
| Out-of-order messages | `SUCCEEDED` is never downgraded. | Nothing. |
| Message from the sandbox arrives at the live address | Rejected; priority-2 security alert. | Tell the Gateway Admin and Security Admin. |
| A spike of signature failures | The partner may have changed how it signs. | Runbook [[a:b10-03]]. |
| A valid signature from an unlisted IP address | The partner may have changed servers. | Runbook [[a:b10-03]]. |
| Weak channel (hint only) | The platform asks the partner before believing. | Nothing. |

### Replay
Because the raw bytes are kept, once a corrected signing recipe is approved the platform can **replay** the stored messages without asking the partner to send them again.

### The dashboard tile
**Webhook Inbox Lag** is the time between receiving and processing. The target is under 30 seconds for most messages. A high value means the workers are behind; tell Engineering.
@@end

@@article id=b07-06 book=7 order=6 title="Slot reservation, single-use links, expiry and the grace window" roles=OPERATOR,SUPPORT,FINANCE minutes=2 ui=AVAILABLE related=b05-07,b07-03,b07-08
### The problem this solves
A single-use link must be paid **once**. But a customer might open it in two tabs, or two people might open it, or a payment might be in doubt while someone else tries. Without a rule, the same invoice could be paid twice.

### The rule: reserve a slot before starting
When an attempt starts, it reserves one **slot** on the link, in one indivisible step. A single-use link has one slot. While the slot is reserved, nobody else can start a competing payment; they see "Payment in progress".

The slot is **released** only when the attempt reaches `FAILED`, `EXPIRED`, `CANCELLED` or `BLOCKED`. It is **kept through `UNKNOWN`**, because the first payment might have succeeded.

### Expiry
Each attempt expires at the **smaller** of the partner's session time and the platform's ceiling for that mode ([[a:b06-02]]). When time is up, the platform first asks the partner one last time (if the partner supports it) and only then moves the attempt to `EXPIRED`.

### The grace window
After expiry, the platform keeps listening for late confirmations for a **grace period** (default 24 hours; unlimited for partners that cannot be asked). If a verified success arrives:
* and the slot is still free: the attempt becomes `SUCCEEDED`, the money is posted, and a priority-2 alert is raised;
* and the link was already paid by another attempt: the money goes to the `SUSPENSE` account and a refund is drafted ([[a:b07-08]]).

### Multi-use links
The same rule applies with more slots. `confirmed_count + active_locked_count` may never exceed the number of uses.

### Customer behaviours that are handled
| Behaviour | Result |
| :--- | :--- |
| Closes the browser mid-payment | The page resumes from the server's state when reopened; the platform asks the partner at expiry. |
| Reloads or presses Back on the code screen | No second start; resend obeys the cooldown. |
| Opens the link on two devices | The second sees "Payment in progress". |
| Switches payment method mid-way | The first attempt is cancelled or watched; the new one joins the same group, and only one success per group is possible. |
| Presses retry while the earlier attempt is `UNKNOWN` | Blocked until it resolves. |
@@end

@@article id=b07-07 book=7 order=7 title="OTP behaviour: wrong codes, resend, lockouts and attacks" roles=OPERATOR,SUPPORT minutes=2 ui=AVAILABLE related=b06-08,b07-06,b11-03
### The OTP flow
In an `OTP_PULL` rail the customer first asks the partner to send a code (the **start** step), then types it (the **confirm** step).

### Rules
1. **Three tries.** A wrong code that the partner marks as retryable returns the customer to the code screen without sending a new SMS. After the third wrong code the payment becomes `FAILED`. (The number is a setting per gateway; the default is 3.)
2. **Resend cooldown.** A new SMS cannot be requested again before the gateway's cooldown ends, and the number of resends is capped. This stops customers (or attackers) draining SMS credit.
3. **Wrong codes never trip the circuit breaker.** They are customer mistakes ([[a:b06-08]]).
4. **A timeout during confirm is never a wrong code.** It becomes `UNKNOWN`, and the same code is never submitted again.
5. **Time limit.** The code screen has a countdown. The effective time limit is the smaller of the partner's code lifetime and the platform's 20-minute ceiling.

### What you tell a customer who says "the code never came"
Do not ask them to tap resend repeatedly. Ask them to wait for the countdown, check the phone number they typed, and use the page's resend button once. If it still fails, the payment company's own support handles SMS delivery.

### Abuse protection
The platform limits how fast one customer, device or network address can try, and a daily SMS budget alarm exists to detect SMS pumping (an attack that triggers thousands of SMS messages).
@@end

@@article id=b07-08 book=7 order=8 title="Late success, conflicts and amount mismatches" roles=OPERATOR,FINANCE minutes=2 ui=AVAILABLE related=b07-04,b07-06,b08-08
### Late success
A confirmation arrives **after** the payment was marked `EXPIRED` or `FAILED`. Cause: the customer approved late, or the partner was slow.
* If the slot is free: `SUCCEEDED` and the entry is posted. Priority-2 alert.
* If the link is already satisfied: the money is parked in `SUSPENSE` and a refund adjustment is drafted for a person to approve.
* Operators confirm the case notes and let Finance process the refund through the normal two-person route. Never refund from a phone call.

### Conflicting signals
Example: a verified webhook says "paid" but our status question says "failed". Both are trusted, so **neither wins**. Nothing is posted, the attempt stays in `UNKNOWN`, and a **priority-1 `CONFLICT` case** opens. Escalate to a senior operator and the Gateway Admin; resolution needs evidence from the partner.

### Amount mismatches
The partner confirms success but the amount or currency is not what we asked. The route's **mismatch policy** decides:
* within the tolerance: accepted;
* beyond it: the money is held in `SUSPENSE` and a `MISMATCH` case opens.

### What you do
1. Read the case notes and the step log.
2. Compare the partner's statement line with the attempt (amount, currency, date).
3. Do not credit or refund by hand. Propose an adjustment through Finance ([[a:b08-08]]) with a written reason.
@@end

@@article id=b07-09 book=7 order=9 title="Inquiry: how to ask a partner safely, and rails that cannot be asked" roles=OPERATOR minutes=2 ui=AVAILABLE related=b07-03,b06-07,b10-04
### What an inquiry is
An **inquiry** asks the partner "what is the true status of this payment?" using a read-only step. It cannot move money. It is the safest tool you have.

### When it runs
* automatically at expiry,
* automatically for channels that must ask before believing,
* automatically on a polling schedule,
* when you press **Inquire** on an attempt,
* when you press **Bulk Inquiry** for many attempts.

### Rules for using it
1. **One press, then wait.** Partners often need a minimum age on a payment before they will report a status. Pressing repeatedly does not help and may be rate-limited.
2. **Bulk Inquiry** sends many calls. Use it after an outage, filtered to the affected route and period. Open [[c:sg-bulk-inquiry]].
3. **Read the answer in the step log.** "Not found" is not the same as "failed". Many partners answer "not found" for a payment that is still being processed.

### Rails with no status question
Some partners (some wallets, and some aggregator routes) offer **no way to ask**. For these:
* an inquiry is impossible; the screen will say so;
* the customer page stays on "Confirming your payment";
* the truth comes from the settlement statement ([[a:b08-06]]) or from a decision by an operator with evidence;
* these gateways are flagged for extra attention, and large amounts may need operator approval.
@@end

@@article id=b07-10 book=7 order=10 title="Checkout Help: what payers see and what you can configure" roles=GATEWAY_ADMIN,OPERATOR,SUPPORT minutes=2 ui=AVAILABLE related=b07-12,b09-08,b03-03
### What the payer sees
On the checkout page, a **Help** drawer shows:
* **A step-by-step guide for the chosen payment method**, with what the customer needs before starting and what to do if it fails.
* **State-aware advice**: different text while waiting, when something is uncertain, after a failure, after expiry or after cancellation.
* **A one-tap "copy payment reference" button.**
* **Frequently asked questions**, in Arabic and English.
* **Contact options**: WhatsApp, phone, e-mail, the merchant's own contact, and working hours, **only if the administrator turned them on**.

### What you configure
The **Checkout Help** screen (under Settings) lets an administrator turn support on or off, set the channels and working hours, choose whether to show the platform's contact and the merchant's contact, and edit the platform FAQ. A live preview shows what a payer sees. If support is turned **off**, the whole contact block disappears.

### Rules for content
1. **Use official company contact details only.** Never a personal number.
2. **Write in both Arabic and English.**
3. **Never reveal internal reasons.** A blocked payment shows only "cannot process this payment". The page never confirms whether a phone number or wallet exists.
4. **Never promise refund times** you do not control.
5. Settings are versioned and audited like other changes.

### What the payer's help can and cannot do
It can explain, calm, and let a customer quote a reference. It cannot confirm a payment, change an amount or give refunds. Those stay with staff.
@@end

@@article id=b07-11 book=7 order=11 title="POS screens and live updates" roles=OPERATOR,SUPPORT minutes=2 ui=AVAILABLE related=b05-07,b07-06
### How live updates work
When an attempt's state changes, the core announces it. The checkout page receives it as a live stream, and the POS screen receives it through a live connection, so the customer and the cashier see the same result within moments.

### What a cashier sees
A screen paired to a terminal shows the current payment, for example a QR code and then "Paid" or "Failed". A screen idle for 15 minutes is disconnected; it reconnects and shows the current state. A long power or internet outage does not lose payments: all state and timers are held on the server, and expired payments release their slots by themselves.

### How to help a cashier
1. Ask for the **payment reference** shown on the screen or receipt.
2. Look the reference up and read the **status**, not the customer's claim.
3. If it says `SUCCEEDED`, the merchant is credited; tell the cashier.
4. If it says `UNKNOWN` or `VERIFYING`, tell the cashier to **wait** and not to hand over goods until it shows paid ([[a:b07-12]]).

:::warning
A customer showing a "Paid" screen on their phone is not proof of payment ([[a:b00-03]], rule 5).
:::
@@end

@@article id=b07-12 book=7 order=12 title="Procedure: a customer says their money was deducted, or that they paid" roles=OPERATOR,SUPPORT minutes=2 ui=AVAILABLE related=b07-03,b07-09,b00-03
This is the most common call you will receive. Follow the steps in order.

1. **Be calm and do not blame.** Say: "I will check this with your reference."
2. **Ask for the payment reference** (shown on the checkout page; the page has a copy button). Do not ask for passwords or codes.
3. **Look it up** and check the **environment** and **status**:

| Status you see | What it means | What you say / do |
| :--- | :--- | :--- |
| `SUCCEEDED` | We have verified the payment. | "We confirm your payment. The merchant has been credited." |
| `AWAITING_CUSTOMER` or `VERIFYING` | The payment is still in progress. | "It is in progress. Please do not pay again. Wait for the page to update." |
| `UNKNOWN` | We are not sure. | "We are confirming with your payment provider. Please do not pay again. We will update you." Then follow [[a:b07-03]]. |
| `FAILED`, `EXPIRED`, `CANCELLED` | We did not receive confirmation. | "We have no confirmed payment. If your provider shows a deduction, keep your receipt and your reference; a late confirmation may still arrive and, if it does, we will credit the merchant or return the money." Open a case if money was deducted. |
| `BLOCKED` | A guard stopped it. | "We cannot process this payment." Nothing more. Do not explain. |
| Not found | Wrong reference or wrong environment. | Ask the customer to check the reference. |

4. **Do not ask them to pay again.**
5. **Create or update an operator case** if the customer claims deduction and the status is not `SUCCEEDED`, noting the reference and the time.
6. **Never say "your payment is confirmed" from a screenshot, an SMS or a call.** Only a status you read in the platform counts.
7. **Tell them what happens next** and when you will reply. Then actually reply.

:::note Why we do not "just refund"
If we refund a payment that actually succeeded later, we lose money. If we credit a payment that never arrived, we lose money. Waiting for evidence protects the customer, the merchant and us.
:::
@@end


### BOOK 8 — MONEY & THE LEDGER

@@article id=b08-01 book=8 order=1 title="Double-entry bookkeeping from zero" roles=ALL minutes=3 ui=AVAILABLE related=b08-02,b08-05,b01-09
### The notebook problem
Imagine you keep a notebook of who has how much. Ali gives Sara 10 LYD and you write "Sara +10". Later you find the notebook says there is 10 LYD more in the world than there should be. Where did it come from? With one-sided notes you cannot tell.

### The idea: every movement has two sides
**Double-entry bookkeeping** writes both sides of every movement. Ali's side goes down, Sara's side goes up. Because every entry has two sides that must match, a mistake shows up at once.

### The words
* **Account**: a named place where an amount is tracked ("Treasury", "Merchant wallet of shop X"). In our system an account is a **GL account** (GL stands for *general ledger*, the book of all accounts).
* **Journal entry**: one page of the book, describing one event ("a customer paid 100 LYD").
* **Journal line**: one row on that page: an account, a direction and an amount.
* **Direction**: every line is a **debit** or a **credit**.
* **Ledger**: all journal entries together.

### Debit and credit are not "good" and "bad"
They are just two directions. Think of them as *left column* and *right column*. The only rule that matters:

**In every journal entry, the total of the debits equals the total of the credits.**

If they are not equal, the system refuses to save the entry.

### What a balance means
To know an account's balance, add its lines up. For accounts that hold things we *have* (cash in the bank), debits increase the balance. For accounts that record things we *owe* or *earned*, credits increase it. You do not need to calculate this by hand: the screens do it. What you must understand is the shape.

### A first example
A customer pays 100 LYD. Our commission is 3 LYD. The merchant is credited 97 LYD. The money sits with the payment company until it pays us later:

| Account | Debit | Credit | Why |
| :--- | :--- | :--- | :--- |
| Gateway clearing | 100.0000 | | We are owed 100 by the payment company. |
| Merchant wallet | | 97.0000 | We now owe the merchant 97. |
| Platform income | | 3.0000 | We earned 3. |
| **Total** | **100.0000** | **100.0000** | Balanced. |

### Four promises the ledger keeps
1. **Balanced entries.** Debits equal credits, always.
2. **Append-only.** Nothing is edited or deleted. A mistake is fixed by adding a new, approved entry that offsets it.
3. **Exactly once.** Each payment, adjustment or sweep can create its entry only once (a duplicate is refused by the database).
4. **No stored balances for wallets.** A merchant's balance is calculated from lines, so it cannot drift from the books.

### Try it
The explorer below shows all the standard events as two columns and checks the balance.

{{widget:ledger-explorer}}

:::danger Never "fix" numbers
If a number on a screen looks wrong, stop and escalate. Nobody edits numbers; corrections are new, approved entries ([[a:b08-08]]).
:::
@@end

@@article id=b08-02 book=8 order=2 title="The eleven accounts: what each one means" roles=FINANCE,COMPLIANCE,OPERATOR minutes=2 ui=AVAILABLE related=b08-01,b08-05
The platform has **11 kinds of GL account**. They split into things we *have* and things we *owe or earned*.

| Account | Plain meaning | One per... | Belongs to |
| :--- | :--- | :--- | :--- |
| `TREASURY` | Our real money in our own bank and cash. | platform | we have |
| `GATEWAY_CLEARING` | Money a payment company has collected for us but not yet paid to us. | gateway + environment + credential set | we have (a claim) |
| `COMMISSION_RECEIVABLE` | Commission we earned on payments that went straight to the merchant; the merchant owes it to us. | merchant | we have (a claim) |
| `MERCHANT_WALLET` | What we owe a merchant. | wallet | we owe |
| `AML_HOLD` | Money held while compliance decides. | platform | we owe (to be decided) |
| `CHARGEBACK_RESERVE` | Money set aside while a dispute is open. | platform | we owe (to be decided) |
| `SUSPENSE` | Money that arrived but does not clearly belong yet (late success on a paid link, mismatch above tolerance). | platform | we owe (to be decided) |
| `GATEWAY_FEE_ACCRUAL` | Fees the payment company will take later but we already know about. | platform | we owe |
| `PLATFORM_INCOME` | Commission we have earned. | platform | earned |
| `PROVIDER_FEE_EXPENSE` | A payment company's fee deducted straight from a payment. | platform | cost |
| `GATEWAY_FEE_EXPENSE` | A payment company's fee recognised when the payment is confirmed (and later corrected if the real fee differs). | platform | cost |

### A reading rule
Money in `MERCHANT_WALLET`, `AML_HOLD`, `CHARGEBACK_RESERVE` and `SUSPENSE` is **not ours**. It is only on its way somewhere. That is why commission on held money is not counted as income until the money is released ([[a:b09-05]]).

:::note 11, not 10
Older design documents list ten account kinds. The code has eleven, because gateway fees recognised at confirmation have their own account. The guide uses eleven.
:::
@@end

@@article id=b08-03 book=8 order=3 title="Commission, fee bearers and rounding, with worked numbers" roles=FINANCE,OPERATOR,SUPPORT minutes=2 ui=PARTIAL related=b01-05,b08-04,b03-08
### Two separate fees
* **Commission**: what we charge the merchant. Our revenue.
* **Gateway fee**: what the payment company charges us. Our cost.
* **Net revenue** = commission − gateway fee.

### How commission is chosen
A **commission profile** says how to calculate the commission for a rail: a flat fee, a percentage, tiers by amount, or a mix, with a minimum and a maximum. Profiles are **effective-dated** (they start on a date) and **versioned**, so old payments always show the profile they used.

The profile used is the most specific one that exists, in this order:
1. this merchant + this application + this rail,
2. this merchant + this rail,
3. the platform default + this rail.

If no profile covers a rail at that amount, the rail is hidden from the customer ([[a:b06-12]]).

### Who pays it: the fee bearer
A link has a **fee bearer**. Example: 100.000 LYD link, 3.000 LYD commission, 0.800 LYD gateway fee.

| Fee bearer | Customer pays | Merchant is credited | Our commission | Our net after gateway fee |
| :--- | :--- | :--- | :--- | :--- |
| `MERCHANT_ABSORBS` (default) | 100.000 | 97.000 | 3.000 | 2.200 |
| `PAYER_SURCHARGE` | 103.000 | 100.000 | 3.000 | 2.200 |
| `SPLIT` (50/50) | 101.500 | 98.500 | 3.000 | 2.200 |

With `PAYER_SURCHARGE` or `SPLIT` the checkout page must show the added fee before the customer confirms.

### Rounding
Money is stored with four decimal places. Commission is rounded using the profile's rounding mode. (The teaching tools in this guide round half up to four places.)

### Revenue is not recognised early
Commission on money held by compliance is **not** counted as income until the hold is released.

:::note Why this article is marked partial
Commission profiles and velocity rules have no screen yet to create or change them (see [[a:b03-08]]). Finance proposes; engineering applies through the approval flow.
:::
@@end

@@article id=b08-04 book=8 order=4 title="How each kind of payment is posted" roles=FINANCE,OPERATOR minutes=2 ui=AVAILABLE related=b08-12,b08-10,b02-03
When an attempt becomes `SUCCEEDED`, one journal entry is written in the **same database transaction**. Which entry depends on how the money travels. All examples use a 100.0000 LYD link and 3% commission.

### A. Platform holds the money, fee taken from the payment (Entry 1)
The payment company deducts its 1.0000 fee before paying us.
| Debit | Credit |
| :--- | :--- |
| `TREASURY` 99.0000 | `MERCHANT_WALLET` 97.0000 |
| `PROVIDER_FEE_EXPENSE` 1.0000 | `PLATFORM_INCOME` 3.0000 |

### B. Platform holds the money, settled later (Entry 2)
The payment company will pay us later, and charges 0.8000 which we accrue.
| Debit | Credit |
| :--- | :--- |
| `GATEWAY_CLEARING` 100.0000 | `MERCHANT_WALLET` 97.0000 |
| `GATEWAY_FEE_EXPENSE` 0.8000 | `PLATFORM_INCOME` 3.0000 |
| | `GATEWAY_FEE_ACCRUAL` 0.8000 |

### C. Payer surcharge (Entry 5)
Customer pays 103.0000; merchant gets the full 100.0000.
| Debit | Credit |
| :--- | :--- |
| `GATEWAY_CLEARING` 103.0000 | `MERCHANT_WALLET` 100.0000 |
| `GATEWAY_FEE_EXPENSE` 0.8000 | `PLATFORM_INCOME` 3.0000 |
| | `GATEWAY_FEE_ACCRUAL` 0.8000 |

### D. Money goes straight to the merchant (Entry 6)
We hold no cash. We book only the commission we are owed:
| Debit | Credit |
| :--- | :--- |
| `COMMISSION_RECEIVABLE` 3.0000 | `PLATFORM_INCOME` 3.0000 |
Later, when it is netted against money we owe the merchant: `MERCHANT_WALLET` debit 3.0000, `COMMISSION_RECEIVABLE` credit 3.0000.

### E. First-party NeomPay (Entry 13)
Posts straight to treasury; there is no clearing step.
| Debit | Credit |
| :--- | :--- |
| `TREASURY` 100.0000 | `MERCHANT_WALLET` 97.0000 |
| | `PLATFORM_INCOME` 3.0000 |

### F. Held by an AML rule (Entry 7)
At confirmation the money goes to `AML_HOLD` and **no commission is recognised**. On release it moves to the merchant and income ([[a:b09-05]]).

### Why "exactly once" matters
Each entry is tied to its payment by a unique pair (type and id). If a webhook is repeated, a second entry is refused, so a duplicate message can never double-credit a merchant.
@@end

@@article id=b08-05 book=8 order=5 title="The ledger equation and what to do when it does not hold" roles=FINANCE,SECURITY_ADMIN,OPERATOR minutes=2 ui=AVAILABLE related=b08-01,b10-05,b08-11
### The equation
At any moment, across the whole platform:

**Treasury + all clearing accounts + all commission receivable**
**=**
**all merchant wallets + platform income − provider fee expense − gateway fee expense + gateway fee accrual + AML hold + chargeback reserve + suspense**

In words: *what we have equals what we owe plus what we earned minus what it cost us.* Because every entry is balanced, this must always be true.

### Four rules enforced by the database
| Rule | Enforced by |
| :--- | :--- |
| Every journal line amount is greater than zero | a check constraint |
| One link slot count never exceeds the allowed uses | a check constraint |
| At most one success per attempt group | a check constraint |
| The approver of a request is never its maker | a trigger on the approval table (plus two code checks) |

### The monitor
A scheduled job recomputes the equation continuously and reports the **drift**, the difference between the two sides. The expected value is **0.0000 LYD**.

### If drift is not zero
1. This is a **priority-1 incident**. Tell your manager and Finance immediately.
2. **Automatic payouts stop** until the cause is understood.
3. Follow [[a:b10-05]].
4. **Never edit numbers** or try to "make it balance". Corrections are new approved adjustments.

### Read the screens
The invariant screen shows the latest result, the drift and when it last ran ([[a:b08-11]]).
@@end

@@article id=b08-06 book=8 order=6 title="Reconciliation: matching partner statements to our books" roles=FINANCE minutes=3 ui=AVAILABLE related=b08-10,b10-05,b07-09
### Why we reconcile
A payment company is another record-keeper. Our books say what *we* think happened; its **statement** says what *it* thinks. If they differ, one of us is wrong, and we must find out which.

### Statement sources
A **statement source** describes where statements come from (`API`, `SFTP` or `UPLOAD`), how often, and how to read the file: format (CSV, XLSX or JSON), encoding, separator, which row has the headers, which column holds which field, the date format and the **time zone**. It also records the **settlement lag**, how many days the partner takes to pay us (for example T+2).

### Running it
On the **Reconciliation** screen choose a source, choose or upload the file and use **Run File**. A live preview shows how the columns will be read before anything is matched. The same file cannot be loaded twice (its fingerprint is unique). Open the checklist [[c:sg-run-reconciliation]] first.

### The results for each line
| Result | Meaning | Usual action |
| :--- | :--- | :--- |
| `MATCHED` | Our payment and the statement line agree. | none |
| `AMOUNT_MISMATCH` | Same payment, different amount. | Check fee or rounding; propose an adjustment or fee true-up. |
| `MISSING_AT_GATEWAY` | We say succeeded; the partner shows nothing. | **Serious**: we may have credited money we did not receive. Escalate. |
| `MISSING_LOCALLY` | The partner shows a payment we do not have. | May be a late success or an `UNKNOWN` we can now resolve. |
| `DUPLICATE` | The same line twice. | Ignore the duplicate after checking. |

Problem lines can open operator cases of kind `UNMATCHED_STATEMENT` or `MISMATCH`.

### What happens when a statement settles
* The **settlement sweep** moves money from `GATEWAY_CLEARING` to `TREASURY` and clears the accrued fee (Entry 3).
* If the actual fee differs from the accrued fee, a **fee variance true-up** posts the difference to `GATEWAY_FEE_EXPENSE` (Entry 4).

### Time zones
The partner's statement may be in Libya time. Our system stores UTC. Convert deliberately when you compare dates; the source's time zone setting does this for you.

### Targets and danger signs
The target is that 99% of statements are loaded within 4 hours of becoming available. If drift appears, automatic payouts stop and runbook [[a:b10-05]] applies.

:::note Partial
New statement sources are created by engineering today ([[a:b03-08]]). You choose an existing source on the screen.
:::
@@end

@@article id=b08-07 book=8 order=7 title="Cash-outs: paying a merchant its balance" roles=FINANCE,OPERATOR minutes=2 ui=AVAILABLE related=b08-08,b04-05,b08-13
### What a cash-out is
A merchant's wallet is a number on our books. A **cash-out** is the merchant's request to receive that money in its real bank account.

### States
`PENDING` → `PROCESSING` → `COMPLETE` → `SUBTRACTED`, or `REJECTED`.

| State | Meaning |
| :--- | :--- |
| `PENDING` | Requested; waiting for Finance. |
| `PROCESSING` | Finance has started paying it. |
| `COMPLETE` | The bank transfer has been made. |
| `SUBTRACTED` | A second Finance person approved, and the amount was taken off the merchant's wallet. |
| `REJECTED` | Finance refused it. |

### The steps on the **Cash-Outs** screen
1. Open the request and read the **bank details snapshot**. It is a copy of the bank details as they were when the request was made. If the merchant later changes its bank account, a request already made keeps the old snapshot.
2. Check that the destination is the merchant's verified bank account, that the merchant is `ACTIVE`, that the wallet has enough balance, and that no negative balance or hold applies.
3. Use **Process**. Open the checklist [[c:sg-process-cashout]] first.
4. Make the real bank transfer outside the platform, using the bank's own controls.
5. Mark it complete.
6. A **different** Finance user uses **Approve and execute** to subtract the amount (Entry 8: wallet debit, treasury credit). The same checklist applies.
7. If it must be refused, use **Reject and release**. Open [[c:sg-reject-cashout]] first. Nothing has been subtracted before the final step, so the merchant's balance is unchanged.

### Rules
* A merchant who is suspended, has a negative balance, or has unresolved AML matters **cannot cash out**.
* Cash-outs stop automatically when the ledger equation shows drift ([[a:b08-05]]).
* The person who processes it is not the person who approves the subtraction.
@@end

@@article id=b08-08 book=8 order=8 title="Adjustments: refunds, chargebacks, manual entries and corrections" roles=FINANCE,OPERATOR minutes=2 ui=AVAILABLE related=b08-09,b04-05,b08-07
### What an adjustment is
An **adjustment** is any money movement that is not an ordinary successful payment. It is the only way to change books after the fact, and it **always needs two people**.

### Types
| Type | Use |
| :--- | :--- |
| `REFUND` | Return money to the payer. |
| `CHARGEBACK` | A dispute outcome; usually drafted by the system. |
| `MANUAL_CREDIT` | Add money to an account in exceptional, documented cases. |
| `MANUAL_DEBIT` | Remove money from an account in exceptional, documented cases. |
| `CORRECTION` | Fix an earlier mistake. |
| `CASHOUT_SUBTRACTION` | The last step of a cash-out. |

### States
`DRAFT` → `PENDING_REVIEW` → `APPROVED` → `EXECUTING` → `EXECUTED`, or `REJECTED`. `EXECUTING` is used for refunds that must be sent to the payment company: the adjustment stays there while the refund call is in flight or uncertain, and the platform reconciles it.

### On the **Adjustments** screen
* **Propose** creates an adjustment: choose the type, the target account, the amount, whether to reverse the commission, and write the reason ([[a:b04-06]]). Open the checklist [[c:sg-propose-adjustment]] first.
* A different `FINANCE` user approves it from **Approvals**.
* **Reverse** proposes a new adjustment that offsets an earlier one. It does not edit or delete the earlier one, and it needs its own approval. Open [[c:sg-reverse-adjustment]] first.

### Commission on refunds
A full refund usually reverses the commission too (Entry 9): the merchant's wallet is debited the net amount and platform income is debited the commission. This can be set per rail and per merchant.

### Rules
1. **Executed adjustments are never edited.** A wrong one is offset by a new one.
2. **Check the amount and the currency** before proposing. A refund can never exceed the original payment.
3. **Link a refund to any dispute** on the same payment so the same money is not returned twice.
4. **The system drafts chargebacks, but never approves them.** A human checker is required before any money moves.
@@end

@@article id=b08-09 book=8 order=9 title="Disputes and chargebacks" roles=FINANCE,OPERATOR minutes=2 ui=AVAILABLE related=b08-08,b08-13,b04-05
### What a dispute is
A **dispute** (or **chargeback**) happens when a payer, or the payer's bank or card scheme, says a payment should be returned. The payment company tells us, and the money may be taken back from us.

### How a dispute reaches us
| Channel | How |
| :--- | :--- |
| Partner message | A verified webhook says a dispute opened. |
| Statement | A settlement line is flagged as a chargeback or reversal. |
| Manual | Finance enters one received by e-mail or through a partner portal. |

A dispute is unique per gateway and partner dispute reference, so a repeated message or a re-loaded statement cannot create a second dispute.

### The lifecycle
`OPENED` → `EVIDENCE_REQUESTED` → `EVIDENCE_SUBMITTED` → `WON`, `LOST`, `EXPIRED` or `WITHDRAWN`.

* When a dispute opens, the payment's state becomes `DISPUTED`. It is not undone.
* There is an **evidence deadline**. If it passes without evidence, the dispute becomes `EXPIRED`, which is treated as lost unless the rail's rules say otherwise.
* A refund already issued is linked to the dispute.

### How the system drafts the chargeback
1. A dispute is created.
2. A **system drafting identity** creates a chargeback adjustment in a waiting state.
3. A human `FINANCE` checker must approve it. The system can never approve or execute.
4. Until a human approves, **no money moves** and the merchant's wallet is untouched. A priority-2 case opens if the request is still waiting shortly before the evidence deadline.

### What the money does
| Moment | Entry |
| :--- | :--- |
| Dispute approved for reserve | Wallet and income reduced; money goes to `CHARGEBACK_RESERVE` (Entry 10, first part). |
| Dispute lost | Reserve goes out to the payer or scheme (Entry 10, second part). |
| Dispute won | Reserve returns to the merchant and income (Entry 12). |
| Dispute on an AML-held payment | Handled against the hold (Entry 11), not the wallet. |

### When the merchant's balance is too low
See [[a:b08-13]].
@@end

@@article id=b08-10 book=8 order=10 title="Settlement: clearing, T+N, direct-to-merchant and held-by-provider" roles=FINANCE minutes=2 ui=AVAILABLE related=b02-06,b08-06,b08-04
### Why money is not instant
A payment company collects the customer's money and typically pays us in a batch some days later. **T+N** means "the payment day plus N days".

### Three settlement targets
| Target | Who the partner pays | What we book |
| :--- | :--- | :--- |
| `PLATFORM_CLEARING` | Us | A clearing balance owed by the partner, then a settlement sweep to treasury. |
| `MERCHANT_DIRECT` | The merchant | Only our commission (a receivable) which is netted later. |
| `PROVIDER_HELD` | The partner keeps it for now | Per the route's rules. |

### The settlement cycle for platform clearing
1. **Payment confirmed**: debit clearing, credit wallet and income and fee accrual (Entry 2).
2. **Statement arrives**: **settlement sweep** debits treasury (the net amount) and the fee accrual, credits clearing (Entry 3).
3. **Fee differs**: **true-up** debits fee expense, credits the accrual (Entry 4).

### Clearing ageing
Finance watches how old each clearing balance is. A clearing balance older than the partner's settlement lag means the partner has not paid us on time. Raise it as drift ([[a:b10-05]]).

### Why merchants may be paid before we are
We credit the merchant's wallet at confirmation. If we cash out before the partner settles, we are using our own treasury. The liquidity screen shows whether cover is enough ([[a:b08-11]]).
@@end

@@article id=b08-11 book=8 order=11 title="Profitability, liquidity and the invariant screens" roles=FINANCE minutes=2 ui=AVAILABLE related=b08-05,b08-10,b03-03
All figures on these screens are **computed from the ledger lines**. There are no hand-maintained totals. A report that disagrees with the ledger is a bug in the report.

### Profit definitions
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

### The liquidity panels
| Panel | What it shows | When to worry |
| :--- | :--- | :--- |
| Invariant status | The latest drift and when it ran. | Any non-zero drift. |
| Treasury cover | Treasury plus clearing versus wallets plus holds plus reserves. | Below the floor. |
| Clearing ageing | Clearing per gateway, by age. | Older than the settlement lag. |
| Cash-out queue | Pending amounts and forecast. | Demand above available cash. |
| Holds and reserves | AML hold and chargeback reserve, oldest item. | Aged beyond deadlines. |
| Receivables | Commission receivable and negative merchant balances versus ceilings. | Ceiling approached. |

### Who sees what
Merchants see their own gross, commission and net, **never** gateway costs or our margin.
@@end

@@article id=b08-12 book=8 order=12 title="All fifteen worked journal entries (plus one)" roles=FINANCE minutes=2 ui=AVAILABLE related=b08-01,b08-04
Use this table as a reference. Each line uses a 100.0000 LYD link and 3% commission unless said otherwise. The explorer below lets you change the amounts.

| # | Event | Debits | Credits |
| :-- | :--- | :--- | :--- |
| 1 | Money in treasury, fee deducted at source (1.0000 fee) | `TREASURY` 99.0000; `PROVIDER_FEE_EXPENSE` 1.0000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 |
| 2 | Money with the partner, fee accrued (0.8000) | `GATEWAY_CLEARING` 100.0000; `GATEWAY_FEE_EXPENSE` 0.8000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000; `GATEWAY_FEE_ACCRUAL` 0.8000 |
| 3 | Settlement sweep (statement shows 99.2000 net) | `TREASURY` 99.2000; `GATEWAY_FEE_ACCRUAL` 0.8000 | `GATEWAY_CLEARING` 100.0000 |
| 4 | Fee true-up (actual 0.9000 vs accrued 0.8000) | `GATEWAY_FEE_EXPENSE` 0.1000 | `GATEWAY_FEE_ACCRUAL` 0.1000 |
| 5 | Payer surcharge (103.0000 charged) | `GATEWAY_CLEARING` 103.0000; `GATEWAY_FEE_EXPENSE` 0.8000 | `MERCHANT_WALLET` 100.0000; `PLATFORM_INCOME` 3.0000; `GATEWAY_FEE_ACCRUAL` 0.8000 |
| 6 | Direct to merchant: at confirmation, then at netting | `COMMISSION_RECEIVABLE` 3.0000; later `MERCHANT_WALLET` 3.0000 | `PLATFORM_INCOME` 3.0000; later `COMMISSION_RECEIVABLE` 3.0000 |
| 7 | AML hold: at confirmation, then at release | `GATEWAY_CLEARING` 100.0000; later `AML_HOLD` 100.0000 | `AML_HOLD` 100.0000; later `MERCHANT_WALLET` 97.0000, `PLATFORM_INCOME` 3.0000 |
| 8 | Cash-out subtracted | `MERCHANT_WALLET` 100.0000 | `TREASURY` 100.0000 |
| 9 | Full refund, commission reversed | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 | `TREASURY` (or clearing) 100.0000 |
| 10 | Chargeback reserved, then lost | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000; later `CHARGEBACK_RESERVE` 100.0000 | `CHARGEBACK_RESERVE` 100.0000; later `TREASURY` 100.0000 |
| 11 | AML hold voided and returned | `AML_HOLD` 100.0000 | `TREASURY` (or clearing) 100.0000 |
| 12 | Chargeback won | `CHARGEBACK_RESERVE` 100.0000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 |
| 13 | NeomPay confirmation | `TREASURY` 100.0000 | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 |
| 14 | NeomPay full refund | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 | `TREASURY` 100.0000 |
| 15 | Chargeback with only 40.0000 in the wallet | `MERCHANT_WALLET` 97.0000; `PLATFORM_INCOME` 3.0000 | `CHARGEBACK_RESERVE` 100.0000 |
| 16 | Late success on an already-paid link (the explorer's extra event) | `GATEWAY_CLEARING` 100.0000 | `SUSPENSE` 100.0000 |

**Reading entry 15.** The wallet goes from +40.0000 to −57.0000. The ledger equation still holds: a negative wallet is arithmetically the same as the merchant owing us money. See [[a:b08-13]].

{{widget:ledger-explorer}}
@@end

@@article id=b08-13 book=8 order=13 title="Negative balances and ceilings" roles=FINANCE,OPERATOR,COMPLIANCE minutes=1 ui=AVAILABLE related=b08-09,b05-01,b08-07
### The situation
A chargeback or refund can be larger than the merchant's wallet balance.

### The rules
1. The adjustment still posts in full (Entry 15) as long as the wallet does not go below the merchant's **negative-balance ceiling**. For new merchants the ceiling is `0`, so by default the adjustment cannot post if it would push the wallet below zero. The ceiling is raised per merchant, by two-person approval, as trust grows.
2. If posting would break the ceiling, the adjustment **does not execute**. A priority-1 operator case opens, the merchant is told about the shortfall, and Finance chooses: collect the money (invoice), net it against pending cash-outs, or suspend the merchant ([[a:b05-08]]).
3. A negative balance is recovered by **netting** against future payments: each confirmed payment first reduces what is owed. The merchant's statement shows "amount owed to platform".
4. A merchant with a negative balance **cannot cash out**. Suspension and closure are blocked until the balance returns to zero or is written off by an approved manual debit or correction.
@@end


### BOOK 9 — RISK, AML & COMPLIANCE

@@article id=b09-01 book=9 order=1 title="Anti-money-laundering from zero: what it is and why it concerns everyone" roles=ALL minutes=2 ui=AVAILABLE related=b09-02,b09-10,b01-10
### What money laundering is
Some money comes from crime: fraud, theft, bribery, smuggling. A criminal cannot spend large sums of such money openly without questions. **Money laundering** is making that money look like it came from a normal source.

It is usually described in three stages:
1. **Placement**: getting the dirty money into the financial system (for example many small payments through a shop that does not really sell much).
2. **Layering**: moving it around so that its origin is hard to follow (many transfers, many accounts, many payment methods).
3. **Integration**: bringing it back as apparently clean money (a "legitimate" business payout to a bank account).

### Why a payment platform is a target
A platform like ours is fast, handles many small payments, connects many payment methods, and pays out to bank accounts. A criminal who can make a fake shop receive payments and then cash out has laundered money through us.

### Anti-money-laundering (AML)
**AML** is the set of rules and activities that detect and stop this. It includes:
* knowing who our merchants really are (KYB, [[a:b05-04]]),
* checking names against official lists (**screening**, [[a:b09-03]]),
* watching payments for suspicious patterns (**rules**, [[a:b09-04]]),
* investigating and deciding (**cases**, [[a:b09-05]]),
* telling the authorities when the law requires (**reporting**, [[a:b09-07]]),
* keeping records ([[a:b09-09]]).

### Who does what
* **Everyone** is a sensor. If something looks wrong, you report it ([[a:b09-10]]).
* **Compliance** analysts investigate and propose decisions.
* The **MLRO** (Money Laundering Reporting Officer) is the senior person who owns the final decisions and the contact with the authorities.
* **The system** screens, flags, holds and records. It does not decide to accuse anyone.

### Why this has legal weight
Failing to run these controls can lead to fines, loss of our licence and personal liability. **Tipping-off** (warning a suspect) can itself be a crime ([[a:b09-08]]).
@@end

@@article id=b09-02 book=9 order=2 title="The seven layers of the AML program" roles=COMPLIANCE,MLRO,OPERATOR minutes=2 ui=AVAILABLE related=b09-03,b09-04,b09-05
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
Payments have a strict speed budget. So the work is split:
1. **Inside the guard (fast, local):** merchant status, risk tier, velocity limits, a local copy of the watch-list, and the cheap AML rules. A hard watch-list match makes the attempt `BLOCKED`; the customer sees only a generic message.
2. **At or after confirmation (deferred):** name screening of the payer where a name is available, structuring checks and pattern rules. A hit turns the posting into an AML hold (for money we hold) or a case (for money paid directly to the merchant).
3. **Daily batch:** structuring, many-to-one and one-to-many patterns, sudden activity after dormancy, rapid in-and-out movement, and a merchant's activity compared with its declared volume.

If a rail legally requires a screening call during the payment, a strict timeout (800 milliseconds by default) applies, with a per-rail policy: **fail closed** (block) or **fail open and flag** (continue and open a case). The default is fail open and flag below the rail's screening threshold, fail closed above it.
@@end

@@article id=b09-03 book=9 order=3 title="Screening: lists, matches and how to decide them" roles=COMPLIANCE,MLRO minutes=3 ui=AVAILABLE related=b09-05,b05-05,b09-08
### What is screened
| Subject | Data used | When |
| :--- | :--- | :--- |
| Merchant (legal entity) | Legal and trade name, registration number, country, activity | Onboarding, periodic, list update, name change |
| Beneficial owner, controller, signatory | Full name (Arabic and Latin), date of birth, nationality, national ID, declared PEP status | Onboarding, owner change, periodic, list update |
| Payer | Phone, wallet ID, card alias, device and IP fingerprint, and a name only where the rail returns one | At transaction time (against the cached watch-list) |
| Payment attempt | Amount, rail, merchant risk tier, cumulative behaviour | Rule engine |

Only the fields needed for matching are sent to the screening provider. **Documents are never sent.**

### The lists
International sanctions lists applicable to the operator; national or Central Bank lists; politically-exposed-person (PEP) lists; adverse-media sources; and an **internal watch-list** we maintain (for example offboarded merchants).

### Arabic names
Names in Arabic script have many spellings in Latin letters. The matching normalises Arabic (marks, letter variants, digits), sends both Arabic and a best Latin spelling where possible and records a match score. A fixed set of Arabic test names is run before go-live.

### Results and what each needs
| Result | Meaning | Action |
| :--- | :--- | :--- |
| `CLEAR` | No match | none |
| `POTENTIAL_MATCH` | A possible match | Decide each match |
| `CONFIRMED_MATCH` | A real match | Sanctions: emergency suspension ([[a:b09-06]]) |
| `ERROR` | Provider unavailable | At onboarding: **cannot approve** until fixed |

### Deciding a match: **Disposition**
Open the screening, review each candidate with its list, score and attributes, then use **Disposition** and **Save**. Open the checklist [[c:sg-aml-disposition]] first. The choices:
* `FALSE_POSITIVE`: a different person. You may set `suppress_future` with an **expiry date** so the same pair does not reopen on every periodic screening. Suppression ends automatically if the person's identifying data changes.
* `TRUE_MATCH`: the match is real.
* `ESCALATED`: refer to the MLRO.

Always write the rationale: what you compared (date of birth, nationality, ID) and why you decided.

### Reproducibility
Each screening stores exactly which list versions were checked and a fingerprint of the input, so a past decision can be replayed against the lists that were then in force.

### List updates
When a list changes, all active subjects are re-screened. A new match on an active merchant opens a case and **restricts cash-out immediately**. Payments continue unless severity is `CRITICAL`.
@@end

@@article id=b09-04 book=9 order=4 title="Rules: velocity limits, AML rules and how they change" roles=COMPLIANCE,MLRO,FINANCE minutes=3 ui=PARTIAL related=b09-05,b04-05,b03-08
### Two different tools
* **Velocity rules** limit *how often or how much* in a window: for example no more than N payments from one phone number in an hour. Action: `REJECT` (the attempt becomes `BLOCKED`) or `FLAG`. Velocity rules never move money.
* **AML rules** look for suspicious *patterns or amounts*. Their actions can hold money or open cases.

### AML rule types
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
| Action | Effect |
| :--- | :--- |
| `HOLD` | Money goes to `AML_HOLD` and a case opens. |
| `FLAG` | The payment proceeds; a review case opens. |
| `BLOCK` | The attempt is `BLOCKED`. |
| `CASE_ONLY` | A case opens; money is untouched. |

### Subjects, not links
Rules evaluate by *subject* (merchant, owner, payer identifier), so splitting a big sale across links, applications or rails does not avoid a threshold.

### Change control
* **Every rule change needs two people**; the `MLRO` approves AML rules ([[a:b04-05]]).
* **Tightening** in an emergency may be activated at once and ratified within 24 hours.
* **Loosening** never skips review.
* A **dry-run** replays recent payments against a proposed rule to show how many holds and cases it would have made, so a noisy rule is caught first.
* Open the checklist [[c:sg-aml-rule-change]] before **Create** or **Save** on the **AML Rules** screen.

### Rule quality
A rule whose precision falls (many holds that end in release) is flagged for retuning, so reviewers are not buried in noise.

:::note Why this article is marked partial
The **AML Rules** screen manages AML rules. **Velocity rules** have no screen yet; they are proposed by Finance or Compliance and applied by engineering ([[a:b03-08]]).
:::
@@end

@@article id=b09-05 book=9 order=5 title="Cases: lifecycle, severity, deadlines and what money does" roles=COMPLIANCE,MLRO minutes=2 ui=AVAILABLE related=b09-06,b08-04,b04-05
### Case lifecycle
`OPEN` → `IN_REVIEW` → `PENDING_CHECKER` → `RELEASED`, `REJECTED_VOID`, `FROZEN` or `ESCALATED_STR`.

1. A rule hit, a screening match, a combined event or an analyst's referral creates the case with a computed **severity** and a deadline.
2. A `COMPLIANCE` analyst (the maker) investigates, records notes, and uses **Propose** to suggest a resolution. Open the checklist [[c:sg-aml-propose-resolution]] first.
3. An `MLRO` (the checker, never the same person) approves. **Only then does money move.**
4. The resolution and the ledger posting are one atomic step.

### The four resolutions
| Resolution | Effect |
| :--- | :--- |
| Release | The held money goes to the merchant and income (Entry 7, release). Commission becomes income now. |
| Void and return | The money is returned to the payer (Entry 11). No commission was ever recognised. |
| Freeze | Only the case state changes; the money stays in `AML_HOLD`. |
| Escalate to STR | A suspicious-activity report draft is created ([[a:b09-07]]). |

### Severity
Severity starts from the rule's base level and is raised by these inputs, which are stored so the result is explainable:

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
`CRITICAL` 4 hours, `HIGH` 1 business day, `MEDIUM` 3 business days, `LOW` 5 business days. Breaches raise alerts. A case cannot be closed without a written rationale and, for holds, a ledger outcome.

### A dispute on held money
A chargeback on an AML-held payment is processed against the hold (void and return) and never touches the merchant's wallet.
@@end

@@article id=b09-06 book=9 order=6 title="Restricting a merchant: suspension, emergency ratification and screening outcomes" roles=COMPLIANCE,MLRO,OPERATOR minutes=2 ui=AVAILABLE related=b04-04,b05-08,b09-03
### The two paths to suspension
1. **Standard**: a reasoned decision, reviewed in the usual way.
2. **Emergency**: one authorised person suspends at once, because delay is the danger. The system creates an approval request in *emergency ratification* mode and a clock of **24 hours**.

### Ratification
A different person from `COMPLIANCE`, or the `MLRO`, must review the emergency suspension within 24 hours and either **ratify** it or **revoke** it. If nobody does, a priority-2 alert fires and the suspension **stays in force**. It is never reversed automatically. (Fail safe: restricted, not open.)

### Screening outcomes that restrict a merchant
| Outcome | Result |
| :--- | :--- |
| Sanctions `CONFIRMED_MATCH` | Immediate suspension by the emergency path; cash-out frozen; held money stays in hold; a suspicious-activity draft is created; nothing more happens until the MLRO decides. |
| `POTENTIAL_MATCH` | Each match must be decided. Until then an applicant cannot be approved, or an existing merchant's cash-out is held. |
| New match after a list update | A case opens; cash-out is restricted at once; payments continue unless the case is `CRITICAL`. |

### Reinstating
Reinstatement increases risk, so it needs prior approval by a different `COMPLIANCE` or `MLRO` user and is never an emergency action.

### What the merchant is told
Only a generic message. If the cause is AML, there is **no reason** in the message ([[a:b09-08]]).
@@end

@@article id=b09-07 book=9 order=7 title="Regulatory reporting: large-transaction and suspicious-activity reports" roles=COMPLIANCE,MLRO minutes=2 ui=AVAILABLE related=b09-05,b09-08,b04-05
### Reporting is configuration, not code
We must not guess what the authority requires. Every reporting parameter is **data** that can be confirmed and changed.

### Reporting rules
A **reporting rule** says, per authority and report type, when a report is triggered (an amount, a window, conditions) and cites the **source** (the circular or written instruction that justifies it). Each rule is `PROVISIONAL` or `CONFIRMED`. **A provisional rule can never produce a live filing**; the database refuses it.

### Report types
| Type | Triggered by |
| :--- | :--- |
| `LARGE_TRANSACTION` | A rule (can be drafted automatically). |
| `SUSPICIOUS_ACTIVITY` (STR) | A case. Always reviewed by a person. |
| `PERIODIC_RETURN` | A schedule. |

### Report lifecycle
`DRAFT` → `PENDING_CHECKER` → `APPROVED` (content frozen, fingerprint stored) → `SUBMITTED` → `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY` (corrected by a new linked report).

Submission is a two-person action: `COMPLIANCE` proposes, `MLRO` approves. On the **AML Reports** screen, **Create** and **Save** are guarded by [[c:sg-aml-report]].

### Internal-only mode
Until the Central Bank's thresholds, formats, deadlines and receiving channel are confirmed in writing, rules stay `PROVISIONAL` and the platform works in **internal-only mode**: it can detect, hold and record, but it cannot file.

### Confidentiality
The existence of a suspicious-activity report is never disclosed to the subject ([[a:b09-08]]). The saved report is read-only; a correction is a new report.
@@end

@@article id=b09-08 book=9 order=8 title="Confidentiality and tipping-off: what you may say, and to whom" roles=ALL minutes=2 ui=AVAILABLE related=b00-03,b05-09,b02-05
### What tipping-off is
**Tipping-off** means telling someone, directly or by hint, that they are or may be under suspicion, or that a report has been made about them. It is forbidden. It can be a crime, and it can ruin an investigation.

### What is confidential
Screenings, matches, cases, rule hits that opened cases, reports, and the reasons for AML suspensions. This is called **AML-confidential**. Only `COMPLIANCE`, `MLRO` and (for audit) `SECURITY_ADMIN` may see it. `SUPPORT` can see *that* a merchant is suspended, never *why*. Every read of an AML case is logged.

### What you may say to a merchant or customer
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
Notification templates for merchants and the public **cannot contain AML variables**; this is checked when a template is saved. Checkout never reveals the internal reason for a block.

### If someone asks you directly
If a merchant or customer asks "am I under investigation?" the answer is always the generic one above. Do not say yes, do not say no, and do not say "I cannot tell you because...". Tell your manager and Compliance.

:::danger This rule outranks helpfulness
Being unhelpful to a customer is acceptable. Tipping off is not.
:::
@@end

@@article id=b09-09 book=9 order=9 title="Records, retention and immutability" roles=COMPLIANCE,MLRO,SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b04-07,b09-08
### Records kept
KYB records, screenings, rule versions, cases, reports and the audit trail.

### How long
By default **5 years after the end of the relationship** (a setting to be confirmed against Central Bank requirements). A request to delete personal data does not override a regulatory retention period. After the period, personal data is erased or irreversibly anonymised. Ledger entries remain, because they contain no personal data.

### Immutability
Frozen report payloads, screening results and case decisions are append-only. A correction is a new record that refers to the old one.

### Reproducibility
A decision can be replayed: the rule version, the list versions and the input fingerprint are stored with it.

### Protection
National ID numbers and document contents are encrypted, shown masked and every read is logged.
@@end

@@article id=b09-10 book=9 order=10 title="If you notice something suspicious: what every employee should do" roles=ALL minutes=2 ui=AVAILABLE related=b09-01,b09-08,b03-06
You do not need to be sure. You only need to report. You are not accusing anyone; you are giving Compliance a reason to look.

### Examples that deserve a report
* A merchant's real activity looks nothing like what it described (a small clothes shop with the volume of a supermarket).
* Many payments just below a limit, repeated.
* A merchant asks to change its payout bank account several times, or to an account in another person's name.
* Someone offers you money or favours to approve something, or to skip a step.
* A colleague asks you to approve their own request, or to approve without reading.
* Two merchants that share the same phone, address, owner or documents.
* A customer or merchant asks unusual questions about our checks (for example "what amount triggers a review?").
* You are asked to move money outside the normal screens, by phone or chat.

### What to do
1. **Do not confront the person.** Do not warn them, do not tell them you are suspicious.
2. **Write down** what you saw: the merchant name, reference numbers, dates, who said what. Facts only.
3. **Tell Compliance** (or your manager if you cannot reach Compliance) the same day, in person or by the agreed internal channel. Do not put it in a merchant-visible place.
4. **Keep the secret.** Tell nobody else.
5. **Carry on normally** with the merchant. Do not change how you treat them.

:::note You will not be punished for a good-faith report that turns out to be nothing
Silence is the danger. If you are unsure, report.
:::
@@end


### BOOK 10 — WHEN THINGS GO WRONG

@@article id=b10-01 book=10 order=1 title="Incident principles: stay calm, protect money, write things down" roles=ALL minutes=2 ui=AVAILABLE related=b10-08,b10-09,b03-06
An **incident** is anything that threatens money, customers or trust: a partner is down, payments are stuck, numbers do not balance, a secret may have leaked.

### Seven principles
1. **Stop the harm first, understand later.** Pausing a route or a payout is reversible. A wrong payment is not.
2. **Never guess with money.** Use the evidence screens: the step log, the inbox, the statement.
3. **Tell people early.** Tell your manager and the role named in the runbook. Reporting quickly is never punished.
4. **One person leads.** Agree who is doing what; do not have two people act on the same item.
5. **Do not work around controls.** Two-person rules apply during incidents too. Only risk-*reducing* actions may be immediate ([[a:b04-04]]).
6. **Write as you go.** Time, what you saw, what you did, who agreed.
7. **Hand over in writing** ([[a:b10-08]]).

### Priorities
Cases and alerts carry `P1`, `P2` or `P3`. `P1` is the most urgent. Examples already defined by the platform: a conflict between trusted signals is P1; a late success is P2; a ledger drift is treated as P1.

### Which runbook?
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
### What you see
The dashboard tile **Open Circuit Breakers** is above zero. Customers report that a payment method is missing. A route's health shows `OPEN_BREAKER`.

### What the platform did by itself
After repeated partner faults the **circuit breaker opened**. The route is hidden, new payments move to the next healthy route (for example from a direct route to an aggregator), and small recovery tests repeat in the background.

### What you do
1. **Confirm it is real.** Open the route and look at its health measures. Check the environment.
2. **Tell the Gateway Admin** and your manager.
3. **Do not re-enable the route by hand** while the partner is still failing.
4. **Expect** payments already running to finish on their original settings, and some to become `UNKNOWN`.
5. When the breaker closes, check the **Unknown Backlog** tile and run [[a:b10-04]] if it grew.
6. **Tell merchants** (through your manager) only that a payment method is temporarily unavailable.

### Gateway Admin follow-up
Contact the partner; check whether the problem is on their side; if the route must stay off for long, pause it deliberately and record why. Pausing is a risk-reducing action and may be immediate. Resuming goes through the normal review.

### What not to do
Do not edit gateway settings to "try something" during an outage. Do not ask customers to retry repeatedly.
@@end

@@article id=b10-03 book=10 order=3 title="RB-02 Partner changed its signature or sender address" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=1 ui=AVAILABLE related=b06-06,b07-05,b10-02
### What you see
An alert about a **spike of signature failures**, or a **valid signature from an address not on our list**. Payments that depend on webhooks stay in `VERIFYING` or become `UNKNOWN`.

### What it usually means
The partner changed how it signs (field order, algorithm, case) or moved its servers.

### What the platform did
The raw messages were stored in the inbox unchanged, so nothing is lost.

### What you do
1. **Do not accept unsigned messages** to "get things moving". That is what an attacker wants.
2. **Gateway Admin:** contact the partner through the official contact and confirm the change in writing.
3. **Add the new secret version or address range** (an overlap, so old and new both work) through the two-person route: Gateway Admin proposes, Security Admin approves.
4. **Replay** the stored messages once the new recipe is approved.
5. Check that attempts resolve; then follow [[a:b10-04]] for what remains.
6. Record the change and the evidence.

### Warning
If the partner says it changed nothing, treat the event as a possible attack and tell the Security Admin ([[a:b10-07]]).
@@end

@@article id=b10-04 book=10 order=4 title="RB-03 A backlog of UNKNOWN payments" roles=OPERATOR,FINANCE minutes=1 ui=AVAILABLE related=b07-03,b07-09,b10-02
### What you see
**Unknown Backlog** and **Oldest** on the dashboard are rising, or the `UNKNOWN` bar in **Attempts By State** is growing.

### Steps
1. **Find the pattern.** Filter **Operator Cases** by route and period. Is it one partner? One time window?
2. **If one partner is failing**, follow [[a:b10-02]] too.
3. **Run Bulk Inquiry** for the affected route and period ([[c:sg-bulk-inquiry]]). Most attempts resolve by themselves when the partner answers.
4. **For rails that cannot be asked** (see [[a:b07-09]]): keep the customer page on "Confirming your payment", and resolve through the next statement or an operator decision with evidence.
5. **Prioritise** by amount and by age.
6. **Do not mass-resolve by hand.** Every manual resolution is a two-person decision with evidence.
7. **Report** progress to your manager at agreed intervals.

### When it is finished
The backlog is back to normal, the oldest item is recent, and cases carry notes of how each was resolved.
@@end

@@article id=b10-05 book=10 order=5 title="RB-04 Reconciliation or ledger drift: payouts stop" roles=FINANCE,SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b08-05,b08-06,b10-01
### What you see
The invariant screen shows a drift other than 0.0000, or reconciliation shows many `MISSING_AT_GATEWAY`, `MISSING_LOCALLY` or `AMOUNT_MISMATCH` lines.

### What the platform did
**Automatic payouts stopped.**

### Steps
1. **Treat it as P1** and tell your manager and the Security Admin.
2. **Do not cash out manually** while payouts are stopped.
3. **Re-run the statement ingest** and check that the file and its time zone are right ([[a:b08-06]]).
4. **Inspect each problem line.** `MISSING_AT_GATEWAY` is the most serious: we may have credited money we did not receive.
5. **Post fee variances** to the fee expense through the true-up ([[a:b08-10]]).
6. **Resolve unmatched items** through approved adjustments only.
7. **Never edit a number** to make it balance.
8. **Resume payouts** only when the drift is understood and zero, and your manager agrees.
@@end

@@article id=b10-06 book=10 order=6 title="RB-05 Credentials or tokens expired or failing" roles=GATEWAY_ADMIN,SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b06-09,b10-02
### What you see
A credential set turns `FAILING`. Its route disappears from customers' choices. Failures mention authentication.

### What the platform did
The route was removed from selection. Payments already running continue on their original credentials.

### Steps
1. **Check the cause:** expired secret, rotated token, changed password at the partner, or a merchant's own account problem (for merchant-owned credentials).
2. **Replace the secret** through the credential field (write-only). The change needs two people.
3. **Run CREDENTIAL_CHECK.** When it passes, the set becomes `VERIFIED` and the route returns.
4. **For merchant-owned accounts**, tell the merchant through your manager that its account needs attention.
5. **Plan rotations** so they overlap (two versions at once), to avoid downtime.
@@end

@@article id=b10-07 book=10 order=7 title="A secret may have leaked, or an account may be taken over" roles=ALL minutes=1 ui=AVAILABLE related=b11-03,b11-02,b10-01
### Signs
Someone else's activity under your account; an unexpected MFA request; you pasted a secret somewhere you should not have; a merchant says its token leaked; a partner says our secret was exposed.

### What to do at once
1. **Tell the Security Admin immediately.** Do not wait to be sure.
2. **Do not try to hide it or fix it quietly.**
3. **Change your own password** if it is your account, from a clean device, and tell the Security Admin so sessions can be revoked.
4. **For a merchant token:** the merchant revokes it in its portal and creates a new one.
5. **For a partner secret:** the Gateway Admin and Security Admin rotate it with an overlap ([[a:b10-06]]).
6. **Write down** what was exposed, where, and for how long.

### Why speed matters
A leaked secret is usable until someone replaces it.
@@end

@@article id=b10-08 book=10 order=8 title="Shift handover and the escalation ladder" roles=ALL minutes=1 ui=AVAILABLE related=b03-06,b10-01
### The handover note
At the end of a shift, write for the next person:
* what is open and why (case numbers or references),
* what you already tried,
* what you are waiting for and from whom,
* anything risky (an approval half-reviewed, a partner not answering),
* anything you promised to a merchant or customer.

### The escalation ladder
1. Your team lead or manager.
2. The role named by the runbook (Gateway Admin for partner issues, Security Admin for security, Finance for money, Compliance for AML).
3. The MLRO for AML decisions.

### Rules
* Never leave a half-finished approval or resolution without a note.
* Tell the next person about anything that could not wait.
* Do not hand over a secret.
@@end

@@article id=b10-09 book=10 order=9 title="You made a mistake: how to report and recover" roles=ALL minutes=1 ui=AVAILABLE related=b03-06,b08-08,b04-06
Everyone makes mistakes. Hiding them is what makes them expensive.

### Steps
1. **Stop.** Do not try to undo it by clicking more.
2. **Tell your manager at once**, then the role that owns the area.
3. **Write what happened**: what you did, which screen, which item, the time.
4. **Do not edit history.** Money mistakes are fixed by a new approved adjustment that offsets the old one ([[a:b08-08]]).
5. **Wrong approval** (before execution): tell the maker; the request can be rejected or withdrawn if not yet executed. Once executed, it is offset by a new entry.
6. **Information sent to the wrong person**: tell Security and Compliance now.
7. **Learn from it:** tell your manager what would have stopped you.

### What the platform tells you
Reporting quickly is never punished. Hiding is.
@@end

### BOOK 11 — SECURITY FOR EVERYONE

@@article id=b11-01 book=11 order=1 title="How attackers think, and what protects us" roles=ALL minutes=2 ui=AVAILABLE related=b02-02,b06-17,b11-02
### Attackers want three things
**Money** (steal it or move it), **information** (identities, secrets) and **disruption** (stop us working). They try the easiest way, and the easiest way is usually a person.

### A way to think: six questions (STRIDE)
| Threat | In plain words | Example here |
| :--- | :--- | :--- |
| Spoofing | Pretending to be someone | A forged webhook claiming "paid"; a fake support call |
| Tampering | Changing data | Changing `?status=success` in a return address |
| Repudiation | Denying an action | "I never approved that" |
| Information disclosure | Leaking data | A pasted secret; an exported file |
| Denial of service | Making us unavailable | Flooding the checkout |
| Elevation of privilege | Getting more power | Using another person's account |

### Our layers of defence
1. **Separation of services:** the public parts hold no database access and no secrets.
2. **Mutual identity checks** between our own services.
3. **Double-checking in the core**, even for requests from our own admin program.
4. **Two-person approval** for sensitive actions.
5. **Immutable records** of what was done.
6. **Secret handling:** encrypted, write-only, host-pinned, scrubbed from logs.
7. **Verification of everything inbound:** secret address, sender address, signature, timestamp, duplicate checks and a question back to the partner.

### Your part
The layers protect against attackers who attack the system. You protect against attackers who attack **you**: phishing, pressure, trickery ([[a:b11-02]]).
@@end

@@article id=b11-02 book=11 order=2 title="Phishing, impersonation and social engineering" roles=ALL minutes=2 ui=AVAILABLE related=b11-03,b10-07
**Social engineering** is tricking a person into doing something. It works because people want to be helpful and are afraid of upsetting authority.

### Common tricks
| Trick | Example | Your response |
| :--- | :--- | :--- |
| Urgency | "The CEO needs this payout now." | Slow down. Urgent requests use the normal screens. |
| Authority | "I'm from the bank / IT / the regulator." | Verify through a known number, not the one they give. |
| Fake support | "Read me the code on your phone." | Never. Nobody legitimate asks for a code. |
| Fake link | An e-mail with a login page | Do not click; type the address yourself. |
| A favour | "Approve my request, I'll approve yours." | Refuse and report ([[a:b09-10]]). |
| Pretext | A caller who knows some details | Details do not prove identity. |

### Rules
* Never give a password or one-time code to anyone, ever.
* Never act on instructions given only by chat or phone ([[a:b03-06]]).
* Verify unusual requests through a second channel you already know.
* Report suspicious messages to the Security Admin even if you did not click.
@@end

@@article id=b11-03 book=11 order=3 title="Passwords, MFA, sessions and devices: the rules" roles=ALL minutes=1 ui=AVAILABLE related=b01-07,b03-01,b10-07
1. **Unique, long password.** Never reused from elsewhere. Use an approved password manager if your company provides one.
2. **MFA always.** Keep your phone secure; if you lose it, tell the Security Admin immediately.
3. **Never share** your password, code or session. Not with a manager, IT or "support".
4. **Lock your screen** whenever you step away.
5. **Do not sign in on shared or personal computers.**
6. **Back Office only from the office network** (or the approved VPN).
7. **Short sessions are normal.** Sign in again; do not ask for an extension.
8. **Report a lost device or a suspected leak** the same minute ([[a:b10-07]]).
9. **Sensitive actions re-ask for sign-in** (for example creating an API token). This is protection, not a bug.
@@end

@@article id=b11-04 book=11 order=4 title="Handling data: personal data, exports, screenshots and chat" roles=ALL minutes=1 ui=AVAILABLE related=b03-04,b09-08,b05-04
### What counts as sensitive
National ID numbers, phone numbers, bank details, documents, any AML information, anything secret, and anything that identifies a customer.

### Rules
| Do | Do not |
| :--- | :--- |
| Quote references. | Quote names and numbers in chat. |
| Look at data inside the platform. | Copy it to personal notes, phones or e-mail. |
| Delete exports when done. | Keep exports in downloads folders. |
| Share only with people who need it for the task. | Forward "for information". |
| Report accidental exposure at once. | Hide it. |

### Screenshots
A screenshot copies data out of our controls. Take one only when policy allows, store it only where allowed, and delete it when finished. Never include a secret, a code or AML information.

### Masking
Masked values (like `091*****78`) are masked on purpose. Do not try to reveal them.

### Never put into chat, tickets or e-mail
Passwords, one-time codes, API keys, certificate keys, card numbers, national ID numbers.
@@end

@@article id=b11-05 book=11 order=5 title="Conduct and insider risk: protecting yourself and the company" roles=ALL minutes=1 ui=AVAILABLE related=b00-03,b04-01,b09-10
### Why it exists
Most losses involving staff are not dramatic. They are small shortcuts that become habits: approving without reading, sharing a login "to help", skipping a checklist.

### The rules that protect you
* **Do not use another person's account**, even with their permission.
* **Do not approve what you cannot explain** ([[a:b00-03]]).
* **Do not ask others to approve unseen.**
* **Do not look at records out of curiosity.** Every read is logged.
* **Do not accept gifts or favours** from merchants, partners or applicants.
* **Report pressure.** If anyone pushes you to bypass a control, report it.

### Why two-person control protects you
When something goes wrong, the record shows who proposed, who approved and what they were told. A reason written well ([[a:b04-06]]) and a checklist followed protect you.

### Consequences
Breaking these rules can lead to disciplinary action, and for some acts (tipping-off, theft, falsifying records) to legal action.
@@end

### BOOK 12 — DEPLOYMENT & HOSTING

@@article id=b12-01 book=12 order=1 title="Where each part runs: the one-to-five server model" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=2 ui=AVAILABLE related=b02-02,b12-02,b12-05
### Five logical roles
| Role | What runs there | Who may connect to it |
| :--- | :--- | :--- |
| Database host | The PostgreSQL 18 database | **Only** the core host |
| Core host | `core-back` (port 4000, mutual-TLS) | **Only** the three edge hosts |
| Admin host | `admin-back` (4101, local only) and the Back Office pages through a LAN-only web server | Office network only |
| Merchant host | `merchant-back` (4102, local only) and the merchant portal through a public web server | The public internet, encrypted |
| Checkout host | `checkout-back` (4103, local only) and the checkout through a public web server | The public internet, encrypted |

### One to five physical servers
The five roles can each have their own server, or share. The deployment tool groups roles by address:
* **Five servers:** every role isolated.
* **Two servers:** for example core, admin and database on an internal server, and merchant and checkout on a public server.
* **One server:** all roles on one machine (for small or staging use), still with separate ports and mutual-TLS.

### Rules that never change
* The **database host never shares an address with the core**.
* Only the core has database credentials and the master encryption key.
* The edge servers never receive database variables or the master key.
* The Back Office is never reachable from the internet and its port is never forwarded by the router.
@@end

@@article id=b12-02 book=12 order=2 title="Network protection: firewalls, LAN-only access and TLS" roles=SECURITY_ADMIN minutes=2 ui=AVAILABLE related=b12-01,b12-03
### Firewall rules per role
| Role | Open inbound | Blocked |
| :--- | :--- | :--- |
| Database | SSH, and the database port **only from the core's address** | everything else |
| Core | SSH, and port 4000 **only from the admin, merchant and checkout addresses** | the public internet |
| Admin | SSH, and the Back Office port **only from the office network ranges** | everything not on the LAN; port 4101 is local-only |
| Merchant | SSH, 80 and 443; 4102 is local-only | direct access to 4102 |
| Checkout | SSH, 80 and 443; 4103 is local-only | direct access to 4103 |

If several roles share a server, the rules are combined for that server. The SSH rule is always present and the firewall is enabled last, so a deployment can never lock itself out.

### TLS
Public portals use encrypted connections (TLS 1.3, HSTS, strict content rules). Web servers are configured so live-update streams are not buffered. Each portal's ports and whether TLS is on come from configuration; when TLS is turned off, the operator is responsible for the certificate set-up.

### Why Back Office is LAN-only
If staff screens were on the internet, an attacker anywhere could try passwords against them. On the office network, the attacker must first get inside.
@@end

@@article id=b12-03 book=12 order=3 title="Certificates and mutual TLS: who holds which key" roles=SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b01-07,b12-02,b12-04
### The idea
Between our own services, **both sides show an identity card** (mutual TLS). The core accepts only connections whose card is signed by our own internal authority **and** whose name matches the channel: the admin service may use only the admin channel, and so on.

### The cards
The deployment tool creates an internal certificate authority and four certificates:
* the **core** certificate (valid for the core's private address, the local address and an internal name),
* a client certificate for **admin-back**, one for **merchant-back**, one for **checkout-back**.

### Least privilege
* The authority's **private key never leaves the deployment workstation**.
* The core host receives only the authority's public certificate and its own certificate and key.
* Each edge host receives only the authority's public certificate and **its own** client certificate and key.
* So a compromised checkout server cannot impersonate the admin or merchant service, and has no database access or master key.

### Rotation
Certificates can be rotated with a flag on the deployment tool; the tool inspects validity dates and prints expiry dates in its audit summary. Track the expiry dates.
@@end

@@article id=b12-04 book=12 order=4 title="Configuration and secrets: deploy.env, the master key and what never leaves the core" roles=SECURITY_ADMIN minutes=1 ui=AVAILABLE related=b12-03,b11-04
### The configuration file
Deployment is driven by one file, `deploy.env`. It is **validated before the first server is contacted**: addresses, ranges, domain names, ports, database names, that the database address matches the engine, certificate paths, that merchant and checkout use different domains, and that ports are distinct.

### What the core alone holds
* the database connection,
* the **master encryption key** that protects every stored secret.

Neither is ever written to an edge server.

### How secrets travel
Secrets are streamed to the server over an encrypted connection so they never rest on the deployment workstation's disk. The shared environment file on each server is readable only by its owner.

### Rules
1. **Never commit** `deploy.env` or any key to a repository.
2. **Never paste** configuration values into chat or tickets.
3. Treat the master key as the most valuable secret: losing it makes stored secrets unreadable; leaking it exposes them.
4. A change to secrets or certificates is a **security change**: two people.
@@end

@@article id=b12-05 book=12 order=5 title="The twelve-step deployment, in plain words" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=2 ui=AVAILABLE related=b12-06,b12-07,b12-01
When a release is deployed, the tool runs these steps **in this order**, so that the core and database changes are ready *before* the outer services switch over:

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
| 10 | End-to-end check | Each edge completes a mutual-TLS handshake with the core and receives OK. A failure triggers an automatic return to the previous release. |
| 11 | Prune old releases | Keeps the most recent few (default five). |
| 12 | Audit summary | Prints the release, hosts and certificate expiry dates. |

Useful modes: a **dry run** prints every action without doing it; `--only` deploys one tier; `--update` and `--fresh` choose the mode.
@@end

@@article id=b12-06 book=12 order=6 title="Test environments: sandbox and the Fake Rails service" roles=GATEWAY_ADMIN,SECURITY_ADMIN,OPERATOR minutes=1 ui=AVAILABLE related=b01-08,b06-10,b12-07
### Sandbox
Every gateway has a sandbox environment on the partner's side ([[a:b06-10]]). It is where building and testing happen.

### Fake Rails
**Fake Rails** is our own internal testing service that **imitates payment companies**. It can be configured to behave badly on purpose (timeouts, wrong codes, duplicate or forged messages, conflicting answers) so we can practise and test how the platform reacts. The Employee Academy labs use it.

### Rules
* Fake Rails must **never run in production**. It is protected by explicit switches and allowed-host lists; a production deployment must leave them off.
* Never point live credentials at it.
* Never use real customer data in any test environment.
* Always check the **SANDBOX/LIVE** badge before acting.
@@end

@@article id=b12-07 book=12 order=7 title="Releases, rollback, backups and health checks" roles=SECURITY_ADMIN,GATEWAY_ADMIN minutes=1 ui=AVAILABLE related=b12-05,b12-08
### Releases
Each deployment creates a dated release folder. A `current` link points to the release in use. Switching is one atomic step. Services are restarted through a process manager.

### Rollback
Because old releases remain, going back is switching the link and restarting. If the end-to-end check fails during deployment, this happens automatically.

### Backups
Before database changes, a compressed backup is saved. Keep backups protected like production data.

### Health checks
The tool checks: the core over mutual TLS, each edge service's health address, each edge's handshake with the core on its own channel, and each public address. Use these results before telling anyone the system is "up".

### Targets (service objectives)
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
* The database is **PostgreSQL 18**. Only the core connects to it.
* Money is stored as exact decimals with four places, never as approximate numbers.
* **Timers live in the database**: when a payment expires, when to ask again. Background workers on any server pick up due items, and a database feature lets two workers avoid taking the same item. This means a restart or a crash does not lose a payment's timers.
* A terminal change is applied **at most once**, even if two servers pick the same item.
* Configuration changes are announced to all servers so none keeps an old copy.
* The weakest guarantee of this design is time: servers must keep correct clocks. Timestamps are stored in UTC.
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

This is the *typical* pattern. Your account's own maker and checker switches and authorities decide what you can really do ([[a:b03-02]]). Merchant-side roles are `MERCHANT_ADMIN`, `MERCHANT_STAFF` and `MERCHANT_CASHIER`.
@@end

@@article id=b13-04 book=13 order=4 title="About this guide: version, updates and the Academy" roles=ALL minutes=1 ui=AVAILABLE related=b00-02,b00-01
* Every build of the guide has a **content version**. Your reading progress records the version you read, so a major change can ask you to read again.
* The guide explains **rules, not records**. It contains no live data, no real thresholds, no names and no secrets.
* If the guide and the screen disagree, **stop and ask**; use **Report a problem** on the article.
* Some features exist in the design but have no screen yet. Those articles show a banner. See [[a:b03-08]].
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
@@term slug=mfa term="MFA" aliases="multi-factor;2FA" ar="التحقق متعدد العوامل" related=otp :: A second proof of identity, usually a code from an app.
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
Tell your manager and the owner of the area at once. A change that was executed is corrected by a new approved change, not by editing. See [[a:b10-09]].
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
- [ ] My reason says what I checked, what I found and why ([[a:b04-06]]).

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
Withdraw the pending reversal if it is wrong, and tell Finance. See [[a:b08-08]].
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
- [ ] My reason names the evidence ([[a:b04-06]]).

**Never**
- Never resolve because it is old.
- Never resolve from a customer's screenshot or phone call.
- Never ask the customer to pay again.

**If you made a mistake**
Tell your manager and Finance. A wrongly credited payment or a wrongly failed one is corrected by a new approved adjustment. See [[a:b07-03]].
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
If the customer paid again, handle the second payment as an overpayment through Finance ([[a:b07-08]]) and tell your manager.
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
Tell Compliance. An approved merchant can be suspended; a wrongly approved one is reviewed under [[a:b05-08]].
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
Withdraw the submission. If it went live badly, roll back to the named version and follow [[a:b10-02]].
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
- [ ] I know what to do with mismatches ([[a:b08-06]]).

**Never**
- Never edit the file to make it match.
- Never run a file from an unknown source.

**If you made a mistake**
Tell Finance. A wrong run is corrected through cases and adjustments, never by editing.
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
5. Resolve by hand only with evidence and a second person ([[c:sg-resolve-unknown]]).
### What not to do
Do not mark it failed because it is old. Do not ask the customer to pay again. Do not re-send an OTP.
@@end

@@situation id=s-customer-deducted title="A customer says money was deducted" screens=OperatorCases cases=1,5,10,19 articles=b07-12,b07-03,b07-08
### What it means
The customer's bank or wallet shows a deduction. Our status may be anything.
### What to do
Ask for the reference, look it up and follow the table in [[a:b07-12]]. If our status is not `SUCCEEDED`, create or update a case with the reference and time.
### What not to do
Do not promise a refund. Do not say "confirmed" from a screenshot.
@@end

@@situation id=s-method-missing title="A customer cannot see a payment method" screens=Routes,Rails cases=49,53,58,34 articles=b06-12,b06-11,b10-02
### What it means
One of the nine conditions of the visible-rails formula is failing.
### What to do
Walk down the table in [[a:b06-12]]: application list, link list, commission profile, route active, route healthy, limits and daily cap, maintenance and scope, credential verified, currency and blocked flag.
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
Follow [[a:b10-03]]. Never accept unsigned messages to get things moving.
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
Treat as P1. Payouts stop automatically. Follow [[a:b10-05]]. Never edit numbers.
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
Follow [[a:b10-06]]: replace the secret through two-person approval and run the credential check.
@@end

@@situation id=s-approval-refused title="A button is missing or an action was refused" screens=Approvals cases=75 articles=b03-07,b03-02
### What to do
Read [[a:b03-07]]. Do not work around it.
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

## III-E. Reading Paths by Role

@@path role=ALL title="New employee: day one to day five" :: b00-01,b00-02,b00-03,b00-04,b01-01,b01-02,b01-03,b01-04,b01-05,b01-06,b01-07,b01-08,b01-09,b01-10,b02-01,b02-02,b02-03,b02-06,b03-01,b03-02,b04-01,b04-03,b04-06,b11-02,b10-01
@@path role=OPERATOR title="Operator" :: b00-03,b03-05,b03-07,b04-03,b05-03,b05-04,b05-08,b05-09,b07-01,b07-02,b07-03,b07-04,b07-09,b07-12,b10-04,b09-08
@@path role=SUPPORT title="Support" :: b00-03,b05-09,b05-08,b07-01,b07-02,b07-03,b07-12,b09-08,b13-01
@@path role=FINANCE title="Finance" :: b04-05,b08-01,b08-02,b08-03,b08-04,b08-05,b08-06,b08-07,b08-08,b08-09,b08-10,b08-11,b08-13,b10-05,b07-03
@@path role=COMPLIANCE title="Compliance" :: b05-03,b05-04,b05-05,b09-01,b09-02,b09-03,b09-04,b09-05,b09-06,b09-07,b09-08,b09-09,b09-10,b04-04
@@path role=MLRO title="MLRO" :: b09-01,b09-05,b09-06,b09-07,b09-08,b04-04,b04-05,b09-04
@@path role=GATEWAY_ADMIN title="Gateway Admin" :: b06-01,b06-02,b06-03,b06-04,b06-05,b06-06,b06-07,b06-08,b06-09,b06-10,b06-11,b06-12,b06-13,b06-14,b06-16,b10-02,b10-03,b10-06
@@path role=SECURITY_ADMIN title="Security Admin" :: b04-05,b06-16,b06-17,b11-01,b11-03,b12-01,b12-02,b12-03,b12-04,b12-05,b12-07,b10-03,b10-07

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
    "KybReview"
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
    "MerchantDetail"
   ],
   "pageDir": "pages/merchants",
   "summary": "Look up a merchant, see its state and history, edit descriptive fields, submit sensitive changes for approval, suspend or reinstate it.",
   "articles": [
    "b05-01",
    "b05-08",
    "b05-09",
    "b04-02",
    "b04-04"
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
   "screenId": "OperatorCases",
   "routeNames": [
    "OperatorCases"
   ],
   "pageDir": "pages/operator-cases",
   "summary": "Tasks for payments and statement lines that need a human: unknown, conflict, mismatch, late success. Inquire first; resolve by hand only with evidence and a second person.",
   "articles": [
    "b07-03",
    "b07-04",
    "b07-08",
    "b07-09"
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
    "FinanceInvariant"
   ],
   "pageDir": "pages/finance",
   "summary": "Profit, cash cover and ledger integrity, all computed from the ledger. Any drift in the invariant is a priority-1 incident.",
   "articles": [
    "b08-05",
    "b08-11",
    "b10-05"
   ],
   "cards": [],
   "situations": [
    "s-ledger-drift"
   ]
  },
  {
   "screenId": "Gateways",
   "routeNames": [
    "Gateways"
   ],
   "pageDir": "pages/gateways",
   "summary": "The list of payment-company integrations. Create a gateway, open its wizard, or start the AI-assisted import. Gateways are versioned; the live version is never edited in place.",
   "articles": [
    "b06-01",
    "b06-13",
    "b06-14",
    "b06-16"
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
    "Routes"
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
    "SettingsCheckoutHelp"
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
    "AdminAcademy"
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
   "screenId": "General",
   "routeNames": [
    "Users",
    "Settings",
    "Profile"
   ],
   "pageDir": "(any other page)",
   "summary": "This screen is not described individually yet. Check your role and the environment badge, read before you click, and ask if unsure.",
   "articles": [
    "b03-02",
    "b03-03",
    "b03-06",
    "b03-07",
    "b03-08"
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

<!-- CONTENT:END -->
