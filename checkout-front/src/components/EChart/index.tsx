import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { dc } from "@/utils/dc";

/**
 * Vapor-owned ECharts wrapper. Replaces `vue-echarts` (a Virtual DOM
 * component) so the last interop component can be removed.
 */
export const EChart = dc(
    (
        props: {
            option: echarts.EChartsOption;
            autoresize?: boolean;
            style?: unknown;
            class?: string;
        },
        _expose,
        { attrs },
    ) => {
        const el = ref<HTMLElement | null>(null);
        let chart: echarts.ECharts | null = null;
        let observer: ResizeObserver | null = null;

        onMounted(() => {
            if (!el.value) return;
            chart = echarts.init(el.value);
            chart.setOption(props.option);
            if (props.autoresize !== false && typeof ResizeObserver !== "undefined") {
                observer = new ResizeObserver(() => chart?.resize());
                observer.observe(el.value);
            }
        });

        watch(
            () => props.option,
            (option) => chart?.setOption(option, true),
            { deep: true },
        );

        onBeforeUnmount(() => {
            observer?.disconnect();
            chart?.dispose();
            chart = null;
        });

        return () => (
            <div
                {...attrs}
                ref={el}
                class={props.class}
                style={[
                    { width: "100%", height: "100%" },
                    props.style as any,
                ]}
            />
        );
    },
    {
        props: {
            option: { type: Object, required: true },
            autoresize: { type: Boolean, default: true },
            style: { type: [String, Object, Array], default: undefined },
            class: { type: String, default: "" },
        },
    },
);

export default EChart;
