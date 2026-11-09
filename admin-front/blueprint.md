<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# admin-front blueprint

Generated from: `admin-ui.system`, `admin-ui.routes`, `admin-ui.tables`, `admin-ui.guide`, `admin-ui.help`, `admin-ui.operations`.

## Admin UI System

> Status: `partial` · Last verified: 2026-11-09

## 1. Purpose and scope

This part owns the design system and shell used by `admin-front`: visual tokens, self-hosted fonts, Vuetify theme/default configuration, the 13 required UI primitives and their extras, the 248 px navigation drawer and 56 px app bar, the split-screen authentication layout, and the cross-workspace rollout rules.

It does not own page-specific business logic, route authority decisions, table data contracts, or the guide content. Those are covered by `01-route-and-page-catalog.md`, `02-tables-filters-exports.md`, and `03-guide-and-academy.md`. It also does not replace the per-service rendering rules in the merchant and checkout parts.

The system is shared by four Vue 3 + Vuetify 3 TSX applications at different levels of adoption:

| Workspace | Adoption |
| :--- | :--- |
| `admin-front` | Full reference implementation: tokens, fonts, primitives, shell, table surface, compliance gate. |
| `merchant-front` | Mirrors tokens, fonts, Vuetify defaults, primitives, table surface, and the 248/56 shell with merchant navigation. |
| `checkout-front` | Uses tokens, fonts, Vuetify defaults, and a focused payer layout; it does not use the admin shell or the full navigation system. |
| `fake-rails-front` | Partial rollout: fonts, tokens, UI primitives, tables, row actions, and `SectionFields` exist, but it keeps its own portal/hosted layouts and is outside the admin compliance test. |

## 2. Design intent (extracted and synthesized from ./design)

The historical UI design starts from an anti-"AI-generated UI" premise. The target is a restrained fintech back office: a neutral canvas, hairline borders, flat surfaces, tabular numerals, a single semantic status dot or primary action, and no decorative gradients or stacked card shadows.

The key intent from `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` and `design/06-ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md` is:

1. **Neutral architectural canvas.** Light background `#F8FAFC`, surface `#FFFFFF`, dark background `#09090B`, dark surface `#121215`. Color is reserved for semantic signals.
2. **Typography with a purpose.** Plus Jakarta Sans for Latin/LTR, Cairo for Arabic/RTL, and JetBrains Mono for references, UUIDs, hashes, and money-adjacent technical strings. All fonts are self-hosted; no CDN is required.
3. **Compact, flat Vuetify defaults.** Ripple off, cards flat and rounded, buttons 36 px with no text transform, inputs outlined/compact with automatic detail hiding, and a restrained dialog scrim.
4. **A precision shell.** A 248 px permanent drawer on desktop, a 56 px flat app bar, keycap-style active navigation, collapsible section groups, breadcrumbs, a global search entry point, help entry point, theme/locale controls, and an operator identity card.
5. **A split-screen auth surface.** Institutional brand and security posture on one side; the login panel on the other.
6. **A primitive layer instead of page-level Vuetify soup.** Pages compose `PageHeader`, `StatusBadge`, `MoneyDisplay`, `MonoRef`, `MetricStrip`, `SurfaceCard`, `FormModal`, `FormField`, `SlideOverDrawer`, `DescriptionList`, `SegmentedTabs`, `EmptyState`, and `JsonDiffViewer`. The unified table surface is the fourteenth deliverable even though the design prose sometimes calls it a fourteenth primitive.
7. **Disciplined tables.** 40 px single-line rows, no rainbow row tints, one primary row action plus an overflow menu, a sticky action column, a row-level right-click/`Shift+F10` context menu that reuses the same action model, collapsible filters, and XLSX export through the shared pipeline.
8. **No global scaling transform.** A previous whole-app `transform: scale(0.9)` caused fixed-position and RTL problems and was removed. The old `SCALING_FEATURE.md` files were deleted; do not reintroduce them.

The implementation plan records one correction to the design prose: the blueprint says "14 primitives" but names 13 components. The 13 named exports plus the unified table surface are the actual contract checked by the compliance test.

## 3. As-built architecture

### 3.1 Tokens and global styles

`admin-front/src/styles/fintech-minimal.css` is the canonical token sheet. It defines:

- Canvas, surface, hover, active, and glass backgrounds.
- Primary, secondary, muted, and faint ink colors.
- Subtle, strong, and focus borders.
- Primary and interactive accents.
- Success, warning, danger, info, and neutral status backgrounds, text, borders, and dots.
- Radii from 4 px to 10 px and low-spread shadows.
- Explicit screen, card, table toolbar, filter, chip, and footer padding tokens.
- Sans LTR, sans RTL, and monospace font-family tokens.

`admin-front/src/styles/globals/app.scss` supplies shared application behavior and selectors such as `.pg-skip-link`, focused main content, `hoverable` helpers, and the comment documenting the removed global transform. `admin-front/src/styles/command-palette.css` styles the global search palette. `admin-front/src/styles/settings.scss` is the Vuetify Sass entry point.

The same token sheet and font assets are mirrored in `merchant-front`, `checkout-front`, and `fake-rails-front`.

### 3.2 Fonts

`src/assets/fonts/fonts.css` registers self-hosted families:

| Family | Role | Weights present |
| :--- | :--- | :--- |
| Plus Jakarta Sans | Latin/LTR UI | 200-800 normal and italic |
| Cairo | Arabic/RTL UI | 200-900 normal |
| JetBrains Mono | References, code, technical strings | 400-700 |

No external font request is required. `tests/e2e/admin/a11y.spec.ts` and the shell tests cover rendered accessibility and layout rather than font network loading.

### 3.3 Vuetify theme and defaults

`admin-front/src/plugins/vuetify.ts` is the canonical Vuetify configuration and is copied almost verbatim to merchant and checkout.

- Light theme: background `#F8FAFC`, surface `#FFFFFF`, primary `#0F172A`, secondary/accent/info `#2563EB`, success `#16A34A`, warning `#D97706`, error `#DC2626`.
- Dark theme: background `#09090B`, surface `#121215`, primary `#F8FAFC`, secondary/accent/info `#3B82F6`, success `#22C55E`, warning `#F59E0B`, error `#EF4444`.
- Locale: Arabic is RTL, English is LTR; fallback is English; the adapter is `adaptedLocale`.
- Icons: MDI default set plus the custom `i` set and aliases from `src/utils/iconSet`.
- Global defaults: ripple off.
- Component defaults: flat cards with `rounded: "lg"`; 36 px, `rounded: "md"`, no-transform buttons; outlined compact text fields/selects/autocompletes/textareas/comboboxes with `hideDetails: "auto"`; small rounded chips; a `rgba(15, 23, 42, 0.45)` dialog scrim.
- `VDateInput` receives an outlined default through the blueprint defaults block.

Theme mode is `system | light | dark`. `utils/theme` resolves the persisted mode (localStorage `theme`; absent means `system`) against `prefers-color-scheme`; `state/theme` applies it to Vuetify, listens to `matchMedia` changes while in `system` mode, and syncs across tabs. `plugins/vuetify.ts` uses `initialTheme()` for `defaultTheme` and `main.ts` calls `initTheme()` before mount, so every route (including the login page) starts in the operating-system theme with no light flash. `ThemeMenu` is the explicit three-option menu (System, Light, Dark) used by the shell, the auth layout and the merchant landing header; the old `toggleTheme` remains as a compatibility cycle (system -> light -> dark).

### 3.4 Primitives and extras

`admin-front/src/components/ui/index.ts` is the primitive barrel. The compliance test requires these 13 named exports:

| Primitive | Responsibility |
| :--- | :--- |
| `PageHeader` | Page title, subtitle, badge, breadcrumbs, optional actions/end slot; also defines help props that are currently unused by pages. |
| `StatusBadge` | Human-readable status pill with semantic tone and optional dot; centralizes status formatting and tone inference. |
| `MoneyDisplay` | Decimal-safe money rendering with currency, size, sign, and tabular formatting. |
| `MonoRef` | Monospace reference/UUID/hash display with copy affordance. |
| `MetricStrip` | Compact KPI strip used on dashboards and operational pages. |
| `SurfaceCard` | Flat hairline card with padding/title slots; `SurfaceCardText` is its body extra. |
| `FormModal` | Standard modal shell with title, body, footer, submit/loading/error behavior. |
| `FormField` | Static label, hint, error, required marker, and maker-checker hint wrapper. |
| `SlideOverDrawer` | Right/end slide-over shell used for details and contextual help. Open drawers keep a module-level stack and take a z-index from their position in it (base 1100, step 4, below Vuetify dialogs/menus), so the drawer opened last is always on top even when it is an always-mounted sibling of its parent (Vuetify otherwise gives earlier-registered items the higher z-index). |
| `AccountLinesTable` (`components/ledger`) | Server-paginated posting lines of one GL account with side/reference-type/date filters, search and totals of the filtered set; used by the wallet statement and the GL account drawer (`financeGlAccountLines`, `walletStatement`). |
| `DescriptionList` | Label/value lists with money, mono, and column options. |
| `SegmentedTabs` | Compact tab switch used for periods, roles, languages, and modes. |
| `EmptyState` | Empty/error-adjacent illustration-free state block. |
| `JsonDiffViewer` | Structured JSON patch/diff presentation. |

Additional exported primitives/extras are `SurfaceCardText`, `MetaPill`, `FormChecklist`, and `SummaryExportCard`. Legacy wrappers `StatusChip` and `MoneyText` remain as compatibility shims over `StatusBadge` and `MoneyDisplay`.

`src/components/ui/__tests__/ui-abstraction-compliance.test.ts` is the UI compliance gate. It asserts the required exports, absence of unlayered universal padding/margin resets, no rainbow row backgrounds, presence of `TableRowActions`, no raw `VDialog`/`VChip`/`VCard` in route pages, `PageHeader` usage on standard route pages, no gradients in the table/header/card system, and the v2 `SectionFields`, `ScreenContainer`, and `.pg-table-card` classes.

### 3.5 Shell

`admin-front/src/layouts/default.tsx` implements the authenticated shell:

- A skip link targeting `#pg-main-content`.
- A 56 px flat app bar with menu toggle, brand, breadcrumbs, live ledger invariant pill (for `profit.read` or `liquidity.read`), global search trigger (`Ctrl+K`/`Cmd+K`), help button, theme mode menu (System/Light/Dark), language menu, and user menu.
- A 248 px `VNavigationDrawer`, permanent on desktop and temporary below the compact breakpoint. It contains brand/environment badge, guide search pill, collapsible navigation sections, and an operator card with role and maker/checker dots.
- Route progress bar, focused `VMain`, global search palette, guide search modal, and contextual help drawer.
- The `?` key opens help when the user is not typing in an input; `Escape` closes the topmost overlay.

`admin-front/src/layouts/sections.tsx` owns the visible navigation groups and both `routesAuthorities` and `routesRoles`. The shell hides a section when every route in it is hidden, so an empty group header never renders.

`merchant-front/src/layouts/default.tsx` mirrors the 248/56 geometry with merchant navigation, guide search, help, locale buttons, and an operator card. `checkout-front/src/layouts/checkout.tsx` is intentionally a single focused payer column, not the admin shell.

### 3.6 Authentication layout

`admin-front/src/layouts/auth.tsx` implements a split-screen institutional layout:

- Brand mark, platform name, and "Admin Back Office" subtitle.
- Security posture heading and explanatory copy.
- Three posture badges: TLS 1.3 mTLS Verified, AES-256-GCM Hardware Vault, Four-Eyes Governance.
- A live status line.
- A main panel slot for the login form.

The auth shell also carries the three-mode theme menu in its top-right corner. `initTheme()` runs before mount and `plugins/vuetify.ts` uses `initialTheme()`, so the login page follows the OS theme on first paint and tracks OS changes while in System mode.

The auth shell is presentation only. Authentication, MFA, and session authority enforcement live in the edge and core services.

### 3.7 Fake Rails rollout

`fake-rails-front` is an optional deploy target. The deploy engine only builds and serves it when `FAKE_RAILS_ENABLED` is true, with a production guard (`FAKE_RAILS_ALLOW_IN_PRODUCTION`) and required SSH/certificate/credential settings.

Its UI rollout is partial by design:

- Fonts, token sheet, `components/ui` primitives, table components, row actions, and `SectionFields` are present.
- It uses `layouts/portal.tsx` and `layouts/hosted.tsx`, not the admin 248/56 shell.
- It has no admin route, admin guide, academy, or admin authority model.
- The admin compliance test does not scan it, so the anti-slop and primitive rules are not automatically enforced there.
- Admin users do not control Fake Rails from the admin portal; seeded rails appear as ordinary catalog records.

### 3.8 Removed app scaling and stale files

The application no longer applies a global `transform: scale()` to `#app`. The removal is documented in `admin-front/src/styles/globals/app.scss` and checked by `tests/e2e/admin/shell.spec.ts`, `tests/e2e/merchant/shell.spec.ts`, and `tests/e2e/checkout/pay.spec.ts`, which assert that the computed transform is `none`.

However, the stale files are still physically present:

- `admin-front/src/styles/README.md`
- `merchant-front/src/styles/README.md`
- `checkout-front/src/styles/README.md`

`scripts/project-design/check.ts` explicitly fails while these files exist. The files still claim a current app-scaling feature and contain unrelated scratch notes. This is a documentation/cleanup gap, not current behavior.

## 4. Contracts and invariants

