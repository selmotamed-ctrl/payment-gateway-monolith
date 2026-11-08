import { humanizeKey, isPlainObject } from "@/components/ui/jsonDiffModel";

export interface ListVersionChip {
    /** Humanised list name, e.g. `adverse_media` -> `Adverse Media`, `ofac` -> `OFAC`. */
    list: string;
    /** Version string as recorded by the screening provider (may be empty). */
    version: string;
}

const scalar = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";

/**
 * `AmlScreening.listVersionsJson` is `{ sanctions: "v2026.10", pep: "v2026.10" }`
 * (list type -> version). Arrays of names and `{ list: { version } }` objects
 * are tolerated.
 */
export const listVersionChips = (lists: unknown): ListVersionChip[] => {
    if (lists === null || lists === undefined) return [];
    if (Array.isArray(lists)) {
        return lists
            .map((item) => {
                if (isPlainObject(item)) {
                    const name = scalar(item.list ?? item.name ?? item.type);
                    return name ? { list: humanizeKey(name), version: scalar(item.version) } : null;
                }
                const name = scalar(item);
                return name ? { list: humanizeKey(name), version: "" } : null;
            })
            .filter((chip): chip is ListVersionChip => chip !== null);
    }
    if (!isPlainObject(lists)) {
        const name = scalar(lists);
        return name ? [{ list: humanizeKey(name), version: "" }] : [];
    }
    return Object.entries(lists).map(([key, value]) => ({
        list: humanizeKey(key),
        version: isPlainObject(value) ? scalar(value.version ?? value.v) : scalar(value),
    }));
};
