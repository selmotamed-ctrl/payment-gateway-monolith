import { SETTING_SECTIONS, SETTING_SECTION_BY_ID, SETTING_STATUS_META, resolveSettingDefinition, settingCatalogDefinitions, settingNamespaceFor, type SettingDefinition, type SettingDisplayStatus, type SettingSectionId } from "./settingsCatalog";
import { resolveSettingNamespace, summarizeSetting, type SettingNamespaceDef } from "./settingsSchemas";
import { asObject, type JsonObject } from "./jsonTree";

/**
 * Pure merge/search/version helpers for the Platform Settings page.
 * Kept free of Vue so the behavior is unit-testable in the repository `tests` workspace.
 */

export type PlatformSettingRow = {
    id: string;
    key: string;
    scope: string;
    version: number;
    valueJson: Record<string, unknown>;
    effectiveFrom: string;
    createdAt: string;
    updatedAt: string;
};

export type SettingVersionSet = {
    latest: PlatformSettingRow | null;
    effective: PlatformSettingRow | null;
    scheduled: PlatformSettingRow[];
};

export type SettingEntry = {
    definition: SettingDefinition;
    key: string;
    namespace: SettingNamespaceDef | null;
    rows: PlatformSettingRow[];
    latest: PlatformSettingRow | null;
    effective: PlatformSettingRow | null;
    scheduled: PlatformSettingRow[];
    configured: boolean;
    scope: string;
    value: JsonObject;
    usingDefault: boolean;
    displayStatus: SettingDisplayStatus;
    readOnly: boolean;
};

export type SettingStatusFilter = "all" | "live" | "decision" | "default" | "attention";
export type SettingsViewId = "all" | SettingSectionId;

export const selectEffectiveVersion = (rows: readonly PlatformSettingRow[], nowMs: number): SettingVersionSet => {
    const sorted = [...rows].sort((left, right) => right.version - left.version);
    const latest = sorted[0] ?? null;
    const effective = sorted.find((row) => {
        const at = new Date(row.effectiveFrom).getTime();
        return Number.isFinite(at) && at <= nowMs;
    }) ?? null;
    const scheduled = sorted
        .filter((row) => {
            const at = new Date(row.effectiveFrom).getTime();
            return Number.isFinite(at) && at > nowMs;
        })
        .sort((left, right) => new Date(left.effectiveFrom).getTime() - new Date(right.effectiveFrom).getTime() || left.version - right.version);
    return { latest, effective, scheduled };
};

const statusFor = (definition: SettingDefinition, configured: boolean): SettingDisplayStatus => {
    if (definition.unregistered) return "UNREGISTERED";
    if (!configured && definition.showWhenUnconfigured) return "UNCONFIGURED";
    return definition.lifecycle;
};

const createEntry = (definition: SettingDefinition, rows: PlatformSettingRow[], nowMs: number): SettingEntry => {
    const namespace = settingNamespaceFor(definition);
    const { latest, effective, scheduled } = selectEffectiveVersion(rows, nowMs);
    const configured = rows.length > 0;
    const value = asObject(effective?.valueJson ?? (configured ? latest?.valueJson : definition.defaults) ?? definition.defaults);
    return {
        definition,
        key: definition.key,
        namespace,
        rows,
        latest,
        effective,
        scheduled,
        configured,
        scope: latest?.scope ?? "PLATFORM",
        value,
        usingDefault: !configured,
        displayStatus: statusFor(definition, configured),
        readOnly: !definition.allowEdit,
    };
};

/**
 * Merge the API rows with the catalog. Every known runtime setting is shown even
 * when it has no row (as "Using default"); decision records are shown only when
 * configured. Any row without a catalog entry becomes an "Unregistered" entry.
 */
export const mergeSettingEntries = (rows: readonly PlatformSettingRow[], nowMs: number = Date.now()): SettingEntry[] => {
    const grouped = new Map<string, PlatformSettingRow[]>();
    for (const row of rows) {
        const list = grouped.get(row.key) ?? [];
        list.push(row);
        grouped.set(row.key, list);
    }
    const entries: SettingEntry[] = [];
    const covered = new Set<string>();
    for (const definition of settingCatalogDefinitions()) {
        covered.add(definition.key);
        const keyRows = grouped.get(definition.key) ?? [];
        if (keyRows.length === 0 && !definition.showWhenUnconfigured) continue;
        entries.push(createEntry(definition, keyRows, nowMs));
    }
    for (const [key, keyRows] of grouped) {
        if (covered.has(key)) continue;
        entries.push(createEntry(resolveSettingDefinition(key), keyRows, nowMs));
    }
    return entries;
};

