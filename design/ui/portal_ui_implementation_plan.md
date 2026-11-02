# Portal UI Abstraction & Modern FinTech Redesign — Execution Plan

**Status:** Approved for implementation  
**Source blueprint:** `design/ui/portal_ui_abstraction_and_modern_fintech_redesign.md`  
**Execution date:** 2026-11-02  
**Working branch:** `master`

## 0. Locked decisions

The implementation follows the blueprint's visual intent and architecture, with the following corrections agreed before execution:

1. **Typography follows the blueprint.**
   - English/LTR: Plus Jakarta Sans.
   - Arabic/RTL: Cairo.
   - References, IDs, hashes, IBANs, CIDRs and code: JetBrains Mono.
   - All fonts remain self-hosted and CSP-safe; no Google Fonts, unpkg, or external CDN requests.
   - The existing unused Plus Jakarta Sans and Cairo TTF assets are adopted. JetBrains Mono is vendored locally as WOFF2.
2. **Rollout covers all three browser portals.**
   - `admin-front` is the primary target.
   - `merchant-front` and `checkout-front` receive the shared tokens and primitives.
   - `fake-rails-front` is out of scope for this redesign.
3. **Blueprint defects are corrected rather than copied verbatim.**
   - The blueprint says “14 primitives” but lists 13 named components. The 14th deliverable is the unified table/filter surface; the compliance test checks the 13 named exports plus the table components.
   - The blueprint's `dc({ name, props, setup })` examples do not match the installed `kt-dc` API. Components are implemented with valid Vue/`kt-dc` patterns and explicit Vuetify imports.
   - The blueprint's Vitest test uses `__dirname` in ESM and scans page-local component files as if they were pages. The corrected test uses ESM-safe paths and distinguishes route pages from page-local components.
   - `MoneyDisplay` must respect the repository's `CURRENCY_PRECISION`; LYD stays at 3 decimals, USD/EUR at 2, etc.
   - `StatusBadge` uses the blueprint's `danger` tone, not the legacy `error` tone. Legacy call sites are adapted or migrated.
4. **The test harness is repaired as part of the work.**
   - `tests/node_modules` is installed.
   - Playwright uses an environment override or the installed Playwright Chromium rather than the nonexistent `/usr/bin/google-chrome-stable`.

## 1. Repository reality check

The blueprint's page map is stale. Actual counts:

| Area | Count |
|---|---:|
| Admin route page entries | 36 |
| Merchant page entries (portal + public/POS) | 20 |
| Checkout page entries | 2 |
| Admin raw `VDialog` in pages | 51 |
| Admin raw `VChip` in pages | 55 |
| Admin raw `VCard` in pages | 244 |
| Admin raw `VTextField` in pages | 117 |
| Merchant raw `VDialog` in pages | 14 |
| Merchant raw `VCard` in pages | 49 |
| Merchant raw `VTextField` in pages | 71 |
| Checkout raw `VCard` in pay page | 7 |

The blueprint lists `credential-sets`, `commission-profiles`, and `velocity-rules` pages that do not exist in the current admin router. Their intent maps to the existing `finance/pricing` page and existing merchant credential pages. No new product routes, backend endpoints, database tables, or permissions are introduced by this redesign.

Existing constraints that must remain intact:

- `ApiTable` is used by 21 admin pages.
- Merchant `DataTable` is used by 12 merchant pages.
- All 36 admin pages already use the legacy `PageHeader`; it is extended rather than duplicated.
- Runtime flags for checklists, help panels, and snapshot export checklists must not change.
- XLSX export behavior and server filtering/sorting/pagination must not regress.
- Shell tests depend on `.pg-app-bar`, `.pg-drawer`, `.pg-page`, skip-link, RTL direction, and no `#app` transform.
- No backend or Prisma changes are part of this work.

## 2. Phase UI-1 — Design tokens, fonts, global stylesheet, Vuetify defaults

### 2.1 Fonts

Files:

- `admin-front/src/assets/fonts/fonts.css`
- `admin-front/src/assets/fonts/*`
- `admin-front/src/styles/settings.scss`
- `admin-front/src/styles/globals/app.scss`
- `admin-front/src/main.ts`
- mirrored copies in `merchant-front` and `checkout-front`

Actions:

1. Replace the IBM Plex `@font-face` rules with local declarations for:
   - Plus Jakarta Sans (variable/static TTF already present).
   - Cairo (static TTF already present).
   - JetBrains Mono (new local WOFF2 files).
