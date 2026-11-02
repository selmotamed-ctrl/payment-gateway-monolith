# PORTAL UI/UX DE-AI-IFICATION, COMPONENT ABSTRACTION & HUMAN-CRAFTED MINIMAL FINTECH DESIGN SYSTEM — MASTER IMPLEMENTATION BLUEPRINT FOR OPENCODE

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith` (`master` branch)  
**Primary Target Workspace:** `admin-front` (with shared primitive rollout to `merchant-front`, `checkout-front`, and `fake-rails-front`)  
**Target Execution Model:** OpenCode (`DeepSeek V4.1 Flash Max`)  
**Frontend Stack:** Vue 3 (`^3.5.22`) TSX/JSX + Vuetify 3 (`^3.10.7`) + `kt-dc` (`dc()`) + Vite (`rolldown-vite`)  
**Design Paradigm:** Architectural Minimalist FinTech (inspired by Linear, Stripe Dashboard, Mercury, and Wise — Whisper-quiet precision, hairline `1px` borders, high-trust neutral surfaces, tabular numerals, zero AI gradient/pill clutter)

---

## 0. EXECUTIVE MANDATE FOR OPENCODE (`DeepSeek V4.1 Flash Max`)

When an AI coding model generates 25+ pages of Vue/Vuetify UI without a strict primitive layer, the result looks unmistakably "AI-generated":
1. **Why the Current Portal Looks AI-Generated:**
   - **Gradient & Rainbow Row Soup:** Soft pastel gradients on filter panels (`TableFilters.tsx`), 8–10% colorful background stripes across entire table rows (`statusTone` row tints), and glowing multi-colored `VChip` pills in every column make critical financial data look like a toy dashboard.
   - **Box-in-a-Box-in-a-Box Clutter:** Pages wrap a bordered `VCard` inside another `VCard`, put a separate rounded card around filters, and another rounded card around the table—creating quadruple nested borders and uneven whitespace.
   - **Repeated Ad-Hoc Boilerplate Across 22+ Pages:** Every page in `admin-front/src/pages/**/*.tsx` manually repeats raw `<div class="d-flex justify-space-between"><h1>...</h1></div>` headers, raw `<VDialog><VCard><VCardTitle>...` modals, raw `<VRow><VCol><VCard>` stat boxes, and raw floating-label `<VTextField>` inputs with inconsistent `mb-3` / `mb-4` / `pa-4` spacing.
   - **Material Design "Chunkiness" & Jittery Floating Labels:** Default Vuetify 3 inputs use tall Material boxes with floating notch labels that animate and collide in dense forms, heavy drop shadows (`elevation-2`/`4`), and proportional numerals where `100.0000 LYD` and `1,450.2500 LYD` fail to align vertically in financial columns.

2. **Your Non-Negotiable Implementation Rules (`DeepSeek V4.1 Flash Max`):**
   - **Rule 1 — Build the 14 UI Primitives (`src/components/ui/`) First:** You MUST implement all 14 abstracted components in `src/components/ui/` (specified with verbatim TSX code in Part III) *before* touching any page in `src/pages/`.
   - **Rule 2 — Zero Raw `<VDialog>`, Zero Raw Page Headers, Zero Gradient Cards in `src/pages/`:** Every page in `src/pages/**/*.tsx` must be refactored to compose `<PageHeader />`, `<MetricStrip />`, `<SurfaceCard />`, `<FormModal />`, `<FormField />`, `<SlideOverDrawer />`, `<StatusBadge />`, `<MoneyDisplay />`, `<MonoRef />`, `<DescriptionList />`, `<SegmentedTabs />`, `<EmptyState />`, and `<JsonDiffViewer />`.
   - **Rule 3 — Enforce the Automated Anti-Boilerplate Test Gate (`Task UI-6`):** You may not mark this plan complete until `ui-abstraction-compliance.test.ts` and the Playwright geometry suite pass with zero violations.

---

# PART I: FORENSIC VISUAL AUDIT — REPLACING "AI SLOP" WITH HUMAN-CRAFTED FINTECH PRECISION

| # | UI Surface / Pattern | Current "AI-Generated" Anti-Pattern in `admin-front` (`master`) | New "Human-Crafted Minimal FinTech" Standard |
| :--- | :--- | :--- | :--- |
| **1** | **Color & Surface Hierarchy** | Saturated Vuetify primary/secondary/info colors, soft gradient backgrounds on filter bars, and tinted cards competing for attention. | **95% Neutral Architectural Canvas:** Pure alabaster/zinc canvas (`#F8FAFC` light / `#09090B` dark), crisp white/carbon elevated surfaces (`#FFFFFF` / `#121215`), and `1px solid` hairline borders (`#E2E8F0` / `#27272A`). Color is used **only** as a 6px semantic signal dot or single primary CTA. |
| **2** | **Table Row Styling (`DataTable.tsx`)** | `statusTone` paints entire table rows with `8–10%` green/yellow/red background tints + thick left stripes, creating visual noise across 200-row tables. | **Clean White/Carbon Rows with Subtle Hover (`#F1F5F9` / `#18181B`):** Status is communicated by a single refined `<StatusBadge />` cell (soft pill + `6px` dot). Only `P1` critical or overdue rows get a subtle `2px` left-border indicator on the first cell. |
| **3** | **Filter Bar + Table Relationship** | Filter panel is a separate rounded gradient card sitting above a separate rounded table card ("two stacked boxes"). | **Unified Single-Surface Table Card:** The search/quick-filter bar, collapsible advanced filter grid, active filter chips bar, data table, and pagination footer live inside **one seamless `1px`-bordered container** divided by crisp `1px` horizontal hairlines. |
| **4** | **Status Chips (`VChip`)** | Default Vuetify `VChip` in `UPPERCASE_WITH_UNDERSCORES`, varying sizes (`small`, `default`), heavy backgrounds. | **`<StatusBadge status={...} />`:** Human-readable title case (`Succeeded`, `Awaiting Customer`, `AML Hold`, `Pending Checker`), fixed `22px` height, `6px` radius, `12px` medium font, `1px` translucent border, and a `6px` solid status dot. |
| **5** | **Financial Amounts & IDs** | Plain strings (`"150.0000 LYD"` or `attempt.id`) rendered in proportional body font, causing digits to zig-zag down a column. | **`<MoneyDisplay />` & `<MonoRef />`:** Every amount uses `font-variant-numeric: tabular-nums` with integer part in high-contrast ink (`150`), decimal dirhams in muted ink (`.000`), and currency badge (`LYD`). Every ID/reference/hash uses `JetBrains Mono` (`12px`) with 1-click copy. |
| **6** | **Page Headers** | Hand-coded `<div class="d-flex...">` on every page with inconsistent `text-h4` / `text-h5`, random icons in titles, and ungrouped buttons. | **`<PageHeader />`:** Consistent `22px` (`1.375rem`) semi-bold title (`letter-spacing: -0.02em` LTR), `13.5px` muted subtitle, optional breadcrumb, and right-aligned action cluster (`Help (?)` ghost button + secondary outlined button + 1 primary button). |
| **7** | **KPI Stat Cards** | 4 separate colored/tonal `VCard` boxes with big circular Material icons and heavy drop shadows. | **`<MetricStrip />`:** A single, unified horizontal architectural bar divided into 3–5 cells by `1px` vertical hairlines (Stripe/Linear style). Clean uppercase `11px` label, `24px` tabular-numeral value, and subtle sub-metric. |
| **8** | **Modals & Dialogs (`VDialog`)** | 30+ hand-rolled `<VDialog>` blocks with raw `<VCardTitle>`, unaligned form fields, and inconsistent button placement. | **`<FormModal />` & `<FormField />`:** Standardized modal shell (`480px` / `600px` / `760px` sizes), `1px` border, subtle backdrop blur (`backdrop-filter: blur(4px)`), static top labels above inputs (zero jumping Material floating notches!), and sticky footer. |
| **9** | **Navigation Sidebar (`default.tsx`)** | Standard Vuetify list items with wide spacing, loud active highlight, and heavy icons. | **Linear/Stripe Precision Sidebar (`248px`):** Subtle canvas background (`#F8FAFC` / `#09090B`) sharing a `1px` border with the main surface, `13px` medium items (`34px` height, `6px` radius), `18px` subtle icons, `Ctrl+K` search bar at top, and compact operator badge at bottom. |
| **10** | **Bilingual Typography (`EN` LTR & `AR` RTL)** | Same line-height and letter-spacing applied to both Latin and Arabic, making Arabic (`Cairo`) look disconnected or cramped. | **Locale-Aware Optical Tuning:** `Plus Jakarta Sans` (`letter-spacing: -0.015em` on headings) for English LTR; `Cairo` (`letter-spacing: 0 !important`, `line-height: 1.65`) for Arabic RTL; `JetBrains Mono` (`dir="ltr"` forced on references, IBANs, CIDR IPs, and code). |

