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
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues, type TableFilter } from "@/components/Table/filters";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { adminSandbox, type AdminSandboxMerchantRow } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { copyToClipboard } from "@/utils/common";
import { xlsxUIPipeline } from "@/utils/xlsx";

const STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "CLOSED"];

const AdminSandboxMerchantsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const summary = ref<Record<string, unknown> | null>(null);
    const total = ref(0);
    const filters = ref<FilterValues>({});
    const search = ref<string | null>(null);
    const pageSize = ref(20);
    const hook = ref<{ reset: () => void; refreshAsIs: () => void } | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const busy = ref<string | null>(null);
    const resetTarget = ref<AdminSandboxMerchantRow | null>(null);
    const resetConfirm = ref("");
    const exportLoading = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const filterDefs = computed<TableFilter[]>(() => [
        { key: "status", label: t("Status"), type: "data-autocomplete", options: STATUSES.map((value) => ({ title: value, value })), multiple: true },
        { key: "created", label: t("Created"), type: "date", queryFrom: "from", queryTo: "to" },
    ]);

    const loadSummary = async () => {
        loading.value = true;
        error.value = null;
        try {
            const data = await adminSandbox.merchantsSummary();
            summary.value = data.summary;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void loadSummary();

    const onFilter = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => hook.value?.reset(), 300);
    };
    const clearFilters = () => { filters.value = {}; hook.value?.reset(); };

    const metrics = computed<MetricItem[]>(() => {
        const data = summary.value ?? {};
        const status = (data.status ?? {}) as Record<string, number>;
        const byCurrency = (data.byCurrency ?? {}) as Record<string, string>;
        return [
            { key: "total", label: t("Sandbox merchants"), value: String(data.total ?? 0) },
            { key: "active", label: t("Active"), value: String(status.ACTIVE ?? 0), badge: t("Active"), badgeTone: "success" },
            { key: "wallets", label: t("Wallets"), value: String(data.wallets ?? 0) },
            { key: "attempts", label: t("Payments"), value: String(data.attempts ?? 0) },
            { key: "cashouts", label: t("Pending cash-outs"), value: String(data.pendingCashouts ?? 0), badge: Number(data.pendingCashouts ?? 0) ? t("Pending") : t("Clear"), badgeTone: Number(data.pendingCashouts ?? 0) ? "warning" : "success" },
            { key: "disputes", label: t("Open disputes"), value: String(data.openDisputes ?? 0), badge: Number(data.openDisputes ?? 0) ? t("Review") : t("Clear"), badgeTone: Number(data.openDisputes ?? 0) ? "danger" : "success" },
            { key: "accounts", label: t("Fake Rails accounts"), value: String(data.fakeAccounts ?? 0) },
            ...Object.entries(byCurrency).map(([currency, amount]) => ({ key: `balance-${currency}`, label: `${t("Available")} · ${currency}`, moneyAmount: amount, currency })),
        ];
    });

    const seed = async (row: AdminSandboxMerchantRow, history = false) => {
        busy.value = row.id;
        try {
            if (history) await adminSandbox.seedHistory(row.id);
            else await adminSandbox.seedMerchant(row.id);
            showSnackBar({ type: "success", message: history ? t("Sandbox history created") : t("Sandbox demo workspace ready") });
            hook.value?.refreshAsIs();
            await loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const reset = async () => {
        if (!resetTarget.value || resetConfirm.value !== "RESET") return;
        busy.value = resetTarget.value.id;
        try {
            await adminSandbox.resetMerchant(resetTarget.value.id);
            resetTarget.value = null;
            resetConfirm.value = "";
            showSnackBar({ type: "success", message: t("Merchant sandbox reset") });
            hook.value?.refreshAsIs();
            await loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const headers: TableHeader<AdminSandboxMerchantRow>[] = [
        { key: "merchant", label: "Merchant", Value: ({ row }) => <div class="d-flex flex-column"><span class="font-weight-medium">{row.tradeName || row.legalName}</span><span class="text-caption text-medium-emphasis">{row.displayName ?? row.legalName}</span><MonoRef value={row.id} truncate={14} /></div> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "wallets", label: "Wallets", value: (row) => String(row.wallets) },
        { key: "applications", label: "Applications", value: (row) => String(row.applications) },
        { key: "payments", label: "Payments", value: (row) => String(row.payments) },
        { key: "cashouts", label: "Cash-outs", value: (row) => String(row.cashouts) },
        { key: "availableBalance", label: "Available", Value: ({ row }) => <MoneyDisplay amount={row.availableBalance} currency="LYD" size="sm" /> },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
        { key: "actions", label: "Actions", Value: ({ row }) => (
            <TableRowActions
                primaryAction={{ label: t("Open"), icon: "mdi-open-in-new", onClick: () => void router.push(`/sandbox/merchants/${row.id}`) }}
                items={[
                    { key: "seed", label: t("Seed demo workspace"), icon: "mdi-play", onClick: () => void seed(row) },
                    { key: "history", label: t("Seed 20 payments"), icon: "mdi-history", onClick: () => void seed(row, true) },
                    { key: "reset", label: t("Reset sandbox"), icon: "mdi-restore", danger: true, onClick: () => { resetTarget.value = row; resetConfirm.value = ""; } },
                    { key: "copy", label: t("Copy merchant ID"), icon: "mdi-content-copy", onClick: () => { copyToClipboard(row.id); showSnackBar({ type: "success", message: t("Copied") }); } },
                ]}
            />
        ) },
    ];

    const exportSummary = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `sandbox-merchants-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines: ["metric,value", ...metrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)] });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Sandbox Merchants")} subtitle={t("The merchant portfolio in the isolated sandbox plane.")} badge="SANDBOX" badgeTone="warning" end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { hook.value?.refreshAsIs(); void loadSummary(); }}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn></div>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Sandbox merchant health")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
                    <ApiTable<AdminSandboxMerchantRow>
                        title={t("Sandbox merchants")}
                        url="/v1/admin/sandbox/merchants"
                        localSearch={false}
                        xlsx={true}
                        noElevation={true}
                        showNumber={true}
                        numberOfItemsPerPage={pageSize.value}
                        setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                        headers={headers}
                        apiDataExtractor={(data) => (data as { merchants?: AdminSandboxMerchantRow[] }).merchants ?? []}
                        apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                        onData={(_, nextTotal) => (total.value = nextTotal)}
                        setRefreshHook={(next) => (hook.value = next as typeof hook.value)}
                        onRefresh={(table, refresh) => {
                            void refresh({ queryParams: { page: table.page, pageSize: pageSize.value, ...(search.value ? { search: search.value } : {}), ...buildFilterQuery(filterDefs.value, filters.value), ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}) } });
                        }}
                        TopSlot={() => <TableFilters filters={filterDefs.value} values={filters.value} total={total.value} onChange={onFilter} onClear={clearFilters} />}
                    />
                </div>
            </StateView>
            <FormModal modelValue={Boolean(resetTarget.value)} onUpdate:modelValue={(v: any) => { if (!v) resetTarget.value = null; }} title={t("Reset merchant sandbox")} size="sm" loading={Boolean(busy.value)} submitLabel={t("Reset sandbox")} onSubmit={() => void reset()}>
                <SectionFields title={t("Confirmation")}>
                    <FormField label={t("Type RESET to confirm")} required><VTextField modelValue={resetConfirm.value} onUpdate:modelValue={(v: string) => (resetConfirm.value = v)} hideDetails /></FormField>
                    <p class="text-caption text-medium-emphasis">{t("This resets")} {resetTarget.value?.tradeName}. {t("Live data is never touched.")}</p>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default AdminSandboxMerchantsPage;
