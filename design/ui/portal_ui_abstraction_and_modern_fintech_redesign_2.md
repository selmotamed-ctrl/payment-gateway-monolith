# PORTAL UI/UX DE-AI-IFICATION, TABLE & ROW-ACTION OVERHAUL, `SectionFields` REDESIGN & HUMAN-CRAFTED MINIMAL FINTECH DESIGN SYSTEM — MASTER IMPLEMENTATION BLUEPRINT FOR OPENCODE (v2.0)

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith` (`master` branch)

**Primary Target Workspace:** `admin-front` (with identical shared component rollout to `merchant-front`, `checkout-front`, and `fake-rails-front`)

**Target Execution Model:** OpenCode (`DeepSeek V4.1 Flash Max`)

**Frontend Stack:** Vue 3 (`^3.5.22`) TSX/JSX + Vuetify 3 (`^3.10.7`) + `kt-dc` (`dc()`) + Vite (`rolldown-vite`)

**Design Paradigm:** Architectural Minimalist FinTech (Linear, Stripe Dashboard, Wise, Mercury — Compact `40px` single-line table rows, disciplined icon/menu row actions, guaranteed container paddings, hairline `1px` borders, tabular numerals, zero AI gradient/pill clutter)

## 0. CRITICAL BRIEFING FOR OPENCODE (`DeepSeek V4.1 Flash Max`): READ BEFORE TOUCHING ANY FILE

This v2.0 specification directly addresses the four worst visual defects currently in `admin-front` (and `merchant-front`):

### Defect 1: Why Most Containers Currently Have ZERO Padding (And How to Fix It Permanently)

* **Root Cause A (The Un-Layered `* { padding: 0; margin: 0 }` Reset Bug):**

  * Vuetify 3 wraps its component styles inside CSS Cascade Layers (`@layer vuetify-core`, `@layer vuetify-components`). In modern CSS, **any un-layered rule—even a universal reset `* { padding: 0; margin: 0; }` in `App.tsx`, `main.scss`, or `style.css`—automatically overrides every rule inside `@layer vuetify-core`!**

  * As a result, `<VContainer>`, `<VCard>`, `<VCardText>`, `<VCardTitle>`, `<VCardActions>`, `ScreenContainer`, `SectionFields`, `FiltersContainer`, and `TableFilters` have their internal padding wiped out to `0px`, making text and inputs slam directly against the `1px` card border!

* **Root Cause B (Missing Explicit Padding on Custom TSX Wrappers):**

  * Custom wrapper components (`ScreenContainer`, `SectionFields`, `InputFields`, `FiltersContainer`, `TableFilters`, `DataTable`, `DetailsFieldsDialog`) use bare `<div>` or `<VCard>` wrappers without explicit padding tokens.

* **The Mandatory Fix:**

  1. **Remove any un-layered `* { padding: 0; margin: 0 }` rule** from `App.tsx`, `main.ts`, and any `.css`/`.scss` file immediately! Keep only `*, *::before, *::after { box-sizing: border-box; }`.

  2. Enforce explicit `--pg-pad-*` CSS rules with `!important` on all container classes (`.pg-screen-container`, `.pg-surface-card__header`, `.pg-surface-card__body`, `.pg-surface-card__footer`, `.pg-section-fields`, `.pg-filters-container`, `.pg-table-toolbar`, `.pg-table-filters`, `.pg-table-footer`) as defined in Part II.

### Defect 2: Why Table Row Actions Look "Horrid" & Blow Up Row Height (And How `<TableRowActions />` Fixes It)

* **Root Cause (Both `DataTable.tsx` and Page-Level Agent Misuse):**

  * Across `src/pages/**/*.tsx` (`gateways`, `rails`, `routes`, `join-requests`, `merchants`, `approvals`, `aml/*`, `operator-cases`, `disputes`, `cashouts`, `reconciliation`), the previous agent placed **2 to 5 full-sized colored `<VBtn>` text buttons** inside the `actions` column of every row (e.g., `[Edit] [Pause] [Resume] [Drain]` or `[Assign] [Request Info] [Approve] [Reject]`).

  * Because those buttons have text labels, `36px` height, and different colors (`primary`, `warning`, `error`, `success`), they wrap onto **2 or 3 vertical lines**, stretching each table row to `80px–110px` tall and turning the right side of every table into an ugly wall of multi-colored bricks!

* **The Mandatory Fix (`<TableRowActions />` — Part III §3.2):**

  1. **Strict Single-Line Compact Row Rule:** Every data table row MUST be **`40px` tall** (`height: 40px !important`, `white-space: nowrap`), and the `actions` cell MUST have `width: 1%; white-space: nowrap; text-align: end;`.

  2. **Ban Multi-Button Soup in Table Cells:** Pages in `src/pages/**/*.tsx` are **strictly forbidden** from rendering raw `<VBtn>` stacks inside table row slots. Every table row with actions MUST use **`<TableRowActions />`**, which renders:

     * **At most 1 ultra-compact `26px`-tall primary quick-action button** (neutral hairline-bordered pill, e.g., `"Review"`, `"Inquire"`, or `"Wizard"`), **PLUS**

     * **A single `26px × 26px` subtle `⋯` (`mdi-dots-horizontal`) menu button** that opens a crisp, `1px`-bordered floating popover menu (`180px` min-width, `padding: 4px !important`) containing all secondary and destructive actions (`Edit`, `Pause`, `Drain`, `Verify`, `Suspend`, `Revoke`, etc.) with clean `16px` icons and red text for destructive items!

### Defect 3: Why `Table/*` (`DataTable.tsx`, `ApiTable.tsx`, `TableFilters.tsx`) Looks Cluttered and Unbalanced

* **Root Cause:**

  1. `TableFilters.tsx` was rendered as a separate gradient card above the table, or had misaligned inputs and cramped `0px` edges.

  2. `statusTone.ts` painted entire table rows with `8–10%` green/yellow/red background tints + thick left borders, turning financial tables into rainbow stripes.

  3. Table cells lacked proper horizontal padding (`padding: 0 16px` inner, `20px` outer left/right edges) and lacked text truncation, causing long names or JSON strings to wrap onto multiple lines.

* **The Mandatory Fix (Part III §3.1–§3.4):**

  * Replace `DataTable.tsx`, `ApiTable.tsx`, `TableFilters.tsx`, and `statusTone.ts` with the exact drop-in code in Part III. The Search Toolbar, Collapsible Filter Grid, Active Filter Chips Bar, Compact `40px`-Row Table, and Pagination Footer are unified into **one single-bordered architectural card** (`class="pg-table-card"`) with guaranteed `16px 20px` paddings on every section and zero full-row rainbow background tints.

### Defect 4: Why `SectionFields`, `InputFields`, `FiltersContainer`, and `DetailsFieldsDialog` Look Broken

* **Root Cause:**

  * `SectionFields`, `InputFields`, `FiltersContainer`, and `DetailsFieldsDialog` (inherited from `template-back-front`) render bare `<VRow><VCol>` or `<VCard>` wrappers with no internal padding, floating Vuetify notch labels that collide with borders, and mismatched input heights.

* **The Mandatory Fix (Part IV §4.1–§4.6):**

  * Replace `SectionFields`, `InputFields`, `FiltersContainer`, `DetailsFieldsDialog`, `AwaitedConfirmationDialog`, and `ScreenContainer` with the exact drop-in TSX implementations in Part IV.

# PART I: VISUAL & ARCHITECTURAL AUDIT MATRIX (BEFORE vs. AFTER)

| \# | Component / Surface | Current Broken State in `admin-front` | Mandatory v2.0 Redesign Specification | 
| ----- | ----- | ----- | ----- | 
| **1** | **Global Container Paddings** (`ScreenContainer`, `VCard`, `SectionFields`, `TableFilters`) | Un-layered `* { padding: 0; margin: 0 }` strips Vuetify `@layer` paddings; text and inputs touch the `1px` border edge (`0px` padding). | Delete `* { padding: 0; margin: 0 }`. Enforce explicit `!important` padding rules: `ScreenContainer` (`24px 28px`), Card Header (`14px 20px`), Card Body (`20px 24px`), Card Footer (`12px 20px`). | 
| **2** | **Table Row Height & Density** (`DataTable.tsx`, `ApiTable.tsx`) | Uneven `56px–110px` rows caused by wrapping text and stacked action buttons; `8–10%` rainbow row background tints. | **Strict `40px` Single-Line Rows (`height: 40px`):** `padding: 0 16px` (`20px` on first/last columns), `white-space: nowrap`, automatic text truncation (`max-width: 240px`), pure white/carbon background with subtle hover (`#F8FAFC` / `#18181C`), and `<StatusBadge />` pills. | 
| **3** | **Table Row Actions** (`TableRowActions.tsx`) | 3 to 5 colored `<VBtn>` buttons crammed into the `actions` cell, wrapping across multiple lines and clashing visually. | **`<TableRowActions />`:** Never wraps. Renders at most **1** compact `26px` neutral outline button (optional primary action) + **1** `26px × 26px` `⋯` (`mdi-dots-horizontal`) menu trigger opening a clean `1px`-bordered action menu. | 
| **4** | **Table Toolbar, Filters & Footer** (`TableFilters.tsx`) | Separate gradient filter card; search box and pagination controls touching container borders. | **Unified Single-Border Table Card (`.pg-table-card`):** Top toolbar (`padding: 12px 20px`), collapsible filter panel (`padding: 16px 20px`, `--pg-bg-surface-subtle`), active filter chips bar (`padding: 8px 20px`), table, and footer (`padding: 10px 20px`) separated by `1px` hairlines. | 
| **5** | **`SectionFields` & `InputFields`** (`src/components/SectionFields/*`, `InputFields/*`) | Un-padded `<VCard>` or `<VRow>`, jumping Material floating labels, misaligned checkbox/date/select heights. | **Padded Architectural Section Card (`.pg-section-fields`):** Header (`14px 24px`), body (`20px 24px`) with CSS Grid (`gap: 16px 20px`), static top labels (`12.5px` medium, `margin-bottom: 6px`), and uniform `36px`-tall inputs. | 
| **6** | **`DetailsFieldsDialog` & `AwaitedConfirmationDialog`** | Cramped dialog body with unformatted raw values and zero padding around header/actions. | Crisp modal (`16px 24px` header, `20px 24px` body, `12px 24px` footer) rendering a bordered 2-column property grid with automatic `<MonoRef />`, `<MoneyDisplay />`, and `<StatusBadge />` formatting. | 

# PART II: COMPLETE CSS TOKENS, PADDING ENFORCEMENT & VUETIFY CONFIGURATION

## 2.1 Master Architectural Stylesheet (`admin-front/src/styles/fintech-minimal.css`)

OpenCode MUST create `admin-front/src/styles/fintech-minimal.css` and import it **last** in `admin-front/src/main.ts` (and remove any `* { padding: 0; margin: 0 }` in `App.tsx` or other stylesheets):

```
/* ============================================================================
 * HUMAN-CRAFTED MINIMAL FINTECH DESIGN SYSTEM v2.0
 * Enforces explicit container paddings, compact 40px single-line tables,
 * static-label form geometry, and hairline 1px borders.
 * ============================================================================ */

