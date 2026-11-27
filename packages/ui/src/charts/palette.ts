/**
 * Shared chart palette for every `@pg/ui` analytics surface.
 *
 * The first block keeps the historical `CHART_*` names and light-mode values so
 * page code can switch its import from `@/charts/palette` to `@pg/ui` without
 * touching chart option builders. The `chartPalette()` resolver adds the
 * dark-mode counterparts and the curated categorical palette used by
 * `PgStatBarChartCard`.
 */
export type ChartTheme = "light" | "dark";

/* Light-mode base values (historical names kept for page compatibility). */
export const CHART_TEXT = "#64748b";
export const CHART_GRID = "#e2e8f0";
export const CHART_INDIGO = "#4f46e5";
export const CHART_EMERALD = "#059669";
export const CHART_SLATE = "#64748b";
export const CHART_DANGER = "#dc2626";
export const CHART_WARNING = "#d97706";
export const CHART_INFO = "#2563eb";

/* Dark-mode counterparts. */
export const CHART_DARK_TEXT = "#94a3b8";
export const CHART_DARK_GRID = "#1e293b";
export const CHART_DARK_INDIGO = "#818cf8";
export const CHART_DARK_EMERALD = "#34d399";
export const CHART_DARK_SLATE = "#94a3b8";
export const CHART_DARK_DANGER = "#f87171";
export const CHART_DARK_WARNING = "#fbbf24";
export const CHART_DARK_INFO = "#60a5fa";

/** 2026 Fintech curated 6-colour categorical palettes. */
export const CHART_CATEGORICAL_LIGHT = [
    "#4f46e5", // Indigo
    "#059669", // Emerald
    "#0284c7", // Sky
    "#d97706", // Amber
    "#7c3aed", // Violet
    "#64748b", // Slate
] as const;

export const CHART_CATEGORICAL_DARK = [
    "#818cf8",
    "#34d399",
    "#38bdf8",
    "#fbbf24",
    "#a78bfa",
    "#94a3b8",
] as const;

export interface ChartPalette {
    theme: ChartTheme;
    text: string;
    grid: string;
    indigo: string;
    emerald: string;
    slate: string;
    danger: string;
    warning: string;
    info: string;
    categorical: string[];
    tooltipBackground: string;
    tooltipBorder: string;
    tooltipText: string;
    areaIndigo: string;
    areaEmerald: string;
}

const LIGHT_PALETTE: ChartPalette = {
    theme: "light",
    text: CHART_TEXT,
    grid: CHART_GRID,
    indigo: CHART_INDIGO,
    emerald: CHART_EMERALD,
    slate: CHART_SLATE,
    danger: CHART_DANGER,
    warning: CHART_WARNING,
    info: CHART_INFO,
    categorical: [...CHART_CATEGORICAL_LIGHT],
    tooltipBackground: "#ffffff",
    tooltipBorder: "#e2e8f0",
    tooltipText: "#0f172a",
    areaIndigo: "rgba(79, 70, 229, 0.16)",
    areaEmerald: "rgba(5, 150, 105, 0.16)",
};

const DARK_PALETTE: ChartPalette = {
    theme: "dark",
    text: CHART_DARK_TEXT,
    grid: CHART_DARK_GRID,
    indigo: CHART_DARK_INDIGO,
    emerald: CHART_DARK_EMERALD,
    slate: CHART_DARK_SLATE,
    danger: CHART_DARK_DANGER,
    warning: CHART_DARK_WARNING,
    info: CHART_DARK_INFO,
    categorical: [...CHART_CATEGORICAL_DARK],
    tooltipBackground: "#0f172a",
    tooltipBorder: "#334155",
    tooltipText: "#f8fafc",
    areaIndigo: "rgba(129, 140, 248, 0.22)",
    areaEmerald: "rgba(52, 211, 153, 0.22)",
};

/** Resolves the palette for a resolved `data-theme` value. */
export const chartPalette = (theme: ChartTheme | string = "light"): ChartPalette =>
    theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;

export const chartText = (theme: ChartTheme | string = "light"): string => chartPalette(theme).text;
export const chartGrid = (theme: ChartTheme | string = "light"): string => chartPalette(theme).grid;

/** Named series tones accepted by `PgStatBarChartCard` (hex colours pass through). */
export const CHART_TONE_NAMES = [
    "indigo",
    "emerald",
    "sky",
    "amber",
    "violet",
    "slate",
    "danger",
    "warning",
    "info",
] as const;

export type ChartToneName = (typeof CHART_TONE_NAMES)[number];

export const isChartToneName = (tone: string): tone is ChartToneName =>
    (CHART_TONE_NAMES as readonly string[]).includes(tone);

/** Maps a named tone to the active palette, falling back to the series index. */
export const chartToneColor = (
    tone: string | undefined,
    palette: ChartPalette,
    index = 0,
): string => {
    if (tone && !isChartToneName(tone)) return tone;
    switch (tone) {
        case "indigo":
            return palette.indigo;
        case "emerald":
            return palette.emerald;
        case "sky":
            return palette.categorical[2] ?? palette.info;
        case "amber":
            return palette.categorical[3] ?? palette.warning;
        case "violet":
            return palette.categorical[4] ?? palette.indigo;
        case "slate":
            return palette.slate;
        case "danger":
            return palette.danger;
        case "warning":
            return palette.warning;
        case "info":
            return palette.info;
        default:
            return palette.categorical[index % palette.categorical.length] ?? palette.indigo;
    }
};
