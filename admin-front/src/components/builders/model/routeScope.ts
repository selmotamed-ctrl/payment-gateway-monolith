import { UUID_PATTERN, asObject, deepClone, pickAlias, toStringList, uniqueStrings, type JsonObject } from "./jsonTree";

/**
 * Route scope (core `RouteScope`, `VisibleRailsResolver.isInScope`):
 * `merchant_ids`, `application_ids`, `risk_tiers`, `channels` (camelCase accepted too).
 * An EMPTY array would exclude every merchant, so empty lists are never written
 * (same rule as `normalizeRouteScope` in `prisma/seedBlueprints.ts`).
 * `mismatch_policy.tolerance_amount` lives on the route, not in the scope, and is modelled here too.
 */
export const ROUTE_RISK_TIERS = ["LOW", "STANDARD", "HIGH"] as const;
export const ROUTE_CHANNELS = ["WEB", "API", "POS"] as const;

export type ScopeField = "merchantIds" | "applicationIds" | "riskTiers" | "channels";
const SCOPE_ALIASES: Record<ScopeField, readonly string[]> = {
    merchantIds: ["merchant_ids", "merchantIds"],
    applicationIds: ["application_ids", "applicationIds"],
    riskTiers: ["risk_tiers", "riskTiers"],
    channels: ["channels"],
};

export type RouteScopeForm = Record<ScopeField, string[]>;
export type RouteScopeState = { form: RouteScopeForm; keys: Partial<Record<ScopeField, string>>; extras: JsonObject };

export const parseRouteScope = (raw: unknown): RouteScopeState => {
    const source = asObject(raw);
    const state: RouteScopeState = {
        form: { merchantIds: [], applicationIds: [], riskTiers: [], channels: [] },
        keys: {},
        extras: {},
    };
    const consumed = new Set<string>();
    (Object.keys(SCOPE_ALIASES) as ScopeField[]).forEach((field) => {
        const alias = pickAlias(source, SCOPE_ALIASES[field]);
        if (!alias) return;
        state.keys[field] = alias;
        consumed.add(alias);
        state.form[field] = toStringList(source[alias]);
    });
    for (const [key, value] of Object.entries(source)) if (!consumed.has(key)) state.extras[key] = deepClone(value);
    return state;
};

export const serializeRouteScope = (state: RouteScopeState): JsonObject => {
    const out: JsonObject = deepClone(state.extras);
    (Object.keys(SCOPE_ALIASES) as ScopeField[]).forEach((field) => {
        const list = uniqueStrings(state.form[field]);
        if (list.length > 0) out[state.keys[field] ?? SCOPE_ALIASES[field][0]!] = list;
    });
    return out;
};

export type ScopeErrorCode = "MERCHANT_ID_INVALID" | "APPLICATION_ID_INVALID" | "RISK_TIER_INVALID" | "CHANNEL_INVALID";
export type ScopeError = { code: ScopeErrorCode; field: ScopeField; value: string };

export const validateRouteScope = (form: RouteScopeForm): ScopeError[] => {
    const errors: ScopeError[] = [];
    for (const value of form.merchantIds) if (!UUID_PATTERN.test(value)) errors.push({ code: "MERCHANT_ID_INVALID", field: "merchantIds", value });
    for (const value of form.applicationIds) if (!UUID_PATTERN.test(value)) errors.push({ code: "APPLICATION_ID_INVALID", field: "applicationIds", value });
    for (const value of form.riskTiers) if (!(ROUTE_RISK_TIERS as readonly string[]).includes(value)) errors.push({ code: "RISK_TIER_INVALID", field: "riskTiers", value });
    for (const value of form.channels) if (!(ROUTE_CHANNELS as readonly string[]).includes(value)) errors.push({ code: "CHANNEL_INVALID", field: "channels", value });
    return errors;
};

export const isScopeEmpty = (form: RouteScopeForm): boolean => (Object.values(form) as string[][]).every((list) => list.length === 0);

// ---------------------------------------------------------------- mismatch policy

export type MismatchPolicyState = { toleranceAmount: string; key: string | null; original: unknown; extras: JsonObject };

const TOLERANCE_ALIASES = ["tolerance_amount", "toleranceAmount"] as const;
const MONEY = /^\d{1,14}(\.\d{1,4})?$/;

export const parseMismatchPolicy = (raw: unknown): MismatchPolicyState => {
    const source = asObject(raw);
    const alias = pickAlias(source, TOLERANCE_ALIASES);
    const extras: JsonObject = {};
    for (const [key, value] of Object.entries(source)) if (key !== alias) extras[key] = deepClone(value);
    const original = alias ? source[alias] : undefined;
    return {
        toleranceAmount: typeof original === "number" ? String(original) : typeof original === "string" ? original : "",
        key: alias,
        original,
        extras,
    };
};

export const serializeMismatchPolicy = (state: MismatchPolicyState): JsonObject => {
    const out: JsonObject = deepClone(state.extras);
    const text = state.toleranceAmount.trim();
    if (text) {
        const asNumber = Number(text);
        out[state.key ?? TOLERANCE_ALIASES[0]] =
            typeof state.original === "number" && Number.isFinite(asNumber) && String(asNumber) === text ? asNumber : text;
    }
    return out;
};

export const validateMismatchPolicy = (state: MismatchPolicyState): "TOLERANCE_INVALID" | null =>
    state.toleranceAmount.trim() === "" || MONEY.test(state.toleranceAmount.trim()) ? null : "TOLERANCE_INVALID";
