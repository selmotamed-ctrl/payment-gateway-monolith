import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VSelect, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import type { WizardDraft, WizardRail, WizardRailField } from "./types";
import type { WizardStepProps } from "./StepIdentity";

const emptyField = (): WizardRailField => ({
    fieldKey: "",
    labelAr: "",
    labelEn: "",
    inputType: "text",
    required: false,
    regex: "",
    minLength: null,
    maxLength: null,
    normalizer: "NONE",
    sensitivity: "NORMAL",
    options: [],
});

const emptyRail = (): WizardRail => ({
    code: "",
    nameAr: "",
    nameEn: "",
    collectionMode: "OTP_PULL",
    currency: "LYD",
    minAmount: "0",
    maxAmount: "0",
    capabilities: ["refund", "partial_refund"],
    fields: [emptyField()],
});

const sensitivityTone = (sensitivity: string) => {
    switch (sensitivity) {
        case "PAN":
            return "error" as const;
        case "SENSITIVE":
            return "warning" as const;
        default:
            return "neutral" as const;
    }
};

export const StepCustomerCatalog = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const activeRailIndex = ref(0);
        const dragIndex = ref<number | null>(null);

        const updateRail = (index: number, patch: Partial<WizardRail>) => {
            const rails = props.model.rails.map((rail, railIndex) => (railIndex === index ? { ...rail, ...patch } : rail));
            props.onChange({ ...props.model, rails });
        };

        const updateField = (railIndex: number, fieldIndex: number, patch: Partial<WizardRailField>) => {
            const rails = props.model.rails.map((rail, index) =>
                index === railIndex
                    ? {
                          ...rail,
                          fields: rail.fields.map((field, fieldIdx) =>
                              fieldIdx === fieldIndex ? { ...field, ...patch } : field,
                          ),
                      }
                    : rail,
            );
            props.onChange({ ...props.model, rails });
        };

        const addRail = () => {
            props.onChange({ ...props.model, rails: [...props.model.rails, emptyRail()] });
            activeRailIndex.value = props.model.rails.length;
        };

        const removeRail = (index: number) => {
            props.onChange({ ...props.model, rails: props.model.rails.filter((_, railIndex) => railIndex !== index) });
            activeRailIndex.value = Math.max(0, Math.min(activeRailIndex.value, props.model.rails.length - 2));
        };

        const addField = (railIndex: number) => {
            const rails = props.model.rails.map((rail, index) =>
                index === railIndex ? { ...rail, fields: [...rail.fields, emptyField()] } : rail,
            );
            props.onChange({ ...props.model, rails });
        };

        const removeField = (railIndex: number, fieldIndex: number) => {
            const rails = props.model.rails.map((rail, index) =>
                index === railIndex
                    ? { ...rail, fields: rail.fields.filter((_, fieldIdx) => fieldIdx !== fieldIndex) }
                    : rail,
            );
            props.onChange({ ...props.model, rails });
        };

        const moveField = (railIndex: number, from: number, to: number) => {
            const rails = props.model.rails.map((rail, index) => {
                if (index !== railIndex) {
                    return rail;
                }
                const fields = [...rail.fields];
                const [moved] = fields.splice(from, 1);
                if (!moved) {
                    return rail;
                }
                fields.splice(to, 0, moved);
                return { ...rail, fields };
            });
            props.onChange({ ...props.model, rails });
        };

        return () => {
            const rails = props.model.rails;
            const activeRail = rails[activeRailIndex.value];

            return (
                <ThemedView style={{ gap: "16px" }}>
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView
                                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                            >
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                    {t("Customer Catalog")}
                                </ThemedText>
                                <VBtn variant="tonal" size="small" onClick={addRail}>
                                    {t("Add")}
                                </VBtn>
                            </ThemedView>

                            <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                {rails.map((rail, index) => (
                                    <ThemedView key={index} style={{ flexDirection: "row", alignItems: "center", gap: "6px" }}>
                                        <VBtn
                                            size="small"
                                            variant={index === activeRailIndex.value ? "flat" : "text"}
                                            color={index === activeRailIndex.value ? "primary" : undefined}
                                            onClick={() => (activeRailIndex.value = index)}
                                        >
                                            {rail.code || `Rail ${index + 1}`}
                                        </VBtn>
                                        <VBtn size="x-small" variant="text" color="error" onClick={() => removeRail(index)}>
                                            ×
                                        </VBtn>
                                    </ThemedView>
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>

                    {activeRail && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                                    <VTextField
                                        label={t("Rail Code")}
                                        modelValue={activeRail.code}
                                        onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { code: v })}
                                        style={{ minWidth: "180px" }}
                                    />
                                    <VTextField
                                        label={t("Label (English)")}
                                        modelValue={activeRail.nameEn}
                                        onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { nameEn: v })}
                                        style={{ minWidth: "220px" }}
                                    />
                                    <VTextField
                                        label={t("Label (Arabic)")}
                                        modelValue={activeRail.nameAr}
                                        onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { nameAr: v })}
                                        style={{ minWidth: "220px" }}
                                    />
                                    <VSelect
                                        items={["OTP_PULL", "REDIRECT", "EMBEDDED", "PUSH_APPROVAL", "QR_DISPLAY", "PAY_CODE", "DEEP_LINK", "MANUAL", "HYBRID"]}
                                        modelValue={activeRail.collectionMode}
                                        onUpdate:modelValue={(v: any) => updateRail(activeRailIndex.value, { collectionMode: v })}
                                        label={t("Type")}
                                        style={{ minWidth: "200px" }}
                                    />
                                    <VTextField
                                        label={t("Currency")}
                                        modelValue={activeRail.currency}
                                        onUpdate:modelValue={(v: string) =>
                                            updateRail(activeRailIndex.value, { currency: v.toUpperCase() })
                                        }
                                        style={{ minWidth: "120px" }}
                                    />
                                    <VTextField
                                        label="min_amount"
                                        modelValue={activeRail.minAmount}
                                        onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { minAmount: v })}
                                        style={{ minWidth: "140px" }}
                                    />
                                    <VTextField
                                        label="max_amount"
                                        modelValue={activeRail.maxAmount}
                                        onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { maxAmount: v })}
                                        style={{ minWidth: "140px" }}
                                    />
                                </ThemedView>

                                <ThemedView
                                    style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                                >
                                    <ThemedText type="defaultSemiBold">{t("Rail Code")}</ThemedText>
                                    <VBtn variant="tonal" size="small" onClick={() => addField(activeRailIndex.value)}>
                                        {t("Add")}
                                    </VBtn>
                                </ThemedView>

                                {activeRail.fields.map((field, fieldIndex) => (
                                    <ThemedView
                                        key={fieldIndex}
                                        draggable={true}
                                        onDragstart={() => (dragIndex.value = fieldIndex)}
                                        onDragover={(e: any) => e.preventDefault()}
                                        onDrop={(e: any) => {
                                            e.preventDefault();
                                            if (dragIndex.value !== null) {
                                                moveField(activeRailIndex.value, dragIndex.value, fieldIndex);
                                                dragIndex.value = null;
                                            }
                                        }}
                                        style={{
                                            flexDirection: "row",
                                            gap: "10px",
                                            flexWrap: "wrap",
                                            alignItems: "center",
                                            border: "1px solid rgba(100,116,139,0.2)",
                                            borderRadius: "12px",
                                            padding: "10px",
                                            cursor: "grab",
                                        }}
                                    >
                                        <VIconDrag />
                                        <VTextField
                                            label={t("Field Key")}
                                            modelValue={field.fieldKey}
                                            onUpdate:modelValue={(v: string) =>
                                                updateField(activeRailIndex.value, fieldIndex, { fieldKey: v })
                                            }
                                            style={{ minWidth: "160px" }}
                                        />
                                        <VTextField
                                            label={t("Label (English)")}
                                            modelValue={field.labelEn}
                                            onUpdate:modelValue={(v: string) =>
                                                updateField(activeRailIndex.value, fieldIndex, { labelEn: v })
                                            }
                                            style={{ minWidth: "190px" }}
                                        />
                                        <VTextField
                                            label={t("Label (Arabic)")}
                                            modelValue={field.labelAr}
                                            onUpdate:modelValue={(v: string) =>
                                                updateField(activeRailIndex.value, fieldIndex, { labelAr: v })
                                            }
                                            style={{ minWidth: "190px" }}
                                        />
                                        <VSelect
                                            items={["text", "numeric", "phone", "wallet_id", "otp", "select"]}
                                            modelValue={field.inputType}
                                            onUpdate:modelValue={(v: any) =>
                                                updateField(activeRailIndex.value, fieldIndex, { inputType: v })
                                            }
                                            label={t("Input Type")}
                                            style={{ minWidth: "160px" }}
                                        />
                                        <VTextField
                                            label={t("Regex")}
                                            modelValue={field.regex}
                                            onUpdate:modelValue={(v: string) =>
                                                updateField(activeRailIndex.value, fieldIndex, { regex: v })
                                            }
                                            style={{ minWidth: "200px" }}
                                        />
                                        <VTextField
                                            label={t("Min Length")}
                                            type="number"
                                            modelValue={field.minLength ?? undefined}
                                            onUpdate:modelValue={(v: any) =>
                                                updateField(activeRailIndex.value, fieldIndex, {
                                                    minLength: v === "" || v == null ? null : Number(v),
                                                })
                                            }
                                            style={{ minWidth: "120px" }}
                                        />
                                        <VTextField
                                            label={t("Max Length")}
                                            type="number"
                                            modelValue={field.maxLength ?? undefined}
                                            onUpdate:modelValue={(v: any) =>
                                                updateField(activeRailIndex.value, fieldIndex, {
                                                    maxLength: v === "" || v == null ? null : Number(v),
                                                })
                                            }
                                            style={{ minWidth: "120px" }}
                                        />
                                        <VSelect
                                            items={[
                                                "NONE",
                                                "ARABIC_DIGITS_TO_ASCII",
                                                "PHONE_NORMALIZE_LOCAL_09",
                                                "PHONE_NORMALIZE_INTL_218",
                                                "PHONE_NORMALIZE_E164",
                                            ]}
                                            modelValue={field.normalizer}
                                            onUpdate:modelValue={(v: any) =>
                                                updateField(activeRailIndex.value, fieldIndex, { normalizer: v })
                                            }
                                            label={t("Normalizer")}
                                            style={{ minWidth: "240px" }}
                                        />
                                        <VSelect
                                            items={["NORMAL", "SENSITIVE", "PAN"]}
                                            modelValue={field.sensitivity}
                                            onUpdate:modelValue={(v: any) =>
                                                updateField(activeRailIndex.value, fieldIndex, { sensitivity: v })
                                            }
                                            label={t("Sensitivity")}
                                            style={{ minWidth: "160px" }}
                                        />
                                        <StatusChip label={field.sensitivity} tone={sensitivityTone(field.sensitivity)} />
                                        <VBtn
                                            size="x-small"
                                            variant="text"
                                            color="error"
                                            onClick={() => removeField(activeRailIndex.value, fieldIndex)}
                                        >
                                            ×
                                        </VBtn>
                                    </ThemedView>
                                ))}
                            </VCardText>
                        </VCard>
                    )}
                </ThemedView>
            );
        };
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

const VIconDrag = dc(() => {
    return () => (
        <span style={{ opacity: 0.5, fontSize: "18px", lineHeight: 1, userSelect: "none" }} aria-hidden="true">
            ⋮⋮
        </span>
    );
});

export default StepCustomerCatalog;
