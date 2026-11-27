import { computed, createSlot, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";

const CONTROL_SELECTOR = "input, textarea, select, [contenteditable='true'], [role='combobox']";

const errorTextOf = (error: unknown): string => {
    if (Array.isArray(error)) return error.filter((entry) => typeof entry === "string" && entry.length > 0).join(" ");
    return typeof error === "string" ? error : "";
};

/**
 * The universal field wrapper: label + required mark + hint OR live error,
 * right-aligned counter and a disabled state. Every `@pg/ui` input renders its
 * control inside this shell so form anatomy never drifts.
 *
 * The shell also mirrors `aria-describedby`, `aria-invalid` and `aria-required`
 * onto the first slotted control (harmless when the input already sets them),
 * which keeps custom controls that ignore slot props accessible too.
 */
export const PgFieldShell = dc(
    (
        props: {
            forId?: string;
            label?: string;
            hint?: string;
            error?: string | string[];
            required?: boolean;
            disabled?: boolean;
            hideDetails?: boolean;
            counter?: string | number;
        },
        _expose,
        { slots },
    ) => {
        const autoId = useId();
        const baseId = props.forId || `pg-field-${autoId}`;
        const labelTarget = ref(props.forId || "");
        const hintId = `${baseId}-hint`;
        const errorId = `${baseId}-error`;
        const root = ref<HTMLElement | null>(null);
        let rootEl: HTMLElement | null = null;
        let observer: MutationObserver | null = null;
        let scheduled = false;

        const errorText = computed(() => errorTextOf(props.error));
        const hintText = computed(() => (typeof props.hint === "string" ? props.hint : ""));
        const counterText = computed(() =>
            props.counter === undefined || props.counter === null ? "" : String(props.counter),
        );
        const showHint = computed(() => !props.hideDetails && !errorText.value && Boolean(hintText.value));
        const showCounter = computed(() => !props.hideDetails && Boolean(counterText.value));
        const describedBy = computed(() => {
            if (errorText.value) return errorId;
            if (showHint.value) return hintId;
            return "";
        });

        const applyAria = () => {
            const rootNode = rootEl;
            if (!rootNode) return;
            const control = rootNode.querySelector<HTMLElement>(CONTROL_SELECTOR);
            if (!control) return;
            if (!control.id && props.forId) control.id = props.forId;
            if (!props.forId && control.id && labelTarget.value !== control.id) labelTarget.value = control.id;
            const existing = (control.getAttribute("aria-describedby") || "")
                .split(/\s+/)
                .filter(Boolean);
            const ids = new Set(existing);
            if (describedBy.value) ids.add(describedBy.value);
            const merged = [...ids].join(" ");
            if (merged) control.setAttribute("aria-describedby", merged);
            else control.removeAttribute("aria-describedby");
            if (props.required) control.setAttribute("aria-required", "true");
            else control.removeAttribute("aria-required");
            if (errorText.value) control.setAttribute("aria-invalid", "true");
            else control.removeAttribute("aria-invalid");
        };

        const scheduleAria = () => {
            if (scheduled) return;
            scheduled = true;
            // A microtask is enough: slot children are mounted by then.
            void Promise.resolve().then(() => {
                scheduled = false;
                applyAria();
            });
        };

        const connect = () => {
            rootEl = root.value;
            if (!rootEl) return;
            applyAria();
            if (!observer && typeof MutationObserver !== "undefined") {
                observer = new MutationObserver(scheduleAria);
                observer.observe(rootEl, { childList: true, subtree: true });
            }
        };

        onMounted(connect);
        onBeforeUnmount(() => {
            observer?.disconnect();
            observer = null;
        });
        watch(
            () => [props.label, props.hint, props.error, props.required, props.forId, props.hideDetails],
            scheduleAria,
            { flush: "post" },
        );

        return () => (
            <div
                ref={(element: any) => {
                    root.value = element;
                    if (element && !rootEl) connect();
                }}
                class={["pg-field", props.disabled ? "pg-field--disabled" : ""]}
            >
                {(props.label || slots.labelAction) && (
                    <div class="pg-field__head">
                        {props.label && (
                            <label class="pg-field__label" for={labelTarget.value || undefined}>
                                <span>{props.label}</span>
                                {props.required && (
                                    <span class="pg-field__required" aria-hidden="true">
                                        *
                                    </span>
                                )}
                            </label>
                        )}
                        {slots.labelAction ? slots.labelAction() : null}
                    </div>
                )}
                {createSlot("default")}
                {errorText.value ? (
                    <div class="pg-field__footer">
                        <span id={errorId} class="pg-field__error" role="alert" aria-live="assertive">
                            {errorText.value}
                        </span>
                        {showCounter.value ? (
                            <span class="pg-field__counter pg-tabular">{counterText.value}</span>
                        ) : null}
                    </div>
                ) : showHint.value ? (
                    <div class="pg-field__footer">
                        <span id={hintId} class="pg-field__hint">
                            {hintText.value}
                        </span>
                        {showCounter.value ? (
                            <span class="pg-field__counter pg-tabular">{counterText.value}</span>
                        ) : null}
                    </div>
                ) : showCounter.value ? (
                    <div class="pg-field__footer">
                        <span class="pg-field__counter pg-tabular">{counterText.value}</span>
                    </div>
                ) : null}
                {slots.append ? slots.append() : null}
            </div>
        );
    },
    {
        props: {
            forId: { type: String, default: "" },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: [String, Array], default: "" },
            required: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            hideDetails: { type: Boolean, default: false },
            counter: { type: [String, Number], default: "" },
        },
        inheritAttrs: true,
    },
);
