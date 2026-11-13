import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { StateView } from "@/components/StateView";
import { SandboxBanner } from "@/components/sandbox/SandboxBanner";
import SandboxResourceTable from "@/components/sandbox/SandboxResourceTable";
import { tokenFilters } from "@/components/sandbox/sandboxFilters";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SectionFields } from "@/components/SectionFields";
import { sandboxGet, sandboxPost, type SandboxSummaryResponse, type SandboxTokenRow } from "@/api/sandbox";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";

const SCOPES = ["link:write", "link:read", "payment:read", "cashout:read", "dispute:read"];

const SandboxTokensPage = dc(() => {
    const { t } = useLocale();
    const summary = ref<Record<string, unknown> | null>(null);
    const applications = ref<Array<{ id: string; name: string }>>([]);
    const refresh = ref<(() => void) | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const busy = ref<string | null>(null);
    const createOpen = ref(false);
    const formError = ref("");
    const createdToken = ref<string | null>(null);
    const form = ref({ name: "Sandbox integration token", scopes: ["link:write", "link:read", "payment:read"] as string[], applicationId: "", expiresAt: "", allowedCidrs: "" });

    const loadSummary = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [data, apps] = await Promise.all([
                sandboxGet<SandboxSummaryResponse>("/studio/tokens/summary"),
                sandboxGet<{ applications: Array<{ id: string; name: string }> }>("/studio/applications", { page: 1, pageSize: 200 }),
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
        return [
            { key: "total", label: t("Test tokens"), value: String(data.total ?? 0) },
            { key: "active", label: t("Active"), value: String(data.active ?? 0), badge: t("Active"), badgeTone: "success" },
            { key: "revoked", label: t("Revoked"), value: String(data.revoked ?? 0), badge: Number(data.revoked ?? 0) ? t("Revoked") : t("Clear"), badgeTone: Number(data.revoked ?? 0) ? "danger" : "success" },
            { key: "expiring", label: t("Expiring in 7 days"), value: String(data.expiring ?? 0), badge: Number(data.expiring ?? 0) ? t("Attention") : t("Clear"), badgeTone: Number(data.expiring ?? 0) ? "warning" : "success" },
        ];
    });

    const create = async () => {
        if (!form.value.name.trim() || !form.value.applicationId || form.value.scopes.length === 0) {
            formError.value = t("Name, application and at least one scope are required");
            return;
        }
        busy.value = "create";
        formError.value = "";
        try {
            const result = await sandboxPost<{ token: string }>("/tokens", {
                name: form.value.name.trim(),
                scopes: form.value.scopes,
                applicationId: form.value.applicationId,
                ...(form.value.expiresAt ? { expiresAt: new Date(form.value.expiresAt).toISOString() } : {}),
                ...(form.value.allowedCidrs.trim() ? { allowedCidrs: form.value.allowedCidrs.split(",").map((entry) => entry.trim()).filter(Boolean) } : {}),
            });
            createdToken.value = result.token ?? null;
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Test token created") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            formError.value = extractApiErrorMessage(e);
        } finally {
            busy.value = null;
        }
    };

    const revoke = async (row: SandboxTokenRow) => {
        busy.value = row.id;
        try {
            await api.delete(urlsMap.tokenDetail(row.id));
            showSnackBar({ type: "success", message: t("Token revoked") });
            refresh.value?.();
            await loadSummary();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const updateIps = async (row: SandboxTokenRow) => {
        busy.value = row.id;
        try {
            await api.put(urlsMap.tokenIps(row.id), { allowedCidrs: row.allowedCidrs });
            showSnackBar({ type: "success", message: t("IP allowlist saved") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const testWebhook = async () => {
        busy.value = "webhook";
        try {
            await sandboxPost("/webhooks/test-ping", { event: "payment.succeeded" });
            showSnackBar({ type: "success", message: t("Test webhook queued") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            busy.value = null;
        }
    };

    const headers: TableHeader<SandboxTokenRow>[] = [
        { key: "name", label: "Token", Value: ({ row }) => <div class="d-flex flex-column"><span class="font-weight-medium">{row.name}</span><span class="pg-mono text-caption">••••{row.lastFour}</span></div> },
        { key: "applicationName", label: "Application", value: (row) => row.applicationName },
        { key: "scopes", label: "Scopes", value: (row) => row.scopes.join(", ") },
        { key: "status", label: "Status", Value: ({ row }) => <StatusBadge status={row.revokedAt ? "REVOKED" : "ACTIVE"} toneOverride={row.revokedAt ? "danger" : "success"} /> },
        { key: "expiresAt", label: "Expiry", value: (row) => row.expiresAt ?? "—" },
        { key: "lastUsedAt", label: "Last used", value: (row) => row.lastUsedAt ?? "—" },
        { key: "ipWhitelistEnabled", label: "IP allowlist", value: (row) => row.allowedCidrs.join(", ") || "—" },
        { key: "createdAt", label: "Created", sortKey: "createdAt", value: (row) => row.createdAt },
        { key: "actions", label: "Actions", Value: ({ row }) => (
            <TableRowActions
                primaryAction={{ label: row.revokedAt ? t("Revoked") : t("Revoke"), icon: "mdi-key-remove", onClick: () => { if (!row.revokedAt) void revoke(row); } }}
                items={[
                    { key: "ips", label: t("Save IP allowlist"), icon: "mdi-shield-key-outline", hidden: Boolean(row.revokedAt), onClick: () => void updateIps(row) },
                    { key: "copy", label: t("Copy token ID"), icon: "mdi-content-copy", onClick: () => { void navigator.clipboard?.writeText(row.id); showSnackBar({ type: "success", message: t("Copied") }); } },
                ]}
            />
        ) },
    ];

    return () => (
        <ScreenContainer>
            <PageHeader title={t("Sandbox API Keys & Webhooks")} subtitle={t("pg_test_ tokens reach only the sandbox core; pg_live_ tokens are refused.")} badge="SANDBOX" badgeTone="warning" end={() => <div class="d-flex flex-wrap ga-2"><VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</VBtn><VBtn variant="tonal" prependIcon="mdi-webhook" loading={busy.value === "webhook"} onClick={() => void testWebhook()}>{t("Send test webhook")}</VBtn><VBtn color="primary" prependIcon="mdi-plus" onClick={() => { formError.value = ""; createOpen.value = true; }}>{t("Create pg_test_ token")}</VBtn></div>} />
            <SandboxBanner subtitle={t("Point your staging website or mobile app at the Sandbox API with a pg_test_ token.")} />
            {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
            {createdToken.value ? <VAlert type="warning" variant="tonal" class="mb-4"> {t("Copy this token now; it is shown once")}: <code>{createdToken.value}</code></VAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="160px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Token health")} metrics={metrics.value} />
                    <SandboxResourceTable<SandboxTokenRow> title={t("Sandbox API tokens")} url="/v1/merchant/sandbox/studio/tokens" listKey="tokens" headers={headers} filters={tokenFilters()} pageSize={20} showNumber={true} onRefreshReady={(next) => (refresh.value = next)} />
                </div>
            </StateView>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create sandbox API token")} size="md" loading={busy.value === "create"} errorMessage={formError.value} submitLabel={t("Create")} onSubmit={() => void create()}>
                <SectionFields title={t("Token details")}>
                    <FormField label={t("Token name")} required><VTextField modelValue={form.value.name} onUpdate:modelValue={(v: string) => (form.value.name = v)} hideDetails /></FormField>
                    <FormField label={t("Application")} required><VSelect items={applications.value.map((app) => ({ title: app.name, value: app.id }))} modelValue={form.value.applicationId} onUpdate:modelValue={(v: string) => (form.value.applicationId = v)} hideDetails /></FormField>
                    <FormField label={t("Scopes")} required><VSelect items={SCOPES} multiple chips modelValue={form.value.scopes} onUpdate:modelValue={(v: string[]) => (form.value.scopes = v)} hideDetails /></FormField>
                    <FormField label={t("Expiry")}><VTextField type="datetime-local" modelValue={form.value.expiresAt} onUpdate:modelValue={(v: string) => (form.value.expiresAt = v)} hideDetails /></FormField>
                    <FormField label={t("IP allowlist")}><VTextField modelValue={form.value.allowedCidrs} onUpdate:modelValue={(v: string) => (form.value.allowedCidrs = v)} placeholder={t("Comma separated CIDR ranges.")} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxTokensPage;
