# `@pg/ui` — 2026 Fintech Vapor component catalog

Single source of truth for every portal (`admin-front`, `merchant-front`, `checkout-front`, `fake-rails-front`).
Import everything from `@pg/ui`; import the tokens once in each portal entry:

```ts
import "@pg/ui/tokens/index.css";
```

The package is consumed through the `@pg/ui` Vite/TypeScript alias (`../packages/ui/src`) so the same source is
compiled by every portal with `vueJsx({ vapor: true })`. No portal has its own copy of a primitive.

## Conventions

- Vue 3.6 Vapor only: `dc`/`defineComponent` from `@pg/ui`, reactive getters inside the returned render closure. Use `createIf` for a reactive loading/error/content branch instead of a top-level early return.
- All props are optional unless marked required; `modelValue` + `update:modelValue` is the standard model contract.
- Vuetify-compatible spellings are accepted where pages already use them (`items`, `itemTitle`, `itemValue`,
  `variant="flat"`, `color="primary"`, `prependIcon`, `to`, `density="compact"`, `hideDetails`, `rules`).
- Every visual decision uses a `--pg-*` token. No page owns a colour or a container padding.
- Components are RTL-aware and follow `data-theme="dark"` (or `.v-theme--dark`).

## Tokens

`packages/ui/src/tokens/fintech-2026.css` — surfaces, ink, hairline borders, neutral focus ring, semantic status,
radii, shadows, spacing, control heights, typography and z-index. `layout-policy.css` owns the page/section/card/
dialog/drawer spacing and the seamless metric grid. `components.css` holds the primitive styles and the legacy
layout classes that existed before the migration.

## Provider and services

| Export | Purpose |
| :--- | :--- |
| `PgProvider` | Root host: supplies `PgUiConfig` (API client, error extractor, XLSX exporter, confirm dialog, router, copy, help button) and mounts `PgToaster`. |
| `usePgUiConfig` | Read the host services inside a component. |
| `useLocale`, `useDisplay`, `useRtl`, `useTheme` | Compatible composables used by the portals. |
| `themeMode`, `resolvedTheme`, `setThemeMode`, `toggleTheme`, `initTheme` | Shared system/light/dark theme state. |
| `showToast`, `dismissToast`, `pauseToast`, `resumeToast`, `useToasts` | Toast store. |
| `formatMoney`, `toDecimal`, `currencyPrecision` | Decimal-only money helpers (LYD = 3 decimals). |

## Layout

| Export | Notes |
| :--- | :--- |
| `PgPage` / `ScreenContainer` | Page canvas: max 1480 px, 28/36 px desktop and 20/16 px mobile padding, 28 px section rhythm. |
| `PgSection` | Title/description/actions with an optional collapsible body. |
| `PgPageHeader` / `PageHeader` | Breadcrumbs, title, badge, subtitle, action slot and an optional `help` slot. The admin portal injects its contextual-help button through `PgUiConfig.helpButton`. |
| `PgCard` / `SurfaceCard` | 18/24 header, 24 body, 14/24 footer; `noPadding` for tables. |
| `PgStack`, `PgFormGrid`, `PgFormCol`, `PgCenter`, `PgDivider` | Stacks, 12-column form grid, centering, hairline divider. |
| `PgApp`, `PgAppBar`, `PgAppBarTitle`, `PgMain`, `PgNavigationDrawer` | Vapor app shell. |
| `PgList`, `PgListItem`, `PgListSubheader`, `PgExpansionPanels`, `PgTimeline` | Navigation and disclosure primitives. |
| `PgText` / `ThemedText`, `PgView` / `ThemedView` | Plain typography/layout surfaces used by existing pages. |

## Actions

| Export | Notes |
| :--- | :--- |
| `PgButton` / `VBtn` | `variant`: `primary`, `secondary`, `tonal`, `outlined`, `text`, `ghost`, `danger`, `outlined-danger`, `text-danger`; sizes `sm/md/lg`; `icon`, `prependIcon`, `appendIcon`, `loading`, `block`, `rounded`, `to`, `href`. |
| `PgIcon` / `VIcon` / `AppIcon` | Inline SVG from the generated `@mdi/js` registry; `name`/`icon`, `size`, `color` token, `label`, `directional`. |
| `PgSegmentedTabs` | WAI-ARIA tablist pill track; arrow/Home/End keys. |
| `PgSpinner`, `PgProgressBar` | Accessible ring and rounded progress bar. |

## Inputs