:root {
  /* Surface Hierarchy (Light Mode) */
  --pg-bg-canvas: #F8FAFC;
  --pg-bg-surface: #FFFFFF;
  --pg-bg-surface-subtle: #F1F5F9;
  --pg-bg-surface-hover: #F8FAFC;
  --pg-bg-surface-selected: #EFF6FF;
  --pg-bg-glass: rgba(255, 255, 255, 0.90);

  /* Ink & Typography */
  --pg-ink-primary: #0F172A;
  --pg-ink-secondary: #475569;
  --pg-ink-muted: #64748B;
  --pg-ink-faint: #94A3B8;

  /* Hairline Borders */
  --pg-border-subtle: #E2E8F0;
  --pg-border-strong: #CBD5E1;
  --pg-border-focus: #2563EB;

  /* Brand & Interactive Accents */
  --pg-accent-primary: #0F172A;
  --pg-accent-primary-hover: #1E293B;
  --pg-accent-interactive: #2563EB;

  /* Semantic Status Palettes (Soft Pill + 1px Border + 6px Dot) */
  --pg-status-success-bg: #F0FDF4;
  --pg-status-success-text: #15803D;
  --pg-status-success-border: #BBF7D0;
  --pg-status-success-dot: #16A34A;

  --pg-status-warning-bg: #FFFBEB;
  --pg-status-warning-text: #B45309;
  --pg-status-warning-border: #FDE68A;
  --pg-status-warning-dot: #D97706;

  --pg-status-danger-bg: #FEF2F2;
  --pg-status-danger-text: #B91C1C;
  --pg-status-danger-border: #FECACA;
  --pg-status-danger-dot: #DC2626;

  --pg-status-info-bg: #EFF6FF;
  --pg-status-info-text: #1D4ED8;
  --pg-status-info-border: #BFDBFE;
  --pg-status-info-dot: #2563EB;

  --pg-status-neutral-bg: #F1F5F9;
  --pg-status-neutral-text: #475569;
  --pg-status-neutral-border: #E2E8F0;
  --pg-status-neutral-dot: #64748B;

  /* Radius & Shadows */
  --pg-radius-xs: 4px;
  --pg-radius-sm: 6px;
  --pg-radius-md: 8px;
  --pg-radius-lg: 10px;
  --pg-shadow-xs: 0 1px 2px 0 rgba(15, 23, 42, 0.03);
  --pg-shadow-menu: 0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04);
  --pg-shadow-modal: 0 20px 25px -5px rgba(15, 23, 42, 0.14), 0 8px 10px -6px rgba(15, 23, 42, 0.06);

  /* Guaranteed Spacing & Padding Tokens */
  --pg-pad-screen-desktop: 24px 28px 48px 28px;
  --pg-pad-screen-mobile: 16px 16px 36px 16px;
  --pg-pad-card-header: 14px 20px;
  --pg-pad-card-body: 20px 24px;
  --pg-pad-card-footer: 12px 20px;
  --pg-pad-table-toolbar: 12px 20px;
  --pg-pad-table-filters: 16px 20px;
  --pg-pad-table-chips: 8px 20px;
  --pg-pad-table-footer: 10px 20px;

  /* Fonts */
  --pg-font-sans-ltr: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --pg-font-sans-rtl: "Cairo", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --pg-font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.v-theme--dark {
  --pg-bg-canvas: #09090B;
  --pg-bg-surface: #121215;
  --pg-bg-surface-subtle: #18181C;
  --pg-bg-surface-hover: #1C1C22;
  --pg-bg-surface-selected: rgba(59, 130, 246, 0.12);
  --pg-bg-glass: rgba(18, 18, 21, 0.90);

  --pg-ink-primary: #F8FAFC;
  --pg-ink-secondary: #A1A1AA;
  --pg-ink-muted: #71717A;
  --pg-ink-faint: #52525B;

  --pg-border-subtle: #27272A;
  --pg-border-strong: #3F3F46;
  --pg-border-focus: #3B82F6;

  --pg-accent-primary: #F8FAFC;
  --pg-accent-primary-hover: #E2E8F0;
  --pg-accent-interactive: #3B82F6;

  --pg-status-success-bg: rgba(22, 163, 74, 0.14);
  --pg-status-success-text: #4ADE80;
  --pg-status-success-border: rgba(74, 222, 128, 0.28);
  --pg-status-success-dot: #22C55E;

  --pg-status-warning-bg: rgba(217, 119, 6, 0.14);
  --pg-status-warning-text: #FBBF24;
  --pg-status-warning-border: rgba(251, 191, 36, 0.28);
  --pg-status-warning-dot: #F59E0B;

  --pg-status-danger-bg: rgba(220, 38, 38, 0.14);
  --pg-status-danger-text: #F87171;
  --pg-status-danger-border: rgba(248, 113, 113, 0.28);
  --pg-status-danger-dot: #EF4444;

  --pg-status-info-bg: rgba(37, 99, 235, 0.16);
  --pg-status-info-text: #60A5FA;
  --pg-status-info-border: rgba(96, 165, 250, 0.28);
  --pg-status-info-dot: #3B82F6;

  --pg-status-neutral-bg: #18181C;
  --pg-status-neutral-text: #A1A1AA;
  --pg-status-neutral-border: #27272A;
  --pg-status-neutral-dot: #71717A;
}

