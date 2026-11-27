import { defineAsyncComponent } from "vue";

/**
 * The chart component loads echarts (about 600 kB) on first render instead of with the page that contains it:
 * the dashboard is the default landing page, and a chart is not needed to paint its cards and tables.
 * Use this instead of a static `import "@/components/EChart"`.
 */
export const LazyEChart = defineAsyncComponent(() => import("./index").then((module) => module.default));
export default LazyEChart;
