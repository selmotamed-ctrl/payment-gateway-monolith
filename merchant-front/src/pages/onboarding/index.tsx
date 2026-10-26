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

const STEPS = [
    { key: "profile", title: "Business Profile" },
    { key: "owners", title: "Beneficial Owners" },
    { key: "documents", title: "Documents" },
    { key: "payout", title: "Bank Details" },
    { key: "review", title: "Submit Application" },
];

const DOCUMENT_TYPES = [
    "Commercial Registry",
    "Tax Certificate",
    "Articles Of Association",
    "Proof Of Address",
    "Bank Letter",
    "Sector Licence",
    "Identification Document",
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
            const response = await api.get(urlsMap.onboardingJoinRequest);
            const payload = response.data?.data ?? response.data ?? {};
            joinStatus.value = payload.status ?? payload.joinRequest?.status ?? null;
            requestedInfo.value = payload.requestedInfo ?? null;
            const source = payload.profile ?? payload.businessProfile ?? payload;
            profile.value = { ...emptyProfile(), ...source };
            owners.value = payload.beneficialOwners ?? payload.owners ?? [];
            documents.value = payload.documents ?? [];
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
            await api.put(urlsMap.onboardingJoinRequest, { profile: profile.value });
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
            body.append("docType", document.docType);
            body.append("expiresOn", document.expiresOn);
            body.append("file", document.file);
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

    const submit = async () => {
        saving.value = true;
        try {
            await api.put(urlsMap.onboardingJoinRequest, { payoutBankDetails: payout.value });
            await api.post(urlsMap.onboardingSubmit, {});
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
                                                    { docType: DOCUMENT_TYPES[0] ?? "Commercial Registry", file: null, expiresOn: "" },
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
