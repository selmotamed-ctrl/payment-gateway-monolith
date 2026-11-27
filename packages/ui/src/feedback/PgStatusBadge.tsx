import { createSlot } from "vue";
import { dc } from "../lib/dc";
import { formatHumanStatus, statusToTone, type BadgeTone } from "../lib/status";

export { formatHumanStatus, statusToTone, type BadgeTone };

const TONES: ReadonlySet<string> = new Set(["success", "warning", "danger", "info", "neutral"]);

/**
 * These states must never be softened by a tone override: a compromised,
 * reversed or blocked financial record is always shown in danger red.
 */
const ALWAYS_DANGER: ReadonlySet<string> = new Set([
    "CRITICAL",
    "FAILED",
    "SUSPENDED",
    "BLOCKED",
    "CHARGEBACK",
    "REVOKED",
    "HIGH_RISK",
]);

const normaliseStatus = (raw: unknown): string =>
    String(raw ?? "")
        .trim()
        .replace(/[-\s]+/g, "_")
        .replace(/_+/g, "_")
        .toUpperCase();

const normaliseTone = (raw: unknown): BadgeTone | null => {
    const value = String(raw ?? "")
        .trim()
        .toLowerCase();
    if (value === "error") return "danger";
    if (value === "warn") return "warning";
    if (value === "primary" || value === "brand" || value === "accent") return "info";
    return TONES.has(value) ? (value as BadgeTone) : null;
};

/** Semantic pill with an optional dot and tabular alignment. */
export const PgStatusBadge = dc(
    (
        props: {
            status?: string;
            label?: string;
            tone?: string;
            toneOverride?: string;
            dot?: boolean;
            showDot?: boolean;
            size?: "sm" | "md";
        },
        _expose,
        { attrs, slots },
    ) => {
        const showDot = (): boolean => {
            if (props.showDot !== undefined) return props.showDot;
            if (props.dot !== undefined) return props.dot;
            return true;
        };

        const tone = (): BadgeTone => {
            if (ALWAYS_DANGER.has(normaliseStatus(props.status))) return "danger";
            return normaliseTone(props.toneOverride || props.tone) ?? statusToTone(props.status);
        };

        return () => {
            const currentTone = tone();
            const requestedSize = String(props.size ?? "");
            const size = requestedSize === "sm" || requestedSize === "xs" || requestedSize === "x-small" ? "sm" : "md";
            return (
                <span
                    {...attrs}
                    class={[
                        "pg-badge",
                        "pg-status-badge",
                        `pg-badge--${currentTone}`,
                        `pg-badge--${size}`,
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                >
                    {showDot() && <span class="pg-badge__dot" aria-hidden="true" />}
                    <span class="pg-badge__label">
                        {slots.default ? createSlot("default") : props.label || formatHumanStatus(props.status)}
                    </span>
                </span>
            );
        };
    },
    {
        props: {
            status: { type: String, default: "" },
            label: { type: String, default: "" },
            tone: { type: String, default: "" },
            toneOverride: { type: String, default: "" },
            // `Boolean | Object` keeps an absent prop `undefined` so `dot={false}`
            // is not shadowed by a `showDot` default of `true`.
            dot: { type: [Boolean, Object], default: undefined },
            showDot: { type: [Boolean, Object], default: undefined },
            size: { type: String, default: "md" },
        },
        inheritAttrs: true,
    },
);

export const StatusBadge = PgStatusBadge;
export const StatusChip = PgStatusBadge;
