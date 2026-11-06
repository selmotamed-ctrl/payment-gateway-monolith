import { asObject, deepClone, deepEqual, pickAlias, toText, type JsonObject } from "./jsonTree";

/**
 * Statement-source parser config (core `engine/reconciliation/StatementIngestor.ts`
 * `parseConfig` + `reconciliationSourceRow` in `api/internal/admin.ts`).
 * Read by the ingestor: `format` (CSV|XLSX|JSON), `encoding`, `delimiter`, `headerRow`/`header_row`,
 * `columnsMap`/`columns_map` (logical -> statement column), `dateFormat`/`date_format`, `timezone`,
 * `supportsBatchNet`/`supports_batch_net`. The source row reads `currency` and `active` too.
 * `PATCH /reconciliation/sources/:id` MERGES the config shallowly (`{...current, ...body.parserConfig}`):
 * a top-level key can be replaced but never removed, so the builder always sends the complete object.
 */
export const STATEMENT_FORMATS = ["CSV", "XLSX", "JSON"] as const;
export const STATEMENT_ENCODINGS = ["utf8", "utf-8", "utf16le", "ucs2", "latin1", "binary", "ascii", "base64", "base64url", "hex"] as const;
export const COLUMN_LOGICAL_KEYS = ["ourReference", "providerReference", "batchReference", "amount", "fee", "currency", "occurredAt", "type"] as const;
export type ColumnLogicalKey = (typeof COLUMN_LOGICAL_KEYS)[number];

/** Spellings the ingestor accepts for each logical column key (`COLUMN_MAP_ALIASES`). */
const COLUMN_ALIASES: Record<ColumnLogicalKey, readonly string[]> = {
    ourReference: ["ourReference", "our_reference"],
    providerReference: ["providerReference", "provider_reference"],
    batchReference: ["batchReference", "batch_reference"],
    amount: ["amount"],
    fee: ["fee"],
    currency: ["currency"],
    occurredAt: ["occurredAt", "occurred_at"],
    type: ["type"],
};

export const REQUIRED_COLUMNS: readonly ColumnLogicalKey[] = ["amount"];
/** A row can only be matched when at least one reference column is mapped. */
export const REFERENCE_COLUMNS: readonly ColumnLogicalKey[] = ["ourReference", "providerReference"];

type Field = "format" | "encoding" | "delimiter" | "headerRow" | "columnsMap" | "dateFormat" | "timezone" | "supportsBatchNet" | "currency";
const FIELD_ALIASES: Record<Field, readonly string[]> = {
    format: ["format"],
    encoding: ["encoding"],
    delimiter: ["delimiter"],
    headerRow: ["headerRow", "header_row"],
    columnsMap: ["columnsMap", "columns_map"],
    dateFormat: ["dateFormat", "date_format"],
    timezone: ["timezone"],
    supportsBatchNet: ["supportsBatchNet", "supports_batch_net"],
    currency: ["currency"],
};

export type ParserConfigForm = {
    format: string;
    encoding: string;
    delimiter: string;
    headerRow: boolean;
    dateFormat: string;
    timezone: string;
    currency: string;
    supportsBatchNet: boolean;
    columns: Record<ColumnLogicalKey, string>;
};

export type ParserConfigState = {
    form: ParserConfigForm;
    keys: Partial<Record<Field, string>>;
    originals: Partial<Record<Field, unknown>>;
    /** Spelling used for each logical column + any extra (unknown) logical column keys. */
    columnKeys: Partial<Record<ColumnLogicalKey, string>>;
    columnExtras: JsonObject;
    extras: JsonObject;
};

const blankColumns = (): Record<ColumnLogicalKey, string> => ({
    ourReference: "",
    providerReference: "",
    batchReference: "",
    amount: "",
    fee: "",
    currency: "",
    occurredAt: "",
    type: "",
});

export const parseParserConfig = (raw: unknown): ParserConfigState => {
    const source = asObject(raw);
    const state: ParserConfigState = {
        form: {
            format: "CSV",
            encoding: "utf8",
            delimiter: ",",
            headerRow: true,
            dateFormat: "",
            timezone: "",
            currency: "",
            supportsBatchNet: false,
            columns: blankColumns(),
        },
        keys: {},
        originals: {},
        columnKeys: {},
        columnExtras: {},
        extras: {},
    };
    const consumed = new Set<string>();
    const take = (field: Field): unknown => {
        const alias = pickAlias(source, FIELD_ALIASES[field]);
        if (!alias) return undefined;
        state.keys[field] = alias;
        state.originals[field] = source[alias];
        consumed.add(alias);
        return source[alias];
    };
    const format = take("format");
    if (typeof format === "string" && format.trim()) state.form.format = format.trim().toUpperCase();
    const encoding = take("encoding");
    if (typeof encoding === "string" && encoding.trim()) state.form.encoding = encoding.trim();
    const delimiter = take("delimiter");
    if (typeof delimiter === "string") state.form.delimiter = delimiter;
    const headerRow = take("headerRow");
    if (headerRow !== undefined) state.form.headerRow = Boolean(headerRow);
    state.form.dateFormat = toText(take("dateFormat"));
    state.form.timezone = toText(take("timezone"));
    state.form.currency = toText(take("currency"));
    const batch = take("supportsBatchNet");
    state.form.supportsBatchNet = batch === true || batch === "true" || batch === 1;
    const columns = take("columnsMap");
    if (columns !== undefined) {
        const map = asObject(columns);
        const usedKeys = new Set<string>();
        for (const logical of COLUMN_LOGICAL_KEYS) {
            const alias = pickAlias(map, COLUMN_ALIASES[logical]);
            if (!alias) continue;
            state.columnKeys[logical] = alias;
            usedKeys.add(alias);
            state.form.columns[logical] = toText(map[alias]);
        }
        for (const [key, value] of Object.entries(map)) if (!usedKeys.has(key)) state.columnExtras[key] = deepClone(value);
    }
    // `columns` (a plain list of column names in some seeds) and any other key stay untouched.
    for (const [key, value] of Object.entries(source)) if (!consumed.has(key)) state.extras[key] = deepClone(value);
    return state;
};

