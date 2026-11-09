import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { SectionFields } from "@/components/SectionFields";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

export type WebhookEndpoint = {
    id: string;
    applicationId: string;
    url: string;
    description: string | null;
    eventTypes: string[];
    status: "ACTIVE" | "DISABLED";
    disabledReason: string | null;
    rotationOverlapActive: boolean;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    createdAt: string;
};

export type WebhookDelivery = {
    id: string;
    endpointId: string;
    eventId: string;
    eventType: string;
    status: "PENDING" | "DELIVERED" | "PARKED";
    attempts: number;
    nextAttemptAt: string | null;
    lastStatusCode: number | null;
    lastError: string | null;
    parkReason: string | null;
    createdAt: string;
};

type ApplicationOption = { id: string; name: string };

/** The portal shows the secret exactly once; this is what it renders for a freshly created or rotated endpoint. */
export const webhookSecretOf = (payload: any): string | null => (typeof payload?.secret === "string" ? payload.secret : null);

const WebhooksPage = dc(() => {
    const { t } = useLocale();
    const canManage = computed(() => hasOneOfAuthorities(["webhooks.manage"]));

    const endpoints = ref<WebhookEndpoint[]>([]);
    const deliveries = ref<WebhookDelivery[]>([]);
    const applications = ref<ApplicationOption[]>([]);
    const eventTypes = ref<string[]>([]);
    const loading = ref(true);
    const deliveriesLoading = ref(false);
    const error = ref<string | null>(null);
    const deliveryFilter = ref<string | null>(null);

    const formOpen = ref(false);
    const editing = ref<WebhookEndpoint | null>(null);
    const form = ref({ applicationId: "", url: "", description: "", eventTypes: [] as string[] });
    const formError = ref("");
    const actionLoading = ref(false);
    const shownSecret = ref<{ endpointUrl: string; secret: string } | null>(null);

    const appName = (id: string) => applications.value.find((app) => app.id === id)?.name ?? id;

    const loadEndpoints = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [list, types, apps] = await Promise.all([
                api.get(urlsMap.webhookEndpoints),
                api.get(urlsMap.webhookEventTypes),
                api.get(urlsMap.applicationsList),
            ]);
            endpoints.value = (list.data?.data ?? list.data)?.endpoints ?? [];
            eventTypes.value = (types.data?.data ?? types.data)?.eventTypes ?? [];
            const appPayload = apps.data?.data ?? apps.data ?? {};
            applications.value = (appPayload.applications ?? appPayload.rows ?? appPayload.items ?? []).map((app: any) => ({ id: app.id, name: app.name }));
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            endpoints.value = [];
        } finally {
            loading.value = false;
        }
    };

    const loadDeliveries = async () => {
        deliveriesLoading.value = true;
        try {
            const response = await api.get(urlsMap.webhookDeliveries, {
                params: { status: deliveryFilter.value || undefined, limit: 50 },
            });
            deliveries.value = (response.data?.data ?? response.data)?.deliveries ?? [];
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
            deliveries.value = [];
        } finally {
            deliveriesLoading.value = false;
        }
    };

    void loadEndpoints();
    void loadDeliveries();

    const openCreate = () => {
        editing.value = null;
        form.value = { applicationId: applications.value[0]?.id ?? "", url: "", description: "", eventTypes: [] };
        formError.value = "";
        formOpen.value = true;
    };

    const openEdit = (row: WebhookEndpoint) => {
        editing.value = row;
        form.value = { applicationId: row.applicationId, url: row.url, description: row.description ?? "", eventTypes: [...row.eventTypes] };
        formError.value = "";
        formOpen.value = true;
    };

    const save = async () => {
        actionLoading.value = true;
        formError.value = "";
        try {
            if (editing.value) {
                await api.patch(urlsMap.webhookEndpoint(editing.value.id), {
                    url: form.value.url,
                    description: form.value.description || null,
                    eventTypes: form.value.eventTypes,
                });
                showSnackBar({ type: "success", message: t("Saved") });
            } else {
                const response = await api.post(urlsMap.webhookEndpoints, {
                    applicationId: form.value.applicationId,
                    url: form.value.url,
                    ...(form.value.description ? { description: form.value.description } : {}),
                    eventTypes: form.value.eventTypes,
                });
                const payload = response.data?.data ?? response.data;
                const secret = webhookSecretOf(payload);
                if (secret) shownSecret.value = { endpointUrl: form.value.url, secret };
                showSnackBar({ type: "success", message: t("Created") });
            }
            formOpen.value = false;
            await loadEndpoints();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const toggle = async (row: WebhookEndpoint) => {
        try {
            await api.patch(urlsMap.webhookEndpoint(row.id), { enabled: row.status !== "ACTIVE" });
            showSnackBar({ type: "success", message: t("Saved") });
            await loadEndpoints();
            await loadDeliveries();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const rotate = async (row: WebhookEndpoint) => {
        try {
            const response = await api.post(urlsMap.webhookRotateSecret(row.id), {});
            const secret = webhookSecretOf(response.data?.data ?? response.data);
            if (secret) shownSecret.value = { endpointUrl: row.url, secret };
            showSnackBar({ type: "success", message: t("Secret rotated. The previous secret keeps working for 24 hours.") });
            await loadEndpoints();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const sendTest = async (row: WebhookEndpoint) => {
        try {
            await api.post(urlsMap.webhookTest(row.id), {});
            showSnackBar({ type: "success", message: t("Test event queued") });
            await loadDeliveries();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const redeliver = async (row: WebhookDelivery) => {
        try {
            await api.post(urlsMap.webhookRedeliver(row.id), {});
            showSnackBar({ type: "success", message: t("Queued for delivery") });
            await loadDeliveries();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const endpointHeaders: TableHeader<WebhookEndpoint>[] = [
        { key: "url", label: "Endpoint URL", Value: ({ row }: { row: WebhookEndpoint }) => <MonoRef value={row.url} truncate={48} /> },
        { key: "applicationId", label: "Application", value: (row) => appName(row.applicationId) },
        { key: "eventTypes", label: "Events", value: (row) => (row.eventTypes.length ? row.eventTypes.join(", ") : t("All events")) },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: WebhookEndpoint }) => (
                <StatusBadge status={row.status} label={row.status === "ACTIVE" ? t("Active") : t("Disabled")} toneOverride={row.status === "ACTIVE" ? "success" : "neutral"} />
            ),
        },
        { key: "lastSuccessAt", label: "Last Success", value: (row) => row.lastSuccessAt ?? t("Never") },
        { key: "lastFailureAt", label: "Last Failure", value: (row) => row.lastFailureAt ?? t("Never") },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: WebhookEndpoint }) =>
                canManage.value ? (
                    <TableRowActions
                        primaryAction={{ label: t("Send Test Event"), icon: "mdi-send-outline", disabled: row.status !== "ACTIVE", onClick: () => void sendTest(row) }}
                        items={[
                            { key: "edit", label: t("Edit"), icon: "mdi-pencil-outline", onClick: () => openEdit(row) },
                            { key: "rotate", label: t("Rotate Secret"), icon: "mdi-key-change", onClick: () => void rotate(row) },
                            {
                                key: "toggle",
                                label: row.status === "ACTIVE" ? t("Disable") : t("Enable"),
                                icon: row.status === "ACTIVE" ? "mdi-pause-circle-outline" : "mdi-play-circle-outline",
                                danger: row.status === "ACTIVE",
                                dividerBefore: true,
                                onClick: () => void toggle(row),
                            },
                        ]}
                    />
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                ),
        },
    ];

    const deliveryTone = (status: WebhookDelivery["status"]) => (status === "DELIVERED" ? "success" : status === "PARKED" ? "danger" : "warning");
    const deliveryLabel = (status: WebhookDelivery["status"]) => (status === "DELIVERED" ? t("Delivered") : status === "PARKED" ? t("Parked") : t("Pending"));

    const deliveryHeaders: TableHeader<WebhookDelivery>[] = [
        { key: "eventType", label: "Event", value: (row) => row.eventType },
        { key: "eventId", label: "Event ID", Value: ({ row }: { row: WebhookDelivery }) => <MonoRef value={row.eventId} truncate={20} /> },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: WebhookDelivery }) => <StatusBadge status={row.status} label={deliveryLabel(row.status)} toneOverride={deliveryTone(row.status)} />,
        },
        { key: "attempts", label: "Attempts", value: (row) => String(row.attempts) },
        { key: "lastStatusCode", label: "Response", value: (row) => (row.lastStatusCode ? String(row.lastStatusCode) : (row.lastError ?? "—")) },
        { key: "nextAttemptAt", label: "Next Attempt", value: (row) => row.nextAttemptAt ?? "—" },
        { key: "createdAt", label: "Created", value: (row) => row.createdAt },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: WebhookDelivery }) =>
                canManage.value && row.status !== "PENDING" ? (
                    <TableRowActions primaryAction={{ label: t("Redeliver"), icon: "mdi-reload", onClick: () => void redeliver(row) }} items={[]} />
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Webhooks")}
                    subtitle={t("Receive signed notifications when payments, disputes and cash-outs change.")}
                    end={() =>
                        canManage.value ? (
                            <VBtn variant="tonal" onClick={openCreate} disabled={applications.value.length === 0}>
                                {t("Add Endpoint")}
                            </VBtn>
                        ) : null
                    }
                />

                {shownSecret.value && (
                    <SurfaceCard title={t("Signing Secret")}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <MonoRef value={shownSecret.value.secret} onCopied={() => showSnackBar({ type: "success", message: t("Copied") })} />
                            <p style={{ fontSize: "12px", color: "var(--pg-ink-muted)", margin: 0 }}>
                                {t("This secret is shown once. Store it securely.")}
                            </p>
                            <VBtn variant="text" size="small" onClick={() => (shownSecret.value = null)}>
                                {t("Close")}
                            </VBtn>
                        </div>
                    </SurfaceCard>
                )}

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void loadEndpoints()} />
                ) : (
                    <DataTable title={t("Webhooks")} data={endpoints.value} headers={endpointHeaders} loading={loading.value} showNumber={true} xlsx={false} noElevation={true} />
                )}

                <PageHeader
                    title={t("Deliveries")}
                    subtitle={t("The latest deliveries. A parked delivery failed every attempt and can be redelivered.")}
                    end={() => (
                        <VSelect
                            modelValue={deliveryFilter.value}
                            onUpdate:modelValue={(value: string | null) => {
                                deliveryFilter.value = value;
                                void loadDeliveries();
                            }}
                            items={[
                                { title: t("All"), value: null },
                                { title: t("Pending"), value: "PENDING" },
                                { title: t("Delivered"), value: "DELIVERED" },
                                { title: t("Parked"), value: "PARKED" },
                            ]}
                            density="compact"
                            hideDetails
                            style={{ minWidth: "160px" }}
                        />
                    )}
                />
                <DataTable title={t("Deliveries")} data={deliveries.value} headers={deliveryHeaders} loading={deliveriesLoading.value} showNumber={true} xlsx={false} noElevation={true} />
            </ThemedView>

            <FormModal
                modelValue={formOpen.value}
                onUpdate:modelValue={(v: any) => (formOpen.value = v)}
                title={editing.value ? t("Edit Endpoint") : t("Add Endpoint")}
                size="md"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Save")}
                onSubmit={() => void save()}
            >
                <SectionFields title={t("Details")}>
                    {!editing.value && (
                        <FormField label={t("Application")} required>
                            <VSelect
                                modelValue={form.value.applicationId}
                                onUpdate:modelValue={(v: string) => (form.value.applicationId = v)}
                                items={applications.value.map((app) => ({ title: app.name, value: app.id }))}
                                hideDetails
                            />
                        </FormField>
                    )}
                    <FormField label={t("Endpoint URL")} required hint={t("HTTPS only. Redirects are not followed.")}>
                        <VTextField modelValue={form.value.url} onUpdate:modelValue={(v: string) => (form.value.url = v)} placeholder="https://" hideDetails />
                    </FormField>
                    <FormField label={t("Events")} hint={t("Leave empty to receive every event.")}>
                        <VSelect
                            modelValue={form.value.eventTypes}
                            onUpdate:modelValue={(v: string[]) => (form.value.eventTypes = v)}
                            items={eventTypes.value}
                            multiple
                            chips
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Description")}>
                        <VTextField modelValue={form.value.description} onUpdate:modelValue={(v: string) => (form.value.description = v)} hideDetails />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default WebhooksPage;
