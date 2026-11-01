import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VDialog, VSelect, VTextarea } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { REVIEW_REASON_CODES } from "../kybReviewHelp";
import type { KybDocumentSummary } from "../types";

export type KybActionMode = "REPLACEMENT" | "REVALIDATION";

const KybActionDialog = dc(
    (props: {
        open: boolean;
        mode: KybActionMode;
        document: KybDocumentSummary | null;
        onUpdate: (open: boolean) => void;
        onDone: () => void;
    }) => {
        const { t } = useLocale();
        const reasonCode = ref("BLURRY_OR_UNREADABLE");
        const message = ref("");
        const error = ref<string | null>(null);
        const saving = ref(false);
        const isReplacement = computed(() => props.mode === "REPLACEMENT");

        watch(
            () => [props.open, props.mode, props.document?.id] as const,
            ([open]) => {
                if (!open) return;
                reasonCode.value = props.document?.expiryState === "EXPIRED" ? "EXPIRED_DOCUMENT" : "BLURRY_OR_UNREADABLE";
                message.value = isReplacement.value
                    ? t("Please upload a replacement copy so the KYB review can continue.")
                    : t("Please upload a current copy for periodic KYB re-verification.");
                error.value = null;
            },
            { immediate: true },
        );

        const submit = async () => {
            if (!props.document) return;
            if (message.value.trim().length < 5) {
                error.value = t("A message for the merchant is required");
                return;
            }
            saving.value = true;
            error.value = null;
            try {
                const url = isReplacement.value
                    ? urlsMap.kybDocumentReplacement(props.document.id)
                    : urlsMap.kybDocumentRevalidation(props.document.id);
                await api.post(url, { reasonCode: reasonCode.value, message: message.value.trim() });
                showSnackBar({
                    type: "success",
                    message: t(isReplacement.value ? "Replacement requested" : "Re-verification requested"),
                });
                props.onUpdate(false);
                props.onDone();
            } catch (cause) {
                error.value = extractApiErrorMessage(cause);
            } finally {
                saving.value = false;
            }
        };

        return () => (
            <VDialog
                modelValue={props.open}
                onUpdate:modelValue={(value: boolean) => props.onUpdate(value)}
                maxWidth="620px"
            >
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {t(isReplacement.value ? "Request document replacement" : "Request KYB re-verification")}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {props.document?.docType} · {props.document?.merchantName}
                        </ThemedText>
                        <VAlert type={isReplacement.value ? "warning" : "info"} variant="tonal">
                            {isReplacement.value
                                ? t("The current document will be rejected, the join request will move to INFO_REQUESTED, and its SLA will pause until the merchant responds.")
                                : t("A periodic re-verification request will be opened for the merchant. The current document remains available as historical evidence.")}
                        </VAlert>
                        <VSelect v-model={reasonCode.value} label={t("Reason")} items={REVIEW_REASON_CODES} />
                        <VTextarea v-model={message.value} label={t("Message to the merchant")} rows={4} autoGrow />
                        {error.value && <VAlert type="error" variant="tonal">{error.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => props.onUpdate(false)}>{t("Cancel")}</VBtn>
                            <VBtn color="warning" loading={saving.value} onClick={() => void submit()}>
                                {t(isReplacement.value ? "Reject and request replacement" : "Open re-verification")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        );
    },
    { props: ["open", "mode", "document", "onUpdate", "onDone"] },
);

export default KybActionDialog;
