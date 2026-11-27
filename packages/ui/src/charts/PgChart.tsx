import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { dc } from "../lib/dc";
import { resolvedTheme } from "../lib/theme";
import { useLocale } from "../lib/locale";
import { PgEmptyState, PgSkeleton } from "../feedback/PgEmptyState";

export type PgChartSize = string | number;

export interface PgChartProps {
    /** Reactive ECharts configuration. */
    option: EChartsOption;
    /** Explicit viewport height; defaults to 260px and can never collapse to 0. */
    height?: PgChartSize;
    /** Explicit viewport width; defaults to 100%. */
    width?: PgChartSize;
    /** Lower bound for the viewport height; defaults to `height`. */
    minHeight?: PgChartSize;
    /** Attach a ResizeObserver and resize the chart when the container changes. */
    autoresize?: boolean;
    /** Show the skeleton overlay while data is loading. */
    loading?: boolean;
    /** Show the empty-state overlay instead of blank axes. */
    empty?: boolean;
    emptyText?: string;
    ariaLabel?: string;
}

const toCssSize = (value: PgChartSize | undefined, fallback: string): string => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return `${value}px`;
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
};

const readViewport = (element: HTMLElement | null): { width: number; height: number } => {
    if (!element || typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
        return { width: 0, height: 0 };
    }
    try {
        const computed = window.getComputedStyle(element);
        return {
            width: Number.parseFloat(computed.width || "0"),
            height: Number.parseFloat(computed.height || "0"),
        };
    } catch {
        return { width: 0, height: 0 };
    }
};

/**
 * Shared ECharts Vapor wrapper.
 *
 * The viewport always receives an explicit `height` (default 260px) plus a
 * matching `min-height`, so ECharts can never initialize inside a collapsed
 * `height: auto` parent (the historical 0px dashboard bug). Rendering uses the
 * SVG renderer, a transparent background and a ResizeObserver; changing the
 * resolved light/dark theme disposes and re-creates the instance cleanly.
 */
export const PgChart = dc(
    (props: PgChartProps, expose, { attrs, emit }) => {
        const { t } = useLocale();
        const canvas = ref<HTMLElement | null>(null);
        const root = ref<HTMLElement | null>(null);
        const state = ref<"pending" | "ready">("pending");
        let chart: echarts.ECharts | null = null;
        let observer: ResizeObserver | null = null;
        let disposed = false;

        const onChartClick = (params: unknown) => {
            emit?.("chartClick", params);
        };

        const canInitialize = (): boolean => {
            const viewport = readViewport(canvas.value);
            return viewport.width > 0 && viewport.height > 0;
        };

        const disposeChart = () => {
            if (chart) {
                try {
                    chart.dispose();
                } catch {
                    /* a chart can already be torn down with its host document */
                }
            }
            chart = null;
            state.value = "pending";
        };

        const initializeChart = () => {
            if (disposed || chart || !canvas.value) return;
            // Never initialize into a hidden tab or a zero-height card. The
            // ResizeObserver retries as soon as the container has real pixels;
            // the explicit inline height is already applied either way.
            if (!canInitialize()) return;
            try {
                chart = echarts.init(canvas.value, undefined, { renderer: "svg" });
                chart.setOption((props.option ?? {}) as EChartsOption, true);
                chart.on("click", onChartClick);
                state.value = "ready";
            } catch {
                chart = null;
                state.value = "pending";
            }
        };

        const onResize = () => {
            if (!chart) {
                initializeChart();
                return;
            }
            const viewport = readViewport(canvas.value);
            if (viewport.width > 0 && viewport.height > 0) {
                try {
                    chart.resize();
                } catch {
                    /* the host may be mid-teardown */
                }
            }
        };

        const attachObserver = () => {
            if (props.autoresize === false || observer) return;
            if (typeof ResizeObserver === "undefined" || !root.value) return;
            observer = new ResizeObserver(onResize);
            observer.observe(root.value);
        };

        onMounted(() => {
            // The observer is attached before the first init so a chart mounted
            // inside a hidden tab still initializes the moment it is shown.
            attachObserver();
            initializeChart();
        });

        watch(
            () => props.option,
            (option) => {
                if (!chart) return;
                try {
                    chart.setOption((option ?? {}) as EChartsOption, true);
                } catch {
                    /* defensive: a malformed option must not unmount the page */
                }
            },
            { deep: true },
        );

        watch(resolvedTheme, () => {
            const wasReady = Boolean(chart);
            disposeChart();
            if (wasReady) initializeChart();
        });

        onBeforeUnmount(() => {
            disposed = true;
            observer?.disconnect();
            observer = null;
            disposeChart();
        });

        expose?.({
            resize: () => chart?.resize(),
            getChart: () => chart,
        });

        return () => {
            const height = toCssSize(props.height, "260px");
            const width = toCssSize(props.width, "100%");
            const minHeight = toCssSize(props.minHeight, height);
            const callerStyle = attrs.style as Record<string, unknown> | undefined;
            const style: Record<string, unknown> = {
                width,
                height,
                ...(callerStyle && typeof callerStyle === "object" && !Array.isArray(callerStyle) ? callerStyle : {}),
                minHeight: (callerStyle as Record<string, unknown> | undefined)?.minHeight ?? minHeight,
                maxWidth: "100%",
            };

            return (
                <div
                    {...attrs}
                    ref={root}
                    class={["pg-chart", attrs.class].filter(Boolean).join(" ")}
                    style={style as any}
                    role="img"
                    aria-label={props.ariaLabel || "Chart"}
                    aria-busy={props.loading ? "true" : "false"}
                    data-pg-chart-state={state.value}
                    data-pg-chart-theme={resolvedTheme.value}
                >
                    <div ref={canvas} class="pg-chart__canvas" style={{ width: "100%", height: "100%" }} />
                    {props.loading && (
                        <div class="pg-chart__state pg-chart__state--loading">
                            <PgSkeleton height={height} radius="var(--pg-radius-md)" />
                        </div>
                    )}
                    {!props.loading && props.empty && (
                        <div class="pg-chart__state pg-chart__state--empty">
                            <PgEmptyState title={props.emptyText || t("No data")} />
                        </div>
                    )}
                </div>
            );
        };
    },
    {
        props: {
            option: { type: Object as unknown as () => EChartsOption, required: true },
            height: { type: [String, Number], default: "260px" },
            width: { type: [String, Number], default: "100%" },
            minHeight: { type: [String, Number], default: "" },
            autoresize: { type: Boolean, default: true },
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
export const EChart = PgChart;

export default PgChart;
