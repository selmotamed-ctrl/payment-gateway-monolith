import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dc } from "../src/lib/dc";
import { mount } from "./helpers/render";

/* The real ECharts needs canvas text metrics that jsdom does not provide; the
 * wrapper contract (init, option updates, theme re-init, click forwarding) is
 * asserted against a recording instance and the real container geometry. */
const echartsMock = vi.hoisted(() => {
    const instances: any[] = [];
    const init = vi.fn((element: HTMLElement) => {
        const instance: any = {
            element,
            options: [] as any[],
            handlers: {} as Record<string, (params: any) => void>,
            setOption: vi.fn((option: any) => {
                instance.options.push(option);
            }),
            resize: vi.fn(),
            dispose: vi.fn(),
            on: vi.fn((event: string, handler: (params: any) => void) => {
                instance.handlers[event] = handler;
            }),
        };
        instances.push(instance);
        return instance;
    });
    return {
        init,
        instances,
        reset: () => {
            instances.length = 0;
            init.mockClear();
        },
    };
});

vi.mock("echarts", () => ({ init: echartsMock.init }));

import {
    CHART_CATEGORICAL_DARK,
    CHART_CATEGORICAL_LIGHT,
    CHART_GRID,
    CHART_TEXT,
    chartPalette,
    chartToneColor,
    EChart,
    PgChart,
    PgStatBarChartCard,
    PgStatChartCard,
    StatsBarChartCard,
    StatsChartCard,
} from "../src/charts";
import { resolvedTheme, setThemeMode } from "../src/lib/theme";

const originalGetComputedStyle = window.getComputedStyle.bind(window);
let forcedViewport = { width: "600px", height: "260px" };
let computedSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    echartsMock.reset();
    setThemeMode("light");
    forcedViewport = { width: "600px", height: "260px" };
    computedSpy = vi.spyOn(window, "getComputedStyle").mockImplementation(((element: Element) => {
        if (element instanceof HTMLElement && element.classList.contains("pg-chart__canvas")) {
            return { width: forcedViewport.width, height: forcedViewport.height } as CSSStyleDeclaration;
        }
        return originalGetComputedStyle(element);
    }) as typeof window.getComputedStyle);
});

afterEach(() => {
    computedSpy.mockRestore();
    setThemeMode("system");
});

const firstChart = () => echartsMock.instances[0];

/**
 * Vapor treats a function-valued root prop as a reactive source and calls it
 * with no arguments. Real page JSX passes handlers as compiled dynamic props,
 * so tests use the same `$` dynamic-source channel for handlers/formatters.
 */
const mountCharts = (component: any, props: Record<string, any>, dynamic: Record<string, any> = {}) =>
    mount(component, { ...props, $: [() => dynamic] } as any);

const option = {
    xAxis: { type: "category", data: ["A", "B"] },
    yAxis: { type: "value" },
    series: [{ type: "bar", data: [10, 20] }],
};

