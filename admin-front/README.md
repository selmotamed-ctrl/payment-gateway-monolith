# admin-front

LAN-only Admin Back Office SPA for the payment gateway platform. It is the operator surface for onboarding, merchant support, governance, finance, gateway configuration, platform settings, backups, the interactive guide and the employee academy.

Status: `partial`. The route catalog, UI system, tables, contextual help, backup/settings pages and guide/academy are implemented, but several authority-gating, maker-checker and documentation gaps remain. See [the canonical admin parts](../project-design/parts/03-admin-front/) and the generated [blueprint.md](blueprint.md).

## 1. Purpose and trust boundary

- The browser talks only to `admin-back` under `/api`; it never receives `DATABASE_URL`, `KMS_MASTER_KEY`, a core client certificate or another host's credentials.
- `admin-back` is the only service that calls `core-back` over mTLS. The admin SPA has no database, ledger or KMS access.
- The admin deployment is LAN-only. Public exposure is outside the supported model.
- UI authority checks (`routesAuthorities`, `routesRoles`, hidden navigation and disabled buttons) are advisory presentation only. `core-back` re-checks every authority, and maker-checker separation is enforced server-side.
- Sensitive actions remain server-governed even where the UI hints at four-eyes control. Do not treat a hidden button or a client-side checklist as a security boundary.
- English/Arabic catalogues are kept in sync. Money is rendered through decimal-backed primitives, never floating-point arithmetic.

## 2. Stack and prerequisites

| Area | Implementation |
| :--- | :--- |
| Framework | Vue 3.5, Vuetify 3.10, TypeScript/TSX |
| Build | Vite (`rolldown-vite`) with `unplugin-vue-router`, auto-imports and Vuetify auto-import |
| Routing/state | `vue-router` 4, local reactive state modules under `src/state` |
| Data/i18n | Axios, `vue-i18n` 11, self-hosted Plus Jakarta Sans, Cairo and JetBrains Mono |
| Tables/exports | Shared table subsystem plus ExcelJS/XLSX under `src/utils/xlsx` |
| Charts/validation | ECharts, Zod, decimal.js |

Prerequisites:

- Node `^20.19.0 || >=22.12.0` (from `engines` in `package.json`).
- Bun for install/scripts, consistent with `bun.lock`.
- A running `admin-back` edge BFF reachable at the configured API URL for real data. The dev server alone does not provide authentication, records, backups or settings.
- No PostgreSQL, Redis or core certificate is required in the frontend workspace.

## 3. Install, run, build, lint and test

```bash
bun install
bun run dev          # Vite dev server on port 5101
bun run build        # rm -rf dist && parallel type-check + build-only
bun run build-only   # Vite build without the type-check
bun run preview      # serve the built dist
bun run type-check   # vue-tsc --build
bun run lint         # oxlint --fix followed by eslint --fix
bun run format       # prettier src/
bun run test:unit    # bun test src/content/__tests__ && vitest run
bun run test:unit:watch  # watch only the Bun content tests
```

- `bun run test:unit` runs the guide/academy content completeness test with Bun and the UI primitives compliance test with Vitest.
- The Playwright admin suites live in the repository `tests/` workspace: `cd ../tests && bun run test:e2e -- admin/shell.spec.ts`, `admin/global-search.spec.ts`, `admin/backups.spec.ts`, `admin/table-and-padding-geometry.spec.ts` and the exhaustive admin surface suite. They require the live stack.
- `bun run lint` is auto-fixing. Use the individual `lint:oxlint`/`lint:eslint` scripts when you need a non-mutating check.

## 4. Environment and runtime configuration

`VITE_API_URL` is a development origin base. In dev the Axios base becomes `${VITE_API_URL}/api`; in a production build the SPA always uses the same-origin `/api` path. The Vite dev server proxies `/api` to `VITE_API_URL` (default `http://localhost:4101`).

