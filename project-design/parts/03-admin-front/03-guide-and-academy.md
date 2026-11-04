---
id: admin-ui.guide
title: Admin Guide and Academy
status: partial
confidence: high
last_verified: 2026-11-04
verified_against: working-tree
code:
  - admin-front/scripts/extract-guide-content.ts
  - admin-front/src/content/guide/**
  - admin-front/src/components/guide/**
  - admin-front/src/pages/guide/**
  - admin-front/src/content/academy/**
  - admin-front/src/pages/academy/**
  - admin-back/api/protected/academy.ts
  - core-back/api/internal/admin.ts
design_sources:
  - design/07-guides-and-academy/guide_system_design_and_content.md
  - design/07-guides-and-academy/academy_system_design_and_content.md
  - design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md
tests:
  - tests/unit/guide-content.test.ts
  - tests/unit/guide-search.test.ts
  - tests/unit/guide-widgets.test.ts
  - tests/e2e/admin/guide-reader.spec.ts
  - tests/e2e/admin/guide-palette.spec.ts
  - tests/e2e/admin/guide-context.spec.ts
  - tests/e2e/admin/guide-safeguard.spec.ts
  - admin-front/src/content/__tests__/content-completeness.test.ts
  - admin-back/test/academy-progress.test.ts
gaps:
  - The Arabic article set (`articles.ar.json`) is not supplied; the loader falls back to English and the reader shows an "Arabic version pending" chip.
  - Academy mastery and certification are computed in the browser; the backend accepts the posted progress JSON and does not independently grade quizzes or labs.
  - There is no server-issued certificate or immutable certification registry beyond the progress JSON and export audit.
  - Current label mismatches and two safeguard cards with no matching UI action are recorded in `design/07-guides-and-academy/guide_content_fixes.md` and `design/07-guides-and-academy/guide_content_questions.md`.
---

# Admin Guide and Academy

## 1. Purpose and scope

This part owns two employee learning products in `admin-front`:

- The Admin Interactive Guide at `/guide/**`: 14 books, 125 articles, glossary, safeguard cards, situation playbook, 140-case catalog, five simulators, reading paths, search palette, contextual help and read tracking.
- The Employee Academy at `/academy`: lessons, labs, quizzes, mastery, badges, team reporting and XLSX exports.

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

Guide read tracking reuses the Academy progress JSON on the user row. `guideRead[articleId] = { v, at }` is merged into the existing Academy payload, so no migration is needed. The core and edge Zod schemas accept `guideRead`; the Academy page sends it back when persisting. The guide keeps a `pg.guide.read` `localStorage` mirror as an offline fallback and falls back to it if the progress API is unreachable.

## 7. Academy

The Academy remains the zero-to-hero curriculum:

- 8 modules (M1–M8), 17 lessons, 8 labs with fatal options and 64 quiz questions (8 per module).
- Six certification tracks including `MASTER_OPERATOR`.
- Mastery requires all lessons, a passed lab and a 100% quiz.
- Progress is stored on the user row; the team overview, summary and two XLSX exports require backend `user:read`.
- Certification is a computed badge, not a server-issued certificate.

## 8. Contracts and invariants

1. The design file content is the single source of truth; article prose is never retyped into TSX.
2. Generated JSON is committed and byte-stable; count changes require updating the design table and meta counts.
3. Guide content contains no live data, external links or secrets.
4. Guide routes have no authority gate; every admin may read the guide.
5. Money math in simulators uses `decimal.js`; no `eval`, `new Function` or `vm`.
6. Safeguards never replace existing confirmations or maker-checker rules.
7. Opening contextual help must not reset the current form.
8. The guide and Academy share one progress record; a save from either page preserves the other's fields.

## 9. Verification

```bash
cd admin-front && bun run content:guide && bun run type-check && bun run test:unit && bun run build
cd ../tests && bun run test:unit
cd ../tests && bunx playwright test --project=admin e2e/admin/guide-*.spec.ts
cd ../admin-back && bun test test/academy-progress.test.ts test/admin-surface.test.ts
```
