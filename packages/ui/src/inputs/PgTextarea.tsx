import { computed, ref, useId } from "vue";
import { dc } from "../lib/dc";
import { controlSize, pick } from "../lib/options";
import { runRules, visibleError } from "../lib/rules";
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
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
];

/** Auto-growing textarea sharing the field shell and the neutral focus ring. */
export const PgTextarea = dc(
    (props: Record<string, any>, _expose, { attrs, emit }) => {
        const inputId = props.id || `pg-ta-${useId()}`;
        const localError = ref("");
        const focused = ref(false);
        const value = computed(() => (props.modelValue == null ? "" : String(props.modelValue)));
        const error = computed(() => visibleError({ ...props, ...attrs }, localError.value));
        const size = computed(() => controlSize({ ...props, density: props.density ?? attrs.density }));

        const validate = (next: any = props.modelValue) => {
            localError.value = props.rules ? runRules({ ...props, ...attrs }, next) : "";
        };

        const resize = (element?: HTMLTextAreaElement | null) => {
            if (!element || props.autoGrow === false) return;
            element.style.height = "auto";
            element.style.height = `${element.scrollHeight}px`;
        };

        return () => {
            const textareaAttrs = pick({ ...props, ...attrs }, TEXTAREA_ATTRS);
            const control = (
                <div
                    class={[
                        "pg-control-box pg-control-box--textarea",
                        `pg-control-box--${size.value}`,
                        focused.value ? "pg-control-box--focused" : "",
                        error.value ? "pg-control-box--error" : "",
                        props.disabled ? "pg-control-box--disabled" : "",
                    ]}
                >
                    <textarea
                        {...textareaAttrs}
                        id={inputId}
                        class="pg-control-native pg-control-textarea"
                        value={value.value}
                        rows={props.rows ?? 3}
                        disabled={props.disabled}
                        readonly={props.readonly}
                        aria-invalid={error.value ? "true" : "false"}
                        onFocus={(event: FocusEvent) => {
                            focused.value = true;
                            props.onFocus?.(event);
                            emit?.("focus");
                        }}
                        onBlur={(event: FocusEvent) => {
                            focused.value = false;
                            props.onBlur?.(event);
                            emit?.("blur");
                            validate();
                        }}
                        onInput={(event: Event) => {
                            const next = (event.target as HTMLTextAreaElement).value;
                            emit?.("update:modelValue", next);
                            resize(event.target as HTMLTextAreaElement);
                            if (props.validateOn === "input") validate(next);
                        }}
                    />
                    <span class="pg-field__counter pg-tabular">
                        {value.value.length}
                        {props.maxlength ? `/${props.maxlength}` : ""}
                    </span>
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
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            autoGrow: { type: Boolean, default: true },
            disabled: { type: Boolean, default: false },
            readonly: { type: Boolean, default: false },
            required: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            hideDetails: { type: Boolean, default: false },
            id: { type: String, default: "" },
            maxlength: { type: [String, Number], default: undefined },
        },
        emits: ["update:modelValue", "blur", "focus"],
        inheritAttrs: true,
    },
);

export const VTextarea = PgTextarea;
