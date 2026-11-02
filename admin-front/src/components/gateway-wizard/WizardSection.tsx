import { defineComponent, type VNodeChild } from "vue";

export const WizardSection = defineComponent({
    name: "WizardSection",
    props: {
        title: { type: String, default: "" },
        hint: { type: String, default: "" },
        divider: { type: Boolean, default: false },
    },
    setup(props, { slots }) {
        return (): VNodeChild => (
            <section
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    paddingTop: props.divider ? "18px" : "0",
                    borderTop: props.divider ? "1px solid var(--pg-border-subtle)" : undefined,
                }}
            >
                {(props.title || props.hint || slots.actions) && (
                    <div
                        style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: "12px",
                            flexWrap: "wrap",
                        }}
                    >
                        <div style={{ minWidth: 0 }}>
                            {props.title && (
                                <h3
                                    style={{
                                        margin: 0,
                                        fontSize: "14px",
                                        fontWeight: 600,
                                        color: "var(--pg-ink-primary)",
                                    }}
                                >
                                    {props.title}
                                </h3>
                            )}
                            {props.hint && (
                                <p
                                    style={{
                                        margin: "2px 0 0",
                                        fontSize: "12.5px",
                                        color: "var(--pg-ink-muted)",
                                        lineHeight: 1.5,
                                    }}
                                >
                                    {props.hint}
                                </p>
                            )}
                        </div>
                        {slots.actions && (
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                {slots.actions()}
                            </div>
                        )}
                    </div>
                )}
                {slots.default?.()}
            </section>
        );
    },
});

export default WizardSection;