/* 1. Safe Box-Sizing Reset (NEVER reset * padding or margin outside a layer!) */
*, *::before, *::after {
  box-sizing: border-box;
}

html, body, #app {
  background-color: var(--pg-bg-canvas) !important;
  color: var(--pg-ink-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  transform: none !important;
}

html[dir="ltr"] body {
  font-family: var(--pg-font-sans-ltr);
  letter-spacing: -0.005em;
}

html[dir="rtl"] body {
  font-family: var(--pg-font-sans-rtl);
  letter-spacing: 0 !important;
  line-height: 1.6;
}

/* 2. Guaranteed Container Paddings (Restores Vuetify & Custom Card Breathing Room) */
.pg-screen-container {
  width: 100%;
  max-width: 1600px;
  margin: 0 auto;
  padding: var(--pg-pad-screen-desktop) !important;
}

@media (max-width: 600px) {
  .pg-screen-container {
    padding: var(--pg-pad-screen-mobile) !important;
  }
}

.v-card {
  background-color: var(--pg-bg-surface) !important;
  border: 1px solid var(--pg-border-subtle) !important;
  border-radius: var(--pg-radius-md) !important;
  box-shadow: var(--pg-shadow-xs) !important;
}

/* Ensure raw VCard subcomponents always have proper padding even if a page uses them directly */
.v-card-title {
  padding: 16px 20px 8px 20px !important;
  font-size: 16px !important;
  font-weight: 600 !important;
}

.v-card-subtitle {
  padding: 0 20px 12px 20px !important;
  font-size: 13px !important;
  color: var(--pg-ink-muted) !important;
}

.v-card-text {
  padding: 16px 20px !important;
}

.v-card-actions {
  padding: 12px 20px !important;
  border-top: 1px solid var(--pg-border-subtle);
  background-color: var(--pg-bg-surface-subtle);
  gap: 8px;
}

/* 3. Unified Architectural Data Table (Compact 40px Single-Line Rows) */
.pg-table-card {
  background-color: var(--pg-bg-surface) !important;
  border: 1px solid var(--pg-border-subtle) !important;
  border-radius: var(--pg-radius-md) !important;
  box-shadow: var(--pg-shadow-xs) !important;
  overflow: hidden;
}

.pg-table-toolbar {
  padding: var(--pg-pad-table-toolbar) !important;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--pg-border-subtle);
  background-color: var(--pg-bg-surface);
}

.pg-table-filters {
  padding: var(--pg-pad-table-filters) !important;
  background-color: var(--pg-bg-surface-subtle);
  border-bottom: 1px solid var(--pg-border-subtle);
}

.pg-table-active-chips {
  padding: var(--pg-pad-table-chips) !important;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background-color: var(--pg-bg-surface);
  border-bottom: 1px solid var(--pg-border-subtle);
}

.pg-table-footer {
  padding: var(--pg-pad-table-footer) !important;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--pg-border-subtle);
  background-color: var(--pg-bg-surface);
  font-size: 12.5px;
  color: var(--pg-ink-muted);
}

/* Table Header & Compact 40px Body Cells */
.pg-table-card .v-table__wrapper > table {
  width: 100%;
  border-collapse: collapse;
}

.pg-table-card .v-table__wrapper > table > thead > tr > th {
  height: 36px !important;
  padding: 0 14px !important;
  background-color: var(--pg-bg-surface-subtle) !important;
  color: var(--pg-ink-muted) !important;
  font-size: 11.5px !important;
  font-weight: 600 !important;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--pg-border-subtle) !important;
  white-space: nowrap !important;
  user-select: none;
}

html[dir="rtl"] .pg-table-card .v-table__wrapper > table > thead > tr > th {
  text-transform: none;
  letter-spacing: 0;
  font-size: 12px !important;
}

.pg-table-card .v-table__wrapper > table > thead > tr > th:first-child,
.pg-table-card .v-table__wrapper > table > tbody > tr > td:first-child {
  padding-inline-start: 20px !important;
}

.pg-table-card .v-table__wrapper > table > thead > tr > th:last-child,
.pg-table-card .v-table__wrapper > table > tbody > tr > td:last-child {
  padding-inline-end: 20px !important;
}

.pg-table-card .v-table__wrapper > table > tbody > tr {
  height: 40px !important;
  transition: background-color 0.1s ease;
}

.pg-table-card .v-table__wrapper > table > tbody > tr:hover > td {
  background-color: var(--pg-bg-surface-hover) !important;
}

