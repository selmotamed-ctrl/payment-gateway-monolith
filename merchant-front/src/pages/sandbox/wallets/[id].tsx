import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import SandboxResourceTable from "@/components/sandbox/SandboxResourceTable";
import { ledgerFilters } from "@/components/sandbox/sandboxFilters";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { sandboxGet, sandboxPatch, sandboxPost, type SandboxLedgerLine, type SandboxWalletDetail } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Tab = "OVERVIEW" | "LEDGER" | "APPLICATIONS" | "LINKS" | "CASHOUTS";
type ActionMode = "CREDIT" | "DEBIT" | "SET_EXACT" | "CASHOUT" | "FREEZE" | "UNFREEZE";

const SandboxWalletDetailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const wallet = ref<SandboxWalletDetail | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const tab = ref<Tab>("OVERVIEW");
    const busy = ref<string | null>(null);
    const ledgerRefresh = ref<(() => void) | null>(null);
    const target = ref<ActionMode | null>(null);
    const exact = ref("");
    const cashoutAmount = ref("");
    const reason = ref("");
    const submitting = ref(false);

    const walletId = () => String(route.params.id ?? "");
    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            wallet.value = await sandboxGet<SandboxWalletDetail>(`/studio/wallets/${encodeURIComponent(walletId())}`);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();
    watch(() => route.params.id, () => void load());

    const metrics = computed<MetricItem[]>(() => {
        const current = wallet.value;
        if (!current) return [];
        return [
            { key: "available", label: t("Available"), moneyAmount: current.availableBalance, currency: current.wallet.currency },
            { key: "checkpoint", label: t("Checkpoint"), moneyAmount: current.checkpointBalance, currency: current.wallet.currency, subLabel: current.checkpointAt ?? t("No checkpoint yet") },
            { key: "pending", label: t("Unposted lines"), value: String(current.pendingLines) },
            { key: "apps", label: t("Applications"), value: String(current.applications.length) },
            { key: "links", label: t("Payment links"), value: String(current.links.length) },
            { key: "payments", label: t("Payments"), value: String(current.attempts) },
            { key: "cashouts", label: t("Pending cash-outs"), value: String(current.pendingCashouts), badge: current.pendingCashouts ? t("Pending") : t("Clear"), badgeTone: current.pendingCashouts ? "warning" : "success" },
            { key: "disputes", label: t("Disputes"), value: String(current.disputes) },
        ];
    });

    const tabs = computed(() => [
        { label: t("Overview"), value: "OVERVIEW" },
        { label: t("Ledger"), value: "LEDGER" },
        { label: t("Applications"), value: "APPLICATIONS" },
        { label: t("Links"), value: "LINKS" },
        { label: t("Cash-outs"), value: "CASHOUTS" },
    ]);

    const ledgerHeaders: TableHeader<SandboxLedgerLine>[] = [
        { key: "createdAt", label: "Date", sortKey: "createdAt", value: (row) => row.createdAt },
        { key: "direction", label: "Side", value: (row) => row.direction },
        { key: "amount", label: "Amount", sortKey: "amount", Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={wallet.value?.wallet.currency ?? "LYD"} size="sm" /> },
        { key: "refType", label: "Reference type", value: (row) => row.refType },
        { key: "refId", label: "Reference", Value: ({ row }) => <MonoRef value={row.refId} truncate={22} /> },
        { key: "description", label: "Description", value: (row) => row.description },
    ];
    const applicationHeaders: TableHeader<SandboxWalletDetail["applications"][number]>[] = [
        { key: "name", label: "Application", value: (row) => row.name },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} /> },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
    ];
    const linkHeaders: TableHeader<SandboxWalletDetail["links"][number]>[] = [
        { key: "key", label: "Link key", Value: ({ row }) => <MonoRef value={row.key} truncate={18} /> },
        { key: "title", label: "Title", value: (row) => row.title ?? "—" },
        { key: "amount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "state", label: "State", Value: ({ row }) => <StatusBadge status={row.state} /> },
        { key: "uses", label: "Uses", value: (row) => `${row.confirmedCount}/${row.useCount}` },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
    ];
    const cashoutHeaders: TableHeader<Record<string, unknown>>[] = [
        { key: "state", label: "State", Value: ({ row }) => <StatusBadge status={String(row.state ?? "")} /> },
        { key: "amount", label: "Amount", Value: ({ row }) => <MoneyDisplay amount={String(row.amount ?? "0")} currency={wallet.value?.wallet.currency ?? "LYD"} size="sm" /> },
        { key: "createdAt", label: "Requested", value: (row) => String(row.createdAt ?? "") },
    ];

    const submit = async () => {
        const current = wallet.value;
        const mode = target.value;
        if (!current || !mode) return;
        submitting.value = true;
        try {
            if (mode === "FREEZE" || mode === "UNFREEZE") {
                await sandboxPatch(`/wallets/${current.wallet.id}/status`, { status: mode === "FREEZE" ? "FROZEN" : "ACTIVE", reason: reason.value || "Sandbox wallet status change" });
            } else if (mode === "CASHOUT") {
                await sandboxPost(`/wallets/${current.wallet.id}/simulate-cashout`, { amountLyd: cashoutAmount.value, reason: reason.value || "Sandbox simulated cash-out" });
            } else {
                await sandboxPost(`/wallets/${current.wallet.id}/balance`, { mode, amountLyd: exact.value, reason: reason.value || `Sandbox wallet ${mode}` });
            }
            target.value = null;
            reason.value = "";
            showSnackBar({ type: "success", message: t("Wallet updated") });
            await load();
            ledgerRefresh.value?.();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            submitting.value = false;
        }
    };

    const openAction = (mode: ActionMode) => {
        target.value = mode;
        exact.value = mode === "SET_EXACT" ? wallet.value?.availableBalance ?? "" : "1000.0000";
        cashoutAmount.value = "";
        reason.value = "";
    };

    return () => (
        <ScreenContainer>
            <PageHeader
                title={wallet.value?.wallet.name || t("Sandbox Wallet")}
                subtitle={wallet.value?.wallet.id ?? walletId()}
                badge="SANDBOX"
                badgeTone="warning"
                breadcrumbs={[{ label: t("Sandbox Wallets"), to: "/sandbox/wallets" }, { label: wallet.value?.wallet.name ?? walletId() }]}
                end={() => (
                    <div class="d-flex flex-wrap ga-2">
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { void load(); ledgerRefresh.value?.(); }}>{t("Refresh")}</VBtn>
                        <VBtn variant="tonal" prependIcon="mdi-cash-plus" onClick={() => openAction("CREDIT")}>{t("Top up")}</VBtn>
                        <VBtn variant="tonal" prependIcon="mdi-cash-fast" onClick={() => openAction("CASHOUT")}>{t("Simulate cash-out")}</VBtn>
                        <VBtn variant="tonal" prependIcon="mdi-pause" onClick={() => openAction(wallet.value?.wallet.status === "FROZEN" ? "UNFREEZE" : "FREEZE")}>{wallet.value?.wallet.status === "FROZEN" ? t("Activate") : t("Freeze")}</VBtn>
                    </div>
                )}
            />
            <SandboxBanner subtitle={t("Sandbox ledger only. Balance changes post balanced journal entries.")} />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value} minHeight="220px">
                {wallet.value ? (
                    <div class="d-flex flex-column ga-4">
                        <MetricStrip items={metrics.value} />
                        <SegmentedTabs modelValue={tab.value} tabs={tabs.value} onUpdate:modelValue={(value: string) => (tab.value = value as Tab)} />
                        {tab.value === "OVERVIEW" ? (
                            <div class="d-flex flex-wrap ga-4 align-start">
                                <SurfaceCard title={t("Wallet")} style={{ flex: "1 1 360px" }}>
                                    <DescriptionList columns={2} items={[
                                        { label: t("Wallet ID"), value: <MonoRef value={wallet.value.wallet.id} /> },
                                        { label: t("Name"), value: wallet.value.wallet.name ?? "—" },
                                        { label: t("Currency"), value: wallet.value.wallet.currency },
                                        { label: t("Status"), value: <StatusBadge status={wallet.value.wallet.status} /> },
                                        { label: t("GL account"), value: <MonoRef value={wallet.value.wallet.glAccountId} truncate={20} /> },
                                        { label: t("Account type"), value: wallet.value.wallet.glAccount?.accountType ?? "MERCHANT_WALLET" },
                                        { label: t("Shards"), value: String(wallet.value.wallet.glAccount?.shardCount ?? wallet.value.shardCount) },
                                        { label: t("Checkpoint status"), value: <StatusBadge status={wallet.value.checkpointStatus} toneOverride={wallet.value.checkpointStatus === "OK" ? "success" : "danger"} /> },
                                        { label: t("Pending lines"), value: String(wallet.value.pendingLines) },
                                        { label: t("Created"), value: wallet.value.wallet.createdAt },
                                    ]} />
                                </SurfaceCard>
                                <SurfaceCard title={t("Balance controls")} style={{ flex: "1 1 360px" }}>
                                    <div class="d-flex flex-wrap ga-2">
                                        <VBtn color="success" variant="tonal" onClick={() => openAction("CREDIT")}>{t("Credit")}</VBtn>
                                        <VBtn color="error" variant="tonal" onClick={() => openAction("DEBIT")}>{t("Debit")}</VBtn>
                                        <VBtn variant="tonal" onClick={() => openAction("SET_EXACT")}>{t("Set exact")}</VBtn>
                                        <VBtn color="warning" variant="tonal" onClick={() => openAction("CASHOUT")}>{t("Simulate cash-out")}</VBtn>
                                    </div>
                                    <p class="text-caption text-medium-emphasis mt-3">{t("Every adjustment is a balanced sandbox journal entry; the ledger keeps the resulting history.")}</p>
                                </SurfaceCard>
                            </div>
                        ) : null}
                        {tab.value === "LEDGER" ? (
                            <SurfaceCard title={t("Sandbox ledger")} subtitle={t("Every posting to this wallet account, newest first.")} noPadding>
                                <SandboxResourceTable<SandboxLedgerLine>
                                    title={t("Ledger lines")}
                                    url={`/v1/merchant/sandbox/wallets/${wallet.value.wallet.id}/ledger`}
                                    listKey="lines"
                                    headers={ledgerHeaders}
                                    filters={ledgerFilters()}
                                    pageSize={25}
                                    showNumber={true}
                                    onRefreshReady={(next) => (ledgerRefresh.value = next)}
                                />
                            </SurfaceCard>
                        ) : null}
                        {tab.value === "APPLICATIONS" ? (
                            <DataTable title={t("Applications")} data={wallet.value.applications} headers={applicationHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={20} />
                        ) : null}
                        {tab.value === "LINKS" ? (
                            <DataTable title={t("Payment links")} data={wallet.value.links} headers={linkHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={20} />
                        ) : null}
                        {tab.value === "CASHOUTS" ? (
                            wallet.value.cashouts.length > 0 ? <DataTable title={t("Cash-outs")} data={wallet.value.cashouts} headers={cashoutHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={20} /> : <EmptyState title={t("No cash-outs")} />
                        ) : null}
                    </div>
                ) : null}
            </StateView>
            <FormModal modelValue={Boolean(target.value)} onUpdate:modelValue={(v: any) => { if (!v) target.value = null; }} title={target.value ? target.value.replaceAll("_", " ") : t("Wallet action")} size="sm" loading={submitting.value} submitLabel={t("Apply")} onSubmit={() => void submit()}>
                <SectionFields title={t("Action")}>
                    {target.value && !["FREEZE", "UNFREEZE"].includes(target.value) ? (
                        <FormField label={target.value === "CASHOUT" ? t("Cash-out amount") : t("Amount LYD")} required>
                            <VTextField type="number" modelValue={target.value === "CASHOUT" ? cashoutAmount.value : exact.value} onUpdate:modelValue={(v: string) => target.value === "CASHOUT" ? (cashoutAmount.value = v) : (exact.value = v)} hideDetails />
                        </FormField>
                    ) : null}
                    <FormField label={t("Reason")}>
                        <VTextField modelValue={reason.value} onUpdate:modelValue={(v: string) => (reason.value = v)} hideDetails />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxWalletDetailPage;
