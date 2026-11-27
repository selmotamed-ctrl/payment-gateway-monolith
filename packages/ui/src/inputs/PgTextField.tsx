import { computed, ref, useId } from "vue";
import { dc } from "../lib/dc";
import { controlSize, pick, normalizeSize } from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
import { PgFieldShell } from "./PgFieldShell";
import { PgIcon } from "../actions/PgIcon";

const INPUT_ATTRS = [
    "id",
    "name",
    "type",
    "placeholder",
    "disabled",
    "readonly",
    "autocomplete",
    "inputmode",
    "maxlength",
    "minlength",
    "min",
    "max",
    "step",
    "pattern",
    "autofocus",
    "dir",
    "title",
    "tabindex",
    "onClick",
    "onChange",
    "onPaste",
    "onKeypress",
    "onKeyPress",
    "onKeydown",
    "onKeyup",
    "onBlur",
    "onFocus",
    "autocapitalize",
    "enterkeyhint",
    "spellcheck",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
    "aria-required",
    "aria-activedescendant",
    "aria-controls",
    "aria-expanded",
    "aria-autocomplete",
    "role",
];

/**
 * The 2026 fintech text field: 40px control, hairline border, neutral obsidian
 * focus ring (never a blue glow), full label/hint/error/icon/affix/clear
 * parity with the old `VTextField`.
 */
