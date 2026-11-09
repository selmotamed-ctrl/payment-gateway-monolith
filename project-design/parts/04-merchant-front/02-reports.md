---
id: merchant-ui.reports
title: Merchant Reports
status: implemented
confidence: high
last_verified: 2026-11-09
verified_against: working-tree
code:
  - merchant-front/src/pages/reports/index.tsx
  - merchant-front/src/lib/reportEngineSdk/**
  - merchant-front/src/router/index.ts
  - merchant-front/src/layouts/sections.tsx
  - merchant-front/src/constants/urlsMap/index.ts
  - merchant-front/src/constants/reportCatalogue.ts
  - merchant-front/src/utils/authorities.ts
  - merchant-back/api/protected/reportEngine.ts
  - core-back/api/internal/merchantReportEngine.ts
design_sources:
  - design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md
tests:
  - merchant-back/test/core-forwarding.test.ts
  - core-back/test/reportEngineSdk/MerchantScopeValidator.test.ts
gaps:
  - The merchant portal runs only merchant-safe reports; it does not author reports or manage chrome.
  - Merchant report execution records the forced merchant ID; there is no merchant-facing execution-history page.
---

# Merchant Reports

## 1. Route and authority

`/portal/reports` (`MerchantReports`) is visible with the `reports.run` UI authority, projected from the merchant `report_engine:run` authority. Core also implies `report_engine:run` from `merchant:read`/`merchant:write`.

## 2. Behavior

The page lists only published `MERCHANT_FACING`/`BOTH` reports whose scope passes `validateMerchantReportScope`. The merchant scope input is hidden; the server overwrites it with the authenticated merchant ID, so a client cannot request another merchant's data. The page provides the language prompt, Paged.js vector preview, print and CSV/XLSX export. It never shows Studio or Chrome management.

## 3. Server enforcement

`core-back/api/internal/merchantReportEngine.ts` enforces the scope, audience, locale, read-only execution and audit. `merchant-back` proxies only the catalog, autocomplete and execute routes; authoring remains admin-only.
