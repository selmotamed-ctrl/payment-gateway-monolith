---
id: admin-ui.system
title: Admin UI System
status: partial
confidence: high
last_verified: 2026-11-27
verified_against: working-tree
code:
  - packages/ui/src/**
  - packages/ui/src/tokens/**
  - packages/ui/test/**
  - packages/ui/CATALOG.md
  - package.json
  - AGENTS.md
  - scripts/ui-full-sweep-audit.ts
  - scripts/generate-ui-icons.ts
  - scripts/migrate-to-pg-ui.ts
  - admin-front/vite.config.ts
  - admin-front/tsconfig.app.json
  - admin-front/src/main.ts
  - admin-front/src/App.tsx
  - admin-front/src/uiConfig.tsx
  - admin-front/src/layouts/**
  - admin-front/src/features/**
  - admin-front/src/forms/**
  - admin-front/src/tables/**
  - admin-front/src/printables/**
  - admin-front/src/components/**
  - admin-front/src/utils/**
  - admin-front/src/state/**
  - admin-front/src/components/AuditChangeChips.tsx
  - admin-front/src/components/CollapsibleSection/**
  - merchant-front/src/main.ts
  - merchant-front/src/App.tsx
  - merchant-front/src/uiConfig.tsx
  - merchant-front/src/layouts/**
  - merchant-front/src/features/**
  - merchant-front/src/forms/**
  - merchant-front/src/tables/**
  - merchant-front/src/components/**
  - checkout-front/src/main.ts
  - checkout-front/src/App.tsx
  - checkout-front/src/uiConfig.tsx
  - checkout-front/src/layouts/**
  - checkout-front/src/features/**
  - checkout-front/src/tables/**
  - checkout-front/src/components/**
  - fake-rails-front/src/main.ts
  - fake-rails-front/src/App.tsx
  - fake-rails-front/src/uiConfig.tsx
  - fake-rails-front/src/layouts/**
  - fake-rails-front/src/tables/**
  - fake-rails-front/src/components/**
  - merchant-front/src/components/**
  - checkout-front/src/components/**
  - fake-rails-front/src/components/**
design_sources:
  - design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md
  - design/06-ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md
  - design/06-ui/portal_ui_implementation_plan.md
  - design/06-ui/fintech_2026_vapor_ui_architecture_and_remediation_plan.md
  - design/06-ui/pg_ui_complete_component_blueprint_and_revision_plan.md
tests:
  - packages/ui/test/core.test.ts
  - packages/ui/test/toastStore.test.ts
  - packages/ui/test/governanceAudit.test.ts
  - scripts/ui-full-sweep-audit.ts
  - tests/e2e/admin/shell.spec.ts
  - tests/e2e/admin/table-and-padding-geometry.spec.ts
  - tests/e2e/admin/table-row-context-menu.spec.ts
  - tests/e2e/admin/a11y.spec.ts
  - tests/e2e/merchant/shell.spec.ts
  - tests/e2e/checkout/pay.spec.ts
  - tests/unit/frontend-security-admin.test.ts
  - tests/unit/json-diff-model.test.ts
  - tests/unit/audit-summary.test.ts
  - tests/unit/dark-overlay-colors.test.ts
  - tests/unit/report-ui-styles.test.ts
gaps:
  - GAP-084: PgAutocomplete/PgDateInput/PgMenu/PgTooltip/PgDialog/PgDrawer use fixed-position inline panels instead of Vue Teleport because Vue 3.6.0-rc.16 Teleport does not mount inside the Vapor dc render path; revisit when the runtime fixes it.
  - GAP-085: DataTable/DataPage/InputFields/FiltersContainer/AuthoritiesPicker/ApiImage/CordsInputMap/Printables remain per-portal feature composites under src/{tables,forms,features,printables}; they are not UI primitives but still share code by copy.
  - GAP-086: @pg/ui is consumed through Vite/TS aliases and each portal keeps its own Bun lockfile, not a hoisted root workspace; this was chosen to avoid disturbing the four independent frontend installs.
---

> **Historical note.** Sections 1-18 below describe the pre-2026-11-27 vael-ui compatibility shim and the
> components that used it. They are retained for history. Section 19 is the current architecture: every
> primitive and token lives in `packages/ui` (`@pg/ui`), and the shim, local primitive directories and drifted
> stylesheets are deleted.

# Admin UI System

## 1. Purpose and scope

> **Historical baseline (superseded 2026-11-27):** sections 1-18 record the Vuetify-era and vael-ui-shim iterations. The current implementation is §19: one `@pg/ui` package, no compatibility shim. References to Vuetify files, per-portal theme configuration, `components/vael/VuetifyShim.tsx`, `fintech-minimal.css`, `vael-shim.css` and `vael-theme.css` describe that history; those files no longer exist.

This part owns the design system and shell used by `admin-front`: visual tokens, self-hosted fonts, vael-ui provider and `--pg-*` theme bridge, the 13 required UI primitives and their extras, the 248 px navigation drawer and 56 px app bar, the split-screen authentication layout, and the cross-workspace rollout rules.

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

The pre-migration baseline used `admin-front/src/plugins/vuetify.ts` for Vuetify configuration; the current implementation uses `components/vael/VaelProvider.tsx` plus `styles/vael-theme.css`.

- Light theme: background `#F8FAFC`, surface `#FFFFFF`, primary `#0F172A`, secondary/accent/info `#2563EB`, success `#16A34A`, warning `#D97706`, error `#DC2626`.
- Dark theme: background `#09090B`, surface `#121215`, primary `#F8FAFC`, secondary/accent/info `#3B82F6`, success `#22C55E`, warning `#F59E0B`, error `#EF4444`.
- Locale: Arabic is RTL, English is LTR; fallback is English; the adapter is `adaptedLocale`.
- Icons: MDI default set plus the custom `i` set and aliases from `src/utils/iconSet`.
- Global defaults: ripple off.
- Component defaults: flat cards with `rounded: "lg"`; 36 px, `rounded: "md"`, no-transform buttons; outlined compact text fields/selects/autocompletes/textareas/comboboxes with `hideDetails: "auto"`; small rounded chips; a `rgba(15, 23, 42, 0.45)` dialog scrim.
- `VDateInput` receives an outlined default through the blueprint defaults block.

Theme mode is `system | light | dark`. `utils/theme` resolves the persisted mode (localStorage `theme`; absent means `system`) against `prefers-color-scheme`; `state/theme` applies it to Vuetify, listens to `matchMedia` changes while in `system` mode, and syncs across tabs. `plugins/vuetify.ts` uses `initialTheme()` for `defaultTheme` and `main.ts` calls `initTheme()` before mount, so every route (including the login page) starts in the operating-system theme with no light flash. `ThemeMenu` is the explicit three-option menu (System, Light, Dark) used by the shell, the auth layout and the merchant landing header; the old `toggleTheme` remains as a compatibility cycle (system -> light -> dark).

### 3.4 Primitives and extras

`packages/ui/src/index.ts` is the primitive barrel. The compliance test requires these 13 named exports:

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
- A 248 px `PgNavigationDrawer`, permanent on desktop and temporary below the compact breakpoint. It contains the brand lockup (28 px mark, one-line 13.5 px wordmark with ellipsis, and a meta row with the "Admin Back Office" subtitle plus a small `LAN` environment badge), guide search pill (`Ctrl+Shift+K`/`Cmd+Shift+K`), collapsible navigation sections, and an operator card with role and maker/checker dots. The badge sits on the meta row rather than beside the wordmark so the title never has to compete for the remaining width.
- Route progress bar, focused `VMain`, global search palette (`Ctrl+K` on every route, including the guide), guide search modal (`Ctrl+Shift+K` on every route), and contextual help drawer.
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
| vael-ui provider | `packages/ui/src/provider/PgProvider.tsx`, `packages/ui/src/provider/PgProvider.tsx`, `packages/ui/src/provider/PgProvider.tsx` |
| Tokens | `*/src/styles/fintech-minimal.css` |
| Global styles | `*/src/styles/globals/app.scss`, `admin-front/src/styles/command-palette.css` |
| Fonts | `*/src/assets/fonts/fonts.css` and the adjacent font files |
| Primitives | `packages/ui/src/**` |
| Tables | `*/src/components/Table/**` |
| Shells | `admin-front/src/layouts/default.tsx`, `merchant-front/src/layouts/default.tsx`, `checkout-front/src/layouts/checkout.tsx` |
| Auth layout | `admin-front/src/layouts/auth.tsx` |
| Compliance test | `packages/ui/test/governanceAudit.test.ts` |
| Deploy flags | `ADMIN_SHOW_CHECKLISTS`, `ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST`, `ADMIN_SHOW_HELP_PANELS`, `FAKE_RAILS_ENABLED`, `FAKE_RAILS_ALLOW_IN_PRODUCTION` |

## 6. Operational usage

- Adding a page: use `ScreenContainer`, `PageHeader`, and the relevant primitives; add a table config only if the page uses the shared table server mode; add a route and navigation entry separately.
- Adding a status: use `StatusBadge` and keep the tone mapping centralized.
- Rendering money: use `MoneyDisplay`/`MoneyText` or decimal-backed utilities; never format money with floating point.
- Adding a drawer/modal: use `SlideOverDrawer`/`FormModal` so focus, padding, and footer behavior stay consistent.
- Totals rows go in a `<tfoot>` of a `.pg-unified-table`/`.pg-table-card` table: the shared stylesheet gives them the body-row padding, edge insets and a top rule (before 2026-11-07 a `tfoot` had no padding and its label touched the table border).
- Changing the theme: edit `styles/vael-theme.css` / `state/theme.ts` and the `--pg-*` tokens together; do not add page-local hard-coded palettes.
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

- `packages/ui/src/provider/PgProvider.tsx`
- `admin-front/src/styles/fintech-minimal.css`
- `admin-front/src/styles/globals/app.scss`
- `admin-front/src/assets/fonts/fonts.css`
- `admin-front/src/layouts/default.tsx`
- `admin-front/src/layouts/auth.tsx`
- `admin-front/src/layouts/sections.tsx`
- `packages/ui/src/index.ts`
- `packages/ui/test/governanceAudit.test.ts`
- `admin-front/src/constants/env/index.ts`
- `deploy/deploy.ts`
- `packages/ui/src/**`

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
- **Builders** (`components/builders/**`, each with a pure model under `builders/model/` and unit tests): `CostModelBuilder` (+`formatCostModel`: `1.25% + 0.500 LYD (min…, max…)`), `RouteScopeBuilder` + `MismatchPolicyBuilder` (`tolerance_amount`, the only key the settlement engine reads), `MaintenanceWindowsBuilder` (absolute UTC `start`/`end`; a route is hidden while `start <= now < end`), `ParserConfigBuilder`/`ColumnMappingBadges` (statement sources), `AmlParamsBuilder`/summaries (7 rule types; `scope` is edited as a structured tree and the UI states that the engine does not evaluate it), `PlatformSettingTypedEditor` + `SettingValueView` (typed editors for the decision register OD-1..OD-11 and the policy keys; unknown keys fall back to a structured tree editor that preserves them), `LogoAssetPicker`, `ChipListInput`, `OptionChips`, `RepeatableRows`, `KeyValueSummary`, `StructuredValueEditor`. Every builder round-trips unknown keys losslessly. The Platform Settings workspace (`pages/settings/platform/**`) adds a pure catalog/search model (`builders/model/settingsCatalog.ts`, `settingsSearch.ts`): sections, lifecycle/status badges, reader/effect/risk metadata, effective/scheduled version selection, unconfigured and unregistered states, Arabic-aware search and a compact row + detail drawer. Every catalog field has a hint; unknown keys are shown as unregistered instead of being silently treated as understood.
- **Commission tiers:** `CommissionTiersEditor` (`pages/finance/pricing/components`) edits `{ upTo, flat, percent }` (percent is a fraction) and is shown for TIERED only (the calculator ignores tiers for FLAT/PERCENTAGE/HYBRID). The create form also carries min/max fee, fee bearer, rounding mode and optional merchant/application scope.
- **Shared drawers** (`components/ledger/JournalEntryDrawer`, `GlAccountDrawer`; `pages/merchants/components/WalletDetailDrawer`, `ApplicationDetailDrawer`) are opened by an id prop (`null` = closed) and emit `close`/`changed`. Governed actions share `ReasonModal` (>=10 characters) and a 202 handler that explains "submitted for approval" and links to `/approvals`.
- **i18n slices:** `constants/i18n/{commerce,ledgerOps,forms,builders}.ts` are merged by `plugins/i18n.ts` after the main catalogue; each new string has an `[English, Arabic]` pair and unit tests assert EN/AR sync. Table filter configs live in `components/Table/registry/{commerce,ledgerOps,forms}.ts` and are spread into `tableRegistry`.
- Compliance gate (`components/ui/__tests__/ui-abstraction-compliance.test.ts`): every standard route page uses `PageHeader` (helper components belong in `components/` subfolders), no raw `VCard`/`VDialog`/`VChip`.

## Remediation round 2 (2026-11-08): bundle size and translation gate

- **Lazy heavy chunks (GAP-060).** `utils/xlsx` is a lazy facade (the exceljs/xlsx chunk loads on the first export click) and charts load through `components/EChart/lazy.tsx` (`defineAsyncComponent`); `tests/unit/admin-bundle-lazy.test.ts` fails if the dashboard, profitability page, gateway health drawer or table header import the heavy libraries statically.
- **Translation gate (GAP-061).** `tests/unit/i18n-catalogue.test.ts` (scanner `tests/unit/helpers/i18nScan.ts`) fails on a literal `t()` key with no catalogue entry that is not in the shrink-only baselines `tests/unit/fixtures/i18n-missing-*.json`, and on a key whose Arabic value conflicts across catalogue files (the last spread silently won). The 18 conflicts were resolved; the existing missing keys stay in the baselines and are filled over time (`UPDATE_I18N_BASELINE=1` rewrites a baseline after a fix).

## Dark teleported overlays (2026-11-10)

Vuetify teleports dialogs, menus and drawers under a `.v-overlay__content` / `.v-navigation-drawer` element that receives the theme class and CSS variables but not a base text color. Custom surface components (`FormModal`, `SlideOverDrawer`, SafeguardDialog, the guide search surface, and any raw dialog content) therefore inherited the body's black text while sitting on the dark surface. `fintech-minimal.css` now sets `color: rgb(var(--v-theme-on-surface))` on `.v-overlay__content` and `.v-navigation-drawer__content`; component-specific text colors and status tones still override it. The same rule is mirrored in the merchant, checkout and Fake Rails portals, and `tests/unit/dark-overlay-colors.test.ts` guards all four stylesheets.

## Object & Asset Storage page

`/system/object-storage` (`pages/system/object-storage/index.tsx`) uses the shared
`ScreenContainer`, `PageHeader`, `MetricStrip`, `SegmentedTabs`, `SurfaceCard`,
`ApiTable` (with the built-in `TableFilters` toolbar), `TableRowActions`,
`SlideOverDrawer`, `DescriptionList` and `FormModal` primitives. The root uses
the standard 18 px section gap, the table cards are the `ApiTable` surfaces
(no nested `SurfaceCard`), and the page-header end slot carries the object,
quarantine and legal-hold summary badges beside Refresh. It has four tabs:
cluster/daemon health with maintenance jobs in a titled `SurfaceCard` and the
result in the shared `.pg-code-block`; object explorer with active locks;
quarantine/AV queue; and the access audit trail. Authority-gated actions:
`system:storage:read` (view), `system:storage:admin`
(maintenance/rewrap/GC/scrub/AV scan), `system:storage:legal-hold`
(place/lift hold with a written reason).

## 18. vael-ui Vapor migration (2026-11-26)

The four portals now run on the **vael-ui Vapor** UI layer. The branch `vael-ui-migration` starts from the `vapor-migration` TSX/Vapor baseline and replaces Vuetify end to end:

- **Runtime:** `vue@3.6.0-rc.16`, `vue-jsx@3.3.0-rc.7` (`vapor: true`), Vue Router `5.5.2` (Vapor router), `vael-ui@0.5.8` (imports only from `vael-ui/vapor`), `vael-form@0.0.3` and `@mdi/js@7.4.47`. `vuetify`, `vite-plugin-vuetify`, `@mdi/font` and `vue-echarts` are removed from every workspace; `vaporInteropPlugin` is no longer installed.
- **Provider:** each portal mounts `components/vael/VaelProvider.tsx` → `ConfigProvider` with the `--pg-*` theme bridge, `locale`, and the `Toaster`, `TooltipHost`, `DialogHost` and `PopoverHost` hosts.
- **Compatibility layer:** `components/vael/VuetifyShim.tsx` exports the Vuetify component names used by the existing pages (`VBtn`, `VTextField`, `VSelect`, `VAlert`, `VTable` shells, `VApp`, `VNavigationDrawer`, …) and renders vael-ui Vapor primitives. This is the strangler seam: a page can keep its JSX names while the implementation and dependency graph are vael-ui. Renaming the remaining shim tags to vael-ui names is a follow-up cleanup, not a runtime dependency.
- **Icons:** `scripts/generate-frontend-icons.ts` scans the source for `mdi-*` names and generates a per-portal `AppIcon/icons.generated.ts` from `@mdi/js` (238 admin, 138 merchant, 52 checkout, 35 Fake Rails). `AppIcon` renders inline SVG and supports RTL `directional` glyphs. The MDI webfont is gone.
- **Charts:** `components/EChart/index.tsx` owns an ECharts instance from a Vapor DOM ref (`echarts.init`, `setOption`, `ResizeObserver`, `dispose`); `EChart/lazy.tsx` preserves the lazy 600 kB chunk. `vue-echarts` is gone.
- **Composables:** `utils/vael-compat.ts` provides `useLocale` (vue-i18n singleton), `useDisplay` (matchMedia breakpoints), `useTheme` (the `--pg-*` palette) and `useRtl`; `utils/vuetify-compat.ts` is a re-export for the existing imports.
- **CSS:** `styles/vael-theme.css` maps `--pg-*` onto `--ui-*`; `styles/vael-shim.css` supplies the grid shell, drawer/table/list surfaces and compact native-control fallbacks; `[data-theme="dark"]` replaces `.v-theme--dark` and `state/theme` sets both the root attribute and the `.v-application` compatibility class.
- **Forms:** login is fully on `vael-form` (`useForm` + `validator`, `Field`, `Input`, `PasswordInput`, `OtpInput`, `Button`, `Message`). `FormField` and `FormModal` remain the primitives used by the rest of the portal; they render vael-ui `Field`/`Dialog`. The remaining page/modal forms still use their existing `rules` maps through the shim inputs. Converting every form to `useForm`/`Field` is the remaining form workstream (see GAP-2026-11-26-UI-01).
- **Verification:** admin Playwright 79 passed / 11 live skips, merchant 22 passed, checkout 7 passed; all four portals type-check and build; admin Vitest 48 and merchant content 23 pass. The admin suite covers shell geometry, RTL, themes, tables, inline filters, row context menus, wallet/GL drawers, approvals/safeguard checklists, guide context/reader, object storage and backups.

Known residuals: the shim tag names still read as Vuetify in JSX; all forms are not yet on `vael-form`; and the native `select`/checkbox fallbacks trade vael-ui search/motion for deterministic form behavior while the field adapters are completed. These are tracked as `GAP-2026-11-26-UI-01` and `GAP-2026-11-26-UI-02`.

### 18.1 Master integration (2026-11-26)

`master` (email-primary communication, email/Google merchant auth, the human-readable Platform Settings workspace, and the Applications & Channels API-token surface) was merged into `vael-ui-migration` and every new surface was migrated to the vael/Vapor layer rather than reintroducing Vuetify:

- **New pages/components:** the admin settings workspace (`pages/settings/platform/components/{CommunicationTab,NewSettingDrawer,SettingDetailDrawer,SettingRow,SettingsHealthStrip,SettingsSectionNav}.tsx`), admin forgot/reset-password pages, merchant forgot/reset-password, verify-email, Google-finish and `components/communication/MaintenanceScreen.tsx` now import `dc`/`defineComponent` from `@/utils/dc`, Vuetify-named components from `@/components/vael/VuetifyShim`, and `useLocale` from `@/utils/vael-compat`. No `vuetify` or `kt-dc` import remains in any portal.
- **PageHeader slot:** the master `end={() => …}` prop is expressed as the vael `PageHeader` default slot; the removed `PageHeader.end` prop is not reintroduced.
- **Shim `VTextField`:** now uses `inheritAttrs: false`, binds only real input attributes, keeps an explicit `aria-label` (falling back to `label`) so field names remain accessible, and renders a visible label/hint/error shell (`.pg-text-field`, `.pg-field-label`, `.pg-field-hint`) when those props are present. This restores labels on the new settings workspace and auth pages while `FormField` keeps owning labels in existing forms. The shim `VSwitch` keeps vael-ui's `role="switch"`; Playwright tests target `getByRole("switch")`.
- **Shim link resolution:** `VBtn`/`VListItem` resolve `to` through `useRouter()`, falling back to the app router on the current instance when the component is created inside a drawer slot. Before this fix, a `VBtn to=…` rendered inside `SlideOverDrawer`'s `v-slots` silently dropped its link (a `TypeError` was swallowed by the slot render).
- **Theme bridge:** `styles/vael-theme.css` now also defines the Vuetify-style RGB triplets (`--v-theme-primary`, `--v-theme-on-surface`, `--v-theme-background`, …) inherited styles still reference (`rgb(var(--v-theme-primary))`), in light and dark. Native `<option>` elements from the shim `VSelect` are visible to `getByText`, so tests scope environment text to the table.
- **ECharts lazy chunk:** `merchant-front/src/charts/EChart/lazy.tsx` was added (the merchant cards imported `@/components/EChart/lazy` without the module).
- **Icons:** the generator now emits 244 admin icons (the new settings/section/auth `mdi-*` names) while merchant/checkout/Fake Rails stay at 138/52/35.

## 19. 2026 Fintech Vapor design system (`@pg/ui`) — 2026-11-27

The plan `design/06-ui/fintech_2026_vapor_ui_architecture_and_remediation_plan.md` was implemented as a shared
package plus a migration sweep. The previous `vael-ui-migration` branch kept four copies of a compatibility shim and
still rendered native `<select>`, `<input type="date">`, `<input type="checkbox">`, raw text fields and a dead
snackbar. That is now replaced by one source of truth.

### 19.1 Architecture

- **Package:** `packages/ui` (`@pg/ui`), a 100% Vue 3.6 Vapor TSX package. It is consumed through the
  `@pg/ui` Vite alias (`../packages/ui/src`) and the matching `tsconfig` paths in all four portals, so every
  portal compiles the same source with `vueJsx({ vapor: true })`; there is no duplicate build artifact.
- **Provider:** `PgProvider` supplies `PgUiConfig` (API client, error extractor, XLSX exporter, confirm dialog,
  router resolve/navigate, clipboard, admin contextual-help button) and mounts the one `PgToaster`. It wraps
  vael-ui's `ConfigProvider` only for the checkbox/switch/radio/file controls that remain vael-based; vael-ui is
  never imported by page code.
- **Tokens:** `tokens/fintech-2026.css` (the exact "Calm Precision" palette: neutral obsidian focus ring, 40 px
  controls, 2026 radii/shadows/status tokens, dark theme, `--ui-*` bridge), `tokens/layout-policy.css`
  (28/36 px desktop and 20/16 px mobile page padding, 1480 px max width, 28 px section rhythm, 24 px card body,
  20/24 header, 16/24 footer, 48 px table rows, 42 px sticky header, seamless metric grid) and
  `tokens/components.css` (all primitives plus the inherited pre-migration layout classes).
- **Primitives:** `PgPage`, `PgSection`, `PgCard`, `PgPageHeader`, `PgButton`, `PgIcon`, `PgTextField`,
  `PgTextarea`, `PgSearchInput`, `PgAutocomplete`, `PgApiAutocomplete`, `PgDateInput`, `PgDateRangeInput`,
  `PgCheckbox`, `PgChoice`, `PgSwitch`, `PgRadioGroup`, `PgFileUpload`, `PgOtpInput`, `PgCodeEditor`,
  `PgAlert`, `PgToast`, `PgStatusBadge`, `PgEmptyState`, `PgStateView`, `PgDialog`, `PgDrawer`,
  `PgFormModal`, `PgConfirmDialog`, `PgDetailsDialog`, `PgCommandPalette`, `PgMenu`, `PgTooltip`,
  `PgMetricStrip`, `PgMoneyText`, `PgMonoRef`, `PgDescriptionList`, `PgField`, `PgFieldsSection`,
  `PgTable`, `PgApiTable`, `PgTableFilters`, `PgTableRowActions`, `PgTableHeader`, `PgTableFooter`,
  `PgFormChecklist`, `PgSummaryExportCard`, `PgThemeMenu`, `PgThemeLanguageControls`, `PgSegmentedTabs`
  and the JSON diff/viewer set. `packages/ui/CATALOG.md` lists props and usage.
- **Icons:** `scripts/generate-ui-icons.ts` scans the package and all four portals for `mdi-*` names and writes
  one `actions/icons.generated.ts`. The old per-portal `AppIcon` directories are deleted.

### 19.2 Defect fixes from the plan

1. **Dropdowns/autocomplete:** `PgAutocomplete` is a WAI-ARIA combobox with single/multi select, removable chips,
   `+N` overflow, `creatable`, full keyboard navigation, fixed-position viewport-flipping panel and no native
   `<select>` anywhere. `VSelect`, `VAutocomplete` and `VCombobox` are aliases of the same component.
2. **Date input:** `PgDateInput` has a typed `YYYY-MM-DD` field, calendar grid, month/year jump, today ring,
   min/max, clear, and a range mode with `Today`, `Last 7 Days`, `Last 30 Days`, `This Month`, `Last Month` and
   `Year to Date` presets.
3. **Checkbox:** `PgCheckbox` uses the shared animated control with `indeterminate` and a `variant="card"`
   safeguard row; `PgChoice` wraps the native radio/checkbox for exam/lab/safeguard cards, so no page writes a
   raw checkbox input.
4. **Text fields/table search:** `PgTextField`/`PgSearchInput` restore label, hint, error, icons, prefix/suffix,
   clear, password reveal, max-length counter and rules. Focus is one 2 px monochrome outline
   (`#0f172a` light / `#e4e4e7` dark, danger for errors) with no blue ring, inner outline or grey halo.
   `PgSearchInput` is the table/toolbar search.
5. **Snackbar:** the broken shim snackbar is deleted. `showToast` has a guaranteed 4.5 s / 6.5 s timer, a 2 px
   countdown bar, pause-on-hover/focus, a four-toast stack cap, an action button and a close button.
6. **Alerts:** one `PgAlert` with `tone` mapped 1:1 to `--pg-status-*` replaces `SandboxBanner`, `AlertView`,
   `VAlert` and every hand-styled `role="alert"` banner.
7. **KPI strips:** `PgMetricStrip` is one rounded, overflow-hidden parent surface. A 1 px grid gap over the
   `--pg-border-subtle` parent paints the internal separators; child cells are square, borderless, shadowless and
   have their legacy negative seam margins reset. The strip wraps 5→2→1 without a grey dead cell.
   `PageStats`/`MiniStats` remain aliases and the transparent-text hack is gone.
8. **Dialogs and command palette:** `PgDialog` uses a strict three-row header/body/footer; the close button is a
   flex-end header item, never absolute, so it cannot overlap a title, input or badge. The `bare` prop removes the
   dialog surface and body padding so a command palette can be the only card. `PgCommandPalette` has a bare 56 px
   search header and padded results.
9. **Duplication:** the four `VuetifyShim`/`VaelProvider` copies, the 48 duplicated primitive directories and the
   four drifted `fintech-minimal.css`/`vael-shim.css`/`vael-theme.css` sets are deleted. Feature-only composites
   moved to `src/features`, `src/forms`, `src/tables` and `src/printables` (the ECharts wrapper now lives in
   `packages/ui`).

### 19.3 Migration and governance

- `scripts/migrate-to-pg-ui.ts` rewrote 461 files: shim imports and `V*` tags became `Pg*`, pure local component
  imports became `@pg/ui`, and the feature folders moved out of `src/components`.
- The four apps import `@pg/ui/tokens/index.css` once in `main.ts`; `App.tsx` mounts `PgProvider` with a small
  `src/uiConfig.tsx` host object. `utils/vael-compat.ts`, `utils/vuetify-compat.ts` and `state/theme.ts` are
  re-exports of the package services, so existing page imports keep working.
- **Gate:** `scripts/ui-full-sweep-audit.ts` runs the pure rules in
  `packages/ui/src/testing/governanceAudit.ts`: UI-01 raw `<select>`, UI-02 date inputs, UI-03 raw checkbox,
  UI-04 raw input/textarea, UI-05 VuetifyShim/vael-ui imports, UI-06 hardcoded page hex, UI-07 container padding
  (only `PgPage`/`PgCard`/`PgDialog`/`PgDrawer`/`PgSection`/`SurfaceCard`/`PgFormModal`), UI-08 hand-styled
  `role="alert"`, UI-09 transparent text fill, UI-10 duplicated primitive directories and UI-11 legacy
  stylesheets. The current tree passes with **0 violations**. The UI-07 scope is the plan's stated policy: table
  cells, chips and compact rows keep their own metric; pages may not override a layout container's padding.
- `bun run ui:audit`, `bun run ui:test`, `bun run ui:typecheck` and `bun run ui:icons:check` are the frontend
  gates; the policy is appended to the root `AGENTS.md`.

### 19.4 Verification and deviations

- All four portals type-check and build; `packages/ui` type-checks and its 428 unit tests pass; the root Vitest
  suite is 564 passing. Admin Playwright is 102 passed / 11 live skips, merchant + checkout 31 passed.
- Browser smoke (cached Chromium against `vite preview`/`vite dev` with mocked APIs): admin login, dashboard,
  sidebar, KPI strip, checklist, currency autocomplete (open/select), user menu and toast; no page errors and no
  console errors. The login page renders `PgTextField`/`PgButton`/`PgOtpInput` with zero native selects.
- **Deviation — Teleport:** Vue `Teleport` does not mount inside the `dc` Vapor render path on this rc, so
  `PgAutocomplete`, `PgDateInput`, `PgMenu`, `PgTooltip`, `PgDialog`, `PgDrawer` and `PgCommandPalette` use
  `position: fixed` panels with viewport flip/clamping. They are not clipped by `overflow: hidden` because no
  ancestor establishes a containing block; revisit when the runtime supports Teleport here (GAP-084).
- **Deviation — Vapor dynamic branches:** the rc's manual `DynamicFragment` + `renderEffect` path leaves
  `currentInstance` null while patching DOM props, so a re-render crashes on `hasFallthrough`. The package and
  the four app `dc` helpers therefore stay on the normal Vapor path, and branch components (`PgDialog`,
  `PgDrawer`, `PgCommandPalette`, `PgStateView`, the merchant/KYB/join detail pages) use the runtime's
  `createIf` for reactive loading/error/content switches. `PgMoneyText`, `PgMonoRef`, `PgDescriptionList`,
  `PgFieldsSection` and `PgIcon` render one always-present surface instead of a top-level early return.
- **Deviation — workspace:** `@pg/ui` is consumed by Vite/TS aliases rather than a hoisted Bun workspace so the
  four independent portal lockfiles and installs are untouched (GAP-086). The single-source guarantee is the
  alias, the package barrel and the governance gate, not a root install.
- **Residual:** feature-level `DataTable`, `DataPage`, `InputFields`, `FiltersContainer`, `AuthoritiesPicker`,
  `ApiImage`, `CordsInputMap` and `Printables` remain per-portal composites under
  `src/{tables,forms,features,printables}`. They are data-connected feature code, not duplicated primitives,
  but they still copy some logic (GAP-085).

### 19.5 Follow-up interaction and layout pass — 2026-11-27

The first implementation review produced a concrete polish list; every item is implemented at the shared layer,
not patched per page.

- **Buttons:** `tonal` is now a quiet outlined utility action (surface background, 1 px border) so Refresh, Export
  Excel/Summary, Copy summary and the other page utilities are never filled. Hover adds the surface-hover tone and
  `--pg-shadow-xs`; press is a 1 px settle (`translateY(1px)`), not a scale transform, so the label never appears to
  shrink. Only `primary` and `danger` remain filled. Documented in `packages/ui/CATALOG.md` and enforced by
  `tests/unit/ui-2026-polish.test.ts`.
- **Inputs:** every family (text/search/textarea/OTP/code editor/date/autocomplete/checkbox/radio/switch/choice/
  dropzone/slider) shares one monochrome focus outline with `outline-offset: 1px` and no box-shadow. The final token
  layer restores `--pg-border-focus` to `#0f172a` in light and `#e4e4e7` in dark after the legacy component palette.
- **Autocomplete:** the panel is a flat, square popover with a clear 1 px strong border, zero padding and
  full-width option rows separated by hairlines. Hover/active use `--pg-bg-surface-active` (visibly stronger in dark
  mode), selected rows use the brand-soft surface. Multi-select still keeps the menu open after each toggle; chips
  shrink/wrap inside the control instead of breaking the trigger.
- **Table chrome:** the table card is flat (no outer border, radius or shadow; the page/card surface is the frame).
  The sticky action column uses a 2 px `--pg-border-strong` end rule and no shadow. The filter surface has no border
  or radius and is not rendered at all when there are no filter definitions. Empty-state medallions inside a table
  are flat.
- **Help:** the contextual-help inspector owns the full viewport height (top `0`, `100dvh`, above the app bar) on
  every screen. Its disclosure cards have a hover surface and 12 px content top padding. The merchant queue/table
  help panel renders directly on the page canvas (no `SurfaceCard` wrapper), its panel is its own bordered
  container, and its body uses symmetric 20/16 px rhythm.
- **Merchant detail:** section headers are one row (label/subtitle start, count + chevron end), hover with the
  surface-hover tone, and body padding is 20/16 px. Identifier/detail groups are real collapsible sections;
  table-only sections use `flush` (0 body padding) so the table is the surface. Expand all/Collapse all update every
  section through the `command` prop. Page-header actions wrap inside the centered page; Suspend/Reinstate are
  outlined; the action cluster no longer overflows.
- **Overlay stack and Vapor branches:** the newest dialog/drawer gets a stack z-index (`1000 + rank among open modal surfaces`) so a
  confirmation dialog always renders above the page modal that opened it. Outside-click handlers ignore surfaces
  that are no longer topmost; clicking inside a nested dialog cannot close the drawer below it. Drawer body children
  keep their content height (`flex: 0 0 auto`) so a card can no longer collapse to a 2 px strip that hides the rest
  of the drawer. Guide glossary/reference popovers, the application detail drawer and merchant sections use
  function-based reactive reads or `createIf` instead of a top-level early return.
- **New gates:** `tests/e2e/admin/ui-polish.spec.ts` covers merchant section commands/layout, the flat table and
  filter chrome, monochrome focus in light/dark, the autocomplete panel/multi-select, the full-height help drawer,
  direct-on-canvas merchant help and outlined utility buttons. `packages/ui/test/table-page-swap.test.tsx` pins the
  stable row-key pagination fix; `tests/unit/ui-2026-polish.test.ts` pins the shared CSS contracts. Playwright:
  admin 102 passed / 11 live skips, merchant + checkout 31 passed.


### 19.6 Audit remediation — 2026-11-27

A second full audit (five parallel reviewers plus real-browser probes) found that the first polish pass had fixed
symptoms but not all root causes. This pass corrects the shared primitives and the page composition:

- **Autocomplete multiple-select closure (root cause):** `TableFilters` read `props.values` synchronously in
  `setup()`, which subscribed the creating `TopSlot` effect to the prop. Every selection recreated the whole
  `TableFilters`/`PgAutocomplete` tree, so the dropdown closed and focus was lost. The filter now copies values in
  its own `watch`, `PgApiTable` no longer reads `loading.value` inside the `TopSlot` expression, and
  `SandboxResourceTable` uses one stable `topSlot` function. The option list no longer calls `isSelected` while
  building rows; selection updates per-option getters and keeps the same DOM nodes. `PgApiAutocomplete` only
  injects missing selected items and returns the same array otherwise. Table filters cap visible chips at one plus
  `+N`, and the chip rail is nowrap with a shrinking input, so 300 px filter columns render a full chip instead of
  clipped text. `PgAutocomplete` no longer changes `activeIndex` on hover, removing the hover-driven row rebuild.
  Tests: package multi/API multi/hover identity, E2E 800 ms survival + node identity + chip geometry.
- **Buttons:** `tonal` + `error`/`warning`/`success` map to `outlined-danger`/`outlined-warning`/
  `outlined-success`; `outlined-danger`/`text-danger` are canonical again; press backgrounds are per-variant
  (no blue flash on a red action) and heights follow the 36/40/44 control tokens. Retry actions are neutral.
  Merchant/admin/fake-rails auth CTAs are primary. `Review attention` is pinned to
  `pg-btn pg-btn--outlined-danger` with a transparent background.
- **Dashboard:** see §19.7 for the final KPI seam, checklist rhythm, header inset and the Route
  health / Approval queue list design. A selected checkbox keeps its selected surface on hover.
- **Cards and sections:** `PgCard` now honours `color` even when `tone` is the default, implements
  `variant` (`tonal`/`outlined`/`flat`/`elevated`), `bodyPadding` and `bodyGap`. `SurfaceCardText` no longer adds a
  second inset inside the card body. Merchant sections keep the card surface and shadow; Expand/Collapse all covers
  identifiers, details, transactions, wallets, applications, finance, pending changes, AML, join requests, KYB,
  beneficial owners, access and field history. `BeneficialOwnersCard` and `MerchantAccessCard` are now disclosure
  sections themselves. `defaultExpanded` is respected, `alwaysOpen` no longer persists a forced-open state, and
  section bodies have `role="region"`/`aria-labelledby`.
- **Disclosure primitives:** `PgExpansionPanel` no longer renders the legacy default slot twice; the help panels,
  AI vector results and operator-case logs use the explicit `title` prop/`title` slot and a single body. The
  legacy `PgExpansionPanelTitle` padding hack and duplicate-render CSS are removed, so header heights and title
  alignment are consistent.
- **Layout system:** `PgRow` is a real 12-track grid (gap no longer wraps 2×50% + gap), `PgCol` supports
  `cols/sm/md/lg/xl`, and the Vuetify-compatible utility subset (`d-flex`, `flex-wrap`, `ga-*`, `mt/mb/pa/px/py`,
  `text-caption`, …) is defined once in `@pg/ui`. Report Studio, chrome forms, fake-rails dashboard and
  checklists keep their authored columns. `PgTextField type="date"` delegates to `PgDateInput`.
- **Chrome:** settings toolbar targets `.pg-field`; card-header actions wrap instead of clipping; dialog bodies keep
  child height; autocomplete panels are clamped to the viewport and no longer offset inside dialogs
  (`backdrop-filter` removed from the dialog backdrop); table filter wrapper ids are unique; wallet Links sections
  and MiniTable frames are flat. The checkout per-rail help banner uses a reactive `createIf` branch (it no longer
  freezes on the first rail or stays absent when the first rail has no guide), the Fake Rails hosted/portal frame
  classes are defined, the merchant Webhooks page has one `h1` plus a `PgSubHeader`, and icon-only Rails/Signature
  actions have accessible names.

### 19.7 Second interaction audit — 2026-11-27

A third browser pass (tabs, palette, navigation, shell, authoring pages, row menus) found these root causes and
fixes:

- **Segmented tabs:** the last-loaded `parts/actions.css` rule was `height: 36px` with 3 px padding and a 1 px
  border (28 px content) around a 30 px tab. `overflow-x: auto` therefore forced `overflow-y: auto` and every
  `SegmentedTabs` became vertically scrollable. The base is now 38 px (`sm` 34, `lg` 42) with an explicit
  `overflow-y: hidden`; the duplicate legacy rule in `components.css` was deleted.
- **Search palettes:** the Ctrl+K palette was `PgDialog` (surface, radius, shadow, 24 px body) around
  `.pg-command-surface` (a second surface). `PgDialog` now supports `bare`, which removes the dialog surface and
  body padding; the global palette and the Ctrl+Shift+K guide palette are each exactly one card. `UI-20` also
  rejects the Vapor slot trap below.
- **Navigation state:** `PgListItem` built its class and `aria-current` in local strings, which Vapor captures once.
  After the first navigation every later route kept the initial `--active` marker and `aria-current`. The bindings
  are now inline JSX expressions and a package reactivity test toggles `active` on a mounted row. The route watcher
  no longer focuses the persistent `<main>`; mouse/keyboard navigation keeps focus on the clicked nav link, and the
  skip link focuses the page `<h1>`.
- **Shell scrolling:** `.pg-main` was `position: static`, so absolutely positioned `.pg-sr-only` spans (1 px, but
  placed at the static position near the bottom of long pages) used the document as their containing block and
  extended `document.scrollingElement.scrollHeight` by 244-698 px. The window scrolled, taking the sticky drawer
  and app bar with it. `.pg-app` is now the clipped viewport (`overflow: hidden`) and `.pg-main` is
  `position: relative; overflow: auto`. The inline `height: 100%` that overrode `100dvh` was removed from the three
  portal `PgApp` roots.
- **Focus rings:** the viewport-wide `<main>:focus-visible` 3 px ring is removed; `[tabindex="-1"]` programmatic
  targets and page headings have no outline; a clickable table row no longer paints a 2 px outline around the whole
  `<tr>` on `:focus-within` when a row menu opens. The nav section header uses a surface hover instead of a white
  border. Real inputs and buttons keep their keyboard focus ring.
- **Report authoring:** `v-slots={condition ? {...} : undefined}` in Vapor `vue-jsx` compiles to slot input without
  a `default`, so `PgCard` rendered an empty padded body. The five occurrences (Studio Step 2/3/4, Chrome upload,
  diagnostics) now use an object literal with a function slot value. Studio Step 1 stacks the Domains autocomplete
  above its two download buttons instead of a 5/7 row with `align="center"`. UI-20 rejects the broken form.
- **Row action menus:** a fixed panel inside `td.pg-col-actions` is still trapped by the `position: sticky`
  stacking context even at `z-index: auto`. `TableRowActions` now adopts its panel into a body-level
  `.pg-floating-layer` before measuring/focusing, so `--pg-z-popover` participates at the root. Outside-click and
  scroll handling recognise the relocated panel.
- **Dashboard final:** the checklist title-to-items gap is 4 px and the items gap is 2 px (separate containers);
  `noPadding` no longer removes the card header/footer inset; Route health is a distribution bar plus a three-row
  legend; Approval queue is a compact domain list with count, oldest age and urgency dot; both footers are pinned
  with a top rule and an end-aligned arrow action. The KPI parent seam is the shared border token, visible in both
  themes.
- **Checklists:** `PgFormChecklist` no longer draws a frame at all. The legacy `.pg-checklist` root rule in
  `components.css` painted a zero-padding bordered box around the title, items and warning; it is removed and
  `data.css` now explicitly resets border/radius/background/overflow. There is also no inner list border/background
  and no separate select-all box, so the checklist merges with the card, drawer or modal body and all content
  aligns with the parent inset.
  `.pg-chk` keeps a 32 px touch box in forms but is sized to its 20 px content inside a checklist row, removing the
  hidden 12-14 px bottom gap; rows are 10 px top and bottom around the visible label. This fixes the asymmetric
  "Summary export checklist" items and the flat checklist is covered by an `ui-polish` geometry test.

Audit evidence and screenshots are under `/tmp/opencode/ui-audit/` (`final-autocomplete.png`,
`final-merchant-detail.png`, `final-settings.png`). Final gates: package 431 tests + typecheck, root Vitest 564,
admin Playwright 111/11 live skips, merchant+checkout 33, ui audit 0, 294 icons, four portal builds,
project-design build/check and `git diff --check`.

### 19.8 Drawer brand lockup — 2026-11-27

The sidebar wordmark had **1 px too little room**: "Payment Gateway" measured 123.5 px at 14 px/600 in Plus Jakarta
Sans, while the brand text column received 122.56 px (248 px drawer − 1 px border − 32 px padding − 28 px mark −
2 × 10 px gap − 43.44 px `LAN` badge). The browser therefore broke the title between the two words and rendered the
header 33.59 px tall instead of 16.19 px. The merchant portal had the same defect, and its wider `SANDBOX` badge
would have truncated the title even after a font reduction.

The brand is now a two-row lockup inside `.pg-drawer__brand-text`: the title is 13.5 px and strictly one line
(`white-space: nowrap` + ellipsis), and the subtitle shares `.pg-drawer__meta` with a small (`size="sm"`)
environment badge. The wordmark gains the whole remaining width (176 px measured), which fits the English, Arabic
and merchant `SANDBOX` variants. `.pg-drawer__brand-text` is `flex: 1 1 auto`, the subtitle truncates with ellipsis,
and the badge no longer participates in the title's line box. The same markup and CSS are mirrored in
`merchant-front/src/layouts/default.tsx` and `merchant-front/src/styles/globals/app.scss`.

Regression: `tests/e2e/admin/shell.spec.ts` and `tests/e2e/merchant/shell.spec.ts` assert the title renders on one
line (`height <= 1.5 × line-height`) and does not overflow its box (`scrollWidth <= clientWidth + 1`) in admin and
in merchant LIVE/SANDBOX routes.

### 19.9 `dc` re-render context and the merchant detail tables — 2026-11-27

The merchant detail page (`admin-front/src/pages/merchants/[id].tsx`) renders every resource table through the
`rerender: true` option of the shared `dc` helper. That option exists for render functions with a top-level reactive
early return: Vapor normally evaluates a render function once, so `rerender` builds a `DynamicFragment` and updates it
from a `renderEffect`.

The original implementation evaluated the render function inside a `computed`:

```ts
const block = computed(() => invokeRender(render));
renderEffect(() => fragment.update(() => block.value));
```

When the page changed from loading to loaded, the computed was re-evaluated during reactivity propagation
(`walkDirty`), where no Vapor instance is active. `createIf`/`renderEffect` inside the new branch then had no owner,
so the branch's child components were mounted **detached from the component tree** and lost every `provide`/`inject`:
`usePgUiConfig()` returned the empty fallback, so every `PgApiTable` threw "No API client configured" and rendered
"Could not load data" without sending a request; router and i18n injections were also missing. The same defect
affected `ApplicationDetailDrawer`, the Platform Settings page and any other `rerender` component that mounts
provider-dependent children after a reactive branch change.

The render is now evaluated **inside its own `renderEffect`** (so `currentInstance` is the owning Vapor component),
and a second `renderEffect` applies the stored block to the fragment. Splitting the two effects keeps DOM insertion
and child setup out of the render pass's dependency set (tracking mount-time writes together with the render caused
the `PgDetailsDialog` tests to time out under the full package run). Children created after the branch change are
therefore mounted inside the owning component, inherit `PgProvider`, router and i18n, and the merchant detail
transactions, wallets, applications, cash-outs, disputes, adjustments, notifications, audit and field-history
tables load their data.

Regression: `packages/ui/test/dc.test.tsx` (`dc rerender branch`) mounts a `PgProvider` around a `rerender`
component that flips from a loading branch to a child calling `usePgUiConfig()`; the child must report the injected
page size (77) rather than the fallback (25). The test fails with the `computed` implementation and passes with the
split-effect implementation. Live verification uses the real merchant detail page against the local stack; the
section shows "Could not load data" before the fix and real rows plus `200` responses for `/transactions` and
`/wallets` after it, with no `usePgUiConfig`/`renderEffect` warnings in the console.

### 19.10 Async detail pages and one-shot render snapshots — 2026-11-27

Vapor evaluates a component render function once. A page that reads async data into a plain local at the top of its
render function (`const entry = detail.value!`) keeps the initial `null` forever: the loading branch never flips, and
after a successful API response the page shows its "not found" fallback. `merchants/[id].tsx` already opted into
`{ rerender: true }`; the join-request and KYB detail pages (and the academy certificate/exam and object-form
module/lesson/lab/track pages) did not. Every such page now opts in.

The same class was fixed where a local snapshot fed live UI without a full re-render: the exam runner now reads
`currentQuestion` (a `computed`) so Previous/Next changes the stem and choices, the exam result empty message and the
Team table visible count are computed, the gateway Flow Builder reads `activePhase.value` directly (and maps
`flowForPhase(activePhase.value).steps`) so switching phases updates the list, the Customer Catalog reads
`props.model.rails` directly so rail tabs and add/remove update, and the checkout help drawer opts into `rerender`.

Guards: `admin-front/src/pages/__tests__/vapor-render-reactivity.test.ts` parses every `src/pages/**/*.tsx` file with
the TypeScript AST and fails when a `dc`/`defineComponent` setup ref is snapshotted in a one-shot render without
`rerender: true` (it is also checked for the object-form `defineComponent({ setup, rerender })`). Removing the option
from `join-requests/[id].tsx` makes it fail with `join-requests/[id].tsx:138 snapshots entry = detail.value! without
{ rerender: true }`. `tests/e2e/admin/detail-pages.spec.ts` loads both reported pages against a mocked API and asserts
the real sections render and the not-found fallbacks are absent.
