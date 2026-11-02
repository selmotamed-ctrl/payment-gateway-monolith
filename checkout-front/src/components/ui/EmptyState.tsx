import { defineComponent, type VNodeChild } from "vue";
import { VBtn, VIcon } from "vuetify/components";

export const EmptyState = defineComponent({
    name: "EmptyState",
    props: {
        title: { type: String, default: "" },
        description: { type: String, default: "" },
        icon: { type: String, default: "mdi-inbox-outline" },
        actionLabel: { type: String, default: "" },
    },
    emits: ["action"],
    setup(props, { emit, slots }) {
        return (): VNodeChild => (
            <div
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
                    <VBtn size="small" variant="outlined" onClick={() => emit("action")}>
                        {props.actionLabel}
                    </VBtn>
                )}
            </div>
        );
    },
});

export default EmptyState;