---

# PART II: COMPLETE DESIGN TOKENS, THEME & CSS ARCHITECTURE

## 1. Global Design Tokens & Architectural Stylesheet (`admin-front/src/styles/fintech-minimal.css`)

OpenCode MUST create `admin-front/src/styles/fintech-minimal.css` (and import it in `src/main.ts`) with the exact rules below:

```css
/* ============================================================================
 * HUMAN-CRAFTED MINIMAL FINTECH DESIGN SYSTEM (admin-front / merchant-front)
 * Aesthetic: Linear / Stripe / Wise / Mercury — Hairline 1px borders,
 * calm zinc/slate surfaces, tabular numerals, zero gradient/shadow clutter.
 * ============================================================================ */

:root {
  /* Surface Hierarchy (Light Mode — Crisp Alabaster & Pure White) */
  --pg-bg-canvas: #F8FAFC;
  --pg-bg-surface: #FFFFFF;
  --pg-bg-surface-subtle: #F1F5F9;
  --pg-bg-surface-hover: #F8FAFC;
  --pg-bg-surface-active: #EFF6FF;
  --pg-bg-glass: rgba(255, 255, 255, 0.88);

  /* Ink & Typography Hierarchy */
  --pg-ink-primary: #0F172A;
  --pg-ink-secondary: #475569;
  --pg-ink-muted: #64748B;
  --pg-ink-faint: #94A3B8;

  /* Hairline Borders & Dividers */
  --pg-border-subtle: #E2E8F0;
  --pg-border-strong: #CBD5E1;
  --pg-border-focus: #2563EB;

  /* Primary Brand & Interactive Accent (Deep FinTech Indigo-Slate) */
  --pg-accent-primary: #0F172A;
  --pg-accent-primary-hover: #1E293B;
  --pg-accent-interactive: #2563EB;
  --pg-accent-interactive-soft: rgba(37, 99, 235, 0.08);

  /* Surgical Semantic Status Tokens (Soft Tint + Crisp Border + Dot) */
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

  /* Radius & Elevation Scale */
  --pg-radius-xs: 4px;
  --pg-radius-sm: 6px;
  --pg-radius-md: 8px;
  --pg-radius-lg: 10px;
  --pg-shadow-xs: 0 1px 2px 0 rgba(15, 23, 42, 0.03);
  --pg-shadow-sm: 0 1px 3px 0 rgba(15, 23, 42, 0.05), 0 1px 2px -1px rgba(15, 23, 42, 0.03);
  --pg-shadow-modal: 0 20px 25px -5px rgba(15, 23, 42, 0.12), 0 8px 10px -6px rgba(15, 23, 42, 0.06);

  /* Font Families */
  --pg-font-sans-ltr: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --pg-font-sans-rtl: "Cairo", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --pg-font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.v-theme--dark {
  --pg-bg-canvas: #09090B;
  --pg-bg-surface: #121215;
  --pg-bg-surface-subtle: #18181C;
  --pg-bg-surface-hover: #1C1C21;
  --pg-bg-surface-active: rgba(59, 130, 246, 0.12);
  --pg-bg-glass: rgba(18, 18, 21, 0.88);

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
  --pg-accent-interactive-soft: rgba(59, 130, 246, 0.14);

  --pg-status-success-bg: rgba(22, 163, 74, 0.12);
  --pg-status-success-text: #4ADE80;
  --pg-status-success-border: rgba(74, 222, 128, 0.25);
  --pg-status-success-dot: #22C55E;

  --pg-status-warning-bg: rgba(217, 119, 6, 0.12);
  --pg-status-warning-text: #FBBF24;
  --pg-status-warning-border: rgba(251, 191, 36, 0.25);
  --pg-status-warning-dot: #F59E0B;

  --pg-status-danger-bg: rgba(220, 38, 38, 0.12);
  --pg-status-danger-text: #F87171;
  --pg-status-danger-border: rgba(248, 113, 113, 0.25);
  --pg-status-danger-dot: #EF4444;

  --pg-status-info-bg: rgba(37, 99, 235, 0.14);
  --pg-status-info-text: #60A5FA;
  --pg-status-info-border: rgba(96, 165, 250, 0.25);
  --pg-status-info-dot: #3B82F6;

  --pg-status-neutral-bg: #18181C;
  --pg-status-neutral-text: #A1A1AA;
  --pg-status-neutral-border: #27272A;
  --pg-status-neutral-dot: #71717A;
}

/* Global Typography & Optical Reset */
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
  line-height: 1.65;
}

/* Tabular Numerals for All Financial Figures, Timestamps & Counts */
.pg-tabular,
.pg-money,
.v-data-table td,
.v-data-table th {
  font-variant-numeric: tabular-nums;
}

.pg-mono {
  font-family: var(--pg-font-mono) !important;
  font-variant-numeric: tabular-nums;
  direction: ltr;
  unicode-bidi: embed;
}

/* Kill Vuetify Material Shadow Soup & Over-Rounded Cards Globally */
.v-card {
  box-shadow: var(--pg-shadow-xs) !important;
  border: 1px solid var(--pg-border-subtle);
  border-radius: var(--pg-radius-md) !important;
  background-color: var(--pg-bg-surface) !important;
}

/* Crisp, Non-Uppercased Buttons with Human Proportions */
.v-btn {
  text-transform: none !important;
  letter-spacing: -0.005em !important;
  font-weight: 500 !important;
  border-radius: var(--pg-radius-sm) !important;
  box-shadow: none !important;
}

/* Clean Table Typography & Borders */
.pg-unified-table .v-table__wrapper > table > thead > tr > th {
  background-color: var(--pg-bg-surface-subtle) !important;
  color: var(--pg-ink-muted) !important;
  font-size: 11.5px !important;
  font-weight: 600 !important;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  height: 38px !important;
  border-bottom: 1px solid var(--pg-border-subtle) !important;
  white-space: nowrap;
}

html[dir="rtl"] .pg-unified-table .v-table__wrapper > table > thead > tr > th {
  text-transform: none;
  letter-spacing: 0;
  font-size: 12.5px !important;
}

.pg-unified-table .v-table__wrapper > table > tbody > tr > td {
  height: 46px !important;
  font-size: 13.5px !important;
  color: var(--pg-ink-primary);
  border-bottom: 1px solid var(--pg-border-subtle) !important;
  transition: background-color 0.12s ease;
}

.pg-unified-table .v-table__wrapper > table > tbody > tr:hover > td {
  background-color: var(--pg-bg-surface-hover) !important;
}
```

## 2. Vuetify 3 Theme & Default Props Configuration (`admin-front/src/plugins/vuetify.ts`)

Update `src/plugins/vuetify.ts` so every Vuetify primitive defaults to flat, compact, hairline-bordered precision without requiring per-page overrides:

```ts
import { createVuetify } from "vuetify";
import { VDateInput } from "vuetify/labs/VDateInput";

export const vuetify = createVuetify({
  components: { VDateInput },
  defaults: {
    global: { ripple: false },
    VCard: { elevation: 0, rounded: "lg" },
    VBtn: {
      elevation: 0,
      rounded: "md",
      height: 36,
      class: "text-none font-weight-medium",
    },
    VTextField: {
      variant: "outlined",
      density: "compact",
      color: "primary",
      hideDetails: "auto",
    },
    VSelect: {
      variant: "outlined",
      density: "compact",
      color: "primary",
      hideDetails: "auto",
    },
    VAutocomplete: {
      variant: "outlined",
      density: "compact",
      color: "primary",
      hideDetails: "auto",
    },
    VTextarea: {
      variant: "outlined",
      density: "compact",
      color: "primary",
      hideDetails: "auto",
    },
    VChip: {
      rounded: "md",
      size: "small",
      elevation: 0,
    },
    VDialog: {
      scrim: "rgba(15, 23, 42, 0.45)",
    },
  },
  theme: {
    defaultTheme: "light",
    themes: {
      light: {
        dark: false,
        colors: {
          background: "#F8FAFC",
          surface: "#FFFFFF",
          primary: "#0F172A",
          secondary: "#2563EB",
          success: "#16A34A",
          warning: "#D97706",
          error: "#DC2626",
          info: "#2563EB",
        },
      },
      dark: {
        dark: true,
        colors: {
          background: "#09090B",
          surface: "#121215",
          primary: "#F8FAFC",
          secondary: "#3B82F6",
          success: "#22C55E",
          warning: "#F59E0B",
          error: "#EF4444",
          info: "#3B82F6",
        },
      },
    },
  },
});
```


---

# PART III: THE 14 ABSTRACTED UI PRIMITIVES (`src/components/ui/`) — COMPLETE VERBATIM TSX (`kt-dc`) CODE

To eliminate repeated ad-hoc UI code across all 22+ pages in `admin-front` (and `merchant-front`), OpenCode MUST create the following 14 components inside `src/components/ui/` and export them from `src/components/ui/index.ts`.

## 3.1 Primitive 1: `<PageHeader />` (`src/components/ui/PageHeader.tsx`)

Replaces every hand-rolled `<div class="d-flex justify-space-between"><h1>...` page header across the portal.

```tsx
import { dc } from "kt-dc";
import type { PropType, VNodeChild } from "vue";
import { StatusBadge } from "./StatusBadge";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export const PageHeader = dc({
  name: "PageHeader",
  props: {
    title: { type: String, required: true },
    subtitle: { type: String, default: "" },
    badge: { type: String, default: "" },
    badgeTone: {
      type: String as PropType<"success" | "warning" | "danger" | "info" | "neutral">,
      default: "neutral",
    },
    breadcrumbs: { type: Array as PropType<BreadcrumbItem[]>, default: () => [] },
    helpChapterId: { type: String, default: "" },
    onOpenHelp: { type: Function as PropType<(chapterId: string) => void>, default: undefined },
  },
  setup(props, { slots }) {
    return (): VNodeChild => (
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "16px",
          paddingBottom: "20px",
          marginBottom: "20px",
          borderBottom: "1px solid var(--pg-border-subtle)",
        }}
      >
        <div style={{ minWidth: "240px", flex: "1 1 auto" }}>
          {props.breadcrumbs.length > 0 && (
            <nav
              aria-label="Breadcrumb"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
                color: "var(--pg-ink-muted)",
                marginBottom: "6px",
              }}
            >
              {props.breadcrumbs.map((crumb, idx) => (
                <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  {idx > 0 && <span style={{ color: "var(--pg-ink-faint)" }}>/</span>}
                  <span>{crumb.label}</span>
                </span>
              ))}
            </nav>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <h1
              style={{
                fontSize: "22px",
                fontWeight: 600,
                lineHeight: 1.25,
                color: "var(--pg-ink-primary)",
                margin: 0,
                letterSpacing: "-0.02em",
              }}
            >
              {props.title}
            </h1>
            {props.badge && <StatusBadge status={props.badge} toneOverride={props.badgeTone} />}
          </div>

          {props.subtitle && (
            <p
              style={{
                fontSize: "13.5px",
                lineHeight: 1.5,
                color: "var(--pg-ink-secondary)",
                margin: "4px 0 0 0",
                maxWidth: "72ch",
              }}
            >
              {props.subtitle}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
            alignSelf: "center",
          }}
        >
          {props.helpChapterId && props.onOpenHelp && (
            <VBtn
              variant="outlined"
              size="small"
              prependIcon="mdi-book-open-page-variant-outline"
              style={{
                borderColor: "var(--pg-border-subtle)",
                color: "var(--pg-ink-secondary)",
                height: "36px",
              }}
              onClick={() => props.onOpenHelp?.(props.helpChapterId)}
            >
              SOP & Help
            </VBtn>
          )}
          {slots.actions?.()}
        </div>
      </header>
    );
  },
});
```

---

## 3.2 Primitive 2: `<StatusBadge />` (`src/components/ui/StatusBadge.tsx`)

Replaces all raw `<VChip>` tags and eliminates the 8–10% full-row rainbow background stripes. Renders a calm, high-precision FinTech pill with a `6px` semantic dot.

```tsx
import { dc } from "kt-dc";
import type { PropType, VNodeChild } from "vue";

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const STATUS_TO_TONE: Record<string, BadgeTone> = {
  // Positive / Live / Verified
  LIVE: "success",
  ACTIVE: "success",
  SUCCEEDED: "success",
  APPROVED: "success",
  EXECUTED: "success",
  VERIFIED: "success",
  HEALTHY: "success",
  CLEAR: "success",
  CLEAN: "success",
  ACCEPTED: "success",
  MATCHED: "success",
  COMPLETE: "success",
  COMPLETED: "success",
  SUBTRACTED: "success",
  CONFIRMED: "success",
  WON: "success",
  RELEASED: "success",
  DELIVERED: "success",
  FALSE_POSITIVE: "neutral",

  // In-Progress / Pending / Review / Warning
  PENDING: "warning",
  PENDING_REVIEW: "warning",
  PENDING_CHECKER: "warning",
  PENDING_APPROVAL: "warning",
  IN_REVIEW: "warning",
  IN_PROGRESS: "warning",
  INFO_REQUESTED: "warning",
  AWAITING_CUSTOMER: "warning",
  VERIFYING: "info",
  AUTHORIZING: "info",
  INITIATING: "info",
  PROCESSING: "info",
  EXECUTING: "info",
  SANDBOX_VERIFIED: "info",
  DRAINING: "warning",
  DEGRADED: "warning",
  POTENTIAL_MATCH: "warning",
  UNREVIEWED: "warning",
  PROVISIONAL: "warning",
  EVIDENCE_REQUESTED: "warning",
  EVIDENCE_SUBMITTED: "info",
  MEDIUM: "warning",
  HIGH: "warning",
  P2: "warning",

  // Critical / Failed / Blocked / Unknown
  UNKNOWN: "danger",
  FAILED: "danger",
  BLOCKED: "danger",
  SUSPENDED: "danger",
  REJECTED: "danger",
  REJECTED_VOID: "danger",
  REVOKED: "danger",
  FAILING: "danger",
  OPEN_BREAKER: "danger",
  CONFIRMED_MATCH: "danger",
  TRUE_MATCH: "danger",
  ESCALATED: "danger",
  ESCALATED_STR: "danger",
  FROZEN: "danger",
  DISPUTED: "danger",
  LOST: "danger",
  INFECTED: "danger",
  AMOUNT_MISMATCH: "danger",
  MISSING_AT_GATEWAY: "danger",
  MISSING_LOCALLY: "danger",
  CONFLICT: "danger",
  HIGH_RISK: "danger",
  CRITICAL: "danger",
  P1: "danger",
};

const TONE_STYLES: Record<BadgeTone, { bg: string; text: string; border: string; dot: string }> = {
  success: {
    bg: "var(--pg-status-success-bg)",
    text: "var(--pg-status-success-text)",
    border: "var(--pg-status-success-border)",
    dot: "var(--pg-status-success-dot)",
  },
  warning: {
    bg: "var(--pg-status-warning-bg)",
    text: "var(--pg-status-warning-text)",
    border: "var(--pg-status-warning-border)",
    dot: "var(--pg-status-warning-dot)",
  },
  danger: {
    bg: "var(--pg-status-danger-bg)",
    text: "var(--pg-status-danger-text)",
    border: "var(--pg-status-danger-border)",
    dot: "var(--pg-status-danger-dot)",
  },
  info: {
    bg: "var(--pg-status-info-bg)",
    text: "var(--pg-status-info-text)",
    border: "var(--pg-status-info-border)",
    dot: "var(--pg-status-info-dot)",
  },
  neutral: {
    bg: "var(--pg-status-neutral-bg)",
    text: "var(--pg-status-neutral-text)",
    border: "var(--pg-status-neutral-border)",
    dot: "var(--pg-status-neutral-dot)",
  },
};

export function formatHumanStatus(raw: string): string {
  if (!raw) return "—";
  const upper = raw.toUpperCase();
  if (upper === "AML_HOLD") return "AML Hold";
  if (upper === "KYC" || upper === "KYB" || upper === "OTP" || upper === "P1" || upper === "P2" || upper === "P3") {
    return upper;
  }
  return raw
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const StatusBadge = dc({
  name: "StatusBadge",
  props: {
    status: { type: String, required: true },
    label: { type: String, default: "" },
    toneOverride: { type: String as PropType<BadgeTone>, default: undefined },
    showDot: { type: Boolean, default: true },
  },
  setup(props) {
    return (): VNodeChild => {
      const normalized = (props.status ?? "").trim().toUpperCase();
      const tone = props.toneOverride ?? STATUS_TO_TONE[normalized] ?? "neutral";
      const palette = TONE_STYLES[tone];
      const displayLabel = props.label || formatHumanStatus(props.status);

      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            height: "22px",
            padding: "0 8px",
            borderRadius: "var(--pg-radius-sm)",
            backgroundColor: palette.bg,
            color: palette.text,
            border: `1px solid ${palette.border}`,
            fontSize: "12px",
            fontWeight: 500,
            lineHeight: 1,
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
        >
          {props.showDot && (
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "9999px",
                backgroundColor: palette.dot,
                flexShrink: 0,
              }}
            />
          )}
          <span>{displayLabel}</span>
        </span>
      );
    };
  },
});
```

