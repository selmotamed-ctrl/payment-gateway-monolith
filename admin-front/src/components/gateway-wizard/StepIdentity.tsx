import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VCard, VCardText, VSelect, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import type { WizardDraft } from "./types";

export type WizardStepProps = {
    model: WizardDraft;
    onChange: (draft: WizardDraft) => void;
    onSave?: () => unknown;
    saving?: boolean;
    error?: string | null;
};

const listToString = (list: string[]) => (list ?? []).join(", ");
const stringToList = (value: string) =>
    value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => !!entry);

export const StepIdentity = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();

        const update = (patch: Partial<WizardDraft["identity"]>) => {
            props.onChange({
                ...props.model,
                identity: { ...props.model.identity, ...patch },
            });
        };

        return () => (
            <VCard>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                        {t("Identity & Basics")}
                    </ThemedText>

                    <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                        <VTextField
                            label={t("Gateway Code")}
                            modelValue={props.model.identity.code}
                            onUpdate:modelValue={(v: string) => update({ code: v })}
                            style={{ minWidth: "220px" }}
                        />
                        <VTextField
                            label={t("Gateway")}
                            modelValue={props.model.identity.name}
                            onUpdate:modelValue={(v: string) => update({ name: v })}
                            style={{ minWidth: "260px" }}
                        />
                        <VTextField
                            label={t("Operator")}
                            modelValue={props.model.identity.operator}
                            onUpdate:modelValue={(v: string) => update({ operator: v })}
                            style={{ minWidth: "220px" }}
                        />
                        <VTextField
                            label={t("Country")}
                            modelValue={props.model.identity.country}
                            onUpdate:modelValue={(v: string) => update({ country: v.toUpperCase() })}
                            style={{ minWidth: "140px" }}
                        />
                    </ThemedView>

                    <VTextField
                        label={t("Aliases")}
                        modelValue={listToString(props.model.identity.aliases)}
                        onUpdate:modelValue={(v: string) => update({ aliases: stringToList(v) })}
                        hint="Comma separated"
                        persistentHint
                    />

                    <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                        <VSelect
                            items={["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]}
                            modelValue={props.model.identity.kind}
                            onUpdate:modelValue={(v: any) => update({ kind: v })}
                            label={t("Kind")}
                            style={{ minWidth: "220px" }}
                        />
                        <VSelect
                            items={["VERIFIED", "UNVERIFIED"]}
                            modelValue={props.model.identity.verificationState}
                            onUpdate:modelValue={(v: any) => update({ verificationState: v })}
                            label={t("Verification State")}
                            style={{ minWidth: "220px" }}
                        />
                        <VSelect
                            items={["NORMAL", "HIGH_RISK"]}
                            modelValue={props.model.identity.riskClass}
                            onUpdate:modelValue={(v: any) => update({ riskClass: v })}
                            label={t("Risk Class")}
                            style={{ minWidth: "220px" }}
                        />
                    </ThemedView>
                </VCardText>
            </VCard>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepIdentity;
