import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VFileInput, VSelect, VTextField, VTextarea, VTimeline, VTimelineItem } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { percentOf, toDecimal } from "@/utils/money";

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

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Merchant Onboarding")}
                    end={() =>
                        joinStatus.value ? <StatusChip label={joinStatus.value} tone="info" /> : (<></>)
                    }
                />

                {requestedInfo.value && (
                    <VAlert type="warning" variant="tonal" density="compact">
                        {requestedInfo.value}
                    </VAlert>
                )}

                {revalidations.value.length > 0 && (
                    <VCard variant="tonal" color="warning">
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                {t("KYB re-verification required")}
                            </ThemedText>
                            {revalidations.value.map((request) => (
                                <ThemedView key={request.id} style={{ gap: "8px" }}>
                                    <ThemedText style={{ fontSize: "13px" }}>
                                        {request.docType}: {request.message}
                                    </ThemedText>
                                    {request.dueAt && (
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                            {t("Due")}: {new Date(request.dueAt).toLocaleDateString()}
                                        </ThemedText>
                                    )}
                                    <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                                        <VFileInput
                                            label={t("Replacement file")}
                                            modelValue={revalidationFiles.value[request.id] ?? null}
                                            onUpdate:modelValue={(value: File | File[] | null) => {
                                                revalidationFiles.value[request.id] = Array.isArray(value) ? (value[0] ?? null) : value;
                                            }}
                                            density="compact"
                                            hideDetails
                                            style={{ minWidth: "260px" }}
                                        />
                                        <VTextField
                                            label={t("Expiry date")}
                                            modelValue={revalidationExpiry.value[request.id] ?? ""}
                                            onUpdate:modelValue={(value: string) => (revalidationExpiry.value[request.id] = value)}
                                            density="compact"
                                            hideDetails
                                            style={{ minWidth: "180px" }}
                                        />
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
                        </VCardText>
                    </VCard>
                )}

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <VCard>
                            <VCardText>
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
                                                {stepValid(index + 1) && <StatusChip label={t("Approved")} tone="success" />}
                                            </div>
                                        </VTimelineItem>
                                    ))}
                                </VTimeline>
                            </VCardText>
                        </VCard>

                        {step.value === 1 && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                        {t("Business Profile")}
                                    </ThemedText>
                                    <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                                        <VTextField
                                            label={t("Legal Name")}
                                            modelValue={profile.value.legalName}
                                            onUpdate:modelValue={(v: string) => (profile.value.legalName = v)}
                                            style={{ minWidth: "240px" }}
                                        />
                                        <VTextField
                                            label={t("Trade Name")}
                                            modelValue={profile.value.tradeName}
                                            onUpdate:modelValue={(v: string) => (profile.value.tradeName = v)}
                                            style={{ minWidth: "240px" }}
                                        />
                                        <VTextField
                                            label={t("Registration Number")}
                                            modelValue={profile.value.registrationNumber}
                                            onUpdate:modelValue={(v: string) => (profile.value.registrationNumber = v)}
                                            style={{ minWidth: "220px" }}
                                        />
                                        <VTextField
                                            label={t("Tax ID")}
                                            modelValue={profile.value.taxId}
                                            onUpdate:modelValue={(v: string) => (profile.value.taxId = v)}
                                            style={{ minWidth: "200px" }}
                                        />
                                        <VSelect
                                            items={CATEGORIES}
                                            modelValue={profile.value.businessCategory}
                                            onUpdate:modelValue={(v: string) => (profile.value.businessCategory = v)}
                                            label={t("Business Category")}
                                            style={{ minWidth: "220px" }}
                                        />
                                        <VTextField
                                            label={t("Phone")}
                                            modelValue={profile.value.contactPhone}
                                            onUpdate:modelValue={(v: string) => (profile.value.contactPhone = v)}
                                            style={{ minWidth: "180px" }}
                                        />
                                        <VTextField
                                            label={t("Email")}
                                            modelValue={profile.value.contactEmail}
                                            onUpdate:modelValue={(v: string) => (profile.value.contactEmail = v)}
                                            style={{ minWidth: "220px" }}
                                        />
                                        <VTextField
                                            label={t("Expected Monthly Volume")}
                                            modelValue={profile.value.expectedMonthlyVolume}
                                            onUpdate:modelValue={(v: string) => (profile.value.expectedMonthlyVolume = v)}
                                            style={{ minWidth: "220px" }}
                                        />
                                        <VTextField
                                            label={t("Currency")}
                                            modelValue={profile.value.currency}
                                            onUpdate:modelValue={(v: string) => (profile.value.currency = v.toUpperCase())}
                                            style={{ minWidth: "130px" }}
                                        />
                                        <VTextField
                                            label={t("Website")}
                                            modelValue={profile.value.website}
                                            onUpdate:modelValue={(v: string) => (profile.value.website = v)}
                                            style={{ minWidth: "220px" }}
                                        />
                                    </ThemedView>
                                    <VTextField
                                        label={t("Registered Address")}
                                        modelValue={profile.value.registeredAddress}
                                        onUpdate:modelValue={(v: string) => (profile.value.registeredAddress = v)}
                                    />
                                    <VTextarea
                                        label={t("Sales Channel Description")}
                                        modelValue={profile.value.businessUseDescription}
                                        onUpdate:modelValue={(v: string) => (profile.value.businessUseDescription = v)}
                                        rows={3}
                                    />
                                    <VBtn variant="tonal" loading={saving.value} onClick={() => void saveProfile()}>
                                        {t("Save")}
                                    </VBtn>
                                </VCardText>
                            </VCard>
                        )}

                        {step.value === 2 && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedView
                                        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                                    >
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                            {t("Beneficial Owners")}
                                        </ThemedText>
                                        <VBtn
                                            variant="tonal"
                                            size="small"
                                            onClick={() =>
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
                                                ]
                                            }
                                        >
                                            {t("Add")}
                                        </VBtn>
                                    </ThemedView>

                                    {owners.value.map((owner, index) => (
                                        <ThemedView
                                            key={index}
                                            style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "center" }}
                                        >
                                            <VTextField
                                                label={t("Full Name")}
                                                modelValue={owner.fullName}
                                                onUpdate:modelValue={(v: string) => (owners.value[index]!.fullName = v)}
                                                style={{ minWidth: "200px" }}
                                            />
                                            <VTextField
                                                label={t("Ownership Percent")}
                                                modelValue={owner.ownershipPercent}
                                                onUpdate:modelValue={(v: string) =>
                                                    (owners.value[index]!.ownershipPercent = v)
                                                }
                                                style={{ minWidth: "160px" }}
                                            />
                                            <VTextField
                                                label={t("National ID")}
                                                modelValue={owner.nationalId}
                                                onUpdate:modelValue={(v: string) => (owners.value[index]!.nationalId = v)}
                                                style={{ minWidth: "180px" }}
                                            />
                                            <VTextField
                                                label={t("Date Of Birth")}
                                                modelValue={owner.dateOfBirth}
                                                onUpdate:modelValue={(v: string) =>
                                                    (owners.value[index]!.dateOfBirth = v)
                                                }
                                                style={{ minWidth: "170px" }}
                                            />
                                            <VTextField
                                                label={t("Nationality")}
                                                modelValue={owner.nationality}
                                                onUpdate:modelValue={(v: string) => (owners.value[index]!.nationality = v)}
                                                style={{ minWidth: "150px" }}
                                            />
                                            <VBtn
                                                size="x-small"
                                                variant="text"
                                                color="error"
                                                onClick={() => (owners.value = owners.value.filter((_, i) => i !== index))}
                                            >
                                                ×
                                            </VBtn>
                                        </ThemedView>
                                    ))}

                                    <ThemedText style={{ fontSize: "13px" }}>
                                        {t("Ownership Percent")}: {totalOwnership.value.toString()}%
                                    </ThemedText>
                                    <VBtn variant="tonal" loading={saving.value} onClick={() => void saveOwners()}>
                                        {t("Save")}
                                    </VBtn>
                                </VCardText>
                            </VCard>
                        )}

                        {step.value === 3 && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedView
                                        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                                    >
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                            {t("Documents")}
                                        </ThemedText>
                                        <VBtn
                                            variant="tonal"
                                            size="small"
                                            onClick={() =>
                                                documents.value = [
                                                    ...documents.value,
                                                    { docType: DOCUMENT_TYPES[0]?.value ?? "COMMERCIAL_REGISTRY", file: null, expiresOn: "" },
                                                ]
                                            }
                                        >
                                            {t("Add")}
                                        </VBtn>
                                    </ThemedView>

                                    {documents.value.map((document, index) => (
                                        <ThemedView
                                            key={index}
                                            style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "center" }}
                                        >
                                            <VSelect
                                                items={DOCUMENT_TYPES}
                                                itemTitle="title"
                                                itemValue="value"
                                                modelValue={document.docType}
                                                onUpdate:modelValue={(v: string) => (documents.value[index]!.docType = v)}
                                                label={t("Document Type")}
                                                style={{ minWidth: "220px" }}
                                            />
                                            <VFileInput
                                                label={t("Uploaded File")}
                                                modelValue={document.file}
                                                onUpdate:modelValue={(v: File | File[] | null) => {
                                                    documents.value[index]!.file = Array.isArray(v) ? (v[0] ?? null) : v;
                                                }}
                                                style={{ minWidth: "260px" }}
                                            />
                                            <VTextField
                                                label={t("Expiry Date")}
                                                modelValue={document.expiresOn}
                                                onUpdate:modelValue={(v: string) => (documents.value[index]!.expiresOn = v)}
                                                style={{ minWidth: "170px" }}
                                            />
                                            <VBtn
                                                size="small"
                                                variant="tonal"
                                                loading={saving.value}
                                                onClick={() => void uploadDocument(document)}
                                            >
                                                {t("Upload")}
                                            </VBtn>
                                        </ThemedView>
                                    ))}
                                </VCardText>
                            </VCard>
                        )}

                        {step.value === 4 && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                        {t("Bank Details")}
                                    </ThemedText>
                                    <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                                        <VTextField
                                            label={t("Bank")}
                                            modelValue={payout.value.bankName}
                                            onUpdate:modelValue={(v: string) => (payout.value.bankName = v)}
                                            style={{ minWidth: "220px" }}
                                        />
                                        <VTextField
                                            label={t("Legal Name")}
                                            modelValue={payout.value.accountHolder}
                                            onUpdate:modelValue={(v: string) => (payout.value.accountHolder = v)}
                                            style={{ minWidth: "220px" }}
                                        />
                                        <VTextField
                                            label="IBAN"
                                            modelValue={payout.value.iban}
                                            onUpdate:modelValue={(v: string) => (payout.value.iban = v.toUpperCase())}
                                            style={{ minWidth: "220px" }}
                                        />
                                        <VTextField
                                            label={t("Token Name")}
                                            modelValue={payout.value.accountNumber}
                                            onUpdate:modelValue={(v: string) => (payout.value.accountNumber = v)}
                                            style={{ minWidth: "200px" }}
                                        />
                                        <VTextField
                                            label="SWIFT"
                                            modelValue={payout.value.swift}
                                            onUpdate:modelValue={(v: string) => (payout.value.swift = v.toUpperCase())}
                                            style={{ minWidth: "170px" }}
                                        />
                                    </ThemedView>
                                </VCardText>
                            </VCard>
                        )}

                        {step.value === 5 && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                        {t("Submit Application")}
                                    </ThemedText>
                                    <ThemedView style={{ flexDirection: "column", gap: "6px", fontSize: "13px" }}>
                                        <span>
                                            {t("Legal Name")}: {profile.value.legalName || "-"}
                                        </span>
                                        <span>
                                            {t("Business Category")}: {profile.value.businessCategory || "-"}
                                        </span>
                                        <span>
                                            {t("Expected Monthly Volume")}: {profile.value.expectedMonthlyVolume || "-"} {" "}
                                            {profile.value.currency}
                                        </span>
                                        <span>
                                            {t("Beneficial Owners")}: {owners.value.length}
                                        </span>
                                        <span>
                                            {t("Documents")}: {documents.value.length}
                                        </span>
                                        <span>
                                            {t("Bank Details")}: {payout.value.bankName || "-"}
                                        </span>
                                    </ThemedView>
                                    <VBtn color="primary" loading={saving.value} onClick={() => void submit()}>
                                        {t("Submit Application")}
                                    </VBtn>
                                </VCardText>
                            </VCard>
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
