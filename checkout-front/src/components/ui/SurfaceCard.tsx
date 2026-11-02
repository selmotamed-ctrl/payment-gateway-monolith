import { defineComponent, type PropType, type VNodeChild } from "vue";
import type { BadgeTone } from "./StatusBadge";

const TONE_STYLES: Record<BadgeTone, { bg: string; border: string }> = {
    success: { bg: "var(--pg-status-success-bg)", border: "var(--pg-status-success-border)" },
    warning: { bg: "var(--pg-status-warning-bg)", border: "var(--pg-status-warning-border)" },
    danger: { bg: "var(--pg-status-danger-bg)", border: "var(--pg-status-danger-border)" },
    info: { bg: "var(--pg-status-info-bg)", border: "var(--pg-status-info-border)" },
    neutral: { bg: "var(--pg-bg-surface)", border: "var(--pg-border-subtle)" },
};

const colorToTone = (color: string): BadgeTone | null => {
    const normalized = color.trim().toLowerCase();
    if (normalized === "error" || normalized === "danger" || normalized === "red") return "danger";
    if (normalized === "warning" || normalized === "amber") return "warning";
    if (normalized === "success" || normalized === "green") return "success";
    if (normalized === "info" || normalized === "primary" || normalized === "secondary" || normalized === "blue") return "info";
    if (normalized === "neutral" || normalized === "grey" || normalized === "gray") return "neutral";
    return null;
};

export const SurfaceCard = defineComponent({
    name: "SurfaceCard",
    props: {
        title: { type: String, default: "" },
        subtitle: { type: String, default: "" },
        noPadding: { type: Boolean, default: false },
        subtle: { type: Boolean, default: false },
        variant: { type: String as PropType<"flat" | "outlined" | "tonal" | "default">, default: "default" },
        color: { type: String, default: "" },
        bodyGap: { type: String, default: "" },
        bodyPadding: { type: String, default: "" },
        onClick: { type: Function as PropType<() => void | Promise<void>>, default: undefined },
    },
    setup(props, { slots }) {
        const activate = () => props.onClick?.();
        const onKeydown = (event: KeyboardEvent) => {
            if (!props.onClick) return;
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate();
            }
        };
        return (): VNodeChild => {
            const tone = props.color ? colorToTone(props.color) : null;
            const palette = tone ? TONE_STYLES[tone] : null;
            const tonal = props.subtle || props.variant === "tonal";
            return (
                <div
                    role={props.onClick ? "button" : undefined}
                    tabindex={props.onClick ? 0 : undefined}
                    onClick={() => props.onClick?.()}
                    onKeydown={onKeydown}
                    class={props.onClick ? "pg-surface-interactive" : undefined}
                    style={{
                        backgroundColor: palette?.bg ?? (tonal ? "var(--pg-bg-surface-subtle)" : "var(--pg-bg-surface)"),
                        border: `1px solid ${palette?.border ?? "var(--pg-border-subtle)"}`,
                        borderRadius: "var(--pg-radius-md)",
                        boxShadow: tonal ? "none" : "var(--pg-shadow-xs)",
                        overflow: "hidden",
                        cursor: props.onClick ? "pointer" : undefined,
                    }}
                >
                    {(props.title || props.subtitle || slots.headerActions) && (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "12px",
                                padding: "14px 20px",
                                borderBottom: "1px solid var(--pg-border-subtle)",
                            }}
                        >
                            <div>
                                {props.title && (
                                    <h2 style={{ fontSize: "15px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                                        {props.title}
                                    </h2>
                                )}
                                {props.subtitle && (
                                    <p style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", margin: props.title ? "2px 0 0 0" : 0 }}>
                                        {props.subtitle}
                                    </p>
                                )}
                            </div>
                            {slots.headerActions && <div style={{ display: "flex", gap: "8px" }}>{slots.headerActions()}</div>}
                        </div>
                    )}
                    <div
                        style={{
                            padding: props.noPadding ? "0" : props.bodyPadding || "20px",
                            display: props.bodyGap ? "flex" : undefined,
                            flexDirection: props.bodyGap ? "column" : undefined,
                            gap: props.bodyGap || undefined,
                        }}
                    >
                        {slots.default?.()}
                    </div>
                    {slots.footer && (
                        <div
                            style={{
                                padding: "12px 20px",
                                backgroundColor: "var(--pg-bg-surface-subtle)",
                                borderTop: "1px solid var(--pg-border-subtle)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "flex-end",
                                gap: "8px",
                            }}
                        >
                            {slots.footer()}
                        </div>
                    )}
                </div>
            );
        };
    },
});

export const SurfaceCardText = defineComponent({
    name: "SurfaceCardText",
    setup(_, { slots }) {
        return (): VNodeChild => <div style={{ padding: 0 }}>{slots.default?.()}</div>;
    },
});

export default SurfaceCard;