2. Use `font-display: swap`.
3. Update the global wildcard font stack and RTL stack.
4. Update Vuetify Sass `$body-font-family`.
5. Remove the unused `@fontsource/roboto` and `unplugin-fonts` dependencies if no source references remain.
6. Keep `assetsInlineLimit: 0` in every Vite config so font files remain external, cacheable files and CSP-safe.

### 2.2 Token stylesheet

Create `admin-front/src/styles/fintech-minimal.css` from the blueprint, with:

- Light and dark surface/ink/border/status tokens.
- Radius and shadow tokens.
- Sans LTR, sans RTL and mono font tokens.
- Global background, body font, tabular numerals and LTR mono rules.
- Vuetify card, button, table, input and dialog overrides.
- Unified table rules (`pg-unified-table`).
- RTL overrides for Arabic typography and table headers.

Import order must be:

1. Vuetify base styles.
2. Legacy `app.scss`.
3. `fintech-minimal.css`.

### 2.3 Vuetify defaults

Update `src/plugins/vuetify.ts`:

- Light and dark palettes from the blueprint.
- Flat global ripple.
- Compact outlined inputs with `hideDetails: "auto"`.
- Flat cards, 36px buttons, no text transform.
- Dialog scrim.
- Keep MDI and custom icon sets.
- Keep locale/RTL wiring.

Validation: all three frontends typecheck and build; no external font requests; Arabic and English render with the correct families.

## 3. Phase UI-2 — Shared primitives and unified table surface

### 3.1 Primitives

Create `src/components/ui/`:

- `PageHeader.tsx`
- `StatusBadge.tsx`
- `MoneyDisplay.tsx`
- `MonoRef.tsx`
- `MetricStrip.tsx`
- `SurfaceCard.tsx`
- `FormModal.tsx`
- `FormField.tsx`
- `SlideOverDrawer.tsx`
- `DescriptionList.tsx`
- `SegmentedTabs.tsx`
- `EmptyState.tsx`
- `JsonDiffViewer.tsx`
- `index.ts`

Implementation rules:

- Use the installed Vue/`kt-dc` patterns; no unsupported object-form `dc` calls.
- Import Vuetify components explicitly in every TSX file.
- Keep props typed and slots explicit.
- `PageHeader` supports title, subtitle, badge/tone, breadcrumbs, help chapter, action slot and a transitional `end` render prop while pages migrate.
- `StatusBadge` maps all current domain statuses, including gateway inquiry statuses, AML, approvals, reconciliation and finance states.
- `MoneyDisplay` splits integer/fraction visually, forces LTR, and derives precision from `currencyPrecision`.
- `MonoRef` copies to clipboard with a safe fallback and forces LTR.
- `FormModal` uses `modelValue`/`update:modelValue`, sticky header/footer, loading lock, scrim/Escape close, optional danger mode and error banner.
- `FormField` renders a static top label, required marker, hint and optional “Four-Eyes Required” tag.
- `SlideOverDrawer` uses a right-side temporary `VNavigationDrawer` with sticky header/footer.
- `DescriptionList` supports 1/2 columns, mono/money values and hairline rows.
- `SegmentedTabs` is keyboard-accessible.
- `EmptyState` provides icon, title, description and optional action.
- `JsonDiffViewer` supports JSON patch operations and before/after object pairs.

### 3.2 Table stack

Refactor:

- `TableFilters.tsx`
- `Table.tsx`
- `DataTable.tsx`
- `ApiTable.tsx`
- `HeaderFooter.tsx`
- `statusTone.ts`

Rules:

- Remove the gradient filter panel.
- Remove full-row semantic background tints.
- Keep hover styling and a 2px critical/overdue marker only.
- Wrap search toolbar, filter toggle, filter grid, active-filter chips, table and pagination footer in one `SurfaceCard`-style hairline container.
- Preserve all server-side filtering, search, sort, pagination, session persistence, refresh hooks, row action and XLSX export behavior.
- Keep `.pg-unified-table` on the unified surface.

### 3.3 Compliance test

Create `src/components/ui/__tests__/ui-abstraction-compliance.test.ts` with:

- ESM-safe file paths.
- Page-entry detection that excludes public/auth pages and page-local `components/` files.
- Checks for all 13 primitive exports and the unified table components.
- Zero raw `VDialog` in page entries.
- Zero raw `VChip` in page entries.
- Zero raw `VCard` in page entries.
- `PageHeader` in every standard route page.
- No gradients in `PageHeader`, `TableFilters`, `Table` or legacy `Card`.
- No full-row `rowColor` tint application in `Table`.
- Add Vitest to admin-front and run it in `test:unit` alongside the existing Bun content tests.

