import { dc } from "kt-dc";
import { VCard, VCardText, VIcon, VProgressCircular } from "vuetify/components";
import { useDisplay } from "vuetify";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import colors from "vuetify/util/colors";
import VChart from "vue-echarts";
import * as echartsCore from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts";
import { ref, computed } from "vue";
import { dashDateFormatter } from "kt-common";

// Register ECharts components
echartsCore.use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent]);

export type StatsCardProps = {
    title: string;
    metricKey: string;
    range?: "today" | "last_7d" | "last_30d";
    color?: string;
    icon?: string;
    loading?: boolean;
    height?: number;
};

const StatsCard = dc(
    (props: StatsCardProps) => {
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
                        max_points: 30,
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

        // Auto-fetch on mount
        fetchData();

        // Convert incoming timestamps (assumed seconds) to milliseconds for ECharts' time axis
        const seriesData = computed(() => data.value.map(([t, v]) => [t * 1000, v]));

        const chartOption = computed<EChartsCoreOption>(() => ({
            tooltip: {
                trigger: "axis",
                backgroundColor: "rgba(30,30,30,0.9)",
                textStyle: { color: "#fff" },
                formatter: (params: any) => {
                    const d = params[0];
                    const date = dashDateFormatter(d.data[0]);
                    const value = typeof d.data[1] === "number" ? d.data[1] : Number(d.data[1]);
                    return `${date}: ${value.toLocaleString()}`;
                },
            },
            grid: {
                // Reduced outer margins because containLabel will handle the padding automatically
                left: isMobile ? "2%" : "5%",
                right: isMobile ? "5%" : "5%",
                top: isMobile ? "10%" : "15%",
                bottom: isMobile ? "5%" : "10%",
                containLabel: true, // <-- FIX 1: Ensures labels are never cut off
            },
            xAxis: {
                type: "time",
                axisLabel: {
                    color: "#888",
                    fontSize: isMobile ? 10 : 12,
                    hideOverlap: true, // <-- FIX 2: Drops labels if they start colliding
                    formatter: (value: number) => {
                        return dashDateFormatter(new Date(value), {
                            getDate: true,
                            getTime: false,
                        });
                    },
                },
                splitLine: { show: false },
                boundaryGap: false,
            },
            yAxis: {
                type: "value",
                axisLabel: {
                    color: "#888",
                    fontSize: isMobile ? 10 : 12,
                    hideOverlap: true, // <-- FIX 3: Prevents vertical text collision
                    formatter: (v: number) => {
                        if (typeof v !== "number") return String(v);

                        // <-- FIX 4: Use compact formatting for mobile (e.g. 15,000 -> 15K)
                        if (isMobile && v >= 1000) {
                            return Intl.NumberFormat("en-US", {
                                notation: "compact",
                                compactDisplay: "short",
                            }).format(v);
                        }

                        return v.toLocaleString();
                    },
                },
                splitLine: {
                    lineStyle: { color: "rgba(255,255,255,0.05)" },
                },
            },
            series: [
                {
                    type: "line",
                    data: seriesData.value,
                    smooth: true,
                    showSymbol: false,
                    symbol: "circle",
                    lineStyle: {
                        width: isMobile ? 2 : 3,
                    },
                    itemStyle: {
                        color: props.color || colors.blue.base,
                    },
                    areaStyle: {
                        opacity: 0.12,
                    },
                    emphasis: {
                        focus: "series",
                    },
                },
            ],
        }));

        return () => {
            const color = props.color || colors.blue.base;

            return (
                <Card style={{ width: "100%" }}>
                    <ThemedView>
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
                                <div style={{ "font-size": isMobile ? "24px" : "28px", "font-weight": 700, color, "margin-bottom": "8px" }}>
                                    {total.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </div>
                                <div style={{ height: isMobile ? "80px" : "100px" }}>
                                    <VChart option={chartOption.value} autoresize style={{ height: "100%", width: "100%" }} />
                                </div>
                            </>
                        )}
                    </ThemedView>
                </Card>
            );
        };
    },
    {
        props: ["title", "height", "metricKey", "range", "color", "icon", "loading"],
    },
);

export default StatsCard;