describe("PgChart", () => {
    it("applies an explicit height and min-height so the viewport can never collapse", async () => {
        const { el, unmount } = mount(PgChart, { option });
        const chart = el.querySelector(".pg-chart") as HTMLElement;
        expect(chart).toBeTruthy();
        expect(chart.style.height).toBe("260px");
        expect(chart.style.minHeight).toBe("260px");
        expect(chart.style.width).toBe("100%");
        expect(chart.getAttribute("role")).toBe("img");
        expect(chart.getAttribute("aria-label")).toBe("Chart");
        expect(echartsMock.init).toHaveBeenCalledTimes(1);
        expect(echartsMock.init).toHaveBeenCalledWith(expect.any(HTMLElement), undefined, { renderer: "svg" });
        expect(firstChart().setOption).toHaveBeenCalledWith(option, true);
        await nextTick();
        expect(chart.getAttribute("data-pg-chart-state")).toBe("ready");
        unmount();
    });

    it("honours an explicit pixel height", () => {
        const { el, unmount } = mount(PgChart, { option, height: 280 });
        const chart = el.querySelector(".pg-chart") as HTMLElement;
        expect(chart.style.height).toBe("280px");
        expect(chart.style.minHeight).toBe("280px");
        unmount();
    });

    it("falls back to 260px instead of accepting a zero height", () => {
        const { el, unmount } = mount(PgChart, { option, height: 0, minHeight: 0 });
        const chart = el.querySelector(".pg-chart") as HTMLElement;
        expect(chart.style.height).toBe("260px");
        expect(chart.style.minHeight).toBe("260px");
        unmount();
    });

    it("updates the chart when the option prop changes", async () => {
        const liveOption = ref<any>({ series: [{ type: "bar", data: [1] }] });
        const Host = dc(() => () => <PgChart option={liveOption.value} />);
        const { unmount } = mount(Host as any, {});
        const chart = firstChart();
        const next = { series: [{ type: "bar", data: [2, 3] }] };
        liveOption.value = next;
        await nextTick();
        await nextTick();
        expect(chart.setOption).toHaveBeenLastCalledWith(next, true);
        unmount();
    });

    it("disposes and re-initializes on a resolvedTheme change without throwing", async () => {
        const { el, unmount } = mount(PgChart, { option });
        const root = el.querySelector(".pg-chart") as HTMLElement;
        expect(root.getAttribute("data-pg-chart-theme")).toBe("light");
        expect(resolvedTheme.value).toBe("light");
        const first = firstChart();

        setThemeMode("dark");
        await nextTick();
        await nextTick();

        expect(resolvedTheme.value).toBe("dark");
        expect(root.getAttribute("data-pg-chart-theme")).toBe("dark");
        expect(first.dispose).toHaveBeenCalledTimes(1);
        expect(echartsMock.init).toHaveBeenCalledTimes(2);
        const second = echartsMock.instances.at(-1)!;
        expect(second).not.toBe(first);
        expect(second.element).toBe(first.element);
        expect(second.setOption).toHaveBeenCalledWith(option, true);
        unmount();
    });

    it("forwards ECharts clicks as chartClick", () => {
        const onClick = vi.fn();
        const { unmount } = mountCharts(PgChart, { option }, { onChartClick: onClick });
        firstChart().handlers.click({ name: "A", seriesName: "Series", value: 10 });
        expect(onClick).toHaveBeenCalledWith({ name: "A", seriesName: "Series", value: 10 });
        unmount();
    });

    it("renders the loading skeleton at the chart height", () => {
        const { el, unmount } = mount(PgChart, { option, loading: true });
        const root = el.querySelector(".pg-chart") as HTMLElement;
        expect(root.style.height).toBe("260px");
        expect(root.getAttribute("aria-busy")).toBe("true");
        expect(el.querySelector(".pg-skeleton")).toBeTruthy();
        expect(el.querySelector(".pg-chart__state--loading")).toBeTruthy();
        unmount();
    });

    it("renders the empty state instead of blank axes", () => {
        const { el, unmount } = mount(PgChart, { option, empty: true, emptyText: "No volume recorded" });
        expect(el.querySelector(".pg-empty")).toBeTruthy();
        expect(el.querySelector(".pg-empty__title")?.textContent).toBe("No volume recorded");
        expect(el.querySelector(".pg-chart")?.getAttribute("style")).toContain("height: 260px");
        unmount();
    });

    it("does not initialize into a zero-size viewport but still applies the height", () => {
        forcedViewport = { width: "0px", height: "0px" };
        const { el, unmount } = mount(PgChart, { option });
        const root = el.querySelector(".pg-chart") as HTMLElement;
        expect(echartsMock.init).not.toHaveBeenCalled();
        expect(root.getAttribute("data-pg-chart-state")).toBe("pending");
        expect(root.style.height).toBe("260px");
        expect(root.style.minHeight).toBe("260px");
        unmount();
    });

    it("initializes from the ResizeObserver when a hidden container becomes visible", async () => {
        forcedViewport = { width: "0px", height: "0px" };
        let notify: (() => void) | undefined;
        const originalResizeObserver = (globalThis as any).ResizeObserver;
        class FakeResizeObserver {
            observe = vi.fn();
            disconnect = vi.fn();
            constructor(callback: () => void) {
                notify = callback;
            }
        }
        (globalThis as any).ResizeObserver = FakeResizeObserver;
        try {
            const { el, unmount } = mount(PgChart, { option });
            expect(echartsMock.init).not.toHaveBeenCalled();
            forcedViewport = { width: "600px", height: "260px" };
            notify?.();
            await nextTick();
            expect(echartsMock.init).toHaveBeenCalledTimes(1);
            expect(el.querySelector(".pg-chart")?.getAttribute("data-pg-chart-state")).toBe("ready");
            unmount();
        } finally {
            (globalThis as any).ResizeObserver = originalResizeObserver;
        }
    });
});

