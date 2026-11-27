export interface PgOption<T = any> {
    value: T;
    label: string;
    subtitle?: string;
    icon?: string;
    badge?: string;
    disabled?: boolean;
}

export type NormalizeAccessors = {
    itemTitle?: string | ((item: any) => any);
    itemValue?: string | ((item: any) => any);
    itemSubtitle?: string | ((item: any) => any);
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
 * Normalises Vuetify-style `items` (plain values, `{ title, value }`,
 * `itemTitle`/`itemValue` accessors) into the one shape every `@pg/ui` picker
 * understands.
 */
export const normalizeOptions = (items: unknown, accessors: NormalizeAccessors = {}): PgOption[] => {
    if (!Array.isArray(items)) return [];
    return items.map((item, index) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
            const value = readAccessor(item, accessors.itemValue, item.value ?? item.id ?? item.key ?? index);
            const label = readAccessor(item, accessors.itemTitle, item.title ?? item.label ?? item.name ?? String(value));
            const subtitle = readAccessor(item, accessors.itemSubtitle, item.subtitle ?? item.description ?? item.hint);
            const icon = readAccessor(item, accessors.itemIcon, item.icon);
            const disabled = readAccessor(item, accessors.itemDisabled, item.disabled);
            return {
                value,
                label: String(label ?? value ?? ""),
                subtitle: subtitle == null ? undefined : String(subtitle),
                icon: typeof icon === "string" && icon ? icon : undefined,
                badge: item.badge == null ? undefined : String(item.badge),
                disabled: Boolean(disabled),
            };
        }
        return { value: item, label: String(item ?? "") };
    });
};

export const sameValue = (a: any, b: any): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const normalizeSize = (size: any): "sm" | "md" | "lg" | undefined => {
    if (size === "x-small" || size === "small") return "sm";
    if (size === "large" || size === "x-large") return "lg";
    if (size === "default") return "md";
    return size === "sm" || size === "md" || size === "lg" ? size : undefined;
};

export const controlSize = (attrs: Record<string, any>): "sm" | "md" | "lg" => {
    if (attrs.density === "compact") return "sm";
    return normalizeSize(attrs.size) ?? "md";
};

export const iconName = (name: any): string | null =>
    typeof name === "string" && name.startsWith("mdi-") ? name : null;

export const pick = (attrs: Record<string, any>, keys: string[]) => {
    const out: Record<string, any> = {};
    for (const key of keys) {
        if (attrs[key] !== undefined) out[key] = attrs[key];
    }
    return out;
};
