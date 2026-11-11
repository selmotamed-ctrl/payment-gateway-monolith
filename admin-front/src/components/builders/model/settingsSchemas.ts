import {
    MONEY_PATTERN,
    CURRENCY_PATTERN,
    asObject,
    deepClone,
    deepEqual,
    humanizeKey,
    isPlainObject,
    toStringList,
    uniqueStrings,
    type JsonObject,
} from "./jsonTree";

/**
 * Typed editors for the platform-setting namespaces the platform actually reads.
 * Derived from `core-back/prisma/seed.ts` (the seeded decision register OD-1..OD-11 and
 * the onboarding settings) and the readers in core:
 *  - `join_request.four_eyes_policy` / `OD-2`        api/internal/merchant.ts `parseFourEyesSetting`
 *  - `join_request.volume_threshold`                 api/internal/merchant.ts `readVolumeThreshold`
 *  - `onboarding.required_documents`                 lib/joinRequestOnboarding.ts
 *  - `kyb.refresh_policy`                            lib/kybReview.ts `parseKybRefreshPolicy`
 *  - `OD-4` (retention)                              engine/workers/RetentionWorker.ts `retentionDaysFromSetting`
 *  - `screening.watchlist` / `screening.fail_closed` engine/guards/AttemptGuardPipeline.ts
 *  - `SELF_PAYMENT_POLICY`                           engine/guards/AttemptGuardPipeline.ts
 *  - `gateway.go_live.<gatewayCode>.<aspect>`        api/internal/admin.ts `goLiveSettingKey`
 * The setting value is always a JSON OBJECT (`PUT /settings` takes `valueJson: record`).
 * Keys a namespace does not declare are never dropped: they are carried as `extras`.
 */
export type SettingFieldKind = "text" | "longtext" | "integer" | "number" | "money" | "boolean" | "select" | "strings" | "stringListMap" | "tree";

export type SettingFieldDef = {
    key: string;
    kind: SettingFieldKind;
    /** English label (translated by the view). */
    label: string;
    hint?: string;
    options?: readonly string[];
    min?: number;
    max?: number;
    required?: boolean;
    /** Alternative spellings the platform also reads (snake_case, legacy). Read and written back as found. */
    aliases?: readonly string[];
    /** Upper-case every list entry (codes, roles). */
    uppercase?: boolean;
};

export type SettingNamespaceDef = {
    id: string;
    title: string;
    description: string;
    fields: readonly SettingFieldDef[];
};

const description: SettingFieldDef = { key: "description", kind: "longtext", label: "Description" };
const currency: SettingFieldDef = { key: "currency", kind: "text", label: "Currency", hint: "Three-letter code, e.g. LYD" };

