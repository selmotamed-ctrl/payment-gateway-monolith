import { computed } from "vue";
import type { EChartsOption } from "echarts";
import { dc } from "../lib/dc";
import { resolvedTheme } from "../lib/theme";
import { PgCard } from "../layout/PgLayout";
import { PgChart, type PgChartSize } from "./PgChart";
import { chartPalette, chartToneColor, type ChartPalette } from "./palette";

export interface PgStatBarSeries {
    name: string;
    data: number[];
    /** Named palette tone (`indigo`, `emerald`, `sky`…) or a raw colour. */
    tone?: string;
}

export interface PgStatBarChartCardProps {
    title: string;
    subtitle?: string;
    categories: string[];
    series: PgStatBarSeries[];
    horizontal?: boolean;
    stacked?: boolean;
    height?: PgChartSize;
    valueFormatter?: (value: number) => string;
    loading?: boolean;
    empty?: boolean;
    emptyText?: string;
    ariaLabel?: string;
}

const MAX_LABEL = 14;

const truncateLabel = (value: string, max = MAX_LABEL): string =>
    value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;

const escapeHtml = (value: unknown): string =>
    String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

const compactNumber = (value: number): string => {
    if (!Number.isFinite(value)) return "0";
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
};

const numeric = (value: unknown): number => {
    if (Array.isArray(value)) return Number(value[value.length - 1] ?? 0);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Categorical / stacked bar analytics card with rounded caps, a curated
 * light/dark 6-colour palette and full-label tooltips for truncated axes.
 */
export const PgStatBarChartCard = dc(
    (props: PgStatBarChartCardProps, _expose, { attrs, emit, slots }) => {
        const palette = computed<ChartPalette>(() => chartPalette(resolvedTheme.value));
        const categories = computed(() => (Array.isArray(props.categories) ? props.categories : []));
        const series = computed(() => (Array.isArray(props.series) ? props.series : []));
        const isEmpty = computed(
            () => props.empty || categories.value.length === 0 || series.value.length === 0,
        );

        const chartOption = computed<EChartsOption>(() => {
            const colors = palette.value;
            const manyCategories = categories.value.length > 6;
            const hasLegend = series.value.length > 1;
            const barSeries = series.value.map((entry, index) => ({
                name: entry.name,
                type: "bar" as const,
                data: Array.isArray(entry.data) ? entry.data : [],
                stack: props.stacked ? "pg-total" : undefined,
                barMaxWidth: 32,
                ...(props.horizontal ? { barMinHeight: 6 } : {}),
                itemStyle: {
                    color: chartToneColor(entry.tone, colors, index),
                    borderRadius: props.horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0],
                },
                emphasis: {
                    focus: "series" as const,
                    itemStyle: { opacity: 0.82 },
                },
            }));

            const valueAxis = {
                type: "value" as const,
                axisLabel: { color: colors.text, formatter: (value: number) => compactNumber(value) },
                splitLine: { lineStyle: { color: colors.grid } },
                axisLine: { show: false },
            };
            const categoryAxis = {
                type: "category" as const,
                data: categories.value,
                axisLabel: {
                    color: colors.text,
                    hideOverlap: true,
                    interval: 0 as const,
                    width: 112,
                    overflow: "truncate" as const,
                    formatter: (value: string) => truncateLabel(value),
                },
                axisLine: { lineStyle: { color: colors.grid } },
                axisTick: { show: false },
                splitLine: { show: false },
            };

            return {
                backgroundColor: "transparent",
                color: colors.categorical,
                textStyle: { color: colors.text },
                tooltip: {
                    trigger: "axis",
                    axisPointer: { type: "shadow" },
                    backgroundColor: colors.tooltipBackground,
                    borderColor: colors.tooltipBorder,
                    borderWidth: 1,
                    textStyle: { color: colors.tooltipText, fontSize: 12.5 },
                    formatter: (params: any) => {
                        const list = Array.isArray(params) ? params : [params];
                        const heading = escapeHtml(list[0]?.name ?? "");
                        const rows = list.map((entry: any) => {
                            const value = numeric(entry?.value);
                            const formatted = props.valueFormatter
                                ? props.valueFormatter(value)
                                : compactNumber(value);
                            return `${entry?.marker ?? ""}${escapeHtml(entry?.seriesName ?? "")}: <strong>${escapeHtml(formatted)}</strong>`;
                        });
                        return [heading, ...rows].join("<br/>");
                    },
                },
                legend: hasLegend
                    ? {
                          show: true,
                          top: 0,
                          left: "center",
                          itemGap: 12,
                          itemWidth: 10,
                          itemHeight: 10,
                          icon: "roundRect",
                          textStyle: { color: colors.text, fontSize: 11.5 },
                      }
                    : { show: false },
                grid: {
                    left: props.horizontal ? 8 : 12,
                    right: 16,
                    top: hasLegend ? 36 : 16,
                    bottom: 8,
                    containLabel: true,
                },
                xAxis: props.horizontal ? valueAxis : { ...categoryAxis, axisLabel: { ...categoryAxis.axisLabel, rotate: manyCategories ? 24 : 0 } },
                yAxis: props.horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
                series: barSeries,
            } as EChartsOption;
        });

        const onChartClick = (params: any) => {
            if (!params) return;
            const dataIndex = Number(params.dataIndex ?? -1);
            const category =
                (dataIndex >= 0 ? categories.value[dataIndex] : undefined) ??
                params.name ??
                "";
            const seriesName = params.seriesName ?? series.value[0]?.name ?? "";
            const value = numeric(params.value);
            emit?.("barClick", { category, seriesName, value });
        };

        return () => (
            <PgCard
                {...attrs}
                class={["pg-stat-chart-card", "pg-stat-bar-chart-card", attrs.class].filter(Boolean).join(" ")}
                role={attrs.role ?? "region"}
                aria-label={props.ariaLabel || props.title}
            >
                <div class="pg-stat-chart-card__head">
                    <div class="pg-stat-chart-card__heading">
                        {props.title && <div class="pg-stat-chart-card__title">{props.title}</div>}
                        {props.subtitle && <div class="pg-stat-chart-card__subtitle">{props.subtitle}</div>}
                    </div>
                    <div class="pg-stat-chart-card__meta">
                        {(slots.actions || slots.headerActions) && (
                            <div class="pg-stat-chart-card__actions">
                                {(slots.actions ?? slots.headerActions)?.()}
                            </div>
                        )}
                    </div>
                </div>
                <PgChart
                    option={chartOption.value}
                    height={props.height ?? 260}
                    loading={props.loading}
                    empty={isEmpty.value}
                    emptyText={props.emptyText || "No data"}
                    ariaLabel={props.ariaLabel || props.title}
                    onChartClick={onChartClick}
                />
            </PgCard>
        );
    },
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            categories: { type: Array as () => string[], default: () => [] },
            series: { type: Array as () => PgStatBarSeries[], default: () => [] },
            horizontal: { type: Boolean, default: false },
            stacked: { type: Boolean, default: false },
            height: { type: [String, Number], default: 260 },
            valueFormatter: { type: Function as unknown as () => ((value: number) => string) | undefined, default: undefined },
            loading: { type: Boolean, default: false },
            empty: { type: Boolean, default: false },
            emptyText: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["barClick"],
        inheritAttrs: true,
    },
);

/** Historical alias kept so page imports can switch source without renaming tags. */
export const StatsBarChartCard = PgStatBarChartCard;

export default PgStatBarChartCard;
