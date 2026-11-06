---
id: admin-ui.system
title: Admin UI System
status: partial
confidence: high
last_verified: 2026-11-06
verified_against: 5a24f6f+working-tree
code:
  - admin-front/src/plugins/vuetify.ts
  - admin-front/src/styles/**
  - admin-front/src/assets/fonts/**
  - admin-front/src/layouts/**
  - admin-front/src/components/ui/**
  - admin-front/src/components/Table/**
  - admin-front/src/utils/iconSet/**
  - merchant-front/src/plugins/vuetify.ts
  - merchant-front/src/layouts/**
  - checkout-front/src/plugins/vuetify.ts
  - checkout-front/src/layouts/**
  - fake-rails-front/src/styles/**
  - fake-rails-front/src/components/ui/**
  - admin-front/src/utils/devLog.ts
  - admin-front/src/components/ui/jsonDiffModel.ts
  - admin-front/src/components/ui/JsonDiffViewer.tsx
  - admin-front/src/components/ui/JsonValueCell.tsx
  - admin-front/src/components/ui/JsonValueList.tsx
  - admin-front/src/components/builders/**
  - admin-front/src/components/ledger/**
  - admin-front/src/components/AuditChangeChips.tsx
  - admin-front/src/utils/auditSummary.ts
  - admin-front/src/constants/i18n/**
design_sources:
  - design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md
  - design/06-ui/portal_ui_abstraction_and_modern_fintech_redesign_2.md
  - design/06-ui/portal_ui_implementation_plan.md
tests:
  - admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts
  - tests/e2e/admin/shell.spec.ts
  - tests/e2e/admin/table-and-padding-geometry.spec.ts
  - tests/e2e/admin/a11y.spec.ts
  - tests/e2e/merchant/shell.spec.ts
  - tests/e2e/checkout/pay.spec.ts
  - tests/unit/frontend-security-admin.test.ts
  - tests/unit/json-diff-model.test.ts
  - tests/unit/audit-summary.test.ts
  - tests/unit/builders-route-models.test.ts
  - tests/unit/builders-settings-parser.test.ts
  - tests/unit/builders-aml-templates.test.ts
  - tests/unit/builders-api-error-i18n.test.ts
  - tests/unit/commerce-i18n.test.ts
gaps:
  - Fake Rails receives only a partial shared-UI rollout; it has separate portal/hosted shells and is not covered by the admin compliance test.
  - Shared primitives are copied per workspace rather than published as one package, so drift is possible.
  - "Residual (GAP-019): the admin session token lives in client storage unless the edge runs `SESSION_COOKIE_MODE=true`."
---

# Admin UI System

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
7. **Disciplined tables.** 40 px single-line rows, no rainbow row tints, one primary row action plus an overflow menu, collapsible filters, and XLSX export through the shared pipeline.
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
| `SlideOverDrawer` | Right/end slide-over shell used for details and contextual help. |
| `DescriptionList` | Label/value lists with money, mono, and column options. |
| `SegmentedTabs` | Compact tab switch used for periods, roles, languages, and modes. |
| `EmptyState` | Empty/error-adjacent illustration-free state block. |
| `JsonDiffViewer` | Structured JSON patch/diff presentation. |

Additional exported primitives/extras are `SurfaceCardText`, `MetaPill`, `FormChecklist`, and `SummaryExportCard`. Legacy wrappers `StatusChip` and `MoneyText` remain as compatibility shims over `StatusBadge` and `MoneyDisplay`.

`src/components/ui/__tests__/ui-abstraction-compliance.test.ts` is the UI compliance gate. It asserts the required exports, absence of unlayered universal padding/margin resets, no rainbow row backgrounds, presence of `TableRowActions`, no raw `VDialog`/`VChip`/`VCard` in route pages, `PageHeader` usage on standard route pages, no gradients in the table/header/card system, and the v2 `SectionFields`, `ScreenContainer`, and `.pg-table-card` classes.

### 3.5 Shell

`admin-front/src/layouts/default.tsx` implements the authenticated shell:

- A skip link targeting `#pg-main-content`.
- A 56 px flat app bar with menu toggle, brand, breadcrumbs, live ledger invariant pill (for `profit.read` or `liquidity.read`), global search trigger (`Ctrl+K`/`Cmd+K`), help button, theme toggle, language menu, and user menu.
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
