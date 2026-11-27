export interface PgOption<T = any> {
    value: T;
    label: string;
    description?: string;
    subtitle?: string;
    icon?: string;
    badge?: string;
    disabled?: boolean;
    raw?: unknown;
}

export type NormalizeAccessors = {
    itemTitle?: string | ((item: any) => any);
    itemValue?: string | ((item: any) => any);
    itemSubtitle?: string | ((item: any) => any);
    itemDescription?: string | ((item: any) => any);
    itemIcon?: string | ((item: any) => any);
    itemDisabled?: string | ((item: any) => any);
};

const readAccessor = (item: any, accessor: string | ((item: any) => any) | undefined, fallback: any) => {
    if (typeof accessor === "function") {
        try {
            return accessor(item);
        } catch {
            return fallback;
        }
    }
    if (typeof accessor === "string" && item != null) return item[accessor];
    return fallback;
};

/**
 * Normalises Vuetify-era `items` (plain values, `{ title, value }`,
 * `{ label, id }`, `{ name, id }`, accessor strings/functions) into the one
 * shape every `@pg/ui` picker understands.
 *
 * `normalizeOptions(items, 'title', 'value')` and
 * `normalizeOptions(items, { itemTitle: 'title', itemValue: 'value' })` both work.
 */
export const normalizeOptions = (
    items: unknown,
    accessorsOrTitle: NormalizeAccessors | string = {},
    itemValue?: string,
): PgOption[] => {
    const accessors: NormalizeAccessors =
        typeof accessorsOrTitle === "string"
            ? { itemTitle: accessorsOrTitle, itemValue }
            : accessorsOrTitle ?? {};
    if (!Array.isArray(items)) return [];
    return items.map((item, index) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
            const value = readAccessor(item, accessors.itemValue, item.value ?? item.id ?? item.key ?? index);
            const label = readAccessor(item, accessors.itemTitle, item.title ?? item.label ?? item.name ?? String(value));
            const subtitle = readAccessor(item, accessors.itemSubtitle, item.subtitle ?? item.description ?? item.hint);
            const description = readAccessor(
                item,
                accessors.itemDescription,
                (item as any).description ?? (item as any).hint,
            );
            const icon = readAccessor(item, accessors.itemIcon, item.icon);
            const disabled = readAccessor(item, accessors.itemDisabled, item.disabled);
            return {
                value,
                label: String(label ?? value ?? ""),
                subtitle: subtitle == null ? undefined : String(subtitle),
                description: description == null ? undefined : String(description),
                icon: typeof icon === "string" && icon ? icon : undefined,
                badge: item.badge == null ? undefined : String(item.badge),
                disabled: Boolean(disabled),
                raw: item,
            };
        }
        return { value: item, label: String(item ?? ""), raw: item };
    });
};

/**
 * Equality for option values. Numbers and numeric strings from a URL query
 * (`123` vs `'123'`) match, which keeps a refreshed filter visibly selected.
 */
export const sameValue = (a: any, b: any): boolean => {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) return false;
    if (typeof a !== "object" && typeof b !== "object") return String(a) === String(b);
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
};

export const normalizeSize = (size: any): "sm" | "md" | "lg" | undefined => {
    if (size === "x-small" || size === "small" || size === "compact") return "sm";
    if (size === "large" || size === "x-large") return "lg";
    if (size === "default" || size === "comfortable" || size === "medium") return "md";
    return size === "sm" || size === "md" || size === "lg" ? size : undefined;
};

export const controlSize = (attrs: Record<string, any>): "sm" | "md" | "lg" => {
    if (attrs.density === "compact") return "sm";
    return normalizeSize(attrs.size) ?? "md";
};

/** Normalises `check`, `mdi-check` and empty names. */
export const iconName = (name: any): string | null => {
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    return trimmed.startsWith("mdi-") ? trimmed : `mdi-${trimmed}`;
};

export const pick = (attrs: Record<string, any>, keys: string[]) => {
    const out: Record<string, any> = {};
    for (const key of keys) {
        if (attrs[key] !== undefined) out[key] = attrs[key];
    }
    return out;
};
