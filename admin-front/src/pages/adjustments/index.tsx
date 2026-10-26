import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Adjustment = {
    id: string;
    type: string;
    state: string;
    amount: string;
    currency: string;
    merchantName: string;
    sourceAttemptId: string | null;
    sourceDisputeId: string | null;
    reverseCommission: boolean;
    reasonCode: string;
    draftedBySystem: boolean;
    createdAt: string;
    executedAt: string | null;
};

const ADJUSTMENT_TYPES = ["CHARGEBACK", "REFUND", "MANUAL_CREDIT", "MANUAL_DEBIT", "CORRECTION"];

const AdjustmentsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Adjustment[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const form = ref({
        type: "MANUAL_CREDIT",
        amount: "",
        currency: "LYD",
        merchantId: "",
        reasonCode: "",
        notes: "",
        reverseCommission: true,
    });
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.adjustmentsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.adjustments ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const submit = async () => {
        actionLoading.value = true;
        try {
            await api.post(urlsMap.adjustmentsList, {
                type: form.value.type,
                amount: form.value.amount,
                currency: form.value.currency,
                merchantId: form.value.merchantId,
                reasonCode: form.value.reasonCode,
                notes: form.value.notes,
                reverseCommission: form.value.reverseCommission,
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Save") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const stateTone = (state: string) => {
        switch (state) {
            case "EXECUTED":
                return "success" as const;
            case "REJECTED":
            case "FAILED":
                return "error" as const;
            case "PENDING_REVIEW":
                return "warning" as const;
            default:
                return "neutral" as const;
        }
    };

    const headers: TableHeader<Adjustment>[] = [
        { key: "type", label: "Adjustment Type", value: (row) => row.type },
        {
            key: "state",
            label: "Status",
            Value: ({ row }: { row: Adjustment }) => <StatusChip label={row.state} tone={stateTone(row.state)} />,
        },
        { key: "amount", label: "Amount Due", value: (row) => `${row.amount ?? ""} ${row.currency ?? ""}` },
        { key: "merchantName", label: "Merchant Name", value: (row) => row.merchantName },
        { key: "sourceAttemptId", label: "Attempt", value: (row) => row.sourceAttemptId ?? "-" },
        { key: "sourceDisputeId", label: "Reference", value: (row) => row.sourceDisputeId ?? "-" },
        { key: "reverseCommission", label: "Commission", value: (row) => (row.reverseCommission ? t("Reverse") : "-") },
        { key: "reasonCode", label: "Reason Code Label", value: (row) => row.reasonCode },
        { key: "draftedBySystem", label: "Maker", value: (row) => (row.draftedBySystem ? "SYSTEM_AUTOMATION" : "-") },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        { key: "executedAt", label: "Executed", value: (row) => row.executedAt ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Adjustments")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                form.value = {
                                    type: "MANUAL_CREDIT",
                                    amount: "",
                                    currency: "LYD",
                                    merchantId: "",
                                    reasonCode: "",
                                    notes: "",
                                    reverseCommission: true,
                                };
                                dialogOpen.value = true;
                            }}
                        >
                            {t("Propose")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Adjustments")}
                                data={rows.value}
                                headers={headers}
                                loading={loading.value}
                                showNumber={true}
                                xlsx={false}
                                noElevation={true}
                                searchValue={search.value}
                                setSearchValue={(value) => (search.value = value)}
                            />
                        </VCardText>
                    </VCard>
                )}
            </ThemedView>

            <VDialog v-model={dialogOpen.value} maxWidth="620px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <VSelect
                            items={ADJUSTMENT_TYPES.map((value) => ({ title: value, value }))}
                            modelValue={form.value.type}
                            onUpdate:modelValue={(v: string) => (form.value.type = v)}
                            label={t("Adjustment Type")}
                        />
                        <VTextField
                            label={t("Amount")}
                            modelValue={form.value.amount}
                            onUpdate:modelValue={(v: string) => (form.value.amount = v)}
                        />
                        <VTextField
                            label={t("Currency")}
                            modelValue={form.value.currency}
                            onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())}
                        />
                        <VTextField
                            label="merchantId"
                            modelValue={form.value.merchantId}
                            onUpdate:modelValue={(v: string) => (form.value.merchantId = v)}
                        />
                        <VTextField
                            label={t("Reason Code")}
                            modelValue={form.value.reasonCode}
                            onUpdate:modelValue={(v: string) => (form.value.reasonCode = v)}
                        />
                        <VTextarea
                            label={t("Notes")}
                            modelValue={form.value.notes}
                            onUpdate:modelValue={(v: string) => (form.value.notes = v)}
                            rows={3}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void submit()}>
                            {t("Propose")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AdjustmentsPage;
