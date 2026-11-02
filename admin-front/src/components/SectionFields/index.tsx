import { defineComponent, type PropType, type VNodeChild } from "vue";

export const SectionFields = defineComponent({
    name: "SectionFields",
    props: {
        title: { type: String, default: "" },
        subtitle: { type: String, default: "" },
        layout: { type: String as PropType<"stacked" | "split">, default: "stacked" },
        columns: { type: Number, default: 2 },
    },
    setup(props, { slots }) {
        return (): VNodeChild => {
            if (props.layout === "split") {
                return (
                    <section
                        style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(220px, 300px) 1fr",
                            gap: "24px",
                            paddingBottom: "24px",
                            marginBottom: "24px",
                            borderBottom: "1px solid var(--pg-border-subtle)",
                            alignItems: "start",
                        }}
                    >
                        <div style={{ paddingTop: "4px" }}>
                            {props.title && (
                                <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                                    {props.title}
                                </h3>
                            )}
                            {props.subtitle && (
                                <p style={{ fontSize: "13px", color: "var(--pg-ink-muted)", margin: "4px 0 0 0", lineHeight: 1.5 }}>
                                    {props.subtitle}
                                </p>
                            )}
                        </div>
                        <div class="pg-section-fields" style={{ marginBottom: 0 }}>
                            <div class="pg-section-fields__body">
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px 20px" }}>
                                    {slots.default?.()}
                                </div>
                            </div>
                            {slots.footer && <div class="pg-section-fields__footer">{slots.footer()}</div>}
                        </div>
                    </section>
                );
            }

            return (
                <section class="pg-section-fields">
                    {(props.title || slots.headerActions) && (
                        <div class="pg-section-fields__header">
                            <div>
                                {props.title && (
                                    <h3 style={{ fontSize: "15px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                                        {props.title}
                                    </h3>
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
                    <div class="pg-section-fields__body">
                        <div
                            style={{
                                display: "grid",
                                gridTemplateColumns: props.columns === 1 ? "1fr" : "repeat(auto-fit, minmax(240px, 1fr))",
                                gap: "16px 20px",
                                alignItems: "start",
                            }}
                        >
                            {slots.default?.()}
                        </div>
                    </div>
                    {slots.footer && <div class="pg-section-fields__footer">{slots.footer()}</div>}
                </section>
            );
        };
    },
});

export default SectionFields;
