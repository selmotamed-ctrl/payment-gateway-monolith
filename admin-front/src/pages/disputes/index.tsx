import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VCard, VCardText } from "vuetify/components";
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

type Dispute = {
    id: string;
    disputeRef: string;
    source: string;
    state: string;
    merchantName: string;
    amount: string;
    currency: string;
    reasonCode: string;
    externalDisputeRef: string;
    openedAt: string;
    evidenceDueAt: string;
    adjustmentId: string | null;
};

const DisputesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Dispute[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.disputesList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.disputes ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const stateTone = (state: string) => {
        switch (state) {
            case "WON":
                return "success" as const;
            case "LOST":
            case "EXPIRED":
                return "error" as const;
            case "EVIDENCE_SUBMITTED":
                return "info" as const;
            default:
                return "warning" as const;
        }
    };

    const headers: TableHeader<Dispute>[] = [
        { key: "disputeRef", label: "Reference", value: (row) => row.disputeRef },
        { key: "source", label: "Dispute Source", value: (row) => row.source },
        {
            key: "state",
            label: "Status",
            Value: ({ row }: { row: Dispute }) => <StatusChip label={row.state} tone={stateTone(row.state)} />,
        },
        { key: "merchantName", label: "Merchant Name", value: (row) => row.merchantName },
        { key: "amount", label: "Amount", value: (row) => `${row.amount ?? ""} ${row.currency ?? ""}` },
        { key: "reasonCode", label: "Reason Code Label", value: (row) => row.reasonCode },
        { key: "externalDisputeRef", label: "Reference", value: (row) => row.externalDisputeRef },
        { key: "openedAt", label: "Opened At", value: (row) => row.openedAt },
        { key: "evidenceDueAt", label: "Evidence Due", value: (row) => row.evidenceDueAt },
        { key: "adjustmentId", label: "Adjustment Type", value: (row) => row.adjustmentId ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Disputes")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Disputes")}
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
        </ScreenContainer>
    );
});

export default DisputesPage;
