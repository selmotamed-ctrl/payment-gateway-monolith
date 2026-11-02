import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VSelect, VTextField } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormField } from "@/components/ui/FormField";
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

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "14px",
} as const;

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
            <SurfaceCard
                title={t("Identity & Basics")}
                v-slots={{
                    headerActions: () => (
                        <StatusBadge status={props.model.identity.verificationState} />
                    ),
                }}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <div style={gridStyle}>
                        <FormField label={t("Gateway Code")} required>
                            <VTextField
                                modelValue={props.model.identity.code}
                                onUpdate:modelValue={(v: string) => update({ code: v })}
                            />
                        </FormField>
                        <FormField label={t("Gateway")} required>
                            <VTextField
                                modelValue={props.model.identity.name}
                                onUpdate:modelValue={(v: string) => update({ name: v })}
                            />
                        </FormField>
                        <FormField label={t("Operator")}>
                            <VTextField
                                modelValue={props.model.identity.operator}
                                onUpdate:modelValue={(v: string) => update({ operator: v })}
                            />
                        </FormField>
                        <FormField label={t("Country")}>
                            <VTextField
                                modelValue={props.model.identity.country}
                                onUpdate:modelValue={(v: string) => update({ country: v.toUpperCase() })}
                            />
                        </FormField>
                    </div>

                    <FormField label={t("Aliases")} hint="Comma separated">
                        <VTextField
                            modelValue={listToString(props.model.identity.aliases)}
                            onUpdate:modelValue={(v: string) => update({ aliases: stringToList(v) })}
                        />
                    </FormField>

                    <div style={gridStyle}>
                        <FormField label={t("Kind")}>
                            <VSelect
                                items={["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]}
                                modelValue={props.model.identity.kind}
                                onUpdate:modelValue={(v: any) => update({ kind: v })}
                            />
                        </FormField>
                        <FormField label={t("Verification State")}>
                            <VSelect
                                items={["VERIFIED", "UNVERIFIED"]}
                                modelValue={props.model.identity.verificationState}
                                onUpdate:modelValue={(v: any) => update({ verificationState: v })}
                            />
                        </FormField>
                        <FormField label={t("Risk Class")}>
                            <VSelect
                                items={["NORMAL", "HIGH_RISK"]}
                                modelValue={props.model.identity.riskClass}
                                onUpdate:modelValue={(v: any) => update({ riskClass: v })}
                            />
                        </FormField>
                    </div>
                </SurfaceCardText>
            </SurfaceCard>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepIdentity;
