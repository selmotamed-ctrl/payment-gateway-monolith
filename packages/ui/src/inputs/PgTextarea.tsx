import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { controlSize, normalizeSize, pick } from "../lib/options";
import { runRules } from "../lib/rules";
import { usePgFormControl } from "../lib/formRegistry";
import { PgFieldShell } from "./PgFieldShell";

const TEXTAREA_ATTRS = [
    "id",
    "name",
    "placeholder",
    "disabled",
    "readonly",
    "autocomplete",
    "maxlength",
    "minlength",
    "rows",
    "autofocus",
    "dir",
    "title",
    "tabindex",
    "onClick",
    "onChange",
    "onKeydown",
    "onKeyup",
    "onBlur",
    "onFocus",
    "onInput",
    "onPaste",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
    "aria-required",
];

const errorMessagesOf = (messages: unknown): string => {
    if (Array.isArray(messages)) return messages.find((entry) => typeof entry === "string" && entry) ?? "";
    return typeof messages === "string" ? messages : "";
};

/**
 * Multi-line text input sharing the field shell and the single neutral focus
 * ring. Auto-grows up to `maxRows`, shows a live counter and submits on
 * Ctrl/Cmd+Enter (`Enter` still inserts a newline).
 */
export const PgTextarea = dc(
    (props: Record<string, any>, _expose, { attrs, emit, expose }) => {
        const autoId = useId();
        const inputId = props.id || `pg-ta-${autoId}`;
        const localError = ref("");
        const touched = ref(false);
        const focused = ref(false);
        let textareaEl: HTMLTextAreaElement | null = null;

        const value = computed(() => (props.modelValue === null || props.modelValue === undefined ? "" : String(props.modelValue)));
        const currentValue = ref(value.value);
        watch(value, (next) => {
            if (next !== currentValue.value) currentValue.value = next;
        });

        const size = computed(() => {
            if ((props.density ?? attrs.density) === "compact") return "sm";
            return (
                normalizeSize(props.size) ??
                controlSize({ ...props, size: props.size ?? attrs.size, density: props.density ?? attrs.density })
            );
        });
        const rows = computed(() => {
            const parsed = Number(props.rows);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
        });
        const maxRows = computed(() => {
            const parsed = Number(props.maxRows);
            return Number.isFinite(parsed) && parsed > rows.value ? parsed : Math.max(rows.value, 8);
        });
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

        const nativeTextarea = (): HTMLTextAreaElement | null =>
            textareaEl ?? (document.getElementById(inputId) as HTMLTextAreaElement | null);

        const focus = () => nativeTextarea()?.focus();
        const blur = () => nativeTextarea()?.blur();
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

        const resize = (element?: HTMLTextAreaElement | null) => {
            const target = element ?? textareaEl;
            if (!target || props.autoGrow === false || props.noResize) return;
            // jsdom reports `scrollHeight = 0`; only size when the browser has
            // actually laid out the element.
            if (!target.scrollHeight) return;
            target.style.height = "auto";
            const line = 22;
            const limit = maxRows.value * line;
            const next = Math.min(target.scrollHeight, limit);
            target.style.height = `${next}px`;
            target.style.overflowY = target.scrollHeight > limit ? "auto" : "hidden";
        };

        usePgFormControl({
            id: inputId,
            validate,
            focus,
            resetValidation,
            reset: () => {
                currentValue.value = "";
                localError.value = "";
                touched.value = false;
                if (textareaEl) textareaEl.value = "";
                emit?.("update:modelValue", "");
            },
        });

        onMounted(() => {
            void nextTick(() => resize());
        });
        watch(value, () => void nextTick(() => resize()));
        onBeforeUnmount(() => {
            textareaEl = null;
        });

        expose?.({
            focus,
            blur,
            validate,
            resetValidation,
            resize: () => resize(),
        });

        return () => {
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
            const textareaAttrs = pick({ ...props, ...attrs }, TEXTAREA_ATTRS);
            delete textareaAttrs.onInput;
            delete textareaAttrs.onKeydown;
            delete textareaAttrs.onFocus;
            delete textareaAttrs.onBlur;
            delete textareaAttrs.id;

            const control = (
                <div
                    class={[
                        "pg-control-box",
                        "pg-control-box--textarea",
                        `pg-control-box--${size.value}`,
                        focused.value ? "pg-control-box--focused" : "",
                        displayError.value ? "pg-control-box--error" : "",
                        props.disabled ? "pg-control-box--disabled" : "",
                    ]}
                    onMousedown={(event: MouseEvent) => {
                        if (event.button !== 0) return;
                        const target = event.target;
                        if (target instanceof Element && target.closest("button, a, textarea, input")) return;
                        event.preventDefault();
                        focus();
                    }}
                >
                    <textarea
                        {...textareaAttrs}
                        ref={(element: any) => {
                            textareaEl = element as HTMLTextAreaElement | null;
                        }}
                        id={inputId}
                        class={[
                            "pg-control-native",
                            "pg-control-textarea",
                            props.noResize || props.autoGrow !== false ? "pg-control-textarea--no-resize" : "",
                        ]}
                        value={currentValue.value}
                        rows={rows.value}
                        maxlength={maxLength.value || undefined}
                        disabled={props.disabled}
                        readonly={props.readonly}
                        autofocus={props.autofocus ? true : undefined}
                        data-autogrow={props.autoGrow === false ? "false" : "true"}
                        data-max-rows={maxRows.value}
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
                            const next = (event.target as HTMLTextAreaElement).value;
                            currentValue.value = next;
                            emit?.("update:modelValue", next);
                            (attrs.onInput as ((event: Event) => void) | undefined)?.(event);
                            if (props.validateOn === "input") validate(next);
                            resize(event.target as HTMLTextAreaElement);
                        }}
                        onKeydown={(event: KeyboardEvent) => {
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                emit?.("submit", currentValue.value);
                            }
                            (attrs.onKeydown as ((event: KeyboardEvent) => void) | undefined)?.(event);
                        }}
                    />
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
            rows: { type: [Number, String], default: 3 },
            maxRows: { type: [Number, String], default: 8 },
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            autoGrow: { type: Boolean, default: true },
            noResize: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            autofocus: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            validateOn: { type: String, default: "blur" },
            hideDetails: { type: Boolean, default: false },
            counter: { type: [Boolean, Number], default: false },
            id: { type: String, default: "" },
            maxlength: { type: [String, Number], default: undefined },
        },
        emits: ["update:modelValue", "blur", "focus", "submit"],
        inheritAttrs: false,
    },
);

export const VTextarea = PgTextarea;
