import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
type Payment = {
    id: string;
    reference: string;
    railCode: string;
    status: string;
    amount: string;
    currency: string;
    commission: string;
    net: string;
    applicationId: string;
    customerLabel: string | null;
    createdAt: string;
    confirmedAt: string | null;
};

const PaymentsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Payment[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.paymentsList, {
                params: {
                    search: search.value || undefined,
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.payments ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const statusTone = (status: string): BadgeTone => {
        switch (status) {
            case "SUCCEEDED":
                return "success";
            case "FAILED":
            case "BLOCKED":
            case "CANCELLED":
                return "danger";
            case "UNKNOWN":
            case "VERIFYING":
                return "warning";
            default:
                return "info";
        }
    };

    const headers: TableHeader<Payment>[] = [
        {
            key: "reference",
            label: "Reference",
            Value: ({ row }: { row: Payment }) => <MonoRef value={row.reference} truncate={18} />,
        },
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Payment }) => (
                <StatusBadge status={row.status} toneOverride={statusTone(row.status)} />
            ),
        },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Payment }) => (
                <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />
            ),
        },
        {
            key: "commission",
            label: "Commission",
            Value: ({ row }: { row: Payment }) => (
                <MoneyDisplay amount={row.commission} currency={row.currency} size="sm" />
            ),
        },
        {
            key: "net",
            label: "Net",
            Value: ({ row }: { row: Payment }) => (
                <MoneyDisplay amount={row.net} currency={row.currency} size="sm" colorSign />
            ),
        },
        {
            key: "applicationId",
            label: "Application",
            Value: ({ row }: { row: Payment }) => <MonoRef value={row.applicationId} truncate={14} />,
        },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        { key: "confirmedAt", label: "Payment Complete", value: (row) => row.confirmedAt ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Payments")}
                    subtitle={t("Payment attempts, statuses, and settlement references.")}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Payments")}
                        data={rows.value}
                        headers={headers}
                        loading={loading.value}
                        showNumber={true}
                        xlsx={false}
                        noElevation={true}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                    />
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default PaymentsPage;
