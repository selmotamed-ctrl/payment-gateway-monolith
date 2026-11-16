import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { EmptyState } from "@/components/ui/EmptyState";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import { adminSandbox, type AdminSandboxMerchantDetail } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Tab = "OVERVIEW" | "WALLETS" | "APPLICATIONS" | "LINKS" | "PAYMENTS" | "CASHOUTS" | "DISPUTES" | "ACCOUNTS" | "AUDITS";

const AdminSandboxMerchantDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const detail = ref<AdminSandboxMerchantDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const tab = ref<Tab>("OVERVIEW");
    const busy = ref<string | null>(null);
    const merchantId = () => String(route.params.id ?? "");
    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            detail.value = await adminSandbox.merchant(merchantId());
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();
    watch(() => route.params.id, () => void load());

    const metrics = computed<MetricItem[]>(() => {
        const data = detail.value;
        if (!data) return [];
        const available = data.wallets.reduce((sum, wallet) => sum + Number(wallet.availableBalance || 0), 0);
        return [
            { key: "wallets", label: t("Wallets"), value: String(data.wallets.length) },
            { key: "applications", label: t("Applications"), value: String(data.applications.length) },
            { key: "links", label: t("Payment links"), value: String(data.links.length) },
            { key: "payments", label: t("Recent payments"), value: String(data.payments.length) },
            { key: "cashouts", label: t("Cash-outs"), value: String(data.cashouts.length) },
            { key: "disputes", label: t("Disputes"), value: String(data.disputes.length) },
            { key: "accounts", label: t("Fake Rails accounts"), value: String(data.accounts.length) },
            { key: "available", label: t("Available"), moneyAmount: available.toFixed(4), currency: "LYD" },
        ];
    });

    const tabs = computed(() => [
        { label: t("Overview"), value: "OVERVIEW" }, { label: t("Wallets"), value: "WALLETS" }, { label: t("Applications"), value: "APPLICATIONS" },
        { label: t("Payment links"), value: "LINKS" }, { label: t("Payments"), value: "PAYMENTS" }, { label: t("Cash-outs"), value: "CASHOUTS" },
        { label: t("Disputes"), value: "DISPUTES" }, { label: t("Fake Rails accounts"), value: "ACCOUNTS" }, { label: t("Audits"), value: "AUDITS" },
    ]);

    const walletHeaders: TableHeader<AdminSandboxMerchantDetail["wallets"][number]>[] = [
        { key: "name", label: "Wallet", Value: ({ row }) => <div class="d-flex flex-column"><span>{row.name || t("Sandbox wallet")}</span><MonoRef value={row.id} truncate={14} /></div> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "availableBalance", label: "Available", Value: ({ row }) => <MoneyDisplay amount={row.availableBalance} currency={row.currency} size="sm" /> },
        { key: "checkpointBalance", label: "Checkpoint", Value: ({ row }) => <MoneyDisplay amount={row.checkpointBalance} currency={row.currency} size="sm" /> },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
    ];
    const appHeaders: TableHeader<AdminSandboxMerchantDetail["applications"][number]>[] = [
        { key: "name", label: "Application", value: (row) => row.name },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "expectedMonthlyVolume", label: "Expected volume", value: (row) => row.expectedMonthlyVolume },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
    ];
    const linkHeaders: TableHeader<AdminSandboxMerchantDetail["links"][number]>[] = [
        { key: "key", label: "Link key", Value: ({ row }) => <MonoRef value={row.key} truncate={18} /> },
        { key: "title", label: "Title", value: (row) => row.title ?? "—" },
        { key: "amount", label: "Amount", value: (row) => row.amount },
        { key: "state", label: "State", Value: ({ row }) => <StatusBadge status={row.state} /> },
        { key: "uses", label: "Uses", value: (row) => `${row.confirmedCount}/${row.useCount}` },
    ];
    const paymentHeaders: TableHeader<AdminSandboxMerchantDetail["payments"][number]>[] = [
        { key: "reference", label: "Reference", Value: ({ row }) => <MonoRef value={row.reference} truncate={18} /> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "totalChargedAmount", label: "Charged", Value: ({ row }) => <MoneyDisplay amount={row.totalChargedAmount} currency={row.currency} size="sm" /> },
        { key: "netMerchantAmount", label: "Net", Value: ({ row }) => <MoneyDisplay amount={row.netMerchantAmount} currency={row.currency} size="sm" /> },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
    ];
    const genericHeaders = (fields: string[]): TableHeader<Record<string, unknown>>[] => fields.map((field) => ({ key: field, label: field.replaceAll("_", " "), value: (row) => String(row[field] ?? "") }));
    const accountHeaders: TableHeader<AdminSandboxMerchantDetail["accounts"][number]>[] = [
        { key: "rail_code", label: "Rail", value: (row) => row.rail_code },
        { key: "holder_name", label: "Holder", value: (row) => row.holder_name },
        { key: "identifier", label: "Identifier", Value: ({ row }) => <MonoRef value={row.identifier} truncate={18} /> },
        { key: "available_balance_lyd", label: "Available", Value: ({ row }) => <MoneyDisplay amount={row.available_balance_lyd} currency="LYD" size="sm" /> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
    ];
    const auditHeaders: TableHeader<AdminSandboxMerchantDetail["audits"][number]>[] = [
        { key: "syncType", label: "Event", value: (row) => row.syncType },
        { key: "actorRole", label: "Actor", value: (row) => row.actorRole ?? "SYSTEM" },
        { key: "createdAt", label: "Date", value: (row) => row.createdAt },
    ];

    const seed = async (history = false) => {
        busy.value = history ? "history" : "seed";
        try {
            if (history) await adminSandbox.seedHistory(merchantId()); else await adminSandbox.seedMerchant(merchantId());
            showSnackBar({ type: "success", message: history ? t("Sandbox history created") : t("Sandbox demo workspace ready") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally { busy.value = null; }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={detail.value?.merchant.tradeName ?? t("Sandbox Merchant")} subtitle={detail.value?.merchant.id ?? merchantId()} badge="SANDBOX" badgeTone="warning" breadcrumbs={[{ label: t("Sandbox Merchants"), to: "/sandbox/merchants" }, { label: detail.value?.merchant.tradeName ?? merchantId() }]} end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => void load()}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-play" loading={busy.value === "seed"} onClick={() => void seed()}>{t("Seed demo")}</VBtn><VBtn variant="tonal" prependIcon="mdi-history" loading={busy.value === "history"} onClick={() => void seed(true)}>{t("Seed history")}</VBtn><VBtn variant="tonal" prependIcon="mdi-storefront-outline" onClick={() => void router.push("/sandbox/merchants")}>{t("Back")}</VBtn></div>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value} minHeight="220px">
                {detail.value ? <div class="d-flex flex-column ga-4">
                    <MetricStrip items={metrics.value} />
                    <SegmentedTabs modelValue={tab.value} tabs={tabs.value} onUpdate:modelValue={(value: string) => (tab.value = value as Tab)} />
                    {tab.value === "OVERVIEW" ? <SurfaceCard title={t("Merchant")}><DescriptionList columns={2} items={[
                        { label: t("Merchant ID"), value: <MonoRef value={detail.value.merchant.id} /> },
                        { label: t("Trade name"), value: detail.value.merchant.tradeName },
                        { label: t("Legal name"), value: detail.value.merchant.legalName },
                        { label: t("Status"), value: <StatusBadge status={detail.value.merchant.status} /> },
                        { label: t("Contact email"), value: detail.value.merchant.contactEmail ?? "—" },
                        { label: t("Created"), value: detail.value.merchant.createdAt },
                    ]} /></SurfaceCard> : null}
                    {tab.value === "WALLETS" ? <DataTable title={t("Wallets")} data={detail.value.wallets} headers={walletHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                    {tab.value === "APPLICATIONS" ? <DataTable title={t("Applications")} data={detail.value.applications} headers={appHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                    {tab.value === "LINKS" ? <DataTable title={t("Payment links")} data={detail.value.links} headers={linkHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                    {tab.value === "PAYMENTS" ? <DataTable title={t("Payments")} data={detail.value.payments} headers={paymentHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                    {tab.value === "CASHOUTS" ? <DataTable title={t("Cash-outs")} data={detail.value.cashouts} headers={genericHeaders(["state", "amount", "createdAt"])} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                    {tab.value === "DISPUTES" ? <DataTable title={t("Disputes")} data={detail.value.disputes} headers={genericHeaders(["status", "reasonCode", "amount", "openedAt"])} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                    {tab.value === "ACCOUNTS" ? <DataTable title={t("Fake Rails accounts")} data={detail.value.accounts} headers={accountHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                    {tab.value === "AUDITS" ? <DataTable title={t("Sandbox audits")} data={detail.value.audits} headers={auditHeaders} loading={false} showNumber={true} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : null}
                </div> : <EmptyState title={t("Merchant not found")} />}
            </StateView>
        </ScreenContainer>
    );
});

export default AdminSandboxMerchantDetailPage;
