import { Checkbox } from "vael-ui/vapor";
import { ref } from "vue";
import { dc } from "../lib/dc";
import { runRules, visibleError } from "../lib/rules";

/**
 * 2026 checkbox backed by vael-ui's animated control (SVG draw-in, neutral
 * focus ring, indeterminate state). `variant="card"` renders the compliance
 * safeguard card row used by maker-checker dialogs.
 */
export const PgCheckbox = dc(
    (props: Record<string, any>, _expose, { attrs, emit }) => {
        const localError = ref("");
        const checked = () => {
            if (Array.isArray(props.modelValue)) return props.modelValue;
            return Boolean(props.modelValue);
        };
        const validate = (next: any) => {
            localError.value = props.rules ? runRules({ ...props, ...attrs }, next) : "";
        };
        const update = (next: boolean | unknown[]) => {
            emit?.("update:modelValue", next);
            validate(next);
        };
        return () => {
            const error = visibleError({ ...props, ...attrs }, localError.value);
            const card = props.variant === "card" || props.card === true;
            const checkedValue = checked();
            const isOn = Array.isArray(checkedValue) ? checkedValue.length > 0 : Boolean(checkedValue);
            const control = card ? (
                <Checkbox
                    modelValue={checked()}
                    value={props.value}
                    indeterminate={Boolean(props.indeterminate)}
                    disabled={Boolean(props.disabled)}
                    invalid={Boolean(error)}
                    size={props.density === "compact" ? "sm" : (props.size ?? "md")}
                    name={props.name}
                    onUpdate:modelValue={update}
                    ui={{ root: { class: "pg-checkbox--bare" } }}
                />
            ) : (
                <Checkbox
                    modelValue={checked()}
                    value={props.value}
                    label={props.label}
                    indeterminate={Boolean(props.indeterminate)}
                    disabled={Boolean(props.disabled)}
                    invalid={Boolean(error)}
                    size={props.density === "compact" ? "sm" : (props.size ?? "md")}
                    name={props.name}
                    onUpdate:modelValue={update}
                />
            );
            if (!card) {
                return (
                    <div class="pg-checkbox-field">
                        {control}
                        {error && !props.hideDetails ? <span class="pg-field__error" role="alert">{error}</span> : null}
                    </div>
                );
            }
            return (
                <label class={["pg-check-card", isOn ? "pg-check-card--on" : ""]}>
                    {control}
                    <span class="pg-check-card__body">
                        <span class="pg-check-card__title">{props.label}</span>
                        {(props.description || props.hint) && (
                            <span class="pg-check-card__description">{props.description || props.hint}</span>
                        )}
                    </span>
                </label>
            );
        };
    },
    {
        props: {
            modelValue: { type: [Boolean, Array], default: false },
            label: { type: String, default: "" },
            description: { type: String, default: "" },
            hint: { type: String, default: "" },
            error: { type: String, default: "" },
            errorMessages: { type: [Array, String], default: undefined },
            value: { type: [String, Number, Object], default: undefined },
            indeterminate: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            density: { type: String, default: "" },
            size: { type: String, default: "md" },
            hideDetails: { type: Boolean, default: false },
            variant: { type: String, default: "" },
            card: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            name: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
        inheritAttrs: true,
    },
);

export const VCheckbox = PgCheckbox;
