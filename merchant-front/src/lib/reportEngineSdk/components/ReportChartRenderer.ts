import type { z } from "zod";
import type * as echarts from "echarts";
import { renderChartSectionToSvgString } from "../print/ClientVectorPdfExporter";
import type { ChartSectionSchema } from "../types/reportSpec";
import { DEFAULT_MINOR_UNIT_DECIMALS, formatDecimal, minorToMajor, toDecimal } from "../utils/decimalFormat";

export type ChartSection = z.infer<typeof ChartSectionSchema>;

/** Default content width of an A4 portrait page with 14 mm side margins, in CSS px. */
export const DEFAULT_CHART_CONTENT_WIDTH_PX = 688;
const PX_PER_MM = 96 / 25.4;
const CHART_FONT = "'Plus Jakarta Sans', 'Cairo', sans-serif";

/** Shared palette so the HTML legend and the ECharts series use identical colors. */
export const CHART_PALETTE = [
  "#4C6EF5",
  "#94C11F",
  "#495057",
  "#FD7E14",
  "#15AABF",
  "#BE4BDB",
  "#E8590C",
  "#0B7285",
  "#7048E8",
  "#2F9E44",
];

/** echarts needs numbers for plotting; the value is display-only (formatted labels go through Decimal). */
const plotNumber = (value: unknown): number => {
  const parsed = toDecimal(value);
  return parsed ? parsed.toNumber() : 0;
};

const axisFormatter = (format: ChartSection["y_axis_format"]) => (value: number): string => {
  const decimal = toDecimal(value);
  if (!decimal) return String(value);
  switch (format) {
    case "CURRENCY_MINOR":
      return formatDecimal(minorToMajor(decimal), DEFAULT_MINOR_UNIT_DECIMALS);
    case "PERCENT_RATIO":
      return `${formatDecimal(decimal, 2)}%`;
    case "DECIMAL_2":
      return formatDecimal(decimal, 2);
    default:
      return formatDecimal(decimal, 0);
  }
};

