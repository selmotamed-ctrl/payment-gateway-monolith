import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
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

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { describeAuditChange } from "@/utils/auditSummary";
const parse = (payload: unknown): KybDocumentDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    return (source.kybDocument ?? source) as KybDocumentDetail;
};

const detailItem = (label: string, value: unknown, _hint?: string, _source?: string, mono = false): DescriptionItem => ({
    label,
    value:
        value === null || value === undefined || value === ""
            ? "—"
            : mono
              ? <MonoRef value={String(value)} />
              : String(value),
});

const auditChangeSummary = (entry: { beforeJson?: unknown; afterJson?: unknown }): string =>
    describeAuditChange(entry.beforeJson, entry.afterJson);

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
                items: [
                    detailItem("Document ID", entry.id, "The KYB document database identifier.", "kyb_documents.id", true),
                    detailItem("Document type", typeHelp.label, typeHelp.meaning, "kyb_documents.doc_type"),
                    detailItem("Subject type", entry.subjectType, COLUMN_HELP.subject, "kyb_documents.subject_type"),
                    detailItem("Subject", entry.subjectName || entry.subjectId, "The merchant or beneficial owner the document belongs to.", "kyb_documents.subject_id"),
                    detailItem("File name", entry.originalFileName, "Original upload file name.", "kyb_documents.original_file_name"),
                    detailItem("MIME type", entry.mime, "Stored MIME type after magic-byte validation.", "kyb_documents.mime"),
                    detailItem("Size", formatBytes(entry.sizeBytes), "Stored file size.", "kyb_documents.size_bytes"),
                    detailItem("SHA-256", entry.sha256, "Content hash used for duplicate-document detection.", "kyb_documents.sha256", true),
                    detailItem("Uploaded at", formatDateTime(entry.createdAt), COLUMN_HELP.uploaded, "kyb_documents.created_at"),
                    detailItem("Uploaded by", entry.uploadedBy?.email, COLUMN_HELP.uploaded, "kyb_documents.uploaded_by"),
                ],
            },
            {
                title: t("Status and integrity"),
                description: "A document is only reviewable when it is uploaded, unexpired and the antivirus scan is clean.",
                items: [
                    detailItem("Document status", statusHelp.label, statusHelp.meaning, "kyb_documents.status"),
                    detailItem("AV scan", avHelp.label, avHelp.meaning, "kyb_documents.av_status"),
                    detailItem("Expiry state", expiry.label, expiry.meaning, "kyb_documents.expires_on"),
                    detailItem("Expiry date", formatDateTime(entry.expiresOn), COLUMN_HELP.expiry, "kyb_documents.expires_on"),
                    detailItem("Days until expiry", entry.daysUntilExpiry, "Negative values mean the document has expired.", "kyb_documents.expires_on"),
                    detailItem("Content available", entry.contentAvailable ? t("Yes") : t("No"), "Whether encrypted content exists for secure preview.", "kyb_documents.content_ciphertext IS NOT NULL"),
                    detailItem("Status changed at", formatDateTime(entry.statusChangedAt), "When the document status last changed.", "kyb_documents.status_changed_at"),
                    detailItem("Expired at", formatDateTime(entry.expiredAt), "When the lifecycle worker marked the document expired.", "kyb_documents.expired_at"),
                ],
            },
            {
                title: t("Merchant"),
                items: [
                    detailItem("Trade name", entry.merchant?.tradeName, "Customer-facing merchant name.", "merchants.tradeName"),
                    detailItem("Legal name", entry.merchant?.legalName, "Registered legal entity name.", "merchants.legalName", true),
                    detailItem("Merchant ID", entry.merchantId, "Merchant database identifier.", "merchants.id", true),
                    detailItem("Merchant status", entry.merchant?.status, "Merchant lifecycle state.", "merchants.status"),
                    detailItem("KYB status", entry.merchant?.kybStatus, "Merchant KYB state, recomputed from required evidence.", "merchants.kyb_status"),
                    detailItem("Risk tier", entry.merchant?.riskTier, "Current merchant risk tier.", "merchants.risk_tier"),
                    detailItem("Business category", entry.merchant?.businessCategory, "Category used by required-document rules.", "merchants.businessCategory"),
                    detailItem("Country", entry.merchant?.country, "Merchant country code.", "merchants.country"),
                    detailItem("Contact phone", entry.merchant?.contactPhone, "Merchant contact phone.", "merchants.contactPhone", true),
                    detailItem("Contact email", entry.merchant?.contactEmail, "Merchant contact email.", "merchants.contactEmail", true),
                ],
            },
            {
                title: t("Join request context"),
                items: entry.joinRequest
                    ? [
                          detailItem("Join request ID", entry.joinRequest.id, "The onboarding request that owns this document.", "join_requests.id", true),
                          detailItem("Request status", entry.joinRequest.status, "Current join-request state.", "join_requests.status"),
                          detailItem("Onboarding channel", entry.joinRequest.onboardingChannel, COLUMN_HELP.request, "join_requests.onboarding_channel"),
                          detailItem("Proposed risk tier", entry.joinRequest.proposedRiskTier, "Risk tier proposed by the reviewer.", "join_requests.proposed_risk_tier"),
                          detailItem("SLA due", formatDateTime(entry.joinRequest.slaDueAt), "Onboarding review SLA.", "join_requests.sla_due_at"),
                          detailItem("SLA paused", entry.joinRequest.slaPausedAt ? t("Yes") : t("No"), "Information requests pause the SLA.", "join_requests.sla_paused_at"),
                          detailItem("Assignee", entry.joinRequest.assignedReviewer?.email, COLUMN_HELP.request, "join_requests.assigned_reviewer_id"),
                      ]
                    : [detailItem("Join request", t("No open join request"), "This document belongs to an active merchant or a closed request.")],
            },
            {
                title: t("Review evidence"),
                items: [
                    detailItem("Reviewed by", entry.reviewedBy?.email, COLUMN_HELP.reviewed, "kyb_documents.reviewed_by"),
                    detailItem("Reviewed at", formatDateTime(entry.reviewedAt), COLUMN_HELP.reviewed, "kyb_documents.reviewed_at"),
                    detailItem("Rejection reason", entry.rejectionReasonCode, "Closed reason code used when the document was rejected.", "kyb_documents.rejection_reason_code"),
                    detailItem("Review notes", entry.reviewNotes, "Reviewer notes recorded with the decision.", "kyb_documents.review_notes"),
                    detailItem("Duplicate justification", entry.duplicateJustification, "Required written justification when a duplicate hash is accepted.", "kyb_documents.duplicate_justification"),
                    detailItem("Duplicate merchants", entry.duplicateMerchantCount, COLUMN_HELP.duplicate, "kyb_documents.sha256"),
                ],
            },
        ].filter((section) => section.items.length > 0);
    });

    const readiness = computed(() => document.value?.readiness ?? null);
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;

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
                        subtitle={t("Inspect document identity, scanning status, expiry evidence and duplicate-document risk.")}
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
                            <StatusBadge status={entry.status} label={statusHelp.label} toneOverride={asBadgeTone(statusHelp.tone)} />
                        </span>
                        <span title={avHelp.meaning}>
                            <StatusBadge status={entry.avStatus} label={avHelp.label} toneOverride={asBadgeTone(avHelp.tone)} />
                        </span>
                        {entry.expiryState !== entry.status && (
                            <StatusBadge status={entry.expiryState} label={expiry.label} toneOverride={asBadgeTone(expiry.tone)} />
                        )}
                        {entry.duplicateMerchantCount > 0 && (
                            <StatusBadge status="duplicate" label={`${entry.duplicateMerchantCount} duplicate merchants`} toneOverride="warning" />
                        )}
                        {entry.status === "UPLOADED" && entry.avStatus === "CLEAN" && entry.expiryState !== "EXPIRED" && (
                            <StatusBadge status="Actionable" label={t("Actionable")} toneOverride="success" />
                        )}
                    </ThemedView>

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Document identifiers")}</ThemedText>
                            <DescriptionList
                                columns={2}
                                items={[
                                    { label: t("Document ID"), value: <MonoRef value={entry.id} /> },
                                    { label: t("SHA-256"), value: <MonoRef value={entry.sha256} truncate={32} /> },
                                    { label: t("Merchant ID"), value: <MonoRef value={entry.merchantId} /> },
                                    { label: t("Join request ID"), value: <MonoRef value={entry.joinRequestId ?? ""} /> },
                                    { label: t("File name"), value: entry.originalFileName || "—" },
                                    { label: t("Document status"), value: statusHelp.label },
                                ]}
                            />
                        </SurfaceCardText>
                    </SurfaceCard>

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
                        <SurfaceCard>
                            <SurfaceCardText>
                                <KybHelpPanel />
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {sections.value.map((section) => (
                        <SurfaceCard key={section.title}>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{section.title}</ThemedText>
                                {("description" in section && section.description) && (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{section.description}</ThemedText>
                                )}
                                <DescriptionList columns={2} items={section.items} />
                            </SurfaceCardText>
                        </SurfaceCard>
                    ))}

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px", flex: 1 }}>{t("Audit trail")}</ThemedText>
                                <StatusBadge status="neutral" label={`${entry.auditTrail?.length ?? 0} ${t("events")}`} toneOverride="neutral" showDot={false} />
                            </ThemedView>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                {t("Last 100 recorded actions on this document, newest first.")}
                            </ThemedText>
                            {(entry.auditTrail ?? []).length === 0 && (
                                <EmptyState title={t("No audit events recorded yet.")} icon="mdi-history" />
                            )}
                            {(entry.auditTrail ?? []).map((event) => {
                                const change = auditChangeSummary(event);
                                return (
                                    <ThemedView
                                        key={event.id}
                                        style={{
                                            gap: "4px",
                                            padding: "10px 12px",
                                            borderRadius: "var(--pg-radius-lg)",
                                            border: "1px solid var(--pg-border-subtle)",
                                        }}
                                    >
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>
                                                {event.action.replaceAll("_", " ")}
                                            </ThemedText>
                                            <StatusBadge status={event.role} label={event.role} toneOverride="info" />
                                            {event.approvalRequestId && (
                                                <StatusBadge status="Approval linked" label={t("Approval linked")} toneOverride="warning" />
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
                        </SurfaceCardText>
                    </SurfaceCard>

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Secure preview")}</ThemedText>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                {t("Only clean, scanned files can be opened. Every preview is written to the audit log.")}
                            </ThemedText>
                            <KybDocumentPreview document={entry} />
                        </SurfaceCardText>
                    </SurfaceCard>

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Duplicate investigation")}</ThemedText>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{COLUMN_HELP.duplicate}</ThemedText>
                            {entry.duplicateMatches.length === 0 ? (
                                <EmptyState
                                    title={t("No cross-merchant duplicate was found for this hash.")}
                                    description={COLUMN_HELP.duplicate}
                                    icon="mdi-content-duplicate"
                                />
                            ) : (
                                entry.duplicateMatches.map((match) => (
                                    <SurfaceCard key={match.id} variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                <ThemedText type="defaultSemiBold">
                                                    {match.merchant.tradeName || match.merchant.legalName}
                                                </ThemedText>
                                                <StatusBadge status={match.status} label={match.status} toneOverride={asBadgeTone(statusTone(match.status))} />
                                                <StatusBadge status={match.merchant.kybStatus} label={match.merchant.kybStatus} toneOverride={asBadgeTone(statusTone(match.merchant.kybStatus))} />
                                                {match.joinRequest && (
                                                    <StatusBadge status={match.joinRequest.status} label={match.joinRequest.status} toneOverride={asBadgeTone(statusTone(match.joinRequest.status))} />
                                                )}
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                    {documentTypeHelp(match.docType).label} · {formatDateTime(match.createdAt)}
                                                </ThemedText>
                                                <MonoRef value={match.merchantId} truncate={18} />
                                            </ThemedView>
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
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                ))
                            )}
                        </SurfaceCardText>
                    </SurfaceCard>

                    {readiness.value && (
                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Join request readiness")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    <StatusBadge status={readiness.value.ready ? "Ready" : "Blocked"} label={readiness.value.ready ? t("Ready") : t("Blocked")} toneOverride={readiness.value.ready ? "success" : "warning"} />
                                    <StatusBadge status="owners" label={`${t("Owners")} ${readiness.value.ownersTotal}% / ${readiness.value.ownerThreshold}%`} toneOverride={readiness.value.ownersReady ? "success" : "warning"} />
                                    <StatusBadge status="screening" label={`${t("Screening")}: ${readiness.value.screeningResult ?? "—"}`} toneOverride={readiness.value.screeningBlocked ? "warning" : "success"} />
                                </ThemedView>
                                {readiness.value.blockers.length > 0 && readiness.value.blockers.map((blocker) => (
                                    <ThemedText key={blocker} style={{ fontSize: "13px" }}>• {blockerLabel(blocker)}</ThemedText>
                                ))}
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px", marginTop: "4px" }}>{t("Required documents")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                    {readiness.value.requiredDocuments.map((required) => (
                                        <StatusBadge
                                            key={required}
                                            status={required}
                                            label={required}
                                            toneOverride={readiness.value?.acceptedDocuments.includes(required) ? "success" : "warning"}
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
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {entry.openRevalidations.length > 0 && (
                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Open re-verification requests")}</ThemedText>
                                {entry.openRevalidations.map((revalidation) => (
                                    <SurfaceCard key={revalidation.id} variant="tonal">
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusBadge status={revalidation.status} label={revalidation.status} toneOverride={asBadgeTone(statusTone(revalidation.status))} />
                                                <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>{revalidation.docType}</ThemedText>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "12px" }}>{revalidation.message}</ThemedText>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                                                {t("Due")}: {formatDateTime(revalidation.dueAt)}
                                            </ThemedText>
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
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
