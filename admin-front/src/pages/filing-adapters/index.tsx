import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useRouter } from "vue-router";
import {VAlert, PgButton, PgAutocomplete, PgTextField} from "@pg/ui";
import { areChecklistsVisible } from "@/constants/env";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {SurfaceCard, SurfaceCardText} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {EmptyState} from "@pg/ui";
import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {ApiTable} from "@pg/ui";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

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
    pendingApprovalId: string | null;
};

const CHANGE_CHECKS = [
    { key: "ADAPTER_SCOPE_VERIFIED", label: "Adapter scope and authority verified" },
    { key: "ENDPOINT_VERIFIED", label: "HTTPS endpoint verified" },
    { key: "SECRET_HANDLING_CONFIRMED", label: "Secret handling confirmed" },
    { key: "APPROVAL_PATH_CONFIRMED", label: "Maker-checker approval path confirmed" },
] as const;

const STATUS_CHECKS = [
    { key: "REPORTING_CHANNEL_VERIFIED", label: "Reporting channel impact verified" },
    { key: "DISABLE_IMPACT_ACKNOWLEDGED", label: "Activation/disable impact acknowledged" },
    { key: "APPROVAL_PATH_CONFIRMED", label: "Maker-checker approval path confirmed" },
] as const;

const emptyForm = () => ({ name: "", authority: "CBL", kind: "HTTP", status: "ACTIVE", endpointUrl: "", authHeaderName: "X-Api-Key", authSecret: "", timeoutSeconds: 30 });

const FilingAdaptersPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<Adapter[]>([]);
    const formOpen = ref(false);
    const saving = ref(false);
    const formError = ref("");
    const editingId = ref<string | null>(null);
    const refreshHook = ref<{ refreshAsIs: () => void } | null>(null);
    const form = ref(emptyForm());
    const showChecklists = areChecklistsVisible();
    const changeChecklist = ref<Record<string, boolean>>({});
    const changeChecklistComplete = computed(() => !showChecklists || CHANGE_CHECKS.every((check) => changeChecklist.value[check.key] === true));
    const statusTarget = ref<Adapter | null>(null);
    const statusNext = ref<"ACTIVE" | "DISABLED">("DISABLED");
    const statusChecklist = ref<Record<string, boolean>>({});
    const statusChecklistComplete = computed(() => !showChecklists || STATUS_CHECKS.every((check) => statusChecklist.value[check.key] === true));
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
                        ...(row.pendingApprovalId ? [{ key: "approval", label: t("View pending approval"), icon: "mdi-open-in-new", onClick: () => void router.push({ name: "Approvals", query: { open: row.pendingApprovalId! } }) }] : []),
                        ...(row.status === "DISABLED" ? [{ key: "enable", label: t("Request re-enable"), icon: "mdi-play-circle-outline", onClick: () => openStatus(row, "ACTIVE") }] : []),
                        ...(row.status === "ACTIVE" ? [{ key: "disable", label: t("Request disable"), icon: "mdi-pause-circle-outline", danger: true, onClick: () => openStatus(row, "DISABLED") }] : []),
                    ]}
                />
            ),
        },
    ]);
    const openCreate = () => {
        editingId.value = null;
        form.value = emptyForm();
        formError.value = "";
        changeChecklist.value = {};
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
        changeChecklist.value = {};
        formOpen.value = true;
    };
    const save = async () => {
        if (!changeChecklistComplete.value) {
            formError.value = t("Complete all adapter change checklist items before submitting");
            return;
        }
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
                checklist: CHANGE_CHECKS.filter((check) => changeChecklist.value[check.key]).map((check) => check.key),
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
    const openStatus = (adapter: Adapter, status: "ACTIVE" | "DISABLED") => {
        statusTarget.value = adapter;
        statusNext.value = status;
        statusChecklist.value = {};
    };
    const setStatus = async () => {
        const adapter = statusTarget.value;
        if (!adapter) return;
        if (!statusChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all status checklist items before submitting") });
            return;
        }
        try {
            await api.patch(urlsMap.filingAdapter(adapter.id), {
                status: statusNext.value,
                checklist: STATUS_CHECKS.filter((check) => statusChecklist.value[check.key]).map((check) => check.key),
            });
            statusTarget.value = null;
            showSnackBar({ type: "success", message: t("Filing adapter change submitted for approval") });
            refreshHook.value?.refreshAsIs();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        }
    };
    return () => (
        <ScreenContainer>
            <PageHeader title={t("Filing Adapters")} subtitle={t("Configure the manual or HTTPS channel used to file an approved regulatory report")} badge="AML-CONFIDENTIAL" badgeTone="danger">(
                    <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                        <PgButton variant="tonal" prependIcon="mdi-refresh" onClick={() => refreshHook.value?.refreshAsIs()}>{t("Refresh")}</PgButton>
                        <PgButton color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("New adapter")}</PgButton>
                    </ThemedView>
                )</PageHeader>
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
                <FormField label={t("Name")} required><PgTextField modelValue={form.value.name} onUpdate:modelValue={(value: string) => (form.value.name = value)} hideDetails /></FormField>
                <FormField label={t("Authority")} required><PgTextField modelValue={form.value.authority} onUpdate:modelValue={(value: string) => (form.value.authority = value)} hideDetails /></FormField>
                <FormField label={t("Kind")} required><PgAutocomplete items={["MANUAL", "HTTP"].map((value) => ({ title: value, value }))} modelValue={form.value.kind} onUpdate:modelValue={(value: string) => (form.value.kind = value)} hideDetails /></FormField>
                <FormField label={t("Status")} required><PgAutocomplete items={["ACTIVE", "DISABLED"].map((value) => ({ title: value, value }))} modelValue={form.value.status} onUpdate:modelValue={(value: string) => (form.value.status = value)} hideDetails /></FormField>
                {form.value.kind === "HTTP" && <FormField label={t("HTTPS endpoint")} required><PgTextField modelValue={form.value.endpointUrl} onUpdate:modelValue={(value: string) => (form.value.endpointUrl = value)} hideDetails /></FormField>}
                {form.value.kind === "HTTP" && <FormField label={t("Auth header")}><PgTextField modelValue={form.value.authHeaderName} onUpdate:modelValue={(value: string) => (form.value.authHeaderName = value)} hideDetails /></FormField>}
                {form.value.kind === "HTTP" && <FormField label={t("Auth secret")}><PgTextField type="password" autocomplete="new-password" modelValue={form.value.authSecret} onUpdate:modelValue={(value: string) => (form.value.authSecret = value)} placeholder={editingId.value ? t("Leave blank to keep the existing secret") : ""} hideDetails /></FormField>}
                <FormField label={t("Timeout seconds")}><PgTextField type="number" modelValue={form.value.timeoutSeconds} onUpdate:modelValue={(value: string) => (form.value.timeoutSeconds = Number(value) || 30)} hideDetails /></FormField>
                <FormChecklist
                    checks={[...CHANGE_CHECKS]}
                    modelValue={changeChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (changeChecklist.value = value)}
                    show={showChecklists}
                    title={t("Adapter change checklist")}
                    complete={changeChecklistComplete.value}
                    incompleteMessage={t("Complete all adapter change checklist items before submitting")}
                />
            </FormModal>
            <FormModal modelValue={statusTarget.value !== null} onUpdate:modelValue={(value: boolean) => { if (!value) statusTarget.value = null; }} title={statusNext.value === "DISABLED" ? t("Disable filing adapter") : t("Re-enable filing adapter")} subtitle={statusTarget.value?.name ?? ""} size="md" loading={saving.value} submitLabel={t("Submit for approval")} onSubmit={() => void setStatus()}>
                <VAlert type={statusNext.value === "DISABLED" ? "warning" : "info"} variant="tonal">
                    {statusNext.value === "DISABLED" ? t("Disabling the adapter stops new filings through it. A second person must approve the change.") : t("Re-enabling restores this filing channel after approval. A second person must approve the change.")}
                </VAlert>
                <FormChecklist
                    checks={[...STATUS_CHECKS]}
                    modelValue={statusChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (statusChecklist.value = value)}
                    show={showChecklists}
                    title={t("Status change checklist")}
                    complete={statusChecklistComplete.value}
                    incompleteMessage={t("Complete all status checklist items before submitting")}
                />
            </FormModal>
        </ScreenContainer>
    );
});
export default FilingAdaptersPage;
