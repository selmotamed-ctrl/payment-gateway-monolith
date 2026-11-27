import { computed, onBeforeUnmount, onMounted, provide, inject, ref, watchEffect, useId, type ComputedRef, type InjectionKey } from "vue";
import { dc } from "../lib/dc";
import { normalizeOptions, sameValue, type PgOption } from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
import { usePgFormControl } from "../lib/formRegistry";
import { PgFieldShell } from "./PgFieldShell";
import { PgIcon } from "../actions/PgIcon";
import { PgSpinner } from "../actions/PgFeedbackAtoms";

/* -------------------------------------------------------------------------- */
/* Switch                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Tactile boolean toggle. Pure native markup: a hidden
 * `<input type="checkbox" role="switch">` owns focus/ARIA, the 38×22 track and
 * thumb own the pixels. Clicking the label or the track toggles once and never
 * bubbles into a table row. `loading` shows a spinner in the thumb and blocks
 * every activation.
 */
export const PgSwitch = dc(
    (props: Record<string, any>, expose, { attrs, emit, slots }) => {
        const inputEl = ref<HTMLInputElement | null>(null);
        const localError = ref("");
        const isOn = computed(() => Boolean(props.modelValue));
        const compact = computed(() => props.size === "sm" || props.density === "compact" || props.size === "small");
        const busy = computed(() => Boolean(props.disabled) || Boolean(props.loading));
        const labelAtStart = computed(() => props.labelPosition === "start");
        const tone = computed(() => {
            const raw = String(props.tone || props.color || attrs.color || "brand");
            if (raw === "error" || raw === "danger") return "danger";
            if (raw === "success" || raw === "warning" || raw === "brand") return raw;
            return "brand";
        });
        const error = computed(() => {
            const explicit = typeof props.errorMessages === "string" && props.errorMessages ? props.errorMessages : props.error;
            return visibleError({ ...props, ...attrs, error: explicit }, localError.value);
        });

        const validate = (next: any = props.modelValue) => {
            localError.value = props.rules || props.errorMessages
                ? runRules({ rules: props.rules, errorMessages: props.errorMessages }, next)
                : "";
        };

        const { id } = usePgFormControl({
            id: props.id || undefined,
            validate: () => {
                let message = props.rules || props.errorMessages
                    ? runRules({ rules: props.rules, errorMessages: props.errorMessages }, props.modelValue)
                    : "";
                if (!message && props.required && (props.modelValue === undefined || props.modelValue === null || props.modelValue === "")) {
                    message = "This field is required";
                }
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
            if (inputEl.value) inputEl.value.checked = isOn.value;
        });

        expose?.({
            focus: () => inputEl.value?.focus(),
            resetValidation: () => {
                localError.value = "";
            },
        });

        const handleClick = (event: MouseEvent) => {
            // A switch is an in-row control: never let the click open the row.
            event.stopPropagation();
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("a,button")) return;
            // Cancel the native label forwarding so exactly one emit happens.
            event.preventDefault();
            if (busy.value) return;
            const next = !isOn.value;
            emit?.("update:modelValue", next);
            emit?.("change", next);
            validate(next);
        };

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-switch-field",
                    props.disabled ? "pg-switch-field--disabled" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                data-pg-switch
            >
                <label
                    class={[
                        "pg-switch",
                        `pg-switch--${tone.value}`,
                        compact.value ? "pg-switch--sm" : "",
                        props.disabled ? "pg-switch--disabled" : "",
                        props.loading ? "pg-switch--loading" : "",
                        labelAtStart.value ? "pg-switch--label-start" : "",
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    onClick={handleClick}
                >
                    <input
                        ref={inputEl}
                        id={id}
                        class="pg-switch__native"
                        type="checkbox"
                        role="switch"
                        name={props.name || undefined}
                        checked={isOn.value}
                        disabled={busy.value}
                        aria-checked={isOn.value ? "true" : "false"}
                        aria-busy={props.loading ? "true" : undefined}
                        aria-describedby={attrs["aria-describedby"] || undefined}
                        aria-label={!props.label && !slots.label ? attrs["aria-label"] || props.ariaLabel || undefined : undefined}
                    />
                    <span class={["pg-switch__track", isOn.value ? "pg-switch__track--on" : ""].filter(Boolean).join(" ")}>
                        <span class={["pg-switch__thumb", props.loading ? "pg-switch__thumb--loading" : ""].filter(Boolean).join(" ")}>
                            {props.loading ? <PgSpinner size={compact.value ? 9 : 12} /> : null}
                        </span>
                    </span>
                    {(props.label || props.description || slots.label) && (
                        <span class="pg-switch__text">
                            {(props.label || slots.label) && (
                                <span class="pg-switch__label">{slots.label ? slots.label() : props.label}</span>
                            )}
                            {props.description && <span class="pg-switch__description">{props.description}</span>}
                        </span>
                    )}
                </label>
                {error.value && !props.hideDetails ? (
                    <span class="pg-switch__error pg-field__error" role="alert">
                        {error.value}
                    </span>
                ) : null}
            </div>
        );
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            label: { type: String, default: "" },
            description: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            tone: { type: String, default: "" },
            color: { type: String, default: "" },
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            loading: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            labelPosition: { type: String, default: "end" },
            hideDetails: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            name: { type: String, default: "" },
            id: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["update:modelValue", "change"],
        inheritAttrs: true,
    },
);

/* -------------------------------------------------------------------------- */
/* Radio group                                                                */
/* -------------------------------------------------------------------------- */

type RadioGroupItem = {
    value: () => any;
    disabled: () => boolean;
    focus: () => void;
};

type RadioGroupContext = {
    value: ComputedRef<any>;
    disabled: ComputedRef<boolean>;
    name: ComputedRef<string>;
    select: (next: any) => void;
    register: (item: RadioGroupItem) => void;
    unregister: (item: RadioGroupItem) => void;
    move: (from: any, direction: 1 | -1) => void;
};

const RADIO_GROUP_KEY: InjectionKey<RadioGroupContext> = Symbol("pg-radio-group");

/**
 * Mutually exclusive option selector. Renders a real `role="radiogroup"` and
 * native radio inputs, with ArrowUp/ArrowDown (and ArrowLeft/ArrowRight) moving
 * focus and selection across the enabled radios in registration order.
 */
export const PgRadioGroup = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const localError = ref("");
        const items: RadioGroupItem[] = [];
        const generatedName = useId();
        const name = computed(() => props.name || generatedName);
        const groupValue = computed(() => props.modelValue);
        const groupDisabled = computed(() => Boolean(props.disabled));
        const error = computed(() => {
            const explicit = typeof props.errorMessages === "string" && props.errorMessages ? props.errorMessages : props.error;
            return visibleError({ ...props, ...attrs, error: explicit }, localError.value);
        });
        const options = computed<PgOption[]>(() => normalizeOptions(props.options ?? props.items ?? []));

        const validate = (next: any = props.modelValue) => {
            localError.value = props.rules || props.errorMessages
                ? runRules({ rules: props.rules, errorMessages: props.errorMessages }, next)
                : "";
        };

        const select = (next: any) => {
            if (groupDisabled.value) return;
            emit?.("update:modelValue", next);
            emit?.("change", next);
            validate(next);
        };

        const register = (item: RadioGroupItem) => {
            if (!items.includes(item)) items.push(item);
        };
        const unregister = (item: RadioGroupItem) => {
            const index = items.indexOf(item);
            if (index >= 0) items.splice(index, 1);
        };
        const move = (from: any, direction: 1 | -1) => {
            const enabled = items.filter((item) => !item.disabled());
            if (!enabled.length) return;
            const current = enabled.findIndex((item) => sameValue(item.value(), from));
            const start = current >= 0 ? current : direction > 0 ? -1 : 0;
            const next = enabled[(start + direction + enabled.length) % enabled.length];
            if (!next) return;
            select(next.value());
            next.focus();
        };

        provide(RADIO_GROUP_KEY, {
            value: groupValue,
            disabled: groupDisabled,
            name,
            select,
            register,
            unregister,
            move,
        });

        const { id } = usePgFormControl({
            id: props.id || undefined,
            validate: () => {
                let message = props.rules || props.errorMessages
                    ? runRules({ rules: props.rules, errorMessages: props.errorMessages }, props.modelValue)
                    : "";
                if (!message && props.required && (props.modelValue === undefined || props.modelValue === null || props.modelValue === "")) {
                    message = "This field is required";
                }
                localError.value = message;
                return { valid: message.length === 0, message };
            },
            focus: () => {
                const first = items.find((item) => !item.disabled());
                first?.focus();
            },
            resetValidation: () => {
                localError.value = "";
            },
            reset: () => {
                localError.value = "";
            },
        });

        return () => (
            <div
                {...attrs}
                class={["pg-radio-field", attrs.class].filter(Boolean).join(" ")}
                data-pg-radio-group={id}
            >
                <PgFieldShell
                    forId=""
                    label={props.label}
                    hint={props.hint}
                    error={error.value}
                    required={Boolean(props.required)}
                    disabled={Boolean(props.disabled)}
                    hideDetails={Boolean(props.hideDetails)}
                >
                    <div
                        class={["pg-radio-group", props.inline ? "pg-radio-group--inline" : ""].filter(Boolean).join(" ")}
                        role="radiogroup"
                        aria-label={props.ariaLabel || props.label || undefined}
                        aria-describedby={attrs["aria-describedby"] || undefined}
                        aria-invalid={error.value ? "true" : "false"}
                        aria-required={props.required ? "true" : undefined}
                    >
                        {options.value.map((option, index) => (
                            <PgRadio
                                key={index}
                                value={option.value}
                                label={option.label}
                                description={option.description}
                                icon={option.icon}
                                disabled={option.disabled || Boolean(props.disabled)}
                            />
                        ))}
                        {slots.default?.()}
                    </div>
                </PgFieldShell>
            </div>
        );
    },
    {
        props: {
            modelValue: { type: null as any, default: undefined },
            label: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            inline: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            options: { type: Array as () => any[], default: () => [] },
            items: { type: Array as () => any[], default: () => [] },
            name: { type: String, default: "" },
            id: { type: String, default: "" },
            hideDetails: { type: Boolean, default: false },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["update:modelValue", "change"],
        inheritAttrs: true,
    },
);

