<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# admin-front blueprint

Generated from: `admin-ui.system`, `admin-ui.routes`, `admin-ui.tables`, `admin-ui.guide`, `admin-ui.help`, `admin-ui.operations`.

## Admin UI System

> Status: `partial` · Last verified: 2026-11-05

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

## Admin Route and Page Catalog

> Status: `partial` · Last verified: 2026-11-05

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

The authority column is the UI gate. "None" means no effective `routesAuthorities` entry; the backend may still require an authority. Help shows the book/chapter used by `GUIDE_ROUTE_HELP`; "none" means no mapping resolves.

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
| 34 | `/academy` | `AdminAcademy` | none (intentional learning; overview API needs `user:read`) | 1 / 1.1 | Employee academy, labs, quizzes, tracks and certifications. |
| 35 | `/settings/platform` | `AdminPlatformSettings` | none (backend `settings:read`/`settings:write`) | none | Versioned platform settings, backup export and restore preview. |
| 36 | `/settings/checkout-help` | `AdminCheckoutHelp` | none (backend `settings:read`/`settings:write`) | 4 / 4.2 | Checkout support config, preview, version history and diff. |
| 37 | `/system/backups` | `SystemBackups` | `security:read` or `gateway:read` | none | WAL/daemon/target health, backup history, drills and policy. |

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
| Admin help map | `admin-front/src/content/guide/index.ts` |
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
| `AdminAcademy` | No entry. | Self progress needs only authentication; team overview/export needs `user:read`. | Intentional learning surface, with a backend-gated reporting surface. |

The merchant portal has a similar gap: `Statements` is shown in navigation only with `statements.read`/`statements.export`, but `routesAuthorities` has no `Statements` entry, so a direct URL is not redirected by the router. `Onboarding` intentionally has `[]` because every authenticated merchant must complete it.

## 6. Operational usage

- Adding an admin page: add the explicit router record, the navigation item, the authority entry, and the `GUIDE_ROUTE_HELP` mapping in the same change.
- Adding a detail page: set `meta.parentName` so navigation/help resolve to the parent; if the parent has no help mapping, add both.
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

- Admin route authority coverage is incomplete: six privileged surfaces are ungated in the UI.
- Merchant `Statements` is not route-gated.
- Contextual help covers most admin routes but not all (see `04-contextual-help.md`).
- Admin `AdminUsers` explicitly uses an empty authority array while the backend requires `user:read`/`security:read`; this is a deliberate-looking but unsafe pattern.

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
- `design/07-guides-and-academy/guide_system_design_and_content.md` — future guide route/context-map expectations (not current).

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

The `VITE_AUTHORIZED` bypass was removed. The route authority table moved to `src/utils/routeAuthorities.ts` with a default-deny guard: `PUBLIC_FOR_AUTHENTICATED` is Dashboard, AdminGuide and AdminAcademy; `AUTHORITY_ALIASES` normalizes dotted and colon forms. Entries were added for AdminUsers, AdminUserDetail, AdminPlatformSettings, PricingControls, GatewayAiImport and AdminCheckoutHelp. These checks are advisory; core enforces authorities. Any route not in the table is denied to authenticated users unless it is in `PUBLIC_FOR_AUTHENTICATED`.

## Tables Filters and Exports

> Status: `partial` · Last verified: 2026-11-05

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

## Admin Guide and Academy

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

This part owns the admin interactive guide and the employee academy:

- The `admin-front` guide content modules under `src/content/guide`.
- The guide page at `/guide`, its global search modal, bookmarks, glossary, simulators, role checklists, and contextual-help data source.
- The academy content modules under `src/content/academy`.
- The academy page at `/academy`, its lessons, labs, quizzes, mastery gate, tracks, badges, team certification view and exports.

It does not own the merchant guide or checkout help center. It also does not present the future guide v2 specification as current behavior. The v2 workstream is recorded separately in `project-design/parts/09-future-and-unimplemented/01-guide-v2.md`.

## 2. Design intent (extracted and synthesized from ./design)

The implemented baseline is the "zero-to-hero" specification in `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md`:

1. **The guide is an operational manual, not a feature tour.** Every chapter explains the concept, the exact workflow, the screen to use, and the human error to avoid.
2. **The reader is assumed to know nothing.** The glossary defines every banking, accounting, compliance and software term with an analogy and a fatal-error warning.
3. **The academy is a flight simulator.** A learner reads lessons, passes an interactive lab with fatal traps, then scores 100% on a verification quiz before a module counts as mastered.
4. **The guide and academy share a learning model.** Roles, tracks, badges and progress are visible to the learner and to management.
5. **The guide is searchable and contextual.** Global search covers books, glossary, statuses, GL accounts, runbooks, error codes, edge cases and simulators; the shell help drawer maps the current route to a chapter.
6. **Content is data, not hard-coded prose in TSX.** Books, chapters, glossary entries and academy modules live in typed content modules so the UI can render, search and test them.
7. **Every claim must be testable.** The content-completeness test asserts book count, chapter depth, glossary counts, status/collection/channel/runbook counts, edge-case count, module count, lesson depth, lab traps, quiz count and track definitions.

The future guide v2 specification in `design/07-guides-and-academy/guide_system_design_and_content.md` goes further: 14 books (0-13), 125 articles, a 23-screen context map, safeguard cards, a symptom playbook, reading paths, read tracking, five simulators and an edge-case catalog. It is not the current implementation.

