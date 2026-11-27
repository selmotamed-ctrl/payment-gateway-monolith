import { dc } from "@/utils/dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {PgAlert, PgAutocomplete, PgTextarea, PgTextField} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import { areChecklistsVisible } from "@/constants/env";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { REVIEW_REASON_CODES } from "../kybReviewHelp";
import type { KybDocumentSummary } from "../types";

import {FormModal} from "@pg/ui";
import {SegmentedTabs} from "@pg/ui";
import {FormField} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
const REVIEW_CHECKS = [
    { key: "DOCUMENT_IDENTITY_VERIFIED", label: "Document identity and merchant matched" },
    { key: "FILE_INTEGRITY_REVIEWED", label: "File integrity and malware status reviewed" },
    { key: "EXPIRY_REVIEWED", label: "Expiry posture reviewed" },
    { key: "DECISION_AUTHORITY_CONFIRMED", label: "Decision authority confirmed" },
] as const;

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
        const showChecklists = areChecklistsVisible();
        const checklist = ref<Record<string, boolean>>({});
        const checklistComplete = computed(() => !showChecklists || REVIEW_CHECKS.every((check) => checklist.value[check.key] === true));

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
                checklist.value = {};
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
            if (!checklistComplete.value) {
                error.value = t("Complete all document review checklist items before saving");
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
                    checklist: REVIEW_CHECKS.filter((check) => checklist.value[check.key]).map((check) => check.key),
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
            <FormModal
                modelValue={props.open}
                onUpdate:modelValue={(value: boolean) => props.onUpdate(value)}
                title={t("Review KYB document")}
                size="md"
                onSubmit={() => void submit()}
                submitLabel={t("Save decision")}
                cancelLabel={t("Cancel")}
                loading={saving.value}
                danger={decision.value === "REJECTED"}
                errorMessage={error.value ?? ""}
            >
<ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                            {props.document?.docType} · {props.document?.originalFileName || props.document?.id}
                        </ThemedText>
                        {duplicate.value && (
                            <PgAlert tone="warning">
                                {t("This file hash is also present under another merchant. Acceptance requires a written justification.")}
                            </PgAlert>
                        )}
                        <SegmentedTabs
                            modelValue={decision.value}
                            tabs={[
                                { value: "ACCEPTED", label: t("Accept") },
                                { value: "REJECTED", label: t("Reject") },
                            ]}
                            onUpdate:modelValue={(value: string) => (decision.value = value === "REJECTED" ? "REJECTED" : "ACCEPTED")}
                        />
                        {decision.value === "ACCEPTED" ? (
                            <>
                                <FormField label={t("Expiry date (YYYY-MM-DD, optional)")}>
                                    <PgTextField v-model={expiresOn.value} />
                                </FormField>
                                {duplicate.value && (
                                    <FormField label={t("Duplicate justification (required, at least 10 characters)")} required>
                                        <PgTextarea v-model={duplicateJustification.value} rows={3} autoGrow />
                                    </FormField>
                                )}
                            </>
                        ) : (
                            <FormField label={t("Rejection reason")} required>
                                <PgAutocomplete v-model={reasonCode.value} items={REVIEW_REASON_CODES} />
                            </FormField>
                        )}
                        <FormField label={t("Reviewer notes")}>
                            <PgTextarea v-model={notes.value} rows={3} autoGrow />
                        </FormField>
                        <FormChecklist
                            checks={[...REVIEW_CHECKS]}
                            modelValue={checklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (checklist.value = value)}
                            show={showChecklists}
                            title={t("Document review checklist")}
                            complete={checklistComplete.value}
                            incompleteMessage={t("Complete all document review checklist items before saving")}
                        />
            </FormModal>
        );
    },
    { props: ["open", "document", "initialDecision", "onUpdate", "onDone"] },
);

export default KybReviewDialog;
