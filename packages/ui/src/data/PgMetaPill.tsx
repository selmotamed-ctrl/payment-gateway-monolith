import { dc } from "../lib/dc";
import { PgIcon } from "../actions/PgIcon";

/** Small metadata pill with an optional leading icon. */
export const PgMetaPill = dc(
    (props: { tone?: string; color?: string; size?: string; variant?: string; icon?: string; prependIcon?: string }, _expose, { attrs, slots }) => {
        const tone = () => {
            const value = (props.tone || props.color || "neutral").toLowerCase();
            if (["success", "green"].includes(value)) return "success";
            if (["warning", "amber", "orange"].includes(value)) return "warning";
            if (["error", "danger", "red"].includes(value)) return "danger";
            if (["info", "blue"].includes(value)) return "info";
            return "neutral";
        };
        return () => (
            <span
                {...attrs}
                class={[
                    "pg-meta-pill",
                    `pg-meta-pill--${tone()}`,
                    props.variant === "outlined" ? "pg-meta-pill--outlined" : "",
                    props.variant === "text" ? "pg-meta-pill--text" : "",
                    props.size === "x-small" ? "pg-meta-pill--xs" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                {(props.icon || props.prependIcon) && <PgIcon icon={props.icon || props.prependIcon} size={12} />}
                {slots.default?.()}
            </span>
        );
    },
    {
        props: {
            tone: { type: String, default: "" },
            color: { type: String, default: "" },
            size: { type: String, default: "small" },
            variant: { type: String, default: "tonal" },
            icon: { type: String, default: "" },
            prependIcon: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

export const MetaPill = PgMetaPill;