---

## 3.3 Primitive 3: `<MoneyDisplay />` (`src/components/ui/MoneyDisplay.tsx`)

Formats `Decimal(18,4)` monetary strings using `decimal.js` with `tabular-nums`, rendering the whole Dinar integer in crisp primary ink and the fractional Dirhams (`.000`) in subdued secondary ink so financial columns scan effortlessly.

```tsx
import { dc } from "kt-dc";
import Decimal from "decimal.js";
import type { PropType, VNodeChild } from "vue";

export const MoneyDisplay = dc({
  name: "MoneyDisplay",
  props: {
    amount: { type: [String, Number] as PropType<string | number | null | undefined>, required: true },
    currency: { type: String, default: "LYD" },
    decimals: { type: Number, default: 3 },
    size: { type: String as PropType<"sm" | "md" | "lg" | "xl">, default: "md" },
    colorSign: { type: Boolean, default: false },
  },
  setup(props) {
    const fontSizeMap = { sm: "12.5px", md: "13.5px", lg: "18px", xl: "24px" };
    return (): VNodeChild => {
      if (props.amount === null || props.amount === undefined || props.amount === "") {
        return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
      }
      let dec: Decimal;
      try {
        dec = new Decimal(String(props.amount));
      } catch {
        return <span>{String(props.amount)}</span>;
      }

      const isNegative = dec.isNegative();
      const fixed = dec.abs().toFixed(props.decimals);
      const [intPartRaw = "0", fracPart = ""] = fixed.split(".");
      const intPart = intPartRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

      const inkColor =
        props.colorSign && isNegative
          ? "var(--pg-status-danger-text)"
          : props.colorSign && dec.gt(0)
            ? "var(--pg-status-success-text)"
            : "var(--pg-ink-primary)";

      return (
        <span
          class="pg-money pg-tabular"
          dir="ltr"
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: "4px",
            fontSize: fontSizeMap[props.size],
            fontWeight: props.size === "lg" || props.size === "xl" ? 600 : 500,
            color: inkColor,
            whiteSpace: "nowrap",
          }}
        >
          <span>
            {isNegative ? "-" : ""}
            {intPart}
            {fracPart && (
              <span style={{ color: "var(--pg-ink-muted)", fontSize: "0.88em", fontWeight: 400 }}>
                .{fracPart}
              </span>
            )}
          </span>
          <span
            style={{
              fontSize: "0.78em",
              fontWeight: 500,
              color: "var(--pg-ink-muted)",
              letterSpacing: "0.02em",
            }}
          >
            {props.currency}
          </span>
        </span>
      );
    };
  },
});
```

---

## 3.4 Primitive 4: `<MonoRef />` (`src/components/ui/MonoRef.tsx`)

Renders references (`gateway_reference`, `provider_reference`, UUIDs, SHA-256 hashes, IP CIDRs) in `JetBrains Mono` with a subtle 1-click copy micro-interaction.

```tsx
import { dc } from "kt-dc";
import { ref, type VNodeChild } from "vue";

export const MonoRef = dc({
  name: "MonoRef",
  props: {
    value: { type: String, default: "" },
    truncate: { type: Number, default: 0 },
    copyable: { type: Boolean, default: true },
  },
  setup(props) {
    const copied = ref(false);

    const copy = async (e: MouseEvent) => {
      e.stopPropagation();
      if (!props.value || !props.copyable) return;
      await navigator.clipboard?.writeText(props.value);
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 1400);
    };

    return (): VNodeChild => {
      if (!props.value) {
        return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
      }
      const shown =
        props.truncate > 0 && props.value.length > props.truncate
          ? `${props.value.slice(0, props.truncate)}…`
          : props.value;

      return (
        <span
          class="pg-mono"
          title={props.value}
          onClick={copy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 6px",
            borderRadius: "var(--pg-radius-xs)",
            backgroundColor: "var(--pg-bg-surface-subtle)",
            border: "1px solid var(--pg-border-subtle)",
            fontSize: "12px",
            color: "var(--pg-ink-primary)",
            cursor: props.copyable ? "pointer" : "default",
            userSelect: "all",
          }}
        >
          <span>{shown}</span>
          {props.copyable && (
            <VIcon
              size={12}
              icon={copied.value ? "mdi-check" : "mdi-content-copy"}
              style={{
                color: copied.value ? "var(--pg-status-success-dot)" : "var(--pg-ink-muted)",
              }}
            />
          )}
        </span>
      );
    };
  },
});
```

---

## 3.5 Primitive 5: `<MetricStrip />` (`src/components/ui/MetricStrip.tsx`)

Replaces all colorful/tonal KPI `<VRow><VCol><VCard>` blocks with a single, architectural hairline-divided metric bar (inspired by Stripe & Linear).

