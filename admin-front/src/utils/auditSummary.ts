import { deepEqual, humanizeKey, isPlainObject } from "@/components/ui/jsonDiffModel";

/**
 * Keys that change on every write and say nothing about WHAT changed.
 * Compared case-insensitively after removing `_` / `-`.
 */
const IGNORED_KEYS = new Set([
    "updatedat",
    "createdat",
    "modifiedat",
    "lastmodifiedat",
    "lastupdatedat",
    "updatedon",
    "createdon",
    "synctimestamp",
]);

/** Shown first, in this order; everything else follows alphabetically by label. */
const PRIORITY_KEYS = [
    "status",
    "state",
    "kybstatus",
    "kycstatus",
    "risktier",
    "severity",
    "role",
    "active",
    "enabled",
];

const normalizeKey = (key: string): string => key.replace(/[_\-\s]/g, "").toLowerCase();

const parseSnapshot = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text) return null;
    if (text.startsWith("{") || text.startsWith("[")) {
        try {
            return JSON.parse(text);
        } catch {
            return value;
        }
    }
    return value;
};

const isEmpty = (value: unknown): boolean =>
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0);

/** The changed top-level keys of two snapshots, in the stable display order (priority keys first, then by label). */
const changedAuditKeys = (before: unknown, after: unknown): { key: string; label: string; left: unknown; right: unknown }[] => {
    const beforeValue = parseSnapshot(before);
    const afterValue = parseSnapshot(after);
    if (!isPlainObject(beforeValue) && !isPlainObject(afterValue)) {
        if (isEmpty(beforeValue) && isEmpty(afterValue)) return [];
        return deepEqual(beforeValue, afterValue) ? [] : [{ key: "value", label: "Value", left: beforeValue, right: afterValue }];
    }
    const left = isPlainObject(beforeValue) ? beforeValue : {};
    const right = isPlainObject(afterValue) ? afterValue : {};
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
    const changed = keys.filter((key) => {
        if (IGNORED_KEYS.has(normalizeKey(key))) return false;
        const a = left[key];
        const b = right[key];
        if (isEmpty(a) && isEmpty(b)) return false;
        return !deepEqual(a, b);
    });
    const rank = (key: string): number => {
        const index = PRIORITY_KEYS.indexOf(normalizeKey(key));
        return index === -1 ? PRIORITY_KEYS.length : index;
    };
    return changed
        .map((key) => ({ key, label: humanizeKey(key), left: left[key], right: right[key] }))
        .sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
};

/**
 * Human labels of the top-level keys that differ between two audit snapshots
 * (e.g. `["Status", "Risk Tier", "Payout Bank Details"]`). Identical values,
 * absent-vs-null/empty and bookkeeping timestamps (`updatedAt`...) are ignored;
 * the order is stable: priority keys first, then alphabetical by label.
 */
export const summarizeAuditChange = (before: unknown, after: unknown): string[] => {
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const { label } of changedAuditKeys(before, after)) {
        if (seen.has(label)) continue;
        seen.add(label);
        labels.push(label);
    }
    return labels;
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text);

/**
 * One audit value as readable text, never as raw JSON: scalars as they are, a list
 * of scalars comma-joined, a list of objects as a count, an object as
 * `Label: value · Label: value` (nested objects flattened with a middle dot path).
 */
export const formatAuditValue = (value: unknown, max = 80): string => {
    const parsed = parseSnapshot(value);
    if (parsed === null || parsed === undefined || parsed === "") return "—";
    if (typeof parsed === "string") return truncate(parsed, max);
    if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
    if (Array.isArray(parsed)) {
        if (parsed.length === 0) return "—";
        if (parsed.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
            return truncate(parsed.map((item) => String(item)).join(", "), max);
        }
        return `${parsed.length} items`;
    }
    if (isPlainObject(parsed)) {
        const parts: string[] = [];
        const walk = (node: Record<string, unknown>, path: string[]): void => {
            for (const [key, child] of Object.entries(node)) {
                if (IGNORED_KEYS.has(normalizeKey(key))) continue;
                const label = [...path, humanizeKey(key)].join(" · ");
                if (isPlainObject(child)) walk(child, [...path, humanizeKey(key)]);
                else if (!isEmpty(child)) parts.push(`${label}: ${formatAuditValue(child, max)}`);
            }
        };
        walk(parsed, []);
        return parts.length === 0 ? "—" : truncate(parts.join(" · "), max);
    }
    return truncate(String(parsed), max);
};

/**
 * `Label: before → after` for the changed keys (at most `maxKeys`, the rest folded into
 * `+N more`). Replaces the per-page `JSON.stringify` summaries of the audit timelines.
 */
export const describeAuditChange = (before: unknown, after: unknown, maxKeys = 4): string => {
    const changed = changedAuditKeys(before, after);
    if (changed.length === 0) return "";
    const shown = changed.slice(0, Math.max(1, maxKeys)).map((entry) => `${entry.label}: ${formatAuditValue(entry.left)} → ${formatAuditValue(entry.right)}`);
    const rest = changed.length - shown.length;
    return rest > 0 ? `${shown.join(" · ")} · +${rest} more` : shown.join(" · ");
};

export interface AuditChips {
    /** Labels to draw as chips (at most `max`). */
    visible: string[];
    /** How many labels were folded into the trailing "+N more" chip. */
    more: number;
}

/** Max 3 chips + a "+N more" counter. */
export const auditChangeChips = (labels: string[], max = 3): AuditChips => {
    const limit = Math.max(0, Math.floor(max));
    return { visible: labels.slice(0, limit), more: Math.max(0, labels.length - limit) };
};
