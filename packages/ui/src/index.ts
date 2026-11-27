/**
 * @pg/ui — the single source of truth for every UI primitive, layout
 * container, form control, table, alert, toast, dialog and design token in the
 * Payment Gateway portals.
 *
 * Every component here is Vue 3.6 Vapor-valid, accessible, RTL-aware and
 * dark/light-mode aware. Page code must import from `@pg/ui`; never copy a
 * component into an app.
 */

/* === Services & utilities === */
export { dc, defineComponent } from "./lib/dc";
export { useLocale, type IconProps } from "./lib/locale";
export { useDisplay, useRtl } from "./lib/display";
export {
    DARK_MEDIA_QUERY,
    THEME_STORAGE_KEY,
    getTheme,
    initTheme,
    initialTheme,
    isThemeMode,
    readThemeMode,
    resolvedTheme,
    resolveTheme,
    setThemeMode,
    systemPrefersDark,
    themeMode,
    toggleTheme,
    useTheme,
    type ResolvedTheme,
    type ThemeMode,
} from "./lib/theme";
export {
    CURRENCY_PRECISION,
    DEFAULT_CURRENCY,
    compareMoney,
    currencyPrecision,
    formatMoney,
    formatPlainNumber,
    isZeroMoney,
    toDecimal,
    toNumber,
    type MoneyInput,
} from "./lib/money";
export { fromIsoDate, sameDay, startOfDay, toIsoDate } from "./lib/date";
export { formatHumanStatus, statusToTone, type BadgeTone } from "./lib/status";
export { normalizeOptions, sameValue, normalizeSize, controlSize, iconName, pick, type PgOption } from "./lib/options";
export { isEmpty, runRules, visibleError } from "./lib/rules";
export {
    copyToClipboard,
    isBrowser,
    lockBodyScroll,
    routeHref,
    useClickOutside,
    useEscape,
    useFocusTrap,
} from "./lib/dom";
export { providePgUiConfig, usePgUiConfig, type PgUiApiClient, type PgUiConfig } from "./lib/config";

/* === Provider === */
export { PgProvider } from "./provider/PgProvider";

/* === Actions === */
export { PgButton, VBtn, type PgButtonSize, type PgButtonVariant } from "./actions/PgButton";
export { PgIcon, PgIcon as AppIcon, VIcon, type IconName } from "./actions/PgIcon";
export { PgSegmentedTabs, SegmentedTabs, type SegmentedTab } from "./actions/PgSegmentedTabs";
export { PgDivider, PgProgressBar, PgSpinner, VDivider, VProgressCircular, VProgressLinear } from "./actions/PgFeedbackAtoms";

/* === Inputs === */
export { PgFieldShell } from "./inputs/PgFieldShell";
export { PgTextField, VTextField } from "./inputs/PgTextField";
export { PgTextarea, VTextarea } from "./inputs/PgTextarea";
export { PgSearchInput } from "./inputs/PgSearchInput";
export { PgAutocomplete, VAutocomplete, VCombobox, VSelect } from "./inputs/PgAutocomplete";
export { PgApiAutocomplete } from "./inputs/PgApiAutocomplete";
export { PgCodeEditor } from "./inputs/PgCodeEditor";
export { PgDateInput, PgDateRangeInput, VDateInput, type PgDateRange } from "./inputs/PgDateInput";
export { PgChoice, type PgChoiceState } from "./inputs/PgChoice";
export { PgCheckbox, VCheckbox } from "./inputs/PgCheckbox";
export { PgRadio, PgRadioGroup, PgSwitch, VRadio, VRadioGroup, VSwitch } from "./inputs/PgToggle";
export { PgFileUpload, VFileInput } from "./inputs/PgFileUpload";
export { PgOtpInput } from "./inputs/PgOtpInput";
export { PgFormField, FormField } from "./inputs/PgFormField";

/* === Feedback === */
export { PgAlert, AlertView, VAlert, type AlertTone } from "./feedback/PgAlert";
export { PgStatusBadge, StatusBadge, StatusChip } from "./feedback/PgStatusBadge";
export { PgEmptyState, EmptyState } from "./feedback/PgEmptyState";
export { PgSkeleton } from "./feedback/PgEmptyState";
export { PgLoadingScreen, PgStateView, LoadingScreen, StateView } from "./feedback/PgStateView";
export {
    clearToasts,
    dismissToast,
    pauseToast,
    resumeToast,
    showToast,
    useToasts,
    type ToastItem,
    type ToastTone,
} from "./feedback/toastStore";
export { PgToast, PgToaster, Toaster } from "./feedback/PgToast";

