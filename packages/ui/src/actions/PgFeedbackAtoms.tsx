import { computed } from "vue";
import { dc } from "../lib/dc";

const SPINNER_SIZES: Record<string, number> = { xs: 14, sm: 16, md: 24, lg: 36 };
const SPINNER_TONES = new Set(["brand", "success", "warning", "danger", "info", "current"]);
const SPINNER_TONE_COLORS: Record<string, string> = {
    brand: "var(--pg-accent-brand)",
    success: "var(--pg-status-success-dot)",
    warning: "var(--pg-status-warning-dot)",
    danger: "var(--pg-status-danger-dot)",
    info: "var(--pg-status-info-dot)",
};
const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const toPixels = (value: number | string | undefined, fallback: number): number => {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, value);
    const raw = (value ?? "").toString().trim();
    if (!raw) return fallback;
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(1, Number(raw));
    const named = SPINNER_SIZES[raw];
    if (named) return named;
    return fallback;
};

const resolveSpinnerTone = (tone?: string, color?: string): { tone: string; custom?: string } => {
    const requested = (tone ?? "").trim();
    const legacy = (color ?? "").trim();
    if (SPINNER_TONES.has(requested)) return { tone: requested };
    if (legacy === "primary" || legacy === "brand") return { tone: "brand" };
    if (legacy === "error" || legacy === "danger") return { tone: "danger" };
    if (SPINNER_TONES.has(legacy)) return { tone: legacy };
    if (requested) return { tone: "brand", custom: requested };
    if (legacy) return { tone: "brand", custom: legacy };
    return { tone: "brand" };
};

const resolveProgressTone = (tone?: string, color?: string): { tone: string; custom?: string } => {
    const requested = (tone ?? "").trim();
    const legacy = (color ?? "").trim();
    const normalize = (value: string) => {
        if (value === "primary" || value === "brand" || value === "") return "brand";
        if (value === "error") return "danger";
        return value;
    };
    const candidate = normalize(requested || legacy);
    if (candidate === "brand" || candidate === "success" || candidate === "warning" || candidate === "danger" || candidate === "info") {
        return { tone: candidate };
    }
    return { tone: "brand", custom: requested || legacy };
};

/**
 * Crisp SVG circular activity indicator.
 *
 * - `size`: `xs` 14 / `sm` 16 / `md` 24 / `lg` 36 (or a number in px).
 * - `tone` / legacy `color`: brand, success, warning, danger, info, current.
 * - `modelValue` switches to determinate mode and is clamped to `[0, 100]`.
 * - `role="progressbar"`; reduced-motion users get a gentle opacity pulse.
 */
export const PgSpinner = dc(
    (
        props: {
            size?: number | string;
            color?: string;
            tone?: string;
            label?: string;
            modelValue?: number;
            indeterminate?: boolean;
            width?: number;
        },
        _expose,
        { attrs },
    ) => {
        const pixels = computed(() => toPixels(props.size, SPINNER_SIZES.md ?? 24));
        const tone = computed(() => resolveSpinnerTone(props.tone, props.color));
        const determinate = computed(
            () => props.modelValue !== undefined && props.modelValue !== null && Number.isFinite(Number(props.modelValue)),
        );
        const clamped = computed(() => Math.max(0, Math.min(100, Number(props.modelValue ?? 0))));
        const dashOffset = computed(() => CIRCUMFERENCE * (1 - clamped.value / 100));

        return () => {
            const size = `${pixels.value}px`;
            const strokeWidth = Math.max(1, Number(props.width) || 2.5);
            const ariaLabel = props.label || (attrs["aria-label"] as string | undefined) || "Loading";
            return (
                <svg
                    {...attrs}
                    class={["pg-spinner", `pg-spinner--${tone.value.tone}`, determinate.value ? "pg-spinner--determinate" : "", attrs.class]
                        .filter(Boolean)
                        .join(" ")}
                    viewBox="0 0 24 24"
                    width={pixels.value}
                    height={pixels.value}
                    role="progressbar"
                    aria-busy="true"
                    aria-label={ariaLabel}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={determinate.value ? clamped.value : undefined}
                    data-pg-spinner={tone.value.tone}
                    focusable="false"
                    style={[
                        {
                            width: size,
                            height: size,
                            color: tone.value.custom || SPINNER_TONE_COLORS[tone.value.tone],
                        },
                        (attrs as { style?: any }).style,
                    ]}
                >
                    <circle
                        class="pg-spinner__track"
                        cx="12"
                        cy="12"
                        r={RADIUS}
                        fill="none"
                        stroke="currentColor"
                        stroke-width={strokeWidth}
                    />
                    <circle
                        class="pg-spinner__arc"
                        cx="12"
                        cy="12"
                        r={RADIUS}
                        fill="none"
                        stroke="currentColor"
                        stroke-width={strokeWidth}
                        stroke-linecap="round"
                        stroke-dasharray={determinate.value ? CIRCUMFERENCE : `${CIRCUMFERENCE * 0.6} ${CIRCUMFERENCE * 0.4}`}
                        stroke-dashoffset={determinate.value ? dashOffset.value : CIRCUMFERENCE * 0.25}
                    />
                </svg>
            );
        };
    },
    {
        props: {
            size: { type: [Number, String], default: "md" },
            color: { type: String, default: "" },
            tone: { type: String, default: "" },
            label: { type: String, default: "" },
            modelValue: { type: Number, default: undefined },
            indeterminate: { type: Boolean, default: true },
            width: { type: Number, default: 2.5 },
        },
        inheritAttrs: true,
    },
);

