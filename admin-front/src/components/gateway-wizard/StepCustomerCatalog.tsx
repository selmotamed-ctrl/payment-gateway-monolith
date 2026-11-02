import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VSelect, VTextField } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { WizardSection } from "./WizardSection";
import type { WizardRail, WizardRailField } from "./types";
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

const sensitivityTone = (sensitivity: string): BadgeTone => {
    switch (sensitivity) {
        case "PAN":
            return "danger";
        case "SENSITIVE":
            return "warning";
        default:
            return "neutral";
    }
};

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "14px",
} as const;

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
                <SurfaceCard
                    title={t("Customer Catalog")}
                    v-slots={{
                        headerActions: () => (
                            <VBtn variant="tonal" size="small" onClick={addRail}>
                                {t("Add")}
                            </VBtn>
                        ),
                    }}
                >
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                        {rails.length > 0 && (
                            <SegmentedTabs
                                modelValue={String(activeRailIndex.value)}
                                tabs={rails.map((rail, index) => ({
                                    value: String(index),
                                    label: rail.code || `Rail ${index + 1}`,
                                }))}
                                onUpdate:modelValue={(value: string) => (activeRailIndex.value = Number(value))}
                                ariaLabel={t("Customer Catalog")}
                            />
                        )}

                        {activeRail && (
                            <WizardSection
                                title={activeRail.code || `Rail ${activeRailIndex.value + 1}`}
                                v-slots={{
                                    actions: () => (
                                        <>
                                            <StatusBadge
                                                status={activeRail.collectionMode}
                                                toneOverride="info"
                                                showDot={false}
                                            />
                                            <VBtn
                                                size="x-small"
                                                variant="text"
                                                color="error"
                                                onClick={() => removeRail(activeRailIndex.value)}
                                            >
                                                ×
                                            </VBtn>
                                        </>
                                    ),
                                }}
                            >
                                <div style={gridStyle}>
                                    <FormField label={t("Rail Code")}>
                                        <VTextField
                                            modelValue={activeRail.code}
                                            onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { code: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Label (English)")}>
                                        <VTextField
                                            modelValue={activeRail.nameEn}
                                            onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { nameEn: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Label (Arabic)")}>
                                        <VTextField
                                            modelValue={activeRail.nameAr}
                                            onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { nameAr: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Type")}>
                                        <VSelect
                                            items={["OTP_PULL", "REDIRECT", "EMBEDDED", "PUSH_APPROVAL", "QR_DISPLAY", "PAY_CODE", "DEEP_LINK", "MANUAL", "HYBRID"]}
                                            modelValue={activeRail.collectionMode}
                                            onUpdate:modelValue={(v: any) => updateRail(activeRailIndex.value, { collectionMode: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Currency")}>
                                        <VTextField
                                            modelValue={activeRail.currency}
                                            onUpdate:modelValue={(v: string) =>
                                                updateRail(activeRailIndex.value, { currency: v.toUpperCase() })
                                            }
                                        />
                                    </FormField>
                                    <FormField label="min_amount">
                                        <VTextField
                                            modelValue={activeRail.minAmount}
                                            onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { minAmount: v })}
                                        />
                                    </FormField>
                                    <FormField label="max_amount">
                                        <VTextField
                                            modelValue={activeRail.maxAmount}
                                            onUpdate:modelValue={(v: string) => updateRail(activeRailIndex.value, { maxAmount: v })}
                                        />
                                    </FormField>
                                </div>

                                <WizardSection
                                    title={t("Params")}
                                    divider
                                    v-slots={{
                                        actions: () => (
                                            <VBtn variant="tonal" size="small" onClick={() => addField(activeRailIndex.value)}>
                                                {t("Add")}
                                            </VBtn>
                                        ),
                                    }}
                                >
                                    {activeRail.fields.map((field, fieldIndex) => (
                                        <div
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
                                            style={{ cursor: "grab" }}
                                        >
                                            <WizardSection
                                                title={field.fieldKey || `${t("Field Key")} ${fieldIndex + 1}`}
                                                divider={fieldIndex > 0}
                                                v-slots={{
                                                    actions: () => (
                                                        <>
                                                            <VIconDrag />
                                                            <StatusBadge
                                                                status={field.sensitivity}
                                                                toneOverride={sensitivityTone(field.sensitivity)}
                                                                showDot={false}
                                                            />
                                                            <VBtn
                                                                size="x-small"
                                                                variant="text"
                                                                color="error"
                                                                onClick={() => removeField(activeRailIndex.value, fieldIndex)}
                                                            >
                                                                ×
                                                            </VBtn>
                                                        </>
                                                    ),
                                                }}
                                            >
                                                <div style={gridStyle}>
                                                    <FormField label={t("Field Key")}>
                                                        <VTextField
                                                            modelValue={field.fieldKey}
                                                            onUpdate:modelValue={(v: string) =>
                                                                updateField(activeRailIndex.value, fieldIndex, { fieldKey: v })
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Label (English)")}>
                                                        <VTextField
                                                            modelValue={field.labelEn}
                                                            onUpdate:modelValue={(v: string) =>
                                                                updateField(activeRailIndex.value, fieldIndex, { labelEn: v })
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Label (Arabic)")}>
                                                        <VTextField
                                                            modelValue={field.labelAr}
                                                            onUpdate:modelValue={(v: string) =>
                                                                updateField(activeRailIndex.value, fieldIndex, { labelAr: v })
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Input Type")}>
                                                        <VSelect
                                                            items={["text", "numeric", "phone", "wallet_id", "otp", "select"]}
                                                            modelValue={field.inputType}
                                                            onUpdate:modelValue={(v: any) =>
                                                                updateField(activeRailIndex.value, fieldIndex, { inputType: v })
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Regex")}>
                                                        <VTextField
                                                            modelValue={field.regex}
                                                            onUpdate:modelValue={(v: string) =>
                                                                updateField(activeRailIndex.value, fieldIndex, { regex: v })
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Min Length")}>
                                                        <VTextField
                                                            type="number"
                                                            modelValue={field.minLength ?? undefined}
                                                            onUpdate:modelValue={(v: any) =>
                                                                updateField(activeRailIndex.value, fieldIndex, {
                                                                    minLength: v === "" || v == null ? null : Number(v),
                                                                })
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Max Length")}>
                                                        <VTextField
                                                            type="number"
                                                            modelValue={field.maxLength ?? undefined}
                                                            onUpdate:modelValue={(v: any) =>
                                                                updateField(activeRailIndex.value, fieldIndex, {
                                                                    maxLength: v === "" || v == null ? null : Number(v),
                                                                })
                                                            }
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Normalizer")}>
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
                                                        />
                                                    </FormField>
                                                    <FormField label={t("Sensitivity")}>
                                                        <VSelect
                                                            items={["NORMAL", "SENSITIVE", "PAN"]}
                                                            modelValue={field.sensitivity}
                                                            onUpdate:modelValue={(v: any) =>
                                                                updateField(activeRailIndex.value, fieldIndex, { sensitivity: v })
                                                            }
                                                        />
                                                    </FormField>
                                                </div>
                                            </WizardSection>
                                        </div>
                                    ))}
                                </WizardSection>
                            </WizardSection>
                        )}
                    </SurfaceCardText>
                </SurfaceCard>
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
