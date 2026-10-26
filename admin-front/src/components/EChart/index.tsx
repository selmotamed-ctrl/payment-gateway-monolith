import { dc } from "kt-dc";
import VChart from "vue-echarts";
import * as echartsCore from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
    GridComponent,
    TooltipComponent,
    LegendComponent,
    TitleComponent,
    DataZoomComponent,
    MarkLineComponent,
} from "echarts/components";

echartsCore.use([
    CanvasRenderer,
    BarChart,
    LineChart,
    PieChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    TitleComponent,
    DataZoomComponent,
    MarkLineComponent,
]);

export type EChartProps = {
    option: Record<string, any>;
    height?: string;
};

export const EChart = dc(
    (props: EChartProps) => {
        return () => (
            <VChart
                option={props.option}
                autoresize
                style={{ height: props.height ?? "300px", width: "100%", direction: "ltr" }}
            />
        );
    },
    {
        props: ["option", "height"],
    },
);

export default EChart;
