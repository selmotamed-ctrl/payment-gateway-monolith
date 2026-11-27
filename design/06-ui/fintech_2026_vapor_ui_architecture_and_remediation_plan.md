# Payment Gateway — 2026 Fintech Vapor-Valid Shared UI Architecture (`@pg/ui`) & Complete Remediation Plan

**Target Branch:** `payment-gateway-monolith-vael-ui-migration` (Vue `3.6.0-rc.16` Vapor Mode + `vue-jsx({ vapor: true })` + `vael-ui/vapor` + `vael-form`)

**Reference Baseline:** `payment-gateway-monolith-master (3).zip`

**Audience:** Coding Agent (`OpenCode`) & Engineering Team — Single-File, Zero-Ambiguity Architectural & Implementation Blueprint

**Goal:** Eliminate every broken shim, native HTML fallback, layout/padding bug, and 4x component duplication across `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front`; establish a **single shared monorepo UI package (`packages/ui` → `@pg/ui`)** with a spacious, modern **2026 Fintech Design System**; and enforce automated governance gates so no human or AI agent can ever reintroduce UI slop.

## 1. Forensic Root-Cause Autopsy: Why `vael-ui-migration` Broke

A full codebase audit comparing `payment-gateway-monolith-master` against `payment-gateway-monolith-vael-ui-migration` reveals that the regressions are **not random page bugs**—they are caused by **six systemic architectural failures**:

| \# | Broken Symptom Observed | Exact Root Cause in `vael-ui-migration` | Affected Locations | 
| ----- | ----- | ----- | ----- | 
| **1** | **Dropdowns / Autocomplete / Combobox / Multi-Select** look like ugly native HTML `<select>` and `<select multiple>` scrollable boxes | `VuetifyShim.tsx` (lines 303–382) imported `Select` & `Combobox` from `vael-ui/vapor` at the top of the file—and **never used them**. Instead, `VSelect`, `VAutocomplete`, and `VCombobox` all render a raw `<select class="pg-select v-field" multiple={Boolean(attrs.multiple)}>`, and `vael-shim.css` (lines 233–237) hardcodes `.pg-select[multiple] { height: 34px; }`! | Copy-pasted in `admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front` (`src/components/vael/VuetifyShim.tsx`) | 
| **2** | **Date Input** is ugly and lacks Vuetify `VDateInput` look & features | `VuetifyShim.tsx` (lines 538–550) imported `DatePicker` from `vael-ui/vapor` and **never used it**—rendering a bare `<input type="date" class="pg-input v-field" />` without even wrapping it in `fieldWrap` (dropping label, hint, clear button, calendar popover, and range selection). | `VuetifyShim.tsx` L538–550 + `DateInput/index.tsx` across all 4 frontends | 
| **3** | **Checkbox** looks outdated (2012 browser checkbox) | `VuetifyShim.tsx` (lines 385–426) imported `Checkbox` from `vael-ui/vapor` and **never used it**—rendering `<input type="checkbox" style="width: 16px; height: 16px" />`. | `VuetifyShim.tsx` L385–426 + `Checkbox/index.ts` across all 4 frontends | 
| **4** | **Text Fields & Table Search Input** look terrible and have an ugly blue focus glow | `VuetifyShim.tsx` (lines 245–254) renders a bare `<input class="pg-input v-field" />`, silently dropping `label`, `hint`, `error`, `prependInnerIcon`, `appendInnerIcon`, `clearable`, `prefix`, `suffix`, and `rules`. `vael-shim.css` (lines 227–231) applies `border-color: var(--pg-border-focus)` (`#2563eb`) + `box-shadow: 0 0 0 2px var(--pg-accent-interactive-soft)` (the blue glow). | `VuetifyShim.tsx` L245–254, `TextField/index.tsx`, `Table/Table.tsx`, `Table/TableFilters.tsx` | 
| **5** | **Snackbar** has a broken/missing close behavior and **never disappears with time** | `VuetifyShim.tsx` (lines 677–710) wraps `<Message>` in a fixed `div`, completely **ignoring `attrs.timeout` (`timeout={6e3}`)** (zero timer!) and **ignoring `slots.actions`**—even though `VaelProvider.tsx` already mounts `<Toaster />`! | `VuetifyShim.tsx` L677–710 + `SnackBar/index.tsx` across all 4 frontends | 
| **6** | **Fragmented Alerts** (Sandbox banner looks great; other alerts look uncolored/broken) | Three competing alert systems exist: `SandboxBanner.tsx` (hand-styled with `--pg-status-warning-*` tokens), `AlertView/index.tsx` (hex-alpha hack `backgroundColor + "22"`), and `VAlert` (wraps `vael-ui` `<Message>` whose `--ui-*` tokens do not map `--pg-status-*-bg`/`border`/`text`). | `SandboxBanner.tsx`, `AlertView/index.tsx`, `VuetifyShim.tsx` L210–243 | 
| **7** | **KPI Stat Boxes / Metric Strip** have broken gray background gaps or invisible values | `MetricStrip.tsx` (lines 29–38) uses `gap: "1px"; backgroundColor: "var(--pg-border-subtle)"` on an `auto-fit` grid—when items wrap to a second row with fewer columns, the empty trailing grid cells expose a giant gray rectangle! Meanwhile `PageStats/index.tsx` (lines 77–79) sets `-webkit-text-fill-color: transparent` with no gradient background! | `components/ui/MetricStrip.tsx`, `components/PageStats/index.tsx`, `components/MiniStats/index.tsx` | 
| **8** | **Dialogs & Guide Search Palette** lack padding and the `×` close button overlaps content | `VDialog` (lines 640–660) passes `showClose={!attrs.persistent}` to `<Dialog>`, which positions `×` at top-right even when `title` is omitted (as in `GuideSearchPalette.tsx` L232–264), causing `×` to collide directly with the search input and `ESC` badge. | `VuetifyShim.tsx` L640–660, `GuideSearchPalette.tsx`, `GlobalSearchPalette.tsx`, `FormModal.tsx` | 
| **9** | **4x Copy-Paste Duplication & Drift** | Zero shared UI package exists: `admin-front` (230 component files), `merchant-front` (93), `checkout-front` (81), and `fake-rails-front` (38) each duplicate `VuetifyShim.tsx`, `Table/`, `Card/`, `Field/`, `fintech-minimal.css` (already drifted: 35 KB vs 33 KB vs 30 KB vs 29 KB), and `vael-shim.css`. | All 4 Vapor frontends | 

## 2. Target Architecture: Single Shared Monorepo Package (`packages/ui` → `@pg/ui`)

### 2.1 Zero-Duplication Monorepo Workspace Setup

Create a root workspace configuration so **every frontend consumes one single source of truth (`@pg/ui`)**. No UI primitive, CSS token file, or layout container may ever be duplicated in `admin-front`, `merchant-front`, `checkout-front`, or `fake-rails-front`.

```
payment-gateway-monolith/
├── package.json                          # Add "workspaces": ["packages/*"] (or Bun workspace)
├── packages/
│   └── ui/                               # Package name: "@pg/ui" (100% Vue 3.6 Vapor-valid TSX)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                  # Public barrel export (ONLY blessed components & composables)
│           ├── tokens/
│           │   ├── fintech-2026.css      # Semantic color, typography, radius, elevation, dark/light & RTL tokens
│           │   ├── layout-policy.css     # Global non-overridable spacing/padding/gap rules for containers
│           │   └── components.css        # Base styles for all @pg/ui primitives
│           ├── layout/
│           │   ├── PgAppShell.tsx        # App shell (top bar, sidebar drawer, main scroll canvas)
│           │   ├── PgPage.tsx            # Enforces page max-width, desktop/mobile padding & vertical rhythm
│           │   ├── PgSection.tsx         # Standard section header + collapsible support + gap policy
│           │   ├── PgCard.tsx            # Unified card with header/body/footer padding policy
│           │   ├── PgFormGrid.tsx        # 1/2/3-column responsive form layout with guaranteed 20px gaps
│           │   └── PgDivider.tsx
│           ├── inputs/
│           │   ├── PgFieldShell.tsx      # Shared label, required mark, hint, error, helper slot wrapper
│           │   ├── PgTextField.tsx       # Built-from-scratch 2026 input (NO blue glow, icons, prefix/suffix, clear)
│           │   ├── PgTextarea.tsx        # Auto-grow textarea sharing PgFieldShell & focus styling
│           │   ├── PgSearchInput.tsx     # Dedicated table & toolbar search input (leading icon, clear, ⌘K hint)
│           │   ├── PgAutocomplete.tsx    # Built-from-scratch Vapor WAI-ARIA Combobox/Autocomplete (Single + Multi Chips)
│           │   ├── PgApiAutocomplete.tsx # Async debounced server-search wrapper over PgAutocomplete
│           │   ├── PgDateInput.tsx       # Built-from-scratch Vapor VDateInput (calendar popover + typed entry + presets)
│           │   ├── PgDateRangeInput.tsx  # Dual-month range picker with fintech presets (7D, 30D, MTD, QTD)
│           │   ├── PgCheckbox.tsx        # Built-from-scratch 2026 animated checkbox + indeterminate + Card-Row variant
│           │   ├── PgSwitch.tsx          # Tactile 2026 toggle switch
│           │   ├── PgRadioGroup.tsx      # Standard + Segmented Card radio options
│           │   └── PgFileUpload.tsx      # Drag-and-drop file dropzone with file preview & progress
│           ├── feedback/
│           │   ├── PgAlert.tsx           # Single unified alert & banner (replaces SandboxBanner, AlertView, VAlert)
│           │   ├── PgToast.tsx           # Auto-dismissing floating toast stack with progress bar & pause-on-hover
│           │   ├── toastStore.ts         # Global reactive useToast() / showToast() API
│           │   ├── PgStatusBadge.tsx     # Semantic pill with optional dot & tabular alignment
│           │   ├── PgEmptyState.tsx      # Calm empty state with icon, title, guidance, and CTA slot
│           │   └── PgSkeleton.tsx        # Shimmer skeleton blocks for cards, tables, and KPI strips
│           ├── overlays/
│           │   ├── PgDialog.tsx          # 3-zone header/body/footer modal (close button NEVER overlaps content)
│           │   ├── PgConfirmDialog.tsx   # Standard & Destructive confirmation modal with safeguard checklist slot
│           │   ├── PgDrawer.tsx          # Slide-over inspector drawer (sm/md/lg/xl) with fixed header & footer
│           │   ├── PgCommandPalette.tsx  # Dedicated bare command/search palette (for Guide & Global Search)
│           │   ├── PgPopover.tsx         # Viewport-aware floating panel (Teleport + auto-flip + click-outside)
│           │   ├── PgMenu.tsx            # Keyboard-navigable action dropdown menu
│           │   └── PgTooltip.tsx         # Delayed hover/focus tooltip
│           ├── data/
│           │   ├── PgMetricStrip.tsx     # Zero-gap seamless hairline KPI bento grid (NO exposed gray cells!)
│           │   ├── PgFieldsSection.tsx   # Spacious key-value detail grid with copy-on-click & hints
│           │   ├── PgTable.tsx           # Spacious 2026 data table (48px rows, sticky header, PgSearchInput toolbar)
│           │   ├── PgTableFilters.tsx    # Unified filter bar using PgAutocomplete & PgDateRangeInput
│           │   ├── PgMoneyText.tsx       # Strict 3-decimal tabular-nums currency display (125.000 LYD)
│           │   └── PgMonoRef.tsx         # Monospace reference chip with 1-click copy
│           ├── actions/
│           │   ├── PgButton.tsx          # Primary, Secondary, Ghost, Danger, Soft, Icon-Only + loading spinner
│           │   ├── PgSegmentedTabs.tsx   # Pill-track sliding tab switcher
│           │   └── PgIcon.tsx            # Thin wrapper over @mdi/js SVG paths
│           └── testing/
│               └── governanceAudit.ts    # Automated AST/regex scanner enforcing @pg/ui compliance in CI

```

