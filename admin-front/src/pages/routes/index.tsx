import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect } from "vuetify/components";
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

type GatewayRoute = {
    id: string;
    railCode: string;
    gatewayCode: string;
    credentialPolicy: string;
    priority: number;
    costModel: string;
    minAmount: string;
    maxAmount: string;
    dailyCapAmount: string;
    status: string;
    healthState: string;
    scope: Record<string, unknown>;
};

const RoutesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<GatewayRoute[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<GatewayRoute | null>(null);
    const targetStatus = ref<string>("ACTIVE");
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.routesList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.routes ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const changeState = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.routeState(selected.value.id), { status: targetStatus.value });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Update") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const statusTone = (status: string) => {
        switch (status) {
            case "ACTIVE":
                return "success" as const;
            case "PAUSED":
                return "warning" as const;
            case "DRAINING":
                return "info" as const;
            default:
                return "neutral" as const;
        }
    };

    const healthTone = (health: string) => {
        switch (health) {
            case "HEALTHY":
                return "success" as const;
            case "DEGRADED":
                return "warning" as const;
            default:
                return "error" as const;
        }
    };

    const headers: TableHeader<GatewayRoute>[] = [
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        { key: "gatewayCode", label: "Gateway Code", value: (row) => row.gatewayCode },
        { key: "credentialPolicy", label: "Credential Policy", value: (row) => row.credentialPolicy },
        { key: "priority", label: "Priority", value: (row) => String(row.priority ?? "") },
        { key: "costModel", label: "Cost Model", value: (row) => row.costModel },
        { key: "minAmount", label: "Amount", value: (row) => `${row.minAmount ?? ""} - ${row.maxAmount ?? ""}` },
        { key: "dailyCapAmount", label: "Amount Due", value: (row) => row.dailyCapAmount },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: GatewayRoute }) => <StatusChip label={row.status} tone={statusTone(row.status)} />,
        },
        {
            key: "healthState",
            label: "Invariant Status",
            Value: ({ row }: { row: GatewayRoute }) => (
                <StatusChip label={row.healthState} tone={healthTone(row.healthState)} />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: GatewayRoute }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    onClick={() => {
                        selected.value = row;
                        targetStatus.value = row.status;
                        dialogOpen.value = true;
                    }}
                >
                    {t("Update")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Routes")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Routes")}
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

            <VDialog v-model={dialogOpen.value} maxWidth="460px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <VSelect
                            items={["ACTIVE", "PAUSED", "DRAINING"]}
                            modelValue={targetStatus.value}
                            onUpdate:modelValue={(v: string) => (targetStatus.value = v)}
                            label={t("Status")}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void changeState()}>
                            {t("Update")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default RoutesPage;
