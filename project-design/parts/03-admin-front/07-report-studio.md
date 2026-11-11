---
id: admin-ui.report-studio
title: Report Catalog, Studio and Chrome
status: implemented
confidence: high
last_verified: 2026-11-10
verified_against: working-tree
code:
  - admin-front/src/pages/reports/**
  - admin-front/src/lib/reportEngineSdk/**
  - admin-front/src/constants/i18n/reports.ts
  - admin-front/src/router/index.ts
  - admin-front/src/utils/routeAuthorities.ts
  - admin-front/src/layouts/sections.tsx
  - admin-front/src/constants/urlsMap/index.ts
  - admin-front/src/components/reports/**
  - admin-front/src/utils/reports/**
  - admin-back/api/protected/reportEngine.ts
design_sources:
  - design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md
tests:
  - admin-front/src/lib/reportEngineSdk/__tests__/**
gaps:
  - `SERVER_PDF` is not available from the UI; the print path uses Paged.js in the browser and ECharts SVG.
  - The catalog has no archive/restore action for report versions; Chrome headers/footers can be archived.
  - The Studio does not yet expose a visual drag-and-drop section builder; sections are edited as structured JSON with a draft preview.
  - The `.zip` upload stores assets locally on the core host; there is no object-store picker.
---

# Report Catalog, Studio and Chrome

## 1. Routes

| Path | Route name | Authority | Purpose |
| :--- | :--- | :--- | :--- |
| `/reports/catalog` | `ReportsCatalog` | `reports.draft` / `reports.run` | Published reports, language selection, input form and print/preview. |
| `/reports/studio` | `ReportsStudio` | `reports.studio` | AI transcript, JSON spec editor, five-layer verification, authority override and publish. |
| `/reports/chrome` | `ReportsChrome` | `reports.studio` | Reusable header/footer registry and default selection. |

The routes are registered in `admin-front/src/router/index.ts`, projected from `report_engine:author` / `report_engine:run` in `core-back/lib/auth/uiAuthorities.ts`, and shown in the Reporting section of the shell.

## 2. Catalog

The catalog page:

- loads the authority-filtered published catalog from the edge with server-side page, page size, search and sort through the shared `ApiTable` (the same pagination pattern as the Merchants page);
- keeps the audience tabs server-filtered (`ALL`, `BACKOFFICE_INTERNAL`, `MERCHANT_FACING`);
- prompts for a locale when the report supports more than one (`ReportLanguagePromptDialog`);
- renders the typed input form (`ReportInputForm`) with entity autocomplete and date-range validation;
- executes the report, shows KPI/table/chart/vector sections, and prints through the isolated Paged.js surface;
- exposes the verification hash and the resolved header/footer.

## 3. Studio

The Studio page:

- downloads the report authoring transcript from the API;
- accepts a `ReportDescriptorSpec` JSON and an optional `.zip` asset bundle;
- runs the five verification layers and renders every diagnostic with a human-readable title, path, code, severity and `aiFixHint` through `ReportDiagnosticsPanel`; API failures also show extracted diagnostics and a friendly message;
- shows the AI repair prompt for a rejected spec;
- saves a draft and publishes a verified version;
- shows the inferred roles/authorities and, for a Security Admin, the override form with a mandatory justification.

## 4. Chrome registry

The Chrome page lists header/footer specs with server-side pagination, search and sort through `ApiTable`, shows their type/status/supported locales and the single global default per type, and archives a header/footer instead of hard-deleting it. It creates a new version from an edited spec and sets the global default. Save/publish failures map duplicate, reference and storage/database errors to explicit API codes, render `ReportDiagnosticsPanel` when the server returns diagnostics, and invalid JSON/schema input returns 400 rather than 500. The default seed creates `cbl-institutional-header-v1` and `cbl-institutional-footer-v1`.

## 5. Client rendering SDK

`admin-front/src/lib/reportEngineSdk/**` is independent of the pages:

- `render/reportHtmlRenderer.ts` renders KPI, table, chart, vector, HTML and image sections and binds chrome variables;
- `print/ClientVectorPdfExporter.ts` builds the `@page` CSS Paged.js document with running header/footer, repeated table headers and vector charts;
- `components/ReportVectorDrawRenderer.tsx` mirrors nodes for RTL;
- `components/ReportChartRenderer.ts` renders ECharts SVG;
- `sanitizer/ClientDomSanitizer.ts` strips active content before preview/print;
- `utils/inputDefaults.ts` and `utils/localeMeta.ts` resolve presets and language options.

## 6. Tests

`admin-front/src/lib/reportEngineSdk/__tests__/**` covers value formatting, preset defaults, Arabic KPI/table/vector rendering, RTL mirroring, chrome binding, the paged-media document, the language options and the fallback sanitizer. The Vitest include list was extended to run these tests.

## 7. Audience, chrome and AML controls

The Catalog has All / Backoffice Internal / Merchant Reports tabs. Chrome selectors are hidden when the report sets `allow_runtime_chrome_selection=false`. CSV/XLSX exports include every dataset (with a `dataset` column).

The Studio reports the domain filter using catalog domains (`LEDGER`, `PAYMENTS`, ...), can download the Chrome transcript, supports clearing an override, and can request a confidential AML bypass. An MLRO or Security Admin sees the pending bypass list and can approve/reject it; maker and checker must differ.

The Studio renders a read-only draft preview through `POST /report-engine/specs/preview` (sample inputs, no persistence) inside the same sandboxed Paged.js surface as the Catalog. It loads the version history for a saved report code and can archive a version. The Chrome page previews registered logos using the asset data returned by the API and keeps one published global default per type. Report execution returns `404 REPORT_NOT_FOUND` only when the code does not exist and `409 REPORT_NOT_PUBLISHED` when a non-published version exists.

## 8. Layout and action polish (2026-11-09)

All three pages use the shared `ScreenContainer`/`ThemedView` page shell, so they inherit the desktop/mobile screen padding and the 18px section rhythm. Catalog and Studio tables use `pg-unified-table` plus the shared `Table/styling.css`; the Catalog row actions use `TableRowActions` (Run primary, Copy code/Download spec/Open Studio overflow).

Actions added: Catalog Refresh/Open Studio/Headers & Footers, row copy/download/open, Reset inputs, Clear selection, Regenerate; Studio Open Catalog/Headers, Refresh pending, Format/Copy/Download/Clear editor, verification badge and disabled Save/Publish until verification passes; Chrome Refresh/Open Catalog/Studio, Format/Copy/Download/Clear editor, publish/make-default switches, empty/loading states and per-row Edit/Copy code/Download spec/Preview/default actions. The Paged.js preview toolbar now uses theme tokens, wraps on small screens and uses a responsive height.

## Report run form (2026-11-10)

The Catalog run drawer is built as a filter-style form rather than a dense grid. `ReportInputForm` groups visible inputs into **Report scope**, **Reporting period** and **Filters and options** sections, with an uppercase muted section title and a short description. Fields are stacked one per row; `FormField` gained a `filter` variant that uses the same label/control anatomy as `TableFilters` (`pg-filter-label`, 36 px compact outlined controls, 13 px inputs). Every field has a label (spec translation or a humanised fallback key) and a description (the spec's `help_i18n_key` or a type fallback such as “Search and select a record.”). The output language, page header/footer and template selectors live in an **Output options** section, and Reset/Clear/Generate are pinned in the `SlideOverDrawer` footer. The drawer is 720 px wide and capped at `100vw` on narrow screens.

## Studio mock preview and A4 containment (2026-11-10)

The Studio draft preview now defaults to **Mock data** and offers a **Live sample** toggle. Mock mode still verifies the spec, then renders a deterministic, database-free bundle in which every dataset, transform output, KPI, table, chart, vector node and image asset is populated; `includeHiddenSections` renders visibility-gated sections too, so nothing is silently omitted from a draft. Live mode runs the same preview endpoint with `mode: "LIVE"`, the caller inputs and the real read-only query line. The preview badge shows which mode produced the pages.

The shared paged-media stylesheet now enforces A4 containment: fixed-layout data tables, long-value wrapping, constrained HTML-template tables, `max-width:100%` on SVGs/images/chrome elements and Paged.js content wrappers. `tests/e2e/admin/report-a4-layout.spec.ts` logs into the live admin edge, previews a real spec in mock mode, paginates it through Paged.js and asserts there is no horizontal overflow in English/Arabic and portrait/landscape. This is the regression gate for report width.

## Print layout hardening (2026-11-11)

The Studio preview and print path now enforce the A4 print contract: KPI grids max 3 columns with bottom-anchored values and length-aware font scaling, chart rows centered with HTML legends that wrap without hiding entries, pie/donut labels suppressed in favor of the legend, table typography reduced for wide tables, long chips shrunk instead of broken, repeated table headers across Paged.js fragments, compact table sections kept together, and true landscape pages in the exported PDF. The shared bridge injects print page rules after Paged.js rendering because Paged.js removes the author `@page` rules; without this pass Chrome printed all pages portrait.

The A4 regression spec (`tests/e2e/admin/report-a4-layout.spec.ts`) now measures the sheet, not just the content box, and asserts table headers, KPI limits, chart-row centering, orphan titles, vertical overflow and orientation. It can also export the paginated PDF for visual review.

## Chrome layout and A4 preview (2026-11-11)

The Report Headers & Footers page now previews the selected chrome on a real A4 page frame with sample body content, the global default counterpart, the header top 2 mm/22 mm slot and footer bottom 4 mm/16 mm slot. The preview uses realistic report title/subtitle, period, currency, actor and generated-at values so it matches the reference institutional chrome.

The renderer fills the chrome slot with the template root, supports the structured `accent_band` (multi-color hard-stop gradient) and suppresses the legacy single-color border when a band is present. The transcript documents the band, `defaultCurrency`, locale-formatted period/generated timestamps and the slot-fill rule. The A4 report gate now measures chrome fill, band colors/height, header-to-body and footer-to-page offsets, and formatted variables through `tests/e2e/admin/chrome-layout.spec.ts`; `tests/e2e/admin/chrome-preview.spec.ts` covers the Studio A4 preview.
