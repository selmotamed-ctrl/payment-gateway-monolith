import { safePreviewMime } from "@/utils/safeBlob";
import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VCheckbox, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { hasOneOfAuthorities, user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";
import { statusTone } from "@/components/Table/statusTone";
import {
    COLUMN_HELP,
    DOCUMENT_TYPES,
    REJECTION_REASONS,
    blockerLabel,
    channelLabel,
    formatDateTime,
    infoRequestedLabel,
    isEditableStatus,
    joinStatusHelp,
    slaInfo,
} from "./joinRequestHelp";
import type {
    BeneficialOwner,
    DuplicateFlag,
    JoinAuditEntry,
    JoinRequestDetail,
    KybDocument,
} from "./types";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
const parse = (payload: unknown): JoinRequestDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    return (source.joinRequest ?? source) as JoinRequestDetail;
};

const asText = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

const jsonRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const detailItem = (
    label: string,
    value: unknown,
    _hint?: string,
    _source?: string,
    mono = false,
): DescriptionItem => ({
    label,
    value:
        value === null || value === undefined || value === ""
            ? "—"
            : mono
              ? <MonoRef value={String(value)} />
              : String(value),
});

const formatBytes = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

type ProfileForm = {
    legalName: string;
    tradeName: string;
    country: string;
    businessCategory: string;
    registrationNumber: string;
    taxId: string;
    registeredAddress: string;
    websiteUrl: string;
    contactPhone: string;
    contactEmail: string;
    expectedMonthlyVolume: string;
    currency: string;
    businessUseDescription: string;
    payoutBankName: string;
    payoutAccount: string;
};

type OwnerForm = {
    fullName: string;
    fullNameEn: string;
    identityType: "NATIONAL_ID" | "PASSPORT";
    identityNumber: string;
    nationality: string;
    dateOfBirth: string;
    ownershipPercent: string;
    role: "OWNER" | "DIRECTOR" | "SIGNATORY" | "CONTROLLER";
    pepDeclared: boolean;
};

const emptyOwner = (): OwnerForm => ({
    fullName: "",
    fullNameEn: "",
    identityType: "NATIONAL_ID",
    identityNumber: "",
    nationality: "LY",
    dateOfBirth: "",
    ownershipPercent: "",
    role: "OWNER",
    pepDeclared: false,
});

const clean = (value: string): string | undefined => (value.trim().length > 0 ? value.trim() : undefined);

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

const auditChangeSummary = (entry: JoinAuditEntry): string => {
    const before = jsonRecord(entry.beforeJson);
    const after = jsonRecord(entry.afterJson);
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).slice(0, 4);
    if (keys.length === 0) return "";
    return keys.map((key) => `${key}: ${auditValue(before[key])} → ${auditValue(after[key])}`).join(" · ");
};

const JoinRequestDetailPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const route = useRoute();
    const router = useRouter();

    const detail = ref<JoinRequestDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const actionLoading = ref(false);
    const checklist = ref<Record<string, boolean>>({});

    const profileOpen = ref(false);
    const profileForm = ref<ProfileForm>({
        legalName: "",
        tradeName: "",
        country: "LY",
        businessCategory: "",
        registrationNumber: "",
        taxId: "",
        registeredAddress: "",
        websiteUrl: "",
        contactPhone: "",
        contactEmail: "",
        expectedMonthlyVolume: "",
        currency: "LYD",
        businessUseDescription: "",
        payoutBankName: "",
        payoutAccount: "",
    });

    const ownerOpen = ref(false);
    const ownerForm = ref<OwnerForm>(emptyOwner());
    const editingOwnerId = ref<string | null>(null);

    const docFileInput = ref<HTMLInputElement | null>(null);
    const docType = ref("COMMERCIAL_REGISTRY");
    const docExpiresOn = ref("");
    const uploadOpen = ref(false);

    const reviewOpen = ref(false);
    const reviewTarget = ref<KybDocument | null>(null);
    const reviewDecision = ref<"ACCEPTED" | "REJECTED">("ACCEPTED");
    const reviewNotes = ref("");
    const reviewExpiresOn = ref("");

    const infoOpen = ref(false);
    const infoMessage = ref("");
    const infoItems = ref("");

    const decisionOpen = ref(false);
    const decision = ref<"APPROVED" | "REJECTED">("APPROVED");
    const decisionReason = ref("POLICY");
    const decisionNotes = ref("");
    const decisionRiskTier = ref("STANDARD");

    const withdrawOpen = ref(false);
    const checkerNotes = ref("");

    const requestId = computed(() => String(route.params.id ?? ""));
    const currentUserId = computed(() => user.value?.userInfo?.id ?? null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.joinRequestDetail(requestId.value));
            detail.value = parse(response.data?.data ?? response.data ?? {});
            const stored = (detail.value?.reviewChecklistJson ?? {}) as Record<string, boolean>;
            checklist.value = Object.fromEntries(
                (detail.value?.checklistKeys ?? []).map((key) => [key, Boolean(stored[key])]),
            );
            if (detail.value?.proposedRiskTier) {
                decisionRiskTier.value = detail.value.proposedRiskTier;
            }
        } catch (cause) {
            error.value = extractApiErrorMessage(cause);
            detail.value = null;
        } finally {
            loading.value = false;
        }
    };

    watch(requestId, () => void load());
    void load();

    const canWrite = computed(() => hasOneOfAuthorities(["joinrequests.review", "kyb.review"]));
    const canCheck = computed(
        () =>
            hasOneOfAuthorities(["approvals.approve", "approvals.reject"]) &&
            detail.value?.approvalRequest?.state === "PENDING_REVIEW" &&
            detail.value?.approvalRequest?.makerUserId !== currentUserId.value,
    );
    const isFinal = computed(() =>
        ["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(detail.value?.status ?? ""),
    );
    const isEditable = computed(() => Boolean(detail.value && isEditableStatus(detail.value.status)));
    const canChecklist = computed(
        () => Boolean(detail.value && ["SUBMITTED", "IN_REVIEW"].includes(detail.value.status)),
    );
    const canDecide = computed(
        () =>
            canWrite.value &&
            Boolean(detail.value && ["SUBMITTED", "IN_REVIEW"].includes(detail.value.status)) &&
            !(detail.value?.onboardingChannel === "ADMIN_ASSISTED" && detail.value?.submittedBy?.id === currentUserId.value),
    );
    const canAssign = computed(() => canWrite.value && !isFinal.value);
    const canRequestInfo = computed(
        () => canWrite.value && Boolean(detail.value && ["SUBMITTED", "IN_REVIEW"].includes(detail.value.status)),
    );
    const canSubmit = computed(() => canWrite.value && isEditable.value);
    const canWithdraw = computed(() => canWrite.value && !isFinal.value);
    const sla = computed(() => slaInfo(detail.value ?? {}));
    const statusHelp = computed(() => joinStatusHelp(detail.value?.status ?? ""));
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
    const profile = computed(() => jsonRecord(detail.value?.profileJson));
    const merchant = computed(() => detail.value?.merchant);
    const payout = computed(() => jsonRecord(merchant.value?.payoutBankDetailsJson));
    const readiness = computed(() => detail.value?.readiness);
    const activeOwners = computed(() => (detail.value?.beneficialOwners ?? []).filter((owner) => owner.active));
    const duplicateFlags = computed(() => detail.value?.readiness?.duplicateFlags ?? detail.value?.duplicateFlagsJson ?? []);
    const checklistComplete = computed(() =>
        !showChecklists || (detail.value?.checklistKeys ?? []).every((key) => Boolean(checklist.value[key])),
    );

    const run = async (task: () => Promise<void>, success: string) => {
        actionLoading.value = true;
        try {
            await task();
            showSnackBar({ type: "success", message: success });
            await load();
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            actionLoading.value = false;
        }
    };

    const assignToMe = () => {
        if (!currentUserId.value) {
            showSnackBar({ type: "error", message: t("Your session does not carry a user id") });
            return;
        }
        void run(
            async () => {
                await api.post(urlsMap.joinRequestAssign(requestId.value), {
                    assigneeUserId: currentUserId.value,
                });
            },
            t("Assigned"),
        );
    };

    const submit = () => void run(async () => {
        await api.post(urlsMap.joinRequestSubmit(requestId.value), {});
    }, t("Submitted for review"));

    const withdraw = () => {
        withdrawOpen.value = false;
        void run(async () => {
            await api.post(urlsMap.joinRequestWithdraw(requestId.value), {});
        }, t("Join request withdrawn"));
    };

    const retryScreening = () => void run(async () => {
        await api.post(urlsMap.joinRequestScreeningRetry(requestId.value), {});
    }, t("Screening refreshed"));

    const saveChecklist = () => void run(async () => {
        await api.patch(urlsMap.joinRequestChecklist(requestId.value), {
            items: Object.fromEntries(
                (detail.value?.checklistKeys ?? []).map((key) => [key, Boolean(checklist.value[key])]),
            ),
        });
    }, t("Review checklist saved"));

    const requestInfo = () => {
        const items = infoItems.value
            .split(/[,\n]/)
            .map((entry) => entry.trim())
            .filter(Boolean);
        if (items.length === 0 || infoMessage.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("Add at least one requested item and a message") });
            return;
        }
        void run(async () => {
            await api.post(urlsMap.joinRequestRequestInfo(requestId.value), {
                requestedItems: items,
                message: infoMessage.value.trim(),
            });
            infoOpen.value = false;
        }, t("Information requested"));
    };

    const closeDecision = () => {
        decisionOpen.value = false;
    };

    const approveJoinSafeguard = useSafeguard("sg-approve-join-request");
    const rejectJoinSafeguard = useSafeguard("sg-reject-join-request");

    const decide = async () => {
        if (decision.value === "APPROVED" && !readiness.value?.ready) {
            showSnackBar({ type: "warning", message: t("All approval blockers must be cleared before approval.") });
            return;
        }
        if (decision.value === "REJECTED" && decisionNotes.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection note is required") });
            return;
        }
        if (!(await (decision.value === "APPROVED" ? approveJoinSafeguard : rejectJoinSafeguard).confirm())) return;
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.joinRequestDecide(requestId.value), {
                decision: decision.value,
                reasonCode: decisionReason.value,
                notes: decisionNotes.value.trim() || undefined,
                proposedRiskTier: decisionRiskTier.value,
            });
            const payload = (response.data?.data ?? response.data ?? {}) as { status?: string };
            decisionOpen.value = false;
            showSnackBar({
                type: "success",
                message:
                    payload.status === "PENDING_CHECKER"
                        ? t("Decision proposed; awaiting independent checker")
                        : t(decision.value === "APPROVED" ? "Join request approved" : "Join request rejected"),
            });
            await load();
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            actionLoading.value = false;
        }
    };

    const checkerDecision = async (approve: boolean) => {
        const approval = detail.value?.approvalRequest;
        if (!approval) return;
        if (!approve && checkerNotes.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection reason is required") });
            return;
        }
        actionLoading.value = true;
        try {
            if (approve) {
                await api.post(urlsMap.approvalApprove(approval.id), {
                    reason: checkerNotes.value.trim() || "Reviewed and approved",
                    comment: checkerNotes.value.trim() || undefined,
                });
            } else {
                await api.post(urlsMap.approvalReject(approval.id), {
                    reason: checkerNotes.value.trim(),
                });
            }
            showSnackBar({
                type: "success",
                message: t(approve ? "Approval executed" : "Approval rejected; request returned to review"),
            });
            await load();
        } catch (cause) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        } finally {
            actionLoading.value = false;
        }
    };

    const openProfileEdit = () => {
        profileForm.value = {
            legalName: merchant.value?.legalName ?? "",
            tradeName: merchant.value?.tradeName ?? "",
            country: merchant.value?.country ?? "LY",
            businessCategory: merchant.value?.businessCategory ?? "",
            registrationNumber: merchant.value?.registrationNo ?? "",
            taxId: merchant.value?.taxId ?? "",
            registeredAddress: asText(profile.value.registeredAddress),
            websiteUrl: asText(profile.value.websiteUrl),
            contactPhone: merchant.value?.contactPhone ?? "",
            contactEmail: merchant.value?.contactEmail ?? "",
            expectedMonthlyVolume: asText(profile.value.expectedMonthlyVolume),
            currency: asText(profile.value.currency) || "LYD",
            businessUseDescription: asText(profile.value.businessUseDescription),
            payoutBankName: asText(payout.value.bank ?? payout.value.bankName),
            payoutAccount: asText(payout.value.iban ?? payout.value.accountNumber ?? payout.value.account),
        };
        profileOpen.value = true;
    };

    const saveProfile = () => {
        void run(async () => {
            const body: Record<string, unknown> = {
                legalName: clean(profileForm.value.legalName),
                tradeName: clean(profileForm.value.tradeName),
                country: clean(profileForm.value.country),
                businessCategory: clean(profileForm.value.businessCategory),
                registrationNumber: clean(profileForm.value.registrationNumber),
                taxId: clean(profileForm.value.taxId),
                registeredAddress: clean(profileForm.value.registeredAddress),
                websiteUrl: clean(profileForm.value.websiteUrl),
                contactPhone: clean(profileForm.value.contactPhone),
                contactEmail: clean(profileForm.value.contactEmail),
                expectedMonthlyVolume: clean(profileForm.value.expectedMonthlyVolume),
                currency: clean(profileForm.value.currency),
                businessUseDescription: clean(profileForm.value.businessUseDescription),
                ...(profileForm.value.payoutBankName.trim() || profileForm.value.payoutAccount.trim()
                    ? {
                          payoutBankDetails: {
                              bank: profileForm.value.payoutBankName.trim(),
                              iban: profileForm.value.payoutAccount.trim(),
                          },
                      }
                    : {}),
            };
            await api.patch(urlsMap.joinRequestProfile(requestId.value), body);
            profileOpen.value = false;
        }, t("Profile saved"));
    };

    const openOwner = (owner?: BeneficialOwner) => {
        editingOwnerId.value = owner?.id ?? null;
        ownerForm.value = owner
            ? {
                  fullName: owner.fullNameAr,
                  fullNameEn: owner.fullNameEn ?? "",
                  identityType: "NATIONAL_ID",
                  identityNumber: "",
                  nationality: owner.nationality,
                  dateOfBirth: owner.dateOfBirth?.slice(0, 10) ?? "",
                  ownershipPercent: owner.ownershipPercent ?? "",
                  role: owner.role as OwnerForm["role"],
                  pepDeclared: owner.pepDeclared,
              }
            : emptyOwner();
        ownerOpen.value = true;
    };

    const saveOwner = () => {
        if (!ownerForm.value.fullName.trim()) {
            showSnackBar({ type: "warning", message: t("The owner name is required") });
            return;
        }
        if (!editingOwnerId.value && ownerForm.value.identityNumber.trim().length < 4) {
            showSnackBar({ type: "warning", message: t("The owner identity number is required") });
            return;
        }
        void run(async () => {
            const body: Record<string, unknown> = {
                fullName: ownerForm.value.fullName.trim(),
                fullNameEn: clean(ownerForm.value.fullNameEn),
                nationality: clean(ownerForm.value.nationality),
                dateOfBirth: clean(ownerForm.value.dateOfBirth),
                ownershipPercent: clean(ownerForm.value.ownershipPercent),
                role: ownerForm.value.role,
                pepDeclared: ownerForm.value.pepDeclared,
            };
            if (!editingOwnerId.value) {
                body.identityType = ownerForm.value.identityType;
                body.identityNumber = ownerForm.value.identityNumber.trim();
            } else if (ownerForm.value.identityNumber.trim()) {
                body.identityType = ownerForm.value.identityType;
                body.identityNumber = ownerForm.value.identityNumber.trim();
            }
            if (editingOwnerId.value) {
                await api.patch(urlsMap.joinRequestOwner(requestId.value, editingOwnerId.value), body);
            } else {
                await api.post(urlsMap.joinRequestOwners(requestId.value), body);
            }
            ownerOpen.value = false;
        }, t("Beneficial owner saved"));
    };

    const removeOwner = (owner: BeneficialOwner) => {
        void run(async () => {
            await api.delete(urlsMap.joinRequestOwner(requestId.value, owner.id));
        }, t("Beneficial owner removed"));
    };

    const uploadDocument = () => {
        const file = docFileInput.value?.files?.[0];
        if (!file) {
            showSnackBar({ type: "warning", message: t("Choose a PDF, PNG or JPEG document") });
            return;
        }
        void run(async () => {
            const form = new FormData();
            form.append("file", file);
            form.append("documentType", docType.value);
            if (docExpiresOn.value) form.append("expiresOn", docExpiresOn.value);
            await api.post(urlsMap.joinRequestDocuments(requestId.value), form);
            uploadOpen.value = false;
            docExpiresOn.value = "";
            if (docFileInput.value) docFileInput.value.value = "";
        }, t("Document uploaded and scanned"));
    };

    const canReviewDocument = (document: KybDocument): boolean => {
        if (["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].includes(detail.value?.status ?? "")) {
            return false;
        }
        if (document.status !== "UPLOADED" || document.avStatus !== "CLEAN") {
            return false;
        }
        if (!document.expiresOn) return true;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return new Date(document.expiresOn).getTime() >= today.getTime();
    };

    const openKybDocument = (document: KybDocument) => {
        void router.push({ name: "KybReviewDetail", params: { id: document.id } });
    };

    const previewDocument = async (document: KybDocument) => {
        const mime = safePreviewMime(document.mime);
        if (!mime) {
            showSnackBar({ type: "warning", message: t("This file type cannot be previewed.") });
            return;
        }
        // Open the tab synchronously, before the await: browsers only allow a
        // popup from the click handler itself.
        const target = window.open("", "_blank");
        if (target) target.opener = null;
        try {
            const response = await api.get(urlsMap.kybDocumentContent(document.id), { responseType: "blob" });
            const url = URL.createObjectURL(new Blob([response.data], { type: mime }));
            if (target) {
                target.location.href = url;
            } else {
                window.open(url, "_blank", "noopener,noreferrer");
            }
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (cause) {
            target?.close();
            showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
        }
    };

    const openReview = (document: KybDocument) => {
        if (!canReviewDocument(document)) {
            showSnackBar({
                type: "warning",
                message: t("Only an uploaded, clean and unexpired document on an open request can be reviewed."),
            });
            return;
        }
        reviewTarget.value = document;
        reviewDecision.value = "ACCEPTED";
        reviewNotes.value = "";
        reviewExpiresOn.value = document.expiresOn?.slice(0, 10) ?? "";
        reviewOpen.value = true;
    };

    const saveReview = () => {
        const target = reviewTarget.value;
        if (!target) return;
        void run(async () => {
            await api.post(urlsMap.kybDocumentReview(target.id), {
                decision: reviewDecision.value,
                notes: reviewNotes.value.trim() || undefined,
                ...(reviewExpiresOn.value ? { expiresOn: reviewExpiresOn.value } : {}),
            });
            reviewOpen.value = false;
        }, t("Document review saved"));
    };

    const removeDocument = (document: KybDocument) => {
        void run(async () => {
            await api.delete(urlsMap.joinRequestDocument(requestId.value, document.id));
        }, t("Document removed"));
    };

    const sections = computed(() => {
        if (!detail.value) return [];
        const entry = detail.value;
        return [
            {
                title: t("Business"),
                description: t("Applicant identity as recorded on the merchant and onboarding profile."),
                items: [
                    detailItem("Legal name", merchant.value?.legalName, "Registered legal entity name.", "merchants.legalName"),
                    detailItem("Trade name", merchant.value?.tradeName, "Customer-facing business name.", "merchants.tradeName"),
                    detailItem("Merchant ID", entry.merchantId, "The merchant database identifier.", "merchants.id", true),
                    detailItem("Join request ID", entry.id, "The onboarding request identifier.", "join_requests.id", true),
                    detailItem("Status", statusHelp.value.label, statusHelp.value.meaning, "join_requests.status"),
                    detailItem("Channel", channelLabel(entry.onboardingChannel), COLUMN_HELP.channel, "join_requests.onboarding_channel"),
                    detailItem("Country", merchant.value?.country, "Two-letter country code.", "merchants.country"),
                    detailItem("Business category", merchant.value?.businessCategory, "Category used by the risk-based four-eyes policy.", "merchants.businessCategory"),
                    detailItem("Registration number", merchant.value?.registrationNo, "Commercial registration number.", "merchants.registrationNo", true),
                    detailItem("Tax ID", merchant.value?.taxId, "Tax registration identifier.", "merchants.taxId", true),
                    detailItem("Risk tier", entry.proposedRiskTier || entry.riskTier, "Proposed at approval; written to the merchant on activation.", "join_requests.proposed_risk_tier"),
                ],
            },
            {
                title: t("Contact and volume"),
                items: [
                    detailItem("Contact phone", merchant.value?.contactPhone, "Primary merchant contact phone.", "merchants.contactPhone", true),
                    detailItem("Contact email", merchant.value?.contactEmail, "Primary merchant contact email.", "merchants.contactEmail", true),
                    detailItem("Website", profile.value.websiteUrl, "Declared business website.", "join_requests.profile_json.websiteUrl"),
                    detailItem("Registered address", profile.value.registeredAddress, "Declared registered address.", "join_requests.profile_json.registeredAddress"),
                    detailItem("Expected monthly volume", profile.value.expectedMonthlyVolume, "Expected processing volume captured at onboarding.", "join_requests.profile_json.expectedMonthlyVolume"),
                    detailItem("Currency", profile.value.currency, "Currency of the expected volume.", "join_requests.profile_json.currency"),
                    detailItem("Business use", profile.value.businessUseDescription, "Merchant description of the intended payment use.", "join_requests.profile_json.businessUseDescription"),
                ],
            },
            {
                title: t("Payout account"),
                items: [
                    detailItem("Bank", payout.value.bank ?? payout.value.bankName, "Payout bank name.", "merchants.payoutBankDetailsJson.bank"),
                    detailItem("Account", payout.value.iban ?? payout.value.accountNumber ?? payout.value.account, "Payout IBAN or account number. Stored as JSON and hashed for duplicate detection.", "merchants.payoutBankDetailsJson.iban"),
                    detailItem("Account hash", merchant.value?.payoutAccountHash, "SHA-256 duplicate-detection hash; raw account is never used as a lookup key.", "merchants.payoutAccountHash", true),
                ],
            },
            {
                title: t("Review and decision"),
                items: [
                    detailItem("Submitted by", entry.submittedBy?.email, "The operator who prepared or the merchant user who submitted the request.", "join_requests.submitted_by_user_id"),
                    detailItem("Submitted at", formatDateTime(entry.submittedAt), "Submission timestamp.", "join_requests.submitted_at"),
                    detailItem("Assignee", entry.assignedReviewer?.email, COLUMN_HELP.reviewer, "join_requests.assigned_reviewer_id"),
                    detailItem("Four eyes", entry.fourEyesRequired ? t("Required") : t("Not required"), "Maker-checker is mandatory when the policy or risk conditions require it.", "join_requests.four_eyes_required"),
                    detailItem("SLA", `${sla.value.label} · ${sla.value.detail}`, COLUMN_HELP.sla, "join_requests.sla_due_at"),
                    detailItem("Decision", entry.decision, "Final decision recorded on the join request.", "join_requests.decision"),
                    detailItem("Decision reason", entry.decisionReasonCode, "Reason code recorded by the decision maker.", "join_requests.decision_reason_code"),
                    detailItem("Decision notes", entry.decisionNotes, "Reviewer notes recorded with the decision.", "join_requests.decision_notes"),
                ],
            },
        ].filter((section) => section.items.length > 0);
    });

    const duplicateLabel = (flag: DuplicateFlag): string =>
        `${blockerLabel(flag.field)}${flag.matchedMerchantId ? ` · merchant ${flag.matchedMerchantId}` : ""}${
            flag.matchedDocumentId ? ` · document ${flag.matchedDocumentId}` : ""
        }`;

    return () => {
        if (loading.value) {
            return (
                <ScreenContainer>
                    <StateView loading onRetry={() => void load()} />
                </ScreenContainer>
            );
        }
        if (error.value || !detail.value) {
            return (
                <ScreenContainer>
                    <StateView error={error.value ?? "Join request not found"} onRetry={() => void load()} />
                </ScreenContainer>
            );
        }
        const entry = detail.value;
        return (
            <ScreenContainer>
                <ThemedView style={{ gap: "18px" }}>
                    <PageHeader
                        title={merchant.value?.tradeName || t("Join request")}
                        subtitle={t("Inspect merchant and owner evidence, keep the review checklist current, and record a defensible decision.")}
                        badge={entry.fourEyesRequired ? t("Four eyes") : t("KYB review")}
                        badgeTone={entry.fourEyesRequired ? "warning" : "info"}
                        end={() => (
                            <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "JoinRequests" })}>
                                    {t("Queue")}
                                </VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
                                    {t("Refresh")}
                                </VBtn>
                                {isEditable.value && (
                                    <VBtn color="primary" prependIcon="mdi-pencil-outline" onClick={openProfileEdit}>
                                        {t("Edit profile")}
                                    </VBtn>
                                )}
                            </ThemedView>
                        )}
                    />

                    <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                        <span title={statusHelp.value.meaning}>
                            <StatusBadge status={entry.status} label={statusHelp.value.label} toneOverride={asBadgeTone(statusHelp.value.tone)} />
                        </span>
                        <StatusBadge status={entry.onboardingChannel} label={channelLabel(entry.onboardingChannel)} toneOverride={entry.onboardingChannel === "ADMIN_ASSISTED" ? "info" : "neutral"} />
                        <StatusBadge status={entry.proposedRiskTier || entry.riskTier} label={entry.proposedRiskTier || entry.riskTier} toneOverride={asBadgeTone(statusTone(entry.proposedRiskTier || entry.riskTier))} />
                        <StatusBadge status={sla.value.label} label={`SLA ${sla.value.label}`} toneOverride={asBadgeTone(sla.value.tone)} />
                        <StatusBadge
                            status={readiness.value?.ready ? t("Decision ready") : t("Blocked")}
                            label={readiness.value?.ready ? t("Decision ready") : t("Blocked")}
                            toneOverride={readiness.value?.ready ? "success" : "warning"}
                        />
                        {entry.fourEyesRequired && <StatusBadge status="Four eyes" label={t("Four eyes")} toneOverride="warning" />}
                    </ThemedView>

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Request at a glance")}</ThemedText>
                            <DescriptionList
                                columns={2}
                                items={[
                                    { label: t("Merchant ID"), value: <MonoRef value={entry.merchantId} /> },
                                    { label: t("Join request ID"), value: <MonoRef value={entry.id} /> },
                                    { label: t("Status"), value: statusHelp.value.label },
                                    { label: t("SLA due"), value: formatDateTime(entry.slaDueAt) },
                                    { label: t("Assignee"), value: entry.assignedReviewer?.email || entry.reviewer || t("Unassigned") },
                                    { label: t("Decision"), value: entry.decision || "—" },
                                    ...(entry.approvalRequest
                                        ? [{ label: t("Approval request ID"), value: <MonoRef value={entry.approvalRequest.id} /> }]
                                        : []),
                                ]}
                            />
                        </SurfaceCardText>
                    </SurfaceCard>

                    {entry.status === "INFO_REQUESTED" && (
                        <VAlert type="warning" variant="tonal">
                            <ThemedText type="defaultSemiBold">{t("Information requested")}</ThemedText>
                            {(entry.infoRequestJson ?? []).map((item, index) => (
                                <div key={index} style={{ fontSize: "13px", marginTop: "4px" }}>
                                    {infoRequestedLabel(item)}
                                </div>
                            ))}
                        </VAlert>
                    )}

                    {entry.approvalRequest?.state === "PENDING_REVIEW" && (
                        <SurfaceCard variant="tonal" color="warning">
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold">{t("Awaiting independent checker")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>
                                    {t("Maker")}: {entry.approvalRequest.makerUserId} · {t("Proposed decision")}: {entry.decision || t("pending")}
                                </ThemedText>
                                {canCheck.value ? (
                                    <ThemedView style={{ gap: "10px" }}>
                                        <FormField label={t("Checker notes or rejection reason")}>
                                            <VTextField v-model={checkerNotes.value} />
                                        </FormField>
                                        <ThemedView style={{ flexDirection: "row", gap: "10px" }}>
                                            <VBtn color="success" loading={actionLoading.value} onClick={() => void checkerDecision(true)}>
                                                {t("Approve and execute")}
                                            </VBtn>
                                            <VBtn color="error" variant="tonal" loading={actionLoading.value} onClick={() => void checkerDecision(false)}>
                                                {t("Reject approval")}
                                            </VBtn>
                                        </ThemedView>
                                    </ThemedView>
                                ) : (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.75 }}>
                                        {t("You cannot check an approval you made. Open the Approvals queue with an independent checker.")}
                                    </ThemedText>
                                )}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {(readiness.value?.blockers?.length ?? 0) > 0 && (
                        <SurfaceCard variant="tonal" color="warning">
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Approval blockers")}</ThemedText>
                                {readiness.value?.blockers.map((blocker) => (
                                    <ThemedText key={blocker} style={{ fontSize: "13px" }}>
                                        • {blockerLabel(blocker)}
                                    </ThemedText>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {!!entry.fourEyesReasons?.length && (
                        <SurfaceCard variant="tonal" color="info">
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold">{t("Four-eyes reasons")}</ThemedText>
                                {entry.fourEyesReasons.map((reason) => (
                                    <ThemedText key={reason} style={{ fontSize: "13px" }}>
                                        • {blockerLabel(reason)}
                                    </ThemedText>
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {duplicateFlags.value.length > 0 && (
                        <SurfaceCard variant="tonal" color="warning">
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Duplicate and related-party flags")}</ThemedText>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.75 }}>{COLUMN_HELP.duplicates}</ThemedText>
                                {duplicateFlags.value.map((flag, index) => (
                                    <ThemedText key={index} style={{ fontSize: "13px" }}>
                                        • {duplicateLabel(flag)}
                                    </ThemedText>
                                ))}
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
                                {t("Last 100 recorded actions on this join request, newest first.")}
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
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedView style={{ gap: "3px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Screening")}</ThemedText>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{COLUMN_HELP.screening}</ThemedText>
                                </ThemedView>
                                {canWrite.value && ["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED"].includes(entry.status) && (
                                    <VBtn size="small" variant="tonal" prependIcon="mdi-radar" loading={actionLoading.value} onClick={retryScreening}>
                                        {t("Retry screening")}
                                    </VBtn>
                                )}
                            </ThemedView>
                            {!entry.screening ? (
                                <ThemedText style={{ opacity: 0.6 }}>{t("No screening result yet")}</ThemedText>
                            ) : (
                                <ThemedView style={{ gap: "10px" }}>
                                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                        <StatusBadge status={entry.screening.result} label={entry.screening.result} toneOverride={asBadgeTone(statusTone(entry.screening.result))} />
                                        <StatusBadge status={`${entry.screening.matchCount} matches`} label={`${entry.screening.matchCount} ${t("matches")}`} toneOverride={entry.screening.matchCount > 0 ? "warning" : "success"} />
                                        <StatusBadge status="Highest score" label={`${t("Highest score")}: ${entry.screening.highestScore ?? "—"}`} toneOverride="neutral" />
                                    </ThemedView>
                                    {entry.amlDetailsRedacted && <ThemedText style={{ fontSize: "12px", color: "var(--pg-status-warning-text)" }}>{t("Match details are redacted for your role.")}</ThemedText>}
                                    {entry.screening.matches.map((match) => (
                                        <SurfaceCard key={match.id} variant="tonal">
                                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                    <StatusBadge status={match.listType} label={match.listType} toneOverride="warning" />
                                                    <StatusBadge status={match.disposition} label={match.disposition} toneOverride={asBadgeTone(statusTone(match.disposition))} />
                                                    <ThemedText style={{ fontSize: "12px" }}>{t("Score")}: {match.score}</ThemedText>
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "13px" }}>{match.matchedName} · {match.listName}</ThemedText>
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{match.listEntryRef}</ThemedText>
                                                {match.dispositionNotes && <ThemedText style={{ fontSize: "12px" }}>{match.dispositionNotes}</ThemedText>}
                                            </SurfaceCardText>
                                        </SurfaceCard>
                                    ))}
                                    {(entry.screening.amlCases ?? []).length > 0 && (
                                        <ThemedView style={{ gap: "6px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("AML cases")}</ThemedText>
                                            {entry.screening.amlCases.map((amlCase) => (
                                                <ThemedView key={amlCase.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                    <StatusBadge status={amlCase.status} label={amlCase.status} toneOverride={asBadgeTone(statusTone(amlCase.status))} />
                                                    <StatusBadge status={amlCase.severity} label={amlCase.severity} toneOverride={asBadgeTone(statusTone(amlCase.severity))} />
                                                    <ThemedText style={{ fontSize: "12px", direction: "ltr" }}>{amlCase.id}</ThemedText>
                                                </ThemedView>
                                            ))}
                                        </ThemedView>
                                    )}
                                </ThemedView>
                            )}
                        </SurfaceCardText>
                    </SurfaceCard>

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedView style={{ gap: "3px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Beneficial owners")}</ThemedText>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                        {COLUMN_HELP.owners} · {t("Total ownership")}: {readiness.value?.ownersTotal ?? 0}% / {readiness.value?.ownerThreshold ?? 25}%
                                    </ThemedText>
                                </ThemedView>
                                {canWrite.value && !isFinal.value && (
                                    <VBtn size="small" variant="tonal" prependIcon="mdi-account-plus-outline" onClick={() => openOwner()}>
                                        {t("Add owner")}
                                    </VBtn>
                                )}
                            </ThemedView>
                            {activeOwners.value.length === 0 && (
                                <EmptyState title={t("No active beneficial owners")} description={COLUMN_HELP.owners} icon="mdi-account-group-outline" />
                            )}
                            {activeOwners.value.map((owner) => (
                                <SurfaceCard key={owner.id} variant="tonal">
                                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                            <ThemedView style={{ gap: "2px" }}>
                                                <ThemedText type="defaultSemiBold">{owner.fullNameAr}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                    {owner.fullNameEn || "—"} · {owner.nationality} · {owner.role} · {owner.ownershipPercent ?? "—"}%
                                                </ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusBadge status={owner.screeningStatus} label={owner.screeningStatus} toneOverride={asBadgeTone(statusTone(owner.screeningStatus))} />
                                                {owner.pepDeclared && <StatusBadge status="PEP" label="PEP" toneOverride="danger" />}
                                                {canWrite.value && !isFinal.value && (
                                                    <>
                                                        <VBtn size="x-small" variant="text" onClick={() => openOwner(owner)}>{t("Edit")}</VBtn>
                                                        <VBtn size="x-small" variant="text" color="error" onClick={() => removeOwner(owner)}>{t("Remove")}</VBtn>
                                                    </>
                                                )}
                                            </ThemedView>
                                        </ThemedView>
                                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                            <MonoRef value={owner.id} truncate={18} />
                                            {owner.nationalIdHash ? (
                                                <MonoRef value={owner.nationalIdHash} truncate={22} />
                                            ) : (
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("no identity hash")}</ThemedText>
                                            )}
                                        </ThemedView>
                                    </SurfaceCardText>
                                </SurfaceCard>
                            ))}
                        </SurfaceCardText>
                    </SurfaceCard>

                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedView style={{ gap: "3px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("KYB documents")}</ThemedText>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{COLUMN_HELP.documents}</ThemedText>
                                </ThemedView>
                                {canWrite.value && isEditable.value && (
                                    <VBtn size="small" variant="tonal" prependIcon="mdi-upload" onClick={() => (uploadOpen.value = true)}>
                                        {t("Upload document")}
                                    </VBtn>
                                )}
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                {(readiness.value?.requiredDocuments ?? []).map((docTypeRequired) => {
                                    const accepted = readiness.value?.acceptedDocuments?.includes(docTypeRequired);
                                    return (
                                        <StatusBadge
                                            key={docTypeRequired}
                                            status={docTypeRequired}
                                            label={`${docTypeRequired}${accepted ? "" : ` · ${t("missing")}`}`}
                                            toneOverride={accepted ? "success" : "warning"}
                                        />
                                    );
                                })}
                            </ThemedView>
                            {entry.kybDocuments.length === 0 && (
                                <EmptyState title={t("No documents uploaded")} description={COLUMN_HELP.documents} icon="mdi-file-document-outline" />
                            )}
                            {entry.kybDocuments.map((document) => (
                                <SurfaceCard key={document.id} variant="tonal">
                                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                            <ThemedView style={{ gap: "3px" }}>
                                                <ThemedText type="defaultSemiBold">{document.docType}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                    {document.originalFileName || "—"} · {formatBytes(document.sizeBytes)} · {formatDateTime(document.createdAt)}
                                                </ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusBadge status={document.status} label={document.status} toneOverride={asBadgeTone(statusTone(document.status))} />
                                                <StatusBadge status={document.avStatus} label={document.avStatus} toneOverride={asBadgeTone(statusTone(document.avStatus))} />
                                                {document.expiresOn && <StatusBadge status="expiry" label={`exp ${document.expiresOn.slice(0, 10)}`} toneOverride="neutral" />}
                                            </ThemedView>
                                        </ThemedView>
                                        <MonoRef value={document.sha256} truncate={28} />
                                        {document.reviewNotes && <ThemedText style={{ fontSize: "12px" }}>{document.reviewNotes}</ThemedText>}
                                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                            {document.avStatus === "CLEAN" && (
                                                <VBtn size="x-small" variant="text" prependIcon="mdi-eye-outline" onClick={() => void previewDocument(document)}>
                                                    {t("Preview")}
                                                </VBtn>
                                            )}
                                            {canWrite.value && canReviewDocument(document) && (
                                                <VBtn size="x-small" variant="text" prependIcon="mdi-file-check-outline" onClick={() => openReview(document)}>
                                                    {t("Review")}
                                                </VBtn>
                                            )}
                                            <VBtn
                                                size="x-small"
                                                variant="text"
                                                prependIcon="mdi-file-search-outline"
                                                onClick={() => openKybDocument(document)}
                                            >
                                                {t("KYB details")}
                                            </VBtn>
                                            {canWrite.value && isEditable.value && (
                                                <VBtn size="x-small" variant="text" color="error" onClick={() => removeDocument(document)}>
                                                    {t("Delete")}
                                                </VBtn>
                                            )}
                                        </ThemedView>
                                    </SurfaceCardText>
                                </SurfaceCard>
                            ))}
                        </SurfaceCardText>
                    </SurfaceCard>

                    {showChecklists && (
                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "3px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Review checklist")}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                            {t("Every item must be checked before approval. Checklist is stored on the join request.")}
                                        </ThemedText>
                                    </ThemedView>
                                    {canChecklist.value && (
                                        <VBtn size="small" color="primary" loading={actionLoading.value} disabled={!checklistComplete.value} onClick={saveChecklist}>
                                            {t("Save checklist")}
                                        </VBtn>
                                    )}
                                </ThemedView>
                                {(entry.checklistKeys ?? []).map((key) => (
                                    <VCheckbox
                                        key={key}
                                        label={t(key)}
                                        modelValue={Boolean(checklist.value[key])}
                                        onUpdate:modelValue={(value: boolean | null) => (checklist.value[key] = Boolean(value))}
                                        density="compact"
                                        hideDetails
                                        disabled={!canChecklist.value}
                                    />
                                ))}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}

                    {canWrite.value && !isFinal.value && (
                        <SurfaceCard>
                            <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{t("Actions")}</ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                    {canAssign.value && (
                                        <VBtn variant="tonal" prependIcon="mdi-account-check-outline" loading={actionLoading.value} onClick={assignToMe}>
                                            {t("Assign to me")}
                                        </VBtn>
                                    )}
                                    {canSubmit.value && (
                                        <VBtn variant="tonal" color="primary" prependIcon="mdi-send-check-outline" loading={actionLoading.value} onClick={submit}>
                                            {t("Submit for review")}
                                        </VBtn>
                                    )}
                                    {canRequestInfo.value && (
                                        <VBtn variant="tonal" color="warning" prependIcon="mdi-message-alert-outline" onClick={() => (infoOpen.value = true)}>
                                            {t("Request information")}
                                        </VBtn>
                                    )}
                                    {canDecide.value && (
                                        <>
                                            <VBtn color="success" prependIcon="mdi-check-decagram-outline" disabled={!readiness.value?.ready} onClick={() => { decision.value = "APPROVED"; decisionOpen.value = true; }}>
                                                {t("Approve")}
                                            </VBtn>
                                            <VBtn color="error" variant="tonal" prependIcon="mdi-close-octagon-outline" onClick={() => { decision.value = "REJECTED"; decisionOpen.value = true; }}>
                                                {t("Reject")}
                                            </VBtn>
                                        </>
                                    )}
                                    {canWithdraw.value && (
                                        <VBtn variant="text" color="error" onClick={() => (withdrawOpen.value = true)}>
                                            {t("Withdraw")}
                                        </VBtn>
                                    )}
                                </ThemedView>
                                {detail.value?.onboardingChannel === "ADMIN_ASSISTED" && detail.value?.submittedBy?.id === currentUserId.value && (
                                    <ThemedText style={{ fontSize: "12px", color: "var(--pg-status-warning-text)" }}>
                                        {t("You prepared this admin-assisted request, so an independent operator must decide it.")}
                                    </ThemedText>
                                )}
                            </SurfaceCardText>
                        </SurfaceCard>
                    )}
                </ThemedView>

                <FormModal
                    modelValue={profileOpen.value}
                    onUpdate:modelValue={(value: boolean) => (profileOpen.value = value)}
                    title={t("Edit applicant profile")}
                    size="lg"
                    onSubmit={saveProfile}
                    submitLabel={t("Save")}
                    cancelLabel={t("Cancel")}
                    loading={actionLoading.value}
                >
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
                        <FormField label={t("Legal name")}>
                            <VTextField v-model={profileForm.value.legalName} />
                        </FormField>
                        <FormField label={t("Trade name")}>
                            <VTextField v-model={profileForm.value.tradeName} />
                        </FormField>
                        <FormField label={t("Country code")}>
                            <VTextField v-model={profileForm.value.country} />
                        </FormField>
                        <FormField label={t("Business category")}>
                            <VTextField v-model={profileForm.value.businessCategory} />
                        </FormField>
                        <FormField label={t("Registration number")}>
                            <VTextField v-model={profileForm.value.registrationNumber} />
                        </FormField>
                        <FormField label={t("Tax ID")}>
                            <VTextField v-model={profileForm.value.taxId} />
                        </FormField>
                        <FormField label={t("Contact phone")}>
                            <VTextField v-model={profileForm.value.contactPhone} />
                        </FormField>
                        <FormField label={t("Contact email")}>
                            <VTextField v-model={profileForm.value.contactEmail} />
                        </FormField>
                        <FormField label={t("Expected monthly volume")}>
                            <VTextField v-model={profileForm.value.expectedMonthlyVolume} />
                        </FormField>
                        <FormField label={t("Currency")}>
                            <VTextField v-model={profileForm.value.currency} />
                        </FormField>
                        <FormField label={t("Website URL")}>
                            <VTextField v-model={profileForm.value.websiteUrl} />
                        </FormField>
                        <FormField label={t("Payout bank")}>
                            <VTextField v-model={profileForm.value.payoutBankName} />
                        </FormField>
                        <FormField label={t("Payout account / IBAN")}>
                            <VTextField v-model={profileForm.value.payoutAccount} />
                        </FormField>
                    </div>
                    <FormField label={t("Registered address")}>
                        <VTextField v-model={profileForm.value.registeredAddress} />
                    </FormField>
                    <FormField label={t("Business use description")}>
                        <VTextarea v-model={profileForm.value.businessUseDescription} rows={3} autoGrow />
                    </FormField>
                </FormModal>

                <FormModal
                    modelValue={ownerOpen.value}
                    onUpdate:modelValue={(value: boolean) => (ownerOpen.value = value)}
                    title={editingOwnerId.value ? t("Edit beneficial owner") : t("Add beneficial owner")}
                    size="md"
                    onSubmit={saveOwner}
                    submitLabel={t("Save")}
                    cancelLabel={t("Cancel")}
                    loading={actionLoading.value}
                >
                    <VAlert type="info" variant="tonal" density="compact">
                        {t("The identity number is encrypted at rest and only its hash is used for duplicate detection.")}
                    </VAlert>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
                        <FormField label={t("Full name (Arabic)")} required>
                            <VTextField v-model={ownerForm.value.fullName} />
                        </FormField>
                        <FormField label={t("Full name (English)")}>
                            <VTextField v-model={ownerForm.value.fullNameEn} />
                        </FormField>
                        <FormField label={t("Identity type")}>
                            <VSelect v-model={ownerForm.value.identityType} items={["NATIONAL_ID", "PASSPORT"]} />
                        </FormField>
                        <FormField label={editingOwnerId.value ? t("New identity number (optional)") : t("Identity number")} required={!editingOwnerId.value}>
                            <VTextField v-model={ownerForm.value.identityNumber} />
                        </FormField>
                        <FormField label={t("Nationality")}>
                            <VTextField v-model={ownerForm.value.nationality} />
                        </FormField>
                        <FormField label={t("Date of birth (YYYY-MM-DD)")}>
                            <VTextField v-model={ownerForm.value.dateOfBirth} />
                        </FormField>
                        <FormField label={t("Ownership percent")}>
                            <VTextField v-model={ownerForm.value.ownershipPercent} />
                        </FormField>
                        <FormField label={t("Role")}>
                            <VSelect v-model={ownerForm.value.role} items={["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"]} />
                        </FormField>
                    </div>
                    <VCheckbox v-model={ownerForm.value.pepDeclared} label={t("Declared PEP")} density="compact" hideDetails />
                </FormModal>

                <FormModal
                    modelValue={uploadOpen.value}
                    onUpdate:modelValue={(value: boolean) => (uploadOpen.value = value)}
                    title={t("Upload KYB document")}
                    size="md"
                    onSubmit={uploadDocument}
                    submitLabel={t("Upload")}
                    cancelLabel={t("Cancel")}
                    loading={actionLoading.value}
                >
                    <FormField label={t("Document type")} required>
                        <VSelect v-model={docType.value} items={DOCUMENT_TYPES} />
                    </FormField>
                    <FormField label={t("Expiry date (YYYY-MM-DD, optional)")}>
                        <VTextField v-model={docExpiresOn.value} />
                    </FormField>
                    <FormField
                        label={t("KYB document file")}
                        hint={t("PDF, PNG or JPEG up to 10 MiB. The file is magic-byte checked, malware scanned and encrypted before storage.")}
                        required
                    >
                        <input ref={docFileInput} type="file" accept="application/pdf,image/png,image/jpeg" />
                    </FormField>
                </FormModal>

                <FormModal
                    modelValue={reviewOpen.value}
                    onUpdate:modelValue={(value: boolean) => (reviewOpen.value = value)}
                    title={t("Review document")}
                    size="md"
                    onSubmit={saveReview}
                    submitLabel={t("Save review")}
                    cancelLabel={t("Cancel")}
                    loading={actionLoading.value}
                    danger={reviewDecision.value === "REJECTED"}
                >
                    <ThemedText style={{ fontSize: "13px" }}>{reviewTarget.value?.docType} · {reviewTarget.value?.originalFileName}</ThemedText>
                    <FormField label={t("Decision")}>
                        <VSelect v-model={reviewDecision.value} items={[{ title: "Accept", value: "ACCEPTED" }, { title: "Reject", value: "REJECTED" }]} />
                    </FormField>
                    <FormField label={t("Expiry date (YYYY-MM-DD, optional)")}>
                        <VTextField v-model={reviewExpiresOn.value} />
                    </FormField>
                    <FormField label={t("Review notes")}>
                        <VTextarea v-model={reviewNotes.value} rows={3} autoGrow />
                    </FormField>
                </FormModal>

                <FormModal
                    modelValue={infoOpen.value}
                    onUpdate:modelValue={(value: boolean) => (infoOpen.value = value)}
                    title={t("Request information")}
                    size="md"
                    onSubmit={requestInfo}
                    submitLabel={t("Request")}
                    cancelLabel={t("Cancel")}
                    loading={actionLoading.value}
                >
                    <FormField label={t("Requested items (comma separated)")} required>
                        <VTextField v-model={infoItems.value} />
                    </FormField>
                    <FormField
                        label={t("Message")}
                        hint={t("The onboarding SLA is paused while the request is in INFO_REQUESTED.")}
                        required
                    >
                        <VTextarea v-model={infoMessage.value} rows={4} autoGrow />
                    </FormField>
                </FormModal>

                <FormModal
                    modelValue={decisionOpen.value}
                    onUpdate:modelValue={(value: boolean) => (decisionOpen.value = value)}
                    title={decision.value === "APPROVED" ? t("Approve join request") : t("Reject join request")}
                    size="md"
                    onSubmit={() => void decide()}
                    submitLabel={decision.value === "APPROVED" ? t("Propose approval") : t("Propose rejection")}
                    cancelLabel={t("Cancel")}
                    loading={actionLoading.value}
                    danger={decision.value === "REJECTED"}
                >
                    {decision.value === "APPROVED" && !readiness.value?.ready && (
                        <VAlert type="warning" variant="tonal">{t("All approval blockers must be cleared before approval.")}</VAlert>
                    )}
                    {decision.value === "APPROVED" && (
                        <FormField label={t("Activation risk tier")}>
                            <VSelect v-model={decisionRiskTier.value} items={["LOW", "STANDARD", "HIGH"]} />
                        </FormField>
                    )}
                    {decision.value === "REJECTED" && (
                        <FormField label={t("Reason code")} required>
                            <VSelect v-model={decisionReason.value} items={REJECTION_REASONS} />
                        </FormField>
                    )}
                    <FormField label={t("Decision notes")} required={decision.value === "REJECTED"}>
                        <VTextarea v-model={decisionNotes.value} rows={4} autoGrow />
                    </FormField>
                </FormModal>

                <FormModal
                    modelValue={withdrawOpen.value}
                    onUpdate:modelValue={(value: boolean) => (withdrawOpen.value = value)}
                    title={t("Withdraw join request")}
                    size="sm"
                    onSubmit={withdraw}
                    submitLabel={t("Withdraw")}
                    cancelLabel={t("Cancel")}
                    loading={actionLoading.value}
                    danger
                >
                    <ThemedText>{t("The request will be closed as withdrawn. A pending checker approval is cancelled.")}</ThemedText>
                </FormModal>
            </ScreenContainer>
        );
    };
});

export default JoinRequestDetailPage;
