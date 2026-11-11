---
id: merchant-ui.reports
title: Merchant Reports
status: implemented
confidence: high
last_verified: 2026-11-10
verified_against: working-tree
code:
  - merchant-front/src/pages/reports/index.tsx
  - merchant-front/src/pages/reports/studio/index.tsx
  - merchant-front/src/lib/reportEngineSdk/**
  - merchant-front/src/router/index.ts
  - merchant-front/src/layouts/sections.tsx
  - merchant-front/src/constants/urlsMap/index.ts
  - merchant-front/src/constants/reportCatalogue.ts
  - merchant-front/src/constants/i18nCatalogue.ts
  - merchant-front/src/utils/authorities.ts
  - merchant-back/api/protected/reportEngine.ts
  - core-back/api/internal/merchantReportEngine.ts
  - core-back/engine/reportStudio/merchantHostConfig.ts
  - core-back/engine/reportStudio/merchantReportEngine.ts
design_sources:
  - design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md
  - design/12-reporting/report_engine_remediation_plan.md
tests:
  - merchant-back/test/core-forwarding.test.ts
  - core-back/test/reportEngineSdk/MerchantScopeValidator.test.ts
  - core-back/test/reportEngineSdk/MerchantReportLine.test.ts
  - tests/unit/report-engine-sdk-mirror.test.ts
gaps:
  - The merchant line has no branded PDF, delivery scheduling or emailing; exports are Excel and browser print.
  - Per-merchant concurrency is enforced in-process per core node; a multi-node deployment needs a shared semaphore for a strict global cap.
  - Replica routing for the dedicated merchant read-only pool is not verified on a live multi-host deployment.
---

# Merchant Reports

## 1. Routes and authorities

- `/portal/reports` (`MerchantReports`) lists platform templates plus the merchant's own published reports. It needs `reports.run`, projected from the merchant `report_engine:run` authority.
- `/portal/reports/studio` (`MerchantReportsStudio`) is the merchant authoring line. It needs `reports.studio`, projected from `report_engine:author`, which a `MERCHANT_ADMIN` holding `merchant:write` holds.

Both pages are separate from the staff report catalog/studio. Staff tables (`report_definition_specs`, `report_assets`, `report_execution_audit`) are never read or written by merchant authoring routes.

## 2. Runner behavior

The runner uses the shared `ApiTable`, opens the run form in a `SlideOverDrawer`, hides the merchant-scope input, renders report-defined labels from the spec dictionary, validates inputs client-side, and shows the sandboxed Paged.js preview with Excel export and print. Errors use the shared friendly mapping and snackbars.

## 3. Merchant Studio

The Studio downloads the merchant-only AI transcript (merchant-safe catalog, no staff authority/override sections), accepts a JSON spec and an optional `.zip` (≤ 2 MB), runs the five verification layers plus the merchant-tier limits, and supports save-as-verified, publish, archive, version history and an execution/usage meter (codes, runs today, DB time, hourly verify/execute counts, suspension). Platform templates can be cloned into the merchant registry from the runner; templates that use assets must be re-authored with the merchant's own bundle. The Studio reads `merchant_reports.policy`: `enabled` is the platform switch (also staff-suspendable per merchant) and `assetsEnabled` shows or hides the `.zip` input; the transcript prints the current asset policy.

## 4. Server enforcement

`core-back/api/internal/merchantReportEngine.ts` uses a dedicated merchant host (`merchantHostConfig.ts`) built from an explicit allow-list of directly merchant-scoped models (`merchants`, `applications`, `wallets`, `payment_attempts`, `cashout_requests`, `rm_merchant_daily_stats`) and explicit column allow-lists. Ledger, credentials, audit, AML, users, webhooks, payment links, POS terminals, disputes and outbox tables are absent from the catalog, not merely blocked.

Every execution:

- resolves the merchant only from the authenticated principal;
- injects `<alias>.merchant_id = $merchant` as a top-level AND on the base model and every joined alias (spec-supplied merchant predicates are never trusted);
- verifies the compiled alias set and selects a hidden `__scope_merchant_id` column, asserting every returned row before stripping it; a mismatch aborts, is audited (`MERCHANT_REPORT_SCOPE_VIOLATION`) and opens a P1 `MANUAL_REVIEW` case;
- enforces ≤ 6 datasets, ≤ 2 joins, ≤ 20 selects, ≤ 2 window fields, ≤ 24 sections, ≤ 10,000 rows, a bounded date range ≤ 92 days, spec ≤ 256 KB, zip ≤ 2 MB, 5 s statement timeout, a lower EXPLAIN cost cap and no large-table sequential scans;
- checks the kill switch, merchant Studio suspension, hourly verify (30) / execute (60) limits, the daily DB-time budget (10 minutes), code/version quotas (50 codes, 20 versions each), one running execution per merchant and a global merchant semaphore, and a 60 s result cache keyed by merchant + spec + inputs.

## 5. Staff oversight

`admin-front` `/reports/merchant-reports` lists merchant-authored reports per merchant with their execution history and a `SUSPEND`/`RESUME` Studio action (`security:write`, audited). The merchant registry, usage rows and execution audit are separate tables (schema version 33).

## Run form layout (2026-11-10)

The merchant run drawer mirrors the admin filter-style form: sectioned, one field per row, labels and descriptions on every field, and a dedicated output-language section when multiple locales exist. Reset and Generate live in the drawer footer; the merchant scope input remains hidden.

## Merchant Studio mock preview (2026-11-10)

The merchant Studio now has a draft preview after a successful verification. It defaults to **Mock data**, which uses the shared `MockReportBundleBuilder` and renders every section (including visibility-gated ones) without a database query; **Live sample** runs the merchant-scoped executor with the engine-injected merchant identity. The endpoint is `POST /report-engine/studio/preview` (core) and is proxied by `merchant-back`. The shared client renderer/print stylesheet fix applies to both portals, so merchant previews and prints use the same A4 containment rules as the admin Studio.

The merchant transcript example now lowers `periodRange.validation.max_range_days` to 90 so it stays inside the merchant 92-day tier limit, and the merchant host registers a `merchants` autocomplete source for the engine-injected scope input (returning the current merchant only).

## Shared print layout hardening (2026-11-11)

The merchant portal receives the same client SDK mirror as the admin portal, so merchant previews/prints now use the hardened A4 layout: max 3 KPI columns, centered chart rows and wrapping HTML legends, compact table typography and chips, repeated table headers, no-data chart states, and true landscape pages in print. The merchant Studio mock/live preview uses the same renderer and is covered by the SDK mirror test.
