import { dc } from "kt-dc";
import { VCard, VIcon, VProgressCircular } from "vuetify/components";
import { useDisplay } from "vuetify";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import colors from "vuetify/util/colors";
import VChart from "vue-echarts";
import * as echartsCore from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts";
import { ref, computed, onMounted } from "vue";
import { dashDateFormatter } from "kt-common";

// Register ECharts components
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
        const isMobile = display.mobile.value;

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

        // Format data for bar chart
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
            const color = props.color || colors.blue.base;
            return {
                tooltip: {
                    trigger: "axis",
                    backgroundColor: "rgba(30,30,30,0.9)",
                    textStyle: { color: "#fff" },
                    formatter: (params: any) => {
                        const d = params[0];
                        const value = typeof d.value === "number" ? d.value.toLocaleString() : String(d.value);
                        return `${d.name}: ${value}`;
                    },
                },
                grid: {
                    left: isMobile ? "3%" : "8%",
                    right: isMobile ? "3%" : "5%",
                    top: isMobile ? "10%" : "15%",
                    bottom: isMobile ? "15%" : "20%",
                },
                xAxis: {
                    type: "category",
                    data: xAxisData.value,
                    axisLabel: {
                        color: "#888",
                        fontSize: isMobile ? 9 : 11,
                        rotate: isMobile ? 45 : 30,
                        formatter: (value: string) => {
                            // Shorten date for mobile
                            if (isMobile && value.length > 5) {
                                return value.substring(5);
                            }
                            return value;
                        },
                    },
                    axisLine: {
                        lineStyle: { color: "#444" },
                    },
                    splitLine: { show: false },
                },
                yAxis: {
                    type: "value",
                    axisLabel: {
                        color: "#888",
                        fontSize: isMobile ? 10 : 11,
                        formatter: (v: number) => {
                            if (typeof v !== "number") return String(v);
                            if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
                            if (v >= 1000) return (v / 1000).toFixed(1) + "K";
                            return v.toLocaleString();
                        },
                    },
                    splitLine: {
                        lineStyle: { color: "rgba(255,255,255,0.05)" },
                    },
                },
                series: [
                    {
                        type: "bar",
                        data: seriesData.value.map((d) => d.value),
                        smooth: false,
                        barMaxWidth: isMobile ? 20 : 40,
                        itemStyle: {
                            color: color,
                            borderRadius: isMobile ? [2, 2, 0, 0] : [4, 4, 0, 0],
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
            const color = props.color || colors.blue.base;
            const chartHeight = props.height || (isMobile ? 100 : 140);

            return (
                <VCard style={{ width: "100%" }}>
                    <div style={{ padding: "16px" }}>
                        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "12px" }}>
                            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                                {props.icon && <VIcon style={{ color, "font-size": "18px" }}>{props.icon}</VIcon>}
                                <span style={{ "font-size": isMobile ? "12px" : "14px", opacity: 0.7 }}>{props.title}</span>
                            </div>
                        </div>

                        {loading.value ? (
                            <div style={{ display: "flex", "justify-content": "center", padding: "20px" }}>
                                <VProgressCircular indeterminate size="32" color="primary" />
                            </div>
                        ) : (
                            <>
                                <div style={{ "font-size": isMobile ? "20px" : "24px", "font-weight": "700", color, "margin-bottom": "8px" }}>
                                    {total.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </div>
                                <div style={{ height: `${chartHeight}px` }}>
                                    <VChart option={chartOption.value} autoresize style={{ height: "100%", width: "100%" }} />
                                </div>
                            </>
                        )}
                    </div>
                </VCard>
            );
        };
    },
    {
        props: ["title", "height", "metricKey", "range", "color", "icon", "loading"],
    },
);

export default StatsBarChartCard;
