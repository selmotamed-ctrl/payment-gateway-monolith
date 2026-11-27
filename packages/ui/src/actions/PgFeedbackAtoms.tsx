import { dc } from "../lib/dc";

/** Crisp SVG ring spinner with accessible `role="status"`. */
export const PgSpinner = dc(
    (props: { size?: number | string; color?: string; label?: string }, _expose, { attrs }) => {
        const dimension = () => (typeof props.size === "number" ? `${props.size}px` : props.size || "20px");
        return () => (
            <span
                {...attrs}
                class={["pg-spinner", attrs.class].filter(Boolean).join(" ")}
                role="status"
                aria-label={props.label || "Loading"}
                style={[
                    { width: dimension(), height: dimension(), color: props.color ? `var(--pg-status-${props.color}-dot, ${props.color})` : undefined },
                    (attrs as { style?: any }).style,
                ]}
            />
        );
    },
    {
        props: {
            size: { type: [Number, String], default: 20 },
            color: { type: String, default: "" },
            label: { type: String, default: "" },
        },
    },
);

/** Thin rounded semantic progress bar. */
export const PgProgressBar = dc(
    (
        props: { modelValue?: number; value?: number; max?: number; tone?: string; indeterminate?: boolean; height?: number },
        _expose,
        { attrs },
    ) => {
        const percent = () => {
            if (props.indeterminate) return 100;
            const max = props.max ?? 100;
            const value = props.value ?? props.modelValue ?? 0;
            if (!max) return 0;
            return Math.max(0, Math.min(100, (Number(value) / max) * 100));
        };
        const tone = () => {
            const value = props.tone ?? attrs.color;
            if (value === "error" || value === "danger") return "danger";
            if (value === "success" || value === "warning" || value === "info") return value;
            return "brand";
        };
        return () => (
            <div
                {...attrs}
                class={["pg-progress", `pg-progress--${tone()}`, props.indeterminate ? "pg-progress--indeterminate" : "", attrs.class]
                    .filter(Boolean)
                    .join(" ")}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={props.max ?? 100}
                aria-valuenow={props.indeterminate ? undefined : (props.value ?? props.modelValue ?? 0)}
                style={[{ height: `${props.height ?? 6}px` }, (attrs as { style?: any }).style]}
            >
                <span class="pg-progress__fill" style={{ width: `${percent()}%` }} />
            </div>
        );
    },
    {
        props: {
            modelValue: { type: Number, default: undefined },
            value: { type: Number, default: undefined },
            max: { type: Number, default: 100 },
            tone: { type: String, default: "" },
            indeterminate: { type: Boolean, default: false },
            height: { type: Number, default: 6 },
        },
    },
);

export const PgDivider = dc(
    (props: { vertical?: boolean; inset?: boolean }, _expose, { attrs }) => () => (
        <div
            {...attrs}
            role="separator"
            aria-orientation={props.vertical ? "vertical" : "horizontal"}
            class={["pg-divider", props.vertical ? "pg-divider--vertical" : "", props.inset ? "pg-divider--inset" : "", attrs.class]
                .filter(Boolean)
                .join(" ")}
        />
    ),
    { props: { vertical: { type: Boolean, default: false }, inset: { type: Boolean, default: false } } },
);

export const VProgressCircular = PgSpinner;
export const VProgressLinear = PgProgressBar;
export const VDivider = PgDivider;
