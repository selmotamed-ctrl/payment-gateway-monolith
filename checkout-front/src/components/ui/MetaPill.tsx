import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VIcon } from "vuetify/components";
import type { BadgeTone } from "./StatusBadge";

const toneForColor = (color: string): BadgeTone => {
    const normalized = color.toLowerCase();
    if (["success", "green"].includes(normalized)) return "success";
    if (["warning", "amber", "orange"].includes(normalized)) return "warning";
    if (["error", "danger", "red"].includes(normalized)) return "danger";
    if (["info", "blue"].includes(normalized)) return "info";
    return "neutral";
};

const TONE_STYLES: Record<BadgeTone, { bg: string; text: string; border: string }> = {
    success: { bg: "var(--pg-status-success-bg)", text: "var(--pg-status-success-text)", border: "var(--pg-status-success-border)" },
    warning: { bg: "var(--pg-status-warning-bg)", text: "var(--pg-status-warning-text)", border: "var(--pg-status-warning-border)" },
    danger: { bg: "var(--pg-status-danger-bg)", text: "var(--pg-status-danger-text)", border: "var(--pg-status-danger-border)" },
    info: { bg: "var(--pg-status-info-bg)", text: "var(--pg-status-info-text)", border: "var(--pg-status-info-border)" },
    neutral: { bg: "var(--pg-bg-surface-subtle)", text: "var(--pg-ink-secondary)", border: "var(--pg-border-subtle)" },
};

export const MetaPill = defineComponent({
    name: "MetaPill",
    props: {
        color: { type: String, default: "" },
        size: { type: String as PropType<"x-small" | "small" | "default">, default: "small" },
        variant: { type: String as PropType<"tonal" | "flat" | "outlined" | "text">, default: "tonal" },
        prependIcon: { type: String, default: "" },
    },
    setup(props, { slots }) {
        return (): VNodeChild => {
            const tone = toneForColor(props.color || "neutral");
            const palette = TONE_STYLES[tone];
            const outlined = props.variant === "outlined";
            const text = props.variant === "text";
            const height = props.size === "x-small" ? "20px" : props.size === "default" ? "24px" : "22px";
            return (
                <span
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        height,
                        padding: "0 8px",
                        borderRadius: "var(--pg-radius-sm)",
                        backgroundColor: text ? "transparent" : outlined ? "transparent" : palette.bg,
                        color: text ? "var(--pg-ink-secondary)" : palette.text,
                        border: text ? "1px solid transparent" : `1px solid ${outlined ? "var(--pg-border-subtle)" : palette.border}`,
                        fontSize: props.size === "x-small" ? "11px" : "12px",
                        fontWeight: 500,
                        lineHeight: 1,
                        whiteSpace: "nowrap",
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
