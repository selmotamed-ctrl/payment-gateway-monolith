import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import SandboxResourceTable from "@/components/sandbox/SandboxResourceTable";
import { paymentFilters } from "@/components/sandbox/sandboxFilters";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { sandboxGet, sandboxPost, type SandboxPaymentRow, type SandboxSummaryResponse } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { xlsxUIPipeline } from "@/utils/xlsx";

const SandboxPaymentsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<SandboxPaymentRow[]>([]);
    const applications = ref<Array<{ id: string; name: string }>>([]);
    const summary = ref<Record<string, unknown> | null>(null);
    const refresh = ref<(() => void) | null>(null);
    const error = ref<string | null>(null);
    const loading = ref(true);
    const busy = ref<string | null>(null);
    const exportLoading = ref(false);

    const loadSummary = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [data, apps] = await Promise.all([
                sandboxGet<SandboxSummaryResponse>("/studio/payments/summary"),
                sandboxGet<{ applications: Array<{ id: string; name: string }> }>("/studio/applications", { page: 1, pageSize: 200 }),
            ]);
            summary.value = data.summary;
            applications.value = apps.applications ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            summary.value = null;
        } finally {
            loading.value = false;
        }
    };
    void loadSummary();

    const metrics = computed<MetricItem[]>(() => {
        const data = summary.value ?? {};
        const status = (data.status ?? {}) as Record<string, number>;
        return [
            { key: "total", label: t("Payments"), value: String(data.total ?? 0) },
            { key: "succeeded", label: t("Succeeded"), value: String(status.SUCCEEDED ?? 0), badge: t("Succeeded"), badgeTone: "success" },
            { key: "failed", label: t("Failed / blocked"), value: String((status.FAILED ?? 0) + (status.BLOCKED ?? 0)), badge: t("Review"), badgeTone: "danger" },
            { key: "inflight", label: t("In flight"), value: String((status.VERIFYING ?? 0) + (status.UNKNOWN ?? 0) + (status.AUTHORIZING ?? 0)) },
            { key: "charged", label: t("Charged"), moneyAmount: String(data.charged ?? "0"), currency: "LYD" },
            { key: "settled", label: t("Settled"), moneyAmount: String(data.settled ?? "0"), currency: "LYD" },
            { key: "fees", label: t("Gateway fees"), moneyAmount: String(data.fees ?? "0"), currency: "LYD" },
            { key: "commission", label: t("Commission"), moneyAmount: String(data.commission ?? "0"), currency: "LYD" },
            { key: "net", label: t("Net to merchant"), moneyAmount: String(data.net ?? "0"), currency: "LYD" },
        ];
    });

    const simulateDispute = async (row: SandboxPaymentRow) => {
        busy.value = row.id;
        try {
            await sandboxPost(`/payments/${row.id}/simulate-dispute`, {});
            showSnackBar({ type: "success", message: t("Sandbox dispute created") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const headers: TableHeader<SandboxPaymentRow>[] = [
        { key: "reference", label: "Reference", sortKey: "reference", Value: ({ row }) => <div class="d-flex flex-column"><MonoRef value={row.reference} truncate={22} /><span class="text-caption text-medium-emphasis">{row.createdAt}</span></div> },
        { key: "status", label: "Status", sortKey: "status", Value: ({ row }) => <div class="d-flex flex-column ga-1"><StatusBadge status={row.status} />{row.substatus ? <span class="text-caption text-medium-emphasis">{row.substatus}</span> : null}</div> },
        { key: "rail", label: "Rail / gateway", value: (row) => `${row.railCode} / ${row.gatewayCode}` },
        { key: "applicationName", label: "Application / link", value: (row) => `${row.applicationName} / ${row.linkKey}` },
        { key: "totalChargedAmount", label: "Charged", sortKey: "amount", Value: ({ row }) => <MoneyDisplay amount={row.totalChargedAmount} currency={row.currency} size="sm" /> },
        { key: "settledAmount", label: "Settled", Value: ({ row }) => <MoneyDisplay amount={row.settledAmount ?? "0.0000"} currency={row.currency} size="sm" /> },
        { key: "fees", label: "Fees / commission", value: (row) => `${row.gatewayFeeAmount ?? "0.0000"} / ${row.platformCommissionAmount}` },
        { key: "netMerchantAmount", label: "Net", Value: ({ row }) => <MoneyDisplay amount={row.netMerchantAmount} currency={row.currency} size="sm" colorSign /> },
        { key: "refundedAmount", label: "Refunded", Value: ({ row }) => <MoneyDisplay amount={row.refundedAmount} currency={row.currency} size="sm" /> },
        { key: "providerReference", label: "Provider reference", Value: ({ row }) => <MonoRef value={row.providerReference ?? "—"} truncate={16} /> },
        {
            key: "actions",
            label: "Actions",
            Value: ({ row }) => (
                <TableRowActions
                    primaryAction={{ label: t("Open"), icon: "mdi-text-search", onClick: () => void router.push(`/sandbox/payments/${row.id}`) }}
                    items={[
                        { key: "dispute", label: t("Simulate dispute"), icon: "mdi-scale-balance", hidden: row.status !== "SUCCEEDED", onClick: () => void simulateDispute(row) },
                        { key: "link", label: t("Open payment link"), icon: "mdi-link-variant", onClick: () => void router.push(`/sandbox/links/${row.linkId}`) },
                        { key: "wallet", label: t("Open wallet"), icon: "mdi-wallet-outline", onClick: () => void router.push(`/sandbox/wallets/${row.walletId}`) },
                        { key: "copy", label: t("Copy reference"), icon: "mdi-content-copy", onClick: () => { void navigator.clipboard?.writeText(row.reference); showSnackBar({ type: "success", message: t("Copied") }); } },
                    ]}
                />
            ),
        },
    ];

    const exportSummary = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `sandbox-payments-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines: ["metric,value", ...metrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)] });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Sandbox Payments & Ledger")} subtitle={t("Payment attempts, partner references and settlement amounts in the sandbox plane.")} badge="SANDBOX" badgeTone="warning" end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn></div>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Payment health")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
                    <SandboxResourceTable<SandboxPaymentRow>
                        title={t("Sandbox payments")}
                        url="/v1/merchant/sandbox/studio/payments"
                        listKey="payments"
                        headers={headers}
                        filters={paymentFilters(applications.value)}
                        pageSize={20}
                        onRows={(next) => (rows.value = next)}
                        onRefreshReady={(next) => (refresh.value = next)}
                    />
                </div>
            </StateView>
        </ScreenContainer>
    );
});

export default SandboxPaymentsPage;