## 3. As-built architecture

### 3.1 Content modules

| Module | Contents |
| :--- | :--- |
| `admin-front/src/content/guide/types.ts` | `GuideBook`, `GuideChapter`, glossary/reference/search types. |
| `admin-front/src/content/guide/booksPart1.ts` | Books 1-6 and their chapters. |
| `admin-front/src/content/guide/booksPart2.ts` | Books 7-12 and their chapters. |
| `admin-front/src/content/guide/glossaryData.ts` | Glossary terms, GL accounts, attempt statuses, collection modes, confirmation channels, runbooks, edge cases and error codes. |
| `admin-front/src/content/guide/index.ts` | Aggregates books/chapters, exposes lookups, simulator ids and `GUIDE_ROUTE_HELP`. |
| `admin-front/src/content/guide/search.ts` | Builds and scores the in-memory search index. |
| `admin-front/src/content/academy/types.ts` | Modules, lessons, labs, quizzes, tracks, badges and progress types. |
| `admin-front/src/content/academy/modulesTrackA.ts` | Modules M1-M4. |
| `admin-front/src/content/academy/modulesTrackB.ts` | Modules M5-M8. |
| `admin-front/src/content/academy/index.ts` | Aggregates modules/tracks and computes mastery, badges and track percentages. |

### 3.2 The 12 books and 27 chapters

| Book | Title | Chapters |
| :--- | :--- | :--- |
| 1 | Welcome to the Platform — How Money, Data, and Security Work From Zero | 1.1, 1.2 |
| 2 | Roles, Authorities & the Four-Eyes (Maker-Checker) Governance Rule | 2.1, 2.2, 2.3, 2.4 |
| 3 | The Four-Layer Payment Catalog (Gateway -> Credential Set -> Rail -> Route) | 3.1, 3.2 |
| 4 | Collection Modes (Axis A) & Confirmation Channels (Axis B) — Why We Never Trust the Browser | 4.1, 4.2 |
| 5 | The Universal Flow Engine, `TransformPipe[]` & Cryptographic Signing | 5.1, 5.2, 5.3 |
| 6 | The 8-Step "Add-a-Gateway" Wizard & Smart AI Integration Importer | 6.1, 6.2 |
| 7 | The 14-State Attempt Lifecycle & Resolving `UNKNOWN`, `CONFLICT`, and `HELD` Cases (`RB-01` to `RB-05`) | 7.1, 7.2, plus the misplaced 9.4 |
| 8 | Double-Entry Accounting, Clearing Accounts, Fee Bearers & Statement Reconciliation | 8.1, 8.2 |
| 9 | Merchant Onboarding, KYB Document Verification & Duplicate Detection | 9.1, 9.2, 9.3 |
| 10 | The 7-Layer AML & Compliance Program, Screening Dispositions & CBL Reporting | 10.1 |
| 11 | Disputes, Chargebacks, Refunds, Cash-Outs & Negative Balance Ceilings | 11.1, 11.2 |
| 12 | Platform Profitability, Liquidity, Solvency & The 12 Go-Live Gates | 12.1 |

The total is 27 chapter objects. The 9.4 object (`book-9-chapter-9.4`, merchant lifecycle/support) is physically inside `BOOKS_PART_2[0]`, which is Book 7. `findChapter(9, "9.4")` therefore returns `undefined`, while Book 7's table of contents renders a 9.4 chapter under Book 7. This is a content-placement bug, not a missing chapter body.

### 3.3 Reference and glossary counts

| Collection | Count | Notes |
| :--- | :--- | :--- |
| `GLOSSARY_TERMS` | 24 | Zero-assumption terms with definition, analogy and fatal-error warning. |
| `GL_ACCOUNT_DEFINITIONS` | 10 entries | Covers 11 core enum types because `PROVIDER_FEE_EXPENSE / GATEWAY_FEE_EXPENSE` is one combined label. |
| `ATTEMPT_STATUS_DEFINITIONS` | 14 | Matches the core attempt lifecycle. |
| `COLLECTION_MODE_DEFINITIONS` | 9 | OTP pull, redirect, embedded, push, QR, pay code, deep link, manual, hybrid. |
| `CONFIRMATION_CHANNEL_DEFINITIONS` | 7 | Zero-trust versus server-trusted channels. |
| `RUNBOOK_DEFINITIONS` | 5 | `RB-01` to `RB-05`. |
| `EDGE_CASE_DEFINITIONS` | 140 | The guide's edge-case registry. |
| `ERROR_CODE_GLOSSARY` | 5 | Canonical error categories such as `RETRYABLE_OTP`, `LIMIT_EXCEEDED`, `GATEWAY_FAULT`, `AMBIGUOUS`. |

The UI glossary headings say "10 GL account types", "9 collection modes" and "7 confirmation channels". The GL label is consistent with the content module but not with the core enum's 11 types; the guide therefore undercounts the canonical GL account types by representing the two fee-expense labels as one entry.

### 3.4 Guide page surfaces

`admin-front/src/pages/guide/index.tsx` provides four view modes:

