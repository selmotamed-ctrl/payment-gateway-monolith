import { Radio, RadioGroup, Switch } from "vael-ui/vapor";
import { ref } from "vue";
import { dc } from "../lib/dc";
import { runRules, visibleError } from "../lib/rules";

export const PgSwitch = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => {
        const localError = ref("");
        const update = (next: boolean) => {
            emit?.("update:modelValue", next);
            localError.value = props.rules ? runRules({ ...props, ...attrs }, next) : "";
        };
        return () => {
            const error = visibleError({ ...props, ...attrs }, localError.value);
            return (
                <div class="pg-switch-field">
                    <Switch
                        modelValue={Boolean(props.modelValue)}
                        label={props.label}
                        disabled={Boolean(props.disabled)}
                        invalid={Boolean(error)}
                        size={props.density === "compact" ? "sm" : (props.size ?? "md")}
                        name={props.name}
                        onUpdate:modelValue={update}
                    >
                        {slots.default ? slots.default() : undefined}
                    </Switch>
                    {error && !props.hideDetails ? <span class="pg-field__error" role="alert">{error}</span> : null}
                </div>
            );
        };
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            label: { type: String, default: "" },
            error: { type: String, default: "" },
            disabled: { type: Boolean, default: false },
            density: { type: String, default: "" },
            size: { type: String, default: "md" },
            hideDetails: { type: Boolean, default: false },
            rules: { type: Array as () => Array<(value: any) => any>, default: () => [] },
            name: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
        inheritAttrs: true,
    },
);

export const PgRadioGroup = dc(
    (props: Record<string, any>, _expose, { attrs, emit, slots }) => () => (
        <RadioGroup
            modelValue={props.modelValue ?? null}
            disabled={Boolean(props.disabled)}
            orientation={props.inline ? "horizontal" : "vertical"}
            name={props.name}
            onUpdate:modelValue={(next: any) => emit?.("update:modelValue", next)}
        >
            {slots.default?.()}
        </RadioGroup>
    ),
    {
        props: {
            modelValue: { type: [String, Number], default: null },
            disabled: { type: Boolean, default: false },
            inline: { type: Boolean, default: false },
            name: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
        inheritAttrs: true,
    },
);

export const PgRadio = dc(
    (props: Record<string, any>) => () => (
        <Radio value={props.value} label={props.label} description={props.description} disabled={Boolean(props.disabled)} />
    ),
    {
        props: {
            value: { type: [String, Number], required: true },
            label: { type: String, default: "" },
            description: { type: String, default: "" },
            disabled: { type: Boolean, default: false },
        },
    },
);

export const VSwitch = PgSwitch;
export const VRadioGroup = PgRadioGroup;
export const VRadio = PgRadio;