/**
 * Horizontal progress bar. Tones: brand, success, warning, danger, info.
 * Values below `0` / above `max` are clamped; `aria-valuenow` reports the
 * clamped value and is omitted entirely in indeterminate mode.
 */
export const PgProgressBar = dc(
    (
        props: {
            modelValue?: number;
            value?: number;
            max?: number;
            tone?: string;
            color?: string;
            indeterminate?: boolean;
            height?: number;
            label?: string;
            showValue?: boolean;
            rounded?: boolean;
        },
        _expose,
        { attrs },
    ) => {
        const max = computed(() => {
            const raw = Number(props.max ?? 100);
            return Number.isFinite(raw) && raw > 0 ? raw : 100;
        });
        const rawValue = computed(() => Number(props.value ?? props.modelValue ?? 0));
        const clamped = computed(() => {
            const value = Number.isFinite(rawValue.value) ? rawValue.value : 0;
            return Math.max(0, Math.min(max.value, value));
        });
        const percent = computed(() => (max.value ? (clamped.value / max.value) * 100 : 0));
        const tone = computed(() => resolveProgressTone(props.tone, props.color));
        const hasHeader = computed(() => Boolean(props.label) || props.showValue === true);

        return () => {
            const label = props.label || "";
            const rounded = Math.round(percent.value);
            return (
                <div
                    {...attrs}
                    class={["pg-progress-field", attrs.class].filter(Boolean).join(" ")}
                    data-pg-progress={tone.value.tone}
                >
                    {hasHeader.value ? (
                        <div class="pg-progress__header">
                            <span class="pg-progress__label">{label}</span>
                            {props.showValue ? <span class="pg-progress__value pg-tabular">{rounded}%</span> : null}
                        </div>
                    ) : null}
                    <div
                        class={[
                            "pg-progress",
                            `pg-progress--${tone.value.tone}`,
                            props.indeterminate ? "pg-progress--indeterminate" : "",
                            props.rounded === false ? "" : "pg-progress--rounded",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={max.value}
                        aria-valuenow={props.indeterminate ? undefined : clamped.value}
                        aria-label={label || (attrs["aria-label"] as string | undefined) || undefined}
                        style={{ height: `${Math.max(1, Number(props.height) || 6)}px` }}
                    >
                        <span
                            class="pg-progress__fill"
                            style={{
                                width: props.indeterminate ? undefined : `${percent.value}%`,
                                background: tone.value.custom,
                            }}
                        />
                    </div>
                </div>
            );
        };
    },
    {
        props: {
            modelValue: { type: Number, default: undefined },
            value: { type: Number, default: undefined },
            max: { type: Number, default: 100 },
            tone: { type: String, default: "" },
            color: { type: String, default: "" },
            indeterminate: { type: Boolean, default: false },
            height: { type: Number, default: 6 },
            label: { type: String, default: "" },
            showValue: { type: Boolean, default: false },
            rounded: { type: Boolean, default: true },
        },
        inheritAttrs: true,
    },
);

/**
 * Hairline separator. Horizontal by default; `vertical` stretches inside a
 * flex toolbar, `inset` adds logical inline margin, `spaced` adds block margin,
 * and `label` renders a centred caption between two hairlines.
 */
export const PgDivider = dc(
    (props: { vertical?: boolean; inset?: boolean; spaced?: boolean; label?: string }, _expose, { attrs, slots }) => {
        const hasLabel = computed(() => !props.vertical && (Boolean(props.label) || typeof slots.default === "function"));

        return () => {
            const classes = [
                "pg-divider",
                props.vertical ? "pg-divider--vertical" : "",
                props.inset ? "pg-divider--inset" : "",
                props.spaced ? "pg-divider--spaced" : "",
                hasLabel.value ? "pg-divider--label" : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ");
            if (hasLabel.value) {
                return (
                    <div
                        {...attrs}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label={props.label || undefined}
                        class={classes}
                    >
                        <span class="pg-divider__line" aria-hidden="true" />
                        <span class="pg-divider__label">{props.label || slots.default?.()}</span>
                        <span class="pg-divider__line" aria-hidden="true" />
                    </div>
                );
            }
            return (
                <div
                    {...attrs}
                    role="separator"
                    aria-orientation={props.vertical ? "vertical" : "horizontal"}
                    class={classes}
                />
            );
        };
    },
    {
        props: {
            vertical: { type: Boolean, default: false },
            inset: { type: Boolean, default: false },
            spaced: { type: Boolean, default: false },
            label: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

export const VProgressCircular = PgSpinner;
export const VProgressLinear = PgProgressBar;
export const VDivider = PgDivider;
