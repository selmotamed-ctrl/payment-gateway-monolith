import { computed } from "vue";
import { useLocale } from "../lib/locale";
import { dc } from "../lib/dc";
import { icons, type IconName } from "./icons.generated";

/**
 * Inline SVG icon backed by the single `@mdi/js` registry in `@pg/ui`.
 *
 * - `name` / `icon` is one of the generated `mdi-*` names.
 * - `size` accepts a number (px) or any CSS length.
 * - `color` accepts a CSS colour or a semantic token name.
 * - `directional` flips arrows/chevrons in RTL.
 * - `label` makes the icon meaningful to assistive tech; otherwise it is hidden.
 */
const COLOR_TOKENS: Record<string, string> = {
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
    surface: "var(--pg-bg-surface)",
    current: "currentColor",
};

export const PgIcon = dc(
    (
        props: {
            name?: string;
            icon?: string;
            size?: number | string;
            color?: string;
            label?: string;
            directional?: boolean;
        },
        _expose,
        { attrs },
    ) => {
        const { isRtl } = useLocale();
        const resolvedName = computed(() => (props.name || props.icon || "") as IconName);
        const path = computed(() => icons[resolvedName.value] ?? "");
        const dimension = computed(() =>
            typeof props.size === "number" ? `${props.size}px` : (props.size ?? "20px"),
        );
        const color = computed(() => {
            const value = props.color?.trim();
            if (!value) return undefined;
            return COLOR_TOKENS[value] ?? value;
        });

        return () => {
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
                    style={[
                        { flex: "0 0 auto", color: color.value, display: "inline-block", verticalAlign: "middle" },
                        props.directional && isRtl.value ? { transform: "scaleX(-1)" } : undefined,
                        (attrs as { style?: any }).style,
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
            size: { type: [Number, String], default: 20 },
            color: { type: String, default: "" },
            label: { type: String, default: "" },
            directional: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

/** Compatibility alias for the old `VIcon` name. */
export const VIcon = PgIcon;

export type { IconName };