## 4. Phase UI-3 — Application shell and authentication

### 4.1 Admin shell

Refactor `admin-front/src/layouts/default.tsx` and shell CSS:

- 248px permanent drawer.
- 56px frosted app bar.
- Hairline section groups and 34px nav items.
- Active item: surface, border, subtle shadow, semibold.
- Quick command pill (`Ctrl+K`).
- Bottom operator identity card: name/email, role badge, maker/checker indicators, logout.
- Breadcrumb trail in app bar.
- Ledger invariant pill using `financeInvariantCheck`, only for authorized users, with safe polling and failure suppression.
- Contextual SOP/help trigger.
- Locale and theme ghost icon buttons.
- Keep skip link, route loading bar, route error overlay, mobile drawer behavior and all `pg-*` test selectors.

### 4.2 Merchant shell

Apply the same 248/56 shell, tokens, group headers, active keycap state and operator card to `merchant-front/src/layouts/default.tsx`. Keep merchant-specific navigation and guide links. Do not add admin-only ledger/help features.

### 4.3 Auth

- Create `admin-front/src/layouts/auth.tsx` with a 45/55 split-screen institutional layout.
- Refactor admin login to use the auth layout, `FormField`, MFA step, caps-lock warning, redirect safety and locale controls.
- Apply the same visual treatment to merchant login/register, and align merchant landing/POS and checkout not-found surfaces to the token system where appropriate.

## 5. Phase UI-4 — Admin page refactor

All 36 route entries and page-local dialog components are migrated in batches.

### Batch A — core operations

- `pages/dashboard/index.tsx`
- `pages/gateways/index.tsx`
- `pages/gateways/wizard/[id].tsx`
- `pages/gateways/ai-import/index.tsx`
- `pages/rails/index.tsx`
- `pages/routes/index.tsx`
- `pages/finance/pricing/index.tsx`

### Batch B — onboarding, merchants, cases

- `pages/join-requests/index.tsx`
- `pages/join-requests/new.tsx`
- `pages/join-requests/[id].tsx`
- `pages/kyb/index.tsx`
- `pages/kyb/[id].tsx`
- `pages/kyb/components/**`
- `pages/merchants/index.tsx`
- `pages/merchants/[id].tsx`
- `pages/merchants/components/**`
- `pages/approvals/index.tsx`
- `pages/operator-cases/index.tsx`
- `pages/operator-cases/[id].tsx`
- `pages/operator-cases/inquiries/index.tsx`

### Batch C — money movement and finance

- `pages/disputes/index.tsx`
- `pages/adjustments/index.tsx`
- `pages/cashouts/index.tsx`
- `pages/reconciliation/index.tsx`
- `pages/finance/invariant/index.tsx`
- `pages/finance/profitability/index.tsx`
- `pages/finance/liquidity/index.tsx`

### Batch D — compliance

- `pages/aml/cases/index.tsx`
- `pages/aml/screenings/index.tsx`
- `pages/aml/rules/index.tsx`
- `pages/aml/reports/index.tsx`

### Batch E — administration and content

- `pages/users/index.tsx`
- `pages/users/[id].tsx`
- `pages/audit-logs/index.tsx`
- `pages/settings/platform/index.tsx`
- `pages/settings/checkout-help/index.tsx`
- `pages/guide/index.tsx`
- `pages/academy/index.tsx`

### Per-page transformation rules

1. Extend `PageHeader` with subtitle, badge and action slot.
2. Replace KPI card grids with `MetricStrip`.
3. Replace raw `VCard`/`VCardText` containers with `SurfaceCard`.
4. Replace raw `VDialog` and page-local dialogs with `FormModal`.
5. Wrap form controls in `FormField` with static labels.
6. Replace status chips with `StatusBadge`.
7. Replace formatted money strings with `MoneyDisplay`.
8. Replace IDs/references/hashes with `MonoRef`.
9. Replace detail field grids with `DescriptionList`.
10. Replace right-side/overlay detail panels with `SlideOverDrawer`.
11. Replace tab/period toggles with `SegmentedTabs`.
12. Replace empty states with `EmptyState`.
13. Replace approval/audit diffs with `JsonDiffViewer`.
14. Add English/Arabic strings to `i18nCatalogue.ts`.
15. Preserve authority checks, checklist flags, help panels, exports, and every API call.

Codemods may be used only for repetitive structural replacements; every diff is reviewed manually.