```tsx
import { dc } from "kt-dc";
import type { PropType, VNodeChild } from "vue";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge, type BadgeTone } from "./StatusBadge";

export interface MetricItem {
  key: string;
  label: string;
  value?: string | number;
  moneyAmount?: string | number;
  currency?: string;
  subLabel?: string;
  badge?: string;
  badgeTone?: BadgeTone;
}

export const MetricStrip = dc({
  name: "MetricStrip",
  props: {
    items: { type: Array as PropType<MetricItem[]>, required: true },
    loading: { type: Boolean, default: false },
  },
  setup(props) {
    return (): VNodeChild => (
      <section
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))`,
          backgroundColor: "var(--pg-bg-surface)",
          border: "1px solid var(--pg-border-subtle)",
          borderRadius: "var(--pg-radius-md)",
          boxShadow: "var(--pg-shadow-xs)",
          marginBottom: "20px",
          overflow: "hidden",
        }}
      >
        {props.items.map((item, idx) => (
          <div
            key={item.key}
            style={{
              padding: "16px 20px",
              borderInlineEnd:
                idx < props.items.length - 1 ? "1px solid var(--pg-border-subtle)" : "none",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: "6px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--pg-ink-muted)",
                }}
              >
                {item.label}
              </span>
              {item.badge && <StatusBadge status={item.badge} toneOverride={item.badgeTone} showDot={false} />}
            </div>

            <div class="pg-tabular" style={{ fontSize: "22px", fontWeight: 600, color: "var(--pg-ink-primary)", lineHeight: 1.2 }}>
              {props.loading ? (
                <span style={{ color: "var(--pg-ink-faint)", fontSize: "16px" }}>…</span>
              ) : item.moneyAmount !== undefined ? (
                <MoneyDisplay amount={item.moneyAmount} currency={item.currency ?? "LYD"} size="lg" />
              ) : (
                <span>{item.value ?? "0"}</span>
              )}
            </div>

            {item.subLabel && (
              <div style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{item.subLabel}</div>
            )}
          </div>
        ))}
      </section>
    );
  },
});
```

---

## 3.6 Primitive 6: `<SurfaceCard />` (`src/components/ui/SurfaceCard.tsx`)

Replaces raw `<VCard>` containers with a clean, single-bordered architectural surface.

```tsx
import { dc } from "kt-dc";
import type { VNodeChild } from "vue";

export const SurfaceCard = dc({
  name: "SurfaceCard",
  props: {
    title: { type: String, default: "" },
    subtitle: { type: String, default: "" },
    noPadding: { type: Boolean, default: false },
    subtle: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return (): VNodeChild => (
      <div
        style={{
          backgroundColor: props.subtle ? "var(--pg-bg-surface-subtle)" : "var(--pg-bg-surface)",
          border: "1px solid var(--pg-border-subtle)",
          borderRadius: "var(--pg-radius-md)",
          boxShadow: props.subtle ? "none" : "var(--pg-shadow-xs)",
          overflow: "hidden",
        }}
      >
        {(props.title || slots.headerActions) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              padding: "14px 20px",
              borderBottom: "1px solid var(--pg-border-subtle)",
            }}
          >
            <div>
              {props.title && (
                <h2 style={{ fontSize: "15px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                  {props.title}
                </h2>
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
        <div style={{ padding: props.noPadding ? "0" : "20px" }}>{slots.default?.()}</div>
        {slots.footer && (
          <div
            style={{
              padding: "12px 20px",
              backgroundColor: "var(--pg-bg-surface-subtle)",
              borderTop: "1px solid var(--pg-border-subtle)",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "8px",
            }}
          >
            {slots.footer()}
          </div>
        )}
      </div>
    );
  },
});
```

---

## 3.7 Primitive 7 & 8: `<FormModal />` & `<FormField />` (`src/components/ui/FormModal.tsx` & `FormField.tsx`)

Replaces all 30+ hand-rolled `<VDialog>` blocks and eliminates jumping Material floating labels in favor of calm, static top labels.

```tsx
// src/components/ui/FormModal.tsx
import { dc } from "kt-dc";
import type { PropType, VNodeChild } from "vue";

export const FormModal = dc({
  name: "FormModal",
  props: {
    modelValue: { type: Boolean, required: true },
    "onUpdate:modelValue": { type: Function as PropType<(v: boolean) => void>, required: true },
    title: { type: String, required: true },
    subtitle: { type: String, default: "" },
    size: { type: String as PropType<"sm" | "md" | "lg">, default: "md" },
    submitLabel: { type: String, default: "Save Changes" },
    cancelLabel: { type: String, default: "Cancel" },
    loading: { type: Boolean, default: false },
    danger: { type: Boolean, default: false },
    errorMessage: { type: String, default: "" },
    onSubmit: { type: Function as PropType<() => void | Promise<void>>, default: undefined },
  },
  setup(props, { slots }) {
    const widthMap = { sm: 460, md: 580, lg: 760 };
    const close = () => {
      if (!props.loading) props["onUpdate:modelValue"](false);
    };

    return (): VNodeChild => (
      <VDialog
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => props["onUpdate:modelValue"](v)}
        maxWidth={widthMap[props.size]}
        persistent={props.loading}
      >
        <div
          style={{
            backgroundColor: "var(--pg-bg-surface)",
            border: "1px solid var(--pg-border-subtle)",
            borderRadius: "var(--pg-radius-lg)",
            boxShadow: "var(--pg-shadow-modal)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            maxHeight: "88vh",
          }}
        >
          {/* Sticky Header */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "12px",
              padding: "16px 20px",
              borderBottom: "1px solid var(--pg-border-subtle)",
            }}
          >
            <div>
              <h3 style={{ fontSize: "16px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                {props.title}
              </h3>
              {props.subtitle && (
                <p style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", margin: "3px 0 0 0" }}>
                  {props.subtitle}
                </p>
              )}
            </div>
            <VBtn icon="mdi-close" variant="text" size="x-small" onClick={close} />
          </div>

          {/* Scrollable Body */}
          <div style={{ padding: "20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "16px" }}>
            {props.errorMessage && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--pg-radius-sm)",
                  backgroundColor: "var(--pg-status-danger-bg)",
                  border: "1px solid var(--pg-status-danger-border)",
                  color: "var(--pg-status-danger-text)",
                  fontSize: "13px",
                }}
              >
                {props.errorMessage}
              </div>
            )}
            {slots.default?.()}
          </div>

          {/* Sticky Footer */}
          {props.onSubmit && (
            <div
              style={{
                padding: "12px 20px",
                backgroundColor: "var(--pg-bg-surface-subtle)",
                borderTop: "1px solid var(--pg-border-subtle)",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: "8px",
              }}
            >
              <VBtn variant="outlined" disabled={props.loading} onClick={close}>
                {props.cancelLabel}
              </VBtn>
              <VBtn
                color={props.danger ? "error" : "primary"}
                variant="flat"
                loading={props.loading}
                onClick={() => props.onSubmit?.()}
              >
                {props.submitLabel}
              </VBtn>
            </div>
          )}
        </div>
      </VDialog>
    );
  },
});
```

```tsx
// src/components/ui/FormField.tsx
import { dc } from "kt-dc";
import type { VNodeChild } from "vue";

export const FormField = dc({
  name: "FormField",
  props: {
    label: { type: String, required: true },
    hint: { type: String, default: "" },
    required: { type: Boolean, default: false },
    sensitiveMakerChecker: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return (): VNodeChild => (
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <label style={{ fontSize: "13px", fontWeight: 500, color: "var(--pg-ink-primary)" }}>
            {props.label}
            {props.required && <span style={{ color: "var(--pg-status-danger-dot)", marginInlineStart: "3px" }}>*</span>}
          </label>
          {props.sensitiveMakerChecker && (
            <span
              style={{
                fontSize: "11px",
                fontWeight: 500,
                padding: "1px 6px",
                borderRadius: "4px",
                backgroundColor: "var(--pg-status-warning-bg)",
                color: "var(--pg-status-warning-text)",
                border: "1px solid var(--pg-status-warning-border)",
              }}
            >
              Four-Eyes Required
            </span>
          )}
        </div>
        {slots.default?.()}
        {props.hint && (
          <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)", lineHeight: 1.4 }}>{props.hint}</span>
        )}
      </div>
    );
  },
});
```

---

## 3.8 Primitives 9–14: `<SlideOverDrawer />`, `<DescriptionList />`, `<SegmentedTabs />`, `<EmptyState />`, `<JsonDiffViewer />`, and Redesigned `TableFilters.tsx`

1. **`<SlideOverDrawer />` (`src/components/ui/SlideOverDrawer.tsx`):**
   - Right-hand `VNavigationDrawer` (`location="end"`, `temporary`, `width={560}`) with a sticky `16px 20px` header, scrollable body, and sticky bottom action bar. Used for Attempt inspection, KYB Document inspection, Approval Diff review, and Contextual Help (`ContextualHelpDrawer.tsx`).
2. **`<DescriptionList />` (`src/components/ui/DescriptionList.tsx`):**
   - Takes `items: Array<{ label: string; value?: VNodeChild; mono?: boolean; money?: boolean }>` and renders a clean 1-column or 2-column architectural grid with `1px solid var(--pg-border-subtle)` row dividers (`12.5px` muted label on the left, `13.5px` primary value on the right).
3. **`<SegmentedTabs />` (`src/components/ui/SegmentedTabs.tsx`):**
   - Takes `modelValue`, `onUpdate:modelValue`, and `tabs: Array<{ value: string; label: string; count?: number }>`. Renders a sleek `34px`-height segmented pill bar (`backgroundColor: var(--pg-bg-surface-subtle)`, `padding: 3px`, `borderRadius: 6px`) where the active tab has `backgroundColor: var(--pg-bg-surface)` and `boxShadow: var(--pg-shadow-xs)`.
4. **`<EmptyState />` (`src/components/ui/EmptyState.tsx`):**
   - Renders a centered `40px 24px` state inside empty tables or queues: a `36px` subtle bordered icon frame (`border: 1px solid var(--pg-border-subtle)`), a `14px` semi-bold title, a `13px` muted explanation, and an optional `"Reset Filters"` or primary action button.
5. **`<JsonDiffViewer />` (`src/components/ui/JsonDiffViewer.tsx`):**
   - Used in `/approvals`, `/audit-log`, and `/detail-change-logs`. Parses `payloadDiffJson` (or `beforeJson` / `afterJson`) into a clean table with 3 columns: **Field Path** (`pg-mono`), **Current / Before Value** (rendered in `--pg-status-danger-bg` / `--pg-status-danger-text`), and **Proposed / After Value** (rendered in `--pg-status-success-bg` / `--pg-status-success-text`).
6. **Redesigned Unified `TableFilters.tsx` & `DataTable.tsx` (`src/components/Table/`):**
   - **Remove the gradient background card** from `TableFilters.tsx` and **remove the 8–10% full-row background tints** from `DataTable.tsx`.
   - Wrap the Search Bar + Filter Toggle Button + Collapsible Filter Grid + Active Filter Chips + `VDataTable` + Pagination Footer inside **one single `SurfaceCard` (`noPadding = true`, `class="pg-unified-table"`)**:
     - **Top Toolbar Row (`padding: 12px 16px`, `borderBottom: 1px solid var(--pg-border-subtle)`):** Left side has a compact `280px` search input (`prependInnerIcon="mdi-magnify"`, `height: 36px`) and a `"Filters"` button showing a count badge of active filters; right side has the result count (`124 records` in `pg-tabular`) and a refresh icon button.
     - **Collapsible Filter Grid (`padding: 14px 16px`, `backgroundColor: var(--pg-bg-surface-subtle)`, `borderBottom: 1px solid var(--pg-border-subtle)`):** Renders the aligned 1/2/3/4-column filter segments (`FormField` style with `11.5px` uppercase label and `36px`-height controls + `VDateInput` range picker).
     - **Active Filter Summary Bar (shown only when `activeCount > 0`, `padding: 8px 16px`, `borderBottom: 1px solid var(--pg-border-subtle)`):** Renders compact removable filter pills (`Status: Live ×`) and a right-aligned `"Clear all"` link button.


---

# PART IV: REDESIGN OF THE PORTAL SHELL (`src/layouts/default.tsx` & `src/layouts/auth.tsx`)

## 4.1 The Architectural Sidebar & Top Bar (`src/layouts/default.tsx`)

The layout shell frames every single screen. To replace the default Material Vuetify drawer/toolbar feel with a human-crafted Linear/Stripe shell:

1. **Sidebar (`VNavigationDrawer`, `width={248}`):**
   - Uses `--pg-bg-canvas` (`#F8FAFC` in light mode, `#09090B` in dark mode) separated from the main workspace by a `1px solid var(--pg-border-subtle)` hairline border (zero drop shadow).
   - **Top Brand Header (`height: 56px`, `padding: 0 16px`):** Crisp `28px` geometric brand mark (`borderRadius: 6px`, `backgroundColor: var(--pg-ink-primary)`), `14px` semi-bold platform name, and a subtle `LAN` / `LIVE` environment pill.
   - **Quick Command Search Pill (`padding: 8px 12px`):** A full-width `34px` button styled like a sleek input (`Search guide, rails, cases…`) with a right-aligned `Ctrl K` keyboard badge that opens `GlobalGuideSearchModal.tsx`.
   - **Section Groups (`useSections()`):**
     - Group headers are `11px`, `fontWeight: 600`, `color: var(--pg-ink-faint)`, `textTransform: uppercase`, `letterSpacing: 0.05em` (or `letterSpacing: 0` in RTL), `padding: 14px 12px 4px`.
     - Nav items are `34px` tall, `borderRadius: 6px`, `padding: 0 10px`, `fontSize: 13px`, `fontWeight: 500`.
     - **Inactive item:** `color: var(--pg-ink-secondary)`, icon `size={17}` in `var(--pg-ink-muted)`.
     - **Active item:** `backgroundColor: var(--pg-bg-surface)`, `color: var(--pg-ink-primary)`, `fontWeight: 600`, `border: 1px solid var(--pg-border-subtle)`, `boxShadow: var(--pg-shadow-xs)`—giving the active route a tactile "physical keycap" feel rather than a loud colored bar!
   - **Bottom Operator Identity Card (`padding: 12px`, `borderTop: 1px solid var(--pg-border-subtle)`):**
     - Shows the signed-in operator's email/phone (`12.5px` medium), their role badge (`<StatusBadge status={user.role} />`), Maker/Checker eligibility dots, and a subtle logout icon button.
