import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextarea } from "vuetify/components";
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

type Cashout = {
    id: string;
    merchantId: string;
    merchantName: string;
    state: string;
    amount: string;
    currency: string;
    walletId: string;
    bankSnapshot: string;
    requestedAt: string;
    processedAt: string | null;
    subtractedAt: string | null;
};

const CashoutsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Cashout[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Cashout | null>(null);
    const decision = ref<"APPROVE" | "REJECT">("APPROVE");
    const reason = ref<string>("");
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.cashoutsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.cashouts ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const process = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.cashoutProcess(selected.value.id), {
                decision: decision.value,
                reason: reason.value || undefined,
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Processing") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const stateTone = (state: string) => {
        switch (state) {
            case "SUBTRACTED":
            case "COMPLETE":
                return "success" as const;
            case "REJECTED":
                return "error" as const;
            case "PROCESSING":
                return "info" as const;
            default:
                return "warning" as const;
        }
    };

    const headers: TableHeader<Cashout>[] = [
        { key: "merchantName", label: "Merchant Name", value: (row) => row.merchantName },
        {
            key: "state",
            label: "Cash-Out State",
            Value: ({ row }: { row: Cashout }) => <StatusChip label={row.state} tone={stateTone(row.state)} />,
        },
        { key: "amount", label: "Amount", value: (row) => `${row.amount ?? ""} ${row.currency ?? ""}` },
        { key: "walletId", label: "Wallet Balance", value: (row) => row.walletId },
        { key: "bankSnapshot", label: "Bank Details", value: (row) => row.bankSnapshot },
        { key: "requestedAt", label: "Submitted At", value: (row) => row.requestedAt },
        { key: "processedAt", label: "Processing", value: (row) => row.processedAt ?? "-" },
        { key: "subtractedAt", label: "Subtracted", value: (row) => row.subtractedAt ?? "-" },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Cashout }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    onClick={() => {
                        selected.value = row;
                        decision.value = "APPROVE";
                        reason.value = "";
                        dialogOpen.value = true;
                    }}
                >
                    {t("Process")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Cash-Outs")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Cash-Outs")}
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

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="540px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <VSelect
                            items={[
                                { title: t("Approve and execute"), value: "APPROVE" },
                                { title: t("Reject and release"), value: "REJECT" },
                            ]}
                            modelValue={decision.value}
                            onUpdate:modelValue={(v: string) => (decision.value = v as "APPROVE" | "REJECT")}
                            label={t("Decision")}
                        />
                        <VTextarea
                            rows={3}
                            modelValue={reason.value}
                            onUpdate:modelValue={(v: string) => (reason.value = v)}
                            label={t("Reason")}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void process()}>
                            {t("Save")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default CashoutsPage;
