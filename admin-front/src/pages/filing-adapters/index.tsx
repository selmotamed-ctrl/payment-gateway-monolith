import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { showConfirm } from "@/utils/confirm";

type Adapter = {
    id: string;
    name: string;
    authority: string;
    kind: string;
    status: string;
    endpointUrl: string | null;
    authHeaderName: string | null;
    hasSecret: boolean;
    timeoutSeconds: number;
    lastUsedAt: string | null;
};

const emptyForm = () => ({ name: "", authority: "CBL", kind: "HTTP", status: "ACTIVE", endpointUrl: "", authHeaderName: "X-Api-Key", authSecret: "", timeoutSeconds: 30 });

const FilingAdaptersPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Adapter[]>([]);
    const formOpen = ref(false);
    const saving = ref(false);
    const formError = ref("");
    const editingId = ref<string | null>(null);
    const refreshHook = ref<{ refreshAsIs: () => void } | null>(null);
    const form = ref(emptyForm());
    const headers = computed<TableHeader<Adapter>[]>(() => [
        {
            key: "name",
            label: "Name",
            value: (row) => row.name,
            Value: ({ row }: { row: Adapter }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.name}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.authority} · {row.kind}</ThemedText>
                </ThemedView>
            ),
        },
        { key: "kind", label: "Kind", value: (row) => row.kind },
        { key: "status", label: "Status", value: (row) => row.status, Value: ({ row }: { row: Adapter }) => <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "neutral"} /> },
        {
            key: "endpoint",
            label: "Endpoint",
            value: (row) => row.endpointUrl ?? "",
            Value: ({ row }: { row: Adapter }) => <ThemedText style={{ fontSize: "11px", maxWidth: "360px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.endpointUrl ?? ""}>{row.endpointUrl ?? "—"}</ThemedText>,
        },
        { key: "secret", label: "Secret", value: (row) => row.hasSecret ? t("Stored") : t("None"), Value: ({ row }: { row: Adapter }) => <StatusBadge status={row.hasSecret ? t("Stored") : t("None")} toneOverride={row.hasSecret ? "success" : "warning"} /> },
        { key: "lastUsed", label: "Last used", value: (row) => row.lastUsedAt ?? "", Value: ({ row }: { row: Adapter }) => <ThemedText style={{ fontSize: "11px" }}>{row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : "—"}</ThemedText> },
        {
            key: "actions",
            label: "Edit",
            sortable: false,
            Value: ({ row }: { row: Adapter }) => (
                <TableRowActions
                    primaryAction={{ label: t("Edit"), icon: "mdi-pencil-outline", onClick: () => openEdit(row) }}
                    items={[
                        ...(row.status === "DISABLED" ? [{ key: "enable", label: t("Request re-enable"), icon: "mdi-play-circle-outline", onClick: () => void setStatus(row, "ACTIVE") }] : []),
                        ...(row.status === "ACTIVE" ? [{ key: "disable", label: t("Request disable"), icon: "mdi-pause-circle-outline", danger: true, onClick: () => void disable(row) }] : []),
                    ]}
                />
            ),
        },
    ]);
    const openCreate = () => {
        editingId.value = null;
        form.value = emptyForm();
        formError.value = "";
        formOpen.value = true;
    };
    const openEdit = (adapter: Adapter) => {
        editingId.value = adapter.id;
        form.value = {
            name: adapter.name,
            authority: adapter.authority,
            kind: adapter.kind,
            status: adapter.status,
            endpointUrl: adapter.endpointUrl ?? "",
            authHeaderName: adapter.authHeaderName ?? "",
            authSecret: "",
            timeoutSeconds: adapter.timeoutSeconds,
        };
        formError.value = "";
        formOpen.value = true;
    };
    const save = async () => {
        saving.value = true;
        formError.value = "";
        try {
            const payload = {
                name: form.value.name,
                authority: form.value.authority,
                kind: form.value.kind,
                status: form.value.status,
                endpointUrl: form.value.kind === "HTTP" ? form.value.endpointUrl : null,
                authHeaderName: form.value.authHeaderName || null,
                ...(form.value.authSecret ? { authSecret: form.value.authSecret } : {}),
                timeoutSeconds: form.value.timeoutSeconds,
            };
            if (editingId.value) {
                await api.patch(urlsMap.filingAdapter(editingId.value), payload);
            } else {
                await api.post(urlsMap.filingAdapters, payload);
            }
            formOpen.value = false;
            showSnackBar({ type: "success", message: t("Filing adapter change submitted for approval") });
            refreshHook.value?.refreshAsIs();
        } catch (error) {
            formError.value = extractApiErrorMessage(error);
        } finally {
            saving.value = false;
        }
    };
    const setStatus = async (adapter: Adapter, status: string) => {
        try {
            await api.patch(urlsMap.filingAdapter(adapter.id), { status });
            showSnackBar({ type: "success", message: t("Filing adapter change submitted for approval") });
            refreshHook.value?.refreshAsIs();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        }
    };
    const disable = async (adapter: Adapter) => {
        if (!(await showConfirm({ title: t("Disable filing adapter"), message: t("Disabling the adapter stops new filings through it. A second person must approve the change."), type: "error" }))) return;
        try {
            await api.delete(urlsMap.filingAdapter(adapter.id));
            showSnackBar({ type: "success", message: t("Filing adapter change submitted for approval") });
            refreshHook.value?.refreshAsIs();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        }
    };
    return () => (
        <ScreenContainer>
            <PageHeader
                title={t("Filing Adapters")}
                subtitle={t("Configure the manual or HTTPS channel used to file an approved regulatory report")}
                badge="AML-CONFIDENTIAL"
                badgeTone="danger"
                end={() => (
                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                        <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={() => refreshHook.value?.refreshAsIs()}>{t("Refresh")}</VBtn>
                        <VBtn color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("New adapter")}</VBtn>
                    </ThemedView>
                )}
            />
            <ApiTable<Adapter>
                title={t("Filing adapter registry")}
                url={urlsMap.filingAdapters}
                showNumber={false}
                numberOfItemsPerPage={100}
                numberOfItemsPerPageChoices={false}
                headers={headers.value}
                apiDataExtractor={(data) => (data as { adapters?: Adapter[] }).adapters ?? []}
                apiTotalExtractor={(data) => Number((data as { adapters?: Adapter[] }).adapters?.length ?? 0)}
                onData={(nextRows) => (rows.value = nextRows)}
                setRefreshHook={(hook) => (refreshHook.value = hook)}
                clearRefreshHook={() => (refreshHook.value = null)}
                onRefresh={(_table, refresh) => void refresh({ queryParams: {} })}
                TopSlot={({ loading }) => <ThemedView>{!loading && rows.value.length === 0 ? <EmptyState title={t("No filing adapters")} description={t("Manual filing remains the default. Add an HTTPS adapter only when a filing API exists.")} /> : null}</ThemedView>}
            />
            <FormModal modelValue={formOpen.value} onUpdate:modelValue={(value: boolean) => (formOpen.value = value)} title={editingId.value ? t("Edit filing adapter") : t("New filing adapter")} size="lg" loading={saving.value} submitLabel={t("Submit for approval")} onSubmit={() => void save()}>
                <VAlert type="info" variant="tonal" class="mb-4">{t("Endpoint and secret changes use maker-checker. The adapter becomes active only after a second person approves the change.")}</VAlert>
                {formError.value && <VAlert type="error" variant="tonal" class="mb-4">{formError.value}</VAlert>}
                <FormField label={t("Name")} required><VTextField modelValue={form.value.name} onUpdate:modelValue={(value: string) => (form.value.name = value)} hideDetails /></FormField>
                <FormField label={t("Authority")} required><VTextField modelValue={form.value.authority} onUpdate:modelValue={(value: string) => (form.value.authority = value)} hideDetails /></FormField>
                <FormField label={t("Kind")} required><VSelect items={["MANUAL", "HTTP"].map((value) => ({ title: value, value }))} modelValue={form.value.kind} onUpdate:modelValue={(value: string) => (form.value.kind = value)} hideDetails /></FormField>
                <FormField label={t("Status")} required><VSelect items={["ACTIVE", "DISABLED"].map((value) => ({ title: value, value }))} modelValue={form.value.status} onUpdate:modelValue={(value: string) => (form.value.status = value)} hideDetails /></FormField>
                {form.value.kind === "HTTP" && <FormField label={t("HTTPS endpoint")} required><VTextField modelValue={form.value.endpointUrl} onUpdate:modelValue={(value: string) => (form.value.endpointUrl = value)} hideDetails /></FormField>}
                {form.value.kind === "HTTP" && <FormField label={t("Auth header")}><VTextField modelValue={form.value.authHeaderName} onUpdate:modelValue={(value: string) => (form.value.authHeaderName = value)} hideDetails /></FormField>}
                {form.value.kind === "HTTP" && <FormField label={t("Auth secret")}><VTextField type="password" autocomplete="new-password" modelValue={form.value.authSecret} onUpdate:modelValue={(value: string) => (form.value.authSecret = value)} placeholder={editingId.value ? t("Leave blank to keep the existing secret") : ""} hideDetails /></FormField>}
                <FormField label={t("Timeout seconds")}><VTextField type="number" modelValue={form.value.timeoutSeconds} onUpdate:modelValue={(value: string) => (form.value.timeoutSeconds = Number(value) || 30)} hideDetails /></FormField>
            </FormModal>
        </ScreenContainer>
    );
});
export default FilingAdaptersPage;