## 6. Phase UI-5 — Merchant and checkout rollout

### Merchant

- Mirror fonts, tokens, Vuetify defaults and `components/ui`.
- Refactor all 15 portal pages.
- Restyle public login/register/landing/POS/not-found.
- Use the unified table surface for the 12 merchant table pages.
- Add shared primitive consistency checks.
- Preserve merchant APIs, authority checks and exports.

### Checkout

- Import tokens and primitives.
- Refactor `pages/pay/[linkKey]/index.tsx` to use `MoneyDisplay` for amount/fee/total, `StatusBadge` for status, `MonoRef` for references and `FormField` for payer inputs.
- Keep the payer surface focused and free of admin chrome.
- Add a token-based not-found surface.

## 7. Phase UI-6 — Test, build, deploy, verify

### Harness

1. `cd tests && bun install`.
2. Replace hardcoded Chrome path in:
   - `tests/playwright.config.ts`
   - `tests/playwright.exhaustive.config.ts`
   - `tests/playwright.live.config.ts`
   with `PLAYWRIGHT_CHROME_PATH` or Playwright's bundled Chromium.
3. Confirm frontend `dist/` builds exist before preview tests.

### Commands

```bash
cd admin-front && bun run test:unit && bun run build
cd merchant-front && bun run test:unit && bun run build
cd checkout-front && bun run build
cd tests && bun run test:unit && bunx playwright test
cd tests && bunx playwright test -c playwright.exhaustive.config.ts
./deploy/deploy.sh --only=admin,merchant,checkout
```

### Manual browser verification

- 1440×900 and 390×844.
- EN/LTR and AR/RTL.
- Light and dark themes.
- Admin dashboard, table page, modal, drawer, approvals diff, operator cases, gateway inquiries, settings.
- Merchant dashboard, table page, onboarding, POS.
- Checkout pay page amount breakdown and form.
- No horizontal overflow, no external font/CDN requests, no CSP violations, no `#app` transform.
- Runtime checklist/help flags unchanged.
- XLSX export still works.

## 8. Definition of done

- All three frontends typecheck and build.
- `ui-abstraction-compliance` reports zero violations.
- No raw `VDialog`, `VChip` or `VCard` in admin page entries.
- No gradients or full-row tints in the table/header/card system.
- All admin and merchant portal pages use `PageHeader`.
- Checkout uses the shared money/status/form primitives.
- Playwright geometry suites pass at desktop/mobile, EN/AR, light/dark.
- Deploy succeeds and health checks pass.
- No backend, Prisma, migration, permission or runtime-flag behavior changes.

---

## 9. Implementation log (2026-11-02)

### 9.1 UI-1 — tokens, fonts, Vuetify

Completed:

- Adopted Plus Jakarta Sans for LTR, Cairo for RTL, and self-hosted JetBrains Mono.
- Renamed the existing Plus Jakarta/Cairo TTF assets to stable, meaningful filenames and added JetBrains Mono WOFF2 files.
- Replaced the IBM Plex font declarations and removed the unused IBM Plex assets.
- Removed `@fontsource/roboto` and `unplugin-fonts` from all three frontends.
- Added `src/styles/fintech-minimal.css` to admin, merchant and checkout.
- Updated `settings.scss`, global `app.scss`, `printJsx`, `main.ts`, and `plugins/vuetify.ts` in all three frontends.
- No external font/CDN references remain.

### 9.2 UI-2 — primitives and tables

Completed:

- Added the 13 named primitives plus the unified table surface:
  - `PageHeader`, `StatusBadge`, `MoneyDisplay`, `MonoRef`, `MetricStrip`, `SurfaceCard`, `FormModal`, `FormField`, `SlideOverDrawer`, `DescriptionList`, `SegmentedTabs`, `EmptyState`, `JsonDiffViewer`.
  - `MetaPill` for non-status metadata chips.
  - `SurfaceCardText` compatibility body for the mechanical card migration.
- Corrected the blueprint's invalid `dc({ setup })` examples to valid Vue/`kt-dc` component patterns.
- `MoneyDisplay` derives precision from `currencyPrecision`; LYD remains 3 decimals.
- `StatusBadge` covers the domain statuses used by the portal, including gateway inquiry, AML, approval, reconciliation and finance states.
- Reworked `StatusChip` and `MoneyText` into compatibility wrappers over the new primitives so the migration did not break existing pages.
- Removed gradients, zebra stripes and full-row semantic tints from the table stack.
- Added the corrected compliance test at `admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts`.
- Added Vitest to admin-front; `bun run test:unit` now runs the Bun content tests and the Vitest compliance gate.
- Synced the corrected table, card, page-header and primitive files to merchant/checkout.

