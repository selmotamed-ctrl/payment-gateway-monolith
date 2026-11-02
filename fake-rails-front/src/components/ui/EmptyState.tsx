import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VBtn, VIcon } from "vuetify/components";

export const EmptyState = defineComponent({
    name: "EmptyState",
    props: {
        title: { type: String, default: "" },
        description: { type: String, default: "" },
        icon: { type: String, default: "mdi-inbox-outline" },
        actionLabel: { type: String, default: "" },
        actionVariant: { type: String as PropType<"outlined" | "flat" | "tonal" | "text">, default: "outlined" },
        actionColor: { type: String, default: "" },
        actionIcon: { type: String, default: "" },
        actionLoading: { type: Boolean, default: false },
    },
    emits: ["action"],
    setup(props, { emit, slots }) {
        return (): VNodeChild => (
            <div
                role="status"
                aria-live="polite"
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "10px",
                    padding: "40px 24px",
                    textAlign: "center",
                }}
            >
                <div
                    aria-hidden="true"
                    style={{
                        width: "36px",
                        height: "36px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid var(--pg-border-subtle)",
                        borderRadius: "var(--pg-radius-sm)",
                        backgroundColor: "var(--pg-bg-surface-subtle)",
                        color: "var(--pg-ink-muted)",
                    }}
                >
                    <VIcon icon={props.icon} size={18} />
                </div>
                {props.title && (
                    <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--pg-ink-primary)" }}>{props.title}</div>
                )}
                {props.description && (
                    <div style={{ fontSize: "13px", color: "var(--pg-ink-muted)", maxWidth: "52ch", lineHeight: 1.5 }}>
                        {props.description}
                    </div>
                )}
                {slots.default?.()}
                {props.actionLabel && (
                    <VBtn
                        size="small"
                        variant={props.actionVariant}
                        color={props.actionColor || undefined}
                        prependIcon={props.actionIcon || undefined}
                        loading={props.actionLoading}
                        onClick={() => emit("action")}
                    >
                        {props.actionLabel}
                    </VBtn>
                )}
            </div>
        );
    },
});

export default EmptyState;
