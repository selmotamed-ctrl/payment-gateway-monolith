import { dc } from "kt-dc";
import { computed } from "vue";
import { useLocale } from "vuetify";
import { VTextField, VSelect } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { FormField } from "@/components/ui";
import { normalizeFieldValue } from "@/utils/zReady";
import type { RailFieldDescriptor } from "@/components/renderers/types";

export type RailFieldFormProps = {
    fields: RailFieldDescriptor[];
    values: Record<string, string>;
    errors: Record<string, string>;
    onChange: (key: string, value: string) => void;
};

export const RailFieldForm = dc(
    (props: RailFieldFormProps) => {
        const { t, current } = useLocale();

        const labelFor = (field: RailFieldDescriptor) => {
            const arabic = field.labelAr;
            const english = field.labelEn;
            return current.value === "ar" ? arabic || english : english || arabic;
        };

        const placeholderFor = (field: RailFieldDescriptor) => {
            const arabic = field.placeholderAr;
            const english = field.placeholderEn;
            return current.value === "ar" ? arabic || english : english || arabic;
        };

        const visibleFields = computed(() => props.fields ?? []);

        return () => (
            <ThemedView style={{ gap: "14px", width: "100%" }}>
                {visibleFields.value.map((field) => {
                    const value = props.values[field.key] ?? "";
                    const error = props.errors[field.key];
                    const label = labelFor(field);
                    const shared = {
                        "aria-label": label,
                        placeholder: placeholderFor(field) ?? undefined,
                        modelValue: value,
                        error: !!error,
                        required: field.required,
                    };
                    if (field.inputType === "select") {
                        return (
                            <FormField
                                key={field.key}
                                label={label}
                                error={error}
                                required={field.required}
                            >
                                <VSelect
                                    items={(field.options ?? []).map((option) => ({ title: option, value: option }))}
                                    {...shared}
                                    onUpdate:modelValue={(raw: string) =>
                                        props.onChange(field.key, normalizeFieldValue(field, raw))
                                    }
                                />
                            </FormField>
                        );
                    }
                    return (
                        <FormField
                            key={field.key}
                            label={label}
                            error={error}
                            required={field.required}
                        >
                            <VTextField
                                {...shared}
                                type={field.sensitivity === "PAN" ? "password" : "text"}
                                autocomplete="off"
                                onUpdate:modelValue={(raw: string) =>
                                    props.onChange(field.key, normalizeFieldValue(field, raw))
                                }
                            />
                        </FormField>
                    );
                })}
                {visibleFields.value.length === 0 && (
                    <ThemedText style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                        {t("Continue To Payment")}
                    </ThemedText>
                )}
            </ThemedView>
        );
    },
    {
        props: ["fields", "values", "errors", "onChange"],
    },
);

export default RailFieldForm;
