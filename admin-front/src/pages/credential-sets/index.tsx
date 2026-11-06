import { dc } from "kt-dc";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VAlert, VAutocomplete, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusBadge, formatHumanStatus } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions, type RowActionItem } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import { createOptionsLoader } from "@/components/Table/referenceOptions";
import type { TableHeader } from "@/components/Table/types";
import { errorCodeOf, formatDate, formatDateTime } from "@/components/ledger/format";
import ReasonModal from "@/pages/merchants/components/ReasonModal";
import EntriesEditor from "./components/EntriesEditor";
import {
    ENV_VALUES,
    OWNER_TYPES,
    SETTLEMENT_TARGETS,
    availableActions,
    credentialStatusTone,
    defaultSettlementFor,
    draftsFromDetail,
    emptyCreateDraft,
    expiryState,
    highlightIdFromQuery,
    newEntry,
    toCreatePayload,
    toEntriesPayload,
    validateCreateDraft,
    validateEntries,
    type CreateDraft,
    type CreateError,
    type CredentialAction,
    type EntryDraft,
} from "./model";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { hasOneOfAuthorities } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type CredentialRow = {
    id: string;
    gatewayCode: string | null;
    env: string;
    ownerType: string;
    ownerMerchantId: string | null;
    externalMerchantId: string | null;
    settlementTarget: string;
    status: string;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
};

type CredentialDetail = CredentialRow & {
    entries: { key: string; type: string; isSecret: boolean; value: string }[];
};

type TableHook = {
    reset: () => void;
    refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
    refreshAsIs: () => void;
};

type OptionItem = { title: string; value: string };

const CREATE_ERROR_TEXT: Record<CreateError, string> = {
    GATEWAY_REQUIRED: "Choose the gateway",
    OWNER_MERCHANT_REQUIRED: "Choose the owning merchant",
    EXTERNAL_ID_LENGTH: "The external merchant ID must be 2 to 120 characters",
};

const ENV_ITEMS: string[] = [...ENV_VALUES];
const OWNER_ITEMS: string[] = [...OWNER_TYPES];
const SETTLEMENT_ITEMS: string[] = [...SETTLEMENT_TARGETS];

const merchantsLoader = createOptionsLoader("merchants");

const CredentialSetsPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const canWrite = computed(() => hasOneOfAuthorities(["credential:write", "gateway:write"]));

    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const total = ref(0);
    const pageSize = ref(25);
    const hook = ref<TableHook | null>(null);
    const filterDefs = computed(() => tableRegistry.CredentialSets?.filters ?? []);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const highlightId = ref<string | null>(highlightIdFromQuery(route.query.highlight));

    // ---- detail drawer
    const selectedId = ref<string | null>(highlightId.value);
    const detail = ref<CredentialDetail | null>(null);
    const detailLoading = ref(false);
    const detailError = ref<string | null>(null);
    let detailSeq = 0;

    // ---- reference data for the create form
    const gatewayItems = ref<OptionItem[]>([]);
    const merchantItems = ref<OptionItem[]>([]);

    // ---- create
    const createOpen = ref(false);
    const createDraft = ref<CreateDraft>(emptyCreateDraft());
    const createEntries = ref<EntryDraft[]>([]);
    const createShowErrors = ref(false);
    const createLoading = ref(false);
    const createError = ref("");

    // ---- rotate
    const rotateTarget = ref<CredentialRow | null>(null);
    const rotateEntries = ref<EntryDraft[]>([]);
    const rotateShowErrors = ref(false);
    const rotateLoading = ref(false);
    const rotateError = ref("");

    // ---- revoke / verify
    const revokeTarget = ref<CredentialRow | null>(null);
    const revokeLoading = ref(false);
    const revokeError = ref("");
    const verifyingId = ref<string | null>(null);

    const refreshTable = () => hook.value?.refreshAsIs();

    const loadDetail = async (id: string) => {
        const seq = ++detailSeq;
        detailLoading.value = true;
        detailError.value = null;
        try {
            const response = await api.get(urlsMap.credentialSetDetail(id));
            if (seq !== detailSeq) return null;
            detail.value = (response.data?.data ?? response.data) as CredentialDetail;
            return detail.value;
        } catch (cause) {
            if (seq !== detailSeq) return null;
            detail.value = null;
            detailError.value = extractApiErrorMessage(cause);
            return null;
        } finally {
            if (seq === detailSeq) detailLoading.value = false;
        }
    };

    watch(
        selectedId,
        (id) => {
            if (id) {
                void loadDetail(id);
            } else {
                detailSeq += 1;
                detail.value = null;
                detailError.value = null;
            }
        },
        { immediate: true },
    );

    watch(
        () => route.query.highlight,
        (value) => {
            const next = highlightIdFromQuery(value);
            highlightId.value = next;
            if (next) selectedId.value = next;
        },
    );

    const closeDrawer = () => {
        selectedId.value = null;
        if ("highlight" in route.query) {
            const nextQuery = { ...route.query };
            delete nextQuery.highlight;
            void router.replace({ query: nextQuery });
        }
    };

    const loadGateways = async () => {
        if (gatewayItems.value.length > 0) return;
        try {
            const response = await api.get(urlsMap.gatewaysList, { params: { pageSize: 100 } });
            const payload = (response.data?.data ?? response.data ?? {}) as { gateways?: { code: string; name: string }[] };
            gatewayItems.value = (payload.gateways ?? []).map((gateway) => ({ title: `${gateway.name} (${gateway.code})`, value: gateway.code }));
        } catch {
            gatewayItems.value = [];
        }
    };

    const searchMerchants = async (text: string) => {
        try {
            merchantItems.value = (await merchantsLoader(text)).map((option) => ({ title: String(option.title), value: String(option.value) }));
        } catch {
            merchantItems.value = [];
        }
    };

    onMounted(() => {
        void searchMerchants("");
    });

    // ---- table
    const onFilterChange = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => hook.value?.reset(), 300);
    };

    // ---- create
    const openCreate = () => {
        createDraft.value = emptyCreateDraft();
        createEntries.value = [newEntry({ key: "apiKey", type: "HEADER", isSecret: true })];
        createShowErrors.value = false;
        createError.value = "";
        createOpen.value = true;
        void loadGateways();
    };

    const createValidation = computed(() => validateEntries(createEntries.value));
    const createDraftErrors = computed(() => validateCreateDraft(createDraft.value));

    const submitCreate = async () => {
        createShowErrors.value = true;
        if (createDraftErrors.value.length > 0 || !createValidation.value.ok) return;
        createLoading.value = true;
        createError.value = "";
        try {
            const response = await api.post(urlsMap.credentialSetsList, toCreatePayload(createDraft.value, createEntries.value));
            const created = (response.data?.data ?? response.data) as { id?: string };
            createOpen.value = false;
            // Drop the typed secrets from memory as soon as they were sent.
            createEntries.value = [];
            showSnackBar({ type: "success", message: t("Credential set created. Verify it before it is trusted.") });
            refreshTable();
            if (created?.id) selectedId.value = created.id;
        } catch (cause) {
            createError.value = extractApiErrorMessage(cause);
        } finally {
            createLoading.value = false;
        }
    };

    // ---- rotate
    const openRotate = async (row: CredentialRow) => {
        rotateError.value = "";
        rotateShowErrors.value = false;
        rotateEntries.value = [];
        rotateTarget.value = row;
        const loaded = detail.value?.id === row.id ? detail.value : await loadDetailFor(row.id);
        if (rotateTarget.value?.id !== row.id) return;
        rotateEntries.value = loaded ? draftsFromDetail(loaded.entries) : [newEntry()];
    };

    const loadDetailFor = async (id: string): Promise<CredentialDetail | null> => {
        try {
            const response = await api.get(urlsMap.credentialSetDetail(id));
            return (response.data?.data ?? response.data) as CredentialDetail;
        } catch (cause) {
            rotateError.value = extractApiErrorMessage(cause);
            return null;
        }
    };

    const rotateValidation = computed(() => validateEntries(rotateEntries.value));

    const submitRotate = async () => {
        const target = rotateTarget.value;
        if (!target) return;
        rotateShowErrors.value = true;
        if (!rotateValidation.value.ok) return;
        rotateLoading.value = true;
        rotateError.value = "";
        try {
            await api.put(urlsMap.credentialSetDetail(target.id), { entries: toEntriesPayload(rotateEntries.value) });
            rotateTarget.value = null;
            rotateEntries.value = [];
            showSnackBar({ type: "success", message: t("Credential set rotated. It is untested until you verify it.") });
            refreshTable();
            if (selectedId.value === target.id) void loadDetail(target.id);
        } catch (cause) {
            rotateError.value = extractApiErrorMessage(cause);
        } finally {
            rotateLoading.value = false;
        }
    };

    // ---- verify
    const verify = async (row: CredentialRow) => {
        verifyingId.value = row.id;
        try {
            await api.post(urlsMap.credentialSetVerify(row.id), {});
            showSnackBar({ type: "success", message: t("Credential set verified") });
        } catch (cause) {
            const message = errorCodeOf(cause) === "CREDENTIAL_VERIFICATION_FAILED" ? `${t("Verification failed")}: ${extractApiErrorMessage(cause)}` : extractApiErrorMessage(cause);
            showSnackBar({ type: "error", message });
        } finally {
            verifyingId.value = null;
            refreshTable();
            if (selectedId.value === row.id) void loadDetail(row.id);
        }
    };

    // ---- revoke
    const submitRevoke = async (reason: string) => {
        const target = revokeTarget.value;
        if (!target) return;
        revokeLoading.value = true;
        revokeError.value = "";
        try {
            await api.post(urlsMap.credentialSetRevoke(target.id), { reason });
            revokeTarget.value = null;
            showSnackBar({ type: "success", message: t("Credential set revoked") });
            refreshTable();
            if (selectedId.value === target.id) void loadDetail(target.id);
        } catch (cause) {
            revokeError.value = extractApiErrorMessage(cause);
        } finally {
            revokeLoading.value = false;
        }
    };

    const runAction = (action: CredentialAction, row: CredentialRow) => {
        if (action === "verify") void verify(row);
        else if (action === "rotate") void openRotate(row);
        else {
            revokeError.value = "";
            revokeTarget.value = row;
        }
    };

    const actionLabel = (action: CredentialAction): string => (action === "verify" ? t("Verify") : action === "rotate" ? t("Rotate secrets") : t("Revoke"));
    const actionIcon = (action: CredentialAction): string => (action === "verify" ? "mdi-shield-check-outline" : action === "rotate" ? "mdi-key-change" : "mdi-cancel");

    const rowActionItems = (row: CredentialRow): RowActionItem[] =>
        availableActions(row.status, canWrite.value).map((action) => ({
            key: action,
            label: actionLabel(action),
            icon: actionIcon(action),
            danger: action === "revoke",
            dividerBefore: action === "revoke",
            disabled: verifyingId.value === row.id,
            onClick: () => runAction(action, row),
        }));

    const expiryCell = (value: string | null) => {
        const state = expiryState(value);
        if (state === "none") return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                <ThemedText style={{ fontSize: "11px" }}>{formatDate(value)}</ThemedText>
                {state === "expired" && <StatusBadge status="EXPIRED" label={t("Expired")} toneOverride="danger" showDot={false} />}
                {state === "soon" && <StatusBadge status="EXPIRING" label={t("Expires soon")} toneOverride="warning" showDot={false} />}
            </div>
        );
    };

    const headers = computed<TableHeader<CredentialRow>[]>(() => [
        {
            key: "gatewayCode",
            label: "Gateway",
            sortKey: "gatewayCode",
            value: (row) => row.gatewayCode ?? "",
            Value: ({ row }) => <ThemedText style={{ fontWeight: 600 }}>{row.gatewayCode ?? "—"}</ThemedText>,
        },
        { key: "env", label: "Environment", sortKey: "env", value: (row) => row.env, Value: ({ row }) => <StatusBadge status={row.env} label={formatHumanStatus(row.env)} showDot={false} toneOverride={row.env === "LIVE" ? "danger" : "info"} /> },
        {
            key: "owner",
            label: "Owner",
            value: (row) => row.ownerType,
            Value: ({ row }) => (
                <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                    <span style={{ fontSize: "12px" }}>{formatHumanStatus(row.ownerType)}</span>
                    {row.ownerMerchantId ? <MonoRef value={row.ownerMerchantId} truncate={12} /> : null}
                </div>
            ),
        },
        {
            key: "externalMerchantId",
            label: "External merchant ID",
            value: (row) => row.externalMerchantId ?? "",
            Value: ({ row }) => (row.externalMerchantId ? <MonoRef value={row.externalMerchantId} truncate={18} /> : <span style={{ color: "var(--pg-ink-faint)" }}>—</span>),
        },
        { key: "settlementTarget", label: "Settlement target", value: (row) => formatHumanStatus(row.settlementTarget) },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }) => <StatusBadge status={row.status} label={formatHumanStatus(row.status)} toneOverride={credentialStatusTone(row.status)} />,
        },
        { key: "lastVerifiedAt", label: "Last verified", value: (row) => row.lastVerifiedAt ?? "", Value: ({ row }) => <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.lastVerifiedAt)}</ThemedText> },
        { key: "expiresAt", label: "Expires", value: (row) => row.expiresAt ?? "", Value: ({ row }) => expiryCell(row.expiresAt) },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }) => (
                <TableRowActions primaryAction={{ label: t("View"), icon: "mdi-eye-outline", onClick: () => void (selectedId.value = row.id) }} items={rowActionItems(row)} />
            ),
        },
    ]);

    const drawerBody = () => {
        if (detailLoading.value) return <StateView loading minHeight="200px" />;
        if (detailError.value) return <StateView error={detailError.value} minHeight="200px" onRetry={() => selectedId.value && void loadDetail(selectedId.value)} />;
        const data = detail.value;
        if (!data) return null;
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                <VAlert type="info" variant="tonal" density="compact">
                    {t("Stored secrets are write-only. To change a value, rotate the credential set and enter every value again.")}
                </VAlert>
                <DescriptionList
                    items={[
                        { label: t("ID"), value: <MonoRef value={data.id} truncate={22} /> },
                        { label: t("Gateway"), value: data.gatewayCode ?? "—" },
                        { label: t("Environment"), value: <StatusBadge status={data.env} label={formatHumanStatus(data.env)} showDot={false} toneOverride={data.env === "LIVE" ? "danger" : "info"} /> },
                        { label: t("Status"), value: <StatusBadge status={data.status} label={formatHumanStatus(data.status)} toneOverride={credentialStatusTone(data.status)} /> },
                        { label: t("Owner"), value: formatHumanStatus(data.ownerType) },
                        { label: t("Owning merchant"), value: data.ownerMerchantId ? <MonoRef value={data.ownerMerchantId} truncate={22} /> : "—" },
                        { label: t("External merchant ID"), value: data.externalMerchantId ? <MonoRef value={data.externalMerchantId} truncate={22} /> : "—" },
                        { label: t("Settlement target"), value: formatHumanStatus(data.settlementTarget) },
                        { label: t("Last verified"), value: formatDateTime(data.lastVerifiedAt) },
                        { label: t("Expires"), value: formatDate(data.expiresAt) },
                    ]}
                />
                <SurfaceCard title={t("Stored entries")} subtitle={t("Keys and types only; values are never shown")} noPadding>
                    {data.entries.length === 0 ? (
                        <EmptyState title={t("No entries")} description={t("This credential set holds no entries.")} />
                    ) : (
                        <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead>
                                    <tr>
                                        <th style={{ textAlign: "start" }}>{t("Key")}</th>
                                        <th style={{ textAlign: "start" }}>{t("Type")}</th>
                                        <th style={{ textAlign: "start" }}>{t("Value")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.entries.map((entry) => (
                                        <tr key={`${entry.type}:${entry.key}`}>
                                            <td class="pg-mono">{entry.key}</td>
                                            <td>{formatHumanStatus(entry.type)}</td>
                                            <td>
                                                <StatusBadge
                                                    status={entry.isSecret ? "SECRET" : "WRITE_ONLY"}
                                                    label={entry.isSecret ? t("Secret, hidden") : t("Write-only")}
                                                    toneOverride="neutral"
                                                    showDot={false}
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </SurfaceCard>
            </div>
        );
    };

    const drawerFooter = () => {
        const data = detail.value;
        const actions = data ? availableActions(data.status, canWrite.value) : [];
        return (
            <>
                {data &&
                    actions.map((action) => (
                        <VBtn
                            key={action}
                            variant={action === "revoke" ? "outlined" : "tonal"}
                            color={action === "revoke" ? "error" : action === "verify" ? "primary" : undefined}
                            prependIcon={actionIcon(action)}
                            loading={action === "verify" && verifyingId.value === data.id}
                            onClick={() => runAction(action, data)}
                        >
                            {actionLabel(action)}
                        </VBtn>
                    ))}
                <VBtn variant="text" onClick={closeDrawer}>
                    {t("Close")}
                </VBtn>
            </>
        );
    };

    const createDraftError = (code: CreateError) => (createShowErrors.value && createDraftErrors.value.includes(code) ? t(CREATE_ERROR_TEXT[code]) : "");

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Credential Sets")}
                    subtitle={t("Provider credentials held in the vault. Secrets are write-only and are never displayed.")}
                    badge={t("Vault")}
                    badgeTone="info"
                    end={() => (
                        <>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshTable}>
                                {t("Refresh")}
                            </VBtn>
                            {canWrite.value && (
                                <VBtn color="primary" variant="flat" prependIcon="mdi-plus" onClick={openCreate}>
                                    {t("New credential set")}
                                </VBtn>
                            )}
                        </>
                    )}
                />
                <ApiTable<CredentialRow>
                    title={t("Credential sets")}
                    url={urlsMap.credentialSetsList}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "25", value: 25 },
                        { label: "50", value: 50 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers.value}
                    rowColor={(row) => (highlightId.value === row.id ? "var(--pg-accent-interactive-soft)" : undefined)}
                    apiDataExtractor={(data) => (data as { credentialSets?: CredentialRow[] }).credentialSets ?? []}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(_rows, nextTotal) => {
                        total.value = nextTotal;
                    }}
                    setRefreshHook={(next) => {
                        hook.value = next as TableHook;
                    }}
                    clearRefreshHook={() => {
                        hook.value = null;
                    }}
                    onRefresh={(table, refresh) => {
                        void refresh({
                            queryParams: {
                                page: table.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(filterDefs.value, filters.value),
                                ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <TableFilters
                            filters={filterDefs.value}
                            values={filters.value}
                            total={total.value}
                            onChange={onFilterChange}
                            onClear={() => {
                                filters.value = {};
                                hook.value?.reset();
                            }}
                        />
                    )}
                />
            </ThemedView>

            <SlideOverDrawer
                modelValue={selectedId.value !== null}
                onUpdate:modelValue={(open: boolean) => {
                    if (!open) closeDrawer();
                }}
                title={t("Credential set")}
                subtitle={detail.value ? `${detail.value.gatewayCode ?? ""} · ${formatHumanStatus(detail.value.env)}` : ""}
                width={640}
                v-slots={{ default: drawerBody, footer: drawerFooter }}
            />

            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(value: boolean) => (createOpen.value = value)}
                title={t("New credential set")}
                subtitle={t("The new set is untested until you verify it")}
                size="lg"
                submitLabel={t("Create credential set")}
                loading={createLoading.value}
                errorMessage={createError.value}
                onSubmit={() => void submitCreate()}
            >
                <FormField label={t("Gateway")} required error={createDraftError("GATEWAY_REQUIRED")}>
                    <VSelect
                        items={gatewayItems.value}
                        itemTitle="title"
                        itemValue="value"
                        modelValue={createDraft.value.gatewayCode}
                        onUpdate:modelValue={(value: string) => (createDraft.value.gatewayCode = value ?? "")}
                    />
                </FormField>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
                    <FormField label={t("Environment")} required>
                        <VSelect items={ENV_ITEMS} modelValue={createDraft.value.env} onUpdate:modelValue={(value: string | null) => void (createDraft.value.env = value ?? "SANDBOX")} />
                    </FormField>
                    <FormField label={t("Owner")} required>
                        <VSelect
                            items={OWNER_ITEMS}
                            modelValue={createDraft.value.ownerType}
                            onUpdate:modelValue={(value: string | null) => {
                                const owner = value ?? "PLATFORM";
                                createDraft.value.ownerType = owner;
                                createDraft.value.settlementTarget = defaultSettlementFor(owner);
                            }}
                        />
                    </FormField>
                    <FormField label={t("Settlement target")} required>
                        <VSelect
                            items={SETTLEMENT_ITEMS}
                            modelValue={createDraft.value.settlementTarget}
                            onUpdate:modelValue={(value: string | null) => void (createDraft.value.settlementTarget = value ?? "PLATFORM_CLEARING")}
                        />
                    </FormField>
                </div>
                {createDraft.value.ownerType === "MERCHANT" && (
                    <FormField label={t("Owning merchant")} required error={createDraftError("OWNER_MERCHANT_REQUIRED")}>
                        <VAutocomplete
                            items={merchantItems.value}
                            itemTitle="title"
                            itemValue="value"
                            modelValue={createDraft.value.ownerMerchantId || null}
                            onUpdate:modelValue={(value: string | null) => (createDraft.value.ownerMerchantId = value ?? "")}
                            onUpdate:search={(text: string) => void searchMerchants(text)}
                            clearable
                        />
                    </FormField>
                )}
                <FormField
                    label={t("External merchant ID")}
                    hint={t("The merchant identifier at the provider. Optional.")}
                    error={createDraftError("EXTERNAL_ID_LENGTH")}
                >
                    <VTextField
                        modelValue={createDraft.value.externalMerchantId}
                        onUpdate:modelValue={(value: string) => (createDraft.value.externalMerchantId = value)}
                        {...{ autocomplete: "off" }}
                    />
                </FormField>
                <FormField label={t("Credential entries")} required hint={t("Secret values are encrypted at rest and can never be read back.")}>
                    <EntriesEditor modelValue={createEntries.value} onUpdate:modelValue={(value: EntryDraft[]) => (createEntries.value = value)} validation={createValidation.value} showErrors={createShowErrors.value} />
                </FormField>
            </FormModal>

            <FormModal
                modelValue={rotateTarget.value !== null}
                onUpdate:modelValue={(open: boolean) => {
                    if (!open) {
                        rotateTarget.value = null;
                        rotateEntries.value = [];
                    }
                }}
                title={t("Rotate secrets")}
                subtitle={rotateTarget.value ? `${rotateTarget.value.gatewayCode ?? ""} · ${formatHumanStatus(rotateTarget.value.env)}` : ""}
                size="lg"
                submitLabel={t("Rotate")}
                loading={rotateLoading.value}
                errorMessage={rotateError.value}
                onSubmit={() => void submitRotate()}
            >
                <VAlert type="warning" variant="tonal" density="compact">
                    {t("Rotation replaces every entry. The set becomes untested until it is verified again, so enter all values.")}
                </VAlert>
                <EntriesEditor modelValue={rotateEntries.value} onUpdate:modelValue={(value: EntryDraft[]) => (rotateEntries.value = value)} validation={rotateValidation.value} showErrors={rotateShowErrors.value} />
            </FormModal>

            <ReasonModal
                modelValue={revokeTarget.value !== null}
                onUpdate:modelValue={(open: boolean) => {
                    if (!open) revokeTarget.value = null;
                }}
                title={t("Revoke credential set")}
                description={t("A revoked credential set can no longer be used and cannot be restored. Create a new one to replace it.")}
                submitLabel={t("Revoke")}
                danger
                loading={revokeLoading.value}
                errorMessage={revokeError.value}
                onSubmit={(reason: string) => void submitRevoke(reason)}
            />
        </ScreenContainer>
    );
});

export default CredentialSetsPage;
