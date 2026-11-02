import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VFileInput, VSelect, VTextField, VTextarea, VTimeline, VTimelineItem } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { toDecimal } from "@/utils/money";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList, type DescriptionItem } from "@/components/ui/DescriptionList";
import { EmptyState } from "@/components/ui/EmptyState";
type BusinessProfile = {
    legalName: string;
    tradeName: string;
    registrationNumber: string;
    taxId: string;
    businessCategory: string;
    registeredAddress: string;
    contactPhone: string;
    contactEmail: string;
    expectedMonthlyVolume: string;
    currency: string;
    website: string;
    businessUseDescription: string;
};

type Owner = {
    fullName: string;
    ownershipPercent: string;
    nationalId: string;
    dateOfBirth: string;
    nationality: string;
    isPep: boolean;
    isController: boolean;
};

type DocumentItem = {
    id?: string;
    docType: string;
    file: File | null;
    expiresOn: string;
};

type RevalidationRequest = {
    id: string;
    docType: string;
    message: string;
    dueAt: string | null;
    status: string;
    sourceDocument?: { id: string; docType: string; originalFileName: string | null } | null;
};

const STEPS = [
    { key: "profile", title: "Business Profile" },
    { key: "owners", title: "Beneficial Owners" },
    { key: "documents", title: "Documents" },
    { key: "payout", title: "Bank Details" },
    { key: "review", title: "Submit Application" },
];

const DOCUMENT_TYPES = [
    { title: "Commercial Registry", value: "COMMERCIAL_REGISTRY" },
    { title: "Tax Certificate", value: "TAX_CERTIFICATE" },
    { title: "Articles Of Association", value: "ARTICLES_OF_ASSOCIATION" },
    { title: "Proof Of Address", value: "PROOF_OF_ADDRESS" },
    { title: "Bank Letter", value: "BANK_LETTER" },
    { title: "Sector Licence", value: "SECTOR_LICENSE" },
    { title: "Owner ID", value: "OWNER_ID" },
    { title: "Signatory ID", value: "SIGNATORY_ID" },
    { title: "Other", value: "OTHER" },
];

const CATEGORIES = [
    "RETAIL",
    "WHOLESALE",
    "SERVICES",
    "TRANSPORT",
    "HOSPITALITY",
    "ELECTRONICS",
    "EDUCATION",
    "HEALTHCARE",
    "OTHER",
];

const emptyProfile = (): BusinessProfile => ({
    legalName: "",
    tradeName: "",
    registrationNumber: "",
    taxId: "",
    businessCategory: "",
    registeredAddress: "",
    contactPhone: "",
    contactEmail: "",
    expectedMonthlyVolume: "",
    currency: "LYD",
    website: "",
    businessUseDescription: "",
});

