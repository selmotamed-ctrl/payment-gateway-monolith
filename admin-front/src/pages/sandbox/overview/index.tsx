import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { adminSandbox, sandboxPost, type AdminSandboxMerchantRow, type AdminSandboxOverview } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { xlsxUIPipeline } from "@/utils/xlsx";

const AdminSandboxOverviewPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const overview = ref<AdminSandboxOverview | null>(null);
    const merchants = ref<AdminSandboxMerchantRow[]>([]);
    const loading = ref(true);
    const busy = ref(false);
    const error = ref<string | null>(null);
    const resetOpen = ref(false);
    const resetConfirm = ref("");
    const exportLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [data, merchantPage] = await Promise.all([
                adminSandbox.summary(),
                adminSandbox.merchants({ page: 1, pageSize: 8, sortKey: "createdAt", sortDirection: "desc" }),
            ]);
            overview.value = data;
            merchants.value = merchantPage.merchants ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();

    const resetAll = async () => {
        if (resetConfirm.value !== "RESET SANDBOX") return;
        busy.value = true;
        try {
            await sandboxPost("/global-reset", { confirm: "RESET SANDBOX" });
            resetOpen.value = false;
            resetConfirm.value = "";
            showSnackBar({ type: "success", message: t("All sandbox workspaces reset") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = false;
        }
    };

    const metrics = computed<MetricItem[]>(() => {
        const data = overview.value;
        if (!data) return [];
        return [
            { key: "merchants", label: t("Sandbox merchants"), value: String(data.sandbox.merchants) },
            { key: "wallets", label: t("Wallets"), value: String(data.sandbox.wallets) },
            { key: "apps", label: t("Applications"), value: String(data.sandbox.applications) },
            { key: "links", label: t("Payment links"), value: String(data.sandbox.links) },
            { key: "attempts", label: t("Attempts"), value: String(data.sandbox.attempts) },
            { key: "tokens", label: t("Active test tokens"), value: String(data.sandbox.tokens ?? 0) },
            { key: "reference", label: t("Reference catalog"), value: data.reference?.ready ? t("Ready") : t("Incomplete"), badge: data.reference?.ready ? t("Ready") : t("Attention"), badgeTone: data.reference?.ready ? "success" : "warning" },
            { key: "rails", label: t("Rails / gateways / routes"), value: `${data.reference?.rails ?? 0} / ${data.reference?.gateways ?? 0} / ${data.reference?.routes ?? 0}` },
        ];
    });

    const auditHeaders: TableHeader<{ id: string; syncType: string; createdAt: string; actorRole: string | null }>[] = [
        { key: "syncType", label: "Event", value: (row) => row.syncType },
        { key: "actorRole", label: "Actor", value: (row) => row.actorRole ?? "SYSTEM" },
        { key: "createdAt", label: "Date", value: (row) => row.createdAt },
    ];

    const merchantHeaders: TableHeader<AdminSandboxMerchantRow>[] = [
        { key: "merchant", label: "Merchant", Value: ({ row }) => <div class="d-flex flex-column"><span class="font-weight-medium">{row.tradeName || row.legalName}</span><span class="text-caption text-medium-emphasis">{row.id}</span></div> },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.status} /> },
        { key: "wallets", label: "Wallets", value: (row) => String(row.wallets) },
        { key: "applications", label: "Applications", value: (row) => String(row.applications) },
        { key: "payments", label: "Payments", value: (row) => String(row.payments) },
        { key: "availableBalance", label: "Available", value: (row) => `${row.availableBalance} LYD` },
        { key: "actions", label: "", Value: ({ row }) => <VBtn size="small" variant="tonal" onClick={() => void router.push(`/sandbox/merchants/${row.id}`)}>{t("Open")}</VBtn> },
    ];

    const exportSummary = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `sandbox-admin-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines: ["metric,value", ...metrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)] });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Sandbox & Fake Rails Health")} subtitle={t("Inspect the isolated sandbox plane, its reference catalog and recent merchant activity.")} badge="SANDBOX" badgeTone="warning" end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => void load()}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn><VBtn variant="tonal" prependIcon="mdi-storefront-outline" onClick={() => void router.push("/sandbox/merchants")}>{t("Merchants")}</VBtn><VBtn variant="tonal" color="error" prependIcon="mdi-restore" onClick={() => { resetConfirm.value = ""; resetOpen.value = true; }}>{t("Reset all sandbox data")}</VBtn></div>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Sandbox plane health")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
                    <div class="d-flex flex-wrap ga-4 align-start">
                        <SurfaceCard title={t("Execution plane")} style={{ flex: "1 1 400px" }}>
                            <DescriptionList columns={2} items={[
                                { label: t("Plane"), value: <StatusBadge status={overview.value?.planeState?.plane ?? "SANDBOX"} toneOverride="warning" /> },
                                { label: t("Allow Fake Rails"), value: overview.value?.planeState?.allowFakeRails ? t("Yes") : t("No") },
                                { label: t("Live sync revision"), value: String(overview.value?.planeState?.liveSyncRevision ?? 0) },
                                { label: t("Last synced from Live"), value: overview.value?.lastSyncedFromLive ?? t("Never") },
                                { label: t("Fake Rails"), value: <StatusBadge status={overview.value?.fakeRails.ok ? "REACHABLE" : "UNAVAILABLE"} toneOverride={overview.value?.fakeRails.ok ? "success" : "danger"} /> },
                                { label: t("Reference catalog"), value: overview.value?.reference?.ready ? t("Ready") : t("Incomplete") },
                            ]} />
                        </SurfaceCard>
                        <SurfaceCard title={t("Control center")} style={{ flex: "1 1 400px" }}>
                            <div class="d-flex flex-wrap ga-2">
                                <VBtn variant="tonal" prependIcon="mdi-bank-outline" onClick={() => void router.push("/sandbox/fake-rails")}>{t("Fake Rails accounts & clearing")}</VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-storefront-outline" onClick={() => void router.push("/sandbox/merchants")}>{t("Sandbox merchants")}</VBtn>
                                <VBtn variant="tonal" prependIcon="mdi-history" onClick={() => void router.push("/sandbox/mirror/audit-logs")}>{t("Audit logs")}</VBtn>
                            </div>
                            <p class="text-caption text-medium-emphasis mt-3">{t("Sandbox and Fake Rails data are deliberately excluded from backup targets.")}</p>
                        </SurfaceCard>
                    </div>
                    <DataTable title={t("Recent sandbox merchants")} data={merchants.value} headers={merchantHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={8} />
                    <DataTable title={t("Recent sandbox sync audits")} data={overview.value?.syncAudits ?? []} headers={auditHeaders} loading={false} showNumber={false} xlsx={false} noElevation={true} numberOfItemsPerPage={10} />
                </div>
            </StateView>
            <FormModal modelValue={resetOpen.value} onUpdate:modelValue={(v: any) => (resetOpen.value = v)} title={t("Reset all sandbox data")} size="sm" loading={busy.value} submitLabel={t("Reset sandbox")} onSubmit={() => void resetAll()}>
                <SectionFields title={t("Confirmation")}>
                    <FormField label={t("Type RESET SANDBOX to confirm")} required>
                        <VTextField modelValue={resetConfirm.value} onUpdate:modelValue={(v: string) => (resetConfirm.value = v)} hideDetails />
                    </FormField>
                    <p class="text-caption text-medium-emphasis">{t("This deletes sandbox wallets, applications, links, payments, disputes and Fake Rails test accounts. Live data is never touched.")}</p>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default AdminSandboxOverviewPage;
