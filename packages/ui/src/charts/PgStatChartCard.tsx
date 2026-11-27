import { computed } from "vue";
import type { EChartsOption } from "echarts";
import { dc } from "../lib/dc";
import { resolvedTheme } from "../lib/theme";
import { PgCard } from "../layout/PgLayout";
import { PgChart, type PgChartSize } from "./PgChart";
import { chartPalette, type ChartPalette } from "./palette";

export interface PgStatChartCardProps {
    title: string;
    subtitle?: string;
    /** Optional headline KPI shown before the chart. */
    value?: string | number;
    /** Optional period-over-period change, rendered as a +/- percentage badge. */
    delta?: number;
    option: EChartsOption;
    height?: PgChartSize;
    loading?: boolean;
    empty?: boolean;
    emptyText?: string;
    ariaLabel?: string;
}

const formatValue = (value: string | number | undefined): string => {
    if (value === undefined || value === null) return "";
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
    }
    return String(value);
};

const formatDelta = (delta: number): string => {
    const safe = Number.isFinite(delta) ? delta : 0;
    const sign = safe > 0 ? "+" : "";
    return `${sign}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(safe)}%`;
};

const axisList = (axis: unknown): Record<string, any>[] => {
    if (!axis || typeof axis !== "object") return [];
    return Array.isArray(axis) ? (axis as Record<string, any>[]) : [axis as Record<string, any>];
};

const themeAxis = (axis: unknown, palette: ChartPalette): unknown => {
    const list = axisList(axis);
    if (!list.length) return axis;
    const themed = list.map((entry) => ({
        ...entry,
        axisLabel: { color: palette.text, ...(entry.axisLabel ?? {}) },
        axisLine: {
            ...(entry.axisLine ?? {}),
            lineStyle: { color: palette.grid, ...((entry.axisLine ?? {}).lineStyle ?? {}) },
        },
        splitLine:
            entry.splitLine?.show === false
                ? entry.splitLine
                : {
                      ...(entry.splitLine ?? {}),
                      lineStyle: { color: palette.grid, ...((entry.splitLine ?? {}).lineStyle ?? {}) },
                  },
    }));
    return Array.isArray(axis) ? themed : themed[0];
};

/**
 * Analytics card with a KPI headline, trend delta, action slot and an embedded
 * `PgChart`. The chart receives an explicit pixel height, so it always paints
 * on the dashboard instead of collapsing inside an auto-height card.
 */
export const PgStatChartCard = dc(
    (props: PgStatChartCardProps, _expose, { attrs, emit, slots }) => {
        const themedOption = computed<EChartsOption>(() => {
            const palette = chartPalette(resolvedTheme.value);
            const raw = (props.option ?? {}) as Record<string, any>;
            const tooltip = raw.tooltip && typeof raw.tooltip === "object" && !Array.isArray(raw.tooltip) ? raw.tooltip : {};
            const textStyle = raw.textStyle && typeof raw.textStyle === "object" ? raw.textStyle : {};
            const legend = raw.legend && typeof raw.legend === "object" && !Array.isArray(raw.legend) ? raw.legend : null;
            return {
                ...raw,
                backgroundColor: raw.backgroundColor ?? "transparent",
                color: raw.color ?? [palette.indigo, palette.emerald],
                textStyle: {
                    fontFamily: '"Plus Jakarta Sans", "Cairo", system-ui, sans-serif',
                    color: palette.text,
                    ...textStyle,
                },
                tooltip: {
                    trigger: "axis",
                    backgroundColor: palette.tooltipBackground,
                    borderColor: palette.tooltipBorder,
                    borderWidth: 1,
                    textStyle: { color: palette.tooltipText, fontSize: 12.5 },
                    ...tooltip,
                },
                ...(legend
                    ? {
                          legend: {
                              ...legend,
                              textStyle: { color: palette.text, ...(legend.textStyle ?? {}) },
                          },
                      }
                    : {}),
                ...(raw.xAxis ? { xAxis: themeAxis(raw.xAxis, palette) } : {}),
                ...(raw.yAxis ? { yAxis: themeAxis(raw.yAxis, palette) } : {}),
            } as EChartsOption;
        });

        const deltaValue = computed(() => (typeof props.delta === "number" ? props.delta : undefined));
        const deltaTone = computed(() => {
            const value = deltaValue.value ?? 0;
            if (value > 0) return "up";
            if (value < 0) return "down";
            return "flat";
        });

        return () => (
            <PgCard
                {...attrs}
                class={["pg-stat-chart-card", attrs.class].filter(Boolean).join(" ")}
                role={attrs.role ?? "region"}
                aria-label={props.ariaLabel || props.title}
            >
                <div class="pg-stat-chart-card__head">
                    <div class="pg-stat-chart-card__heading">
                        {props.title && <div class="pg-stat-chart-card__title">{props.title}</div>}
                        {props.subtitle && <div class="pg-stat-chart-card__subtitle">{props.subtitle}</div>}
                    </div>
                    <div class="pg-stat-chart-card__meta">
                        {props.value !== undefined && (
                            <div class="pg-stat-chart-card__value pg-tabular">{formatValue(props.value)}</div>
                        )}
                        {deltaValue.value !== undefined && (
                            <span
                                class={["pg-stat-chart-card__delta", `pg-stat-chart-card__delta--${deltaTone.value}`]}
                                aria-label={`Change: ${formatDelta(deltaValue.value)}`}
                            >
                                {formatDelta(deltaValue.value)}
                            </span>
                        )}
                        {(slots.actions || slots.headerActions) && (
                            <div class="pg-stat-chart-card__actions">
                                {(slots.actions ?? slots.headerActions)?.()}
                            </div>
                        )}
                    </div>
                </div>
                <PgChart
                    option={themedOption.value}
                    height={props.height ?? 260}
                    loading={props.loading}
                    empty={props.empty}
                    emptyText={props.emptyText}
                    ariaLabel={props.ariaLabel || props.title}
                    onChartClick={(params: unknown) => emit?.("chartClick", params)}
                />
            </PgCard>
        );
    },
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            value: { type: [String, Number], default: undefined },
            delta: { type: Number, default: undefined },
            option: { type: Object, required: true },
            height: { type: [String, Number], default: 260 },
            loading: { type: Boolean, default: false },
            empty: { type: Boolean, default: false },
            emptyText: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["chartClick"],
        inheritAttrs: true,
    },
);

/** Historical alias kept so page imports can switch source without renaming tags. */
export const StatsChartCard = PgStatChartCard;

export default PgStatChartCard;
