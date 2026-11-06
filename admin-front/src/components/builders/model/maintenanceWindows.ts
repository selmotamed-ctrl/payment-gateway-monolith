import { asObject, deepClone, type JsonObject } from "./jsonTree";

/**
 * Route maintenance windows (core `RailRoute.maintenanceWindows`, `VisibleRailsResolver`):
 * `[{ start, end }]`, ISO instants, a route is excluded while `start <= now < end`.
 * The builder edits them as UTC `datetime-local` text so the result is deterministic
 * regardless of the operator's time zone.
 */
export type MaintenanceWindowRow = {
    /** `YYYY-MM-DDTHH:mm` interpreted as UTC. */
    start: string;
    end: string;
    meta: { rawStart: unknown; rawEnd: unknown; startInput: string; endInput: string; extras: JsonObject };
};

const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const pad = (value: number): string => String(value).padStart(2, "0");

/** ISO instant -> `YYYY-MM-DDTHH:mm` in UTC; `""` when it is not a valid date. */
export const isoToUtcInput = (value: unknown): string => {
    if (typeof value !== "string" && !(value instanceof Date)) return "";
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

/** `YYYY-MM-DDTHH:mm` (UTC) -> ISO instant; `null` when invalid. */
export const utcInputToIso = (text: string): string | null => {
    const clean = text.trim();
    if (!LOCAL_INPUT.test(clean)) return null;
    const date = new Date(`${clean}:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const parseMaintenanceWindows = (raw: unknown): MaintenanceWindowRow[] => {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((entry) => {
        const source = asObject(entry);
        const extras: JsonObject = {};
        for (const [key, value] of Object.entries(source)) if (key !== "start" && key !== "end") extras[key] = deepClone(value);
        const startInput = isoToUtcInput(source.start);
        const endInput = isoToUtcInput(source.end);
        return { start: startInput, end: endInput, meta: { rawStart: source.start, rawEnd: source.end, startInput, endInput, extras } };
    });
};

export const blankMaintenanceWindow = (): MaintenanceWindowRow => ({
    start: "",
    end: "",
    meta: { rawStart: undefined, rawEnd: undefined, startInput: "", endInput: "", extras: {} },
});

export type MaintenanceWindowErrorCode =
    | "START_REQUIRED"
    | "END_REQUIRED"
    | "START_INVALID"
    | "END_INVALID"
    | "END_NOT_AFTER_START"
    | "OVERLAP";

export type MaintenanceWindowError = { index: number; field: "start" | "end"; code: MaintenanceWindowErrorCode };

export const validateMaintenanceWindows = (rows: readonly MaintenanceWindowRow[]): MaintenanceWindowError[] => {
    const errors: MaintenanceWindowError[] = [];
    const valid: { index: number; start: number; end: number }[] = [];
    rows.forEach((row, index) => {
        const startIso = row.start.trim() ? utcInputToIso(row.start) : null;
        const endIso = row.end.trim() ? utcInputToIso(row.end) : null;
        if (!row.start.trim()) errors.push({ index, field: "start", code: "START_REQUIRED" });
        else if (!startIso) errors.push({ index, field: "start", code: "START_INVALID" });
        if (!row.end.trim()) errors.push({ index, field: "end", code: "END_REQUIRED" });
        else if (!endIso) errors.push({ index, field: "end", code: "END_INVALID" });
        if (startIso && endIso) {
            const start = Date.parse(startIso);
            const end = Date.parse(endIso);
            if (end <= start) errors.push({ index, field: "end", code: "END_NOT_AFTER_START" });
            else valid.push({ index, start, end });
        }
    });
    const sorted = [...valid].sort((left, right) => left.start - right.start);
    for (let position = 1; position < sorted.length; position += 1) {
        const previous = sorted[position - 1]!;
        const current = sorted[position]!;
        if (current.start < previous.end) errors.push({ index: current.index, field: "start", code: "OVERLAP" });
    }
    return errors;
};

/** The JSON array the API stores. A window whose text did not change keeps its original value byte for byte. */
export const serializeMaintenanceWindows = (rows: readonly MaintenanceWindowRow[]): JsonObject[] =>
    rows.map((row) => {
        const out: JsonObject = deepClone(row.meta.extras);
        out.start = row.start === row.meta.startInput && row.meta.rawStart !== undefined ? row.meta.rawStart : (utcInputToIso(row.start) ?? row.start);
        out.end = row.end === row.meta.endInput && row.meta.rawEnd !== undefined ? row.meta.rawEnd : (utcInputToIso(row.end) ?? row.end);
        return out;
    });

export type MaintenanceWindowState = "ACTIVE" | "UPCOMING" | "PAST";

/** Same predicate as the resolver: `start <= now < end`. */
export const maintenanceWindowState = (row: Pick<MaintenanceWindowRow, "start" | "end">, now: Date = new Date()): MaintenanceWindowState | null => {
    const start = utcInputToIso(row.start);
    const end = utcInputToIso(row.end);
    if (!start || !end) return null;
    const at = now.getTime();
    if (at >= Date.parse(end)) return "PAST";
    if (at >= Date.parse(start)) return "ACTIVE";
    return "UPCOMING";
};

/** Rows sorted by start, invalid rows last. Only used for read views. */
export const sortedMaintenanceWindows = (rows: readonly MaintenanceWindowRow[]): MaintenanceWindowRow[] =>
    [...rows].sort((left, right) => {
        const a = utcInputToIso(left.start);
        const b = utcInputToIso(right.start);
        if (a && b) return Date.parse(a) - Date.parse(b);
        return a ? -1 : b ? 1 : 0;
    });
