import { computed } from "vue";
import { isRtlLocale } from "../lib/locale";
import { dc } from "../lib/dc";
import { icons, type IconName } from "./icons.generated";

/**
 * Canonical registry name. The generated file exports `icons`; older design
 * notes call the same dictionary `ICON_PATHS`, so both names are available.
 */
export const ICON_PATHS: Record<string, string> = icons as unknown as Record<string, string>;

/**
 * Directional glyphs that mirror in Arabic. Callers can still force or disable
 * mirroring with the explicit `directional` prop.
 */
const DIRECTIONAL_ICONS = new Set([
    "mdi-arrow-left",
    "mdi-arrow-right",
    "mdi-chevron-left",
    "mdi-chevron-right",
    "mdi-logout",
    "mdi-undo",
]);

const WARNED_ICONS = new Set<string>();

const devConsole = (): ((...args: any[]) => void) | null => {
    try {
        const dev = Boolean((import.meta as any).env?.DEV);
        return dev && typeof console !== "undefined" ? console.warn.bind(console) : null;
    } catch {
        return null;
    }
};

const warnUnknown = (name: string) => {
    if (!name || WARNED_ICONS.has(name)) return;
    WARNED_ICONS.add(name);
    devConsole()?.(`[@pg/ui] Unknown icon "${name}". Add it to scripts/generate-ui-icons.ts.`);
};

/** `check`, `mdi-check` and an already-canonical name all resolve the same. */
export const normalizeIconName = (name?: string): string => {
    const value = (name ?? "").trim();
    if (!value) return "";
    if (value.startsWith("mdi-")) return value;
    return ICON_PATHS[`mdi-${value}`] !== undefined ? `mdi-${value}` : value;
};

const SEMANTIC_COLORS: Record<string, string> = {
    primary: "var(--pg-accent-primary)",
    interactive: "var(--pg-accent-brand)",
    brand: "var(--pg-accent-brand)",
    success: "var(--pg-status-success-dot)",
    warning: "var(--pg-status-warning-dot)",
    error: "var(--pg-status-danger-dot)",
    danger: "var(--pg-status-danger-dot)",
    info: "var(--pg-status-info-dot)",
    muted: "var(--pg-ink-muted)",
    faint: "var(--pg-ink-faint)",
    secondary: "var(--pg-ink-secondary)",
    onAccent: "var(--pg-ink-on-accent)",
    "on-accent": "var(--pg-ink-on-accent)",
    current: "currentColor",
    inherit: "inherit",
};

/** Maps a semantic tone to its token, or returns a valid CSS colour untouched. */
export const resolveIconColor = (color?: string): string | undefined => {
    const value = (color ?? "").trim();
    if (!value) return undefined;
    return SEMANTIC_COLORS[value] ?? value;
};

const slotText = (slots: Record<string, (...args: any[]) => any>): string => {
    if (typeof slots.default !== "function") return "";
    try {
        const rendered: any = slots.default();
        const first = Array.isArray(rendered) ? rendered[0] : rendered;
        return typeof first === "string" ? first.trim() : "";
    } catch {
        return "";
    }
};

/**
 * Inline SVG icon backed by the single `@mdi/js` registry in `@pg/ui`.
 *
 * - `name` / `icon` accepts `mdi-check` or `check`.
 * - `size` accepts a number (px) or any CSS length; default `18`.
 * - `color` accepts a semantic token name or any valid CSS colour.
 * - `directional` mirrors arrows/chevrons in RTL (auto-detected for known glyphs).
 * - `label` makes the icon meaningful to assistive tech; otherwise it is hidden.
 * - `spin` rotates continuously (for `mdi-loading`).
 */
export const PgIcon = dc(
    (
        props: {
            name?: string;
            icon?: string;
            size?: number | string;
            color?: string;
            label?: string;
            directional?: boolean;
            flipRtl?: boolean;
            spin?: boolean;
        },
        _expose,
        { attrs, slots },
    ) => {
        const resolvedName = computed(() => normalizeIconName(props.name || props.icon || slotText(slots)));
        const path = computed(() => {
            const name = resolvedName.value;
            const value = name ? ICON_PATHS[name] : "";
            if (!value && name) warnUnknown(name);
            return value ?? "";
        });
        const dimension = computed(() => {
            if (typeof props.size === "number") return `${props.size}px`;
            const raw = (props.size ?? "").toString().trim();
            if (!raw) return "18px";
            return /^\d+(\.\d+)?$/.test(raw) ? `${raw}px` : raw;
        });
        const color = computed(() => resolveIconColor(props.color));
        const mirrored = computed(() => {
            const directional = props.directional || props.flipRtl || DIRECTIONAL_ICONS.has(resolvedName.value);
            const documentRtl =
                typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";
            return directional && (isRtlLocale.value || documentRtl);
        });
        const spinning = computed(() => props.spin === true || resolvedName.value === "mdi-loading");

        return () => {
            const extraStyle = (attrs as { style?: any }).style;
            return (
                <svg
                    {...attrs}
                    viewBox="0 0 24 24"
                    width={dimension.value}
                    height={dimension.value}
                    fill="currentColor"
                    aria-hidden={props.label ? undefined : "true"}
                    aria-label={props.label || undefined}
                    role={props.label ? "img" : undefined}
                    focusable="false"
                    data-pg-icon={resolvedName.value || undefined}
                    class={["pg-icon", spinning.value ? "pg-icon--spin" : "", attrs.class].filter(Boolean).join(" ")}
                    style={[
                        {
                            flex: "0 0 auto",
                            display: "inline-block",
                            verticalAlign: "middle",
                            width: dimension.value,
                            height: dimension.value,
                            color: color.value,
                        },
                        mirrored.value ? { transform: "scaleX(-1)" } : undefined,
                        extraStyle,
                    ]}
                >
                    <path d={path.value} />
                </svg>
            );
        };
    },
    {
        props: {
            name: { type: String, default: "" },
            icon: { type: String, default: "" },
            size: { type: [Number, String], default: 18 },
            color: { type: String, default: "" },
            label: { type: String, default: "" },
            directional: { type: Boolean, default: false },
            flipRtl: { type: Boolean, default: false },
            spin: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

/** Compatibility aliases for the Vuetify-era names. */
export const VIcon = PgIcon;
export const AppIcon = PgIcon;

export type { IconName };
