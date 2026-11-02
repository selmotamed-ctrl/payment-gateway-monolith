import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VCheckbox } from "vuetify/components";
import { useLocale } from "vuetify";

export interface ChecklistItem {
    key: string;
    label: string;
}

export const FormChecklist = defineComponent({
    name: "FormChecklist",
    props: {
        checks: { type: Array as PropType<ChecklistItem[]>, required: true },
        modelValue: { type: Object as PropType<Record<string, boolean>>, required: true },
        title: { type: String, default: "" },
        show: { type: Boolean, default: true },
        incompleteMessage: { type: String, default: "" },
        complete: { type: Boolean, default: true },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const update = (key: string, value: unknown) => {
            emit("update:modelValue", { ...props.modelValue, [key]: Boolean(value) });
        };
        return (): VNodeChild => {
            if (!props.show || props.checks.length === 0) return null;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    {props.title && (
                        <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--pg-ink-primary)" }}>
                            {props.title}
                        </div>
                    )}
                    {props.checks.map((check) => (
                        <VCheckbox
                            key={check.key}
                            modelValue={props.modelValue[check.key] === true}
                            onUpdate:modelValue={(value: unknown) => update(check.key, value)}
                            label={t(check.label)}
                            density="compact"
                            hideDetails
                        />
                    ))}
                    {!props.complete && props.incompleteMessage && (
                        <div style={{ fontSize: "11px", color: "var(--pg-ink-muted)" }}>{props.incompleteMessage}</div>
                    )}
                </div>
            );
        };
    },
});

export default FormChecklist;
