import { computed, createSlot, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";

const CONTROL_SELECTOR = "input, textarea, [contenteditable='true'], [role='combobox'], select";

const messageOf = (value: unknown): string => {
    if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry).join(" ");
    return typeof value === "string" ? value : "";
};

/**
 * High-level form-row wrapper for custom controls (code editor, OTP, upload,
 * composite rows). It owns the label row, required mark, optional help tooltip,
 * a right-aligned action slot and the footer where an error replaces the hint.
 *
 * `PgFormField` (and its `FormField` alias) is intentionally separate from
 * `PgFieldShell`: the shell is the low-level anatomy used inside every input,
 * this wrapper is for controls assembled by application pages.
 */
export const PgFormField = dc(
    (props: Record<string, any>, _expose, { attrs, slots }) => {
        const { t } = useLocale();
        const generatedId = useId();
        const fieldId = ref(props.forId || props.id || `pg-form-field-${generatedId}`);
        const hintId = computed(() => `${fieldId.value}-hint`);
        const errorId = computed(() => `${fieldId.value}-error`);
        const wrapper = ref<HTMLElement | null>(null);
        let wrapperEl: HTMLElement | null = null;
        let observer: MutationObserver | undefined;
        let scheduled = false;

        const errorText = computed(() => messageOf(props.error));
        const hintText = computed(() => messageOf(props.hint));
        const hasError = computed(() => Boolean(errorText.value) || Boolean(slots.error));
        const hasHint = computed(() => Boolean(hintText.value) || Boolean(slots.hint));
        const describedBy = computed(() => {
            if (hasError.value) return errorId.value;
            if (hasHint.value) return hintId.value;
            return "";
        });

        const applyAria = () => {
            const root = wrapperEl;
            if (!root) return;
            const control = root.querySelector<HTMLElement>(CONTROL_SELECTOR);
            if (!control) return;
            // Keep one stable id for the whole field. Adopting the child
            // control's generated id caused an endless remount loop: each new
            // child minted a new id, which re-scoped the slot and remounted the
            // child again. Own the id instead.
            if (!props.forId && !props.id) {
                if (control.id !== fieldId.value) control.id = fieldId.value;
            } else if (!control.id && props.forId) {
                control.id = props.forId;
            }
            const existing = (control.getAttribute("aria-describedby") || "")
                .split(/\s+/)
                .filter(Boolean);
            const ids = new Set(existing);
            if (describedBy.value) ids.add(describedBy.value);
            const merged = [...ids].join(" ");
            if (merged) control.setAttribute("aria-describedby", merged);
            else control.removeAttribute("aria-describedby");
            if (props.label) control.setAttribute("aria-label", props.label);
            else control.removeAttribute("aria-label");
            if (props.required) control.setAttribute("aria-required", "true");
            else control.removeAttribute("aria-required");
            if (hasError.value) control.setAttribute("aria-invalid", "true");
            else control.removeAttribute("aria-invalid");
            if (props.disabled) control.setAttribute("aria-disabled", "true");
            else control.removeAttribute("aria-disabled");
        };
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            void nextTick(() => {
                scheduled = false;
                applyAria();
            });
        };

        const connect = () => {
            wrapperEl = wrapper.value;
            if (!wrapperEl) return;
            applyAria();
            if (!observer && typeof MutationObserver !== "undefined") {
                observer = new MutationObserver(schedule);
                observer.observe(wrapperEl, { childList: true, subtree: true });
            }
        };

        onMounted(connect);
        onBeforeUnmount(() => {
            observer?.disconnect();
            observer = undefined;
        });
        watch(
            () => [props.label, props.hint, props.error, props.required, props.disabled, props.forId],
            schedule,
            { flush: "post" },
        );

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-form-field",
                    props.variant === "filter" ? "pg-form-field--filter" : "",
                    props.disabled ? "pg-field--disabled" : "",
                    attrs.class,
                ]}
            >
                {(props.label || slots.label || slots.labelAction) && (
                    <div class="pg-form-field__label-row pg-field__head">
                        <label class="pg-field__label" for={fieldId.value}>
                            {slots.label ? slots.label() : props.label}
                            {props.required && (
                                <span class="pg-field__required" aria-hidden="true">
                                    *
                                </span>
                            )}
                        </label>
                        {props.tooltip && (
                            <span class="pg-form-field__tooltip" title={props.tooltip}>
                                <PgIcon icon="mdi-help-circle-outline" size={15} />
                                <span class="pg-sr-only">{props.tooltip}</span>
                            </span>
                        )}
                        {props.sensitiveMakerChecker && (
                            <span class="pg-badge pg-badge--warning">{t("Four-Eyes Required")}</span>
                        )}
                        <span class="pg-form-field__label-action">{slots.labelAction ? slots.labelAction() : null}</span>
                    </div>
                )}
                <div
                    ref={(element: any) => {
                        wrapper.value = element;
                        if (element && !wrapperEl) connect();
                    }}
                    class="pg-form-field__control"
                >
                    {createSlot("default", {
                        id: fieldId.value,
                        describedBy: describedBy.value || undefined,
                        invalid: hasError.value,
                        required: Boolean(props.required),
                        disabled: Boolean(props.disabled),
                    })}
                </div>
                {hasError.value ? (
                    <div id={errorId.value} class="pg-field__error pg-form-field__error" role="alert" aria-live="assertive">
                        {slots.error ? slots.error() : errorText.value}
                    </div>
                ) : hasHint.value ? (
                    <div id={hintId.value} class="pg-field__hint pg-form-field__hint">
                        {slots.hint ? slots.hint() : hintText.value}
                    </div>
                ) : null}
            </div>
        );
    },
    {
        props: {
            label: { type: String, default: "" },
            forId: { type: String, default: "" },
            id: { type: String, default: "" },
            hint: { type: [String, Array], default: "" },
            error: { type: [String, Array], default: "" },
            required: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            tooltip: { type: String, default: "" },
            sensitiveMakerChecker: { type: Boolean, default: false },
            variant: { type: String, default: "default" },
        },
        inheritAttrs: true,
    },
);

export const FormField = PgFormField;
