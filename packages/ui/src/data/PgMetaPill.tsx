import { dc } from "../lib/dc";
import { PgIcon } from "../actions/PgIcon";

export type MetaPillTone = "neutral" | "brand" | "info" | "success" | "warning" | "danger";

const TONES: ReadonlySet<string> = new Set(["neutral", "brand", "info", "success", "warning", "danger"]);

const resolveTone = (tone?: string, color?: string): MetaPillTone => {
    const value = String(tone || color || "neutral").toLowerCase();
    if (value === "brand" || value === "primary" || value === "accent") return "brand";
    if (value === "success" || value === "green") return "success";
    if (value === "warning" || value === "amber" || value === "orange") return "warning";
    if (value === "danger" || value === "error" || value === "red") return "danger";
    if (value === "info" || value === "blue") return "info";
    return TONES.has(value) ? (value as MetaPillTone) : "neutral";
};

/** Small metadata pill with an optional leading icon and a key/value pair. */
export const PgMetaPill = dc(
    (
        props: {
            label?: string;
            value?: string | number;
            icon?: string;
            tone?: string;
            color?: string;
            mono?: boolean;
            onClick?: (event?: MouseEvent) => void;
            size?: string;
            variant?: string;
            prependIcon?: string;
        },
        _expose,
        { attrs, slots },
    ) => {
        const clickHandler = (event?: MouseEvent) => {
            (props.onClick as ((event?: MouseEvent) => void) | undefined)?.(event);
            const fallthrough = (attrs as any).onClick;
            if (typeof fallthrough === "function") fallthrough(event);
        };

        const clickable = () => typeof props.onClick === "function" || typeof (attrs as any).onClick === "function";

        const onKeydown = (event: KeyboardEvent) => {
            if (!clickable()) return;
            if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
                event.preventDefault();
                clickHandler(event as unknown as MouseEvent);
            }
        };

        const hasValue = () => props.value !== undefined && props.value !== null && props.value !== "";

        return () => (
            <span
                {...attrs}
                class={[
                    "pg-meta-pill",
                    `pg-meta-pill--${resolveTone(props.tone, props.color)}`,
                    props.mono ? "pg-meta-pill--mono" : "",
                    clickable() ? "pg-meta-pill--clickable" : "",
                    props.variant === "outlined" ? "pg-meta-pill--outlined" : "",
                    props.variant === "text" ? "pg-meta-pill--text" : "",
                    props.size === "x-small" ? "pg-meta-pill--xs" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                role={clickable() ? "button" : undefined}
                tabindex={clickable() ? 0 : undefined}
                onClick={clickable() ? clickHandler : undefined}
                onKeydown={clickable() ? onKeydown : undefined}
            >
                {(props.icon || props.prependIcon) && (
                    <PgIcon icon={(props.icon || props.prependIcon) as string} size={13} />
                )}
                {props.label && <span class="pg-meta-pill__label">{props.label}</span>}
                {hasValue() && <span class="pg-meta-pill__value">{props.value}</span>}
                {slots.default?.()}
            </span>
        );
    },
    {
        props: {
            label: { type: String, default: "" },
            value: { type: [String, Number], default: "" },
            icon: { type: String, default: "" },
            tone: { type: String, default: "" },
            color: { type: String, default: "" },
            mono: { type: Boolean, default: false },
            onClick: { type: Function as unknown as () => ((event?: MouseEvent) => void) | undefined, default: undefined },
            size: { type: String, default: "small" },
            variant: { type: String, default: "tonal" },
            prependIcon: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

export const MetaPill = PgMetaPill;
