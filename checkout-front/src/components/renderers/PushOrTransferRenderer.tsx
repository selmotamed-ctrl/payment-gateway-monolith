import { dc } from "kt-dc";
import { computed } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VFileInput } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { DescriptionList, FormField, MonoRef, type DescriptionItem } from "@/components/ui";
import type { PushOrTransferClientAction } from "./types";

export type PushOrTransferRendererProps = {
    action: PushOrTransferClientAction;
    error?: string | null;
    onProof?: (file: File | null) => void;
    onCancel?: () => void;
};

export const PushOrTransferRenderer = dc(
    (props: PushOrTransferRendererProps) => {
        const { t, current } = useLocale();

        const instructions = computed(() =>
            current.value === "ar" ? props.action.instructions_ar : props.action.instructions_en,
        );

        return () => {
            const referenceItems: DescriptionItem[] = [
                {
                    label: t("Transfer To"),
                    value: <MonoRef value={props.action.destination_account} />,
                },
                {
                    label: t("Payment Reference"),
                    value: <MonoRef value={props.action.payment_reference} />,
                },
            ];
            if (props.action.wallet_hint) {
                referenceItems.push({
                    label: t("Wallet Balance"),
                    value: props.action.wallet_hint,
                });
            }

            return (
                <ThemedView style={{ gap: "16px", width: "100%" }}>
                    <ThemedText
                        type="defaultSemiBold"
                        style={{ fontSize: "17px", color: "var(--pg-ink-primary)" }}
                    >
                        {t("Instructions")}
                    </ThemedText>

                    {props.error && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {props.error}
                        </VAlert>
                    )}

                    <DescriptionList ariaLabel={t("Instructions")} items={referenceItems} />

                    {instructions.value && (
                        <ThemedText
                            style={{ fontSize: "13px", color: "var(--pg-ink-secondary)", lineHeight: 1.8 }}
                        >
                            {instructions.value}
                        </ThemedText>
                    )}

                    {props.action.proof_upload_allowed && (
                        <FormField label={t("Submit Proof")}>
                            <VFileInput
                                aria-label={t("Submit Proof")}
                                modelValue={null}
                                onUpdate:modelValue={(v: File | File[] | null) => {
                                    props.onProof?.(Array.isArray(v) ? (v[0] ?? null) : v);
                                }}
                            />
                        </FormField>
                    )}

                    {props.action.expires_at && (
                        <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                            {t("Expires At")}: {props.action.expires_at}
                        </ThemedText>
                    )}
                </ThemedView>
            );
        };
    },
    {
        props: ["action", "error", "onProof", "onCancel"],
    },
);

export default PushOrTransferRenderer;
