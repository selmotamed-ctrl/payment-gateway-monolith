/**
 * Shared chart suite: the ECharts wrapper plus the analytics cards that used to
 * be duplicated under `admin-front/src/charts`, `merchant-front/src/charts` and
 * `checkout-front/src/charts`.
 */
export { PgChart, EChart, type PgChartProps, type PgChartSize } from "./PgChart";
export { PgStatChartCard, StatsChartCard, type PgStatChartCardProps } from "./PgStatChartCard";
export {
    PgStatBarChartCard,
    StatsBarChartCard,
    type PgStatBarChartCardProps,
    type PgStatBarSeries,
} from "./PgStatBarChartCard";
export {
    CHART_CATEGORICAL_DARK,
    CHART_CATEGORICAL_LIGHT,
    CHART_DANGER,
    CHART_DARK_DANGER,
    CHART_DARK_EMERALD,
    CHART_DARK_GRID,
    CHART_DARK_INDIGO,
    CHART_DARK_INFO,
    CHART_DARK_SLATE,
    CHART_DARK_TEXT,
    CHART_DARK_WARNING,
    CHART_EMERALD,
    CHART_GRID,
    CHART_INDIGO,
    CHART_INFO,
    CHART_SLATE,
    CHART_TEXT,
    CHART_TONE_NAMES,
    CHART_WARNING,
    chartGrid,
    chartPalette,
    chartText,
    chartToneColor,
    isChartToneName,
    type ChartPalette,
    type ChartTheme,
    type ChartToneName,
} from "./palette";