| Key | Scope | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `VITE_API_URL` | Dev/build env | `http://localhost:4101/` in `.env` | Edge BFF origin used by the dev API client and the Vite `/api` proxy. Production ignores it and uses `/api`. |
| `VITE_SEND_NOT_FOUND_TRANSLATIONS` | Dev/build env | `NO` | When `YES` **and** running in dev mode, reports missing translation keys. No effect in production. |
| `VITE_MY_TAILSCALE` | Dev env | unset | Optional hostname appended to the Vite `allowedHosts` list for LAN/Tailscale development. |
| `VITE_SHOW_CHECKLISTS` | Build env | unset, effectively `true` | Build-time fallback for admin action/export checklist visibility. Used only when runtime config is absent. |
| `VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST` | Build env | unset | Legacy alias used when `VITE_SHOW_CHECKLISTS` is absent. |
| `VITE_SHOW_HELP_PANELS` | Build env | unset, effectively `true` | Build-time fallback for inline KYB/approvals/merchants help panels. |
| `ADMIN_SHOW_CHECKLISTS` | Deploy config | `true` | Deploy master switch for all admin action/export checklists. Falls back to `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST` when omitted. |
| `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST` | Deploy config | unset | Legacy deploy alias for `ADMIN_SHOW_CHECKLISTS`. |
| `ADMIN_SHOW_HELP_PANELS` | Deploy config | `true` | Deploy switch for the inline help expansion panels. |

Runtime config is a `window.__PG_RUNTIME_CONFIG__` object loaded from `/runtime-config.js` before the app starts:

| Runtime key | Values | Precedence |
| :--- | :--- | :--- |
| `showChecklists` | boolean | Highest. Overrides the legacy runtime key, both Vite values and the default. |
| `showSnapshotExportChecklist` | boolean | Legacy runtime fallback when `showChecklists` is absent. |
| `showHelpPanels` | boolean | Highest for help panels; overrides `VITE_SHOW_HELP_PANELS` and the default. |

Visibility resolution:

- `areChecklistsVisible()`: `showChecklists` → `showSnapshotExportChecklist` → `VITE_SHOW_CHECKLISTS` → `VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST` → `true`.
- `areHelpPanelsVisible()`: `showHelpPanels` → `VITE_SHOW_HELP_PANELS` → `true`.
- Runtime config wins at boot. The deploy engine writes both the Vite build values and `runtime-config.js`, so deployment flags can change without rebuilding the SPA. Nginx serves `index.html` and `runtime-config.js` with no caching.

## 5. Route and page map

The router has 37 protected children under `/`, a visitor-only `/login`, and a catch-all `NotFound`. `/` redirects to `Dashboard`. Detail routes use `meta.parentName` for active navigation, breadcrumbs and contextual help.

