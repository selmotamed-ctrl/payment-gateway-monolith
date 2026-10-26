import { dc } from "kt-dc";
import { computed } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VFileInput } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
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

        return () => (
            <ThemedView style={{ gap: "16px", width: "100%" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                    {t("Instructions")}
                </ThemedText>

                {props.error && (
                    <VAlert type="error" variant="tonal" density="compact">
                        {props.error}
                    </VAlert>
                )}

                <ThemedView style={{ gap: "8px" }}>
                    <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
                        <ThemedText style={{ fontSize: "13px" }}>{t("Transfer To")}</ThemedText>
                        <ThemedText
                            type="defaultSemiBold"
                            style={{ fontSize: "14px", direction: "ltr", textAlign: "end" }}
                        >
                            {props.action.destination_account}
                        </ThemedText>
                    </ThemedView>
                    <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
                        <ThemedText style={{ fontSize: "13px" }}>{t("Payment Reference")}</ThemedText>
                        <ThemedText
                            type="defaultSemiBold"
                            style={{ fontSize: "14px", direction: "ltr", textAlign: "end" }}
                        >
                            {props.action.payment_reference}
                        </ThemedText>
                    </ThemedView>
                    {props.action.wallet_hint && (
                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
                            <ThemedText style={{ fontSize: "13px" }}>{t("Wallet Balance")}</ThemedText>
                            <ThemedText style={{ fontSize: "14px" }}>{props.action.wallet_hint}</ThemedText>
                        </ThemedView>
                    )}
                </ThemedView>

                {instructions.value && (
                    <ThemedText style={{ fontSize: "13px", opacity: 0.8, lineHeight: "1.8" }}>
                        {instructions.value}
                    </ThemedText>
                )}

                {props.action.proof_upload_allowed && (
                    <VFileInput
                        label={t("Submit Proof")}
                        modelValue={null}
                        onUpdate:modelValue={(v: File | File[] | null) => {
                            props.onProof?.(Array.isArray(v) ? (v[0] ?? null) : v);
                        }}
                    />
                )}

                {props.action.expires_at && (
                    <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                        {t("Expires At")}: {props.action.expires_at}
                    </ThemedText>
                )}
            </ThemedView>
        );
    },
    {
        props: ["action", "error", "onProof", "onCancel"],
    },
);

export default PushOrTransferRenderer;
