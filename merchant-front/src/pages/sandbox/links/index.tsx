import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useRoute, useRouter } from "vue-router";
import {PgAlert, PgButton, PgAutocomplete, PgCheckbox, PgTextField, PgTextarea} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {SummaryExportCard} from "@pg/ui";
import type { MetricItem } from "@pg/ui";
import {StateView} from "@pg/ui";
import { SandboxBanner } from "@/features/sandbox/SandboxBanner";
import { SandboxResourceTable } from "@/features/sandbox/SandboxResourceTable";
import { linkFilters } from "@/features/sandbox/sandboxFilters";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {MoneyDisplay} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {SectionFields} from "@pg/ui";
import { sandboxGet, sandboxPost, type SandboxLinkRow, type SandboxStudioOverview, type SandboxSummaryResponse } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { buildCheckoutUrl } from "@/utils/security/checkoutUrl";
import { copyToClipboard } from "@/utils/common";
import { xlsxUIPipeline } from "@/utils/xlsx";

const SandboxLinksPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const summary = ref<Record<string, unknown> | null>(null);
    const applications = ref<Array<{ id: string; name: string; assignedWalletId: string }>>([]);
    const refresh = ref<(() => void) | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const createOpen = ref(false);
    const creating = ref(false);
    const formError = ref("");
    const exportLoading = ref(false);
    const form = ref({ applicationId: String(route.query.applicationId ?? ""), title: "Sandbox test link", description: "Created from Sandbox Studio", amount: "125.0000", currency: "LYD", feeBearer: "MERCHANT_ABSORBS", maxUses: "1", infiniteUse: false, expiresAt: "", redirectUrl: "", allowedRails: "" });

    const loadSummary = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [data, apps] = await Promise.all([
                sandboxGet<SandboxSummaryResponse>("/studio/links/summary"),
                sandboxGet<{ applications: Array<{ id: string; name: string; assignedWalletId: string }> }>("/studio/applications", { page: 1, pageSize: 200 }),
            ]);
            summary.value = data.summary;
            applications.value = apps.applications ?? [];
            if (!form.value.applicationId && applications.value.length > 0) form.value.applicationId = applications.value[0]!.id;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void loadSummary();

    const metrics = computed<MetricItem[]>(() => {
        const data = summary.value ?? {};
        const states = (data.states ?? {}) as Record<string, number>;
        return [
            { key: "total", label: t("Payment links"), value: String(data.total ?? 0) },
            { key: "active", label: t("Active"), value: String(states.PENDING ?? 0), badge: t("Open"), badgeTone: "info" },
            { key: "completed", label: t("Completed"), value: String(states.COMPLETED ?? 0), badge: t("Paid"), badgeTone: "success" },
            { key: "expired", label: t("Expired / cancelled"), value: String((states.EXPIRED ?? 0) + (states.CANCELLED ?? 0)) },
            { key: "amount", label: t("Total face value"), moneyAmount: String(data.amount ?? "0"), currency: "LYD" },
            { key: "uses", label: t("Uses"), value: String(data.uses ?? 0) },
            { key: "confirmed", label: t("Confirmed payments"), value: String(data.confirmed ?? 0) },
        ];
    });

    const checkoutUrl = (key: string) => buildCheckoutUrl(key, import.meta.env.VITE_CHECKOUT_BASE_URL, location.origin);

    const create = async () => {
        if (!form.value.applicationId || !form.value.title.trim() || !form.value.amount.trim()) {
            formError.value = t("Application, title and amount are required");
            return;
        }
        creating.value = true;
        formError.value = "";
        try {
            await sandboxPost("/links", {
                applicationId: form.value.applicationId,
                title: form.value.title.trim(),
                description: form.value.description || undefined,
                amount: form.value.amount,
                currency: form.value.currency.toUpperCase(),
                feeBearer: form.value.feeBearer,
                ...(form.value.infiniteUse ? { infiniteUse: true } : { maxUses: Number(form.value.maxUses) || 1 }),
                ...(form.value.expiresAt ? { expiresAt: form.value.expiresAt } : {}),
                ...(form.value.redirectUrl.trim() ? { redirectUrl: form.value.redirectUrl.trim() } : {}),
                ...(form.value.allowedRails.trim() ? { allowedRails: form.value.allowedRails.split(",").map((entry) => entry.trim()).filter(Boolean) } : {}),
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Payment link created") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            formError.value = extractApiErrorMessage(e);
        } finally {
            creating.value = false;
        }
    };

    const cancel = async (row: SandboxLinkRow) => {
        try {
            await sandboxPost(`/links/${row.id}/cancel`, {});
            showSnackBar({ type: "success", message: t("Payment link cancelled") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const headers: TableHeader<SandboxLinkRow>[] = [
        { key: "key", label: "Link", sortKey: "key", Value: ({ row }) => <div class="d-flex flex-column"><MonoRef value={row.key} truncate={20} /><span class="text-caption text-medium-emphasis">{row.title || "—"}</span></div> },
        { key: "amount", label: "Amount", sortKey: "amount", Value: ({ row }) => <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" /> },
        { key: "state", label: "State", sortKey: "state", Value: ({ row }) => <StatusBadge status={row.state} /> },
        { key: "uses", label: "Uses", value: (row) => `${row.confirmedCount}/${row.infiniteUse ? "∞" : row.useCount}` },
        { key: "applicationName", label: "Application", value: (row) => row.applicationName },
        { key: "walletName", label: "Wallet", value: (row) => row.walletName || row.walletId.slice(0, 8) },
        { key: "expiresAt", label: "Expiry", sortKey: "expiresAt", value: (row) => row.expiresAt ?? "—" },
        { key: "payments", label: "Payments", value: (row) => String(row.payments) },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt },
        {
            key: "actions",
            label: "Actions",
            Value: ({ row }) => (
                <TableRowActions
                    primaryAction={{ label: t("Open checkout"), icon: "mdi-open-in-new", onClick: () => { window.open(checkoutUrl(row.key), "_blank", "noopener"); } }}
                    items={[
                        { key: "detail", label: t("Inspect link"), icon: "mdi-text-search", onClick: () => void router.push(`/sandbox/links/${row.id}`) },
                        { key: "copy", label: t("Copy checkout URL"), icon: "mdi-content-copy", onClick: () => { copyToClipboard(checkoutUrl(row.key)); showSnackBar({ type: "success", message: t("Copied") }); } },
                        { key: "cancel", label: t("Cancel link"), icon: "mdi-close-circle-outline", danger: true, hidden: row.state === "COMPLETED" || row.state === "CANCELLED", onClick: () => void cancel(row) },
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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({ title: `sandbox-links-summary-${new Date().toISOString().slice(0, 10)}.xlsx`, lines: ["metric,value", ...metrics.value.map((item) => `${escape(item.label)},${escape(item.value ?? item.moneyAmount ?? "")}`)] });
            showSnackBar({ type: "success", message: t("Summary exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Sandbox Checkout Links")} subtitle={t("sbx_ links open the Sandbox checkout with the test assistant.")} badge="SANDBOX" badgeTone="warning"><div class="d-flex flex-wrap ga-2"><PgButton variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</PgButton><PgButton variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</PgButton><PgButton color="primary" prependIcon="mdi-plus" onClick={() => { formError.value = ""; createOpen.value = true; }}>{t("Create link")}</PgButton></div></PageHeader>
            <SandboxBanner />
            {error.value ? <PgAlert tone="danger" class="mb-4">{error.value}</PgAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Link health")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
                    <SandboxResourceTable<SandboxLinkRow> title={t("Sandbox payment links")} url="/v1/merchant/sandbox/studio/links" listKey="links" headers={headers} filters={linkFilters(applications.value)} pageSize={20} onRefreshReady={(next) => (refresh.value = next)} />
                </div>
            </StateView>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create sandbox payment link")} size="md" loading={creating.value} errorMessage={formError.value} submitLabel={t("Create")} onSubmit={() => void create()}>
                <SectionFields title={t("Link details")}>
                    <FormField label={t("Application")} required><PgAutocomplete items={applications.value.map((app) => ({ title: app.name, value: app.id }))} modelValue={form.value.applicationId} onUpdate:modelValue={(v: string) => (form.value.applicationId = v)} hideDetails /></FormField>
                    <FormField label={t("Title")} required><PgTextField modelValue={form.value.title} onUpdate:modelValue={(v: string) => (form.value.title = v)} hideDetails /></FormField>
                    <FormField label={t("Description")}><PgTextarea modelValue={form.value.description} onUpdate:modelValue={(v: string) => (form.value.description = v)} rows={2} hideDetails /></FormField>
                    <FormField label={t("Amount")} required><PgTextField type="number" modelValue={form.value.amount} onUpdate:modelValue={(v: string) => (form.value.amount = v)} hideDetails /></FormField>
                    <FormField label={t("Currency")} required><PgTextField modelValue={form.value.currency} onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())} hideDetails /></FormField>
                    <FormField label={t("Fee bearer")}><PgAutocomplete items={["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"].map((value) => ({ title: value.replaceAll("_", " "), value }))} modelValue={form.value.feeBearer} onUpdate:modelValue={(v: string) => (form.value.feeBearer = v)} hideDetails /></FormField>
                    <FormField label={t("Max uses")}><PgTextField type="number" modelValue={form.value.maxUses} onUpdate:modelValue={(v: string) => (form.value.maxUses = v)} disabled={form.value.infiniteUse} hideDetails /></FormField>
                    <FormField label={t("Infinite use")}><PgCheckbox modelValue={form.value.infiniteUse} onUpdate:modelValue={(value: boolean) => (form.value.infiniteUse = value)} hideDetails /></FormField>
                    <FormField label={t("Expires at")}><PgTextField type="datetime-local" modelValue={form.value.expiresAt} onUpdate:modelValue={(v: string) => (form.value.expiresAt = v)} hideDetails /></FormField>
                    <FormField label={t("Redirect URL (optional)")}><PgTextField modelValue={form.value.redirectUrl} onUpdate:modelValue={(v: string) => (form.value.redirectUrl = v)} hideDetails /></FormField>
                    <FormField label={t("Allowed rails")}><PgTextField modelValue={form.value.allowedRails} onUpdate:modelValue={(v: string) => (form.value.allowedRails = v)} placeholder={t("Comma separated, empty means all rails.")} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxLinksPage;