### 2.2 Vite & TypeScript Resolution in All 4 Frontends

In each frontend's `vite.config.ts` (`admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front`), add the `@pg/ui` alias so Vite compiles `@pg/ui` directly through `vueJsx({ vapor: true })` with zero extra build step:

```
resolve: {
  alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "@pg/ui": fileURLToPath(new URL("../packages/ui/src", import.meta.url)),
  },
}

```

And in each frontend's `tsconfig.json`:

```
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@pg/ui": ["../packages/ui/src/index.ts"],
      "@pg/ui/*": ["../packages/ui/src/*"]
    }
  }
}

```

## 3. The 2026 Fintech Design System Policy ("Calm Precision")

Inspired by the best of **Mercury** (breathable, uncrowded whitespace), **Stripe** (tabular financial clarity and scannable hierarchy), and **Linear** (crisp 1px hairlines, refined neutral focus rings, effortless keyboard UX), this design policy upgrades the platform from "compact utility" to **modern 2026 enterprise fintech**.

### 3.1 Core Visual & Interaction Rules (Non-Negotiable)

1. **Less Compact, More Breathable Spacing Policy:**

   * **Page Canvas Padding:** `28px 36px 56px` on desktop (`>= 1024px`), `20px 16px 40px` on mobile. Max content width `1480px` centered.

   * **Section Vertical Rhythm:** `28px` gap between major page sections (`PgPage` enforces `display: flex; flex-direction: column; gap: var(--pg-space-section)`).

   * **Card Padding:** `24px` body padding (`20px 24px` header, `16px 24px` footer) — never `12px` or `0px`.

   * **Dialog & Drawer Padding:** `20px 24px` header, `24px` body (`gap: 20px` between form rows), `16px 24px` footer.

   * **Form Control Height:** `40px` (`--pg-control-h-md`) default for all text fields, autocompletes, and date inputs (`36px` only for dense table toolbar filters) — up from the cramped `34px`.

   * **Table Row Height:** `48px` comfortable data rows (`14px 16px` cell padding), `42px` sticky table header with `11.5px` uppercase tracked labels.

2. **NO UGLY BLUE GLOW ON INPUTS:**

   * Every input (`PgTextField`, `PgSearchInput`, `PgAutocomplete`, `PgDateInput`, `PgTextarea`) uses a **refined neutral obsidian focus border** (`#0f172a` in Light Mode, `#f4f4f5` in Dark Mode) with a soft **neutral 3px halo** (`rgba(15, 23, 42, 0.08)` in Light / `rgba(244, 244, 245, 0.10)` in Dark).

   * Colored focus rings are reserved **exclusively** for validation error (`--pg-status-danger-dot`) so errors pop unmistakably.

3. **Typography & Financial Numerals:**

   * LTR UI font: `"Plus Jakarta Sans"`, RTL Arabic font: `"Cairo"`, Financial/Ref font: `"JetBrains Mono"`.

   * Every balance, fee, count, KPI metric, and table currency cell enforces `font-variant-numeric: tabular-nums lining-nums`.

4. **Pure Vue 3.6 Vapor Mode Safety Rules:**

   * All `@pg/ui` components use `defineComponent` / `dc` with reactive getters inside the render closure (`return () => (...)`), zero reliance on `getCurrentInstance().proxy`, zero Options API, and explicit `stopPropagation` awareness (remembering Vue 3.6 Vapor delegates eligible events at the document level — never call `e.stopPropagation()` on a container that wraps Vapor-delegated child click handlers without testing!).

   * All floating overlays (`PgAutocomplete` dropdown, `PgDateInput` calendar, `PgMenu`, `PgTooltip`) render via `<Teleport to="body">` with dynamic `getBoundingClientRect()` viewport auto-flip (flips upward if `< 260px` below) and `ResizeObserver` / scroll repositioning, so dropdowns are **never clipped by `overflow: hidden` inside cards, tables, or dialogs**.

### 3.2 Complete Master Design Tokens (`packages/ui/src/tokens/fintech-2026.css`)

```
/* packages/ui/src/tokens/fintech-2026.css */
:root {
  /* === Surfaces (Calm Layered Hierarchy) === */
  --pg-bg-canvas: #f7f8fa;
  --pg-bg-surface: #ffffff;
  --pg-bg-surface-subtle: #f3f4f6;
  --pg-bg-surface-hover: #f9fafb;
  --pg-bg-surface-active: #f1f5f9;
  --pg-bg-elevated: #ffffff;
  --pg-bg-overlay: rgba(15, 23, 42, 0.48);

  /* === Ink (WCAG AA+ Contrast) === */
  --pg-ink-primary: #0f172a;
  --pg-ink-secondary: #475569;
  --pg-ink-muted: #64748b;
  --pg-ink-faint: #94a3b8;
  --pg-ink-on-accent: #ffffff;

  /* === Hairline Borders & Neutral Focus (NO Blue Glow!) === */
  --pg-border-subtle: #e5e7eb;
  --pg-border-default: #d1d5db;
  --pg-border-strong: #9ca3af;
  --pg-border-focus: #0f172a;
  --pg-focus-ring: 0 0 0 3px rgba(15, 23, 42, 0.08);
  --pg-focus-ring-danger: 0 0 0 3px rgba(220, 38, 38, 0.14);

  /* === Brand & Primary Action Accents === */
  --pg-accent-primary: #0f172a;
  --pg-accent-primary-hover: #1e293b;
  --pg-accent-brand: #4f46e5;
  --pg-accent-brand-hover: #4338ca;
  --pg-accent-brand-soft: rgba(79, 70, 229, 0.08);

  /* === Unified Semantic Status Tokens (Used by PgAlert, PgToast, PgStatusBadge) === */
  --pg-status-success-bg: #f0fdf4;
  --pg-status-success-text: #166534;
  --pg-status-success-border: #bbf7d0;
  --pg-status-success-dot: #16a34a;

  --pg-status-warning-bg: #fffbeb;
  --pg-status-warning-text: #92400e;
  --pg-status-warning-border: #fde68a;
  --pg-status-warning-dot: #d97706;

  --pg-status-danger-bg: #fef2f2;
  --pg-status-danger-text: #991b1b;
  --pg-status-danger-border: #fecaca;
  --pg-status-danger-dot: #dc2626;

  --pg-status-info-bg: #eff6ff;
  --pg-status-info-text: #1e40af;
  --pg-status-info-border: #bfdbfe;
  --pg-status-info-dot: #2563eb;

  --pg-status-neutral-bg: #f3f4f6;
  --pg-status-neutral-text: #374151;
  --pg-status-neutral-border: #e5e7eb;
  --pg-status-neutral-dot: #6b7280;

  /* === Radii === */
  --pg-radius-xs: 6px;
  --pg-radius-sm: 8px;
  --pg-radius-md: 12px;
  --pg-radius-lg: 16px;
  --pg-radius-pill: 9999px;

  /* === Shadows (Soft, Layered, Zero Harshness) === */
  --pg-shadow-xs: 0 1px 2px rgba(15, 23, 42, 0.04);
  --pg-shadow-sm: 0 2px 6px -1px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.03);
  --pg-shadow-popover: 0 12px 32px -8px rgba(15, 23, 42, 0.16), 0 4px 12px -4px rgba(15, 23, 42, 0.08);
  --pg-shadow-modal: 0 24px 48px -12px rgba(15, 23, 42, 0.22), 0 8px 20px -8px rgba(15, 23, 42, 0.10);

  /* === Spacious 2026 Layout & Container Spacing Policy === */
  --pg-space-page-desktop: 28px 36px 56px 36px;
  --pg-space-page-mobile: 20px 16px 40px 16px;
  --pg-space-section: 28px;
  --pg-space-card-pad: 24px;
  --pg-space-card-header: 18px 24px;
  --pg-space-card-footer: 14px 24px;
  --pg-space-dialog-header: 20px 24px;
  --pg-space-dialog-body: 24px;
  --pg-space-dialog-footer: 16px 24px;
  --pg-space-form-gap: 20px;
  --pg-space-inline-gap: 12px;
  --pg-control-h-sm: 36px;
  --pg-control-h-md: 40px;
  --pg-control-h-lg: 44px;

  /* === Typography === */
  --pg-font-sans-ltr: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --pg-font-sans-rtl: "Cairo", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --pg-font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  /* === Z-Index Scale === */
  --pg-z-sticky: 20;
  --pg-z-header: 30;
  --pg-z-drawer: 40;
  --pg-z-modal: 1000;
  --pg-z-popover: 1200;
  --pg-z-tooltip: 1300;
  --pg-z-toast: 1500;
}

[data-theme="dark"], .v-theme--dark {
  --pg-bg-canvas: #09090b;
  --pg-bg-surface: #111114;
  --pg-bg-surface-subtle: #18181d;
  --pg-bg-surface-hover: #1e1e24;
  --pg-bg-surface-active: #27272f;
  --pg-bg-elevated: #16161b;
  --pg-bg-overlay: rgba(0, 0, 0, 0.72);

  --pg-ink-primary: #f4f4f5;
  --pg-ink-secondary: #a1a1aa;
  --pg-ink-muted: #71717a;
  --pg-ink-faint: #52525b;
  --pg-ink-on-accent: #09090b;

  --pg-border-subtle: #242429;
  --pg-border-default: #32323a;
  --pg-border-strong: #464652;
  --pg-border-focus: #e4e4e7;
  --pg-focus-ring: 0 0 0 3px rgba(244, 244, 245, 0.12);
  --pg-focus-ring-danger: 0 0 0 3px rgba(248, 113, 113, 0.18);

  --pg-accent-primary: #f4f4f5;
  --pg-accent-primary-hover: #ffffff;
  --pg-accent-brand: #6366f1;
  --pg-accent-brand-hover: #818cf8;
  --pg-accent-brand-soft: rgba(99, 102, 241, 0.16);

  --pg-status-success-bg: rgba(22, 163, 74, 0.14);
  --pg-status-success-text: #4ade80;
  --pg-status-success-border: rgba(74, 222, 128, 0.28);
  --pg-status-success-dot: #22c55e;

  --pg-status-warning-bg: rgba(217, 119, 6, 0.14);
  --pg-status-warning-text: #fbbf24;
  --pg-status-warning-border: rgba(251, 191, 36, 0.28);
  --pg-status-warning-dot: #f59e0b;

  --pg-status-danger-bg: rgba(220, 38, 38, 0.14);
  --pg-status-danger-text: #f87171;
  --pg-status-danger-border: rgba(248, 113, 113, 0.28);
  --pg-status-danger-dot: #ef4444;

  --pg-status-info-bg: rgba(37, 99, 235, 0.16);
  --pg-status-info-text: #60a5fa;
  --pg-status-info-border: rgba(96, 165, 250, 0.28);
  --pg-status-info-dot: #3b82f6;

  --pg-status-neutral-bg: rgba(161, 161, 170, 0.10);
  --pg-status-neutral-text: #d4d4d8;
  --pg-status-neutral-border: #2e2e36;
  --pg-status-neutral-dot: #a1a1aa;

  --pg-shadow-popover: 0 18px 40px -10px rgba(0, 0, 0, 0.72), 0 4px 12px rgba(0, 0, 0, 0.45);
  --pg-shadow-modal: 0 28px 64px -12px rgba(0, 0, 0, 0.80);
}

```

