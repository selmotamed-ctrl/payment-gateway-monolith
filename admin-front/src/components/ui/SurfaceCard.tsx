import { defineComponent, type PropType, type VNodeChild } from "vue";

export const SurfaceCard = defineComponent({
    name: "SurfaceCard",
    props: {
        title: { type: String, default: "" },
        subtitle: { type: String, default: "" },
        noPadding: { type: Boolean, default: false },
        subtle: { type: Boolean, default: false },
        variant: { type: String, default: "" },
        color: { type: String, default: "" },
        onClick: { type: Function as PropType<(event: MouseEvent) => void>, default: undefined },
    },
    setup(props, { slots }) {
        return (): VNodeChild => (
            <div
                onClick={props.onClick}
                style={{
                    backgroundColor: props.subtle || props.variant === "tonal" ? "var(--pg-bg-surface-subtle)" : "var(--pg-bg-surface)",
                    border: "1px solid var(--pg-border-subtle)",
                    borderRadius: "var(--pg-radius-md)",
                    boxShadow: props.subtle ? "none" : "var(--pg-shadow-xs)",
                    overflow: "hidden",
                }}
            >
                {(props.title || slots.headerActions) && (
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
                                <p style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", margin: "2px 0 0 0" }}>
                                    {props.subtitle}
                                </p>
                            )}
                        </div>
                        {slots.headerActions && <div style={{ display: "flex", gap: "8px" }}>{slots.headerActions()}</div>}
                    </div>
                )}
                <div style={{ padding: props.noPadding ? "0" : "20px" }}>{slots.default?.()}</div>
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
    },
});

export const SurfaceCardText = defineComponent({
    name: "SurfaceCardText",
    setup(_, { slots }) {
        return (): VNodeChild => <div style={{ padding: 0 }}>{slots.default?.()}</div>;
    },
});

export default SurfaceCard;