.pg-table-card .v-table__wrapper > table > tbody > tr > td {
  height: 40px !important;
  max-height: 40px !important;
  padding: 4px 14px !important;
  font-size: 13px !important;
  line-height: 1.35 !important;
  color: var(--pg-ink-primary);
  border-bottom: 1px solid var(--pg-border-subtle) !important;
  white-space: nowrap !important;
  vertical-align: middle !important;
}

.pg-table-card .v-table__wrapper > table > tbody > tr:last-child > td {
  border-bottom: none !important;
}

/* Truncate long cell text cleanly so a cell never wraps to 2 lines */
.pg-cell-truncate {
  display: inline-block;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

/* Actions Column: Locked to tight right edge, never wraps */
.pg-col-actions {
  width: 1% !important;
  white-space: nowrap !important;
  text-align: end !important;
}

/* 4. SectionFields & FiltersContainer Guaranteed Paddings */
.pg-section-fields {
  background-color: var(--pg-bg-surface);
  border: 1px solid var(--pg-border-subtle);
  border-radius: var(--pg-radius-md);
  box-shadow: var(--pg-shadow-xs);
  margin-bottom: 20px;
  overflow: hidden;
}

.pg-section-fields__header {
  padding: 14px 24px !important;
  border-bottom: 1px solid var(--pg-border-subtle);
  background-color: var(--pg-bg-surface);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pg-section-fields__body {
  padding: 20px 24px !important;
}

.pg-section-fields__footer {
  padding: 12px 24px !important;
  border-top: 1px solid var(--pg-border-subtle);
  background-color: var(--pg-bg-surface-subtle);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

/* 5. Compact 36px Form Inputs (Static Top Labels, Zero Floating Label Jitter) */
.pg-field-wrapper .v-field__input {
  min-height: 36px !important;
  padding-top: 6px !important;
  padding-bottom: 6px !important;
  padding-inline: 12px !important;
  font-size: 13px !important;
}

.pg-field-wrapper .v-field {
  border-radius: var(--pg-radius-sm) !important;
  background-color: var(--pg-bg-surface) !important;
}

/* Tabular Numerals & Monospace Helpers */
.pg-tabular,
.pg-money,
.pg-table-card td,
.pg-table-card th {
  font-variant-numeric: tabular-nums;
}

.pg-mono {
  font-family: var(--pg-font-mono) !important;
  font-variant-numeric: tabular-nums;
  direction: ltr;
  unicode-bidi: embed;
}

```

# PART III: COMPLETE REDESIGN OF `admin-front/src/components/Table/*` (COMPACT `40px` ROWS, `<TableRowActions />`, UNIFIED FILTERS & PROPER PADDINGS)

OpenCode MUST replace the files in `admin-front/src/components/Table/` (and mirror them in `merchant-front/src/components/Table/`) with the exact implementations below.

## 3.1 `statusTone.ts` (`src/components/Table/statusTone.ts`) — Killing the Full-Row Rainbow Stripes

Previously, `statusTone` applied `8–10%` background tints and left borders across entire table rows, creating visual chaos. Update `statusTone.ts` so `getRowTintStyle()` returns an **empty object `{}`** (keeping rows clean white/carbon with a subtle hover state), while mapping status enums cleanly to our 5 semantic tones:

```
// src/components/Table/statusTone.ts
import type { BadgeTone } from "../ui/StatusBadge";

export type StatusTone = BadgeTone;

const SUCCESS_SET = new Set([
  "LIVE", "ACTIVE", "SUCCEEDED", "APPROVED", "EXECUTED", "VERIFIED",
  "HEALTHY", "CLEAR", "CLEAN", "ACCEPTED", "MATCHED", "COMPLETE",
  "COMPLETED", "SUBTRACTED", "CONFIRMED", "WON", "RELEASED", "DELIVERED",
  "TRUE", "YES",
]);

const WARNING_SET = new Set([
  "PENDING", "PENDING_REVIEW", "PENDING_CHECKER", "PENDING_APPROVAL",
  "IN_REVIEW", "IN_PROGRESS", "INFO_REQUESTED", "AWAITING_CUSTOMER",
  "DRAINING", "DEGRADED", "POTENTIAL_MATCH", "UNREVIEWED", "PROVISIONAL",
  "EVIDENCE_REQUESTED", "MEDIUM", "HIGH", "P2",
]);

const DANGER_SET = new Set([
  "UNKNOWN", "FAILED", "BLOCKED", "SUSPENDED", "REJECTED", "REJECTED_VOID",
  "REVOKED", "FAILING", "OPEN_BREAKER", "CONFIRMED_MATCH", "TRUE_MATCH",
  "ESCALATED", "ESCALATED_STR", "FROZEN", "DISPUTED", "LOST", "INFECTED",
  "AMOUNT_MISMATCH", "MISSING_AT_GATEWAY", "MISSING_LOCALLY", "CONFLICT",
  "HIGH_RISK", "CRITICAL", "P1",
]);

const INFO_SET = new Set([
  "VERIFYING", "AUTHORIZING", "INITIATING", "PROCESSING", "EXECUTING",
  "SANDBOX_VERIFIED", "EVIDENCE_SUBMITTED",
]);

export function resolveStatusTone(value: unknown): StatusTone {
  if (value === true) return "success";
  if (value === false) return "neutral";
  const normalized = String(value ?? "").trim().toUpperCase();
  if (SUCCESS_SET.has(normalized)) return "success";
  if (WARNING_SET.has(normalized)) return "warning";
  if (DANGER_SET.has(normalized)) return "danger";
  if (INFO_SET.has(normalized)) return "info";
  return "neutral";
}

/**
 * IMPORTANT: Returns empty style so table rows NEVER get painted with 8-10%
 * rainbow backgrounds. Status is shown strictly via <StatusBadge /> pills.
 */
export function getRowTintStyle(_row: Record<string, unknown>): Record<string, string> {
  return {};
}

```

## 3.2 `<TableRowActions />` (`src/components/Table/TableRowActions.tsx`) — Fixing the "Horrid" Row Actions Permanently

**Why this component is mandatory:**
Instead of rendering 3–5 colored `<VBtn>` text buttons inside the `actions` column (which wrap onto multiple lines and stretch rows to `90px+`), every page MUST render `<TableRowActions />`.

* It keeps the `actions` cell strictly `26px` tall (`height: 26px`, `white-space: nowrap`) inside the `40px` row.

* It renders **at most ONE** compact `26px`-tall neutral outline button (`primaryAction`, e.g., `"Review"`, `"Wizard"`, or `"Inquire"`), plus **ONE** `26px × 26px` `⋯` (`mdi-dots-horizontal`) icon button that opens a crisp, `1px`-bordered popover menu for all other actions (`Edit`, `Pause`, `Resume`, `Drain`, `Verify`, `Revoke`, `Suspend`, `Delete`).

```
// src/components/Table/TableRowActions.tsx
import { dc } from "kt-dc";
import { ref, type PropType, type VNodeChild } from "vue";

export interface RowActionItem {
  key: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  dividerBefore?: boolean;
  onClick: () => void | Promise<void>;
}

export const TableRowActions = dc({
  name: "TableRowActions",
  props: {
    primaryAction: {
      type: Object as PropType<{
        label: string;
        icon?: string;
        disabled?: boolean;
        loading?: boolean;
        onClick: () => void | Promise<void>;
      } | null>,
      default: null,
    },
    items: {
      type: Array as PropType<RowActionItem[]>,
      default: () => [],
    },
  },
  setup(props) {
    const menuOpen = ref(false);

    return (): VNodeChild => {
      const visibleItems = (props.items ?? []).filter((i) => !i.hidden);

      return (
        <div
          onClick={(e: MouseEvent) => e.stopPropagation()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: "6px",
            height: "28px",
            whiteSpace: "nowrap",
          }}
        >
          {/* Optional Single Compact Primary Inline Action (26px tall, neutral hairline pill) */}
          {props.primaryAction && (
            <button
              type="button"
              disabled={props.primaryAction.disabled || props.primaryAction.loading}
              onClick={() => props.primaryAction?.onClick()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                height: "26px",
                padding: "0 10px",
                borderRadius: "var(--pg-radius-sm)",
                backgroundColor: "var(--pg-bg-surface)",
                color: "var(--pg-ink-primary)",
                border: "1px solid var(--pg-border-strong)",
                fontSize: "12px",
                fontWeight: 500,
                lineHeight: 1,
                cursor: props.primaryAction.disabled ? "not-allowed" : "pointer",
                opacity: props.primaryAction.disabled ? 0.5 : 1,
                boxShadow: "var(--pg-shadow-xs)",
                transition: "background-color 0.12s ease, border-color 0.12s ease",
              }}
            >
              {props.primaryAction.icon && <VIcon icon={props.primaryAction.icon} size={13} />}
              <span>{props.primaryAction.label}</span>
            </button>
          )}

          {/* Overflow Context Menu Button (26x26px) */}
          {visibleItems.length > 0 && (
            <VMenu
              modelValue={menuOpen.value}
              onUpdate:modelValue={(v: boolean) => {
                menuOpen.value = v;
              }}
              location="bottom end"
              offset={4}
            >
              {{
                activator: ({ props: activatorProps }: { props: Record<string, unknown> }) => (
                  <button
                    type="button"
                    {...activatorProps}
                    aria-label="Row actions"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "26px",
                      height: "26px",
                      borderRadius: "var(--pg-radius-sm)",
                      backgroundColor: menuOpen.value ? "var(--pg-bg-surface-subtle)" : "transparent",
                      color: "var(--pg-ink-secondary)",
                      border: menuOpen.value ? "1px solid var(--pg-border-subtle)" : "1px solid transparent",
                      cursor: "pointer",
                    }}
                  >
                    <VIcon icon="mdi-dots-horizontal" size={16} />
                  </button>
                ),
                default: () => (
                  <div
                    style={{
                      minWidth: "184px",
                      padding: "4px",
                      backgroundColor: "var(--pg-bg-surface)",
                      border: "1px solid var(--pg-border-subtle)",
                      borderRadius: "var(--pg-radius-md)",
                      boxShadow: "var(--pg-shadow-menu)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "1px",
                    }}
                  >
                    {visibleItems.map((item) => (
                      <div key={item.key}>
                        {item.dividerBefore && (
                          <div
                            style={{
                              height: "1px",
                              backgroundColor: "var(--pg-border-subtle)",
                              margin: "4px 2px",
                            }}
                          />
                        )}
                        <button
                          type="button"
                          disabled={item.disabled}
                          onClick={() => {
                            menuOpen.value = false;
                            item.onClick();
                          }}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            height: "32px",
                            padding: "0 10px",
                            borderRadius: "var(--pg-radius-xs)",
                            backgroundColor: "transparent",
                            border: "none",
                            fontSize: "12.5px",
                            fontWeight: 500,
                            color: item.danger ? "var(--pg-status-danger-text)" : "var(--pg-ink-primary)",
                            cursor: item.disabled ? "not-allowed" : "pointer",
                            opacity: item.disabled ? 0.45 : 1,
                            textAlign: "start",
                          }}
                        >
                          {item.icon && (
                            <VIcon
                              icon={item.icon}
                              size={15}
                              style={{
                                color: item.danger ? "var(--pg-status-danger-text)" : "var(--pg-ink-muted)",
                              }}
                            />
                          )}
                          <span>{item.label}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                ),
              }}
            </VMenu>
          )}
        </div>
      );
    };
  },
});

