import { dc } from "kt-dc";
import { VCard, VCardText, VIcon, VProgressCircular } from "vuetify/components";
import { useDisplay } from "vuetify";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import colors from "vuetify/util/colors";
import VChart from "vue-echarts";
import * as echartsCore from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";

// Register ECharts components
echartsCore.use([CanvasRenderer, BarChart, GridComponent, TooltipComponent, LegendComponent]);

export type StatsCardProps = {
    title: string;
    metricKey: string;
    range?: "today" | "last_7d" | "last_30d";
    color?: string;
    icon?: string;
    loading?: boolean;
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

        const chartOption = () => ({
            tooltip: {
                trigger: "axis",
                backgroundColor: "rgba(30,30,30,0.9)",
                textStyle: { color: "#fff" },
                formatter: (params: any) => {
                    const d = params[0];
                    const date = new Date(d.data[0] * 1000);
                    return `${date.toLocaleDateString()}: ${d.data[1].toLocaleString()}`;
                },
            },
            grid: {
                left: isMobile ? "5%" : "10%",
                right: isMobile ? "5%" : "5%",
                top: isMobile ? "10%" : "15%",
                bottom: isMobile ? "10%" : "15%",
            },
            xAxis: {
                type: "time",
                axisLabel: {
                    color: "#888",
                    fontSize: isMobile ? 10 : 12,
                    formatter: (value: number) => {
                        const date = new Date(value * 1000);
                        return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                    },
                },
                splitLine: { show: false },
            },
            yAxis: {
                type: "value",
                axisLabel: {
                    color: "#888",
                    fontSize: isMobile ? 10 : 12,
                },
                splitLine: {
                    lineStyle: { color: "rgba(255,255,255,0.05)" },
                },
            },
            series: [
                {
                    type: "bar",
                    data: data.value,
                    itemStyle: {
                        color: props.color || colors.blue.base,
                        borderRadius: [4, 4, 0, 0],
                    },
                    barMaxWidth: isMobile ? 20 : 40,
                },
            ],
        });

        return () => {
            const color = props.color || colors.blue.base;

            return (
                <Card>
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
                                <VChart option={chartOption()} autoresize style={{ height: "100%", width: "100%" }} />
                            </div>
                        </>
                    )}
                </Card>
            );
        };
    },
    {
        props: ["title", "metricKey", "range", "color", "icon", "loading"],
    },
);

export default StatsCard;
