---
id: admin-ui.report-studio
title: Report Catalog, Studio and Chrome
status: implemented
confidence: high
last_verified: 2026-11-09
verified_against: working-tree
code:
  - admin-front/src/pages/reports/**
  - admin-front/src/lib/reportEngineSdk/**
  - admin-front/src/constants/i18n/reports.ts
  - admin-front/src/router/index.ts
  - admin-front/src/utils/routeAuthorities.ts
  - admin-front/src/layouts/sections.tsx
  - admin-front/src/constants/urlsMap/index.ts
  - admin-back/api/protected/reportEngine.ts
design_sources:
  - design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md
tests:
  - admin-front/src/lib/reportEngineSdk/__tests__/**
gaps:
  - `SERVER_PDF` is not available from the UI; the print path uses Paged.js in the browser and ECharts SVG.
  - The catalog has no archive/restore action beyond the spec status.
  - The Studio does not yet expose a visual drag-and-drop section builder; sections are edited as structured JSON with a live preview.
  - The `.zip` upload stores assets locally on the core host; there is no object-store picker.
  - Archive/list APIs exist, but there is no dedicated version-history page yet.
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

- loads the authority-filtered published catalog from the edge;
- prompts for a locale when the report supports more than one (`ReportLanguagePromptDialog`);
- renders the typed input form (`ReportInputForm`) with entity autocomplete and date-range validation;
- executes the report, shows KPI/table/chart/vector sections, and prints through the isolated Paged.js surface;
- exposes the verification hash and the resolved header/footer.

## 3. Studio

The Studio page:

- downloads the report authoring transcript from the API;
- accepts a `ReportDescriptorSpec` JSON and an optional `.zip` asset bundle;
- runs the five verification layers and renders every diagnostic with path, code, severity and `aiFixHint`;
- shows the AI repair prompt for a rejected spec;
- saves a draft and publishes a verified version;
- shows the inferred roles/authorities and, for a Security Admin, the override form with a mandatory justification.

## 4. Chrome registry

The Chrome page lists header/footer specs, their type/status/supported locales and the single global default per type. It creates a new version from an edited spec and sets the global default. The default seed creates `cbl-institutional-header-v1` and `cbl-institutional-footer-v1`.

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

The Chrome page previews registered logos using the asset data returned by the API and keeps one published global default per type.