/** One entry for a known-but-unconfigured setting (used by the New setting picker). */
export const createUnconfiguredEntry = (definition: SettingDefinition, nowMs: number = Date.now()): SettingEntry =>
    createEntry(definition, [], nowMs);

export const createUnregisteredEntry = (key: string, nowMs: number = Date.now()): SettingEntry =>
    createEntry(resolveSettingDefinition(key), [], nowMs);

export const settingDisplayStatusMeta = (status: SettingDisplayStatus) => SETTING_STATUS_META[status];

const normalizeArabic = (value: string): string =>
    value
        .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
        .replace(/[أإآ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه");

export const normalizeSettingSearch = (value: string): string =>
    normalizeArabic(String(value ?? ""))
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

const valueSearchText = (entry: SettingEntry, translate: (text: string) => string): string => {
    const rows = summarizeSetting(entry.key, entry.value);
    const parts: string[] = [];
    for (const row of rows.slice(0, 80)) {
        parts.push(translate(row.label));
        if (row.map) {
            for (const group of row.map) parts.push(group.name, group.entries.join(" "));
        } else if (Array.isArray(row.value)) {
            parts.push(row.value.join(" "));
        } else if (typeof row.value === "boolean") {
            parts.push(row.value ? translate("Yes") : translate("No"));
        } else if (row.value !== null) {
            parts.push(String(row.value));
        }
    }
    return parts.join(" ");
};

const fieldSearchText = (namespace: SettingNamespaceDef | null, translate: (text: string) => string): string => {
    if (!namespace) return "";
    const parts: string[] = [translate(namespace.title), translate(namespace.description)];
    for (const field of namespace.fields) {
        parts.push(field.key, translate(field.label), translate(field.hint));
        if (field.description) parts.push(translate(field.description));
        if (field.unit) parts.push(field.unit);
        if (field.options) {
            parts.push(...field.options);
            for (const option of field.options) {
                const hint = field.optionHints?.[option];
                if (hint) parts.push(translate(hint));
            }
        }
    }
    return parts.join(" ");
};

export const settingSearchText = (entry: SettingEntry, translate: (text: string) => string = (text) => text): string => {
    const section = SETTING_SECTION_BY_ID[entry.definition.section];
    const status = SETTING_STATUS_META[entry.displayStatus];
    const parts = [
        entry.key,
        entry.definition.id,
        translate(entry.definition.summary),
        translate(entry.definition.description),
        translate(entry.definition.readBy),
        translate(entry.definition.effect),
        translate(entry.definition.riskReason),
        ...entry.definition.keywords.map(translate),
        translate(section.title),
        translate(section.description),
        translate(status.label),
        translate(status.description),
        fieldSearchText(entry.namespace, translate),
        valueSearchText(entry, translate),
    ];
    return normalizeSettingSearch(parts.filter(Boolean).join(" "));
};

export type SettingSearchOptions = {
    query: string;
    section: SettingsViewId;
    status: SettingStatusFilter;
    translate?: (text: string) => string;
};

const matchesStatus = (entry: SettingEntry, filter: SettingStatusFilter): boolean => {
    switch (filter) {
        case "live":
            return entry.displayStatus === "RUNTIME" || entry.displayStatus === "DYNAMIC";
        case "decision":
            return entry.displayStatus === "DECISION";
        case "default":
            return entry.displayStatus === "UNCONFIGURED" || (entry.displayStatus === "FALLBACK" && !entry.configured);
        case "attention":
            return entry.displayStatus === "UNREGISTERED" || entry.displayStatus === "DEPRECATED" || entry.displayStatus === "FALLBACK";
        default:
            return true;
    }
};

export const filterSettingEntries = (entries: readonly SettingEntry[], options: SettingSearchOptions): SettingEntry[] => {
    const terms = normalizeSettingSearch(options.query).split(" ").filter(Boolean);
    const filtered = entries.filter((entry) => {
        if (options.section !== "all" && entry.definition.section !== options.section) return false;
        if (!matchesStatus(entry, options.status)) return false;
        if (terms.length === 0) return true;
        const haystack = settingSearchText(entry, options.translate);
        return terms.every((term) => haystack.includes(term));
    });
    const sectionOrder = new Map(SETTING_SECTIONS.map((section, index) => [section.id, index]));
    return filtered.sort((left, right) => {
        const leftSection = sectionOrder.get(left.definition.section) ?? 99;
        const rightSection = sectionOrder.get(right.definition.section) ?? 99;
        if (leftSection !== rightSection) return leftSection - rightSection;
        if (left.configured !== right.configured) return left.configured ? -1 : 1;
        const leftTitle = left.namespace?.title ?? left.definition.summary;
        const rightTitle = right.namespace?.title ?? right.definition.summary;
        return leftTitle.localeCompare(rightTitle);
    });
};

export type SettingSectionCount = {
    id: SettingsViewId;
    count: number;
    needsSetup: number;
    attention: number;
};

export const settingSectionCounts = (entries: readonly SettingEntry[]): SettingSectionCount[] => {
    const all = { id: "all" as const, count: entries.length, needsSetup: 0, attention: 0 };
    const counts = new Map<SettingSectionId, SettingSectionCount>();
    for (const section of SETTING_SECTIONS) counts.set(section.id, { id: section.id, count: 0, needsSetup: 0, attention: 0 });
    for (const entry of entries) {
        const count = counts.get(entry.definition.section);
        if (!count) continue;
        count.count += 1;
        if (entry.displayStatus === "UNCONFIGURED" || (entry.displayStatus === "FALLBACK" && !entry.configured)) count.needsSetup += 1;
        if (entry.displayStatus === "UNREGISTERED" || entry.displayStatus === "DEPRECATED" || entry.displayStatus === "FALLBACK") count.attention += 1;
        all.needsSetup += entry.displayStatus === "UNCONFIGURED" || (entry.displayStatus === "FALLBACK" && !entry.configured) ? 1 : 0;
        all.attention += entry.displayStatus === "UNREGISTERED" || entry.displayStatus === "DEPRECATED" || entry.displayStatus === "FALLBACK" ? 1 : 0;
    }
    return [all, ...SETTING_SECTIONS.map((section) => counts.get(section.id)!)];
};

export const settingTitle = (entry: SettingEntry): string => entry.namespace?.title ?? entry.definition.summary;

/** One-line value preview for a compact row. Never raw JSON. */
export const settingPreview = (entry: SettingEntry, translate: (text: string) => string = (text) => text): string => {
    const preferred = new Set(entry.definition.cardFields ?? []);
    const rows = summarizeSetting(entry.key, entry.value).filter((row) => row.path !== "description");
    const selected = preferred.size > 0
        ? rows.filter((row) => preferred.has(row.path)).slice(0, 3)
        : rows.slice(0, 3);
    const fallback = selected.length > 0 ? selected : rows.slice(0, 3);
    const parts = fallback.map((row) => {
        const label = translate(row.label);
        if (row.kind === "boolean") return `${label}: ${row.value === true ? translate("On") : translate("Off")}`;
        if (row.kind === "list") return `${label}: ${Array.isArray(row.value) ? row.value.length : 0} ${translate("entries")}`;
        if (row.kind === "listMap") return `${label}: ${row.map?.length ?? 0} ${translate("groups")}`;
        if (row.kind === "empty") return `${label}: ${translate("Not set")}`;
        return `${label}: ${String(row.value)}`;
    });
    if (parts.length === 0) return entry.usingDefault ? translate("No value stored; using the built-in default.") : translate("No fields to preview.");
    return parts.join(" · ");
};

export const settingFieldGroups = (namespace: SettingNamespaceDef | null): Array<{ group: string; fields: SettingNamespaceDef["fields"][number][] }> => {
    if (!namespace) return [];
    const map = new Map<string, SettingNamespaceDef["fields"][number][]>();
    for (const field of namespace.fields) {
        const group = field.group ?? "General";
        const list = map.get(group) ?? [];
        list.push(field);
        map.set(group, list);
    }
    return [...map.entries()].map(([group, fields]) => ({ group, fields }));
};

export const namespaceForEntry = (entry: SettingEntry | null): SettingNamespaceDef | null =>
    entry ? entry.namespace ?? resolveSettingNamespace(entry.key) : null;
