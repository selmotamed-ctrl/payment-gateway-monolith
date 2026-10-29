import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VTextField, VTextarea } from "vuetify/components";
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
    status: string;
    kybStatus: string;
    riskTier: string;
    email: string;
    phone: string;
    createdAt: string;
    suspendedAt: string | null;
};

const MerchantsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Merchant[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Merchant | null>(null);
    const actionMode = ref<"SUSPEND" | "REINSTATE" | "PROPOSE_EDIT">("SUSPEND");
    const reason = ref<string>("");
    const patch = ref<string>("");
    const actionLoading = ref(false);

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

    const openAction = (row: Merchant, mode: "SUSPEND" | "REINSTATE" | "PROPOSE_EDIT") => {
        selected.value = row;
        actionMode.value = mode;
        reason.value = "";
        patch.value = "";
        dialogOpen.value = true;
    };

    const submit = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            if (actionMode.value === "SUSPEND") {
                await api.post(urlsMap.merchantSuspend(selected.value.id), { reason: reason.value });
            } else if (actionMode.value === "REINSTATE") {
                await api.post(urlsMap.merchantReinstate(selected.value.id), { reason: reason.value });
            } else {
                let operations: unknown[] = [];
                try {
                    operations = JSON.parse(patch.value || "[]");
                } catch {
                    throw new Error("JSON patch must be a valid JSON array");
                }
                await api.post(urlsMap.merchantProposeEdit(selected.value.id), {
                    reason: reason.value,
                    payloadDiff: operations,
                });
            }
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
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
        { key: "riskTier", label: "Risk Class", Value: ({ row }: { row: any }) => <StatusChip label={row.riskTier} tone={statusTone(row.riskTier)} /> },
        { key: "email", label: "Email", value: (row) => row.email },
        { key: "phone", label: "Phone", value: (row) => row.phone },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Merchant }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                    <VBtn size="small" variant="tonal" color="error" onClick={() => openAction(row, "SUSPEND")}>
                        {t("Suspended")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" color="success" onClick={() => openAction(row, "REINSTATE")}>
                        {t("Active")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => openAction(row, "PROPOSE_EDIT")}>
                        {t("Edit")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

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

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="620px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {selected.value?.tradeName}
                        </ThemedText>
                        <VTextField
                            modelValue={reason.value}
                            onUpdate:modelValue={(v: string) => (reason.value = v)}
                            label={t("Reason")}
                        />
                        {actionMode.value === "PROPOSE_EDIT" && (
                            <VTextarea
                                modelValue={patch.value}
                                onUpdate:modelValue={(v: string) => (patch.value = v)}
                                label="JSON-Patch"
                                rows={5}
                            />
                        )}
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void submit()}>
                            {t("Submit")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default MerchantsPage;
