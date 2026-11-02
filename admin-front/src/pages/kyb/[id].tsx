import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import FieldsSections from "@/components/FieldsSections";
import type { FieldProps } from "@/components/Field";
import { statusTone } from "@/components/Table/statusTone";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { areHelpPanelsVisible } from "@/constants/env";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import {
    COLUMN_HELP,
    avStatusHelp,
    blockerLabel,
    documentStatusHelp,
    documentTypeHelp,
    expiryHelp,
    formatBytes,
    formatDateTime,
} from "./kybReviewHelp";
import type { KybAuditEntry, KybDocumentDetail } from "./types";
import KybHelpPanel from "./components/KybHelpPanel";
import KybDocumentPreview from "./components/KybDocumentPreview";
import KybReviewDialog from "./components/KybReviewDialog";
import KybActionDialog, { type KybActionMode } from "./components/KybActionDialog";

const parse = (payload: unknown): KybDocumentDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    return (source.kybDocument ?? source) as KybDocumentDetail;
};

const field = (text: string, value: unknown, hint?: string, source?: string, copy = false): FieldProps => ({
    text,
    value: value === null || value === undefined ? "" : String(value),
    hint,
    source,
    copyOnClick: copy,
});

const auditValue = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        const text = JSON.stringify(value);
        return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    } catch {
        return String(value);
    }
};

const auditRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const auditChangeSummary = (entry: KybAuditEntry): string => {
    const before = auditRecord(entry.beforeJson);
    const after = auditRecord(entry.afterJson);
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).slice(0, 4);
    if (keys.length === 0) return "";
    return keys.map((key) => `${key}: ${auditValue(before[key])} → ${auditValue(after[key])}`).join(" · ");
};

const KybReviewDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const document = ref<KybDocumentDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const reviewOpen = ref(false);
    const reviewDecision = ref<"ACCEPTED" | "REJECTED">("ACCEPTED");
    const actionOpen = ref(false);
    const actionMode = ref<KybActionMode>("REPLACEMENT");

    const documentId = computed(() => String(route.params.id ?? ""));

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.kybDocumentDetail(documentId.value));
            document.value = parse(response.data?.data ?? response.data ?? {});
        } catch (cause) {
            error.value = extractApiErrorMessage(cause);
            document.value = null;
        } finally {
            loading.value = false;
        }
    };

    watch(documentId, () => void load());
    void load();

    const openReview = (decision: "ACCEPTED" | "REJECTED") => {
        reviewDecision.value = decision;
        reviewOpen.value = true;
    };

    const openAction = () => {
        actionMode.value = document.value?.canRequestReplacement ? "REPLACEMENT" : "REVALIDATION";
        actionOpen.value = true;
    };

    const sections = computed(() => {
        const entry = document.value;
        if (!entry) return [];
        const typeHelp = documentTypeHelp(entry.docType);
        const statusHelp = documentStatusHelp(entry.status);
        const avHelp = avStatusHelp(entry.avStatus);
        const expiry = expiryHelp(entry.expiryState);
        const readiness = entry.readiness;
        return [
            {
                title: t("Document identity"),
                description: COLUMN_HELP.documentType,
                fields: [
                    field("Document ID", entry.id, "The KYB document database identifier.", "kyb_documents.id", true),
                    field("Document type", typeHelp.label, typeHelp.meaning, "kyb_documents.doc_type"),
                    field("Subject type", entry.subjectType, COLUMN_HELP.subject, "kyb_documents.subject_type"),
                    field("Subject", entry.subjectName || entry.subjectId, "The merchant or beneficial owner the document belongs to.", "kyb_documents.subject_id"),
                    field("File name", entry.originalFileName, "Original upload file name.", "kyb_documents.original_file_name"),
                    field("MIME type", entry.mime, "Stored MIME type after magic-byte validation.", "kyb_documents.mime"),
                    field("Size", formatBytes(entry.sizeBytes), "Stored file size.", "kyb_documents.size_bytes"),
                    field("SHA-256", entry.sha256, "Content hash used for duplicate-document detection.", "kyb_documents.sha256", true),
                    field("Uploaded at", formatDateTime(entry.createdAt), COLUMN_HELP.uploaded, "kyb_documents.created_at"),
                    field("Uploaded by", entry.uploadedBy?.email, COLUMN_HELP.uploaded, "kyb_documents.uploaded_by"),
                ],
            },
            {
                title: t("Status and integrity"),
                description: "A document is only reviewable when it is uploaded, unexpired and the antivirus scan is clean.",
                fields: [
                    field("Document status", statusHelp.label, statusHelp.meaning, "kyb_documents.status"),
                    field("AV scan", avHelp.label, avHelp.meaning, "kyb_documents.av_status"),
                    field("Expiry state", expiry.label, expiry.meaning, "kyb_documents.expires_on"),
                    field("Expiry date", formatDateTime(entry.expiresOn), COLUMN_HELP.expiry, "kyb_documents.expires_on"),
                    field("Days until expiry", entry.daysUntilExpiry, "Negative values mean the document has expired.", "kyb_documents.expires_on"),
                    field("Content available", entry.contentAvailable ? t("Yes") : t("No"), "Whether encrypted content exists for secure preview.", "kyb_documents.content_ciphertext IS NOT NULL"),
                    field("Status changed at", formatDateTime(entry.statusChangedAt), "When the document status last changed.", "kyb_documents.status_changed_at"),
                    field("Expired at", formatDateTime(entry.expiredAt), "When the lifecycle worker marked the document expired.", "kyb_documents.expired_at"),
                ],
            },
            {
                title: t("Merchant"),
                fields: [
                    field("Trade name", entry.merchant?.tradeName, "Customer-facing merchant name.", "merchants.tradeName"),
                    field("Legal name", entry.merchant?.legalName, "Registered legal entity name.", "merchants.legalName", true),
                    field("Merchant ID", entry.merchantId, "Merchant database identifier.", "merchants.id", true),
                    field("Merchant status", entry.merchant?.status, "Merchant lifecycle state.", "merchants.status"),
                    field("KYB status", entry.merchant?.kybStatus, "Merchant KYB state, recomputed from required evidence.", "merchants.kyb_status"),
                    field("Risk tier", entry.merchant?.riskTier, "Current merchant risk tier.", "merchants.risk_tier"),
                    field("Business category", entry.merchant?.businessCategory, "Category used by required-document rules.", "merchants.businessCategory"),
                    field("Country", entry.merchant?.country, "Merchant country code.", "merchants.country"),
                    field("Contact phone", entry.merchant?.contactPhone, "Merchant contact phone.", "merchants.contactPhone", true),
                    field("Contact email", entry.merchant?.contactEmail, "Merchant contact email.", "merchants.contactEmail", true),
                ],
            },
            {
                title: t("Join request context"),
                fields: entry.joinRequest
                    ? [
                          field("Join request ID", entry.joinRequest.id, "The onboarding request that owns this document.", "join_requests.id", true),
                          field("Request status", entry.joinRequest.status, "Current join-request state.", "join_requests.status"),
                          field("Onboarding channel", entry.joinRequest.onboardingChannel, COLUMN_HELP.request, "join_requests.onboarding_channel"),
                          field("Proposed risk tier", entry.joinRequest.proposedRiskTier, "Risk tier proposed by the reviewer.", "join_requests.proposed_risk_tier"),
                          field("SLA due", formatDateTime(entry.joinRequest.slaDueAt), "Onboarding review SLA.", "join_requests.sla_due_at"),
                          field("SLA paused", entry.joinRequest.slaPausedAt ? t("Yes") : t("No"), "Information requests pause the SLA.", "join_requests.sla_paused_at"),
                          field("Assignee", entry.joinRequest.assignedReviewer?.email, COLUMN_HELP.request, "join_requests.assigned_reviewer_id"),
                      ]
                    : [field("Join request", t("No open join request"), "This document belongs to an active merchant or a closed request.")],
            },
            {
                title: t("Review evidence"),
                fields: [
                    field("Reviewed by", entry.reviewedBy?.email, COLUMN_HELP.reviewed, "kyb_documents.reviewed_by"),
                    field("Reviewed at", formatDateTime(entry.reviewedAt), COLUMN_HELP.reviewed, "kyb_documents.reviewed_at"),
                    field("Rejection reason", entry.rejectionReasonCode, "Closed reason code used when the document was rejected.", "kyb_documents.rejection_reason_code"),
                    field("Review notes", entry.reviewNotes, "Reviewer notes recorded with the decision.", "kyb_documents.review_notes"),
                    field("Duplicate justification", entry.duplicateJustification, "Required written justification when a duplicate hash is accepted.", "kyb_documents.duplicate_justification"),
                    field("Duplicate merchants", entry.duplicateMerchantCount, COLUMN_HELP.duplicate, "kyb_documents.sha256"),
                ],
            },
        ].filter((section) => section.fields.length > 0);
    });

    const readiness = computed(() => document.value?.readiness ?? null);

    return () => {
        if (loading.value) {
            return (
                <ScreenContainer>
                    <StateView loading onRetry={() => void load()} />
                </ScreenContainer>
            );
        }
        if (error.value || !document.value) {
            return (
                <ScreenContainer>
                    <StateView error={error.value ?? "KYB document not found"} onRetry={() => void load()} />
                </ScreenContainer>
            );
        }
        const entry = document.value;
        const typeHelp = documentTypeHelp(entry.docType);
        const statusHelp = documentStatusHelp(entry.status);
        const avHelp = avStatusHelp(entry.avStatus);
        const expiry = expiryHelp(entry.expiryState);
        return (
            <ScreenContainer>
                <ThemedView style={{ gap: "18px" }}>
                    <PageHeader
                        title={`${typeHelp.label} · ${entry.merchantName}`}
                        end={() => (
                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "KybReview" })}>
                                    {t("Queue")}
                                </VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
                                    {t("Refresh")}
                                </VBtn>
                                {entry.joinRequestId && (
                                    <VBtn
                                        variant="tonal"
                                        prependIcon="mdi-clipboard-account-outline"
                                        onClick={() => void router.push({ name: "JoinRequestDetail", params: { id: entry.joinRequestId } })}
                                    >
                                        {t("Join request")}
                                    </VBtn>
                                )}
                                {entry.canReview && (
                                    <>
                                        <VBtn color="success" prependIcon="mdi-check-decagram-outline" onClick={() => openReview("ACCEPTED")}>
                                            {t("Accept")}
                                        </VBtn>
                                        <VBtn color="error" variant="tonal" prependIcon="mdi-close-octagon-outline" onClick={() => openReview("REJECTED")}>
                                            {t("Reject")}
                                        </VBtn>
                                    </>
                                )}
                                {(entry.canRequestReplacement || entry.canRequestRevalidation) && (
                                    <VBtn color="warning" variant="tonal" prependIcon="mdi-file-replace-outline" onClick={openAction}>
                                        {t(entry.canRequestReplacement ? "Request replacement" : "Request re-verification")}
                                    </VBtn>
                                )}
                            </ThemedView>
                        )}
                    />

                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                        <span title={statusHelp.meaning}>
                            <StatusChip label={statusHelp.label} tone={statusHelp.tone} />
                        </span>
                        <span title={avHelp.meaning}>
                            <StatusChip label={avHelp.label} tone={avHelp.tone} />
                        </span>
                        <StatusChip label={expiry.label} tone={expiry.tone} />
                        {entry.duplicateMerchantCount > 0 && (
                            <StatusChip label={`${entry.duplicateMerchantCount} duplicate merchants`} tone="warning" />
                        )}
                        {entry.status === "UPLOADED" && entry.avStatus === "CLEAN" && entry.expiryState !== "EXPIRED" && (
                            <StatusChip label={t("Actionable")} tone="success" />
                        )}
                    </ThemedView>

                    {entry.avStatus !== "CLEAN" && (
                        <VAlert type={entry.avStatus === "INFECTED" ? "error" : "warning"} variant="tonal">
                            {t(avHelp.meaning)}
                        </VAlert>
                    )}
                    {entry.expiryState === "EXPIRED" && (
                        <VAlert type="error" variant="tonal">
                            {t("This document has expired and cannot be accepted as current evidence. Request a replacement or active-merchant re-verification.")}
                        </VAlert>
                    )}
                    {!entry.contentAvailable && (
                        <VAlert type="info" variant="tonal">
                            {t("The encrypted content is not available for this legacy record. The metadata and decision are still auditable.")}
                        </VAlert>
                    )}

                    {areHelpPanelsVisible() && (
                        <VCard>
                            <VCardText>
                                <KybHelpPanel />
                            </VCardText>
                        </VCard>
                    )}

                    <FieldsSections sections={sections.value} />

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px", flex: 1 }}>{t("Audit trail")}</ThemedText>
                                <StatusChip label={`${entry.auditTrail?.length ?? 0} ${t("events")}`} tone="neutral" size="x-small" />
                            </ThemedView>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                {t("Last 100 recorded actions on this document, newest first.")}
                            </ThemedText>
                            {(entry.auditTrail ?? []).length === 0 && (
                                <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No audit events recorded yet.")}</ThemedText>
                            )}
                            {(entry.auditTrail ?? []).map((event) => {
                                const change = auditChangeSummary(event);
                                return (
                                    <ThemedView
                                        key={event.id}
                                        style={{
                                            gap: "4px",
                                            padding: "10px 12px",
                                            borderRadius: "10px",
                                            border: "1px solid rgba(100,116,139,0.2)",
                                        }}
                                    >
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>
                                                {event.action.replaceAll("_", " ")}
                                            </ThemedText>
                                            <StatusChip label={event.role} tone="info" size="x-small" />
                                            {event.approvalRequestId && (
                                                <StatusChip label={t("Approval linked")} tone="warning" size="x-small" />
                                            )}
                                            <div style={{ flex: 1 }} />
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(event.createdAt)}</ThemedText>
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                            {event.actor?.email ?? "—"}
                                        </ThemedText>
                                        {change && (
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.75, direction: "ltr" }}>
                                                {change}
                                            </ThemedText>
                                        )}
                                    </ThemedView>
                                );
                            })}
                        </VCardText>
                    </VCard>

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Secure preview")}</ThemedText>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                {t("Only clean, scanned files can be opened. Every preview is written to the audit log.")}
                            </ThemedText>
                            <KybDocumentPreview document={entry} />
                        </VCardText>
                    </VCard>

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Duplicate investigation")}</ThemedText>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{COLUMN_HELP.duplicate}</ThemedText>
                            {entry.duplicateMatches.length === 0 ? (
                                <ThemedText style={{ opacity: 0.6 }}>{t("No cross-merchant duplicate was found for this hash.")}</ThemedText>
                            ) : (
                                entry.duplicateMatches.map((match) => (
                                    <VCard key={match.id} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                <ThemedText type="defaultSemiBold">
                                                    {match.merchant.tradeName || match.merchant.legalName}
                                                </ThemedText>
                                                <StatusChip label={match.status} tone={statusTone(match.status)} size="x-small" />
                                                <StatusChip label={match.merchant.kybStatus} tone={statusTone(match.merchant.kybStatus)} size="x-small" />
                                                {match.joinRequest && (
                                                    <StatusChip label={match.joinRequest.status} tone={statusTone(match.joinRequest.status)} size="x-small" />
                                                )}
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                {documentTypeHelp(match.docType).label} · {formatDateTime(match.createdAt)} · {match.merchantId}
                                            </ThemedText>
                                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                                <VBtn size="x-small" variant="text" onClick={() => void router.push({ name: "KybReviewDetail", params: { id: match.id } })}>
                                                    {t("Open duplicate document")}
                                                </VBtn>
                                                {match.joinRequestId && (
                                                    <VBtn
                                                        size="x-small"
                                                        variant="text"
                                                        onClick={() => void router.push({ name: "JoinRequestDetail", params: { id: match.joinRequestId } })}
                                                    >
                                                        {t("Open related join request")}
                                                    </VBtn>
                                                )}
                                            </ThemedView>
                                        </VCardText>
                                    </VCard>
                                ))
                            )}
                        </VCardText>
                    </VCard>

                    {readiness.value && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Join request readiness")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    <StatusChip label={readiness.value.ready ? t("Ready") : t("Blocked")} tone={readiness.value.ready ? "success" : "warning"} />
                                    <StatusChip label={`${t("Owners")} ${readiness.value.ownersTotal}% / ${readiness.value.ownerThreshold}%`} tone={readiness.value.ownersReady ? "success" : "warning"} />
                                    <StatusChip label={`${t("Screening")}: ${readiness.value.screeningResult ?? "—"}`} tone={readiness.value.screeningBlocked ? "warning" : "success"} />
                                </ThemedView>
                                {readiness.value.blockers.length > 0 && readiness.value.blockers.map((blocker) => (
                                    <ThemedText key={blocker} style={{ fontSize: "13px" }}>• {blockerLabel(blocker)}</ThemedText>
                                ))}
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px", marginTop: "4px" }}>{t("Required documents")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    {readiness.value.requiredDocuments.map((required) => (
                                        <StatusChip
                                            key={required}
                                            label={required}
                                            tone={readiness.value?.acceptedDocuments.includes(required) ? "success" : "warning"}
                                            size="x-small"
                                        />
                                    ))}
                                </ThemedView>
                                {entry.joinRequestId && (
                                    <VBtn
                                        size="small"
                                        variant="text"
                                        prependIcon="mdi-clipboard-check-outline"
                                        onClick={() => void router.push({ name: "JoinRequestDetail", params: { id: entry.joinRequestId } })}
                                    >
                                        {t("Open checklist and decision")}
                                    </VBtn>
                                )}
                            </VCardText>
                        </VCard>
                    )}

                    {entry.openRevalidations.length > 0 && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Open re-verification requests")}</ThemedText>
                                {entry.openRevalidations.map((revalidation) => (
                                    <VCard key={revalidation.id} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusChip label={revalidation.status} tone={statusTone(revalidation.status)} size="x-small" />
                                                <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>{revalidation.docType}</ThemedText>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "12px" }}>{revalidation.message}</ThemedText>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                                {t("Due")}: {formatDateTime(revalidation.dueAt)}
                                            </ThemedText>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </VCardText>
                        </VCard>
                    )}
                </ThemedView>

                <KybReviewDialog
                    open={reviewOpen.value}
                    document={document.value}
                    initialDecision={reviewDecision.value}
                    onUpdate={(value) => (reviewOpen.value = value)}
                    onDone={() => void load()}
                />
                <KybActionDialog
                    open={actionOpen.value}
                    mode={actionMode.value}
                    document={document.value}
                    onUpdate={(value) => (actionOpen.value = value)}
                    onDone={() => void load()}
                />
            </ScreenContainer>
        );
    };
});

export default KybReviewDetailPage;
