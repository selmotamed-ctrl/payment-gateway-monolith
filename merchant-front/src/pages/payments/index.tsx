import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VCard, VCardText, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

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
    const statusFilter = ref<string | null>(null);
    const railFilter = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.paymentsList, {
                params: {
                    search: search.value || undefined,
                    status: statusFilter.value || undefined,
                    railCode: railFilter.value || undefined,
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

    const statusTone = (status: string) => {
        switch (status) {
            case "SUCCEEDED":
                return "success" as const;
            case "FAILED":
            case "BLOCKED":
            case "CANCELLED":
                return "error" as const;
            case "UNKNOWN":
            case "VERIFYING":
                return "warning" as const;
            default:
                return "info" as const;
        }
    };

    const headers: TableHeader<Payment>[] = [
        { key: "reference", label: "Reference", value: (row) => row.reference },
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Payment }) => <StatusChip label={row.status} tone={statusTone(row.status)} />,
        },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Payment }) => <MoneyText value={row.amount} currency={row.currency} bold />,
        },
        {
            key: "commission",
            label: "Commission",
            Value: ({ row }: { row: Payment }) => <MoneyText value={row.commission} currency={row.currency} />,
        },
        {
            key: "net",
            label: "Net",
            Value: ({ row }: { row: Payment }) => <MoneyText value={row.net} currency={row.currency} />,
        },
        { key: "applicationId", label: "Applications", value: (row) => row.applicationId },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        { key: "confirmedAt", label: "Payment Complete", value: (row) => row.confirmedAt ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Payments")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px" }}>
                            <VSelect
                                items={[
                                    "CREATED",
                                    "INITIATING",
                                    "AWAITING_CUSTOMER",
                                    "AUTHORIZING",
                                    "VERIFYING",
                                    "UNKNOWN",
                                    "SUCCEEDED",
                                    "FAILED",
                                    "EXPIRED",
                                    "CANCELLED",
                                    "BLOCKED",
                                ]}
                                modelValue={statusFilter.value}
                                onUpdate:modelValue={(v: string | null) => {
                                    statusFilter.value = v;
                                    void load();
                                }}
                                label={t("Status")}
                                density="compact"
                                hideDetails
                                clearable
                                style={{ minWidth: "190px" }}
                            />
                            <VTextField
                                label={t("Rail Code")}
                                modelValue={railFilter.value ?? ""}
                                onUpdate:modelValue={(v: string) => {
                                    railFilter.value = v || null;
                                    void load();
                                }}
                                density="compact"
                                hideDetails
                                style={{ minWidth: "160px" }}
                            />
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
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
                        </VCardText>
                    </VCard>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default PaymentsPage;
