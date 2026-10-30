import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VDialog, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Merchant = {
    id: string;
    legalName: string;
    tradeName: string;
    taxId: string | null;
    registrationNo: string | null;
    businessCategory: string | null;
    status: string;
    kybStatus: string;
    riskTier: string;
    onboardingChannel: string;
    country: string;
    contactEmail: string | null;
    contactPhone: string | null;
    negativeBalanceCeiling: string | number | null;
    commissionReceivableCeiling: string | number | null;
    createdAt: string;
    suspendedAt: string | null;
};

type MerchantEditForm = {
    legalName: string;
    tradeName: string;
    taxId: string;
    registrationNo: string;
    businessCategory: string;
    country: string;
    contactEmail: string;
    contactPhone: string;
    riskTier: string;
    negativeBalanceCeiling: string;
    commissionReceivableCeiling: string;
};

type ActionMode = "SUSPEND" | "REINSTATE" | "PROPOSE_EDIT";

const RISK_TIERS = ["LOW", "STANDARD", "HIGH"];
const DECIMAL_PATTERN = /^\d{1,14}(\.\d{1,4})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const asText = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

const emptyEditForm = (): MerchantEditForm => ({
    legalName: "",
    tradeName: "",
    taxId: "",
    registrationNo: "",
    businessCategory: "",
    country: "LY",
    contactEmail: "",
    contactPhone: "",
    riskTier: "STANDARD",
    negativeBalanceCeiling: "0",
    commissionReceivableCeiling: "",
});

const editFormFromMerchant = (merchant: Partial<Merchant>): MerchantEditForm => ({
    legalName: asText(merchant.legalName),
    tradeName: asText(merchant.tradeName),
    taxId: asText(merchant.taxId),
    registrationNo: asText(merchant.registrationNo),
    businessCategory: asText(merchant.businessCategory),
    country: asText(merchant.country || "LY").toUpperCase(),
    contactEmail: asText(merchant.contactEmail),
    contactPhone: asText(merchant.contactPhone),
    riskTier: asText(merchant.riskTier || "STANDARD").toUpperCase(),
    negativeBalanceCeiling: asText(merchant.negativeBalanceCeiling ?? "0"),
    commissionReceivableCeiling: asText(merchant.commissionReceivableCeiling),
});

const validateEditForm = (form: MerchantEditForm): string | null => {
    if (!form.legalName.trim()) return "Legal name is required";
    if (!form.tradeName.trim()) return "Trade name is required";
    if (!/^[A-Za-z]{2}$/.test(form.country.trim())) return "Country must be a two-letter ISO code";
    if (!RISK_TIERS.includes(form.riskTier)) return "Risk tier is invalid";
    if (form.contactEmail.trim() && !EMAIL_PATTERN.test(form.contactEmail.trim())) {
        return "Contact email is invalid";
    }
    if (!DECIMAL_PATTERN.test(form.negativeBalanceCeiling.trim() || "0")) {
        return "Negative balance ceiling must be a decimal with up to four places";
    }
    if (form.commissionReceivableCeiling.trim() && !DECIMAL_PATTERN.test(form.commissionReceivableCeiling.trim())) {
        return "Commission receivable ceiling must be a decimal with up to four places";
    }
    return null;
};

const buildPatch = (original: Partial<Merchant>, form: MerchantEditForm) => {
    const operations: { op: "replace"; path: string; value: unknown }[] = [];
    const add = (field: keyof MerchantEditForm, value: unknown) => {
        const before = original[field] ?? null;
        const after = value ?? null;
        if (asText(before) !== asText(after)) {
            operations.push({ op: "replace", path: `/${field}`, value: after });
        }
    };

    add("legalName", form.legalName.trim());
    add("tradeName", form.tradeName.trim());
    add("taxId", form.taxId.trim() || null);
    add("registrationNo", form.registrationNo.trim() || null);
    add("businessCategory", form.businessCategory.trim() || null);
    add("country", form.country.trim().toUpperCase());
    add("contactEmail", form.contactEmail.trim() || null);
    add("contactPhone", form.contactPhone.trim() || null);
    add("riskTier", form.riskTier);
    add("negativeBalanceCeiling", form.negativeBalanceCeiling.trim() || "0");
    add("commissionReceivableCeiling", form.commissionReceivableCeiling.trim() || null);

    return operations;
};

const MerchantsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Merchant[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Merchant | null>(null);
    const actionMode = ref<ActionMode>("SUSPEND");
    const reason = ref<string>("");
    const editForm = ref<MerchantEditForm>(emptyEditForm());
    const editOriginal = ref<Partial<Merchant>>({});
    const editError = ref<string | null>(null);
    const editLoading = ref(false);
    const actionLoading = ref(false);

    const dialogTitle = computed(() => {
        switch (actionMode.value) {
            case "SUSPEND":
                return t("Suspend Merchant");
            case "REINSTATE":
                return t("Reinstate Merchant");
            default:
                return t("Edit Merchant");
        }
    });

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.merchantsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.merchants ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openAction = async (row: Merchant, mode: ActionMode) => {
        selected.value = row;
        actionMode.value = mode;
        reason.value = "";
        editError.value = null;
        editForm.value = editFormFromMerchant(row);
        editOriginal.value = { ...row };
        dialogOpen.value = true;

        if (mode !== "PROPOSE_EDIT") {
            return;
        }

        editLoading.value = true;
        try {
            const response = await api.get(urlsMap.merchantDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            const merchant: Partial<Merchant> = payload.merchant ?? payload;
            editOriginal.value = merchant;
            editForm.value = editFormFromMerchant(merchant);
        } catch (e) {
            editError.value = extractApiErrorMessage(e);
        } finally {
            editLoading.value = false;
        }
    };

    const submit = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        editError.value = null;
        try {
            if (actionMode.value === "SUSPEND") {
                await api.post(urlsMap.merchantSuspend(selected.value.id), { reason: reason.value });
            } else if (actionMode.value === "REINSTATE") {
                await api.post(urlsMap.merchantReinstate(selected.value.id), { reason: reason.value });
            } else {
                const validationError = validateEditForm(editForm.value);
                if (validationError) {
                    editError.value = validationError;
                    return;
                }
                const operations = buildPatch(editOriginal.value, editForm.value);
                if (operations.length === 0) {
                    editError.value = t("No changes to submit");
                    return;
                }
                await api.post(urlsMap.merchantProposeEdit(selected.value.id), { patch: operations });
            }
            dialogOpen.value = false;
            showSnackBar({
                type: "success",
                message:
                    actionMode.value === "PROPOSE_EDIT"
                        ? t("Change submitted for approval")
                        : t("Saved"),
            });
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            if (actionMode.value === "PROPOSE_EDIT") {
                editError.value = message;
            }
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<Merchant>[] = [
        { key: "legalName", label: "Legal Name", value: (row) => row.legalName },
        { key: "tradeName", label: "Trade Name", value: (row) => row.tradeName },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Merchant }) => (
                <StatusChip label={row.status} tone={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        { key: "kybStatus", label: "Verified Docs", value: (row) => row.kybStatus },
        {
            key: "riskTier",
            label: "Risk Class",
            Value: ({ row }: { row: Merchant }) => (
                <StatusChip label={row.riskTier} tone={statusTone(row.riskTier)} />
            ),
        },
        { key: "contactEmail", label: "Email", value: (row) => row.contactEmail ?? "" },
        { key: "contactPhone", label: "Phone", value: (row) => row.contactPhone ?? "" },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Merchant }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                    <VBtn size="small" variant="tonal" color="error" onClick={() => void openAction(row, "SUSPEND")}>
                        {t("Suspended")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" color="success" onClick={() => void openAction(row, "REINSTATE")}>
                        {t("Active")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => void openAction(row, "PROPOSE_EDIT")}>
                        {t("Edit")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    const renderEditForm = () => {
        if (editLoading.value) {
            return <StateView loading={true} minHeight="220px" />;
        }
        if (editError.value) {
            return (
                <VAlert type="error" variant="tonal" density="compact">
                    {editError.value}
                </VAlert>
            );
        }
        return (
            <>
                <VAlert type="info" variant="tonal" density="compact">
                    {t("This change is submitted for checker approval before it is applied.")}
                </VAlert>
                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                    <VTextField
                        label={t("Legal Name")}
                        modelValue={editForm.value.legalName}
                        onUpdate:modelValue={(v: string) => (editForm.value.legalName = v)}
                        style={{ minWidth: "280px", flex: "1 1 280px" }}
                    />
                    <VTextField
                        label={t("Trade Name")}
                        modelValue={editForm.value.tradeName}
                        onUpdate:modelValue={(v: string) => (editForm.value.tradeName = v)}
                        style={{ minWidth: "280px", flex: "1 1 280px" }}
                    />
                    <VTextField
                        label={t("Tax ID")}
                        modelValue={editForm.value.taxId}
                        onUpdate:modelValue={(v: string) => (editForm.value.taxId = v)}
                        style={{ minWidth: "220px", flex: "1 1 220px" }}
                    />
                    <VTextField
                        label={t("Registration No")}
                        modelValue={editForm.value.registrationNo}
                        onUpdate:modelValue={(v: string) => (editForm.value.registrationNo = v)}
                        style={{ minWidth: "220px", flex: "1 1 220px" }}
                    />
                    <VTextField
                        label={t("Business Category")}
                        modelValue={editForm.value.businessCategory}
                        onUpdate:modelValue={(v: string) => (editForm.value.businessCategory = v)}
                        style={{ minWidth: "240px", flex: "1 1 240px" }}
                    />
                    <VTextField
                        label={t("Country")}
                        modelValue={editForm.value.country}
                        onUpdate:modelValue={(v: string) => (editForm.value.country = v.toUpperCase().slice(0, 2))}
                        style={{ minWidth: "140px", flex: "0 1 140px" }}
                    />
                    <VTextField
                        label={t("Contact Email")}
                        modelValue={editForm.value.contactEmail}
                        onUpdate:modelValue={(v: string) => (editForm.value.contactEmail = v)}
                        style={{ minWidth: "260px", flex: "1 1 260px" }}
                    />
                    <VTextField
                        label={t("Contact Phone")}
                        modelValue={editForm.value.contactPhone}
                        onUpdate:modelValue={(v: string) => (editForm.value.contactPhone = v)}
                        style={{ minWidth: "220px", flex: "1 1 220px" }}
                    />
                    <VSelect
                        label={t("Risk Class")}
                        items={RISK_TIERS}
                        modelValue={editForm.value.riskTier}
                        onUpdate:modelValue={(v: string) => (editForm.value.riskTier = v)}
                        style={{ minWidth: "200px", flex: "0 1 200px" }}
                    />
                    <VTextField
                        label={t("Negative Balance Ceiling")}
                        modelValue={editForm.value.negativeBalanceCeiling}
                        onUpdate:modelValue={(v: string) => (editForm.value.negativeBalanceCeiling = v)}
                        hint="Decimal, up to 4 places"
                        persistentHint
                        style={{ minWidth: "240px", flex: "1 1 240px" }}
                    />
                    <VTextField
                        label={t("Commission Receivable Ceiling")}
                        modelValue={editForm.value.commissionReceivableCeiling}
                        onUpdate:modelValue={(v: string) => (editForm.value.commissionReceivableCeiling = v)}
                        hint={t("Optional decimal, up to 4 places")}
                        persistentHint
                        style={{ minWidth: "260px", flex: "1 1 260px" }}
                    />
                </ThemedView>
            </>
        );
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Merchants")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Merchants")}
                        data={rows.value}
                        headers={headers}
                        loading={loading.value}
                        showNumber={true}
                        xlsx={false}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                    />
                )}
            </ThemedView>

            <VDialog
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                maxWidth="860px"
            >
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ gap: "4px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                {dialogTitle.value}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                {selected.value?.tradeName}
                            </ThemedText>
                        </ThemedView>

                        {actionMode.value === "PROPOSE_EDIT" ? (
                            renderEditForm()
                        ) : (
                            <VTextField
                                modelValue={reason.value}
                                onUpdate:modelValue={(v: string) => (reason.value = v)}
                                label={t("Reason")}
                            />
                        )}

                        <ThemedView
                            style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}
                        >
                            <VBtn variant="text" onClick={() => (dialogOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                loading={actionLoading.value}
                                disabled={editLoading.value || (actionMode.value === "PROPOSE_EDIT" && !!editError.value)}
                                onClick={() => void submit()}
                            >
                                {actionMode.value === "PROPOSE_EDIT" ? t("Submit For Approval") : t("Submit")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default MerchantsPage;
