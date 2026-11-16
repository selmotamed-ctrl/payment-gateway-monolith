import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import { sandboxGet, sandboxPost, type SandboxStudioOverview } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { xlsxUIPipeline } from "@/utils/xlsx";

type RecentPayment = SandboxStudioOverview["recentPayments"][number];
type Audit = SandboxStudioOverview["syncAudits"][number];

const SandboxOverviewPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const overview = ref<SandboxStudioOverview | null>(null);
    const loading = ref(true);
    const busy = ref<string | null>(null);
    const error = ref<string | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            overview.value = await sandboxGet<SandboxStudioOverview>("/studio/overview");
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();

    const seed = async () => {
        busy.value = "seed";
        try {
            const result = await sandboxPost<{ checkoutUrl: string; testToken: string | null }>("/seed-demo");
            showSnackBar({ type: "success", message: t("Sandbox demo workspace is ready") });
            if (result.testToken) showSnackBar({ type: "success", message: `${t("Test token (shown once)")}: ${result.testToken}` });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const seedHistory = async () => {
        busy.value = "history";
        try {
            const result = await sandboxPost<{ created: number }>("/seed-history", { count: 20 });
            showSnackBar({ type: "success", message: `${t("Created")} ${result.created} ${t("sandbox payment history rows")}` });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const reset = async () => {
        busy.value = "reset";
        try {
            await sandboxPost("/reset");
            showSnackBar({ type: "success", message: t("Sandbox data reset") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = overview.value;
        if (!data) return [];
        return [
            { key: "wallets", label: t("Wallets"), value: String(data.counts.wallets) },
            { key: "applications", label: t("Applications"), value: String(data.counts.applications) },
            { key: "links", label: t("Payment links"), value: String(data.counts.links) },
            { key: "payments", label: t("Payments"), value: String(data.counts.payments) },
            { key: "available", label: t("Available balance"), moneyAmount: data.money.available, currency: "LYD" },
            { key: "settled", label: t("Settled"), moneyAmount: data.money.settled, currency: "LYD" },
            { key: "fees", label: t("Gateway fees"), moneyAmount: data.money.fees, currency: "LYD" },
            { key: "net", label: t("Net to merchant"), moneyAmount: data.money.net, currency: "LYD" },
            { key: "cashouts", label: t("Pending cash-outs"), value: String(data.counts.pendingCashouts), badge: data.counts.pendingCashouts ? t("Pending") : t("Clear"), badgeTone: data.counts.pendingCashouts ? "warning" : "success" },
            { key: "disputes", label: t("Open disputes"), value: String(data.counts.disputes), badge: data.counts.disputes ? t("Review") : t("Clear"), badgeTone: data.counts.disputes ? "danger" : "success" },
            { key: "tokens", label: t("Active test tokens"), value: String(data.counts.activeTestTokens) },
            { key: "accounts", label: t("Fake Rails accounts"), value: String(data.counts.fakeCustomerAccounts) },
        ];
    });

    const paymentHeaders: TableHeader<RecentPayment>[] = [
        { key: "reference", label: "Reference", Value: ({ row }) => <MonoRef value={row.reference} truncate={20} /> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "amount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "net", label: "Net", Value: ({ row }) => <MoneyDisplay amount={row.net} currency={row.currency} size="sm" colorSign /> },
        { key: "railCode", label: "Rail", value: (row) => row.railCode },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
    ];
    const auditHeaders: TableHeader<Audit>[] = [
        { key: "syncType", label: "Event", value: (row) => row.syncType },
        { key: "actorRole", label: "Actor", value: (row) => row.actorRole ?? "SYSTEM" },
        { key: "createdAt", label: "Date", value: (row) => row.createdAt },
    ];

    const exportSummary = async () => {
        const data = overview.value;
        if (!data) return;
        try {
            const rows: Array<[string, unknown]> = [
                ...metricItems.value.map((item) => [item.label, item.value ?? item.moneyAmount ?? ""] as [string, unknown]),
                ...Object.entries(data.statusCounts).map(([status, count]) => [`status.${status}`, count] as [string, unknown]),
            ];
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `sandbox-overview-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines: ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)],
            });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    return () => (
        <ScreenContainer>
            <PageHeader
                title={t("Sandbox Overview")}
                subtitle={t("A separate database, a separate core node, and zero real money.")}
                badge="SANDBOX"
                badgeTone="warning"
                end={() => (
                    <div class="d-flex flex-wrap ga-2 align-center">
                        <StatusBadge status="SANDBOX" label={`${overview.value?.counts.payments ?? 0} ${t("payments")}`} toneOverride="info" showDot={false} />
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => void load()}>{t("Refresh")}</VBtn>
                    </div>
                )}
            />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value} minHeight="220px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard
                        title={t("Sandbox workspace health")}
                        metrics={metricItems.value}
                        exportLabel={t("Export summary")}
                        onExport={() => void exportSummary()}
                    >
                        <div class="d-flex flex-wrap ga-2">
                            {Object.entries(overview.value?.statusCounts ?? {}).map(([status, count]) => (
                                <StatusBadge key={status} status={status} label={`${status}: ${count}`} toneOverride="info" showDot={false} />
                            ))}
                        </div>
                    </SummaryExportCard>
                    <div class="d-flex flex-wrap ga-4 align-start">
                        <SurfaceCard title={t("Environment")} style={{ flex: "1 1 360px" }}>
                            <DescriptionList
                                columns={2}
                                items={[
                                    { label: t("Plane"), value: <StatusBadge status="SANDBOX" toneOverride="warning" /> },
                                    { label: t("Merchant"), value: overview.value?.merchantName ?? "—" },
                                    { label: t("Fake Rails"), value: overview.value?.fakeRails.ok ? t("Reachable") : t("Unavailable") },
                                    { label: t("Reference catalog"), value: overview.value?.reference.ready ? t("Ready") : t("Incomplete") },
                                    { label: t("Rails"), value: String(overview.value?.reference.rails ?? 0) },
                                    { label: t("Gateways"), value: String(overview.value?.reference.gateways ?? 0) },
                                    { label: t("Routes"), value: String(overview.value?.reference.routes ?? 0) },
                                    { label: t("Commission profiles"), value: String(overview.value?.reference.commissionProfiles ?? 0) },
                                ]}
                            />
                        </SurfaceCard>
                        <SurfaceCard title={t("Demo workspace")} style={{ flex: "1 1 360px" }}>
                            <div class="d-flex flex-wrap ga-2">
                                <VBtn color="primary" prependIcon="mdi-play" loading={busy.value === "seed"} onClick={() => void seed()}>{t("Seed demo workspace")}</VBtn>
                                <VBtn color="primary" variant="tonal" prependIcon="mdi-history" loading={busy.value === "history"} onClick={() => void seedHistory()}>{t("Seed 20 historical payments")}</VBtn>
                                <VBtn color="error" variant="outlined" prependIcon="mdi-restore" loading={busy.value === "reset"} onClick={() => void reset()}>{t("Reset my sandbox data")}</VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-bank-outline" onClick={() => void router.push("/sandbox/accounts")}>{t("Fake Rails accounts")}</VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-wallet-outline" onClick={() => void router.push("/sandbox/wallets")}>{t("Wallets")}</VBtn>
                            </div>
                            <p class="text-caption text-medium-emphasis mt-3">
                                {t("The seeder creates a funded LYD wallet, an application, a POS terminal, links and a pg_test_ API token. Reset removes only sandbox data.")}
                            </p>
                        </SurfaceCard>
                    </div>
                    <div class="d-flex flex-column ga-4">
                        <DataTable title={t("Recent sandbox payments")} data={overview.value?.recentPayments ?? []} headers={paymentHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={8} />
                        <DataTable title={t("Recent sandbox activity")} data={overview.value?.syncAudits ?? []} headers={auditHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={8} />
                    </div>
                    {(overview.value?.recentPayments ?? []).length === 0 ? <EmptyState title={t("No sandbox payments yet")} description={t("Seed the demo workspace or create a checkout link to start testing.")} /> : null}
                </div>
            </StateView>
        </ScreenContainer>
    );
});

export default SandboxOverviewPage;
