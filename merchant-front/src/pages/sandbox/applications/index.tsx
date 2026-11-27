import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useRouter } from "vue-router";
import {PgAlert, PgButton, PgAutocomplete, PgTextField, PgTextarea} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {SummaryExportCard} from "@pg/ui";
import type { MetricItem } from "@pg/ui";
import {StateView} from "@pg/ui";
import { SandboxBanner } from "@/features/sandbox/SandboxBanner";
import { SandboxResourceTable } from "@/features/sandbox/SandboxResourceTable";
import { applicationFilters } from "@/features/sandbox/sandboxFilters";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {MoneyDisplay} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {SectionFields} from "@pg/ui";
import { sandboxGet, sandboxPost, type SandboxApplicationRow, type SandboxSummaryResponse, type SandboxStudioOverview } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { copyToClipboard } from "@/utils/common";
import { xlsxUIPipeline } from "@/utils/xlsx";

const SandboxApplicationsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const summary = ref<Record<string, unknown> | null>(null);
    const wallets = ref<Array<{ id: string; name: string | null; currency: string; availableBalance: string }>>([]);
    const refresh = ref<(() => void) | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const createOpen = ref(false);
    const creating = ref(false);
    const formError = ref("");
    const form = ref({ name: "", description: "", expectedMonthlyVolume: "", walletId: "", railWhitelist: "", redirectDomainAllowlist: "" });
    const exportLoading = ref(false);

    const loadSummary = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [data, overview] = await Promise.all([
                sandboxGet<SandboxSummaryResponse>("/studio/applications/summary"),
                sandboxGet<SandboxStudioOverview>("/studio/overview"),
            ]);
            summary.value = data.summary;
            wallets.value = overview.wallets ?? [];
            if (!form.value.walletId && wallets.value.length > 0) form.value.walletId = wallets.value[0]!.id;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void loadSummary();

    const metrics = computed<MetricItem[]>(() => {
        const data = summary.value ?? {};
        const status = (data.status ?? {}) as Record<string, number>;
        return [
            { key: "total", label: t("Applications"), value: String(data.total ?? 0) },
            { key: "active", label: t("Active"), value: String(status.ACTIVE ?? 0), badge: t("Active"), badgeTone: "success" },
            { key: "suspended", label: t("Suspended"), value: String(status.SUSPENDED ?? 0), badge: status.SUSPENDED ? t("Review") : t("Clear"), badgeTone: status.SUSPENDED ? "warning" : "success" },
            { key: "links", label: t("Payment links"), value: String(data.links ?? 0) },
            { key: "payments", label: t("Payments"), value: String(data.payments ?? 0) },
        ];
    });

    const create = async () => {
        if (!form.value.name.trim() || !form.value.walletId) {
            formError.value = t("Application name and wallet are required");
            return;
        }
        creating.value = true;
        formError.value = "";
        try {
            await sandboxPost("/applications", {
                name: form.value.name.trim(),
                businessUseDescription: form.value.description || undefined,
                expectedMonthlyVolume: form.value.expectedMonthlyVolume || undefined,
                assignedWalletId: form.value.walletId,
                ...(form.value.railWhitelist.trim() ? { railWhitelist: form.value.railWhitelist.split(",").map((entry) => entry.trim()).filter(Boolean) } : {}),
                ...(form.value.redirectDomainAllowlist.trim() ? { redirectDomainAllowlist: form.value.redirectDomainAllowlist.split(",").map((entry) => entry.trim()).filter(Boolean) } : {}),
            });
            createOpen.value = false;
            form.value.name = "";
            form.value.description = "";
            form.value.expectedMonthlyVolume = "";
            form.value.railWhitelist = "";
            form.value.redirectDomainAllowlist = "";
            showSnackBar({ type: "success", message: t("Application created") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            formError.value = extractApiErrorMessage(e);
        } finally {
            creating.value = false;
        }
    };

    const headers: TableHeader<SandboxApplicationRow>[] = [
        { key: "name", label: "Application", sortKey: "name", Value: ({ row }) => <div class="d-flex flex-column"><span class="font-weight-medium">{row.name}</span><MonoRef value={row.id} truncate={14} /></div> },
        { key: "status", label: "Status", sortKey: "status", Value: ({ row }) => <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} /> },
        { key: "wallet", label: "Wallet", value: (row) => `${row.walletName || row.assignedWalletId.slice(0, 8)} · ${row.walletCurrency}` },
        { key: "expectedMonthlyVolume", label: "Expected monthly volume", Value: ({ row }) => <MoneyDisplay amount={row.expectedMonthlyVolume} currency={row.walletCurrency} size="sm" /> },
        { key: "railWhitelist", label: "Rail whitelist", value: (row) => row.railWhitelist?.length ? row.railWhitelist.join(", ") : t("All") },
        { key: "redirectDomainAllowlist", label: "Redirect domains", value: (row) => row.redirectDomainAllowlist?.length ? row.redirectDomainAllowlist.join(", ") : "—" },
        { key: "counts", label: "Links / payments", value: (row) => `${row.links} / ${row.payments}` },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt },
        {
            key: "actions",
            label: "Actions",
            Value: ({ row }) => (
                <TableRowActions
                    primaryAction={{ label: t("Open"), icon: "mdi-open-in-new", onClick: () => void router.push(`/sandbox/applications/${row.id}`) }}
                    items={[
                        { key: "link", label: t("Create payment link"), icon: "mdi-link-plus", onClick: () => void router.push({ path: "/sandbox/links", query: { applicationId: row.id } }) },
                        { key: "copy", label: t("Copy application ID"), icon: "mdi-content-copy", onClick: () => { copyToClipboard(row.id); showSnackBar({ type: "success", message: t("Copied") }); } },
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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `sandbox-applications-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines: ["metric,value", ...metrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)] });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Sandbox Applications")} subtitle={t("Applications bound to sandbox wallets and Fake Rails routes.")} badge="SANDBOX" badgeTone="warning"><div class="d-flex flex-wrap ga-2"><PgButton variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</PgButton><PgButton variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</PgButton><PgButton color="primary" prependIcon="mdi-plus" onClick={() => { formError.value = ""; createOpen.value = true; }}>{t("Create application")}</PgButton></div></PageHeader>
            <SandboxBanner />
            {error.value ? <PgAlert tone="danger" class="mb-4">{error.value}</PgAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Application portfolio")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
                    <SandboxResourceTable<SandboxApplicationRow> title={t("Sandbox applications")} url="/v1/merchant/sandbox/studio/applications" listKey="applications" headers={headers} filters={applicationFilters(wallets.value)} pageSize={20} onRefreshReady={(next) => (refresh.value = next)} />
                </div>
            </StateView>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create sandbox application")} size="md" loading={creating.value} errorMessage={formError.value} submitLabel={t("Create")} onSubmit={() => void create()}>
                <SectionFields title={t("Application details")}>
                    <FormField label={t("Application name")} required><PgTextField modelValue={form.value.name} onUpdate:modelValue={(v: string) => (form.value.name = v)} hideDetails /></FormField>
                    <FormField label={t("Description")}><PgTextarea modelValue={form.value.description} onUpdate:modelValue={(v: string) => (form.value.description = v)} rows={3} hideDetails /></FormField>
                    <FormField label={t("Expected monthly volume")}><PgTextField type="number" modelValue={form.value.expectedMonthlyVolume} onUpdate:modelValue={(v: string) => (form.value.expectedMonthlyVolume = v)} hideDetails /></FormField>
                    <FormField label={t("Sandbox wallet")} required><PgAutocomplete items={wallets.value.map((wallet) => ({ title: `${wallet.name || wallet.id.slice(0, 8)} (${wallet.availableBalance})`, value: wallet.id }))} modelValue={form.value.walletId} onUpdate:modelValue={(v: string) => (form.value.walletId = v)} hideDetails /></FormField>
                    <FormField label={t("Rail whitelist")}><PgTextField modelValue={form.value.railWhitelist} onUpdate:modelValue={(v: string) => (form.value.railWhitelist = v)} placeholder={t("Comma separated, empty means all rails.")} hideDetails /></FormField>
                    <FormField label={t("Redirect domain allowlist")}><PgTextField modelValue={form.value.redirectDomainAllowlist} onUpdate:modelValue={(v: string) => (form.value.redirectDomainAllowlist = v)} placeholder={t("Comma separated domains.")} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxApplicationsPage;
