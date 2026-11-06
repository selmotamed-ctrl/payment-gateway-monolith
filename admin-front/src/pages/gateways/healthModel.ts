/**
 * Pure chart models for the gateway health drawer. The API returns per-route health samples
 * (oldest first, `successRate` 0..1 or null) and 30 days of per-currency route volume.
 */

export interface HealthSample {
    windowStart: string;
    successes: number;
    definitiveFailures: number;
    ambiguousUnknowns: number;
    rateLimits429: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    successRate: number | null;
}

export interface DailyVolume {
    day: string;
    currency: string;
    attemptCount: number;
    successCount: number;
    volumeAmount: string;
}

export interface RouteHealth {
    routeId: string;
    railCode: string;
    samples: HealthSample[];
    dailyVolume: DailyVolume[];
}

/** successes / (successes + definitive failures + ambiguous unknowns) as 0..1, null without traffic. */
export const successRateOf = (sample: Pick<HealthSample, "successes" | "definitiveFailures" | "ambiguousUnknowns">): number | null => {
    const total = sample.successes + sample.definitiveFailures + sample.ambiguousUnknowns;
    return total === 0 ? null : sample.successes / total;
};

export type Point = [string, number | null];

const roundTo = (value: number, digits: number): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

/** Success rate in percent per window; windows without traffic stay `null` so the line breaks. */
export const buildSuccessRateSeries = (samples: readonly HealthSample[]): Point[] =>
    samples.map((sample) => {
        const rate = sample.successRate ?? successRateOf(sample);
        return [sample.windowStart, rate === null ? null : roundTo(rate * 100, 2)];
    });

export const buildLatencySeries = (samples: readonly HealthSample[], key: "p50Ms" | "p95Ms" | "p99Ms"): Point[] =>
    samples.map((sample) => [sample.windowStart, sample[key] === null || sample[key] === undefined ? null : Number(sample[key])]);

export interface VolumeSeries {
    days: string[];
    currencies: string[];
    /** One array per currency, aligned with `days`; missing days are 0. */
    amountByCurrency: Record<string, number[]>;
    attempts: number[];
    successes: number[];
    totalAttempts: number;
    totalSuccesses: number;
}

/** Dense day axis (no gaps between the first and last day) so a quiet day shows as zero. */
export const buildVolumeSeries = (rows: readonly DailyVolume[]): VolumeSeries => {
    if (rows.length === 0) {
        return { days: [], currencies: [], amountByCurrency: {}, attempts: [], successes: [], totalAttempts: 0, totalSuccesses: 0 };
    }
    const sortedDays = [...new Set(rows.map((row) => row.day))].sort();
    const days: string[] = [];
    const first = new Date(`${sortedDays[0]}T00:00:00Z`);
    const last = new Date(`${sortedDays[sortedDays.length - 1]}T00:00:00Z`);
    for (let cursor = first; cursor.getTime() <= last.getTime(); cursor = new Date(cursor.getTime() + 86_400_000)) {
        days.push(cursor.toISOString().slice(0, 10));
    }
    const index = new Map(days.map((day, position) => [day, position]));
    const currencies = [...new Set(rows.map((row) => row.currency))].sort();
    const amountByCurrency: Record<string, number[]> = Object.fromEntries(currencies.map((currency) => [currency, days.map(() => 0)]));
    const attempts = days.map(() => 0);
    const successes = days.map(() => 0);
    for (const row of rows) {
        const position = index.get(row.day);
        if (position === undefined) continue;
        const amounts = amountByCurrency[row.currency];
        if (amounts) amounts[position] = roundTo((amounts[position] ?? 0) + Number(row.volumeAmount || 0), 4);
        attempts[position] = (attempts[position] ?? 0) + row.attemptCount;
        successes[position] = (successes[position] ?? 0) + row.successCount;
    }
    return {
        days,
        currencies,
        amountByCurrency,
        attempts,
        successes,
        totalAttempts: attempts.reduce((sum, value) => sum + value, 0),
        totalSuccesses: successes.reduce((sum, value) => sum + value, 0),
    };
};

export type HealthTone = "success" | "warning" | "danger" | "neutral";

