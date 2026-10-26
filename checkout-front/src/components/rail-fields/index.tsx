import { dc } from "kt-dc";
import { computed } from "vue";
import { useLocale } from "vuetify";
import { VTextField, VSelect } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
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
                    const shared = {
                        label: labelFor(field),
                        placeholder: placeholderFor(field) ?? undefined,
                        modelValue: value,
                        error: !!error,
                        errorMessages: error ? [error] : undefined,
                    };
                    if (field.inputType === "select") {
                        return (
                            <VSelect
                                key={field.key}
                                items={(field.options ?? []).map((option) => ({ title: option, value: option }))}
                                label={shared.label}
                                modelValue={value}
                                error={shared.error}
                                errorMessages={shared.errorMessages}
                                onUpdate:modelValue={(raw: string) =>
                                    props.onChange(field.key, normalizeFieldValue(field, raw))
                                }
                            />
                        );
                    }
                    return (
                        <VTextField
                            key={field.key}
                            label={shared.label}
                            placeholder={shared.placeholder}
                            modelValue={value}
                            error={shared.error}
                            errorMessages={shared.errorMessages}
                            type={field.sensitivity === "PAN" ? "password" : "text"}
                            autocomplete="off"
                            onUpdate:modelValue={(raw: string) =>
                                props.onChange(field.key, normalizeFieldValue(field, raw))
                            }
                        />
                    );
                })}
                {visibleFields.value.length === 0 && (
                    <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>{t("Continue To Payment")}</ThemedText>
                )}
            </ThemedView>
        );
    },
    {
        props: ["fields", "values", "errors", "onChange"],
    },
);

export default RailFieldForm;