1. **Books** — 12-book tree, selected book summary, tags, human-error warning, SOP checklist, expandable chapters, "where to click" route pills, previous/next book, bookmark, copy link, and Markdown download.
2. **Glossary** — filterable glossary plus expandable sections for 14 statuses, GL accounts, 9 collection modes, 7 confirmation channels, error codes, 5 runbooks and 140 edge cases.
3. **Simulators** — three interactive widgets: `TransformPlayground`, `CryptoSignatureLab`, `LedgerTAccountVisualizer`. The same widgets are embedded inline in chapters 5.2, 5.3 and 8.2.
4. **Checklists** — five role-based daily checklists: support, operations, compliance, finance, gateway architect.

Additional guide behavior:

- Global search modal opened by the shell (`Ctrl+K`/`Cmd+K`), searching books, chapters, glossary, errors, GL accounts, statuses, collection modes, channels, runbooks, edge cases and simulators.
- Bookmark persistence in `localStorage` key `admin-guide-bookmarks`.
- Daily checklist persistence in `localStorage` key `admin-guide-daily-checklists`.
- Bookmark import/export as JSON, with unknown book ids skipped and an optional replace mode.
- Deep links via `?entry=`, `?book=`, `?chapter=`, `?search=1`.
- Route help mapping in `GUIDE_ROUTE_HELP` (29 entries), consumed by the shell drawer.

### 3.5 Academy content

| Module | Focus | Lessons | Quiz questions |
| :--- | :--- | :--- | :--- |
| M1 | Foundations: digital payments, links, slots, zero-trust | 3 | 8 |
| M2 | Four-eyes governance and field control | 2 | 8 |
| M3 | Merchant onboarding, KYB forensics, beneficial owners, duplicates | 2 | 8 |
| M4 | Double-entry accounting, fee bearers, clearing, reconciliation | 2 | 8 |
| M5 | Rail engine, 8-step wizard, smart AI importer | 2 | 8 |
| M6 | `UNKNOWN`, outages, circuit breakers, runbooks | 2 | 8 |
| M7 | AML program, Arabic name matching, velocity, no tipping-off | 2 | 8 |
| M8 | Disputes, chargebacks, refunds, ceilings, go-live gates | 2 | 8 |

Totals: 8 modules, 17 lessons, 8 labs with at least one fatal option, and 64 quiz questions (8 per module).

### 3.6 Academy page and mastery gate

`admin-front/src/pages/academy/index.tsx` provides:

- Track tabs with live progress percentages.
- Module selection and three steps: lessons, interactive lab, verification quiz.
- Lesson completion tracking.
- Lab scenarios with fatal-error feedback; a fatal option does not pass the lab.
- Quiz submission with 100% required to pass; immediate score and explanations.
- Badge computation from track definitions.
- Team certification accordion with per-user completion percentage and badges.
- Summary health panel (`usersWithProgress`, not started, modules/lessons/labs, badges, active last 7 days).
- Two XLSX exports: academy summary and team certifications.

Mastery is computed client-side in `admin-front/src/content/academy/index.ts`:

- `moduleLessonsComplete` — every lesson id is in `completedLessonIds`.
- `moduleLabPassed` — the module lab id is in `completedLabIds` with `passed: true`.
- `moduleQuizPerfect` — the quiz score is 100%.
- `moduleMastered` — all three are true.
- `earnedBadges` — all modules in a track are mastered; `MASTER_OPERATOR` additionally requires all labs passed and all quizzes perfect.
- `trackProgressPercent` — mastered modules divided by track modules.

Progress persistence uses `GET/PUT v1/admin/academy/progress`. It stores completed lesson ids, lab results, quiz scores, earned badges and last module id on the authenticated user row. Legacy `completedModules` data is converted into the new shape on load.

### 3.7 Academy reporting and authority

- Self progress endpoints: authenticated user, no extra authority.
- Team overview: `GET v1/admin/academy/progress/overview`, backend requires `user:read`.
- Summary: `GET v1/admin/academy/progress/overview/summary`, backend requires `user:read`.
- Summary export: `GET .../summary/export`, backend requires `user:read` and writes an `ACADEMY_SUMMARY_EXPORTED` audit entry.
- Certification export: `GET .../overview/export`, backend requires `user:read` and writes an `ACADEMY_CERTIFICATIONS_EXPORTED` audit entry.
- UI route `/academy` has no router authority gate, so the page opens for any authenticated admin; the reporting calls fail without `user:read`.

## 4. Contracts and invariants

1. **Current guide counts are 12 books and 27 chapters.** The content test asserts 12 books; it does not assert exactly 27 chapters, so the count is verified by code inspection.
2. **The current academy counts are 8 modules, 17 lessons, 64 quizzes.** The content test asserts 8 modules and exactly 8 quizzes per module.
3. **A module is mastered only by lessons + passed lab + 100% quiz.** No UI button can skip the gate.
4. **Badges are derived, not manually granted.** `earnedBadges` merges stored badges with newly earned track badges.
5. **Guide/search content must be typed and testable.** New content goes into the content modules, not inline JSX.
6. **The guide is allowed for all admins.** It contains no live data or secrets by design.
7. **Academy progress is per user.** Team views aggregate the same JSON shape.
8. **The guide v2 specification is not current authority.** It must not be described as shipped.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Guide content | `admin-front/src/content/guide/**` |
| Academy content | `admin-front/src/content/academy/**` |
| Guide page | `admin-front/src/pages/guide/index.tsx` |
| Academy page | `admin-front/src/pages/academy/index.tsx` |
| Guide drawer/search | `admin-front/src/components/guide/**` |
| Route help map | `admin-front/src/content/guide/index.ts` |
| Progress APIs | `v1/admin/academy/progress`, `/overview`, `/overview/summary`, `/overview/export` |
| Local storage | `admin-guide-bookmarks`, `admin-guide-daily-checklists` |
| Future v2 destination | `project-design/parts/09-future-and-unimplemented/01-guide-v2.md` |

