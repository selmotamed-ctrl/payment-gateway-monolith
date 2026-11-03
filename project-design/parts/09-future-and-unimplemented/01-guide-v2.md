---
id: future.guide-v2
title: Admin Guide v2 (Future)
status: missing
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - admin-front/src/pages/guide/index.tsx
  - admin-front/src/content/guide/**
  - admin-front/src/pages/academy/index.tsx
  - admin-front/src/content/academy/**
design_sources:
  - design/guide_system_design_and_content (2).md
  - design/complete_zero_to_hero_guides_and_academy_specification.md
tests:
  - admin-front/src/content/__tests__/content-completeness.test.ts
gaps:
  - The 14-book, 125-article guide described here does not exist.
  - The current guide is a 12-book, embedded-content single page with three simulators.
  - No generated v2 article/glossary/card/situation JSON pipeline exists; the current guide uses TypeScript content arrays.
  - No contextual help drawer or safeguard dialog exists on admin screens.
  - The v2 Arabic article set (`articles.ar.json`) does not exist; the current 12-book guide has bilingual fields but not the v2 content model.
---

# Admin Guide v2 (Future)

## 1. Purpose and scope

This part preserves the complete future design for the admin interactive guide, employee academy integration, glossary, safeguard cards, command palette, contextual help and five simulators.

It is **not current behaviour**. The current admin portal has a working 12-book guide and an 8-module academy, but it does not have the 14-book/125-article structure, generated content pipeline, contextual help drawer, safeguard dialogs, five simulators, playbook, edge-case catalog or the v2 Arabic content described here.

This part also records the relationship between the current guide and the future design so no reader mistakes the design for shipped functionality.

## 2. Design intent (future, not current)

### 2.1 Why rebuild

The historical design says the old guide reads like a feature tour: ten short books plus three simulators, assuming the reader already knows what a gateway, ledger, OTP, webhook or AML is. The new guide has three jobs, in priority order:

1. **Prevent human error at the moment of action.** Every screen gets a "?" drawer; every risky action gets a checklist before it executes.
2. **Teach from zero.** Anyone who can read can understand the system. Every unfamiliar word is defined where it first appears and again in the glossary.
3. **Be the incident reference.** Calm runbooks, a symptom-to-action playbook and a plain-language catalog of the 140 edge cases.

### 2.2 Audience

| Audience | Need | Path |
| :--- | :--- | :--- |
| New employee, any role | Vocabulary and the big picture | Book 0 -> Book 1 -> Book 2 |
| `OPERATOR`, `SUPPORT` | Daily queues, statuses, `UNKNOWN` | Books 3, 5, 7, 10 |
| `FINANCE` | Ledger, settlement, cash-outs, refunds, disputes | Books 4, 7, 8 |
| `COMPLIANCE`, `MLRO` | AML program, cases, reporting, confidentiality | Books 4, 5, 9 |
| `GATEWAY_ADMIN`, `SECURITY_ADMIN` | Gateways, rails, routes, credentials, deployment, security | Books 4, 6, 11, 12 |
| Management | The rules everyone is held to | Book 0, Book 4, Book 13 |

All seven admin roles can open every article. Roles only change recommendations and reading paths. The guide contains no live data, real thresholds, names or secrets.

### 2.3 Writing principles

1. Zero assumed knowledge. Define every term at first use. Never write "obviously", "simply" or "just".
2. Say who, where, what, why and what happens if the reader gets it wrong.
3. Short sentences and concrete numbers (100 LYD, 3 percent commission).
4. One meaning per word. Use the same term consistently.
5. Be honest about gaps: `ui=NOT_YET` banner and who performs the task today.
6. Safety first, in plain voice. Warnings explain the consequence, not just the rule.
7. No secrets, live data or external links.
8. Version every build with `contentVersion`; reading progress records the version.

### 2.4 Scope

In scope: Admin Guide `/guide/**`, global command palette, contextual "?" drawer, safeguard checklists, five simulators, glossary auto-linking, symptom playbook, 140-case catalog, reading paths, read tracking, English content with Arabic-ready terms.

Out of scope: Merchant Guide, Checkout Help, changes to payment/ledger/engine behaviour, server-side search, analytics, external links, AI/LLM features.

## 3. As-built architecture

### 3.1 Current guide (predecessor, not v2)

The current implementation is:

- `admin-front/src/pages/guide/index.tsx`: one page with books, chapters, glossary, search and simulators.
- `admin-front/src/content/guide/booksPart1.ts` and `booksPart2.ts`: embedded `GuideBook[]` arrays.
- `admin-front/src/content/guide/glossaryData.ts`, `search.ts`, `types.ts`, `index.ts`.
- `admin-front/src/content/academy/*`: eight academy modules across `modulesTrackA.ts` and `modulesTrackB.ts`.
- `admin-front/src/pages/academy/index.tsx`: the employee academy page.
- `admin-front/src/router/index.ts`: only `AdminGuide` (`/guide`) and `AdminAcademy` (`/academy`) under the Learning section.
- The current guide has **12 books** and **8 academy modules**.
- The current guide has three simulators: transform sandbox, crypto lab and ledger T-account explorer.
- The current guide has `GlobalGuideSearchModal`, glossary definitions and 140 edge-case definitions, but it has no v2 `GuideSearchPalette`, `ContextHelpDrawer`, `SafeguardDialog`, `playbook`, `cards` or `edge-cases` routes.
- `admin-front/src/content/__tests__/content-completeness.test.ts` asserts the current content shape, not the v2 counts.

`design/complete_zero_to_hero_guides_and_academy_specification.md` describes an alternative 12-book admin guide, 8-module academy, 10-chapter merchant guide and developer API guide. It is the current guide's lineage. It is **not** the 14-book guide v2.

### 3.2 Future information architecture

Routes:

| Route | Purpose |
| :--- | :--- |
| `/guide` | Home: search, Start here, role path, continue reading, books, tools, "I'm stuck" |
| `/guide/book/:bookId` | One book: summary, ordered articles, progress ring |
| `/guide/a/:articleId` | Article reader with TOC, glossary tooltips, mark-as-read, prev/next |
| `/guide/glossary/:slug?` | A-Z glossary with filter; one entry deep-linkable |
| `/guide/tools/:tool?` | Simulator gallery |
| `/guide/playbook/:id?` | "What you may see, and what to do" situation cards |
| `/guide/cards/:id?` | Safeguard cards |
| `/guide/edge-cases` | Full 140-case catalog with filters |
| Global `Ctrl/Cmd+K` | Command palette over articles, glossary, cards, situations, error codes, edge cases |
| PageHeader "?" | Contextual drawer for the current screen |

Route names: `AdminGuide`, `AdminGuideBook`, `AdminGuideArticle`, `AdminGuideGlossary`, `AdminGuideTools`, `AdminGuidePlaybook`, `AdminGuideCards`, `AdminGuideEdgeCases`. They need no authority because every admin must be able to read the guide.

### 3.3 The 14 books

| Book | Title | Articles |
| ---: | :--- | ---: |
| 0 | Start Here | 4 |
| 1 | Foundations from Zero | 10 |
| 2 | The Platform Map | 7 |
| 3 | Working in the Back Office | 8 |
| 4 | Governance: Four Eyes | 7 |
| 5 | Merchants | 10 |
| 6 | Gateways, Rails & the Engine | 17 |
| 7 | Payments in Operation | 12 |
| 8 | Money & the Ledger | 13 |
| 9 | Risk, AML & Compliance | 10 |
| 10 | When Things Go Wrong | 9 |
| 11 | Security for Everyone | 5 |
| 12 | Deployment & Hosting | 8 |
| 13 | Reference | 5 |
| **Total** | | **125** |

### 3.4 Expected content counts

| Item | Count | Source |
| :--- | ---: | :--- |
| Books | 14 | `@@book` blocks |
| Articles | 125 | `@@article` blocks |
| Glossary terms | 151 | `@@term` lines |
| Safeguard cards | 22 | `@@card` blocks |
| Safeguard checklist items | 99 | `- [ ]` lines inside cards |
| Situations | 29 | `@@situation` blocks |
| Reading paths | 8 | `ALL` plus seven staff roles |
| Quick answers (FAQ) | 58 | `@@faq` blocks |
| Data blocks | 3 | `ledger-events` (16 events), `visible-rails` (7 vectors), `attempt-transitions` |
| Context-map screens | 23 | `screens` array |
| Error codes | 19 | Article `b13-01` |
| Edge cases | 140 | Parsed from `design/payment-gateway-refined-design-v4.1.md` |

The content test must fail if `meta.json.counts` differs.

### 3.5 Content pipeline

The source is `design/guide_system_design_and_content (2).md`, parsed between `<!-- CONTENT:BEGIN -->` and `<!-- CONTENT:END -->`.

Block syntax:

- `@@book`
- `@@article` with Markdown body, `@@end`
- `@@term`
- `@@card` with four fixed headings
- `@@situation`
- `@@path`
- `@@data` / `@@map` with one JSON fence
- `@@faq`

The extractor is `admin-front/scripts/extract-guide-content.ts`, run by `bun run content:guide`. It must:

1. Locate the design file, normalise CRLF.
2. Parse only between the markers.
3. Fail on unknown blocks, duplicate ids, missing `@@end` or invalid JSON.
4. Validate every cross-reference.
5. Emit `books.json`, `articles.en.json`, `glossary.en.json`, `cards.en.json`, `playbook.en.json`, `paths.json`, `faq.en.json`, `data.json`, `context-map.json`, `meta.json`, `error-codes.en.json` and `edge-cases.en.json`.
6. Parse edge cases from the v4 design and require exactly 140 rows.
7. Commit the generated files; a test re-runs the extractor and compares bytes.

Types: `Book`, `Article`, `Term`, `Card`, `Situation`, `ContextScreen`, `EdgeCase`, `Role`, `UiStatus`. Loaders use dynamic `import()` and fall back to English.

Markdown dialect: CommonMark plus tables, callouts (`:::note`, `:::tip`, `:::warning`, `:::danger`, `:::example`, `:::do`, `:::dont`), `{{widget:<id>}}`, article/card/situation/glossary links, stable heading ids, `diagram` fences and no raw HTML or external links.

### 3.6 Glossary, search and context help

Glossary:

- Match terms and aliases case-insensitively, whole word, longest first, with Unicode-aware boundaries.
- Wrap the first occurrence per article in a button.
- Do not wrap headings, code, links, table header cells, callout titles or the glossary page.
- Popover is a focus-trapped dialog with term, short definition, Arabic term, glossary link and related terms.
- Hover is never the only way to read a definition.

Search:

- `minisearch` fields: title (5), headings (3), aliases (4), plainText (1).
- `prefix:true`, `fuzzy:0.2`, `combineWith:"AND"` then `"OR"` on zero results.
- Document types: article, term, card, situation, edge case, FAQ, error code.
- Normalise Arabic diacritics, tatweel, alef/ya/ta-marbuta variants and Arabic-Indic digits.
- Group results, max 8 per type, keyboard navigation, recent queries in `localStorage` under `pg.guide.recent`.
- Lazy index build; target under 150 ms and fail tests above 1,000 ms.

Context help:

- `PageHeader` mounts `ContextHelpButton` automatically using the route name.
- `context-map.json` maps `routeNames` to `pageDir`, summary, articles, cards and situations.
- Unknown route uses a fallback screen.
- Drawer is 420 px, non-modal, opposite side in RTL, preserves page state.
- Sections: what the screen is for, Before you act, Common problems, Learn more, Open the whole guide.
- A test enumerates every router name except Login/NotFound and requires a mapping.

### 3.7 Safeguard cards

A card has exactly four bold headings: `**What this does**`, `**Check first**` with `- [ ]` items, `**Never**` and `**If you made a mistake**`.

`useSafeguard(cardId).confirm()` opens a dialog. Every checklist item is required; Continue is disabled until all are ticked; Cancel resolves false. Ticks are client-side only and reset every time.

The 22 cards are:

`sg-approve-request`, `sg-reject-request`, `sg-propose-adjustment`, `sg-reverse-adjustment`, `sg-process-cashout`, `sg-reject-cashout`, `sg-resolve-unknown`, `sg-release-reservation`, `sg-bulk-inquiry`, `sg-approve-join-request`, `sg-reject-join-request`, `sg-suspend-merchant`, `sg-reinstate-merchant`, `sg-edit-merchant-sensitive`, `sg-aml-propose-resolution`, `sg-aml-disposition`, `sg-aml-rule-change`, `sg-aml-report`, `sg-submit-gateway-version`, `sg-edit-route`, `sg-ai-import-draft`, `sg-run-reconciliation`.

Integrations guard the matching Approve/Reject/Propose/Reverse/Process/Create/Save/Run actions on approvals, adjustments, cash-outs, operator cases, join requests, merchants, AML, gateway wizard, routes, AI import and reconciliation. Existing confirmation dialogs must remain.

### 3.8 Internationalisation and progress

- UI chrome strings go through the existing locale system with English and Arabic entries.
- Content loader tries `articles.ar.json`; if missing, shows "Arabic version pending" and renders English with `lang="en" dir="ltr"`.
- Glossary `ar=` is mandatory for later translation.
- Read tracking reuses the Academy progress JSON (`guideRead`), with a `localStorage` fallback under `pg.guide.read`.
- No schema migration is required.

### 3.9 Five simulators

All simulators are client-only, deterministic, keyboard accessible, have a Reset button and an "Explain this result" panel, use `decimal.js` for money and display "Teaching tool — not connected to any real system."

| Simulator | What it teaches | Key vectors / data |
| :--- | :--- | :--- |
| `transform-sandbox` | Closed transform library and amount scaling | T1-T12, including `10.50 -> scale(1000) -> to_int -> "10500"` and `76.255 -> round(NEAREST) -> "76.26"` |
| `crypto-lab` | Canonicalisation, key encodings and signatures | C1-C4 HMAC-SHA256 vectors; shows canonical string and match/no-match |
| `ledger-explorer` | Double-entry T-accounts | 16 ledger events; E02 defaults balance at 100.8000 debit/credit |
| `visible-rails` | Nine-predicate rail visibility | 7 vectors; shows first failing predicate |
| `attempt-states` | Attempt transitions | Shows new state, slot reservation, money posted and human action |

The source also names the data blocks `ledger-events`, `visible-rails` and `attempt-transitions`.

### 3.10 Tests and quality bars

Unit tests:

- `guide-content.test.ts`: extractor byte equality, expected counts, links, non-empty bodies, no external URLs, unique slugs, non-empty card checklists, router coverage, card ids, widget ids, gzip under 400 KB.
- `guide-search.test.ts`: query normalisation and top results; index build under 1,000 ms.
- `guide-widgets.test.ts`: all simulator vectors.

E2E:

- `guide-reader.spec.ts`: search, article, glossary keyboard popover, mark-as-read persistence, no overflow at 360/1280, Arabic RTL.
- `guide-palette.spec.ts`: Ctrl+K, type, Enter, Esc, focus return.
- `guide-context.spec.ts`: five routes, "?" drawer, at least one card, form state preserved.
- `guide-safeguard.spec.ts`: Approve opens the dialog, Continue disabled until all checked, Cancel sends no request.

Quality bars: Lighthouse accessibility at least 95, keyboard reachability, AA contrast, first article render under 500 ms, no `#app` transform and no horizontal overflow.

### 3.11 Delivery phases

- `G-0`: extractor, generated JSON, content test.
- `G-1`: reader routes/pages, Markdown renderer, glossary, paths, status banner.
- `G-2`: search and command palette.
- `G-3`: five simulators and tools page.
- `G-4`: context drawer, safeguard dialog, 22 integrations.
- `G-5`: read tracking and progress.
- `G-6`: delete old `content.ts`, audit labels, record content fixes/questions, full test run.

## 4. Contracts and invariants (future)

1. The source content is copied, not rewritten, summarised or machine-translated.
2. Counts in `meta.json` equal the expected table.
3. Generated files are committed and byte-stable.
4. Every cross-reference resolves.
5. No article contains an external URL.
6. All money math uses `decimal.js`; no `eval`, `new Function`, `Function` or `vm`.
7. Every risky action integration calls the safeguard before the request.
8. Guide routes require no authority, but the underlying action still does.
9. Neither the guide nor the drawer unmounts or loses page form state.
10. The guide never scales `#app` or introduces horizontal overflow.

## 5. Data / API / config / deployment surface (future)

- `admin-front/scripts/extract-guide-content.ts`
- `admin-front/src/content/guide/generated/*.json`
- `admin-front/src/content/guide/index.ts`
- `admin-front/src/components/guide/**`
- `admin-front/src/pages/guide/{index,book,article,glossary,tools,playbook,cards,edge-cases}.tsx`
- `admin-front/src/components/PageHeader/index.tsx`
- `admin-front/src/layouts/default.tsx`
- `admin-front/src/router/index.ts`
- `admin-front/src/layouts/sections.tsx`
- `tests/unit/guide-*.test.ts`
- `tests/e2e/admin/guide-*.spec.ts`
- `design/guide_content_fixes.md` and `guide_content_questions.md`
- Only new dependencies: `markdown-it` and `minisearch`.

## 6. Operational usage

Not applicable. No v2 guide exists. The current guide is reached at `/guide` and the academy at `/academy`.

## 7. Status and deviations

### Implemented

Nothing from guide v2. The repository has a 12-book guide and 8 academy modules, which are the predecessor, not this design.

### Partial

Nothing from guide v2 is partially implemented under the v2 structure.

### Missing / deferred

All 14 books, 125 articles, 151 glossary terms, 22 cards, 99 checklist items, 29 situations, 8 paths, 58 FAQs, 3 data blocks, 23 context screens, 19 error codes, 8 v2 routes, the command palette, context drawer, safeguard system, five simulators and the generated v2 content pipeline. The 140 edge-case definitions already exist in the current guide; the v2 design adds the dedicated `/guide/edge-cases` route and generated JSON. The v2 Arabic article set is also absent.

### Known bugs / risks

- **Documentation risk:** SC-019 previously presented guide v2 as current. It is not.
- **Content risk:** the current guide has stale claims (for example, "10 GL accounts" in one chapter title) that the v2 content must correct to 11.
- **Design risk:** the extractor depends on a design file whose name contains spaces and parentheses; path resolution and CI must handle it exactly.
- **Scope risk:** the 140 edge cases are parsed from a separate v4 design file; moving or renaming that file breaks the build.

## 8. Verification and tests

There are no v2 tests. Acceptance requires the unit and E2E suites in section 3.10, plus exact content counts and generated-file byte equality. The current completeness test is not evidence for v2.

## 9. Source references

### Old design sections

- `design/guide_system_design_and_content (2).md` Parts 0-III, especially II-1 through II-13.
- `design/complete_zero_to_hero_guides_and_academy_specification.md` for the current 12-book/8-module lineage.
- `design/payment-gateway-refined-design-v4.1.md` section 13 for the 140 edge cases.

### Code paths

- `admin-front/src/pages/guide/index.tsx`
- `admin-front/src/content/guide/booksPart1.ts`
- `admin-front/src/content/guide/booksPart2.ts`
- `admin-front/src/content/guide/glossaryData.ts`
- `admin-front/src/content/guide/search.ts`
- `admin-front/src/pages/academy/index.tsx`
- `admin-front/src/content/academy/modulesTrackA.ts`
- `admin-front/src/content/academy/modulesTrackB.ts`
- `admin-front/src/router/index.ts`

### Generated appendices

- `project-design/appendices/stale-claims-register.md` (SC-019)
- `project-design/appendices/design-source-map.md`

## 10. Change history

- 2026-11-03: initial future design. Status explicitly `missing`; not current behaviour.