## 4. Complete Vapor-Valid Component Blueprints (`packages/ui/src/`)

Every component below is designed from scratch to be **100% Vue 3.6 Vapor-valid**, accessible (WAI-ARIA 1.2), RTL-ready, dark-mode-ready, and visually superior to Vuetify 3 while keeping full functional parity.

### 4.1 `PgFieldShell.tsx` + `PgTextField.tsx` + `PgSearchInput.tsx` (Zero Blue Glow, Full Parity)

* **Replaces:** `VTextField`, `TextField`, and every ad-hoc table search `<input>`.

* **Design:**

  * `40px` height (`36px` in `size="sm"` for table toolbars), `8px` radius, `1px solid var(--pg-border-default)` resting border, `var(--pg-border-strong)` on hover, and **neutral `var(--pg-border-focus)` + `var(--pg-focus-ring)`** on focus (zero blue glow!).

  * Full slots & props: `label`, `hint`, `error`, `required`, `leadingIcon`, `trailingIcon`, `prefix` (e.g. `LYD`), `suffix`, `clearable`, `readonly`, `disabled`, `maxLength` with live counter, `type="password"` with built-in eye toggle.

  * `PgSearchInput` wraps `PgTextField` with `leadingIcon="mdi-magnify"`, `clearable`, `size="sm"`, debounced `onSearch`, and optional trailing `<kbd>/</kbd>` or `<kbd>⌘K</kbd>` pill.

```
// packages/ui/src/inputs/PgTextField.tsx
import { computed, defineComponent, ref, useId, type PropType } from "vue";
import { PgIcon } from "../actions/PgIcon";
import { PgFieldShell } from "./PgFieldShell";

export const PgTextField = defineComponent({
  name: "PgTextField",
  props: {
    modelValue: { type: [String, Number] as PropType<string | number | null>, default: "" },
    label: { type: String, default: "" },
    placeholder: { type: String, default: "" },
    hint: { type: String, default: "" },
    error: { type: String, default: "" },
    type: { type: String, default: "text" },
    size: { type: String as PropType<"sm" | "md" | "lg">, default: "md" },
    leadingIcon: { type: String, default: "" },
    trailingIcon: { type: String, default: "" },
    prefix: { type: String, default: "" },
    suffix: { type: String, default: "" },
    kbdHint: { type: String, default: "" },
    clearable: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    readonly: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    monospace: { type: Boolean, default: false },
    autocomplete: { type: String, default: "off" },
  },
  emits: ["update:modelValue", "clear", "enter", "blur", "focus"],
  setup(props, { emit }) {
    const inputId = `pg-tf-${useId()}`;
    const focused = ref(false);
    const revealPassword = ref(false);
    const stringVal = computed(() => (props.modelValue == null ? "" : String(props.modelValue)));
    const effectiveType = computed(() =>
      props.type === "password" ? (revealPassword.value ? "text" : "password") : props.type,
    );

    return () => (
      <PgFieldShell
        forId={inputId}
        label={props.label}
        hint={props.hint}
        error={props.error}
        required={props.required}
        disabled={props.disabled}
      >
        <div
          class={[
            "pg-control-box",
            `pg-control-box--${props.size}`,
            focused.value ? "pg-control-box--focused" : "",
            props.error ? "pg-control-box--error" : "",
            props.disabled ? "pg-control-box--disabled" : "",
          ]}
        >
          {props.leadingIcon && (
            <span class="pg-control-adornment pg-control-adornment--start">
              <PgIcon icon={props.leadingIcon} size={17} />
            </span>
          )}
          {props.prefix && <span class="pg-control-affix">{props.prefix}</span>}

          <input
            id={inputId}
            class={["pg-control-native", props.monospace ? "pg-mono" : ""]}
            type={effectiveType.value}
            value={stringVal.value}
            placeholder={props.placeholder}
            disabled={props.disabled}
            readonly={props.readonly}
            autocomplete={props.autocomplete}
            aria-invalid={props.error ? "true" : "false"}
            onFocus={() => {
              focused.value = true;
              emit("focus");
            }}
            onBlur={() => {
              focused.value = false;
              emit("blur");
            }}
            onInput={(e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value)}
            onKeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter") emit("enter");
            }}
          />

          {props.suffix && <span class="pg-control-affix">{props.suffix}</span>}
          {props.clearable && stringVal.value.length > 0 && !props.disabled && !props.readonly && (
            <button
              type="button"
              class="pg-control-clear-btn"
              aria-label="Clear input"
              onMousedown={(e: MouseEvent) => e.preventDefault()}
              onClick={() => {
                emit("update:modelValue", "");
                emit("clear");
              }}
            >
              <PgIcon icon="mdi-close-circle" size={16} />
            </button>
          )}
          {props.type === "password" && (
            <button
              type="button"
              class="pg-control-clear-btn"
              aria-label={revealPassword.value ? "Hide password" : "Show password"}
              onMousedown={(e: MouseEvent) => e.preventDefault()}
              onClick={() => (revealPassword.value = !revealPassword.value)}
            >
              <PgIcon icon={revealPassword.value ? "mdi-eye-off-outline" : "mdi-eye-outline"} size={17} />
            </button>
          )}
          {props.kbdHint && !focused.value && !stringVal.value && (
            <kbd class="pg-kbd-badge">{props.kbdHint}</kbd>
          )}
          {props.trailingIcon && (
            <span class="pg-control-adornment pg-control-adornment--end">
              <PgIcon icon={props.trailingIcon} size={17} />
            </span>
          )}
        </div>
      </PgFieldShell>
    );
  },
});

```

### 4.2 `PgAutocomplete.tsx` (Replaces `VSelect`, `VAutocomplete`, `VCombobox` — Zero `<select multiple>`!)

* **Hard Policy:** Never use `<select>` or `<select multiple>` anywhere in the codebase. Even 3-option dropdowns use `PgAutocomplete` (with `searchable={false}` only when explicitly desired; default `searchable={true}` everywhere!).

