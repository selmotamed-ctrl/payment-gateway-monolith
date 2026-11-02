import { dc } from "kt-dc";
import { VIcon, VProgressCircular } from "vuetify/components";
import { useDisplay, useTheme } from "vuetify";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import VChart from "vue-echarts";
import * as echartsCore from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts";
import { ref, computed, onMounted } from "vue";
import { dashDateFormatter } from "kt-common";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

echartsCore.use([CanvasRenderer, BarChart, GridComponent, TooltipComponent, LegendComponent]);

export type StatsBarChartCardProps = {
    title: string;
    metricKey: string;
    range?: "today" | "last_7d" | "last_30d";
    color?: string;
    icon?: string;
    loading?: boolean;
    height?: number;
};

const StatsBarChartCard = dc(
    (props: StatsBarChartCardProps) => {
        const display = useDisplay();
        const theme = useTheme();
        const isMobile = computed(() => display.mobile.value);
        const palette = computed(() => theme.current.value.colors);
        const accent = computed(() => props.color || palette.value.primary);

        const loading = ref(props.loading ?? true);
        const data = ref<[number, number][]>([]);
        const total = ref(0);

        const fetchData = async () => {
            loading.value = true;
            try {
                const response = await api.get(urlsMap.statsMetric.replace(":mk", props.metricKey), {
                    params: {
                        metricKey: props.metricKey,
                        range: props.range || "last_30d",
                        max_points: props.range === "last_7d" ? 7 : 30,
                    },
                });
                data.value = response.data?.data || [];
                total.value = data.value.reduce((sum: number, d: [number, number]) => sum + (d[1] || 0), 0);
            } catch (e) {
                console.error(`Failed to fetch ${props.metricKey}:`, e);
            } finally {
                loading.value = false;
            }
        };

        onMounted(() => {
            fetchData();
        });

        const seriesData = computed(() => {
            return data.value.map(([t, v]) => ({
                value: v,
                name: dashDateFormatter(new Date(t * 1000)),
            }));
        });

        const xAxisData = computed(() => {
            return seriesData.value.map((d) => d.name);
        });

        const chartOption = computed<EChartsCoreOption>(() => {
            return {
                tooltip: {
                    trigger: "axis",
                    backgroundColor: palette.value.surface,
                    textStyle: { color: palette.value["on-surface"] },
                    formatter: (params: any) => {
                        const d = params[0];
                        const value = typeof d.value === "number" ? d.value.toLocaleString() : String(d.value);
                        return `${d.name}: ${value}`;
                    },
                },
                grid: {
                    left: isMobile.value ? "3%" : "8%",
                    right: isMobile.value ? "3%" : "5%",
                    top: isMobile.value ? "10%" : "15%",
                    bottom: isMobile.value ? "15%" : "20%",
                },
                xAxis: {
                    type: "category",
                    data: xAxisData.value,
                    axisLabel: {
                        color: palette.value["on-surface-variant"],
                        fontSize: isMobile.value ? 9 : 11,
                        rotate: isMobile.value ? 45 : 30,
                        formatter: (value: string) => {
                            if (isMobile.value && value.length > 5) {
                                return value.substring(5);
                            }
                            return value;
                        },
                    },
                    axisLine: {
                        lineStyle: { color: palette.value["on-surface-variant"] },
                    },
                    splitLine: { show: false },
                },
                yAxis: {
                    type: "value",
                    axisLabel: {
                        color: palette.value["on-surface-variant"],
                        fontSize: isMobile.value ? 10 : 11,
                        formatter: (v: number) => {
                            if (typeof v !== "number") return String(v);
                            if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
                            if (v >= 1000) return (v / 1000).toFixed(1) + "K";
                            return v.toLocaleString();
                        },
                    },
                    splitLine: {
                        lineStyle: {
                            color: palette.value["on-surface-variant"],
                            opacity: 0.12,
                        },
                    },
                },
                series: [
                    {
                        type: "bar",
                        data: seriesData.value.map((d) => d.value),
                        smooth: false,
                        barMaxWidth: isMobile.value ? 20 : 40,
                        itemStyle: {
                            color: accent.value,
                            borderRadius: isMobile.value ? [2, 2, 0, 0] : [4, 4, 0, 0],
                        },
                        emphasis: {
                            focus: "series",
                            itemStyle: {
                                opacity: 0.8,
                            },
                        },
                    },
                ],
            };
        });

        return () => {
            const chartHeight = props.height || (isMobile.value ? 100 : 140);

            return (
                <SurfaceCard>
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            {props.icon && (
                                <VIcon size={18} icon={props.icon} style={{ color: accent.value }} />
                            )}
                            <span style={{ fontSize: isMobile.value ? "12px" : "13.5px", color: "var(--pg-ink-muted)" }}>
                                {props.title}
                            </span>
                        </div>

                        {loading.value ? (
                            <div style={{ display: "flex", justifyContent: "center", padding: "20px" }}>
                                <VProgressCircular indeterminate size="32" color="primary" />
                            </div>
                        ) : (
                            <>
                                <div
                                    class="pg-tabular"
                                    style={{
                                        fontSize: isMobile.value ? "20px" : "24px",
                                        fontWeight: 600,
                                        color: "var(--pg-ink-primary)",
                                    }}
                                >
                                    {total.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </div>
                                <div style={{ height: `${chartHeight}px` }}>
                                    <VChart option={chartOption.value} autoresize style={{ height: "100%", width: "100%" }} />
                                </div>
                            </>
                        )}
                    </div>
                </SurfaceCard>
            );
        };
    },
    {
        props: ["title", "height", "metricKey", "range", "color", "icon", "loading"],
    },
);

export default StatsBarChartCard;