/* === Overlays === */
export { PgDialog, VDialog } from "./overlays/PgDialog";
export { PgDrawer, SlideOverDrawer } from "./overlays/PgDrawer";
export { PgFormModal, FormModal, PgConfirmDialog } from "./overlays/PgFormModal";
export { PgDetailsDialog, DetailsFieldsDialog } from "./overlays/PgDetailsDialog";
export { PgCommandPalette } from "./overlays/PgCommandPalette";
export { PgMenu, VMenu } from "./overlays/PgMenu";
export { PgTooltip, VTooltip } from "./overlays/PgTooltip";

/* === Layout === */
export {
    PgCard,
    PgCenter,
    PgFormCol,
    PgFormGrid,
    PgPage,
    PgSection,
    PgStack,
    CenterView,
    ScreenContainer,
    SurfaceCard,
} from "./layout/PgLayout";
export {
    PgPageHeader,
    PgSubHeader,
    PgText,
    PgView,
    PageHeader,
    SubHeader,
    ThemedText,
    ThemedView,
    type PgBreadcrumb,
    type PgBreadcrumb as BreadcrumbItem,
} from "./layout/PgPageHeader";
export {
    PgApp,
    PgAppBar,
    PgAppBarTitle,
    PgAvatar,
    PgBtnToggle,
    PgChip,
    PgCol,
    PgContainer,
    PgExpansionPanel,
    PgExpansionPanelText,
    PgExpansionPanelTitle,
    PgExpansionPanels,
    PgForm,
    PgList,
    PgListItem,
    PgListItemSubtitle,
    PgListItemTitle,
    PgListSubheader,
    PgMain,
    PgNavigationDrawer,
    PgRow,
    PgSlider,
    PgSpacer,
    PgTag,
    PgTimeline,
    PgTimelineItem,
    PgTransition,
    SurfaceCardText,
    VApp,
    VAppBar,
    VAppBarTitle,
    VAvatar,
    VBtnToggle,
    PgCardActions,
    PgCardSubtitle,
    PgCardText,
    PgCardTitle,
    VCardActions,
    VCardSubtitle,
    VCardText,
    VCardTitle,
    VCol,
    VChip,
    VContainer,
    VExpansionPanel,
    VExpansionPanelText,
    VExpansionPanelTitle,
    VExpansionPanels,
    VForm,
    VList,
    VListItem,
    VListItemSubtitle,
    VListItemTitle,
    VListSubheader,
    VMain,
    VNavigationDrawer,
    VRow,
    VSlider,
    VSpacer,
    VTimeline,
    VTimelineItem,
} from "./layout/PgShellPrimitives";

/* === Data === */
export { PgMetricStrip, MetricStrip, PgMiniStats, MiniStats, type MetricTone, type PgMetricItem, type PgMetricItem as MetricItem } from "./data/PgMetricStrip";
export { PgMoneyText, MoneyDisplay, MoneyText } from "./data/PgMoneyText";
export { PgMonoRef, MonoRef } from "./data/PgMonoRef";
export { PgDescriptionList, DescriptionList, type PgDescriptionItem, type PgDescriptionItem as DescriptionItem } from "./data/PgDescriptionList";
export { PgMetaPill, MetaPill } from "./data/PgMetaPill";
export { PgField, Field, type PgFieldItem, type PgFieldItem as FieldProps } from "./data/PgField";
export { PgFieldsSection, PgSectionFields, FieldsSections, SectionFields, type PgFieldSection } from "./data/PgFieldsSection";
export { PgFormChecklist, FormChecklist, type PgChecklistItem, type PgChecklistItem as ChecklistItem } from "./data/PgFormChecklist";
export { PgSummaryExportCard, SummaryExportCard } from "./data/PgSummaryExportCard";
export * from "./data/json/jsonDiffModel";
export { JsonDiffViewer } from "./data/json/JsonDiffViewer";
export { JsonValueCell } from "./data/json/JsonValueCell";
export { JsonValueList } from "./data/json/JsonValueList";
export {
    PgTable,
    Table,
} from "./data/table/Table";
export { PgTableFilters, default as TableFilters, createTableFilterSurface, tableFilterSurfaceKey, type TableFilterSurface } from "./data/table/TableFilters";
export { PgTableFooter, PgTableHeader, useTableXlsx } from "./data/table/HeaderFooter";
export { PgTableRowActions, TableRowActions, type RowActionItem, type RowPrimaryAction } from "./data/table/TableRowActions";
export { PgApiTable, default as ApiTable } from "./data/table/PgApiTable";
export * from "./data/table/types";
export * from "./data/table/filters";
export type { StatusTone } from "./data/table/filters";
export { criticalRowTone, statusTone, rowTone } from "./data/table/statusTone";

/* === Patterns === */
export { PgThemeMenu, PgThemeLanguageControls, ThemeMenu, ThemeAndLanguageControls } from "./patterns/PgThemeControls";
