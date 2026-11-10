import type { z } from "zod";
import type * as echarts from "echarts";
import { renderChartSectionToSvgString } from "../print/ClientVectorPdfExporter";
import type { ChartSectionSchema } from "../types/reportSpec";

export type ChartSection = z.infer<typeof ChartSectionSchema>;

export function renderChartSectionToSvg(params: {
  section: ChartSection;
  datasets: Record<string, Array<Record<string, unknown>>>;
  t: (key: string) => string;
  isRtl: boolean;
}): string {
  const { section, datasets, t, isRtl } = params;
  const rows = datasets[section.dataset_id] ?? [];
  const xValues = rows.map((row) => String(row[section.x_field] ?? ""));
  const chartKind = section.chart_kind;

  if (chartKind === "HEATMAP") {
    const values: Array<[number, number, number]> = [];
    rows.forEach((row, xIndex) => {
      section.series.forEach((seriesSpec, yIndex) => {
        values.push([xIndex, yIndex, Number(row[seriesSpec.field] ?? 0)]);
      });
    });
    const option: echarts.EChartsOption = {
      animation: false,
      title: { text: t(section.title_i18n_key), left: isRtl ? "right" : "left", textStyle: { fontSize: 13 } },
      tooltip: { position: "top" },
      grid: { left: 70, right: 20, top: 42, bottom: 42, containLabel: true },
      xAxis: { type: "category", data: xValues, axisLabel: { fontSize: 9 } },
      yAxis: { type: "category", data: section.series.map((seriesSpec) => t(seriesSpec.label_i18n_key)), axisLabel: { fontSize: 9 } },
      visualMap: { min: 0, max: Math.max(1, ...values.map((value) => value[2])), calculable: true, orient: "horizontal", left: "center", bottom: 0 },
      series: [{ type: "heatmap", data: values, label: { show: section.series[0]?.show_value_labels ?? false } }],
    };
    return renderChartSectionToSvgString({ echartsOption: option, widthPx: 900, heightPx: Math.max(220, section.height_mm * 3.78) });
  }

  if (chartKind === "WATERFALL") {
    let cumulative = 0;
    const base: number[] = [];
    const delta: number[] = [];
    const first = section.series[0];
    for (const row of rows) {
      const value = Number(row[first?.field ?? ""] ?? 0);
      const start = Math.min(cumulative, cumulative + value);
      base.push(start);
      delta.push(Math.abs(value));
      cumulative += value;
    }
    const option: echarts.EChartsOption = {
      animation: false,
      title: { text: t(section.title_i18n_key), left: isRtl ? "right" : "left", textStyle: { fontSize: 13 } },
      tooltip: { trigger: "axis" },
      grid: { left: 52, right: 20, top: 42, bottom: 42, containLabel: true },
      xAxis: { type: "category", data: xValues, axisLabel: { fontSize: 9 } },
      yAxis: { type: "value", axisLabel: { fontSize: 9, formatter: (value: number) => `${(value / 1000).toFixed(3)}` } },
      series: [
        { name: "base", type: "bar", stack: "waterfall", itemStyle: { color: "transparent" }, data: base, silent: true },
        { name: t(first?.label_i18n_key ?? section.title_i18n_key), type: "bar", stack: "waterfall", data: delta, itemStyle: { color: first?.color_hex } },
      ],
    };
    return renderChartSectionToSvgString({ echartsOption: option, widthPx: 900, heightPx: Math.max(220, section.height_mm * 3.78) });
  }

  const series: echarts.SeriesOption[] = section.series.map((seriesSpec, index) => {
    const data = rows.map((row) => Number(row[seriesSpec.field] ?? 0));
    const rawType =
      seriesSpec.type_override ??
      (chartKind === "LINE" || chartKind === "AREA"
        ? "line"
        : chartKind === "PIE" || chartKind === "DONUT"
          ? "pie"
          : "bar");
    const type = rawType === "area" ? "line" : rawType;
    const base: Record<string, unknown> = {
      name: t(seriesSpec.label_i18n_key),
      type,
      data,
      itemStyle: seriesSpec.color_hex ? { color: seriesSpec.color_hex } : undefined,
      label: { show: seriesSpec.show_value_labels },
    };
    if (type === "line" && chartKind === "AREA") {
      base.areaStyle = {};
    }
    if (chartKind === "STACKED_BAR") {
      base.stack = "total";
    }
    if (type === "pie") {
      base.data = rows.map((row) => ({
        name: String(row[section.x_field] ?? ""),
        value: Number(row[seriesSpec.field] ?? 0),
      }));
      base.radius = chartKind === "DONUT" ? ["45%", "70%"] : undefined;
    }
    if (chartKind === "COMBO_BAR_LINE") {
      base.type = index === 0 ? "bar" : "line";
    }
    return base as echarts.SeriesOption;
  });

  const yAxisFormatter = (value: number): string => {
    switch (section.y_axis_format) {
      case "CURRENCY_MINOR":
        return `${(value / 1000).toFixed(3)}`;
      case "PERCENT_RATIO":
        return `${value.toFixed(2)}%`;
      case "DECIMAL_2":
        return value.toFixed(2);
      default:
        return String(Math.round(value));
    }
  };

  const option: echarts.EChartsOption = {
    animation: false,
    title: { text: t(section.title_i18n_key), left: isRtl ? "right" : "left", textStyle: { fontSize: 13 } },
    tooltip: { trigger: chartKind === "PIE" || chartKind === "DONUT" ? "item" : "axis" },
    legend: { bottom: 0, textStyle: { fontSize: 10 } },
    grid: { left: 52, right: 20, top: 42, bottom: 42, containLabel: true },
    xAxis:
      chartKind === "PIE" || chartKind === "DONUT"
        ? undefined
        : {
            type: "category",
            data: xValues,
            axisLabel: { fontSize: 9, formatter: (value: string) => value.slice(0, 16) },
          },
    yAxis:
      chartKind === "PIE" || chartKind === "DONUT"
        ? undefined
        : { type: "value", axisLabel: { fontSize: 9, formatter: yAxisFormatter } },
    series,
    textStyle: { fontFamily: "Inter, sans-serif" },
  };

  return renderChartSectionToSvgString({
    echartsOption: option,
    widthPx: 900,
    heightPx: Math.max(220, section.height_mm * 3.78),
  });
}
