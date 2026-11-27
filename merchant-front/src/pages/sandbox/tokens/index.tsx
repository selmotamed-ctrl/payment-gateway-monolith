import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {PgAlert, PgButton, PgAutocomplete, PgTextField} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {SummaryExportCard} from "@pg/ui";
import type { MetricItem } from "@pg/ui";
import {StateView} from "@pg/ui";
import { SandboxBanner } from "@/features/sandbox/SandboxBanner";
import { SandboxResourceTable } from "@/features/sandbox/SandboxResourceTable";
import { tokenFilters } from "@/features/sandbox/sandboxFilters";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {MonoRef} from "@pg/ui";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {SectionFields} from "@pg/ui";
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
            <PageHeader title={t("Sandbox API Keys & Webhooks")} subtitle={t("pg_test_ tokens reach only the sandbox core; pg_live_ tokens are refused.")} badge="SANDBOX" badgeTone="warning"><div class="d-flex flex-wrap ga-2"><PgButton variant="tonal" prependIcon="mdi-refresh" onClick={() => { refresh.value?.(); void loadSummary(); }}>{t("Refresh")}</PgButton><PgButton variant="tonal" prependIcon="mdi-webhook" loading={busy.value === "webhook"} onClick={() => void testWebhook()}>{t("Send test webhook")}</PgButton><PgButton color="primary" prependIcon="mdi-plus" onClick={() => { formError.value = ""; createOpen.value = true; }}>{t("Create pg_test_ token")}</PgButton></div></PageHeader>
            <SandboxBanner subtitle={t("Point your staging website or mobile app at the Sandbox API with a pg_test_ token.")} />
            {error.value ? <PgAlert tone="danger" class="mb-4">{error.value}</PgAlert> : null}
            {createdToken.value ? <PgAlert tone="warning" class="mb-4"> {t("Copy this token now; it is shown once")}: <code>{createdToken.value}</code></PgAlert> : null}
            <StateView loading={loading.value && !summary.value} minHeight="160px">
                <div class="d-flex flex-column ga-4">
                    <SummaryExportCard title={t("Token health")} metrics={metrics.value} />
                    <SandboxResourceTable<SandboxTokenRow> title={t("Sandbox API tokens")} url="/v1/merchant/sandbox/studio/tokens" listKey="tokens" headers={headers} filters={tokenFilters()} pageSize={20} showNumber={true} onRefreshReady={(next) => (refresh.value = next)} />
                </div>
            </StateView>
            <FormModal modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} title={t("Create sandbox API token")} size="md" loading={busy.value === "create"} errorMessage={formError.value} submitLabel={t("Create")} onSubmit={() => void create()}>
                <SectionFields title={t("Token details")}>
                    <FormField label={t("Token name")} required><PgTextField modelValue={form.value.name} onUpdate:modelValue={(v: string) => (form.value.name = v)} hideDetails /></FormField>
                    <FormField label={t("Application")} required><PgAutocomplete items={applications.value.map((app) => ({ title: app.name, value: app.id }))} modelValue={form.value.applicationId} onUpdate:modelValue={(v: string) => (form.value.applicationId = v)} hideDetails /></FormField>
                    <FormField label={t("Scopes")} required><PgAutocomplete items={SCOPES} multiple chips modelValue={form.value.scopes} onUpdate:modelValue={(v: string[]) => (form.value.scopes = v)} hideDetails /></FormField>
                    <FormField label={t("Expiry")}><PgTextField type="datetime-local" modelValue={form.value.expiresAt} onUpdate:modelValue={(v: string) => (form.value.expiresAt = v)} hideDetails /></FormField>
                    <FormField label={t("IP allowlist")}><PgTextField modelValue={form.value.allowedCidrs} onUpdate:modelValue={(v: string) => (form.value.allowedCidrs = v)} placeholder={t("Comma separated CIDR ranges.")} hideDetails /></FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default SandboxTokensPage;
