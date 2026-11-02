import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VIcon } from "vuetify/components";
import type { BadgeTone } from "./StatusBadge";

const toneForColor = (color: string): BadgeTone => {
    const normalized = color.toLowerCase();
    if (["success", "green"].includes(normalized)) return "success";
    if (["warning", "amber", "orange"].includes(normalized)) return "warning";
    if (["error", "danger", "red"].includes(normalized)) return "danger";
    if (["primary", "secondary", "info", "blue"].includes(normalized)) return "info";
    return "neutral";
};

const TONE_STYLES: Record<BadgeTone, { bg: string; text: string; border: string }> = {
    success: { bg: "var(--pg-status-success-bg)", text: "var(--pg-status-success-text)", border: "var(--pg-status-success-border)" },
    warning: { bg: "var(--pg-status-warning-bg)", text: "var(--pg-status-warning-text)", border: "var(--pg-status-warning-border)" },
    danger: { bg: "var(--pg-status-danger-bg)", text: "var(--pg-status-danger-text)", border: "var(--pg-status-danger-border)" },
    info: { bg: "var(--pg-status-info-bg)", text: "var(--pg-status-info-text)", border: "var(--pg-status-info-border)" },
    neutral: { bg: "var(--pg-status-neutral-bg)", text: "var(--pg-status-neutral-text)", border: "var(--pg-status-neutral-border)" },
};

export const MetaPill = defineComponent({
    name: "MetaPill",
    props: {
        color: { type: String, default: "" },
        size: { type: String as PropType<"x-small" | "small" | "default">, default: "small" },
        variant: { type: String as PropType<"tonal" | "flat" | "outlined" | "text">, default: "tonal" },
        prependIcon: { type: String, default: "" },
        onClick: { type: Function as PropType<(event: MouseEvent) => void>, default: undefined },
    },
    setup(props, { slots }) {
        return (): VNodeChild => {
            const tone = toneForColor(props.color || "neutral");
            const palette = TONE_STYLES[tone];
            const outlined = props.variant === "outlined";
            const text = props.variant === "text";
            return (
                <span
                    onClick={props.onClick}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        height: props.size === "x-small" ? "20px" : "22px",
                        padding: "0 8px",
                        borderRadius: "var(--pg-radius-sm)",
                        backgroundColor: text ? "transparent" : outlined ? "transparent" : palette.bg,
                        color: palette.text,
                        border: text ? "1px solid transparent" : `1px solid ${palette.border}`,
                        fontSize: props.size === "x-small" ? "11px" : "12px",
                        fontWeight: 500,
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                        cursor: props.onClick ? "pointer" : undefined,
                    }}
                >
                    {props.prependIcon && <VIcon icon={props.prependIcon} size={12} />}
                    {slots.default?.()}
                </span>
            );
        };
    },
});

export default MetaPill;