| Export | Notes |
| :--- | :--- |
| `PgFieldShell` | Label, required mark, hint, error, counter. |
| `PgTextField` / `VTextField` | 40 px control (36 sm), neutral focus ring, label/hint/error, prefix/suffix, leading/trailing icon, clear, password reveal, max length, counter, `rules`. |
| `PgTextarea` / `VTextarea` | Auto-grow textarea sharing the field shell. |
| `PgSearchInput` | Toolbar search with magnifier, clear, debounced `search`, ⌘K hint. |
| `PgAutocomplete` / `VSelect` / `VAutocomplete` / `VCombobox` | WAI-ARIA combobox: single/multi, chips, `creatable`, keyboard navigation, viewport-aware panel, no native `<select>`. |
| `PgApiAutocomplete` | Async/debounced server search using `PgUiConfig.api`. |
| `PgDateInput` / `PgDateRangeInput` / `VDateInput` | Typed `YYYY-MM-DD`, calendar grid, month jump, min/max, today, clear, range presets (`Today`, 7/30 days, this/last month, YTD). |
| `PgCheckbox` / `VCheckbox` | 2026 animated check, indeterminate, `variant="card"` safeguard row. |
| `PgChoice` | Accessible radio/checkbox card used by exams, labs and safeguard lists. The native control lives inside the package. |
| `PgSwitch`, `PgRadioGroup`, `PgRadio` | Tactile switch and radio group. |
| `PgFileUpload` / `VFileInput` | Drag-and-drop, file pills, accept/max size validation. |
| `PgOtpInput` | Segmented one-time code boxes with paste/arrow navigation. |
| `PgCodeEditor` | Line-numbered code editor for the report/chrome JSON spec (the only sanctioned JSON textarea). |
| `PgFormField` / `FormField` | ARIA label/hint/error mirroring for composite controls. |

## Feedback

| Export | Notes |
| :--- | :--- |
| `PgAlert` / `AlertView` / `VAlert` | One alert system; `tone` maps 1:1 to `--pg-status-*`; title/message/messages/actions/closable. |
| `PgStatusBadge` / `StatusBadge` / `StatusChip` | Semantic pill with dot and the shared financial status vocabulary. |
| `PgEmptyState`, `PgStateView`, `PgLoadingScreen`, `PgSkeleton`, `PgSpinner` | Calm empty/loading/skeleton surfaces. |
| `PgToaster`, `PgToast` | Auto-dismiss (4.5 s success/info, 6.5 s warning/danger), pause on hover, stack cap 4, progress bar, action button. |

## Overlays

| Export | Notes |
| :--- | :--- |
| `PgDialog` / `VDialog` | Strict header/body/footer zones; the × lives in the header flex end and can never overlap content. Focus trap, scroll lock, Escape/overlay close. |
| `PgDrawer` / `SlideOverDrawer` | Stacking slide-over with header/body/footer. |
| `PgFormModal` / `FormModal` | Standard form modal with Cancel/Save and a real `<form>` submit. |
| `PgConfirmDialog` | `show(options)` service used by `showConfirm`. |
| `PgDetailsDialog` / `DetailsFieldsDialog` | Read-only detail sections with status/reference/money formatting. |
| `PgCommandPalette` | Bare 56 px search header, ESC badge and padded results list. |
| `PgMenu`, `PgTooltip` | Teleport-free fixed positioning (Vapor-safe) with viewport flip, Escape and outside close. |

## Data

| Export | Notes |
| :--- | :--- |
| `PgMetricStrip` / `MetricStrip` / `MiniStats` | Seamless zero-gap KPI bento; inset hairlines, no exposed gray cells. |
| `PgMoneyText` / `MoneyDisplay` | Tabular 3-decimal LYD / 2-decimal USD, sign colouring. |
| `PgMonoRef` / `MonoRef` | Monospace reference with one-click copy. |
| `PgDescriptionList`, `PgField`, `PgFieldsSection`, `PgSectionFields` | Key/value detail surfaces with copy and help tooltips. |
| `PgMetaPill`, `PgStatusBadge`, `PgChip` | Pills and removable chips. |
| `PgTable`, `PgApiTable`, `PgTableFilters`, `PgTableRowActions`, `PgTableHeader`, `PgTableFooter` | Shared 48 px data table, toolbar, filters, pagination, row context menu and XLSX hook. |
| `PgFormChecklist`, `PgSummaryExportCard` | Maker-checker checklist and summary/export card. |
| `JsonDiffViewer`, `JsonValueList`, `JsonValueCell` | Human-readable RFC-6902/compare/payload diffs. |

## Patterns

| Export | Notes |
| :--- | :--- |
| `PgThemeMenu`, `PgThemeLanguageControls` | System/Light/Dark menu and language switcher. |

## Governance

```bash
bun run ui:audit          # zero raw controls / shim imports / page hex / container padding
bun run ui:test           # package unit tests
bun run ui:typecheck      # Vapor component typecheck
bun run ui:icons:check    # generated icon registry is current
```

`packages/ui/src/testing/governanceAudit.ts` holds the pure rules used by the CLI gate and the tests. See the root
`AGENTS.md` UI policy before adding a component.