* **Capabilities (Vuetify `VAutocomplete` / `VCombobox` Parity + 2026 Fintech UX):**

  * **Single & Multi-Select with Pill Chips:** Selected items in `multiple` mode render as crisp removable pill chips inside the input box (`maxVisibleChips` defaults to `3` with a `+N more` pill so tall multi-selects never explode row height).

  * **Floating `<Teleport to="body">` Popover:** Auto-positions below or flips above the trigger based on viewport space; matches trigger width (`minWidth: triggerRect.width`); closes on Escape or outside pointerdown.

  * **Full Keyboard Navigation:** `ArrowDown` / `ArrowUp` move active highlight, `Enter` toggles/selects option, `Backspace` on empty search query removes the last selected chip, `Escape` closes popover.

  * **Rich Option Rows:** Supports `label`, `subtitle` (e.g., merchant ID or rail code), `icon`, `badge`, `disabled`, and animated checkmark indicator.

  * **Combobox Mode (`creatable={true}`):** Pressing `Enter` when no exact match exists creates and selects the typed custom tag (e.g., IP CIDR allowlists, redirect domains, custom rail codes).

  * **Async Mode (`PgApiAutocomplete`):** Built-in 250ms debounce, loading spinner inside trigger, and empty/error state inside the dropdown panel.

```
// packages/ui/src/inputs/PgAutocomplete.tsx
import { computed, defineComponent, nextTick, onBeforeUnmount, ref, Teleport, useId, watch, type PropType } from "vue";
import { PgIcon } from "../actions/PgIcon";
import { PgFieldShell } from "./PgFieldShell";

export interface PgOption<T = string> {
  value: T;
  label: string;
  subtitle?: string;
  icon?: string;
  badge?: string;
  disabled?: boolean;
}

export const PgAutocomplete = defineComponent({
  name: "PgAutocomplete",
  props: {
    modelValue: { type: [String, Number, Array, Object] as PropType<any>, default: null },
    items: { type: Array as PropType<PgOption<any>[]>, default: () => [] },
    label: { type: String, default: "" },
    placeholder: { type: String, default: "Search or select…" },
    hint: { type: String, default: "" },
    error: { type: String, default: "" },
    multiple: { type: Boolean, default: false },
    searchable: { type: Boolean, default: true },
    creatable: { type: Boolean, default: false },
    clearable: { type: Boolean, default: true },
    loading: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    size: { type: String as PropType<"sm" | "md" | "lg">, default: "md" },
    maxVisibleChips: { type: Number, default: 4 },
    noResultsText: { type: String, default: "No matching options" },
  },
  emits: ["update:modelValue", "search", "clear"],
  setup(props, { emit }) {
    const uid = useId();
    const listboxId = `pg-ac-list-${uid}`;
    const triggerRef = ref<HTMLElement | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    const inputRef = ref<HTMLInputElement | null>(null);

    const open = ref(false);
    const query = ref("");
    const activeIndex = ref(0);
    const panelStyle = ref<Record<string, string>>({});

    const selectedValues = computed<any[]>(() => {
      if (props.multiple) return Array.isArray(props.modelValue) ? props.modelValue : [];
      return props.modelValue === null || props.modelValue === undefined || props.modelValue === ""
        ? []
        : [props.modelValue];
    });

    const selectedOptions = computed<PgOption<any>[]>(() =>
      selectedValues.value.map(
        (val) =>
          props.items.find((it) => String(it.value) === String(val)) ?? {
            value: val,
            label: String(val),
          },
      ),
    );

    const filteredItems = computed(() => {
      const q = query.value.trim().toLowerCase();
      if (!q || !props.searchable) return props.items;
      return props.items.filter(
        (it) =>
          it.label.toLowerCase().includes(q) ||
          String(it.value).toLowerCase().includes(q) ||
          (it.subtitle && it.subtitle.toLowerCase().includes(q)),
      );
    });

    const isSelected = (val: any) => selectedValues.value.some((v) => String(v) === String(val));

    const updatePosition = () => {
      const el = triggerRef.value;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < 260 && rect.top > spaceBelow;
      panelStyle.value = {
        position: "fixed",
        left: `${rect.left}px`,
        width: `${Math.max(rect.width, 220)}px`,
        top: flipUp ? "auto" : `${rect.bottom + 6}px`,
        bottom: flipUp ? `${window.innerHeight - rect.top + 6}px` : "auto",
        zIndex: "var(--pg-z-popover)",
      };
    };

    const openPanel = async () => {
      if (props.disabled) return;
      open.value = true;
      activeIndex.value = 0;
      await nextTick();
      updatePosition();
      inputRef.value?.focus();
    };

    const closePanel = () => {
      open.value = false;
      query.value = "";
    };

    const selectOption = (opt: PgOption<any>) => {
      if (opt.disabled) return;
      if (props.multiple) {
        const exists = isSelected(opt.value);
        const next = exists
          ? selectedValues.value.filter((v) => String(v) !== String(opt.value))
          : [...selectedValues.value, opt.value];
        emit("update:modelValue", next);
        query.value = "";
        inputRef.value?.focus();
      } else {
        emit("update:modelValue", opt.value);
        closePanel();
      }
    };

    const removeChip = (val: any) => {
      if (props.disabled) return;
      if (props.multiple) {
        emit(
          "update:modelValue",
          selectedValues.value.filter((v) => String(v) !== String(val)),
        );
      } else {
        emit("update:modelValue", null);
      }
    };

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!open.value) {
          void openPanel();
          return;
        }
        activeIndex.value = Math.min(activeIndex.value + 1, Math.max(filteredItems.value.length - 1, 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex.value = Math.max(activeIndex.value - 1, 0);
      } else if (e.key === "Enter") {
        if (!open.value) return;
        e.preventDefault();
        const highlighted = filteredItems.value[activeIndex.value];
        if (highlighted) {
          selectOption(highlighted);
        } else if (props.creatable && query.value.trim()) {
          selectOption({ value: query.value.trim(), label: query.value.trim() });
        }
      } else if (e.key === "Escape") {
        closePanel();
      } else if (e.key === "Backspace" && !query.value && props.multiple && selectedValues.value.length > 0) {
        removeChip(selectedValues.value[selectedValues.value.length - 1]);
      }
    };

    const onDocumentPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.value?.contains(target) || panelRef.value?.contains(target)) return;
      closePanel();
    };

    watch(open, (isOpen) => {
      if (isOpen) {
        document.addEventListener("pointerdown", onDocumentPointerDown);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
      } else {
        document.removeEventListener("pointerdown", onDocumentPointerDown);
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      }
    });

    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });

    return () => {
      const visibleChips = selectedOptions.value.slice(0, props.maxVisibleChips);
      const overflowCount = Math.max(0, selectedOptions.value.length - props.maxVisibleChips);

      return (
        <PgFieldShell
          label={props.label}
          hint={props.hint}
          error={props.error}
          required={props.required}
          disabled={props.disabled}
        >
          <div
            ref={triggerRef}
            class={[
              "pg-control-box pg-ac-trigger",
              `pg-control-box--${props.size}`,
              open.value ? "pg-control-box--focused" : "",
              props.error ? "pg-control-box--error" : "",
              props.disabled ? "pg-control-box--disabled" : "",
            ]}
            onClick={() => (open.value ? inputRef.value?.focus() : void openPanel())}
          >
            <div class="pg-ac-values">
              {props.multiple &&
                visibleChips.map((chip) => (
                  <span key={String(chip.value)} class="pg-ac-chip">
                    <span class="pg-ac-chip__label">{chip.label}</span>
                    {!props.disabled && (
                      <button
                        type="button"
                        class="pg-ac-chip__remove"
                        aria-label={`Remove ${chip.label}`}
                        onClick={(e: MouseEvent) => {
                          e.stopPropagation();
                          removeChip(chip.value);
                        }}
                      >
                        <PgIcon icon="mdi-close" size={12} />
                      </button>
                    )}
                  </span>
                ))}
              {props.multiple && overflowCount > 0 && (
                <span class="pg-ac-chip pg-ac-chip--overflow">+{overflowCount}</span>
              )}

              <input
                ref={inputRef}
                role="combobox"
                aria-expanded={open.value ? "true" : "false"}
                aria-controls={listboxId}
                aria-autocomplete="list"
                class="pg-control-native pg-ac-input"
                type="text"
                readonly={!props.searchable}
                disabled={props.disabled}
                value={
                  open.value
                    ? query.value
                    : !props.multiple && selectedOptions.value[0]
                      ? selectedOptions.value[0].label
                      : ""
                }
                placeholder={selectedOptions.value.length === 0 ? props.placeholder : ""}
                onFocus={() => !open.value && void openPanel()}
                onInput={(e: Event) => {
                  query.value = (e.target as HTMLInputElement).value;
                  activeIndex.value = 0;
                  emit("search", query.value);
                }}
                onKeydown={onKeydown}
              />
            </div>

            {props.clearable && selectedValues.value.length > 0 && !props.disabled && (
              <button
                type="button"
                class="pg-control-clear-btn"
                aria-label="Clear selection"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  emit("update:modelValue", props.multiple ? [] : null);
                  emit("clear");
                }}
              >
                <PgIcon icon="mdi-close-circle" size={16} />
              </button>
            )}
            <span class={["pg-ac-chevron", open.value ? "pg-ac-chevron--open" : ""]}>
              <PgIcon icon={props.loading ? "mdi-loading" : "mdi-chevron-down"} size={18} />
            </span>
          </div>

          <Teleport to="body">
            {open.value && (
              <div ref={panelRef} id={listboxId} role="listbox" class="pg-popover-panel pg-ac-panel" style={panelStyle.value}>
                {props.loading ? (
                  <div class="pg-ac-empty">Loading options…</div>
                ) : filteredItems.value.length === 0 ? (
                  <div class="pg-ac-empty">
                    {props.creatable && query.value.trim() ? (
                      <button
                        type="button"
                        class="pg-ac-create-btn"
                        onClick={() => selectOption({ value: query.value.trim(), label: query.value.trim() })}
                      >
                        Create "{query.value.trim()}"
                      </button>
                    ) : (
                      props.noResultsText
                    )}
                  </div>
                ) : (
                  filteredItems.value.map((opt, idx) => {
                    const checked = isSelected(opt.value);
                    return (
                      <button
                        key={`${String(opt.value)}-${idx}`}
                        type="button"
                        role="option"
                        aria-selected={checked ? "true" : "false"}
                        disabled={opt.disabled}
                        class={[
                          "pg-ac-option",
                          idx === activeIndex.value ? "pg-ac-option--active" : "",
                          checked ? "pg-ac-option--selected" : "",
                        ]}
                        onMouseenter={() => (activeIndex.value = idx)}
                        onClick={() => selectOption(opt)}
                      >
                        {props.multiple && (
                          <span class={["pg-ac-option-check", checked ? "pg-ac-option-check--on" : ""]}>
                            {checked && <PgIcon icon="mdi-check" size={12} />}
                          </span>
                        )}
                        {opt.icon && <PgIcon icon={opt.icon} size={16} />}
                        <span class="pg-ac-option-text">
                          <span class="pg-ac-option-label">{opt.label}</span>
                          {opt.subtitle && <span class="pg-ac-option-sub">{opt.subtitle}</span>}
                        </span>
                        {opt.badge && <span class="pg-ac-option-badge">{opt.badge}</span>}
                        {!props.multiple && checked && (
                          <PgIcon icon="mdi-check" size={16} class="pg-ac-option-tick" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </Teleport>
        </PgFieldShell>
      );
    };
  },
});

```

