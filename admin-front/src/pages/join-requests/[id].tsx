import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VCheckbox,
    VDialog,
    VSelect,
    VTextField,
    VTextarea,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import FieldsSections from "@/components/FieldsSections";
import type { FieldProps } from "@/components/Field";
import { api } from "@/state/api";
import { hasOneOfAuthorities, user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
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
    JoinRequestDetail,
    KybDocument,
} from "./types";

const parse = (payload: unknown): JoinRequestDetail => {
    const source = (payload ?? {}) as Record<string, unknown>;
    return (source.joinRequest ?? source) as JoinRequestDetail;
};

const asText = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

const jsonRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const field = (
    text: string,
    value: unknown,
    hint?: string,
    source?: string,
    copy = false,
): FieldProps => ({
    text,
    value: value === null || value === undefined ? "" : String(value),
    hint,
    source,
    copyOnClick: copy,
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

const JoinRequestDetailPage = dc(() => {
    const { t } = useLocale();
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
    const profile = computed(() => jsonRecord(detail.value?.profileJson));
    const merchant = computed(() => detail.value?.merchant);
    const payout = computed(() => jsonRecord(merchant.value?.payoutBankDetailsJson));
    const readiness = computed(() => detail.value?.readiness);
    const activeOwners = computed(() => (detail.value?.beneficialOwners ?? []).filter((owner) => owner.active));
    const duplicateFlags = computed(() => detail.value?.readiness?.duplicateFlags ?? detail.value?.duplicateFlagsJson ?? []);
    const checklistComplete = computed(() =>
        (detail.value?.checklistKeys ?? []).every((key) => Boolean(checklist.value[key])),
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

    const decide = async () => {
        if (decision.value === "REJECTED" && decisionNotes.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection note is required") });
            return;
        }
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
        const tab = window.open("", "_blank");
        try {
            const response = await api.get(urlsMap.kybDocumentContent(document.id), { responseType: "blob" });
            const url = URL.createObjectURL(new Blob([response.data], { type: document.mime }));
            if (tab) tab.location.href = url;
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (cause) {
            tab?.close();
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
                fields: [
                    field("Legal name", merchant.value?.legalName, "Registered legal entity name.", "merchants.legalName"),
                    field("Trade name", merchant.value?.tradeName, "Customer-facing business name.", "merchants.tradeName"),
                    field("Merchant ID", entry.merchantId, "The merchant database identifier.", "merchants.id", true),
                    field("Join request ID", entry.id, "The onboarding request identifier.", "join_requests.id", true),
                    field("Status", statusHelp.value.label, statusHelp.value.meaning, "join_requests.status"),
                    field("Channel", channelLabel(entry.onboardingChannel), COLUMN_HELP.channel, "join_requests.onboarding_channel"),
                    field("Country", merchant.value?.country, "Two-letter country code.", "merchants.country"),
                    field("Business category", merchant.value?.businessCategory, "Category used by the risk-based four-eyes policy.", "merchants.businessCategory"),
                    field("Registration number", merchant.value?.registrationNo, "Commercial registration number.", "merchants.registrationNo", true),
                    field("Tax ID", merchant.value?.taxId, "Tax registration identifier.", "merchants.taxId", true),
                    field("Risk tier", entry.proposedRiskTier || entry.riskTier, "Proposed at approval; written to the merchant on activation.", "join_requests.proposed_risk_tier"),
                ],
            },
            {
                title: t("Contact and volume"),
                fields: [
                    field("Contact phone", merchant.value?.contactPhone, "Primary merchant contact phone.", "merchants.contactPhone", true),
                    field("Contact email", merchant.value?.contactEmail, "Primary merchant contact email.", "merchants.contactEmail", true),
                    field("Website", profile.value.websiteUrl, "Declared business website.", "join_requests.profile_json.websiteUrl"),
                    field("Registered address", profile.value.registeredAddress, "Declared registered address.", "join_requests.profile_json.registeredAddress"),
                    field("Expected monthly volume", profile.value.expectedMonthlyVolume, "Expected processing volume captured at onboarding.", "join_requests.profile_json.expectedMonthlyVolume"),
                    field("Currency", profile.value.currency, "Currency of the expected volume.", "join_requests.profile_json.currency"),
                    field("Business use", profile.value.businessUseDescription, "Merchant description of the intended payment use.", "join_requests.profile_json.businessUseDescription"),
                ],
            },
            {
                title: t("Payout account"),
                fields: [
                    field("Bank", payout.value.bank ?? payout.value.bankName, "Payout bank name.", "merchants.payoutBankDetailsJson.bank"),
                    field("Account", payout.value.iban ?? payout.value.accountNumber ?? payout.value.account, "Payout IBAN or account number. Stored as JSON and hashed for duplicate detection.", "merchants.payoutBankDetailsJson.iban"),
                    field("Account hash", merchant.value?.payoutAccountHash, "SHA-256 duplicate-detection hash; raw account is never used as a lookup key.", "merchants.payoutAccountHash", true),
                ],
            },
            {
                title: t("Review and decision"),
                fields: [
                    field("Submitted by", entry.submittedBy?.email, "The operator who prepared or the merchant user who submitted the request.", "join_requests.submitted_by_user_id"),
                    field("Submitted at", formatDateTime(entry.submittedAt), "Submission timestamp.", "join_requests.submitted_at"),
                    field("Assignee", entry.assignedReviewer?.email, COLUMN_HELP.reviewer, "join_requests.assigned_reviewer_id"),
                    field("Four eyes", entry.fourEyesRequired ? t("Required") : t("Not required"), "Maker-checker is mandatory when the policy or risk conditions require it.", "join_requests.four_eyes_required"),
                    field("SLA", `${sla.value.label} · ${sla.value.detail}`, COLUMN_HELP.sla, "join_requests.sla_due_at"),
                    field("Decision", entry.decision, "Final decision recorded on the join request.", "join_requests.decision"),
                    field("Decision reason", entry.decisionReasonCode, "Reason code recorded by the decision maker.", "join_requests.decision_reason_code"),
                    field("Decision notes", entry.decisionNotes, "Reviewer notes recorded with the decision.", "join_requests.decision_notes"),
                ],
            },
        ].filter((section) => section.fields.length > 0);
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
                            <StatusChip label={statusHelp.value.label} tone={statusHelp.value.tone} />
                        </span>
                        <StatusChip label={channelLabel(entry.onboardingChannel)} tone={entry.onboardingChannel === "ADMIN_ASSISTED" ? "info" : "neutral"} />
                        <StatusChip label={entry.proposedRiskTier || entry.riskTier} tone={statusTone(entry.proposedRiskTier || entry.riskTier)} />
                        <StatusChip label={`SLA ${sla.value.label}`} tone={sla.value.tone} />
                        <StatusChip
                            label={readiness.value?.ready ? t("Decision ready") : t("Blocked")}
                            tone={readiness.value?.ready ? "success" : "warning"}
                        />
                        {entry.fourEyesRequired && <StatusChip label={t("Four eyes")} tone="warning" />}
                    </ThemedView>

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
                        <VCard variant="tonal" color="warning">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <ThemedText type="defaultSemiBold">{t("Awaiting independent checker")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>
                                    {t("Maker")}: {entry.approvalRequest.makerUserId} · {t("Proposed decision")}: {entry.decision || t("pending")}
                                </ThemedText>
                                {canCheck.value ? (
                                    <ThemedView style={{ gap: "10px" }}>
                                        <VTextField v-model={checkerNotes.value} label={t("Checker notes or rejection reason")} />
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
                            </VCardText>
                        </VCard>
                    )}

                    {(readiness.value?.blockers?.length ?? 0) > 0 && (
                        <VCard variant="tonal" color="warning">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Approval blockers")}</ThemedText>
                                {readiness.value?.blockers.map((blocker) => (
                                    <ThemedText key={blocker} style={{ fontSize: "13px" }}>
                                        • {blockerLabel(blocker)}
                                    </ThemedText>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {!!entry.fourEyesReasons?.length && (
                        <VCard variant="tonal" color="info">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold">{t("Four-eyes reasons")}</ThemedText>
                                {entry.fourEyesReasons.map((reason) => (
                                    <ThemedText key={reason} style={{ fontSize: "13px" }}>
                                        • {blockerLabel(reason)}
                                    </ThemedText>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    {duplicateFlags.value.length > 0 && (
                        <VCard variant="tonal" color="warning">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{t("Duplicate and related-party flags")}</ThemedText>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.75 }}>{COLUMN_HELP.duplicates}</ThemedText>
                                {duplicateFlags.value.map((flag, index) => (
                                    <ThemedText key={index} style={{ fontSize: "13px" }}>
                                        • {duplicateLabel(flag)}
                                    </ThemedText>
                                ))}
                            </VCardText>
                        </VCard>
                    )}

                    <FieldsSections sections={sections.value} />

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
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
                                        <StatusChip label={entry.screening.result} tone={statusTone(entry.screening.result)} />
                                        <StatusChip label={`${entry.screening.matchCount} ${t("matches")}`} tone={entry.screening.matchCount > 0 ? "warning" : "success"} />
                                        <StatusChip label={`${t("Highest score")}: ${entry.screening.highestScore ?? "—"}`} tone="neutral" />
                                    </ThemedView>
                                    {entry.amlDetailsRedacted && <ThemedText style={{ fontSize: "12px", color: "rgb(var(--v-theme-warning))" }}>{t("Match details are redacted for your role.")}</ThemedText>}
                                    {entry.screening.matches.map((match) => (
                                        <VCard key={match.id} variant="tonal">
                                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                    <StatusChip label={match.listType} tone="warning" size="x-small" />
                                                    <StatusChip label={match.disposition} tone={statusTone(match.disposition)} size="x-small" />
                                                    <ThemedText style={{ fontSize: "12px" }}>{t("Score")}: {match.score}</ThemedText>
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "13px" }}>{match.matchedName} · {match.listName}</ThemedText>
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{match.listEntryRef}</ThemedText>
                                                {match.dispositionNotes && <ThemedText style={{ fontSize: "12px" }}>{match.dispositionNotes}</ThemedText>}
                                            </VCardText>
                                        </VCard>
                                    ))}
                                    {(entry.screening.amlCases ?? []).length > 0 && (
                                        <ThemedView style={{ gap: "6px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("AML cases")}</ThemedText>
                                            {entry.screening.amlCases.map((amlCase) => (
                                                <ThemedView key={amlCase.id} style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                                    <StatusChip label={amlCase.status} tone={statusTone(amlCase.status)} size="x-small" />
                                                    <StatusChip label={amlCase.severity} tone={statusTone(amlCase.severity)} size="x-small" />
                                                    <ThemedText style={{ fontSize: "12px", direction: "ltr" }}>{amlCase.id}</ThemedText>
                                                </ThemedView>
                                            ))}
                                        </ThemedView>
                                    )}
                                </ThemedView>
                            )}
                        </VCardText>
                    </VCard>

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
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
                            {activeOwners.value.length === 0 && <ThemedText style={{ opacity: 0.6 }}>{t("No active beneficial owners")}</ThemedText>}
                            {activeOwners.value.map((owner) => (
                                <VCard key={owner.id} variant="tonal">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                            <ThemedView style={{ gap: "2px" }}>
                                                <ThemedText type="defaultSemiBold">{owner.fullNameAr}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                    {owner.fullNameEn || "—"} · {owner.nationality} · {owner.role} · {owner.ownershipPercent ?? "—"}%
                                                </ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusChip label={owner.screeningStatus} tone={statusTone(owner.screeningStatus)} size="x-small" />
                                                {owner.pepDeclared && <StatusChip label="PEP" tone="error" size="x-small" />}
                                                {canWrite.value && !isFinal.value && (
                                                    <>
                                                        <VBtn size="x-small" variant="text" onClick={() => openOwner(owner)}>{t("Edit")}</VBtn>
                                                        <VBtn size="x-small" variant="text" color="error" onClick={() => removeOwner(owner)}>{t("Remove")}</VBtn>
                                                    </>
                                                )}
                                            </ThemedView>
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.55, direction: "ltr" }}>
                                            {owner.id} · {owner.nationalIdHash ?? t("no identity hash")}
                                        </ThemedText>
                                    </VCardText>
                                </VCard>
                            ))}
                        </VCardText>
                    </VCard>

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
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
                                        <StatusChip
                                            key={docTypeRequired}
                                            label={`${docTypeRequired}${accepted ? "" : ` · ${t("missing")}`}`}
                                            tone={accepted ? "success" : "warning"}
                                            size="x-small"
                                        />
                                    );
                                })}
                            </ThemedView>
                            {entry.kybDocuments.length === 0 && <ThemedText style={{ opacity: 0.6 }}>{t("No documents uploaded")}</ThemedText>}
                            {entry.kybDocuments.map((document) => (
                                <VCard key={document.id} variant="tonal">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                            <ThemedView style={{ gap: "3px" }}>
                                                <ThemedText type="defaultSemiBold">{document.docType}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                    {document.originalFileName || "—"} · {formatBytes(document.sizeBytes)} · {formatDateTime(document.createdAt)}
                                                </ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                                <StatusChip label={document.status} tone={statusTone(document.status)} size="x-small" />
                                                <StatusChip label={document.avStatus} tone={statusTone(document.avStatus)} size="x-small" />
                                                {document.expiresOn && <StatusChip label={`exp ${document.expiresOn.slice(0, 10)}`} tone="neutral" size="x-small" />}
                                            </ThemedView>
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.55, direction: "ltr" }}>{document.sha256}</ThemedText>
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
                                    </VCardText>
                                </VCard>
                            ))}
                        </VCardText>
                    </VCard>

                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
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
                        </VCardText>
                    </VCard>

                    {canWrite.value && !isFinal.value && (
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
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
                                    <ThemedText style={{ fontSize: "12px", color: "rgb(var(--v-theme-warning))" }}>
                                        {t("You prepared this admin-assisted request, so an independent operator must decide it.")}
                                    </ThemedText>
                                )}
                            </VCardText>
                        </VCard>
                    )}
                </ThemedView>

                <VDialog modelValue={profileOpen.value} onUpdate:modelValue={(value: boolean) => (profileOpen.value = value)} maxWidth="860px" scrollable>
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Edit applicant profile")}</ThemedText>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
                                <VTextField v-model={profileForm.value.legalName} label={t("Legal name")} />
                                <VTextField v-model={profileForm.value.tradeName} label={t("Trade name")} />
                                <VTextField v-model={profileForm.value.country} label={t("Country code")} />
                                <VTextField v-model={profileForm.value.businessCategory} label={t("Business category")} />
                                <VTextField v-model={profileForm.value.registrationNumber} label={t("Registration number")} />
                                <VTextField v-model={profileForm.value.taxId} label={t("Tax ID")} />
                                <VTextField v-model={profileForm.value.contactPhone} label={t("Contact phone")} />
                                <VTextField v-model={profileForm.value.contactEmail} label={t("Contact email")} />
                                <VTextField v-model={profileForm.value.expectedMonthlyVolume} label={t("Expected monthly volume")} />
                                <VTextField v-model={profileForm.value.currency} label={t("Currency")} />
                                <VTextField v-model={profileForm.value.websiteUrl} label={t("Website URL")} />
                                <VTextField v-model={profileForm.value.payoutBankName} label={t("Payout bank")} />
                                <VTextField v-model={profileForm.value.payoutAccount} label={t("Payout account / IBAN")} />
                            </div>
                            <VTextField v-model={profileForm.value.registeredAddress} label={t("Registered address")} />
                            <VTextarea v-model={profileForm.value.businessUseDescription} label={t("Business use description")} rows={3} autoGrow />
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (profileOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="primary" loading={actionLoading.value} onClick={saveProfile}>{t("Save")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>

                <VDialog modelValue={ownerOpen.value} onUpdate:modelValue={(value: boolean) => (ownerOpen.value = value)} maxWidth="720px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                {editingOwnerId.value ? t("Edit beneficial owner") : t("Add beneficial owner")}
                            </ThemedText>
                            <VAlert type="info" variant="tonal" density="compact">
                                {t("The identity number is encrypted at rest and only its hash is used for duplicate detection.")}
                            </VAlert>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
                                <VTextField v-model={ownerForm.value.fullName} label={t("Full name (Arabic)")} />
                                <VTextField v-model={ownerForm.value.fullNameEn} label={t("Full name (English)")} />
                                <VSelect v-model={ownerForm.value.identityType} label={t("Identity type")} items={["NATIONAL_ID", "PASSPORT"]} />
                                <VTextField v-model={ownerForm.value.identityNumber} label={editingOwnerId.value ? t("New identity number (optional)") : t("Identity number")} />
                                <VTextField v-model={ownerForm.value.nationality} label={t("Nationality")} />
                                <VTextField v-model={ownerForm.value.dateOfBirth} label={t("Date of birth (YYYY-MM-DD)")} />
                                <VTextField v-model={ownerForm.value.ownershipPercent} label={t("Ownership percent")} />
                                <VSelect v-model={ownerForm.value.role} label={t("Role")} items={["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"]} />
                                <VCheckbox v-model={ownerForm.value.pepDeclared} label={t("Declared PEP")} density="compact" hideDetails />
                            </div>
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (ownerOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="primary" loading={actionLoading.value} onClick={saveOwner}>{t("Save")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>

                <VDialog modelValue={uploadOpen.value} onUpdate:modelValue={(value: boolean) => (uploadOpen.value = value)} maxWidth="560px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Upload KYB document")}</ThemedText>
                            <VSelect v-model={docType.value} label={t("Document type")} items={DOCUMENT_TYPES} />
                            <VTextField v-model={docExpiresOn.value} label={t("Expiry date (YYYY-MM-DD, optional)")} />
                            <input ref={docFileInput} type="file" accept="application/pdf,image/png,image/jpeg" />
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                {t("PDF, PNG or JPEG up to 10 MiB. The file is magic-byte checked, malware scanned and encrypted before storage.")}
                            </ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (uploadOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="primary" loading={actionLoading.value} onClick={uploadDocument}>{t("Upload")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>

                <VDialog modelValue={reviewOpen.value} onUpdate:modelValue={(value: boolean) => (reviewOpen.value = value)} maxWidth="560px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Review document")}</ThemedText>
                            <ThemedText style={{ fontSize: "13px" }}>{reviewTarget.value?.docType} · {reviewTarget.value?.originalFileName}</ThemedText>
                            <VSelect v-model={reviewDecision.value} label={t("Decision")} items={[{ title: "Accept", value: "ACCEPTED" }, { title: "Reject", value: "REJECTED" }]} />
                            <VTextField v-model={reviewExpiresOn.value} label={t("Expiry date (YYYY-MM-DD, optional)")} />
                            <VTextarea v-model={reviewNotes.value} label={t("Review notes")} rows={3} autoGrow />
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (reviewOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="primary" loading={actionLoading.value} onClick={saveReview}>{t("Save review")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>

                <VDialog modelValue={infoOpen.value} onUpdate:modelValue={(value: boolean) => (infoOpen.value = value)} maxWidth="620px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Request information")}</ThemedText>
                            <VTextField v-model={infoItems.value} label={t("Requested items (comma separated)")} />
                            <VTextarea v-model={infoMessage.value} label={t("Message")} rows={4} autoGrow />
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                {t("The onboarding SLA is paused while the request is in INFO_REQUESTED.")}
                            </ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (infoOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="warning" loading={actionLoading.value} onClick={requestInfo}>{t("Request")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>

                <VDialog modelValue={decisionOpen.value} onUpdate:modelValue={(value: boolean) => (decisionOpen.value = value)} maxWidth="620px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                {decision.value === "APPROVED" ? t("Approve join request") : t("Reject join request")}
                            </ThemedText>
                            {decision.value === "APPROVED" && !readiness.value?.ready && (
                                <VAlert type="warning" variant="tonal">{t("All approval blockers must be cleared before approval.")}</VAlert>
                            )}
                            {decision.value === "APPROVED" && (
                                <VSelect v-model={decisionRiskTier.value} label={t("Activation risk tier")} items={["LOW", "STANDARD", "HIGH"]} />
                            )}
                            {decision.value === "REJECTED" && (
                                <VSelect v-model={decisionReason.value} label={t("Reason code")} items={REJECTION_REASONS} />
                            )}
                            <VTextarea v-model={decisionNotes.value} label={t("Decision notes")} rows={4} autoGrow />
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={closeDecision}>{t("Cancel")}</VBtn>
                                <VBtn
                                    color={decision.value === "APPROVED" ? "success" : "error"}
                                    loading={actionLoading.value}
                                    disabled={decision.value === "APPROVED" && !readiness.value?.ready}
                                    onClick={() => void decide()}
                                >
                                    {decision.value === "APPROVED" ? t("Propose approval") : t("Propose rejection")}
                                </VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>

                <VDialog modelValue={withdrawOpen.value} onUpdate:modelValue={(value: boolean) => (withdrawOpen.value = value)} maxWidth="520px">
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Withdraw join request")}</ThemedText>
                            <ThemedText>{t("The request will be closed as withdrawn. A pending checker approval is cancelled.")}</ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                <VBtn variant="text" onClick={() => (withdrawOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="error" loading={actionLoading.value} onClick={withdraw}>{t("Withdraw")}</VBtn>
                            </ThemedView>
                        </VCardText>
                    </VCard>
                </VDialog>
            </ScreenContainer>
        );
    };
});

export default JoinRequestDetailPage;
