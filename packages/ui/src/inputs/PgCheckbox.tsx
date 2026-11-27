import { computed, ref, watchEffect } from "vue";
import { dc } from "../lib/dc";
import { sameValue } from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
import { usePgFormControl } from "../lib/formRegistry";

/**
 * 2026 tactile squircle checkbox. Pure Vapor-native markup: a real (visually
 * hidden) `<input type="checkbox">` owns focus and form semantics, while the
 * 18px squircle below it owns the pixels. Clicking the box, the label or the
 * whole compliance card toggles exactly once — the visual state is derived from
 * `modelValue`, never from an internal wrapper.
 *
 * `variant="card"` renders the maker-checker / safeguard card row. Array
 * `modelValue` + `value` toggles membership with `sameValue()`.
 */
export const PgCheckbox = dc(
    (props: Record<string, any>, expose, { attrs, emit, slots }) => {
        const inputEl = ref<HTMLInputElement | null>(null);
        const localError = ref("");

        const card = computed(() => props.variant === "card" || props.card === true);
        const compact = computed(() => props.density === "compact" || props.size === "sm" || props.size === "small");
        const trueValue = computed(() => (props.trueValue !== undefined ? props.trueValue : (attrs["true-value"] ?? true)));
        const falseValue = computed(() => (props.falseValue !== undefined ? props.falseValue : (attrs["false-value"] ?? false)));

        const isOn = computed(() => {
            const model = props.modelValue;
            if (Array.isArray(model)) {
                if (props.value === undefined) return model.length > 0;
                return model.some((entry: any) => sameValue(entry, props.value));
            }
            return sameValue(model, trueValue.value);
        });

        const error = computed(() => {
            const explicit = typeof props.errorMessages === "string" && props.errorMessages ? props.errorMessages : props.error;
            return visibleError({ ...props, ...attrs, error: explicit }, localError.value);
        });

        const ruleError = (next: any = props.modelValue): string => {
            let message = props.rules || props.errorMessages
                ? runRules({ rules: props.rules, errorMessages: props.errorMessages }, next)
                : "";
            if (!message && props.required) {
                const on = Array.isArray(next) ? next.length > 0 : sameValue(next, trueValue.value);
                if (!on) message = "This field is required";
            }
            return message;
        };

        const validate = (next: any = props.modelValue) => {
            localError.value = ruleError(next);
        };

        const toggle = () => {
            if (props.disabled) return;
            let next: any;
            if (Array.isArray(props.modelValue)) {
                const list = [...props.modelValue];
                if (props.value === undefined) {
                    next = list.length > 0 ? [] : [true];
                } else {
                    const index = list.findIndex((entry: any) => sameValue(entry, props.value));
                    if (index >= 0) list.splice(index, 1);
                    else list.push(props.value);
                    next = list;
                }
            } else {
                next = isOn.value ? falseValue.value : trueValue.value;
            }
            emit?.("update:modelValue", next);
            emit?.("change", next);
            validate(next);
        };

        const { id } = usePgFormControl({
            id: props.id || undefined,
            validate: () => {
                const message = ruleError(props.modelValue);
                localError.value = message;
                return { valid: message.length === 0, message };
            },
            focus: () => inputEl.value?.focus(),
            resetValidation: () => {
                localError.value = "";
            },
            reset: () => {
                localError.value = "";
            },
        });

        watchEffect(() => {
            const element = inputEl.value;
            if (!element) return;
            element.checked = isOn.value;
            element.indeterminate = Boolean(props.indeterminate);
        });

        expose?.({
            focus: () => inputEl.value?.focus(),
            blur: () => inputEl.value?.blur(),
            resetValidation: () => {
                localError.value = "";
            },
        });

        const handleClick = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            // A link/button inside a description keeps its own behaviour.
            if (target?.closest?.("a,button,select,textarea")) return;
            // A direct click on the native input already flips the DOM checkbox.
            // Keep that immediate state (automation and assistive tech rely on
            // it) and only emit; clicks on the label/box still need one manual
            // toggle because the native forwarding is cancelled.
            if (target === inputEl.value) {
                const next = inputEl.value?.checked ?? !isOn.value;
                emit?.("update:modelValue", next);
                emit?.("change", next);
                validate(next);
                return;
            }
            event.preventDefault();
            toggle();
        };

        const control = () => (
            <label
                class={[
                    "pg-chk",
                    card.value ? "pg-chk--card pg-check-card" : "",
                    isOn.value ? "pg-chk--checked" : "",
                    isOn.value && card.value ? "pg-check-card--on" : "",
                    props.indeterminate ? "pg-chk--indeterminate" : "",
                    props.disabled ? "pg-chk--disabled" : "",
                    compact.value ? "pg-chk--sm" : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
                onClick={handleClick}
            >
                <input
                    ref={inputEl}
                    id={id}
                    class="pg-chk__native"
                    type="checkbox"
                    name={props.name || undefined}
                    value={Array.isArray(props.modelValue) && props.value !== undefined && typeof props.value !== "object" ? String(props.value) : undefined}
                    checked={isOn.value}
                    disabled={Boolean(props.disabled)}
                    required={Boolean(props.required)}
                    aria-checked={props.indeterminate ? "mixed" : isOn.value ? "true" : "false"}
                    aria-invalid={error.value ? "true" : "false"}
                    aria-label={attrs["aria-label"] || props.ariaLabel || undefined}
                    aria-describedby={attrs["aria-describedby"] || undefined}
                />
                <span class="pg-chk__box" aria-hidden="true">
                    {props.indeterminate ? (
                        <svg class="pg-chk__dash" viewBox="0 0 24 24" width={10} height={10} focusable="false">
                            <path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
                        </svg>
                    ) : isOn.value ? (
                        <svg class="pg-chk__check" viewBox="0 0 24 24" width={12} height={12} focusable="false">
                            <path
                                d="M20 6 9 17l-5-5"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2.4"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            />
                        </svg>
                    ) : null}
                </span>
                {(props.label || props.description || props.hint || slots.default) && (
                    <span class={["pg-chk__body", card.value ? "pg-check-card__body" : ""].filter(Boolean).join(" ")}>
                        {(props.label || slots.default) && (
                            <span class={["pg-chk__label", card.value ? "pg-check-card__title" : ""].filter(Boolean).join(" ")}>
                                {slots.default ? slots.default() : props.label}
                            </span>
                        )}
                        {(props.description || props.hint) && (
                            <span class={["pg-chk__description", card.value ? "pg-check-card__description" : ""].filter(Boolean).join(" ")}>
                                {props.description || props.hint}
                            </span>
                        )}
                    </span>
                )}
            </label>
        );

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-checkbox-field",
                    card.value ? "pg-checkbox-field--card" : "",
                    props.disabled ? "pg-checkbox-field--disabled" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                data-pg-checkbox={card.value ? "card" : "default"}
            >
                {control()}
                {error.value && !props.hideDetails ? (
                    <span class="pg-chk__error pg-field__error" role="alert">
                        {error.value}
                    </span>
                ) : null}
            </div>
        );
    },
    {
        props: {
            modelValue: { type: [Boolean, Array], default: false },
            label: { type: String, default: "" },
            description: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            value: { type: [String, Number, Object, Boolean], default: undefined },
            trueValue: { type: null as any, default: undefined },
            falseValue: { type: null as any, default: undefined },
            indeterminate: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            density: { type: String, default: "" },
            size: { type: String, default: "md" },
            hideDetails: { type: Boolean, default: false },
            variant: { type: String, default: "" },
            card: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            name: { type: String, default: "" },
            id: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["update:modelValue", "change"],
        inheritAttrs: true,
    },
);

export const VCheckbox = PgCheckbox;