### 9.3 UI-3 — shell and auth

Completed:

- Admin shell: 248px drawer, 56px app bar, keycap active nav state, section groups, command search pill, operator card, breadcrumbs, live ledger invariant pill, contextual help, locale and theme controls.
- Merchant shell: 248px/56px equivalent with merchant guide search and operator card.
- Admin auth: split-screen `AuthLayout`, static `FormField` labels, MFA, caps-lock warning, redirect safety and locale controls.
- Merchant auth: split-screen `AuthLayout`, static `FormField` labels, MFA, Google login/register flow preserved.
- Removed all landing/auth/POS/checkout gradients and replaced them with token surfaces.

### 9.4 UI-4 — admin pages

Completed mechanically and then deepened:

- All 36 admin route entries were migrated off raw `VCard`, `VDialog` and `VChip`.
- All route pages use `PageHeader`.
- Deep refactors added:
  - `MetricStrip` across dashboard, gateways, rails, routes, pricing, approvals, operator cases, AML, finance, users and merchant summaries.
  - `SegmentedTabs` on dashboard periods, merchant dashboard periods, pricing, approvals, merchant detail, KYB, reconciliation and queue views.
  - `MonoRef` for IDs, references, hashes, link keys and provider references.
  - `DescriptionList` for detail field groups in onboarding, merchant, KYB, approvals, operator cases and finance/AML panels.
  - `SlideOverDrawer` for join request, merchant, approval and operator case inspection.
  - `JsonDiffViewer` in approvals and audit log detail.
  - `EmptyState` in empty queue/activity/document panels.
  - `PageHeader` subtitles and badges on all major route families.
- Added English/Arabic catalogue entries for the new strings.

### 9.5 UI-5 — merchant and checkout

Completed:

- Merchant portal and public/auth pages receive the shared tokens, primitives, shell and table surface.
- Merchant auth pages use the split-screen `AuthLayout`.
- Merchant dashboard now uses `MetricStrip`, `SegmentedTabs`, `MoneyDisplay`, `StatusBadge` and `MonoRef`.
- Checkout payer surface uses `SurfaceCard`, `MoneyDisplay`, `MonoRef`, `StatusBadge`, and `FormField` static labels in rail fields/OTP.
- Checkout keeps the focused payer layout and has no admin chrome.

### 9.6 UI-6 — verification

Passed:

- `admin-front`: typecheck, compliance Vitest suite and production build.
- `merchant-front`: typecheck and production build.
- `checkout-front`: typecheck and production build.
- Root Vitest suite: 17/17.
- Standard Playwright suite: 46/46.
- Exhaustive Playwright matrix: 474 passed, 4 live-only tests skipped.
- Browser geometry verified at desktop/phone, EN/AR, light/dark through the exhaustive matrix.
- No horizontal overflow, no `#app` transform, no external font/CDN requests.

Test harness corrections:

- Installed `tests/node_modules`.
- Replaced the hardcoded `/usr/bin/google-chrome-stable` path with `PLAYWRIGHT_CHROME_PATH` or Playwright's bundled Chromium.
- On this workstation the bundled Chromium requires:
  `LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu`.
- Updated geometry thresholds for the blueprint's 248px drawer.
- Updated tests whose old expectations no longer matched the current product surfaces:
  - gateway name label,
  - merchant sensitive-change flow,
  - inquiry checklist conditional when checklists are hidden,
  - password label exact matching,
  - subtle typographic tracking.

### 9.7 Documented blueprint corrections

- The blueprint claims 14 primitives but names 13; the 14th deliverable is the unified table surface.
- The blueprint's `dc` examples are not valid for the installed `kt-dc`; implemented with valid Vue/`kt-dc` patterns.
- The blueprint's Vitest gate used ESM-incompatible `__dirname` and scanned page-local components as pages; corrected.
- `MoneyDisplay` cannot hardcode 3 decimals; it uses the repository's multi-currency precision.
- The blueprint's page map references `credential-sets`, `commission-profiles` and `velocity-rules` pages that do not exist; the design intent was mapped to the existing `finance/pricing` page and merchant credential pages. No product routes/APIs were invented.
- `StatusBadge` uses `danger`; legacy `error` tones are mapped.

### 9.8 Remaining operational step

- Deploy the three frontends and verify the live runtime configuration, CSP/font loading, checklists/help flags and XLSX exports.
