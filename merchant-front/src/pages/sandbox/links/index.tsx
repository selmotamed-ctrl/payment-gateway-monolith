import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import SandboxResourceTable from "@/components/sandbox/SandboxResourceTable";
import { linkFilters } from "@/components/sandbox/sandboxFilters";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
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
            <PageHeader title={t("Sandbox Checkout Links")} subtitle={t("sbx_ links open the Sandbox checkout with the test assistant.")} badge="SANDBOX" badgeTone="warning" end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn><VBtn color="primary" prependIcon="mdi-plus" onClick={() => { formError.value = ""; createOpen.value = true; }}>{t("Create link")}</VBtn></div>} />
            <SandboxBanner />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="180px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Link health")} metrics={metrics.value} exportLoading={exportLoading.value} exportLabel={t("Export summary")} onExport={() => void exportSummary()} />
                    <SandboxResourceTable<SandboxLinkRow> title={t("Sandbox payment links")} url="/v1/merchant/sandbox/studio/links" listKey="links" headers={headers} filters={linkFilters(applications.value)} pageSize={20} onRefreshReady={(next) => (refresh.value = next)} />
                </div>
            </StateView>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create sandbox payment link")} size="md" loading={creating.value} errorMessage={formError.value} submitLabel={t("Create")} onSubmit={() => void create()}>
                <SectionFields title={t("Link details")}>
                    <FormField label={t("Application")} required><VSelect items={applications.value.map((app) => ({ title: app.name, value: app.id }))} modelValue={form.value.applicationId} onUpdate:modelValue={(v: string) => (form.value.applicationId = v)} hideDetails /></FormField>
                    <FormField label={t("Title")} required><VTextField modelValue={form.value.title} onUpdate:modelValue={(v: string) => (form.value.title = v)} hideDetails /></FormField>
                    <FormField label={t("Description")}><VTextarea modelValue={form.value.description} onUpdate:modelValue={(v: string) => (form.value.description = v)} rows={2} hideDetails /></FormField>
                    <FormField label={t("Amount")} required><VTextField type="number" modelValue={form.value.amount} onUpdate:modelValue={(v: string) => (form.value.amount = v)} hideDetails /></FormField>
                    <FormField label={t("Currency")} required><VTextField modelValue={form.value.currency} onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())} hideDetails /></FormField>
                    <FormField label={t("Fee bearer")}><VSelect items={["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"].map((value) => ({ title: value.replaceAll("_", " "), value }))} modelValue={form.value.feeBearer} onUpdate:modelValue={(v: string) => (form.value.feeBearer = v)} hideDetails /></FormField>
                    <FormField label={t("Max uses")}><VTextField type="number" modelValue={form.value.maxUses} onUpdate:modelValue={(v: string) => (form.value.maxUses = v)} disabled={form.value.infiniteUse} hideDetails /></FormField>
                    <FormField label={t("Infinite use")}><input type="checkbox" checked={form.value.infiniteUse} onChange={(event: Event) => (form.value.infiniteUse = (event.target as HTMLInputElement).checked)} /></FormField>
                    <FormField label={t("Expires at")}><VTextField type="datetime-local" modelValue={form.value.expiresAt} onUpdate:modelValue={(v: string) => (form.value.expiresAt = v)} hideDetails /></FormField>
                    <FormField label={t("Redirect URL (optional)")}><VTextField modelValue={form.value.redirectUrl} onUpdate:modelValue={(v: string) => (form.value.redirectUrl = v)} hideDetails /></FormField>
                    <FormField label={t("Allowed rails")}><VTextField modelValue={form.value.allowedRails} onUpdate:modelValue={(v: string) => (form.value.allowedRails = v)} placeholder={t("Comma separated, empty means all rails.")} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxLinksPage;