/**
 * One native radio row. Inside a `PgRadioGroup` the group owns the value; on its
 * own it still behaves as a controlled/uncontrolled radio and emits its value.
 */
export const PgRadio = dc(
    (props: Record<string, any>, expose, { attrs, emit }) => {
        const inputEl = ref<HTMLInputElement | null>(null);
        const group = inject<RadioGroupContext | null>(RADIO_GROUP_KEY, null);
        const standalone = ref<any>(props.modelValue ?? props.checked ?? null);
        const fallbackName = useId();
        const name = computed(() => group?.name.value || props.name || fallbackName);
        const disabled = computed(() => Boolean(props.disabled) || Boolean(group?.disabled.value));
        const isChecked = computed(() => {
            if (group) return sameValue(group.value.value, props.value);
            if (props.checked !== undefined) return Boolean(props.checked);
            return sameValue(standalone.value, props.value);
        });

        const select = () => {
            if (disabled.value) return;
            if (group) {
                group.select(props.value);
                return;
            }
            standalone.value = props.value;
            emit?.("update:modelValue", props.value);
            emit?.("change", props.value);
        };

        const item: RadioGroupItem = {
            value: () => props.value,
            disabled: () => disabled.value,
            focus: () => inputEl.value?.focus(),
        };

        onMounted(() => group?.register(item));
        onBeforeUnmount(() => group?.unregister(item));

        expose?.({
            focus: () => inputEl.value?.focus(),
            blur: () => inputEl.value?.blur(),
        });

        const handleClick = (event: MouseEvent) => {
            event.preventDefault();
            select();
        };

        const handleKeydown = (event: KeyboardEvent) => {
            if (!group) return;
            if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                event.preventDefault();
                group.move(props.value, 1);
            } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                event.preventDefault();
                group.move(props.value, -1);
            } else if (event.key === "Enter") {
                event.preventDefault();
                select();
            }
        };

        return () => (
            <label
                {...attrs}
                class={[
                    "pg-radio",
                    isChecked.value ? "pg-radio--checked" : "",
                    disabled.value ? "pg-radio--disabled" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                data-pg-radio={typeof props.value === "object" ? undefined : String(props.value)}
                onClick={handleClick}
            >
                <input
                    ref={inputEl}
                    class="pg-radio__native"
                    type="radio"
                    name={name.value}
                    value={typeof props.value === "object" ? undefined : String(props.value)}
                    checked={isChecked.value}
                    disabled={disabled.value}
                    aria-checked={isChecked.value ? "true" : "false"}
                    aria-describedby={props.ariaDescribedBy || undefined}
                    aria-label={!props.label ? attrs["aria-label"] || undefined : undefined}
                    onChange={() => select()}
                    onKeydown={handleKeydown}
                />
                <span class="pg-radio__circle" aria-hidden="true">
                    {isChecked.value ? <span class="pg-radio__dot" /> : null}
                </span>
                {(props.label || props.description || props.icon) && (
                    <span class="pg-radio__body">
                        {props.icon && <PgIcon icon={props.icon} size={16} />}
                        {props.label && <span class="pg-radio__label">{props.label}</span>}
                        {props.description && <span class="pg-radio__description">{props.description}</span>}
                    </span>
                )}
            </label>
        );
    },
    {
        props: {
            value: { type: null as any, default: undefined },
            label: { type: String, default: "" },
            description: { type: String, default: "" },
            icon: { type: String, default: "" },
            disabled: { type: Boolean, default: false },
            checked: { type: Boolean, default: undefined },
            modelValue: { type: null as any, default: undefined },
            name: { type: String, default: "" },
            ariaDescribedBy: { type: String, default: "" },
        },
        emits: ["update:modelValue", "change"],
        inheritAttrs: true,
    },
);

export const VSwitch = PgSwitch;
export const VRadioGroup = PgRadioGroup;
export const VRadio = PgRadio;
