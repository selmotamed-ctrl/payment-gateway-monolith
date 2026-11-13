import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import SandboxResourceTable from "@/components/sandbox/SandboxResourceTable";
import { walletFilters, WALLET_STATUS } from "@/components/sandbox/sandboxFilters";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { sandboxGet, sandboxPost, sandboxPatch, type SandboxSummaryResponse, type SandboxWalletRow } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { copyToClipboard } from "@/utils/common";
import { xlsxUIPipeline } from "@/utils/xlsx";

type ActionMode = "CREDIT" | "DEBIT" | "SET_EXACT" | "CASHOUT" | "FREEZE" | "UNFREEZE";

const SandboxWalletsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<SandboxWalletRow[]>([]);
    const summary = ref<Record<string, unknown> | null>(null);
    const refresh = ref<(() => void) | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const createOpen = ref(false);
    const creating = ref(false);
    const formError = ref("");
    const createForm = ref({ name: "", currency: "LYD" });
    const target = ref<{ wallet: SandboxWalletRow; mode: ActionMode } | null>(null);
    const actionAmount = ref("");
    const actionReason = ref("");
    const submitting = ref(false);
    const exportLoading = ref(false);

    const loadSummary = async () => {
        loading.value = true;
        error.value = null;
        try {
            const data = await sandboxGet<SandboxSummaryResponse>("/studio/wallets/summary");
            summary.value = data.summary;
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
        const byCurrency = (data.byCurrency ?? {}) as Record<string, string>;
        return [
            { key: "total", label: t("Total wallets"), value: String(data.total ?? 0) },
            { key: "active", label: t("Active wallets"), value: String(status.ACTIVE ?? 0), badge: t("Active"), badgeTone: "success" as const },
            { key: "frozen", label: t("Frozen wallets"), value: String(status.FROZEN ?? 0), badge: status.FROZEN ? t("Contained") : t("Clear"), badgeTone: status.FROZEN ? "danger" as const : "success" as const },
            ...Object.entries(byCurrency).map(([currency, amount]) => ({ key: `balance-${currency}`, label: `${t("Available")} · ${currency}`, moneyAmount: amount, currency })),
            { key: "applications", label: t("Applications"), value: String(data.applications ?? 0) },
            { key: "links", label: t("Payment links"), value: String(data.links ?? 0) },
            { key: "payments", label: t("Payments"), value: String(data.payments ?? 0) },
            { key: "cashouts", label: t("Pending cash-outs"), value: String(data.pendingCashouts ?? 0), badge: Number(data.pendingCashouts ?? 0) ? t("Pending") : t("Clear"), badgeTone: Number(data.pendingCashouts ?? 0) ? "warning" as const : "success" as const },
        ];
    });

    const create = async () => {
        if (!createForm.value.name.trim()) {
            formError.value = t("Wallet name is required");
            return;
        }
        creating.value = true;
        formError.value = "";
        try {
            await sandboxPost("/wallets", { currency: createForm.value.currency.toUpperCase(), label: createForm.value.name.trim() });
            createOpen.value = false;
            createForm.value = { name: "", currency: "LYD" };
            showSnackBar({ type: "success", message: t("Wallet created") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            formError.value = extractApiErrorMessage(e);
        } finally {
            creating.value = false;
        }
    };

    const openAction = (wallet: SandboxWalletRow, mode: ActionMode) => {
        target.value = { wallet, mode };
        actionAmount.value = mode === "SET_EXACT" ? wallet.availableBalance : mode === "CASHOUT" ? "" : "1000.0000";
        actionReason.value = "";
    };

    const submitAction = async () => {
        const current = target.value;
        if (!current) return;
        submitting.value = true;
        try {
            if (current.mode === "FREEZE" || current.mode === "UNFREEZE") {
                await sandboxPatch(`/wallets/${current.wallet.id}/status`, { status: current.mode === "FREEZE" ? "FROZEN" : "ACTIVE", reason: actionReason.value || (current.mode === "FREEZE" ? "Sandbox wallet freeze" : "Sandbox wallet activation") });
            } else if (current.mode === "CASHOUT") {
                await sandboxPost(`/wallets/${current.wallet.id}/simulate-cashout`, { amountLyd: actionAmount.value, reason: actionReason.value || "Sandbox simulated cash-out" });
            } else {
                await sandboxPost(`/wallets/${current.wallet.id}/balance`, { mode: current.mode, amountLyd: actionAmount.value, reason: actionReason.value || `Sandbox wallet ${current.mode}` });
            }
            target.value = null;
            showSnackBar({ type: "success", message: t("Wallet updated") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            submitting.value = false;
        }
    };

    const exportSummary = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `sandbox-wallets-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines: ["metric,value", ...metrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)],
            });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    const headers: TableHeader<SandboxWalletRow>[] = [
        { key: "name", label: "Wallet", sortKey: "name", Value: ({ row }) => <div class="d-flex flex-column"><span class="font-weight-medium">{row.name || t("Sandbox wallet")}</span><MonoRef value={row.id} truncate={14} /></div> },
        { key: "status", label: "Status", sortKey: "status", Value: ({ row }) => <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} /> },
        { key: "currency", label: "Currency", sortKey: "currency", value: (row) => row.currency },
        { key: "availableBalance", label: "Available", Value: ({ row }) => <MoneyDisplay amount={row.availableBalance} currency={row.currency} size="sm" /> },
        { key: "checkpointBalance", label: "Checkpoint", Value: ({ row }) => <MoneyDisplay amount={row.checkpointBalance} currency={row.currency} size="sm" /> },
        { key: "paymentCounts", label: "Apps / links", value: (row) => `${row.applications} / ${row.links}` },
        { key: "payments", label: "Payments", value: (row) => String(row.payments) },
        { key: "pendingCashouts", label: "Pending cash-outs", Value: ({ row }) => row.pendingCashouts ? <StatusBadge status="PENDING" label={String(row.pendingCashouts)} toneOverride="warning" /> : <span class="text-medium-emphasis">—</span> },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt },
        {
            key: "actions",
            label: "Actions",
            Value: ({ row }) => (
                <TableRowActions
                    primaryAction={{ label: t("Open"), icon: "mdi-open-in-new", onClick: () => void router.push(`/sandbox/wallets/${row.id}`) }}
                    items={[
                        { key: "credit", label: t("Credit 1,000 LYD"), icon: "mdi-plus", onClick: () => openAction(row, "CREDIT") },
                        { key: "debit", label: t("Debit 1,000 LYD"), icon: "mdi-minus", onClick: () => openAction(row, "DEBIT") },
                        { key: "exact", label: t("Set exact balance"), icon: "mdi-tune", onClick: () => openAction(row, "SET_EXACT") },
                        { key: "cashout", label: t("Simulate cash-out"), icon: "mdi-cash-fast", onClick: () => openAction(row, "CASHOUT") },
                        { key: "freeze", label: row.status === "FROZEN" ? t("Activate wallet") : t("Freeze wallet"), icon: row.status === "FROZEN" ? "mdi-play" : "mdi-pause", danger: row.status !== "FROZEN", onClick: () => openAction(row, row.status === "FROZEN" ? "UNFREEZE" : "FREEZE") },
                        { key: "copy", label: t("Copy wallet ID"), icon: "mdi-content-copy", onClick: () => { copyToClipboard(row.id); showSnackBar({ type: "success", message: t("Copied") }); } },
                    ]}
                />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <PageHeader
                title={t("Sandbox Wallets")}
                subtitle={t("Balances, ledger checkpoints and test controls for sandbox-only wallets.")}
                badge="SANDBOX"
                badgeTone="warning"
                end={() => (
                    <div class="d-flex flex-wrap ga-2">
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</VBtn>
                        <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                        <VBtn color="primary" prependIcon="mdi-plus" onClick={() => { formError.value = ""; createOpen.value = true; }}>{t("Create wallet")}</VBtn>
                    </div>
                )}
            />
            <SandboxBanner subtitle={t("Wallet balance changes post real double-entry journal entries in the sandbox ledger.")} />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Wallet portfolio")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
                    <SandboxResourceTable<SandboxWalletRow>
                        title={t("Sandbox wallets")}
                        url="/v1/merchant/sandbox/studio/wallets"
                        listKey="wallets"
                        headers={headers}
                        filters={walletFilters()}
                        pageSize={20}
                        onRows={(next) => (rows.value = next)}
                        onRefreshReady={(next) => (refresh.value = next)}
                    />
                </div>
            </StateView>

            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create sandbox wallet")} size="sm" loading={creating.value} errorMessage={formError.value} submitLabel={t("Create")} onSubmit={() => void create()}>
                <SectionFields title={t("Wallet details")}>
                    <FormField label={t("Wallet name")} required>
                        <VTextField modelValue={createForm.value.name} onUpdate:modelValue={(v: string) => (createForm.value.name = v)} hideDetails />
                    </FormField>
                    <FormField label={t("Currency")} required>
                        <VTextField modelValue={createForm.value.currency} onUpdate:modelValue={(v: string) => (createForm.value.currency = v.toUpperCase())} hideDetails />
                    </FormField>
                </SectionFields>
            </FormModal>

            <FormModal
                modelValue={Boolean(target.value)}
                onUpdate:modelValue={(v: any) => { if (!v) target.value = null; }}
                title={target.value ? `${target.value.mode.replaceAll("_", " ")} · ${target.value.wallet.name || target.value.wallet.id.slice(0, 8)}` : t("Wallet action")}
                size="sm"
                loading={submitting.value}
                submitLabel={target.value?.mode === "FREEZE" ? t("Freeze") : target.value?.mode === "UNFREEZE" ? t("Activate") : t("Apply")}
                onSubmit={() => void submitAction()}
            >
                <SectionFields title={t("Action")}>
                    {target.value && !["FREEZE", "UNFREEZE"].includes(target.value.mode) ? (
                        <FormField label={t("Amount LYD")} required>
                            <VTextField type="number" modelValue={actionAmount.value} onUpdate:modelValue={(v: string) => (actionAmount.value = v)} hideDetails />
                        </FormField>
                    ) : null}
                    <FormField label={t("Reason")}>
                        <VTextField modelValue={actionReason.value} onUpdate:modelValue={(v: string) => (actionReason.value = v)} hideDetails />
                    </FormField>
                    <div class="text-caption text-medium-emphasis">{t("Current available")}: {target.value?.wallet.availableBalance} {target.value?.wallet.currency}</div>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxWalletsPage;
