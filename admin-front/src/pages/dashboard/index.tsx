import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VCard, VCardText, VChip, VProgressLinear } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { MiniStats, type StatItem } from "@/components/MiniStats";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatPlainNumber } from "@/utils/money";

type Overview = {
    attemptsByState?: Record<string, number>;
    unknownBacklog?: number;
    unknownOldestAgeSeconds?: number;
    openCircuitBreakers?: number;
    webhookInboxLagSeconds?: number;
    reconciliationMatchRate?: string;
    approvalQueueAgeing?: { role: string; oldestHours: number; count: number }[];
    joinRequestSlaBreaches?: number;
    amlSlaBreaches?: number;
    merchantsActive?: number;
    merchantsPending?: number;
};

const DashboardPage = dc(() => {
    const { t } = useLocale();
    const overview = ref<Overview | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.dashboardOverview);
            overview.value = (response.data?.data ?? response.data ?? {}) as Overview;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const stats = (): StatItem[] => {
        const data = overview.value;
        return [
            {
                title: t("Active Merchants"),
                value: formatPlainNumber(data?.merchantsActive ?? 0),
                icon: "mdi-storefront-outline",
                color: "#0f6bff",
                subtitle: `${formatPlainNumber(data?.merchantsPending ?? 0)} ${t("Pending")}`,
            },
            {
                title: t("Unknown Backlog"),
                value: formatPlainNumber(data?.unknownBacklog ?? 0),
                icon: "mdi-help-circle-outline",
                color: "#d97706",
                subtitle: `${formatPlainNumber(data?.unknownOldestAgeSeconds ?? 0)}s ${t("Oldest")}`,
            },
            {
                title: t("Open Circuit Breakers"),
                value: formatPlainNumber(data?.openCircuitBreakers ?? 0),
                icon: "mdi-electric-switch",
                color: "#dc2626",
            },
            {
                title: t("Join Request SLA"),
                value: formatPlainNumber(data?.joinRequestSlaBreaches ?? 0),
                icon: "mdi-clipboard-account-outline",
                color: "#059669",
            },
            {
                title: t("AML SLA"),
                value: formatPlainNumber(data?.amlSlaBreaches ?? 0),
                icon: "mdi-scale-balance",
                color: "#dc2626",
            },
            {
                title: t("Webhook Inbox Lag"),
                value: `${formatPlainNumber(data?.webhookInboxLagSeconds ?? 0)}s`,
                icon: "mdi-webhook",
                color: "#2563eb",
            },
        ];
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Dashboard")}
                    end={() => (
                        <VChip color="primary" variant="tonal" size="small">
                            {t("Live")}
                        </VChip>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <>
                        <MiniStats stats={stats()} loading={loading.value} />

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "18px" }}>
                            <VCard style={{ flex: "1 1 340px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Attempts By State")}</ThemedText>
                                    {loading.value ? (
                                        <VProgressLinear indeterminate color="primary" />
                                    ) : (
                                        Object.entries(overview.value?.attemptsByState ?? {}).map(([state, count]) => (
                                            <ThemedView key={state} style={{ flexDirection: "column", gap: "4px" }}>
                                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between" }}>
                                                    <ThemedText style={{ fontSize: "13px" }}>{state}</ThemedText>
                                                    <ThemedText style={{ fontSize: "13px", fontWeight: "700" }}>
                                                        {formatPlainNumber(count)}
                                                    </ThemedText>
                                                </ThemedView>
                                                <VProgressLinear
                                                    modelValue={Math.min(
                                                        100,
                                                        (count / Math.max(1, Object.values(overview.value?.attemptsByState ?? {}).reduce((a, b) => a + b, 0))) * 100,
                                                    )}
                                                    color="primary"
                                                    height="6px"
                                                    rounded
                                                />
                                            </ThemedView>
                                        ))
                                    )}
                                </VCardText>
                            </VCard>

                            <VCard style={{ flex: "1 1 340px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Approval Queue Ageing")}</ThemedText>
                                    {loading.value ? (
                                        <VProgressLinear indeterminate color="primary" />
                                    ) : overview.value?.approvalQueueAgeing?.length ? (
                                        overview.value.approvalQueueAgeing.map((entry) => (
                                            <ThemedView
                                                key={entry.role}
                                                style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px" }}
                                            >
                                                <ThemedText style={{ fontSize: "13px" }}>{entry.role}</ThemedText>
                                                <ThemedText style={{ fontSize: "13px" }}>
                                                    {formatPlainNumber(entry.count)} · {formatPlainNumber(entry.oldestHours)}h
                                                </ThemedText>
                                            </ThemedView>
                                        ))
                                    ) : (
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.6 }}>{t("No Data Found")}</ThemedText>
                                    )}
                                </VCardText>
                            </VCard>
                        </ThemedView>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default DashboardPage;