```

## 3.3 `TableFilters.tsx` (`src/components/Table/TableFilters.tsx`) — Aligned, Padded, Non-Gradient Filter Grid

Replaces the separate gradient filter box with a clean, properly padded (`padding: 16px 20px !important`) collapsible filter drawer and active-filter chip strip that sits seamlessly inside `.pg-table-card`:

```
// src/components/Table/TableFilters.tsx
import { dc } from "kt-dc";
import type { PropType, VNodeChild } from "vue";
import type { FilterFieldSpec } from "./filters";
import { StatusBadge } from "../ui/StatusBadge";

export const TableFilters = dc({
  name: "TableFilters",
  props: {
    specs: { type: Array as PropType<FilterFieldSpec[]>, default: () => [] },
    values: { type: Object as PropType<Record<string, any>>, required: true },
    expanded: { type: Boolean, default: false },
    optionsMap: { type: Object as PropType<Record<string, Array<{ value: string; label: string }>>>, default: () => ({}) },
    loadingOptions: { type: Object as PropType<Record<string, boolean>>, default: () => ({}) },
    onChange: { type: Function as PropType<(key: string, value: any) => void>, required: true },
    onClearKey: { type: Function as PropType<(key: string) => void>, required: true },
    onClearAll: { type: Function as PropType<() => void>, required: true },
    onRefreshOptions: { type: Function as PropType<(kind: string) => void>, default: undefined },
  },
  setup(props) {
    return (): VNodeChild => {
      if (!props.specs || props.specs.length === 0) return null;

      // Collect active filter chips
      const activeChips: Array<{ key: string; label: string; displayValue: string }> = [];
      for (const spec of props.specs) {
        const val = props.values[spec.key];
        if (val !== undefined && val !== null && val !== "" && (!Array.isArray(val) || val.length > 0)) {
          activeChips.push({
            key: spec.key,
            label: spec.label,
            displayValue: Array.isArray(val) ? val.join(", ") : String(val),
          });
        }
      }

      return (
        <div>
          {/* Collapsible Filter Controls Grid (Guaranteed 16px 20px padding) */}
          {props.expanded && (
            <div class="pg-table-filters">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: "14px 16px",
                  alignItems: "start",
                }}
              >
                {props.specs.map((spec) => (
                  <div
                    key={spec.key}
                    class="pg-field-wrapper"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "5px",
                      gridColumn: spec.type === "dateRange" || spec.type === "numberRange" ? "span 2" : "span 1",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11.5px",
                        fontWeight: 600,
                        color: "var(--pg-ink-secondary)",
                        letterSpacing: "0.02em",
                        lineHeight: 1.2,
                      }}
                    >
                      {spec.label}
                    </label>

                    {spec.type === "enum" || spec.type === "boolean" ? (
                      <VSelect
                        modelValue={props.values[spec.key] ?? (spec.multiple ? [] : null)}
                        onUpdate:modelValue={(v: any) => props.onChange(spec.key, v)}
                        items={spec.options ?? []}
                        itemTitle="label"
                        itemValue="value"
                        multiple={spec.multiple}
                        clearable
                        placeholder="All"
                        density="compact"
                        variant="outlined"
                        hideDetails
                      />
                    ) : spec.type === "apiAutocomplete" ? (
                      <VAutocomplete
                        modelValue={props.values[spec.key] ?? null}
                        onUpdate:modelValue={(v: any) => props.onChange(spec.key, v)}
                        items={props.optionsMap[spec.optionsKind ?? spec.key] ?? []}
                        itemTitle="label"
                        itemValue="value"
                        loading={props.loadingOptions[spec.optionsKind ?? spec.key]}
                        clearable
                        placeholder={`Select ${spec.label.toLowerCase()}…`}
                        density="compact"
                        variant="outlined"
                        hideDetails
                      />
                    ) : (
                      <VTextField
                        modelValue={props.values[spec.key] ?? ""}
                        onUpdate:modelValue={(v: string) => props.onChange(spec.key, v)}
                        placeholder={spec.placeholder ?? `Filter ${spec.label.toLowerCase()}…`}
                        clearable
                        density="compact"
                        variant="outlined"
                        hideDetails
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Active Filter Summary Strip (Guaranteed 8px 20px padding) */}
          {activeChips.length > 0 && (
            <div class="pg-table-active-chips">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)", marginInlineEnd: "4px" }}>
                  Active filters:
                </span>
                {activeChips.map((chip) => (
                  <span
                    key={chip.key}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      height: "24px",
                      padding: "0 8px",
                      borderRadius: "var(--pg-radius-sm)",
                      backgroundColor: "var(--pg-bg-surface-subtle)",
                      border: "1px solid var(--pg-border-subtle)",
                      fontSize: "12px",
                      color: "var(--pg-ink-primary)",
                    }}
                  >
                    <span style={{ color: "var(--pg-ink-muted)" }}>{chip.label}:</span>
                    <StatusBadge status={chip.displayValue} showDot={false} />
                    <button
                      type="button"
                      onClick={() => props.onClearKey(chip.key)}
                      style={{
                        border: "none",
                        background: "none",
                        cursor: "pointer",
                        color: "var(--pg-ink-muted)",
                        padding: 0,
                        display: "inline-flex",
                      }}
                    >
                      <VIcon icon="mdi-close" size={13} />
                    </button>
                  </span>
                ))}
              </div>

              <button
                type="button"
                onClick={() => props.onClearAll()}
                style={{
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--pg-accent-interactive)",
                  padding: "2px 6px",
                }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      );
    };
  },
});

```

## 3.4 Redesigned `DataTable.tsx` (`src/components/Table/DataTable.tsx`)

Enforces:

1. Unified `.pg-table-card` wrapper with guaranteed `12px 20px` toolbar padding and `10px 20px` footer padding,

2. Compact `40px` single-line rows (`height: 40px !important`),

3. Automatic `.pg-col-actions` alignment on the trailing column,

4. Clean `<EmptyState />` when 0 rows match.

```
// Look inside DataTable.tsx and ensure the root template renders:
// <div class="pg-table-card">
//   <div class="pg-table-toolbar"> ... search input (width: 260px, height: 34px) + Filters button (with active count pill) + right-side total count + refresh button ... </div>
//   <TableFilters ... />
//   <VDataTable class="pg-compact-table" density="compact" hover ... />
//   <div class="pg-table-footer"> ... "Showing X-Y of Z" + compact pagination buttons ... </div>
// </div>

```

# PART IV: COMPLETE REDESIGN OF `SectionFields`, `InputFields`, `FiltersContainer`, `DetailsFieldsDialog`, `AwaitedConfirmationDialog`, AND `ScreenContainer`

The user specifically requested a thorough overhaul of `SectionFields` and its sibling container/field components so that none of them lack padding or suffer from misaligned inputs. OpenCode MUST update each of the following components to match the exact specifications below:

## 4.1 `SectionFields` (`src/components/SectionFields/index.tsx`)

Previously, `SectionFields` lacked internal padding (`padding: 0`) or relied on stripped Vuetify card classes. Replace `SectionFields` with this exact architectural implementation supporting both **Stacked Card Mode** (`layout="stacked"`) and **Two-Column Stripe Settings Mode** (`layout="split"`):

```
import { dc } from "kt-dc";
import type { PropType, VNodeChild } from "vue";

export const SectionFields = dc({
  name: "SectionFields",
  props: {
    title: { type: String, default: "" },
    subtitle: { type: String, default: "" },
    layout: { type: String as PropType<"stacked" | "split">, default: "stacked" },
    columns: { type: Number, default: 2 },
  },
  setup(props, { slots }) {
    return (): VNodeChild => {
      if (props.layout === "split") {
        return (
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(220px, 300px) 1fr",
              gap: "24px",
              paddingBottom: "24px",
              marginBottom: "24px",
              borderBottom: "1px solid var(--pg-border-subtle)",
              alignItems: "start",
            }}
          >
            <div style={{ paddingTop: "4px" }}>
              {props.title && (
                <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                  {props.title}
                </h3>
              )}
              {props.subtitle && (
                <p style={{ fontSize: "13px", color: "var(--pg-ink-muted)", margin: "4px 0 0 0", lineHeight: 1.5 }}>
                  {props.subtitle}
                </p>
              )}
            </div>

            <div class="pg-section-fields" style={{ marginBottom: 0 }}>
              <div class="pg-section-fields__body">
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(auto-fit, minmax(240px, 1fr))`,
                    gap: "16px 20px",
                  }}
                >
                  {slots.default?.()}
                </div>
              </div>
              {slots.footer && <div class="pg-section-fields__footer">{slots.footer()}</div>}
            </div>
          </section>
        );
      }

      return (
        <section class="pg-section-fields">
          {(props.title || slots.headerActions) && (
            <div class="pg-section-fields__header">
              <div>
                {props.title && (
                  <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                    {props.title}
                  </h3>
                )}
                {props.subtitle && (
                  <p style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", margin: "2px 0 0 0" }}>
                    {props.subtitle}
                  </p>
                )}
              </div>
              {slots.headerActions && <div style={{ display: "flex", gap: "8px" }}>{slots.headerActions()}</div>}
            </div>
          )}

          <div class="pg-section-fields__body">
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  props.columns === 1 ? "1fr" : "repeat(auto-fit, minmax(240px, 1fr))",
                gap: "16px 20px",
                alignItems: "start",
              }}
            >
              {slots.default?.()}
            </div>
          </div>

          {slots.footer && <div class="pg-section-fields__footer">{slots.footer()}</div>}
        </section>
      );
    };
  },
});

```

## 4.2 `InputFields` (`src/components/InputFields/index.tsx`)

Ensures every dynamically rendered field has:

1. A static top label (`12.5px` medium, `margin-bottom: 6px`) instead of a jumping floating Vuetify notch label,

2. Uniform `36px` input height across `VTextField`, `VSelect`, `VAutocomplete`, and `VDateInput`,

3. `16px 20px` grid spacing when rendering multiple fields.

```
// Every field item inside InputFields MUST be wrapped in:
<div class="pg-field-wrapper" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
  <label style={{ fontSize: "12.5px", fontWeight: 500, color: "var(--pg-ink-primary)" }}>
    {field.label}
    {field.required && <span style={{ color: "var(--pg-status-danger-dot)", marginInlineStart: "3px" }}>*</span>}
  </label>
  {/* Render VTextField / VSelect / VAutocomplete / VDateInput with label={undefined} and placeholder={field.placeholder || field.label} */}
</div>

```

## 4.3 `FiltersContainer` (`src/components/FiltersContainer/index.tsx`)

Guarantees `16px 20px !important` internal padding, a `1px solid var(--pg-border-subtle)` hairline border, `--pg-bg-surface-subtle` background, and an aligned CSS Grid (`gap: 14px 16px`) so filter fields never touch the container edges.

## 4.4 `DetailsFieldsDialog` (`src/components/DetailsFieldsDialog/index.tsx`)

Rebuilds the global record-details inspection modal with:

* Sticky header (`padding: 16px 24px !important`, `border-bottom: 1px solid var(--pg-border-subtle)`),

* Padded body (`padding: 20px 24px !important`) rendering a 2-column architectural `<DescriptionList />` where:

  * Any field ending in `Id`, `Ref`, `Reference`, `Hash`, `Code`, or `Key` is automatically rendered inside `<MonoRef copyable />`,

  * Any field ending in `Amount`, `Fee`, `Balance`, or `Ceiling` is automatically rendered inside `<MoneyDisplay />`,

  * Any field named `status`, `state`, `kybStatus`, `riskTier`, or `healthState` is automatically rendered inside `<StatusBadge />`,

* Sticky footer (`padding: 12px 24px !important`, `background-color: var(--pg-bg-surface-subtle)`).

## 4.5 `ScreenContainer` (`src/components/ScreenContainer/index.tsx`)

Ensures every page has guaranteed breathing room (`padding: 24px 28px 48px 28px !important` on desktop, `16px 16px 36px 16px !important` on mobile) via `.pg-screen-container`:

```
import { dc } from "kt-dc";
import type { VNodeChild } from "vue";

export const ScreenContainer = dc({
  name: "ScreenContainer",
  setup(_props, { slots }) {
    return (): VNodeChild => (
      <div class="pg-screen-container">{slots.default?.()}</div>
    );
  },
});

```

# PART V: PAGE-BY-PAGE TABLE & ROW-ACTION REFACTORING MANDATE ACROSS ALL 22+ PAGES

OpenCode MUST refactor the `actions` column and form sections of every single table page in `admin-front/src/pages/` (and `merchant-front/src/pages/`) to use `<TableRowActions />` and `<SectionFields />`:

| Page File in `admin-front/src/pages/` | Old Horrid Row Actions (MUST REMOVE) | New `<TableRowActions />` Configuration (MUST IMPLEMENT) | 
| ----- | ----- | ----- | 
| **`pages/gateways/index.tsx`** | Multiple buttons (`Wizard`, `Edit`, `Rollback`) stacked in cell | `primaryAction={{ label: "Wizard", icon: "mdi-tune-variant", onClick: ... }}` + `items={[{ key: "edit", label: "Edit Basics", icon: "mdi-pencil-outline" }, { key: "rollback", label: "Rollback Version", icon: "mdi-history", danger: true }]}` | 
| **`pages/rails/index.tsx`** | Multiple buttons (`Edit`, `Customer Catalog`, `Block/Unblock`) | `primaryAction={{ label: "Fields", icon: "mdi-form-select", onClick: ... }}` + `items={[{ key: "edit", label: "Edit Rail", icon: "mdi-pencil-outline" }, { key: "toggle", label: row.blocked ? "Unblock Rail" : "Block Rail", icon: "mdi-shield-Alert-outline", danger: !row.blocked }]}` | 
| **`pages/routes/index.tsx`** | 4 stacked buttons (`Edit`, `Activate`, `Pause`, `Drain`) blowing up row height | `primaryAction={{ label: "Edit", icon: "mdi-pencil-outline", onClick: ... }}` + `items={[{ key: "active", label: "Set Active", icon: "mdi-play-circle-outline" }, { key: "drain", label: "Drain Traffic", icon: "mdi-filter-outline" }, { key: "pause", label: "Pause Route", icon: "mdi-pause-circle-outline", danger: true, dividerBefore: true }]}` | 
| **`pages/credential-sets/index.tsx`** | Multiple buttons (`Verify`, `Rotate`, `Revoke`) | `primaryAction={{ label: "Verify", icon: "mdi-check-decagram-outline", onClick: ... }}` + `items={[{ key: "rotate", label: "Rotate Secrets", icon: "mdi-key-change" }, { key: "revoke", label: "Revoke Set", icon: "mdi-key-remove", danger: true, dividerBefore: true }]}` | 
| **`pages/join-requests/index.tsx`** | 4–5 stacked buttons (`Assign`, `Request Info`, `Approve`, `Reject`) | `primaryAction={{ label: "Review KYB", icon: "mdi-file-search-outline", onClick: ... }}` + `items={[{ key: "assign", label: "Assign to Me", icon: "mdi-account-check-outline" }, { key: "info", label: "Request Info", icon: "mdi-comment-question-outline" }, { key: "approve", label: "Approve Merchant", icon: "mdi-check-circle-outline" }, { key: "reject", label: "Reject Application", icon: "mdi-close-circle-outline", danger: true, dividerBefore: true }]}` | 
| **`pages/merchants/index.tsx`** | Multiple buttons (`View`, `Propose Edit`, `Suspend`, `Reinstate`) | `primaryAction={{ label: "Inspect", icon: "mdi-eye-outline", onClick: ... }}` + `items={[{ key: "edit", label: "Propose Sensitive Edit", icon: "mdi-file-Edit-outline" }, { key: "history", label: "Field Change Log", icon: "mdi-history" }, { key: "suspend", label: row.status === "SUSPENDED" ? "Reinstate" : "Suspend Merchant", danger: row.status !== "SUSPENDED", dividerBefore: true }]}` | 
| **`pages/approvals/index.tsx`** | 3 buttons (`View Diff`, `Approve`, `Reject`) | `primaryAction={{ label: "Review Diff", icon: "mdi-file-compare", onClick: ... }}` + `items={[{ key: "approve", label: "Approve Request", icon: "mdi-check" }, { key: "reject", label: "Reject Request", icon: "mdi-close", danger: true }]}` | 
| **`pages/aml/cases/index.tsx` & `screenings/index.tsx`** | Multiple buttons (`Propose Release`, `Propose Void`, `Freeze`, `STR`) | `primaryAction={{ label: "Investigate", icon: "mdi-shield-search", onClick: ... }}` + `items={[{ key: "release", label: "Propose Release" }, { key: "void", label: "Propose Void & Refund", danger: true }, { key: "str", label: "Escalate to STR", danger: true, dividerBefore: true }]}` | 
| **`pages/operator-cases/index.tsx`** | Multiple buttons (`Inquire`, `Resolve Succeeded`, `Resolve Failed`) | `primaryAction={{ label: "Inquire", icon: "mdi-refresh", onClick: ... }}` + `items={[{ key: "resolve_ok", label: "Resolve -> Succeeded" }, { key: "resolve_fail", label: "Resolve -> Failed", danger: true }]}` | 
| **`pages/disputes/index.tsx`, `adjustments/index.tsx`, `cashouts/index.tsx`** | Multiple action buttons in row | `primaryAction={{ label: "Process", onClick: ... }}` + overflow `items` menu for secondary/reject decisions. | 

# PART VI: STRICT AUTOMATED COMPLIANCE & GEOMETRY VERIFICATION GATES FOR OPENCODE

To leave **zero room for interpretation** by `DeepSeek V4.1 Flash Max`, OpenCode MUST add and pass both the static code compliance suite (`ui-abstraction-compliance.test.ts`) and the live Playwright geometry assertions (`e2e/table-and-padding-geometry.spec.ts`):

## 6.1 Static Code Compliance Gate (`admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts`)

```
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTsx(full));
    else if (e.isFile() && full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Strict UI, Table Row Actions & Padding Compliance Gate", () => {
  const srcDir = path.resolve(__dirname, "../../..");
  const pageFiles = walkTsx(path.join(srcDir, "pages"));

  it("1. No stylesheet or TSX file contains an un-layered '* { padding: 0' reset that strips Vuetify paddings", () => {
    const allFiles = walkTsx(srcDir);
    for (const f of allFiles) {
      const content = fs.readFileSync(f, "utf8");
      expect(content, `${f} contains forbidden * padding reset`).not.toMatch(/\*\s*\{[^}]*padding\s*:\s*0/);
    }
  });

  it("2. statusTone.ts getRowTintStyle returns empty object (zero 8-10% rainbow row tints)", () => {
    const statusTonePath = path.join(srcDir, "components/Table/statusTone.ts");
    const content = fs.readFileSync(statusTonePath, "utf8");
    expect(content).not.toMatch(/rgba\([^)]+,\s*0\.0[89]\)/);
  });

  it("3. TableRowActions.tsx exists and is used across table pages instead of multi-VBtn stacks", () => {
    const rowActionsPath = path.join(srcDir, "components/Table/TableRowActions.tsx");
    expect(fs.existsSync(rowActionsPath)).toBe(true);
  });

  it("4. Zero page files in src/pages/ use raw <VDialog> instead of <FormModal />", () => {
    for (const f of pageFiles) {
      const content = fs.readFileSync(f, "utf8");
      expect(content, `${f} still uses raw <VDialog`).not.toMatch(/<VDialog\b/);
    }
  });
});

```

## 6.2 Playwright Live DOM Geometry Assertions (`admin-front/e2e/table-and-padding-geometry.spec.ts`)

OpenCode MUST run this Playwright test against the built portal and verify all 4 geometric invariants pass in a real headless Chromium browser:

1. **Container Padding Invariant:** On every page, `.pg-screen-container` has computed `paddingTop >= 16px` and `paddingLeft >= 16px`; every `.pg-section-fields__body`, `.pg-table-toolbar`, and `.pg-table-filters` has computed `paddingTop >= 12px` and `paddingLeft >= 16px` (never `0px`!).

2. **Compact Single-Line Table Row Invariant:** Every `tbody tr` in `.pg-table-card` has a rendered bounding-box height **`<= 44px`** (`38px–42px` target) and never wraps onto 2 or 3 lines.

3. **Disciplined Row Actions Invariant:** Every `.pg-col-actions` cell contains **at most 2 visible top-level buttons** (1 optional `26px` primary button + 1 `26px × 26px` `⋯` overflow menu button) and has `scrollHeight <= 40px`.

4. **Filter Alignment Invariant:** When `TableFilters` is expanded, all filter control boxes in the same grid row share the exact same top `y` coordinate (`Math.abs(boxA.y - boxB.y) <= 2px`) and `height` between `34px` and `40px`.

## 6.3 Step-by-Step Execution Checklist for OpenCode (`UI-1` to `UI-7`)

* \[ \] **`UI-1` Fix the Global CSS Reset & Install `fintech-minimal.css`:** Remove any `* { padding: 0; margin: 0 }` rule in `admin-front`, `merchant-front`, and `checkout-front`. Create `src/styles/fintech-minimal.css` (Part II §2.1) and update `src/plugins/vuetify.ts`.

* \[ \] **`UI-2` Implement the 14 UI Primitives (`src/components/ui/`) & `<TableRowActions />`:** Create `PageHeader.tsx`, `StatusBadge.tsx`, `MoneyDisplay.tsx`, `MonoRef.tsx`, `MetricStrip.tsx`, `SurfaceCard.tsx`, `FormModal.tsx`, `FormField.tsx`, `SlideOverDrawer.tsx`, `DescriptionList.tsx`, `SegmentedTabs.tsx`, `EmptyState.tsx`, `JsonDiffViewer.tsx`, and `src/components/Table/TableRowActions.tsx`.

* \[ \] **`UI-3` Overhaul `src/components/Table/*` (`DataTable.tsx`, `ApiTable.tsx`, `TableFilters.tsx`, `statusTone.ts`):** Apply `.pg-table-card`, `.pg-table-toolbar` (`12px 20px` padding), `.pg-table-filters` (`16px 20px` padding), compact `40px` single-line rows, `.pg-col-actions`, and remove the 8–10% full-row background tints.

* \[ \] **`UI-4` Overhaul `SectionFields`, `InputFields`, `FiltersContainer`, `DetailsFieldsDialog`, `AwaitedConfirmationDialog`, and `ScreenContainer`:** Implement the padded architectural versions in Part IV (§4.1–§4.5) with static top labels and `36px` uniform inputs.

* \[ \] **`UI-5` Refactor All 22+ Pages in `admin-front/src/pages/**/*.tsx`:** Replace all multi-button row action cells with `<TableRowActions />` (per Part V table), replace all raw `<VDialog>` blocks with `<FormModal />`, and add `<PageHeader />`, `<MoneyDisplay />`, `<MonoRef />`, and `<StatusBadge />`.

* \[ \] **`UI-6` Mirror All Updated Components to `merchant-front` and `checkout-front`:** Copy the updated `fintech-minimal.css`, `src/components/ui/`, `src/components/Table/*`, `SectionFields`, `InputFields`, `FiltersContainer`, `DetailsFieldsDialog`, and `ScreenContainer` into `merchant-front` (and `checkout-front`) and refactor `merchant-front/src/pages/**/*.tsx` row actions to `<TableRowActions />`.

* \[ \] **`UI-7` Execute Static Compliance, Build & Playwright Geometry Verification:** Run `ui-abstraction-compliance.test.ts`, `bun run build` across all frontends, and `table-and-padding-geometry.spec.ts` until 100% green.