### 4.3 `PgDateInput.tsx` & `PgDateRangeInput.tsx` (Vuetify `VDateInput` Parity + 2026 Fintech Upgrade)

* **Replaces:** Raw `<input type="date">` in `VuetifyShim.tsx` L538–550 and `DateInput/index.tsx`.

* **Design & UX:**

  * Looks and behaves like an elevated Vuetify `VDateInput` meets Linear/Stripe:

    * Same `40px` `PgControlBox` trigger with leading calendar icon (`mdi-calendar-blank-outline`), editable `YYYY-MM-DD` input (power users can type dates directly!), and `clearable` button.

    * Clicking opens a `<Teleport to="body">` floating calendar grid with:

      * Month/Year switcher header (`‹` `November 2026` `›` — clicking the month/year header toggles a fast 12-month / year-grid picker so picking birthdays or KYB expiry dates takes 2 clicks instead of 40!).

      * 7-column weekday grid (`Su Mo Tu We Th Fr Sa`, RTL-aware) with today ring, selected pill, range-highlight band, and disabled `min`/`max` dates.

      * Optional fintech preset sidebar on `PgDateRangeInput` (`Today`, `Last 7 Days`, `Last 30 Days`, `This Month`, `Last Month`, `Year to Date`).

      * Footer with `Today` shortcut and `Clear` button.

### 4.4 `PgCheckbox.tsx` (Modern 2026 Animated Checkbox + Compliance Safeguard Card Variant)

* **Replaces:** Ugly raw `<input type="checkbox">` in `VuetifyShim.tsx` L385–426 and `Checkbox/index.ts`.

* **Design & UX:**

  * Custom `20px × 20px` rounded-square (`border-radius: 6px`) control with `1.5px solid var(--pg-border-strong)`, subtle hover fill, smooth `140ms cubic-bezier(0.22, 1, 0.36, 1)` fill transition to `var(--pg-accent-primary)`, crisp inline SVG animated checkmark (`stroke-dashoffset` draw-in!) and horizontal dash for `indeterminate={true}`.

  * Neutral `var(--pg-focus-ring)` on `:focus-visible`.

  * **`variant="card"` (Fintech Compliance Safeguard Mode):** Wraps the checkbox + `label` + `description` inside a full-width clickable card row (`padding: 12px 14px; border-radius: 10px`) that transitions to a calm emerald-tinted verified state when checked—ideal for all four-eyes Maker-Checker & KYB Safeguard dialogs!

### 4.5 `PgAlert.tsx` (Single Unified Alert & Banner Component)

* **Replaces:** `SandboxBanner.tsx`, `AlertView/index.tsx`, `VAlert`, and every hand-styled inline `<div role="alert">` across all 4 frontends.

* **Design:**

  * Consistent left semantic icon + bold title + crisp body copy + optional right-aligned actions slot + optional close `×` button.

  * Every `tone` (`info`, `success`, `warning`, `danger`, `neutral`) maps 1-to-1 to `--pg-status-{tone}-bg`, `--pg-status-{tone}-border`, `--pg-status-{tone}-text`, and `--pg-status-{tone}-dot`—so **every alert in the entire system** (Sandbox banner, Email-not-configured warning, Form validation error, KYB revalidation notice) has the exact same polished visual quality!

### 4.6 `PgToast.tsx` & `toastStore.ts` (Auto-Dismissing 2026 Toast/Snackbar System)

* **Replaces:** Broken `VSnackbar` (L677–710) and `SnackBar/index.tsx`.

* **Design & Behavior (Fixes Every Snackbar Crime):**

  1. **Guaranteed Auto-Dismiss Timer:** Every toast starts a `setTimeout` (`4500ms` default for `success`/`info`, `6500ms` for `warning`/`danger`) with a thin 2px animated countdown bar along the bottom edge.

  2. **Pause on Hover:** Hovering over a toast pauses the countdown timer and resumes smoothly on `mouseleave` so users can finish reading longer messages.

  3. **Stackable Queue (Up to 4 Toasts):** Multiple rapid actions (e.g., copying a reference then saving a setting) stack cleanly at `bottom: 24px; inset-inline-end: 24px` (RTL-aware) instead of overwriting each other.

  4. **Clean Dismiss & Action Button:** Compact icon-only `×` dismiss button + optional action button (`Undo`, `View`).

```
// packages/ui/src/feedback/toastStore.ts
import { ref } from "vue";

export type ToastTone = "success" | "info" | "warning" | "danger";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title?: string;
  message: string;
  durationMs: number;
  actionLabel?: string;
  onAction?: () => void;
  paused: boolean;
  remainingMs: number;
  startedAt: number;
}

const toasts = ref<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let seq = 0;

function startTimer(item: ToastItem) {
  if (item.durationMs <= 0) return;
  item.startedAt = Date.now();
  const handle = setTimeout(() => dismissToast(item.id), item.remainingMs);
  timers.set(item.id, handle);
}

export function dismissToast(id: number) {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function pauseToast(id: number) {
  const item = toasts.value.find((t) => t.id === id);
  const handle = timers.get(id);
  if (!item || !handle || item.paused) return;
  clearTimeout(handle);
  timers.delete(id);
  item.remainingMs = Math.max(400, item.remainingMs - (Date.now() - item.startedAt));
  item.paused = true;
}

export function resumeToast(id: number) {
  const item = toasts.value.find((t) => t.id === id);
  if (!item || !item.paused) return;
  item.paused = false;
  startTimer(item);
}

export function showToast(opts: {
  tone?: ToastTone;
  title?: string;
  message: string;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const tone = opts.tone ?? "info";
  const durationMs = opts.durationMs ?? (tone === "danger" || tone === "warning" ? 6500 : 4500);
  const item: ToastItem = {
    id: ++seq,
    tone,
    title: opts.title,
    message: opts.message,
    durationMs,
    remainingMs: durationMs,
    startedAt: Date.now(),
    paused: false,
    actionLabel: opts.actionLabel,
    onAction: opts.onAction,
  };
  // Cap visible stack at 4 toasts
  if (toasts.value.length >= 4) {
    dismissToast(toasts.value[0].id);
  }
  toasts.value = [...toasts.value, item];
  startTimer(item);
  return item.id;
}

export function useToasts() {
  return { toasts, showToast, dismissToast, pauseToast, resumeToast };
}

```

### 4.7 `PgDialog.tsx` & `PgCommandPalette.tsx` (Guaranteed Padding & Zero Close-Button Overlap)

* **Replaces:** `VDialog`, `FormModal`, and broken `GuideSearchPalette` / `GlobalSearchPalette` dialog chrome.

* **Hard Layout Contract:**

  * `PgDialog` uses a strict 3-row flex column (`header`, `body`, `footer`) inside `max-height: min(86vh, 820px)`:

    * **Header (`padding: 20px 24px`, `border-bottom: 1px solid var(--pg-border-subtle)`):** Title + Subtitle on the start side, `×` close button in a dedicated `flex-shrink: 0` slot on the end side. **Never `position: absolute`!** Thus the `×` button can **never** overlap any title, input, or badge.

    * **Body (`padding: 24px`, `overflow-y: auto`, `display: flex; flex-direction: column; gap: 20px`):** Spacious, scroll-safe form/detail container.

    * **Footer (`padding: 16px 24px`, `background: var(--pg-bg-surface-subtle)`, `border-top: 1px solid var(--pg-border-subtle)`):** Right-aligned action buttons (`gap: 10px`).

  * `PgCommandPalette` (for `GuideSearchPalette` & `GlobalSearchPalette`): Uses `bare={true}` (no duplicate `×` button), a dedicated `56px`-tall search header (`padding: 0 20px`, magnifying icon + borderless input + `ESC` badge), and a padded scrollable results listbox (`padding: 12px`).

### 4.8 `PgMetricStrip.tsx` (Fixes Broken Gray-Background Square Boxes — Zero Gaps!)

* **Replaces:** Broken `MetricStrip.tsx` (`gap: 1px; backgroundColor: var(--pg-border-subtle)`), `PageStats/index.tsx` (`-webkit-text-fill-color: transparent` bug), and `MiniStats/index.tsx`.

* **The Exact Fix for Zero Gaps & Zero Exposed Gray Cells:**

  * Never rely on `backgroundColor: border-color` + `gap: 1px` on a wrapping grid!

  * Instead, set `backgroundColor: var(--pg-bg-surface)` on the container, `gap: 0`, and apply a subtle `box-shadow: inset -1px 0 0 var(--pg-border-subtle), inset 0 -1px 0 var(--pg-border-subtle)` (or `margin: -1px 0 0 -1px; border-top: 1px solid var(--pg-border-subtle); border-inline-start: 1px solid var(--pg-border-subtle)`) on each tile!

  * Result: **Crisp seamless 1px internal hairlines with zero gaps between boxes, zero double outer borders, and zero gray dead-space rectangles when wrapping!**