1. **Token names are stable.** Pages should consume `--pg-*` tokens rather than hard-coded colors.
2. **No global #app transform.** No scale/zoom transform may be reintroduced on the application root.
3. **Shell geometry is 248/56.** The admin and merchant desktop drawer is 248 px wide; the app bar is 56 px high.
4. **The 13 named primitives must remain exported** from `src/components/ui/index.ts`, and the unified table surface must remain under `src/components/Table`.
5. **Standard route pages use `PageHeader`.** Public/login/not-found pages are excluded from the compliance scan.
6. **Route pages do not use raw `VDialog`, `VChip`, or `VCard`.** They compose primitives instead. Component-level files may use Vuetify internally.
7. **Action columns do not stack multiple `VBtn` elements.** They use one primary action plus `TableRowActions` overflow items.
8. **Checklist flags are runtime-config controlled.** `areChecklistsVisible()` reads `window.__PG_RUNTIME_CONFIG__.showChecklists`, then the legacy `showSnapshotExportChecklist`, then `VITE_SHOW_CHECKLISTS`, then the legacy Vite alias, defaulting to true. `areHelpPanelsVisible()` reads `showHelpPanels`, then `VITE_SHOW_HELP_PANELS`, defaulting to true.
9. **Deploy is the source of truth for admin visibility.** `deploy/deploy.ts` writes both build-time Vite values and `runtime-config.js`; runtime values take precedence.
10. **English and Arabic catalogues stay in sync.** The UI is RTL-aware and uses Vuetify's locale adapter plus the app catalogue.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Vuetify configuration | `admin-front/src/plugins/vuetify.ts`, `merchant-front/src/plugins/vuetify.ts`, `checkout-front/src/plugins/vuetify.ts` |
| Tokens | `*/src/styles/fintech-minimal.css` |
| Global styles | `*/src/styles/globals/app.scss`, `admin-front/src/styles/command-palette.css` |
| Fonts | `*/src/assets/fonts/fonts.css` and the adjacent font files |
| Primitives | `*/src/components/ui/**` |
| Tables | `*/src/components/Table/**` |
| Shells | `admin-front/src/layouts/default.tsx`, `merchant-front/src/layouts/default.tsx`, `checkout-front/src/layouts/checkout.tsx` |
| Auth layout | `admin-front/src/layouts/auth.tsx` |
| Compliance test | `admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts` |
| Deploy flags | `ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`, `ADMIN_SHOW_HELP_PANELS`, `FAKE_RAILS_ENABLED`, `FAKE_RAILS_ALLOW_IN_PRODUCTION` |

## 6. Operational usage

- Adding a page: use `ScreenContainer`, `PageHeader`, and the relevant primitives; add a table config only if the page uses the shared table server mode; add a route and navigation entry separately.
- Adding a status: use `StatusBadge` and keep the tone mapping centralized.
- Rendering money: use `MoneyDisplay`/`MoneyText` or decimal-backed utilities; never format money with floating point.
- Adding a drawer/modal: use `SlideOverDrawer`/`FormModal` so focus, padding, and footer behavior stay consistent.
- Totals rows go in a `<tfoot>` of a `.pg-unified-table`/`.pg-table-card` table: the shared stylesheet gives them the body-row padding, edge insets and a top rule (before 2026-11-07 a `tfoot` had no padding and its label touched the table border).
- Changing the theme: edit `plugins/vuetify.ts` and the `--pg-*` tokens together; do not add page-local hard-coded palettes.
- Learning surfaces: the Guide (`styles/guide.css`) and the Academy (`styles/academy/*.css`, see `03-guide-and-academy.md` §7.6) are built from these primitives and tokens. A feature area may add its own stylesheet under `src/styles/` imported from `main.ts`, but must not inject runtime `<style>` blocks, introduce a second palette, or cap the page width below the `ScreenContainer`; only reading text takes a measure (75 ch).
- Deploy-time visibility: set `ADMIN_SHOW_CHECKLISTS` and `ADMIN_SHOW_HELP_PANELS` in `deploy.env`; the deploy engine writes `runtime-config.js`. Rebuilding the SPA is not required for the runtime flags to change.

## 7. Status and deviations

### Implemented

- Admin, merchant, checkout, and partial Fake Rails token/font rollout.
- Vuetify theme, defaults, RTL locale, and MDI/custom icon setup.
- 248/56 admin and merchant shells with responsive temporary drawers.
- Split-screen admin auth layout.
- 13 required primitives plus `SurfaceCardText`, `MetaPill`, `FormChecklist`, and `SummaryExportCard`.
- Compliance test enforcing primitive usage, no raw page-level dialog/chip/card, no gradients, no universal reset, and table/action discipline.
- Removal of the global app-scaling transform.
- Runtime checklist/help-panel flags written by deploy.

### Partial

- Fake Rails UI adoption is partial and not compliance-tested.
- The 13-primitive layer is copied per workspace rather than shared as a package; merchant and checkout copies can drift.
- The design prose inconsistently calls the table surface a fourteenth primitive; the code treats it as a separate table subsystem.

### Missing / deferred

- No shared component package or generated primitive sync.
- No automated visual regression suite for the token system.
- No in-repo enforcement of the 13 exports for Fake Rails.

### Known bugs / risks

- **Documentation gap:** `SCALING_FEATURE.md` and `notes.md` were removed; the check script now fails if they are reintroduced.
- **Documentation gap:** the design blueprint says 14 primitives; the actual contract is 13 named exports plus the table surface.
- **Delivery risk:** per-workspace copies of primitives/tokens require manual synchronization.
- **Delivery risk:** Fake Rails can diverge because the admin compliance gate does not scan it.

## 8. Verification and tests

- `cd admin-front && bun run test:unit` runs the Bun content tests and Vitest, including `src/components/ui/__tests__/ui-abstraction-compliance.test.ts`.
- `tests/e2e/admin/shell.spec.ts` checks shell geometry, drawer behavior, RTL, theme toggling, navigation rendering, overflow, and the removed scaling transform.
- `tests/e2e/admin/table-and-padding-geometry.spec.ts` checks v2 table row/action/filter geometry.
- `tests/e2e/admin/a11y.spec.ts` checks accessibility basics.
- `tests/e2e/merchant/shell.spec.ts` checks the mirrored merchant shell and the removed scaling transform.
- `tests/e2e/checkout/pay.spec.ts` checks the payer surface and the removed scaling transform.

These are browser or unit checks; they do not require PostgreSQL or Redis.

## 9. Source references

### Old design sections

- `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` — v1 token system, primitive catalogue, shell and page map.
- `design/06-ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md` — v2 geometry, tables, filters, padding, and anti-reset rules.
- `design/06-ui/portal_ui_implementation_plan.md` — as-built rollout and the 13-vs-14 primitive correction.

### Code paths

