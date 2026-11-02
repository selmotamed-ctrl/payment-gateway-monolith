import { cloneVNode, defineComponent, useId, type VNodeChild } from "vue";
import { useLocale } from "vuetify";

export const FormField = defineComponent({
    name: "FormField",
    props: {
        label: { type: String, required: true },
        hint: { type: String, default: "" },
        error: { type: String, default: "" },
        required: { type: Boolean, default: false },
        sensitiveMakerChecker: { type: Boolean, default: false },
        id: { type: String, default: "" },
    },
    setup(props, { slots }) {
        const { t } = useLocale();
        const generatedId = useId();
        const hintId = `${generatedId}-hint`;
        const errorId = `${generatedId}-error`;
        const describedBy = [props.hint ? hintId : "", props.error ? errorId : ""].filter(Boolean).join(" ") || undefined;

        return (): VNodeChild => {
            const fieldId = props.id || generatedId;
            const raw = slots.default?.() ?? [];
            const children = Array.isArray(raw) ? raw : [raw];
            const first = children[0];
            const enhanced = first
                ? [
                      cloneVNode(first, {
                          id: fieldId,
                          "aria-label": props.label,
                          "aria-describedby": describedBy,
                          "aria-required": props.required ? "true" : undefined,
                          "aria-invalid": props.error ? "true" : undefined,
                      }),
                      ...children.slice(1),
                  ]
                : [];
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                        <label for={fieldId} style={{ fontSize: "13px", fontWeight: 500, color: "var(--pg-ink-primary)" }}>
                            {props.label}
                            {props.required && (
                                <span aria-hidden="true" style={{ color: "var(--pg-status-danger-dot)", marginInlineStart: "3px" }}>
                                    *
                                </span>
                            )}
                        </label>
                        {props.sensitiveMakerChecker && (
                            <span
                                style={{
                                    fontSize: "11px",
                                    fontWeight: 500,
                                    padding: "1px 6px",
                                    borderRadius: "var(--pg-radius-xs)",
                                    backgroundColor: "var(--pg-status-warning-bg)",
                                    color: "var(--pg-status-warning-text)",
                                    border: "1px solid var(--pg-status-warning-border)",
                                }}
                            >
                                {t("Four-Eyes Required")}
                            </span>
                        )}
                    </div>
                    {enhanced}
                    {props.hint && (
                        <span id={hintId} style={{ fontSize: "12px", color: "var(--pg-ink-muted)", lineHeight: 1.4 }}>
                            {props.hint}
                        </span>
                    )}
                    {props.error && (
                        <span
                            id={errorId}
                            role="alert"
                            style={{ fontSize: "12px", color: "var(--pg-status-danger-text)", lineHeight: 1.4 }}
                        >
                            {props.error}
                        </span>
                    )}
                </div>
            );
        };
    },
});

export default FormField;
