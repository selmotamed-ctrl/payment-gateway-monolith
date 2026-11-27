import { dc } from "@/utils/dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {VAlert, PgAutocomplete, PgTextarea} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { REVIEW_REASON_CODES } from "../kybReviewHelp";
import type { KybDocumentSummary } from "../types";

import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
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
            <FormModal
                modelValue={props.open}
                onUpdate:modelValue={(value: boolean) => props.onUpdate(value)}
                title={t(isReplacement.value ? "Request document replacement" : "Request KYB re-verification")}
                size="md"
                onSubmit={() => void submit()}
                submitLabel={t(isReplacement.value ? "Reject and request replacement" : "Open re-verification")}
                cancelLabel={t("Cancel")}
                loading={saving.value}
                danger={isReplacement.value}
                errorMessage={error.value ?? ""}
            >
<ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {props.document?.docType} · {props.document?.merchantName}
                        </ThemedText>
                        <VAlert type={isReplacement.value ? "warning" : "info"} variant="tonal">
                            {isReplacement.value
                                ? t("The current document will be rejected, the join request will move to INFO_REQUESTED, and its SLA will pause until the merchant responds.")
                                : t("A periodic re-verification request will be opened for the merchant. The current document remains available as historical evidence.")}
                        </VAlert>
                        <FormField label={t("Reason")} required>
                            <PgAutocomplete v-model={reasonCode.value} items={REVIEW_REASON_CODES} />
                        </FormField>
                        <FormField label={t("Message to the merchant")} required>
                            <PgTextarea v-model={message.value} rows={4} autoGrow />
                        </FormField>
            </FormModal>
        );
    },
    { props: ["open", "mode", "document", "onUpdate", "onDone"] },
);

export default KybActionDialog;
