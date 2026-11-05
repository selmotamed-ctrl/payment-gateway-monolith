---
id: admin-ui.tables
title: Tables Filters and Exports
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - admin-front/src/components/Table/**
  - admin-front/src/utils/xlsx/**
  - admin-front/src/components/ui/SummaryExportCard.tsx
  - admin-front/src/components/ui/FormChecklist.tsx
  - admin-front/src/constants/env/index.ts
  - admin-front/src/pages/**
design_sources:
  - design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md
  - design/06-ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md
  - design/06-ui/portal_ui_implementation_plan.md
tests:
  - tests/e2e/admin/table-and-padding-geometry.spec.ts
  - tests/e2e/admin/create.spec.ts
  - admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts
gaps:
  - DataTable "server" mode fetches the first 200 rows with page=1 and pageSize=200, then paginates in the browser; it is not true server-side pagination for larger result sets.
  - ApiTable and DataTable XLSX export only the currently rendered page, not the full filtered result set.
  - ApiTable does not persist search, filter or sort state across navigation; only DataTable server mode persists session state.
  - Filter state is split between page-owned values and table-owned values, so pages that implement custom filter surfaces can drift from registry definitions.
---

# Tables Filters and Exports

## 1. Purpose and scope

This part owns the shared table subsystem in `admin-front`: `ApiTable`, `DataTable`, `TableFilters`, `TableRowActions`, `tableRegistry`, the table header/footer chrome, XLSX export, summary export cards, and the runtime checklist flags that gate export/action checklists.

It does not own the business meaning of each column or the backend list endpoints. Those belong to the page and API parts. It also does not claim that the table subsystem is identical in every portal: merchant and Fake Rails have copies of the same components, while checkout uses only a minimal subset.

## 2. Design intent (extracted and synthesized from ./design)

The v2 design intends tables to look operational rather than decorative:

1. **Compact single-line rows.** Approximately 40 px tall, 16 px horizontal cell padding, 20 px on first/last cells, text truncation around 240 px, no wrapped action stacks.
2. **No semantic row paint.** Status is expressed by `StatusBadge` pills and small dots, not full-row rainbow tints.
3. **One action hierarchy.** A single 26 px primary action plus a 26 px overflow menu. Action columns must not stack multiple `VBtn` elements.
4. **Collapsible filters.** Filters live in a padded surface under the toolbar, with an active-filter count and removable chips, rather than in an always-open gradient box.
5. **Stable chrome.** Toolbar, filters, table card, and footer use explicit padding tokens and the `.pg-table-card` class.
6. **Predictable exports.** Every spreadsheet export goes through the shared XLSX pipeline, with translated headers, styled header rows, frozen header row, widths, and a stable title.
7. **Human checklist before risky exports.** Summary/export cards can require checklist items; deploy flags can hide checklists without changing behavior.

## 3. As-built architecture

### 3.1 Components

| Component | File | Responsibility |
| :--- | :--- | :--- |
| `ApiTable` | `admin-front/src/components/Table/ApiTable.tsx` | Page-driven server fetch. The parent supplies `onRefresh`, data/total extractors, headers and optional filters. Supports local search suppression, refresh hooks, and XLSX export of the rendered page. |
| `DataTable` | `admin-front/src/components/Table/DataTable.tsx` | Either local data mode or "server" mode driven by a `server` prop or `tableRegistry[route.name]`. Server mode fetches one page of up to 200 rows and paginates locally. Persists server search/filter/sort state in `sessionStorage`. |
| `Table` | `admin-front/src/components/Table/Table.tsx` | Renders the Vuetify table, compact row styling, selection, column filters, row tone, and cell rendering. |
| `TableFilters` | `admin-front/src/components/Table/TableFilters.tsx` | Renders filter controls by type, active chips, summary text, a mobile/desktop surface, and an injection key so the toolbar can toggle filters. |
| `TableRowActions` | `admin-front/src/components/Table/TableRowActions.tsx` | One optional primary action plus a right-aligned overflow menu. Supports danger/disabled/hidden items and dividers. |
| `HeaderFooter` | `admin-front/src/components/Table/HeaderFooter.tsx` | Desktop/mobile toolbar and pagination, search, refresh, filter trigger, record count, XLSX button, and `useTableXlsx`. |
| `tableRegistry` | `admin-front/src/components/Table/tableRegistry.ts` | Maps a route name to a URL, list key, filters, default sort, optional storage key, params, and row mapper. |
| `filters` | `admin-front/src/components/Table/filters.ts` | Filter union type, active-state detection, query mapping, and server config type. |
| `referenceOptions` | `admin-front/src/components/Table/referenceOptions.ts` | Cached `/options/:kind` loaders for merchant/rail/gateway/user/wallet filters. |
| `statusTone` | `admin-front/src/components/Table/statusTone.ts` | Status-to-tone mapping used by filters and status pills. |

### 3.2 Filter types

`filters.ts` supports six filter types:

| Type | UI | Query behavior |
| :--- | :--- | :--- |
| `text` | Text input | `[query ?? key]=value` |
| `data-autocomplete` | Local options, optional multi-select | Comma-joined values under `query ?? key` |
| `api-autocomplete` | Debounced option loader, optional multi-select | Comma-joined values under `query ?? key` |
| `boolean` | True/false option set | String `true`/`false` under `query ?? key` |
| `number-range` | Min/max number inputs | `<key>Min`/`<key>Max` unless `queryMin`/`queryMax` override |
| `date` | Date range | `from`/`to` unless `queryFrom`/`queryTo` override |

`filterToQuery` ignores inactive values. `activeFilterCount` powers the toolbar badge. `isFilterActive` treats arrays as active only when non-empty, and objects as active only when at least one nested value is set.

### 3.3 Registry coverage (19 configurations)

| Registry key | List key | Filters |
| :--- | :--- | :--- |
| `Gateways` | `gateways` | 6 |
| `AuditLogs` | `auditLogs` | 4 |
| `Users` | `users` | 3 |
| `Rails` | `rails` | 5 |
| `GatewayRoutes` | `routes` | 6 |
| `Merchants` | `merchants` | 13 |
| `JoinRequests` | `joinRequests` | 6 |
| `KybReview` | `kybDocuments` | 12 |
| `Approvals` | `approvals` | 9 |
| `AmlCases` | `cases` | 6 |
| `AmlScreenings` | `screenings` | 6 |
| `AmlRules` | `rules` | 5 |
| `AmlReports` | `reports` | 5 |
| `Adjustments` | `adjustments` | 6 |
| `CashOuts` | `cashouts` | 5 |
| `Disputes` | `disputes` | 7 |
| `OperatorCases` | `cases` | 9 |
| `GatewayInquiries` | `schedules` | 8 |
| `Reconciliation` | `sources` | 1, with storage key `pg.admin.reconciliation.sources` |

`referenceOptions.ts` caches option lookups per `kind:search` key and requests `/options/:kind` with a search string and `limit=50`.

### 3.4 Session persistence

Only `DataTable` server mode persists state:

- Default key: `pg.table.<route.name>`.
- Override key: `server.storageKey` (used by `Reconciliation`).
- Persisted fields: search, filter values, sort key, sort direction.
- Restored on component initialization; writes are best-effort and swallow storage errors.
- Local `DataTable` mode and `ApiTable` do not persist table state.

### 3.5 Server-mode data flow

`DataTable` chooses its server config from `props.server` or `tableRegistry[String(route.name)]`. When server mode is active:

1. It restores persisted state from `sessionStorage`.
2. It calls the configured URL with `page=1`, `pageSize=200`, optional `search`, `sortKey`, `sortDirection`, `buildFilterQuery(...)`, and any configured params.
3. It reads rows from `payload[listKey] ?? payload.rows ?? payload.items ?? []` after unwrapping `payload.data ?? payload`.
4. It reads `payload.total`, applies an optional mapper, then paginates the fetched rows locally.
5. It schedules fetches with a 300 ms debounce after search/filter/sort changes.

This is a hybrid: the first fetch is server-side, but pagination beyond the fetched 200 rows is not.

`ApiTable` instead delegates paging to the parent's `onRefresh` callback. It sends the configured API request for the page and uses the parent-provided data/total extractors. It can filter the already-fetched page locally unless `localSearch={false}`.

### 3.6 XLSX pipeline

`admin-front/src/utils/xlsx/templateDownload.ts` is the shared spreadsheet engine. It uses `exceljs` for styled workbooks and `xlsx` (SheetJS 0.20.3, installed from `cdn.sheetjs.com` since GAP-029) for reading/upload and CSV conversion.

`xlsxUIPipeline` exposes:

- `downloadXlsxFromHeadersAndData` — styled workbook from typed headers and rows.
- `downloadXlsxFromCsvText` — parses CSV text and converts it into the same styled workbook.
- `downloadXlsxFromCsvLines` — joins CSV lines and delegates to the text path.
- `uploadXlsxFromHeadersAndData` — reads the first sheet, maps header text to keys, applies validation rules, and returns valid/invalid rows.

Table exports use `useTableXlsx` in `HeaderFooter.tsx`:

- Headers with a `value` accessor are translated and exported; headers without `value` are skipped.
- Cell values come from the header accessor or an empty string.
- The workbook title is the translated table title and is normalized to `.xlsx`.
- The export covers the currently rendered page only.

Summary exports occur on 20 pages via `SummaryExportCard` and on additional pages via direct `downloadXlsxFromCsvLines` calls (academy, dashboard, finance, merchant detail and others). The server endpoints return summary JSON or CSV-like metric rows; the client converts them to the same styled workbook.

### 3.7 Summary export cards and checklists

`SummaryExportCard` renders:

- A title and optional export button.
- An optional `FormChecklist`.
- A `MetricStrip` of headline metrics.
- A default slot for extra content.

Pages that use it include adjustments, AML cases/reports/rules/screenings, approvals, audit logs, cashouts, disputes, gateways, join requests, KYB, merchants, operator cases, rails, reconciliation, routes, checkout help, platform settings, and users. The export button is typically disabled until the checklist is complete, and some pages also send the checked keys to the backend for audit.

### 3.8 Checklist and help-panel flags

`admin-front/src/constants/env/index.ts` controls visibility:

- `areChecklistsVisible()`:
  1. `window.__PG_RUNTIME_CONFIG__.showChecklists` when boolean.
  2. `showSnapshotExportChecklist` when boolean (legacy).
  3. `VITE_SHOW_CHECKLISTS`, then `VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST`.
  4. Default `true`.
- `areHelpPanelsVisible()`:
  1. `window.__PG_RUNTIME_CONFIG__.showHelpPanels` when boolean.
  2. `VITE_SHOW_HELP_PANELS`.
  3. Default `true`.

When checklists are hidden, page-side completeness computations generally become `true` and the checklist component returns `null`. This keeps the underlying action/export path unchanged.

`deploy/deploy.ts` writes both build-time Vite values and `runtime-config.js`; the runtime object wins at boot. `ADMIN_SHOW_CHECKLISTS` falls back to the legacy `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`.

## 4. Contracts and invariants

1. **Money is never formatted with floating point.** Table money cells use `MoneyDisplay` or decimal-backed utilities.
2. **Server table responses are envelope-shaped.** The shared code unwraps `data` and then the configured list key; pages must keep the list key current.
3. **Filters map to explicit query names.** Custom query names are declared in the filter definition, not hard-coded in pages.
4. **Table header exports use the rendered column accessors.** A column without `value` is not exported.
5. **All spreadsheet exports use the shared XLSX pipeline.** CSV-producing endpoints are converted client-side into the same workbook style.
6. **Export checklists are advisory UI gates.** The backend may also audit the submitted checklist keys, but the UI flag controls visibility only.
7. **Action columns use `TableRowActions`.** The compliance test fails a page action column that stacks multiple `VBtn` elements without it.
8. **Full-row semantic tints are not allowed.** The v2 table styling keeps neutral rows and a status badge.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Table components | `admin-front/src/components/Table/**` |
| Table registry | `admin-front/src/components/Table/tableRegistry.ts` |
| Filter types and query mapping | `admin-front/src/components/Table/filters.ts` |
| XLSX engine | `admin-front/src/utils/xlsx/**` |
| Summary export card | `admin-front/src/components/ui/SummaryExportCard.tsx` |
| Checklist component | `admin-front/src/components/ui/FormChecklist.tsx` |
| Visibility flags | `admin-front/src/constants/env/index.ts` |
| Deploy flags | `admin-front/deploy` schema and `deploy/deploy.ts` |

Common export endpoints include `*/export` and `*/summary/export` routes in `admin-front/src/constants/urlsMap/index.ts`, for example:

- `v1/admin/users/export`, `v1/admin/users/summary/export`
- `v1/admin/merchants/export`, `v1/admin/merchants/summary/export`
- `v1/admin/approvals/export`, `v1/admin/approvals/summary/export`
- `v1/admin/operator-cases/export`, `v1/admin/operator-cases/summary/export`
- `v1/admin/settings/summary/export`, `v1/admin/settings/checkout-support/summary/export`
- `v1/admin/academy/progress/overview/export`, `v1/admin/academy/progress/overview/summary/export`

## 6. Operational usage

- Add a new server table: add a `tableRegistry` entry keyed by the route name, define the list key and filters, and ensure the page uses `DataTable` (not `ApiTable`) if it wants registry-driven server mode.
- Add a filter: prefer a registry definition so the filter surface and query mapping stay together; use `query`/`queryFrom`/`queryTo` when the API name differs from the UI key.
- Add a row action: use one primary action plus `TableRowActions` items; do not add two or three `VBtn` elements to the action cell.
- Add a summary export: use `SummaryExportCard` and `FormChecklist`, and route the download through `xlsxUIPipeline.downloadXlsxFromCsvLines` or the shared typed workbook function.
- Change checklist visibility: set `ADMIN_SHOW_CHECKLISTS`/`ADMIN_SHOW_HELP_PANELS` in deploy config; do not remove checklist controls from the page.
- Debug a missing export: confirm the header has a `value` accessor, the current page has rows, and the XLSX pipeline received a non-empty title.

## 7. Status and deviations

### Implemented

- Shared `ApiTable`, `DataTable`, `TableFilters`, `TableRowActions`, table chrome and filter query mapping.
- 19 registry configurations.
- Server-mode state persistence for `DataTable`.
- Styled XLSX export, CSV-to-XLSX conversion, and XLSX upload parsing.
- Summary export cards and audit-aware checklist keys.
- Runtime checklist/help-panel flags with deploy precedence.

### Partial

- "Server" mode is limited to the first 200 rows and local pagination.
- Table XLSX export is current-page only; full-result exports are not wired into the table header.
- Only `DataTable` server mode persists state; `ApiTable` re-fetches from its parent defaults after navigation.
- Filter state ownership is split: pages with custom filter surfaces can bypass registry definitions or duplicate them.

### Missing / deferred

- No shared keyset/server export endpoint used directly by the table toolbar.
- No automatic test that every registry `listKey`/filter matches its backend API.
- No generic column-visibility or saved-view system.

### Known bugs / risks

- **Data gap:** a result set larger than 200 rows paginates only within the first 200 fetched rows in `DataTable` server mode.
- **Export gap:** users may expect the XLSX button to export the full filtered result, but it exports only the current page.
- **Consistency risk:** `ApiTable` and `DataTable` have different persistence and search behavior, so two pages with similar tables can behave differently.
- **Documentation gap:** older design prose implies fully server-side pagination and all-dashboard replica reads; neither is true for this table subsystem.

## 8. Verification and tests

- `tests/e2e/admin/table-and-padding-geometry.spec.ts` checks compact rows, row-action discipline, filter padding, toolbar/table padding, and expanded filters.
- `tests/e2e/admin/create.spec.ts` checks table search behavior on gateway data.
- `admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts` checks `TableRowActions` existence, action-column discipline, no rainbow tints, no gradients, and the presence of the unified table components.
- `tests/e2e/admin/a11y.spec.ts` covers table accessibility basics.

No database is required for the unit/static compliance checks; the Playwright geometry suite requires the live stack.

## 9. Source references

### Old design sections

- `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` — v1 table, status, row-action and export intent.
- `design/06-ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md` — v2 40 px rows, filter drawer/chips, summary export cards, checklist flags.
- `design/06-ui/portal_ui_implementation_plan.md` — as-built table and CSV-to-XLSX rollout.

### Code paths

- `admin-front/src/components/Table/ApiTable.tsx`
- `admin-front/src/components/Table/DataTable.tsx`
- `admin-front/src/components/Table/TableFilters.tsx`
- `admin-front/src/components/Table/TableRowActions.tsx`
- `admin-front/src/components/Table/tableRegistry.ts`
- `admin-front/src/components/Table/filters.ts`
- `admin-front/src/components/Table/HeaderFooter.tsx`
- `admin-front/src/components/ui/SummaryExportCard.tsx`
- `admin-front/src/components/ui/FormChecklist.tsx`
- `admin-front/src/utils/xlsx/**`
- `admin-front/src/constants/env/index.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical table/export part. Records the 19 registry configurations, hybrid 200-row server mode, current-page-only XLSX export, summary export surfaces, and runtime checklist flags.
