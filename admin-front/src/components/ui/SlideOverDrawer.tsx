import { defineComponent, useId, type VNodeChild } from "vue";
import { VBtn, VNavigationDrawer } from "vuetify/components";
import { useLocale } from "vuetify";

export const SlideOverDrawer = defineComponent({
    name: "SlideOverDrawer",
    props: {
        modelValue: { type: Boolean, required: true },
        title: { type: String, required: true },
        subtitle: { type: String, default: "" },
        width: { type: Number, default: 560 },
    },
    emits: ["update:modelValue"],
    setup(props, { emit, slots }) {
        const { t } = useLocale();
        const titleId = useId();
        const close = () => emit("update:modelValue", false);
        return (): VNodeChild => (
            <VNavigationDrawer
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                location="end"
                temporary
                width={props.width}
                class="pg-slide-over"
                tag="aside"
                aria-labelledby={titleId}
            >
                <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: "12px",
                            padding: "16px 20px",
                            borderBottom: "1px solid var(--pg-border-subtle)",
                            flex: "0 0 auto",
                        }}
                    >
                        <div style={{ minWidth: 0 }}>
                            <h2 id={titleId} style={{ fontSize: "16px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                                {props.title}
                            </h2>
                            {props.subtitle && (
                                <p style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", margin: "3px 0 0 0" }}>
                                    {props.subtitle}
                                </p>
                            )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: "0 0 auto" }}>
                            {slots.headerActions?.()}
                            <VBtn icon="mdi-close" variant="text" size="small" onClick={close} aria-label={t("Close")} />
                        </div>
                    </div>
                    <div style={{ padding: "20px", overflowY: "auto", flex: "1 1 auto", minHeight: 0 }}>
                        {slots.default?.()}
                    </div>
                    {slots.footer && (
                        <div
                            style={{
                                padding: "12px 20px",
                                borderTop: "1px solid var(--pg-border-subtle)",
                                backgroundColor: "var(--pg-bg-surface-subtle)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "flex-end",
                                gap: "8px",
                                flex: "0 0 auto",
                            }}
                        >
                            {slots.footer()}
                        </div>
                    )}
                </div>
            </VNavigationDrawer>
        );
    },
});

export default SlideOverDrawer;