const NAMESPACES: Record<string, SettingNamespaceDef> = {
    "OD-1": {
        id: "OD-1",
        title: "Regulatory reporting thresholds",
        description: "State of the CBL reporting thresholds.",
        fields: [
            { key: "mode", kind: "select", label: "Mode", options: ["PROVISIONAL", "CONFIRMED"] },
            { key: "internalOnly", kind: "boolean", label: "Internal only" },
            description,
        ],
    },
    "OD-2": {
        id: "OD-2",
        title: "Four-eyes policy for join requests",
        description: "When a second reviewer is required for a join request.",
        fields: [
            { key: "policy", kind: "select", label: "Policy", options: ["RISK_BASED", "ALWAYS", "NEVER"], aliases: ["fourEyesPolicy"] },
            { key: "ownerThresholdPercent", kind: "number", label: "Beneficial owner threshold (%)", min: 0, max: 100, aliases: ["owner_threshold_percent"] },
            { key: "highRiskCategories", kind: "strings", label: "High-risk business categories", uppercase: true, aliases: ["high_risk_categories"] },
            description,
        ],
    },
    "OD-3": {
        id: "OD-3",
        title: "Screening provider",
        description: "Provider and adapters used for sanctions and PEP screening.",
        fields: [
            { key: "provider", kind: "text", label: "Provider", required: true },
            { key: "adapters", kind: "strings", label: "Adapters" },
            description,
        ],
    },
    "OD-4": {
        id: "OD-4",
        title: "Record retention",
        description: "How long KYB and related records are retained.",
        fields: [
            { key: "kybYears", kind: "integer", label: "Retention (years)", min: 1, max: 100, aliases: ["retentionYears", "years"] },
            { key: "retentionDays", kind: "integer", label: "Retention (days)", min: 1, max: 36500, hint: "When set, it takes precedence over the years value." },
            description,
        ],
    },
    "OD-5": {
        id: "OD-5",
        title: "First production gateway",
        description: "The recommended first production internal rail.",
        fields: [
            { key: "gatewayCode", kind: "text", label: "Gateway code", required: true },
            { key: "kind", kind: "select", label: "Gateway kind", options: ["INTERNAL", "EXTERNAL"] },
            { key: "recommendedStage", kind: "integer", label: "Recommended stage", min: 0, max: 20 },
            description,
        ],
    },
    "OD-6": {
        id: "OD-6",
        title: "Beneficial owner threshold",
        description: "Ownership percentage at which a beneficial owner is captured.",
        fields: [{ key: "ownerThresholdPercent", kind: "number", label: "Beneficial owner threshold (%)", min: 0, max: 100, required: true }, description],
    },
    "OD-7": {
        id: "OD-7",
        title: "Collection time ceilings",
        description: "Platform time-to-live ceilings per collection mode, in seconds.",
        fields: [
            { key: "otpPullSeconds", kind: "integer", label: "OTP pull (seconds)", min: 1, max: 86400 },
            { key: "redirectSeconds", kind: "integer", label: "Redirect (seconds)", min: 1, max: 86400 },
            { key: "qrDisplaySeconds", kind: "integer", label: "QR display (seconds)", min: 1, max: 86400 },
            { key: "pushApprovalSeconds", kind: "integer", label: "Push approval (seconds)", min: 1, max: 86400 },
            description,
        ],
    },
    "OD-8": {
        id: "OD-8",
        title: "Negative balance ceiling",
        description: "Overdraft allowance of a new merchant wallet.",
        fields: [{ key: "negativeBalanceCeiling", kind: "money", label: "Negative balance ceiling", required: true }, currency, description],
    },
    "OD-9": {
        id: "OD-9",
        title: "Emergency suspension ratification",
        description: "Who must ratify an emergency suspension and how fast.",
        fields: [
            { key: "ratificationWindowHours", kind: "integer", label: "Ratification window (hours)", min: 1, max: 720 },
            { key: "authorizedRoles", kind: "strings", label: "Authorised roles", uppercase: true },
            description,
        ],
    },
    "OD-10": {
        id: "OD-10",
        title: "Sandbox before approval",
        description: "Whether pending merchants may use sandbox rails.",
        fields: [{ key: "sandboxBeforeApproval", kind: "boolean", label: "Allow sandbox before approval" }, description],
    },
    "OD-11": {
        id: "OD-11",
        title: "Checker roles",
        description: "Roles provisioned as named checker accounts.",
        fields: [{ key: "checkerRoles", kind: "strings", label: "Checker roles", uppercase: true }, description],
    },
    "onboarding.required_documents": {
        id: "onboarding.required_documents",
        title: "Required KYB documents",
        description: "The default KYB document set and the per-category replacements.",
        fields: [
            { key: "default", kind: "strings", label: "Default documents", uppercase: true },
            { key: "byCategory", kind: "stringListMap", label: "Documents per business category", hint: "A category entry replaces the default list.", uppercase: true },
            description,
        ],
    },
    "join_request.volume_threshold": {
        id: "join_request.volume_threshold",
        title: "Review volume threshold",
        description: "An expected monthly volume above this amount forces a second reviewer.",
        fields: [{ key: "amount", kind: "number", label: "Amount", min: 0, required: true, aliases: ["value"] }, currency, description],
    },
    "kyb.refresh_policy": {
        id: "kyb.refresh_policy",
        title: "KYB refresh policy",
        description: "Periodic KYB re-verification cadence and expiry handling.",
        fields: [
            { key: "highMonths", kind: "integer", label: "High risk (months)", min: 1, max: 120, aliases: ["high_months"] },
            { key: "standardMonths", kind: "integer", label: "Standard risk (months)", min: 1, max: 120, aliases: ["standard_months"] },
            { key: "lowMonths", kind: "integer", label: "Low risk (months)", min: 1, max: 120, aliases: ["low_months"] },
            { key: "expiryGraceDays", kind: "integer", label: "Expiry grace (days)", min: 0, max: 365, aliases: ["expiry_grace_days"] },
            { key: "revalidationDueDays", kind: "integer", label: "Revalidation due (days)", min: 1, max: 365, aliases: ["revalidation_due_days"] },
            { key: "duplicateAmlThreshold", kind: "integer", label: "Duplicate AML threshold", min: 1, max: 100, aliases: ["duplicate_aml_threshold"] },
            description,
        ],
    },
    "screening.watchlist": {
        id: "screening.watchlist",
        title: "Internal watch list",
        description: "The internal watch list the transaction hot path screens against. A published revision needs a new version.",
        fields: [
            { key: "version", kind: "text", label: "List version", required: true },
            { key: "entries", kind: "tree", label: "Entries" },
            description,
        ],
    },
    "screening.fail_closed": {
        id: "screening.fail_closed",
        title: "Screening fail-closed switch",
        description: "Whether a screening error blocks the payment (the safe default) or lets it pass.",
        fields: [{ key: "failClosed", kind: "boolean", label: "Fail closed", aliases: ["fail_closed"] }],
    },
    SELF_PAYMENT_POLICY: {
        id: "SELF_PAYMENT_POLICY",
        title: "Self-payment policy",
        description: "Anti-self-dealing policy: a merchant paying into its own wallet.",
        fields: [{ key: "policy", kind: "select", label: "Policy", options: ["BLOCK", "ALLOW"], required: true }],
    },
    "merchant_reports.policy": {
        id: "merchant_reports.policy",
        title: "Merchant reporting policy",
        description: "Controls the merchant report runner/Studio and whether merchants may attach asset bundles.",
        fields: [
            {
                key: "enabled",
                kind: "boolean",
                label: "Merchant report Studio enabled",
                hint: "When off, the merchant report runner and Studio are unavailable for every merchant.",
            },
            {
                key: "assetsEnabled",
                kind: "boolean",
                label: "Merchant report assets enabled",
                aliases: ["assets_enabled"],
                hint: "When off, merchant reports cannot declare required assets and asset .zip uploads are rejected.",
            },
            description,
        ],
    },
};

