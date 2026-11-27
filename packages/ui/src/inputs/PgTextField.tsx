import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { controlSize, normalizeSize, pick } from "../lib/options";
import { runRules } from "../lib/rules";
import { usePgFormControl } from "../lib/formRegistry";
import { useLocale } from "../lib/locale";
import { PgFieldShell } from "./PgFieldShell";
import { PgDateInput } from "./PgDateInput";
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

const TYPE_WHITELIST = ["text", "password", "email", "search", "url", "tel", "number"];

const errorMessagesOf = (messages: unknown): string => {
    if (Array.isArray(messages)) return messages.find((entry) => typeof entry === "string" && entry) ?? "";
    return typeof messages === "string" ? messages : "";
};

/**
 * The 2026 fintech text field. The outer `.pg-control-box` owns the border and
 * the neutral obsidian focus ring; the native `<input>` is a transparent,
 * borderless child, so focusing it never paints a second browser outline.
 */
export const PgTextField = dc(
    (
        props: Record<string, any>,
        _expose,
        { attrs, emit, expose, slots },
    ) => {
        const { t } = useLocale();
        const autoId = useId();
        const inputId = props.id || `pg-tf-${autoId}`;
        const localError = ref("");
        const touched = ref(false);
        const focused = ref(false);
        const revealPassword = ref(false);
        let inputEl: HTMLInputElement | null = null;

        const value = computed(() => (props.modelValue === null || props.modelValue === undefined ? "" : String(props.modelValue)));
        const currentValue = ref(value.value);
        watch(value, (next) => {
            if (next !== currentValue.value) currentValue.value = next;
        });

        const type = computed(() => {
            const requested = String(props.type || "text").toLowerCase();
            return TYPE_WHITELIST.includes(requested) ? requested : "text";
        });
        const effectiveType = computed(() =>
            type.value === "password" && revealPassword.value ? "text" : type.value,
        );
        const size = computed(() => {
            if ((props.density ?? attrs.density) === "compact") return "sm";
            return (
                normalizeSize(props.size) ??
                controlSize({ ...props, size: props.size ?? attrs.size, density: props.density ?? attrs.density })
            );
        });

        const leadingIcon = computed(
            () =>
                props.leadingIcon ||
                props.prependInnerIcon ||
                props.prependIcon ||
                attrs["prepend-inner-icon"] ||
                attrs.prependIcon ||
                "",
        );
        const trailingIcon = computed(
            () =>
                props.trailingIcon ||
                props.appendInnerIcon ||
                props.appendIcon ||
                attrs["append-inner-icon"] ||
                attrs.appendIcon ||
                "",
        );

        const maxLength = computed(() => {
            const raw = props.maxlength ?? (typeof props.counter === "number" ? props.counter : 0);
            const parsed = Number(raw);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        });

        const explicitError = computed(() => {
            if (typeof props.error === "string" && props.error) return props.error;
            return errorMessagesOf(props.errorMessages);
        });
        const displayError = computed(() => explicitError.value || (touched.value ? localError.value : ""));

        const hintId = computed(() => `${inputId}-hint`);
        const errorId = computed(() => `${inputId}-error`);
        const describedBy = computed(() => {
            const ids: string[] = [];
            const external = String(attrs["aria-describedby"] || "")
                .split(/\s+/)
                .filter(Boolean);
            ids.push(...external);
            if (displayError.value) ids.push(errorId.value);
            else if (!props.hideDetails && props.hint) ids.push(hintId.value);
            return ids.length ? [...new Set(ids)].join(" ") : undefined;
        });

        const counterText = computed(() => {
            if (props.hideDetails) return "";
            if (maxLength.value > 0) return `${currentValue.value.length}/${maxLength.value}`;
            if (props.counter === true) return String(currentValue.value.length);
            return "";
        });

        const nativeInput = (): HTMLInputElement | null =>
            inputEl ?? (document.getElementById(inputId) as HTMLInputElement | null);

        const focus = () => nativeInput()?.focus();
        const blur = () => nativeInput()?.blur();
        const resetValidation = () => {
            localError.value = "";
            touched.value = false;
        };

        const validate = (next: any = currentValue.value) => {
            const ruleMessage = runRules(
                { rules: Array.isArray(props.rules) ? props.rules : [], errorMessages: props.errorMessages },
                next,
            );
            localError.value = ruleMessage;
            touched.value = true;
            const message = explicitError.value || ruleMessage;
            return { valid: !message, message: message || "Invalid value" };
        };

        const doClear = () => {
            currentValue.value = "";
            localError.value = "";
            touched.value = false;
            if (inputEl) inputEl.value = "";
            emit?.("update:modelValue", "");
            emit?.("clear");
        };

        usePgFormControl({
            id: inputId,
            validate,
            focus,
            resetValidation,
            reset: doClear,
        });

        expose?.({
            focus,
            blur,
            clear: doClear,
            validate,
            resetValidation,
            select: () => {
                const element = nativeInput();
                element?.focus();
                element?.select();
            },
        });

        onBeforeUnmount(() => {
            inputEl = null;
        });

        const interactiveTarget = (target: EventTarget | null) =>
            target instanceof Element && Boolean(target.closest("button, a, input, textarea, select, [role='button']"));

        return () => {
            if (type.value === "date") {
                return (
                    <PgDateInput
                        modelValue={props.modelValue}
                        onUpdate:modelValue={(value: any) => {
                            emit?.("update:modelValue", value);
                            emit?.("change", value);
                        }}
                        label={props.label}
                        hint={props.hint}
                        error={props.error}
                        errorMessages={props.errorMessages}
                        placeholder={props.placeholder}
                        min={props.min}
                        max={props.max}
                        clearable={props.clearable}
                        disabled={props.disabled}
                        readonly={props.readonly}
                        required={props.required}
                        density={props.density}
                        size={props.size}
                        hideDetails={props.hideDetails}
                        id={props.id || inputId}
                        class={attrs.class}
                        style={attrs.style}
                    />
                );
            }
            const shellAttrs: Record<string, any> = { class: attrs.class, style: attrs.style };
            for (const key of Object.keys(attrs)) {
                if (
                    key.startsWith("data-") ||
                    key === "onFocusout" ||
                    key === "onFocusin" ||
                    key === "onFocusOut" ||
                    key === "onFocusIn"
                ) {
                    shellAttrs[key] = attrs[key];
                }
            }
            const inputAttrs = pick({ ...props, ...attrs }, INPUT_ATTRS);
            delete inputAttrs.type;
            delete inputAttrs.id;
            delete inputAttrs.onKeydown;
            delete inputAttrs.onFocus;
            delete inputAttrs.onBlur;
            delete inputAttrs.onInput;

            const numeric = type.value === "number";
            const control = (
                <div
                    class={[
                        "pg-control-box",
                        `pg-control-box--${size.value}`,
                        focused.value ? "pg-control-box--focused" : "",
                        displayError.value ? "pg-control-box--error" : "",
                        props.disabled ? "pg-control-box--disabled" : "",
                        numeric || props.monospace ? "pg-control-box--numeric" : "",
                    ]}
                    onMousedown={(event: MouseEvent) => {
                        if (event.button !== 0 || interactiveTarget(event.target)) return;
                        event.preventDefault();
                        focus();
                    }}
                >
                    {slots["prepend-inner"] ? slots["prepend-inner"]() : null}
                    {leadingIcon.value && (
                        <span
                            class="pg-control-adornment pg-control-adornment--start"
                            onClick={
                                props["onClick:prependInner"] ??
                                props["onClick:prepend"] ??
                                attrs["onClick:prependInner"] ??
                                attrs["onClick:prepend"]
                            }
                            role={
                                props["onClick:prependInner"] ||
                                props["onClick:prepend"] ||
                                attrs["onClick:prependInner"] ||
                                attrs["onClick:prepend"]
                                    ? "button"
                                    : undefined
                            }
                        >
                            <PgIcon icon={leadingIcon.value} size={17} />
                        </span>
                    )}
                    {props.prefix && <span class="pg-control-affix">{props.prefix}</span>}
                    <input
                        {...inputAttrs}
                        ref={(element: any) => {
                            inputEl = element as HTMLInputElement | null;
                        }}
                        id={inputId}
                        class={[
                            "pg-control-native",
                            props.monospace || numeric ? "pg-mono pg-tabular" : "",
                        ]}
                        type={effectiveType.value}
                        value={currentValue.value}
                        placeholder={props.placeholder}
                        disabled={props.disabled}
                        readonly={props.readonly}
                        autofocus={props.autofocus ? true : undefined}
                        maxlength={maxLength.value || undefined}
                        autocomplete={props.autocomplete ?? "off"}
                        aria-describedby={describedBy.value}
                        aria-invalid={displayError.value ? "true" : "false"}
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
                            currentValue.value = next;
                            emit?.("update:modelValue", next);
                            (attrs.onInput as ((event: Event) => void) | undefined)?.(event);
                            if (props.validateOn === "input") validate(next);
                        }}
                        onKeydown={(event: KeyboardEvent) => {
                            if (event.key === "Enter") emit?.("enter", currentValue.value);
                            (attrs.onKeydown as ((event: KeyboardEvent) => void) | undefined)?.(event);
                        }}
                    />
                    {props.suffix && <span class="pg-control-affix">{props.suffix}</span>}
                    {props.clearable && currentValue.value.length > 0 && !props.disabled && !props.readonly && (
                        <button
                            type="button"
                            class="pg-control-clear-btn pg-control-action-btn"
                            aria-label={t("Clear input")}
                            onMousedown={(event: MouseEvent) => event.preventDefault()}
                            onClick={(event: MouseEvent) => {
                                event.stopPropagation();
                                doClear();
                            }}
                        >
                            <PgIcon icon="mdi-close-circle" size={16} />
                        </button>
                    )}
                    {type.value === "password" && !props.disabled && !props.readonly && (
                        <button
                            type="button"
                            class="pg-control-clear-btn pg-control-action-btn"
                            aria-label={revealPassword.value ? t("Hide password") : t("Show password")}
                            aria-pressed={revealPassword.value ? "true" : "false"}
                            onMousedown={(event: MouseEvent) => event.preventDefault()}
                            onClick={(event: MouseEvent) => {
                                event.stopPropagation();
                                revealPassword.value = !revealPassword.value;
                            }}
                        >
                            <PgIcon icon={revealPassword.value ? "mdi-eye-off" : "mdi-eye-outline"} size={17} />
                        </button>
                    )}
                    {props.kbdHint && !focused.value && !currentValue.value && (
                        <kbd class="pg-kbd-badge" aria-hidden="true">
                            {props.kbdHint}
                        </kbd>
                    )}
                    {trailingIcon.value && (
                        <span
                            class="pg-control-adornment pg-control-adornment--end"
                            onClick={
                                props["onClick:appendInner"] ??
                                props["onClick:append"] ??
                                attrs["onClick:appendInner"] ??
                                attrs["onClick:append"]
                            }
                            role={
                                props["onClick:appendInner"] ||
                                props["onClick:append"] ||
                                attrs["onClick:appendInner"] ||
                                attrs["onClick:append"]
                                    ? "button"
                                    : undefined
                            }
                        >
                            <PgIcon icon={trailingIcon.value} size={17} />
                        </span>
                    )}
                    {slots["append-inner"] ? slots["append-inner"]() : null}
                </div>
            );

            return (
                <PgFieldShell
                    {...shellAttrs}
                    forId={inputId}
                    label={props.label}
                    hint={props.hint}
                    error={displayError.value}
                    required={props.required}
                    disabled={props.disabled}
                    hideDetails={props.hideDetails}
                    counter={counterText.value}
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
            prependIcon: { type: String, default: "" },
            appendIcon: { type: String, default: "" },
            prefix: { type: String, default: "" },
            suffix: { type: String, default: "" },
            kbdHint: { type: String, default: "" },
            clearable: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            monospace: { type: Boolean, default: false },
            autocomplete: { type: String, default: "off" },
            autofocus: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            validateOn: { type: String, default: "blur" },
            hideDetails: { type: Boolean, default: false },
            counter: { type: [Boolean, Number], default: false },
            maxlength: { type: [String, Number], default: undefined },
            id: { type: String, default: "" },
        },
        emits: ["update:modelValue", "clear", "enter", "blur", "focus"],
        inheritAttrs: false,
    },
);

export const TextField = PgTextField;
export const VTextField = PgTextField;
