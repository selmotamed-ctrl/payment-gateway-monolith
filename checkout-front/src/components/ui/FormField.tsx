import { createSlot, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { defineComponent } from "@/utils/dc";
import { useLocale } from "@/utils/vael-compat";

/**
 * Vapor-safe field shell.
 *
 * Vapor has no vnode tree to clone, so the old `cloneVNode` approach is not
 * possible. The shell renders the field slot and mirrors the label/hint/error
 * semantics onto the first form control through ARIA attributes. Callers that
 * need explicit control can also use the `field` scoped slot.
 */
export const FormField = defineComponent({
    name: "FormField",
    props: {
        label: { type: String, required: true },
        hint: { type: String, default: "" },
        error: { type: String, default: "" },
        required: { type: Boolean, default: false },
        sensitiveMakerChecker: { type: Boolean, default: false },
        variant: { type: String, default: "default" },
        id: { type: String, default: "" },
    },
    setup(props) {
        const { t } = useLocale();
        const generatedId = useId();
        const fieldId = props.id || generatedId;
        const hintId = `${fieldId}-hint`;
        const errorId = `${fieldId}-error`;
        const wrapper = ref<HTMLElement | null>(null);
        let observer: MutationObserver | undefined;
        let scheduled = false;

        const applyAria = () => {
            const root = wrapper.value;
            if (!root) return;
            const control = root.querySelector<HTMLElement>(
                "input, select, textarea, [contenteditable='true'], [role='combobox']",
            );
            if (!control) return;

            const describedBy = [props.hint ? hintId : "", props.error ? errorId : ""]
                .filter(Boolean)
                .join(" ");

            if (!control.id) control.id = fieldId;
            if (control.getAttribute("aria-label") !== props.label) {
                control.setAttribute("aria-label", props.label);
            }
            if (describedBy && control.getAttribute("aria-describedby") !== describedBy) {
                control.setAttribute("aria-describedby", describedBy);
            }
            const required = props.required ? "true" : null;
            if (control.getAttribute("aria-required") !== required) {
                if (required) control.setAttribute("aria-required", required);
                else control.removeAttribute("aria-required");
            }
            const invalid = props.error ? "true" : null;
            if (control.getAttribute("aria-invalid") !== invalid) {
                if (invalid) control.setAttribute("aria-invalid", invalid);
                else control.removeAttribute("aria-invalid");
            }
        };

        const scheduleApply = () => {
            if (scheduled) return;
            scheduled = true;
            void nextTick(() => {
                scheduled = false;
                applyAria();
            });
        };

        onMounted(() => {
            applyAria();
            if (wrapper.value) {
                observer = new MutationObserver(scheduleApply);
                observer.observe(wrapper.value, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ["id", "aria-label"],
                });
            }
        });

        onBeforeUnmount(() => observer?.disconnect());

        watch(
            () => [props.label, props.hint, props.error, props.required],
            scheduleApply,
            { flush: "post" },
        );

        return () => {
            const isFilter = props.variant === "filter";
            return (
                <div
                    class={isFilter ? "pg-report-field" : undefined}
                    style={{ display: "flex", flexDirection: "column", gap: "6px" }}
                >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                        <label
                            for={fieldId}
                            class={isFilter ? "pg-filter-label" : undefined}
                            style={isFilter ? undefined : { fontSize: "13px", fontWeight: 500, color: "var(--pg-ink-primary)" }}
                        >
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
                    <div ref={wrapper}>
                        {createSlot("default", {
                            id: fieldId,
                            describedBy: [props.hint ? hintId : "", props.error ? errorId : ""]
                                .filter(Boolean)
                                .join(" ") || undefined,
                            invalid: !!props.error,
                            required: props.required,
                        })}
                    </div>
                    {props.hint && (
                        <span
                            id={hintId}
                            class={isFilter ? "pg-report-field__hint" : undefined}
                            style={isFilter ? undefined : { fontSize: "12px", color: "var(--pg-ink-muted)", lineHeight: 1.4 }}
                        >
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
