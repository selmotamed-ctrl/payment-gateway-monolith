import { createSlot, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";

/**
 * Vapor-safe field shell. It mirrors label/hint/error onto the first control via
 * ARIA and keeps the same contract across every input in `@pg/ui`.
 */
export const PgFormField = dc(
    (props: Record<string, any>, _expose, { slots }) => {
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
                "input, textarea, [contenteditable='true'], [role='combobox'], select",
            );
            if (!control) return;
            const describedBy = [props.hint ? hintId : "", props.error ? errorId : ""].filter(Boolean).join(" ");
            if (!control.id) control.id = fieldId;
            control.setAttribute("aria-label", props.label);
            if (describedBy) control.setAttribute("aria-describedby", describedBy);
            if (props.required) control.setAttribute("aria-required", "true");
            else control.removeAttribute("aria-required");
            if (props.error) control.setAttribute("aria-invalid", "true");
            else control.removeAttribute("aria-invalid");
        };
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            void nextTick(() => {
                scheduled = false;
                applyAria();
            });
        };

        onMounted(() => {
            applyAria();
            if (wrapper.value && typeof MutationObserver !== "undefined") {
                observer = new MutationObserver(schedule);
                observer.observe(wrapper.value, { childList: true, subtree: true });
            }
        });
        onBeforeUnmount(() => observer?.disconnect());
        watch(() => [props.label, props.hint, props.error, props.required], schedule, { flush: "post" });

        return () => (
            <div class={["pg-form-field", props.variant === "filter" ? "pg-form-field--filter" : ""]}>
                <div class="pg-form-field__label-row">
                    <label for={fieldId} class="pg-field__label">
                        {props.label}
                        {props.required && (
                            <span class="pg-field__required" aria-hidden="true">
                                *
                            </span>
                        )}
                    </label>
                    {props.sensitiveMakerChecker && (
                        <span class="pg-badge pg-badge--warning">{t("Four-Eyes Required")}</span>
                    )}
                </div>
                <div ref={wrapper}>
                    {createSlot("default", {
                        id: fieldId,
                        describedBy: [props.hint ? hintId : "", props.error ? errorId : ""].filter(Boolean).join(" ") || undefined,
                        invalid: Boolean(props.error),
                        required: Boolean(props.required),
                    })}
                </div>
                {props.hint && (
                    <span id={hintId} class="pg-field__hint">
                        {props.hint}
                    </span>
                )}
                {props.error && (
                    <span id={errorId} role="alert" class="pg-field__error">
                        {props.error}
                    </span>
                )}
            </div>
        );
    },
    {
        props: {
            label: { type: String, required: true },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            required: { type: Boolean, default: false },
            sensitiveMakerChecker: { type: Boolean, default: false },
            variant: { type: String, default: "default" },
            id: { type: String, default: "" },
        },
    },
);

export const FormField = PgFormField;