| Path | Route name | UI gate | Purpose |
| :--- | :--- | :--- | :--- |
| `/dashboard` | `Dashboard` | authenticated | Live platform health, volume, queues, recent activity and snapshot export. |
| `/join-requests` | `JoinRequests` | `joinrequests.review` | Onboarding application queue and SLA health. |
| `/join-requests/new` | `JoinRequestNew` | `joinrequests.review` | Admin-assisted onboarding package creation. |
| `/join-requests/:id` | `JoinRequestDetail` | `joinrequests.review` | Profile, owners, documents, checklist, decisions and audit. |
| `/kyb` | `KybReview` | `kyb.review` | KYB document queue, integrity, expiry and duplicate review. |
| `/kyb/:id` | `KybReviewDetail` | `kyb.review` | Document inspection and per-document dispositions. |
| `/merchants` | `Merchants` | `merchants.read` or `support.read_merchant` | Merchant portfolio, risk/KYB posture and governed changes. |
| `/merchants/:id` | `MerchantDetail` | `merchants.read` or `support.read_merchant` | Merchant 360: transactions, wallets, cash-outs, disputes, audit and changes. |
| `/approvals` | `Approvals` | `approvals.approve` or `approvals.reject` | Maker-checker queue, diffs, approve/reject, bulk reject and export. |
| `/users` | `AdminUsers` | none (backend `user:read`/`security:read`) | Admin operators, invitations, status and authority posture. |
| `/users/:id` | `AdminUserDetail` | none (`AdminUsers` parent) | Operator identity, authorities and access history. |
| `/audit-logs` | `AuditLog` | `security:read` | Immutable operator/system activity, detail drawer and export. |
| `/aml/cases` | `AmlCases` | `aml.read_confidential` + `COMPLIANCE`/`MLRO` | AML case investigation, proposal and escalation. |
| `/aml/screenings` | `AmlScreenings` | `aml.read_confidential` + `COMPLIANCE`/`MLRO` | Sanctions/PEP screening queue and match disposition. |
| `/aml/rules` | `AmlRules` | `aml.read_confidential` + `COMPLIANCE`/`MLRO` | AML rule versions, thresholds and maker-checker drafts. |
| `/aml/reports` | `AmlReports` | `aml.read_confidential` + `COMPLIANCE`/`MLRO` | Regulatory report drafting, submission and acknowledgement. |
| `/operator-cases` | `OperatorCases` | `case:read` or `operator:read` | UNKNOWN/conflict/reconciliation operator queue and bulk actions. |
| `/operator-cases/inquiries` | `GatewayInquirySchedules` | `case:read` or `operator:read` | Gateway inquiry schedule monitoring, run/retry/cancel. |
| `/operator-cases/:id` | `OperatorCaseDetail` | `case:read` or `operator:read` | Case evidence, step logs, inbound events and governed resolution. |
| `/disputes` | `Disputes` | `dispute:read` | Chargeback queue, evidence deadlines and adjustment linkage. |
| `/adjustments` | `Adjustments` | `adjustments.propose` | Refund/manual adjustment drafting and finance review. |
| `/cashouts` | `CashOuts` | `cashout.process` | Cash-out processing with wallet, destination and AML checks. |
| `/reconciliation` | `Reconciliation` | `reconciliation.run` or `reconciliation.resolve` | Statement upload, run monitoring and variance resolution. |
| `/finance/pricing` | `PricingControls` | none (nav hidden without `profit.read`/`liquidity.read`) | Commission profiles and velocity controls under governance. |
| `/finance/profitability` | `Profitability` | `profit.read` | Gross commission, gateway cost and net contribution. |
| `/finance/liquidity` | `Liquidity` | `liquidity.read` | Treasury cover, clearing ageing, cash-out demand and holds. |
| `/finance/invariant` | `Invariant` | `profit.read` or `liquidity.read` | Double-entry invariant, treasury cover and ledger accounts. |
| `/gateways` | `Gateways` | `gateways.edit` | Gateway portfolio, version state, rollback and creation. |
| `/gateways/ai-import` | `GatewayAiImport` | none (direct URL, not in nav) | External-AI integration spec import with local/backend verification. |
| `/gateways/wizard/:id` | `GatewayWizard` | `gateways.edit` | Eight-step gateway version wizard. |
| `/rails` | `Rails` | `gateways.edit` | Rail catalog, collection modes and customer fields. |
| `/routes` | `GatewayRoutes` | `gateways.edit` | Route priority, limits, credential policy and circuit-breaker health. |
| `/guide` | `AdminGuide` | none (intentional learning surface) | Interactive admin guide, glossary, simulators and checklists. |
| `/academy` | `AdminAcademy` | none (intentional learning surface) | Employee academy, labs, quizzes, tracks and certifications. |
| `/settings/platform` | `AdminPlatformSettings` | none (backend `settings:read`/`settings:write`) | Versioned platform settings, backup export and restore. |
| `/settings/checkout-help` | `AdminCheckoutHelp` | none (backend `settings:read`/`settings:write`) | Checkout support config, preview, history and diff. |
| `/system/backups` | `SystemBackups` | `security:read` or `gateway:read` | WAL/daemon/target health, history, drills and policy. |

Public routes are `/login` (`Login`, visitor-only) and `/:pathMatch(.*)*` (`NotFound`). The catch-all has no privileged behavior.

### Authority-gating gaps

- `AdminUsers`, `AdminUserDetail`, `PricingControls`, `GatewayAiImport`, `AdminPlatformSettings` and `AdminCheckoutHelp` have no effective router authority array. Direct navigation loads the page; backend calls still fail without the required authority.
- `AdminGuide` and `AdminAcademy` are intentionally open to authenticated admins. Academy self-progress needs only authentication, while team overview and exports require `user:read`.
- Hiding a navigation item does not protect its route. Test both the hidden-navigation case and the direct-URL case.
- AML routes add a role check (`COMPLIANCE` or `MLRO`) after the authority check.

## 6. Key capabilities

### Global search

- `Ctrl+K` (`Cmd+K` on macOS) opens the global search palette across platform records, admin pages and guide entries. The drawer search pill opens the guide-only modal.
- Record search calls `POST v1/admin/search`; the palette requires at least two characters for record search, aborts stale requests, uses an 8-second timeout and caches non-partial responses for 60 seconds.
- Search types include merchants, payment attempts, join requests, KYB documents, users, approvals, audit logs, AML cases/screenings/rules/reports, operator cases, gateway inquiries, disputes, adjustments, cash-outs, reconciliation runs, gateways, rails and routes.
- Deep links open the relevant record drawer where the target page supports it. The guide tab or guide modal routes to `/guide` with the selected entry.
- Access-aware filtering is applied in the palette, but the backend remains the authorization authority.