/** The canonical key of the OD-2 policy carries the same shape (`join_request.four_eyes_policy`). */
NAMESPACES["join_request.four_eyes_policy"] = { ...NAMESPACES["OD-2"]!, id: "join_request.four_eyes_policy" };

const GO_LIVE_PREFIX = "gateway.go_live.";

/** The namespace of a key: an exact key, or the `gateway.go_live.*` family (free-form, operator provided). */
export const resolveSettingNamespace = (key: string): SettingNamespaceDef | null => {
    const exact = NAMESPACES[key];
    if (exact) return exact;
    if (key.startsWith(GO_LIVE_PREFIX)) {
        return {
            id: "gateway.go_live.*",
            title: "Gateway go-live evidence",
            description: "Operator provided go-live configuration of one gateway aspect.",
            fields: [],
        };
    }
    return null;
};

export const knownSettingKeys = (): string[] => Object.keys(NAMESPACES);

// ---------------------------------------------------------------- form model

export type SettingFormValue = string | boolean | string[] | Record<string, string[]> | unknown;
export type SettingForm = {
    /** Editable text/boolean/list value per declared field. */
    values: Record<string, SettingFormValue>;
    /** The JSON key (alias) each declared field was read from. */
    keys: Record<string, string>;
    /** The original JSON value of each declared field. */
    originals: Record<string, unknown>;
    /** Every key the namespace does not declare. */
    extras: JsonObject;
};

const fieldAliases = (field: SettingFieldDef): readonly string[] => [field.key, ...(field.aliases ?? [])];

const readText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
};

