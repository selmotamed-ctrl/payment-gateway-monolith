import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VBtn, VDialog } from "vuetify/components";
import { useLocale } from "vuetify";

const WIDTH_MAP = { sm: 460, md: 580, lg: 760 } as const;

export const FormModal = defineComponent({
    name: "FormModal",
    props: {
        modelValue: { type: Boolean, required: true },
        title: { type: String, required: true },
        subtitle: { type: String, default: "" },
        size: { type: String as PropType<keyof typeof WIDTH_MAP>, default: "md" },
        submitLabel: { type: String, default: "" },
        cancelLabel: { type: String, default: "" },
        loading: { type: Boolean, default: false },
        danger: { type: Boolean, default: false },
        errorMessage: { type: String, default: "" },
        onSubmit: { type: Function as PropType<() => void | Promise<void>>, default: undefined },
    },
    emits: ["update:modelValue"],
    setup(props, { emit, slots }) {
        const { t } = useLocale();
        const close = () => {
            if (!props.loading) emit("update:modelValue", false);
        };
        return (): VNodeChild => (
            <VDialog
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                maxWidth={WIDTH_MAP[props.size]}
                persistent={props.loading}
            >
                <div
                    class="pg-form-modal"
                    style={{
                        backgroundColor: "var(--pg-bg-surface)",
                        border: "1px solid var(--pg-border-subtle)",
                        borderRadius: "var(--pg-radius-lg)",
                        boxShadow: "var(--pg-shadow-modal)",
                        overflow: "hidden",
                        display: "flex",
                        flexDirection: "column",
                        maxHeight: "88vh",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: "12px",
                            padding: "16px 20px",
                            borderBottom: "1px solid var(--pg-border-subtle)",
                        }}
                    >
                        <div>
                            <h3 style={{ fontSize: "16px", fontWeight: 600, color: "var(--pg-ink-primary)", margin: 0 }}>
                                {props.title}
                            </h3>
                            {props.subtitle && (
                                <p style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", margin: "3px 0 0 0" }}>
                                    {props.subtitle}
                                </p>
                            )}
                        </div>
                        <VBtn icon="mdi-close" variant="text" size="x-small" onClick={close} aria-label={t("Close")} />
                    </div>
                    <div
                        style={{
                            padding: "20px",
                            overflowY: "auto",
                            display: "flex",
                            flexDirection: "column",
                            gap: "16px",
                        }}
                    >
                        {props.errorMessage && (
                            <div
                                role="alert"
                                style={{
                                    padding: "10px 12px",
                                    borderRadius: "var(--pg-radius-sm)",
                                    backgroundColor: "var(--pg-status-danger-bg)",
                                    border: "1px solid var(--pg-status-danger-border)",
                                    color: "var(--pg-status-danger-text)",
                                    fontSize: "13px",
                                }}
                            >
                                {props.errorMessage}
                            </div>
                        )}
                        {slots.default?.()}
                    </div>
                    {props.onSubmit && (
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
                            <VBtn variant="outlined" disabled={props.loading} onClick={close}>
                                {props.cancelLabel || t("Cancel")}
                            </VBtn>
                            <VBtn
                                color={props.danger ? "error" : "primary"}
                                variant="flat"
                                loading={props.loading}
                                onClick={() => void props.onSubmit?.()}
                            >
                                {props.submitLabel || t("Save Changes")}
                            </VBtn>
                        </div>
                    )}
                </div>
            </VDialog>
        );
    },
});

export default FormModal;