const OnboardingPage = dc(() => {
    const { t } = useLocale();
    const step = ref(1);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const saving = ref(false);
    const joinStatus = ref<string | null>(null);
    const requestedInfo = ref<string | null>(null);

    const profile = ref<BusinessProfile>(emptyProfile());
    const owners = ref<Owner[]>([]);
    const documents = ref<DocumentItem[]>([]);
    const revalidations = ref<RevalidationRequest[]>([]);
    const revalidationFiles = ref<Record<string, File | null>>({});
    const revalidationExpiry = ref<Record<string, string>>({});
    const payout = ref({
        bankName: "",
        accountHolder: "",
        iban: "",
        accountNumber: "",
        swift: "",
    });

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [response, revalidationResponse] = await Promise.all([
                api.get(urlsMap.onboardingJoinRequest),
                api.get(urlsMap.onboardingKybRevalidations).catch(() => null),
            ]);
            const payload = response.data?.data ?? response.data ?? {};
            joinStatus.value = payload.status ?? payload.joinRequest?.status ?? null;
            requestedInfo.value = payload.requestedInfo ?? null;
            const source = payload.profile ?? payload.businessProfile ?? payload;
            profile.value = { ...emptyProfile(), ...source };
            owners.value = payload.beneficialOwners ?? payload.owners ?? [];
            documents.value = payload.documents ?? [];
            const revalidationPayload = revalidationResponse?.data?.data ?? revalidationResponse?.data ?? {};
            revalidations.value = (revalidationPayload.revalidations ?? []).filter(
                (request: RevalidationRequest) => request.status === "OPEN",
            );
            payout.value = { ...payout.value, ...(payload.payoutBankDetails ?? {}) };
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const saveProfile = async () => {
        saving.value = true;
        try {
            await api.put(urlsMap.onboardingJoinRequest, profile.value);
            showSnackBar({ type: "success", message: t("Saved") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            saving.value = false;
        }
    };

    const saveOwners = async () => {
        saving.value = true;
        try {
            for (const owner of owners.value) {
                await api.post(urlsMap.onboardingBeneficialOwners, owner);
            }
            showSnackBar({ type: "success", message: t("Saved") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            saving.value = false;
        }
    };

    const uploadDocument = async (document: DocumentItem) => {
        if (!document.file) {
            return;
        }
        saving.value = true;
        try {
            const body = new FormData();
            body.append("documentType", document.docType);
            body.append("expiresAt", document.expiresOn);
            body.append("document", document.file);
            await api.post(urlsMap.onboardingKybDocuments, body, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            showSnackBar({ type: "success", message: t("Uploaded File") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            saving.value = false;
        }
    };

    const uploadRevalidation = async (request: RevalidationRequest) => {
        const file = revalidationFiles.value[request.id];
        if (!file) {
            showSnackBar({ type: "warning", message: t("Choose a replacement document first") });
            return;
        }
        saving.value = true;
        try {
            const body = new FormData();
            body.append("documentType", request.docType);
            body.append("expiresAt", revalidationExpiry.value[request.id] ?? "");
            body.append("revalidationRequestId", request.id);
            body.append("document", file);
            await api.post(urlsMap.onboardingKybDocuments, body, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            showSnackBar({ type: "success", message: t("Replacement uploaded") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            saving.value = false;
        }
    };

    const submit = async () => {
        saving.value = true;
        try {
            await api.post(urlsMap.onboardingSubmit, { acknowledgement: true });
            showSnackBar({ type: "success", message: t("Submit Application") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            saving.value = false;
        }
    };

    const totalOwnership = computed(() =>
        owners.value.reduce((total, owner) => total.plus(toDecimal(owner.ownershipPercent)), toDecimal(0)),
    );

    const profileComplete = computed(
        () =>
            !!profile.value.legalName &&
            !!profile.value.tradeName &&
            !!profile.value.registrationNumber &&
            !!profile.value.taxId &&
            !!profile.value.businessCategory,
    );

    const ownersComplete = computed(() => owners.value.length > 0 && totalOwnership.value.greaterThanOrEqualTo(25));

    const documentsComplete = computed(() => documents.value.length > 0);

    const payoutComplete = computed(
        () => !!payout.value.bankName && !!payout.value.accountHolder && !!payout.value.iban,
    );

    const stepValid = (index: number) => {
        switch (index) {
            case 1:
                return profileComplete.value;
            case 2:
                return ownersComplete.value;
            case 3:
                return documentsComplete.value;
            case 4:
                return payoutComplete.value;
            default:
                return true;
        }
    };

    const reviewItems = computed<DescriptionItem[]>(() => [
        { label: t("Legal Name"), value: profile.value.legalName || "-" },
        {
            label: t("Registration Number"),
            value: profile.value.registrationNumber ? (
                <MonoRef value={profile.value.registrationNumber} truncate={18} />
            ) : (
                "-"
            ),
        },
        {
            label: t("Tax ID"),
            value: profile.value.taxId ? <MonoRef value={profile.value.taxId} truncate={18} /> : "-",
        },
        { label: t("Business Category"), value: profile.value.businessCategory || "-" },
        {
            label: t("Expected Monthly Volume"),
            value: profile.value.expectedMonthlyVolume ? (
                <MoneyDisplay
                    amount={profile.value.expectedMonthlyVolume}
                    currency={profile.value.currency || "LYD"}
                    size="sm"
                />
            ) : (
                "-"
            ),
        },
        { label: t("Beneficial Owners"), value: owners.value.length },
        { label: t("Documents"), value: documents.value.length },
        { label: t("Bank Details"), value: payout.value.bankName || "-" },
    ]);

    const addOwner = () => {
        owners.value = [
            ...owners.value,
            {
                fullName: "",
                ownershipPercent: "",
                nationalId: "",
                dateOfBirth: "",
                nationality: "",
                isPep: false,
                isController: false,
            },
        ];
    };

    const addDocument = () => {
        documents.value = [
            ...documents.value,
            { docType: DOCUMENT_TYPES[0]?.value ?? "COMMERCIAL_REGISTRY", file: null, expiresOn: "" },
        ];
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Merchant Onboarding")}
                    subtitle={t("Complete KYB, payout, and storefront details for activation.")}
                    end={() =>
                        joinStatus.value ? <StatusBadge status={joinStatus.value} toneOverride="info" /> : <></>
                    }
                />

                {requestedInfo.value && (
                    <VAlert type="warning" variant="tonal" density="compact">
                        {requestedInfo.value}
                    </VAlert>
                )}

                {revalidations.value.length > 0 && (
                    <SurfaceCard variant="tonal" color="warning" bodyGap="12px">
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                            {t("KYB re-verification required")}
                        </ThemedText>
                        {revalidations.value.map((request) => (
                            <ThemedView key={request.id} style={{ gap: "8px" }}>
                                <ThemedText style={{ fontSize: "13px" }}>
                                    {request.docType}: {request.message}
                                </ThemedText>
                                {request.dueAt && (
                                    <ThemedText style={{ fontSize: "11px", color: "var(--pg-ink-muted)" }}>
                                        {t("Due")}: {new Date(request.dueAt).toLocaleDateString()}
                                    </ThemedText>
                                )}
                                <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }}>
                                    <FormField label={t("Replacement file")} style={{ minWidth: "260px" }}>
                                        <VFileInput
                                            modelValue={revalidationFiles.value[request.id] ?? null}
                                            onUpdate:modelValue={(value: File | File[] | null) => {
                                                revalidationFiles.value[request.id] = Array.isArray(value) ? (value[0] ?? null) : value;
                                            }}
                                            density="compact"
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Expiry date")} style={{ minWidth: "180px" }}>
                                        <VTextField
                                            modelValue={revalidationExpiry.value[request.id] ?? ""}
                                            onUpdate:modelValue={(value: string) => (revalidationExpiry.value[request.id] = value)}
                                            density="compact"
                                            hideDetails
                                        />
                                    </FormField>
                                    <VBtn
                                        size="small"
                                        variant="flat"
                                        color="warning"
                                        loading={saving.value}
                                        onClick={() => void uploadRevalidation(request)}
                                    >
                                        {t("Upload replacement")}
                                    </VBtn>
                                </ThemedView>
                            </ThemedView>
                        ))}
                    </SurfaceCard>
                )}

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <SurfaceCard>
                            <VTimeline density="compact" side="end" align="start">
                                {STEPS.map((item, index) => (
                                    <VTimelineItem key={item.key} size="small">
                                        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                                            <ThemedText
                                                style={{
                                                    fontWeight: index + 1 === step.value ? "800" : "500",
                                                    fontSize: "14px",
                                                }}
                                            >
                                                {t(item.title)}
                                            </ThemedText>
                                            {stepValid(index + 1) && (
                                                <StatusBadge status="APPROVED" label={t("Approved")} />
                                            )}
                                        </div>
                                    </VTimelineItem>
                                ))}
                            </VTimeline>
                        </SurfaceCard>

                        {step.value === 1 && (
                            <SurfaceCard title={t("Business Profile")} bodyGap="12px">
                                <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                                    <FormField label={t("Legal Name")} required style={{ minWidth: "240px", flex: "1 1 240px" }}>
                                        <VTextField
                                            modelValue={profile.value.legalName}
                                            onUpdate:modelValue={(v: string) => (profile.value.legalName = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Trade Name")} required style={{ minWidth: "240px", flex: "1 1 240px" }}>
                                        <VTextField
                                            modelValue={profile.value.tradeName}
                                            onUpdate:modelValue={(v: string) => (profile.value.tradeName = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Registration Number")} required style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VTextField
                                            modelValue={profile.value.registrationNumber}
                                            onUpdate:modelValue={(v: string) => (profile.value.registrationNumber = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Tax ID")} required style={{ minWidth: "200px", flex: "1 1 200px" }}>
                                        <VTextField
                                            modelValue={profile.value.taxId}
                                            onUpdate:modelValue={(v: string) => (profile.value.taxId = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Business Category")} required style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VSelect
                                            items={CATEGORIES}
                                            modelValue={profile.value.businessCategory}
                                            onUpdate:modelValue={(v: string) => (profile.value.businessCategory = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Phone")} style={{ minWidth: "180px", flex: "1 1 180px" }}>
                                        <VTextField
                                            modelValue={profile.value.contactPhone}
                                            onUpdate:modelValue={(v: string) => (profile.value.contactPhone = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Email")} style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VTextField
                                            modelValue={profile.value.contactEmail}
                                            onUpdate:modelValue={(v: string) => (profile.value.contactEmail = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Expected Monthly Volume")} style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VTextField
                                            modelValue={profile.value.expectedMonthlyVolume}
                                            onUpdate:modelValue={(v: string) => (profile.value.expectedMonthlyVolume = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Currency")} style={{ minWidth: "130px", flex: "0 1 130px" }}>
                                        <VTextField
                                            modelValue={profile.value.currency}
                                            onUpdate:modelValue={(v: string) => (profile.value.currency = v.toUpperCase())}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Website")} style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VTextField
                                            modelValue={profile.value.website}
                                            onUpdate:modelValue={(v: string) => (profile.value.website = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                </ThemedView>
                                <FormField label={t("Registered Address")}>
                                    <VTextField
                                        modelValue={profile.value.registeredAddress}
                                        onUpdate:modelValue={(v: string) => (profile.value.registeredAddress = v)}
                                        hideDetails
                                    />
                                </FormField>
                                <FormField label={t("Sales Channel Description")}>
                                    <VTextarea
                                        modelValue={profile.value.businessUseDescription}
                                        onUpdate:modelValue={(v: string) => (profile.value.businessUseDescription = v)}
                                        rows={3}
                                        hideDetails
                                    />
                                </FormField>
                                <VBtn variant="tonal" loading={saving.value} onClick={() => void saveProfile()}>
                                    {t("Save")}
                                </VBtn>
                            </SurfaceCard>
                        )}

                        {step.value === 2 && (
                            <SurfaceCard
                                title={t("Beneficial Owners")}
                                bodyGap="12px"
                                v-slots={{
                                    headerActions: () => (
                                        <VBtn variant="tonal" size="small" onClick={addOwner}>
                                            {t("Add")}
                                        </VBtn>
                                    ),
                                }}
                            >
                                {owners.value.length === 0 ? (
                                    <EmptyState
                                        title={t("No beneficial owners yet")}
                                        description={t("Add each owner with 25% or more ownership.")}
                                    />
                                ) : (
                                    owners.value.map((owner, index) => (
                                        <ThemedView
                                            key={index}
                                            style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }}
                                        >
                                            <FormField label={t("Full Name")} required style={{ minWidth: "200px", flex: "1 1 200px" }}>
                                                <VTextField
                                                    modelValue={owner.fullName}
                                                    onUpdate:modelValue={(v: string) => (owners.value[index]!.fullName = v)}
                                                    hideDetails
                                                />
                                            </FormField>
                                            <FormField label={t("Ownership Percent")} required style={{ minWidth: "160px", flex: "0 1 160px" }}>
                                                <VTextField
                                                    modelValue={owner.ownershipPercent}
                                                    onUpdate:modelValue={(v: string) =>
                                                        (owners.value[index]!.ownershipPercent = v)
                                                    }
                                                    hideDetails
                                                />
                                            </FormField>
                                            <FormField label={t("National ID")} style={{ minWidth: "180px", flex: "1 1 180px" }}>
                                                <VTextField
                                                    modelValue={owner.nationalId}
                                                    onUpdate:modelValue={(v: string) => (owners.value[index]!.nationalId = v)}
                                                    hideDetails
                                                />
                                            </FormField>
                                            <FormField label={t("Date Of Birth")} style={{ minWidth: "170px", flex: "0 1 170px" }}>
                                                <VTextField
                                                    modelValue={owner.dateOfBirth}
                                                    onUpdate:modelValue={(v: string) =>
                                                        (owners.value[index]!.dateOfBirth = v)
                                                    }
                                                    hideDetails
                                                />
                                            </FormField>
                                            <FormField label={t("Nationality")} style={{ minWidth: "150px", flex: "0 1 150px" }}>
                                                <VTextField
                                                    modelValue={owner.nationality}
                                                    onUpdate:modelValue={(v: string) => (owners.value[index]!.nationality = v)}
                                                    hideDetails
                                                />
                                            </FormField>
                                            <VBtn
                                                size="x-small"
                                                variant="text"
                                                color="error"
                                                onClick={() => (owners.value = owners.value.filter((_, i) => i !== index))}
                                            >
                                                {t("Remove")}
                                            </VBtn>
                                        </ThemedView>
                                    ))
                                )}

                                <ThemedText style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                                    {t("Ownership Percent")}: {totalOwnership.value.toString()}%
                                </ThemedText>
                                <VBtn variant="tonal" loading={saving.value} onClick={() => void saveOwners()}>
                                    {t("Save")}
                                </VBtn>
                            </SurfaceCard>
                        )}

                        {step.value === 3 && (
                            <SurfaceCard
                                title={t("Documents")}
                                bodyGap="12px"
                                v-slots={{
                                    headerActions: () => (
                                        <VBtn variant="tonal" size="small" onClick={addDocument}>
                                            {t("Add")}
                                        </VBtn>
                                    ),
                                }}
                            >
                                {documents.value.length === 0 ? (
                                    <EmptyState
                                        title={t("No documents uploaded yet")}
                                        description={t("Add the KYB documents required for activation.")}
                                    />
                                ) : (
                                    documents.value.map((document, index) => (
                                        <ThemedView
                                            key={index}
                                            style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }}
                                        >
                                            <FormField label={t("Document Type")} style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                                <VSelect
                                                    items={DOCUMENT_TYPES}
                                                    itemTitle="title"
                                                    itemValue="value"
                                                    modelValue={document.docType}
                                                    onUpdate:modelValue={(v: string) => (documents.value[index]!.docType = v)}
                                                    hideDetails
                                                />
                                            </FormField>
                                            <FormField label={t("Uploaded File")} style={{ minWidth: "260px", flex: "1 1 260px" }}>
                                                <VFileInput
                                                    modelValue={document.file}
                                                    onUpdate:modelValue={(v: File | File[] | null) => {
                                                        documents.value[index]!.file = Array.isArray(v) ? (v[0] ?? null) : v;
                                                    }}
                                                    hideDetails
                                                />
                                            </FormField>
                                            <FormField label={t("Expiry Date")} style={{ minWidth: "170px", flex: "0 1 170px" }}>
                                                <VTextField
                                                    modelValue={document.expiresOn}
                                                    onUpdate:modelValue={(v: string) => (documents.value[index]!.expiresOn = v)}
                                                    hideDetails
                                                />
                                            </FormField>
                                            <VBtn
                                                size="small"
                                                variant="tonal"
                                                loading={saving.value}
                                                onClick={() => void uploadDocument(document)}
                                            >
                                                {t("Upload")}
                                            </VBtn>
                                        </ThemedView>
                                    ))
                                )}
                            </SurfaceCard>
                        )}

                        {step.value === 4 && (
                            <SurfaceCard title={t("Bank Details")} bodyGap="12px">
                                <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                                    <FormField label={t("Bank")} style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VTextField
                                            modelValue={payout.value.bankName}
                                            onUpdate:modelValue={(v: string) => (payout.value.bankName = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Account Holder")} style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VTextField
                                            modelValue={payout.value.accountHolder}
                                            onUpdate:modelValue={(v: string) => (payout.value.accountHolder = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("IBAN")} style={{ minWidth: "220px", flex: "1 1 220px" }}>
                                        <VTextField
                                            modelValue={payout.value.iban}
                                            onUpdate:modelValue={(v: string) => (payout.value.iban = v.toUpperCase())}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("Account Number")} style={{ minWidth: "200px", flex: "1 1 200px" }}>
                                        <VTextField
                                            modelValue={payout.value.accountNumber}
                                            onUpdate:modelValue={(v: string) => (payout.value.accountNumber = v)}
                                            hideDetails
                                        />
                                    </FormField>
                                    <FormField label={t("SWIFT")} style={{ minWidth: "170px", flex: "0 1 170px" }}>
                                        <VTextField
                                            modelValue={payout.value.swift}
                                            onUpdate:modelValue={(v: string) => (payout.value.swift = v.toUpperCase())}
                                            hideDetails
                                        />
                                    </FormField>
                                </ThemedView>
                            </SurfaceCard>
                        )}

                        {step.value === 5 && (
                            <SurfaceCard title={t("Submit Application")} bodyGap="12px">
                                <DescriptionList items={reviewItems.value} columns={2} />
                                <VBtn color="primary" loading={saving.value} onClick={() => void submit()}>
                                    {t("Submit Application")}
                                </VBtn>
                            </SurfaceCard>
                        )}

                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                            <VBtn variant="tonal" disabled={step.value <= 1} onClick={() => (step.value -= 1)}>
                                {t("Back")}
                            </VBtn>
                            {step.value < STEPS.length ? (
                                <VBtn
                                    color="primary"
                                    disabled={!stepValid(step.value)}
                                    onClick={() => (step.value += 1)}
                                >
                                    {t("Continue")}
                                </VBtn>
                            ) : (
                                <span />
                            )}
                        </ThemedView>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default OnboardingPage;
