import { defineComponent, type VNodeChild } from "vue";
import { useLocale } from "vuetify";

export const FormField = defineComponent({
    name: "FormField",
    props: {
        label: { type: String, required: true },
        hint: { type: String, default: "" },
        required: { type: Boolean, default: false },
        sensitiveMakerChecker: { type: Boolean, default: false },
    },
    setup(props, { slots }) {
        const { t } = useLocale();
        return (): VNodeChild => (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <label style={{ fontSize: "13px", fontWeight: 500, color: "var(--pg-ink-primary)" }}>
                        {props.label}
                        {props.required && (
                            <span style={{ color: "var(--pg-status-danger-dot)", marginInlineStart: "3px" }}>*</span>
                        )}
                    </label>
                    {props.sensitiveMakerChecker && (
                        <span
                            style={{
                                fontSize: "11px",
                                fontWeight: 500,
                                padding: "1px 6px",
                                borderRadius: "4px",
                                backgroundColor: "var(--pg-status-warning-bg)",
                                color: "var(--pg-status-warning-text)",
                                border: "1px solid var(--pg-status-warning-border)",
                            }}
                        >
                            {t("Four-Eyes Required")}
                        </span>
                    )}
                </div>
                {slots.default?.()}
                {props.hint && (
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)", lineHeight: 1.4 }}>{props.hint}</span>
                )}
            </div>
        );
    },
});

export default FormField;