export function renderChartSectionToSvg(params: {
  section: ChartSection;
  datasets: Record<string, Array<Record<string, unknown>>>;
  t: (key: string) => string;
  isRtl: boolean;
  /** Width of the page content box in CSS px (portrait A4 ~688, landscape ~1017). */
  contentWidthPx?: number;
}): string {
  const { section, datasets, t, isRtl } = params;
  const rows = datasets[section.dataset_id] ?? [];
  const xValues = rows.map((row) => String(row[section.x_field] ?? ""));
  const chartKind = section.chart_kind;
  const contentWidth = params.contentWidthPx ?? DEFAULT_CHART_CONTENT_WIDTH_PX;
  const widthPx = Math.max(240, Math.round((contentWidth * (section.width_percent ?? 100)) / 100));
  const heightPx = Math.max(160, Math.round(section.height_mm * PX_PER_MM));
  const render = (option: echarts.EChartsOption) =>
    renderChartSectionToSvgString({
      echartsOption: { color: CHART_PALETTE, ...option, textStyle: { fontFamily: CHART_FONT } },
      widthPx,
      heightPx,
    });
  const dateLike = xValues.length > 0 && xValues.every((value) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value));
  const formatCategoryLabel = (value: string): string => {
    if (dateLike) return value.slice(0, 10);
    return value.length > 14 ? `${value.slice(0, 13)}…` : value;
  };
  const rotate = !dateLike && (xValues.length > 7 || xValues.some((value) => value.length > 10));
  const categoryAxis = (): echarts.XAXisComponentOption => ({
    type: "category",
    data: xValues,
    inverse: isRtl,
    axisLabel: {
      fontSize: 7.5,
      interval: 0,
      rotate: rotate ? (isRtl ? -28 : 28) : 0,
      hideOverlap: true,
      width: 72,
      overflow: "truncate",
      formatter: (value: string) => formatCategoryLabel(value),
    },
  });
  const valueAxis = (): echarts.YAXisComponentOption => ({
    type: "value",
    position: isRtl ? "right" : "left",
    axisLabel: { fontSize: 7.5, formatter: axisFormatter(section.y_axis_format) },
  });
  // The section heading is rendered by the HTML renderer; the chart never repeats it.
  const grid = { left: 16, right: 30, top: 12, bottom: 44, containLabel: true };
  // The legend is rendered as wrapping HTML under the chart; ECharts' canvas
  // legend cannot wrap and overflows or hides entries on narrow charts.

  if (chartKind === "HEATMAP") {
    const values: Array<[number, number, number]> = [];
    rows.forEach((row, xIndex) => {
      section.series.forEach((seriesSpec, yIndex) => {
        values.push([xIndex, yIndex, plotNumber(row[seriesSpec.field])]);
      });
    });
    return render({
      animation: false,
      grid: { ...grid, bottom: 58 },
      xAxis: categoryAxis(),
      yAxis: {
        type: "category",
        position: isRtl ? "right" : "left",
        data: section.series.map((seriesSpec) => t(seriesSpec.label_i18n_key)),
        axisLabel: { fontSize: 9 },
      },
      visualMap: {
        min: 0,
        max: Math.max(1, ...values.map((value) => value[2])),
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
      },
      series: [{ type: "heatmap", data: values, label: { show: section.series[0]?.show_value_labels ?? false } }],
    });
  }

  if (chartKind === "WATERFALL") {
    let cumulative = 0;
    const base: number[] = [];
    const delta: number[] = [];
    const first = section.series[0];
    for (const row of rows) {
      const value = plotNumber(row[first?.field ?? ""]);
      base.push(Math.min(cumulative, cumulative + value));
      delta.push(Math.abs(value));
      cumulative += value;
    }
    return render({
      animation: false,
      grid,
      xAxis: categoryAxis(),
      yAxis: valueAxis(),
      series: [
        { name: "base", type: "bar", stack: "waterfall", itemStyle: { color: "transparent" }, data: base, silent: true },
        {
          name: t(first?.label_i18n_key ?? section.title_i18n_key),
          type: "bar",
          stack: "waterfall",
          data: delta,
          itemStyle: first?.color_hex ? { color: first.color_hex } : undefined,
          label: { show: first?.show_value_labels ?? false, fontSize: 7 },
          labelLayout: { hideOverlap: true },
        },
      ],
    });
  }

  const isPie = chartKind === "PIE" || chartKind === "DONUT";
  const horizontalBars =
    (chartKind === "BAR" || chartKind === "STACKED_BAR") &&
    !dateLike &&
    xValues.length <= 10 &&
    xValues.some((value) => value.length > 10);
  const series: echarts.SeriesOption[] = section.series.map((seriesSpec, index) => {
    const rawType =
      seriesSpec.type_override ?? (chartKind === "LINE" || chartKind === "AREA" ? "line" : isPie ? "pie" : "bar");
    const type = rawType === "area" ? "line" : rawType;
    const base: Record<string, unknown> = {
      name: t(seriesSpec.label_i18n_key),
      type,
      data: rows.map((row) => plotNumber(row[seriesSpec.field])),
      itemStyle: seriesSpec.color_hex ? { color: seriesSpec.color_hex } : undefined,
      label: { show: seriesSpec.show_value_labels, fontSize: 7 },
      labelLayout: { hideOverlap: true },
    };
    if (type === "line" && (chartKind === "AREA" || seriesSpec.type_override === "area")) base.areaStyle = {};
    if (chartKind === "STACKED_BAR") base.stack = "total";
    if (type === "pie") {
      base.data = rows.map((row) => ({ name: String(row[section.x_field] ?? ""), value: plotNumber(row[seriesSpec.field]) }));
      base.radius = chartKind === "DONUT" ? ["40%", "64%"] : "62%";
      base.center = ["50%", "43%"];
      base.label = { show: false };
      base.labelLine = { show: false };
      base.emphasis = { label: { show: false } };
    }
    if (chartKind === "COMBO_BAR_LINE") base.type = index === 0 ? "bar" : "line";
    if (horizontalBars) {
      base.label = { show: seriesSpec.show_value_labels, position: "right", fontSize: 7 };
    }
    return base as echarts.SeriesOption;
  });

  if (horizontalBars) {
    return render({
      animation: false,
      grid: { left: 10, right: 24, top: 12, bottom: 20, containLabel: true },
      xAxis: {
        type: "value",
        axisLabel: { fontSize: 7.5, formatter: axisFormatter(section.y_axis_format) },
      },
      yAxis: {
        type: "category",
        data: xValues,
        inverse: !isRtl,
        axisLabel: { fontSize: 7.5, width: 120, overflow: "truncate", hideOverlap: true },
      },
      series,
    });
  }

  return render({
    animation: false,
    grid,
    xAxis: isPie ? undefined : categoryAxis(),
    yAxis: isPie ? undefined : valueAxis(),
    series,
  });
}