/** 99%+ is healthy, 95%+ degraded, anything lower needs attention. */
export const successRateTone = (rate: number | null | undefined): HealthTone => {
    if (rate === null || rate === undefined) return "neutral";
    if (rate >= 0.99) return "success";
    if (rate >= 0.95) return "warning";
    return "danger";
};

export const formatPercent = (rate: number | null | undefined): string =>
    rate === null || rate === undefined ? "—" : `${roundTo(rate * 100, 2)}%`;

export const formatMs = (ms: number | null | undefined): string => (ms === null || ms === undefined ? "—" : `${Math.round(ms)} ms`);

export interface ChartPalette {
    ink: string;
    muted: string;
    grid: string;
    success: string;
    info: string;
    warning: string;
    danger: string;
}

const axisCommon = (palette: ChartPalette) => ({
    axisLine: { lineStyle: { color: palette.grid } },
    axisLabel: { color: palette.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: palette.grid, opacity: 0.5 } },
});

const timeLabel = (value: string): string => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
};

export const successRateOption = (samples: readonly HealthSample[], palette: ChartPalette, labels: { successRate: string }): Record<string, unknown> => {
    const points = buildSuccessRateSeries(samples);
    return {
        grid: { left: 44, right: 16, top: 16, bottom: 28 },
        tooltip: { trigger: "axis", valueFormatter: (value: number | null) => (value === null || value === undefined ? "—" : `${value}%`) },
        xAxis: { type: "category", data: points.map((point) => timeLabel(point[0])), ...axisCommon(palette), boundaryGap: false },
        yAxis: { type: "value", min: (range: { min: number }) => Math.max(0, Math.floor(Math.min(range.min, 99) - 1)), max: 100, ...axisCommon(palette), axisLabel: { color: palette.muted, fontSize: 11, formatter: "{value}%" } },
        series: [
            {
                name: labels.successRate,
                type: "line",
                data: points.map((point) => point[1]),
                connectNulls: false,
                showSymbol: false,
                smooth: false,
                lineStyle: { width: 2, color: palette.success },
                itemStyle: { color: palette.success },
                areaStyle: { color: palette.success, opacity: 0.08 },
            },
        ],
    };
};

export const latencyOption = (samples: readonly HealthSample[], palette: ChartPalette, labels: { p50: string; p95: string; p99: string }): Record<string, unknown> => {
    const axis = samples.map((sample) => timeLabel(sample.windowStart));
    const line = (name: string, key: "p50Ms" | "p95Ms" | "p99Ms", color: string, width: number) => ({
        name,
        type: "line",
        data: buildLatencySeries(samples, key).map((point) => point[1]),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width, color },
        itemStyle: { color },
    });
    return {
        grid: { left: 52, right: 16, top: 32, bottom: 28 },
        legend: { top: 0, textStyle: { color: palette.muted, fontSize: 11 } },
        tooltip: { trigger: "axis", valueFormatter: (value: number | null) => (value === null || value === undefined ? "—" : `${value} ms`) },
        xAxis: { type: "category", data: axis, ...axisCommon(palette), boundaryGap: false },
        yAxis: { type: "value", min: 0, ...axisCommon(palette), axisLabel: { color: palette.muted, fontSize: 11, formatter: "{value} ms" } },
        series: [line(labels.p50, "p50Ms", palette.info, 1.5), line(labels.p95, "p95Ms", palette.warning, 2), line(labels.p99, "p99Ms", palette.danger, 1.5)],
    };
};

export const volumeOption = (series: VolumeSeries, palette: ChartPalette, labels: { attempts: string; successes: string }): Record<string, unknown> => ({
    grid: { left: 44, right: 16, top: 32, bottom: 28 },
    legend: { top: 0, textStyle: { color: palette.muted, fontSize: 11 } },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: series.days.map((day) => day.slice(5)), ...axisCommon(palette) },
    yAxis: { type: "value", minInterval: 1, ...axisCommon(palette) },
    series: [
        { name: labels.attempts, type: "bar", data: series.attempts, itemStyle: { color: palette.info }, barMaxWidth: 18 },
        { name: labels.successes, type: "bar", data: series.successes, itemStyle: { color: palette.success }, barMaxWidth: 18 },
    ],
});
