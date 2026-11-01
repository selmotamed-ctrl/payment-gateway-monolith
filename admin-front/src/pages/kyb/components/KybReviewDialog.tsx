import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VBtnToggle, VCard, VCardText, VDialog, VSelect, VTextarea, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { REVIEW_REASON_CODES } from "../kybReviewHelp";
import type { KybDocumentSummary } from "../types";

const KybReviewDialog = dc(
    (props: {
        open: boolean;
        document: KybDocumentSummary | null;
        initialDecision?: "ACCEPTED" | "REJECTED";
        onUpdate: (open: boolean) => void;
        onDone: () => void;
    }) => {
        const { t } = useLocale();
        const decision = ref<"ACCEPTED" | "REJECTED">("ACCEPTED");
        const reasonCode = ref("BLURRY_OR_UNREADABLE");
        const notes = ref("");
        const duplicateJustification = ref("");
        const expiresOn = ref("");
        const error = ref<string | null>(null);
        const saving = ref(false);

        const duplicate = computed(() => Boolean(props.document && props.document.duplicateMerchantCount > 0));
        const requiresJustification = computed(
            () => decision.value === "ACCEPTED" && duplicate.value && duplicateJustification.value.trim().length < 10,
        );

        watch(
            () => [props.open, props.document?.id, props.initialDecision] as const,
            ([open]) => {
                if (!open) return;
                decision.value = props.initialDecision ?? "ACCEPTED";
                reasonCode.value = "BLURRY_OR_UNREADABLE";
                notes.value = "";
                duplicateJustification.value = "";
                expiresOn.value = props.document?.expiresOn?.slice(0, 10) ?? "";
                error.value = null;
            },
            { immediate: true },
        );

        const submit = async () => {
            if (!props.document) return;
            if (decision.value === "REJECTED" && !reasonCode.value) {
                error.value = t("A rejection reason is required");
                return;
            }
            if (requiresJustification.value) {
                error.value = t("A written duplicate justification of at least 10 characters is required");
                return;
            }
            saving.value = true;
            error.value = null;
            try {
                await api.post(urlsMap.kybDocumentReview(props.document.id), {
                    decision: decision.value,
                    reasonCode: decision.value === "REJECTED" ? reasonCode.value : undefined,
                    notes: notes.value.trim() || undefined,
                    duplicateJustification: decision.value === "ACCEPTED" ? duplicateJustification.value.trim() || undefined : undefined,
                    expiresOn: expiresOn.value || undefined,
                });
                showSnackBar({
                    type: "success",
                    message: t(decision.value === "ACCEPTED" ? "Document accepted" : "Document rejected"),
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
                maxWidth="680px"
                scrollable
            >
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                            {t("Review KYB document")}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {props.document?.docType} · {props.document?.originalFileName || props.document?.id}
                        </ThemedText>
                        {duplicate.value && (
                            <VAlert type="warning" variant="tonal">
                                {t("This file hash is also present under another merchant. Acceptance requires a written justification.")}
                            </VAlert>
                        )}
                        <VBtnToggle
                            modelValue={decision.value}
                            onUpdate:modelValue={(value: unknown) => value && (decision.value = value as "ACCEPTED" | "REJECTED")}
                            mandatory
                            divided
                            variant="outlined"
                        >
                            <VBtn value="ACCEPTED">{t("Accept")}</VBtn>
                            <VBtn value="REJECTED">{t("Reject")}</VBtn>
                        </VBtnToggle>
                        {decision.value === "ACCEPTED" ? (
                            <>
                                <VTextField v-model={expiresOn.value} label={t("Expiry date (YYYY-MM-DD, optional)")} />
                                {duplicate.value && (
                                    <VTextarea
                                        v-model={duplicateJustification.value}
                                        label={t("Duplicate justification (required, at least 10 characters)")}
                                        rows={3}
                                        autoGrow
                                    />
                                )}
                            </>
                        ) : (
                            <VSelect v-model={reasonCode.value} label={t("Rejection reason")} items={REVIEW_REASON_CODES} />
                        )}
                        <VTextarea v-model={notes.value} label={t("Reviewer notes")} rows={3} autoGrow />
                        {error.value && <VAlert type="error" variant="tonal">{error.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => props.onUpdate(false)}>{t("Cancel")}</VBtn>
                            <VBtn
                                color={decision.value === "ACCEPTED" ? "success" : "error"}
                                loading={saving.value}
                                disabled={requiresJustification.value}
                                onClick={() => void submit()}
                            >
                                {t("Save decision")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        );
    },
    { props: ["open", "document", "initialDecision", "onUpdate", "onDone"] },
);

export default KybReviewDialog;