2. **Top Application Bar (`VAppBar`, `height={56}`, `flat`):**
   - Uses `backgroundColor: var(--pg-bg-glass)` with `backdropFilter: blur(8px)` and `borderBottom: 1px solid var(--pg-border-subtle)`.
   - Left side: Mobile hamburger button (`< 960px`) + current section/page breadcrumb trail.
   - Right side:
     - **Ledger Invariant Live Pill:** A compact pill (`0.0000 LYD Drift` with a green `6px` dot) that links to `/finance/liquidity`,
     - **Contextual `"Help & SOP (?)"` Trigger:** Opens `ContextualHelpDrawer.tsx` for the active route,
     - **Language Switcher (`AR` / `EN`)** & **Theme Toggle (Light / Dark)** as clean `32px` ghost icon buttons.

## 4.2 Minimalist Split-Screen Authentication Layout (`src/layouts/auth.tsx` & `src/pages/public/auth/login/index.tsx`)

Replaces the generic centered Vuetify login box with an institutional split-screen layout:
- **Start Column (Desktop `>= 960px`, 45% width, `--pg-bg-surface-subtle` with a subtle architectural grid pattern and `1px` border):** Displays the platform brand emblem, zero-trust security posture badges (`TLS 1.3 mTLS Verified`, `AES-256-GCM Hardware Vault`, `Four-Eyes Governance`), and live system status.
- **End Column (55% width, `--pg-bg-surface`):** Centers a crisp `400px` login container using `<FormField />` static labels (`Email or Phone`, `Password`), a clean 2-step 6-digit MFA input when challenged, and a full-width `38px` primary submit button.

---

# PART V: PAGE-BY-PAGE REFACTORING MAP Across ALL 22+ PAGES IN `admin-front` & AUTOMATED VERIFICATION GATES

