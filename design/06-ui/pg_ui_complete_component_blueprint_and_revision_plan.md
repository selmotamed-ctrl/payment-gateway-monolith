# `@pg/ui` — Complete 2026 Fintech Component Blueprint, Forensic Audit & Full-Platform Revision Plan

**Repository Branch:** `payment-gateway-monolith-vael-ui-migration` (Vue `3.6.0-rc.16` Pure Vapor Mode + `vue-jsx({ vapor: true })`)

**Audited Live Deployment:** `https://admin-pg-dev.duckdns.org` (Login, Dashboard, Merchants, Transactions, Reports Catalog, Guide Search Palette, Context Help Drawer, Toasts, Tables, Filters, Date Pickers)

**Scope:** **Every single one of the 69 files in `packages/ui/src/` + extracted `PgChart` suite + all 4 frontends (`admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front`) across 154 pages.**

**Consumer:** `OpenCode` — **Zero guesswork, zero shortcuts, zero unverified components.**

## PART 1 — 2026 FINTECH DESIGN PHILOSOPHY, SPATIAL RHYTHM & MASTER TOKEN ARCHITECTURE

### 1.1 Why This Blueprint Exists

A payment gateway handles real people's money, KYB legal compliance, double-entry ledger invariants, and bank settlements. Every visual defect—a clipped export button, a checkbox that looks checked while disabled, a dead `Inspect` button, a `0px`-tall invisible chart, a stray `(` around page actions, an inner input focus box, or English text rendered backwards in `dir="rtl"`—destroys operator trust.

This document is the **binding, pixel-level visual and behavioral specification** for every component in `@pg/ui`. It defines:

1. **What is broken today** (verified from live browser inspection + static forensic audit of all 69 files in `packages/ui/src/`).
2. **How every component MUST look** (exact geometry, heights, paddings, gaps, borders, radii, typography, Light & Dark tokens, LTR & RTL mirroring, and every interactive state).
3. **How every component MUST behave** (every prop, default, slot, emit, click, right-click, hover, keyboard shortcut, and edge case).
4. **How `OpenCode` MUST prove satisfaction** (mandatory per-component automated test suites + full-platform sweep across all 4 frontends).

### 1.2 The Seven Non-Negotiable 2026 Fintech Aesthetic Principles

1. **Breathable, Calm Density (Mercury + Linear + Stripe):** Generous whitespace (`28px 36px 56px` page canvas padding, `28px` section rhythm, `24px` card/dialog body padding, `40px` form control height, `48px` table data rows). Never cram controls together with `0px` gaps.
2. **Neutral Focus Discipline (ZERO Blue Glow):** Every text field, search box, autocomplete, date picker, and textarea uses a **neutral obsidian focus border** (`#0f172a` Light / `#e4e4e7` Dark) with a subtle `3px` neutral halo (`var(--pg-focus-ring)`) painted strictly on the **outer `.pg-control-box`**. Inner native `<input>` / `<textarea>` elements NEVER draw their own border or outline. Colored focus rings are reserved exclusively for `error` validation states.
3. **Button Hierarchy Discipline (Not Everything Is Filled!):**
   * **1 Primary Filled Button** per screen/modal (`variant="primary"`) for the single most important action.
   * **Secondary / Outlined** (`variant="outlined"` / `variant="secondary"`) for peer actions (`Export`, `Refresh`, table primary `Inspect`).
   * **Ghost / Text** (`variant="ghost"` / `variant="text"`) for tertiary actions, icon buttons (`[...]`, `×`, `Theme`, `Language`), and inline table secondary actions.
   * **Danger** (`variant="danger"`) strictly for destructive/irreversible actions (`Suspend`, `Close`, `Delete`).
4. **100% Pure Vue 3.6 Vapor Native:** Zero VDOM `<Teleport>` from `'vue'`; every conditional overlay/menu/popover/dialog/drawer MUST use Vapor `createIf` from `@vue/runtime-vapor`; `dc.ts` MUST preserve `options.props` intact so defaults and reactivity never silently break.
5. **100% Native Ownership of Core Controls:** Zero fragile `vael-ui/vapor` wrappers for `PgCheckbox`, `PgSwitch`, `PgRadioGroup`, `PgFileUpload`, `PgAutocomplete`, `PgDateInput`, `PgTextField`, `PgDialog`, `PgMenu`, or `PgToast`. `@pg/ui` owns every pixel and every DOM event.
6. **True LTR/RTL Symmetry:** Default language is English (`<html lang="en" dir="ltr">`) unless Arabic (`ar` -> `dir="rtl"`) is explicitly chosen. Every component uses CSS logical properties (`padding-inline`, `margin-inline`, `inset-inline-start/end`, `border-inline-start/end`, `text-align: start/end`), while financial numbers, IDs, OTPs, and JSON remain `direction: ltr; unicode-bidi: isolate;`.
7. **Zero Unstyled Classes (100% CSS Coverage):** Every `.pg-*` class referenced in any `.tsx` file inside `packages/ui/src/` MUST have an explicit rule in `packages/ui/src/tokens/fintech-2026.css`, `layout-policy.css`, or `components.css`, verified automatically by CI.

### 1.3 2026 Fintech Architecture Upgrades (Stripe, Ramp, Mercury & Linear Standards)
1. **Strict Monochrome Restraint & Zero Blue Focus Glow:** Primary CTAs use `--pg-accent-primary` (`#0f172a` light / `#f4f4f5` dark) and focus rings use `--pg-border-focus` + `--pg-focus-ring` (neutral subtle slate halo — **NEVER** a blue or indigo focus glow!). Brand indigo (`--pg-accent-brand: #4f46e5`) is reserved strictly for active navigation indicators, links, selected calendar endpoints, and primary chart series.
2. **4-Step Dark Mode Elevation Ladder (Zinc Palette):** Dark mode MUST maintain 4 visually distinct surface steps so popovers and modals never bleed into cards:
   - Step 0 Canvas: `--pg-bg-canvas: #09090b`
   - Step 1 Card / Primary Table Surface: `--pg-bg-surface: #111114`
   - Step 2 Subtle / Sidebar / Table Header: `--pg-bg-surface-subtle: #18181d`
   - Step 3 Elevated Popovers / Menus / Dialogs / Date Pickers: `--pg-bg-elevated: #1e1e26` (upgraded from `#16161b` so floating layers sit clearly above `#18181d` subtle surfaces with `1px solid #2e2e36` hairline borders).
3. **Role-Calibrated Density Across the 4 Frontends:**
   - **`admin-front` & `merchant-front` (High-Density Ops):** Support user-persisted table density (`Compact 36px` vs `Comfortable 48px` stored in `localStorage['pg-table-density']`, keeping all checkboxes & action buttons `>= 24x24px` WCAG 2.2 hit targets), strictly right-aligned (`text-align: end`) numeric/monetary columns with `tabular-nums`, and a floating bottom **Bulk Selection Action Bar** (`N selected | Action | Export | Clear`) whenever rows are selected.
   - **`checkout-front` (Calm Customer Payment Flow):** Spacious, single-column focus (`max-width: 480px`), generous `24px–32px` card padding, unmistakable amount + currency + fee breakdown upfront, zero cluttered toolbars, and calm progressive disclosure for rail widgets (`OtpFormRenderer`, `QrOrCodeRenderer`, `PushOrTransferRenderer`).
4. **Keyboard-Typeable + Timezone-Explicit Date Pickers:** Both `PgDateInput` and `PgDateRangeInput` MUST allow direct keyboard typing (`YYYY-MM-DD` or `DD/MM/YYYY` with instant validation) alongside calendar clicking + presets, and `PgDateRangeInput` MUST display an explicit timezone badge (`UTC` or `Africa/Tripoli`) on financial ledger/settlement filters so reconciliation never suffers off-by-one-day ambiguity.
5. **Actionable Error Microcopy Standard:** Every `PgAlert`, `PgStateView`, and inline validation error MUST answer both *what happened* and *what the user can do next* (e.g., attaching a direct `Retry`, `Reset Filters`, or `Configure SMTP` action rather than dead-end text).

## PART 2 — SYSTEMIC GLOBAL ROOT CAUSES (MUST BE FIXED FIRST IN WAVE 1)

Before auditing individual components, `OpenCode` MUST apply these **6 platform-wide Wave 1 fixes** that resolve over 70% of the visible breakage across all 154 pages:

### 2.1 Wave 1 Fix A — Eliminate Global RTL Leak in English Mode

* Change `<html lang="ar" dir="rtl">` to `<html lang="en" dir="ltr">` in `admin-front/index.html`, `merchant-front/index.html`, and `checkout-front/index.html`.
* Update `getLocaleName()` in `admin-front/src/plugins/i18n.ts`, `merchant-front/src/plugins/i18n.ts`, and `checkout-front/src/plugins/i18n.ts` to default to `"en"` (`return stored === "ar" ? "ar" : "en"`).
* Sync `document.documentElement.dir` and `lang` reactively inside `packages/ui/src/lib/locale.ts`.

### 2.2 Wave 1 Fix B — Stop `dc.ts` From Stripping `options.props`

* In `packages/ui/src/lib/dc.ts` (lines 87 & 110), replace `const { props: _props, rerender, ...rest } = options;` with `const { rerender, ...rest } = options;` so declared `props` and their `default` values are preserved in `defineVaporComponent`.

> **CRITICAL `vue@3.6.0-rc.16` + `vue-jsx@3.3.0-rc.7` SAFETY PROTOCOL FOR `dc.ts`:** Do NOT blindly forward `options.props` into `defineVaporComponent` without verifying how `vue-jsx@3.3.0-rc.7` interacts with `inheritAttrs: true`. Resolve `options.props` defaults cleanly inside `renderSetup` (or via a dedicated `resolveProps(rawProps, propDefs)` helper) AND strip declared prop keys from fallthrough DOM attributes, then prove with a Vitest test that BOTH (a) `PgMonoRef` receives `copyable === true` by default and (b) non-prop attributes (`class`, `style`, `data-*`, `onClick`) still forward to the root element while object props (`items`, `primaryAction`) NEVER serialize as `[object Object]` on DOM nodes.

### 2.3 Wave 1 Fix C — Fix CSS Import Order & Global `:focus-visible` Leak

* Fix `packages/ui/src/tokens/index.css` order:
  1. `@import "vael-ui/style.css";`
  2. `@import "./fintech-2026.css";`
  3. `@import "./layout-policy.css";`
  4. `@import "./components.css";`
* Fix `packages/ui/src/tokens/components.css` lines 1030–1032 so `.pg-unified-table :focus-visible` and `.pg-table-filters :focus-visible` exclude `.pg-control-native` and `.pg-chk__native` (`:focus-visible:not(.pg-control-native):not(.pg-chk__native)`), guaranteeing the outer `.pg-control-box:focus-within` owns the focus ring.
* Add all **35 missing `.pg-*` CSS classes** discovered by our forensic audit (`pg-row-actions*`, `pg-toast__close`, `pg-toast__action`, `pg-toast__timer--paused`, `pg-json-editor__*`, `pg-metric-tile__head`, `pg-metric-loading`, `pg-control-adornment--start/end`, `pg-card--interactive`, `pg-field-item--interactive`, `pg-section-fields--split`, `pg-badge__label`, `pg-field--disabled`, `pg-sr-only`, `pg-json-diff`).

### 2.4 Wave 1 Fix D — Strip Stray `<PageHeader ...>(` and `)</PageHeader>` Across All 89 Corrupted Pages

* Run the automated codemod (`scripts/fix-stray-pageheader-parens.ts`) across `admin-front` (55 corrupted pages) and `merchant-front` (17 corrupted pages) to remove every literal `(` and `)` surrounding page header actions, and enforce a CI rule forbidding `>\s*\(\s*$` / `^\s*\)\s*</PageHeader>`.

### 2.5 Wave 1 Fix E — Replace All VDOM `<Teleport>` & Add Vapor `createIf` to All 6 Overlays

* Replace VDOM `<Teleport>` in `TableRowActions.tsx` and wrap conditional overlays in Vapor `createIf` across: `TableRowActions.tsx`, `PgAutocomplete.tsx`, `PgDateInput.tsx`, `PgMenu.tsx`, `PgTooltip.tsx`, and `TableFilters.tsx`.

### 2.6 Wave 1 Fix F — Extract Charts (`PgChart`, `PgStatChartCard`, `PgStatBarChartCard`) Into `@pg/ui` & Fix `0px` Height Bug

* Move `EChart`, `StatsChartCard`, and `StatsBarChartCard` into `packages/ui/src/charts/` with explicit `height` & `minHeight` (default `"260px"`), SVG renderer, `ResizeObserver`, and dark/light theme re-init, and delete the 3 duplicated `src/charts/` directories.

## PART 3 — CORE RUNTIME, PROVIDER & SHARED UTILITIES BLUEPRINTS

### 3.1 `PgProvider`

* **Source File:** `packages/ui/src/provider/PgProvider.tsx`
* **Exported Symbols / Aliases:** `PgProvider, default`
* **Category:** Core Runtime & Root Provider
* **Purpose & Role in Platform:** Single application root wrapper mounted once in `App.tsx` across `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front`. Provides host config (`api`, `router`, `copyText`, `helpButton`), synchronizes active theme & locale onto `<html>`, and mounts the global `<PgToaster />` stack.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Locale/Direction Desync:** Currently passes `locale` to `ConfigProvider` without enforcing `document.documentElement` `dir` & `lang` synchronization, allowing English UI to render inside `dir='rtl'`.
* **Unneeded `vael-ui` Theme Override Drift:** Hardcodes hex strings (`#f4f4f5`, `#0f172a`) in JS instead of deriving from the single CSS token source (`fintech-2026.css`).
* **Fragile `vael-ui/vapor` Wrapper (`ConfigProvider`):** Leaks mismatched prop bindings and unmapped styles; must be owned natively in `@pg/ui` or strictly bridged.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Display `contents` wrapper (zero layout box of its own) so `<PgApp>` occupies exact `100vw × 100vh` without extra scroll wrappers.
* **Padding & Internal Gaps:** Zero margin/padding on the provider wrapper; global toast host sits fixed at `bottom: 24px; inset-inline-end: 24px`.
* **Borders, Radius & Elevation:** None on root wrapper; inherits `--pg-*` border tokens.
* **Typography & Numerals:** Applies `--pg-font-sans-ltr` (`Plus Jakarta Sans`) when `dir='ltr'` and `--pg-font-sans-rtl` (`Cairo`) when `dir='rtl'`.
* **Color & Surface Tokens (Light & Dark):** Sets `data-theme='light' | 'dark'` on `document.documentElement` synchronously before first paint to prevent theme flash.
* **RTL (Arabic) Visual Adaptation:** Sets `lang='ar' dir='rtl'` when locale is `'ar'`, and `lang='en' dir='ltr'` for `'en'` (default).

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default (Light LTR)** | `--pg-bg-canvas` (`#f7f8fa`) | N/A | `--pg-ink-primary` (`#0f172a`) | Instant on boot | 
| **Dark Mode** | `--pg-bg-canvas` (`#09090b`) | N/A | `--pg-ink-primary` (`#f4f4f5`) | 150ms color-scheme swap | 
| **Arabic RTL** | Mirrors logical inline properties | N/A | Cairo font family active | Instant `dir` switch | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `config` | `PgUiConfig` | `{}` | Host callbacks (`navigate`, `resolveHref`, `copyText`, `helpButton`, `apiBaseUrl`). Provided via Vue `provide()`. | 
| `initialTheme` | \`'system' | 'light' | 'dark'\` | 
| `initialLocale` | \`'en' | 'ar'\` | `'en'` | 

* **Slots:** `default` (entire portal application tree).
* **Emitted Events:** None (state managed via reactive theme/locale/toast stores).
* **Pointer & Click Behavior:**
  * Never intercepts pointer events; toast stack uses `pointer-events: none` on the container and `pointer-events: auto` on individual toast cards.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Preserves natural document focus order; never traps focus at root level.
* **Mandatory Edge Cases & Defensive Guards:**
  * SSR / test environment without `window` or `localStorage`: falls back safely to `light` + `en` (`ltr`) without throwing.
  * Multiple portals mounted in tests: cleans up global listeners on unmount.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgProvider.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Mounts with default props and asserts `document.documentElement.dir === 'ltr'` and `lang === 'en'`.
2. Switches locale to `'ar'` and asserts `dir === 'rtl'` and `lang === 'ar'`; switches back to `'en'` and asserts `dir === 'ltr'`.
3. Verifies `<PgToaster />` is mounted once and responds to `showToast()` calls.
4. Verifies `usePgUiConfig()` inside deeply nested child receives `config.copyText` and `config.navigate`.

### 3.2 `dc & defineComponent (Vapor Component Factory)`

* **Source File:** `packages/ui/src/lib/dc.ts`
* **Exported Symbols / Aliases:** `dc, defineComponent`
* **Category:** Core Runtime & Vapor Factory
* **Purpose & Role in Platform:** Unified Vapor component factory wrapping Vue 3.6's `defineVaporComponent` so every `@pg/ui` and portal component supports declared `props` with defaults, `emits`, `slots`, `expose`, and optional `rerender: true` DynamicFragment mode.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Strips `options.props` (Lines 87 & 110):** `const { props: _props, rerender, ...rest } = options;` deletes `props` before calling `defineVaporComponent`, breaking every default prop in `@pg/ui` (e.g., `PgMonoRef.copyable=true`, `TableRowActions.primaryAction`, `PgCheckbox.modelValue`) and leaking JS objects into DOM attributes!

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Non-visual runtime utility.
* **Padding & Internal Gaps:** N/A
* **Borders, Radius & Elevation:** N/A
* **Typography & Numerals:** N/A
* **Color & Surface Tokens (Light & Dark):** N/A
* **RTL (Arabic) Visual Adaptation:** N/A

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Standard Vapor Path** | Fine-grained DOM updates | No VDOM overhead | Declared `props` reactive | 0ms overhead | 
| **DynamicFragment (`rerender: true`)** | Re-evaluates top-level early returns | Clean branch disposal | No stale DOM nodes | Synchronous reactive patch | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `options.props` | \`Record<string, PropOptions> | string\[\]\` | `undefined` | 
| `options.emits` | \`string\[\] | Record<string, any>\` | `undefined` | 
| `options.inheritAttrs` | `boolean` | `true` | Controls whether undeclared attributes fall through to root element. | 
| `options.rerender` | `boolean` | `false` | Opt-in `DynamicFragment` wrapper for components with top-level conditional early returns. | 

* **Slots:** Forwards `options.slots` and `ctx.slots` intact.
* **Emitted Events:** Forwards `options.emits` and `ctx.emit` intact.
* **Pointer & Click Behavior:**
  * Non-visual; must never leak `onClick` or object props onto non-interactive wrapper elements unintentionally.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Preserves `attrs` ARIA attributes (`aria-label`, `role`, `tabindex`) cleanly.
* **Mandatory Edge Cases & Defensive Guards:**
  * Boolean prop with `default: true` omitted by caller MUST resolve to `true`, not `undefined`.
  * Object prop (`primaryAction`, `option`) declared in `options.props` MUST NOT appear in `ctx.attrs` or render as `primaryaction='[object Object]'` in DOM HTML.

#### D. Mandatory Automated Test Contract (`packages/ui/test/dc.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Component created with `dc(setup, { props: { copyable: { type: Boolean, default: true } } })` receives `props.copyable === true` when omitted.
2. Declared object prop `primaryAction` is accessible via `props.primaryAction` and is ABSENT from `ctx.attrs` and root DOM element attributes.
3. Component with `rerender: true` cleanly mounts and unmounts when a reactive `ref` flips from `false` to `true` and back.

### 3.3 `useLocale & Document Direction Engine`

* **Source File:** `packages/ui/src/lib/locale.ts`
* **Exported Symbols / Aliases:** `useLocale, t`
* **Category:** Core Runtime & Internationalization
* **Purpose & Role in Platform:** Provides reactive translation `t(key)`, active locale `current`, `isRtl` computed boolean, and guarantees `<html lang dir>` is ALWAYS synchronized with the active language across all 4 frontends.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — English Text Rendered Inside `dir='rtl'`:** `index.html` and `i18n.ts` default to `'ar'` (`dir='rtl'`), while `locale.ts` falls back to `'en'` when `useI18n()` fails in Vapor setup, causing catastrophic layout mirroring on every English screen.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Controls global document reading direction (`ltr` vs `rtl`).
* **Padding & Internal Gaps:** All `@pg/ui` components MUST use CSS logical properties (`margin-inline`, `padding-inline`, `inset-inline-start/end`, `border-inline-start/end`, `text-align: start/end`) so LTR and RTL mirror with 100% symmetry.
* **Borders, Radius & Elevation:** Logical borders (`border-inline-start` on toasts/alerts/active nav items).
* **Typography & Numerals:** Switches font family between `Plus Jakarta Sans` (EN) and `Cairo` (AR).
* **Color & Surface Tokens (Light & Dark):** N/A
* **RTL (Arabic) Visual Adaptation:** In `en`, `dir='ltr'`. In `ar`, `dir='rtl'`. Never mixed.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **English (Default)** | `lang='en' dir='ltr'` | Sidebar on LEFT | Standard LTR punctuation | Instant switch | 
| **Arabic** | `lang='ar' dir='rtl'` | Sidebar on RIGHT | Arabic RTL punctuation & Cairo font | Instant switch | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `localStorage['locale-name']` | \`'en' | 'ar'\` | `'en'` | 

* **Slots:** N/A
* **Emitted Events:** N/A
* **Pointer & Click Behavior:**
  * N/A
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * N/A
* **Mandatory Edge Cases & Defensive Guards:**
  * Missing translation key in `ar` catalogue: falls back gracefully to key string without breaking directionality.
  * Calling `t(undefined)` or `t(null)` returns `''` without throwing.

#### D. Mandatory Automated Test Contract (`packages/ui/test/locale.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Fresh `localStorage` boots in `en` + `dir='ltr'` across `admin-front`, `merchant-front`, and `checkout-front`.
2. Setting locale to `'ar'` updates `document.documentElement.dir` to `'rtl'` and `isRtl.value` to `true`.
3. Setting locale back to `'en'` updates `document.documentElement.dir` to `'ltr'` and `isRtl.value` to `false`.

### 3.4 `theme.ts (Theme Store & Persistence)`

* **Source File:** `packages/ui/src/lib/theme.ts`
* **Exported Symbols / Aliases:** `themeMode, resolvedTheme, setThemeMode, initTheme`
* **Category:** Core Runtime
* **Purpose & Role in Platform:** Synchronizes `system | light | dark` mode with `prefers-color-scheme` and sets `data-theme` on `<html>` before first paint.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Prop-Default & Token Audit Required:** Affected by `dc.ts` stripping `options.props`; verify every default prop, RTL logical spacing property, and dark-mode contrast token.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Follows `@pg/ui` 4px/8px spatial grid and responsive breakpoints (`sm < 640`, `md < 960`, `lg < 1280`, `xl >= 1280`).
* **Padding & Internal Gaps:** Uses `--pg-space-*` logical tokens exclusively (zero hardcoded pixels in callers).
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-subtle)` hairlines; `--pg-radius-sm` (8px) for controls, `--pg-radius-md` (12px) for surfaces.
* **Typography & Numerals:** `Plus Jakarta Sans` (LTR) / `Cairo` (RTL) / `JetBrains Mono` (code/IDs/money) with `tabular-nums`.
* **Color & Surface Tokens (Light & Dark):** 100% CSS custom properties (`--pg-*`) verified for WCAG AA >= 4.5:1 contrast in Light and Dark mode.
* **RTL (Arabic) Visual Adaptation:** 100% logical properties (`inline-start`/`inline-end`); numeric/code values isolated LTR.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface` | 1px `--pg-border-subtle` | `--pg-ink-primary` | 140ms ease | 
| **Hover / Active** | `--pg-bg-surface-hover` | 1px `--pg-border-strong` | `--pg-ink-primary` | 120ms ease | 
| **Focus-Visible** | Same | `var(--pg-focus-ring)` (neutral) | Same | 120ms ease | 
| **Disabled** | Opacity `0.45` | Same | `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `All declared props` | `Strictly typed` | `Explicit defaults` | Preserved intact by `dc.ts` and validated with unit tests. | 

* **Slots:** Documented named slots with Vapor `createSlot` / `slots.*?.()`.
* **Emitted Events:** Typed Vue emits; zero silent swallows.
* **Pointer & Click Behavior:**
  * Full hit-target area (`>= 32px`), `e.stopPropagation()` where nested inside clickable rows.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Full `Tab`, `Enter`, `Space`, and `Escape` WAI-ARIA 1.2 compliance.
* **Mandatory Edge Cases & Defensive Guards:**
  * Safe in SSR/jsdom tests without `window`; handles `null`/`undefined`/empty arrays gracefully.

#### D. Mandatory Automated Test Contract (`packages/ui/test/themets.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Verifies all exported symbols (`themeMode, resolvedTheme, setThemeMode, initTheme`) render cleanly in Light/Dark & LTR/RTL with zero console warnings.
2. Verifies every prop default, user interaction, and keyboard shortcut behaves exactly per blueprint.

### 3.5 `dom.ts (ClickOutside, Escape, ScrollLock, FocusTrap, Clipboard)`

* **Source File:** `packages/ui/src/lib/dom.ts`
* **Exported Symbols / Aliases:** `useClickOutside, useEscape, lockBodyScroll, useFocusTrap, copyToClipboard`
* **Category:** Core Runtime
* **Purpose & Role in Platform:** Reference-counted body scroll lock, capture-phase click-outside handler, modal focus trap with return-focus restoration, and secure/fallback clipboard copy.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Prop-Default & Token Audit Required:** Affected by `dc.ts` stripping `options.props`; verify every default prop, RTL logical spacing property, and dark-mode contrast token.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Follows `@pg/ui` 4px/8px spatial grid and responsive breakpoints (`sm < 640`, `md < 960`, `lg < 1280`, `xl >= 1280`).
* **Padding & Internal Gaps:** Uses `--pg-space-*` logical tokens exclusively (zero hardcoded pixels in callers).
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-subtle)` hairlines; `--pg-radius-sm` (8px) for controls, `--pg-radius-md` (12px) for surfaces.
* **Typography & Numerals:** `Plus Jakarta Sans` (LTR) / `Cairo` (RTL) / `JetBrains Mono` (code/IDs/money) with `tabular-nums`.
* **Color & Surface Tokens (Light & Dark):** 100% CSS custom properties (`--pg-*`) verified for WCAG AA >= 4.5:1 contrast in Light and Dark mode.
* **RTL (Arabic) Visual Adaptation:** 100% logical properties (`inline-start`/`inline-end`); numeric/code values isolated LTR.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface` | 1px `--pg-border-subtle` | `--pg-ink-primary` | 140ms ease | 
| **Hover / Active** | `--pg-bg-surface-hover` | 1px `--pg-border-strong` | `--pg-ink-primary` | 120ms ease | 
| **Focus-Visible** | Same | `var(--pg-focus-ring)` (neutral) | Same | 120ms ease | 
| **Disabled** | Opacity `0.45` | Same | `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `All declared props` | `Strictly typed` | `Explicit defaults` | Preserved intact by `dc.ts` and validated with unit tests. | 

* **Slots:** Documented named slots with Vapor `createSlot` / `slots.*?.()`.
* **Emitted Events:** Typed Vue emits; zero silent swallows.
* **Pointer & Click Behavior:**
  * Full hit-target area (`>= 32px`), `e.stopPropagation()` where nested inside clickable rows.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Full `Tab`, `Enter`, `Space`, and `Escape` WAI-ARIA 1.2 compliance.
* **Mandatory Edge Cases & Defensive Guards:**
  * Safe in SSR/jsdom tests without `window`; handles `null`/`undefined`/empty arrays gracefully.

#### D. Mandatory Automated Test Contract (`packages/ui/test/domts.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Verifies all exported symbols (`useClickOutside, useEscape, lockBodyScroll, useFocusTrap, copyToClipboard`) render cleanly in Light/Dark & LTR/RTL with zero console warnings.
2. Verifies every prop default, user interaction, and keyboard shortcut behaves exactly per blueprint.

### 3.6 `config.ts (`providePgUiConfig`&`usePgUiConfig`)`

* **Source File:** `packages/ui/src/lib/config.ts`
* **Canonical Exports:** `providePgUiConfig`, `usePgUiConfig`, `PgUiApiClient`, `PgUiConfig`
* **Role & Design Intent:** Dependency-injection bridge allowing `@pg/ui` data-fetching components (`PgApiTable`, `PgApiAutocomplete`, `PgSummaryExportCard`) to call each portal's authenticated HTTP client, router, and error reporter without coupling `@pg/ui` to app-specific Axios/fetch singletons.

#### Detected Gaps, Bugs & Audit Findings

1. Silent fallback returns `undefined` client when `PgProvider` is mounted outside a portal wrapper, causing `PgApiAutocomplete` and `PgApiTable` to throw unhandled TypeErrors on first search instead of a clear developer diagnostic.
2. Missing typed `onUnauthorized` and `localeHeader` hook so API calls inside shared table/autocomplete components do not propagate active `Accept-Language` or handle 401 session expiry gracefully.
3. **Forensic Audit — Missing CSS Classes:** `pg-ui-config` are referenced in `packages/ui/src/lib/config.ts` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Non-visual DI provider; influences loading/error states of all API-bound components.
* **Padding, Gaps & Rhythm:** N/A (runtime service).
* **Typography Scale & Numerals:** N/A.
* **Light Mode Palette:** N/A.
* **Dark Mode Palette:** N/A.
* **Interactive & Visual States:** Configured (valid `apiClient` + optional `router` + `onError`) vs. Unconfigured (emits explicit console warning in dev mode and renders `PgStateView` error state in API components instead of crashing).
* **LTR & RTL Directional Behavior:** Exposes reactive `getLocale()` so API requests send accurate `Accept-Language: ar` or `en` headers.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `config.apiClient`: Required `PgUiApiClient` (`get`, `post`, `delete` returning typed JSON with `AbortSignal` support).
  * `config.defaultPageSize`: Optional number (default `25`).
  * `config.currency`: Optional default ISO-4217 code (default `'LYD'`).
  * `config.onError`: Optional `(err: unknown, context: string) => void` hook wired to `showToast({ tone: 'danger' })`.
* **Emitted Events:**
  * None (Vue `provide`/`inject` symbol-keyed registry).
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Portal `main.ts` / `App.tsx` calls `providePgUiConfig(...)` once at root inside `PgProvider`.
  * Any nested `PgApiTable` or `PgApiAutocomplete` calls `usePgUiConfig()` and receives the exact client instance.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * Must support `AbortController` signal forwarding on every `apiClient.get(url, { params, signal })` so rapid typing in `PgApiAutocomplete` or quick filter toggles in `PgApiTable` cancel stale in-flight requests.
  * Must work cleanly in Vitest unit tests via a lightweight mock `providePgUiConfig({ apiClient: mockClient })`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `usePgUiConfig()` returns provided `apiClient` and `defaultPageSize` inside a child component.
- [ ] Unit test: Missing provider does not throw unhandled exception; returns safe fallback with dev warning.
- [ ] Unit test: `AbortSignal` is forwarded through `apiClient.get` without stripping.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 3.7 `display.ts (`useDisplay`&`useRtl`)`

* **Source File:** `packages/ui/src/lib/display.ts`
* **Canonical Exports:** `useDisplay`, `useRtl`
* **Role & Design Intent:** Reactive viewport breakpoint and text-direction composable driving responsive drawer behavior (`PgNavigationDrawer`), table column collapsing (`PgTable`), modal fullscreen transitions (`PgDialog`), and logical directional icons.

#### Detected Gaps, Bugs & Audit Findings

1. `useRtl()` currently reads static `document.documentElement.dir` at setup time instead of subscribing to the reactive locale store, causing RTL-aware icons (chevrons, back arrows, drawer anchor side) to stay inverted after switching languages.
2. Window `resize` listeners are not debounced via `requestAnimationFrame` or cleaned up on scope disposal (`onScopeDispose`), risking memory leaks during route transitions.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Non-visual responsive engine governing layout breakpoints across all 4 frontends.
* **Padding, Gaps & Rhythm:** Breakpoints: `xs` `<600px`, `sm` `600-959px`, `md` `960-1279px`, `lg` `1280-1919px`, `xl` `>=1920px`. `mobile` is true when `width < 960px`.
* **Typography Scale & Numerals:** N/A.
* **Light Mode Palette:** N/A.
* **Dark Mode Palette:** N/A.
* **Interactive & Visual States:** Reactive refs: `width`, `height`, `name`, `xs`, `sm`, `md`, `lg`, `xl`, `smAndDown`, `mdAndUp`, `mobile`, `isRtl`.
* **LTR & RTL Directional Behavior:** `useRtl().isRtl` MUST be a computed ref synced 1:1 with `useLocale().isRtl` and `document.documentElement.dir === 'rtl'`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * None (zero-argument composables).
* **Emitted Events:**
  * Reactive `window.resize` listener throttled via `requestAnimationFrame`.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Resizing viewport across `960px` threshold switches `PgNavigationDrawer` from permanent rail to temporary overlay drawer automatically.
  * Switching language in `PgThemeLanguageControls` flips `useRtl().isRtl.value` immediately without page reload.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * SSR / Vitest JSDOM safe: defaults to `1280x800` (`lg`, `mobile: false`) when `window` is undefined.
  * Listener is registered once as a shared singleton per window rather than N listeners for N mounted components.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: Viewport width `500px` sets `xs=true, mobile=true`; `1280px` sets `lg=true, mobile=false`.
- [ ] Unit test: Toggling locale from `en` to `ar` updates `useRtl().isRtl.value` from `false` to `true` reactively.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 3.8 `money.ts (Decimal-Safe Financial Math & Formatting)`

* **Source File:** `packages/ui/src/lib/money.ts`
* **Canonical Exports:** `CURRENCY_PRECISION`, `DEFAULT_CURRENCY`, `currencyPrecision`, `toDecimal`, `formatMoney`, `formatPlainNumber`, `toNumber`, `isZeroMoney`, `compareMoney`
* **Role & Design Intent:** Zero-float-drift monetary formatting and comparison library supporting 3-decimal Libyan Dinar (`LYD`, 1000 dirhams), 2-decimal USD/EUR/GBP, and 0-decimal JPY/KRW across every ledger table, KPI card, and checkout receipt.

#### Detected Gaps, Bugs & Audit Findings

1. `formatMoney` occasionally mixes Arabic-Indic digits (`٠١٢٣`) with Latin currency codes depending on browser `Intl.NumberFormat` locale defaults, breaking tabular column alignment in financial ledgers.
2. Negative monetary values in RTL mode can render the minus sign on the wrong side of the number when not wrapped in an explicit LTR isolate (`dir='ltr'` / `unicode-bidi: isolate`).

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Outputs formatted string tokens consumed by `PgMoneyText`, `PgMetricStrip`, and `PgTable` cells.
* **Padding, Gaps & Rhythm:** Single non-breaking space (`\u00A0`) between amount and currency code (`1,250.500 LYD`).
* **Typography Scale & Numerals:** Always rendered in Western Latin digits (`numberingSystem: 'latn'`) with `font-variant-numeric: tabular-nums` so decimal points align vertically in tables.
* **Light Mode Palette:** N/A (pure formatter; color applied by `PgMoneyText`).
* **Dark Mode Palette:** N/A.
* **Interactive & Visual States:** Positive (`1,250.000 LYD`), Signed Positive (`+1,250.000 LYD`), Negative (`-450.250 LYD`), Zero (`0.000 LYD`), Invalid/Null (`—`).
* **LTR & RTL Directional Behavior:** Amount + sign always formatted with `numberingSystem: 'latn'`; `PgMoneyText` applies `dir='ltr'` and `unicode-bidi: isolate` so `-450.250 LYD` never flips to `LYD 450.250-`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `amount`: `string | number | bigint | null | undefined` (supports minor units or decimal strings).
  * `currency`: ISO-4217 string (default `'LYD'`; `LYD/KWD/BHD/OMR/JOD/TND` = 3 decimals, `USD/EUR/GBP/SAR/AED` = 2 decimals, `JPY` = 0 decimals).
  * `options`: `{ showCurrency?: boolean; showSign?: boolean; compact?: boolean; locale?: string }`.
* **Emitted Events:**
  * None (pure functions).
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * `compareMoney(a, b)` sorts monetary strings accurately without IEEE-754 float precision loss.
  * `isZeroMoney('0.000')` returns `true` for `'0'`, `'0.00'`, `'0.000'`, `0`, `'-0.00'`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * Very large settlement amounts (`999,999,999,999.999 LYD`) must not lose precision via `Number()` truncation.
  * `null`, `undefined`, `''`, or `NaN` must return `'—'` cleanly, never `'NaN LYD'`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `formatMoney('1250.5', 'LYD')` -> `'1,250.500 LYD'` (3 decimals, Latin digits).
- [ ] Unit test: `formatMoney('-45.2', 'USD', { showSign: true })` -> `'-45.20 USD'`.
- [ ] Unit test: `formatMoney(null, 'LYD')` -> `'—'` and `isZeroMoney('0.000')` -> `true`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 3.9 `date.ts (ISO Date & Calendar Math)`

* **Source File:** `packages/ui/src/lib/date.ts`
* **Canonical Exports:** `toIsoDate`, `fromIsoDate`, `startOfDay`, `sameDay`
* **Role & Design Intent:** Timezone-safe local calendar date utilities preventing off-by-one UTC shift bugs when selecting dates in `PgDateInput`, `PgDateRangeInput`, and `PgTableFilters`.

#### Detected Gaps, Bugs & Audit Findings

1. `new Date('2026-11-26')` parses as UTC midnight, which shifts to `2026-11-25` in negative UTC offsets; `fromIsoDate` must strictly construct `new Date(year, month - 1, day)` in local time.
2. Missing helper for relative fintech range presets (`last7Days`, `last30Days`, `last90Days`, `monthToDate`, `quarterToDate`, `yearToDate`) needed by Dashboard and Report filters.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Non-visual utility powering `PgDateInput` and `PgDateRangeInput` calendar grids.
* **Padding, Gaps & Rhythm:** N/A.
* **Typography Scale & Numerals:** Strict `YYYY-MM-DD` ISO canonical wire format; display format localized per `useLocale()`.
* **Light Mode Palette:** N/A.
* **Dark Mode Palette:** N/A.
* **Interactive & Visual States:** Valid Date, Invalid Input (`null`), Boundary Month/Leap Year (`2028-02-29`).
* **LTR & RTL Directional Behavior:** Date math is calendar-agnostic; visual week grid alignment is handled in `PgDateInput`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `toIsoDate(d: Date | string | null)`: Returns `'YYYY-MM-DD'` or `''`.
  * `fromIsoDate(iso: string | null)`: Parses `'YYYY-MM-DD'` strictly into local midnight `Date` or `null`.
  * `startOfDay(d: Date)`: Zeroes hours/minutes/seconds/ms locally.
  * `sameDay(a: Date | null, b: Date | null)`: True iff year, month, and date match.
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Used by `PgDateInput` calendar grid to highlight today, selected date, and in-range hover spans without timezone drift.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * Rejects impossible calendar dates like `'2026-02-31'` (returns `null` instead of silently rolling over to March 3).
  * Handles leap years (`2024-02-29`, `2028-02-29`) accurately.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `fromIsoDate('2026-11-26')` round-trips through `toIsoDate()` to `'2026-11-26'` across any TZ.
- [ ] Unit test: `fromIsoDate('2026-02-31')` returns `null`.
- [ ] Unit test: `sameDay` returns `true` for same calendar date at `00:01` and `23:59`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 3.10 `options.ts (Option Normalization & Control Sizing)`

* **Source File:** `packages/ui/src/lib/options.ts`
* **Canonical Exports:** `normalizeOptions`, `sameValue`, `normalizeSize`, `controlSize`, `iconName`, `pick`, `PgOption`
* **Role & Design Intent:** Normalizes heterogeneous Vuetify-era option shapes (`string[]`, `{title, value}[]`, `{label, value}[]`, `{name, id}[]`) and maps legacy density/size props (`compact`, `comfortable`, `default`, `small`, `large`) into canonical `@pg/ui` tokens (`sm`, `md`, `lg`).

#### Detected Gaps, Bugs & Audit Findings

1. `sameValue(a, b)` fails when comparing numeric IDs (`123`) against URL-querystring string IDs (`'123'`) in `PgTableFilters` and `PgAutocomplete`, causing active filter selections to appear unselected after page refresh.
2. `iconName` occasionally passes raw unprefixed Material icons or `null` without safe fallback.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Maps size tokens to exact heights: `sm` = `32px`, `md` = `40px` (default), `lg` = `46px`.
* **Padding, Gaps & Rhythm:** Consistent vertical rhythm across `PgButton`, `PgTextField`, `PgAutocomplete`, `PgDateInput`, and `PgSearchInput`.
* **Typography Scale & Numerals:** N/A.
* **Light Mode Palette:** N/A.
* **Dark Mode Palette:** N/A.
* **Interactive & Visual States:** Normalized `PgOption`: `{ label: string; value: unknown; disabled?: boolean; description?: string; icon?: string; badge?: string; raw?: unknown }`.
* **LTR & RTL Directional Behavior:** N/A.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `normalizeOptions(items, itemTitle='title', itemValue='value')`: Accepts primitives or objects and returns uniform `PgOption[]`.
  * `sameValue(a, b)`: Deep-safe equality with optional strict/loose primitive matching.
  * `normalizeSize(size, density)`: Maps `compact`/`small`/`x-small` -> `'sm'`, `default`/`comfortable`/`medium` -> `'md'`, `large`/`x-large` -> `'lg'`.
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Called by `PgAutocomplete`, `PgApiAutocomplete`, `PgRadioGroup`, `PgSegmentedTabs`, and `PgTableFilters`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * Handles `null`/`undefined`/non-array `items` gracefully by returning `[]`.
  * Supports function-based `itemTitle: (item) => string` and `itemValue: (item) => unknown` just like Vuetify.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `normalizeOptions(['A', 'B'])` returns `[{label:'A',value:'A'}, {label:'B',value:'B'}]`.
- [ ] Unit test: `normalizeOptions` supports custom `itemTitle` and `itemValue` string keys and functions.
- [ ] Unit test: `normalizeSize(undefined, 'compact')` returns `'sm'`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 3.11 `rules.ts (Form Validation Engine)`

* **Source File:** `packages/ui/src/lib/rules.ts`
* **Canonical Exports:** `isEmpty`, `runRules`, `visibleError`
* **Role & Design Intent:** Synchronous Vuetify-compatible validation runner evaluating `Array<(v) => true | string>` rules on every form input (`PgTextField`, `PgTextarea`, `PgAutocomplete`, `PgDateInput`, `PgCheckbox`, `PgFileUpload`) and coordinating form-level submit blocking in `PgForm`.

#### Detected Gaps, Bugs & Audit Findings

1. `isEmpty` treats `0` or `false` inconsistently in some numeric/boolean fields, causing valid `0.00` fee inputs to fail required validation.
2. `visibleError` displays validation errors immediately on untouched fields when `errorMessages` is passed as an empty array `[undefined]`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Feeds the error message string into `PgFieldShell` bottom helper slot.
* **Padding, Gaps & Rhythm:** N/A.
* **Typography Scale & Numerals:** Error message renders at `12px`, `font-weight: 500`, `line-height: 1.35`.
* **Light Mode Palette:** Error text `#B91C1C` (`--pg-status-danger-text`).
* **Dark Mode Palette:** Error text `#FCA5A5` (`--pg-status-danger-text`).
* **Interactive & Visual States:** Pristine (hidden until touched or form submitted), Dirty Valid (no error), Dirty Invalid (first failing rule message shown).
* **LTR & RTL Directional Behavior:** Localized rule error messages align to inline-start.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `isEmpty(v)`: `true` for `null`, `undefined`, `''`, whitespace-only strings, and empty arrays `[]`; `false` for `0` and `false`.
  * `runRules(value, rules)`: Iterates rules in order, returns first string error or `null` if all return `true`.
  * `visibleError(explicitError, ruleError, touched, forceShow)`: Resolves the exact single error string to render.
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Runs on blur, on input after first error (eager recovery), and on `PgForm.validate()`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * Filters out `null`/`undefined`/`''` entries in `errorMessages` arrays.
  * Never throws if a rule returns `false` without a message (maps `false` to localized `'Invalid value'`).

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `isEmpty(0)` is `false`; `isEmpty('')` is `true`; `isEmpty([])` is `true`.
- [ ] Unit test: `runRules('', [v => !!v || 'Required'])` returns `'Required'`.
- [ ] Unit test: `visibleError` suppresses rule errors when `touched=false` and `forceShow=false`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 3.12 `status.ts (Status Humanizer & Semantic Tone Resolver)`

* **Source File:** `packages/ui/src/lib/status.ts`
* **Canonical Exports:** `formatHumanStatus`, `statusToTone`, `BadgeTone`
* **Role & Design Intent:** Single canonical mapping from backend enum strings (`SETTLED`, `PENDING_KYB`, `FAILED_INSUFFICIENT_FUNDS`, `SUSPENDED`, `CRITICAL`, `ACTIVE`, `DRAFT`) to human-readable labels and semantic color tones (`success`, `warning`, `danger`, `info`, `brand`, `neutral`).

#### Detected Gaps, Bugs & Audit Findings

1. Several critical/compliance statuses (`CRITICAL`, `HIGH_RISK`, `BLOCKED`, `REVOKED`) fall through to `neutral` in some views, resulting in low-contrast gray badges (like the unreadable `CRITICAL` badge observed in `ContextHelpDrawer`).
2. `formatHumanStatus` leaves acronyms like `KYB`, `KYC`, `AML`, `API`, `IBAN`, `LYD`, `PDF`, `OTP` awkwardly title-cased (`Kyb`, `Aml`).

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Maps every status string to one of 6 tones: `success`, `warning`, `danger`, `info`, `brand`, `neutral`.
* **Padding, Gaps & Rhythm:** N/A.
* **Typography Scale & Numerals:** Preserves uppercase fintech acronyms (`KYB`, `KYC`, `AML`, `API`, `OTP`, `3DS`, `SWIFT`, `IBAN`, `POS`, `QR`).
* **Light Mode Palette:** Each tone maps to WCAG AA >= 4.5:1 tinted pill background + dark semantic ink.
* **Dark Mode Palette:** Each tone maps to subtle translucent dark-surface tint + luminous semantic ink.
* **Interactive & Visual States:** 6 canonical tones + explicit `danger` mapping for `CRITICAL`, `FAILED`, `REJECTED`, `SUSPENDED`, `BLOCKED`, `EXPIRED`, `DISPUTED`, `CHARGEBACK`.
* **LTR & RTL Directional Behavior:** Works seamlessly alongside i18n translation keys before falling back to `formatHumanStatus`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `formatHumanStatus(raw: string | null | undefined)`: Converts `PENDING_KYB_REVIEW` -> `'Pending KYB Review'`.
  * `statusToTone(raw: string | null | undefined)`: Returns `BadgeTone`.
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Consumed by `PgStatusBadge`, `PgTable`, `statusTone.ts`, and `ContextHelpDrawer`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * Case-insensitive and delimiter-agnostic (`pending-kyb`, `PENDING_KYB`, `pending kyb` all resolve identically).
  * `null`/`undefined`/`''` returns `{ label: '—', tone: 'neutral' }`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `statusToTone('CRITICAL')` -> `'danger'`; `statusToTone('SETTLED')` -> `'success'`; `statusToTone('PENDING_KYB')` -> `'warning'`.
- [ ] Unit test: `formatHumanStatus('PENDING_KYB_API_CHECK')` -> `'Pending KYB API Check'`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

## PART 4 — LAYOUT, APP SHELL & CONTAINER SPACING BLUEPRINTS

### 4.1 `PgPageHeader`

* **Source File:** `packages/ui/src/layout/PgPageHeader.tsx`
* **Exported Symbols / Aliases:** `PgPageHeader, PageHeader, PgSubHeader, SubHeader, PgText, ThemedText`
* **Category:** Layout & Page Identity
* **Purpose & Role in Platform:** Top-of-page identity bar displaying optional breadcrumbs, primary `<h1>` title, optional status badge, plain-English subtitle, and right-aligned primary action buttons.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **72 Pages Corrupted with Literal `(` `)` Around Actions:** `<PageHeader ...>( ... )</PageHeader>` renders ugly stray parentheses around action buttons across 55 admin pages and 17 merchant pages.
* **Action Cluster Wrapping:** `.pg-page-header__actions` needs `gap: 10px; flex-wrap: wrap; flex-shrink: 0;` so buttons have breathing room and never clip.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Flex row (`justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;`).
* **Padding & Internal Gaps:** Zero outer margin (parent `PgPage` provides `28px` gap). Internal title-to-subtitle gap `6px`. Breadcrumbs bottom margin `8px`. Action buttons `gap: 10px`.
* **Borders, Radius & Elevation:** Optional subtle bottom hairline (`1px solid var(--pg-border-subtle)` with `padding-bottom: 18px`) on dense admin views.
* **Typography & Numerals:** `h1.pg-page-title`: `24px / 700 / 1.25 / letter-spacing: -0.02em / --pg-ink-primary`. Subtitle: `13.5px / 400 / 1.5 / --pg-ink-muted`.
* **Color & Surface Tokens (Light & Dark):** Transparent background over `--pg-bg-canvas`.
* **RTL (Arabic) Visual Adaptation:** Breadcrumb separators (`/`) and flex direction mirror automatically.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | Transparent | None | `--pg-ink-primary` title + `--pg-ink-muted` subtitle | N/A | 
| **With Status Badge** | Inline `PgStatusBadge` beside `<h1>` | Badge semantic border | Aligned to baseline | N/A | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `title` | `string` | `required` | Main `<h1>` heading text. | 
| `subtitle` | `string` | `''` | Concise secondary description beneath title. | 
| `badge` | `string` | `''` | Optional status code rendered as `PgStatusBadge`. | 
| `badgeTone` | `BadgeTone` | `'neutral'` | Semantic color tone for the badge. | 
| `breadcrumbs` | `PgBreadcrumb[]` | `[]` | Array of `{ label, to? }` navigation links. | 
| `helpChapterId` | `string` | `''` | Optional SOP chapter ID; renders an outlined `SOP & Help` button. | 

* **Slots:** `default` (action buttons), `help` (optional host help button).
* **Emitted Events:** None (navigation via `vue-router`).
* **Pointer & Click Behavior:**
  * Breadcrumb links navigate via `router.push` on click.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Breadcrumb `<nav aria-label='Breadcrumb'>` with `aria-current='page'` on final item.
* **Mandatory Edge Cases & Defensive Guards:**
  * Zero stray text nodes (`(` or `)`) allowed inside `<PageHeader>` default slot (enforced by CI governance test!).

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgPageHeader.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders `<h1>` title, subtitle, breadcrumbs with `aria-current='page'`, badge, and action slot buttons with `10px` gap.
2. CI audit asserts zero `<PageHeader ...>(` or `)</PageHeader>` occurrences across all 4 frontends.

### 4.2 `PgApp & PgMain (Root Application Shell Canvas)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgApp`, `VApp`, `PgMain`, `VMain`
* **Role & Design Intent:** Root viewport frame (`PgApp`) and scrollable main content canvas (`PgMain`) that coordinate fixed App Bar height (`60px`), collapsible Navigation Drawer width (`260px` expanded / `72px` rail), and smooth canvas background transitions.

#### Detected Gaps, Bugs & Audit Findings

1. `PgMain` lacks proper `min-width: 0` on its flex child, allowing wide `PgTable` components to blow out the viewport horizontally and push the page header off-screen.
2. Missing CSS custom property coordination (`--pg-appbar-h: 60px`, `--pg-drawer-w: 260px`), causing pages to hardcode top margins or overlap the sticky app bar.
3. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgApp` is a full-viewport flex column (`min-height: 100dvh`); `PgMain` occupies `flex: 1 1 auto; min-width: 0` with `padding-top: var(--pg-appbar-h)` when app bar is fixed.
* **Padding, Gaps & Rhythm:** App canvas background fills 100% viewport; inner content padding is delegated cleanly to `PgPage` (`24px` desktop, `16px` mobile) so there is zero double-padding.
* **Typography Scale & Numerals:** Sets root `font-family: var(--pg-font-sans)`, `font-size: 14px`, `line-height: 1.5`, `-webkit-font-smoothing: antialiased`.
* **Light Mode Palette:** Canvas `#F6F7F9` (`--pg-bg-canvas`), ink `#0F172A` (`--pg-ink-primary`).
* **Dark Mode Palette:** Canvas `#0B0F17` (`--pg-bg-canvas`), ink `#F1F5F9` (`--pg-ink-primary`).
* **Interactive & Visual States:** Desktop with permanent sidebar, Desktop with collapsed rail, Mobile with overlay drawer (`overflow-x: hidden` on `PgApp`).
* **LTR & RTL Directional Behavior:** Logical padding (`padding-inline-start`) mirrors sidebar offset automatically when `dir='rtl'`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgApp`: `class`, `style`, `theme` (optional override).
  * `PgMain`: `class`, `style`, `scrollable` (boolean, default `false` — uses document scroll by default).
* **Emitted Events:**
  * None.
* **Slots:**
  * `default`: Shell children (`PgAppBar`, `PgNavigationDrawer`, `PgMain`, `PgToaster`).
* **User Interactions & Click Behavior:**
  * Provides smooth `200ms cubic-bezier(0.2, 0, 0, 1)` margin transition when sidebar expands/collapses.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Supports skip-to-main-content anchor (`#pg-main-content`) for keyboard accessibility.
* **Edge Cases & Defensive Guards:**
  * Wide data tables inside `PgMain` scroll inside their own `.pg-table-scroll` container and NEVER cause horizontal page scrollbars.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `PgMain` renders `<main id='pg-main-content' class='pg-main'>` with `min-width: 0`.
- [ ] Playwright visual test: No horizontal document overflow (`scrollWidth <= clientWidth`) at `1280px` and `390px` viewports.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.3 `PgAppBar & PgAppBarTitle (Top Navigation Header)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgAppBar`, `VAppBar`, `PgAppBarTitle`, `VAppBarTitle`
* **Role & Design Intent:** Sticky `60px` frosted-glass top navigation bar hosting the mobile menu toggle, workspace/environment indicator (Live vs. Sandbox), global Command Palette trigger (`Cmd+K`), Context Help trigger, Language/Theme controls, and User Account menu.

#### Detected Gaps, Bugs & Audit Findings

1. Language menu inside `PgAppBar` is completely broken (clicking does nothing / unstyled) because `PgMenu` fails to toggle in Vapor without `createIf`.
2. Items inside `PgAppBar` lack uniform `gap: 8px` and vertical centering, causing icons and pills to crowd or misalign.
3. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Sticky top bar (`position: sticky; top: 0; z-index: var(--pg-z-header)`), height `60px`, `padding: 0 20px` (mobile `0 12px`), `display: flex; align-items: center; gap: 12px`.
* **Padding, Gaps & Rhythm:** Left cluster (sidebar toggle + brand/title + environment pill), Center/Flex spacer (`PgSpacer`), Right cluster (`gap: 8px` between search trigger, help button, language/theme menu, user avatar).
* **Typography Scale & Numerals:** `PgAppBarTitle`: `15px`, `font-weight: 600`, `letter-spacing: -0.01em`, single-line ellipsis truncation (`min-width: 0`).
* **Light Mode Palette:** `rgba(255, 255, 255, 0.88)` with `backdrop-filter: blur(12px)`, `border-bottom: 1px solid var(--pg-border-subtle)`.
* **Dark Mode Palette:** `rgba(15, 23, 42, 0.86)` with `backdrop-filter: blur(12px)`, `border-bottom: 1px solid var(--pg-border-subtle)`.
* **Interactive & Visual States:** Resting (flat hairline border), Scrolled (`--pg-shadow-xs` subtle elevation cue).
* **LTR & RTL Directional Behavior:** Flex row automatically reverses start/end clusters cleanly; brand on right, user controls on left.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `height`: number | string (default `60`).
  * `elevation`: number (default `0`, subtle border only).
  * `sticky`: boolean (default `true`).
  * `density`: `'default' | 'compact'`.
* **Emitted Events:**
  * None (delegated to child buttons/menus).
* **Slots:**
  * `prepend`, `default`, `append`.
* **User Interactions & Click Behavior:**
  * Clicking hamburger button toggles `PgNavigationDrawer`.
  * Clicking search pill opens `PgCommandPalette` (`Cmd+K` / `Ctrl+K`).
  * Clicking language button opens `PgMenu` cleanly aligned below the trigger without clipping off-screen.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Tab order flows naturally from start cluster to end cluster.
* **Edge Cases & Defensive Guards:**
  * Sandbox banner (`PgAlert`) renders cleanly directly beneath `PgAppBar` without overlapping dropdown menus.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `PgAppBar` renders `<header class='pg-app-bar'>` with `height: 60px` and `gap: 12px`.
- [ ] Playwright test: Clicking Language menu in `PgAppBar` opens dropdown, switches EN<->AR, and updates `document.documentElement.dir`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.4 `PgNavigationDrawer (Primary Sidebar Navigation)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgNavigationDrawer`, `VNavigationDrawer`
* **Role & Design Intent:** Persistent left (right in RTL) application navigation rail (`260px` wide) organized into scannable fintech operational groups (Overview, Operations, Merchants, Finance & Ledger, Risk & Compliance, Reports, System) with a pinned non-overlapping bottom user footer.

#### Detected Gaps, Bugs & Audit Findings

1. **Live Bug Observed:** Bottom navigation items (`Settings`, `Audit Logs`) are clipped behind the fixed user profile footer because the scrollable nav body lacks `flex: 1 1 auto; min-height: 0; overflow-y: auto` inside a flex column layout.
2. Active navigation item lacks a crisp left accent indicator bar and clear contrast separation in Dark Mode.
3. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** 3-zone vertical flex column (`display: flex; flex-direction: column; height: 100dvh`): (1) Brand Header (`60px`, `flex-shrink: 0`), (2) Scrollable Nav List (`flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 10px 24px`), (3) Pinned Footer (`flex-shrink: 0; border-top: 1px solid var(--pg-border-subtle); padding: 12px`).
* **Padding, Gaps & Rhythm:** Width `260px` (rail mode `72px`). Group subheaders: `margin: 16px 10px 6px`, `11px` uppercase `letter-spacing: 0.06em`. Nav items: `height: 36px`, `padding: 0 10px`, `gap: 10px`, `border-radius: 8px`, `margin-bottom: 2px`.
* **Typography Scale & Numerals:** Nav item: `13.5px`, `font-weight: 500` (active: `600`). Subheader: `11px`, `font-weight: 600`, `--pg-ink-faint`.
* **Light Mode Palette:** Surface `#FFFFFF`, right border `#E2E8F0`. Active item: bg `#EEF2FF` (`--pg-accent-brand-soft`), text `#4338CA` (`--pg-accent-primary`), 3px start indicator pill.
* **Dark Mode Palette:** Surface `#0F172A`, right border `#1E293B`. Active item: bg `rgba(99, 102, 241, 0.16)`, text `#A5B4FC`, 3px start indicator pill.
* **Interactive & Visual States:** Resting, Hover (`--pg-bg-surface-hover`), Active/Current Route, Collapsed Rail (icons centered + `PgTooltip` on hover), Mobile Temporary Overlay (with dim backdrop `rgba(15,23,42,0.45)`).
* **LTR & RTL Directional Behavior:** Anchors to `inset-inline-start: 0`; border flips to `border-inline-end`; mobile slide-in animates from right in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue`: boolean (open/closed state on mobile).
  * `rail`: boolean (collapsed icon-only mode on desktop).
  * `permanent`: boolean (default `true` on `>=960px`).
  * `width`: number | string (default `260`).
  * `location`: `'start' | 'end'` (default `'start'`).
* **Emitted Events:**
  * `update:modelValue(open: boolean)`
  * `update:rail(rail: boolean)`
* **Slots:**
  * `prepend` (brand logo), `default` (scrollable navigation groups), `append` (pinned user/logout footer).
* **User Interactions & Click Behavior:**
  * Clicking backdrop or pressing `Escape` closes mobile overlay drawer.
  * Scrolling the nav list NEVER causes items to hide behind the `append` footer.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Arrow Up/Down navigates items cleanly; `Escape` closes mobile drawer and restores focus to toggle button.
* **Edge Cases & Defensive Guards:**
  * Thin custom scrollbar (`4px` width, subtle thumb) prevents visual clutter on Windows/Linux browsers.
  * Long Arabic/English nav labels truncate with ellipsis rather than wrapping to awkward 2-line heights.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Layout test: Scrollable nav body has `flex: 1 1 auto; min-height: 0; overflow-y: auto` and last nav item is 100% reachable above `append` footer.
- [ ] Interaction test: Mobile mode locks body scroll when open and closes on `Escape` or backdrop click.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.5 `PgPage (`ScreenContainer`) & PgSection (Global Container Spacing Policy)`

* **Source File:** `packages/ui/src/layout/PgLayout.tsx`
* **Canonical Exports:** `PgPage`, `ScreenContainer`, `PgSection`
* **Role & Design Intent:** Enforces the global 2026 Fintech spatial rhythm automatically on every page so individual pages NEVER have to invent ad-hoc outer margins, max-widths, or section gaps.

#### Detected Gaps, Bugs & Audit Findings

1. Pages currently mix raw `<div class='pa-4'>`, `<ThemedView style={{ gap: '18px' }}>`, and `<ScreenContainer>`, producing inconsistent outer gutters (from `0px` to `32px`) and cramped card-to-card spacing.
2. `PgSection` lacks a built-in header/description/actions bar slot, forcing pages to hand-roll inconsistent `h3` headings.
3. **Forensic Audit — Missing CSS Classes:** `pg-card--interactive, pg-card--tone, pg-form-col, pg-inline--wrap` are referenced in `packages/ui/src/layout/PgLayout.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgPage`: Centered responsive container (`max-width: 1440px` default, `100%` when `fluid`, `960px` when `narrow`), vertical flex stack (`gap: 24px`). `PgSection`: Semantic `<section>` with optional header row (`title`, `subtitle`, `actions`) and `gap: 16px` between header and body.
* **Padding, Gaps & Rhythm:** `PgPage` padding: `24px 28px 48px` on desktop (`>=960px`), `16px 16px 36px` on mobile. `PgSection` internal gap: `16px`. Adjacent `PgSection` gap: `24px` (controlled by `PgPage`).
* **Typography Scale & Numerals:** `PgSection` title: `16px`, `font-weight: 600`, `letter-spacing: -0.01em`; subtitle: `13px`, `--pg-ink-muted`.
* **Light Mode Palette:** Transparent over `--pg-bg-canvas`.
* **Dark Mode Palette:** Transparent over `--pg-bg-canvas`.
* **Interactive & Visual States:** Default (`max-width: 1440px`), `fluid` (`max-width: 100%` for dense ledger tables), `narrow` (`max-width: 840px` for forms/settings).
* **LTR & RTL Directional Behavior:** Padding and section header flex direction mirror cleanly via logical CSS properties.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgPage`: `size?: 'narrow' | 'default' | 'wide' | 'fluid'`, `gap?: 'sm' | 'md' | 'lg'` (default `'md'` = `24px`).
  * `PgSection`: `title?: string`, `subtitle?: string`, `gap?: 'sm' | 'md' | 'lg'` (default `'md'` = `16px`).
* **Emitted Events:**
  * None.
* **Slots:**
  * `PgPage`: `default`. `PgSection`: `title`, `actions`, `default`.
* **User Interactions & Click Behavior:**
  * Pure structural layout containers; zero layout shift during async data hydration.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Uses semantic `<section aria-labelledby>` when `title` is provided.
* **Edge Cases & Defensive Guards:**
  * Nested `PgPage` inside `PgPage` (if legacy wrapper exists) collapses outer padding via `:where(.pg-page .pg-page) { padding: 0; }` so pages NEVER suffer double-gutter bugs.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] CSS policy test: `PgPage` applies `24px 28px 48px` desktop padding and `24px` vertical stack gap.
- [ ] Nesting test: Nested `PgPage` resets inner padding to `0`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.6 `PgCard (`SurfaceCard` & Card Sub-Primitives)`

* **Source File:** `packages/ui/src/layout/PgLayout.tsx`
* **Canonical Exports:** `PgCard`, `SurfaceCard`, `PgCardTitle`, `PgCardSubtitle`, `PgCardText`, `PgCardActions`, `SurfaceCardText`
* **Role & Design Intent:** The canonical elevated surface container for forms, KPI panels, chart wrappers, detail inspectors, and settings blocks, enforcing crisp 1px borders, generous internal padding, and clean header/body/footer separation.

#### Detected Gaps, Bugs & Audit Findings

1. `.pg-card--interactive` is referenced in `PgLayout.tsx` but has NO CSS definition in `components.css`, leaving clickable cards without hover elevation, border accent, or pointer cursor.
2. Cards with tables or flush lists inside lack a `padded={false}` / `flush` mode, causing awkward double-borders or missing padding.
3. **Forensic Audit — Missing CSS Classes:** `pg-card--interactive, pg-card--tone, pg-form-col, pg-inline--wrap` are referenced in `packages/ui/src/layout/PgLayout.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Optional Header (`padding: 18px 20px 14px`, `border-bottom: 1px solid var(--pg-border-subtle)` when `divided`), Body (`padding: 20px`), Optional Footer/Actions (`padding: 14px 20px`, `border-top: 1px solid var(--pg-border-subtle)`, `display: flex; justify-content: flex-end; gap: 10px`).
* **Padding, Gaps & Rhythm:** Default padding `20px` (compact `16px`, spacious `24px`, flush `0px`). Border radius `12px` (`--pg-radius-lg`).
* **Typography Scale & Numerals:** `PgCardTitle`: `15px`, `font-weight: 600`; `PgCardSubtitle`: `13px`, `--pg-ink-muted`.
* **Light Mode Palette:** Bg `#FFFFFF`, border `1px solid #E2E8F0`, shadow `0 1px 2px rgba(15,23,42,0.04)`.
* **Dark Mode Palette:** Bg `#111827`, border `1px solid #1E293B`, shadow `0 1px 3px rgba(0,0,0,0.35)`.
* **Interactive & Visual States:** Resting, Interactive Hover (`border-color: var(--pg-border-strong); box-shadow: var(--pg-shadow-sm); transform: translateY(-1px)`), Selected (`border-color: var(--pg-accent-primary); box-shadow: 0 0 0 3px var(--pg-focus-ring)`), Toned (`tone='subtle' | 'info' | 'warning' | 'danger'`).
* **LTR & RTL Directional Behavior:** Header title/actions and footer button alignment mirror naturally via flexbox logical flow.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `title?: string`, `subtitle?: string`
  * `padding?: 'none' | 'sm' | 'md' | 'lg'` (default `'md'` = `20px`)
  * `interactive?: boolean` (enables hover lift + keyboard `Enter`/`Space` activation)
  * `tone?: 'default' | 'subtle' | 'info' | 'warning' | 'danger'`
  * `divided?: boolean` (hairline divider between header, body, and footer)
* **Emitted Events:**
  * `click(e: MouseEvent)` when `interactive=true`.
* **Slots:**
  * `header`, `title`, `subtitle`, `actions`, `default`, `footer`.
* **User Interactions & Click Behavior:**
  * Interactive cards act as accessible clickable surfaces with visible `:focus-visible` ring.
* **Keyboard Navigation & Accessibility (ARIA):**
  * When `interactive=true`, `tabindex='0'` and `Enter`/`Space` trigger `click`.
* **Edge Cases & Defensive Guards:**
  * `PgCard` containing a `PgTable` should use `padding='none'` so table headers align flush with card edges and respect `overflow: hidden` rounded corners.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: Default `PgCard` renders `20px` padding, `12px` radius, and `1px` border.
- [ ] CSS test: `interactive=true` applies `.pg-card--interactive` with cursor pointer and hover border transition.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.7 `PgFormGrid, PgFormCol, PgStack & PgCenter`

* **Source File:** `packages/ui/src/layout/PgLayout.tsx`
* **Canonical Exports:** `PgFormGrid`, `PgFormCol`, `PgStack`, `PgCenter`, `CenterView`
* **Role & Design Intent:** 12-column responsive form grid and flex alignment primitives that eliminate manual inline `style={{ display: 'grid', gap: '...' }}` across all 204 pages.

#### Detected Gaps, Bugs & Audit Findings

1. `.pg-form-col-*` classes referenced in `PgLayout.tsx` are missing full responsive media-query breakpoints (`sm`, `md`, `lg`) in `components.css`, causing 2-column forms to stay cramped side-by-side on mobile screens.
2. `.pg-inline--wrap` is referenced in `PgLayout.tsx` without a corresponding CSS rule.
3. **Forensic Audit — Missing CSS Classes:** `pg-card--interactive, pg-card--tone, pg-form-col, pg-inline--wrap` are referenced in `packages/ui/src/layout/PgLayout.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgFormGrid`: CSS Grid (`grid-template-columns: repeat(12, minmax(0, 1fr))`, `column-gap: 16px`, `row-gap: 16px`). `PgFormCol`: spans `cols` (1–12), collapsing to `span 12` below `768px`.
* **Padding, Gaps & Rhythm:** `PgStack`: vertical flex (`gap: 12px` default; `xs=6px`, `sm=8px`, `md=16px`, `lg=24px`). `PgCenter`: centers content horizontally and vertically with optional `minHeight`.
* **Typography Scale & Numerals:** Inherits parent.
* **Light Mode Palette:** Transparent.
* **Dark Mode Palette:** Transparent.
* **Interactive & Visual States:** Desktop 12-col grid -> Tablet 2-col -> Mobile 1-col stack.
* **LTR & RTL Directional Behavior:** CSS Grid auto-placement flows right-to-left natively under `dir='rtl'`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgFormGrid`: `columns?: number` (default `12`), `gap?: 'sm' | 'md' | 'lg'` (default `'md'` = `16px`).
  * `PgFormCol`: `span?: number` (1–12, default `12`), `md?: number`, `lg?: number`.
  * `PgStack`: `direction?: 'column' | 'row'`, `gap?: 'xs' | 'sm' | 'md' | 'lg'`, `align?: string`, `justify?: string`, `wrap?: boolean`.
* **Emitted Events:**
  * None.
* **Slots:**
  * `default`.
* **User Interactions & Click Behavior:**
  * Every child gets `min-width: 0` so inputs and selects never overflow their grid track.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Visual grid order matches DOM tab order.
* **Edge Cases & Defensive Guards:**
  * Mixed full-width (`span=12`) and half-width (`span=6`) form fields align baselines cleanly even when one field displays a validation error message underneath.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Layout test: `PgFormCol span={6}` renders `grid-column: span 6 / span 6` on desktop and collapses to `span 12` on mobile.
- [ ] CSS test: `.pg-inline--wrap` applies `flex-wrap: wrap`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.8 `PgContainer, PgRow, PgCol, PgSpacer & PgForm`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgContainer`, `VContainer`, `PgRow`, `VRow`, `PgCol`, `VCol`, `PgSpacer`, `VSpacer`, `PgForm`, `VForm`
* **Role & Design Intent:** Vuetify-compatible 12-column grid and `<form>` submission/validation coordinator (`PgForm`) enabling drop-in Vapor compatibility across migrated pages without losing validation orchestration.

#### Detected Gaps, Bugs & Audit Findings

1. `.pg-form` is referenced in `PgShellPrimitives.tsx` with no CSS rule in `components.css`, causing forms to lose default vertical field spacing.
2. `PgForm` `validate()` method does not consistently register child `PgTextField`/`PgAutocomplete`/`PgDateInput` validators via `provide`/`inject`, allowing invalid forms to submit.
3. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgForm` renders `<form class='pg-form' novalidate>` with `display: flex; flex-direction: column; gap: 16px`. `PgRow`/`PgCol` map to a clean 12-column CSS grid with `16px` gutter. `PgSpacer` is `flex: 1 1 auto`.
* **Padding, Gaps & Rhythm:** `PgRow` gap `16px` (`dense` -> `8px`). `PgContainer` padding `0` inside `PgPage`, `24px` standalone.
* **Typography Scale & Numerals:** Inherits.
* **Light Mode Palette:** Transparent.
* **Dark Mode Palette:** Transparent.
* **Interactive & Visual States:** Form states: `pristine`, `dirty`, `valid`, `invalid`, `submitting` (`disabled` propagation).
* **LTR & RTL Directional Behavior:** Grid and flex rows invert automatically in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgForm`: `modelValue?: boolean` (validity state), `disabled?: boolean`, `fastFail?: boolean`.
  * `PgCol`: `cols?: number|string`, `sm?`, `md?`, `lg?`, `xl?`.
* **Emitted Events:**
  * `PgForm`: `submit(event: SubmitEvent)` (automatically calls `preventDefault()` and runs `validate()`), `update:modelValue(valid: boolean)`.
* **Slots:**
  * `default`.
* **User Interactions & Click Behavior:**
  * Exposes `validate(): Promise<{ valid: boolean; errors: Array<{ id: string; errorMessages: string[] }> }>`, `reset()`, and `resetValidation()` via template ref (`defineExpose`).
  * On failed submit, automatically scrolls to and focuses the first invalid field.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Pressing `Enter` in a single-line input inside `PgForm` triggers validation and submit cleanly.
* **Edge Cases & Defensive Guards:**
  * Unmounted conditional form fields unregister their validator on `onUnmounted` so hidden fields never block submission.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `PgForm` `validate()` returns `{ valid: false }` when a child `PgTextField` fails its required rule and exposes the error visibly.
- [ ] Unit test: `PgForm` `resetValidation()` clears visible errors without clearing values.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.9 `PgSubHeader, PgText & PgView`

* **Source File:** `packages/ui/src/layout/PgPageHeader.tsx`
* **Canonical Exports:** `PgSubHeader`, `SubHeader`, `PgText`, `ThemedText`, `PgView`, `ThemedView`
* **Role & Design Intent:** Semantic typography and sub-section header primitives ensuring uniform type scale, muted ink hierarchy, and clean dark-mode contrast without hand-coded hex colors.

#### Detected Gaps, Bugs & Audit Findings

1. `PgText` with `variant='muted'` or `caption` sometimes falls back to browser default `#000000` in dark mode when color class is omitted.
2. `PgSubHeader` lacks an optional right-side `actions` slot and consistent `margin-bottom: 12px` rhythm.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgSubHeader`: flex row (`justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px`). `PgText`: semantic `<p>`/`<span>`/`<h1>`–`<h4>` mapped to token typography variants.
* **Padding, Gaps & Rhythm:** `PgSubHeader`: `padding-bottom: 8px`, optional `border-bottom: 1px solid var(--pg-border-subtle)` when `divided=true`.
* **Typography Scale & Numerals:** Variants: `display` (`24px/700`), `title` (`18px/600`), `subtitle` (`15px/600`), `body` (`14px/400`), `label` (`13px/500`), `caption` (`12px/400`), `overline` (`11px/600 uppercase 0.06em`), `mono` (`13px var(--pg-font-mono)`).
* **Light Mode Palette:** Tones: `primary` `#0F172A`, `secondary` `#334155`, `muted` `#64748B`, `faint` `#94A3B8`, plus semantic `success/warning/danger/info/brand`.
* **Dark Mode Palette:** Tones: `primary` `#F1F5F9`, `secondary` `#CBD5E1`, `muted` `#94A3B8`, `faint` `#64748B`, plus luminous semantic inks.
* **Interactive & Visual States:** Supports `truncate` (single-line ellipsis) and `clamp={2|3}`.
* **LTR & RTL Directional Behavior:** Text alignment defaults to `text-align: start` (never hardcoded `left`).

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgSubHeader`: `title: string`, `subtitle?: string`, `divided?: boolean`.
  * `PgText`: `as?: 'span'|'p'|'div'|'h1'|'h2'|'h3'|'h4'`, `variant?: string`, `tone?: string`, `weight?: string`, `truncate?: boolean`.
* **Emitted Events:**
  * None.
* **Slots:**
  * `PgSubHeader`: `default`, `actions`. `PgText`: `default`.
* **User Interactions & Click Behavior:**
  * Pure presentational primitives.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * `PgView` forwards `style` and `class` cleanly without dropping flex-direction overrides from legacy pages.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `PgText variant='mono' tone='muted'` renders monospace font and `--pg-ink-muted` token.
- [ ] Render test: `PgSubHeader` aligns title and actions slot with `12px` gap.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.10 `PgList, PgListItem, PgListItemTitle, PgListItemSubtitle & PgListSubheader`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgList`, `VList`, `PgListItem`, `VListItem`, `PgListItemTitle`, `VListItemTitle`, `PgListItemSubtitle`, `VListItemSubtitle`, `PgListSubheader`, `VListSubheader`
* **Role & Design Intent:** Structured vertical item lists used inside `PgNavigationDrawer`, `PgMenu`, `PgCommandPalette`, notification popovers, and detail drawers.

#### Detected Gaps, Bugs & Audit Findings

1. Clickable `PgListItem` elements with `to` or `onClick` lack consistent `min-height: 40px`, `padding: 8px 12px`, and keyboard `focus-visible` ring.
2. Active state in `PgListItem` does not distinguish between `nav` mode (rounded `8px` pill inside sidebar) and `menu` mode (rounded `6px` row inside popover).
3. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgList`: vertical stack (`padding: 4px 0`, `gap: 2px`). `PgListItem`: 3-zone flex row (`prepend` icon/avatar, `body` title+subtitle with `min-width: 0`, `append` badge/chevron/action).
* **Padding, Gaps & Rhythm:** Row padding `8px 12px` (`compact`: `6px 10px`), `gap: 10px`, `border-radius: 8px`.
* **Typography Scale & Numerals:** `PgListItemTitle`: `13.5px`, `font-weight: 500`, `line-height: 1.35`. `PgListItemSubtitle`: `12px`, `--pg-ink-muted`, `line-height: 1.35`. `PgListSubheader`: `11px`, `font-weight: 600`, uppercase, `letter-spacing: 0.06em`, `padding: 12px 12px 4px`.
* **Light Mode Palette:** Hover `#F1F5F9`, Active `#EEF2FF` + `#4338CA` text, Danger hover `#FEF2F2` + `#B91C1C` text.
* **Dark Mode Palette:** Hover `#1E293B`, Active `rgba(99,102,241,0.16)` + `#A5B4FC` text, Danger hover `rgba(239,68,68,0.14)` + `#FCA5A5` text.
* **Interactive & Visual States:** Resting, Hover, Active/Selected, Focus-Visible (`2px solid var(--pg-border-focus)`), Disabled (`opacity: 0.45; pointer-events: none`), Danger.
* **LTR & RTL Directional Behavior:** Prepend/append slots and directional chevrons mirror naturally in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgListItem`: `title?: string`, `subtitle?: string`, `prependIcon?: string`, `appendIcon?: string`, `active?: boolean`, `disabled?: boolean`, `danger?: boolean`, `to?: string | object`, `href?: string`.
* **Emitted Events:**
  * `click(e: MouseEvent)`.
* **Slots:**
  * `prepend`, `default`, `title`, `subtitle`, `append`.
* **User Interactions & Click Behavior:**
  * Renders as `<a>` when `to`/`href` is set, `<button type='button'>` when `onClick` is bound, or `<div>` when purely static.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Supports `Enter` and `Space` when interactive.
* **Edge Cases & Defensive Guards:**
  * Never nests `<button>` inside `<a>` when `append` contains an action button.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `PgListItem` with `onClick` renders an accessible button with `min-height: 36px` and `gap: 10px`.
- [ ] State test: `active=true` applies `.pg-list-item--active` and `aria-current='page'` when used as nav link.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.11 `PgExpansionPanels & PgExpansionPanel (Accordions & Default-Collapsed Policy)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgExpansionPanels`, `VExpansionPanels`, `PgExpansionPanel`, `VExpansionPanel`, `PgExpansionPanelTitle`, `VExpansionPanelTitle`, `PgExpansionPanelText`, `VExpansionPanelText`
* **Role & Design Intent:** Collapsible disclosure panels for SOP guides, advanced configuration sections, and raw payload inspection without burying primary page tables beneath walls of expanded text.

#### Detected Gaps, Bugs & Audit Findings

1. **Live Bug Observed on `/merchants`:** 10+ SOP accordion panels default to open, pushing the actual Merchants table 2,000px below the fold. `PgExpansionPanels` MUST default to **all collapsed (`modelValue: undefined / []`)** unless explicitly controlled.
2. Expand/collapse chevron lacks smooth rotation transition (`180deg`) and focus ring on the trigger header.
3. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Container with `border: 1px solid var(--pg-border-subtle); border-radius: 12px; overflow: hidden; background: var(--pg-bg-surface)`. Panels separated by `1px solid var(--pg-border-subtle)`.
* **Padding, Gaps & Rhythm:** Header button: `min-height: 48px`, `padding: 12px 16px`, `gap: 12px`. Content body: `padding: 0 16px 16px` (or `16px` with subtle top divider).
* **Typography Scale & Numerals:** Header title: `14px`, `font-weight: 600`. Body: `13.5px`, `line-height: 1.55`, `--pg-ink-secondary`.
* **Light Mode Palette:** Header bg `#FFFFFF`, hover `#F8FAFC`, expanded header subtle `#F8FAFC`.
* **Dark Mode Palette:** Header bg `#111827`, hover `#1E293B`, expanded header `#162032`.
* **Interactive & Visual States:** Collapsed (chevron `0deg`), Expanded (chevron `180deg`, `200ms ease`), Hover, Focus-Visible, Disabled.
* **LTR & RTL Directional Behavior:** Header text aligns right, chevron sits on inline-end (left) in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgExpansionPanels`: `modelValue?: string | number | Array<string|number>` (default `undefined` — ALL COLLAPSED), `multiple?: boolean` (default `false`), `variant?: 'default' | 'accordion' | 'inset'`.
  * `PgExpansionPanel`: `value?: string | number`, `title?: string`, `disabled?: boolean`.
* **Emitted Events:**
  * `update:modelValue(next)`.
* **Slots:**
  * `title`, `default` / `text`.
* **User Interactions & Click Behavior:**
  * Clicking header toggles panel open/closed; in single mode (`multiple=false`), opening a new panel closes the previously open panel.
  * Uses Vapor `createIf` or CSS grid-row transition (`grid-template-rows: 0fr -> 1fr`) so collapsed content is non-tabbable (`inert` / `hidden`).
* **Keyboard Navigation & Accessibility (ARIA):**
  * `Enter`/`Space` toggles focused panel; `aria-expanded` and `aria-controls` strictly synced.
* **Edge Cases & Defensive Guards:**
  * Never defaults to expanding all panels when `modelValue` is omitted.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Default state test: `PgExpansionPanels` with 5 children renders all 5 collapsed (`aria-expanded='false'`) by default.
- [ ] Interaction test: Clicking panel 1 expands it; clicking panel 2 in single mode collapses panel 1.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.12 `PgTimeline & PgTimelineItem (Audit & Transaction Lifecycle Rail)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgTimeline`, `VTimeline`, `PgTimelineItem`, `VTimelineItem`
* **Role & Design Intent:** Vertical chronological event trail for transaction state transitions (`CREATED -> AUTHORIZED -> CAPTURED -> SETTLED`), KYB approval histories, and webhook delivery attempts.

#### Detected Gaps, Bugs & Audit Findings

1. Timeline connector line misaligns vertically with status dots when item content wraps to multiple lines or switches to RTL.
2. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Vertical grid (`grid-template-columns: 24px minmax(0, 1fr)`, `column-gap: 14px`). Left track holds `10px` semantic status dot centered on `2px` vertical connector line (`--pg-border-subtle`); right track holds timestamp + event title + metadata card.
* **Padding, Gaps & Rhythm:** Row bottom padding `18px` (last item `0px`, connector line stops at last dot center).
* **Typography Scale & Numerals:** Event title: `13.5px/600`; Timestamp: `12px` monospace `--pg-ink-muted`; Detail note: `13px` `--pg-ink-secondary`.
* **Light Mode Palette:** Line `#E2E8F0`; Dots use `--pg-status-{tone}-dot` with `3px` ring of `--pg-bg-surface`.
* **Dark Mode Palette:** Line `#1E293B`; Dots use luminous `--pg-status-{tone}-dot` with `3px` ring of `#111827`.
* **Interactive & Visual States:** Tone per item: `success`, `warning`, `danger`, `info`, `brand`, `neutral`.
* **LTR & RTL Directional Behavior:** Grid mirrors track to the right edge automatically in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgTimeline`: `density?: 'default' | 'compact'`.
  * `PgTimelineItem`: `tone?: BadgeTone`, `icon?: string`, `timestamp?: string`, `title?: string`.
* **Emitted Events:**
  * None.
* **Slots:**
  * `opposite` (timestamp/actor), `icon`, `default` (event body).
* **User Interactions & Click Behavior:**
  * Pure chronological display; embedded `PgMonoRef` IDs remain click-to-copy.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Semantic `<ol class='pg-timeline'>` with `<li>` items.
* **Edge Cases & Defensive Guards:**
  * Single-item timeline hides trailing connector line cleanly.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: Renders semantic `<ol>` and `<li>` with correct tone dot class and no trailing line on final item.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 4.13 `PgTransition (Motion & Reduced-Motion Wrapper)`

- **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
- **Canonical Exports:** `PgTransition`
- **Role & Design Intent:** Vapor-safe lightweight transition wrapper providing subtle `160ms–200ms` fade/slide transitions for route panels, collapsible filter bars, and inline state switches while respecting `prefers-reduced-motion: reduce`.

#### Detected Gaps, Bugs & Audit Findings
1. Exported in `packages/ui/src/index.ts` but lacked a blueprint and `prefers-reduced-motion` guard; VDOM `<Transition>` hooks do not reliably fire in pure Vapor mode.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)
- **Structural Anatomy:** Pure CSS class-driven enter/leave transition (`opacity 160ms cubic-bezier(0.2, 0, 0, 1)`, optional `translateY(4px) -> 0`).
- **Padding, Gaps & Rhythm:** Zero layout footprint (`display: contents` or clean block wrapper).
- **Typography Scale & Numerals:** Inherits.
- **Light Mode Palette:** Transparent.
- **Dark Mode Palette:** Transparent.
- **Interactive & Visual States:** Presets: `fade`, `slide-y`, `slide-x`, `scale`. Disabled instantaneously under `@media (prefers-reduced-motion: reduce)`.
- **LTR & RTL Directional Behavior:** `slide-x` uses logical sign flip under `html[dir="rtl"]`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)
- **Props & Parameters:** `name?: 'fade'|'slide-y'|'slide-x'|'scale'` (default `'fade'`), `duration?: number` (default `160`).
- **Emitted Events:** None.
- **Slots:** `default`.
- **User Interactions & Click Behavior:** Never blocks pointer events during exit (`pointer-events: none` on leaving state).
- **Keyboard Navigation & Accessibility (ARIA):** Preserves child focus without trapping.
- **Edge Cases & Defensive Guards:** Safe no-op passthrough in JSDOM/Vitest environments.

#### Mandatory OpenCode Verification & Automated Tests
- [ ] Unit test: `PgTransition` renders slotted children cleanly in Vapor without VDOM `<Transition>` warnings.

## PART 5 — ACTIONS, BUTTONS, ICONS & NAVIGATION BLUEPRINTS

### 5.1 `PgButton`

* **Source File:** `packages/ui/src/actions/PgButton.tsx`
* **Exported Symbols / Aliases:** `PgButton, VBtn, Button`
* **Category:** Actions & Controls
* **Purpose & Role in Platform:** The single button primitive across all 4 frontends supporting 7 clear visual hierarchy tiers (`primary`, `secondary`, `outlined`, `tonal`, `ghost`, `text`, `danger`), 3 sizes (`sm`, `md`, `lg`), icon-only mode, loading spinner replacement, and router-link navigation.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Double Icons When Loading (`Refresh` Button Bug):** Lines 98–102 render BOTH `.pg-btn__spinner` AND `prependIcon` at the same time, showing two overlapping icons inside `Refresh`.
* **Table Row Over-Filling:** Callers default to filled `tonal` buttons on every table row instead of `outlined` / `ghost` / `text` hierarchy.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Heights: `sm = 32px`, `md = 38px`, `lg = 44px`. Icon-only: square (`32×32`, `38×38`, `44×44`). `flex-shrink: 0` so buttons NEVER get squished or clipped (fixes `...mary`).
* **Padding & Internal Gaps:** Padding: `sm = 0 12px`, `md = 0 16px`, `lg = 0 20px`. Icon-to-label gap: `gap: 8px` (`6px` in `sm`).
* **Borders, Radius & Elevation:** `border-radius: var(--pg-radius-sm)` (`8px`; `9999px` when `rounded='pill'`). `outlined` / `secondary` have `1px solid var(--pg-border-default)`.
* **Typography & Numerals:** `13px` (`12.5px` in `sm`, `14px` in `lg`), weight `600`, `line-height: 1`, `white-space: nowrap`.
* **Color & Surface Tokens (Light & Dark):** `primary`: `--pg-accent-primary` bg + `--pg-ink-on-accent` text. `secondary`/`outlined`: `--pg-bg-surface` bg + `--pg-ink-primary`. `tonal`: `--pg-bg-surface-subtle` bg + `--pg-ink-primary`. `ghost`/`text`: transparent bg + `--pg-ink-secondary` (hover `--pg-bg-surface-hover`). `danger`: `--pg-status-danger-dot` bg + white text.
* **RTL (Arabic) Visual Adaptation:** `prependIcon` automatically appears on the right in RTL and `appendIcon` on the left.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default (`primary`)** | `--pg-accent-primary` | Transparent | `--pg-ink-on-accent` | 140ms ease | 
| **Hover (`primary`)** | `--pg-accent-primary-hover` | Transparent | `--pg-ink-on-accent` | 140ms ease | 
| **Active / Pressed** | Scale `0.985` | Same | Same | 80ms ease-out | 
| **Focus-Visible** | Same | Neutral `var(--pg-focus-ring)` (NO blue glow) | Same | 120ms ease | 
| **Loading** | Same (opacity `0.85`) | Same | Spinner **replaces** `prependIcon` (NEVER both!) | 650ms linear spin | 
| **Disabled** | Opacity `0.45` | Same | `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `variant` | \`'primary' | 'secondary' | 'outlined' | 
| `size` | \`'sm' | 'md' | 'lg'\` | 
| `prependIcon / appendIcon` | `string` | `''` | MDI icon name before/after label. `prependIcon` MUST hide when `loading=true`. | 
| `icon` | \`boolean | string\` | `false` | 
| `loading` | `boolean` | `false` | Disables clicks, sets `aria-busy='true'`, replaces leading icon with spinner. | 
| `disabled` | `boolean` | `false` | Blocks pointer and keyboard activation. | 
| `to / href` | \`RouteLocationRaw | string\` | `undefined` | 

* **Slots:** `default` (label text), `leading`, `trailing`.
* **Emitted Events:** `click` (MouseEvent).
* **Pointer & Click Behavior:**
  * Clicks when `disabled` or `loading` call `event.preventDefault()` and never fire `onClick`.
  * Ctrl/Cmd+Click on a `to` link opens in a new browser tab natively.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Focusable via `Tab`; activates on `Enter` and `Space`; displays neutral `var(--pg-focus-ring)` on `:focus-visible`.
* **Mandatory Edge Cases & Defensive Guards:**
  * Loading button with `prependIcon='mdi-refresh'`: renders ONLY `.pg-btn__spinner` + label — NEVER 2 icons.
  * Icon-only button without `ariaLabel`: warns in dev / falls back to `title`.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgButton.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders `loading={true}` with `prependIcon='mdi-refresh'` and asserts `.pg-btn__spinner` exists and `<PgIcon>` count is `0`.
2. Asserts `disabled={true}` and `loading={true}` block `onClick` handler.
3. Asserts all 7 variants apply exact `.pg-btn--<variant>` classes and `flex-shrink: 0`.

### 5.2 `PgIcon`

* **Source File:** `packages/ui/src/actions/PgIcon.tsx`
* **Exported Symbols / Aliases:** `PgIcon, VIcon, AppIcon, Icon`
* **Category:** Actions & Iconography
* **Purpose & Role in Platform:** Single crisp SVG icon renderer backed by `@mdi/js` pre-generated paths (`icons.generated.ts`) with semantic color token mapping and zero external icon-font latency.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Token Resolution:** Maps color names like `'muted'`, `'success'`, `'danger'` to CSS variables (`var(--pg-...)`), must ensure every semantic tone resolves cleanly in both Light & Dark mode.
* **Missing CSS Classes (Unstyled in DOM):** `pg-accent-brand, pg-accent-primary, pg-bg-surface, pg-ink-faint, pg-ink-muted, pg-status-danger-dot, pg-status-info-dot, pg-status-success-dot, pg-status-warning-dot` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Inline-flex SVG (`width = size`, `height = size`, default `18px`, `flex: 0 0 auto`).
* **Padding & Internal Gaps:** Zero padding/margin; parent controls gap.
* **Borders, Radius & Elevation:** None.
* **Typography & Numerals:** N/A (`fill: currentColor`).
* **Color & Surface Tokens (Light & Dark):** Inherits `currentColor` by default; supports `'muted'`, `'primary'`, `'success'`, `'warning'`, `'danger'`, `'info'` mapped to `--pg-*` variables.
* **RTL (Arabic) Visual Adaptation:** Directional icons (`chevron`, `arrow`, `logout`) flip horizontally when `flipRtl` or in RTL navigation contexts.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | Transparent | None | `currentColor` or semantic token | 140ms color | 
| **Spinning (`mdi-loading`)** | Transparent | None | Same | 700ms infinite rotate | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `icon` | `string` | `''` | MDI name (`mdi-check`, `mdi-magnify`, etc.). | 
| `size` | \`number | string\` | `18` | 
| `color` | `string` | `''` | Semantic tone or valid CSS color. | 

* **Slots:** `default` (optional fallback icon name string if passed as `<PgIcon>mdi-check</PgIcon>`).
* **Emitted Events:** None.
* **Pointer & Click Behavior:**
  * `pointer-events: none` unless explicitly interactive.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Decorative icons set `aria-hidden='true'`.
* **Mandatory Edge Cases & Defensive Guards:**
  * Unknown icon name renders nothing gracefully instead of crashing.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgIcon.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders valid `<svg><path d='...'/></svg>` for `mdi-check` and `mdi-magnify`.
2. Maps `color='success'` to `var(--pg-status-success-dot)` and `color='muted'` to `var(--pg-ink-muted)`.

### 5.3 `PgSegmentedTabs`

* **Source File:** `packages/ui/src/actions/PgSegmentedTabs.tsx`
* **Exported Symbols / Aliases:** `PgSegmentedTabs, SegmentedTabs, VBtnToggle`
* **Category:** Actions & Navigation
* **Purpose & Role in Platform:** Compact pill-track segmented control for switching timeframes (`24 hours | 7 days | 30 days | 90 days`), view modes (`Payment attempts | Inbound webhooks`), or detail sub-tabs.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **RTL Reversed Text in English Mode:** Previously rendered `days 90 | days 30 | days 7 | hours 24` due to the global `dir='rtl'` leak.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Inline-flex track (`height: 36px; padding: 3px; border-radius: var(--pg-radius-sm);`).
* **Padding & Internal Gaps:** Track padding `3px`; gap between tabs `2px`; each tab `padding: 0 12px; height: 30px;`.
* **Borders, Radius & Elevation:** Track: `1px solid var(--pg-border-subtle)`. Active tab: `border-radius: 6px; box-shadow: var(--pg-shadow-xs);`.
* **Typography & Numerals:** `12.5px / 600 / white-space: nowrap`.
* **Color & Surface Tokens (Light & Dark):** Track: `--pg-bg-surface-subtle`. Inactive tab: transparent + `--pg-ink-secondary`. Active tab: `--pg-bg-surface` + `--pg-ink-primary`.
* **RTL (Arabic) Visual Adaptation:** Tabs flow inline-start to inline-end naturally.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Inactive** | Transparent | None | `--pg-ink-secondary` | 140ms ease | 
| **Hover** | Subtle tint | None | `--pg-ink-primary` | 140ms ease | 
| **Active** | `--pg-bg-surface` | `--pg-shadow-xs` | `--pg-ink-primary` (600) | 140ms ease | 
| **Focus-Visible** | Same | `var(--pg-focus-ring)` | Same | 120ms | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | `string` | `''` | Currently selected tab `value`. | 
| `tabs` | `Array<{ label, value, count?, icon?, disabled? }>` | `[]` | Ordered list of tab options. | 

* **Slots:** None.
* **Emitted Events:** `update:modelValue`.
* **Pointer & Click Behavior:**
  * Clicking an inactive tab immediately emits `update:modelValue(tab.value)`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `role='tablist'` / `role='tab'` with `aria-selected`, supporting `ArrowLeft` / `ArrowRight` roving focus.
* **Mandatory Edge Cases & Defensive Guards:**
  * Optional numeric `count` renders as a tabular pill badge beside the label.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgSegmentedTabs.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders all tabs, highlights active tab with `aria-selected='true'`, and emits `update:modelValue` on click and arrow-key navigation.

### 5.4 `PgThemeMenu`

* **Source File:** `packages/ui/src/patterns/PgThemeControls.tsx`
* **Exported Symbols / Aliases:** `PgThemeMenu, ThemeMenu, PgThemeLanguageControls`
* **Category:** Actions & Header Controls
* **Purpose & Role in Platform:** Header control cluster allowing users to switch Theme (`System`, `Light`, `Dark`) and Language (`English`, `العربية`) with clear active checkmarks and instant `<html>` attribute updates.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Language Menu Completely Broken in App Bar:** Relies on `PgMenu` which lacked Vapor `createIf` and `location='bottom end'` alignment, causing clicks on the translate icon in the app bar to fail or clip off-screen.
* **No Active Language Highlight on Login Page:** Language buttons lacked active styling (`aria-pressed` + surface fill).

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Inline-flex cluster (`gap: 6px; align-items: center;`). Square `34×34` ghost/outlined icon triggers.
* **Padding & Internal Gaps:** Menu panel `padding: 6px; min-width: 170px;`. Menu item `padding: 8px 10px; gap: 10px;`.
* **Borders, Radius & Elevation:** Menu panel: `1px solid var(--pg-border-subtle); border-radius: var(--pg-radius-md); box-shadow: var(--pg-shadow-popover);`.
* **Typography & Numerals:** Menu item: `13px / 500`, active `600`.
* **Color & Surface Tokens (Light & Dark):** Active checkmark uses `--pg-accent-brand` or `--pg-ink-primary`.
* **RTL (Arabic) Visual Adaptation:** Dropdown aligns to `inline-end` of trigger without overflowing viewport edges.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Trigger Default** | Transparent | None (or 1px subtle) | `--pg-ink-secondary` | 120ms | 
| **Trigger Open** | `--pg-bg-surface-active` | `var(--pg-focus-ring)` | `--pg-ink-primary` | 120ms | 
| **Selected Option** | `--pg-bg-surface-subtle` | Checkmark icon at end | `--pg-ink-primary` (600) | 120ms | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `variant` | \`'text' | 'outlined'\` | `'text'` | 
| `size` | \`'sm' | 'md'\` | `'sm'` | 

* **Slots:** None.
* **Emitted Events:** Updates global theme store (`setThemeMode`) and i18n locale (`setI18nLocale`).
* **Pointer & Click Behavior:**
  * Clicking Language icon opens dropdown cleanly aligned under the icon.
  * Clicking `English` sets `lang='en' dir='ltr'`, persists `localStorage['locale-name']='en'`, and closes menu.
  * Clicking `العربية` sets `lang='ar' dir='rtl'`, persists `localStorage['locale-name']='ar'`, and closes menu.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `Escape` closes menu; `ArrowDown`/`ArrowUp` moves between options; `Enter`/`Space` selects.
* **Mandatory Edge Cases & Defensive Guards:**
  * Works identically whether `admin-front` uses `PgThemeLanguageControls` directly or `PgMenu`.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgThemeControls.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Clicks Language trigger, verifies menu mounts with `English` and `العربية`, clicks `العربية` and asserts `document.documentElement.dir === 'rtl'`, then clicks `English` and asserts `dir === 'ltr'`.
2. Clicks Theme trigger and switches `Dark` -> `Light` -> `System`, asserting `data-theme` updates.

### 5.5 `PgBtnToggle (Grouped Action / Mode Toggle)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgBtnToggle`, `VBtnToggle`
* **Role & Design Intent:** Compact joined button group for switching chart timeframes (`7D | 30D | 90D`), table density, or view modes (`Table | Diff | Raw JSON`).

#### Detected Gaps, Bugs & Audit Findings

1. Child `PgButton` elements inside `PgBtnToggle` render with double borders and separate rounded corners instead of a seamless segmented pill bar.
2. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Inline-flex container (`padding: 3px`, `background: var(--pg-bg-surface-subtle)`, `border: 1px solid var(--pg-border-subtle)`, `border-radius: 9px`, `gap: 2px`). Active button elevates onto `--pg-bg-surface` with `--pg-shadow-xs`.
* **Padding, Gaps & Rhythm:** Segment height `30px` (`sm`) / `34px` (`md`), horizontal padding `12px`, `border-radius: 6px`.
* **Typography Scale & Numerals:** `13px`, `font-weight: 500` (active: `600`).
* **Light Mode Palette:** Track `#F1F5F9`, active pill `#FFFFFF`, text `#0F172A`, inactive `#64748B`.
* **Dark Mode Palette:** Track `#0F172A`, active pill `#1E293B`, text `#F8FAFC`, inactive `#94A3B8`.
* **Interactive & Visual States:** Resting, Hover (subtle text darken), Active, Focus-Visible, Disabled.
* **LTR & RTL Directional Behavior:** Button order flows naturally right-to-left.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue`: `string | number | Array<string|number>`
  * `mandatory?: boolean` (default `true` — prevents deselecting all options)
  * `multiple?: boolean` (default `false`)
  * `disabled?: boolean`
* **Emitted Events:**
  * `update:modelValue(next)`.
* **Slots:**
  * `default` (child `PgButton` items with `value` prop).
* **User Interactions & Click Behavior:**
  * Clicking an option selects it and updates `aria-pressed='true'`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Left/Right arrow keys move between segments; `Enter`/`Space` activates.
* **Edge Cases & Defensive Guards:**
  * Clicking already-selected option when `mandatory=true` does NOT emit `undefined`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Interaction test: Clicking `90D` emits `update:modelValue('90d')` and sets `aria-pressed='true'`.
- [ ] Mandatory test: Re-clicking active option when `mandatory=true` keeps selection intact.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 5.6 `PgThemeLanguageControls (App Bar Language & Theme Switcher)`

* **Source File:** `packages/ui/src/patterns/PgThemeControls.tsx`
* **Canonical Exports:** `PgThemeLanguageControls`, `ThemeAndLanguageControls`
* **Role & Design Intent:** Unified App Bar control pair giving instant one-click access to Theme Mode (`System / Light / Dark`) and Language (`English (LTR) / العربية (RTL)`), completely replacing the broken unstyled language menu.

#### Detected Gaps, Bugs & Audit Findings

1. **Live Bug Reported by User:** Clicking the Language icon in the App Bar does nothing / renders broken because `PgMenu` lacks Vapor `createIf` and `.pg-menu-trigger` has no CSS.
2. Switching language updates `i18n.locale` in some portals without syncing `document.documentElement.dir`, `document.documentElement.lang`, and `localStorage['locale-name']`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Inline-flex pair (`gap: 6px`) of two `36px x 36px` ghost icon buttons (or compact labeled pill `EN` / `عربي` + sun/moon icon). Clicking either opens a crisp `PgMenu` popover (`min-width: 170px`, `padding: 6px`, `border-radius: 10px`, `--pg-shadow-popover`).
* **Padding, Gaps & Rhythm:** Trigger padding `0 10px`, `height: 36px`, `gap: 6px`. Menu items `height: 36px`, `padding: 0 10px`, active checkmark on inline-end.
* **Typography Scale & Numerals:** Trigger code `12.5px/600`; Menu items `13.5px/500`.
* **Light Mode Palette:** Trigger hover `#F1F5F9`; Menu bg `#FFFFFF`, border `#E2E8F0`, active row `#EEF2FF` + `#4338CA` checkmark.
* **Dark Mode Palette:** Trigger hover `#1E293B`; Menu bg `#111827`, border `#1E293B`, active row `rgba(99,102,241,0.16)` + `#A5B4FC` checkmark.
* **Interactive & Visual States:** Closed, Open (trigger shows active tint), Hover, Focus-Visible.
* **LTR & RTL Directional Behavior:** Popover anchors to `bottom-end` so it NEVER overflows the viewport edge in either LTR or RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `showLanguage?: boolean` (default `true`)
  * `showTheme?: boolean` (default `true`)
  * `compact?: boolean` (default `false`)
* **Emitted Events:**
  * `localeChange(locale: 'en' | 'ar')`
  * `themeChange(mode: ThemeMode)`
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Clicking `English` immediately sets `locale='en'`, `document.documentElement.lang='en'`, `document.documentElement.dir='ltr'`, persists `localStorage['locale-name']='en'`, and closes menu.
  * Clicking `العربية` immediately sets `locale='ar'`, `document.documentElement.lang='ar'`, `document.documentElement.dir='rtl'`, persists `localStorage['locale-name']='ar'`, and closes menu.
  * Clicking `Light` / `Dark` / `System` updates `setThemeMode()` and persists `localStorage['pg-theme']` immediately.
* **Keyboard Navigation & Accessibility (ARIA):**
  * `Enter`/`Space` opens menu; `ArrowDown`/`ArrowUp` moves highlight; `Enter` applies; `Escape` closes and returns focus to trigger.
* **Edge Cases & Defensive Guards:**
  * Opening Language menu automatically closes Theme menu if open (mutually exclusive popovers).

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Playwright test: Click Language trigger -> menu visibly appears -> click `العربية` -> `html[dir='rtl']` -> click `English` -> `html[dir='ltr']`.
- [ ] Playwright test: Click Theme trigger -> select `Dark` -> `html[data-theme='dark']` persists across reload.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 5.7 `PgSpinner (`VProgressCircular`)`

* **Source File:** `packages/ui/src/actions/PgFeedbackAtoms.tsx`
* **Canonical Exports:** `PgSpinner`, `VProgressCircular`
* **Role & Design Intent:** Crisp SVG circular activity indicator used inside loading buttons, async autocomplete dropdowns, card overlays, and full-page loading screens.

#### Detected Gaps, Bugs & Audit Findings

1. Inconsistent sizing when embedded inside `PgButton` (`16px` expected, sometimes renders `24px` and stretches button height).
2. **Forensic Audit — Missing CSS Classes:** `pg-status` are referenced in `packages/ui/src/actions/PgFeedbackAtoms.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Pure SVG circle with subtle static track (`opacity: 0.2`) and smooth animated arc (`stroke-linecap: round`, `animation: pg-spin 0.8s linear infinite`).
* **Padding, Gaps & Rhythm:** Sizes: `xs` `14px` (inside `sm` buttons), `sm` `16px` (inside `md` buttons), `md` `24px` (inline cards), `lg` `36px` (empty/loading screens). Stroke width `2.5px`.
* **Typography Scale & Numerals:** Optional centered label for determinate mode (`11px/600 tabular-nums`).
* **Light Mode Palette:** Defaults to `currentColor` inside buttons, `--pg-accent-primary` (`#4F46E5`) standalone.
* **Dark Mode Palette:** Defaults to `currentColor` inside buttons, `#818CF8` standalone.
* **Interactive & Visual States:** Indeterminate (default smooth spin) and Determinate (`modelValue: 0-100`).
* **LTR & RTL Directional Behavior:** Rotation is symmetric.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `size?: 'xs' | 'sm' | 'md' | 'lg' | number` (default `'md'`)
  * `indeterminate?: boolean` (default `true`)
  * `modelValue?: number` (0–100 when determinate)
  * `tone?: 'current' | 'brand' | 'success' | 'warning' | 'danger'`
* **Emitted Events:**
  * None.
* **Slots:**
  * `default` (optional percentage text).
* **User Interactions & Click Behavior:**
  * Respects `prefers-reduced-motion: reduce` (slower subtle pulse instead of rapid spin).
* **Keyboard Navigation & Accessibility (ARIA):**
  * `role='progressbar'`, `aria-busy='true'`, `aria-label` localized `'Loading'`.
* **Edge Cases & Defensive Guards:**
  * Clamps determinate `modelValue` strictly to `[0, 100]`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: Renders SVG with `role='progressbar'` and exact pixel size for `xs/sm/md/lg`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 5.8 `PgProgressBar (`VProgressLinear`)`

* **Source File:** `packages/ui/src/actions/PgFeedbackAtoms.tsx`
* **Canonical Exports:** `PgProgressBar`, `VProgressLinear`
* **Role & Design Intent:** Horizontal progress bar for file uploads, batch report generation, KYB onboarding completion, and table refresh indicators.

#### Detected Gaps, Bugs & Audit Findings

1. `.pg-progress--*` tone modifier classes referenced in `PgFeedbackAtoms.tsx` are missing in `components.css`, causing all progress bars to render uncolored.
2. **Forensic Audit — Missing CSS Classes:** `pg-status` are referenced in `packages/ui/src/actions/PgFeedbackAtoms.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Rounded pill track (`height: 6px` default, `3px` thin table-top bar, `8px` prominent onboarding bar; `border-radius: 999px`; `overflow: hidden`) with smooth fill bar (`transition: width 240ms cubic-bezier(0.2, 0, 0, 1)`).
* **Padding, Gaps & Rhythm:** Optional header row with label on start and `tabular-nums` percentage on end (`margin-bottom: 6px`).
* **Typography Scale & Numerals:** Label `12.5px/500`, Percentage `12px/600 tabular-nums`.
* **Light Mode Palette:** Track `#E2E8F0`; Fill: brand `#4F46E5`, success `#059669`, warning `#D97706`, danger `#DC2626`, info `#0284C7`.
* **Dark Mode Palette:** Track `#1E293B`; Fill: brand `#6366F1`, success `#10B981`, warning `#F59E0B`, danger `#EF4444`, info `#38BDF8`.
* **Interactive & Visual States:** Determinate (`0–100%`), Indeterminate (smooth sliding shimmer bar).
* **LTR & RTL Directional Behavior:** Fill grows from right-to-left automatically via logical flow / `transform-origin: inline-start`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue?: number` (0–100)
  * `indeterminate?: boolean`
  * `tone?: 'brand' | 'success' | 'warning' | 'danger' | 'info'` (default `'brand'`)
  * `height?: number` (default `6`)
  * `label?: string`, `showValue?: boolean`
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Pure visual feedback primitive.
* **Keyboard Navigation & Accessibility (ARIA):**
  * `role='progressbar'`, `aria-valuenow`, `aria-valuemin='0'`, `aria-valuemax='100'`.
* **Edge Cases & Defensive Guards:**
  * Values `<0` clamp to `0`, `>100` clamp to `100`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `modelValue=65` renders fill bar at `65%` width and `aria-valuenow='65'`.
- [ ] CSS test: Every `.pg-progress--{tone}` modifier applies its semantic fill color.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 5.9 `PgDivider (`VDivider`)`

* **Source File:** `packages/ui/src/actions/PgFeedbackAtoms.tsx`
* **Canonical Exports:** `PgDivider`, `VDivider`
* **Role & Design Intent:** Hairline visual separator (`1px`) for cards, menus, form sections, and toolbars, with optional centered text label (e.g., `'OR'` on login screens).

#### Detected Gaps, Bugs & Audit Findings

1. Vertical dividers inside flex toolbars collapse to `0px` height when `align-self: stretch` is missing.
2. **Forensic Audit — Missing CSS Classes:** `pg-status` are referenced in `packages/ui/src/actions/PgFeedbackAtoms.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Horizontal: `height: 1px; width: 100%; background: var(--pg-border-subtle)`. Vertical: `width: 1px; align-self: stretch; min-height: 16px; background: var(--pg-border-subtle)`.
* **Padding, Gaps & Rhythm:** Default margin `0` (or `12px 0` when `spaced=true`). Inset mode adds `margin-inline: 16px`.
* **Typography Scale & Numerals:** Optional centered label: `11.5px`, `font-weight: 500`, uppercase, `--pg-ink-faint`, `padding: 0 10px`.
* **Light Mode Palette:** `#E2E8F0` (`--pg-border-subtle`).
* **Dark Mode Palette:** `#1E293B` (`--pg-border-subtle`).
* **Interactive & Visual States:** Horizontal, Vertical, Inset, Labeled.
* **LTR & RTL Directional Behavior:** Symmetric.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `vertical?: boolean`
  * `inset?: boolean`
  * `spaced?: boolean`
  * `label?: string`
* **Emitted Events:**
  * None.
* **Slots:**
  * `default` (optional center label).
* **User Interactions & Click Behavior:**
  * Non-interactive (`role='separator'`, `aria-orientation`).
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * Vertical divider inside `PgAppBar` or toolbar automatically sizes to `20px` height.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: Horizontal divider renders `role='separator'`; vertical divider sets `aria-orientation='vertical'`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 5.10 `PgAvatar, PgChip & PgTag (Identity & Metadata Micro-Atoms)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgAvatar`, `VAvatar`, `PgChip`, `VChip`, `PgTag`
* **Role & Design Intent:** User/merchant monogram avatars (`PgAvatar`), removable filter/selection chips (`PgChip`), and compact read-only category tags (`PgTag`).

#### Detected Gaps, Bugs & Audit Findings

1. `PgChip` close (`×`) button inside `PgAutocomplete` multi-select has a tiny `<14px` hit target and lacks hover background feedback.
2. `PgAvatar` does not gracefully fall back to clean 2-letter initials when an image URL fails to load (`onerror`).
3. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgAvatar`: circle (`border-radius: 999px`) or squircle (`border-radius: 8px` for merchant logos), `overflow: hidden`, centered monogram or `object-fit: cover` image. `PgChip`: pill (`height: 26px`, `padding: 0 8px`, `gap: 5px`, `border-radius: 6px`). `PgTag`: compact badge (`height: 22px`, `padding: 0 7px`, `border-radius: 5px`).
* **Padding, Gaps & Rhythm:** Avatar sizes: `xs` `24px`, `sm` `30px`, `md` `36px`, `lg` `44px`. Chip close button: `18px x 18px` hit target with `border-radius: 4px`.
* **Typography Scale & Numerals:** Avatar initials: `12px–14px`, `font-weight: 600`. Chip: `12.5px`, `font-weight: 500`. Tag: `11.5px`, `font-weight: 600`.
* **Light Mode Palette:** Neutral chip bg `#F1F5F9`, border `#E2E8F0`, text `#334155`. Toned variants use `--pg-status-{tone}-bg/text`.
* **Dark Mode Palette:** Neutral chip bg `#1E293B`, border `#334155`, text `#E2E8F0`. Toned variants use dark translucent tints.
* **Interactive & Visual States:** Resting, Interactive Hover, Selected, Closable (hover on `×` darkens pill icon), Disabled.
* **LTR & RTL Directional Behavior:** Icon prepend and `×` close button mirror naturally to inline-start and inline-end.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgAvatar`: `src?: string`, `name?: string` (auto-derives 2-letter initials), `size?: 'xs'|'sm'|'md'|'lg'|number`, `shape?: 'circle'|'rounded'`, `tone?: BadgeTone`.
  * `PgChip`: `tone?: BadgeTone`, `variant?: 'tonal'|'outlined'|'solid'`, `closable?: boolean`, `prependIcon?: string`, `size?: 'sm'|'md'`.
  * `PgTag`: `tone?: BadgeTone`, `label?: string`.
* **Emitted Events:**
  * `PgChip`: `click`, `close` (calls `stopPropagation()` so removing a chip inside `PgAutocomplete` does NOT toggle the dropdown).
* **Slots:**
  * `prepend`, `default`, `append`.
* **User Interactions & Click Behavior:**
  * Clicking `×` on a `PgChip` emits `close` without firing parent click handlers.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Closable chip supports `Backspace`/`Delete` when focused, and `×` button has `aria-label='Remove'`.
* **Edge Cases & Defensive Guards:**
  * Image load error on `PgAvatar` swaps seamlessly to initials without showing a broken image icon.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `PgAvatar name='Salem Elmotamed'` renders `'SE'` initials when `src` is absent or errors.
- [ ] Interaction test: Clicking `PgChip` close button emits `close` and stops propagation.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 5.11 `icons.generated.ts (SVG Path Registry & Fallback Audit)`

- **Source File:** `packages/ui/src/actions/icons.generated.ts`
- **Canonical Exports:** `ICON_PATHS`, `IconName`
- **Role & Design Intent:** Zero-font-download, tree-shakeable inline SVG icon path dictionary powering every `PgIcon` across all 4 frontends so no external Material Design Icons webfont is ever required.

#### Detected Gaps, Bugs & Audit Findings
1. Missing icon names referenced by migrated pages silently render empty `<svg>` boxes instead of logging a dev warning or falling back gracefully.
2. Several fintech operational icons (`mdi-page-layout-header-footer`, `mdi-robot-outline`, `mdi-bank-transfer`, `mdi-shield-check-outline`, `mdi-content-copy`, `mdi-check`) must be verified present in `icons.generated.ts`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)
- **Structural Anatomy:** Standardized `viewBox="0 0 24 24"` SVG path strings rendered with `fill="currentColor"`.
- **Padding, Gaps & Rhythm:** Optical `2px` internal safe zone within `24x24` grid.
- **Typography Scale & Numerals:** N/A.
- **Light Mode Palette:** Inherits `currentColor`.
- **Dark Mode Palette:** Inherits `currentColor`.
- **Interactive & Visual States:** N/A (data registry).
- **LTR & RTL Directional Behavior:** Directional icons (`chevron-left/right`, `arrow-left/right`, `logout`, `reply`) flagged for automatic `scaleX(-1)` mirroring in `PgIcon` when `html[dir="rtl"]`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)
- **Props & Parameters:** Lookup by canonical `mdi-*` name (normalized with or without `mdi-` prefix).
- **Emitted Events:** None.
- **Slots:** None.
- **User Interactions & Click Behavior:** Static registry; zero runtime network requests.
- **Keyboard Navigation & Accessibility (ARIA):** Icons rendered via `PgIcon` default to `aria-hidden="true"` unless `label` is provided.
- **Edge Cases & Defensive Guards:** Automated Vitest check scans all 414 `.tsx` files across the 4 frontends and asserts every literal `mdi-*` string exists in `icons.generated.ts`!

#### Mandatory OpenCode Verification & Automated Tests
- [ ] Governance test: Every `mdi-*` icon string referenced in `packages/ui`, `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front` resolves to a non-empty SVG path in `icons.generated.ts`.

## PART 6 — FORM INPUTS, AUTOCOMPLETE, DATE PICKER & CHECKBOX BLUEPRINTS

### 6.1 `PgFieldShell`

* **Source File:** `packages/ui/src/inputs/PgFieldShell.tsx`
* **Exported Symbols / Aliases:** `PgFieldShell, PgFormField, FormField`
* **Category:** Form Inputs & Field Anatomy
* **Purpose & Role in Platform:** The universal wrapper for EVERY form control (`PgTextField`, `PgTextarea`, `PgAutocomplete`, `PgDateInput`, `PgFileUpload`, `PgOtpInput`, `PgCodeEditor`). Guarantees consistent label typography, required asterisk, helper hint, live character counter, and red validation error line.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Missing `.pg-field--disabled` CSS Rule:** Referenced in `PgFieldShell.tsx` but undefined in `components.css`.
* **Duplicate Labels in `TableFilters`:** When a parent already renders a filter label, passing `label` into `PgFieldShell` duplicates the label above the input.
* **Missing CSS Classes (Unstyled in DOM):** `pg-field--disabled` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Flex column (`display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0;`).
* **Padding & Internal Gaps:** Label-to-control gap `6px`. Control-to-hint/error gap `5px`. Zero outer margin (parent `PgFormGrid` supplies `20px` gap).
* **Borders, Radius & Elevation:** None on shell.
* **Typography & Numerals:** Label: `12.5px / 600 / --pg-ink-primary`. Required `*`: `--pg-status-danger-dot`. Hint: `12px / 400 / --pg-ink-muted`. Error: `12px / 500 / --pg-status-danger-text`.
* **Color & Surface Tokens (Light & Dark):** Adapts automatically to Light & Dark tokens.
* **RTL (Arabic) Visual Adaptation:** Label aligns to `start`; counter aligns to `end` via `margin-inline-start: auto`.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | Transparent | None | Primary label + muted hint | N/A | 
| **Error** | Transparent | None | Error message replaces hint in `--pg-status-danger-text` (`role='alert'`) | 140ms fade | 
| **Disabled** | Opacity `0.65` on label | None | `--pg-ink-muted` | N/A | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `forId` | `string` | `''` | Links `<label for={forId}>` to native input ID. | 
| `label` | `string` | `''` | Top field label; if empty, no label row renders. | 
| `hint` | `string` | `''` | Helper text shown below control when no error is active. | 
| `error` | `string` | `''` | Validation error message; takes precedence over `hint`. | 
| `required` | `boolean` | `false` | Appends accessible red `*` after label. | 
| `hideDetails` | `boolean` | `false` | Suppresses bottom hint/error row in compact filter bars unless error is present. | 
| `counter` | `string` | `''` | Right-aligned character count (e.g. `12/120`). | 

* **Slots:** `default` (the control box).
* **Emitted Events:** None.
* **Pointer & Click Behavior:**
  * Clicking `<label>` focuses the associated control via `forId`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Connects `aria-describedby` to hint/error element ID.
* **Mandatory Edge Cases & Defensive Guards:**
  * Empty `label`, `hint`, `error`: renders control directly with zero dead vertical space.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgFieldShell.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders label, required `*`, hint, and swaps hint for `role='alert'` error when `error` prop is set.
2. Omits label DOM node completely when `label=''`.

### 6.2 `PgTextField`

* **Source File:** `packages/ui/src/inputs/PgTextField.tsx`
* **Exported Symbols / Aliases:** `PgTextField, VTextField, TextField, PgSearchInput`
* **Category:** Form Inputs & Search
* **Purpose & Role in Platform:** The primary 2026 fintech text input and dedicated table/toolbar search field. Replaces all bare `<input>` fields and ugly browser-default focus rings with a calm, spacious `40px` container where the neutral focus ring surrounds the **entire** field (including icons, prefix, suffix, and clear button).

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Focus Ring Surrounds Inner `<input>` Only:** `components.css` L1030–1032 (`.pg-table-filters :focus-visible { outline: 2px solid ... }`) paints a harsh outline around ONLY the inner `.pg-control-native` instead of the outer `.pg-control-box`!
* **Missing Adornment Classes:** `pg-control-adornment--start` and `pg-control-adornment--end` are undefined in CSS.
* **Inconsistent Icon Alignment on Login Page:** In RTL leak mode, user icon and password eye toggle sat on opposite inconsistent edges.
* **Missing CSS Classes (Unstyled in DOM):** `pg-control-adornment--end, pg-control-adornment--start, pg-tf` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Full width (`width: 100%`). Heights: `sm = 36px` (table search/filters), `md = 40px` (all forms), `lg = 44px` (login/checkout).
* **Padding & Internal Gaps:** Container padding: `4px 12px` (`2px 10px` in `sm`). Internal gap between leading icon, prefix, input, suffix, clear button, and trailing icon: `gap: 8px`.
* **Borders, Radius & Elevation:** Outer `.pg-control-box`: `1px solid var(--pg-border-default); border-radius: var(--pg-radius-sm) (8px)`. Inner `.pg-control-native`: `border: 0 !important; outline: none !important; box-shadow: none !important; background: transparent !important;`.
* **Typography & Numerals:** `13.5px / 400 / 1.4 / --pg-ink-primary` (`--pg-font-mono` + `tabular-nums` when `monospace` or `type='number'`). Placeholder `--pg-ink-faint`.
* **Color & Surface Tokens (Light & Dark):** Resting: `--pg-bg-surface`. Focus: **neutral obsidian** `border-color: var(--pg-border-focus)` + `box-shadow: var(--pg-focus-ring)` around the ENTIRE `.pg-control-box` (ZERO blue glow!). Error: `--pg-status-danger-dot` border + `--pg-focus-ring-danger`.
* **RTL (Arabic) Visual Adaptation:** Leading icon/prefix on right, trailing icon/clear/eye on left; `type='email'`, `type='url'`, and `monospace` tokens remain readable.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Resting** | `--pg-bg-surface` | 1px `--pg-border-default` | `--pg-ink-primary` | 140ms ease | 
| **Hover** | `--pg-bg-surface` | 1px `--pg-border-strong` | `--pg-ink-primary` | 140ms ease | 
| **Focused (`:focus-within`)** | `--pg-bg-surface` | 1px `--pg-border-focus` + `var(--pg-focus-ring)` on OUTER box | Inner `<input>` has ZERO outline | 140ms ease | 
| **Error / Invalid** | `--pg-bg-surface` | 1px `--pg-status-danger-dot` + `--pg-focus-ring-danger` | Error text below in `--pg-status-danger-text` | 140ms ease | 
| **Disabled** | `--pg-bg-surface-subtle` | 1px `--pg-border-subtle` | Opacity `0.58`, `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | \`string | number\` | `''` | 
| `label / placeholder / hint / error` | `string` | `''` | Passed to `PgFieldShell` and native `<input>`. | 
| `type` | \`'text' | 'password' | 'email' | 
| `size / density` | \`'sm' | 'md' | 'lg'\` | 
| `leadingIcon / prependInnerIcon` | `string` | `''` | Icon at inline-start inside `.pg-control-box`. | 
| `trailingIcon / appendInnerIcon` | `string` | `''` | Icon at inline-end inside `.pg-control-box`. | 
| `prefix / suffix` | `string` | `''` | Muted inline text (e.g. `LYD`, `%`, `https://`). | 
| `clearable` | `boolean` | `false` | Shows `24×24` clear `×` button when value is non-empty. | 
| `kbdHint` | `string` | `''` | Keyboard shortcut badge (`/` or `⌘K`) shown when unfocused & empty. | 
| `rules / validateOn` | \`RuleFn\[\] / 'blur' | 'input'\` | `[] / 'blur'` | 

* **Slots:** `prepend-inner`, `append-inner`.
* **Emitted Events:** `update:modelValue`, `clear`, `enter`, `focus`, `blur`.
* **Pointer & Click Behavior:**
  * Clicking anywhere inside `.pg-control-box` focuses the inner `<input>`.
  * Clicking the clear `×` button or password eye toggle uses `onMousedown={e => e.preventDefault()}` so focus never flickers.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `Enter` emits `enter` (submits search in `PgSearchInput`).
  * `Escape` clears search value in `PgSearchInput` when non-empty.
* **Mandatory Edge Cases & Defensive Guards:**
  * Focus inside `.pg-table-filters` or `.pg-unified-table`: inner `<input>` MUST have `outline: none` and outer `.pg-control-box` MUST own the focus ring.
  * `modelValue={0}` (numeric zero) displays `'0'` instead of empty string.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgTextField.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders `PgTextField` inside `.pg-table-filters`, focuses `<input>`, and verifies `.pg-control-box--focused` is active while inner `<input>` has zero border/outline.
2. Clicks clear button and asserts `update:modelValue('')` and `clear` fire.
3. Toggles password eye button and asserts input `type` switches between `'password'` and `'text'`.
4. Tests `PgSearchInput` debounce and `Enter`/`Escape` key behavior.

### 6.3 `PgTextarea`

* **Source File:** `packages/ui/src/inputs/PgTextarea.tsx`
* **Exported Symbols / Aliases:** `PgTextarea, VTextarea`
* **Category:** Form Inputs
* **Purpose & Role in Platform:** Multi-line text input sharing `PgFieldShell` and `.pg-control-box` neutral focus ring, with optional auto-grow height and live character counter.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Missing `.pg-ta` class & Focus Ring Consistency:** Must inherit `.pg-control-box:focus-within` neutral ring and suppress inner `<textarea>` browser outline.
* **Missing CSS Classes (Unstyled in DOM):** `pg-ta` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** `width: 100%; min-height: 92px;` (`rows` default `3`).
* **Padding & Internal Gaps:** `padding: 10px 12px;` inside `.pg-control-box--textarea`.
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-default); border-radius: var(--pg-radius-sm);`.
* **Typography & Numerals:** `13.5px / 400 / line-height: 1.55 / --pg-ink-primary`.
* **Color & Surface Tokens (Light & Dark):** Identical to `PgTextField` (neutral focus ring, zero blue glow).
* **RTL (Arabic) Visual Adaptation:** Text aligns to `start`; resize handle follows logical direction.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Resting** | `--pg-bg-surface` | 1px `--pg-border-default` | `--pg-ink-primary` | 140ms | 
| **Focused** | `--pg-bg-surface` | 1px `--pg-border-focus` + `var(--pg-focus-ring)` | `--pg-ink-primary` | 140ms | 
| **Error** | `--pg-bg-surface` | 1px `--pg-status-danger-dot` | Error line below | 140ms | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | `string` | `''` | Bound text value. | 
| `rows` | `number` | `3` | Initial visible text rows. | 
| `autoGrow` | `boolean` | `true` | Automatically expands height up to `maxRows` as user types. | 
| `counter / maxlength` | `boolean / number` | `false / 0` | Shows `len/max` counter in footer. | 

* **Slots:** None.
* **Emitted Events:** `update:modelValue`, `blur`, `focus`.
* **Pointer & Click Behavior:**
  * Vertical resize allowed unless `noResize` is set.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `Enter` inserts newline; `Ctrl+Enter` / `Cmd+Enter` emits `submit`.
* **Mandatory Edge Cases & Defensive Guards:**
  * Very long pasted text scrolls cleanly inside max-height without blowing out dialog footer.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgTextarea.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Typing updates `modelValue`, updates counter, and applies `.pg-control-box--focused` without inner outline.

### 6.4 `PgAutocomplete (Single + Multi-Select + Combobox)`

* **Source File:** `packages/ui/src/inputs/PgAutocomplete.tsx`
* **Exported Symbols / Aliases:** `PgAutocomplete, VAutocomplete, VSelect, VCombobox, Autocomplete, PgApiAutocomplete, ApiAutocomplete`
* **Category:** Form Inputs — Combobox & Selection
* **Purpose & Role in Platform:** The universal replacement for ALL dropdowns, selects, autocompletes, and multi-selects across the entire platform (ZERO native `<select>` or `<select multiple>` anywhere!). Combines Vuetify `VAutocomplete`/`VCombobox` full functionality with 2026 Linear/Stripe polish.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Multi-Select Closes Immediately on First Click:** Clicking a checkbox option (`ACTIVE` in `Status` filter) closes the dropdown immediately instead of staying open for selecting multiple values.
* **CRITICAL — Thick Black Inner Input Border:** `.pg-ac-input` inherits native browser border/outline inside `.pg-control-box`, overlapping `Any` placeholder.
* **CRITICAL — Conditional Panel Without Vapor `createIf`:** Uses `{open.value && (<div ref={panelRef} ...>)}` instead of `createIf`, causing unreliable Vapor mount/unmount.
* **Crowded Chips & Unwanted Refresh Box:** Selected chips collide with filter icon and `ApiAutocompleteControl` injects a clunky `↻` button box inside every filter field.
* **Missing CSS Classes (Unstyled in DOM):** `pg-ac-list, pg-control-adornment--end, pg-control-adornment--start, pg-z-popover` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.
* **Vapor Reactivity Trap (Conditional Overlay Without `createIf`):** Renders conditional overlay via `{open.value && (...)}` instead of `createIf` from `@vue/runtime-vapor`, breaking mount/unmount toggling in Vapor.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Trigger: `min-height: 40px` (`36px` in `sm`), grows smoothly when multi-select chips wrap (`maxVisibleChips = 3` default + `+N` overflow pill). Dropdown panel: `max-height: 280px; min-width: max(triggerWidth, 240px); overflow-y: auto;`.
* **Padding & Internal Gaps:** Trigger: `padding: 4px 10px; gap: 6px;`. Chip: `padding: 2px 8px; gap: 4px;`. Dropdown panel: `padding: 6px;`. Each option row: `padding: 9px 10px; gap: 10px; border-radius: 6px;`.
* **Borders, Radius & Elevation:** Trigger: `1px solid var(--pg-border-default); border-radius: 8px;`. Inner search input: **ZERO border, ZERO outline**. Panel: `1px solid var(--pg-border-subtle); border-radius: 12px; box-shadow: var(--pg-shadow-popover);`.
* **Typography & Numerals:** Option label: `13px / 500 / --pg-ink-primary` (selected `600`). Option subtitle: `11.5px / 400 / --pg-ink-muted`. Chip: `12px / 600`.
* **Color & Surface Tokens (Light & Dark):** Panel surface: `--pg-bg-elevated`. Highlighted option: `--pg-bg-surface-hover`. Selected option: `--pg-bg-surface-active` + checkmark icon (single) or crisp animated checkbox (multiple).
* **RTL (Arabic) Visual Adaptation:** Chips flow inline-start to inline-end; clear `×` and chevron sit at `inline-end`; panel aligns to trigger `left/right` safely within viewport.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Closed Empty** | `--pg-bg-surface` | 1px `--pg-border-default` | Placeholder in `--pg-ink-faint` | 140ms | 
| **Open & Filtering** | `--pg-bg-surface` | 1px `--pg-border-focus` + `var(--pg-focus-ring)` | Chevron rotates 180deg | 140ms ease | 
| **Multi-Select Checked** | Chip pill in `--pg-bg-surface-subtle` | 1px `--pg-border-subtle` | Checkmark box filled `--pg-accent-primary` | Dropdown **STAYS OPEN** | 
| **Loading (`PgApiAutocomplete`)** | Spinner replaces chevron | Same | `Loading options…` shimmer inside panel | 700ms spin | 
| **No Matches** | Panel shows `No matching options` | Or `Create '...'` CTA if `creatable` | `--pg-ink-muted` | Instant | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | \`any | any\[\]\` | `null` | 
| `items` | \`PgOption\[\] | any\[\]\` | `[]` | 
| `multiple` | `boolean` | `false` | Enables multi-select with removable chips + checkboxes; panel STAYS OPEN on option click! | 
| `searchable` | `boolean` | `true` | Enables live fuzzy typing inside trigger (default `true` everywhere). | 
| `creatable / allowCustom` | `boolean` | `false` | Combobox mode: pressing `Enter` or clicking `Create '...'` adds custom value. | 
| `clearable` | `boolean` | `true` | Displays single clear `×` button when selection is non-empty. | 
| `maxVisibleChips` | `number` | `3` | Caps rendered chips in trigger and shows `+N` overflow pill. | 
| `load (PgApiAutocomplete)` | `(query: string) => Promise<PgOption[]>` | `required` | Debounced (`250ms`) async server search loader with stale-request cancellation. | 

* **Slots:** `prepend-inner`, `append-inner`, `option` (custom option row), `empty`.
* **Emitted Events:** `update:modelValue`, `search`, `change`, `clear`.
* **Pointer & Click Behavior:**
  * Clicking trigger opens panel and focuses search input.
  * Clicking an option in `single` mode selects it and closes panel.
  * Clicking an option in `multiple` mode uses `onMousedown={e => e.preventDefault()}` + `e.stopPropagation()`, toggles that option's checked state, updates chips, and **KEEPS THE PANEL OPEN**.
  * Clicking a chip's `×` removes ONLY that chip (`e.stopPropagation()`).
  * Clicking outside trigger + panel closes panel cleanly.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `ArrowDown` / `ArrowUp`: moves active highlight through filtered list (wrapping cleanly) and scrolls active option into view.
  * `Enter`: toggles/selects highlighted option (or commits custom tag if `creatable=true`).
  * `Backspace` on empty search query in `multiple` mode: removes last selected chip.
  * `Escape`: closes panel and restores focus to trigger.
* **Mandatory Edge Cases & Defensive Guards:**
  * Rendered inside a scrollable card or dialog (`overflow: hidden`): panel uses `position: fixed` + auto-flip upward when `< 280px` space remains below, so it is NEVER clipped.
  * 500+ options: filters smoothly in `< 5ms` and supports keyboard scroll-into-view.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgAutocomplete.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Single-select: opens panel, filters by typing, selects with `ArrowDown` + `Enter`, emits value, and closes.
2. Multi-select: opens panel, clicks option A -> asserts panel REMAINS OPEN and `modelValue === ['A']`; clicks option B -> asserts panel REMAINS OPEN and `modelValue === ['A', 'B']`; clicks chip A `×` -> asserts `modelValue === ['B']`.
3. Asserts ZERO `<select>` elements exist in rendered DOM and inner `<input>` has zero border/outline.
4. Combobox (`creatable=true`): typing `'10.0.0.0/8'` + `Enter` emits `'10.0.0.0/8'`.

### 6.5 `PgDateInput (Vuetify VDateInput Parity + Direct Typing + Timezone)`

* **Source File:** `packages/ui/src/inputs/PgDateInput.tsx`
* **Exported Symbols / Aliases:** `PgDateInput, PgDateRangeInput, VDateInput, DateInput`
* **Category:** Form Inputs — Date & Range Picker
* **Purpose & Role in Platform:** Full Vapor-valid date and date-range input matching and surpassing Vuetify `VDateInput`: editable `YYYY-MM-DD` text entry, floating calendar grid, fast Month/Year jump picker, fintech range presets (`Today`, `Last 7d`, `Last 30d`, `This Month`, `Last Quarter`), min/max clamping, and clear button.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Duplicate Labels in `TableFilters`:** `Created`, `Activated`, `Next KYB review` rendered their label twice stacked above the input.
* **Reversed Calendar Weekdays & Inward Arrows:** Global RTL leak flipped weekdays to `SAT..SUN` and pointed month arrows inward (`>` on left, `<` on right).
* **Black Inner Focus Border & Missing `createIf`:** Native input painted a black border inside `.pg-control-box` and popover lacked Vapor `createIf`.
* **Missing CSS Classes (Unstyled in DOM):** `pg-z-popover` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.
* **Vapor Reactivity Trap (Conditional Overlay Without `createIf`):** Renders conditional overlay via `{open.value && (...)}` instead of `createIf` from `@vue/runtime-vapor`, breaking mount/unmount toggling in Vapor.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Trigger: `40px` (`36px` in `sm`). Calendar panel: `width: 304px` (single) or `width: 440px` (range with preset sidebar).
* **Padding & Internal Gaps:** Panel padding: `14px`. Header: `margin-bottom: 10px`. 7-column day grid: `gap: 3px`. Each day cell: `36×36px` centered pill.
* **Borders, Radius & Elevation:** Panel: `1px solid var(--pg-border-subtle); border-radius: 12px; box-shadow: var(--pg-shadow-popover);`. Today cell: `1.5px solid var(--pg-border-strong)`.
* **Typography & Numerals:** Input: `13px / --pg-font-mono / tabular-nums`. Month heading: `14px / 600`. Weekday header: `11px / 600 / uppercase / --pg-ink-muted`. Day numbers: `13px / 500 / tabular-nums`.
* **Color & Surface Tokens (Light & Dark):** Selected start/end day: `--pg-accent-primary` bg + `--pg-ink-on-accent` text. In-range highlight band: `--pg-accent-brand-soft` (`rgba(79,70,229,0.10)`). Outside month days: `--pg-ink-faint`.
* **RTL (Arabic) Visual Adaptation:** In LTR (`en`): weekdays run `Sun Mon Tue Wed Thu Fri Sat`, prev-month `<` on left, next-month `>` on right. In RTL (`ar`): weekdays mirror cleanly and prev/next arrows point outward properly.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Resting** | `--pg-bg-surface` | 1px `--pg-border-default` | Formatted date or `YYYY-MM-DD` placeholder | 140ms | 
| **Calendar Open** | `--pg-bg-surface` | 1px `--pg-border-focus` + `var(--pg-focus-ring)` | Calendar pops below/above trigger | 140ms | 
| **Day Hover** | `--pg-bg-surface-hover` | None | `--pg-ink-primary` | 100ms | 
| **Day Selected** | `--pg-accent-primary` | None | `--pg-ink-on-accent` (600) | 100ms | 
| **Day Disabled (`< min` or `> max`)** | Transparent | None | 30% opacity, `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | \`string | Date | Date\[\] | 
| `multiple` | \`boolean | 'range'\` | `false` | 
| `min / max` | \`string | Date\` | `undefined` | 
| `clearable` | `boolean` | `true` | Shows clear `×` button when a date is selected. | 
| `label` | `string` | `''` | Optional label (MUST be omitted when parent `TableFilters` renders `.pg-filter-label`). | 

* **Slots:** None.
* **Emitted Events:** `update:modelValue`, `clear`.
* **Pointer & Click Behavior:**
  * Clicking calendar icon or input opens calendar popover.
  * Clicking Month/Year heading toggles fast 12-month grid (and clicking Year toggles 12-year grid) so picking distant dates takes 2 clicks.
  * In `range` mode: first click sets range start; hovering previews range highlight; second click completes range and closes popover (auto-swapping if second date < first date).
  * Clicking a preset (`Last 7 days`, `Last 30 days`, `This month`) immediately applies the range and closes popover.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Typing `2026-11-15` + `Enter` parses and commits date immediately.
  * Arrow keys navigate days in the calendar grid; `PageUp`/`PageDown` step months; `Escape` closes popover.
* **Mandatory Edge Cases & Defensive Guards:**
  * Invalid typed string (e.g. `2026-99-99`): reverts draft to previous valid value and shows clear validation hint.
  * Timezone safety: parses `YYYY-MM-DD` at local noon (`T12:00:00`) so UTC offsets never shift the selected day by ±1 day.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgDateInput.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Opens calendar via click, verifies 7 weekday headers in LTR (`Sun..Sat`), selects a day, and asserts ISO date emitted.
2. Range mode: clicks start day, clicks end day, asserts `[start, end]` emitted and `pg-cal-day--in-range` applied.
3. Clicks `Last 30 days` preset and asserts 30-day range emitted.
4. Types `2026-11-27` + `Enter` and asserts value commits.

### 6.6 `PgCheckbox (2026 Tactile Squircle)`

* **Source File:** `packages/ui/src/inputs/PgCheckbox.tsx`
* **Exported Symbols / Aliases:** `PgCheckbox, VCheckbox, Checkbox, PgFormChecklist, FormChecklist`
* **Category:** Form Inputs — Selection & Compliance Checklists
* **Purpose & Role in Platform:** Modern 2026 animated checkbox with indeterminate state and a dedicated compliance `variant='card'` row for Maker-Checker and Export Safeguard checklists.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Pre-Checked Yet Export Disabled Bug:** Wrapping `vael-ui/vapor` `<Checkbox>` caused visual checked state to desync from `PgFormChecklist`'s `modelValue` on `/transactions` (all 4 boxes looked checked while `checklistComplete` stayed `false` and `Export summary` stayed disabled!).
* **Missing `.pg-checkbox--bare` CSS class** and ugly native checkbox appearance.
* **Missing CSS Classes (Unstyled in DOM):** `pg-checkbox--bare` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.
* **Fragile `vael-ui/vapor` Wrapper (`Checkbox`):** Leaks mismatched prop bindings and unmapped styles; must be owned natively in `@pg/ui` or strictly bridged.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** `18×18px` rounded-square (`border-radius: 5px;`). Card variant: full-width clickable card (`padding: 12px 14px; border-radius: 10px;`).
* **Padding & Internal Gaps:** Box-to-label gap `10px`. Checklist vertical stack gap `8px`.
* **Borders, Radius & Elevation:** Unchecked: `1.5px solid var(--pg-border-strong)`. Checked: `1.5px solid var(--pg-accent-primary)`.
* **Typography & Numerals:** Label: `13px / 500 / 1.4 / --pg-ink-primary`. Description: `12px / 400 / --pg-ink-muted`.
* **Color & Surface Tokens (Light & Dark):** Checked fill: `--pg-accent-primary` with `--pg-ink-on-accent` SVG checkmark. Card-checked tint: `--pg-status-success-bg` + `--pg-status-success-border`.
* **RTL (Arabic) Visual Adaptation:** Box sits at `inline-start`, label flows inline-start to inline-end.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Unchecked** | `--pg-bg-surface` | 1.5px `--pg-border-strong` | Empty box | 140ms ease | 
| **Hover** | `--pg-bg-surface-hover` | 1.5px `--pg-ink-primary` | Subtle border darken | 120ms ease | 
| **Checked** | `--pg-accent-primary` | 1.5px `--pg-accent-primary` | Animated SVG checkmark draw-in | 160ms cubic-bezier | 
| **Indeterminate** | `--pg-accent-primary` | 1.5px `--pg-accent-primary` | Crisp horizontal SVG dash | 140ms | 
| **Focus-Visible** | Same | `var(--pg-focus-ring)` on `.pg-chk__box` | Same | 120ms | 
| **Disabled** | Opacity `0.5` | Same | `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | \`boolean | any\[\]\` | `false` | 
| `value` | \`string | number | object\` | 
| `indeterminate` | `boolean` | `false` | Shows dash icon for partial table select-all state. | 
| `variant` | \`'default' | 'card'\` | `'default'` | 
| `label / description / error` | `string` | `''` | Accessible label, optional subtitle, and error line. | 

* **Slots:** None.
* **Emitted Events:** `update:modelValue`.
* **Pointer & Click Behavior:**
  * Clicking anywhere on the box, label, or card row toggles the native hidden checkbox and emits exact boolean/array value.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `Tab` focuses native `<input type='checkbox'>` (paints focus ring on `.pg-chk__box` via `:has(:focus-visible)`); `Space` toggles.
* **Mandatory Edge Cases & Defensive Guards:**
  * Pure Vapor implementation (NO `vael-ui` `<Checkbox>` wrapper!) so `checked={props.modelValue === true}` is 100% deterministic.
  * When `PgFormChecklist` starts with `{}`: ALL checkboxes MUST render visually unchecked (`checked=false`) until the user clicks each one.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgCheckbox.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Mounts `PgCheckbox` with `modelValue={false}` -> asserts `input.checked === false` and SVG checkmark absent; clicks -> emits `update:modelValue(true)`.
2. Mounts `PgFormChecklist` with 4 checks and empty `{}` -> asserts 0 checked boxes and incomplete hint visible; clicks all 4 -> asserts `complete` becomes `true` and Export button enables.
3. Tests array `modelValue` toggling with `value='ACTIVE'`.

### 6.7 `PgSearchInput (Dedicated Table & Header Search Control)`

* **Source File:** `packages/ui/src/inputs/PgSearchInput.tsx`
* **Exported Symbols / Aliases:** `PgSearchInput`
* **Category:** Form Inputs
* **Purpose & Role in Platform:** Specialized `PgTextField` preset with leading `mdi-magnify`, `clearable=true`, `size='sm'`, optional debounced `onSearch`, `Escape`-to-clear, and neutral outer `.pg-control-box` focus ring.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Prop-Default & Token Audit Required:** Affected by `dc.ts` stripping `options.props`; verify every default prop, RTL logical spacing property, and dark-mode contrast token.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Follows `@pg/ui` 4px/8px spatial grid and responsive breakpoints (`sm < 640`, `md < 960`, `lg < 1280`, `xl >= 1280`).
* **Padding & Internal Gaps:** Uses `--pg-space-*` logical tokens exclusively (zero hardcoded pixels in callers).
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-subtle)` hairlines; `--pg-radius-sm` (8px) for controls, `--pg-radius-md` (12px) for surfaces.
* **Typography & Numerals:** `Plus Jakarta Sans` (LTR) / `Cairo` (RTL) / `JetBrains Mono` (code/IDs/money) with `tabular-nums`.
* **Color & Surface Tokens (Light & Dark):** 100% CSS custom properties (`--pg-*`) verified for WCAG AA >= 4.5:1 contrast in Light and Dark mode.
* **RTL (Arabic) Visual Adaptation:** 100% logical properties (`inline-start`/`inline-end`); numeric/code values isolated LTR.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface` | 1px `--pg-border-subtle` | `--pg-ink-primary` | 140ms ease | 
| **Hover / Active** | `--pg-bg-surface-hover` | 1px `--pg-border-strong` | `--pg-ink-primary` | 120ms ease | 
| **Focus-Visible** | Same | `var(--pg-focus-ring)` (neutral) | Same | 120ms ease | 
| **Disabled** | Opacity `0.45` | Same | `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `All declared props` | `Strictly typed` | `Explicit defaults` | Preserved intact by `dc.ts` and validated with unit tests. | 

* **Slots:** Documented named slots with Vapor `createSlot` / `slots.*?.()`.
* **Emitted Events:** Typed Vue emits; zero silent swallows.
* **Pointer & Click Behavior:**
  * Full hit-target area (`>= 32px`), `e.stopPropagation()` where nested inside clickable rows.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Full `Tab`, `Enter`, `Space`, and `Escape` WAI-ARIA 1.2 compliance.
* **Mandatory Edge Cases & Defensive Guards:**
  * Safe in SSR/jsdom tests without `window`; handles `null`/`undefined`/empty arrays gracefully.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgSearchInput.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Verifies all exported symbols (`PgSearchInput`) render cleanly in Light/Dark & LTR/RTL with zero console warnings.
2. Verifies every prop default, user interaction, and keyboard shortcut behaves exactly per blueprint.

### 6.8 `PgFormField (`FormField` — Standardized Form Row Wrapper)`

* **Source File:** `packages/ui/src/inputs/PgFormField.tsx`
* **Canonical Exports:** `PgFormField`, `FormField`
* **Role & Design Intent:** High-level form field wrapper for custom controls (e.g., `PgCodeEditor`, `PgFileUpload`, `PgOtpInput`, or composite multi-input rows) that need the exact same label, required asterisk, help tooltip, hint text, and validation error slot as `PgTextField`.

#### Detected Gaps, Bugs & Audit Findings

1. Missing `for` / `id` association between `<label>` and custom slotted inputs, breaking click-to-focus and screen-reader announcements.
2. Inconsistent vertical gap between label (`6px`) and error message (`4px`) compared to `PgFieldShell`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Vertical flex stack (`gap: 6px`): (1) Header row (`label` + optional red `*` + optional info tooltip icon + optional right-aligned character count or action link), (2) Control slot, (3) Footer helper row (`min-height: 0` when empty; `margin-top: 2px` when hint/error is present).
* **Padding, Gaps & Rhythm:** Label margin-bottom `0` (controlled by `gap: 6px`). Footer row `12px` text with `gap: 4px` icon + message.
* **Typography Scale & Numerals:** Label: `13px`, `font-weight: 500`, `--pg-ink-secondary`. Hint: `12px`, `--pg-ink-muted`. Error: `12px`, `font-weight: 500`, `--pg-status-danger-text`.
* **Light Mode Palette:** Label `#334155`, required asterisk `#DC2626`, error `#B91C1C`, hint `#64748B`.
* **Dark Mode Palette:** Label `#CBD5E1`, required asterisk `#F87171`, error `#FCA5A5`, hint `#94A3B8`.
* **Interactive & Visual States:** Default, Required, Disabled (`.pg-field--disabled` dims label to `opacity: 0.6`), Error (shakes gently only on explicit form submit failure; steady red border/message otherwise).
* **LTR & RTL Directional Behavior:** Label aligns inline-start; optional right-aligned action aligns inline-end.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `label?: string`, `forId?: string`, `required?: boolean`, `hint?: string`, `error?: string | string[]`, `disabled?: boolean`, `tooltip?: string`
* **Emitted Events:**
  * None.
* **Slots:**
  * `label`, `labelAction`, `default`, `hint`, `error`.
* **User Interactions & Click Behavior:**
  * Clicking label focuses the element matching `forId`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Provides `aria-describedby` IDs for hint and error text.
* **Edge Cases & Defensive Guards:**
  * When both `hint` and `error` exist, `error` takes precedence and replaces `hint` cleanly without vertical layout jump.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `required=true` renders accessible required indicator; `error` overrides `hint` with `role='alert'`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.9 `PgApiAutocomplete (Async Server-Backed Autocomplete)`

* **Source File:** `packages/ui/src/inputs/PgApiAutocomplete.tsx`
* **Canonical Exports:** `PgApiAutocomplete`
* **Role & Design Intent:** Async server-searching wrapper around `PgAutocomplete` for large remote datasets (Merchants, Bank Accounts, Settlement Batches, Users, Report Specs) with debounced querying, request cancellation, and infinite-scroll / load-more pagination.

#### Detected Gaps, Bugs & Audit Findings

1. **Live Bug Observed:** `ApiAutocompleteControl` inside `TableFilters` injects a clunky bordered `↻` refresh button box *inside* the text field, cramping the input and breaking alignment with adjacent filters.
2. Rapid typing fires overlapping requests without `AbortController`, causing older slower responses to overwrite newer search results.
3. Selected initial ID (e.g., from URL query `?merchantId=m_123`) displays raw UUID instead of resolving the human-readable merchant name when not in the first page of results.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Inherits 100% of `PgAutocomplete` visual shell (NO awkward bordered `↻` box inside the input!). While fetching, displays a subtle `14px` `PgSpinner` in the trailing adornment slot (replacing the chevron temporarily). Optional subtle `'Refresh list'` icon button lives inside the dropdown footer if needed.
* **Padding, Gaps & Rhythm:** Identical to `PgAutocomplete` (`height: 40px` md / `32px` sm, `padding: 0 12px`, `border-radius: 8px`).
* **Typography Scale & Numerals:** Option primary line: `13.5px/500`; optional secondary subtitle (e.g., Merchant ID or email): `12px` `--pg-ink-muted`.
* **Light Mode Palette:** Identical to `PgAutocomplete`.
* **Dark Mode Palette:** Identical to `PgAutocomplete`.
* **Interactive & Visual States:** Idle, Debouncing, Loading (inline spinner + skeleton rows on initial open), Loaded, Empty Search Result (`'No matches for "..."'`), Network Error (inline retry button inside dropdown), Has More (`'Load more...'` footer row).
* **LTR & RTL Directional Behavior:** Spinner, clear button, and option subtitles align cleanly in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `endpoint: string` (or `fetcher: (query: string, page: number, signal: AbortSignal) => Promise<{ items: any[]; hasMore?: boolean }>`)
  * `queryParam?: string` (default `'search'`), `debounceMs?: number` (default `250`)
  * `itemTitle`, `itemValue`, `itemSubtitle`
  * `multiple?: boolean`, `clearable?: boolean`, `preloadOnOpen?: boolean` (default `true`)
* **Emitted Events:**
  * `update:modelValue(value)`
  * `select(item)`
  * `error(err)`
* **Slots:**
  * `item`, `empty`, `selection`.
* **User Interactions & Click Behavior:**
  * Opening dropdown triggers initial fetch if cache is empty; typing debounces `250ms` and cancels any previous in-flight `AbortController`.
  * In `multiple=true` mode, clicking an option toggles it and KEEPS the dropdown open (inherited from `PgAutocomplete`).
  * If a fetch fails, shows a clean inline error row with a `'Retry'` button inside the popover instead of failing silently.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Full `PgAutocomplete` keyboard navigation (`ArrowDown/Up`, `Enter`, `Escape`, `Backspace` to pop last chip).
* **Edge Cases & Defensive Guards:**
  * Preserves already-selected option labels in an internal Map cache so changing the search query never turns selected chips into raw IDs.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Async race test: Typing `'a'` then `'ab'` within 100ms aborts first request and renders only `'ab'` results.
- [ ] Visual regression test: Zero bordered `↻` refresh button rendered inside the input box.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.10 `PgDateRangeInput (Dual-Calendar Fintech Date Range Picker)`

* **Source File:** `packages/ui/src/inputs/PgDateInput.tsx`
* **Canonical Exports:** `PgDateRangeInput`, `PgDateRange`
* **Role & Design Intent:** Purpose-built fintech date range selector for Dashboard analytics, Settlement Reconciliation, Ledger Statements, and Report Catalog exports — combining Vuetify `VDateInput` polish with one-click relative presets (`Today`, `Last 7 Days`, `Last 30 Days`, `Last 90 Days`, `This Month`, `Last Month`).

#### Detected Gaps, Bugs & Audit Findings

1. Filter bars currently render two separate clunky date inputs with duplicated labels (`From` + `From`, `To` + `To`) instead of one cohesive `PgDateRangeInput` or properly labeled single `PgDateInput` controls.
2. Hovering over end dates during range selection does not preview the highlighted band between start and hovered date.
3. **Forensic Audit — Missing CSS Classes:** `pg-z-popover` are referenced in `packages/ui/src/inputs/PgDateInput.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.
4. **Forensic Audit — Missing Vapor `createIf`:** Conditional overlay branch renders without `createIf` from `@vue/runtime-vapor`, breaking mount/unmount toggling.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Single `40px` input shell displaying formatted range (`Nov 01, 2026  →  Nov 26, 2026`) with leading calendar icon and trailing clear `×` button. Opening displays a pure-Vapor `createIf` floating popover (`padding: 0`, `border-radius: 14px`, `--pg-shadow-xl`, `border: 1px solid var(--pg-border-subtle)`) split into: (1) Left Presets Sidebar (`152px` wide, `padding: 12px 8px`, right hairline divider), (2) Dual side-by-side month grids on desktop (`>=768px`) or single month grid on mobile, (3) Compact footer showing selected ISO range + `Cancel` / `Apply` buttons.
* **Padding, Gaps & Rhythm:** Day cell `34px x 34px`. Start/End caps: solid `--pg-accent-primary` circle/squircle (`border-radius: 8px`). In-range days: soft continuous band (`background: var(--pg-accent-brand-soft)`, `border-radius: 0`).
* **Typography Scale & Numerals:** Input value `13.5px/500 tabular-nums`; Month/Year header `14px/600`; Weekday headers `11.5px/600 --pg-ink-muted`; Day numbers `13px/500 tabular-nums`.
* **Light Mode Palette:** Popover `#FFFFFF`, presets hover `#F1F5F9`, active preset `#EEF2FF` + `#4338CA`, range band `#EEF2FF`, endpoints `#4F46E5` with `#FFFFFF` ink.
* **Dark Mode Palette:** Popover `#111827`, presets hover `#1E293B`, active preset `rgba(99,102,241,0.18)` + `#A5B4FC`, range band `rgba(99,102,241,0.16)`, endpoints `#6366F1` with `#FFFFFF` ink.
* **Interactive & Visual States:** Empty, Picking Start, Picking End (live hover band preview), Complete Range, Disabled Dates (`min`/`max`), Preset Active.
* **LTR & RTL Directional Behavior:** Presets sidebar flips to inline-start (right); range band start/end rounded corners use logical `border-start-start-radius` / `border-end-end-radius`; weekday order matches active locale (never reversed in English!).

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue`: `{ start: string | null; end: string | null }` (ISO `YYYY-MM-DD`)
  * `presets?: Array<{ label: string; value: () => PgDateRange }>` (defaults to Today / 7D / 30D / 90D / MTD / Last Month)
  * `min?: string`, `max?: string`, `clearable?: boolean` (default `true`), `autoApply?: boolean` (default `false`)
* **Emitted Events:**
  * `update:modelValue(range: PgDateRange)`
  * `apply(range: PgDateRange)`
  * `clear()`
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * First click sets provisional `start` and clears `end`; hovering subsequent days previews the range band; second click sets `end` (auto-swapping if second click < first click).
  * Clicking a preset immediately highlights both endpoints and applies (or stages for `Apply`).
  * Clicking `×` clears both `start` and `end` to `null`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Arrow keys move day focus across calendar grid; `Enter` selects start/end; `PageUp`/`PageDown` changes month; `Escape` closes popover without applying uncommitted changes.
* **Edge Cases & Defensive Guards:**
  * Selecting the exact same day twice sets a valid 1-day range (`start === end`).
  * Popover flips upward automatically if near bottom of viewport.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Interaction test: Clicking `'Last 90 Days'` preset emits exact 90-day ISO `start` and `end`.
- [ ] Swap test: Clicking `2026-11-20` then `2026-11-10` normalizes to `{ start: '2026-11-10', end: '2026-11-20' }`.
- [ ] LTR/RTL test: English mode displays `Su Mo Tu We Th Fr Sa` left-to-right.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.11 `PgChoice (Rich Radio / Checkbox Selection Cards)`

* **Source File:** `packages/ui/src/inputs/PgChoice.tsx`
* **Canonical Exports:** `PgChoice`, `PgChoiceState`
* **Role & Design Intent:** Elevated card-based selection tiles for onboarding flows, settlement rail selection, payout frequency, and report export templates where each option needs an icon, title, description, and optional badge.

#### Detected Gaps, Bugs & Audit Findings

1. Selection state relies on weak border change without a crisp checkmark/radio indicator or focus ring.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Clickable card (`padding: 14px 16px`, `border-radius: 10px`, `border: 1.5px solid var(--pg-border-subtle)`, `display: flex; align-items: flex-start; gap: 12px`) containing: leading icon box (`36px x 36px`, `border-radius: 8px`), title + description text stack, and trailing `PgCheckbox`/`PgRadio` indicator.
* **Padding, Gaps & Rhythm:** Minimum touch height `60px`, internal gap `12px`.
* **Typography Scale & Numerals:** Title: `14px/600`; Description: `12.5px` `--pg-ink-muted` `line-height: 1.4`.
* **Light Mode Palette:** Resting `#FFFFFF` + `#E2E8F0` border; Hover `#F8FAFC` + `#CBD5E1`; Selected `#EEF2FF` tint + `1.5px solid #4F46E5`.
* **Dark Mode Palette:** Resting `#111827` + `#1E293B` border; Hover `#162032` + `#334155`; Selected `rgba(99,102,241,0.14)` + `1.5px solid #6366F1`.
* **Interactive & Visual States:** Unchecked, Checked, Indeterminate, Hover, Focus-Visible (`0 0 0 3px var(--pg-focus-ring)`), Disabled (`opacity: 0.5; cursor: not-allowed`).
* **LTR & RTL Directional Behavior:** Leading icon sits on right, selection indicator on left.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: boolean`
  * `mode?: 'checkbox' | 'radio'` (default `'checkbox'`)
  * `title: string`, `description?: string`, `icon?: string`, `badge?: string`, `disabled?: boolean`
* **Emitted Events:**
  * `update:modelValue(next: boolean)`
* **Slots:**
  * `default`, `icon`, `badge`.
* **User Interactions & Click Behavior:**
  * Clicking anywhere on the card toggles selection unless `disabled=true`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * `Space` / `Enter` toggles; proper `role='checkbox'` or `role='radio'` + `aria-checked`.
* **Edge Cases & Defensive Guards:**
  * Interactive links inside description call `stopPropagation()` so clicking `'Learn more'` does not flip the card.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Interaction test: Clicking card body toggles `aria-checked` and emits `update:modelValue`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.12 `PgSwitch (`VSwitch` — Tactile Boolean Toggle)`

* **Source File:** `packages/ui/src/inputs/PgToggle.tsx`
* **Canonical Exports:** `PgSwitch`, `VSwitch`
* **Role & Design Intent:** Immediate-effect boolean toggle for feature flags, webhook active status, sandbox mode switches, and notification channel toggles.

#### Detected Gaps, Bugs & Audit Findings

1. Wraps legacy `vael-ui` switch primitives that lack smooth thumb spring animation, loading spinner inside thumb, and proper dark-mode unchecked track contrast.
2. **Forensic Audit — Legacy `vael-ui` Dependency:** Wraps `Radio, RadioGroup, Switch` from `vael-ui`. Replace with pure Vapor-native `@pg/ui` markup so styling, focus rings, and disabled states are 100% deterministic.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Horizontal row (`display: inline-flex; align-items: center; gap: 10px`) with native hidden `<input type='checkbox' role='switch'>`, pill track (`38px x 22px` md; `32px x 18px` sm; `border-radius: 999px`), and circular white thumb (`18px x 18px` md; `14px x 14px` sm; `box-shadow: 0 1px 3px rgba(0,0,0,0.22)`).
* **Padding, Gaps & Rhythm:** Thumb inset `2px` from track edge; translates `16px` (`14px` sm) on active with `transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1)`.
* **Typography Scale & Numerals:** Label: `13.5px/500`; optional description below label: `12px` `--pg-ink-muted`.
* **Light Mode Palette:** Off track `#CBD5E1`, hover `#94A3B8`; On track `#4F46E5` (or semantic `success` `#059669`, `danger` `#DC2626`); Thumb `#FFFFFF`.
* **Dark Mode Palette:** Off track `#334155`, hover `#475569`; On track `#6366F1`; Thumb `#FFFFFF`.
* **Interactive & Visual States:** Off, On, Loading (subtle `12px` spinner inside thumb, disabled pointer), Hover, Focus-Visible (`0 0 0 3px var(--pg-focus-ring)` around track), Disabled (`opacity: 0.45`).
* **LTR & RTL Directional Behavior:** Thumb slides left (negative X) when toggled ON in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: boolean`
  * `label?: string`, `description?: string`, `tone?: 'brand'|'success'|'warning'|'danger'`, `size?: 'sm'|'md'`, `loading?: boolean`, `disabled?: boolean`, `labelPosition?: 'end'|'start'`
* **Emitted Events:**
  * `update:modelValue(next: boolean)`
  * `change(next: boolean)`
* **Slots:**
  * `label`.
* **User Interactions & Click Behavior:**
  * Clicking track or label toggles value immediately; blocked while `loading=true` or `disabled=true`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * `Space` toggles switch; `role='switch'`, `aria-checked`.
* **Edge Cases & Defensive Guards:**
  * Works seamlessly inside table cells (`size='sm'`, no label) with `stopPropagation()` so toggling a webhook switch does not open the row detail drawer.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Interaction test: Clicking `PgSwitch` toggles `aria-checked` and emits `update:modelValue(true)`.
- [ ] Guard test: `loading=true` blocks click events and renders spinner.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.13 `PgRadioGroup & PgRadio (Mutually Exclusive Option Selector)`

* **Source File:** `packages/ui/src/inputs/PgToggle.tsx`
* **Canonical Exports:** `PgRadioGroup`, `VRadioGroup`, `PgRadio`, `VRadio`
* **Role & Design Intent:** Clean mutually exclusive radio list (vertical or inline horizontal) for small option sets (2–5 choices such as settlement frequency, fee bearer, or export format).

#### Detected Gaps, Bugs & Audit Findings

1. Radio outer ring and inner dot fail to scale smoothly and lack hover ring feedback in Dark Mode.
2. **Forensic Audit — Legacy `vael-ui` Dependency:** Wraps `Radio, RadioGroup, Switch` from `vael-ui`. Replace with pure Vapor-native `@pg/ui` markup so styling, focus rings, and disabled states are 100% deterministic.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Group renders `<div role='radiogroup'>` with `PgFieldShell` label/error support. Each `PgRadio` renders a `18px x 18px` circle (`border-radius: 999px`, `border: 1.5px solid var(--pg-border-strong)`) with animated `8px` inner white dot on solid accent fill when checked.
* **Padding, Gaps & Rhythm:** Vertical gap `10px`, horizontal `inline` gap `20px`. Radio-to-label gap `8px`.
* **Typography Scale & Numerals:** Label `13.5px/500`, optional description `12px --pg-ink-muted`.
* **Light Mode Palette:** Unchecked border `#94A3B8`, hover `#4F46E5`; Checked bg `#4F46E5`, inner dot `#FFFFFF`.
* **Dark Mode Palette:** Unchecked border `#475569`, hover `#818CF8`; Checked bg `#6366F1`, inner dot `#FFFFFF`.
* **Interactive & Visual States:** Unchecked, Checked, Hover, Focus-Visible (`0 0 0 3px var(--pg-focus-ring)`), Disabled, Error.
* **LTR & RTL Directional Behavior:** Radio circle sits at inline-start; inline row flows right-to-left.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgRadioGroup`: `modelValue`, `label?: string`, `inline?: boolean`, `disabled?: boolean`, `rules?: Rule[]`, `error?: string`, `options?: PgOption[]`.
  * `PgRadio`: `value: unknown`, `label: string`, `description?: string`, `disabled?: boolean`.
* **Emitted Events:**
  * `update:modelValue(value)`.
* **Slots:**
  * `default` (child `PgRadio` items).
* **User Interactions & Click Behavior:**
  * Selecting any radio updates group `modelValue` via `provide`/`inject`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Arrow Up/Down (or Left/Right when inline) moves selection cleanly across non-disabled radios.
* **Edge Cases & Defensive Guards:**
  * Uses `sameValue()` so numeric and string values match reliably.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Interaction test: Clicking second `PgRadio` updates group `modelValue` and unchecks first radio.
- [ ] Keyboard test: `ArrowDown` moves focus and selection to next enabled radio.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.14 `PgSlider (`VSlider` — Range & Threshold Control)`

* **Source File:** `packages/ui/src/layout/PgShellPrimitives.tsx`
* **Canonical Exports:** `PgSlider`, `VSlider`
* **Role & Design Intent:** Precision numeric slider for risk scoring thresholds, fraud velocity rules, fee split percentages, and timeout configurations.

#### Detected Gaps, Bugs & Audit Findings

1. Current `PgSlider` renders an unstyled browser `<input type='range'>` with inconsistent appearance across Chrome/Firefox/Safari and no live value pill.
2. **Forensic Audit — Missing CSS Classes:** `pg-form` are referenced in `packages/ui/src/layout/PgShellPrimitives.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Custom-styled track (`height: 6px`, `border-radius: 999px`) with active filled progress segment (`--pg-accent-primary`), `18px x 18px` circular white thumb with `2px solid var(--pg-accent-primary)` border and `--pg-shadow-sm`, plus optional top-right live tabular-nums value badge (`75%`).
* **Padding, Gaps & Rhythm:** Minimum vertical hit area `28px` around track; `gap: 10px` between label/value header and track.
* **Typography Scale & Numerals:** Value readout `13px/600 tabular-nums`.
* **Light Mode Palette:** Track `#E2E8F0`, fill `#4F46E5`, thumb `#FFFFFF`.
* **Dark Mode Palette:** Track `#1E293B`, fill `#6366F1`, thumb `#F8FAFC`.
* **Interactive & Visual States:** Resting, Hover (thumb scales `1.08`), Dragging (active halo `0 0 0 5px var(--pg-focus-ring)`), Focus-Visible, Disabled.
* **LTR & RTL Directional Behavior:** Track fills from right-to-left under `dir='rtl'`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: number`, `min?: number` (0), `max?: number` (100), `step?: number` (1), `label?: string`, `unit?: string`, `showValue?: boolean` (default `true`), `disabled?: boolean`
* **Emitted Events:**
  * `update:modelValue(n: number)`
  * `change(n: number)`
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Dragging thumb or clicking anywhere along track updates value smoothly in real time.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Left/Right/Up/Down adjust by `step`; `PageUp`/`PageDown` adjust by `10 * step`; `Home`/`End` jump to `min`/`max`.
* **Edge Cases & Defensive Guards:**
  * Clamps out-of-range initial values cleanly to `[min, max]`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Interaction test: Updating range input emits numeric `update:modelValue` (never string) and updates displayed readout.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.15 `PgFileUpload (`VFileInput` — KYB Document & Asset Dropzone)`

* **Source File:** `packages/ui/src/inputs/PgFileUpload.tsx`
* **Canonical Exports:** `PgFileUpload`, `VFileInput`
* **Role & Design Intent:** Drag-and-drop + click-to-browse file uploader for KYB commercial licenses, merchant logos, bank verification letters, and CSV batch payout files.

#### Detected Gaps, Bugs & Audit Findings

1. Missing client-side MIME type and max-size validation feedback before upload; uploaded file list lacks clear file-size readout and individual remove buttons.
2. **Forensic Audit — Legacy `vael-ui` Dependency:** Wraps `FileUpload` from `vael-ui`. Replace with pure Vapor-native `@pg/ui` markup so styling, focus rings, and disabled states are 100% deterministic.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Dashed dropzone box (`min-height: 112px`, `padding: 20px`, `border: 1.5px dashed var(--pg-border-strong)`, `border-radius: 12px`, centered upload icon + primary instruction + accepted formats/size hint) followed by a clean vertical list of attached file rows (`height: 44px`, file-type icon, filename, formatted KB/MB size, progress bar if uploading, remove `×` button).
* **Padding, Gaps & Rhythm:** Dropzone-to-file-list gap `10px`; file row padding `8px 12px`, `gap: 10px`, `border-radius: 8px`.
* **Typography Scale & Numerals:** Dropzone CTA `13.5px/600`; Hint `12px --pg-ink-muted`; Filename `13px/500 truncate`; Size `12px tabular-nums --pg-ink-muted`.
* **Light Mode Palette:** Zone bg `#F8FAFC`, hover `#F1F5F9`, drag-over `#EEF2FF` + `1.5px dashed #4F46E5`; File row `#FFFFFF` + `1px solid #E2E8F0`.
* **Dark Mode Palette:** Zone bg `#0F172A`, hover `#162032`, drag-over `rgba(99,102,241,0.14)` + `1.5px dashed #6366F1`; File row `#111827` + `1px solid #1E293B`.
* **Interactive & Visual States:** Empty, Drag-Over, Has Files, Uploading (inline `PgProgressBar`), Validation Error (red dashed border + exact reason: `'Exceeds 10 MB limit'`), Disabled.
* **LTR & RTL Directional Behavior:** File icon at inline-start, remove button at inline-end.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: File | File[] | null`, `multiple?: boolean`, `accept?: string` (e.g. `'.pdf,.png,.jpg'`), `maxSizeMb?: number` (default `10`), `maxFiles?: number`, `label?: string`, `hint?: string`, `disabled?: boolean`
* **Emitted Events:**
  * `update:modelValue(files)`
  * `reject(reasons: Array<{ file: File; reason: string }>)`
* **Slots:**
  * `default` (custom dropzone body).
* **User Interactions & Click Behavior:**
  * Supports both drag-and-drop and clicking the dropzone to open native file dialog.
  * Rejects oversized or wrong-MIME files immediately with clear inline error message without wiping already-valid files.
  * Resets hidden `<input type='file'>` value after selection so re-uploading the same filename after removing it works.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Dropzone is a focusable `<button>`/`<label>` triggered via `Enter`/`Space`; each remove button is individually focusable.
* **Edge Cases & Defensive Guards:**
  * Drag-leave from child elements does not flicker drag-over state (uses enter/leave counter).

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Validation test: Dropping a 25MB file when `maxSizeMb=10` emits `reject` and shows size error.
- [ ] Removal test: Clicking remove `×` removes file and updates `modelValue`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.16 `PgOtpInput (6-Digit Verification & 2FA Code Input)`

* **Source File:** `packages/ui/src/inputs/PgOtpInput.tsx`
* **Canonical Exports:** `PgOtpInput`
* **Role & Design Intent:** Segmented one-time-passcode input for Checkout 3DS/SMS verification, Merchant Login 2FA, and Sensitive Payout Approval.

#### Detected Gaps, Bugs & Audit Findings

1. Pasting a 6-digit code from SMS/clipboard fails to distribute across all 6 boxes, and RTL mode reverses digit entry order instead of keeping numeric OTP left-to-right.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Horizontal row (`dir='ltr'` ALWAYS for numeric OTP!) of `length` (default `6`) crisp squircle boxes (`46px x 52px`, `border-radius: 10px`, `gap: 8px`, centered tabular monospace digit), with optional hyphen separator after box 3 for 6-digit codes.
* **Padding, Gaps & Rhythm:** Box width `46px` (mobile `40px`), height `52px` (mobile `46px`), gap `8px`.
* **Typography Scale & Numerals:** `22px`, `font-weight: 600`, `font-family: var(--pg-font-mono)`, centered.
* **Light Mode Palette:** Bg `#FFFFFF`, border `1.5px solid #CBD5E1`, filled border `#94A3B8`, focus border `#4F46E5` + `0 0 0 3px var(--pg-focus-ring)`, error border `#DC2626`.
* **Dark Mode Palette:** Bg `#111827`, border `1.5px solid #334155`, filled border `#475569`, focus border `#6366F1` + `0 0 0 3px var(--pg-focus-ring)`, error border `#EF4444`.
* **Interactive & Visual States:** Empty, Focused, Filled, Complete (fires `complete`), Error (red ring), Disabled/Verifying (`opacity: 0.6`).
* **LTR & RTL Directional Behavior:** Digits MUST remain `dir='ltr'` so `123456` reads and enters left-to-right even in Arabic UI; surrounding label and error align RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: string`, `length?: number` (default `6`), `mask?: boolean` (for PINs), `autofocus?: boolean`, `disabled?: boolean`, `error?: string`
* **Emitted Events:**
  * `update:modelValue(code: string)`
  * `complete(code: string)` (fired automatically when all N digits are filled).
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Typing a digit fills current box and auto-advances focus to box `i+1`.
  * Pressing `Backspace` on an empty box moves focus to `i-1` and clears it.
  * Pasting `'482910'` into ANY box distributes all 6 digits cleanly and emits `complete('482910')`.
  * Sets `autocomplete='one-time-code'` and `inputmode='numeric'` on box 0 for mobile SMS autofill.
* **Keyboard Navigation & Accessibility (ARIA):**
  * `ArrowLeft`/`ArrowRight` moves between boxes; non-numeric characters are ignored.
* **Edge Cases & Defensive Guards:**
  * Pasting formatted `'482-910'` or `'482 910'` strips non-digits automatically before filling.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Paste test: Pasting `'482-910'` populates all 6 boxes and emits `complete('482910')`.
- [ ] RTL test: Container retains `dir='ltr'` even when `document.documentElement.dir === 'rtl'`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 6.17 `PgCodeEditor (JSON & Report Spec Code Editor)`

* **Source File:** `packages/ui/src/inputs/PgCodeEditor.tsx`
* **Canonical Exports:** `PgCodeEditor`
* **Role & Design Intent:** Monospace JSON/config editor with synchronized line-number gutter, live JSON syntax validation, line-level error highlighting, Format/Prettify button, and Copy button used in Report Studio, Webhook Payload Tester, and System Settings.

#### Detected Gaps, Bugs & Audit Findings

1. **Missing CSS Classes:** ALL 6 classes (`pg-json-editor__frame`, `pg-json-editor__frame--invalid`, `pg-json-editor__gutter`, `pg-json-editor__gutter-line`, `pg-json-editor__gutter-line--error`, `pg-json-editor__input`) have ZERO CSS definitions in `components.css`, causing the editor to render as a broken unaligned raw textarea!
2. Scrolling the textarea vertically does not synchronize `scrollTop` with the line-number gutter.
3. **Forensic Audit — Missing CSS Classes:** `pg-json-editor__frame, pg-json-editor__frame--invalid, pg-json-editor__gutter, pg-json-editor__gutter-line, pg-json-editor__gutter-line--error, pg-json-editor__input` are referenced in `packages/ui/src/inputs/PgCodeEditor.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Enclosed frame (`.pg-json-editor__frame`, `border-radius: 10px`, `border: 1px solid var(--pg-border-default)`, `overflow: hidden`, `dir='ltr'` ALWAYS for code) with: (1) Compact top toolbar (`height: 36px`, language badge `JSON`, live status pill `Valid JSON` / `Line 14 error`, `Format` button, `Copy` button), (2) Split flex body: fixed-width gutter (`44px`, right-aligned line numbers, `--pg-bg-surface-subtle`, right hairline border) + monospace `<textarea>` (`flex: 1`, `padding: 12px 14px`, `line-height: 20px`, `tab-size: 2`).
* **Padding, Gaps & Rhythm:** Min height `180px` (configurable via `minHeight` / `rows`), line-height locked identically to `20px` in both gutter and textarea so line numbers NEVER drift.
* **Typography Scale & Numerals:** `13px`, `font-family: var(--pg-font-mono)`, `line-height: 20px`.
* **Light Mode Palette:** Frame `#FFFFFF`, gutter `#F8FAFC`, gutter text `#94A3B8`, error line gutter bg `#FEE2E2` + text `#B91C1C`, focus frame border `#4F46E5` + `0 0 0 3px var(--pg-focus-ring)`.
* **Dark Mode Palette:** Frame `#0B1120`, gutter `#0F172A`, gutter text `#64748B`, error line gutter bg `rgba(239,68,68,0.2)` + text `#FCA5A5`, focus frame border `#6366F1`.
* **Interactive & Visual States:** Valid, Syntax Error (`.pg-json-editor__frame--invalid` red border + `.pg-json-editor__gutter-line--error` highlight + exact parse error line message below), Read-Only, Focused.
* **LTR & RTL Directional Behavior:** Code frame strictly enforces `dir='ltr'`; outer label and error message respect RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: string`, `language?: 'json' | 'text'` (default `'json'`), `label?: string`, `readonly?: boolean`, `minHeight?: string` (default `'200px'`), `showFormat?: boolean` (default `true`)
* **Emitted Events:**
  * `update:modelValue(code: string)`
  * `validChange(valid: boolean)`
* **Slots:**
  * `toolbar`.
* **User Interactions & Click Behavior:**
  * Scrolling `<textarea>` syncs `gutterRef.scrollTop = textareaRef.scrollTop`.
  * Clicking `Format` runs `JSON.stringify(JSON.parse(val), null, 2)` and updates `modelValue`.
  * Pressing `Tab` inserts 2 spaces instead of jumping focus away (with `Escape` then `Tab` escape hatch for accessibility).
* **Keyboard Navigation & Accessibility (ARIA):**
  * `Tab` inserts 2 spaces; `Cmd/Ctrl + Shift + F` formats JSON.
* **Edge Cases & Defensive Guards:**
  * Empty string is valid when field is optional (`required=false`).

#### Mandatory OpenCode Verification & Automated Tests

- [ ] CSS test: All 6 `.pg-json-editor__*` classes exist in `components.css` and lock identical `20px` line-height.
- [ ] Validation test: Invalid JSON `{a: 1}` applies `.pg-json-editor__frame--invalid` and highlights error line.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

## PART 7 — OVERLAYS, DIALOGS, DRAWERS, COMMAND PALETTE & MENUS BLUEPRINTS

### 7.1 `PgDialog (Base Modal Primitive)`

* **Source File:** `packages/ui/src/overlays/PgDialog.tsx`
* **Exported Symbols / Aliases:** `PgDialog, VDialog, PgConfirmDialog, ConfirmDialog, PgFormModal, FormModal, PgDetailsDialog`
* **Category:** Overlays & Modals
* **Purpose & Role in Platform:** Strict 3-zone (`header` / scrollable `body` / sticky `footer`) modal dialog system where the close `×` button lives in a dedicated flex slot inside the header so it can NEVER overlap titles, inputs, or badges.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Overlay Stacking:** Opening `GlobalSearchPalette` (`Ctrl+K`) while `ContextHelpDrawer` is open stacks both overlays on top of each other; opening a modal should coordinate via a shared overlay stack or close non-modal drawers.
* **ConfirmDialog & DetailsDialog Ref Exposure:** Must work seamlessly with `dc.ts` `expose({ show })` after `dc.ts` fix.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Sizes: `sm = 460px`, `md = 580px`, `lg = 760px`, `xl = 960px`. `max-height: min(86vh, 840px); width: calc(100vw - 32px);`.
* **Padding & Internal Gaps:** Header: `padding: 20px 24px; gap: 16px;`. Body: `padding: 24px; gap: 20px; overflow-y: auto;`. Footer: `padding: 16px 24px; gap: 10px;`.
* **Borders, Radius & Elevation:** Panel: `1px solid var(--pg-border-subtle); border-radius: var(--pg-radius-lg) (16px); box-shadow: var(--pg-shadow-modal);`. Header bottom & Footer top: `1px solid var(--pg-border-subtle)`.
* **Typography & Numerals:** Title: `16px / 700 / 1.35 / --pg-ink-primary`. Subtitle: `13px / 400 / --pg-ink-muted`.
* **Color & Surface Tokens (Light & Dark):** Backdrop: `var(--pg-bg-overlay)` + `backdrop-filter: blur(4px)`. Panel: `--pg-bg-elevated`. Footer: `--pg-bg-surface-subtle`.
* **RTL (Arabic) Visual Adaptation:** Title at inline-start, close `×` button (`32×32` ghost button, `flex-shrink: 0`) at inline-end; footer actions aligned to `justify-content: flex-end`.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Closed** | Unmounted via Vapor `createIf` | Zero DOM footprint | Body scroll unlocked | N/A | 
| **Open** | `--pg-bg-elevated` centered in viewport | `--pg-shadow-modal` | Focus trapped inside modal | 160ms scale(0.97->1) + fade | 
| **Danger Confirm** | Red danger CTA button | Optional 4-box safeguard checklist in body | Submit disabled until checklist complete | N/A | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | `boolean` | `false` | Controls visibility (mounted via Vapor `createIf`). | 
| `title / subtitle` | `string` | `''` | Header title and description. | 
| `size` | \`'sm' | 'md' | 'lg' | 
| `persistent` | `boolean` | `false` | Disables backdrop-click and Escape closing during in-flight financial mutations. | 
| `errorMessage (PgFormModal)` | `string` | `''` | Renders `<PgAlert tone='danger'>` cleanly at top of body. | 

* **Slots:** `default` (body), `footer` / `actions` (bottom bar).
* **Emitted Events:** `update:modelValue`, `afterLeave`.
* **Pointer & Click Behavior:**
  * Clicking backdrop closes modal unless `persistent=true` or `loading=true`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Focus trap cycles `Tab`/`Shift+Tab` inside modal; `Escape` closes unless `persistent`; restores focus to trigger element on close.
* **Mandatory Edge Cases & Defensive Guards:**
  * Nested scroll inside long modal forms: header and footer stay pinned while ONLY `.pg-dialog__body` scrolls.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgDialog.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Opens `PgDialog`, verifies `role='dialog' aria-modal='true'`, verifies close `×` button is inside `.pg-dialog__header` flex row (not `position: absolute`), clicks backdrop -> closes.
2. Tests `persistent={true}` blocks `Escape` and backdrop close.
3. Tests `PgConfirmDialog.show()` promise resolves `true` on confirm and `false` on cancel.

### 7.2 `PgDrawer (Slide-Over Inspector)`

* **Source File:** `packages/ui/src/overlays/PgDrawer.tsx`
* **Exported Symbols / Aliases:** `PgDrawer, SlideOverDrawer`
* **Category:** Overlays & Drawers
* **Purpose & Role in Platform:** Right-edge (or left-edge in RTL) slide-over inspector drawer for `InboundEventDrawer`, `GatewayHealthDrawer`, `ApplicationDetailDrawer`, `JournalEntryDrawer`, `ContextHelpDrawer`, and `SandboxCheckoutInspector`.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **`ContextHelpDrawer` Contrast & Route Mapping:** On `/transactions`, `ContextHelpDrawer` displayed `OperatorCases` and rendered white text on light gray under `CRITICAL`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Full viewport height (`100vh`), widths: `sm = 420px`, `md = 540px`, `lg = 680px`, `xl = 840px` (`max-width: 100vw`).
* **Padding & Internal Gaps:** Header `20px 24px`, Body `24px` (`gap: 20px`), Footer `16px 24px`.
* **Borders, Radius & Elevation:** `border-inline-start: 1px solid var(--pg-border-subtle); box-shadow: var(--pg-shadow-modal);`.
* **Typography & Numerals:** Eyebrow `11px / 700 / uppercase / --pg-ink-muted`. Title `17px / 700 / --pg-ink-primary`.
* **Color & Surface Tokens (Light & Dark):** Surface `--pg-bg-elevated`; critical callouts inside drawer MUST use `--pg-status-danger-bg` + `--pg-status-danger-text`.
* **RTL (Arabic) Visual Adaptation:** Slides in from `inset-inline-end` (right in EN, left in AR).

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Closed** | Unmounted via Vapor `createIf` | None | N/A | N/A | 
| **Open** | `--pg-bg-elevated` pinned to `inset-inline-end: 0` | 1px hairline + shadow | Focus trapped | 200ms slide-in | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | `boolean` | `false` | Open state. | 
| `title / subtitle / eyebrow` | `string` | `''` | Header hierarchy. | 
| `size` | \`'sm' | 'md' | 'lg' | 
| `scrim` | `boolean` | `true` | Optional backdrop dim (set `false` for non-blocking Help drawer). | 

* **Slots:** `default`, `headerActions`, `footer`.
* **Emitted Events:** `update:modelValue`.
* **Pointer & Click Behavior:**
  * Backdrop click closes when `scrim=true` and not `persistent`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `Escape` closes drawer and restores trigger focus.
* **Mandatory Edge Cases & Defensive Guards:**
  * Body scrolls independently with `min-height: 0; flex: 1 1 auto;`.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgDrawer.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Opens `PgDrawer`, verifies title/body/footer padding and `Escape` close.

### 7.3 `PgCommandPalette (Global Search & Guide Search)`

* **Source File:** `packages/ui/src/overlays/PgCommandPalette.tsx`
* **Exported Symbols / Aliases:** `PgCommandPalette, default`
* **Category:** Overlays — Command & Search Palette
* **Purpose & Role in Platform:** Bare, keyboard-first search palette (`Ctrl+K` Global Search & `Ctrl+Shift+K` Guide Search) with a `56px` borderless search header, `ESC` badge (zero overlapping `×` button!), and grouped scrollable results.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Typing Navigates Away Immediately:** Typing `'merchant'` into Guide Search Palette navigated away to `/guide/a/b04-01` instead of filtering results because global or item keydown handlers were not isolated from `<input>`.
* **Missing `.pg-command-backdrop` class** and LTR/RTL mismatch with outer shell.
* **Missing CSS Classes (Unstyled in DOM):** `pg-command-backdrop` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Centered near top (`margin-top: min(12vh, 96px)`), `width: min(680px, calc(100vw - 32px))`, `max-height: 70vh`.
* **Padding & Internal Gaps:** Search header: `height: 56px; padding: 0 20px; gap: 12px;`. Results listbox: `padding: 10px; gap: 4px;`. Result row: `padding: 10px 12px; border-radius: 8px;`.
* **Borders, Radius & Elevation:** Panel: `1px solid var(--pg-border-subtle); border-radius: 16px; box-shadow: var(--pg-shadow-modal);`. Header bottom: `1px solid var(--pg-border-subtle)`.
* **Typography & Numerals:** Search input: `15px / 400` borderless. Group header: `11px / 700 / uppercase / --pg-ink-muted`. Result title: `13.5px / 600`.
* **Color & Surface Tokens (Light & Dark):** Active result row: `--pg-bg-surface-active` + `--pg-ink-primary`.
* **RTL (Arabic) Visual Adaptation:** Inherits document `dir` cleanly (never hardcoded LTR when app is RTL).

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Empty Query** | Shows Recent + Golden Rules / Quick Actions | No `×` overlap | Auto-focused input | 140ms fade | 
| **Typing / Filtering** | Live debounced results | Zero accidental navigation while typing! | First hit highlighted | Instant | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue` | `boolean` | `false` | Controls visibility via `createIf`. | 
| `placeholder / ariaLabel` | `string` | `''` | Search input placeholder and accessible name. | 

* **Slots:** `default` (scoped `{ query }`), `actions`, `footer`.
* **Emitted Events:** `update:modelValue`, `update:query`, `search`, `submit`.
* **Pointer & Click Behavior:**
  * Hover highlights result row; click navigates and closes palette.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Typing printable characters ONLY updates `query` — NEVER triggers global navigation shortcuts!
  * `ArrowDown`/`ArrowUp` moves active index; `Enter` executes active result; `Escape` closes palette.
* **Mandatory Edge Cases & Defensive Guards:**
  * Opening `PgCommandPalette` automatically closes any open `ContextHelpDrawer` so overlays never stack.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgCommandPalette.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Opens palette, types `'merchant'`, asserts `query === 'merchant'` and NO navigation occurs until `Enter` is pressed.
2. Asserts zero overlapping close `×` button exists in search header.

### 7.4 `PgMenu (Floating Dropdown & Action Menu)`

* **Source File:** `packages/ui/src/overlays/PgMenu.tsx`
* **Exported Symbols / Aliases:** `PgMenu, VMenu, PgTooltip, VTooltip`
* **Category:** Overlays — Menus & Tooltips
* **Purpose & Role in Platform:** Viewport-aware floating action menus (App Bar Language, Theme, Account, and page overflow menus) and accessible hover/focus tooltips.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Missing Vapor `createIf` in BOTH `PgMenu` & `PgTooltip`:** Conditional `{isOpen() && (...)}` fails to toggle reliably in pure Vue 3.6 Vapor — breaking the App Bar Language Menu completely!
* **Broken `location='bottom end'` Alignment:** `PgMenu` L29 ignored `end` alignment, clipping header menus near the right viewport edge.
* **Missing `--pg-z-popover` / `--pg-z-tooltip` class hooks.**
* **Missing CSS Classes (Unstyled in DOM):** `pg-menu-trigger, pg-z-popover` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.
* **Vapor Reactivity Trap (Conditional Overlay Without `createIf`):** Renders conditional overlay via `{open.value && (...)}` instead of `createIf` from `@vue/runtime-vapor`, breaking mount/unmount toggling in Vapor.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** `PgMenu` panel: `min-width: 180px; max-width: 280px;`. `PgTooltip`: `max-width: 320px;`.
* **Padding & Internal Gaps:** Menu panel `padding: 6px;`. Menu item `padding: 8px 10px; gap: 10px;`. Tooltip `padding: 6px 10px;`.
* **Borders, Radius & Elevation:** Menu: `1px solid var(--pg-border-subtle); border-radius: 12px; box-shadow: var(--pg-shadow-popover);`. Tooltip: `border-radius: 6px;`.
* **Typography & Numerals:** Menu item: `13px / 500`. Tooltip: `12px / 500 / 1.4`.
* **Color & Surface Tokens (Light & Dark):** Menu: `--pg-bg-elevated`. Tooltip: inverted high-contrast (`#0f172a` bg / `#f8fafc` text in Light; `#f4f4f5` bg / `#09090b` text in Dark).
* **RTL (Arabic) Visual Adaptation:** `location='bottom end'` aligns panel right edge to trigger right edge in LTR, and left edge to trigger left edge in RTL.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Closed** | Unmounted via Vapor `createIf` | None | N/A | N/A | 
| **Open** | `position: fixed; z-index: var(--pg-z-popover)` | Auto-flips upward if `<240px` below | First item focused on keyboard open | 120ms fade | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `modelValue / open` | `boolean` | `undefined` | Optional controlled open state. | 
| `location` | \`'bottom start' | 'bottom end' | 'top start' | 
| `offset` | `number` | `6` | Pixel gap between trigger and panel. | 

* **Slots:** `activator` (`{ props }`), `default` (menu items or tooltip trigger).
* **Emitted Events:** `update:modelValue`, `update:open`.
* **Pointer & Click Behavior:**
  * Clicking trigger toggles menu (`e.stopPropagation()`); clicking outside or selecting an item closes menu.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `Escape` closes menu; `ArrowDown`/`ArrowUp` navigates `[role='menuitem']` items.
* **Mandatory Edge Cases & Defensive Guards:**
  * Window resize/scroll while open repositions panel or closes cleanly.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgMenuAndTooltip.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Clicks activator button, asserts `.pg-menu-panel` mounts via `createIf`, clicks item -> emits action and unmounts panel.
2. Tests `location='bottom end'` stays within `window.innerWidth - 8`.
3. Hovers/focuses `PgTooltip` trigger -> asserts tooltip mounts and hides on blur/mouseleave.

### 7.5 `PgDetailsDialog (Read-Only Key-Value Inspector Modal)`

- **Source File:** `packages/ui/src/overlays/PgDetailsDialog.tsx`
- **Canonical Exports:** `PgDetailsDialog`, `DetailsFieldsDialog`
- **Role & Design Intent:** Read-only modal inspector displaying structured entity attributes (`PgFieldsSection` seamless `1px` hairline grid) and optional secondary sections (e.g., Audit Metadata, Webhook Headers) without forcing pages to compose raw `PgDialog` + `PgFieldsSection` boilerplate.

#### Detected Gaps, Bugs & Audit Findings
1. Previously duplicated between Part 4 and Part 7; consolidated here as the single canonical overlay blueprint.
2. Header close `X` button lacks flex-gap protection against long titles, and internal `PgFieldsSection` tiles render with awkward outer gaps instead of seamless `1px` hairlines.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)
- **Structural Anatomy:** Built on `PgDialog` (`size="lg"` `680px` default) with sticky header (`padding: var(--pg-space-dialog-header)`), scrollable body (`padding: var(--pg-space-dialog-body)`) containing seamless `PgFieldsSection` grids (`gap: 1px`), and sticky footer (`padding: var(--pg-space-dialog-footer)`) with `Close` button and optional primary action (e.g., `Edit` or `Download Receipt`).
- **Padding, Gaps & Rhythm:** Section-to-section vertical gap `20px`; zero gaps between field boxes inside `PgFieldsSection`.
- **Typography Scale & Numerals:** Title `17px/600`; field labels `11.5px/500 --pg-ink-muted`; values `14px/500` (`tabular-nums` for amounts, `JetBrains Mono` for copyable `PgMonoRef` IDs).
- **Light Mode Palette:** Surface `--pg-bg-surface` (`#ffffff`), border `--pg-border-subtle` (`#e5e7eb`), shadow `--pg-shadow-modal`.
- **Dark Mode Palette:** Elevated surface `--pg-bg-elevated` (`#1e1e26`), border `--pg-border-subtle` (`#242429`), shadow `--pg-shadow-modal`.
- **Interactive & Visual States:** Loading (`PgSkeleton` field grid), Ready, Empty, Copyable IDs active.
- **LTR & RTL Directional Behavior:** Close `X` and grid columns mirror cleanly via logical properties.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)
- **Props & Parameters:** `modelValue: boolean`, `title: string`, `subtitle?: string`, `sections: PgFieldSection[]`, `loading?: boolean`, `size?: 'sm'|'md'|'lg'|'xl'`.
- **Emitted Events:** `update:modelValue(open: boolean)`.
- **Slots:** `headerExtra`, `default`, `footer`.
- **User Interactions & Click Behavior:** Clicking any copyable `PgMonoRef` copies to clipboard with emerald checkmark fade without closing the dialog.
- **Keyboard Navigation & Accessibility (ARIA):** Full focus trap, `Escape` closes, `aria-modal="true"`.
- **Edge Cases & Defensive Guards:** Empty sections are automatically skipped rather than rendering blank boxes.

#### Mandatory OpenCode Verification & Automated Tests
- [ ] Unit test: Renders `PgFieldsSection` with `gap: 1px` seamless hairlines and non-overlapping header close `X`.
- [ ] Verified in Light & Dark Mode (elevated `#1e1e26` surface) and EN (LTR) / AR (RTL).

### 7.6 `PgConfirmDialog (Destructive & Standard Confirmation Modal)`

* **Source File:** `packages/ui/src/overlays/PgFormModal.tsx`
* **Canonical Exports:** `PgConfirmDialog`
* **Role & Design Intent:** Dedicated, high-clarity confirmation dialog for irreversible financial or operational actions (Refund Payment, Suspend Merchant, Revoke API Key, Delete Report Spec) with optional type-to-confirm safety lock for critical operations.

#### Detected Gaps, Bugs & Audit Findings

1. Destructive actions sometimes render a neutral primary blue button instead of a clear semantic danger button, and dialog header/body/footer padding feels cramped.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Built on `PgDialog` (`maxWidth: '460px'`, `padding: 24px`). Top section: `40px x 40px` tonal icon badge (amber warning / crimson danger / indigo info) beside crisp `17px/600` title and `14px` body explanation (`margin-top: 8px`, `line-height: 1.55`). Optional `confirmText` input (`Type SUSPEND to confirm`). Footer (`margin-top: 24px`, `display: flex; justify-content: flex-end; gap: 10px`): `Cancel` (`variant='outlined'`) + Primary/Danger confirm button.
* **Padding, Gaps & Rhythm:** Outer padding `24px`, icon-to-text gap `14px`, footer button gap `10px`.
* **Typography Scale & Numerals:** Title `17px/600`, Body `14px --pg-ink-secondary`.
* **Light Mode Palette:** Danger icon badge bg `#FEF2F2`, icon `#DC2626`; Warning bg `#FFFBEB`, icon `#D97706`.
* **Dark Mode Palette:** Danger icon badge bg `rgba(239,68,68,0.16)`, icon `#F87171`; Warning bg `rgba(245,158,11,0.16)`, icon `#FBBF24`.
* **Interactive & Visual States:** Resting, Locked (when `requireText` does not match), Loading (confirm button spins, Cancel & Escape disabled while in-flight).
* **LTR & RTL Directional Behavior:** Icon badge on inline-start, footer buttons mirrored cleanly.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: boolean`, `title: string`, `message: string`, `tone?: 'danger' | 'warning' | 'info' | 'brand'` (default `'danger'`), `confirmLabel?: string`, `cancelLabel?: string`, `loading?: boolean`, `requireText?: string`
* **Emitted Events:**
  * `update:modelValue(open: boolean)`
  * `confirm()`
  * `cancel()`
* **Slots:**
  * `default` (rich detail summary such as amount & merchant ID).
* **User Interactions & Click Behavior:**
  * Confirm button stays disabled until typed input matches `requireText` (when specified).
  * Closing resets typed confirmation text cleanly.
* **Keyboard Navigation & Accessibility (ARIA):**
  * `Escape` cancels (unless `loading=true`); initial focus lands on `Cancel` for `tone='danger'` (preventing accidental Enter confirmation!).
* **Edge Cases & Defensive Guards:**
  * Double-clicking Confirm is blocked while `loading=true`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Safety test: When `tone='danger'`, initial focus lands on `Cancel` button, not `Confirm`.
- [ ] Lock test: `requireText='REFUND'` keeps Confirm disabled until exact string is entered.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 7.7 `PgFormModal (`FormModal` — Structured Create/Edit Modal)`

* **Source File:** `packages/ui/src/overlays/PgFormModal.tsx`
* **Canonical Exports:** `PgFormModal`, `FormModal`
* **Role & Design Intent:** Standardized modal form container with fixed non-scrolling header, cleanly padded scrollable form body, and sticky footer with validation-aware Submit button — used across Create Merchant, Add Bank Account, Configure Webhook, and Run Report modals.

#### Detected Gaps, Bugs & Audit Findings

1. Long forms inside `PgFormModal` scroll the header and close `X` off-screen or let the close `X` overlap the modal title.
2. Clicking Submit does not automatically invoke internal `PgForm.validate()` before emitting `submit`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Flex-column modal (`max-height: 88dvh`): (1) Sticky Header (`padding: 20px 24px 16px`, `border-bottom: 1px solid var(--pg-border-subtle)`, title + optional subtitle on start, `32px x 32px` close `X` button cleanly aligned on end with `gap: 16px` — ZERO overlap!), (2) Scrollable Body (`flex: 1 1 auto; overflow-y: auto; padding: 20px 24px`), (3) Sticky Footer (`padding: 16px 24px`, `border-top: 1px solid var(--pg-border-subtle)`, optional left status/error text + right-aligned `Cancel` & `Save` buttons with `gap: 10px`).
* **Padding, Gaps & Rhythm:** Default `maxWidth: '580px'` (`sm: 440px`, `md: 580px`, `lg: 760px`, `xl: 960px`). Internal form vertical gap `16px`.
* **Typography Scale & Numerals:** Header title `17px/600`, subtitle `13px --pg-ink-muted`.
* **Light Mode Palette:** Surface `#FFFFFF`, footer subtle `#F8FAFC` or `#FFFFFF` with `#E2E8F0` top divider.
* **Dark Mode Palette:** Surface `#111827`, footer `#0F172A` with `#1E293B` top divider.
* **Interactive & Visual States:** Idle, Validating, Submitting (Submit button shows spinner, fields disabled, backdrop close blocked), Server Error (top `PgAlert tone='danger'` inside body).
* **LTR & RTL Directional Behavior:** Close `X` moves cleanly to inline-end (top-left) without overlapping Arabic title.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `modelValue: boolean`, `title: string`, `subtitle?: string`, `size?: 'sm'|'md'|'lg'|'xl'`, `submitLabel?: string`, `cancelLabel?: string`, `loading?: boolean`, `error?: string | null`, `persistent?: boolean`
* **Emitted Events:**
  * `update:modelValue(open)`
  * `submit()`
  * `cancel()`
* **Slots:**
  * `default` (form fields), `footerExtra`.
* **User Interactions & Click Behavior:**
  * Wraps body in `<PgForm>` so clicking Submit validates all registered child inputs and only emits `submit` if valid.
  * If `error` prop is non-empty, renders a unified `PgAlert tone='danger'` at the top of the scrollable body and scrolls it into view.
* **Keyboard Navigation & Accessibility (ARIA):**
  * `Escape` closes when not `loading`/`persistent`; Focus Trap keeps `Tab` inside modal.
* **Edge Cases & Defensive Guards:**
  * Dropdowns (`PgAutocomplete`, `PgDateInput`) inside `PgFormModal` render in fixed overlay layer above modal `z-index` so they are NEVER clipped by the modal body's `overflow-y: auto`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Layout test: Close `X` button bounding box NEVER intersects modal title bounding box.
- [ ] Overlay layering test: Opening a `PgAutocomplete` inside `PgFormModal` renders above the modal footer without clipping.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 7.8 `PgTooltip (`VTooltip` — Floating Contextual Hint)`

* **Source File:** `packages/ui/src/overlays/PgTooltip.tsx`
* **Canonical Exports:** `PgTooltip`, `VTooltip`
* **Role & Design Intent:** Lightweight floating label for icon-only buttons, truncated table cells, collapsed sidebar rail icons, and compliance field definitions.

#### Detected Gaps, Bugs & Audit Findings

1. **Vapor Bug:** Conditional tooltip render lacks Vapor `createIf`, and `.pg-z-tooltip` class is missing in `components.css`, causing tooltips to either never appear or render behind modals/headers.
2. **Forensic Audit — Missing CSS Classes:** `pg-z-tooltip` are referenced in `packages/ui/src/overlays/PgTooltip.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.
3. **Forensic Audit — Missing Vapor `createIf`:** Conditional overlay branch renders without `createIf` from `@vue/runtime-vapor`, breaking mount/unmount toggling.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Compact dark pill (`padding: 6px 10px`, `max-width: 260px`, `border-radius: 7px`, `z-index: var(--pg-z-tooltip)` = `1300` (`--pg-z-tooltip`), `pointer-events: none`, crisp `6px` fade+translate entrance after `220ms` hover delay).
* **Padding, Gaps & Rhythm:** Offset `8px` from trigger element; viewport edge clamp `8px`.
* **Typography Scale & Numerals:** `12px`, `font-weight: 500`, `line-height: 1.4`.
* **Light Mode Palette:** Bg `#0F172A`, text `#F8FAFC`, shadow `0 6px 16px rgba(15,23,42,0.18)`.
* **Dark Mode Palette:** Bg `#F8FAFC`, text `#0F172A` (high-contrast inverted surface), shadow `0 6px 18px rgba(0,0,0,0.45)`.
* **Interactive & Visual States:** Hidden, Visible (on hover after `220ms` delay OR immediately on keyboard `:focus-visible`).
* **LTR & RTL Directional Behavior:** `start`/`end` placements flip automatically in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `text?: string`, `location?: 'top' | 'bottom' | 'start' | 'end'` (default `'top'`), `delay?: number` (default `220`), `disabled?: boolean`
* **Emitted Events:**
  * None.
* **Slots:**
  * `activator` / `default` (trigger), `content` (rich tooltip text).
* **User Interactions & Click Behavior:**
  * Uses pure Vapor `createIf` + `getBoundingClientRect()` fixed positioning so it escapes `overflow: hidden` parents.
  * Auto-flips from `top` to `bottom` if within `48px` of viewport top.
  * Hides immediately on `Escape`, mouseleave, scroll, or click.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Links trigger via `aria-describedby` when open; never steals focus.
* **Edge Cases & Defensive Guards:**
  * Disabled on coarse touch pointers (`@media (hover: none)`) so tapping an icon button doesn't leave a stuck tooltip.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Vapor test: Hovering trigger mounts tooltip via `createIf` after delay; mouseleave unmounts cleanly.
- [ ] CSS test: `.pg-z-tooltip` applies `z-index: var(--pg-z-tooltip)` above modals.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

## PART 8 — FEEDBACK, ALERTS, TOASTS, BADGES & EMPTY STATES BLUEPRINTS

### 8.1 `PgAlert (Single Unified Alert & Banner System)`

* **Source File:** `packages/ui/src/feedback/PgAlert.tsx`
* **Exported Symbols / Aliases:** `PgAlert, VAlert, AlertView`
* **Category:** Feedback & Banners
* **Purpose & Role in Platform:** The ONE unified alert & banner primitive for the entire platform (Sandbox Execution Plane banner, Email-not-configured warning, KYB revalidation notice, inline form errors). Zero uncolored or inconsistent alerts anywhere.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Banner Spacing & Action Gap:** On `/dashboard`, warning text sat on the far right while `Configure communication` sat on the far left with a massive empty middle gap and leading period `.Email delivery...`.
* **Missing CSS Classes (Unstyled in DOM):** `pg-status` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Full-width flex row (`align-items: flex-start; gap: 12px; width: 100%;`).
* **Padding & Internal Gaps:** `padding: 14px 16px;` (`10px 14px` in `density='compact'`). Title-to-body gap `3px`. Actions sit cleanly aligned at `inline-end` with `flex-shrink: 0`.
* **Borders, Radius & Elevation:** `1px solid var(--pg-status-<tone>-border); border-inline-start: 3px solid var(--pg-status-<tone>-dot); border-radius: var(--pg-radius-md) (12px);`.
* **Typography & Numerals:** Title: `13px / 700 / uppercase or sentence`. Body: `13px / 400 / 1.5`.
* **Color & Surface Tokens (Light & Dark):** Every tone (`info`, `success`, `warning`, `danger`, `neutral`) strictly maps to `--pg-status-<tone>-bg`, `-border`, `-text`, `-dot`.
* **RTL (Arabic) Visual Adaptation:** 3px accent bar uses `border-inline-start`; icon sits at start; actions/close sit at end.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **`info`** | `--pg-status-info-bg` | `--pg-status-info-border` + 3px dot bar | `--pg-status-info-text` | 140ms | 
| **`success`** | `--pg-status-success-bg` | `--pg-status-success-border` + 3px dot bar | `--pg-status-success-text` | 140ms | 
| **`warning`** | `--pg-status-warning-bg` | `--pg-status-warning-border` + 3px dot bar | `--pg-status-warning-text` | 140ms | 
| **`danger`** | `--pg-status-danger-bg` | `--pg-status-danger-border` + 3px dot bar | `--pg-status-danger-text` | 140ms | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `tone / type` | \`'info' | 'success' | 'warning' | 
| `title` | `string` | `''` | Optional bold alert heading. | 
| `closable` | `boolean` | `false` | Renders clean `28×28` ghost dismiss `×` button. | 
| `modelValue / open` | `boolean` | `true` | Controls dismissible visibility. | 

* **Slots:** `default` (body copy), `actions` (right-aligned CTA links/buttons).
* **Emitted Events:** `update:modelValue`, `close`.
* **Pointer & Click Behavior:**
  * Clicking close `×` dismisses alert cleanly.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Uses `role='alert' aria-live='assertive'` for `danger`/`warning` and `role='status' aria-live='polite'` for `info`/`success`.
* **Mandatory Edge Cases & Defensive Guards:**
  * Multi-message array (`messages: string[]`) renders a clean bulleted list inside the alert.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgAlert.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders all 5 tones and verifies exact semantic CSS classes and ARIA roles.
2. Clicks dismiss `×` when `closable={true}` and asserts alert unmounts.

### 8.2 `PgToast, PgToaster & toastStore (Auto-Dismissing Notifications)`

* **Source File:** `packages/ui/src/feedback/PgToast.tsx`
* **Exported Symbols / Aliases:** `PgToast, PgToaster, Toaster, showToast, dismissToast, pauseToast, resumeToast, useToasts`
* **Category:** Feedback — Floating Toasts
* **Purpose & Role in Platform:** Modern bottom-end toast notification stack with guaranteed auto-dismiss timer, animated progress bar, pause-on-hover, stack limit (4 max), optional action CTA, and crisp borderless dismiss `×` button.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Missing CSS for `.pg-toast__close`, `.pg-toast__action`, `.pg-toast__timer--paused`:** Caused the `[×]` button on `/dashboard` to render with a heavy black browser border and a huge empty white gap between text and close button.
* **Missing CSS Classes (Unstyled in DOM):** `pg-toast__action, pg-toast__close, pg-toast__timer--paused` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Fixed stack at `bottom: 24px; inset-inline-end: 24px; width: min(400px, calc(100vw - 32px));`.
* **Padding & Internal Gaps:** Stack `gap: 10px`. Card `padding: 14px 16px; gap: 12px;`.
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-subtle); border-inline-start: 3px solid var(--pg-status-<tone>-dot); border-radius: 12px; box-shadow: var(--pg-shadow-popover);`. Close button: **`border: 0; background: transparent; outline: none;`** (`:focus-visible` only!).
* **Typography & Numerals:** Title `13px / 700`. Message `13px / 400 / 1.45 / --pg-ink-secondary`.
* **Color & Surface Tokens (Light & Dark):** `--pg-bg-elevated` card surface with semantic icon + 3px accent bar + 2.5px bottom countdown bar.
* **RTL (Arabic) Visual Adaptation:** Positioned at `inset-inline-end: 24px` (bottom-right in EN, bottom-left in AR); progress bar shrinks toward inline-start.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Entering** | Slide-up + fade in | 3px semantic accent bar | Countdown timer running | 180ms cubic-bezier | 
| **Hover / Focusin** | Timer pauses (`pauseToast`) | Progress bar pauses smoothly | User can read without rush | Paused | 
| **Auto-Dismiss** | Fires at `4500ms` (`6500ms` danger/warning) | Removed from stack cleanly | Zero stuck toasts | 150ms fade-out | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `tone` | \`'success' | 'info' | 'warning' | 
| `message / title` | `string` | `required / ''` | Toast copy. | 
| `durationMs` | `number` | `4500 (6500 danger)` | Guaranteed auto-dismiss timeout; `0` disables auto-dismiss. | 
| `actionLabel / onAction` | `string / fn` | `undefined` | Optional inline action button (`Undo`, `View`). | 

* **Slots:** None (driven via `showToast()` store).
* **Emitted Events:** None.
* **Pointer & Click Behavior:**
  * Hover pauses timer; mouseleave resumes remaining milliseconds; clicking `×` dismisses immediately without leaving a black focus outline.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Close button focusable with `:focus-visible` ring only (never on mount!).
* **Mandatory Edge Cases & Defensive Guards:**
  * Firing 6 toasts rapidly caps stack at 4 visible cards (evicting oldest cleanly).

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgToast.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Calls `showToast({ tone: 'success', message: 'Saved', durationMs: 200 })`, verifies card renders, advances timer -> asserts toast auto-dismisses.
2. Triggers `mouseenter` -> advances timer -> asserts toast stays alive; triggers `mouseleave` -> asserts toast dismisses.
3. Asserts `.pg-toast__close` has `border: 0` and no focus outline on initial mount.

### 8.3 `PgStatusBadge (Canonical Semantic Status Pill)`

- **Source File:** `packages/ui/src/feedback/PgStatusBadge.tsx`
- **Canonical Exports:** `PgStatusBadge`, `StatusBadge`, `StatusChip`
- **Role & Design Intent:** Single canonical status indicator across all tables, detail headers, KYB workflows, and `ContextHelpDrawer` — enforcing WCAG AA `>= 4.5:1` contrast and consistent semantic tone mapping via `statusToTone()`.

#### Detected Gaps, Bugs & Audit Findings
1. **Missing CSS Class:** `.pg-badge__label` is referenced in `PgStatusBadge.tsx` with zero CSS definition in `components.css`.
2. **Live Bug Observed:** `CRITICAL` badge in `ContextHelpDrawer` renders white text on light gray background (unreadable); `statusToTone('CRITICAL')` MUST map strictly to `danger` (`--pg-status-danger-bg` + `--pg-status-danger-text`).

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)
- **Structural Anatomy:** Inline-flex pill (`height: 24px`, `padding: 0 9px`, `gap: 6px`, `border-radius: var(--pg-radius-pill)`, `border: 1px solid var(--pg-status-{tone}-border)`, `background: var(--pg-status-{tone}-bg)`) containing an optional `6px` circular dot (`--pg-status-{tone}-dot`) and `.pg-badge__label`.
- **Padding, Gaps & Rhythm:** `sm`: `height: 20px, padding: 0 7px, font-size: 11px`; `md` (default): `height: 24px, padding: 0 9px, font-size: 12px`.
- **Typography Scale & Numerals:** `12px`, `font-weight: 600`, `line-height: 1`, `white-space: nowrap`.
- **Light Mode Palette:** Exact `fintech-2026.css` tokens (`--pg-status-{success|warning|danger|info|neutral}-{bg|text|border|dot}`).
- **Dark Mode Palette:** Translucent dark tint + luminous ink (`#4ade80`, `#fbbf24`, `#f87171`, `#60a5fa`, `#d4d4d8`) guaranteeing `>= 4.5:1` contrast.
- **Interactive & Visual States:** 5 semantic tones (`success`, `warning`, `danger`, `info`, `neutral`) + `dot?: boolean` (default `true`).
- **LTR & RTL Directional Behavior:** Status dot sits at inline-start naturally.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)
- **Props & Parameters:** `status?: string`, `label?: string`, `tone?: BadgeTone` (auto-resolved from `status` when omitted), `size?: 'sm'|'md'`, `dot?: boolean` (default `true`).
- **Emitted Events:** None.
- **Slots:** `default`.
- **User Interactions & Click Behavior:** Non-interactive status readout.
- **Keyboard Navigation & Accessibility (ARIA):** Never relies on color alone — always renders clear human-readable text via `formatHumanStatus()`.
- **Edge Cases & Defensive Guards:** `CRITICAL`, `FAILED`, `SUSPENDED`, `BLOCKED`, `CHARGEBACK`, `REVOKED` ALWAYS map to `danger`.

#### Mandatory OpenCode Verification & Automated Tests
- [ ] Unit test: `PgStatusBadge status="CRITICAL"` resolves to `.pg-badge--danger` with WCAG AA contrast.
- [ ] CSS test: `.pg-badge__label` exists in `components.css`.

### 8.4 `PgMetaPill (`MetaPill` — Key-Value Metadata Chip)`

* **Source File:** `packages/ui/src/data/PgMetaPill.tsx`
* **Canonical Exports:** `PgMetaPill`, `MetaPill`
* **Role & Design Intent:** Compact inline metadata pill displaying environment (`SANDBOX`), rail (`SADAD`, `TADAWUL`, `MOAMALAT`), currency, or count next to page headers and table rows.

#### Detected Gaps, Bugs & Audit Findings

1. `.pg-meta-pill--*` tone modifier classes referenced in `PgMetaPill.tsx` are missing in `components.css`, causing all pills to render as plain uncolored text.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Inline-flex capsule (`height: 24px`, `padding: 0 9px`, `gap: 5px`, `border-radius: 6px`, `border: 1px solid`) with optional `13px` icon, muted key prefix (`Rail:`), and bold value.
* **Padding, Gaps & Rhythm:** Inline gap `5px`; horizontal padding `9px`.
* **Typography Scale & Numerals:** `12px`, `font-weight: 500`, `line-height: 1`, `white-space: nowrap`.
* **Light Mode Palette:** Neutral bg `#F8FAFC`, border `#E2E8F0`, ink `#334155`; Toned variants use `--pg-status-{tone}-bg/border/text`.
* **Dark Mode Palette:** Neutral bg `#1E293B`, border `#334155`, ink `#E2E8F0`; Toned variants use dark translucent tints.
* **Interactive & Visual States:** 6 semantic tones (`neutral`, `brand`, `info`, `success`, `warning`, `danger`) + optional clickable hover state.
* **LTR & RTL Directional Behavior:** Icon sits at inline-start.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `label?: string`, `value?: string | number`, `icon?: string`, `tone?: BadgeTone`, `mono?: boolean`
* **Emitted Events:**
  * `click` (optional).
* **Slots:**
  * `default`.
* **User Interactions & Click Behavior:**
  * Pure metadata indicator; when `mono=true`, applies tabular monospace font.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A (unless clickable).
* **Edge Cases & Defensive Guards:**
  * Never wraps onto two lines inside table headers or page header bars.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] CSS test: All `.pg-meta-pill--{tone}` classes exist in `components.css` with >= 4.5:1 text contrast.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 8.5 `PgEmptyState (`EmptyState` — Zero-Data & Zero-Filter-Match Surface)`

* **Source File:** `packages/ui/src/feedback/PgEmptyState.tsx`
* **Canonical Exports:** `PgEmptyState`, `EmptyState`
* **Role & Design Intent:** Warm, reassuring empty-state block rendered inside tables, cards, and full pages when a collection has no records yet or when active filters yield zero matches.

#### Detected Gaps, Bugs & Audit Findings

1. Empty tables sometimes render a cramped single line `'No data'` without distinguishing between 'no records exist yet' vs. 'filters hid all records (Reset Filters CTA)'.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Centered vertical stack (`padding: 48px 24px` default, `32px 16px` compact inside tables, `max-width: 420px`, `margin: 0 auto`, `text-align: center`): (1) `48px x 48px` rounded-xl tonal icon medallion (`--pg-bg-surface-subtle`, `1px solid var(--pg-border-subtle)`), (2) Title (`15px/600`, `margin-top: 14px`), (3) Description (`13.5px`, `--pg-ink-muted`, `margin-top: 6px`), (4) Action button row (`margin-top: 18px`, `gap: 10px`).
* **Padding, Gaps & Rhythm:** Generous breathing room (`48px` vertical padding) so empty tables look intentional and calm.
* **Typography Scale & Numerals:** Title `15px/600`, Description `13.5px/400` `line-height: 1.5`.
* **Light Mode Palette:** Medallion `#F1F5F9`, icon `#64748B`, title `#0F172A`, desc `#64748B`.
* **Dark Mode Palette:** Medallion `#1E293B`, icon `#94A3B8`, title `#F1F5F9`, desc `#94A3B8`.
* **Interactive & Visual States:** Empty Collection (primary `'Create ...'` CTA), Filtered Empty (`'Reset filters'` outlined CTA), Compact (inside cards/drawers).
* **LTR & RTL Directional Behavior:** Centered layout; action buttons follow RTL flex order.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `icon?: string` (default `'mdi-inbox-outline'`), `title: string`, `description?: string`, `actionLabel?: string`, `compact?: boolean`
* **Emitted Events:**
  * `action()`.
* **Slots:**
  * `icon`, `actions`, `default`.
* **User Interactions & Click Behavior:**
  * Clicking primary CTA emits `action` (e.g., resets table filters or opens Create Modal).
* **Keyboard Navigation & Accessibility (ARIA):**
  * CTA button is standard focusable `PgButton`.
* **Edge Cases & Defensive Guards:**
  * Works seamlessly inside `PgTable` `<tbody>` full-span row without breaking horizontal scroll.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: Renders icon medallion, title, description, and action button emitting `action` on click.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 8.6 `PgSkeleton (Shimmer Loading Placeholder)`

* **Source File:** `packages/ui/src/feedback/PgEmptyState.tsx`
* **Canonical Exports:** `PgSkeleton`
* **Role & Design Intent:** Layout-preserving shimmer placeholder for KPI tiles, table rows, charts, and detail forms during initial hydration so pages never jump or flash blank white boxes.

#### Detected Gaps, Bugs & Audit Findings

1. Skeleton pulse animation ignores `prefers-reduced-motion` and uses overly harsh contrast in Dark Mode.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Block element (`border-radius: 6px` text / `12px` card / `999px` circle) with subtle diagonal shimmer sweep (`1.6s ease-in-out infinite`).
* **Padding, Gaps & Rhythm:** Presets: `text` (`height: 14px`), `heading` (`height: 22px`), `metric` (`height: 84px`), `row` (`height: 44px`), `chart` (`height: 260px`), `avatar` (`36px x 36px circle`).
* **Typography Scale & Numerals:** N/A.
* **Light Mode Palette:** Base `#E2E8F0` -> Shimmer highlight `#F1F5F9`.
* **Dark Mode Palette:** Base `#1E293B` -> Shimmer highlight `#293548`.
* **Interactive & Visual States:** Animated shimmer (static soft tone when `prefers-reduced-motion: reduce`).
* **LTR & RTL Directional Behavior:** Shimmer sweeps right-to-left in RTL.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `variant?: 'text'|'heading'|'rect'|'circle'|'metric'|'row'|'chart'`, `width?: string`, `height?: string`, `count?: number` (renders N stacked rows with `10px` gap)
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * `aria-hidden='true'` on decorative skeleton bars; parent container sets `aria-busy='true'`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Non-focusable.
* **Edge Cases & Defensive Guards:**
  * When `count > 1` on `variant='text'`, last line auto-widths to `72%` for natural paragraph rhythm.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `count={4}` renders 4 skeleton bars with `aria-hidden='true'`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 8.7 `PgStateView & PgLoadingScreen (Unified Async View Orchestrator)`

* **Source File:** `packages/ui/src/feedback/PgStateView.tsx`
* **Canonical Exports:** `PgStateView`, `StateView`, `PgLoadingScreen`, `LoadingScreen`
* **Role & Design Intent:** Single declarative async state wrapper handling `loading`, `error` (with Retry button), `empty`, and `ready` states across detail pages and dashboards so no page ever gets stuck on a blank screen.

#### Detected Gaps, Bugs & Audit Findings

1. Error state renders an unstyled plain text string instead of a centered `PgAlert` / error card with an actionable `Retry` button.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgStateView`: switches cleanly via Vapor `createIf` between (1) `loading`: `PgSkeleton` or `PgLoadingScreen`, (2) `error`: centered `PgCard` with danger icon, human-readable error message, and `'Try Again'` `PgButton`, (3) `empty`: `PgEmptyState`, (4) `ready`: default slot. `PgLoadingScreen`: centered `PgSpinner size='lg'` + subtle localized `'Loading...'` caption (`min-height: 240px`).
* **Padding, Gaps & Rhythm:** Error card `max-width: 460px`, `padding: 28px`, centered with `32px` vertical margin.
* **Typography Scale & Numerals:** Error title `15px/600`, detail `13.5px --pg-ink-muted`.
* **Light Mode Palette:** Matches `PgCard` + `PgEmptyState`.
* **Dark Mode Palette:** Matches `PgCard` + `PgEmptyState`.
* **Interactive & Visual States:** Loading, Error, Empty, Ready.
* **LTR & RTL Directional Behavior:** Centered layout; Retry button icon flips cleanly.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgStateView`: `loading?: boolean`, `error?: unknown`, `empty?: boolean`, `emptyTitle?: string`, `emptyDescription?: string`, `retryLabel?: string`.
  * `PgLoadingScreen`: `label?: string`, `fullScreen?: boolean`.
* **Emitted Events:**
  * `retry()`.
* **Slots:**
  * `loading`, `error`, `empty`, `default`.
* **User Interactions & Click Behavior:**
  * Clicking `'Try Again'` emits `retry` to re-run the page query.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Retry button is immediately tabbable; error state sets `role='alert'`.
* **Edge Cases & Defensive Guards:**
  * Extracts `.message` or API `error.detail` safely from Axios/Fetch error objects; never prints `[object Object]`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] State machine test: Transitions `loading -> error -> (click retry) -> ready` cleanly using Vapor `createIf`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

## PART 9 — DATA DISPLAY, KPI STRIPS, TABLES, FILTERS, ROW ACTIONS, JSON & CHARTS BLUEPRINTS

### 9.1 `PgMetricStrip (Balanced KPI Bento Grid)`

* **Source File:** `packages/ui/src/data/PgMetricStrip.tsx`
* **Exported Symbols / Aliases:** `PgMetricStrip, MetricStrip, PgMiniStats, MiniStats, PageStats`
* **Category:** Data Display — Financial KPIs
* **Purpose & Role in Platform:** Top-of-page financial KPI strip rendering balanced, breathable metric cards with tabular numerals, trend/status badges, and clean sub-labels — zero orphan rows, zero broken borders, zero exposed gray dead cells.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Broken 4+1 & 4+2 Grid Wrapping:** On `/dashboard` (5 metrics), `/merchants` (6 metrics), and `/transactions` (5 metrics), row 2 had 1 or 2 lonely tiles with empty columns and incomplete borders!
* **Missing `.pg-metric-tile__head` & `.pg-metric-loading` CSS classes.**
* **Awkward Sublabel Wrapping (`Pending approvals · 739 121`):** Sub-label needs clean `line-height: 1.45` and `white-space: normal` with explicit `·` separator spacing.
* **Missing CSS Classes (Unstyled in DOM):** `pg-metric-loading, pg-metric-tile__head` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Dynamic balanced grid via `data-cols`: 1->1, 2->2, 3->3, 4->4, **5->5** (single clean row on `>=1280px`!), **6->3** (balanced 3×2 grid — zero orphan cells!). Tablet `<1200px` -> 2 cols; mobile `<640px` -> 1 col.
* **Padding & Internal Gaps:** Grid `gap: 12px`. Each tile `padding: 18px 20px; gap: 8px;`.
* **Borders, Radius & Elevation:** Each tile is an independent crisp card: `1px solid var(--pg-border-subtle); border-radius: 12px; box-shadow: var(--pg-shadow-xs);` (never exposes parent gray background!).
* **Typography & Numerals:** Label: `11px / 600 / uppercase / letter-spacing: 0.05em / --pg-ink-muted`. Value: `24px / 700 / tabular-nums / 1.2 / --pg-ink-primary`. SubLabel: `12px / 400 / 1.45 / --pg-ink-muted`.
* **Color & Surface Tokens (Light & Dark):** Tile surface `--pg-bg-surface`, hover `--pg-bg-surface-hover`.
* **RTL (Arabic) Visual Adaptation:** Label at start, badge at end; tabular numbers render cleanly.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface` | 1px `--pg-border-subtle` | `--pg-ink-primary` | 140ms ease | 
| **Loading** | `--pg-bg-surface` | 1px `--pg-border-subtle` | `PgSkeleton` shimmer bar (`28px` high) | 1.4s shimmer | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `items` | `PgMetricItem[]` | `[]` | Array of `{ key, label, value?, moneyAmount?, currency?, subLabel?, badge?, badgeTone?, icon? }`. | 
| `loading` | `boolean` | `false` | Displays skeleton placeholder bars without layout shift. | 

* **Slots:** None.
* **Emitted Events:** None.
* **Pointer & Click Behavior:**
  * Hover subtly elevates border to `--pg-border-default`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Semantic `<section aria-label='Key metrics' aria-busy={loading}>`.
* **Mandatory Edge Cases & Defensive Guards:**
  * 5 items on desktop (`1440px`): renders 5 equal columns in 1 row (`data-cols='5'`).
  * 6 items on desktop: renders 3×2 balanced grid (`data-cols='3'`).
  * Long currency values (e.g., `12,450,890.000 LYD`): scales cleanly without overflowing tile width.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgMetricStrip.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Passes 5 items -> asserts `data-cols='5'` and 5 `.pg-metric-tile` nodes.
2. Passes 6 items -> asserts `data-cols='3'` (balanced 3×2, zero orphan row).
3. Passes `loading={true}` -> asserts `aria-busy='true'` and skeleton rendered.

### 9.2 `PgSummaryExportCard`

* **Source File:** `packages/ui/src/data/PgSummaryExportCard.tsx`
* **Exported Symbols / Aliases:** `PgSummaryExportCard, SummaryExportCard`
* **Category:** Data Display — Governance Summary & Export
* **Purpose & Role in Platform:** Unified portfolio health card combining one header title, a non-clipping Export CTA button, optional 4-item Maker-Checker `PgFormChecklist`, and `PgMetricStrip`.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Duplicate Card Header (`Merchant portfolio health` & `Transaction health`):** Appeared twice due to pages wrapping `SummaryExportCard` inside a second titled card.
* **Clipped Export Button (`...mary`):** Header lacked `flex-wrap: wrap` and button lacked `flex-shrink: 0`.
* **Checklist State Desync:** Fixed by pure-Vapor `PgCheckbox` (Section 6.6) + `dc.ts` prop preservation (Section 3.2).

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Single `<PgCard>` with `header` slot (title + non-clipping export button) and `24px`-padded body.
* **Padding & Internal Gaps:** Header `18px 24px; gap: 12px; flex-wrap: wrap;`. Body vertical stack `gap: 18px`.
* **Borders, Radius & Elevation:** Inherits `PgCard` 1px hairline border.
* **Typography & Numerals:** Title `15px / 600` (rendered ONCE!).
* **Color & Surface Tokens (Light & Dark):** Inherits `PgCard` tokens.
* **RTL (Arabic) Visual Adaptation:** Title at start, Export button at end.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Checklist Incomplete** | Export button `disabled` | Amber/muted helper text below checklist | 0/4 checked | N/A | 
| **Checklist Complete** | Export button enabled | Helper text hidden | 4/4 checked | Instant enable | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `title` | `string` | `required` | Rendered ONCE in card header. | 
| `metrics` | `PgMetricItem[]` | `[]` | Passed to `PgMetricStrip`. | 
| `checks / checklist / showChecklists / checklistComplete` | `various` | `[] / {} / false / true` | Controls safeguard checklist before export. | 
| `onExport / exportDisabled / exportLoading / exportLabel` | `various` | `undefined` | Export button action and state. | 

* **Slots:** `default` (optional status pill strip below metrics).
* **Emitted Events:** `update:checklist`.
* **Pointer & Click Behavior:**
  * Checking all safeguard boxes enables Export; clicking Export shows spinner and invokes `onExport()`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Full keyboard support through `PgCheckbox` and `PgButton`.
* **Mandatory Edge Cases & Defensive Guards:**
  * Narrow viewports wrap Export button cleanly onto line 2 instead of clipping text.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgSummaryExportCard.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders title ONCE, verifies Export button is never clipped (`flex-shrink: 0`), verifies checking all 4 boxes enables Export.

### 9.3 `PgMonoRef (Click-to-Copy Financial Reference)`

* **Source File:** `packages/ui/src/data/PgMonoRef.tsx`
* **Exported Symbols / Aliases:** `PgMonoRef, MonoRef, PgMoneyText, MoneyText, MoneyDisplay`
* **Category:** Data Display — Financial Primitives
* **Purpose & Role in Platform:** 1-click copyable monospace reference chip (`PgMonoRef`) with animated green checkmark feedback, and strict 3-decimal Libyan Dinar (`125.000 LYD`) tabular currency formatter (`PgMoneyText`).

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Clicking ID Selects Text Instead of Copying + Green Checkmark:** `dc.ts` stripped `copyable: { default: true }`, causing `PgMonoRef.tsx` L17 to bail out immediately and hide the copy/check icon!
* **Missing `user-select: none` & Checkmark Pop Animation:** Needs crisp button hover, `user-select: none`, green copied state tint, and `pg-check-pop` animated checkmark fade.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** `PgMonoRef`: inline pill button (`padding: 3px 8px; gap: 6px; border-radius: 6px;`). `PgMoneyText`: inline-flex tabular numerals (`gap: 4px`).
* **Padding & Internal Gaps:** Ref text-to-icon `gap: 6px`.
* **Borders, Radius & Elevation:** Resting `1px solid var(--pg-border-subtle)`. Copied: `1px solid var(--pg-status-success-border)`.
* **Typography & Numerals:** `var(--pg-font-mono)` `12px / 500` (`PgMonoRef`); `tabular-nums` (`PgMoneyText`, currency code muted `0.85em`).
* **Color & Surface Tokens (Light & Dark):** Copied state transitions smoothly to `--pg-status-success-bg` + `--pg-status-success-text` + animated green check icon (`--pg-status-success-dot`) for `1600ms`, then fades cleanly back.
* **RTL (Arabic) Visual Adaptation:** Both `PgMonoRef` and `PgMoneyText` enforce `direction: ltr; unicode-bidi: isolate;` so IDs and `125.000 LYD` NEVER scramble in Arabic mode!

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface-subtle` | 1px `--pg-border-subtle` | `--pg-ink-primary` + muted copy icon | 140ms | 
| **Hover** | `--pg-bg-surface-hover` | 1px `--pg-border-strong` | `--pg-ink-primary` | 140ms | 
| **Copied (`1600ms`)** | `--pg-status-success-bg` | 1px `--pg-status-success-border` | Green animated checkmark (`pg-check-pop`) | 220ms pop + fade | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `value (PgMonoRef)` | `string` | `''` | Full ID/reference string copied on click. | 
| `truncate` | `number` | `0` | Max visible characters before `…` (full value always copied!). | 
| `copyable` | `boolean` | `true` | Defaults to `true` (`props.copyable !== false`). | 
| `amount / currency / size (PgMoneyText)` | \`string | number / string / 'sm' | 'md' | 

* **Slots:** None.
* **Emitted Events:** `copied` (`PgMonoRef`).
* **Pointer & Click Behavior:**
  * Single click copies full `value` to clipboard (`e.stopPropagation()` so parent row click does NOT trigger), shows animated green checkmark for `1.6s`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Focusable `<button type='button'>`; `Enter`/`Space` copies and announces `'Copied'` via `aria-live='polite'`.
* **Mandatory Edge Cases & Defensive Guards:**
  * Empty `value`: renders `—` disabled without copy icon.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgMonoRefAndMoney.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders `<PgMonoRef value='TXN-987654321' truncate={8} />` WITHOUT passing `copyable` -> clicks button -> asserts clipboard received full `'TXN-987654321'`, `.pg-mono-ref--copied` applied, and `mdi-check` rendered.
2. Advances timer `1600ms` -> asserts `.pg-mono-ref--copied` clears cleanly.
3. Renders `<PgMoneyText amount='125.5' currency='LYD' />` -> asserts `125.500 LYD` with `tabular-nums`.

### 9.4 `PgTable (Core Operational Data Table)`

* **Source File:** `packages/ui/src/data/table/Table.tsx`
* **Exported Symbols / Aliases:** `PgTable, Table, DataTable, PgApiTable, ApiTable`
* **Category:** Data Display — Enterprise Data Tables
* **Purpose & Role in Platform:** The spacious 2026 fintech data table: integrated `PgSearchInput` toolbar, sortable column headers, `48px` comfortable rows, opaque sticky `Actions` column with start shadow (never clipping adjacent columns!), pagination footer, and built-in empty/loading states.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Sticky `Actions` Column Clips `Rail` Column:** On `/transactions`, `Rail` cell text (`adfali`, `sadad`) clipped behind the sticky `Actions` column.
* **Missing `.pg-sr-only` class** and `.pg-unified-table :focus-visible` painting inner input outlines.
* **Toolbar Search Field:** Must strictly use `<PgSearchInput size='sm' clearable />` with neutral outer focus ring.
* **Missing CSS Classes (Unstyled in DOM):** `pg-border-subtle, pg-sr-only` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Full-width shell (`overflow: hidden; border-radius: 12px;`) wrapping `.table-wrapper` (`overflow-x: auto`).
* **Padding & Internal Gaps:** Toolbar: `padding: 14px 20px; gap: 12px;`. Header cells: `padding: 11px 16px; height: 42px;`. Body cells: `padding: 12px 16px; height: 48px;`. Footer: `padding: 12px 20px;`.
* **Borders, Radius & Elevation:** Outer shell `1px solid var(--pg-border-subtle)`. Row bottom hairline `1px solid var(--pg-border-subtle)` (none on last row). Sticky `Actions` cell has opaque `background: var(--pg-bg-surface)` + `box-shadow: -8px 0 12px -8px rgba(15,23,42,0.12)`.
* **Typography & Numerals:** Header: `11.5px / 600 / uppercase / letter-spacing: 0.04em / --pg-ink-muted`. Body: `13px / 400 / tabular-nums / --pg-ink-primary`.
* **Color & Surface Tokens (Light & Dark):** Header bg: `--pg-bg-surface-subtle`. Row hover: `--pg-bg-surface-hover` (sticky `Actions` cell inherits hover bg cleanly!).
* **RTL (Arabic) Visual Adaptation:** Sticky `Actions` pins to `inset-inline-end: 0` with flipped shadow in RTL.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Loading** | Skeleton rows or top linear bar | No jumpy collapse | `aria-busy='true'` | Smooth | 
| **Row Hover** | `--pg-bg-surface-hover` | Bottom hairline | Sticky `Actions` matches hover bg | 120ms | 
| **Empty** | Full-width `PgEmptyState` inside shell | Zero empty broken table body | Clear guidance + optional Reset Filters CTA | N/A | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `headers` | `TableHeader<T>[]` | `[]` | Column definitions (`key`, `label`, `Value`, `sortable`, `stickyEnd`, `minWidth`). | 
| `items / fetcher` | `T[] / ApiFetcher` | `[]` | Static rows or keyset/offset paginated API loader. | 
| `searchable / filters` | `boolean / TableFilter[]` | `true / []` | Renders `PgSearchInput` and collapsible `PgTableFilters`. | 

* **Slots:** `toolbar`, `empty`, `footer`.
* **Emitted Events:** `rowClick`, `sort`, `pageChange`.
* **Pointer & Click Behavior:**
  * Clicking sortable header cycles `asc -> desc -> none`; clicking row fires `rowClick` unless click originated inside an interactive control or `PgMonoRef`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Header sort buttons focusable; pagination buttons accessible.
* **Mandatory Edge Cases & Defensive Guards:**
  * Wide 14-column tables scroll horizontally smoothly with zero clipping of adjacent columns before the sticky `Actions` column.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgTable.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders table with 10 rows, verifies `48px` row padding class, sticky `Actions` opaque surface, sort click, and search input filtering.

### 9.5 `PgTableFilters`

* **Source File:** `packages/ui/src/data/table/TableFilters.tsx`
* **Exported Symbols / Aliases:** `PgTableFilters, TableFilters, createTableFilterSurface`
* **Category:** Data Display — Table Filter Bar
* **Purpose & Role in Platform:** Collapsible 2/3/4-column filter bar supporting text, `PgAutocomplete` (static & async), `PgDateRangeInput`, boolean, and number-range filters, plus active removable filter chips and `Clear all filters`.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Duplicate Labels on Date Filters:** Rendered `.pg-filter-label` AND passed `label` into `DateInput`.
* **Boxy Refresh Button Inside Every API Autocomplete Filter:** Cluttered `Gateway`, `Rail`, `Application`, `Merchant` inputs.
* **Clipped `Clear all filters` & Reversed `:Status` Chip:** Caused by RTL leak + missing `flex-wrap: wrap` on chip bar.
* **Missing Vapor `createIf` on collapsible filter grid.**
* **Missing CSS Classes (Unstyled in DOM):** `pg-table-filter-surface` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.
* **Vapor Reactivity Trap (Conditional Overlay Without `createIf`):** Renders conditional overlay via `{open.value && (...)}` instead of `createIf` from `@vue/runtime-vapor`, breaking mount/unmount toggling in Vapor.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Responsive grid (`1 / 2 / 3 / 4` columns); date-range and number-range span 2 columns cleanly with aligned label baselines.
* **Padding & Internal Gaps:** Panel `padding: 16px 20px;`. Grid `gap: 14px 16px;`. Active chip bar `padding: 10px 20px; gap: 8px; flex-wrap: wrap;`.
* **Borders, Radius & Elevation:** Separated from toolbar and table by `1px solid var(--pg-border-subtle)`.
* **Typography & Numerals:** Filter label: `11.5px / 600 / --pg-ink-muted` (rendered ONCE per filter!).
* **Color & Surface Tokens (Light & Dark):** Panel bg: `--pg-bg-surface-subtle` (subtle contrast from white table rows).
* **RTL (Arabic) Visual Adaptation:** Number range places `Min` at inline-start and `Max` at inline-end; chip format is `Status: ACTIVE` (colon after label).

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Collapsed (0 active)** | Hidden via Vapor `createIf` | Zero dead height | Filter badge hidden | N/A | 
| **Expanded** | Clean aligned grid | Every control height `36px` | Single label above every control | 140ms | 
| **Active Filters** | Removable pill chips + `Clear all filters` button | Never clips at edge (`flex-wrap: wrap`) | Filter button shows active count badge | Instant | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `filters` | `TableFilter[]` | `[]` | Declarative filter schema. | 
| `values` | `FilterValues` | `{}` | Active filter values map. | 

* **Slots:** None.
* **Emitted Events:** `change`, `clear`.
* **Pointer & Click Behavior:**
  * Clicking a chip `×` clears that single filter; clicking `Clear all filters` resets all values.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Every filter control is Tab-accessible with outer `.pg-control-box` focus ring.
* **Mandatory Edge Cases & Defensive Guards:**
  * All filter columns align on the exact same horizontal baseline (zero 1-label vs 2-label vertical misalignment!).

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgTableFilters.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Renders date filter + status multi-select + number range -> asserts each filter has EXACTLY ONE label node.
2. Selects 2 statuses -> verifies active chip shows `Status: ACTIVE, PENDING` and `Clear all filters` resets all.

### 9.6 `PgTableRowActions (Primary Action + Overflow `[...]` + Right-Click Context Menu)`

* **Source File:** `packages/ui/src/data/table/TableRowActions.tsx`
* **Exported Symbols / Aliases:** `PgTableRowActions, TableRowActions`
* **Category:** Data Display — Table Row Actions
* **Purpose & Role in Platform:** Unified table row action cell providing a clean outlined primary action (`Inspect`), a subtle ghost `[...]` overflow button, and an identical right-click / `Shift+F10` row context menu.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Completely Dead on `/merchants` & `/transactions`:** Uses VDOM `<Teleport>` from `'vue'` inside `createVaporApp` + `dc.ts` stripped `options.props` -> clicking `Inspect`, `[...]`, OR right-clicking a row did NOTHING!
* **CRITICAL — ZERO CSS Rules in `components.css`:** All 6 classes (`pg-row-actions`, `pg-row-actions__primary`, `pg-row-actions__more`, `pg-row-actions__panel`, `pg-menu-divider`, `pg-menu-item--danger`) were missing, causing `Inspect` text to overlap its icon and buttons to stick together with `0px` gap!
* **Wrong Button Weight:** Row actions must be subtle `outlined` / `ghost` controls, NEVER heavy filled blocks.
* **Missing CSS Classes (Unstyled in DOM):** `pg-menu-divider, pg-menu-item--danger, pg-row-actions, pg-row-actions__more, pg-row-actions__panel, pg-row-actions__primary` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.
* **Illegal VDOM `<Teleport>` in Pure Vapor App:** Imports `Teleport` from `'vue'` inside `createVaporApp`, causing teleported content to fail silently.
* **Vapor Reactivity Trap (Conditional Overlay Without `createIf`):** Renders conditional overlay via `{open.value && (...)}` instead of `createIf` from `@vue/runtime-vapor`, breaking mount/unmount toggling in Vapor.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Inline-flex row (`gap: 8px; align-items: center; justify-content: flex-end;`). Primary button: `height: 30px; padding: 0 10px;`. More `[...]`: `30×30px` square.
* **Padding & Internal Gaps:** Primary icon-to-label `gap: 6px`. Primary-to-more `gap: 8px`. Menu panel `padding: 6px; min-width: 210px;`. Menu item `padding: 8px 10px; gap: 10px;`.
* **Borders, Radius & Elevation:** Primary: `1px solid var(--pg-border-default); border-radius: 6px;`. More `[...]`: `1px solid var(--pg-border-subtle); border-radius: 6px;`. Panel: `1px solid var(--pg-border-subtle); border-radius: 12px; box-shadow: var(--pg-shadow-popover);`.
* **Typography & Numerals:** Primary: `12.5px / 600`. Menu item: `13px / 500`.
* **Color & Surface Tokens (Light & Dark):** Primary: `--pg-bg-surface` (outlined, NOT filled!). More `[...]`: transparent/surface ghost. Danger menu item: `--pg-status-danger-text` (hover `--pg-status-danger-bg`).
* **RTL (Arabic) Visual Adaptation:** Panel clamps safely inside `[8px, window.innerWidth - width - 8px]` in both LTR and RTL.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface` (outlined) + ghost `[...]` | 1px hairline | `--pg-ink-primary` | 120ms | 
| **Hover** | `--pg-bg-surface-hover` | 1px `--pg-border-strong` | `--pg-ink-primary` | 120ms | 
| **Menu Open** | Fixed viewport panel via Vapor `createIf` | `--pg-shadow-popover` | Only 1 row menu open globally at a time | 120ms fade | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `primaryAction` | \`RowPrimaryAction | null\` | `null` | 
| `items` | `RowActionItem[]` | `[]` | Overflow & right-click menu items (`key`, `label`, `icon`, `danger`, `disabled`, `hidden`, `dividerBefore`, `onClick`). | 
| `contextMenu` | `boolean` | `true` | Binds `contextmenu` (right-click) and `Shift+F10` on parent `<tr>`. | 

* **Slots:** None.
* **Emitted Events:** Invokes `primaryAction.onClick()` or `item.onClick()` directly.
* **Pointer & Click Behavior:**
  * Clicking `Inspect` calls `event.stopPropagation()` and executes `primaryAction.onClick()` immediately.
  * Clicking `[...]` calls `event.stopPropagation()` and toggles the `createIf`-mounted fixed menu panel positioned cleanly beneath/above the button.
  * Right-clicking anywhere on the table `<tr>` (outside inputs/links) opens the exact same menu at the mouse cursor `(clientX, clientY)`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * `Shift+F10` or `ContextMenu` key on row opens menu; `Escape` closes menu and returns focus to `[...]` button.
* **Mandatory Edge Cases & Defensive Guards:**
  * Opening row B's menu automatically closes row A's menu (`activeMenu` singleton).

#### D. Mandatory Automated Test Contract (`packages/ui/test/TableRowActions.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Clicks `Inspect` -> asserts `primaryAction.onClick` called once and click did not bubble to row.
2. Clicks `[...]` -> asserts `.pg-row-actions__panel` mounts via `createIf` (NO VDOM Teleport!) and clicking an item runs `item.onClick` and closes menu.
3. Dispatches `contextmenu` on parent `<tr>` -> asserts menu opens at cursor coordinates.

### 9.7 `JsonDiffViewer (Before/After Audit Diff Viewer)`

* **Source File:** `packages/ui/src/data/json/JsonDiffViewer.tsx`
* **Exported Symbols / Aliases:** `JsonDiffViewer, JsonValueCell, JsonValueList`
* **Category:** Data Display — Audit & Approval Diffs
* **Purpose & Role in Platform:** Side-by-side and inline human-readable JSON diff viewer for Four-Eyes Maker-Checker Approvals and Immutable Audit Logs.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Missing `.pg-json-diff` & `.pg-sr-only` CSS classes** in `components.css`.
* **Missing CSS Classes (Unstyled in DOM):** `pg-bg-surface-subtle, pg-border-subtle, pg-ink-muted, pg-ink-primary, pg-json-diff, pg-radius-md, pg-sr-only, pg-status-danger-bg, pg-status-success-bg` are referenced in JSX but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Full-width structured table/list with collapsible nested objects (`dir='ltr'` on raw keys/values).
* **Padding & Internal Gaps:** Row padding `8px 12px; gap: 10px;`.
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-subtle); border-radius: 10px;`.
* **Typography & Numerals:** `var(--pg-font-mono)` `12px / 1.5` for keys/values.
* **Color & Surface Tokens (Light & Dark):** Added lines: `--pg-status-success-bg` + `--pg-status-success-text`. Removed lines: `--pg-status-danger-bg` + `--pg-status-danger-text`. Modified lines: `--pg-status-warning-bg`.
* **RTL (Arabic) Visual Adaptation:** JSON keys/values stay LTR-isolated so nested paths (`fees.tiers[0].rate`) never scramble.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Added** | `--pg-status-success-bg` | 3px green bar | `+` prefix | N/A | 
| **Removed** | `--pg-status-danger-bg` | 3px red bar | `-` prefix | N/A | 
| **Unchanged** | Transparent | None | `--pg-ink-muted` (collapsible) | N/A | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `before / after` | `unknown` | `undefined` | Previous and proposed JSON payloads. | 
| `showUnchanged` | `boolean` | `false` | Toggle to hide/show unchanged fields. | 

* **Slots:** None.
* **Emitted Events:** None.
* **Pointer & Click Behavior:**
  * Clicking copy on any field copies formatted JSON value.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Toggle unchanged button keyboard-accessible.
* **Mandatory Edge Cases & Defensive Guards:**
  * Handles `null`, `BigInt`, nested arrays, and masked secrets cleanly.

#### D. Mandatory Automated Test Contract (`packages/ui/test/JsonDiffViewer.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Diffs `{ status: 'PENDING', fee: 10 }` vs `{ status: 'ACTIVE', fee: 10 }` and asserts only `status` renders as modified when `showUnchanged=false`.

### 9.8 `PgChart (Abstracted ECharts Core in @pg/ui)`

* **Source File:** `packages/ui/src/charts/PgChart.tsx`
* **Exported Symbols / Aliases:** `PgChart, EChart, PgStatChartCard, StatsChartCard, PgStatBarChartCard, StatsBarChartCard`
* **Category:** Data Visualization — Shared Charts Package
* **Purpose & Role in Platform:** Single shared ECharts Vapor wrapper & stat-chart card suite inside `@pg/ui` (replacing the 3 duplicated `src/charts/` folders in `admin-front`, `merchant-front`, and `checkout-front`) that guarantees non-zero canvas height, automatic theme switching, and responsive resize.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **CRITICAL — Dashboard Charts Invisible (`0px` Height Bug):** `admin-front/src/charts/EChart/index.tsx` ignored `height='260px'` passed by `dashboard/index.tsx` L515 & L524 and set `height: '100%'` inside `height: auto`, collapsing the chart to `0px` tall!
* **Duplicated Outside `@pg/ui`:** Still copy-pasted in `admin-front/src/charts`, `merchant-front/src/charts`, and `checkout-front/src/charts`.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Explicit `height` (`default: '260px'`) and `minHeight` applied directly on the chart container `<div>` so ECharts ALWAYS initializes with real pixel dimensions!
* **Padding & Internal Gaps:** Inside `PgStatChartCard`: card header `18px 24px`, chart body `padding: 16px 24px 20px;`.
* **Borders, Radius & Elevation:** Card inherits `PgCard` 1px hairline border.
* **Typography & Numerals:** Axis labels & tooltips use `Plus Jakarta Sans` / `Cairo` + `tabular-nums`.
* **Color & Surface Tokens (Light & Dark):** Automatically disposes & re-initializes with transparent background and dark/light ink palette whenever `resolvedTheme` changes.
* **RTL (Arabic) Visual Adaptation:** Tooltip formatting and legend alignment follow document direction.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Loading** | `PgSkeleton` chart shimmer (`height: props.height`) | Zero layout jump | Smooth | 1.4s | 
| **Rendered (90-day data)** | Crisp SVG ECharts renderer | Responsive `ResizeObserver` | Interactive hover tooltip | 250ms animate | 
| **Empty Series** | `PgEmptyState` inside chart height | Never renders blank axes | Clear message | N/A | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `option` | `echarts.EChartsOption` | `required` | Reactive ECharts configuration; updates via `chart.setOption(opt, true)`. | 
| `height` | \`string | number\` | `'260px'` | 
| `width` | \`string | number\` | `'100%'` | 
| `autoresize` | `boolean` | `true` | Attaches `ResizeObserver` to call `chart.resize()`. | 

* **Slots:** `headerActions` (`PgStatChartCard`).
* **Emitted Events:** `chartClick` (ECharts click params).
* **Pointer & Click Behavior:**
  * Interactive tooltips on hover; clicking a bar/slice emits `chartClick`.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Container sets `role='img'` and descriptive `aria-label`.
* **Mandatory Edge Cases & Defensive Guards:**
  * Mounted inside a tab or collapsible card that starts hidden (`width=0`): `ResizeObserver` triggers `chart.resize()` the moment the tab becomes visible.
  * Switching Dashboard period `24h -> 90d` updates `option` reactively and repaints immediately.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgChart.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Mounts `<PgChart option={...} height='260px' />` -> asserts container `style.height === '260px'` and `style.minHeight === '260px'`.
2. Switches `resolvedTheme` from `'light'` to `'dark'` -> asserts chart re-initializes cleanly.
3. Asserts `admin-front/src/charts`, `merchant-front/src/charts`, and `checkout-front/src/charts` directories are deleted.

### 9.9 `PgDescriptionList (Compact Key-Value Pair List)`

* **Source File:** `packages/ui/src/data/PgDescriptionList.tsx`
* **Exported Symbols / Aliases:** `PgDescriptionList, DescriptionList`
* **Category:** Data Display
* **Purpose & Role in Platform:** Clean horizontal/stacked `<dl><dt><dd>` description list for drawers and summary cards with tabular values and hairline dividers.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Prop-Default & Token Audit Required:** Affected by `dc.ts` stripping `options.props`; verify every default prop, RTL logical spacing property, and dark-mode contrast token.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Follows `@pg/ui` 4px/8px spatial grid and responsive breakpoints (`sm < 640`, `md < 960`, `lg < 1280`, `xl >= 1280`).
* **Padding & Internal Gaps:** Uses `--pg-space-*` logical tokens exclusively (zero hardcoded pixels in callers).
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-subtle)` hairlines; `--pg-radius-sm` (8px) for controls, `--pg-radius-md` (12px) for surfaces.
* **Typography & Numerals:** `Plus Jakarta Sans` (LTR) / `Cairo` (RTL) / `JetBrains Mono` (code/IDs/money) with `tabular-nums`.
* **Color & Surface Tokens (Light & Dark):** 100% CSS custom properties (`--pg-*`) verified for WCAG AA >= 4.5:1 contrast in Light and Dark mode.
* **RTL (Arabic) Visual Adaptation:** 100% logical properties (`inline-start`/`inline-end`); numeric/code values isolated LTR.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface` | 1px `--pg-border-subtle` | `--pg-ink-primary` | 140ms ease | 
| **Hover / Active** | `--pg-bg-surface-hover` | 1px `--pg-border-strong` | `--pg-ink-primary` | 120ms ease | 
| **Focus-Visible** | Same | `var(--pg-focus-ring)` (neutral) | Same | 120ms ease | 
| **Disabled** | Opacity `0.45` | Same | `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `All declared props` | `Strictly typed` | `Explicit defaults` | Preserved intact by `dc.ts` and validated with unit tests. | 

* **Slots:** Documented named slots with Vapor `createSlot` / `slots.*?.()`.
* **Emitted Events:** Typed Vue emits; zero silent swallows.
* **Pointer & Click Behavior:**
  * Full hit-target area (`>= 32px`), `e.stopPropagation()` where nested inside clickable rows.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Full `Tab`, `Enter`, `Space`, and `Escape` WAI-ARIA 1.2 compliance.
* **Mandatory Edge Cases & Defensive Guards:**
  * Safe in SSR/jsdom tests without `window`; handles `null`/`undefined`/empty arrays gracefully.

#### D. Mandatory Automated Test Contract (`packages/ui/test/PgDescriptionList.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Verifies all exported symbols (`PgDescriptionList, DescriptionList`) render cleanly in Light/Dark & LTR/RTL with zero console warnings.
2. Verifies every prop default, user interaction, and keyboard shortcut behaves exactly per blueprint.

### 9.10 `governanceAudit.ts (Automated CI Governance Gate)`

* **Source File:** `packages/ui/src/testing/governanceAudit.ts`
* **Exported Symbols / Aliases:** `runGovernanceAudit`
* **Category:** Governance & CI
* **Purpose & Role in Platform:** Static scanner enforcing zero raw `<select>`/`<input>`, zero `VuetifyShim`, zero stray `<PageHeader>(` parentheses, zero duplicated `src/charts/` or component folders, and zero missing `.pg-*` CSS classes.

#### A. Forensic Audit — Detected Bugs & Gaps to Fix

* **Prop-Default & Token Audit Required:** Affected by `dc.ts` stripping `options.props`; verify every default prop, RTL logical spacing property, and dark-mode contrast token.

#### B. Visual Design Blueprint (2026 Fintech Craft — Light, Dark, LTR & RTL)

* **Geometry & Sizing:** Follows `@pg/ui` 4px/8px spatial grid and responsive breakpoints (`sm < 640`, `md < 960`, `lg < 1280`, `xl >= 1280`).
* **Padding & Internal Gaps:** Uses `--pg-space-*` logical tokens exclusively (zero hardcoded pixels in callers).
* **Borders, Radius & Elevation:** `1px solid var(--pg-border-subtle)` hairlines; `--pg-radius-sm` (8px) for controls, `--pg-radius-md` (12px) for surfaces.
* **Typography & Numerals:** `Plus Jakarta Sans` (LTR) / `Cairo` (RTL) / `JetBrains Mono` (code/IDs/money) with `tabular-nums`.
* **Color & Surface Tokens (Light & Dark):** 100% CSS custom properties (`--pg-*`) verified for WCAG AA >= 4.5:1 contrast in Light and Dark mode.
* **RTL (Arabic) Visual Adaptation:** 100% logical properties (`inline-start`/`inline-end`); numeric/code values isolated LTR.

| Visual State | Surface / Background | Border & Focus Ring | Ink / Icon Color | Motion / Transition | 
| ----- | ----- | ----- | ----- | ----- | 
| **Default** | `--pg-bg-surface` | 1px `--pg-border-subtle` | `--pg-ink-primary` | 140ms ease | 
| **Hover / Active** | `--pg-bg-surface-hover` | 1px `--pg-border-strong` | `--pg-ink-primary` | 120ms ease | 
| **Focus-Visible** | Same | `var(--pg-focus-ring)` (neutral) | Same | 120ms ease | 
| **Disabled** | Opacity `0.45` | Same | `cursor: not-allowed` | None | 

#### C. Complete Functional & Interaction Specification

| Prop / Parameter | Type | Default | Exact Behavior & Validation Contract | 
| ----- | ----- | ----- | ----- | 
| `All declared props` | `Strictly typed` | `Explicit defaults` | Preserved intact by `dc.ts` and validated with unit tests. | 

* **Slots:** Documented named slots with Vapor `createSlot` / `slots.*?.()`.
* **Emitted Events:** Typed Vue emits; zero silent swallows.
* **Pointer & Click Behavior:**
  * Full hit-target area (`>= 32px`), `e.stopPropagation()` where nested inside clickable rows.
* **Keyboard & Accessibility (WAI-ARIA 1.2) Behavior:**
  * Full `Tab`, `Enter`, `Space`, and `Escape` WAI-ARIA 1.2 compliance.
* **Mandatory Edge Cases & Defensive Guards:**
  * Safe in SSR/jsdom tests without `window`; handles `null`/`undefined`/empty arrays gracefully.

#### D. Mandatory Automated Test Contract (`packages/ui/test/governanceAuditts.test.ts`)

OpenCode MUST write and pass every assertion below before marking this component satisfied:

1. Verifies all exported symbols (`runGovernanceAudit`) render cleanly in Light/Dark & LTR/RTL with zero console warnings.
2. Verifies every prop default, user interaction, and keyboard shortcut behaves exactly per blueprint.

### 9.11 `PgMiniStats (Compact Inline KPI Summary Bar)`

* **Source File:** `packages/ui/src/data/PgMetricStrip.tsx`
* **Canonical Exports:** `PgMiniStats`, `MiniStats`
* **Role & Design Intent:** Lightweight horizontal inline stat strip used inside detail drawers, modal headers, and card sub-headers where a full `PgMetricStrip` bento grid would be too heavy.

#### Detected Gaps, Bugs & Audit Findings

1. Stats wrap unevenly without hairline separators or tabular numeral alignment.
2. **Forensic Audit — Missing CSS Classes:** `pg-metric-loading, pg-metric-tile__head` are referenced in `packages/ui/src/data/PgMetricStrip.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Horizontal flex row (`display: flex; flex-wrap: wrap; align-items: center; gap: 0; border: 1px solid var(--pg-border-subtle); border-radius: 10px; background: var(--pg-bg-surface-subtle)`) where each stat cell (`padding: 10px 16px`, `flex: 1 1 120px`) is separated by a `1px` vertical hairline divider (`--pg-border-subtle`).
* **Padding, Gaps & Rhythm:** Cell padding `10px 16px`, label-to-value gap `2px`.
* **Typography Scale & Numerals:** Label `11.5px/500 --pg-ink-muted`; Value `15px/600 tabular-nums`.
* **Light Mode Palette:** Surface `#F8FAFC`, border `#E2E8F0`, value `#0F172A`.
* **Dark Mode Palette:** Surface `#0F172A`, border `#1E293B`, value `#F8FAFC`.
* **Interactive & Visual States:** Resting, Loading (compact skeleton bars), Toned value (`success/warning/danger`).
* **LTR & RTL Directional Behavior:** Dividers use `border-inline-start` so RTL borders never double up.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `items: PgMetricItem[]`, `loading?: boolean`
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Pure compact KPI readout.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Semantic `<dl>` with `<dt>`/`<dd>` pairs.
* **Edge Cases & Defensive Guards:**
  * Zero gaps between boxes; collapses cleanly to 2-column grid on narrow drawers.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: Renders seamless hairline-divided stat cells with `tabular-nums`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.12 `PgFormChecklist (`FormChecklist` — Interactive Verification & Export Checklist)`

* **Source File:** `packages/ui/src/data/PgFormChecklist.tsx`
* **Canonical Exports:** `PgFormChecklist`, `FormChecklist`, `PgChecklistItem`
* **Role & Design Intent:** Structured checklist of selectable or status-tracked items used in `PgSummaryExportCard`, KYB document readiness checklists, and pre-settlement verification drawers.

#### Detected Gaps, Bugs & Audit Findings

1. **Live Bug Observed on `/merchants` & `/transactions`:** Checkboxes inside `PgFormChecklist` render pre-checked YET grayed-out/disabled (`opacity: 0.5`) because it wraps the broken `vael-ui` Checkbox and confuses read-only status checklists with interactive export-section checklists.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Bordered vertical list (`border: 1px solid var(--pg-border-subtle); border-radius: 10px; overflow: hidden`) with hairline-separated rows (`padding: 10px 14px`, `gap: 10px`, `align-items: center`). Interactive mode uses the new 2026 squircle `PgCheckbox`; Read-only status mode uses crisp `16px` semantic check/circle icons (NEVER disabled checkboxes!).
* **Padding, Gaps & Rhythm:** Row min-height `42px`, horizontal padding `14px`, gap `10px`.
* **Typography Scale & Numerals:** Item label `13.5px/500`; secondary hint `12px --pg-ink-muted`.
* **Light Mode Palette:** Row `#FFFFFF`, hover (interactive) `#F8FAFC`, divider `#E2E8F0`.
* **Dark Mode Palette:** Row `#111827`, hover (interactive) `#162032`, divider `#1E293B`.
* **Interactive & Visual States:** Interactive Checked/Unchecked, Read-Only Complete (emerald check icon) / Pending (muted outline circle) / Blocked (crimson alert icon).
* **LTR & RTL Directional Behavior:** Checkbox/status icon at inline-start, optional badge at inline-end.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `items: PgChecklistItem[]` (`{ id, label, hint?, checked?, status?: 'done'|'pending'|'error', disabled? }`)
  * `interactive?: boolean` (default `true`)
  * `modelValue?: string[]` (selected IDs when `interactive=true`)
* **Emitted Events:**
  * `update:modelValue(ids: string[])`
  * `toggle(id: string, checked: boolean)`
* **Slots:**
  * `item`.
* **User Interactions & Click Behavior:**
  * In `interactive=true` mode, clicking anywhere on the row toggles the checkbox cleanly (never disabled unless explicitly `item.disabled=true`).
  * In `interactive=false` (read-only status) mode, renders clean status icons instead of disabled checkboxes.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Standard checkbox keyboard focus and `Space` toggle.
* **Edge Cases & Defensive Guards:**
  * Supports optional `'Select all'` header toggle when `items.length >= 4`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Interactive test: Clicking row in `PgFormChecklist` toggles checked state and is NOT disabled.
- [ ] Read-only test: `interactive=false` renders status icons, zero disabled `<input type='checkbox'>`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.13 `PgField & PgFieldsSection (Seamless Hairline Detail Grid — Zero Gaps Between Boxes)`

* **Source File:** `packages/ui/src/data/PgField.tsx`
* **Canonical Exports:** `PgField`, `Field`, `PgFieldsSection`, `PgSectionFields`, `FieldsSections`, `SectionFields`
* **Role & Design Intent:** Structured read-only inspector grid displaying entity attributes (Merchant Legal Name, Commercial Registry, Settlement IBAN, Fee Tier, Created At, MonoRef IDs) in a **seamless hairline-divided bento box with ZERO gaps between tiles**.

#### Detected Gaps, Bugs & Audit Findings

1. **Live Bug Explicitly Called Out by User:** The gray-background square field boxes have broken gaps between them, uneven heights, and missing CSS classes (`.pg-field-item--interactive`, `.pg-section-fields--split`). User explicitly stated: *'there should be no gaps between the boxes'*!
2. **Forensic Audit — Missing CSS Classes:** `pg-field-item--interactive` are referenced in `packages/ui/src/data/PgField.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgFieldsSection` renders a clean bordered outer frame (`border: 1px solid var(--pg-border-subtle); border-radius: 12px; overflow: hidden; background: var(--pg-border-subtle)` — using the **1px CSS Grid Hairline Technique**: `display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1px` where EVERY `PgField` tile has `background: var(--pg-bg-surface)` so the 1px grid gap becomes a razor-sharp seamless hairline border with ZERO floating gaps between boxes!).
* **Padding, Gaps & Rhythm:** Zero outer gaps between tiles (`gap: 1px` hairline border ONLY!). Inside each `PgField` tile: `padding: 14px 16px`, vertical stack `gap: 4px`. Optional section header bar sits cleanly above the grid (`padding: 12px 16px`, `background: var(--pg-bg-surface-subtle)`, `border-bottom: 1px solid var(--pg-border-subtle)`).
* **Typography Scale & Numerals:** Field label: `11.5px`, `font-weight: 500`, `--pg-ink-muted`, uppercase/sentence clean tracking. Field value: `14px`, `font-weight: 500`, `--pg-ink-primary`, `word-break: break-word`.
* **Light Mode Palette:** Outer border & 1px hairline `#E2E8F0`; Tile surface `#FFFFFF` (NOT ugly muddy gray!); Interactive tile hover `#F8FAFC`.
* **Dark Mode Palette:** Outer border & 1px hairline `#1E293B`; Tile surface `#111827`; Interactive tile hover `#162032`.
* **Interactive & Visual States:** Standard text, `copyable` (renders `PgMonoRef` with click-to-copy + green checkmark fade), `money` (renders `PgMoneyText`), `status` (renders `PgStatusBadge`), `interactive` (`.pg-field-item--interactive` with chevron + hover tint), `span='full'` (spans full row width for long addresses/notes).
* **LTR & RTL Directional Behavior:** CSS Grid flows right-to-left seamlessly; hairline dividers stay exact 1px everywhere.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgFieldsSection`: `title?: string`, `subtitle?: string`, `columns?: 2 | 3 | 4` (default `3`, collapses to `2` on tablet, `1` on mobile), `fields?: PgFieldItem[]`, `split?: boolean`.
  * `PgField`: `label: string`, `value?: unknown`, `type?: 'text'|'mono'|'money'|'date'|'status'|'boolean'`, `copyable?: boolean`, `span?: 1 | 2 | 'full'`, `interactive?: boolean`
* **Emitted Events:**
  * `PgField`: `click` when `interactive=true`.
* **Slots:**
  * `PgFieldsSection`: `actions`, `default`. `PgField`: `default`, `value`.
* **User Interactions & Click Behavior:**
  * Clicking a `copyable` or `type='mono'` field copies value and animates the emerald checkmark.
  * Trailing empty cells in an uneven last row (e.g., 5 fields in a 3-column grid) are filled seamlessly with a clean surface filler (`background: var(--pg-bg-surface)`) so no exposed border-color dead block ever appears!
* **Keyboard Navigation & Accessibility (ARIA):**
  * Interactive fields are keyboard focusable buttons.
* **Edge Cases & Defensive Guards:**
  * `null` / `undefined` / `''` values render a calm muted `'—'` rather than collapsing tile height.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Layout test: `PgFieldsSection` uses `gap: 1px` hairline grid with `#FFFFFF` / `#111827` tiles — ZERO floating gaps between boxes.
- [ ] CSS test: `.pg-field-item--interactive` and `.pg-section-fields--split` exist in `components.css`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.14 `PgMoneyText (`MoneyDisplay` — Tabular Financial Amount Primitive)`

* **Source File:** `packages/ui/src/data/PgMoneyText.tsx`
* **Canonical Exports:** `PgMoneyText`, `MoneyDisplay`, `MoneyText`
* **Role & Design Intent:** Consistent, decimal-aligned financial figure display for transaction amounts, net settlements, fees, reserves, and balances.

#### Detected Gaps, Bugs & Audit Findings

1. Missing `.pg-status-success-text` / `.pg-status-danger-text` utility classes referenced in `PgMoneyText.tsx`, causing signed credits/debits to lose semantic color.
2. Missing `dir='ltr'` isolate causes negative amounts in Arabic RTL tables to misplace the minus sign.
3. **Forensic Audit — Missing CSS Classes:** `pg-ink-primary, pg-status-danger-text, pg-status-success-text` are referenced in `packages/ui/src/data/PgMoneyText.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Inline `<span class='pg-money' dir='ltr'>` displaying `[sign][integer].[fraction] [CURRENCY]` with subtle smaller/muted currency code (`0.82em`, `font-weight: 500`, `margin-inline-start: 4px`) and optional muted decimal tail.
* **Padding, Gaps & Rhythm:** Zero wrapping (`white-space: nowrap`).
* **Typography Scale & Numerals:** `font-variant-numeric: tabular-nums`, `font-feature-settings: 'tnum' 1`. Sizes: `sm` (`13px`), `md` (`14px`), `lg` (`18px/600`), `xl` (`24px/700`).
* **Light Mode Palette:** Neutral `#0F172A`, Credit/Positive `#047857`, Debit/Negative `#B91C1C`, Zero `#64748B`.
* **Dark Mode Palette:** Neutral `#F8FAFC`, Credit/Positive `#34D399`, Debit/Negative `#F87171`, Zero `#94A3B8`.
* **Interactive & Visual States:** Neutral, Signed (`signed=true` colors positive emerald and negative crimson), Zero (muted), Null (`—`).
* **LTR & RTL Directional Behavior:** Always `dir='ltr'` with `unicode-bidi: isolate` so `-1,250.500 LYD` stays structurally intact inside Arabic sentences and RTL table cells.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `amount: MoneyInput`, `currency?: string` (default `'LYD'`), `signed?: boolean`, `showCurrency?: boolean` (default `true`), `size?: 'sm'|'md'|'lg'|'xl'`, `mutedDecimals?: boolean`
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Delegates all formatting strictly to `lib/money.ts` `formatMoney()`.
* **Keyboard Navigation & Accessibility (ARIA):**
  * N/A.
* **Edge Cases & Defensive Guards:**
  * `amount=0` with `signed=true` renders neutral muted `0.000 LYD` (no `+` or `-`).

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `PgMoneyText amount='-250.5' currency='LYD' signed` renders `-250.500 LYD` with `dir='ltr'`, `tabular-nums`, and danger ink.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.15 `PgApiTable (`ApiTable` — Server-Paginated, Filter-Synced Operational Table)`

* **Source File:** `packages/ui/src/data/table/PgApiTable.tsx`
* **Canonical Exports:** `PgApiTable`
* **Role & Design Intent:** Zero-boilerplate server-backed data table wrapping `PgTable`, `PgTableHeader`, `PgTableFilters`, and `PgTableFooter` with automatic URL query sync, debounced search, server sorting, `AbortController` race protection, and XLSX export.

#### Detected Gaps, Bugs & Audit Findings

1. Changing filters rapidly fires parallel requests without aborting stale calls, causing older responses to flash over newer filtered results.
2. Switching page size from `25` to `50` while on page 4 requests invalid page 4 instead of resetting to page 1.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** Unified `PgCard padding='none'` housing: `PgTableHeader` (top toolbar) -> collapsible `PgTableFilters` bar -> `PgTable` (with thin `3px` top `PgProgressBar indeterminate` during background refetch so existing rows don't flash away!) -> `PgTableFooter` (pagination).
* **Padding, Gaps & Rhythm:** Zero vertical gaps between header, filter bar, table, and footer — separated strictly by `1px solid var(--pg-border-subtle)`.
* **Typography Scale & Numerals:** Inherited from `PgTable`.
* **Light Mode Palette:** Surface `#FFFFFF`, hairline `#E2E8F0`.
* **Dark Mode Palette:** Surface `#111827`, hairline `#1E293B`.
* **Interactive & Visual States:** Initial Loading (skeleton rows), Background Refetch (top `3px` progress bar + `opacity: 0.7` subtle dim), Loaded, Filtered Empty (shows `'Reset all filters'` CTA), Network Error (shows `PgStateView` error with Retry).
* **LTR & RTL Directional Behavior:** Mirrors cleanly with `PgTable`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `endpoint: string` (or `fetcher`), `headers: TableHeader[]`, `filters?: FilterDef[]`, `syncUrl?: boolean` (default `true`), `defaultSort?: { key: string; order: 'asc'|'desc' }`, `defaultPageSize?: number` (default `25`), `exportFilename?: string`
* **Emitted Events:**
  * `loaded(payload)`
  * `error(err)`
  * `rowClick(row)`
  * `selectionChange(rows)`
* **Slots:**
  * `toolbar`, `actions`, `cell-*`, `expanded`, `empty`.
* **User Interactions & Click Behavior:**
  * Exposes `refresh()` and `resetFilters()` via `defineExpose`.
  * Any filter or search change automatically resets `page = 1` and cancels previous in-flight request via `AbortController`.
  * Handles both `{ items, total }` and `{ data, meta: { total } }` backend response envelopes cleanly.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Inherited from `PgTable` and `PgTableFooter`.
* **Edge Cases & Defensive Guards:**
  * Manual `Refresh` button spins while fetching and triggers toast only on unexpected error.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Race test: Rapid filter change aborts first request and renders only latest response.
- [ ] Pagination test: Changing page size resets `page` to `1`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.16 `PgTableHeader & PgTableFooter (`useTableXlsx` — Table Toolbar & Pagination)`

* **Source File:** `packages/ui/src/data/table/HeaderFooter.tsx`
* **Canonical Exports:** `PgTableHeader`, `PgTableFooter`, `useTableXlsx`
* **Role & Design Intent:** Top operational toolbar (search input, active filter count badge + toggle, column visibility picker, refresh button, XLSX export, custom actions) and bottom pagination bar (`Showing 1–25 of 1,420`, rows-per-page selector, Previous/Page Numbers/Next).

#### Detected Gaps, Bugs & Audit Findings

1. Search input inside `PgTableHeader` looks like an ugly unstyled raw HTML input with blue glow instead of using `PgSearchInput`.
2. Pagination buttons lack consistent `32px x 32px` hit targets, clear active page highlight, and RTL-flipped prev/next chevrons.
3. **Forensic Audit — Missing CSS Classes:** `pg-accent-brand, pg-ink-muted, pg-sr-only` are referenced in `packages/ui/src/data/table/HeaderFooter.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgTableHeader`: flex bar (`min-height: 56px`, `padding: 12px 16px`, `gap: 10px`, `flex-wrap: wrap`, `border-bottom: 1px solid var(--pg-border-subtle)`): Start hosts `PgSearchInput` (`width: 280px`, `max-width: 100%`) + `Filters` toggle button (with indigo count badge when active); End hosts Refresh, Column Picker (`PgMenu`), Export XLSX, and primary toolbar CTA. `PgTableFooter`: flex bar (`min-height: 52px`, `padding: 10px 16px`, `border-top: 1px solid var(--pg-border-subtle)`, `justify-content: space-between`, `gap: 12px`).
* **Padding, Gaps & Rhythm:** Toolbar button gap `8px`; Pagination button size `32px x 32px`, `border-radius: 7px`, `gap: 4px`.
* **Typography Scale & Numerals:** Range summary: `13px`, `--pg-ink-muted`, `tabular-nums`. Page buttons: `13px/500 tabular-nums`.
* **Light Mode Palette:** Bar bg `#FFFFFF`; Active page button `#4F46E5` with `#FFFFFF` text; Inactive hover `#F1F5F9`.
* **Dark Mode Palette:** Bar bg `#111827`; Active page button `#6366F1` with `#FFFFFF` text; Inactive hover `#1E293B`.
* **Interactive & Visual States:** First page (Prev disabled), Last page (Next disabled), Exporting XLSX (button shows spinner), Active Filters (`Filters (3)` tonal brand pill).
* **LTR & RTL Directional Behavior:** Prev/Next chevrons flip direction cleanly in RTL; range summary formats naturally.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `PgTableHeader`: `search?: string`, `showSearch?: boolean`, `activeFilters?: number`, `exportable?: boolean`, `loading?: boolean`.
  * `PgTableFooter`: `page: number`, `pageSize: number`, `total: number`, `pageSizeOptions?: number[]` (default `[10, 25, 50, 100]`).
* **Emitted Events:**
  * `update:search`, `toggleFilters`, `refresh`, `export`, `update:page`, `update:pageSize`.
* **Slots:**
  * `prepend`, `actions`.
* **User Interactions & Click Behavior:**
  * Search input debounces `250ms` and shows clear `×` button when non-empty.
  * `useTableXlsx` exports visible columns with formatted money/date strings (never raw `[object Object]`) and shows a success toast.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Every pagination button has descriptive `aria-label` (`'Previous page'`, `'Page 2'`, `'Next page'`).
* **Edge Cases & Defensive Guards:**
  * When `total === 0`, footer displays `'0 results'` cleanly instead of `'Showing 1–0 of 0'`.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Render test: `PgTableHeader` uses `PgSearchInput` (never raw unstyled `<input>`).
- [ ] Edge test: `total=0` renders `'0 results'` and disables Prev/Next.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.17 `JsonValueCell, JsonValueList & jsonDiffModel.ts (Structured Payload Inspectors)`

* **Source File:** `packages/ui/src/data/json/JsonValueCell.tsx`
* **Canonical Exports:** `JsonValueCell`, `JsonValueList`, `humanizeKey`, `parsePath`, `humanizePath`, `deepEqual`
* **Role & Design Intent:** Human-friendly rendering of arbitrary JSON metadata, webhook payloads, audit-log before/after snapshots, and nested key-value objects without dumping unreadable raw JSON strings.

#### Detected Gaps, Bugs & Audit Findings

1. Missing utility classes (`.pg-json-diff`, `.pg-bg-surface-subtle`, `.pg-border-subtle`, `.pg-status-success-bg`, `.pg-status-danger-bg`, `.pg-radius-md`) leave `JsonDiffViewer` and `JsonValueCell` unstyled.
2. Long string values or nested arrays inside `JsonValueCell` overflow table cells without truncation or expandable preview.
3. **Forensic Audit — Missing CSS Classes:** `pg-ink-faint, pg-ink-muted` are referenced in `packages/ui/src/data/json/JsonValueCell.tsx` but have zero CSS rules in `packages/ui/src/tokens/*.css`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `JsonValueCell`: typed inline rendering — booleans as subtle `true`/`false` pills, numbers in `tabular-nums`, `null` as italic muted `null`, strings truncated at `120` chars with click-to-expand, ISO timestamps formatted cleanly. `JsonValueList`: indented tree (`padding-inline-start: 14px`, `border-inline-start: 1px solid var(--pg-border-subtle)`) with humanized keys (`merchant_id` -> `Merchant ID`).
* **Padding, Gaps & Rhythm:** Row padding `6px 8px`, key-to-value gap `12px`, nested indent `14px`.
* **Typography Scale & Numerals:** Keys `12.5px/500 --pg-ink-muted`; Values `13px` (mono for IDs/numbers/booleans).
* **Light Mode Palette:** Added diff row `#ECFDF5` (`--pg-status-success-bg`), Removed `#FEF2F2` (`--pg-status-danger-bg`), Changed `#FFFBEB`.
* **Dark Mode Palette:** Added diff row `rgba(16,185,129,0.14)`, Removed `rgba(239,68,68,0.14)`, Changed `rgba(245,158,11,0.14)`.
* **Interactive & Visual States:** Collapsed/Expanded nested objects, Copyable leaf values, Diff mode (Added/Removed/Modified).
* **LTR & RTL Directional Behavior:** Tree indent uses `border-inline-start` / `padding-inline-start`; JSON keys/values preserve readability.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `JsonValueCell`: `value: unknown`, `maxLength?: number` (120), `copyable?: boolean`.
  * `JsonValueList`: `data: Record<string, unknown>`, `humanize?: boolean` (default `true`), `maxDepth?: number` (default `4`).
* **Emitted Events:**
  * None.
* **Slots:**
  * None.
* **User Interactions & Click Behavior:**
  * Clicking truncated string expands inline; clicking copy icon copies raw value.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Expandable toggles are accessible `<button>` elements.
* **Edge Cases & Defensive Guards:**
  * Handles circular/deep objects safely up to `maxDepth`, rendering `'[Nested Object]'` beyond limit.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Unit test: `humanizeKey('settlement_iban_number')` -> `'Settlement IBAN Number'`; `deepEqual` compares nested objects accurately.
- [ ] CSS test: `.pg-json-diff` and diff row background classes exist in `components.css`.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.18 `PgStatChartCard (Abstracted Time-Series & Area/Line Analytics Card)`

* **Source File:** `packages/ui/src/data/charts/PgStatChartCard.tsx`
* **Canonical Exports:** `PgStatChartCard`
* **Role & Design Intent:** Shared `@pg/ui` analytics card combining a KPI headline + trend delta, timeframe/metric header controls, and an embedded `PgChart` (ECharts) with guaranteed non-zero explicit height, smooth area gradient, dark/light theme sync, and loading/empty states — eliminating duplicated `StatsChartCard` copies across `admin-front`, `merchant-front`, and `checkout-front`.

#### Detected Gaps, Bugs & Audit Findings

1. **Live Bug Reported by User:** Dashboard charts render completely invisible (`0px` height) because `admin-front/src/charts/EChart/index.tsx` ignores `height='260px'` and sets `height: '100%'` inside an `auto`-height parent. Also duplicated across 3 frontends instead of living in `@pg/ui`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgCard padding='md'` containing: (1) Header row (`title` + `subtitle` on start, optional headline KPI + delta badge + action slot on end, `margin-bottom: 16px`), (2) Chart viewport container with EXPLICIT CSS height (`min-height: 260px; height: var(--pg-chart-h, 260px); width: 100%; position: relative`) hosting `PgChart`.
* **Padding, Gaps & Rhythm:** Card padding `20px`, header-to-chart gap `16px`, chart internal ECharts grid padding `{ top: 16, right: 16, bottom: 28, left: 48, containLabel: true }`.
* **Typography Scale & Numerals:** Card title `15px/600`, headline KPI `22px/700 tabular-nums`, axis labels `11.5px --pg-ink-muted`, tooltip `12.5px tabular-nums`.
* **Light Mode Palette:** Primary series `#4F46E5` with subtle vertical area gradient (`rgba(79,70,229,0.16)` -> `0`), secondary `#059669`, gridlines `#F1F5F9`, tooltip `#FFFFFF` with `#E2E8F0` border and `--pg-shadow-popover`.
* **Dark Mode Palette:** Primary series `#818CF8` with gradient (`rgba(129,140,248,0.22)` -> `0`), secondary `#34D399`, gridlines `#1E293B`, tooltip `#0F172A` with `#334155` border.
* **Interactive & Visual States:** Loading (`PgSkeleton variant='chart'` at exact `height`), Empty (`PgEmptyState compact` centered at exact `height`), Ready (interactive ECharts hover crosshair + rich formatted tooltip).
* **LTR & RTL Directional Behavior:** Header mirrors cleanly; tooltip formats numbers with Latin digits and localized date headers.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `title: string`, `subtitle?: string`, `value?: string | number`, `delta?: number`, `option: EChartsOption`, `height?: string | number` (default `260`), `loading?: boolean`, `empty?: boolean`, `emptyText?: string`
* **Emitted Events:**
  * `pointClick(params)`.
* **Slots:**
  * `actions` (e.g., timeframe toggle or export button).
* **User Interactions & Click Behavior:**
  * Passes explicit pixel `height` down to `PgChart` (`260px` default — NEVER `100%` inside `auto`!).
  * `ResizeObserver` on container calls `chart.resize()` cleanly when sidebar toggles or window resizes.
  * Watches `resolvedTheme` reactively and re-applies ECharts palette/axis/tooltip colors immediately on Light<->Dark switch.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Card has `role='region'` and `aria-label=title`; exposes accessible summary fallback.
* **Edge Cases & Defensive Guards:**
  * Zero data points renders `PgEmptyState compact` (`'No volume recorded in this period'`) instead of blank empty axes.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Height test: Rendered `<canvas>` / chart container has `computedHeight >= 260px` (NEVER `0px`).
- [ ] Theme test: Switching `resolvedTheme` to `'dark'` updates ECharts tooltip/gridline colors without remount crash.
- [ ] Playwright live test: `/dashboard` with `90 days` selected renders visible non-zero SVG/Canvas charts.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.19 `PgStatBarChartCard (Abstracted Categorical & Stacked Bar Analytics Card)`

* **Source File:** `packages/ui/src/data/charts/PgStatBarChartCard.tsx`
* **Canonical Exports:** `PgStatBarChartCard`
* **Role & Design Intent:** Shared `@pg/ui` bar chart card for payment rail breakdown (`SADAD`, `TADAWUL`, `MOAMALAT`, `CARDS`), settlement status distribution, and top-merchant rankings — replacing duplicated `StatsBarChartCard` implementations across frontends.

#### Detected Gaps, Bugs & Audit Findings

1. Duplicated in `admin-front/src/charts/` and `merchant-front/src/charts/`, inherits the exact `0px` height bug from `EChart`, and renders harsh default ECharts colors without rounded bar caps.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)

* **Structural Anatomy:** `PgCard padding='md'` with header row + `PgChart` container locked to explicit `height` (default `260px`). Bars feature `borderRadius: [6, 6, 0, 0]` (vertical) or `[0, 6, 6, 0]` (horizontal), `barMaxWidth: 32`, and crisp hover highlight.
* **Padding, Gaps & Rhythm:** Card padding `20px`, `height: 260px` default, legend bottom or top-end with `12px` item gap.
* **Typography Scale & Numerals:** Matches `PgStatChartCard` (`15px/600` title, `11.5px` axis labels, `tabular-nums` tooltips).
* **Light Mode Palette:** Curated 2026 Fintech 6-color categorical palette: `#4F46E5` (Indigo), `#059669` (Emerald), `#0284C7` (Sky), `#D97706` (Amber), `#7C3AED` (Violet), `#64748B` (Slate).
* **Dark Mode Palette:** Luminous 6-color dark palette: `#818CF8`, `#34D399`, `#38BDF8`, `#FBBF24`, `#A78BFA`, `#94A3B8`.
* **Interactive & Visual States:** Vertical bars, Horizontal ranked bars (`horizontal=true`), Stacked bars (`stacked=true`), Loading, Empty.
* **LTR & RTL Directional Behavior:** Horizontal bar axis labels align cleanly; tooltips preserve LTR numeric formatting.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)

* **Props & Parameters:**
  * `title: string`, `subtitle?: string`, `categories: string[]`, `series: Array<{ name: string; data: number[]; tone?: string }>`, `horizontal?: boolean`, `stacked?: boolean`, `height?: string | number` (default `260`), `valueFormatter?: (v: number) => string`, `loading?: boolean`
* **Emitted Events:**
  * `barClick({ category, seriesName, value })`.
* **Slots:**
  * `actions`.
* **User Interactions & Click Behavior:**
  * Clicking a bar emits `barClick` so Dashboard pages can drill down into filtered `/transactions`.
  * Hovering any bar dims non-hovered series slightly (`emphasis.focus = 'series'`) and displays exact formatted currency/count.
* **Keyboard Navigation & Accessibility (ARIA):**
  * Accessible region label + optional tabular data toggle.
* **Edge Cases & Defensive Guards:**
  * Long category labels auto-truncate at 14 chars on X-axis with full label shown in hover tooltip.

#### Mandatory OpenCode Verification & Automated Tests

- [ ] Height test: Chart container computes to `260px` (never `0px`).
- [ ] Format test: `valueFormatter` formats hover tooltip values cleanly in `LYD` / counts.
- [ ] Verified visually in both **Light Mode & Dark Mode** and both **English (LTR) & Arabic (RTL)** with zero clipped text, zero missing CSS classes, and zero focus-ring leaks.

### 9.20 `table/filters.ts, table/statusTone.ts & table/types.ts (Table Engine Utilities)`

- **Source File:** `packages/ui/src/data/table/filters.ts`, `statusTone.ts`, `types.ts`
- **Canonical Exports:** `isFilterActive`, `filterToQuery`, `buildFilterQuery`, `activeFilterCount`, `statusTone`, `rowTone`, `criticalRowTone`, `readCell`, `sortRowsByHeader`, `defaultNumberOfItemsPerPageChoices`
- **Role & Design Intent:** Pure functional engine backing `PgTable`, `PgApiTable`, and `PgTableFilters` — handling URL query serialization, active filter badge counts, row-level risk highlighting, nested dot-path cell reading (`merchant.legalName`), and locale/money-aware client sorting.

#### Detected Gaps, Bugs & Audit Findings
1. `sortRowsByHeader` performs lexicographical string sorting on formatted money strings (`"90.000"` > `"100.000"`) unless it delegates to `compareMoney()` from `lib/money.ts`.
2. `filterToQuery` emits empty array parameters (`status=`) into URLs when multi-select filters are cleared, keeping `activeFilterCount` stuck at `1`.

#### Visual Blueprint (Exact Geometry, Surface, Typography & States)
- **Structural Anatomy:** Non-visual data layer powering table sort carets, filter count pills, and critical row left-edge indicators (`3px` inline-start stripe via `.pg-row-indicator--danger`).
- **Padding, Gaps & Rhythm:** N/A.
- **Typography Scale & Numerals:** N/A.
- **Light Mode Palette:** Row tone indicators map strictly to `--pg-status-{tone}-dot`.
- **Dark Mode Palette:** Same semantic tokens.
- **Interactive & Visual States:** Active vs inactive filter states; ascending/descending/none sort states; `criticalRowTone` highlights high-risk/disputed transactions cleanly without washing out row text.
- **LTR & RTL Directional Behavior:** Row indicator stripe uses `inset-inline-start: 0`.

#### Functional Blueprint (Parameters, Events, Slots, Clicks & Edge Cases)
- **Props & Parameters:** Pure TypeScript helpers with strict generic row typing `<T extends Record<string, unknown>>`.
- **Emitted Events:** None.
- **Slots:** None.
- **User Interactions & Click Behavior:** Drives URL bookmarkability so sharing a filtered `/transactions?status=FAILED&from=2026-11-01` link restores exact table state.
- **Keyboard Navigation & Accessibility (ARIA):** N/A.
- **Edge Cases & Defensive Guards:** `readCell` safely resolves nested paths (`"settlement.netAmount"`) and returns `null` (never throws) on missing intermediate objects; `isFilterActive([])` and `isFilterActive({ start: null, end: null })` strictly return `false`.

#### Mandatory OpenCode Verification & Automated Tests
- [ ] Unit test: `activeFilterCount` returns `0` for empty arrays, empty strings, and empty date ranges.
- [ ] Unit test: `sortRowsByHeader` sorts money columns numerically (`90.000` < `100.000`) and dates chronologically.

## PART 10 — COMPLETE CSS TOKEN DICTIONARY & MISSING `.pg-*` CLASS SPECIFICATIONS

OpenCode MUST NOT invent ad-hoc colors, shadows, radii, or z-index values in component files. Every visual property in `packages/ui/src/tokens/fintech-2026.css`, `layout-policy.css`, and `components.css` MUST conform to the exact token table and missing-class definitions below.

### 10.1 Master `tokens/index.css` Load Order (Non-Negotiable)

1. `@import './fintech-2026.css';` — Root `:root` (Light) and `[data-theme='dark']` (Dark) custom properties MUST load FIRST.
2. `@import './layout-policy.css';` — Global container padding, section spacing, page gutters, and responsive grid rules MUST load SECOND.
3. `@import './components.css';` — Component-level rules consuming tokens MUST load THIRD.

### 10.2 Exact `fintech-2026.css` Light & Dark Mode Token Dictionary (100% Codebase-Aligned)

OpenCode MUST use these **exact** token names already defined in `packages/ui/src/tokens/fintech-2026.css` (zero invented aliases, zero blue focus glow, 4-step dark elevation):

| Token Name | Light Mode (`:root`) | Dark Mode (`[data-theme="dark"]`) | Purpose |
| :--- | :--- | :--- | :--- |
| `--pg-bg-canvas` | `#f7f8fa` | `#09090b` | Step 0 — Main application canvas |
| `--pg-bg-surface` | `#ffffff` | `#111114` | Step 1 — Cards, tables, inputs |
| `--pg-bg-surface-subtle` | `#f3f4f6` | `#18181d` | Step 2 — Table headers, gutters, filter bars |
| `--pg-bg-surface-hover` | `#f9fafb` | `#1e1e24` | Hover tint for rows, menus, ghost buttons |
| `--pg-bg-surface-active` | `#f1f5f9` | `#27272f` | Pressed / active tint |
| `--pg-bg-elevated` | `#ffffff` | `#1e1e26` *(upgraded from `#16161b`)* | Step 3 — Floating popovers, dialogs, menus, date pickers |
| `--pg-bg-overlay` | `rgba(15, 23, 42, 0.48)` | `rgba(0, 0, 0, 0.72)` | Modal & drawer backdrop |
| `--pg-bg-glass` | `rgba(255, 255, 255, 0.88)` | `rgba(17, 17, 20, 0.88)` | Frosted sticky `PgAppBar` |
| `--pg-ink-primary` | `#0f172a` | `#f4f4f5` | Primary headings, amounts, values |
| `--pg-ink-secondary` | `#475569` | `#a1a1aa` | Form labels, descriptions, table text |
| `--pg-ink-muted` | `#64748b` | `#71717a` | Subtitles, hints, timestamps, table headers |
| `--pg-ink-faint` | `#94a3b8` | `#52525b` | Placeholders, disabled text, overlines |
| `--pg-ink-on-accent` | `#ffffff` | `#09090b` | Text on `--pg-accent-primary` buttons |
| `--pg-border-subtle` | `#e5e7eb` | `#242429` | Card borders, hairline grids, dividers |
| `--pg-border-default` | `#d1d5db` | `#32323a` | Input borders, outlined buttons |
| `--pg-border-strong` | `#9ca3af` | `#464652` | Hovered inputs, interactive card hover |
| `--pg-border-focus` | `#0f172a` | `#e4e4e7` | Neutral focus border (**ZERO blue glow!**) |
| `--pg-focus-ring` | `0 0 0 3px rgba(15, 23, 42, 0.08)` | `0 0 0 3px rgba(244, 244, 245, 0.12)` | Neutral focus halo around `.pg-control-box` |
| `--pg-focus-ring-danger` | `0 0 0 3px rgba(220, 38, 38, 0.14)` | `0 0 0 3px rgba(248, 113, 113, 0.18)` | Invalid field focus halo |
| `--pg-accent-primary` | `#0f172a` | `#f4f4f5` | Monochrome primary action fill |
| `--pg-accent-primary-hover` | `#1e293b` | `#ffffff` | Primary action hover fill |
| `--pg-accent-brand` | `#4f46e5` | `#6366f1` | Reserved strictly for active nav, links, charts, range caps |
| `--pg-accent-brand-hover` | `#4338ca` | `#818cf8` | Brand hover |
| `--pg-accent-brand-soft` | `rgba(79, 70, 229, 0.08)` | `rgba(99, 102, 241, 0.16)` | Soft active nav pill & calendar range band |
| `--pg-status-success-bg/text/border/dot` | `#f0fdf4` / `#166534` / `#bbf7d0` / `#16a34a` | `rgba(22,163,74,.14)` / `#4ade80` / `rgba(74,222,128,.28)` / `#22c55e` | Success semantic tone |
| `--pg-status-warning-bg/text/border/dot` | `#fffbeb` / `#92400e` / `#fde68a` / `#d97706` | `rgba(217,119,6,.14)` / `#fbbf24` / `rgba(251,191,36,.28)` / `#f59e0b` | Warning / Sandbox banner tone |
| `--pg-status-danger-bg/text/border/dot` | `#fef2f2` / `#991b1b` / `#fecaca` / `#dc2626` | `rgba(220,38,38,.14)` / `#f87171` / `rgba(248,113,113,.28)` / `#ef4444` | Danger / `CRITICAL` tone |
| `--pg-status-info-bg/text/border/dot` | `#eff6ff` / `#1e40af` / `#bfdbfe` / `#2563eb` | `rgba(37,99,235,.16)` / `#60a5fa` / `rgba(96,165,250,.28)` / `#3b82f6` | Info tone |
| `--pg-status-neutral-bg/text/border/dot` | `#f3f4f6` / `#374151` / `#e5e7eb` / `#6b7280` | `rgba(161,161,170,.10)` / `#d4d4d8` / `#2e2e36` / `#a1a1aa` | Neutral tone |
| `--pg-radius-xs / sm / md / lg / pill` | `6px` / `8px` / `12px` / `16px` / `9999px` | Identical | Radii scale |
| `--pg-shadow-xs / sm / popover / modal` | Soft layered slate shadows | Deep dark shadows (`0 18px 40px rgba(0,0,0,.72)`) | Elevation shadows |
| `--pg-control-h-sm / md / lg` | `36px` / `40px` / `44px` | Identical | Exact control heights |
| `--pg-z-sticky / header / drawer / modal / popover / tooltip / toast` | `20` / `30` / `40` / `1000` / `1200` / `1300` / `1500` | Identical | Exact z-index layering scale |

### 10.3 Complete Specification of ALL Missing `.pg-*` Classes Found in Forensic Audit

Every class below is currently referenced in `packages/ui/src/**/*.tsx` with **ZERO CSS rules** in `components.css`. OpenCode MUST implement every single one with exact styling:

* **`.pg-row-actions`** *(used in `TableRowActions.tsx`)*: `display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; white-space: nowrap;` — fixes row buttons sticking together with zero gap.
* **`.pg-row-actions__primary`** *(used in `TableRowActions.tsx`)*: Compact outlined/text button (`height: 30px; padding: 0 10px; font-size: 12.5px; border-radius: 7px;`) — NEVER loud solid primary fill on every row!
* **`.pg-row-actions__more`** *(used in `TableRowActions.tsx`)*: Ghost icon trigger (`width: 30px; height: 30px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center;`) with `--pg-bg-surface-hover` hover.
* **`.pg-row-actions__panel`** *(used in `TableRowActions.tsx`)*: Fixed floating context/overflow menu (`position: fixed; z-index: var(--pg-z-popover); min-width: 196px; padding: 6px; background: var(--pg-bg-surface); border: 1px solid var(--pg-border-subtle); border-radius: 10px; box-shadow: var(--pg-shadow-popover);`).
* **`.pg-menu-divider`** *(used in `TableRowActions.tsx`)*: `height: 1px; margin: 5px 4px; background: var(--pg-border-subtle);`
* **`.pg-menu-item--danger`** *(used in `TableRowActions.tsx`)*: `color: var(--pg-status-danger-text);` with hover `background: var(--pg-status-danger-bg);`.
* **`.pg-menu-trigger`** *(used in `PgMenu.tsx`)*: `display: inline-flex; align-items: center; cursor: pointer;`
* **`.pg-z-popover`** *(used in `PgMenu.tsx, PgAutocomplete.tsx, PgDateInput.tsx`)*: `z-index: var(--pg-z-popover);` (1200 — always floats above modals and sticky table headers!).
* **`.pg-z-tooltip`** *(used in `PgTooltip.tsx`)*: `z-index: var(--pg-z-tooltip);` (1600).
* **`.pg-toast__close`** *(used in `PgToast.tsx`)*: Subtle `26px x 26px` ghost icon button at top inline-end (`border-radius: 6px; color: var(--pg-ink-muted);`) with hover `--pg-bg-surface-hover`.
* **`.pg-toast__action`** *(used in `PgToast.tsx`)*: Inline compact action link/button inside toast (`font-size: 12.5px; font-weight: 600; color: var(--pg-accent-primary); padding: 2px 6px; border-radius: 5px;`).
* **`.pg-toast__timer--paused`** *(used in `PgToast.tsx`)*: `animation-play-state: paused;` — freezes countdown progress bar while pointer hovers toast.
* **`.pg-json-editor__frame`** *(used in `PgCodeEditor.tsx`)*: `display: flex; border: 1px solid var(--pg-border-default); border-radius: 10px; overflow: hidden; background: var(--pg-bg-surface); direction: ltr;` + `:focus-within` border `--pg-border-focus` & ring `--pg-focus-ring`.
* **`.pg-json-editor__frame--invalid`** *(used in `PgCodeEditor.tsx`)*: `border-color: var(--pg-status-danger-dot); box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.14);`
* **`.pg-json-editor__gutter`** *(used in `PgCodeEditor.tsx`)*: `width: 44px; flex-shrink: 0; padding: 12px 8px; background: var(--pg-bg-surface-subtle); border-right: 1px solid var(--pg-border-subtle); text-align: right; user-select: none; overflow: hidden; font-family: var(--pg-font-mono); font-size: 13px; line-height: 20px; color: var(--pg-ink-faint);`
* **`.pg-json-editor__gutter-line`** *(used in `PgCodeEditor.tsx`)*: `height: 20px; line-height: 20px;`
* **`.pg-json-editor__gutter-line--error`** *(used in `PgCodeEditor.tsx`)*: `background: var(--pg-status-danger-bg); color: var(--pg-status-danger-text); font-weight: 600; border-radius: 3px;`
* **`.pg-json-editor__input`** *(used in `PgCodeEditor.tsx`)*: `flex: 1 1 auto; min-width: 0; border: 0; outline: none; resize: vertical; padding: 12px 14px; font-family: var(--pg-font-mono); font-size: 13px; line-height: 20px; background: transparent; color: var(--pg-ink-primary); tab-size: 2;`
* **`.pg-control-adornment--start`** *(used in `PgTextField.tsx, PgAutocomplete.tsx`)*: `display: inline-flex; align-items: center; color: var(--pg-ink-muted); padding-inline-start: 10px; flex-shrink: 0;`
* **`.pg-control-adornment--end`** *(used in `PgTextField.tsx, PgAutocomplete.tsx`)*: `display: inline-flex; align-items: center; gap: 4px; color: var(--pg-ink-muted); padding-inline-end: 8px; flex-shrink: 0;`
* **`.pg-field--disabled`** *(used in `PgFieldShell.tsx`)*: `opacity: 0.62; pointer-events: none;` with `.pg-control-box { background: var(--pg-bg-surface-subtle); }`.
* **`.pg-checkbox--bare`** *(used in `PgCheckbox.tsx`)*: `gap: 0; padding: 0;` for standalone table-row selection checkboxes.
* **`.pg-card--interactive`** *(used in `PgLayout.tsx`)*: `cursor: pointer; transition: border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;` with hover `border-color: var(--pg-border-strong); box-shadow: var(--pg-shadow-sm); transform: translateY(-1px);`.
* **`.pg-inline--wrap`** *(used in `PgLayout.tsx`)*: `flex-wrap: wrap;`
* **`.pg-form`** *(used in `PgShellPrimitives.tsx`)*: `display: flex; flex-direction: column; gap: 16px;`
* **`.pg-field-item--interactive`** *(used in `PgField.tsx`)*: `cursor: pointer; transition: background-color 140ms ease;` with hover `background: var(--pg-bg-surface-hover);`.
* **`.pg-section-fields--split`** *(used in `PgFieldsSection.tsx`)*: `grid-template-columns: repeat(2, minmax(0, 1fr));` (collapses to 1 col below `768px`) with seamless `1px` hairline gap.
* **`.pg-metric-tile__head`** *(used in `PgMetricStrip.tsx`)*: `display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;`
* **`.pg-metric-loading`** *(used in `PgMetricStrip.tsx`)*: `display: flex; flex-direction: column; gap: 8px; padding: 4px 0;`
* **`.pg-badge__label`** *(used in `PgStatusBadge.tsx`)*: `line-height: 1; white-space: nowrap;`
* **`.pg-command-backdrop`** *(used in `PgCommandPalette.tsx`)*: `position: fixed; inset: 0; z-index: var(--pg-z-modal); background: rgba(15, 23, 42, 0.48); backdrop-filter: blur(4px); display: flex; align-items: flex-start; justify-content: center; padding: 10vh 16px 24px;`
* **`.pg-table-filter-surface`** *(used in `TableFilters.tsx`)*: `padding: 14px 16px; background: var(--pg-bg-surface-subtle); border-bottom: 1px solid var(--pg-border-subtle); display: flex; flex-direction: column; gap: 12px;`
* **`.pg-json-diff`** *(used in `JsonDiffViewer.tsx`)*: `border: 1px solid var(--pg-border-subtle); border-radius: 10px; overflow: hidden; font-family: var(--pg-font-mono); font-size: 12.5px;`
* **`.pg-sr-only`** *(used in `Table.tsx, HeaderFooter.tsx, JsonDiffViewer.tsx`)*: `position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;`
* **`.pg-status-success-text / -danger-text / -bg / -dot`** *(used in `PgMoneyText.tsx, PgIcon.tsx, JsonDiffViewer.tsx`)*: Semantic utility classes mapped directly to `var(--pg-status-{tone}-{role})` tokens.

## PART 11 — COMPLETE 4-FRONTEND PAGE SWEEP MATRIX (204 PAGES & ALL 89 CORRUPTED HEADERS)

Fixing `@pg/ui` alone is only half the mission. OpenCode MUST sweep all **4 frontends** (`admin-front`: 148 pages, `merchant-front`: 46 pages, `checkout-front`: 3 pages, `fake-rails-front`: 7 pages) to eliminate every migration artifact, stray parenthesis, duplicated chart, broken drawer binding, and inline spacing hack.

### 11.1 Live-Observed High-Priority Page Fixes (Verified on `admin-pg-dev.duckdns.org`)

1. **Dashboard (`admin-front/src/pages/dashboard/index.tsx` & `merchant-front/src/pages/dashboard/index.tsx`):**
   * Replace local `src/charts/EChart`, `StatsChartCard`, `StatsBarChartCard` imports with `@pg/ui`'s `PgChart`, `PgStatChartCard`, `PgStatBarChartCard`.
   * Pass explicit `height={280}` so charts render immediately for `7d`, `30d`, and `90d` timeframes (zero `0px` invisible canvases!).
   * Balance KPI `PgMetricStrip` grid so 5 or 6 KPIs NEVER leave 1 or 2 lonely orphan tiles on a second row.
2. **Report Catalog (`admin-front/src/pages/reports/catalog/index.tsx`):**
   * Strip literal `(` and `)` wrapping `<PageHeader>` action buttons (`Refresh`, `Open Studio`, `Headers & Footers`).
   * Fix row action hierarchy (`Run` as subtle outlined button + `[...]` overflow menu + right-click context menu) with `6px` gap.
   * Ensure report IDs use `PgMonoRef` (`copyable=true` by default after `dc.ts` fix) with green checkmark fade animation.
3. **Merchants (`admin-front/src/pages/merchants/index.tsx`):**
   * Default all SOP `PgExpansionPanels` to **collapsed** so the Merchants table is immediately visible above the fold instead of pushed `2,000px` down.
   * Remove duplicate `'Merchant portfolio health'` heading inside `PgSummaryExportCard`.
   * Fix pre-checked yet disabled export checklist items and clipped `...mary` Export button width.
4. **Transactions (`admin-front/src/pages/transactions/index.tsx`):**
   * Remove duplicate `'Transaction health'` heading and duplicate `From` / `To` date filter labels.
   * Fix `Status` multi-select filter staying open while checking multiple statuses.
   * Fix sticky `Actions` column overlapping/clipping the `Rail` column by enforcing clean horizontal scroll container + subtle scrolled edge shadow.
   * Fix `ContextHelpDrawer` route-to-screen mapping so `/transactions` opens Transactions help (NOT `OperatorCases`!) and fix `CRITICAL` badge contrast.
5. **Global Guide Search Palette (`GuideSearchPalette`):**
   * Typing in search input MUST filter results ONLY — NEVER auto-navigate while typing! Navigation occurs strictly on clicking a result row or pressing `Enter` on the highlighted item.
   * Fix close `X` button padding so it NEVER overlaps the search input or results.
6. **App Shell & Navigation (`admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front`):**
   * Change `<html lang='ar' dir='rtl'>` in all `index.html` files to `<html lang='en' dir='ltr'>` and sync `i18n.ts` default locale with `packages/ui/src/lib/locale.ts` (`'en'` when unset, honoring `localStorage['locale-name']`).
   * Fix sidebar scroll flex container so bottom links (`Settings`, `Audit Logs`) are 100% visible above the pinned user footer.
   * Fix App Bar Language Menu via `PgThemeLanguageControls` + Vapor `createIf` `PgMenu`.

### 11.2 Exact Inventory of ALL 89 Pages Corrupted With Stray `<PageHeader ...>(` and `)</PageHeader>`

OpenCode MUST strip the literal `(` after `<PageHeader ...>` and `)` before `</PageHeader>` in **EVERY SINGLE FILE** below (and run a repo-wide regex check confirming `0` remaining matches):

#### A. `admin-front` (65 Files)

 1. `admin-front/src/pages/academy/help.tsx`
 2. `admin-front/src/pages/academy/index.tsx`
 3. `admin-front/src/pages/academy/lesson.tsx`
 4. `admin-front/src/pages/academy/module.tsx`
 5. `admin-front/src/pages/academy/team.tsx`
 6. `admin-front/src/pages/academy/track.tsx`
 7. `admin-front/src/pages/academy/tracks.tsx`
 8. `admin-front/src/pages/adjustments/index.tsx`
 9. `admin-front/src/pages/aml/cases/index.tsx`
10. `admin-front/src/pages/aml/reporting-studio/index.tsx`
11. `admin-front/src/pages/aml/reports/index.tsx`
12. `admin-front/src/pages/aml/rules/index.tsx`
13. `admin-front/src/pages/aml/screenings/index.tsx`
14. `admin-front/src/pages/approvals/index.tsx`
15. `admin-front/src/pages/audit-logs/index.tsx`
16. `admin-front/src/pages/cashouts/index.tsx`
17. `admin-front/src/pages/credential-sets/index.tsx`
18. `admin-front/src/pages/dashboard/index.tsx`
19. `admin-front/src/pages/disputes/index.tsx`
20. `admin-front/src/pages/filing-adapters/index.tsx`
21. `admin-front/src/pages/finance/invariant/index.tsx`
22. `admin-front/src/pages/finance/journal-entries/index.tsx`
23. `admin-front/src/pages/finance/liquidity/index.tsx`
24. `admin-front/src/pages/finance/pricing/index.tsx`
25. `admin-front/src/pages/finance/profitability/index.tsx`
26. `admin-front/src/pages/gateways/ai-import/index.tsx`
27. `admin-front/src/pages/gateways/index.tsx`
28. `admin-front/src/pages/gateways/wizard/[id].tsx`
29. `admin-front/src/pages/guide/article.tsx`
30. `admin-front/src/pages/guide/cards.tsx`
31. `admin-front/src/pages/guide/edge-cases.tsx`
32. `admin-front/src/pages/guide/glossary.tsx`
33. `admin-front/src/pages/guide/index.tsx`
34. `admin-front/src/pages/guide/playbook.tsx`
35. `admin-front/src/pages/guide/tools.tsx`
36. `admin-front/src/pages/incidents/index.tsx`
37. `admin-front/src/pages/join-requests/[id].tsx`
38. `admin-front/src/pages/join-requests/index.tsx`
39. `admin-front/src/pages/join-requests/new.tsx`
40. `admin-front/src/pages/kyb/[id].tsx`
41. `admin-front/src/pages/kyb/index.tsx`
42. `admin-front/src/pages/merchants/[id].tsx`
43. `admin-front/src/pages/merchants/index.tsx`
44. `admin-front/src/pages/operator-cases/[id].tsx`
45. `admin-front/src/pages/operator-cases/index.tsx`
46. `admin-front/src/pages/operator-cases/inquiries/index.tsx`
47. `admin-front/src/pages/rails/index.tsx`
48. `admin-front/src/pages/reconciliation/index.tsx`
49. `admin-front/src/pages/reports/catalog/index.tsx`
50. `admin-front/src/pages/reports/chrome/index.tsx`
51. `admin-front/src/pages/reports/chrome/needs-migration/index.tsx`
52. `admin-front/src/pages/reports/merchant-reports/index.tsx`
53. `admin-front/src/pages/reports/needs-migration/index.tsx`
54. `admin-front/src/pages/reports/studio/index.tsx`
55. `admin-front/src/pages/routes/index.tsx`
56. `admin-front/src/pages/settings/checkout-help/index.tsx`
57. `admin-front/src/pages/settings/platform/index.tsx`
58. `admin-front/src/pages/system/backups/index.tsx`
59. `admin-front/src/pages/system/jobs-outbox/index.tsx`
60. `admin-front/src/pages/system/object-storage/index.tsx`
61. `admin-front/src/pages/transactions/index.tsx`
62. `admin-front/src/pages/users/[id].tsx`
63. `admin-front/src/pages/users/index.tsx`
64. `admin-front/src/pages/wallets/[id].tsx`
65. `admin-front/src/pages/wallets/index.tsx`

#### B. `merchant-front` (24 Files)

 1. `merchant-front/src/pages/cashouts/index.tsx`
 2. `merchant-front/src/pages/credentials/index.tsx`
 3. `merchant-front/src/pages/dashboard/index.tsx`
 4. `merchant-front/src/pages/developers/tokens/index.tsx`
 5. `merchant-front/src/pages/developers/webhooks/index.tsx`
 6. `merchant-front/src/pages/disputes/index.tsx`
 7. `merchant-front/src/pages/guide/developers/index.tsx`
 8. `merchant-front/src/pages/guide/index.tsx`
 9. `merchant-front/src/pages/links/index.tsx`
10. `merchant-front/src/pages/onboarding/index.tsx`
11. `merchant-front/src/pages/pos/index.tsx`
12. `merchant-front/src/pages/pos/screen/[code].tsx`
13. `merchant-front/src/pages/reports/chrome/index.tsx`
14. `merchant-front/src/pages/reports/chrome/needs-migration/index.tsx`
15. `merchant-front/src/pages/reports/index.tsx`
16. `merchant-front/src/pages/reports/needs-migration/index.tsx`
17. `merchant-front/src/pages/reports/studio/index.tsx`
18. `merchant-front/src/pages/sandbox/overview/index.tsx`
19. `merchant-front/src/pages/sandbox/payments/[id].tsx`
20. `merchant-front/src/pages/sandbox/wallets/[id].tsx`
21. `merchant-front/src/pages/sandbox/wallets/index.tsx`
22. `merchant-front/src/pages/statements/index.tsx`
23. `merchant-front/src/pages/team/index.tsx`
24. `merchant-front/src/pages/wallets/index.tsx`

### 11.3 Mandatory Repo-Wide Code Sweeps Across All 4 Frontends

- [ ] **Delete Duplicated Local Charts:** Remove `admin-front/src/charts/`, `merchant-front/src/charts/`, and `checkout-front/src/charts/` once `PgChart`, `PgStatChartCard`, and `PgStatBarChartCard` live in `@pg/ui`.
- [ ] **Eliminate Raw Native Controls:** Zero raw `<select>`, `<input type='checkbox'>`, `<input type='date'>`, or unstyled `<input type='search'>` inside any page `.tsx` — every form/filter control MUST import from `@pg/ui`.
- [ ] **Eliminate Ad-Hoc Alerts & Toasts:** Every warning/info/error banner (including `'Email not configured'` and `'Sandbox Execution Plane'`) MUST use the single unified `PgAlert` component; every transient notification MUST call `showToast()` rendered by `PgToaster`.
- [ ] **Eliminate Legacy Inline Layout Hacks:** Replace ad-hoc `<div class='pa-4'>` / `<ThemedView style={{ gap: '18px' }}>` outer wrappers with `PgPage`, `PgSection`, `PgCard`, and `PgFormGrid`.

## PART 12 — OPENCODE EXECUTION ROADMAP, AUTOMATED TEST MANDATE & FINAL SIGN-OFF GATE

### 12.1 Strict Wave Execution Order

1. **Wave 1 — Systemic Foundations (Zero Visual Guesswork):** Fix `index.html`/`i18n.ts`/`locale.ts` RTL leak -> Fix `dc.ts` `options.props` stripping -> Fix `tokens/index.css` load order & `:focus-visible` leak -> Implement all 35+ missing `.pg-*` classes in `components.css` -> Strip stray `(` `)` across all 89 corrupted pages.
2. **Wave 2 — Pure Vapor Overlay Engine & Core Primitives:** Migrate all 6 overlays (`PgMenu`, `PgTooltip`, `PgAutocomplete`, `PgDateInput`, `TableFilters`, `TableRowActions`) to pure Vapor `createIf` with zero VDOM `<Teleport>` -> Fix `PgButton`, `PgMonoRef`, `PgAlert`, `PgToast`, `PgCheckbox`, `PgTextField`, `PgSearchInput`, `PgCodeEditor`.
3. **Wave 3 — Complex Data & Analytics Components:** Fix `PgAutocomplete` (multi-select stay-open + combobox), `PgApiAutocomplete` (no inline `↻`), `PgDateInput`/`PgDateRangeInput` (presets + LTR/RTL weekdays), `PgFieldsSection` (zero gaps hairline grid), `PgMetricStrip` (no orphan rows), `PgTable`/`PgTableRowActions` (hierarchy + right-click menu + sticky scroll), and extract `PgChart`/`PgStatChartCard`/`PgStatBarChartCard` into `@pg/ui`.
4. **Wave 4 — 4-Frontend Sweep & Page-Specific Fixes:** Apply all Part 11 page fixes (`/dashboard`, `/reports/catalog`, `/merchants`, `/transactions`, `GuideSearchPalette`, `ContextHelpDrawer`, sidebar footer) across `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front`.
5. **Wave 5 — Automated Blueprint Verification & Visual Proof:** Run the complete Vitest component suite, `governanceAudit.ts` CI gate, typecheck/build across all 5 packages, and Playwright end-to-end visual + interactive verification in both Light/Dark and EN/AR modes.

### 12.2 Mandatory Per-Component Automated Test Suite (`packages/ui/test/*.test.ts`)

OpenCode is STRICTLY REQUIRED to write and pass unit/component tests verifying **every single blueprint requirement** (every padding token, gap, border, focus ring, click, keyboard shortcut, Light/Dark class, and LTR/RTL direction). Do NOT skip or mock away real DOM assertions:

| Test File | Components & Blueprint Contracts Verified | 
| ----- | ----- | 
| `test/runtime.test.ts` | `dc.ts` preserves `options.props` defaults & stops leaking object props to DOM; `locale.ts` defaults to `en`/`ltr` & syncs `html[dir]`; `theme.ts` persists & resolves `system/light/dark`; `dom.ts` clickOutside/Escape/focusTrap/copyToClipboard; `money.ts`, `date.ts`, `options.ts`, `rules.ts`, `status.ts`. | 
| `test/layout.test.ts` | `PgApp`/`PgMain` (`min-width: 0`); `PgAppBar` (`60px` sticky); `PgNavigationDrawer` (scrollable flex body above pinned footer); `PgPage`/`PgSection`/`PgCard` (global padding policy, `.pg-card--interactive`, nested padding reset); `PgPageHeader` (no stray parens); `PgExpansionPanels` (default ALL collapsed); `PgForm` (`validate()`/`resetValidation()`). | 
| `test/actions.test.ts` | `PgButton` (no double loading+prepend icon, all variants/sizes); `PgIcon` (known & fallback icons); `PgSegmentedTabs` & `PgBtnToggle` (keyboard arrows, mandatory); `PgThemeLanguageControls` (opens menu, flips EN<->AR & Light<->Dark); `PgSpinner`, `PgProgressBar`, `PgDivider`, `PgAvatar`, `PgChip`, `PgTag`. | 
| `test/inputs-text.test.ts` | `PgFieldShell` & `PgFormField` (full-box `:focus-within` hue, zero inner-input outline); `PgTextField` (clearable, password reveal, prefix/suffix, rules); `PgSearchInput`; `PgTextarea` (auto-grow, counter); `PgOtpInput` (6-digit paste, `dir='ltr'`); `PgCodeEditor` (all 6 `.pg-json-editor__*` classes, JSON validation, format). | 
| `test/inputs-selection.test.ts` | `PgAutocomplete` (single, multi-select STAYS OPEN on click, chips remove without toggling menu, combobox create, keyboard nav, Vapor `createIf`); `PgApiAutocomplete` (debounce + `AbortController`, zero inline `↻` box); `PgDateInput` & `PgDateRangeInput` (presets, swap order, LTR/RTL weekdays); `PgCheckbox` (2026 squircle, indeterminate, not disabled); `PgChoice`, `PgSwitch`, `PgRadioGroup`, `PgSlider`, `PgFileUpload`. | 
| `test/overlays.test.ts` | `PgDialog`, `PgConfirmDialog` (danger focuses Cancel, `requireText` lock), `PgFormModal` (non-overlapping `X`, validates before submit), `PgDetailsDialog`; `PgDrawer`; `PgCommandPalette` (typing filters ONLY — zero auto-navigation!); `PgMenu` & `PgTooltip` (pure Vapor `createIf`, zero VDOM `<Teleport>`, viewport flip). | 
| `test/feedback.test.ts` | `PgAlert` (all tones matching Sandbox Execution Plane standard); `PgToast`/`PgToaster`/`toastStore` (auto-dismiss timer, pause on hover, close button, stacking); `PgStatusBadge` (`CRITICAL` -> high-contrast `danger`), `PgMetaPill`, `PgEmptyState`, `PgSkeleton`, `PgStateView`, `PgLoadingScreen`. | 
| `test/data-table.test.ts` | `PgMetricStrip` & `PgMiniStats` (balanced grid, zero orphan rows); `PgSummaryExportCard` (no duplicate header, interactive checklist, non-clipped Export); `PgFormChecklist`; `PgField` & `PgFieldsSection` (seamless `1px` hairline grid — ZERO gaps between boxes); `PgMoneyText` (`dir='ltr'` tabular-nums); `PgMonoRef` (click-to-copy + emerald checkmark fade); `PgTable` & `PgApiTable` (sticky scroll, abort race); `PgTableHeader`/`Footer`; `PgTableFilters` (zero duplicate date labels); `PgTableRowActions` (outlined/text primary + `[...]` + right-click context menu, pure Vapor); `JsonDiffViewer`/`JsonValueCell`/`JsonValueList`. | 
| `test/charts.test.ts` | `PgChart`, `PgStatChartCard`, `PgStatBarChartCard` render explicit non-zero height (`>= 260px`), respond to `ResizeObserver`, and switch palettes cleanly on Light<->Dark toggle. | 
| `test/governance.test.ts` | `governanceAudit.ts` confirms: `0` stray `<PageHeader>(` parens across all 204 pages, `0` VDOM `<Teleport>` imports in `packages/ui`, `0` missing `.pg-*` CSS classes, `0` duplicated `src/charts/` directories in frontends, and `0` raw `<select>` elements in page code. | 

### 12.3 Final Playwright Live-Verification Sign-Off Checklist

Before declaring the task complete, OpenCode MUST boot the dev server and verify every item below via automated Playwright assertions:

- [ ] **English Mode (`/dashboard`, `/reports/catalog`, `/merchants`, `/transactions`):** `html[lang='en'][dir='ltr']`, zero stray `(` `)` characters anywhere on screen.
- [ ] **Language Switcher:** Clicking App Bar language button opens crisp `PgMenu`, switching to `العربية` flips to `dir='rtl'` immediately, switching back restores `dir='ltr'`.
- [ ] **Dashboard Charts:** Selecting `90 days` renders visible, non-zero-height (`>= 260px`) interactive charts in both Light and Dark mode.
- [ ] **Report Catalog Row Actions & Copyable IDs:** Clicking an ID copies to clipboard and animates emerald checkmark; row buttons have `6px` gap and refined outlined/text hierarchy; both `[...]` click AND row right-click open the floating context menu.
- [ ] **Focus Ring & Inputs:** Focusing any search, filter, or form input illuminates the **entire `.pg-control-box`** border + neutral slate halo (`--pg-focus-ring`, zero blue glow) — NEVER a harsh outline around the inner `<input>` only.
- [ ] **Filters & Date Pickers:** Multi-select `Status` dropdown stays open while toggling multiple checkboxes; Date filters show single clean labels and correct LTR weekday order.
- [ ] **Merchants & Transactions Pages:** Tables sit immediately above the fold (SOP accordions collapsed by default), `PgFieldsSection` tiles have zero gaps between boxes, `PgSummaryExportCard` has no duplicate title or disabled checklist, and `ContextHelpDrawer` opens the correct screen with WCAG AA `CRITICAL` contrast.
- [ ] **Guide Search Palette:** Typing `'settlement'` filters results smoothly without navigating away; close `X` has clean padding and never overlaps content.
- [ ] **Build & Typecheck:** `pnpm --filter @pg/ui test`, `pnpm --filter @pg/ui build`, and `pnpm build` across `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front` all exit `0`.

## PART 13 — HIGH-IMPACT COMPONENT EXACT PIXEL, STATE-TRANSITION & DOM TEST-HOOK MATRICES

For the 12 highest-visibility interactive components in `@pg/ui`, OpenCode MUST enforce the exact pixel geometry, state transitions, and `data-pg-*` test hooks below so both automated tests and human eyes verify zero drift:

### 13.1 `PgButton` (`data-pg-btn`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Size `sm`** | Height `32px`, Padding `0 12px`, Font `12.5px/500`, Icon `15px`, Gap `6px`, Radius `7px` | 
| **Size `md` (Default)** | Height `38px`, Padding `0 16px`, Font `13.5px/500`, Icon `16px`, Gap `8px`, Radius `8px` | 
| **Size `lg`** | Height `44px`, Padding `0 20px`, Font `14.5px/600`, Icon `18px`, Gap `8px`, Radius `9px` | 
| **Icon-Only (`icon`)** | `32x32` (sm) / `36x36` (md) / `42x42` (lg), `padding: 0`, centered icon | 
| **Variant `primary`** | Bg `--pg-accent-primary`, Ink `#FFFFFF`, Hover `--pg-accent-primary-hover`, Active `scale(0.985)` | 
| **Variant `outlined`** | Bg `--pg-bg-surface`, Border `1px solid --pg-border-default`, Ink `--pg-ink-primary`, Hover bg `--pg-bg-surface-hover` + border `--pg-border-strong` | 
| **Variant `tonal`** | Bg `--pg-accent-brand-soft`, Ink `--pg-accent-primary`, Hover slightly deeper tint — zero harsh drop shadow | 
| **Variant `ghost` / `text`** | Bg `transparent`, Ink `--pg-ink-secondary`, Hover bg `--pg-bg-surface-hover` + ink `--pg-ink-primary` | 
| **Variant `danger`** | Bg `#DC2626` (solid) or `--pg-status-danger-bg` (tonal), Ink `#FFFFFF` / `--pg-status-danger-text` | 
| **State `loading`** | Replaces `prependIcon` in-place with `PgSpinner` (`15px`) — NEVER renders both spinner AND prepend icon simultaneously! | 
| **State `focus-visible`** | `outline: none; box-shadow: 0 0 0 3px var(--pg-focus-ring);` | 
| **State `disabled`** | `opacity: 0.48; pointer-events: none; cursor: not-allowed;` | 

### 13.2 `PgTextField & PgSearchInput` (`data-pg-field`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Control Box `sm`** | Height `32px`, Padding `0 10px`, Font `13px`, Radius `7px`, Gap `8px` | 
| **Control Box `md` (Default)** | Height `40px`, Padding `0 12px`, Font `13.5px`, Radius `8px`, Gap `8px` | 
| **Control Box `lg`** | Height `46px`, Padding `0 14px`, Font `14.5px`, Radius `9px`, Gap `10px` | 
| **Inner `<input>`** | `border: 0; outline: none !important; box-shadow: none !important; background: transparent; flex: 1 1 auto; min-width: 0;` | 
| **Resting Box** | Bg `--pg-bg-surface`, Border `1px solid --pg-border-default` | 
| **Hover Box** | Border `1px solid --pg-border-strong` | 
| **Focus-Within Box** | Border `1px solid --pg-border-focus`, `box-shadow: 0 0 0 3px var(--pg-focus-ring)` — surrounds ENTIRE `.pg-control-box` (icons + input + clear button), NEVER inner `<input>`! | 
| **Error Box** | Border `1px solid --pg-status-danger-dot`, Focus-Within `box-shadow: 0 0 0 3px rgba(239,68,68,0.16)` | 
| **Clear Button (`×`)** | `22px x 22px` ghost button in trailing adornment; appears only when value non-empty and not disabled/readonly | 
| **Prefix / Suffix** | Muted `--pg-ink-muted` `13px` non-wrapping adornment inside `.pg-control-box` | 

### 13.3 `PgAutocomplete & PgApiAutocomplete` (`data-pg-autocomplete`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Trigger Box** | Min-height `40px` (`32px` sm), `padding: 4px 10px`, `gap: 6px`, wraps selected `PgChip` pills cleanly without clipping | 
| **Popover Panel** | Pure Vapor `createIf`, `position: fixed; z-index: 1200; min-width: triggerWidth; max-height: 300px; overflow-y: auto; padding: 6px; border-radius: 10px; border: 1px solid --pg-border-subtle; box-shadow: --pg-shadow-popover;` | 
| **Option Row** | Min-height `36px`, `padding: 7px 10px`, `gap: 10px`, `border-radius: 7px`, Hover/Highlighted bg `--pg-bg-surface-hover` | 
| **Single Select** | Selected row shows `--pg-accent-brand-soft` tint + trailing checkmark icon; clicking option closes popover immediately | 
| **Multi Select** | Each row shows leading 2026 squircle `PgCheckbox`; clicking row toggles selection and **KEEPS POPOVER OPEN** | 
| **Combobox Mode** | When typed query matches no existing option, renders `'Create "<query>"'` action row at bottom with `+` icon | 
| **Async Loading** | Inline `14px` `PgSpinner` in trailing adornment (NO ugly bordered `↻` box inside input!) + 3 skeleton rows on initial empty open | 
| **Keyboard** | `ArrowDown`/`ArrowUp` scrolls highlighted option into view; `Enter` toggles/selects; `Escape` closes; `Backspace` on empty query removes last chip | 

### 13.4 `PgDateInput & PgDateRangeInput` (`data-pg-date`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Trigger Box** | Height `40px` (`32px` sm), leading calendar icon (`16px`), formatted date or `YYYY-MM-DD`, trailing clear `×` | 
| **Popover Frame** | Pure Vapor `createIf`, `position: fixed; z-index: 1200; border-radius: 14px; border: 1px solid --pg-border-subtle; box-shadow: --pg-shadow-popover; padding: 14px;` | 
| **Calendar Header** | Prev/Next month `30x30` ghost buttons + clickable `Month Year` pill switching to 12-month / 12-year fast-jump grid | 
| **Weekday Row** | 7 equal `34px` columns; strictly `Su Mo Tu We Th Fr Sa` left-to-right in English (LTR) and localized right-to-left in Arabic (RTL) | 
| **Day Cell** | `34px x 34px`, `border-radius: 8px`, `13px/500 tabular-nums`; Today shows `1.5px solid --pg-accent-primary` ring; Selected fills `--pg-accent-primary` + `#FFFFFF` ink | 
| **Range Band** | In-range days fill `--pg-accent-brand-soft` with `border-radius: 0`; start/end caps use logical `8px` outer radius | 
| **Presets Sidebar** | `152px` wide, hairline divider, presets: Today, Last 7D, Last 30D, Last 90D, This Month, Last Month | 
| **Footer** | `Today` / `Clear` quick links + `Cancel` / `Apply` buttons for range mode | 

### 13.5 `PgCheckbox (2026 Tactile Squircle)` (`data-pg-checkbox`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Visual Box** | `18px x 18px` (`16px` compact in tables), `border-radius: 5px`, `border: 1.5px solid --pg-border-strong`, `transition: all 140ms cubic-bezier(0.2,0,0,1)` | 
| **Hit Target** | Expanded invisible `32px x 32px` touch/click area around box; clicking label toggles cleanly | 
| **Checked State** | Solid `--pg-accent-primary` fill + crisp `12px` white SVG checkmark (`stroke-width: 2.4`, animated draw-in) | 
| **Indeterminate State** | Solid `--pg-accent-primary` fill + crisp `10px` white horizontal dash (`2px` stroke) | 
| **Focus-Visible** | `0 0 0 3px var(--pg-focus-ring)` around the `18x18` squircle | 
| **Disabled State** | `opacity: 0.45; cursor: not-allowed` — ONLY applied when `disabled=true` is explicitly passed (NEVER accidentally disabled like `vael-ui`!) | 

### 13.6 `PgAlert (Single Unified Banner System)` (`data-pg-alert`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Container** | `display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: 10px; border: 1px solid var(--pg-status-{tone}-border); background: var(--pg-status-{tone}-bg);` | 
| **Accent Stripe** | Optional `3px` inline-start solid accent bar (`--pg-status-{tone}-dot`) matching Sandbox Execution Plane authority | 
| **Icon** | `18px` semantic icon (`check-circle`, `alert`, `alert-circle`, `information`) aligned to first title line | 
| **Typography** | Title `13.5px/600` (`--pg-status-{tone}-text`); Body `13px/400` `line-height: 1.5` | 
| **Actions & Close** | Inline action button slot + optional `28x28` ghost dismiss `×` button at top inline-end | 
| **Mandatory Coverage** | Replaces ALL unstyled alerts across all 4 frontends (`Email not configured`, `Sandbox Execution Plane`, `Reports Needing Migration`, inline form errors) | 

### 13.7 `PgToast & PgToaster (Auto-Dismissing Notifications)` (`data-pg-toast`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Viewport Anchor** | `position: fixed; bottom: 20px; inset-inline-end: 20px; z-index: var(--pg-z-toast) (1500); display: flex; flex-direction: column; gap: 10px; max-width: 400px; width: calc(100vw - 32px);` | 
| **Toast Card** | Bg `--pg-bg-surface`, Border `1px solid --pg-border-subtle`, Radius `12px`, Padding `14px 16px`, Shadow `--pg-shadow-popover`, `overflow: hidden` | 
| **Auto-Dismiss Timer** | Default `4500ms` (`6500ms` for danger/warning); `2.5px` bottom countdown progress bar colored by `--pg-status-{tone}-dot` | 
| **Pause on Hover** | Hovering or focusing toast pauses both JS `setTimeout` AND CSS countdown bar (`.pg-toast__timer--paused`) | 
| **Stack Limit** | Max `4` visible toasts; oldest auto-dismisses smoothly when 5th arrives; deduplicates identical message within `1500ms` | 
| **Close & Action** | `.pg-toast__close` (`26x26` ghost `×`) + optional `.pg-toast__action` (`Undo` / `View`) | 

### 13.8 `PgDialog & PgFormModal` (`data-pg-dialog`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Backdrop** | `position: fixed; inset: 0; z-index: 1000; background: rgba(15,23,42,0.5); backdrop-filter: blur(4px); padding: 24px 16px;` | 
| **Panel Surface** | Bg `--pg-bg-surface`, Border `1px solid --pg-border-subtle`, Radius `16px`, Shadow `--pg-shadow-popover`, `max-height: 88dvh`, flex-column | 
| **Header Padding** | `20px 24px 16px`, `display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;` — Close `X` (`32x32`) sits cleanly in flex end slot, ZERO overlap! | 
| **Body Padding** | `20px 24px`, `flex: 1 1 auto; overflow-y: auto;` | 
| **Footer Padding** | `16px 24px`, `border-top: 1px solid --pg-border-subtle`, `display: flex; justify-content: flex-end; gap: 10px;` | 
| **Focus & Scroll** | Locks `document.body` scroll via `lockBodyScroll()`, traps `Tab` via `useFocusTrap()`, closes on `Escape` (unless `persistent`/`loading`) | 

### 13.9 `PgTable & PgTableFilters` (`data-pg-table`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Scroll Wrapper** | `.pg-table-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }` — NEVER causes document horizontal scroll | 
| **Header Row** | `height: 40px`, Bg `--pg-bg-surface-subtle`, `11.5px/600` uppercase `letter-spacing: 0.04em` `--pg-ink-muted`, `border-bottom: 1px solid --pg-border-subtle` | 
| **Body Row** | `min-height: 48px` (`40px` compact), Cell padding `10px 14px`, `border-bottom: 1px solid --pg-border-subtle`, Hover bg `--pg-bg-surface-hover` | 
| **Sticky Actions Col** | `position: sticky; inset-inline-end: 0; background: inherit; box-shadow: -8px 0 12px -8px rgba(15,23,42,0.12);` — clean scrolled edge shadow, NEVER clips adjacent `Rail` text | 
| **Filter Bar** | Single clean label per filter control (ZERO duplicate `From`/`From` or `To`/`To` labels!), `gap: 12px`, active filter count badge + `Reset all` button | 
| **Row Context Menu** | `onContextmenu` prevents default browser menu and opens `PgTableRowActions` floating panel at exact `(clientX, clientY)` clamped to viewport | 

### 13.10 `PgTableRowActions` (`data-pg-row-actions`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Container** | `.pg-row-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; white-space: nowrap; }` | 
| **Primary Action** | Subtle `variant='outlined'` or `variant='ghost'` `sm` button (`height: 30px`, `padding: 0 10px`) — NEVER loud solid filled buttons on every table row! | 
| **Overflow Trigger** | `30px x 30px` ghost icon button (`mdi-dots-horizontal`) with `aria-haspopup='menu'` and `aria-expanded` | 
| **Floating Panel** | Pure Vapor `createIf` + `position: fixed; z-index: 1200; min-width: 196px; padding: 6px;` — ZERO VDOM `<Teleport>`! | 
| **Menu Item** | `height: 34px`, `padding: 0 10px`, `gap: 8px`, `border-radius: 6px`, `13px/500`; danger items use `.pg-menu-item--danger` | 
| **Auto-Dismiss** | Closes on item click, outside click, `Escape`, scroll, or opening another row's menu | 

### 13.11 `PgFieldsSection & PgMetricStrip` (`data-pg-fields-section`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Outer Frame** | `border: 1px solid --pg-border-subtle; border-radius: 12px; overflow: hidden; background: --pg-border-subtle;` | 
| **Seamless Grid** | `display: grid; gap: 1px;` — EVERY tile has `background: --pg-bg-surface`, producing razor-sharp `1px` hairline borders and **ZERO floating gaps between boxes**! | 
| **Tile Padding** | `PgField`: `14px 16px` (`gap: 4px`); `PgMetricStrip`: `16px 20px` (`gap: 6px`) | 
| **Orphan Prevention** | `PgMetricStrip` dynamically picks `grid-template-columns`: 1->1, 2->2, 3->3, 4->4, 5->5 (or 3+2 balanced), 6->3 (3+3 balanced, NEVER 4+2!), 7->4+3, 8->4+4 | 
| **Filler Cell** | If `PgFieldsSection` has an uneven last row, trailing filler cell uses `--pg-bg-surface` so no dead gray/border block shows | 

### 13.12 `PgMonoRef (Click-to-Copy Financial ID)` (`data-pg-mono-ref`)

| Dimension / State | Exact Non-Negotiable Specification | 
| ----- | ----- | 
| **Default Prop** | `copyable: true` by default (restored after `dc.ts` stops stripping `options.props`!) | 
| **Visual Pill** | Inline-flex (`gap: 5px`, `padding: 2px 6px`, `border-radius: 5px`, `font-family: var(--pg-font-mono)`, `font-size: 12.5px`, `cursor: pointer`, `user-select: none`) | 
| **Hover State** | Bg `--pg-bg-surface-hover`, subtle trailing copy icon (`13px`) becomes visible (`opacity: 0.75 -> 1`) | 
| **Copied State** | Copies full untruncated ID via `copyToClipboard()`, swaps icon to emerald checkmark (`--pg-status-success-dot`), fades emerald tint softly over `1600ms`, and restores copy icon | 
| **Click Safety** | Calls `e.stopPropagation()` so clicking an ID in a table row copies the ID instead of navigating/selecting text | 

## PART 14 — COMPLETE 204-PAGE FORENSIC PUNCH LIST ACROSS ALL 4 FRONTENDS

Every single page file across `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front` was scanned automatically against the live `vael-ui-migration` repository. OpenCode MUST sweep **every row below** and eliminate every flagged defect (`STRAY_PAREN`, `LOCAL_CHART`, `RAW_SELECT`, `RAW_CHECKBOX`, `LEGACY_VALERT`, `INLINE_GAP_HACK`, `VAEL_DIRECT`) before closing Wave 4.

### 14.1 `admin-front` (148 Page Files)

| \# | Page Path | Detected Migration Defects | Required Action | 
| ----- | ----- | ----- | ----- | 
| 1 | `admin-front/src/pages/academy/certificate.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 2 | `admin-front/src/pages/academy/exam.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 3 | `admin-front/src/pages/academy/help.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 4 | `admin-front/src/pages/academy/index.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 5 | `admin-front/src/pages/academy/lab.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 6 | `admin-front/src/pages/academy/lesson.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 7 | `admin-front/src/pages/academy/module.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 8 | `admin-front/src/pages/academy/team.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 9 | `admin-front/src/pages/academy/track.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 10 | `admin-front/src/pages/academy/tracks.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 11 | `admin-front/src/pages/adjustments/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 12 | `admin-front/src/pages/aml/cases/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 13 | `admin-front/src/pages/aml/cases/severityInputs.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 14 | `admin-front/src/pages/aml/reporting-studio/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>` | 
| 15 | `admin-front/src/pages/aml/reports/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 16 | `admin-front/src/pages/aml/rules/components/ReportingRulesTab.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 17 | `admin-front/src/pages/aml/rules/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 18 | `admin-front/src/pages/aml/screenings/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 19 | `admin-front/src/pages/aml/screenings/listVersions.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 20 | `admin-front/src/pages/applications/applicationActions.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 21 | `admin-front/src/pages/applications/index.tsx` | `INLINE_GAP_HACK` | Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 22 | `admin-front/src/pages/approvals/approvalHelp.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 23 | `admin-front/src/pages/approvals/components/ApprovalHelpPanel.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 24 | `admin-front/src/pages/approvals/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 25 | `admin-front/src/pages/approvals/types.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 26 | `admin-front/src/pages/audit-logs/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 27 | `admin-front/src/pages/cashouts/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 28 | `admin-front/src/pages/credential-sets/components/EntriesEditor.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 29 | `admin-front/src/pages/credential-sets/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 30 | `admin-front/src/pages/credential-sets/model.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 31 | `admin-front/src/pages/dashboard/__tests__/metricLabels.test.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 32 | `admin-front/src/pages/dashboard/index.tsx` | `STRAY_PAREN`, `LOCAL_CHART`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate to `@pg/ui` `PgChart`/`PgStatChartCard` with explicit height; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 33 | `admin-front/src/pages/dashboard/metricLabels.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 34 | `admin-front/src/pages/disputes/__tests__/queryFilters.test.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 35 | `admin-front/src/pages/disputes/evidenceModel.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 36 | `admin-front/src/pages/disputes/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 37 | `admin-front/src/pages/disputes/queryFilters.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 38 | `admin-front/src/pages/filing-adapters/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 39 | `admin-front/src/pages/finance/invariant/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 40 | `admin-front/src/pages/finance/journal-entries/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 41 | `admin-front/src/pages/finance/liquidity/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 42 | `admin-front/src/pages/finance/liquidity/routeCaps.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 43 | `admin-front/src/pages/finance/pricing/commissionTiers.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 44 | `admin-front/src/pages/finance/pricing/components/CommissionTiersEditor.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 45 | `admin-front/src/pages/finance/pricing/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 46 | `admin-front/src/pages/finance/profitability/index.tsx` | `STRAY_PAREN`, `LOCAL_CHART`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate to `@pg/ui` `PgChart`/`PgStatChartCard` with explicit height; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 47 | `admin-front/src/pages/gateways/ai-import/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 48 | `admin-front/src/pages/gateways/components/GatewayHealthDrawer.tsx` | `LOCAL_CHART` | Migrate to `@pg/ui` `PgChart`/`PgStatChartCard` with explicit height | 
| 49 | `admin-front/src/pages/gateways/healthModel.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 50 | `admin-front/src/pages/gateways/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 51 | `admin-front/src/pages/gateways/wizard/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 52 | `admin-front/src/pages/guide/article.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 53 | `admin-front/src/pages/guide/book.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 54 | `admin-front/src/pages/guide/cards.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 55 | `admin-front/src/pages/guide/edge-cases.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 56 | `admin-front/src/pages/guide/glossary.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 57 | `admin-front/src/pages/guide/index.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 58 | `admin-front/src/pages/guide/playbook.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 59 | `admin-front/src/pages/guide/tools.tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 60 | `admin-front/src/pages/incidents/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 61 | `admin-front/src/pages/join-requests/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 62 | `admin-front/src/pages/join-requests/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 63 | `admin-front/src/pages/join-requests/joinRequestHelp.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 64 | `admin-front/src/pages/join-requests/new.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 65 | `admin-front/src/pages/join-requests/types.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 66 | `admin-front/src/pages/kyb/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 67 | `admin-front/src/pages/kyb/components/KybActionDialog.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 68 | `admin-front/src/pages/kyb/components/KybDocumentPreview.tsx` | `LEGACY_VALERT`, `INLINE_GAP_HACK` | Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 69 | `admin-front/src/pages/kyb/components/KybHelpPanel.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 70 | `admin-front/src/pages/kyb/components/KybReviewDialog.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 71 | `admin-front/src/pages/kyb/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 72 | `admin-front/src/pages/kyb/kybReviewHelp.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 73 | `admin-front/src/pages/kyb/types.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 74 | `admin-front/src/pages/merchants/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 75 | `admin-front/src/pages/merchants/approvalPayload.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 76 | `admin-front/src/pages/merchants/commerceGovernance.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 77 | `admin-front/src/pages/merchants/components/ApplicationDetailDrawer.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 78 | `admin-front/src/pages/merchants/components/ApplicationPolicyModal.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 79 | `admin-front/src/pages/merchants/components/BeneficialOwnersCard.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 80 | `admin-front/src/pages/merchants/components/MerchantAccessCard.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 81 | `admin-front/src/pages/merchants/components/MerchantActionDialog.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 82 | `admin-front/src/pages/merchants/components/MerchantEditDialog.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 83 | `admin-front/src/pages/merchants/components/MerchantHelpPanel.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 84 | `admin-front/src/pages/merchants/components/MerchantResourceTable.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 85 | `admin-front/src/pages/merchants/components/MerchantTransactionDialog.tsx` | `LEGACY_VALERT`, `INLINE_GAP_HACK` | Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 86 | `admin-front/src/pages/merchants/components/ReasonModal.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 87 | `admin-front/src/pages/merchants/components/RevalidationModal.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 88 | `admin-front/src/pages/merchants/components/commerceBits.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 89 | `admin-front/src/pages/merchants/governedRequest.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 90 | `admin-front/src/pages/merchants/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 91 | `admin-front/src/pages/merchants/merchantHelp.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 92 | `admin-front/src/pages/merchants/merchantTableFilters.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 93 | `admin-front/src/pages/merchants/ownerForm.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 94 | `admin-front/src/pages/merchants/revalidation.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 95 | `admin-front/src/pages/merchants/types.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 96 | `admin-front/src/pages/operator-cases/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 97 | `admin-front/src/pages/operator-cases/caseTypes.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 98 | `admin-front/src/pages/operator-cases/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 99 | `admin-front/src/pages/operator-cases/inquiries/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 100 | `admin-front/src/pages/operator-cases/operatorCaseHelp.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 101 | `admin-front/src/pages/operator-cases/types.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 102 | `admin-front/src/pages/public/auth/accept-invitation/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 103 | `admin-front/src/pages/public/auth/forgot-password/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 104 | `admin-front/src/pages/public/auth/login/index.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 105 | `admin-front/src/pages/public/auth/reset-password/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 106 | `admin-front/src/pages/public/not-found/index.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 107 | `admin-front/src/pages/rails/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 108 | `admin-front/src/pages/reconciliation/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 109 | `admin-front/src/pages/reports/catalog/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 110 | `admin-front/src/pages/reports/chrome/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 111 | `admin-front/src/pages/reports/chrome/needs-migration/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 112 | `admin-front/src/pages/reports/merchant-reports/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 113 | `admin-front/src/pages/reports/needs-migration/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 114 | `admin-front/src/pages/reports/studio/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 115 | `admin-front/src/pages/routes/components/RouteHealthDrawer.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 116 | `admin-front/src/pages/routes/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 117 | `admin-front/src/pages/sandbox/fake-rails/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 118 | `admin-front/src/pages/sandbox/merchants/[id].tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 119 | `admin-front/src/pages/sandbox/merchants/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 120 | `admin-front/src/pages/sandbox/overview/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 121 | `admin-front/src/pages/settings/checkout-help/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 122 | `admin-front/src/pages/settings/platform/components/CommunicationTab.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 123 | `admin-front/src/pages/settings/platform/components/NewSettingDrawer.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 124 | `admin-front/src/pages/settings/platform/components/NotificationTemplatesTab.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 125 | `admin-front/src/pages/settings/platform/components/SettingDetailDrawer.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 126 | `admin-front/src/pages/settings/platform/components/SettingRow.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 127 | `admin-front/src/pages/settings/platform/components/SettingsHealthStrip.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 128 | `admin-front/src/pages/settings/platform/components/SettingsSectionNav.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 129 | `admin-front/src/pages/settings/platform/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 130 | `admin-front/src/pages/system/backups/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 131 | `admin-front/src/pages/system/jobs-outbox/components/MonitorTable.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 132 | `admin-front/src/pages/system/jobs-outbox/components/__tests__/MonitorTable.test.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 133 | `admin-front/src/pages/system/jobs-outbox/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 134 | `admin-front/src/pages/system/jobs-outbox/model.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 135 | `admin-front/src/pages/system/object-storage/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 136 | `admin-front/src/pages/transactions/components/InboundEventDrawer.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 137 | `admin-front/src/pages/transactions/components/PayloadRows.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 138 | `admin-front/src/pages/transactions/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 139 | `admin-front/src/pages/transactions/lifecycle.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 140 | `admin-front/src/pages/transactions/payloadRows.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 141 | `admin-front/src/pages/transactions/types.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 142 | `admin-front/src/pages/users/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 143 | `admin-front/src/pages/users/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 144 | `admin-front/src/pages/wallets/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 145 | `admin-front/src/pages/wallets/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 146 | `admin-front/src/pages/wallets/types.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 147 | `admin-front/src/pages/wallets/walletActions.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 148 | `admin-front/src/pages/wallets/walletModel.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 

### 14.2 `merchant-front` (46 Page Files)

| \# | Page Path | Detected Migration Defects | Required Action | 
| ----- | ----- | ----- | ----- | 
| 1 | `merchant-front/src/pages/applications/index.tsx` | `INLINE_GAP_HACK` | Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 2 | `merchant-front/src/pages/cashouts/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 3 | `merchant-front/src/pages/credentials/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 4 | `merchant-front/src/pages/dashboard/index.tsx` | `STRAY_PAREN`, `LOCAL_CHART`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate to `@pg/ui` `PgChart`/`PgStatChartCard` with explicit height; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 5 | `merchant-front/src/pages/developers/tokens/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 6 | `merchant-front/src/pages/developers/webhooks/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 7 | `merchant-front/src/pages/disputes/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 8 | `merchant-front/src/pages/guide/developers/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 9 | `merchant-front/src/pages/guide/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 10 | `merchant-front/src/pages/links/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 11 | `merchant-front/src/pages/onboarding/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 12 | `merchant-front/src/pages/payments/index.tsx` | `INLINE_GAP_HACK` | Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 13 | `merchant-front/src/pages/pos/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 14 | `merchant-front/src/pages/pos/screen/[code].tsx` | `STRAY_PAREN` | Strip `(` `)` inside `<PageHeader>` | 
| 15 | `merchant-front/src/pages/public/auth/forgot-password/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 16 | `merchant-front/src/pages/public/auth/google-finish/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 17 | `merchant-front/src/pages/public/auth/login/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 18 | `merchant-front/src/pages/public/auth/register/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 19 | `merchant-front/src/pages/public/auth/reset-password/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 20 | `merchant-front/src/pages/public/auth/verify-email/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 21 | `merchant-front/src/pages/public/landing/DeveloperSection.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 22 | `merchant-front/src/pages/public/landing/FeePreview.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 23 | `merchant-front/src/pages/public/landing/HeroDemo.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 24 | `merchant-front/src/pages/public/landing/LedgerTicker.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 25 | `merchant-front/src/pages/public/landing/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 26 | `merchant-front/src/pages/public/landing/motion.ts` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 27 | `merchant-front/src/pages/public/not-found/index.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 28 | `merchant-front/src/pages/reports/chrome/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 29 | `merchant-front/src/pages/reports/chrome/needs-migration/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 30 | `merchant-front/src/pages/reports/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 31 | `merchant-front/src/pages/reports/needs-migration/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 32 | `merchant-front/src/pages/reports/studio/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 33 | `merchant-front/src/pages/sandbox/accounts/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 34 | `merchant-front/src/pages/sandbox/applications/[id].tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 35 | `merchant-front/src/pages/sandbox/applications/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 36 | `merchant-front/src/pages/sandbox/links/[id].tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 37 | `merchant-front/src/pages/sandbox/links/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 38 | `merchant-front/src/pages/sandbox/overview/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>` | 
| 39 | `merchant-front/src/pages/sandbox/payments/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>` | 
| 40 | `merchant-front/src/pages/sandbox/payments/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 41 | `merchant-front/src/pages/sandbox/tokens/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 42 | `merchant-front/src/pages/sandbox/wallets/[id].tsx` | `STRAY_PAREN`, `LEGACY_VALERT` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>` | 
| 43 | `merchant-front/src/pages/sandbox/wallets/index.tsx` | `STRAY_PAREN`, `LEGACY_VALERT` | Strip `(` `)` inside `<PageHeader>`; Migrate `<VAlert>` to unified `<PgAlert>` | 
| 44 | `merchant-front/src/pages/statements/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 45 | `merchant-front/src/pages/team/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 
| 46 | `merchant-front/src/pages/wallets/index.tsx` | `STRAY_PAREN`, `INLINE_GAP_HACK` | Strip `(` `)` inside `<PageHeader>`; Use `PgPage`/`PgSection`/`PgStack` spacing policy | 

### 14.3 `checkout-front` (3 Page Files)

| \# | Page Path | Detected Migration Defects | Required Action | 
| ----- | ----- | ----- | ----- | 
| 1 | `checkout-front/src/pages/pay/[linkKey]/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 2 | `checkout-front/src/pages/public/not-found/index.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 
| 3 | `checkout-front/src/pages/public/verify-certificate/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 

### 14.4 `fake-rails-front` (7 Page Files)

| \# | Page Path | Detected Migration Defects | Required Action | 
| ----- | ----- | ----- | ----- | 
| 1 | `fake-rails-front/src/pages/chaos-matrix/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 2 | `fake-rails-front/src/pages/dashboard/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 3 | `fake-rails-front/src/pages/hosted/redirect/[sessionId].tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 4 | `fake-rails-front/src/pages/hosted/widget-frame.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 5 | `fake-rails-front/src/pages/login/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 6 | `fake-rails-front/src/pages/statements/index.tsx` | `LEGACY_VALERT` | Migrate `<VAlert>` to unified `<PgAlert>` | 
| 7 | `fake-rails-front/src/pages/transactions/index.tsx` | Clean syntax — visual QA sweep | Verify Light/Dark, LTR/RTL, focus rings & table row actions | 

**Total Frontend Pages Audited & Tracked:** `204` pages across all 4 portals — zero pages skipped.

### 14.5 Complete Non-Page Component, Layout & Feature Audit (All 210 Non-Page `.tsx` Files)

Beyond the 204 route pages above, the 4 frontends contain **210 non-page `.tsx` files** (layouts, drawers, help/guide palettes, academy modules, checkout payment renderers, and `fake-rails-front` local tables/forms). OpenCode MUST sweep every flagged file below:

#### `admin-front` Non-Page `.tsx` Files (125 Files)

| # | File Path | Audit Findings & Required Action |
| :--- | :--- | :--- |
| 1 | `admin-front/src/App.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 2 | `admin-front/src/charts/EChart/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 3 | `admin-front/src/charts/EChart/lazy.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 4 | `admin-front/src/charts/StatsBarChartCard/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 5 | `admin-front/src/charts/StatsCard/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 6 | `admin-front/src/charts/StatsChartCard/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 7 | `admin-front/src/components/AuditChangeChips.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 8 | `admin-front/src/components/CollapsibleSection/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 9 | `admin-front/src/components/JsonPatchDiff/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 10 | `admin-front/src/components/academy/AcademyShell.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 11 | `admin-front/src/components/academy/BadgeChip.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 12 | `admin-front/src/components/academy/CertificateView.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 13 | `admin-front/src/components/academy/LessonCheck.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 14 | `admin-front/src/components/academy/ModuleList.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 15 | `admin-front/src/components/academy/ProgressRing.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 16 | `admin-front/src/components/academy/ReadingList.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 17 | `admin-front/src/components/academy/TeamTable.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 18 | `admin-front/src/components/academy/TrackCard.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 19 | `admin-front/src/components/academy/exam/ExamBriefing.tsx` | Replace raw checkbox with `<PgCheckbox>` |
| 20 | `admin-front/src/components/academy/exam/ExamResult.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 21 | `admin-front/src/components/academy/exam/ExamRunner.tsx` | Replace raw checkbox with `<PgCheckbox>` |
| 22 | `admin-front/src/components/academy/lab/ChecklistTask.tsx` | Replace raw checkbox with `<PgCheckbox>` |
| 23 | `admin-front/src/components/academy/lab/ChoiceTask.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 24 | `admin-front/src/components/academy/lab/LabResult.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 25 | `admin-front/src/components/academy/lab/LabRunner.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 26 | `admin-front/src/components/academy/lab/LedgerTask.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 27 | `admin-front/src/components/academy/lab/MultiTask.tsx` | Replace raw checkbox with `<PgCheckbox>` |
| 28 | `admin-front/src/components/academy/lab/NumericTask.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 29 | `admin-front/src/components/academy/lab/OrderTask.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 30 | `admin-front/src/components/academy/lab/PanelView.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 31 | `admin-front/src/components/academy/ui/AcademyNav.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 32 | `admin-front/src/components/academy/ui/Callout.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 33 | `admin-front/src/components/academy/ui/IconTile.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 34 | `admin-front/src/components/academy/ui/ProgressBar.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 35 | `admin-front/src/components/academy/ui/StateIcon.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 36 | `admin-front/src/components/builders/AmlParamsBuilder.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 37 | `admin-front/src/components/builders/ChipListInput.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 38 | `admin-front/src/components/builders/CostModelBuilder.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 39 | `admin-front/src/components/builders/KeyValueSummary.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 40 | `admin-front/src/components/builders/LogoAssetPicker.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 41 | `admin-front/src/components/builders/MaintenanceWindowsBuilder.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 42 | `admin-front/src/components/builders/ParserConfigBuilder.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 43 | `admin-front/src/components/builders/PlatformSettingTypedEditor.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 44 | `admin-front/src/components/builders/RepeatableRows.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 45 | `admin-front/src/components/builders/RouteScopeBuilder.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 46 | `admin-front/src/components/builders/SettingValueView.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 47 | `admin-front/src/components/builders/StructuredValueEditor.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 48 | `admin-front/src/components/gateway-wizard/StepBar.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 49 | `admin-front/src/components/gateway-wizard/StepClientAction.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 50 | `admin-front/src/components/gateway-wizard/StepCryptoProfile.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 51 | `admin-front/src/components/gateway-wizard/StepCustomerCatalog.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 52 | `admin-front/src/components/gateway-wizard/StepEnvironments.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 53 | `admin-front/src/components/gateway-wizard/StepFlowBuilder.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 54 | `admin-front/src/components/gateway-wizard/StepIdentity.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 55 | `admin-front/src/components/gateway-wizard/StepSimulator.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 56 | `admin-front/src/components/gateway-wizard/StepStatusRules.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 57 | `admin-front/src/components/gateway-wizard/WizardSection.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 58 | `admin-front/src/components/guide/ArticleToc.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 59 | `admin-front/src/components/guide/BookCard.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 60 | `admin-front/src/components/guide/ContextHelpButton.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 61 | `admin-front/src/components/guide/ContextHelpDrawer.tsx` | **CRITICAL FIX:** Fix route-to-screen mapping (e.g., `/transactions`) + fix `CRITICAL` badge WCAG AA contrast |
| 62 | `admin-front/src/components/guide/ContextualHelpDrawer.tsx` | **CRITICAL FIX:** Fix route-to-screen mapping (e.g., `/transactions`) + fix `CRITICAL` badge WCAG AA contrast |
| 63 | `admin-front/src/components/guide/GlobalGuideSearchModal.tsx` | **CRITICAL FIX:** Stop auto-navigating on typing; fix close `X` padding; Replace inline gap hack with `@pg/ui` spacing policy |
| 64 | `admin-front/src/components/guide/GlossaryPopover.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 65 | `admin-front/src/components/guide/GuideMarkdown.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 66 | `admin-front/src/components/guide/GuideSearchPalette.tsx` | **CRITICAL FIX:** Stop auto-navigating on typing; fix close `X` padding |
| 67 | `admin-front/src/components/guide/MarkdownView.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 68 | `admin-front/src/components/guide/ReadToggle.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 69 | `admin-front/src/components/guide/ReadingPath.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 70 | `admin-front/src/components/guide/ReferencePreviewPopover.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 71 | `admin-front/src/components/guide/SafeguardDialog.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 72 | `admin-front/src/components/guide/StuckPanel.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 73 | `admin-front/src/components/guide/TermTooltip.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 74 | `admin-front/src/components/guide/UiStatusBanner.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 75 | `admin-front/src/components/guide/parts/CryptoSignatureLab.tsx` | Migrate `<VAlert>` to unified `<PgAlert>`; Replace inline gap hack with `@pg/ui` spacing policy |
| 76 | `admin-front/src/components/guide/parts/LedgerTAccountVisualizer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 77 | `admin-front/src/components/guide/parts/TransformPlayground.tsx` | Migrate `<VAlert>` to unified `<PgAlert>`; Replace inline gap hack with `@pg/ui` spacing policy |
| 78 | `admin-front/src/components/guide/widgets/AttemptStateExplorer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 79 | `admin-front/src/components/guide/widgets/CryptoLab.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 80 | `admin-front/src/components/guide/widgets/LedgerExplorer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 81 | `admin-front/src/components/guide/widgets/TransformSandbox.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 82 | `admin-front/src/components/guide/widgets/VisibleRailsExplainer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 83 | `admin-front/src/components/ledger/AccountLinesTable.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 84 | `admin-front/src/components/ledger/GlAccountDrawer.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 85 | `admin-front/src/components/ledger/JournalEntryDrawer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 86 | `admin-front/src/components/ledger/LedgerRefLink.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 87 | `admin-front/src/components/ledger/ShardRepairModal.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 88 | `admin-front/src/components/reports/AuthorityOverrideModal.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 89 | `admin-front/src/components/reports/JsonSpecEditor.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 90 | `admin-front/src/components/reports/ReportDiagnosticsPanel.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 91 | `admin-front/src/components/search/GlobalSearchPalette.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 92 | `admin-front/src/components/search/SearchResultRow.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 93 | `admin-front/src/features/ActionsList/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 94 | `admin-front/src/features/ApiImage/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 95 | `admin-front/src/features/AuthoritiesPicker/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 96 | `admin-front/src/features/CordsInputMap/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 97 | `admin-front/src/features/sandbox/SandboxBanner.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 98 | `admin-front/src/features/sandbox/SandboxResourceTable.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 99 | `admin-front/src/forms/FiltersContainer/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 100 | `admin-front/src/forms/InputFields/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 101 | `admin-front/src/layouts/auth.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 102 | `admin-front/src/layouts/default.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 103 | `admin-front/src/layouts/sections.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 104 | `admin-front/src/lib/reportEngineSdk/components/ReportInputForm.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 105 | `admin-front/src/lib/reportEngineSdk/components/ReportLanguagePromptDialog.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 106 | `admin-front/src/lib/reportEngineSdk/components/ReportPagedPreviewSurface.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 107 | `admin-front/src/lib/reportEngineSdk/components/ReportSandboxedHtmlSurface.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 108 | `admin-front/src/lib/reportEngineSdk/components/ReportVectorDrawRenderer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 109 | `admin-front/src/printables/FieldsSections/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 110 | `admin-front/src/printables/Paragraph/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 111 | `admin-front/src/printables/PrintHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 112 | `admin-front/src/printables/PrintableContainer/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 113 | `admin-front/src/printables/PrintableDataTable/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 114 | `admin-front/src/printables/PrintableField/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 115 | `admin-front/src/printables/PrintableFieldsSections/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 116 | `admin-front/src/printables/PrintableHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 117 | `admin-front/src/printables/PrintableSubHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 118 | `admin-front/src/printables/PrintableThemedView.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 119 | `admin-front/src/tables/DataPage/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 120 | `admin-front/src/tables/DataTable.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 121 | `admin-front/src/uiConfig.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 122 | `admin-front/src/utils/iconSet/icons/Institution.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 123 | `admin-front/src/utils/iconSet/icons/InstitutionAdd.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 124 | `admin-front/src/utils/printJsx/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 125 | `admin-front/src/utils/showDetails/idnex.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |

#### `merchant-front` Non-Page `.tsx` Files (45 Files)

| # | File Path | Audit Findings & Required Action |
| :--- | :--- | :--- |
| 1 | `merchant-front/src/App.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 2 | `merchant-front/src/charts/EChart/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 3 | `merchant-front/src/charts/EChart/lazy.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 4 | `merchant-front/src/charts/StatsBarChartCard/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 5 | `merchant-front/src/charts/StatsCard/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 6 | `merchant-front/src/charts/StatsChartCard/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 7 | `merchant-front/src/components/communication/MaintenanceScreen.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 8 | `merchant-front/src/components/guide/ContextualHelpDrawer.tsx` | **CRITICAL FIX:** Fix route-to-screen mapping (e.g., `/transactions`) + fix `CRITICAL` badge WCAG AA contrast |
| 9 | `merchant-front/src/components/guide/GlobalGuideSearchModal.tsx` | **CRITICAL FIX:** Stop auto-navigating on typing; fix close `X` padding |
| 10 | `merchant-front/src/components/guide/GuideCodeBlock.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 11 | `merchant-front/src/components/guide/GuideMarkdown.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 12 | `merchant-front/src/components/guide/MerchantFeeCalculator.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 13 | `merchant-front/src/features/ActionsList/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 14 | `merchant-front/src/features/ApiImage/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 15 | `merchant-front/src/features/AuthoritiesPicker/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 16 | `merchant-front/src/features/CordsInputMap/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 17 | `merchant-front/src/features/sandbox/SandboxBanner.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 18 | `merchant-front/src/features/sandbox/SandboxResourceTable.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 19 | `merchant-front/src/forms/FiltersContainer/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 20 | `merchant-front/src/forms/InputFields/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 21 | `merchant-front/src/layouts/auth.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 22 | `merchant-front/src/layouts/default.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 23 | `merchant-front/src/layouts/sections.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 24 | `merchant-front/src/lib/reportEngineSdk/components/ReportInputForm.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 25 | `merchant-front/src/lib/reportEngineSdk/components/ReportLanguagePromptDialog.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 26 | `merchant-front/src/lib/reportEngineSdk/components/ReportPagedPreviewSurface.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 27 | `merchant-front/src/lib/reportEngineSdk/components/ReportSandboxedHtmlSurface.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 28 | `merchant-front/src/lib/reportEngineSdk/components/ReportVectorDrawRenderer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 29 | `merchant-front/src/printables/FieldsSections/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 30 | `merchant-front/src/printables/Paragraph/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 31 | `merchant-front/src/printables/PrintHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 32 | `merchant-front/src/printables/PrintableContainer/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 33 | `merchant-front/src/printables/PrintableDataTable/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 34 | `merchant-front/src/printables/PrintableField/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 35 | `merchant-front/src/printables/PrintableFieldsSections/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 36 | `merchant-front/src/printables/PrintableHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 37 | `merchant-front/src/printables/PrintableSubHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 38 | `merchant-front/src/printables/PrintableThemedView.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 39 | `merchant-front/src/tables/DataPage/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 40 | `merchant-front/src/tables/DataTable.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 41 | `merchant-front/src/uiConfig.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 42 | `merchant-front/src/utils/iconSet/icons/Institution.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 43 | `merchant-front/src/utils/iconSet/icons/InstitutionAdd.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 44 | `merchant-front/src/utils/printJsx/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 45 | `merchant-front/src/utils/showDetails/idnex.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |

#### `checkout-front` Non-Page `.tsx` Files (29 Files)

| # | File Path | Audit Findings & Required Action |
| :--- | :--- | :--- |
| 1 | `checkout-front/src/App.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 2 | `checkout-front/src/charts/EChart/index.tsx` | **DELETE after extracting to `@pg/ui` (`PgChart`/`PgStatChartCard`/`PgStatBarChartCard`)** |
| 3 | `checkout-front/src/components/help/CheckoutHelpDrawer.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 4 | `checkout-front/src/components/help/PerRailInstructionsBanner.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 5 | `checkout-front/src/components/rail-cards/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 6 | `checkout-front/src/components/rail-fields/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 7 | `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx` | **Checkout Calm-Trust Density:** Verify spacious padding, clear amount/fee summary, LTR OTP/card inputs, and RTL parity; Migrate `<VAlert>` to unified `<PgAlert>`; Replace inline gap hack with `@pg/ui` spacing policy |
| 8 | `checkout-front/src/components/renderers/OtpFormRenderer.tsx` | **Checkout Calm-Trust Density:** Verify spacious padding, clear amount/fee summary, LTR OTP/card inputs, and RTL parity; Replace inline gap hack with `@pg/ui` spacing policy |
| 9 | `checkout-front/src/components/renderers/PushOrTransferRenderer.tsx` | **Checkout Calm-Trust Density:** Verify spacious padding, clear amount/fee summary, LTR OTP/card inputs, and RTL parity; Migrate `<VAlert>` to unified `<PgAlert>`; Replace inline gap hack with `@pg/ui` spacing policy |
| 10 | `checkout-front/src/components/renderers/QrOrCodeRenderer.tsx` | **Checkout Calm-Trust Density:** Verify spacious padding, clear amount/fee summary, LTR OTP/card inputs, and RTL parity; Migrate `<VAlert>` to unified `<PgAlert>`; Replace inline gap hack with `@pg/ui` spacing policy |
| 11 | `checkout-front/src/components/renderers/RedirectRenderer.tsx` | **Checkout Calm-Trust Density:** Verify spacious padding, clear amount/fee summary, LTR OTP/card inputs, and RTL parity; Migrate `<VAlert>` to unified `<PgAlert>`; Replace inline gap hack with `@pg/ui` spacing policy |
| 12 | `checkout-front/src/features/sandbox/SandboxCheckoutInspector.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 13 | `checkout-front/src/layouts/checkout.tsx` | **Checkout Calm-Trust Density:** Verify spacious padding, clear amount/fee summary, LTR OTP/card inputs, and RTL parity |
| 14 | `checkout-front/src/printables/FieldsSections/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 15 | `checkout-front/src/printables/Paragraph/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 16 | `checkout-front/src/printables/PrintHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 17 | `checkout-front/src/printables/PrintableContainer/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 18 | `checkout-front/src/printables/PrintableDataTable/index.tsx` | Replace inline gap hack with `@pg/ui` spacing policy |
| 19 | `checkout-front/src/printables/PrintableField/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 20 | `checkout-front/src/printables/PrintableFieldsSections/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 21 | `checkout-front/src/printables/PrintableHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 22 | `checkout-front/src/printables/PrintableSubHeader/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 23 | `checkout-front/src/printables/PrintableThemedView.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 24 | `checkout-front/src/tables/DataTable.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 25 | `checkout-front/src/uiConfig.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 26 | `checkout-front/src/utils/iconSet/icons/Institution.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 27 | `checkout-front/src/utils/iconSet/icons/InstitutionAdd.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 28 | `checkout-front/src/utils/printJsx/index.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 29 | `checkout-front/src/utils/showDetails/idnex.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |

#### `fake-rails-front` Non-Page `.tsx` Files (11 Files)

| # | File Path | Audit Findings & Required Action |
| :--- | :--- | :--- |
| 1 | `fake-rails-front/src/App.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 2 | `fake-rails-front/src/components/LiveTransactionFeed.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 3 | `fake-rails-front/src/components/RailChaosCard.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 4 | `fake-rails-front/src/components/WebhookComposerModal.tsx` | Migrate `<VAlert>` to unified `<PgAlert>` |
| 5 | `fake-rails-front/src/components/WireInspectorDrawer.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 6 | `fake-rails-front/src/forms/FiltersContainer/index.tsx` | **REPLACE local duplicated table/form wrapper with `@pg/ui` (`PgTable`/`PgTableFilters`/`PgTextField`)** |
| 7 | `fake-rails-front/src/forms/InputFields/index.tsx` | **REPLACE local duplicated table/form wrapper with `@pg/ui` (`PgTable`/`PgTableFilters`/`PgTextField`)** |
| 8 | `fake-rails-front/src/layouts/hosted.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 9 | `fake-rails-front/src/layouts/portal.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |
| 10 | `fake-rails-front/src/tables/DataTable.tsx` | **REPLACE local duplicated table/form wrapper with `@pg/ui` (`PgTable`/`PgTableFilters`/`PgTextField`)** |
| 11 | `fake-rails-front/src/uiConfig.tsx` | Verify `@pg/ui` imports, Light/Dark 4-step elevation, LTR/RTL & focus rings |

**Total Non-Page Frontend `.tsx` Files Audited:** `210` (Combined Frontend Coverage: `204 pages + 210 non-page files = 414 files`).

## PART 15 — GLOBAL LAYOUT POLICY, MOTION/ACCESSIBILITY RULES & COMPLETE 72-FILE SIGN-OFF LEDGER

### 15.1 Global Spatial Rhythm & Layout Policy (`packages/ui/src/tokens/layout-policy.css`)

Every container across all 4 portals MUST inherit these exact spacing rules from `layout-policy.css` rather than repeating inline styles per page:

| Surface / Container | Desktop (`>=960px`) | Tablet (`600–959px`) | Mobile (`<600px`) | Non-Negotiable Rule | 
| ----- | ----- | ----- | ----- | ----- | 
| `PgAppBar` height | `60px` | `56px` | `56px` | Sticky top, frosted glass blur, `border-bottom: 1px solid var(--pg-border-subtle)` | 
| `PgNavigationDrawer` width | `260px` (`72px` rail) | Overlay `280px` | Overlay `280px` | Flex column with `min-height: 0; overflow-y: auto` nav list above pinned footer | 
| `PgPage` outer gutter | `24px 28px 48px` | `20px 20px 40px` | `16px 16px 36px` | Nested `PgPage` resets padding to `0` automatically | 
| `PgPage` vertical section gap | `24px` | `20px` | `16px` | Consistent breathing room between header, alerts, KPIs, and tables | 
| `PgSection` header-to-body gap | `16px` | `14px` | `12px` | Section title `16px/600` + subtitle `13px --pg-ink-muted` | 
| `PgCard` default body padding | `20px` (`sm: 16px`, `lg: 24px`) | `18px` | `16px` | `border-radius: 12px`, `border: 1px solid var(--pg-border-subtle)` | 
| `PgFormGrid` column & row gap | `16px` | `14px` | `12px` | 12-column grid collapsing cleanly to 1 column below `768px` | 
| `PgDialog` / `PgFormModal` padding | Header `20px 24px 16px`, Body `20px 24px`, Footer `16px 24px` | Same | `16px` all around | Close `X` (`32x32`) in flex end slot — ZERO overlap with title | 
| `PgDrawer` internal padding | Header `20px 24px`, Body `20px 24px`, Footer `16px 24px` | Same | `16px` | Max-width `520px` (`lg: 680px`), `100vw` on mobile | 
| `PgFieldsSection` & `PgMetricStrip` | `gap: 1px` hairline grid, Tile padding `14px 16px` / `16px 20px` | Same | 1–2 col | ZERO floating gaps between boxes; uniform `--pg-bg-surface` tile bg | 
| `PgTable` cell padding | `10px 14px` (header `height: 40px`, row `min-height: 48px`) | `10px 12px` | `8px 10px` | Horizontal scroll strictly inside `.pg-table-scroll` | 
| `PgTableRowActions` button gap | `6px` | `6px` | `6px` | Primary action outlined/text `30px` + `[...]` ghost `30x30` | 

### 15.2 Motion, Transitions & Reduced-Motion Policy

* **Standard Easing:** `cubic-bezier(0.2, 0, 0, 1)` for drawers, dialogs, dropdowns, accordion reveals, and progress fills.
* **Micro-Interaction Duration:** `140ms` for button hover, border focus, checkbox check, and row hover.
* **Overlay Entrance Duration:** `180ms` fade + `4px` vertical slide for popovers/menus; `220ms` for dialogs and drawers.
* **Reduced Motion (`@media (prefers-reduced-motion: reduce)`):** Disables slide/scale transforms, slows spinners to gentle opacity pulse, and renders static subtle skeleton surfaces.

### 15.3 Pure Vue 3.6 Vapor Runtime & Accessibility Invariants

1. **Zero VDOM `<Teleport>`:** Never import `Teleport` from `'vue'` inside `packages/ui/src/`. Every popover, tooltip, dialog, drawer, and context menu renders via pure Vapor `createIf` + `position: fixed` + `z-index` tokens.
2. **Zero Conditional Overlay Reactivity Traps:** Every open/closed overlay surface uses Vapor `createIf` so toggling `open.value` mounts and unmounts DOM nodes deterministically.
3. **Zero Stripped `options.props` in `dc.ts`:** Component default props (`copyable=true` on `PgMonoRef`, `clearable=true`, etc.) resolve reliably and object props NEVER leak into HTML DOM attributes (`[object Object]`).
4. **Full-Container Focus Hue:** Inner `<input>`/`<textarea>` elements NEVER show browser outlines or rogue `.pg-table-filters :focus-visible` boxes; `.pg-control-box:focus-within` owns the border color and `3px` neutral slate ring (`--pg-focus-ring`, zero blue glow).
5. **WCAG AA Contrast Floor (>= 4.5:1):** Every status badge (including `CRITICAL`, `WARNING`, `SETTLED`, `PENDING`), button label, alert body, and dark-mode muted ink passes `>= 4.5:1` contrast.
6. **Strict LTR/RTL Parity:** Default English mode boots with `<html lang='en' dir='ltr'>`; Arabic mode flips cleanly to `<html lang='ar' dir='rtl'>`; financial figures (`PgMoneyText`), OTP boxes (`PgOtpInput`), and JSON code (`PgCodeEditor`) preserve `dir='ltr'` numeric/code integrity.

### 15.4 Complete 72-File `@pg/ui` Forensic Sign-Off Ledger (Every Single File Tracked)

OpenCode MUST inspect, fix, test, and check off **every single file** below (`69` existing files in `packages/ui/src/` + `3` newly abstracted chart files in `packages/ui/src/data/charts/`) before closing this revision:

#### 1. `packages/ui/src/actions/PgButton.tsx`

* **Exports:** `PgButton`, `VBtn`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 2. `packages/ui/src/actions/PgFeedbackAtoms.tsx`

* **Exports:** `PgSpinner`, `PgProgressBar`, `PgDivider`, `VProgressCircular`, `VProgressLinear`, `VDivider`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 3. `packages/ui/src/actions/PgIcon.tsx`

* **Exports:** `PgIcon`, `VIcon`
* **Primary Remediation Focus:** Missing CSS (9)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 4. `packages/ui/src/actions/PgSegmentedTabs.tsx`

* **Exports:** `PgSegmentedTabs`, `SegmentedTabs`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 5. `packages/ui/src/data/PgDescriptionList.tsx`

* **Exports:** `PgDescriptionList`, `DescriptionList`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 6. `packages/ui/src/data/PgField.tsx`

* **Exports:** `PgField`, `Field`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 7. `packages/ui/src/data/PgFieldsSection.tsx`

* **Exports:** `PgFieldsSection`, `FieldsSections`, `PgSectionFields`, `SectionFields`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 8. `packages/ui/src/data/PgFormChecklist.tsx`

* **Exports:** `PgFormChecklist`, `FormChecklist`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 9. `packages/ui/src/data/PgMetaPill.tsx`

* **Exports:** `PgMetaPill`, `MetaPill`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 10. `packages/ui/src/data/PgMetricStrip.tsx`

* **Exports:** `PgMetricStrip`, `MetricStrip`, `PgMiniStats`, `MiniStats`
* **Primary Remediation Focus:** Missing CSS (2)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 11. `packages/ui/src/data/PgMoneyText.tsx`

* **Exports:** `PgMoneyText`, `MoneyDisplay`, `MoneyText`
* **Primary Remediation Focus:** Missing CSS (3)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 12. `packages/ui/src/data/PgMonoRef.tsx`

* **Exports:** `PgMonoRef`, `MonoRef`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 13. `packages/ui/src/data/PgSummaryExportCard.tsx`

* **Exports:** `PgSummaryExportCard`, `SummaryExportCard`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 14. `packages/ui/src/data/json/JsonDiffViewer.tsx`

* **Exports:** `JsonDiffViewer`
* **Primary Remediation Focus:** Missing CSS (9)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 15. `packages/ui/src/data/json/JsonValueCell.tsx`

* **Exports:** `JsonValueCell`
* **Primary Remediation Focus:** Missing CSS (2)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 16. `packages/ui/src/data/json/JsonValueList.tsx`

* **Exports:** `JsonValueList`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 17. `packages/ui/src/data/table/HeaderFooter.tsx`

* **Exports:** `useTableXlsx`, `TableFooter`, `TableHeader`, `PgTableHeader`, `PgTableFooter`
* **Primary Remediation Focus:** Missing CSS (3)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 18. `packages/ui/src/data/table/PgApiTable.tsx`

* **Exports:** `PgApiTable`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 19. `packages/ui/src/data/table/Table.tsx`

* **Exports:** `Table`, `PgTable`
* **Primary Remediation Focus:** Missing CSS (2)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 20. `packages/ui/src/data/table/TableFilters.tsx`

* **Exports:** `tableFilterSurfaceKey`, `createTableFilterSurface`, `PgTableFilters`
* **Primary Remediation Focus:** Missing CSS (1); Add Vapor `createIf`
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 21. `packages/ui/src/data/table/TableRowActions.tsx`

* **Exports:** `PgTableRowActions`, `TableRowActions`
* **Primary Remediation Focus:** Missing CSS (6); VDOM Teleport -> Pure Vapor; Add Vapor `createIf`
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 22. `packages/ui/src/feedback/PgAlert.tsx`

* **Exports:** `PgAlert`, `VAlert`, `AlertView`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 23. `packages/ui/src/feedback/PgEmptyState.tsx`

* **Exports:** `PgEmptyState`, `EmptyState`, `PgSkeleton`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 24. `packages/ui/src/feedback/PgStateView.tsx`

* **Exports:** `PgStateView`, `StateView`, `PgLoadingScreen`, `LoadingScreen`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 25. `packages/ui/src/feedback/PgStatusBadge.tsx`

* **Exports:** `PgStatusBadge`, `StatusBadge`, `StatusChip`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 26. `packages/ui/src/feedback/PgToast.tsx`

* **Exports:** `PgToaster`, `PgToast`, `Toaster`
* **Primary Remediation Focus:** Missing CSS (3)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 27. `packages/ui/src/inputs/PgApiAutocomplete.tsx`

* **Exports:** `PgApiAutocomplete`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 28. `packages/ui/src/inputs/PgAutocomplete.tsx`

* **Exports:** `PgAutocomplete`, `VSelect`, `VAutocomplete`, `VCombobox`
* **Primary Remediation Focus:** Missing CSS (4); Add Vapor `createIf`
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 29. `packages/ui/src/inputs/PgCheckbox.tsx`

* **Exports:** `PgCheckbox`, `VCheckbox`
* **Primary Remediation Focus:** Missing CSS (1); Replace `vael-ui` wrapper
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 30. `packages/ui/src/inputs/PgChoice.tsx`

* **Exports:** `PgChoice`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 31. `packages/ui/src/inputs/PgCodeEditor.tsx`

* **Exports:** `PgCodeEditor`
* **Primary Remediation Focus:** Missing CSS (6)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 32. `packages/ui/src/inputs/PgDateInput.tsx`

* **Exports:** `PgDateInput`, `PgDateRangeInput`, `VDateInput`
* **Primary Remediation Focus:** Missing CSS (1); Add Vapor `createIf`
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 33. `packages/ui/src/inputs/PgFieldShell.tsx`

* **Exports:** `PgFieldShell`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 34. `packages/ui/src/inputs/PgFileUpload.tsx`

* **Exports:** `PgFileUpload`, `VFileInput`
* **Primary Remediation Focus:** Replace `vael-ui` wrapper
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 35. `packages/ui/src/inputs/PgFormField.tsx`

* **Exports:** `PgFormField`, `FormField`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 36. `packages/ui/src/inputs/PgOtpInput.tsx`

* **Exports:** `PgOtpInput`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 37. `packages/ui/src/inputs/PgSearchInput.tsx`

* **Exports:** `PgSearchInput`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 38. `packages/ui/src/inputs/PgTextField.tsx`

* **Exports:** `PgTextField`, `VTextField`
* **Primary Remediation Focus:** Missing CSS (3)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 39. `packages/ui/src/inputs/PgTextarea.tsx`

* **Exports:** `PgTextarea`, `VTextarea`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 40. `packages/ui/src/inputs/PgToggle.tsx`

* **Exports:** `PgSwitch`, `PgRadioGroup`, `PgRadio`, `VSwitch`, `VRadioGroup`, `VRadio`
* **Primary Remediation Focus:** Replace `vael-ui` wrapper
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 41. `packages/ui/src/layout/PgLayout.tsx`

* **Exports:** `PgPage`, `ScreenContainer`, `PgStack`, `PgCenter`, `CenterView`, `PgFormGrid`
* **Primary Remediation Focus:** Missing CSS (4)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 42. `packages/ui/src/layout/PgPageHeader.tsx`

* **Exports:** `PgPageHeader`, `PageHeader`, `PgSubHeader`, `SubHeader`, `PgText`, `ThemedText`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 43. `packages/ui/src/layout/PgShellPrimitives.tsx`

* **Exports:** `PgApp`, `VApp`, `PgAppBar`, `VAppBar`, `PgAppBarTitle`, `VAppBarTitle`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 44. `packages/ui/src/overlays/PgCommandPalette.tsx`

* **Exports:** `PgCommandPalette`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 45. `packages/ui/src/overlays/PgDetailsDialog.tsx`

* **Exports:** `PgDetailsDialog`, `DetailsFieldsDialog`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 46. `packages/ui/src/overlays/PgDialog.tsx`

* **Exports:** `PgDialog`, `VDialog`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 47. `packages/ui/src/overlays/PgDrawer.tsx`

* **Exports:** `PgDrawer`, `SlideOverDrawer`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 48. `packages/ui/src/overlays/PgFormModal.tsx`

* **Exports:** `PgFormModal`, `FormModal`, `PgConfirmDialog`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 49. `packages/ui/src/overlays/PgMenu.tsx`

* **Exports:** `PgMenu`, `VMenu`
* **Primary Remediation Focus:** Missing CSS (2); Add Vapor `createIf`
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 50. `packages/ui/src/overlays/PgTooltip.tsx`

* **Exports:** `PgTooltip`, `VTooltip`
* **Primary Remediation Focus:** Missing CSS (1); Add Vapor `createIf`
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 51. `packages/ui/src/patterns/PgThemeControls.tsx`

* **Exports:** `PgThemeMenu`, `ThemeMenu`, `PgThemeLanguageControls`, `ThemeAndLanguageControls`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 52. `packages/ui/src/provider/PgProvider.tsx`

* **Exports:** `PgProvider`
* **Primary Remediation Focus:** Replace `vael-ui` wrapper
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 53. `packages/ui/src/data/json/jsonDiffModel.ts`

* **Exports:** `humanizeKey`, `parsePath`, `toPointer`, `humanizeSegment`, `humanizeSegments`, `humanizePath`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 54. `packages/ui/src/data/table/filters.ts`

* **Exports:** `isFilterActive`, `filterToQuery`, `buildFilterQuery`, `activeFilterCount`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 55. `packages/ui/src/data/table/statusTone.ts`

* **Exports:** `statusTone`, `rowTone`, `criticalRowTone`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 56. `packages/ui/src/data/table/types.ts`

* **Exports:** `defaultNumberOfItemsPerPageChoices`, `defaultNumberOfItemsPerPageChoicesWithAll`, `readCell`, `sortRowsByHeader`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 57. `packages/ui/src/feedback/toastStore.ts`

* **Exports:** `dismissToast`, `pauseToast`, `resumeToast`, `showToast`, `useToasts`, `clearToasts`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 58. `packages/ui/src/lib/config.ts`

* **Exports:** `providePgUiConfig`, `usePgUiConfig`
* **Primary Remediation Focus:** Missing CSS (1)
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 59. `packages/ui/src/lib/date.ts`

* **Exports:** `toIsoDate`, `fromIsoDate`, `startOfDay`, `sameDay`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 60. `packages/ui/src/lib/dc.ts`

* **Exports:** `defineComponent`, `defineComponent`, `defineComponent`, `dc`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 61. `packages/ui/src/lib/display.ts`

* **Exports:** `useRtl`, `useDisplay`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 62. `packages/ui/src/lib/dom.ts`

* **Exports:** `isBrowser`, `useClickOutside`, `useEscape`, `lockBodyScroll`, `useFocusTrap`, `copyToClipboard`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 63. `packages/ui/src/lib/locale.ts`

* **Exports:** `useLocale`, `t`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 64. `packages/ui/src/lib/money.ts`

* **Exports:** `CURRENCY_PRECISION`, `DEFAULT_CURRENCY`, `currencyPrecision`, `toDecimal`, `formatMoney`, `formatPlainNumber`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 65. `packages/ui/src/lib/options.ts`

* **Exports:** `normalizeOptions`, `sameValue`, `normalizeSize`, `controlSize`, `iconName`, `pick`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 66. `packages/ui/src/lib/rules.ts`

* **Exports:** `isEmpty`, `runRules`, `visibleError`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 67. `packages/ui/src/lib/status.ts`

* **Exports:** `formatHumanStatus`, `statusToTone`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 68. `packages/ui/src/lib/theme.ts`

* **Exports:** `THEME_STORAGE_KEY`, `DARK_MEDIA_QUERY`, `isThemeMode`, `readThemeMode`, `systemPrefersDark`, `resolveTheme`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 69. `packages/ui/src/testing/governanceAudit.ts`

* **Exports:** `GOVERNANCE_RULES`, `CONTAINER_TAGS`, `scanSource`, `auditUiSources`, `findDuplicatedComponentDirs`, `findLegacyStylesheets`
* **Primary Remediation Focus:** Audit against blueprint, Light/Dark, LTR/RTL & unit tests
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 70. `packages/ui/src/data/charts/PgChart.tsx`

* **Exports:** `PgChart`
* **Primary Remediation Focus:** NEW — Extract from frontends + explicit height
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 71. `packages/ui/src/data/charts/PgStatChartCard.tsx`

* **Exports:** `PgStatChartCard`
* **Primary Remediation Focus:** NEW — Extract from frontends + explicit height
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)

#### 72. `packages/ui/src/data/charts/PgStatBarChartCard.tsx`

* **Exports:** `PgStatBarChartCard`
* **Primary Remediation Focus:** NEW — Extract from frontends + explicit height
- [ ] Visual Blueprint Verified (padding, gap, border, radius, typography, Light & Dark mode, LTR & RTL)
- [ ] Functional Blueprint Verified (all props, defaults, clicks, keyboard shortcuts, ARIA, edge cases)
- [ ] Automated Vitest / Playwright Assertions Passing (`0` warnings, `0` missing CSS classes)