### Backups (`/system/backups`)

- Shows WAL archive lag against the alert threshold, daemon reachability/health, storage-target health, latest backup status/time, latest drill and the latest 30 backup runs.
- Triggers `all`/`postgres_core`/`audit_db`/`redis` backups as `full` or `delta`, runs isolated restore drills, and edits the backup policy schedule and retention.
- Trigger and drill are immediate writes under `security:write`; they are not maker-checker actions.
- A policy save creates a pending approval (`202 PENDING_REVIEW`). The page shows the approval id but does not continue into it; a different checker must execute the request from `/approvals`. `BACKUP_POLICY` is also missing from the shared approval subject-type filter.
- There is no direct restore-from-backup UI, only restore drills.

### Platform settings (`/settings/platform`)

- Lists settings grouped by key with the latest version, scope, version count and effective date; includes JSON preview, history, version diff and "load into editor".
- Saves create the next immutable version with scope `PLATFORM`, validate the key and require a JSON object (not an array or scalar), plus the setting checklist when checklists are visible.
- Backup export writes a JSON file containing the latest version per key and an audit entry.
- Restore is preview-first: preview classifies added/changed/unchanged/invalid/missing keys; apply requires a reason of at least three characters, the restore checklist and `confirm: true`, and refuses invalid entries or `expectedCurrentVersion` conflicts (`409 SETTING_VERSION_CONFLICT`).
- Platform settings edits are versioned and audited but are **not** maker-checker approvals, despite sensitive-field hints in the form.

### Checkout help (`/settings/checkout-help`)

- Edits the platform setting `checkout.support_config`: enablement, platform/merchant contact visibility, phone/WhatsApp/email, Arabic/English working hours and bilingual FAQ entries.
- Validates email shape, 6-15 digit phone/WhatsApp values and complete means one localized question/answer pair. The edit checklist covers support channels, FAQ, working hours and payer visibility.
- Saves a new immutable version and writes before/after and checklist audit entries. History, diff and summary export are available.
- The page subtitle mentions "per-rail instructions", but there is no per-rail editor. Per-rail guides are seeded in `core-back/prisma/seedGuides.ts` and flow to checkout through `rails.help_guide_json`.
- Disabling support hides the payer contact block and FAQ; it does not hide the checkout help drawer, state guidance, payment reference or per-rail banner.

### Guide and academy

- `/guide` is the Admin Interactive Guide v1.0: 14 books, 125 articles, 151 glossary terms, 22 safeguard cards, 29 situations, 8 reading paths, 58 quick answers, 19 error codes and a 140-case edge-case catalogue, extracted deterministically from `design/07-guides-and-academy/guide_system_design_and_content.md` into `src/content/guide/generated/` (`bun run content:guide`). Eight routes (home, book, article, glossary, tools, playbook, cards, edge cases), a MiniSearch command palette, five client-only simulators and per-article read tracking stored in the shared Academy progress JSON. Canonical part: [Admin Guide v2](../project-design/parts/03-admin-front/06-guide-v2.md).
- Guide search is MiniSearch over articles, glossary, cards, situations, FAQ and error codes with Arabic-aware normalisation; `Ctrl+K` also searches platform records and admin pages.
- `/academy` has 8 modules, 17 lessons, 8 labs with fatal options and 64 quiz questions, grouped into six certification tracks.
- Mastery is computed client-side: all lessons complete, the lab passed and a 100% quiz. Badges are derived, not manually granted. The backend stores progress JSON but does not independently validate answers, labs or mastery.
- Academy self-progress is available to any authenticated admin. Team overview, summary and both XLSX exports require `user:read`; the page itself has no router gate, so unauthorized users see the page load and the reporting calls fail.
- Gaps: Arabic article bodies are not supplied (the reader falls back to English with an "Arabic version pending" chip), and two safeguard cards have no separate current UI action (see `design/07-guides-and-academy/guide_content_questions.md`).

### Contextual help