describe("PgStatChartCard", () => {
    it("renders the KPI header, delta badge and chart region", () => {
        const { el, unmount } = mount(PgStatChartCard, {
            title: "Attempts",
            subtitle: "By state",
            value: 1200,
            delta: 12.5,
            option,
            height: 280,
        });
        const card = el.querySelector(".pg-stat-chart-card") as HTMLElement;
        expect(card.getAttribute("role")).toBe("region");
        expect(card.getAttribute("aria-label")).toBe("Attempts");
        expect(el.querySelector(".pg-stat-chart-card__title")?.textContent).toBe("Attempts");
        expect(el.querySelector(".pg-stat-chart-card__subtitle")?.textContent).toBe("By state");
        expect(el.querySelector(".pg-stat-chart-card__value")?.textContent).toBe("1,200");
        const delta = el.querySelector(".pg-stat-chart-card__delta") as HTMLElement;
        expect(delta.classList.contains("pg-stat-chart-card__delta--up")).toBe(true);
        expect(delta.textContent).toBe("+12.5%");
        const chart = el.querySelector(".pg-chart") as HTMLElement;
        expect(chart.style.height).toBe("280px");
        expect(chart.style.minHeight).toBe("280px");
        unmount();
    });

    it("renders a downward delta and forwards chartClick", () => {
        const onClick = vi.fn();
        const { el, unmount } = mountCharts(
            PgStatChartCard,
            {
                title: "Volume",
                delta: -4,
                option,
            },
            { onChartClick: onClick },
        );
        expect(el.querySelector(".pg-stat-chart-card__delta--down")).toBeTruthy();
        expect(el.querySelector(".pg-stat-chart-card__delta")?.textContent).toBe("-4%");
        firstChart().handlers.click({ name: "A" });
        expect(onClick).toHaveBeenCalledWith({ name: "A" });
        unmount();
    });

    it("re-themes axis and tooltip colours on a light/dark switch", async () => {
        const { unmount } = mount(PgStatChartCard, { title: "Attempts", option });
        expect(firstChart().options[0].xAxis.axisLabel.color).toBe(chartPalette("light").text);
        setThemeMode("dark");
        await nextTick();
        await nextTick();
        const lastOption = echartsMock.instances.at(-1)!.options.at(-1);
        expect(lastOption.xAxis.axisLabel.color).toBe(chartPalette("dark").text);
        expect(lastOption.tooltip.backgroundColor).toBe(chartPalette("dark").tooltipBackground);
        unmount();
    });

    it("keeps aliases wired", () => {
        expect(StatsChartCard).toBe(PgStatChartCard);
        expect(StatsBarChartCard).toBe(PgStatBarChartCard);
        expect(EChart).toBe(PgChart);
    });
});

