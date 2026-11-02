import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VAutocomplete, VBtn, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { copyToClipboard } from "@/utils/common";
import { formatDateTime } from "./joinRequestHelp";

import { FormModal } from "@/components/ui/FormModal";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormField } from "@/components/ui/FormField";
type MerchantOption = {
    id: string;
    title: string;
    legalName: string;
    tradeName: string;
    country: string;
    businessCategory: string | null;
    registrationNo: string | null;
    taxId: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    status: string;
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
    riskTier: "LOW" | "STANDARD" | "HIGH";
};

const emptyForm = (): ProfileForm => ({
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
    riskTier: "STANDARD",
});

const clean = (value: string): string | undefined => (value.trim().length > 0 ? value.trim() : undefined);

const JoinRequestNewPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();

    const mode = ref<"NEW" | "EXISTING">("NEW");
    const merchantId = ref<string | null>(null);
    const merchantOptions = ref<MerchantOption[]>([]);
    const merchantSearch = ref("");
    const merchantLoading = ref(false);
    const form = ref<ProfileForm>(emptyForm());
    const saving = ref(false);
    const created = ref<{ joinRequestId: string; invitationToken?: string; invitationExpiresAt?: string } | null>(null);
    const inviteOpen = ref(false);
    let merchantTimer: ReturnType<typeof setTimeout> | undefined;

    const emailInvalid = computed(
        () => !!form.value.contactEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.value.contactEmail.trim()),
    );
    const phoneInvalid = computed(() => {
        const digits = form.value.contactPhone.replace(/[^\d]/g, "");
        return !!digits && (digits.length < 6 || digits.length > 15);
    });
    const websiteInvalid = computed(() => {
        const value = form.value.websiteUrl.trim();
        if (!value) return false;
        try {
            const url = new URL(value);
            return !["http:", "https:"].includes(url.protocol);
        } catch {
            return true;
        }
    });
    const countryInvalid = computed(
        () => !!form.value.country.trim() && !/^[A-Za-z]{2}$/.test(form.value.country.trim()),
    );
    const currencyInvalid = computed(
        () => !!form.value.currency.trim() && !/^[A-Za-z]{3}$/.test(form.value.currency.trim()),
    );
    const volumeInvalid = computed(
        () => !!form.value.expectedMonthlyVolume.trim() && !/^\d+(?:\.\d{1,4})?$/.test(form.value.expectedMonthlyVolume.trim()),
    );
    const payoutIncomplete = computed(
        () => Boolean(form.value.payoutBankName.trim()) !== Boolean(form.value.payoutAccount.trim()),
    );
    const formInvalid = computed(
        () =>
            emailInvalid.value ||
            phoneInvalid.value ||
            websiteInvalid.value ||
            countryInvalid.value ||
            currencyInvalid.value ||
            volumeInvalid.value ||
            payoutIncomplete.value,
    );

    const canSubmit = computed(() => {
        if (formInvalid.value) return false;
        if (mode.value === "EXISTING") return Boolean(merchantId.value);
        return Boolean(form.value.legalName.trim() && form.value.tradeName.trim())
            && Boolean(form.value.contactPhone.trim() || form.value.contactEmail.trim());
    });

    const loadMerchants = async (search = "") => {
        merchantLoading.value = true;
        try {
            const response = await api.get(urlsMap.merchantsList, {
                params: { search: search || undefined, page: 1, pageSize: 20, status: "PENDING" },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rows = (payload.merchants ?? payload.rows ?? payload.items ?? []) as Record<string, unknown>[];
            merchantOptions.value = rows.map((row) => ({
                id: String(row.id ?? ""),
                title: `${String(row.tradeName ?? "")} — ${String(row.legalName ?? "")}`,
                legalName: String(row.legalName ?? ""),
                tradeName: String(row.tradeName ?? ""),
                country: String(row.country ?? "LY"),
                businessCategory: row.businessCategory ? String(row.businessCategory) : null,
                registrationNo: row.registrationNo ? String(row.registrationNo) : null,
                taxId: row.taxId ? String(row.taxId) : null,
                contactPhone: row.contactPhone ? String(row.contactPhone) : null,
                contactEmail: row.contactEmail ? String(row.contactEmail) : null,
                status: String(row.status ?? ""),
            }));
        } catch {
            merchantOptions.value = [];
        } finally {
            merchantLoading.value = false;
        }
    };

    const onMerchantSearch = (value: string) => {
        merchantSearch.value = value;
        if (merchantTimer) clearTimeout(merchantTimer);
        merchantTimer = setTimeout(() => void loadMerchants(value), 300);
    };

    const selectMerchant = (id: string | null) => {
        merchantId.value = id;
        if (!id) return;
        const merchant = merchantOptions.value.find((entry) => entry.id === id);
        if (!merchant) return;
        form.value = {
            ...form.value,
            legalName: merchant.legalName,
            tradeName: merchant.tradeName,
            country: merchant.country || "LY",
            businessCategory: merchant.businessCategory ?? "",
            registrationNumber: merchant.registrationNo ?? "",
            taxId: merchant.taxId ?? "",
            contactPhone: merchant.contactPhone ?? "",
            contactEmail: merchant.contactEmail ?? "",
        };
    };

    onMounted(() => {
        if (mode.value === "EXISTING") void loadMerchants("");
    });

    const create = async () => {
        if (!canSubmit.value) {
            showSnackBar({
                type: "warning",
                message: formInvalid.value
                    ? t("Fix the highlighted fields before creating the draft")
                    : t("Complete the mandatory merchant and contact fields"),
            });
            return;
        }
        saving.value = true;
        try {
            const body: Record<string, unknown> = {
                ...(mode.value === "EXISTING" && merchantId.value ? { merchantId: merchantId.value } : {}),
                riskTier: form.value.riskTier,
                legalName: clean(form.value.legalName),
                tradeName: clean(form.value.tradeName),
                country: clean(form.value.country),
                businessCategory: clean(form.value.businessCategory),
                registrationNumber: clean(form.value.registrationNumber),
                taxId: clean(form.value.taxId),
                registeredAddress: clean(form.value.registeredAddress),
                websiteUrl: clean(form.value.websiteUrl),
                contactPhone: clean(form.value.contactPhone),
                contactEmail: clean(form.value.contactEmail),
                expectedMonthlyVolume: clean(form.value.expectedMonthlyVolume),
                currency: clean(form.value.currency),
                businessUseDescription: clean(form.value.businessUseDescription),
                ...(form.value.payoutBankName.trim() || form.value.payoutAccount.trim()
                    ? {
                          payoutBankDetails: {
                              bank: form.value.payoutBankName.trim(),
                              iban: form.value.payoutAccount.trim(),
                          },
                      }
                    : {}),
            };
            const response = await api.post(urlsMap.joinRequestAdminAssisted, body);
            const payload = (response.data?.data ?? response.data ?? {}) as {
                joinRequestId: string;
                invitationToken?: string;
                invitationExpiresAt?: string;
            };
            created.value = payload;
            showSnackBar({ type: "success", message: t("Admin-assisted onboarding draft created") });
            if (payload.invitationToken) {
                inviteOpen.value = true;
            } else {
                await router.push({ name: "JoinRequestDetail", params: { id: payload.joinRequestId } });
            }
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            saving.value = false;
        }
    };

    const continueToDraft = async () => {
        if (!created.value) return;
        inviteOpen.value = false;
        await router.push({ name: "JoinRequestDetail", params: { id: created.value.joinRequestId } });
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("New admin-assisted join request")}
                    subtitle={t("Prepare a complete onboarding package on behalf of a merchant without bypassing maker-checker controls.")}
                    badge={t("Admin assisted")}
                    badgeTone="info"
                    end={() => (
                        <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "JoinRequests" })}>
                            {t("Back to queue")}
                        </VBtn>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t(
                        "Admin-assisted onboarding prepares the merchant package on the merchant's behalf. The operator who creates it cannot approve or reject it.",
                    )}
                </VAlert>

                <SurfaceCard>
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                            {t("Onboarding target")}
                        </ThemedText>
                        <SegmentedTabs
                            modelValue={mode.value}
                            tabs={[
                                { value: "NEW", label: t("New merchant") },
                                { value: "EXISTING", label: t("Existing pending merchant") },
                            ]}
                            onUpdate:modelValue={(value: string) => {
                                mode.value = value === "EXISTING" ? "EXISTING" : "NEW";
                                if (mode.value === "EXISTING") void loadMerchants("");
                            }}
                        />
                        {mode.value === "EXISTING" && (
                            <FormField
                                label={t("Merchant")}
                                hint={t("Only pending or rejected merchants can start a new onboarding request.")}
                                required
                            >
                                <VAutocomplete
                                    items={merchantOptions.value}
                                    itemTitle="title"
                                    itemValue="id"
                                    modelValue={merchantId.value}
                                    loading={merchantLoading.value}
                                    clearable
                                    onUpdate:modelValue={(value: unknown) => selectMerchant(value ? String(value) : null)}
                                    onUpdate:search={onMerchantSearch}
                                />
                            </FormField>
                        )}
                    </SurfaceCardText>
                </SurfaceCard>

                <SurfaceCard>
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                            {t("Applicant profile")}
                        </ThemedText>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px" }}>
                            <FormField label={t("Legal name")} required>
                                <VTextField v-model={form.value.legalName} />
                            </FormField>
                            <FormField label={t("Trade name")} required>
                                <VTextField v-model={form.value.tradeName} />
                            </FormField>
                            <FormField label={t("Country code (2 letters)")} error={countryInvalid.value ? t("Use exactly 2 letters") : ""}>
                                <VTextField v-model={form.value.country} error={countryInvalid.value} />
                            </FormField>
                            <FormField label={t("Business category")}>
                                <VTextField v-model={form.value.businessCategory} />
                            </FormField>
                            <FormField label={t("Registration number")}>
                                <VTextField v-model={form.value.registrationNumber} />
                            </FormField>
                            <FormField label={t("Tax ID")}>
                                <VTextField v-model={form.value.taxId} />
                            </FormField>
                            <FormField label={t("Contact phone")} error={phoneInvalid.value ? t("Enter a phone number with 6-15 digits") : ""}>
                                <VTextField v-model={form.value.contactPhone} error={phoneInvalid.value} />
                            </FormField>
                            <FormField label={t("Contact email")} error={emailInvalid.value ? t("Enter a valid email address") : ""}>
                                <VTextField v-model={form.value.contactEmail} error={emailInvalid.value} />
                            </FormField>
                            <FormField label={t("Expected monthly volume")} error={volumeInvalid.value ? t("Use a number with up to 4 decimals") : ""}>
                                <VTextField v-model={form.value.expectedMonthlyVolume} error={volumeInvalid.value} />
                            </FormField>
                            <FormField label={t("Currency (3 letters)")} error={currencyInvalid.value ? t("Use exactly 3 letters") : ""}>
                                <VTextField v-model={form.value.currency} error={currencyInvalid.value} />
                            </FormField>
                            <FormField label={t("Proposed risk tier")}>
                                <VSelect v-model={form.value.riskTier} items={["LOW", "STANDARD", "HIGH"]} />
                            </FormField>
                            <FormField label={t("Website URL")} error={websiteInvalid.value ? t("Enter a full http:// or https:// URL") : ""}>
                                <VTextField v-model={form.value.websiteUrl} error={websiteInvalid.value} />
                            </FormField>
                        </div>
                        <FormField label={t("Registered address")}>
                            <VTextField v-model={form.value.registeredAddress} />
                        </FormField>
                        <FormField label={t("Business use description")}>
                            <VTextarea v-model={form.value.businessUseDescription} rows={3} autoGrow />
                        </FormField>
                    </SurfaceCardText>
                </SurfaceCard>

                <SurfaceCard>
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                            {t("Payout account")}
                        </ThemedText>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px" }}>
                            <FormField label={t("Bank name")} error={payoutIncomplete.value ? t("Enter both bank name and account number") : ""}>
                                <VTextField v-model={form.value.payoutBankName} error={payoutIncomplete.value} />
                            </FormField>
                            <FormField label={t("IBAN / account number")} error={payoutIncomplete.value ? t("Enter both bank name and account number") : ""}>
                                <VTextField v-model={form.value.payoutAccount} error={payoutIncomplete.value} />
                            </FormField>
                        </div>
                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                            {t("The payout account is hashed for cross-merchant duplicate detection and reviewed before approval.")}
                        </ThemedText>
                    </SurfaceCardText>
                </SurfaceCard>

                <ThemedView style={{ flexDirection: "row", gap: "12px", justifyContent: "flex-end" }}>
                    <VBtn variant="text" onClick={() => void router.push({ name: "JoinRequests" })}>
                        {t("Cancel")}
                    </VBtn>
                    <VBtn color="primary" loading={saving.value} disabled={!canSubmit.value} onClick={() => void create()}>
                        {t("Create draft")}
                    </VBtn>
                </ThemedView>
            </ThemedView>

            <FormModal
                modelValue={inviteOpen.value}
                onUpdate:modelValue={(value: boolean) => (inviteOpen.value = value)}
                title={t("Merchant invitation")}
                size="md"
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn
                                variant="tonal"
                                prependIcon="mdi-content-copy"
                                onClick={() => {
                                    if (created.value?.invitationToken) {
                                        copyToClipboard(created.value.invitationToken);
                                        showSnackBar({ type: "success", message: t("Invitation token copied") });
                                    }
                                }}
                            >
                                {t("Copy token")}
                            </VBtn>
                            <VBtn color="primary" onClick={() => void continueToDraft()}>
                                {t("Continue to draft")}
                            </VBtn>
                        </>
                    ),
                }}
            >
<ThemedText>
                            {t("Share this one-time invitation token with the merchant administrator. It is shown only once.")}
                        </ThemedText>
                        <VAlert type="warning" variant="tonal">
                            <MonoRef value={created.value?.invitationToken ?? ""} />
                        </VAlert>
                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                            {t("Expires")}: {formatDateTime(created.value?.invitationExpiresAt)}
                        </ThemedText>
            </FormModal>
        </ScreenContainer>
    );
});

export default JoinRequestNewPage;