## 5.1 Complete Page-by-Page Component Abstraction Map (`admin-front/src/pages/`)

OpenCode MUST refactor every single page listed below to remove raw Vuetify layout boilerplate and use the 14 UI primitives from `src/components/ui/`:

| # | Route / File in `admin-front/src/pages/` | Required UI Primitives & Specific Visual Enhancements |
| :--- | :--- | :--- |
| **1** | **Executive Dashboard** (`pages/dashboard/index.tsx` or `pages/index.tsx`) | - `<PageHeader title="Platform Overview" subtitle="..." />` with period `<SegmentedTabs />` (`Today`, `7D`, `30D`, `YTD`).<br>- `<MetricStrip />` (4 cells: Gross Volume `<MoneyDisplay />`, Net Commission `<MoneyDisplay />`, Success Rate `%`, Open Action Queues).<br>- 2-column `<SurfaceCard />` grid for ECharts Volume/Rail Mix charts (using monochrome slate/indigo/emerald ECharts palette—no neon rainbow charts!) + Recent Attempts table using `<StatusBadge />`, `<MoneyDisplay />`, and `<MonoRef />`. |
| **2** | **Gateways Catalog** (`pages/gateways/index.tsx`) | - `<PageHeader />` with actions: `Smart AI Integration` (outlined) + `New Gateway` (primary).<br>- Unified `DataTable` where `code` uses `<MonoRef />`, `status` & `verificationState` & `riskClass` use `<StatusBadge />`.<br>- Replace raw create `<VDialog>` with `<FormModal title="Create Gateway" size="md">` and `<FormField />` inputs. |
| **3** | **8-Step Gateway Wizard** (`pages/gateways/wizard/[id].tsx`) | - `<PageHeader />` with version `<StatusBadge />` (`DRAFT`, `SANDBOX_VERIFIED`, `LIVE`) and `Run 15-Scenario Suite` / `Submit for Approval` buttons.<br>- Replace bulky `<VStepper>` header with a clean horizontal architectural step bar (`1. Identity` .. `8. Go-Live Gates`).<br>- Each step wrapped in `<SurfaceCard />` using `<FormField />` and `<MonoRef />`. Step 8 renders the 12 Go-Live Gates as a crisp 12-row `<DescriptionList />` with `<StatusBadge />` pass/fail pills. |
| **4** | **Smart AI Integration Wizard** (`pages/gateways/ai-import/index.tsx`) | - `<PageHeader />` + 3-step `<SegmentedTabs />` (`1. Download AI Kit`, `2. Verify Spec JSON`, `3. Bind Secrets & Import`).<br>- Verification scorecard rendered via `<MetricStrip />` (Layer 1 Schema, Layer 2 Semantics/SSRF, Layer 3 Test Vectors, Layer 4 Collisions) + `<SurfaceCard />` for vector simulation previews and secret `<FormField />` inputs. |
| **5** | **Customer Rails** (`pages/rails/index.tsx`) | - `<PageHeader />` + Unified `DataTable` (`code` in `<MonoRef />`, `collectionMode` & `Active/Blocked` in `<StatusBadge />`, `minAmount`/`maxAmount` in `<MoneyDisplay />`).<br>- Replace both Create Rail and Edit Rail/Fields dialogs with `<FormModal />` and `<FormField />`. |
| **6** | **Rail Routes** (`pages/routes/index.tsx`) | - `<PageHeader />` + Unified `DataTable` (`priority`, `status` & `healthState` in `<StatusBadge />`, `minAmount`/`maxAmount`/`dailyCapAmount` in `<MoneyDisplay />`).<br>- Replace Add Route and Edit Route dialogs with `<FormModal />` + `<FormField />`. |
| **7** | **Credential Sets** (`pages/credential-sets/index.tsx`) | - `<PageHeader />` + Unified `DataTable` (`ownerType`, `settlementTarget`, `env`, and `status` in `<StatusBadge />`).<br>- Create/Rotate Credential modal built with `<FormModal />` + write-only secret `<FormField />` inputs + live `CREDENTIAL_CHECK` trigger button. |
| **8** | **Join Requests & KYB Desk** (`pages/join-requests/index.tsx`) | - `<PageHeader />` + `<MetricStrip />` (Pending Review, Info Requested, Overdue SLA, Approved Today).<br>- Unified `DataTable` (`status` and `proposedRiskTier` in `<StatusBadge />`, duplicate SHA-256 flags highlighted).<br>- Clicking a row opens `<SlideOverDrawer />` containing the merchant's `<DescriptionList />`, KYB document list, 7-item reviewer checklist, and `<FormModal />` triggers for `Request Info` / `Approve` / `Reject`. |
| **9** | **Merchants Directory** (`pages/merchants/index.tsx`) | - `<PageHeader />` + Unified `DataTable` (`status`, `kybStatus`, `riskTier` in `<StatusBadge />`, ceilings in `<MoneyDisplay />`).<br>- Merchant inspection and sensitive-edit proposals (`propose-edit` / `suspend` / `reinstate`) inside `<SlideOverDrawer />` and `<FormModal />` with `<FormField sensitiveMakerChecker />` badges. |
| **10** | **Four-Eyes Approvals Center** (`pages/approvals/index.tsx`) | - `<PageHeader />` + `<SegmentedTabs />` (`Pending My Review`, `Emergency Ratifications`, `Decided History`).<br>- Unified `DataTable` (`subjectType`, `mode`, `state` in `<StatusBadge />`, `maker` vs `checker`).<br>- Clicking a request opens `<SlideOverDrawer />` displaying `<JsonDiffViewer />` (side-by-side Old vs Proposed New values) and the Approve / Reject `<FormModal />` (with outcome selector for chargebacks). |
| **11** | **AML Cases, Screenings, Rules & Reports** (`pages/aml/cases/index.tsx`, `screenings/index.tsx`, `rules/index.tsx`, `reports/index.tsx`) | - `<PageHeader badge="AML-CONFIDENTIAL" badgeTone="danger" />` on all 4 pages.<br>- `<MetricStrip />` for open cases by severity (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`).<br>- Case disposition and rule creation refactored to `<SlideOverDrawer />`, `<DescriptionList />`, `<FormModal />`, and `<FormField sensitiveMakerChecker />`. |
| **12** | **Operator Cases & Unknown Queue** (`pages/operator-cases/index.tsx`) | - `<PageHeader />` + `<MetricStrip />` (`P1 Conflicts`, `UNKNOWN In-Flight`, `Amount Mismatches`, `Overdue SLA`).<br>- Unified `DataTable` with `1-Click Inquire` button and `<SlideOverDrawer />` showing `attempt_step_logs` in `pg-mono` + Maker-Checker resolution `<FormModal />`. |
| **13** | **Disputes, Adjustments & Cashouts** (`pages/disputes/index.tsx`, `adjustments/index.tsx`, `cashouts/index.tsx`) | - All monetary columns (`amount`, `settledAmount`) rendered via `<MoneyDisplay />`, references via `<MonoRef />`, and states via `<StatusBadge />`.<br>- Propose Adjustment, Decide Dispute, and Process Cashout dialogs refactored to `<FormModal />` + `<FormField />`. |
| **14** | **Commission Profiles & Velocity Rules** (`pages/commission-profiles/index.tsx`, `velocity-rules/index.tsx`) | - `<PageHeader />` + Unified `DataTable` + `<FormModal />` for proposing new effective-dated versions under Four-Eyes governance. |
| **15** | **Statement Reconciliation** (`pages/reconciliation/index.tsx`) | - `<PageHeader />` + `<SegmentedTabs />` (`Reconciliation Runs`, `Statement Sources`, `Upload & Preview`).<br>- Upload preview and column mapper wrapped in `<SurfaceCard />`; run results (`MATCHED`, `AMOUNT_MISMATCH`, `MISSING_LOCALLY`) rendered with `<StatusBadge />` and `<MoneyDisplay />`. |
| **16** | **Profitability & Liquidity Dashboards** (`pages/finance/profitability/index.tsx`, `liquidity/index.tsx`) | - `<PageHeader />` + `<MetricStrip />` (Gross Commission, Gateway Cost, Net Contribution, Treasury Cover Ratio, Invariant Drift `0.0000 LYD`).<br>- Clearing Ageing buckets (`T+0`, `T+1`, `T+2`, `> Lag`) and GL Account Trial Balance rendered in `<SurfaceCard />` with `<MoneyDisplay colorSign />`. |
| **17** | **Users, Platform Settings & Checkout Help Settings** (`pages/users/index.tsx`, `settings/index.tsx`, `settings/checkout-help/index.tsx`) | - Refactored to `<PageHeader />`, `<SurfaceCard />`, `<FormField />`, and `<FormModal />`, with a live payer preview card on `settings/checkout-help`. |
| **18** | **Interactive System Guide & Employee Academy** (`pages/guide/index.tsx`, `pages/academy/index.tsx`) | - Styled with `<PageHeader />`, `<SegmentedTabs />`, `<SurfaceCard />`, `<StatusBadge />`, `<MoneyDisplay />`, and clean 2-column reading typography (`maxWidth: 75ch` per lesson article, crisp callout boxes, and hairline-bordered simulator cards). |

---

## 5.2 Mirroring the Primitives Across `merchant-front` and `checkout-front`

1. **Copy `src/styles/fintech-minimal.css` and `src/components/ui/` to `merchant-front`:**
   - Apply the exact same `<PageHeader />`, `<MetricStrip />`, `<SurfaceCard />`, `<StatusBadge />`, `<MoneyDisplay />`, `<MonoRef />`, `<FormModal />`, `<FormField />`, and unified `DataTable` across all 13 pages in `merchant-front/src/pages/` (`dashboard`, `onboarding`, `wallets`, `applications`, `links`, `pos`, `payments`, `disputes`, `cashouts`, `developers/tokens`, `credentials`, `team`, `guide`).
2. **Polish `checkout-front` (`src/pages/pay/[linkKey]/index.tsx`):**
   - Import `fintech-minimal.css`, `<MoneyDisplay />`, `<MonoRef />`, `<StatusBadge />`, and `<FormField />` into `checkout-front` so the customer payment card has the exact same Stripe/Wise-grade typographic hierarchy, crisp `1px` border, tabular LYD breakdown (`Amount` + `Service Fee` = `Total`), and static top input labels.

---

## 5.3 Automated Anti-Boilerplate & Visual Compliance Gate (`admin-front/src/components/ui/__tests__/ui-abstraction-compliance.test.ts`)

To guarantee that `DeepSeek V4.1 Flash Max` actually refactors every page rather than leaving old ad-hoc markup behind, OpenCode MUST create and pass the following Vitest compliance test:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function walkTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsxFiles(full));
    } else if (entry.isFile() && full.endsWith(".tsx")) {
      results.push(full);
    }
  }
  return results;
}

describe("UI Abstraction & Anti-AI-Slop Compliance Gate", () => {
  const pagesDir = path.resolve(__dirname, "../../../pages");
  const pageFiles = walkTsxFiles(pagesDir);

  it("1. All 14 UI primitives exist and are exported from src/components/ui/index.ts", () => {
    const uiIndex = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
    const requiredExports = [
      "PageHeader",
      "StatusBadge",
      "MoneyDisplay",
      "MonoRef",
      "MetricStrip",
      "SurfaceCard",
      "FormModal",
      "FormField",
      "SlideOverDrawer",
      "DescriptionList",
      "SegmentedTabs",
      "EmptyState",
      "JsonDiffViewer",
    ];
    for (const exp of requiredExports) {
      expect(uiIndex).toContain(exp);
    }
  });

  it("2. Zero page files in src/pages/ use raw <VDialog> instead of <FormModal />", () => {
    for (const file of pageFiles) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${path.relative(pagesDir, file)} still uses raw <VDialog`).not.toMatch(/<VDialog\b/);
    }
  });

  it("3. Every standard workspace page in src/pages/ uses <PageHeader />", () => {
    const exemptAuthPages = new Set(["login/index.tsx", "register/index.tsx"]);
    for (const file of pageFiles) {
      const rel = path.relative(pagesDir, file).replace(/\\/g, "/");
      if (exemptAuthPages.has(rel) || rel.startsWith("public/")) continue;
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${rel} must use <PageHeader`).toContain("PageHeader");
    }
  });

  it("4. TableFilters and DataTable contain zero gradient backgrounds and zero full-row rainbow background tints", () => {
    const tableFilters = fs.readFileSync(path.resolve(__dirname, "../../Table/TableFilters.tsx"), "utf8");
    expect(tableFilters).not.toMatch(/linear-gradient|radial-gradient/i);
  });
});
```

---

## 5.4 Phased OpenCode Execution Checklist (`UI-1` to `UI-6`)

Hand this file directly to OpenCode (`DeepSeek V4.1 Flash Max`) and instruct it to execute `UI-1` through `UI-6` in strict sequence:

- [ ] **`UI-1` Install Design Tokens, Global Stylesheet & Vuetify Defaults:**
  - Create `admin-front/src/styles/fintech-minimal.css` (from Part II §1), import it in `admin-front/src/main.ts`, and update `admin-front/src/plugins/vuetify.ts` (from Part II §2).
- [ ] **`UI-2` Implement All 14 Abstracted UI Primitives (`admin-front/src/components/ui/`):**
  - Implement `PageHeader.tsx`, `StatusBadge.tsx`, `MoneyDisplay.tsx`, `MonoRef.tsx`, `MetricStrip.tsx`, `SurfaceCard.tsx`, `FormModal.tsx`, `FormField.tsx`, `SlideOverDrawer.tsx`, `DescriptionList.tsx`, `SegmentedTabs.tsx`, `EmptyState.tsx`, `JsonDiffViewer.tsx`, and export them from `src/components/ui/index.ts`.
  - Refactor `src/components/Table/TableFilters.tsx` and `src/components/Table/DataTable.tsx` into the unified single-surface table container (removing the gradient filter card and removing the 8–10% full-row background tints in favor of `<StatusBadge />`, `<MoneyDisplay />`, and `<MonoRef />`).
- [ ] **`UI-3` Refactor the App Shell (`src/layouts/default.tsx` & `src/layouts/auth.tsx`):**
  - Implement the `248px` architectural sidebar (tactile keycap active states, `Ctrl+K` search pill, bottom operator card), the `56px` glass top bar (breadcrumb trail, live `0.0000 LYD` ledger invariant pill, contextual `"SOP & Help"` drawer button, locale/theme toggles), and the split-screen login page.
- [ ] **`UI-4` Refactor All 22+ Pages in `admin-front/src/pages/**/*.tsx`:**
  - Systematically refactor every page in `admin-front/src/pages/` according to the 18-row Page-by-Page Map in Part V §5.1, replacing all raw `<VDialog>`, raw page headers, raw `<VChip>` status tags, and raw money strings with the new `src/components/ui/` primitives.
- [ ] **`UI-5` Roll Out Shared Primitives & Theme to `merchant-front` and `checkout-front`:**
  - Copy `fintech-minimal.css` and `src/components/ui/` to `merchant-front` and `checkout-front`, refactoring `merchant-front/src/layouts/` and `merchant-front/src/pages/` to the exact same design standard.
- [ ] **`UI-6` Run Automated Anti-Boilerplate, Unit, Build & Playwright Geometry Verification:**
  - Create and run `ui-abstraction-compliance.test.ts` (`cd admin-front && bun run test:unit && bun run build`), `cd merchant-front && bun run build`, `cd checkout-front && bun run build`, and `bunx playwright test` across Desktop (`1440×900`) and Mobile (`390×844`) in both `EN` (LTR) and `AR` (RTL).