export const PgTextField = dc(
    (
        props: Record<string, any>,
        _expose,
        { attrs, emit, expose },
    ) => {
        const inputId = props.id || `pg-tf-${useId()}`;
        const localError = ref("");
        const focused = ref(false);
        const revealPassword = ref(false);
        const value = computed(() => (props.modelValue == null ? "" : String(props.modelValue)));
        const error = computed(() => visibleError({ ...props, ...attrs }, localError.value));
        const size = computed(() => normalizeSize(props.size) ?? controlSize({ ...props, size: props.size ?? attrs.size, density: props.density ?? attrs.density }));
        const effectiveType = computed(() =>
            props.type === "password" && revealPassword.value ? "text" : (props.type ?? "text"),
        );
        const leading = computed(() => props.prependInnerIcon || props.leadingIcon || attrs["prepend-inner-icon"] || "");
        const trailing = computed(() => props.appendInnerIcon || props.trailingIcon || attrs["append-inner-icon"] || "");
        const maxLength = computed(() => Number(props.maxlength ?? attrs.maxlength ?? 0));

        const validate = (next: any = props.modelValue) => {
            localError.value = props.rules || props.errorMessages ? runRules({ ...props, ...attrs }, next) : "";
        };

        const clear = () => {
            emit?.("update:modelValue", "");
            emit?.("clear");
            validate("");
        };

        const nativeInput = () => document.getElementById(inputId) as HTMLInputElement | null;
        expose?.({
            focus: () => nativeInput()?.focus(),
            blur: () => nativeInput()?.blur(),
            select: () => {
                nativeInput()?.focus();
                nativeInput()?.select();
            },
            reset: () => validate(""),
        });

        return () => {
            const inputAttrs = pick({ ...props, ...attrs }, INPUT_ATTRS);
            const control = (
                <div
                    class={[
                        "pg-control-box",
                        `pg-control-box--${size.value}`,
                        focused.value ? "pg-control-box--focused" : "",
                        error.value ? "pg-control-box--error" : "",
                        props.disabled ? "pg-control-box--disabled" : "",
                    ]}
                >
                    {leading.value && (
                        <span
                            class="pg-control-adornment pg-control-adornment--start"
                            onClick={props["onClick:prependInner"] ?? props["onClick:prepend"]}
                            role={props["onClick:prependInner"] || props["onClick:prepend"] ? "button" : undefined}
                        >
                            <PgIcon icon={leading.value} size={17} />
                        </span>
                    )}
                    {props.prefix && <span class="pg-control-affix">{props.prefix}</span>}
                    <input
                        {...inputAttrs}
                        id={inputId}
                        class={["pg-control-native", props.monospace ? "pg-mono" : ""]}
                        type={effectiveType.value}
                        value={value.value}
                        placeholder={props.placeholder}
                        disabled={props.disabled}
                        readonly={props.readonly}
                        autocomplete={props.autocomplete ?? "off"}
                        aria-invalid={error.value ? "true" : "false"}
                        aria-required={props.required ? "true" : undefined}
                        onFocus={(event: FocusEvent) => {
                            focused.value = true;
                            props.onFocus?.(event);
                            (attrs.onFocus as ((event: FocusEvent) => void) | undefined)?.(event);
                            emit?.("focus");
                        }}
                        onBlur={(event: FocusEvent) => {
                            focused.value = false;
                            props.onBlur?.(event);
                            (attrs.onBlur as ((event: FocusEvent) => void) | undefined)?.(event);
                            emit?.("blur");
                            validate();
                        }}
                        onInput={(event: Event) => {
                            const next = (event.target as HTMLInputElement).value;
                            emit?.("update:modelValue", next);
                            (attrs.onInput as ((event: Event) => void) | undefined)?.(event);
                            if (props.validateOn === "input") validate(next);
                        }}
                        onKeydown={(event: KeyboardEvent) => {
                            if (event.key === "Enter") emit?.("enter");
                            (attrs.onKeydown as ((event: KeyboardEvent) => void) | undefined)?.(event);
                        }}
                    />
                    {maxLength.value > 0 && props.counter && (
                        <span class="pg-field__counter pg-tabular">
                            {value.value.length}/{maxLength.value}
                        </span>
                    )}
                    {props.suffix && <span class="pg-control-affix">{props.suffix}</span>}
                    {props.clearable && value.value.length > 0 && !props.disabled && !props.readonly && (
                        <button
                            type="button"
                            class="pg-control-clear-btn"
                            aria-label="Clear input"
                            onMousedown={(event: MouseEvent) => event.preventDefault()}
                            onClick={clear}
                        >
                            <PgIcon icon="mdi-close-circle" size={16} />
                        </button>
                    )}
                    {props.type === "password" && (
                        <button
                            type="button"
                            class="pg-control-clear-btn"
                            aria-label={revealPassword.value ? "Hide password" : "Show password"}
                            onMousedown={(event: MouseEvent) => event.preventDefault()}
                            onClick={() => (revealPassword.value = !revealPassword.value)}
                        >
                            <PgIcon icon={revealPassword.value ? "mdi-eye-off-outline" : "mdi-eye-outline"} size={17} />
                        </button>
                    )}
                    {props.kbdHint && !focused.value && !value.value && (
                        <kbd class="pg-kbd-badge">{props.kbdHint}</kbd>
                    )}
                    {trailing.value && (
                        <span
                            class="pg-control-adornment pg-control-adornment--end"
                            onClick={props["onClick:appendInner"] ?? props["onClick:append"]}
                            role={props["onClick:appendInner"] || props["onClick:append"] ? "button" : undefined}
                        >
                            <PgIcon icon={trailing.value} size={17} />
                        </span>
                    )}
                </div>
            );

            return (
                <PgFieldShell
                    forId={inputId}
                    label={props.label}
                    hint={props.hint}
                    error={error.value}
                    required={props.required}
                    disabled={props.disabled}
                    hideDetails={props.hideDetails}
                    counter={props.counter && maxLength.value > 0 ? `${value.value.length}/${maxLength.value}` : ""}
                >
                    {control}
                </PgFieldShell>
            );
        };
    },
    {
        props: {
            modelValue: { type: [String, Number], default: "" },
            label: { type: String, default: "" },
            placeholder: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            type: { type: String, default: "text" },
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            leadingIcon: { type: String, default: "" },
            trailingIcon: { type: String, default: "" },
            prependInnerIcon: { type: String, default: "" },
            appendInnerIcon: { type: String, default: "" },
            prefix: { type: String, default: "" },
            suffix: { type: String, default: "" },
            kbdHint: { type: String, default: "" },
            clearable: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            monospace: { type: Boolean, default: false },
            autocomplete: { type: String, default: "off" },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            validateOn: { type: String, default: "blur" },
            hideDetails: { type: Boolean, default: false },
            counter: { type: [Boolean, Number], default: false },
            maxlength: { type: [String, Number], default: undefined },
            id: { type: String, default: "" },
        },
        emits: ["update:modelValue", "clear", "enter", "blur", "focus"],
        inheritAttrs: true,
    },
);

export const VTextField = PgTextField;
