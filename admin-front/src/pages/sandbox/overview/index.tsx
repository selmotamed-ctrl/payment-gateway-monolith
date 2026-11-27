import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useRouter } from "vue-router";
import {PgAlert, PgButton, PgTextField} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {SurfaceCard} from "@pg/ui";
import {SummaryExportCard} from "@pg/ui";
import type { MetricItem } from "@pg/ui";
import {DescriptionList} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import { DataTable } from "@/tables/DataTable";
import type { TableHeader } from "@pg/ui";
import {StateView} from "@pg/ui";
import { SandboxBanner } from "@/features/sandbox/SandboxBanner";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import { areChecklistsVisible } from "@/constants/env";
import {SectionFields} from "@pg/ui";
import { adminSandbox, sandboxPost, type AdminSandboxMerchantRow, type AdminSandboxOverview } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { xlsxUIPipeline } from "@/utils/xlsx";

const RESET_CHECKS = [
    { key: "SANDBOX_SCOPE_VERIFIED", label: "Sandbox plane and scope verified" },
    { key: "LIVE_ISOLATION_CONFIRMED", label: "Live data isolation confirmed" },
    { key: "RESET_IMPACT_ACKNOWLEDGED", label: "Sandbox-only destructive impact acknowledged" },
    { key: "AUTHORITY_CONFIRMED", label: "Sandbox admin authority confirmed" },
] as const;

const EXPORT_CHECKS = [
    { key: "SANDBOX_SCOPE_VERIFIED", label: "Sandbox scope verified" },
    { key: "HEALTH_AND_DATA_REVIEWED", label: "Health and sandbox data reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

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
    const showChecklists = areChecklistsVisible();
    const resetChecklist = ref<Record<string, boolean>>({});
    const resetChecklistComplete = computed(() => !showChecklists || RESET_CHECKS.every((check) => resetChecklist.value[check.key] === true));
    const exportChecklist = ref<Record<string, boolean>>({});
    const exportChecklistComplete = computed(() => !showChecklists || EXPORT_CHECKS.every((check) => exportChecklist.value[check.key] === true));

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

    const copySandboxSummary = async () => {
        const data = overview.value;
        if (!data) return;
        const summary = {
            sandbox: data.sandbox,
            reference: data.reference,
            merchants: merchants.value.map((row) => ({ id: row.id, name: row.tradeName || row.legalName, status: row.status, wallets: row.wallets, applications: row.applications, payments: row.payments, cashouts: row.cashouts })),
            url: window.location.href,
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
            showSnackBar({ type: "success", message: t("Sandbox summary copied") });
        } catch {
            showSnackBar({ type: "error", message: t("Could not copy to the clipboard") });
        }
    };

    const resetAll = async () => {
        if (resetConfirm.value !== "RESET SANDBOX") return;
        if (!resetChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all reset checklist items before continuing") });
            return;
        }
        busy.value = true;
        try {
            await sandboxPost("/global-reset", {
                confirm: "RESET SANDBOX",
                checklist: RESET_CHECKS.filter((check) => resetChecklist.value[check.key]).map((check) => check.key),
            });
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
        { key: "actions", label: "", Value: ({ row }) => <PgButton size="small" variant="tonal" onClick={() => void router.push(`/sandbox/merchants/${row.id}`)}>{t("Open")}</PgButton> },
    ];

    const exportSummary = async () => {
        if (exportLoading.value) return;
        if (!exportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all export checklist items before exporting") });
            return;
        }
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
            <PageHeader title={t("Sandbox & Fake Rails Health")} subtitle={t("Inspect the isolated sandbox plane, its reference catalog and recent merchant activity.")} badge="SANDBOX" badgeTone="warning"><div class="d-flex flex-wrap ga-2"><PgButton variant="tonal" prependIcon="mdi-refresh" onClick={() => void load()}>{t("Refresh")}</PgButton><PgButton variant="tonal" prependIcon="mdi-content-copy" disabled={!overview.value} onClick={() => void copySandboxSummary()}>{t("Copy summary")}</PgButton><PgButton variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</PgButton><PgButton variant="tonal" prependIcon="mdi-storefront-outline" onClick={() => void router.push("/sandbox/merchants")}>{t("Merchants")}</PgButton><PgButton variant="tonal" color="error" prependIcon="mdi-restore" onClick={() => { resetConfirm.value = ""; resetChecklist.value = {}; resetOpen.value = true; }}>{t("Reset all sandbox data")}</PgButton></div></PageHeader>
            <SandboxBanner />
            {error.value ? <PgAlert tone="danger" class="mb-4">{error.value}</PgAlert> : null}
            <StateView loading={loading.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Sandbox plane health")} metrics={metrics.value} checks={[...EXPORT_CHECKS]} checklist={exportChecklist.value} onUpdate:checklist={(value: Record<string, boolean>) => (exportChecklist.value = value)} showChecklists={showChecklists} checklistComplete={exportChecklistComplete.value} exportLoading={exportLoading.value} exportDisabled={!exportChecklistComplete.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
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
                                <PgButton variant="tonal" prependIcon="mdi-bank-outline" onClick={() => void router.push("/sandbox/fake-rails")}>{t("Fake Rails accounts & clearing")}</PgButton>
                                <PgButton variant="tonal" prependIcon="mdi-storefront-outline" onClick={() => void router.push("/sandbox/merchants")}>{t("Sandbox merchants")}</PgButton>
                                <PgButton variant="tonal" prependIcon="mdi-history" onClick={() => void router.push("/sandbox/mirror/audit-logs")}>{t("Audit logs")}</PgButton>
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
                        <PgTextField modelValue={resetConfirm.value} onUpdate:modelValue={(v: string) => (resetConfirm.value = v)} hideDetails />
                    </FormField>
                    <p class="text-caption text-medium-emphasis">{t("This deletes sandbox wallets, applications, links, payments, disputes and Fake Rails test accounts. Live data is never touched.")}</p>
                </SectionFields>
                <FormChecklist
                    checks={[...RESET_CHECKS]}
                    modelValue={resetChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (resetChecklist.value = value)}
                    show={showChecklists}
                    title={t("Reset sandbox checklist")}
                    complete={resetChecklistComplete.value}
                    incompleteMessage={t("Complete all reset checklist items before continuing")}
                />
            </FormModal>
        </ScreenContainer>
    );
});

export default AdminSandboxOverviewPage;