- The shell's "Help & SOP (?)" button and the `?` shortcut open a 560 px right-hand drawer for the current route. Opening it does not close or reset the form.
- `GUIDE_ROUTE_HELP` has 29 entries and uses `meta.parentName ?? route.name`, giving effective coverage for 31 of 37 protected routes.
- No effective chapter resolves for `AdminUsers`, `AdminUserDetail`, `AuditLog`, `PricingControls`, `AdminPlatformSettings` or `SystemBackups`.
- Chapter 9.4 ("Merchant Lifecycle, Sensitive Edits & Support Operations") is stored under Book 7 instead of Book 9. `Merchants`/`MerchantDetail` therefore resolve to no chapter, and Book 7 shows an out-of-sequence chapter. Search still finds it as Book 7 content.
- Mapping titles are English-only even in Arabic mode.
- `PageHeader` exposes help props, but no page passes them. The shell route map is the only effective chapter selector.

## 7. UI system, tables and exports

### Tokens and shell

- `src/styles/fintech-minimal.css` defines the `--pg-*` tokens: neutral canvas/surface colors, semantic status backgrounds/borders/dots, radii, low-spread shadows and explicit page/card/table/filter/chip/footer padding.
- Fonts are self-hosted: Plus Jakarta Sans for Latin/LTR, Cairo for Arabic/RTL, JetBrains Mono for references, hashes and technical strings.
- Vuetify defaults: ripple off, flat rounded cards, 36 px no-transform buttons, outlined compact fields with automatic detail hiding, restrained dialog scrim and RTL-aware locale.
- The authenticated shell is a 56 px app bar plus a 248 px drawer (temporary below the compact breakpoint). It includes breadcrumbs, global/guide search, contextual help, theme/locale controls, a live ledger invariant pill for finance readers and an operator card with maker/checker dots. The auth layout is a split-screen institutional panel.
- Do not reintroduce a global `#app` transform/scale. The removed scaling behavior is checked by shell tests.

### Primitives

The required barrel exports are `PageHeader`, `StatusBadge`, `MoneyDisplay`, `MonoRef`, `MetricStrip`, `SurfaceCard`, `FormModal`, `FormField`, `SlideOverDrawer`, `DescriptionList`, `SegmentedTabs`, `EmptyState` and `JsonDiffViewer`. Extras are `SurfaceCardText`, `MetaPill`, `FormChecklist` and `SummaryExportCard`. The unified table subsystem is the fourteenth deliverable but is not one of the 13 named primitive exports.

The compliance test (`src/components/ui/__tests__/ui-abstraction-compliance.test.ts`) enforces the primitive exports, `PageHeader` usage on standard pages, no raw `VDialog`/`VChip`/`VCard` in route pages, no rainbow row tints, no gradients in the table/card/header system, `TableRowActions` discipline and the v2 table/container classes. Use primitives and `--pg-*` tokens rather than page-local colors.

### Tables

- `DataTable` supports local data or registry-driven "server" mode; `ApiTable` is parent-fetch driven. `TableFilters`, `TableRowActions`, `HeaderFooter` and `tableRegistry` provide the shared chrome.
- There are 19 registry configurations. Server mode fetches `page=1&pageSize=200`, then paginates locally; it is not true server-side pagination beyond the first 200 rows.
- Rows are compact and neutral; status is a badge/dot, not a full-row tint. Action columns use one primary action plus a `TableRowActions` overflow menu.
- Filter types are text, local autocomplete, API autocomplete, boolean, number range and date range; active filters render as removable chips.
- Only `DataTable` server mode persists search/filter/sort in `sessionStorage` (`pg.table.<route.name>`, or a configured storage key). `ApiTable` does not.

### Exports

- All spreadsheets use the shared XLSX pipeline under `src/utils/xlsx`; CSV-producing endpoints are converted client-side into the same styled workbook.
- Table-header exports use rendered column accessors and export **only the current page**, not the full filtered result set. Do not present them as full exports.
- `SummaryExportCard` combines metric strips, optional checklists and summary exports. When checklists are hidden by runtime config, checklist completeness is treated as true; the underlying action/export path is unchanged.
- Export endpoints may audit the submitted checklist keys, but checklist visibility is a UI flag, not an authorization boundary.

## 8. i18n, RTL and authority conventions

