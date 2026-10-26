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

type KybDocument = {
    id: string;
    merchantId: string;
    merchantName: string;
    docType: string;
    status: string;
    fileName: string;
    contentHash: string;
    uploadedAt: string;
    expiresOn: string | null;
    reviewNote: string | null;
};

const KybReviewPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<KybDocument[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.joinRequestsList, {
                params: { search: search.value || undefined, include: "kyb_documents" },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.kybDocuments ?? payload.documents ?? payload.rows ?? payload.items ?? [];
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
            case "ACCEPTED":
                return "success" as const;
            case "REJECTED":
                return "error" as const;
            case "EXPIRED":
                return "warning" as const;
            default:
                return "info" as const;
        }
    };

    const headers: TableHeader<KybDocument>[] = [
        { key: "merchantName", label: "Merchant Name", value: (row) => row.merchantName },
        { key: "docType", label: "Document Type", value: (row) => row.docType },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: KybDocument }) => <StatusChip label={row.status} tone={statusTone(row.status)} />,
        },
        { key: "fileName", label: "Uploaded File", value: (row) => row.fileName },
        { key: "contentHash", label: "Content Hash", value: (row) => (row.contentHash ?? "").slice(0, 16) },
        { key: "uploadedAt", label: "Created At", value: (row) => row.uploadedAt },
        { key: "expiresOn", label: "Expiry Date", value: (row) => row.expiresOn ?? "-" },
        { key: "reviewNote", label: "Notes", value: (row) => row.reviewNote ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("KYB Review")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("KYB Review")}
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

export default KybReviewPage;