export const parseSettingForm = (def: SettingNamespaceDef | null, raw: unknown): SettingForm => {
    const source = asObject(raw);
    const form: SettingForm = { values: {}, keys: {}, originals: {}, extras: {} };
    const consumed = new Set<string>();
    for (const field of def?.fields ?? []) {
        const alias = fieldAliases(field).find((candidate) => Object.prototype.hasOwnProperty.call(source, candidate));
        const original = alias ? source[alias] : undefined;
        if (alias) {
            consumed.add(alias);
            form.keys[field.key] = alias;
            form.originals[field.key] = original;
        }
        switch (field.kind) {
            case "boolean":
                form.values[field.key] = original === true || original === "true";
                break;
            case "strings":
                form.values[field.key] = toStringList(original);
                break;
            case "stringListMap": {
                const map: Record<string, string[]> = {};
                if (isPlainObject(original)) for (const [name, list] of Object.entries(original)) map[name] = toStringList(list);
                form.values[field.key] = map;
                break;
            }
            case "tree":
                form.values[field.key] = original === undefined ? [] : deepClone(original);
                break;
            default:
                form.values[field.key] = readText(original);
        }
    }
    for (const [key, value] of Object.entries(source)) if (!consumed.has(key)) form.extras[key] = deepClone(value);
    return form;
};

const numberFromText = (text: string, original: unknown): number | string => {
    const parsed = Number(text.trim());
    if (typeof original === "string" && text.trim() === original) return original;
    return Number.isFinite(parsed) ? parsed : text.trim();
};

const listForWrite = (field: SettingFieldDef, list: string[]): string[] => uniqueStrings(field.uppercase ? list.map((entry) => entry.trim().toUpperCase()) : list);

/** The `valueJson` object the API stores. Declared fields that are blank are omitted unless they existed before. */
export const buildSettingValue = (def: SettingNamespaceDef | null, form: SettingForm): JsonObject => {
    const out: JsonObject = deepClone(form.extras);
    for (const field of def?.fields ?? []) {
        const key = form.keys[field.key] ?? field.key;
        const value = form.values[field.key];
        const original = form.originals[field.key];
        switch (field.kind) {
            case "boolean":
                if (value === true || original !== undefined) out[key] = value === true;
                break;
            case "strings": {
                const list = listForWrite(field, (value as string[]) ?? []);
                if (list.length > 0 || original !== undefined) out[key] = list;
                break;
            }
            case "stringListMap": {
                const map: JsonObject = {};
                for (const [name, list] of Object.entries((value as Record<string, string[]>) ?? {})) {
                    const clean = name.trim();
                    if (clean) map[clean] = listForWrite(field, list);
                }
                if (Object.keys(map).length > 0 || original !== undefined) out[key] = map;
                break;
            }
            case "tree":
                if (!(Array.isArray(value) && value.length === 0 && original === undefined)) out[key] = deepClone(value);
                break;
            case "integer":
            case "number":
            case "money": {
                const text = typeof value === "string" ? value : "";
                // A blank number means "removed": the key is omitted.
                if (text.trim()) out[key] = field.kind === "money" ? text.trim() : numberFromText(text, original);
                break;
            }
            default: {
                const text = typeof value === "string" ? value : "";
                if (text.trim() !== "") out[key] = text.trim();
                else if (typeof original === "string" && field.kind === "longtext") out[key] = "";
            }
        }
    }
    return out;
};

export type SettingErrorCode = "REQUIRED" | "INTEGER" | "NUMBER" | "MONEY" | "RANGE" | "OPTION" | "CURRENCY";
export type SettingError = { field: string; code: SettingErrorCode };

export const validateSettingForm = (def: SettingNamespaceDef | null, form: SettingForm): SettingError[] => {
    const errors: SettingError[] = [];
    for (const field of def?.fields ?? []) {
        const value = form.values[field.key];
        const text = typeof value === "string" ? value.trim() : "";
        const textual = ["text", "longtext", "integer", "number", "money", "select"].includes(field.kind);
        if (field.required && textual && !text) {
            errors.push({ field: field.key, code: "REQUIRED" });
            continue;
        }
        if (!text) continue;
        if (field.kind === "integer") {
            if (!/^-?\d+$/.test(text)) errors.push({ field: field.key, code: "INTEGER" });
            else if ((field.min !== undefined && Number(text) < field.min) || (field.max !== undefined && Number(text) > field.max)) errors.push({ field: field.key, code: "RANGE" });
        } else if (field.kind === "number") {
            const parsed = Number(text);
            if (!Number.isFinite(parsed)) errors.push({ field: field.key, code: "NUMBER" });
            else if ((field.min !== undefined && parsed < field.min) || (field.max !== undefined && parsed > field.max)) errors.push({ field: field.key, code: "RANGE" });
        } else if (field.kind === "money") {
            if (!MONEY_PATTERN.test(text) && !/^-\d{1,14}(\.\d{1,4})?$/.test(text)) errors.push({ field: field.key, code: "MONEY" });
        } else if (field.kind === "select" && field.options && !field.options.includes(text)) {
            // An unknown value that already exists stays editable (the select offers it); a typed-in one is rejected.
            if (form.originals[field.key] !== text) errors.push({ field: field.key, code: "OPTION" });
        } else if (field.key === "currency" && !CURRENCY_PATTERN.test(text)) {
            errors.push({ field: field.key, code: "CURRENCY" });
        }
    }
    return errors;
};

