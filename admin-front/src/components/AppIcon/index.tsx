import { computed } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { dc } from "@/utils/dc";
import { icons, type IconName } from "./icons.generated";

/**
 * Inline SVG icon. Replaces Vuetify's `VIcon` without shipping the MDI font.
 *
 * - `name` is one of the `mdi-*` names generated from the source.
 * - `size` accepts a number (px) or any CSS length.
 * - `color` accepts a CSS color or one of the design-system tokens below.
 * - `directional` flips the glyph in RTL; only arrows/chevrons should set it.
 * - `label` makes the icon meaningful to assistive tech; otherwise it is hidden.
 */
const COLOR_TOKENS: Record<string, string> = {
    primary: "var(--pg-accent-primary)",
    interactive: "var(--pg-accent-interactive)",
    success: "var(--pg-status-success-dot)",
    warning: "var(--pg-status-warning-dot)",
    error: "var(--pg-status-danger-dot)",
    info: "var(--pg-status-info-dot)",
    muted: "var(--pg-ink-muted)",
    faint: "var(--pg-ink-faint)",
    surface: "var(--pg-bg-surface)",
};

export const AppIcon = dc(
    (
        props: {
            name: IconName;
            size?: number | string;
            color?: string;
            label?: string;
            directional?: boolean;
        },
        _expose,
        { attrs },
    ) => {
        const { isRtl } = useLocale();
        const path = computed(() => icons[props.name] ?? "");
        const dimension = computed(() =>
            typeof props.size === "number" ? `${props.size}px` : (props.size ?? "20px"),
        );
        const color = computed(() => {
            const value = props.color?.trim();
            if (!value) return undefined;
            return COLOR_TOKENS[value] ?? value;
        });

        return () => (
            <svg
                {...attrs}
                viewBox="0 0 24 24"
                width={dimension.value}
                height={dimension.value}
                fill="currentColor"
                aria-hidden={props.label ? undefined : "true"}
                aria-label={props.label || undefined}
                role={props.label ? "img" : undefined}
                style={[
                    { flex: "0 0 auto", color: color.value },
                    props.directional && isRtl.value ? { transform: "scaleX(-1)" } : undefined,
                    (attrs as { style?: any }).style,
                ]}
            >
                <path d={path.value} />
            </svg>
        );
    },
    {
        props: {
            name: { type: String, required: true },
            size: { type: [Number, String], default: 20 },
            color: { type: String, default: "" },
            label: { type: String, default: "" },
            directional: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

export type { IconName };
export default AppIcon;
