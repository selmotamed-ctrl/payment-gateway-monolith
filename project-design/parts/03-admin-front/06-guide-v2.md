---
id: admin-ui.guide-v2
title: Admin Guide v2
status: implemented
confidence: high
last_verified: 2026-11-04
verified_against: working-tree
code:
  - admin-front/scripts/extract-guide-content.ts
  - admin-front/src/content/guide/**
  - admin-front/src/components/guide/**
  - admin-front/src/pages/guide/**
  - admin-front/src/router/index.ts
  - admin-front/src/layouts/default.tsx
  - admin-front/src/components/ui/PageHeader.tsx
  - admin-front/src/styles/guide.css
design_sources:
  - design/07-guides-and-academy/guide_system_design_and_content (2).md
tests:
  - tests/unit/guide-content.test.ts
  - tests/unit/guide-search.test.ts
  - tests/unit/guide-widgets.test.ts
  - tests/e2e/admin/guide-reader.spec.ts
  - tests/e2e/admin/guide-palette.spec.ts
  - tests/e2e/admin/guide-context.spec.ts
  - tests/e2e/admin/guide-safeguard.spec.ts
gaps:
  - Arabic article bodies (`articles.ar.json`) are not supplied; the loader falls back to English with an "Arabic version pending" chip.
  - Two safeguard cards have no separate current UI action; see `design/guide_content_questions.md`.
---

# Admin Guide v2

## 1. Status

The Admin Interactive Guide v1.0 from
`design/07-guides-and-academy/guide_system_design_and_content (2).md` is
implemented. The earlier 12-book embedded-content page has been replaced.

Delivered:

- 14 books, 125 articles, 151 glossary terms, 22 safeguard cards (99 checks), 29 situations, 8 reading paths, 58 quick answers, 19 error codes and the 140-case catalog.
- A deterministic extractor and committed JSON under `src/content/guide/generated/`.
- Eight guide routes: home, book, article, glossary, tools, playbook, cards and edge cases.
- Markdown reader with callouts, diagram fences, tables, stable heading ids, safe article/card/situation/glossary links and first-occurrence glossary popovers.
- MiniSearch command palette with Arabic-aware normalisation, grouping, recents and keyboard navigation.
- Contextual help button/drawer driven by the 23-screen context map, mounted automatically by `PageHeader`.
- 22 safeguard integrations at risky action points; Continue is disabled until all required checks are ticked.
- Five client-only simulators with published test vectors.
- Guide read tracking stored in the shared Academy progress JSON with a `localStorage` fallback.
- Unit, content, widget and Playwright coverage listed in the frontmatter.

## 2. Key invariants

1. Article prose is copied from the design by the extractor; it is never typed into TSX.
2. Generated JSON is committed and byte-stable; the content test re-runs the extractor and compares bytes.
3. Counts are asserted; content changes that alter a count must update the design table and meta contract.
4. Simulators use `decimal.js` and never `eval`/`new Function`.
5. Safeguards are additional to, not a replacement for, maker-checker and existing confirmations.
6. Guide routes need no authority; every admin may read the guide.
7. The guide contains no live data, secrets or external links.
8. Arabic content is a separate human-reviewed work package; the loader must never machine-translate.

## 3. Verification

```bash
cd admin-front && bun run content:guide && bun run type-check && bun run test:unit && bun run build
cd ../tests && bun run test:unit
cd ../tests && bunx playwright test --project=admin e2e/admin/guide-reader.spec.ts e2e/admin/guide-palette.spec.ts e2e/admin/guide-context.spec.ts e2e/admin/guide-safeguard.spec.ts
```