```
/* packages/ui/src/tokens/components.css — PgMetricStrip seamless zero-gap grid */
.pg-metric-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 0;
  background: var(--pg-bg-surface);
  border: 1px solid var(--pg-border-subtle);
  border-radius: var(--pg-radius-md);
  box-shadow: var(--pg-shadow-xs);
  overflow: hidden;
}

.pg-metric-tile {
  padding: 20px 24px;
  background: var(--pg-bg-surface);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  /* Seamless internal hairlines with ZERO gaps and ZERO gray dead cells */
  box-shadow:
    inset -1px 0 0 var(--pg-border-subtle),
    inset 0 -1px 0 var(--pg-border-subtle);
  margin-inline-end: -1px;
  margin-bottom: -1px;
  transition: background-color 140ms ease;
}

.pg-metric-tile:hover {
  background: var(--pg-bg-surface-hover);
}

```

## 5. Parallel-Agent Monorepo Remediation & Sweep Plan for `OpenCode`

`OpenCode` should execute this remediation in **5 disciplined phases** using parallel subagents where safe:

1. **Phase 1 — Bootstrap `@pg/ui` Workspace & Master Design Tokens (`packages/ui/`):**

   * Create `packages/ui/package.json`, `tsconfig.json`, `fintech-2026.css`, `layout-policy.css`, and `components.css`.

   * Wire `@pg/ui` path aliases into `vite.config.ts` and `tsconfig.json` for `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front`.

2. **Phase 2 — Build & Unit-Test All Core Vapor-Valid Primitives in `packages/ui/src/`:**

   * Implement `PgFieldShell`, `PgTextField`, `PgTextarea`, `PgSearchInput`, `PgAutocomplete`, `PgApiAutocomplete`, `PgDateInput`, `PgDateRangeInput`, `PgCheckbox`, `PgSwitch`, `PgRadioGroup`, `PgFileUpload`, `PgAlert`, `PgToast`/`toastStore`, `PgDialog`, `PgConfirmDialog`, `PgDrawer`, `PgCommandPalette`, `PgMetricStrip`, `PgFieldsSection`, `PgCard`, `PgPage`, `PgTable`, `PgTableFilters`, `PgButton`, `PgStatusBadge`, `PgMoneyText`, and `PgMonoRef`.

   * Add Vapor component unit tests (`packages/ui/test/*.test.ts`) verifying:

     * `PgAutocomplete` single/multi-select keyboard navigation, chip removal, creatable mode, and zero `<select>` DOM elements.

     * `PgDateInput` typed input, calendar grid selection, month/year jump, and range presets.

     * `PgToast` auto-dismiss timer (`4500ms`), pause-on-hover, and stacking cap.

     * `PgDialog` header/close-button non-overlap and `PgCommandPalette` bare mode.

     * `PgMetricStrip` zero-gap seamless rendering with 3, 4, 5, and 7 tiles.

3. **Phase 3 — Parallel Frontend Sweep (4 Subagents Concurrently):**

   * **Subagent A (`admin-front`):** Migrate `App.tsx` (mount `<PgToaster />`), `GuideSearchPalette.tsx`, `GlobalSearchPalette.tsx`, `Table/`, `SandboxBanner.tsx`, `AlertView/`, `SnackBar/`, `MetricStrip`, `PageStats`, `MiniStats`, `FieldsSections`, `FormModal`, and all pages to `@pg/ui`.

   * **Subagent B (`merchant-front`):** Migrate all Live & Sandbox pages, `Table/`, `SnackBar/`, `AlertView/`, `SandboxBanner`, `onboarding/`, `links/`, `wallets/`, `applications/`, and `pos/` to `@pg/ui`.

   * **Subagent C (`checkout-front`):** Migrate `pay/[linkKey]/index.tsx` and the Sandbox Checkout Inspector drawer to `@pg/ui`.

   * **Subagent D (`fake-rails-front`):** Migrate `dashboard/`, `transactions/`, `chaos-matrix/`, `statements/`, `hosted/redirect/`, and `hosted/widget-frame.tsx` to `@pg/ui`.

4. **Phase 4 — Delete Legacy Shims & Drifted Duplicates:**

   * Delete `src/components/vael/VuetifyShim.tsx`, `src/styles/vael-shim.css`, `src/styles/fintech-minimal.css`, and all duplicated local copies of `Autocomplete/`, `DateInput/`, `Checkbox/`, `TextField/`, `AlertView/`, `SnackBar/`, `Card/`, `Field/`, `FieldsSections/`, `PageStats/`, `MiniStats/`, and `Table/` from all 4 frontends so `@pg/ui` is the **only** implementation.

5. **Phase 5 — Build Verification & Automated Visual/Governance Gate:**

   * Run `bun run build` across all 4 frontends (`admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front`) and verify zero TypeScript, Vite, or Vapor compiler errors.

   * Run the automated UI Governance CI suite (Section 6).

## 6. Strict Future-Agent UI Governance Contract (`AGENTS.md` + Automated CI Gate)

To guarantee that **no future developer or AI coding agent** (`OpenCode`, Cursor, Claude, Gemini) ever breaks the design system again, enforce both a **human/agent policy in `AGENTS.md`** and an **automated CI test (`packages/ui/src/testing/governanceAudit.ts`)** that fails the build on any violation:

### 6.1 Automated CI Governance Rules (Hard Build Failures)

| Rule ID | Forbidden Pattern in `*/src/pages/**` & App Components | Required `@pg/ui` Replacement | 
| ----- | ----- | ----- | 
| `UI-01` | Raw `<select` or `<select multiple` anywhere outside `packages/ui` | `<PgAutocomplete>` (single or `multiple`) | 
| `UI-02` | Raw `<input type="date"` or `<input type="datetime-local"` | `<PgDateInput>` / `<PgDateRangeInput>` | 
| `UI-03` | Raw `<input type="checkbox"` | `<PgCheckbox>` (`variant="default"` or `variant="card"`) | 
| `UI-04` | Raw `<input type="text"` / `<input type="search"` / `<textarea` | `<PgTextField>` / `<PgSearchInput>` / `<PgTextarea>` | 
| `UI-05` | Any import from `VuetifyShim`, `vael-ui` directly inside page files, or `vuetify` | Import exclusively from `@pg/ui` | 
| `UI-06` | Inline hardcoded hex colors (`#[0-9a-fA-F]{3,8}`) or `rgba(...)` in page TSX | Use `--pg-*` semantic CSS custom properties | 
| `UI-07` | Ad-hoc `padding` overrides on `<PgPage>`, `<PgCard>`, or `<PgDialog>` | Use component `density` / `size` / `bare` props only | 
| `UI-08` | Hand-styled `<div role="alert">` banners or custom `setTimeout` snackbars | `<PgAlert tone="...">` and `showToast(...)` | 
| `UI-09` | Duplicating any component file across 2+ frontends (`admin-front` & `merchant-front`) | Extract into `packages/ui/src/` immediately | 

### 6.2 Mandatory Policy Block to Append to Root `AGENTS.md`

```
## UI & Design System Governance (STRICT — ZERO EXCEPTIONS)
1. **Single Source of Truth (`@pg/ui`):** All reusable UI primitives, layout containers, form controls, tables, alerts, toasts, dialogs, and design tokens live exclusively in `packages/ui` (`@pg/ui`). Never copy-paste UI components or CSS token files into `admin-front`, `merchant-front`, `checkout-front`, or `fake-rails-front`.
2. **Forbidden Raw Controls:** Never write raw `<select>`, `<select multiple>`, `<input type="date">`, `<input type="checkbox">`, `<input type="text">`, or hand-styled alert/toast divs inside application pages. Always use `PgAutocomplete`, `PgDateInput`, `PgCheckbox`, `PgTextField`, `PgSearchInput`, `PgAlert`, `PgDialog`, `PgMetricStrip`, and `showToast` from `@pg/ui`.
3. **Global Spacing Policy:** Never override container padding or form gaps with ad-hoc inline `style={{ padding: ... }}` on pages. Rely on `PgPage`, `PgSection`, `PgCard`, `PgDialog`, and `PgFormGrid` tokens.
4. **Creating a New Component:** If a feature genuinely requires a UI pattern not yet in `@pg/ui`, you MUST:
   - Design and implement it inside `packages/ui/src/` as a 100% Vue 3.6 Vapor-valid, accessible, RTL-ready, dark/light-mode component using `--pg-*` tokens.
   - Export it from `packages/ui/src/index.ts`, add unit tests in `packages/ui/test/`, and document its props and usage in `packages/ui/CATALOG.md` BEFORE using it in any page.
5. **CI Gate:** Run `bun test packages/ui/test` and `bun run ui:audit` before completing any frontend task.

```
---

## 7. Exact 48-Component Monorepo Extraction & Deduplication Manifest

A forensic scan of `payment-gateway-monolith-vael-ui-migration` found **48 component directories/files duplicated across 2 to 4 frontends**, totaling **442 component files** (`admin-front`: 230, `merchant-front`: 93, `checkout-front`: 81, `fake-rails-front`: 38) plus **4 drifted copies** of `fintech-minimal.css` and `vael-shim.css`.

`OpenCode` must execute the exact disposition below for every single one of these 48 duplicated items so **zero duplicated UI code remains in any app**:

| # | Duplicated Directory / File | Currently Duplicated In | Exact Target in `@pg/ui` (`packages/ui/src/`) | Disposition |
|---|---|---|---|---|
| 1 | `vael/VuetifyShim.tsx` & `VaelProvider.tsx` | admin, merchant, checkout, fake-rails | `packages/ui/src/provider/PgProvider.tsx` | **DELETE** `VuetifyShim.tsx` from all 4 apps after sweep; replace provider with `<PgProvider>` |
| 2 | `Autocomplete/` | admin, merchant, checkout | `inputs/PgAutocomplete.tsx` | **REPLACE & DELETE** local copies |
| 3 | `ApiAutocomplete/` | admin, merchant | `inputs/PgApiAutocomplete.tsx` | **EXTRACT & DELETE** local copies |
| 4 | `DateInput/` | admin, merchant, checkout | `inputs/PgDateInput.tsx` + `PgDateRangeInput.tsx` | **REPLACE & DELETE** local copies |
| 5 | `Checkbox/` | admin, merchant, checkout | `inputs/PgCheckbox.tsx` | **REPLACE & DELETE** local copies |
| 6 | `TextField/` | admin, merchant, checkout | `inputs/PgTextField.tsx` + `PgSearchInput.tsx` | **REPLACE & DELETE** local copies |
| 7 | `InputFields/` | admin, merchant, fake-rails | `inputs/PgFieldShell.tsx` + `layout/PgFormGrid.tsx` | **CONSOLIDATE & DELETE** local copies |
| 8 | `AlertView/` | admin, merchant, checkout | `feedback/PgAlert.tsx` | **MERGE INTO `PgAlert` & DELETE** local copies |
| 9 | `sandbox/SandboxBanner.tsx` | admin, merchant, checkout | `feedback/PgAlert.tsx` (`tone="warning"`) + `patterns/PgSandboxBanner.tsx` | **EXTRACT & DELETE** local copies |
| 10 | `SnackBar/` | admin, merchant, checkout | `feedback/PgToast.tsx` + `feedback/toastStore.ts` | **REPLACE & DELETE** local copies |
| 11 | `Button/` & `_Button/` | admin, merchant, checkout | `actions/PgButton.tsx` | **CONSOLIDATE BOTH & DELETE** local copies |
| 12 | `Card/` | admin, merchant, checkout | `layout/PgCard.tsx` | **REPLACE & DELETE** local copies |
| 13 | `ScreenContainer/` | admin, merchant, checkout, fake-rails | `layout/PgPage.tsx` | **EXTRACT & DELETE** local copies |
| 14 | `CenterView/` & `ThemedView/` & `ThemedText/` | admin, merchant, checkout | `layout/PgStack.tsx` + `layout/PgCenter.tsx` + `typography/PgText.tsx` | **CONSOLIDATE & DELETE** local copies |
| 15 | `Field/` & `FieldsSections/` & `SectionFields/` | admin, merchant, checkout, fake-rails | `data/PgFieldsSection.tsx` + `data/PgFieldItem.tsx` | **UNIFY ALL 3 & DELETE** local copies |
| 16 | `MiniStats/` & `PageStats/` & `StatsCard/` & `ui/MetricStrip.tsx` | admin, merchant, checkout, fake-rails | `data/PgMetricStrip.tsx` (zero-gap seamless grid; removes broken `PageStats` transparent-text bug & `MetricStrip` gray-gap bug!) | **UNIFY ALL 4 & DELETE** local copies |
| 17 | `StatsBarChartCard/` & `StatsChartCard/` & `EChart/` | admin, merchant, checkout | `charts/PgChart.tsx` + `charts/PgStatChartCard.tsx` | **EXTRACT & DELETE** local copies |
| 18 | `Table/` (`Table.tsx`, `ApiTable.tsx`, `DataTable.tsx`, `TableFilters.tsx`, `TableRowActions.tsx`, `styling.css`) | admin, merchant, checkout, fake-rails | `data/PgTable.tsx`, `data/PgApiTable.tsx`, `data/PgTableFilters.tsx`, `data/PgTableRowActions.tsx` | **EXTRACT & DELETE** all 4 copies |
| 19 | `FiltersContainer/` | admin, merchant, fake-rails | `data/PgTableFilters.tsx` | **MERGE & DELETE** local copies |
| 20 | `DataPage/` | admin, merchant | `patterns/PgDataPage.tsx` | **EXTRACT & DELETE** local copies |
| 21 | `PageHeader/` & `SubHeader/` | admin, merchant, checkout | `layout/PgPageHeader.tsx` + `layout/PgSubHeader.tsx` | **EXTRACT & DELETE** local copies |
| 22 | `ConfirmDialog.tsx` & `detailsFieldsDialog/` & `ui/FormModal.tsx` | admin, merchant, checkout, fake-rails | `overlays/PgDialog.tsx`, `overlays/PgConfirmDialog.tsx`, `overlays/PgFormModal.tsx`, `overlays/PgDetailsDialog.tsx` | **UNIFY & DELETE** local copies |
| 23 | `ui/SlideOverDrawer.tsx` | admin, merchant, checkout, fake-rails | `overlays/PgDrawer.tsx` | **EXTRACT & DELETE** local copies |
| 24 | `ui/` (`DescriptionList`, `EmptyState`, `FormChecklist`, `FormField`, `JsonDiffViewer`, `JsonValueCell`, `JsonValueList`, `MetaPill`, `MoneyDisplay`, `MonoRef`, `SegmentedTabs`, `StatusBadge`, `SummaryExportCard`, `SurfaceCard`) | admin, merchant, checkout, fake-rails | `packages/ui/src/data/*`, `feedback/*`, `inputs/*`, `actions/*` | **EXTRACT ALL TO `@pg/ui` & DELETE** all 4 app copies |
| 25 | `MoneyText/` | admin, merchant, checkout | `data/PgMoneyText.tsx` (merge with `MoneyDisplay`) | **MERGE & DELETE** local copies |
| 26 | `StatusChip/` | admin, merchant, checkout | `feedback/PgStatusBadge.tsx` (merge with `StatusBadge`) | **MERGE & DELETE** local copies |
| 27 | `AppIcon/` & `Icon/` | admin, merchant, checkout, fake-rails | `actions/PgIcon.tsx` + `actions/icons.generated.ts` | **UNIFY & DELETE** all 4 copies |
| 28 | `ActionsList/` | admin, merchant | `actions/PgActionsList.tsx` | **EXTRACT & DELETE** local copies |
| 29 | `AuthoritiesPicker/` | admin, merchant | `patterns/PgAuthoritiesPicker.tsx` | **EXTRACT & DELETE** local copies |
| 30 | `ApiImage/` & `CordsInputMap/` | admin, merchant | `media/PgApiImage.tsx` + `inputs/PgCordsMapInput.tsx` | **EXTRACT & DELETE** local copies |
| 31 | `StateView/` & `loadingScreen.tsx` | admin, merchant, checkout | `feedback/PgStateView.tsx` + `feedback/PgLoadingScreen.tsx` | **EXTRACT & DELETE** local copies |
| 32 | `ThemeMenu/` & `ThemeAndLanguageControls/` | admin, merchant, checkout, fake-rails | `layout/PgThemeLanguageControls.tsx` | **EXTRACT & DELETE** all 4 copies |
| 33 | `Printables/` | admin, merchant, checkout | `printables/*` | **EXTRACT & DELETE** local copies |
| 34 | `guide/` (`GuideSearchPalette.tsx`, `GuideMarkdown.tsx`, etc.) | admin, merchant | `overlays/PgCommandPalette.tsx` + `patterns/guide/*` | **EXTRACT & DELETE** local copies |
| 35 | `styles/fintech-minimal.css`, `styles/vael-shim.css`, `styles/vael-theme.css` | admin, merchant, checkout, fake-rails | `packages/ui/src/tokens/fintech-2026.css`, `layout-policy.css`, `components.css` | **DELETE ALL 12 DRIFTED CSS FILES**; import `@pg/ui/tokens` once in each `main.ts` |

---

## 8. Complete 47-Symbol `VuetifyShim` → `@pg/ui` 1-to-1 Replacement Ledger (All 2,440+ Usages)

Every single `<V*>` tag currently in the codebase (**362 `VuetifyShim` imports**, **2,440+ JSX usages** across **154 pages**) is accounted for below so **nothing** is overlooked:

| `VuetifyShim` Tag | Total Usages (admin / merchant / checkout / fake) | Exact `@pg/ui` Replacement | Critical Fix Enforced During Migration |
|---|---|---|---|
| `<VBtn>` | **860** (616 / 160 / 62 / 22) | `<PgButton>` | Unified heights (`sm`/`md`/`lg`), neutral focus ring, loading state |
| `<VTextField>` | **506** (356 / 117 / 13 / 20) | `<PgTextField>` or `<PgSearchInput>` | Restores `label`, `hint`, `error`, icons, `clearable`; removes blue glow |
| `<VAlert>` | **222** (181 / 21 / 11 / 9) | `<PgAlert>` | Unified semantic status tokens (`--pg-status-*-bg/border/text/dot`) |
| `<VIcon>` | **213** (95 / 68 / 38 / 12) | `<PgIcon>` | Single `@mdi/js` icon registry in `@pg/ui` |
| `<VSelect>` | **179** (148 / 21 / 2 / 8) | `<PgAutocomplete>` | **Zero native `<select>`!** Searchable floating popover + chips for `multiple` |
| `<VTextarea>` | **73** (65 / 8 / 0 / 0) | `<PgTextarea>` | Shared `PgFieldShell` + neutral focus ring + auto-grow |
| `<VProgressCircular>` | **37** (21 / 9 / 7 / 0) | `<PgSpinner>` | Crisp SVG ring spinner with accessible `role="status"` |
| `<VDivider>` | **37** (19 / 9 / 6 / 3) | `<PgDivider>` | Hairline `1px solid var(--pg-border-subtle)` |
| `<VSwitch>` | **35** (25 / 3 / 0 / 7) | `<PgSwitch>` | Tactile 2026 pill toggle with label + description |
| `<VList>` / `<VListItem*>` | **48** (18 / 15 / 7 / 8) | `<PgList>` / `<PgListItem>` | Spacious row padding (`10px 14px`) + active indicator |
| `<VCheckbox>` | **26** (22 / 2 / 1 / 1) | `<PgCheckbox>` | Custom 2026 animated SVG checkmark + `variant="card"` for safeguards |
| `<VAutocomplete>` / `<VCombobox>` | **25** (10 / 7 / 3 / 5) | `<PgAutocomplete>` | Built-from-scratch Vapor WAI-ARIA combobox (`creatable` for combobox) |
| `<VFileInput>` | **22** (12 / 8 / 1 / 1) | `<PgFileUpload>` | Modern dropzone + file pill preview + validation error |
| `<VTooltip>` | **20** (8 / 7 / 5 / 0) | `<PgTooltip>` | `<Teleport to="body">` auto-flip tooltip |
| `<VMenu>` | **15** (6 / 4 / 3 / 2) | `<PgMenu>` | `<Teleport to="body">` keyboard-navigable menu |
| `<VRow>` / `<VCol>` / `<VContainer>` / `<VSpacer>` | **23** (9 / 3 / 0 / 11) | `<PgFormGrid>` / `<PgStack>` / `<PgPage>` | Replaces ad-hoc flex/col hacks with guaranteed spacing tokens |
| `<VChip>` | **12** (10 / 1 / 1 / 0) | `<PgStatusBadge>` or `<PgTag>` | Unified pill typography and removable chip support |
| `<VCard>` / `<VCardText>` / `<VCardActions>` | **23** (23 / 0 / 0 / 0) | `<PgCard>` | Enforces `--pg-space-card-pad` (`24px`) globally |
| `<VDialog>` | **10** (7 / 1 / 1 / 1) | `<PgDialog>` or `<PgCommandPalette>` | Strict 3-zone header/body/footer; `×` button NEVER overlaps content |
| `<VForm>` | **10** (3 / 4 / 3 / 0) | `<PgForm>` | Built-in `preventDefault` + validation summary integration |
| `<VNavigationDrawer>` / `<VApp*>` / `<VMain>` | **20** (7 / 5 / 2 / 6) | `<PgAppShell>` | Single unified responsive app shell across all 4 frontends |
| `<VProgressLinear>` | **9** (7 / 2 / 0 / 0) | `<PgProgressBar>` | Thin 4px/6px rounded semantic progress bar |
| `<VExpansionPanels>` / `<VExpansionPanel*>` | **33** (33 / 0 / 0 / 0) | `<PgAccordion>` | Smooth collapsible accordion with hairline dividers |
| `<VDateInput>` | All `DateInput` usages | `<PgDateInput>` / `<PgDateRangeInput>` | Calendar popover + typed `YYYY-MM-DD` + month/year jump + presets |
| `<VSnackbar>` | **3** (1 / 1 / 1 / 0) | `<PgToaster />` + `showToast()` | Guaranteed auto-dismiss timer + progress bar + pause-on-hover |
| `<VRadioGroup>` / `<VRadio>` | **4** (2 / 2 / 0 / 0) | `<PgRadioGroup>` | Standard + Card-Radio variants |
| `<VSlider>` | **3** (0 / 0 / 0 / 3) | `<PgSlider>` | Custom track/thumb + tabular value readout |
| `<VAvatar>` / `<VTimeline*>` / `<VBtnToggle>` / `<VExpandTransition>` | **10** (5 / 5 / 0 / 0) | `<PgAvatar>`, `<PgTimeline>`, `<PgSegmentedTabs>` | Consistent 2026 visual language |

---

## 9. Zero-Miss Full-Sweep Protocol & Automated Defect Scanner (`scripts/ui-full-sweep-audit.ts`)

Because "countless" UI defects hide across **154 pages** (`admin-front`: 103, `merchant-front`: 41, `checkout-front`: 3, `fake-rails-front`: 7), `OpenCode` must **NOT** rely on manual spot-checking. Before marking the migration complete, `OpenCode` must create and run `scripts/ui-full-sweep-audit.ts` as a hard CI gate.

### 9.1 Verbatim Automated Full-Sweep Gate (`scripts/ui-full-sweep-audit.ts`)

```ts
// scripts/ui-full-sweep-audit.ts
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APPS = ["admin-front", "merchant-front", "checkout-front", "fake-rails-front"];

interface Violation {
  rule: string;
  file: string;
  line: number;
  snippet: string;
}

const violations: Violation[] = [];

const RULES: Array<{ id: string; regex: RegExp; message: string; pagesOnly?: boolean }> = [
  { id: "UI-01", regex: /<select\b/g, message: "Raw <select> forbidden; use <PgAutocomplete> from @pg/ui" },
  { id: "UI-02", regex: /<input\b[^>]*type=["'](?:date|datetime-local)["']/g, message: "Raw date <input> forbidden; use <PgDateInput> from @pg/ui" },
  { id: "UI-03", regex: /<input\b[^>]*type=["']checkbox["']/g, message: "Raw checkbox <input> forbidden; use <PgCheckbox> from @pg/ui" },
  { id: "UI-04", regex: /<(?:input|textarea)\b/g, message: "Raw <input>/<textarea> forbidden; use <PgTextField>/<PgSearchInput>/<PgTextarea> from @pg/ui" },
  { id: "UI-05", regex: /VuetifyShim|from\s+["']vael-ui|from\s+["']vuetify/g, message: "Direct VuetifyShim/vael-ui/vuetify import forbidden in app code; import from @pg/ui" },
  { id: "UI-06", regex: /#[0-9a-fA-F]{3,8}\b/g, message: "Hardcoded hex color forbidden in TSX; use --pg-* CSS token", pagesOnly: true },
  { id: "UI-07", regex: /\bpadding(?:Top|Bottom|Left|Right|Inline|Block)?\s*:/g, message: "Ad-hoc inline padding forbidden in pages; use @pg/ui container spacing policy", pagesOnly: true },
  { id: "UI-08", regex: /role=["']alert["']/g, message: "Hand-styled role='alert' div forbidden; use <PgAlert> from @pg/ui" },
  { id: "UI-09", regex: /-webkit-text-fill-color\s*:\s*["']?transparent/g, message: "Broken transparent text-fill hack forbidden" },
];

function walkTsx(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsx(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// 1. Scan all TSX files in all 4 apps
for (const app of APPS) {
  const srcDir = path.join(ROOT, app, "src");
  for (const file of walkTsx(srcDir)) {
    const rel = path.relative(ROOT, file);
    const isPage = rel.includes("/src/pages/");
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);

    lines.forEach((text, idx) => {
      for (const rule of RULES) {
        if (rule.pagesOnly && !isPage) continue;
        if (rule.regex.test(text)) {
          violations.push({
            rule: `${rule.id}: ${rule.message}`,
            file: rel,
            line: idx + 1,
            snippet: text.trim().slice(0, 110),
          });
        }
        rule.regex.lastIndex = 0;
      }
    });
  }
}

// 2. Enforce zero duplicated UI component directories across apps
const compOccurrences = new Map<string, string[]>();
for (const app of APPS) {
  const cdir = path.join(ROOT, app, "src", "components");
  if (!fs.existsSync(cdir)) continue;
  for (const entry of fs.readdirSync(cdir)) {
    const list = compOccurrences.get(entry) ?? [];
    list.push(app);
    compOccurrences.set(entry, list);
  }
}
for (const [compName, appList] of compOccurrences.entries()) {
  if (appList.length >= 2) {
    violations.push({
      rule: "UI-10: Duplicated component directory across frontends; extract to packages/ui",
      file: `${compName} (${appList.join(", ")})`,
      line: 0,
      snippet: `Found in ${appList.length} frontends`,
    });
  }
}

// 3. Enforce deletion of legacy drifted CSS shims
for (const app of APPS) {
  for (const legacyCss of ["vael-shim.css", "fintech-minimal.css"]) {
    const p = path.join(ROOT, app, "src", "styles", legacyCss);
    if (fs.existsSync(p)) {
      violations.push({
        rule: "UI-11: Legacy duplicated stylesheet must be deleted (use @pg/ui/tokens)",
        file: path.relative(ROOT, p),
        line: 0,
        snippet: legacyCss,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n❌ UI FULL-SWEEP AUDIT FAILED: ${violations.length} violation(s) remaining.\n`);
  for (const v of violations.slice(0, 80)) {
    console.error(`  [${v.rule}]\n    → ${v.file}${v.line ? `:${v.line}` : ""}  |  ${v.snippet}`);
  }
  if (violations.length > 80) {
    console.error(`\n  ... and ${violations.length - 80} more violations.`);
  }
  process.exit(1);
}

console.log("✅ UI FULL-SWEEP AUDIT PASSED: 0 violations across all 4 frontends and 154 pages!");
```

### 9.2 Parallel Subagent Execution Loop (Zero-Miss Guarantee)

1. **Wave 1 (Foundations):** Main agent creates `packages/ui` (`@pg/ui`), tokens, and all core Vapor-valid components + unit tests.
2. **Wave 2 (App-Level Parallel Sweep — 4 Subagents in Parallel):**
   - **Subagent 1 (`admin-front` — 103 pages, split into 2 parallel sub-batches: Onboarding/KYB/Governance/AML vs. Operations/Finance/Gateways/System/Sandbox/Guide/Academy)**
   - **Subagent 2 (`merchant-front` — 41 pages: Live + Sandbox Studio + Sandbox Live Mirror + Public Landing/Auth/Onboarding)**
   - **Subagent 3 (`checkout-front` — 3 pages + Sandbox Checkout Inspector)**
   - **Subagent 4 (`fake-rails-front` — 7 pages + Hosted Redirect & Widget Frame)**
3. **Wave 3 (Automated Convergence Loop):**
   - Run `bun run scripts/ui-full-sweep-audit.ts`.
   - For any remaining violation printed by the scanner, dispatch a targeted fix until the scanner prints **`0 violations`**.
4. **Wave 4 (Build & Visual Smoke Verification):**
   - Run `bun run build` in `admin-front`, `merchant-front`, `checkout-front`, and `fake-rails-front` (must exit `0` with zero Vapor compiler or TypeScript errors).
   - Run `bun test packages/ui/test` and verify every interactive component in both **Light & Dark Mode** and **LTR (English) & RTL (Arabic)**.