## 6. Operational usage

- Add a book or chapter: append to `booksPart1.ts` or `booksPart2.ts`, keep the id/number/title/body/tags shape, and update `GUIDE_ROUTE_HELP` if a screen should point to it.
- Add a glossary entry: add to the appropriate array in `glossaryData.ts`; the search index and glossary UI pick it up automatically.
- Add an academy module: add to a track module file, keep 8 quiz questions and at least one fatal lab option, then update the track definitions if the module belongs to a track.
- Re-run `bun test src/content/__tests__/content-completeness.test.ts` after content changes.
- Fix the 9.4 bug by moving the chapter object into Book 9 (or by changing the mapping to the actual book); do not duplicate the body.
- Treat guide v2 as a separate future implementation, not as a content edit to the current modules.

## 7. Status and deviations

### Implemented

- 12 books, 27 chapters, 24 glossary terms, 14 statuses, 9 collection modes, 7 channels, 5 runbooks, 140 edge cases and 5 error codes.
- Three interactive simulators with inline chapter embeds.
- Five role-based daily checklists with local persistence.
- Global guide search, bookmarks, import/export, deep links and Markdown download.
- 29-entry contextual route map.
- 8 academy modules, 17 lessons, 8 labs, 64 quizzes, 6 certification tracks.
- Client-side mastery gate, badge derivation and track progress.
- Progress persistence and team overview/summary/certification exports with backend `user:read` gating.

### Partial

- The guide is content-rich but not fully bilingual; many chapters have Arabic bodies and many do not.
- Academy assessment is client-computed. The backend accepts the posted progress JSON and does not independently verify answers, lab outcomes or mastery.
- Certification is a computed badge, not a server-issued certificate with an immutable registry.
- The guide v2 work is not merged; the current guide does not have v2's articles, context map, safeguard cards, playbook or read tracking.

### Guide v2 comparison (future, not current)

| Area | Current implementation | Guide v2 target |
| :--- | :--- | :--- |
| Books | 12 (1-12) | 14 (0-13) |
| Articles/chapters | 27 chapter objects | 125 articles |
| Context model | 29-entry route map | 23-screen context map with fallback |
| Simulators | 3 | 5 |
| Safeguard cards | none | Per-screen safeguard checklists |
| Situation playbook | none | Symptom-to-action playbook |
| Reading paths/progress | Bookmarks and role checklists only | Role reading paths and read tracking |
| Edge cases | 140 | 140-case catalog plus v2 presentation |

### Missing / deferred

- **Guide v2 is missing.** Target: 14 books (0-13), 125 articles, 23 context-map screens, five simulators, reading paths, safeguard cards, symptom playbook, read tracking and a full edge-case catalog. See `project-design/parts/09-future-and-unimplemented/01-guide-v2.md` and `design/07-guides-and-academy/guide_system_design_and_content.md`.
- No server-side quiz/lab validation.
- No immutable certification record or expiry/re-certification cycle.
- No completion tracking tied to route-level or authority-level access grants.
- No Arabic content completeness gate.

### Known bugs / risks

- **Content-placement bug:** Chapter 9.4 lives under Book 7, so Book 9/9.4 help resolution fails and Book 7 shows an out-of-sequence chapter.
- **Count gap:** The guide displays 10 GL entries while the core enum has 11 types. The combined `PROVIDER_FEE_EXPENSE / GATEWAY_FEE_EXPENSE` entry hides the distinction.
- **Security gap:** A client could POST arbitrary progress JSON because mastery is not recomputed server-side. The stored progress is training data, not an authorization authority.
- **Reporting gap:** `/academy` is open to all authenticated admins, but team overview/export fail without `user:read`; the page does not explain this before the request.
- **Documentation risk:** The v2 specification must not be presented as current; it is future/unimplemented.

## 8. Verification and tests

- `admin-front/src/content/__tests__/content-completeness.test.ts` asserts:
  - 12 books with depth, SOP checklist and human-error warnings.
  - Glossary/reference counts: 10 GL entries, 14 statuses, 9 collection modes, 7 channels, 5 runbooks, 140 edge cases, at least 5 error codes.
  - Search coverage for books, errors, GL accounts, statuses, runbooks, edge cases and simulators.
  - 8 academy modules, at least 2 lessons per module, one lab per module with a fatal option, exactly 8 quizzes per module (64 total), and six track definitions.
- `tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts` includes `/guide` and `/academy`.
- `tests/e2e/admin/global-search.spec.ts` covers the shell search split between records and guide search.

The content test is a Bun test and does not require PostgreSQL. The Playwright surface checks require the running stack.

## 9. Source references

### Old design sections