- Locales are Arabic (`ar`) and English (`en`). Arabic is the default: the stored `locale-name` is treated as English only when it is exactly `en`; otherwise the app starts in Arabic.
- The selected locale is stored in `localStorage`, applied to `<html lang>`/`dir` (`rtl` for Arabic, `ltr` for English) and passed to Vuetify's locale adapter.
- User-facing text comes from `src/constants/i18nCatalogue.ts` as `[English, Arabic]` pairs, plus Vuetify locale messages. Keep both catalogues in sync.
- Guide and academy content carries per-item English/Arabic fields. Coverage is content-dependent; not every guide chapter or academy string is fully bilingual. Contextual-help mapping titles are English-only.
- Route authorities use OR semantics: any listed authority passes. Role lists are additional, currently only on AML routes. Missing/empty authority arrays mean "no UI gate".
- Backend authorization remains authoritative. A page can render and then fail its API calls when authority is missing.

## 9. Deployment and runtime behavior

- The deploy engine builds `admin-front` with `bun run build`, syncs `dist`, and writes `dist/runtime-config.js`. Nginx serves the SPA with history fallback, proxies `/api/` to `admin-back`, and disables caching for `index.html` and `runtime-config.js`.
- The admin host is LAN-only. TLS/`ADMIN_SSL` and LAN binding are deploy concerns; the SPA does not implement mTLS itself.
- Deploy is the source of truth for `ADMIN_SHOW_CHECKLISTS` and `ADMIN_SHOW_HELP_PANELS`. The values are injected as both Vite build constants and runtime config; runtime wins.
- Admin receives no database URL, KMS key or core client key. `admin-back` holds the mTLS client identity and forwards authorized requests to `core-back`.
- Changing runtime flags does not require rebuilding the SPA, but it does require redeploying/serving the new `runtime-config.js`. Build-time Vite flags only matter when runtime config is absent.

## 10. Testing and troubleshooting

### Recommended checks

```bash
bun run type-check
bun run lint
bun run test:unit
bun run build
```

Relevant browser suites (from `tests/`): admin shell, table/padding geometry, accessibility, global search, backups and exhaustive admin surface. They require the running stack.

### Common problems

| Symptom | Check |
| :--- | :--- |
| Login loops or requests fail | Is `admin-back` reachable at `/api`? In dev, is `VITE_API_URL` pointing at the admin edge port (4101)? Remember production uses same-origin `/api`. |
| "You are not allowed" redirect | The route authority/role guard rejected direct navigation. Hidden navigation is not proof of protection; confirm the backend authority too. |
| Page loads then APIs return 403 | Expected for ungated routes such as settings, checkout help, users and pricing. The backend is authoritative. |
| Stale-chunk error | The router retries a failed dynamic import once; hard-reload the SPA if the chunk hash is stale. |
| Contextual help says no chapter | Check the effective key (`parentName ?? name`), the `GUIDE_ROUTE_HELP` entry, and whether the chapter is in the mapped book. `Merchants`/`MerchantDetail` currently fail through the 9.4 placement bug. |
| XLSX export misses rows | Table export exports only the current rendered page. Use a summary export or a backend export endpoint when full data is required. |
| Checklist controls disappear | Runtime `showChecklists` is false (or build/Vite fallback is false). Actions still execute; only the checklist UI is hidden. |
| Backup policy changed but not applied | A policy save creates a pending approval. Find it in `/approvals`; the backup page does not continue into the approval. |
| Settings save did not require a checker | Platform settings and checkout support are versioned/audited but not maker-checker. Only backup policy currently goes through the approval queue. |
| Academy team report returns 403 | The page opens for any authenticated admin, but overview/summary/exports require `user:read`. |
| Arabic help still shows English text | Mapping titles are English-only; chapter bodies are content-dependent. |

## 11. References

- Generated workspace blueprint: [blueprint.md](blueprint.md)
- Canonical design parts:
  - [Admin UI System](../project-design/parts/03-admin-front/00-ui-system.md)
  - [Admin Route and Page Catalog](../project-design/parts/03-admin-front/01-route-and-page-catalog.md)
  - [Tables Filters and Exports](../project-design/parts/03-admin-front/02-tables-filters-exports.md)
  - [Admin Guide and Academy](../project-design/parts/03-admin-front/03-guide-and-academy.md)
  - [Contextual Help](../project-design/parts/03-admin-front/04-contextual-help.md)
  - [Backups Settings and Operations](../project-design/parts/03-admin-front/05-backups-settings-and-operations.md)
- Generated appendices: [environment and config matrix](../project-design/appendices/env-and-config-matrix.md), [API route matrix](../project-design/appendices/api-route-matrix.md), [test inventory](../project-design/appendices/test-inventory.md)
- [Admin Guide v2](../project-design/parts/03-admin-front/06-guide-v2.md)
