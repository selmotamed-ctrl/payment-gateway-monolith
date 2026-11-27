import { dc } from "../lib/dc";

import { formatHumanStatus, statusToTone, type BadgeTone } from "../lib/status";
export { formatHumanStatus, statusToTone, type BadgeTone };

/** Semantic pill with an optional dot and tabular alignment. */
export const PgStatusBadge = dc(
    (props: { status: string; label?: string; tone?: string; toneOverride?: string; dot?: boolean; showDot?: boolean }, _expose, { attrs }) => {
        const tone = (): BadgeTone => {
            const override = props.toneOverride ?? props.tone;
            return override && ["success", "warning", "danger", "info", "neutral"].includes(override)
                ? (override as BadgeTone)
                : statusToTone(props.status);
        };
        return () => {
            const currentTone = tone();
            return (
                <span {...attrs} class={["pg-badge", `pg-badge--${currentTone}`, attrs.class].filter(Boolean).join(" ")}>
                    {(props.showDot ?? props.dot ?? true) && <span class="pg-badge__dot" aria-hidden="true" />}
                    <span class="pg-badge__label">{props.label || formatHumanStatus(props.status)}</span>
                </span>
            );
        };
    },
    {
        props: {
            status: { type: String, required: true },
            label: { type: String, default: "" },
            tone: { type: String, default: "" },
            toneOverride: { type: String, default: "" },
            dot: { type: Boolean, default: true },
            showDot: { type: Boolean, default: true },
        },
        inheritAttrs: true,
    },
);

export const StatusBadge = PgStatusBadge;
export const StatusChip = PgStatusBadge;
