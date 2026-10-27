import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VCard, VCardText } from "vuetify/components";
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

type Gateway = {
    id: string;
    code: string;
    name: string;
    operator: string;
    country: string;
    kind: string;
    verificationState: string;
    riskClass: string;
    aliases: string[];
    activeVersionId: string | null;
    versions: { id: string; version: number; status: string; createdAt: string }[];
};

const GatewaysPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<Gateway[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.gatewaysList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.gateways ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const kindTone = (kind: string) => {
        switch (kind) {
            case "INTERNAL":
                return "primary" as const;
            case "AGGREGATOR":
                return "info" as const;
            case "DIRECT":
                return "success" as const;
            default:
                return "warning" as const;
        }
    };

    const headers: TableHeader<Gateway>[] = [
        { key: "code", label: "Gateway Code", value: (row) => row.code },
        { key: "name", label: "Gateway", value: (row) => row.name },
        { key: "operator", label: "Operator", value: (row) => row.operator },
        { key: "country", label: "Country", value: (row) => row.country },
        {
            key: "kind",
            label: "Kind",
            Value: ({ row }: { row: Gateway }) => <StatusChip label={row.kind} tone={kindTone(row.kind)} />,
        },
        {
            key: "verificationState",
            label: "Verification State",
            Value: ({ row }: { row: Gateway }) => (
                <StatusChip
                    label={row.verificationState}
                    tone={row.verificationState === "VERIFIED" ? "success" : "warning"}
                />
            ),
        },
        { key: "riskClass", label: "Risk Class", value: (row) => row.riskClass },
        { key: "aliases", label: "Aliases", value: (row) => (row.aliases ?? []).join(", ") },
        { key: "versions", label: "Version", value: (row) => String(row.versions?.length ?? 0) },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Gateway }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    color="primary"
                    onClick={() => void router.push({ name: "GatewayWizard", params: { id: row.id } })}
                >
                    {t("Gateway Wizard")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Gateways")}
                    end={() => (
                        <VBtn
                            color="primary"
                            variant="tonal"
                            prependIcon={"mdi-robot-outline"}
                            onClick={() => void router.push({ name: "GatewayAiImport" })}
                        >
                            {t("Smart AI Integration")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Gateways")}
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

export default GatewaysPage;