describe("PgStatBarChartCard", () => {
    const longCategory = "A very long settlement rail";
    const valueFormatter = (value: number) => `${value.toLocaleString()} LYD`;

    const baseProps = {
        title: "Volume by rail",
        subtitle: "Selected period",
        categories: ["SADAD", longCategory],
        series: [{ name: "Volume", data: [10, 20], tone: "emerald" }],
    };

    const mountBar = (extra: Record<string, any> = {}, dynamic: Record<string, any> = {}) =>
        mountCharts(PgStatBarChartCard, { ...baseProps, ...extra }, dynamic);

    it("builds rounded 6px bars with the curated palette and a truncating axis", () => {
        const { el, unmount } = mountBar();
        const applied = firstChart().options[0];
        expect(applied.series[0].barMaxWidth).toBe(32);
        expect(applied.series[0].itemStyle.borderRadius).toEqual([6, 6, 0, 0]);
        expect(applied.series[0].itemStyle.color).toBe(chartPalette("light").emerald);
        expect(applied.xAxis.data).toEqual(["SADAD", longCategory]);
        const label = applied.xAxis.axisLabel.formatter(longCategory);
        expect(label).toHaveLength(14);
        expect(label.endsWith("…")).toBe(true);
        expect(el.querySelector(".pg-chart")?.getAttribute("style")).toContain("height: 260px");
        unmount();
    });

    it("formats tooltip values with valueFormatter and shows the full label", () => {
        const { unmount } = mountBar({}, { valueFormatter });
        const applied = firstChart().options[0];
        const html = applied.tooltip.formatter([
            { name: longCategory, seriesName: "Volume", value: 1234, marker: "" },
        ]);
        expect(html).toContain(longCategory);
        expect(html).toContain("1,234 LYD");
        unmount();
    });

    it("emits barClick with the category, series and numeric value", () => {
        const onBarClick = vi.fn();
        const { unmount } = mountBar({}, { onBarClick });
        firstChart().handlers.click({ name: longCategory, seriesName: "Volume", dataIndex: 1, value: 20 });
        expect(onBarClick).toHaveBeenCalledWith({
            category: longCategory,
            seriesName: "Volume",
            value: 20,
        });
        unmount();
    });

    it("supports horizontal stacked bars with rounded end caps", () => {
        const { unmount } = mountBar({ horizontal: true, stacked: true, height: 300 });
        const applied = firstChart().options[0];
        expect(applied.series[0].stack).toBe("pg-total");
        expect(applied.series[0].itemStyle.borderRadius).toEqual([0, 6, 6, 0]);
        expect(applied.xAxis.type).toBe("value");
        expect(applied.yAxis.type).toBe("category");
        expect(applied.yAxis.inverse).toBe(true);
        const chart = document.querySelector(".pg-chart") as HTMLElement;
        expect(chart.style.height).toBe("300px");
        unmount();
    });

    it("renders the empty state for an empty dataset", () => {
        const { el, unmount } = mount(PgStatBarChartCard, { title: "Volume", categories: [], series: [] });
        expect(el.querySelector(".pg-empty")).toBeTruthy();
        unmount();
    });

    it("re-themes its option when the resolved theme changes", async () => {
        const { unmount } = mountBar({}, { valueFormatter });
        expect(firstChart().options[0].series[0].itemStyle.color).toBe(chartPalette("light").emerald);
        setThemeMode("dark");
        await nextTick();
        await nextTick();
        const lastOption = echartsMock.instances.at(-1)!.options.at(-1);
        expect(lastOption.series[0].itemStyle.color).toBe(chartPalette("dark").emerald);
        expect(lastOption.xAxis.axisLabel.color).toBe(chartPalette("dark").text);
        unmount();
    });
});

describe("chart palette", () => {
    it("keeps the historical light constants for page imports", () => {
        expect(CHART_TEXT).toBe("#64748b");
        expect(CHART_GRID).toBe("#e2e8f0");
        expect(CHART_CATEGORICAL_LIGHT).toHaveLength(6);
        expect(CHART_CATEGORICAL_DARK).toHaveLength(6);
    });

    it("resolves light and dark palettes", () => {
        const light = chartPalette("light");
        const dark = chartPalette("dark");
        expect(light.indigo).toBe("#4f46e5");
        expect(dark.indigo).toBe("#818cf8");
        expect(dark.text).not.toBe(light.text);
        expect(chartPalette().theme).toBe("light");
        expect(chartToneColor("emerald", dark)).toBe("#34d399");
        expect(chartToneColor("#123456", light)).toBe("#123456");
    });
});

describe("duplicated chart folders", () => {
    it("no longer ships local src/charts directories in any portal", () => {
        for (const portal of ["admin-front", "merchant-front", "checkout-front"]) {
            const directory = fileURLToPath(new URL(`../../../${portal}/src/charts/`, import.meta.url));
            expect(existsSync(directory), `${portal}/src/charts must be deleted`).toBe(false);
        }
    });
});