/** The options of a select: the declared ones plus the stored value when it is outside the list. */
export const selectOptions = (field: SettingFieldDef, current: unknown): string[] => {
    const options = [...(field.options ?? [])];
    if (typeof current === "string" && current && !options.includes(current)) options.push(current);
    return options;
};

export const isSettingUnchanged = (def: SettingNamespaceDef | null, form: SettingForm, original: unknown): boolean =>
    deepEqual(buildSettingValue(def, form), asObject(original));

// ---------------------------------------------------------------- read view

export type SettingSummaryRow = {
    path: string;
    label: string;
    kind: "text" | "boolean" | "list" | "empty" | "listMap";
    value: string | boolean | string[] | null;
    /** Only for `listMap`: label -> entries. */
    map?: { name: string; entries: string[] }[];
};

/** Structured read view: labelled rows for the declared fields, then every other key humanised. Never raw JSON. */
export const summarizeSetting = (key: string, value: unknown): SettingSummaryRow[] => {
    const def = resolveSettingNamespace(key);
    const source = asObject(value);
    const rows: SettingSummaryRow[] = [];
    const consumed = new Set<string>();
    for (const field of def?.fields ?? []) {
        const alias = fieldAliases(field).find((candidate) => Object.prototype.hasOwnProperty.call(source, candidate));
        if (!alias) continue;
        consumed.add(alias);
        const raw = source[alias];
        const base = { path: alias, label: field.label };
        if (field.kind === "boolean") rows.push({ ...base, kind: "boolean", value: raw === true || raw === "true" });
        else if (field.kind === "strings") {
            const list = toStringList(raw);
            rows.push(list.length ? { ...base, kind: "list", value: list } : { ...base, kind: "empty", value: null });
        } else if (field.kind === "stringListMap") {
            const map = isPlainObject(raw) ? Object.entries(raw).map(([name, list]) => ({ name, entries: toStringList(list) })) : [];
            rows.push(map.length ? { ...base, kind: "listMap", value: null, map } : { ...base, kind: "empty", value: null });
        } else if (field.kind === "tree") {
            const count = Array.isArray(raw) ? raw.length : isPlainObject(raw) ? Object.keys(raw).length : 0;
            rows.push(count ? { ...base, kind: "text", value: String(count) } : { ...base, kind: "empty", value: null });
        } else {
            const text = readText(raw);
            rows.push(text ? { ...base, kind: "text", value: text } : { ...base, kind: "empty", value: null });
        }
    }
    const rest: JsonObject = {};
    for (const [name, entry] of Object.entries(source)) if (!consumed.has(name)) rest[name] = entry;
    flattenInto(rest, [], rows);
    return rows;
};

const flattenInto = (value: unknown, prefix: string[], rows: SettingSummaryRow[]): void => {
    if (rows.length > 80) return;
    const label = prefix.map(humanizeKey).join(" · ");
    const path = prefix.join(".");
    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0 && prefix.length > 0) rows.push({ path, label, kind: "empty", value: null });
        for (const [name, entry] of entries) flattenInto(entry, [...prefix, name], rows);
    } else if (Array.isArray(value)) {
        if (value.length === 0) rows.push({ path, label, kind: "empty", value: null });
        else if (value.every((entry) => entry === null || typeof entry !== "object")) rows.push({ path, label, kind: "list", value: value.map(String) });
        else value.forEach((entry, index) => flattenInto(entry, [...prefix, String(index + 1)], rows));
    } else if (typeof value === "boolean") rows.push({ path, label, kind: "boolean", value });
    else if (value === null || value === undefined || value === "") rows.push({ path, label, kind: "empty", value: null });
    else rows.push({ path, label, kind: "text", value: String(value) });
};