const keyFor = (state: ParserConfigState, field: Field): string => state.keys[field] ?? FIELD_ALIASES[field][0]!;

/** The complete `parserConfig` object for `PATCH /reconciliation/sources/:id` (unknown keys preserved). */
export const serializeParserConfig = (state: ParserConfigState): JsonObject => {
    const out: JsonObject = deepClone(state.extras);
    const { form } = state;
    out[keyFor(state, "format")] = form.format;
    out[keyFor(state, "encoding")] = form.encoding;
    out[keyFor(state, "delimiter")] = form.delimiter;
    out[keyFor(state, "headerRow")] = form.headerRow;
    for (const field of ["dateFormat", "timezone", "currency"] as const) {
        const text = form[field].trim();
        if (text) out[keyFor(state, field)] = text;
        else if (state.keys[field]) out[keyFor(state, field)] = "";
    }
    if (form.supportsBatchNet || state.keys.supportsBatchNet) out[keyFor(state, "supportsBatchNet")] = form.supportsBatchNet;
    const map: JsonObject = deepClone(state.columnExtras);
    for (const logical of COLUMN_LOGICAL_KEYS) {
        const text = form.columns[logical].trim();
        if (text) map[state.columnKeys[logical] ?? logical] = text;
    }
    if (Object.keys(map).length > 0 || state.keys.columnsMap) out[keyFor(state, "columnsMap")] = map;
    return out;
};

export type ParserConfigErrorCode =
    | "FORMAT_INVALID"
    | "ENCODING_INVALID"
    | "DELIMITER_REQUIRED"
    | "DELIMITER_LENGTH"
    | "AMOUNT_REQUIRED"
    | "REFERENCE_REQUIRED"
    | "COLUMN_DUPLICATE"
    | "CURRENCY_INVALID"
    | "TIMEZONE_INVALID";

export type ParserConfigError = { code: ParserConfigErrorCode; field: string; severity: "error" | "warning" };

export const validateParserConfig = (form: ParserConfigForm): ParserConfigError[] => {
    const errors: ParserConfigError[] = [];
    const error = (code: ParserConfigErrorCode, field: string): void => void errors.push({ code, field, severity: "error" });
    if (!(STATEMENT_FORMATS as readonly string[]).includes(form.format)) error("FORMAT_INVALID", "format");
    if (!(STATEMENT_ENCODINGS as readonly string[]).includes(form.encoding)) error("ENCODING_INVALID", "encoding");
    if (form.format === "CSV") {
        if (form.delimiter === "") error("DELIMITER_REQUIRED", "delimiter");
        else if (form.delimiter.length !== 1) error("DELIMITER_LENGTH", "delimiter");
    }
    // Warnings: an unmapped column falls back to the statement column named like the logical key.
    if (!form.columns.amount.trim()) errors.push({ code: "AMOUNT_REQUIRED", field: "columns.amount", severity: "warning" });
    if (!REFERENCE_COLUMNS.some((key) => form.columns[key].trim())) errors.push({ code: "REFERENCE_REQUIRED", field: "columns.ourReference", severity: "warning" });
    const seen = new Map<string, ColumnLogicalKey>();
    for (const logical of COLUMN_LOGICAL_KEYS) {
        const text = form.columns[logical].trim();
        if (!text) continue;
        // Two logical fields reading the same statement column is almost always a typo.
        if (seen.has(text)) error("COLUMN_DUPLICATE", `columns.${logical}`);
        else seen.set(text, logical);
    }
    if (form.currency.trim() && !/^[A-Za-z]{3}$/.test(form.currency.trim())) error("CURRENCY_INVALID", "currency");
    if (form.timezone.trim()) {
        try {
            new Intl.DateTimeFormat("en", { timeZone: form.timezone.trim() });
        } catch {
            error("TIMEZONE_INVALID", "timezone");
        }
    }
    return errors;
};

/**
 * Without a header row the ingestor reads the cells by POSITION, in this fixed order
 * (the mapped logical columns in canonical order), whatever column names are typed.
 */
export const positionalColumnOrder = (form: ParserConfigForm): ColumnLogicalKey[] =>
    COLUMN_LOGICAL_KEYS.filter((key) => form.columns[key].trim() !== "");

export const isParserConfigUnchanged = (state: ParserConfigState, original: unknown): boolean =>
    deepEqual(serializeParserConfig(state), asObject(original));

// ---------------------------------------------------------------- display (table badges)

export type MappingSummary = { mapped: ColumnLogicalKey[]; missing: ColumnLogicalKey[]; ok: boolean };

/**
 * Which logical columns the source maps. The admin list row exposes `columnMapping`
 * from `parser.columns ?? parser.columnMapping` (core `reconciliationSourceRow`), which misses
 * `columnsMap`, so the view derives the mapping from the full `parserConfig` instead.
 */
export const summarizeColumnMapping = (parserConfig: unknown): MappingSummary => {
    const { form } = parseParserConfig(parserConfig);
    const mapped = COLUMN_LOGICAL_KEYS.filter((key) => form.columns[key].trim() !== "");
    const missing: ColumnLogicalKey[] = REQUIRED_COLUMNS.filter((key) => !mapped.includes(key));
    if (!REFERENCE_COLUMNS.some((key) => mapped.includes(key))) missing.push("ourReference");
    return { mapped: [...mapped], missing, ok: missing.length === 0 };
};