- `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` — implemented 12-book/8-module baseline.
- `design/07-guides-and-academy/guide_system_design_and_content.md` — future guide v2 workstream, not current.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` — deployment and guide architecture context.

### Code paths

- `admin-front/src/content/guide/booksPart1.ts`
- `admin-front/src/content/guide/booksPart2.ts`
- `admin-front/src/content/guide/glossaryData.ts`
- `admin-front/src/content/guide/index.ts`
- `admin-front/src/content/guide/search.ts`
- `admin-front/src/content/academy/modulesTrackA.ts`
- `admin-front/src/content/academy/modulesTrackB.ts`
- `admin-front/src/content/academy/index.ts`
- `admin-front/src/pages/guide/index.tsx`
- `admin-front/src/pages/academy/index.tsx`
- `admin-front/src/components/guide/**`

### Generated appendices

- `project-design/appendices/test-inventory.md`
- `project-design/appendices/api-route-matrix.md`

## 10. Change history

- 2026-11-03 — Initial canonical guide/academy part. Confirms 12 books/27 chapters, 24 glossary terms, 10 GL entries covering 11 core types, 8 academy modules/17 lessons/64 quizzes, the client-side mastery gate, and the unimplemented guide v2 workstream.

## Contextual Help

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

This part owns the admin contextual-help drawer and its route-to-guide mapping, the merchant portal help drawer, the unused `PageHeader` help props, and the boundary between admin/merchant contextual help and the payer-facing checkout help center.

The checkout help center has its own data contract and rendering rules; it is documented in `05-checkout-front/01-help-center.md`. This part only records how the products are separated and where the admin/merchant surfaces diverge.

## 2. Design intent (extracted and synthesized from ./design)

The design intent is that help is always one action away without destroying work in progress:

1. **Global admin drawer.** A "Help & SOP (?)" button in the shell and a `?` keyboard shortcut open a right-hand 560 px drawer for the current screen.
2. **Context before content.** The drawer should show the mapped book/chapter, the book SOP checklist and the critical human-error warning for the current route.
3. **No form reset.** Opening help must not unmount, close or reset the form being edited.
4. **Search is separate from context.** `Ctrl+K`/`Cmd+K` opens the broader guide search palette; the drawer is for the current screen.
5. **Merchant help is merchant-specific.** The merchant portal has its own M-xx/D-xx chapters and route map, not the admin 12-book guide.
6. **Checkout help is payer-specific.** The checkout support drawer and per-rail banner are driven by the checkout projection, not by the admin guide.
7. **Future guide v2 expects a formal 23-screen context map.** That exhaustive context-map model is not implemented; the current admin map is a simpler 29-entry record.

## 3. As-built architecture

### 3.1 Admin drawer

`admin-front/src/components/guide/ContextualHelpDrawer.tsx` renders a `VNavigationDrawer` with:

- `location="end"`, `temporary`, width 560.
- A close button.
- Status chips for "Help & SOP", the book number and the chapter number.
- A mapping title (English only).
- The book title in the current language when a book resolves.
- The mapped chapter title and Markdown body (`GuideMarkdown compact`).
- The book SOP checklist.
- The book human-error warning.
- An "Open the full guide" button.
- A footer note that the drawer never closes/resets the current form.

If no chapter resolves, it shows a message telling the operator to use `Ctrl+K` to search records, pages and the guide.

The drawer is mounted once in `admin-front/src/layouts/default.tsx`. The route name passed to it is:

```text
String(route.meta.parentName ?? route.name ?? "")
```

That parent-first rule means detail pages automatically use the parent mapping.

### 3.2 The 29-entry admin map

`GUIDE_ROUTE_HELP` in `admin-front/src/content/guide/index.ts` has 29 entries.

| Mapping key(s) | Book | Chapter | Mapping title |
| :--- | :--- | :--- | :--- |
| `Dashboard` | 1 | 1.1 | What the platform does |
| `Approvals` | 2 | 2.4 | Approvals queue SOP |
| `JoinRequests` (also `JoinRequestNew` via parent) | 9 | 9.1 | Join request lifecycle |
| `KybReview`, `KybReviewDetail` | 9 | 9.3 | KYB review queue and per-document decisions |
| `AmlCases`, `AmlScreenings`, `AmlRules`, `AmlReports` | 10 | 10.1 | AML case management / screening / rules / reporting |
| `OperatorCases`, `OperatorCaseDetail`, `GatewayInquirySchedules` | 7 | 7.2 | Operator cases and runbooks |
| `Disputes` | 11 | 11.1 | Dispute and chargeback SOP |
| `Adjustments` | 11 | 11.2 | Refund adjustment SOP |
| `CashOuts` | 12 | 12.1 | Liquidity before cash-outs |
| `Reconciliation` | 8 | 8.2 | Statement reconciliation |
| `Profitability`, `Liquidity`, `Invariant` | 12 | 12.1 | Profitability/liquidity/invariant guidance |
| `Gateways`, `GatewayWizard` | 6 | 6.1 | Gateway wizard |
| `GatewayAiImport` | 6 | 6.2 | Smart AI importer |
| `Rails`, `GatewayRoutes` | 3 | 3.2 | Visible rails formula / route diagnostics |
| `Merchants`, `MerchantDetail` | 9 | 9.4 | Merchant lifecycle and support operations |
| `AdminCheckoutHelp` | 4 | 4.2 | Checkout confirmation channels |
| `AdminGuide` | 1 | 1.1 | Admin system guide |
| `AdminAcademy` | 1 | 1.1 | Employee academy |

The map has no Arabic titles. In Arabic mode the drawer still shows `mapping.titleEn`.

### 3.3 Effective coverage and missing mappings

Because the drawer receives `parentName ?? name`, not every route name needs its own map key. With parent fallback, the current map covers 31 of the 37 protected routes. Six route names have no effective chapter:

| Route | Effective help key | Result |
| :--- | :--- | :--- |
| `AdminUsers` | `AdminUsers` | No mapping; drawer shows the "no chapter" message. |
| `AdminUserDetail` | `AdminUsers` via parent | Same. |
| `AuditLog` | `AuditLog` | No mapping. |
| `PricingControls` | `PricingControls` | No mapping. |
| `AdminPlatformSettings` | `AdminPlatformSettings` | No mapping. |
| `SystemBackups` | `SystemBackups` | No mapping. |

`GatewayAiImport`, `AdminCheckoutHelp`, `AdminGuide` and `AdminAcademy` are mapped even though some are not in the navigation or have no route authority gate. `JoinRequestNew` is not a map key but resolves through `meta.parentName = "JoinRequests"`.

### 3.4 The 9.4 placement bug

The merchant chapter object is:

```text
id: book-9-chapter-9.4
number: 9.4
title: Merchant Lifecycle, Sensitive Edits & Support Operations
```

It is physically inside `BOOKS_PART_2[0]`, whose `id` is `book-7` and whose `number` is 7. As a result:

- Book 7's chapter list has three chapters: 7.1, 7.2 and 9.4.
- Book 9's chapter list has only 9.1, 9.2 and 9.3.
- `findChapter(9, "9.4")` returns `undefined`.
- `GUIDE_ROUTE_HELP.Merchants` and `.MerchantDetail` point to 9/9.4, so the admin merchants help drawer shows "No chapter is mapped to this screen yet."
- Global guide search still finds the 9.4 entry because the search index walks all chapter objects and records `bookNumber` from the containing book; the result is therefore presented as Book 7's chapter 9.4.

This is a content-placement bug, not a missing body. Moving the object into Book 9 fixes the drawer without changing the mapping.

### 3.5 PageHeader help props are unused

`admin-front/src/components/ui/PageHeader.tsx` defines `helpChapterId` and `onOpenHelp` and conditionally renders an "SOP & Help" button. However, no route page passes either prop. The only working entry points are:

- The shell "Help & SOP (?)" button.
- The `?` shortcut when focus is not in an input/textarea/select/contenteditable.
- The shell menu/guide link.

Therefore the PageHeader help affordance is dead code in practice, and the help chapter cannot be selected per page through that prop.

### 3.6 Merchant contextual help

`merchant-front/src/components/guide/ContextualHelpDrawer.tsx` has a separate 16-entry `ROUTE_HELP` map:

| Route | Chapter |
| :--- | :--- |
| `Dashboard` | `M-02` |
| `Onboarding` | `M-01` |
| `Wallets` | `M-07` |
| `Statements` | `M-07` |
| `Cashouts` | `M-07` |
| `Links` | `M-03` |
| `Applications` | `M-02` |
| `PosTerminals` | `M-05` |
| `PosScreen` | `M-05` |
| `Payments` | `M-06` |
| `Disputes` | `M-08` |
| `DeveloperTokens` | `D-02` |
| `Credentials` | `M-09` |
| `Team` | `M-10` |
| `MerchantGuide` | `M-01` |
| `MerchantDeveloperGuide` | `D-01` |

The merchant drawer:

- Resolves the chapter from the merchant operations/developer content, not the admin 12-book guide.
- Shows chapter id, role, developer/operations badge, title and Markdown body.
- Has an "Open the full guide" footer that routes to the developer guide for developer routes and to the merchant guide otherwise.
- Is opened by the merchant shell's "SOP & Help" button and `?` shortcut.
- Uses the same parent-first route-name rule.

The 9.4-under-Book-7 bug is an admin guide content bug. Merchant `M-07` and the merchant drawer are unaffected because they do not read the admin book arrays.

### 3.7 Checkout help is a separate product

The checkout help center does not consume `GUIDE_ROUTE_HELP` or the merchant `ROUTE_HELP` map. It consumes:

- `PayLinkSummary.supportConfig` from the core checkout projection of `checkout.support_config`.
- `RailDescriptor.helpGuide` from `rails.help_guide_json`.

The admin `Checkout Help` page edits the support configuration; the per-rail guides are seeded from `core-back/prisma/seedGuides.ts` and sent through the checkout summary. The checkout drawer/banner are documented in `05-checkout-front/01-help-center.md`.

## 4. Contracts and invariants

1. **The admin drawer never closes or resets the underlying form.** It is a temporary navigation drawer, not a page transition.
2. **The route key is parent-first.** `meta.parentName` wins over the detail route name.
3. **Mappings carry a book number, optional chapter number and English title.** Missing chapter numbers fall back to the book's first chapter; missing mappings show the fallback message.
4. **A mapped chapter must exist in the mapped book.** The 9.4 case violates this.
5. **Help is role-agnostic.** Any authenticated admin may open the guide and drawer; it contains no live data.
6. **Merchant and admin help are separate content domains.** Do not reuse admin book numbers in the merchant drawer.
7. **Checkout help is data-driven.** It must not depend on admin guide content.
8. **The future context map is not current.** Do not describe the 23-screen v2 map as implemented.

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Admin drawer | `admin-front/src/components/guide/ContextualHelpDrawer.tsx` |
| Admin shell mount and keyboard handling | `admin-front/src/layouts/default.tsx` |
| Admin route map | `admin-front/src/content/guide/index.ts` |
| Admin guide search | `admin-front/src/components/guide/GlobalGuideSearchModal.tsx` |
| PageHeader help props | `admin-front/src/components/ui/PageHeader.tsx` |
| Merchant drawer/map | `merchant-front/src/components/guide/ContextualHelpDrawer.tsx` |
| Merchant shell mount | `merchant-front/src/layouts/default.tsx` |
| Checkout help drawer/banner | `checkout-front/src/components/help/**` |
| Checkout support projection | `core-back/api/internal/checkout.ts` |
| Seeded support/rail guides | `core-back/prisma/seedGuides.ts` |

No deployment flag controls the admin/merchant contextual drawer. The `ADMIN_SHOW_HELP_PANELS` flag controls inline help panels on KYB, approvals and merchants, not the contextual drawer.

## 6. Operational usage

- Add an admin mapping: add the route name to `GUIDE_ROUTE_HELP`, point it at an existing chapter, and confirm `findChapter(bookNumber, chapterNumber)` resolves.
- Fix the 9.4 bug: move the chapter object from Book 7's array to Book 9's array; keep the `book-9-chapter-9.4` id and number.
- Add a merchant mapping: add the route name to the merchant `ROUTE_HELP` map and ensure the referenced M/D chapter exists.
- Debug "no chapter" in the admin drawer: check the effective route key (`parentName ?? name`), the map entry, and the chapter's actual containing book.
- Do not wire per-page `PageHeader` help props until the shell and the page share a single open-state contract; the current shell owns drawer state.

## 7. Status and deviations

### Implemented

- Admin global 560 px drawer with book/chapter/SOP/human-error rendering.
- 29-entry admin route map with parent fallback.
- `?` shortcut and shell button.
- Merchant 16-route help map and separate M/D chapter content.
- Guide search entry point.
- Checkout help separate from admin/merchant guide content.

### Partial

- Effective admin help coverage is 31/37 routes; six routes fall back to "no chapter".
- Mapping titles are English-only.
- `PageHeader` help props are implemented but unused.
- Merchant help is mapped for all 16 routes, but its content is still the 10+5 chapter baseline, not guide v2.

### Missing / deferred

- No full 23-screen context map, safeguard cards, playbook or read tracking from guide v2.
- No admin UI to author per-rail checkout help guides.
- No localized mapping titles.
- No page-level help button wiring beyond the shell.

### Known bugs / risks

- **Content bug:** 9.4 under Book 7 breaks the Merchants/MerchantDetail admin help and misorders Book 7.
- **Coverage gap:** AdminUsers, AdminUserDetail, AuditLog, PricingControls, AdminPlatformSettings and SystemBackups have no help chapter.
- **Dead UI:** `PageHeader`'s help props are unused, so a page cannot request a different chapter than the shell route map supplies.
- **Localization gap:** Arabic mode still shows the English mapping title.
- **Future-doc risk:** the guide v2 context map must not be presented as current.

## 8. Verification and tests

- `admin-front/src/content/__tests__/content-completeness.test.ts` verifies book/chapter content shape and depth, but it does not assert that every `GUIDE_ROUTE_HELP` entry resolves. That is why the 9.4 bug can pass.
- `tests/e2e/admin/global-search.spec.ts` checks the shell search split between records and guide search.
- `tests/e2e/checkout/pay.spec.ts` checks the payer surface; checkout help behavior is covered in the checkout help part.
- `core-back/test/guides-support.test.ts` verifies the checkout support setting and per-rail help guide seeding.

The content test and `guides-support` test require Bun; the latter requires PostgreSQL/Redis. Playwright requires the live stack.

## 9. Source references

### Old design sections

- `design/07-guides-and-academy/complete_zero_to_hero_guides_and_academy_specification.md` — implemented four-surface help model and merchant guide chapters.
- `design/90-archive/superseded-ui/portal_ui_abstraction_and_modern_fintech_redesign.md` — 560 px drawer intent.
- `design/07-guides-and-academy/guide_system_design_and_content.md` — future context-map/safeguard workstream.

### Code paths

- `admin-front/src/components/guide/ContextualHelpDrawer.tsx`
- `admin-front/src/components/guide/GlobalGuideSearchModal.tsx`
- `admin-front/src/components/ui/PageHeader.tsx`
- `admin-front/src/layouts/default.tsx`
- `admin-front/src/content/guide/index.ts`
- `admin-front/src/content/guide/booksPart2.ts`
- `merchant-front/src/components/guide/ContextualHelpDrawer.tsx`
- `merchant-front/src/layouts/default.tsx`
- `checkout-front/src/components/help/CheckoutHelpDrawer.tsx`
- `checkout-front/src/components/help/PerRailInstructionsBanner.tsx`
- `core-back/api/internal/checkout.ts`
- `core-back/prisma/seedGuides.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical contextual-help part. Records the 29-entry admin map, six missing effective mappings, unused PageHeader help props, the 9.4-under-Book-7 bug, the merchant map, and the separation from checkout help.

## Backups Settings and Operations

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part owns the admin operational pages that are neither the primary merchant/payment queues nor the guide:

- Backup management at `/system/backups`.
- Platform settings versioning and restore at `/settings/platform`.
- Checkout support configuration, history and diff at `/settings/checkout-help`.
- Academy reporting and certification exports at `/academy`.
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

The academy page is covered functionally in `03-guide-and-academy.md`. Its operational reporting surface uses:

| Operation | Endpoint | Authority |
| :--- | :--- | :--- |
| Summary | `GET v1/admin/academy/progress/overview/summary` | `user:read` |
| Summary export | `GET v1/admin/academy/progress/overview/summary/export` | `user:read` |
| Team overview | `GET v1/admin/academy/progress/overview` | `user:read` |
| Certification export | `GET v1/admin/academy/progress/overview/export` | `user:read` |
| Own progress | `GET/PUT v1/admin/academy/progress` | authenticated user |

The summary reports total users, users with progress, not started, completed modules/lessons/labs, earned badges, quiz scores, active last 7 days and counts by role. The team accordion loads on demand, searches by email/role, and shows completion percentage, module count, badges and last update.

Both exports require the team export checklist (`TEAM_SCOPE_VERIFIED`, `PRIVACY_REVIEWED`, `PROGRESS_DATA_REVIEWED`, `EXPORT_APPROVAL_CONFIRMED`) when checklists are visible. The backend accepts only the known checklist keys and writes `ACADEMY_SUMMARY_EXPORTED` or `ACADEMY_CERTIFICATIONS_EXPORTED`.

The route has no UI authority gate. The self-progress calls succeed for any authenticated admin; the team/report calls fail without `user:read`.

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
| Academy page | none | self: authenticated; team: `user:read` | self: authenticated |
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
8. **Academy exports require `user:read` and write audit entries.**
9. **All spreadsheet exports use the shared XLSX pipeline.**
10. **Runtime visibility flags override build-time flags.**

## 5. Data / API / config / deployment surface

| Surface | Location |
| :--- | :--- |
| Backup page | `admin-front/src/pages/system/backups/index.tsx` |
| Platform settings page | `admin-front/src/pages/settings/platform/index.tsx` |
| Checkout help page | `admin-front/src/pages/settings/checkout-help/index.tsx` |
| Academy page | `admin-front/src/pages/academy/index.tsx` |
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
- Export academy reports: complete the team export checklist first; confirm the backend authority before blaming the button.

## 7. Status and deviations

### Implemented

- Backup health, WAL lag, targets, backup history, drill verification, trigger, drill and policy UI.
- Backup policy maker-checker execution through the approvals queue.
- Platform settings list, version history, diff, backup export, restore preview/apply, summary and summary export.
- Checkout support config, live preview, version history, diff, summary and summary export.
- Academy summary, team view, certification export and summary export.
- Shared XLSX and checklist behavior.

### Partial

- The backup page does not hand the operator into the specific pending approval after a policy save.
- `BACKUP_POLICY` is missing from the shared approvals subject-type filter options, even though the backend supports it.
- Platform settings and checkout support are versioned/audited but not maker-checker.
- The route-level UI gates for platform settings, checkout help and academy are absent.
- Academy mastery is not server-validated; certification is a computed badge.

### Missing / deferred

- No immutable certificate registry or re-certification cycle.
- No backup catalog browser beyond the latest-30 history.
- No direct restore-from-backup UI; only restore drills.
- No schedule editor validation preview for cron syntax beyond the five-field check.

### Known bugs / risks

- **Workflow gap:** a backup policy maker cannot continue directly to approval; the pending request must be found in the general approvals queue.
- **Filter gap:** the approvals subject filter cannot select `BACKUP_POLICY`.
- **Governance gap:** `sensitiveMakerChecker` hints on platform settings/checkout help fields do not produce a maker-checker approval.
- **Authorization risk:** direct navigation to settings/checkout help/academy is not blocked by the router; the page loads and then fails backend calls for unauthorized users.
- **Export scope risk:** table exports are current-page only; do not treat them as full-result exports.
- **Documentation gap:** historical design claims about weekly drills/hourly Redis/ready-to-run backup certificates are superseded by the storage/backup parts.

## 8. Verification and tests

- `tests/e2e/admin/backups.spec.ts` mocks the backup overview and verifies the rendered health/schedule/drill state and the trigger request payload.
- `core-back/test/backup-admin/backup-admin-routes.test.ts` covers backup route authority, trigger/drill/policy behavior and audit entries.
- `admin-front/src/content/__tests__/content-completeness.test.ts` covers the academy content counts used by the reporting page.
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
- `admin-front/src/pages/academy/index.tsx`
- `admin-front/src/utils/xlsx/**`
- `admin-front/src/components/ui/SummaryExportCard.tsx`
- `admin-front/src/components/ui/FormChecklist.tsx`
- `core-back/api/internal/backups.ts`
- `core-back/api/internal/admin.ts` (settings and academy handlers)
- `core-back/lib/approvalQueue.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03 — Initial canonical operations part. Records backup/target/drill/policy behavior, settings versioning/restore, checkout-support history/diff, academy reporting, export/checklist behavior, and the authority/workflow gaps.

## Security hardening (2026-11-05)

Backups page: actions are disabled unless backups are configured and the daemon is reachable; a full backup of all targets needs an extra confirmation; trigger and drill send an `Idempotency-Key` header (required by admin-back); policy form validation mirrors the edge rules (cron, minimum gaps, retention floors); server error text is sanitized and clipped.