- `admin-front/src/plugins/vuetify.ts`
- `admin-front/src/styles/fintech-minimal.css`
- `admin-front/src/styles/globals/app.scss`
- `admin-front/src/assets/fonts/fonts.css`
- `admin-front/src/layouts/default.tsx`
- `admin-front/src/layouts/auth.tsx`
- `admin-front/src/layouts/sections.tsx`
- `admin-front/src/components/ui/index.ts`
- `admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts`
- `admin-front/src/constants/env/index.ts`
- `deploy/deploy.ts`
- `fake-rails-front/src/components/ui/**`

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/api-route-matrix.md`

## 10. Change history

- 2026-11-09 — Added system/light/dark theme modes across all four portals: `utils/theme` + `state/theme` resolve the persisted mode against `prefers-color-scheme`, `initialTheme()`/`initTheme()` apply it before mount (login included), a live `matchMedia` listener follows OS changes in System mode, and the explicit `ThemeMenu` replaces the light/dark toggle in the shell, auth layout and merchant landing. See `TRACKER.md`.
- 2026-11-03 — Initial canonical part created from the v1/v2 UI designs and working-tree code. Records the 13-primitive contract, 248/56 shell, Fake Rails partial rollout, removed app scaling, and the still-present stale files.

## Security hardening (2026-11-05)

- Blob previews whitelist png/jpeg/pdf and open with `noopener`; `ApiImage` renders raster images only; `resolveUploadPathWithMat` was removed.
- `console.log` is gated through `utils/devLog.ts` (DEV builds only).
- A fresh clone should `cp .env.example .env`; the real `.env` is no longer tracked.
- Catalogue keys added (EN and AR): "This file type cannot be previewed." and the full-backup confirmation text.
- **Logout and cookie sessions (GAP-019, RESOLVED).** The user store logout calls `POST v1/admin/auth/logout` (`urlsMap.authLogout`) through `revokeServerSession` (best effort, never throws) and always clears the local session. `utils/security/sessionToken.ts` handles the cookie mode: a login payload with `sessionCookie: true` is kept as the non-secret `cookie-session` sentinel and requests send `X-Pg-Csrf: 1` instead of a bearer token.
- **XLSX 0.20.3 (GAP-029).** `xlsx` is pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (the maintained SheetJS build; the npm registry copy 0.18.5 is vulnerable) and `@types/xlsx` was dropped. The shared XLSX pipeline is unchanged. `@prisma/client` is still listed in `admin-front/package.json` although nothing imports it (residual).

## No raw operational JSON; structured builders (2026-11-06)

**Rule:** operational data is never shown as `JSON.stringify`/`<pre>`, and never edited in a JSON textarea. Allowed exceptions: raw HTTP wire traces (`gateways/ai-import`, the step/webhook trace blocks of `operator-cases/[id]`), data exports (`audit-logs` CSV/XLSX columns, the platform-settings backup file), and plain-text message bodies (rail instructions, notification template body, restore reason).

- **`JsonDiffViewer`** (rewritten) takes `diff: unknown`: an RFC-6902 array, `{operations}`, `{before, after}` or a plain payload (`DRAFT_AML_RULE`, `CREATE_ADJUSTMENT`...). The pure model `components/ui/jsonDiffModel.ts` humanises paths (`/payoutBankDetailsJson/iban` -> "Payout Bank Details · IBAN"), flattens nested objects to sub-rows, classifies money keys (`*Amount|*Ceiling|*Fee|*Balance|*Volume` -> `MoneyDisplay`), status strings (`StatusBadge`), lists (chips) and dates. `JsonValueCell`/`JsonValueList` render the same values as key/value rows. `components/JsonPatchDiff` is now a thin wrapper.
- **`summarizeAuditChange(before, after)`** (`utils/auditSummary.ts`) returns the humanised labels of the changed top-level keys (ignoring identical values and timestamps); `components/AuditChangeChips.tsx` shows up to 3 chips plus "+N more" in the audit-log table, Merchant 360 and the case timeline.
- **Builders** (`components/builders/**`, each with a pure model under `builders/model/` and unit tests): `CostModelBuilder` (+`formatCostModel`: `1.25% + 0.500 LYD (min…, max…)`), `RouteScopeBuilder` + `MismatchPolicyBuilder` (`tolerance_amount`, the only key the settlement engine reads), `MaintenanceWindowsBuilder` (absolute UTC `start`/`end`; a route is hidden while `start <= now < end`), `ParserConfigBuilder`/`ColumnMappingBadges` (statement sources), `AmlParamsBuilder`/summaries (7 rule types; `scope` is edited as a structured tree and the UI states that the engine does not evaluate it), `PlatformSettingTypedEditor` + `SettingValueView` (typed editors for the decision register OD-1..OD-11 and the policy keys; unknown keys fall back to a structured tree editor that preserves them), `LogoAssetPicker`, `ChipListInput`, `OptionChips`, `RepeatableRows`, `KeyValueSummary`, `StructuredValueEditor`. Every builder round-trips unknown keys losslessly.
- **Commission tiers:** `CommissionTiersEditor` (`pages/finance/pricing/components`) edits `{ upTo, flat, percent }` (percent is a fraction) and is shown for TIERED only (the calculator ignores tiers for FLAT/PERCENTAGE/HYBRID). The create form also carries min/max fee, fee bearer, rounding mode and optional merchant/application scope.
- **Shared drawers** (`components/ledger/JournalEntryDrawer`, `GlAccountDrawer`; `pages/merchants/components/WalletDetailDrawer`, `ApplicationDetailDrawer`) are opened by an id prop (`null` = closed) and emit `close`/`changed`. Governed actions share `ReasonModal` (>=10 characters) and a 202 handler that explains "submitted for approval" and links to `/approvals`.
- **i18n slices:** `constants/i18n/{commerce,ledgerOps,forms,builders}.ts` are merged by `plugins/i18n.ts` after the main catalogue; each new string has an `[English, Arabic]` pair and unit tests assert EN/AR sync. Table filter configs live in `components/Table/registry/{commerce,ledgerOps,forms}.ts` and are spread into `tableRegistry`.
- Compliance gate (`components/ui/__tests__/ui-abstraction-compliance.test.ts`): every standard route page uses `PageHeader` (helper components belong in `components/` subfolders), no raw `VCard`/`VDialog`/`VChip`.

## Remediation round 2 (2026-11-08): bundle size and translation gate

- **Lazy heavy chunks (GAP-060).** `utils/xlsx` is a lazy facade (the exceljs/xlsx chunk loads on the first export click) and charts load through `components/EChart/lazy.tsx` (`defineAsyncComponent`); `tests/unit/admin-bundle-lazy.test.ts` fails if the dashboard, profitability page, gateway health drawer or table header import the heavy libraries statically.
- **Translation gate (GAP-061).** `tests/unit/i18n-catalogue.test.ts` (scanner `tests/unit/helpers/i18nScan.ts`) fails on a literal `t()` key with no catalogue entry that is not in the shrink-only baselines `tests/unit/fixtures/i18n-missing-*.json`, and on a key whose Arabic value conflicts across catalogue files (the last spread silently won). The 18 conflicts were resolved; the existing missing keys stay in the baselines and are filled over time (`UPDATE_I18N_BASELINE=1` rewrites a baseline after a fix).

## Admin Route and Page Catalog

> Status: `partial` · Last verified: 2026-11-06

## 1. Purpose and scope

This part records every protected admin route, the merchant portal routes, and the public checkout routes as they are defined in the router tables. It identifies each route's purpose, UI authority gate, role restriction, and contextual-help mapping, and it records where the UI gate is absent even though the backend still authorizes the request.

It does not define the backend authority matrix or duplicate the API surface. It also does not claim that a UI gate is a security boundary: `core-back` and the edge BFFs re-check every protected request.

## 2. Design intent (extracted and synthesized from ./design)

The route design follows five rules:

1. **One explicit router table per SPA.** Admin, merchant, and checkout use `createRouter` with explicit route records; admin does not use file-based routing.
2. **Navigation and route gates are separate.** `layouts/sections.tsx` decides what is visible; `routesAuthorities` decides whether a direct navigation is allowed. A hidden item is not automatically protected, and a missing route gate is not automatically denied.
3. **Parent names drive active state and help.** Detail routes set `meta.parentName` so the parent navigation item is highlighted and the contextual-help drawer resolves the parent's guide mapping.
4. **Roles are layered on authorities.** Admin AML routes additionally require a `COMPLIANCE` or `MLRO` role. No other admin route has a role restriction.
5. **The backend is authoritative.** UI checks are advisory and server-side authority checks remain the real boundary.

The historical operator-case design also expects a dedicated operator-case inquiry schedule route; that is implemented as `GatewayInquirySchedules` rather than a separate top-level module.

## 3. As-built architecture

### 3.1 Admin router composition

`admin-front/src/router/index.ts` defines:

- One protected parent at `/` using `layouts/default`, with 37 child route records.
- One visitor-only login route at `/login`.
- One catch-all `NotFound` route.
- A global `beforeEach` guard that redirects unauthenticated users to `Login` with a `redirect` query, redirects authenticated visitors to `Dashboard`, checks `routesAuthorities[name]`, and then checks `routesRoles[name]`.
- A global `afterEach` that clears route loading/error and dynamic-import retry state.
- A dynamic-import retry path for stale chunk errors.

`admin-front/src/layouts/sections.tsx` groups visible navigation into Overview, Onboarding, Governance, Operations, Finance, Gateways, and Learning. Sections and route items are filtered by their `if` callbacks. Empty sections are removed.

### 3.2 Admin protected routes (37)

The authority column is the UI gate. "None" means no effective `routesAuthorities` entry; the backend may still require an authority. Help shows the guide screen used by the generated context map; "none" means no mapping resolves.

| # | Path | Name | UI authority / role | Help | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `/dashboard` | `Dashboard` | `[]` (authenticated only) | 1 / 1.1 | Live platform health, volume, queues, recent activity, snapshot export. |
| 2 | `/join-requests` | `JoinRequests` | `joinrequests.review` | 9 / 9.1 | Onboarding application queue, SLA health, summary export. |
| 3 | `/join-requests/new` | `JoinRequestNew` | `joinrequests.review` | 9 / 9.1 via parent | Admin-assisted onboarding package creation. |
| 4 | `/join-requests/:id` | `JoinRequestDetail` | `joinrequests.review` | 9 / 9.1 | Review profile, owners, documents, checklist, decisions, audit. |
| 5 | `/kyb` | `KybReview` | `kyb.review` | 9 / 9.3 | KYB document queue, integrity, expiry and duplicate review. |
| 6 | `/kyb/:id` | `KybReviewDetail` | `kyb.review` | 9 / 9.3 | Document inspection and per-document disposition. |
| 7 | `/merchants` | `Merchants` | `merchants.read` or `support.read_merchant` | 9 / 9.4 (broken) | Merchant portfolio, risk/KYB posture, governed changes. |
| 8 | `/merchants/:id` | `MerchantDetail` | `merchants.read` or `support.read_merchant` | 9 / 9.4 (broken) | Merchant 360, transactions, wallets, finance, compliance, audit. |
| 9 | `/approvals` | `Approvals` | `approvals.approve` or `approvals.reject` | 2 / 2.4 | Maker-checker queue, diffs, approve/reject, bulk reject, export. |
| 10 | `/users` | `AdminUsers` | `[]` (none; backend `user:read`/`security:read`) | none | Admin operator list, invite, edit, status, authority posture. |
| 11 | `/users/:id` | `AdminUserDetail` | none (parent `AdminUsers`) | none | Operator identity, authorities and access history. |
| 12 | `/audit-logs` | `AuditLog` | `security:read` | none | Immutable operator/system activity, detail drawer, export. |
| 13 | `/aml/cases` | `AmlCases` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | AML case investigation, proposal and escalation. |
| 14 | `/aml/screenings` | `AmlScreenings` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | Sanctions/PEP screening queue and match disposition. |
| 15 | `/aml/rules` | `AmlRules` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | AML rule versions, thresholds and maker-checker drafts. |
| 16 | `/aml/reports` | `AmlReports` | `aml.read_confidential` + role `COMPLIANCE`/`MLRO` | 10 / 10.1 | Regulatory report drafting, submission and acknowledgement. |
| 17 | `/operator-cases` | `OperatorCases` | `case:read` or `operator:read` | 7 / 7.2 | UNKNOWN/conflict/reconciliation operator queue. |
| 18 | `/operator-cases/inquiries` | `GatewayInquirySchedules` | `case:read` or `operator:read` | 7 / 7.2 | Gateway inquiry schedule monitoring, run/retry/cancel. |
| 19 | `/operator-cases/:id` | `OperatorCaseDetail` | `case:read` or `operator:read` | 7 / 7.2 | Case evidence, step logs, inbound events, maker-checker resolution. |
| 20 | `/disputes` | `Disputes` | `dispute:read` | 11 / 11.1 | Chargeback queue, evidence deadlines, adjustment linkage. |
| 21 | `/adjustments` | `Adjustments` | `adjustments.propose` | 11 / 11.2 | Refund/manual adjustment drafting and review. |
| 22 | `/cashouts` | `CashOuts` | `cashout.process` | 12 / 12.1 | Cash-out processing with wallet, destination and AML checks. |
| 23 | `/reconciliation` | `Reconciliation` | `reconciliation.run` or `reconciliation.resolve` | 8 / 8.2 | Statement upload, run monitoring and variance resolution. |
| 24 | `/finance/pricing` | `PricingControls` | none (nav hides without `profit.read`/`liquidity.read`) | none | Commission profiles and velocity controls under governance. |
| 25 | `/finance/profitability` | `Profitability` | `profit.read` | 12 / 12.1 | Gross commission, gateway cost and net contribution. |
| 26 | `/finance/liquidity` | `Liquidity` | `liquidity.read` | 12 / 12.1 | Treasury cover, clearing ageing, cash-out demand and holds. |
| 27 | `/finance/invariant` | `Invariant` | `profit.read` or `liquidity.read` | 12 / 12.1 | Double-entry invariant, treasury cover and account balances. |
| 28 | `/gateways` | `Gateways` | `gateways.edit` | 6 / 6.1 | Gateway portfolio, version state, rollback and creation. |
| 29 | `/gateways/ai-import` | `GatewayAiImport` | none (direct URL; not in nav) | 6 / 6.2 | External-AI integration spec import with local/backend verification. |
| 30 | `/gateways/wizard/:id` | `GatewayWizard` | `gateways.edit` | 6 / 6.1 | Eight-step gateway version wizard. |
| 31 | `/rails` | `Rails` | `gateways.edit` | 3 / 3.2 | Rail catalog, collection modes and customer fields. |
| 32 | `/routes` | `GatewayRoutes` | `gateways.edit` | 3 / 3.2 | Route priority, limits, credential policy and circuit-breaker health. |
| 33 | `/guide` | `AdminGuide` | none (intentional) | 1 / 1.1 | Interactive admin system guide, glossary, simulators and checklists. |
| 34 | `/academy` | `AdminAcademy` | none (intentional learning) | 1 / 1.1 | Employee Academy home (full-width hero with the single Continue action and progress rings, tracks, certificates list, Guide reading). Sub-routes `AdminAcademyTracks`, `AdminAcademyTrack`, `AdminAcademyModule`, `AdminAcademyLesson`, `AdminAcademyLab`, `AdminAcademyExam`, `AdminAcademyCertificate`, `AdminAcademyHelp` (none gated) and `AdminAcademyTeam` (role `SECURITY_ADMIN`); see `03-guide-and-academy.md` §7. |
| 35 | `/settings/platform` | `AdminPlatformSettings` | none (backend `settings:read`/`settings:write`) | none | Versioned platform settings, backup export and restore preview. |
| 36 | `/settings/checkout-help` | `AdminCheckoutHelp` | none (backend `settings:read`/`settings:write`) | 4 / 4.2 | Checkout support config, preview, version history and diff. |
| 37 | `/system/backups` | `SystemBackups` | `security:read` or `gateway:read` | none | WAL/daemon/target health, backup history, drills and policy. |
| 38 | `/guide/book/:bookId` | `AdminGuideBook` | none (learning surface) | 1 / 1.1 | One guide book with ordered articles and progress. |
| 39 | `/guide/a/:articleId` | `AdminGuideArticle` | none (learning surface) | 1 / 1.1 | Guide article reader with glossary, TOC, widgets and read tracking. |
| 40 | `/guide/glossary/:slug?` | `AdminGuideGlossary` | none (learning surface) | 13 / 13.1 | A–Z glossary and deep-linkable term detail. |
| 41 | `/guide/tools/:tool?` | `AdminGuideTools` | none (learning surface) | 1 / 1.1 | Five client-only teaching simulators. |
| 42 | `/guide/playbook/:id?` | `AdminGuidePlaybook` | none (learning surface) | 10 / 10.1 | Symptom-to-action situation playbook. |
| 43 | `/guide/cards/:id?` | `AdminGuideCards` | none (learning surface) | 1 / 1.1 | Safeguard checklist card catalog. |
| 44 | `/guide/edge-cases` | `AdminGuideEdgeCases` | none (learning surface) | 13 / 13.5 | Filterable 140-case edge-case catalog. |

Public admin routes are `/login` (`Login`, visitor-only) and the catch-all `NotFound`. The root `/` redirects to `Dashboard`.

### 3.3 Merchant portal routes (16)

`merchant-front/src/router/index.ts` defines public `Landing`, `Login`, `Register`, and `NotFound`, plus 16 protected children under `/portal`.

| # | Path | Name | UI authority | Help chapter | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `/portal/dashboard` | `Dashboard` | `stats.read` | M-02 | Wallet, volume, success rate and recent payments. |
| 2 | `/portal/onboarding` | `Onboarding` | `[]` (authenticated only) | M-01 | Five-step KYB, owners, documents, payout and submission. |
| 3 | `/portal/guide` | `MerchantGuide` | none (learning surface) | M-01 | Merchant operations guide and fee/code tools. |
| 4 | `/portal/guide/developers` | `MerchantDeveloperGuide` | none (learning surface) | D-01 | Developer API chapter reader and code templates. |
| 5 | `/portal/wallets` | `Wallets` | `wallets.read` | M-07 | Wallet balances, pending/negative amounts and wallet creation. |
| 6 | `/portal/statements` | `Statements` | **none (gap)** | M-07 | Monthly wallet statement and XLSX export. |
| 7 | `/portal/applications` | `Applications` | `applications.read` | M-02 | Applications, environments, wallet assignment and sensitive proposals. |
| 8 | `/portal/links` | `Links` | `links.read` | M-03 | Payment-link creation, QR, attempts inspector and cancellation. |
| 9 | `/portal/pos` | `PosTerminals` | `pos.manage` or `pos.operate` | M-05 | Terminals and paired customer screens. |
| 10 | `/portal/pos/screen/:code` | `PosScreen` | `pos.manage` or `pos.operate` | M-05 | Full-screen live POS status via SSE. |
| 11 | `/portal/payments` | `Payments` | `payments.read` | M-06 | Payment list, status, commission and net. |
| 12 | `/portal/disputes` | `Disputes` | `payments.read` | M-08 | Chargeback list and evidence upload. |
| 13 | `/portal/cashouts` | `Cashouts` | `cashout.read` or `cashout.request` | M-07 | Cash-out requests and bank destination details. |
| 14 | `/portal/developers/tokens` | `DeveloperTokens` | `tokens.read` | D-02 | API token creation, scopes, revocation and IP allowlists. |
| 15 | `/portal/credentials` | `Credentials` | `credentials.manage` | M-09 | Merchant-owned gateway credential sets. |
| 16 | `/portal/team` | `Team` | `users.manage` | M-10 | Team members, roles, scopes and authorities. |

### 3.4 Checkout routes

`checkout-front/src/router/index.ts` defines three route records and no authentication guard:

| Path | Name | Behavior |
| :--- | :--- | :--- |
| `/` | `Home` | Redirects to `NotFound`. |
| `/pay/:linkKey` | `Pay` | Payer summary, rail form, action renderer, confirmation and receipt. |
| `/:pathMatch(.*)*` | `NotFound` | Token-styled 404 page; its `Dashboard` button targets a route that does not exist in this SPA. |

## 4. Contracts and invariants

1. **Protected route count is 37.** The generated catalog and tests must treat the 37 children under `/` as the protected admin surface; `/login` and `NotFound` are excluded.
2. **Merchant protected route count is 16.** Public landing/login/register/not-found are excluded.
3. **A UI gate exists only when the authority array is non-empty.** `[]`, `undefined`, and a missing key all behave as "no UI gate".
4. **Authority checks use OR semantics.** `hasOneOfAuthorities` accepts any listed authority.
5. **Role checks are additional.** AML routes require an allowed role after the authority check.
6. **Unauthenticated protected navigation goes to `Login`.** Admin preserves a `redirect` query; merchant does not.
7. **`meta.parentName` controls active navigation and contextual help.** Detail routes often use the parent's guide chapter.
8. **The backend re-checks authorities.** No UI route table is a security authority.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Admin routes | `admin-front/src/router/index.ts` |
| Admin navigation and gates | `admin-front/src/layouts/sections.tsx` |
| Merchant routes | `merchant-front/src/router/index.ts` |
| Merchant navigation and gates | `merchant-front/src/layouts/sections.tsx` |
| Checkout routes | `checkout-front/src/router/index.ts` |
| Admin help map | `admin-front/src/content/guide/generated/context-map.json` |
| Merchant help map | `merchant-front/src/components/guide/ContextualHelpDrawer.tsx` |

### 5.1 Missing admin UI authority gates

| Route | Actual UI behavior | Backend evidence | Classification |
| :--- | :--- | :--- | :--- |
| `AdminUsers` | `routesAuthorities.AdminUsers = []`, so any authenticated admin can open it. | `/users` requires `user:read` or `security:read`; mutations require `user:write`/`security:write`. | Privilege gap. |
| `AdminUserDetail` | No entry; direct navigation is allowed. | `/users/:id` requires `user:read` or `security:read`. | Privilege gap. |
| `PricingControls` | No entry; only the nav item is hidden without `profit.read`/`liquidity.read`. | Commission/velocity endpoints require finance/commission/velocity authorities. | Privilege gap. |
| `GatewayAiImport` | No entry; it is reachable by URL even though it is not in the nav. | AI transcript/spec endpoints require `gateway:read`/`gateway:write`. | Privilege gap. |
| `AdminPlatformSettings` | No entry; any authenticated admin can open the page. | Settings reads require `settings:read`; writes require `settings:write`. | Privilege gap. |
| `AdminCheckoutHelp` | No entry; any authenticated admin can open the page. | Checkout-support reads require `settings:read`; writes require `settings:write`. | Privilege gap. |
| `AdminGuide` | No entry. | No business-data authority required. | Intentional learning surface. |
| `AdminAcademy*` | No entry (only `AdminAcademyTeam` has a role gate: `SECURITY_ADMIN`). | Progress and exams need only a back-office session; the team view requires the `SECURITY_ADMIN` role in admin-back and core-back. | Intentional learning surface; exams are server-graded. |

The merchant portal has a similar gap: `Statements` is shown in navigation only with `statements.read`/`statements.export`, but `routesAuthorities` has no `Statements` entry, so a direct URL is not redirected by the router. `Onboarding` intentionally has `[]` because every authenticated merchant must complete it.

## 6. Operational usage

- Adding an admin page: add the explicit router record, the navigation item, the authority entry, and a `context-map.json` screen/route-name entry in the same change.
- Adding a detail page: set `meta.parentName` so navigation/help resolve to the parent; if the parent has no context-map screen, add the route name to the owning screen or `General`.
- Adding a merchant page: add the route, section item, `routesAuthorities` entry (unless intentionally open), and the merchant `ROUTE_HELP` entry.
- Adding a checkout page: keep the router minimal; do not assume the `Dashboard` route exists.
- Testing a route: verify both the hidden-navigation case and the direct-URL case; a hidden nav item is not a route gate.

## 7. Status and deviations

### Implemented

- 37 protected admin routes with explicit components and names.
- 16 protected merchant routes plus public landing/login/register/not-found.
- Three checkout route records (home redirect, payer page, catch-all).
- Authority and role guards in admin and merchant routers.
- Parent-aware navigation, breadcrumbs, and contextual-help lookup.
- Admin dynamic-import retry and route error state.

### Partial

- Merchant `Statements` is not route-gated.
- Contextual help covers most admin routes but not all (see `04-contextual-help.md`).
- The admin route-authority table is advisory and must be kept in sync with core; the Guide/Academy reader routes are login-only and the Team page keeps its own `SECURITY_ADMIN` check.

### Missing / deferred

- No generated route-authority matrix test that fails when a protected route has no gate.
- No shared route metadata between the router, navigation, guide map, and tests.
- No checkout home page; `/` is a 404 redirect.

### Known bugs / risks

- **Checkout 404 recovery bug:** `checkout-front/src/pages/public/not-found/index.tsx` links to `{ name: "Dashboard" }`, but the checkout router has no `Dashboard` route. The recovery button leads back to the catch-all.
- **Admin help gap:** `Merchants` and `MerchantDetail` point to Book 9 Chapter 9.4, but the chapter object lives in Book 7's `chapters` array, so no chapter resolves.
- **Admin help gap:** `AdminUsers`, `AdminUserDetail`, `AuditLog`, `PricingControls`, `AdminPlatformSettings`, and `SystemBackups` have no effective help chapter.
- **Documentation gap:** the stale design claim of 36 admin routes / 15 merchant routes is superseded by the current 37 / 16 counts.

## 8. Verification and tests

- `tests/e2e/admin/shell.spec.ts` checks that every navigation destination renders, that role/authority-hidden sections behave, that direct access to a denied page redirects, and that the shell is responsive.
- `tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts` enumerates the admin route list, including `/guide`, `/academy`, and `/settings/checkout-help`.
- `tests/e2e/exhaustive/exhaustive-merchant-surface.spec.ts` enumerates merchant portal routes.
- `tests/e2e/exhaustive/exhaustive-checkout-surface.spec.ts` enumerates the checkout surface.
- `tests/e2e/admin/global-search.spec.ts` verifies deep links to records open the expected drawers.

These suites require a running stack and are skipped without the live/edge services.

## 9. Source references

### Old design sections

- `design/06-ui/portal_ui_implementation_plan.md` — page and shell rollout.
- `design/10-fixes/_0001_operator_cases.md` — operator-case and inquiry workflow.
- `design/07-guides-and-academy/guide_system_design_and_content.md` — current guide routes, context map and content.

### Code paths

- `admin-front/src/router/index.ts`
- `admin-front/src/layouts/sections.tsx`
- `admin-front/src/pages/**`
- `merchant-front/src/router/index.ts`
- `merchant-front/src/layouts/sections.tsx`
- `merchant-front/src/pages/**`
- `checkout-front/src/router/index.ts`
- `checkout-front/src/pages/public/not-found/index.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/code-surface-map.md`

## 10. Change history

- 2026-11-03 — Initial canonical route catalog. Confirms 37 admin protected routes and 16 merchant portal routes, records missing UI authority gates, the broken 9.4 help chapter placement, and the checkout 404 recovery bug.

## Security hardening (2026-11-05)

The `VITE_AUTHORIZED` bypass was removed. The route authority table moved to `src/utils/routeAuthorities.ts` with a default-deny guard. `PUBLIC_FOR_AUTHENTICATED` covers Dashboard, every Guide reader route and every Academy route (the Team page keeps its own `SECURITY_ADMIN` check); `AUTHORITY_ALIASES` normalizes dotted and colon forms. AdminUsers/Detail accept `user:read`/`user:write`/`security:*`, AdminPlatformSettings accepts `settings:read`/`settings:write` (plus the security fallback), and PricingControls includes `liquidity.read`. These checks are advisory; core enforces authorities. Any route not in the table is denied to authenticated users unless it is in `PUBLIC_FOR_AUTHENTICATED`.

## Admin UI completion: six new routes (2026-11-06)

Six protected children were added to `admin-front/src/router/index.ts` (and the sidebar in `layouts/sections.tsx`, authorities in `utils/routeAuthorities.ts`, guide context-map screens). The numbered table in 3.2 and the "37" counts in this part predate the Guide/Academy routes; the router now has **60** protected children (the six below included), so treat the table as a historical catalog and this section as current for these routes.

| Path | Name | Sidebar section | UI authority | Backend authority | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/wallets` | `Wallets` | Onboarding | `merchants.read` or `support.read_merchant` | `merchant:read` (freeze `merchant:write`) | Cross-merchant wallets: KPI strip, live/checkpoint balance ("Restricted" for non-financial roles), freeze (immediate) / unfreeze (approval) from the row menu. **Inspect** (or the wallet id) navigates to `WalletDetail`; `?open=<id>` redirects there. "Inspect GL account" still opens the GL drawer. |
| `/wallets/:id` | `WalletDetail` (`meta.parentName: Wallets`) | Onboarding | same as `Wallets` | `merchant:read` (freeze `merchant:write`) | Wallet details page replacing the old wallet drawer: header with status badge, frozen banner, pending approvals, Freeze/Request unfreeze, Refresh; metric strip (live, checkpoint, posted since checkpoint, pending cash-outs). `?tab=` (`overview` default, `statement`, `links`, `activity`): Overview (details card, shard table with a padded **Total** row and a shards-vs-live-balance integrity badge), Statement (`AccountLinesTable`: server-paginated posting lines with side/reference-type/date filters, search, totals of the whole filtered set, links to the source record and to the journal entry drawer), Links and cash-outs (assigned applications, last 10 cash-outs), Status history (`/wallets/:id/audit-events`: when, action, change, reason, by, approval). Merchant 360 and the application drawer link here. |
| `/applications` | `Applications` ("Applications & Channels") | Onboarding | same | `merchant:read` / `merchant:write` | Tabs Applications, Payment Links, POS Terminals; drawer with rail whitelist, redirect domains, API tokens (revoke), link cancel, terminal status; suspend immediate, reactivation and policy edits go to approval. `?tab=links\|pos`, `?open=<id>`. |
| `/transactions` | `Transactions` ("Transactions & Webhooks") | Operations | `merchants.read`, `support.read_merchant` or `attempt:read` | `attempt:read` (+`merchant:read`/`finance:read`) | Tabs Payment Attempts and Inbound Webhooks (verified / unmatched filters); the attempt drawer shows summary, step logs, inbound events and the checkout retry group as structured rows. |
| `/credential-sets` | `CredentialSets` | Gateways | `credentials.manage` or `gateways.edit` | `credential:read`/`gateway:read`, `credential:write` | Vault entries: create, rotate, verify, revoke (reason); secrets are write-only. `?highlight=<id>` (from search hits and Merchant 360). |
| `/finance/journal-entries` | `JournalEntries` | Finance | `profit.read` or `liquidity.read` | `finance:read` | Double-entry explorer: balanced badge, T-account drawer, GL account drawer; `?glAccountId=`, `?open=`. |
| `/system/jobs-outbox` | `JobsOutbox` ("Jobs & Outbox") | Operations | `security:read` | `security:read` / `security:write` | Outbox and audit-outbox monitors (no retry exists), background-job requeue, failed-notification retry. The metric strip also shows the ledger automation: shards behind their checkpoint (with the most pending lines), shards failing the checkpoint proof, and the last shard scaling. |

Existing routes that changed: `Invariant` is now "Ledger Audit & Invariant" with per-account actions (shards and lines, journal entries, checkpoint rollup); `MerchantDetail` shows the Wallets tab to every `merchant:read` role and gained interactive wallets/applications, structured beneficial owners, KYB revalidation, access rows and pending-change diffs; `Gateways` gained a route-health drawer; `Liquidity` shows route daily-cap utilisation; `GatewayRoutes`, `AdminPlatformSettings`, `Reconciliation`, `AmlRules`, `Rails`, `Approvals`, `AuditLog`, `Disputes`, `PricingControls` lost their raw-JSON views/inputs (see `admin-ui.system`). The GL account drawer (`GlAccountDrawer`) shows the routing width, a derived checkpoint status badge, a per-shard table (balance, lines, pending, checkpoint, checkpoint age, status, padded Total row), the paginated Lines table, "Run checkpoint rollup" (verifies every shard, names a failing one) and "Set shard count" (`finance:write`, reason, audited) and, per failed shard, **Repair** (`ShardRepairModal`: preview from the journal; an intact shard is recomputed at once with a reason, a damaged one is submitted to Approvals as `GL_SHARD_REPAIR`). Shared drawers are opened by id prop and clear themselves on `close`: `JournalEntryDrawer`, `GlAccountDrawer`, `WalletDetailDrawer`, `ApplicationDetailDrawer`. `attempt:read` was added to `AUTHORITY_ALIASES` (no portal equivalent).

Gaps: the dashboards/global search still route `payment_attempt` hits to Merchant 360's transactions tab (a test pins it; `Transactions?open=` would be a one-line change); approvals' "Open subject" has no target for `WALLET`/`APPLICATION`/`POS_TERMINAL`; merchant users open the `AdminUserDetail` route (works: `GET /users/:id` serves any user id).

## Remediation round 2 (2026-11-08): invitation route

`/accept-invitation` (`pages/public/auth/accept-invitation`) is a public route reached from the invitation message; the Users page creates users without a password and shows invitation state with a re-invite action; the login page links to nothing new.

## Tables Filters and Exports

> Status: `partial` · Last verified: 2026-11-07

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
8. **Actions are always reachable.** The action column is sticky to the inline end, so the visible primary action and the overflow trigger never require horizontal scrolling. A row-level context menu offers the same actions at the pointer (right-click) and from the keyboard (`Shift+F10`); the menu lists the primary action first, then the overflow items. The sticky trigger remains the touch path and the accessible baseline; links and form fields keep their native context menu.

## 3. As-built architecture

### 3.1 Components

| Component | File | Responsibility |
| :--- | :--- | :--- |
| `ApiTable` | `admin-front/src/components/Table/ApiTable.tsx` | Page-driven server fetch. The parent supplies `onRefresh`, data/total extractors, headers and optional filters. Supports local search suppression, refresh hooks, and XLSX export of the rendered page. |
| `DataTable` | `admin-front/src/components/Table/DataTable.tsx` | Either local data mode or "server" mode driven by a `server` prop or `tableRegistry[route.name]`. Server mode fetches one page of up to 200 rows and paginates locally. Persists server search/filter/sort state in `sessionStorage`. |
| `Table` | `admin-front/src/components/Table/Table.tsx` | Renders the Vuetify table, compact row styling, selection, column filters, row tone, and cell rendering. |
| `TableFilters` | `admin-front/src/components/Table/TableFilters.tsx` | Renders filter controls by type, active chips, summary text, a mobile/desktop surface, and an injection key so the toolbar can toggle filters. |
| `TableRowActions` | `admin-front/src/components/Table/TableRowActions.tsx` | One optional primary action plus a right-aligned overflow menu. Supports danger/disabled/hidden items and dividers. It also binds the row context menu (`contextmenu` + `Shift+F10`), shares the menu panel with the overflow trigger, and owns the one-open-menu coordinator. |
| `HeaderFooter` | `admin-front/src/components/Table/HeaderFooter.tsx` | Desktop/mobile toolbar and pagination, search, refresh, filter trigger, record count, XLSX button, and `useTableXlsx`. |
| `tableRegistry` | `admin-front/src/components/Table/tableRegistry.ts` | Maps a route name to a URL, list key, filters, default sort, optional storage key, params, and row mapper. |
| `filters` | `admin-front/src/components/Table/filters.ts` | Filter union type, active-state detection, query mapping, and server config type. |
| `referenceOptions` | `admin-front/src/components/Table/referenceOptions.ts` | Cached `/options/:kind` loaders for merchant/rail/gateway/user/wallet filters. |
| `statusTone` | `admin-front/src/components/Table/statusTone.ts` | Status-to-tone mapping used by filters and status pills. |

### 3.1.1 Row context menu and sticky action column (2026-11-07)

- **Sticky action column.** `.table-wrapper .pg-col-actions` is `position: sticky; inset-inline-end: 0` with an opaque surface background, a header above the body cells, and the hover surface on `tr:hover`. Removing `.modern-table { overflow: hidden }` was required so the sticky cell resolves against `.table-wrapper` (the actual horizontal scroll container).
- **One integration point.** `TableRowActions` finds its row (`root.closest("tr")`) on mount, marks it with `data-pg-row-actions-bound="true"`, and binds `contextmenu` and `keydown`. No page changes are needed; `MiniTable` rows that use the same component are covered too. The first action cell in a row owns the binding.
- **Context menu semantics.** Right-click opens the shared menu at the pointer through a hidden fixed activator; Vuetify flips it near the viewport edge and handles RTL. The activator's element ref MUST be composed with the one Vuetify passes in `activatorProps.ref` (`composeActivatorRef`): a second `ref` on the same element, before or after the spread, replaces Vuetify's and the menu then has no anchor and opens at the top-left of the page (found and fixed 2026-11-08; the same applies to the overflow button, whose focus return depends on its own ref). The e2e specs assert the menu position against the pointer. The menu always contains the primary action first (disabled/loading respected), a divider, then the visible overflow items. `hidden`/`disabled`/`dividerBefore` behave exactly as in the overflow menu.
- **Native exclusions.** `a`, inputs, text areas, selects, contenteditable fields, Vuetify field/checkbox/switch/radio/slider controls and `[data-no-row-context-menu]` keep the browser menu. Right-clicking a button (including the action buttons) opens the row menu.
- **Keyboard and focus.** `Shift+F10`/the ContextMenu key on any focused, non-editable element in the row opens the menu anchored at the action cell. Opening moves focus to the first enabled item; `Escape` is handled by a capture-phase window listener (so it also works when another overlay owns the global-top flag and when focus stayed on the row) and `restoreFocus()` returns focus to the overflow/primary button. The visible action button remains the accessible baseline.
- **One menu at a time.** A module-level closer is registered when either the overflow or the context menu opens; opening another row's menu closes the previous one. The button and context menus share the same panel renderer (max-height `min(70vh, 420px)`, internal scrolling).
- **Scope.** Admin shared tables (`ApiTable`/`DataTable`/`DataPage`) and `TableRowActions` used inside `MiniTable` rows. Custom inline action cells that do not use `TableRowActions` are not covered. The merchant portal uses the identical component and CSS copy.

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
- The Academy team view has no server export; it exports the visible rows as CSV client-side (`TeamTable`, formula-injection guarded).

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

## Registry slices (2026-11-06)

`components/Table/tableRegistry.ts` (keyed by ROUTE NAME) now spreads three area slices, `registry/commerce.ts`, `registry/ledgerOps.ts` and `registry/forms.ts`, so independent areas add filter configs without editing one shared literal. The approvals subject-type filter lists the new `WALLET` and `POS_TERMINAL` subjects. Pages with several tables (Applications: applications / payment links / POS terminals; Transactions: attempts / inbound events; Jobs & Outbox) pass their filters explicitly to `ApiTable`.

## Admin Guide and Academy

> Status: `partial` · Last verified: 2026-11-07

## 1. Purpose and scope

This part owns two employee learning products in `admin-front`:

- The Admin Interactive Guide at `/guide/**`: 14 books, 134 articles, glossary, safeguard cards, situation playbook, 140-case catalog, five simulators, reading paths, search palette, contextual help and read tracking.
- The Employee Academy under `/academy/**`: eight tracks, lessons with practice checks, simulated labs, server-graded certification exams, 12-month badges, certificates and a `SECURITY_ADMIN` team view.

It does not own the merchant guide or the checkout help center. The future-guide design is now implemented; its detailed implementation notes live in `06-guide-v2.md`.

## 2. Guide content pipeline

The canonical content is `design/07-guides-and-academy/guide_system_design_and_content.md` (a root duplicate with CRLF line endings is also accepted as a fallback).

`admin-front/scripts/extract-guide-content.ts` (`bun run content:guide`) parses only the `<!-- CONTENT:BEGIN -->` … `<!-- CONTENT:END -->` region, validates every cross-reference, enforces the design counts, and emits committed JSON into `admin-front/src/content/guide/generated/`:

| Artifact | Count / notes |
| :--- | :--- |
| `books.json` | 14 books |
| `articles.en.json` | 134 articles with headings, plain text, roles, UI status and related ids |
| `glossary.en.json` | 151 terms with aliases, Arabic term and related slugs |
| `cards.en.json` | 25 cards and 112 required checklist items |
| `playbook.en.json` | 32 situations with screens, cases and articles |
| `paths.json` | 8 reading paths (`ALL` plus seven staff roles) |
| `faq.en.json` | 58 quick answers |
| `data.json` | `ledger-events`, `visible-rails`, `attempt-transitions` |
| `context-map.json` | 25 screens (including `Wallets` and `SystemBackups`), the last being the `General` fallback |
| `error-codes.en.json` | 19 codes parsed from `b13-01` |
| `edge-cases.en.json` | 140 rows parsed from the v4.1 design |
| `meta.json` | `contentVersion`, deterministic `generatedAt`, counts and source SHA-256 |

The extractor output is deterministic and byte-stable. The content test re-runs it into a temporary directory and fails on drift, count changes, unresolved links, empty bodies, external URLs, missing context-map routes, missing widgets or a gzip total above 400 KB.

`scripts/overhaul-guide-and-academy-clarity.ts` is the content clarity gate. It labels every bare inline `[[a:…]]` / `[[c:…]]` / `[[s:…]]` / `[[g:…]]` token outside tables with a short natural title, skips code fences, table rows and already-labelled links, and supports `--check` (used by `guide-content.test.ts`). Table cells stay unlabelled because a `|` inside a link label would split the markdown cell; the readers shorten bare table links at render time instead. Parenthetical reference dumps are removed at render time (see §3), so the canonical prose preserves the links. The clarity overhaul (2026-11-07) rewrote 101 Guide articles (Books 2 and 4–12; Books 0, 1, 3 and 13 untouched) so each opens with a `:::summary` "In plain words" callout and a plain-language opening, and rewrote 40 Academy lessons as self-contained 350–600 word tutorials (all 50 lessons are now in that form); it also added short labels on bare references. Counts, ids, headings, check ids, quiz structure and table rows are unchanged. Each rewrite was validated mechanically and then reviewed independently against the old text and the code; the factual corrections that review found are listed in `design/07-guides-and-academy/guide_content_fixes.md` and `academy_content_fixes.md`. The authoring standard is §10.

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

`MarkdownView` uses `markdown-it` (`html:false`, `linkify:false`) and adds callouts, diagram fences, table scrolling, stable heading ids, article/card/situation/glossary links, glossary auto-linking (first occurrence per article, never in headings, links, code or table headers) and widget placeholders. The glossary popover is keyboard reachable and focus-trapped. Markdown and edge-case tables keep a `9.5em` minimum column width, so a table narrower than that budget scrolls horizontally inside its focusable wrapper (with themed thin scrollbars and contained overscroll) instead of compressing; cells use `overflow-wrap: normal` and never break a word letter by letter. The edge-case filter controls also cap at the row width so the page itself never overflows on a phone.

The clarity renderer adds:

- **Automatic parenthetical extraction.** Parenthetical pointers such as `([[a:b06-12]])`, `(see [[a:b07-03]])` or `(see [[a:b06-05]], [[a:b06-07]])` are removed from the sentence, deduplicated and rendered in a per-`##`-section **Related** tray of typed pills (`Guide`, `Screen`, `Playbook`, `Term`). Meaningful parenthetical prose is preserved: `(called rails, see [[a:b02-06]])` becomes `(called rails)`. Links extracted this way carry `data-ref-kind` and `data-ref-id`.
- **Short inline labels.** A bare `[[a:id]]` renders the target's short title (the clause before a colon, or at most 12 words) instead of dumping the full 10-to-15-word title into the sentence. The full title is still the anchor's `title` attribute.
- **Summary and reference callouts.** `:::summary` renders a warm "In plain words" banner for a two-sentence orientation at the top of an article; `:::refs` renders a "Where to go next" callout whose links explain why the reader would follow them. Explicit `:::refs` links are excluded from the automatic section tray to avoid duplicates.
- **Reference preview popover.** In the full reader (not compact embedded views), clicking a guide, screen or playbook pill opens a keyboard-accessible popover with the type badge, title, reading time or risk, a short plain-text body and two actions: **Stay here** and **Read full page →**. Compact views (`ContextHelpDrawer`, `SafeguardDialog`, Academy help drills) keep direct navigation so the hosting dialog is not covered.

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

One JSON record per user in `users.academy_progress_json` (the column pre-dates the rebuild; no migration). It is shared by the Guide and the Academy.

```ts
AcademyProgress { schema:1; rev; startedAt; updatedAt; contentVersion; activeTrack?; integrityAcceptedAt?;
  guideRead: Record<articleId,{v,at}>; lessons: Record<lessonId,{at,v,checkScore:0|1|2}>;
  labs: Record<labId,{bestScore,attempts,passedAt?,criticalErrors,v}>;
  exams: Record<examId,{attempts[],open?,passedAt?,v}>; badges: {id,track,earnedAt,expiresAt,v}[] }
```

- **Browser-writable keys** are only `guideRead`, `lessons`, `labs` and `activeTrack`, through `PUT /api/v1/admin/academy/progress` with `{ baseRev, patch }`. The server ignores `exams`, `badges`, `contentVersion`, `rev`, `schema`, `integrityAcceptedAt` and `_server` in a patch, and drops lesson/lab ids that are not in the catalog.
- **Server-written keys** are `exams`, `badges`, `integrityAcceptedAt`, `rev`, `contentVersion`.
- **Merge rules** (server `engine/academy/progress.ts` and client `components/academy/progressMerge.ts` agree): lessons keep the later `at`; labs keep the max `bestScore`/`attempts`, the earliest `passedAt`, and `criticalErrors`/`v` from the best entry; `guideRead` keeps the later `at`. Keys are never deleted: un-reading a Guide article writes a tombstone `{ v: "", at }`.
- **Concurrency:** a stale `baseRev` returns `409 ACADEMY_REV_CONFLICT` with `details:{progress,rev}`; the client refetches, merges and retries once. `rev` also bumps on exam start/submit. The store compare-and-swaps on `User.updatedAt` (retry up to 4, then `ACADEMY_BUSY`).
- **Server-only state** lives in the same JSON under the reserved key `_server` (open exam sessions with question ids and opaque option ids, previous attempt's question ids, attempt counters, last submitted session ids). `publicProgress()` is the only exit and strips it, including from `GET /users/:id`. Stored size limit 64 KB (`413 ACADEMY_PROGRESS_TOO_LARGE`).
- **Legacy rows** (no `schema:1`, the pre-rebuild academy shape) are replaced by a fresh record that carries over only `guideRead`.
- **Client:** `useAcademyProgress` keeps the last record and a queue of unsent patches in `localStorage["pg.academy.progress"]`, stamped with the owner's user id (a record with no owner or another user's is dropped, never adopted; `setUserState` fires `pg:user-changed` on every login/logout/switch and `resetAcademyProgress` drops the in-memory singletons, with a generation counter so a request in flight for the previous user cannot write into the next user's state; before 2026-11-08 user A's queued patches could be sent under user B's token); a failed save never blocks learning and shows a "not saved yet" indicator. `useGuideProgress` (the Guide's hook) is a thin layer over it and one-time migrates `pg.guide.read`.

## 7. Academy (rebuilt 2026-11-04)

Specification: `design/07-guides-and-academy/academy_system_design_and_content.md` (Parts 0-II are the spec, Part III is the content; the file carries a dated repository note listing the reconciliations made during implementation).

### 7.1 Content pipeline

`admin-front/scripts/extract-academy-content.ts` (`bun scripts/extract-academy-content.ts`) parses only the `<!-- CONTENT:BEGIN -->` … `<!-- CONTENT:END -->` whole-line markers, validates every block and reference, deep-validates lab JSON, and writes deterministic output:

| Output | Content | Audience |
| :--- | :--- | :--- |
| `admin-front/src/content/academy/generated/` | `meta`, `tracks`, `modules`, `lessons.en` (markdown `body`, rendered `html`, `plainText`), `checks.en` (100 practice questions WITH keys), `labs.en` (WITH keys), `drills.en`, `pages.en`, `lab-vectors`, `exam-blueprints.public` (no question ids) | browser |
| `core-back/content/academy/exam-bank.json` | 223 exam-pool questions WITH keys + 8 blueprints | server only, never served |
| `core-back/content/academy/catalog.json` | tracks → lesson/lab/exam ids, lesson/lab titles, badge ids; no questions | server (eligibility, team view) |

Counts (asserted by `academy-content.test.ts`): 8 tracks, 11 modules, 50 lessons (20 Foundation + 30 role), 100 checks, 223 exam-pool questions (208 single, 13 number, 2 order; 43 critical), 16 labs / 92 tasks, 8 exams, 11 drills, 7 pages (+ `lab-vectors`). Generated output is ~75 KB gzipped (budget 600 KB). Exam-pool question ids never appear under `admin-front/src/content/academy/generated/`.

### 7.2 Tracks, badges, routes

`FOUNDATION` (everyone) plus one role track per back-office role (`OPERATOR`, `SUPPORT`, `FINANCE`, `COMPLIANCE`, `MLRO`, `GATEWAY_ADMIN`, `SECURITY_ADMIN`; the role enum and track ids coincide). A user's required tracks = Foundation + their role track. Badges last 12 months and show **Recertification required** when expired or when `meta.recertifyFrom` major is newer than the badge's `v`. Certification is evidence, not permission: nothing in the platform switches authorities on a badge.

| Route name | Path | Notes |
| :--- | :--- | :--- |
| `AdminAcademy` | `/academy` | My learning: active track, **Continue**, rings, badges, Guide reading progress |
| `AdminAcademyTracks` / `AdminAcademyTrack` | `/academy/tracks`, `/academy/track/:trackId` | modules, lesson/lab state, exam Locked (missing prerequisites in words) / Ready |
| `AdminAcademyModule` / `AdminAcademyLesson` | `/academy/module/:moduleId`, `/academy/lesson/:lessonId` | lesson = body, Read now list, two checks, **Mark lesson complete** (needs both checks answered and every reading article opened or read) |
| `AdminAcademyLab` | `/academy/lab/:labId` | lab runner |
| `AdminAcademyExam` | `/academy/exam/:examId` | briefing → runner → result |
| `AdminAcademyCertificate` | `/academy/certificate/:badgeId` | printable |
| `AdminAcademyTeam` | `/academy/team` | `SECURITY_ADMIN` only (`routesRoles`, `admin-back`, `core-back`) |
| `AdminAcademyHelp` | `/academy/help` | learner texts, trainer guide, optional live drills (staging only) |

All ten route names are in the Guide context map's `Academy` screen. No route has an authority gate except Team.

### 7.3 Labs (browser)

`components/academy/labScoring.ts` is pure and unit-tested against the 18 published vectors. Six task kinds: choice, multi, ledger, order, checklist, numeric. Rules: hint costs 1 point (floor 0); multi `max(0,(right-wrong)/totalCorrect)`; ledger compares Decimal cells per expected line and penalises non-zero cells on unexpected accounts, with a live Balanced/NOT BALANCED badge; order partial credit rounded down to 1 decimal; any critical option/wrong id is a critical error. Lab score = round(100·earned/possible); pass = ≥ `passPercent` (80) and zero critical errors. Labs are deterministic (no shuffle, no timers), make no network calls except saving progress, and show a "TRAINING — nothing here is real" ribbon and a `SANDBOX` badge. `progress.labs` keeps best score, attempts, first pass and the critical-error count of the best attempt.

### 7.4 Exams (server)

Endpoints under `/api/v1/admin/academy/` (admin-back proxy → `core-back` `/internal/admin/academy/`): `GET progress`, `PUT progress`, `GET exams/:examId/eligibility`, `POST exams/:examId/start`, `POST exams/:examId/submit`, `GET team`. admin-back rate-limits 60 requests/minute per user (`429 ACADEMY_RATE_LIMITED`). Merchant principals get `403 ACADEMY_BACK_OFFICE_ONLY`.

- **Eligibility:** role exams need a valid (not expired, not below `recertifyFrom`) Foundation badge; every lesson of the track completed; every lab of the track passed (`bestScore ≥ passPercent` and `criticalErrors == 0`, else `lab_critical`). Cooldown after a failed attempt (`cooldownMinutes`). After 3 consecutive failures each module below 70 % in the last attempt needs one of its lessons re-opened after that attempt. `missing[].text` names lessons and labs by title.
- **Start** requires `{ integrityAccepted: true }` (records `integrityAcceptedAt`; `page-integrity` is shown in the briefing). One open session per user per exam; a live session is returned again (`resumed:true`) with the same questions and option ids. The set is built deterministically from `sha256(userId:examId:attemptNumber)` → mulberry32: per-module seeded shuffle preferring questions not in the previous attempt, a floor of `criticalPick` critical questions (swaps inside the same module), seeded order shuffles, opaque random option ids per session. Starting consumes the attempt number and remembers the set even if never submitted (an abandoned session cannot be replayed for free). The start payload has no `correct`, `critical`, explanation, notes or refs.
- **Submit** grades 1 point per question (single/truefalse exact, multi all-or-nothing, order exact sequence, number `decimal.js` within tolerance, unanswered wrong). `scorePercent` rounds half up; pass = `scorePercent ≥ passPercent` and `criticalMissed == 0`. One submission per session (`422 ACADEMY_SESSION_USED`); a submit after expiry + 2 minutes is a failed attempt scored 0 (`expired:true`). A pass issues the track badge (`expiresAt` = +12 calendar months, replaces an older badge). Result items carry the answer, correct answer, `why`, option notes, refs and critical flag.
- **Audit:** `ACADEMY_PROGRESS` (key counts), `ACADEMY_EXAM_STARTED`, `ACADEMY_EXAM_SUBMITTED` (score, pass, critical missed, attempt number only), `ACADEMY_BADGE_ISSUED`, `ACADEMY_TEAM_VIEWED`. Answers and question ids are never logged.
- **Error codes:** 403 `ACADEMY_TEAM_FORBIDDEN`/`ACADEMY_BACK_OFFICE_ONLY`, 404 `ACADEMY_EXAM_NOT_FOUND`, 409 `ACADEMY_REV_CONFLICT`/`ACADEMY_BUSY`, 413 `ACADEMY_PROGRESS_TOO_LARGE`, 422 `ACADEMY_NOT_ELIGIBLE`/`ACADEMY_INTEGRITY_REQUIRED`/`ACADEMY_SESSION_EXPIRED`/`ACADEMY_SESSION_USED`.

### 7.5 Team view

`GET team` (`SECURITY_ADMIN` role, audited) returns one row per back-office user (`merchantId` null, status not `DISABLED`): name (email local part), role, maker/checker flags, required tracks, lessons/labs done vs required, badges with expiry, last activity and a status with precedence `RECERTIFICATION_REQUIRED` > `EXPIRING_SOON` (within 30 days) > `CERTIFIED` > `EXAM_READY` > `IN_PROGRESS` > `NOT_STARTED`. No question text, answers or per-question results. The page filters by role/status/search and exports the visible rows as CSV with a formula-injection guard.

### 7.6 Visual system v2 (2026-11-05)

The first rebuild (7.1-7.5) was functionally complete but visually foreign: it injected a private UI kit (`.ac-btn`, `.ac-chip`, `.ac-card`, `.ac-nav`, `.ac-skel`) through a runtime `<style innerHTML>` on every page, used glyph/emoji icons, mixed `--pg-*` and `--v-theme-*` tokens, and capped the whole Academy at `max-inline-size: 820px` inside the 1600 px `ScreenContainer` (the system container; the 820 px figure is the Guide's *reading measure*, not a page width). v2 re-expresses the same screens, content and behaviour in the admin design system (`00-ui-system.md`).

**Frame.** `components/academy/AcademyShell.tsx` renders `ScreenContainer > .ac-wrap > [page header, section toolbar, body, footer]`. Each page file passes its own `PageHeader` through the `header` render prop (the compliance gate requires the literal `PageHeader` in every route entry). The toolbar holds `ui/AcademyNav` (a segmented-tabs look built from real links; keeps `nav[aria-label="Academy sections"]`, the section stays lit on sub-pages, `aria-current="page"` only on the exact route) and the "not saved yet" `MetaPill`. The shell still loads the progress record on mount and flushes unsent patches on leave.

**Width and layout.** No page-level cap. Pages are grids: `.ac-grid` (auto-fill cards, `--ac-min`), `.ac-split` (main + sticky `.ac-aside`, one column below 1100 px; `.ac-split--reading` caps the main column at 920 px for the lesson, exam runner and review), `.ac-hero` (My learning). Only reading text has a measure (`.ac-prose`, 75 ch).

**Styles.** `src/styles/academy/{base,learner,lesson,lab,exam,team}.css`, imported once through `styles/academy/index.css` from `main.ts`. Tokens only (`--pg-*`), logical properties, flat hairline surfaces, no gradients, `prefers-reduced-motion` honoured, RTL via logical properties and `.ac-flip` for directional icons. The runtime `<style>` block is gone.

**Components.** Pages compose the shared primitives (`PageHeader`, `SurfaceCard`, `StatusBadge`, `MetaPill`, `MetricStrip`, `SegmentedTabs`, `EmptyState`, `DescriptionList`, `VBtn`) plus Academy atoms in `components/academy/ui/`: `StateIcon` (MDI state marker, always paired with words), `ProgressBar`, `Callout` (inline status message), `IconTile`, `trackMeta` (track icons, badge-state → tone). `BadgeChip` is now a `StatusBadge` inside `span.ac-chip[data-track]`; `ProgressRing` is a thin flat ring. Date helpers live in `components/academy/format.ts`.

**Screens (what changed).**

| Route | v2 |
| :--- | :--- |
| `/academy` | Hero card (active track, next-step sentence, one primary **Continue** link, three rings) + split: your tracks (progress, badge, make active) / certificates list with links, Guide reading, quick links. |
| `/academy/tracks` | Filter tabs (All · For my role · Certified) over a card grid with icon, badge state, facts, progress and Required/Active markers. |
| `/academy/track/:id` | Summary + timeline-style module cards; sticky **Exam readiness** aside (status, facts, missing prerequisites in words, exam link). |
| `/academy/module/:id` | Module list with "Up next" marker and previous/next module links. |
| `/academy/lesson/:id` | 75 ch article, Read now, progressive practice checks, finish card; sticky aside with the lesson checklist and the module outline; previous/next tiles. |
| `/academy/lab/:id` | Calm TRAINING/SANDBOX strip (warning tokens, no solid fill), task stage + sticky lab-progress aside, panels grid, token-based answer rows, ledger as a unified-table look with a Balanced badge, task-by-task result. |
| `/academy/exam/:id` | Briefing facts strip + requirements + integrity + coverage; runner with sticky timer/progress/question navigator aside; result with verdict, metrics, filterable review (All · Incorrect · Critical). |
| `/academy/certificate/:id` | Formal sheet (print CSS unchanged) + status/actions aside. |
| `/academy/team` | Status summary strip + the unified table surface (`pg-table-card`/toolbar/footer), `StatusBadge` statuses and mini progress bars; CSV export unchanged. |
| `/academy/help` | Topic rail + `.ac-prose` page; live drills as expandable cards. |

**Defects fixed while verifying the redesign.** (1) Strings with `{placeholders}` were translated without their values (`fmt(t("Continue: lesson {title}"), …)`), but vue-i18n consumes placeholders at translation time, so titles, counts and "x of y" rendered blank; every call now passes the values to `t(key, values)` (`fmt` removed) and content titles are bidi-isolated (`format.ts` `isolate`) inside Arabic sentences. (2) Lesson bodies end with the structural `### Read now` / `### Check yourself` sections (a link list and raw check ids) that the page renders as its own cards; `components/academy/lessonBody.ts` `lessonProse()` stops the displayed prose before them (the content itself is untouched; unit test `tests/unit/academy-lesson-body.test.ts`). (3) The old `.ac-btn` painted a fixed white label on `--pg-accent-primary`, which is near-white in dark mode. (4) `kt-dc` `dc((props) => …)` only declares runtime props when the options argument lists them (`{ props: [...] }`); the exam, certificate and team components now do. (5) Partial-credit lab points are shown with at most two decimals (`pts()`). (6) An independent review of the redesign found and fixed: authored English (`dir="auto"`) sitting at the far edge of RTL option rows (Chrome resolves `text-align: match-parent` to the element's own start, so `html[dir="rtl"]` rules in `base.css` state `right` outright), the lesson checklist reporting "0 of 0 / done" before the checks had loaded (totals now come from `lesson.checkIds`), the exam runner's visual order differing from its DOM order on narrow screens (the aside now follows the question in both; a visual-only clock repeats in the question header), the Team person cell losing its `th scope="row"` role, and the Team 403 state losing its heading.

**Test hooks kept** (see `tests/e2e/admin/academy-*.spec.ts`, `academy-live.ts`): `.ac-wrap`, `.ac-nav`, `.ac-card` (never nested, so the overlap check holds), `.ac-chip[data-track]`, `aria-busy` skeletons, every heading/button/label/region name the specs query. No logic file changed (`useAcademyProgress`, `progressMerge`, `nextStep`, `labScoring`, `useEligibility`, `readingOpened`).

### 7.7 Content accuracy pass (2026-11-05)

The guide was checked against the built admin screens and the current core behaviour. Stale "no screen" claims were removed: staff user management (Admin Users), audit search (Audit Log), commission/velocity changes (Pricing & Limits) and versioned platform settings (Platform Settings) all have screens. The menu table now lists Audit Log, Admin Users, Inquiry Schedule, Backups, Platform Settings and Pricing & Limits, and the Admin Users, Inquiry Schedule and Platform Settings articles describe those screens. MFA is described as an SMS code to the registered phone (not an authenticator app), sign-out is documented as server-side revocation, the authority catalogue is described as closed with no self-escalation, reconciliation fingerprints are per statement source, and the Backups screen/drill/policy flow is described. Academy `l-m1-5` uses the same SMS wording. The exact corrections are logged in `guide_content_fixes.md` and `academy_content_fixes.md`.

### 7.8 Offline companion (2026-11-06)

`companion-app/` is a separate offline-first Android app that mirrors the complete Guide and
the learner-facing Academy. It runs the same canonical extractors with redirected output and
commits the resulting snapshot in `companion-app/public/content/`. It deliberately excludes
the Academy exam bank, team view and server-graded certification. The app is documented in
`project-design/parts/10-companion/00-offline-companion.md` and
`design/06-ui/pg_companion_offline_android_app.md`. No runtime code in `admin-front` is
imported by the companion; this part remains the authority for the web Guide/Academy.

## 8. Contracts and invariants

1. The design file content is the single source of truth; article prose is never retyped into TSX.
2. Generated JSON is committed and byte-stable; count changes require updating the design table and meta counts.
3. Guide content contains no live data, external links or secrets.
4. Guide routes have no authority gate; every admin may read the guide.
5. Money math in simulators uses `decimal.js`; no `eval`, `new Function` or `vm`.
6. Safeguards never replace existing confirmations or maker-checker rules.
7. Opening contextual help must not reset the current form.
8. The guide and Academy share one progress record; a save from either page preserves the other's fields.
9. Exam keys, `critical` flags and explanations never reach the browser before submit; the browser cannot write `exams` or `badges`.
10. The Academy never changes `is_maker`, `is_checker`, a role or an authority.
11. Academy content is never retyped into TSX; labels are corrected only in the design file and logged in `academy_content_fixes.md`.
12. The Academy composes the shared admin primitives and `src/styles/academy/*.css`; it defines no parallel button/chip/card kit, applies no page-width cap (only `.ac-prose` has a measure), never nests `.ac-card` (the e2e `layoutProblems` helper asserts no overlap) and keeps `PageHeader` literally present in every `pages/academy/*.tsx` entry (UI compliance gate).
13. Strings with `{placeholders}` are translated with their values (`t("Continue: lesson {title}", { title })`); never format after translating. Authored English content interpolated into a translated sentence is wrapped with `isolate()`.

## 9. Verification

```bash
cd admin-front && bun run content:guide && bun run content:academy && bun run type-check && bun run test:unit && bun run build
bun scripts/overhaul-guide-and-academy-clarity.ts --check
cd ../tests && bunx vitest run unit/guide- unit/academy-
cd ../core-back && bun run typecheck && bun test test/academy-
cd ../admin-back && bun run typecheck && bun test test/academy-progress.test.ts test/admin-surface.test.ts
cd ../tests && bunx playwright test --project=admin e2e/admin/guide-*.spec.ts e2e/admin/academy-*.spec.ts   # needs a deployed stack
```

## 10. Authoring standard (readability)

Every new or edited Guide article and Academy lesson follows this standard. Readers range from an intern to the CEO and most read English as a second language, so articles are **layered**: the summary and tables serve the expert, the story and example serve the newcomer.

**Article anatomy.** (1) `:::summary Big picture in 20 seconds`: at most two sentences, 45 words. (2) An opening in everyday terms (a situation the reader knows, or their real question), with at most one analogy, noting where it stops being true. (3) Short `###` sections whose headings say what they answer (never `##`). (4) A worked example with the shared cast wherever numbers or a sequence matter. (5) Reference tables only for lookup, each introduced by one sentence, at most five columns, no explanations hidden in cells. (6) Operator articles end with what you do and never do. (7) At most three callouts and an optional `:::refs` of at most three links, each with a reason to click.

**Sentences.** Average at most 18 words, none over 28; one idea per sentence, four sentences per paragraph at most; active voice. Introduce a term in its own short sentence before using it; at most one parenthesis per paragraph. One name per concept; spell out abbreviations at first use; no idioms, no "simply/just/obviously". Code identifiers stay exact in backticks, but say what they mean in words first. LYD amounts use three decimals (25.500 LYD) and every example sum must be recomputed.

**Links.** Inline links use a natural two-to-six word anchor that reads as part of the sentence; never a parenthetical link, never an article id in prose. Inside a table use a bare `[[a:id]]`. Every existing link target is kept.

**Shared cast.** Layla (payer), Noon Mart (merchant), Sadad / MobiCash / Edfali (partner wallets), Ali (operator), Huda (finance), Omar (compliance). Default example: Layla pays 25.500 LYD for a phone case at Noon Mart with Sadad. Example roles must follow the approval matrix (`b04-05`). Invented numbers are labelled as examples.

**Facts are sacred.** Rewriting changes readability only. Never add, drop, soften or strengthen a claim, state name, number, limit, role, screen name or safeguard. A claim the code contradicts is corrected only with evidence recorded in the `*_content_fixes.md` files; a disagreement between text and code that needs a product decision goes to `*_content_questions.md`.

**Lessons.** Six headings in order (`You will be able to`, `Key ideas`, `A worked example`, `Common mistakes`, `Read now`, `Check yourself`); 350–600 words that a learner can pass without opening the Guide; every correct answer and the reason each wrong option is wrong is taught in the lesson; check ids and Read-now links unchanged.

**Review before merging.** A mechanical diff (header, link targets, widgets, dropped numbers and code terms) is not enough: the rewrite of 101 articles and 50 lessons found 21 high-severity and about 67 medium problems (invented behaviour, wrong example roles, misleading analogies) only when a second reader compared old text, new text and the code.

## Backup and disaster-recovery content (2026-11-06)

Added from `design/02-storage-and-performance/backup_engine_reliability_architecture_and_test_plan.md` section 5, corrected against the real product: Guide articles `b12-09` (full/delta/WAL/PITR, topologies, encryption and the three storage tiers), `b12-10` (the Backups screen: real tile, badge and column labels) and `b12-11` (manual triggers, maker-checker policy changes, queueing and idempotency); safeguard cards `sg-trigger-backup`, `sg-run-restore-drill`, `sg-update-backup-policy`; situations `s-backup-daemon-unreachable`, `s-wal-archive-lag-high`, `s-restore-drill-failed`; a `SystemBackups` context-map screen. Academy: lesson `l-m10-4` (GATEWAY_ADMIN and SECURITY_ADMIN tracks only, to avoid adding certification time for every learner), lab `lab-backup-dr-desk`, drill `drill-pitr-recovery` and exam questions `q-m10-113..117`.

Corrections to the draft: the exam question ids `q-m10-004..008` collided with existing questions and were renumbered; the extractor requires exactly two checks per lesson, so the third moved into the exam pool; `@@map` takes a JSON block, not the draft's one-liner; the real route is `SystemBackups` (not `AdminSystemBackups`); the menu path is Operations -> Backups; the drill has three invariant checks, not five gates; unverified claims (cron gap minimums, hard-coded retention defaults, a 30-second tick) were removed. Content stays English-only like the rest of the Guide/Academy bodies. The three new cards are content only: they are not wired into `pages/system/backups/index.tsx` with `useSafeguard`.

## Contextual Help

> Status: `implemented` · Last verified: 2026-11-04

## 1. Purpose and scope

This part owns the admin contextual-help button and drawer, the 25-screen context map, and the safeguard dialog that appears before risky actions. The merchant portal drawer and payer checkout help are separate products; this part only records their boundary.

## 2. As-built architecture

### 2.1 Button

`admin-front/src/components/ui/PageHeader.tsx` renders `ContextHelpButton` automatically. The button uses the current route name, preferring `route.meta.parentName` over `route.name`, and opens a shared drawer through `useContextHelp()`. Pages never wire the button by hand. The app-bar "Help & SOP" button and the `?` shortcut open the same drawer with the same parent-first rule.

The accessible name is "How this page works".

### 2.2 Context map

`context-map.json` is generated from `@@map id=context-map` in the guide design. It contains `fallbackScreenId` plus 23 `ContextScreen` entries with `screenId`, `routeNames`, `pageDir`, `summary`, `articles`, `cards` and `situations`.

Resolution rules:

1. Find the first screen whose `routeNames` contains the current route name.
2. If none matches, use the screen whose `screenId` equals `fallbackScreenId` (`General`).
3. `pageDir` is the `admin-front/src` folder used by the label-verification procedure.

The route-coverage unit test parses every named route in `router/index.ts` (except `Login` and `NotFound`) and fails if a name has no context-map entry. Missing names were added to the owning screen or `General` and logged in `design/07-guides-and-academy/guide_content_fixes.md`.

### 2.3 Drawer

`ContextHelpDrawer` is a non-modal navigation drawer, 420 px wide, placed on the inline-end side (right in LTR, left in RTL). It shows:

1. **What this screen is for** — the screen summary.
2. **Before you act** — collapsible safeguard cards with risk badges and the full four-section body.
3. **Common problems** — situation links.
4. **Learn more** — article links.
5. **Open the whole guide** — route to `AdminGuide`.

The drawer does not unmount or reset the page, and a test types into the merchant filter, opens the drawer, closes it and asserts the value remains.

### 2.4 Safeguard dialog

`SafeguardDialog` is mounted once in the default layout. `useSafeguard(cardId).confirm()` returns `Promise<boolean>`:

- Every `- [ ]` item in the card's `Check first` section is a required checkbox.
- **Continue** is disabled until every box is ticked.
- **Cancel** resolves `false`.
- Ticks reset on every open and are never stored or sent.

The integration points are the 22 action areas named in the guide design: approvals, adjustments, cash-outs, operator cases, join requests, merchants, AML cases/screenings/rules/reports, gateway wizard, routes, AI import and reconciliation. Existing confirmation and maker-checker mechanisms remain in place after the safeguard. Two cards (`sg-reverse-adjustment`, `sg-release-reservation`) have no separate current UI action; this is documented in `design/07-guides-and-academy/guide_content_questions.md`.

## 3. Contracts and invariants

1. Help is always one button away in `PageHeader`; no page wires it manually.
2. The route key is parent-first, matching navigation and breadcrumbs.
3. Unknown route names always fall back to `General`.
4. Opening help never navigates or resets form state.
5. The drawer never substitutes for an approval; safeguards are additional, not a replacement.
6. The guide and drawer contain no live data, secrets or external links.
7. Merchant and checkout help remain separate content domains.

## 4. Surface

| Surface | Location |
| :--- | :--- |
| Button | `admin-front/src/components/guide/ContextHelpButton.tsx` |
| Drawer | `admin-front/src/components/guide/ContextHelpDrawer.tsx` |
| Shared state | `admin-front/src/components/guide/useContextHelp.ts` |
| Safeguard dialog | `admin-front/src/components/guide/SafeguardDialog.tsx` |
| Safeguard composable | `admin-front/src/components/guide/useSafeguard.ts` |
| PageHeader mount | `admin-front/src/components/ui/PageHeader.tsx` |
| Global mount | `admin-front/src/layouts/default.tsx` |
| Context map | `admin-front/src/content/guide/generated/context-map.json` |
| Merchant drawer | `merchant-front/src/components/guide/ContextualHelpDrawer.tsx` |
| Checkout help | `checkout-front/src/components/help/**` |

## 5. Verification

`tests/unit/guide-content.test.ts` checks route coverage. `tests/e2e/admin/guide-context.spec.ts` checks five representative routes and form-state preservation. `tests/e2e/admin/guide-safeguard.spec.ts` checks the disabled Continue button, required checks and that Cancel sends no request.

## Backups Settings and Operations

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part owns the admin operational pages that are neither the primary merchant/payment queues nor the guide:

- Backup management at `/system/backups`.
- Platform settings versioning and restore at `/settings/platform`.
- Checkout support configuration, history and diff at `/settings/checkout-help`.
- Academy team view at `/academy/team` (`SECURITY_ADMIN`).
- Their shared export/checklist behavior and authority gating.

It does not own the backup daemon, PostgreSQL WAL configuration or restore-drill engine. Those are in the deploy and storage parts. It documents the admin UI and the backend contracts that the UI calls.

## 2. Design intent (extracted and synthesized from ./design)

The operations surfaces follow the same governance pattern as the rest of the admin portal:

1. **Read is separate from write.** Operators with read authority can inspect health, versions and history; writes require a stronger authority and are visibly hidden from read-only users.
2. **Versioned configuration, not in-place edits.** Platform settings and checkout support create a new immutable version; the effective version is the highest version whose effective date has passed.
3. **Restore is preview-first.** A backup file is parsed and summarized before anything is written; invalid entries and version conflicts block apply.
4. **Reason and checklist are part of the audit.** Restore and settings edits record the operator, reason and checklist keys.
5. **Backup policy is maker-checker.** A policy save creates a pending approval; a different checker executes the policy through the approvals queue.
6. **Exports are audited.** Summary and certification exports write audit entries and use the shared XLSX pipeline.
7. **Visibility flags are runtime-config controlled.** Checklist panels can be hidden by deploy configuration without changing the underlying action path.

## 3. As-built architecture

### 3.1 Backup management (`/system/backups`)

Page: `admin-front/src/pages/system/backups/index.tsx`.

Endpoints:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| Overview | `GET v1/admin/system/backups/overview` | `security:read` or `gateway:read` |
| Trigger backup | `POST v1/admin/system/backups/trigger` | `security:write` |
| Run restore drill | `POST v1/admin/system/backups/drill` | `security:write` |
| Update policy | `PUT v1/admin/system/backups/policy` | `security:write` |

The page renders:

- Metric strip: WAL archive lag vs alert threshold, daemon reachability, healthy storage targets, latest backup status/time, latest drill status.
- Alerts when backups are not configured or the daemon is unreachable.
- WAL archive lag card: archive lag, current LSN, last archived LSN, lag bytes, alert threshold.
- Daemon status card: engine mode, configured, overall health, generated time.
- Storage target cards: target name, kind, health and detail.
- Backup history table (latest 30 from daemon or local catalog): id, target, kind, engine, status, start/completion, duration, size, error.
- Latest drill card: status, target time, replayed LSN, double-entry drift, balance mismatches, audit broken links, journal line count and the three invariant checks (double-entry zero drift, sharded balance parity, audit hash chain).
- Trigger modal: target `all`/`postgres_core`/`audit_db`/`redis`; kind `full`/`delta`.
- Restore drill confirmation: explains the isolated scratch restore and invariant verification.
- Policy modal: full cron, delta cron, drill cron, full retention days, WAL retention days, alert lag seconds.

The write buttons are hidden without `security:write`, and the backend re-checks the same authority. A policy update without an `approvalRequestId` returns `202 PENDING_REVIEW`; the page displays the approval id but does not open the approval. The checker executes the policy through the general approvals flow, where `BACKUP_POLICY` has a dedicated handler. The checker must differ from the maker.

The overview endpoint is `no-store`, syncs daemon catalog rows into `backupCatalogRun`/`backupRestoreDrill`, and falls back to the local catalog when the daemon returns no data. The page does not call the separate `/catalog` endpoint.

### 3.2 Platform settings (`/settings/platform`)

Page: `admin-front/src/pages/settings/platform/index.tsx`.

Endpoints:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| List settings | `GET v1/admin/settings` | `settings:read` |
| Summary | `GET v1/admin/settings/summary` | `settings:read` |
| Summary export | `GET v1/admin/settings/summary/export` | `settings:read` |
| Backup export | `GET v1/admin/settings/export` | `settings:read` |
| Restore preview | `POST v1/admin/settings/restore-preview` | `settings:read` |
| Restore apply | `POST v1/admin/settings/restore-apply` | `settings:write` |
| Save setting | `PUT v1/admin/settings` | `settings:write` |

The page groups all versions by setting key, newest first, and shows:

- Key, latest version, scope, version count and effective date.
- A JSON preview.
- History and edit dialog.

A save:

1. Validates the key against `^[A-Za-z0-9._:-]{2,120}$`.
2. Requires a JSON object (not an array or scalar).
3. Requires the setting checklist when checklists are visible.
4. Calls `PUT v1/admin/settings` with `settings: { [key]: parsed }` and the checked keys.
5. The backend creates the next version with `scope: "PLATFORM"` and an effective date (now unless supplied) and writes a `PLATFORM_SETTINGS_UPDATED` audit entry.

This path is versioned and audited but is **not** a maker-checker approval. The form marks fields as sensitive/maker-checker, but the backend handler writes directly for an operator with `settings:write`.

The history dialog can compare an older version with the current version. The diff is computed by flattening both JSON objects and listing added/removed/changed paths. "Load into editor" copies a version's JSON into the editor; it does not write until the operator saves.

Backup export downloads a JSON file containing the latest version per key with `exportedAt`, key/scope/version/value/effective/updated fields, and writes a `PLATFORM_SETTINGS_EXPORTED` audit entry.

Restore is preview-first:

- The operator selects a JSON file.
- The backend validates entries, computes `ADDED`/`CHANGED`/`UNCHANGED`/`INVALID` and the missing-in-backup keys, and returns the preview. Preview requires only read authority and writes a preview audit entry.
- Apply requires a reason of at least 3 characters, the restore checklist, `confirm: true`, and only sends entries that are added/changed and have a value.
- The backend rejects invalid entries before apply and checks `expectedCurrentVersion` for each setting inside a transaction. A concurrent change returns `409 SETTING_VERSION_CONFLICT`.
- Apply creates new versions and writes `PLATFORM_SETTINGS_RESTORED` with the reason and checklist.

The summary card shows keys, versions, updates in the last 24 hours, future-effective count, and per-scope counts. The summary export is a CSV-to-XLSX workbook of those metrics.

### 3.3 Checkout help settings (`/settings/checkout-help`)

Page: `admin-front/src/pages/settings/checkout-help/index.tsx`.

Endpoints:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| Current config | `GET v1/admin/settings/checkout-support` | `settings:read` |
| Version history | `GET v1/admin/settings/checkout-support/history` | `settings:read` |
| Summary | `GET v1/admin/settings/checkout-support/summary` | `settings:read` |
| Summary export | `GET v1/admin/settings/checkout-support/summary/export` | `settings:read` |
| Save config | `PUT v1/admin/settings/checkout-support` | `settings:write` |

The form edits the `checkout.support_config` platform setting:

- `enabled`.
- `show_platform_contact`, `show_merchant_contact`.
- Support phone, WhatsApp and email.
- Working hours in Arabic and English.
- A bilingual FAQ list.

Validation:

- Email must look like an email when present.
- Phone/WhatsApp digits must be 6-15 when present.
- At least one of Arabic/English question and answer must be present for an FAQ entry to be saved.
- The edit checklist is `SUPPORT_CHANNELS_VERIFIED`, `FAQ_CONTENT_REVIEWED`, `WORKING_HOURS_VERIFIED`, `PAYER_VISIBILITY_REVIEWED`.
- The page warns when there are unsaved changes and registers `beforeunload`.

Saving creates the next immutable version directly, writes `CHECKOUT_SUPPORT_UPDATED` with the before/after value, and writes `CHECKOUT_SUPPORT_EDIT_CHECKLIST` with the version and checklist keys. This is versioned and audited but not maker-checker.

The live preview shows the current working hours, platform contact block, merchant-contact explanation and FAQ entries. It does not simulate the actual payer drawer; the real drawer also includes state help, reference copy and per-rail guide.

The version history card lists all versions with effective/created timestamps. "Compare with current" flattens the selected and current JSON and lists added/removed/changed paths. "Load into editor" copies the selected version into the form; saving creates a new version.

### 3.4 Academy reporting and certification

The Academy was rebuilt on 2026-11-04 and is specified in `03-guide-and-academy.md` (§6-7). Its operational surface is the `SECURITY_ADMIN` team view and the per-user progress calls:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| Own progress | `GET/PUT v1/admin/academy/progress` | authenticated back-office user |
| Exam eligibility / start / submit | `GET .../exams/:examId/eligibility`, `POST .../start`, `POST .../submit` | authenticated back-office user (server-graded) |
| Team view | `GET v1/admin/academy/team` | `SECURITY_ADMIN` role (admin-back + core-back; audited `ACADEMY_TEAM_VIEWED`) |

The old summary/overview/export endpoints (`/progress/overview*`, `ACADEMY_SUMMARY_EXPORTED`, `ACADEMY_CERTIFICATIONS_EXPORTED`) and their export checklist were removed; the team page exports the visible rows as CSV client-side. Only `AdminAcademyTeam` is role-gated in the router; every other Academy route needs no authority.

### 3.5 Exports and checklist behavior

All spreadsheet exports use `admin-front/src/utils/xlsx/**`:

- Summary metric rows are converted with `downloadXlsxFromCsvLines`.
- Table exports use `useTableXlsx` and export the currently rendered page.
- The summary export card disables the export button until the checklist is complete.
- When `ADMIN_SHOW_CHECKLISTS` is false, the checklist is hidden and the completeness guard is treated as true.
- Export endpoints generally write audit entries with the checklist keys.

The deploy engine writes both build-time Vite values and `runtime-config.js`; runtime values take precedence. `ADMIN_SHOW_HELP_PANELS` controls the inline KYB/approvals/merchants help panels, not these exports.

### 3.6 Authority gating summary

| Surface | UI route gate | Backend read | Backend write |
| :--- | :--- | :--- | :--- |
| Backups | `security:read` or `gateway:read` | `security:read`/`gateway:read` | `security:write` |
| Platform settings | none | `settings:read` | `settings:write` |
| Checkout help | none | `settings:read` | `settings:write` |
| Academy pages | none (Team: role `SECURITY_ADMIN`) | self: authenticated; team: `SECURITY_ADMIN` | self: authenticated |
| Approvals | `approvals.approve`/`reject` | approval authority | `approval:check` and checker separation |

The UI hides write controls where it knows the authority. The backend remains authoritative.

## 4. Contracts and invariants

1. **Platform settings are append-only versions.** A save never mutates an existing row; the next version is `latest + 1`.
2. **The effective version is the highest version whose effective date has passed.** Future-effective versions remain visible but are not yet effective.
3. **Restore must preview first.** Apply requires explicit confirmation, a reason, the checklist, and matching `expectedCurrentVersion` values.
4. **Invalid restore entries block apply.** The UI and backend both refuse to apply when `invalid > 0`.
5. **Backup policy is maker-checker.** The maker submits; a different checker executes through approvals.
6. **Backup trigger/drill are immediate writes under `security:write`.** They are not maker-checker approvals.
7. **Checkout support save creates a new version and audit entries.** It is not a maker-checker execution.
8. **The Academy team view requires the `SECURITY_ADMIN` role and writes an audit entry; exam grading is server-side.**
9. **All spreadsheet exports use the shared XLSX pipeline.**
10. **Runtime visibility flags override build-time flags.**

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Backup page | `admin-front/src/pages/system/backups/index.tsx` |
| Platform settings page | `admin-front/src/pages/settings/platform/index.tsx` |
| Checkout help page | `admin-front/src/pages/settings/checkout-help/index.tsx` |
| Academy pages | `admin-front/src/pages/academy/*.tsx` |
| URL map | `admin-front/src/constants/urlsMap/index.ts` |
| XLSX pipeline | `admin-front/src/utils/xlsx/**` |
| Summary/checklist primitives | `admin-front/src/components/ui/SummaryExportCard.tsx`, `FormChecklist.tsx` |
| Deploy flags | `ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`, `ADMIN_SHOW_HELP_PANELS` |
| Backup config | deploy `FAKE_RAILS_*` is unrelated; backup daemon config is in the deploy/backup parts |

## 6. Operational usage

- Review backups: start with WAL lag, daemon reachability, target health and the latest drill. A failed/absent drill is not a healthy backup posture.
- Trigger a backup: choose a target and kind; `delta` is not a substitute for a full restore point.
- Change backup policy: submit the form, then have a different checker execute the pending approval. The backup page will not execute it directly.
- Change a platform setting: edit the JSON object, record the checklist, and save; verify the new version and effective date. Treat the form's maker-checker hint as advisory only.
- Restore settings: preview, inspect invalid/missing/version conflicts, then apply with a real reason. Do not retry a version conflict without re-previewing.
- Change checkout support: ensure contact channels and FAQ content are valid in both languages, preview the result, and save. This changes payer-visible help immediately for new fetches.
- Academy team view not visible: it needs the `SECURITY_ADMIN` role.

## 7. Status and deviations

### Implemented

- Backup health, WAL lag, targets, backup history, drill verification, trigger, drill and policy UI.
- Backup policy maker-checker execution through the approvals queue.
- Platform settings list, version history, diff, backup export, restore preview/apply, summary and summary export.
- Checkout support config, live preview, version history, diff, summary and summary export.
- Academy team view (CSV export of the visible rows).
- Shared XLSX and checklist behavior.

### Partial

- The backup page does not hand the operator into the specific pending approval after a policy save.
- `BACKUP_POLICY` is missing from the shared approvals subject-type filter options, even though the backend supports it.
- Platform settings and checkout support are versioned/audited but not maker-checker.
- The route-level UI gates for platform settings and checkout help are absent (the Academy team route is role-gated).
- Academy labs are browser-graded practice; certification is decided only by server-graded exams.

### Missing / deferred

- No immutable certificate registry or re-certification cycle.
- No backup catalog browser beyond the latest-30 history.
- No direct restore-from-backup UI; only restore drills.
- No schedule editor validation preview for cron syntax beyond the five-field check.

### Known bugs / risks

- **Workflow gap:** a backup policy maker cannot continue directly to approval; the pending request must be found in the general approvals queue.
- **Filter gap:** the approvals subject filter cannot select `BACKUP_POLICY`.
- **Governance gap:** `sensitiveMakerChecker` hints on platform settings/checkout help fields do not produce a maker-checker approval.
- **Authorization risk:** direct navigation to settings/checkout help is not blocked by the router; the page loads and then fails backend calls for unauthorized users.
- **Export scope risk:** table exports are current-page only; do not treat them as full-result exports.
- **Documentation gap:** historical design claims about weekly drills/hourly Redis/ready-to-run backup certificates are superseded by the storage/backup parts.

## 8. Verification and tests

- `tests/e2e/admin/backups.spec.ts` mocks the backup overview and verifies the rendered health/schedule/drill state and the trigger request payload.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` covers backup route authority, trigger/drill/policy behavior and audit entries.
- `tests/unit/academy-content.test.ts` covers the Academy content counts.
- The XLSX pipeline has no dedicated unit test in this repository; coverage is through page-level usage and the shared UI compliance test.

The backup E2E suite requires the live stack; the core backup test requires PostgreSQL/Redis.

## 9. Source references

### Old design sections

- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` — backup/restore/drill intent and corrected as-built notes.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — admin operations/guide placement.
- `design/06-ui/portal_ui_implementation_plan.md` — settings, backups and export rollout.

### Code paths

- `admin-front/src/pages/system/backups/index.tsx`
- `admin-front/src/pages/settings/platform/index.tsx`
- `admin-front/src/pages/settings/checkout-help/index.tsx`
- `admin-front/src/pages/academy/*.tsx`
- `admin-front/src/utils/xlsx/**`
- `admin-front/src/components/ui/SummaryExportCard.tsx`
- `admin-front/src/components/ui/FormChecklist.tsx`
- `core-back/api/internal/backups.ts`
- `core-back/api/internal/admin.ts` (settings handlers), `core-back/api/internal/academy.ts`
- `core-back/lib/approvalQueue.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical operations part. Records backup/target/drill/policy behavior, settings versioning/restore, checkout-support history/diff, academy reporting, export/checklist behavior, and the authority/workflow gaps.

## Security hardening (2026-11-05)

Backups page: actions are disabled unless backups are configured and the daemon is reachable; a full backup of all targets needs an extra confirmation; trigger and drill send an `Idempotency-Key` header (required by admin-back); policy form validation mirrors the edge rules (cron, minimum gaps, retention floors); server error text is sanitized and clipped.
