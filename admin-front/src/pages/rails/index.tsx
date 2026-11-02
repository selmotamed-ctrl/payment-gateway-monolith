import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { MetaPill } from "@/components/ui/MetaPill";
type RailField = {
    id?: string;
    key?: string;
    fieldKey?: string;
    labelAr: string;
    labelEn: string;
    type?: string;
    inputType?: string;
    required: boolean;
    regex: string | null;
    minLength: number | null;
    maxLength: number | null;
    normalizer: unknown;
    sensitivity: string;
};

const SUMMARY_EXPORT_CHECKS = [
    { key: "RAIL_SCOPE_VERIFIED", label: "Rail portfolio scope verified" },
    { key: "COLLECTION_MODE_REVIEWED", label: "Collection-mode breakdown reviewed" },
    { key: "ROUTE_HEALTH_REVIEWED", label: "Route health reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const RAIL_FIELD_CHECKS = [
    { key: "FIELD_CODES_VERIFIED", label: "Field codes verified" },
    { key: "VALIDATION_RULES_REVIEWED", label: "Validation rules reviewed" },
    { key: "SENSITIVITY_REVIEWED", label: "Sensitivity reviewed" },
    { key: "CHECKOUT_IMPACT_REVIEWED", label: "Checkout impact reviewed" },
] as const;

const RAIL_EDIT_CHECKS = [
    { key: "NAMES_VERIFIED", label: "Rail names verified" },
    { key: "LIMITS_VERIFIED", label: "Amount limits verified" },
    { key: "INSTRUCTIONS_REVIEWED", label: "Payer instructions reviewed" },
    { key: "AVAILABILITY_IMPACT_REVIEWED", label: "Availability impact reviewed" },
] as const;

type Rail = {
    id: string;
    fieldCount?: number;
    routeCount?: number;
    flowCount?: number;
    paymentAttemptCount?: number;
    routeHealth?: { healthy: number; degraded: number; openBreaker: number; active: number };
    code: string;
    nameAr: string;
    nameEn: string;
    collectionMode: string;
    currency: string;
    minAmount: string;
    maxAmount: string;
    capabilities: unknown;
    blocked?: boolean;
    displayOrder?: number;
    instructionsAr?: string;
    instructionsEn?: string;
    createdAt?: string;
    updatedAt?: string;
    fields: RailField[];
};

/** The public field shape the admin edge accepts on PUT /rails/:id/fields. */
type PublicField = {
    code: string;
    label: string;
    type: string;
    required: boolean;
    pattern: string;
    minLength: string;
    maxLength: string;
    sensitive: boolean;
};

const PUBLIC_TYPES = ["TEXT", "NUMBER", "PHONE", "NATIONAL_ID", "PASSPORT", "DATE", "OTP", "HIDDEN"];

const CORE_TO_PUBLIC: Record<string, string> = {
    string: "TEXT",
    number: "NUMBER",
    phone: "PHONE",
    otp: "OTP",
    birth_year: "DATE",
    card_number: "TEXT",
    pan: "TEXT",
    wallet_id: "TEXT",
    from_list: "TEXT",
};

const blankField = (): PublicField => ({
    code: "",
    label: "",
    type: "TEXT",
    required: true,
    pattern: "",
    minLength: "",
    maxLength: "",
    sensitive: false,
});

const formatCapabilities = (value: unknown): string => {
    if (Array.isArray(value)) {
        return value.join(", ");
    }
    if (value && typeof value === "object") {
        return Object.entries(value as Record<string, unknown>)
            .filter(([, enabled]) => enabled === true)
            .map(([key]) => key)
            .join(", ");
    }
    return "";
};

const toPublicField = (field: RailField): PublicField => {
    const code = field.key ?? field.fieldKey ?? "";
    const rawType = String(field.type ?? field.inputType ?? "").toUpperCase();
    const type = PUBLIC_TYPES.includes(rawType)
        ? rawType
        : (CORE_TO_PUBLIC[rawType.toLowerCase()] ?? "TEXT");
    return {
        code,
        label: field.labelEn || field.labelAr || code,
        type,
        required: field.required !== false,
        pattern: field.regex ?? "",
        minLength: field.minLength === null || field.minLength === undefined ? "" : String(field.minLength),
        maxLength: field.maxLength === null || field.maxLength === undefined ? "" : String(field.maxLength),
        sensitive: (field.sensitivity ?? "NORMAL") !== "NORMAL",
    };
};

type RailSummary = {
    total: number;
    active: number;
    blocked: number;
    byMode: Record<string, number>;
    routes: { healthy: number; degraded: number; openBreaker: number };
};

const RailsPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const showChecklists = areChecklistsVisible();
    const toneColor = (tone: "error" | "warning"): string =>
        (theme.current.value.colors as Record<string, string>)[tone] ?? "";
    const summary = ref<RailSummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const pageSize = ref(20);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    // Create rail
    const createOpen = ref(false);
    const creating = ref(false);
    const railForm = ref({ code: "", name: "", collectionMode: "REDIRECT" });

    // Update rail
    const editOpen = ref(false);
    const railEditChecklist = ref<Record<string, boolean>>({});
    const savingRail = ref(false);
    const editingRail = ref<Rail | null>(null);
    const railEditForm = ref({
        nameEn: "",
        nameAr: "",
        active: true,
        minAmount: "",
        maxAmount: "",
        displayOrder: "",
        instructionsEn: "",
        instructionsAr: "",
    });

    // Customer catalog (rail fields)
    const dialogOpen = ref(false);
    const selected = ref<Rail | null>(null);
    const fields = ref<PublicField[]>([]);
    const fieldForm = ref<PublicField>(blankField());
    const railFieldChecklist = ref<Record<string, boolean>>({});
    const editingFieldIndex = ref<number | null>(null);
    const actionLoading = ref(false);

    const filterDefinitions = computed(() => tableRegistry.Rails?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.railsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as RailSummary;
        } catch {
            summary.value = null;
        }
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.railsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.rails ?? []) as Rail[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No rails match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "code", "nameEn", "nameAr", "collectionMode", "currency", "minAmount", "maxAmount", "blocked", "displayOrder", "fields", "routes", "flows", "attempts", "healthyRoutes", "degradedRoutes", "openBreakers", "activeRoutes", "createdAt"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) => {
                    const health = row.routeHealth ?? { healthy: 0, degraded: 0, openBreaker: 0, active: 0 };
                    return [
                        row.id,
                        row.code,
                        row.nameEn,
                        row.nameAr,
                        row.collectionMode,
                        row.currency,
                        row.minAmount,
                        row.maxAmount,
                        row.blocked ?? false,
                        row.displayOrder ?? "",
                        row.fieldCount ?? row.fields.length,
                        row.routeCount ?? 0,
                        row.flowCount ?? 0,
                        row.paymentAttemptCount ?? 0,
                        health.healthy,
                        health.degraded,
                        health.openBreaker,
                        health.active,
                        row.createdAt ?? "",
                    ]
                        .map(escape)
                        .join(",");
                }),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `rails-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({
                type: payload.truncated ? "warning" : "success",
                message: payload.truncated
                    ? `${t("Exported")} ${rowsData.length} / ${payload.total}`
                    : `${t("Exported")} ${rowsData.length}`,
            });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            exportLoading.value = false;
        }
    };

    const refreshAll = () => {
        refreshHook.value?.reset();
        void loadSummary();
    };

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    void loadSummary();

    const openCreateRail = () => {
        railForm.value = { code: "", name: "", collectionMode: "REDIRECT" };
        createOpen.value = true;
    };

    const createRail = async () => {
        if (creating.value) {
            return;
        }
        creating.value = true;
        try {
            await api.post(urlsMap.railsList, {
                code: railForm.value.code.trim().toLowerCase(),
                name: railForm.value.name.trim(),
                collectionMode: railForm.value.collectionMode,
                active: true,
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            refreshAll();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            creating.value = false;
        }
    };

    const openEditRail = (rail: Rail) => {
        editingRail.value = rail;
        railEditForm.value = {
            nameEn: rail.nameEn ?? "",
            nameAr: rail.nameAr ?? "",
            active: rail.blocked !== true,
            minAmount: rail.minAmount ?? "",
            maxAmount: rail.maxAmount ?? "",
            displayOrder: rail.displayOrder === undefined || rail.displayOrder === null ? "" : String(rail.displayOrder),
            instructionsEn: rail.instructionsEn ?? "",
            instructionsAr: rail.instructionsAr ?? "",
        };
        railEditChecklist.value = {};
        editOpen.value = true;
    };

    const railEditChecklistComplete = computed(() => !showChecklists || RAIL_EDIT_CHECKS.every((check) => railEditChecklist.value[check.key] === true));

    const saveRail = async () => {
        if (!editingRail.value || savingRail.value) {
            return;
        }
        const form = railEditForm.value;
        if (!railEditChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all rail checklist items before saving") });
            return;
        }
        const payload: Record<string, unknown> = { active: form.active };
        if (form.nameEn.trim()) payload.nameEn = form.nameEn.trim();
        if (form.nameAr.trim()) payload.nameAr = form.nameAr.trim();
        if (form.minAmount.trim()) payload.minAmount = form.minAmount.trim();
        if (form.maxAmount.trim()) payload.maxAmount = form.maxAmount.trim();
        if (form.displayOrder.trim()) payload.displayOrder = Number(form.displayOrder);
        if (form.instructionsEn.trim()) payload.instructionsEn = form.instructionsEn.trim();
        if (form.instructionsAr.trim()) payload.instructionsAr = form.instructionsAr.trim();
        payload.checklist = RAIL_EDIT_CHECKS.filter((check) => railEditChecklist.value[check.key]).map((check) => check.key);
        savingRail.value = true;
        try {
            await api.patch(urlsMap.railDetail(editingRail.value.id), payload);
            editOpen.value = false;
            showSnackBar({ type: "success", message: t("Update") });
            refreshAll();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            savingRail.value = false;
        }
    };

    const resetFieldForm = () => {
        fieldForm.value = blankField();
        railFieldChecklist.value = {};
        editingFieldIndex.value = null;
    };

    const openRail = async (rail: Rail) => {
        selected.value = rail;
        fields.value = [];
        resetFieldForm();
        dialogOpen.value = true;
        try {
            const response = await api.get(urlsMap.railDetail(rail.id));
            const payload = response.data?.data ?? response.data ?? {};
            const detail = payload.rail ?? payload;
            fields.value = (detail.fields ?? []).map(toPublicField);
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const editField = (index: number) => {
        const field = fields.value[index];
        if (!field) {
            return;
        }
        fieldForm.value = { ...field };
        editingFieldIndex.value = index;
    };

    const railFieldChecklistComplete = computed(() => !showChecklists || RAIL_FIELD_CHECKS.every((check) => railFieldChecklist.value[check.key] === true));

    const persistFields = async (next: PublicField[]): Promise<void> => {
        if (!selected.value) {
            return;
        }
        if (!railFieldChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all rail field checklist items before saving") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.put(urlsMap.railFields(selected.value.id), {
                fields: next.map((field) => ({
                    code: field.code.trim().toLowerCase(),
                    label: field.label.trim(),
                    type: field.type,
                    required: !!field.required,
                    sensitive: !!field.sensitive,
                    ...(field.pattern.trim() ? { pattern: field.pattern.trim() } : {}),
                    ...(field.minLength.trim() ? { minLength: Number(field.minLength) } : {}),
                    ...(field.maxLength.trim() ? { maxLength: Number(field.maxLength) } : {}),
                })),
                checklist: RAIL_FIELD_CHECKS.filter((check) => railFieldChecklist.value[check.key]).map((check) => check.key),
            });
            fields.value = next;
            resetFieldForm();
            showSnackBar({ type: "success", message: t("Save") });
            refreshAll();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const saveField = async () => {
        if (!fieldForm.value.code.trim() || !fieldForm.value.label.trim()) {
            return;
        }
        const next = [...fields.value];
        if (editingFieldIndex.value === null) {
            next.push({ ...fieldForm.value });
        } else {
            next[editingFieldIndex.value] = { ...fieldForm.value };
        }
        await persistFields(next);
    };

    const removeField = async (index: number) => {
        if (fields.value.length <= 1) {
            showSnackBar({ type: "error", message: t("A rail needs at least one field") });
            return;
        }
        const next = fields.value.filter((_, position) => position !== index);
        if (editingFieldIndex.value === index) {
            resetFieldForm();
        }
        await persistFields(next);
    };

    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.railsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as RailSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["active", snapshot.active],
                ["blocked", snapshot.blocked],
                ["routes_healthy", snapshot.routes.healthy],
                ["routes_degraded", snapshot.routes.degraded],
                ["routes_open_breaker", snapshot.routes.openBreaker],
            ];
            for (const [mode, count] of Object.entries(snapshot.byMode ?? {})) rows.push([`mode.${mode}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `rail-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Rail summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "rails", label: t("Rails"), value: String(data.total) },
            { key: "active", label: t("Active"), value: String(data.active), badge: t("Active"), badgeTone: "success" },
            { key: "blocked", label: t("Blocked"), value: String(data.blocked), badge: (data.blocked ?? 0) > 0 ? t("Critical") : t("Clear"), badgeTone: (data.blocked ?? 0) > 0 ? "danger" : "success" },
            { key: "degraded", label: t("Degraded routes"), value: String(data.routes?.degraded ?? 0), badge: (data.routes?.degraded ?? 0) > 0 ? t("Watch") : t("Clear"), badgeTone: (data.routes?.degraded ?? 0) > 0 ? "warning" : "success" },
            { key: "breakers", label: t("Open breakers"), value: String(data.routes?.openBreaker ?? 0), badge: (data.routes?.openBreaker ?? 0) > 0 ? t("Critical") : t("Clear"), badgeTone: (data.routes?.openBreaker ?? 0) > 0 ? "danger" : "success" },
        ];
    });

    const headers: TableHeader<Rail>[] = [
        { key: "code", label: "Rail Code", value: (row) => row.code, Value: ({ row }) => <MonoRef value={row.code} /> },
        { key: "nameEn", label: "Label (English)", value: (row) => row.nameEn },
        { key: "nameAr", label: "Label (Arabic)", value: (row) => row.nameAr },
        { key: "collectionMode", label: "Type", value: (row) => row.collectionMode },
        { key: "currency", label: "Currency", value: (row) => row.currency },
        {
            key: "limits",
            label: "Amount",
            value: (row) => `${row.minAmount ?? ""} - ${row.maxAmount ?? ""}`,
            Value: ({ row }: { row: Rail }) => (
                <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                    <MoneyDisplay amount={row.minAmount ?? "0"} currency={row.currency} size="sm" />
                    <span style={{ color: "var(--pg-ink-faint)" }}>–</span>
                    <MoneyDisplay amount={row.maxAmount ?? "0"} currency={row.currency} size="sm" />
                </div>
            ),
        },
        {
            key: "routes",
            label: "Routes / health",
            value: (row) => `${row.routeCount ?? 0} ${row.routeHealth?.healthy ?? 0}/${row.routeHealth?.degraded ?? 0}/${row.routeHealth?.openBreaker ?? 0}`,
            Value: ({ row }: { row: Rail }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.routeCount ?? 0}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                        {row.routeHealth?.healthy ?? 0} {t("healthy")} · {row.routeHealth?.degraded ?? 0} {t("degraded")} · {row.routeHealth?.openBreaker ?? 0} {t("open")}
                    </ThemedText>
                </ThemedView>
            ),
        },
        { key: "fields", label: "Fields", value: (row) => String(row.fieldCount ?? (row.fields ?? []).length) },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Rail }) => (
                <StatusBadge status={row.blocked ? "BLOCKED" : "ACTIVE"} label={row.blocked ? t("Blocked") : t("Active")} toneOverride={row.blocked ? "danger" : "success"} />
            ),
        },
        { key: "capabilities", label: "Capabilities", value: (row) => formatCapabilities(row.capabilities) },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Rail }) => (
                <ThemedView style={{ flexDirection: "row", gap: "8px" }}>
                    <VBtn size="small" variant="text" prependIcon="mdi-pencil" onClick={() => openEditRail(row)}>
                        {t("Edit")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => void openRail(row)}>
                        {t("Customer Catalog")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Rails")}
                    subtitle={t("Customer payment methods, collection modes, and catalog fields.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                            <VBtn color="primary" variant="flat" prependIcon={"mdi-plus"} onClick={() => openCreateRail()}>
                                {t("Add Rail")}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Rails define the customer-facing payment methods. Route health and circuit breaker state come from the live catalog.")}
                </VAlert>

                {summary.value && (
                    <SummaryExportCard
                        title={t("Rail health")}
                        metrics={metricItems.value}
                        exportLoading={summaryExportLoading.value}
                        exportDisabled={!summaryExportChecklistComplete.value}
                        onExport={() => void exportSummary()}
                    >
                        <FormChecklist
                            checks={[...SUMMARY_EXPORT_CHECKS]}
                            modelValue={summaryExportChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (summaryExportChecklist.value = value)}
                            show={showChecklists}
                            title={t("Summary export checklist")}
                            complete={summaryExportChecklistComplete.value}
                            incompleteMessage={t("Complete all summary export checklist items before exporting")}
                        />
                    </SummaryExportCard>
                )}

                <ApiTable<Rail>
                    title={t("Rail catalog")}
                    url={urlsMap.railsList}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "20", value: 20 },
                        { label: "50", value: 50 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers}
                    rowColor={(row) => (row.blocked ? toneColor("error") : (row.routeHealth?.openBreaker ?? 0) > 0 ? toneColor("warning") : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { rails?: Rail[]; rows?: Rail[] };
                        return payload.rails ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    setRefreshHook={(hook) => {
                        refreshHook.value = hook as typeof refreshHook.value;
                    }}
                    clearRefreshHook={() => {
                        refreshHook.value = null;
                    }}
                    onRefresh={(table, refresh) => {
                        void refresh({
                            queryParams: {
                                page: table.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(filterDefinitions.value, filters.value),
                                ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <TableFilters
                            filters={filterDefinitions.value}
                            values={filters.value}
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )}
                />
            </ThemedView>

            {/* Customer catalog: list + add/edit/delete fields */}
            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={[selected.value?.nameEn, selected.value?.code ? `(${selected.value.code})` : ""].filter(Boolean).join(" ")}
                size="lg"
                onSubmit={() => void saveField()}
                submitLabel={editingFieldIndex.value === null ? t("Add") : t("Save")}
                loading={actionLoading.value}
                v-slots={{
                    footer: () => (
                        <>
                            {editingFieldIndex.value !== null && (
                                <VBtn variant="text" onClick={() => resetFieldForm()}>
                                    {t("Cancel")}
                                </VBtn>
                            )}
                            <VBtn variant="outlined" disabled={actionLoading.value} onClick={() => (dialogOpen.value = false)}>
                                {t("Close")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={actionLoading.value}
                                disabled={!fieldForm.value.code.trim() || !fieldForm.value.label.trim() || !railFieldChecklistComplete.value}
                            >
                                {editingFieldIndex.value === null ? t("Add") : t("Save")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center" }}>
                    <StatusBadge status={selected.value?.collectionMode ?? "-"} toneOverride="info" />
                </ThemedView>

                <ThemedText type="defaultSemiBold">{t("Customer Catalog")}</ThemedText>
                <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                    {fields.value.length === 0 && (
                        <ThemedText style={{ opacity: 0.6, fontSize: "13px" }}>
                            {t("No Data Found")}
                        </ThemedText>
                    )}
                    {fields.value.map((field, index) => (
                        <ThemedView
                            key={`${field.code}-${index}`}
                            style={{
                                flexDirection: "row",
                                gap: "10px",
                                alignItems: "center",
                                borderBottom: "1px solid var(--pg-border-subtle)",
                                paddingBottom: "8px",
                                fontSize: "13px",
                            }}
                        >
                            <span style={{ width: "150px", fontWeight: 600 }}>{field.code}</span>
                            <span style={{ flex: 1 }}>{field.label}</span>
                            <MetaPill size="x-small" variant="tonal">{field.type}</MetaPill>
                            {field.required && <StatusBadge status="REQUIRED" label={t("Required")} toneOverride="warning" showDot={false} />}
                            {field.sensitive && <StatusBadge status="SENSITIVE" label={t("Sensitive")} toneOverride="danger" showDot={false} />}
                            <VBtn size="small" variant="text" icon="mdi-pencil" onClick={() => editField(index)} />
                            <VBtn
                                size="small"
                                variant="text"
                                icon="mdi-delete-outline"
                                color="error"
                                onClick={() => void removeField(index)}
                            />
                        </ThemedView>
                    ))}
                </ThemedView>

                <ThemedText type="defaultSemiBold">
                    {editingFieldIndex.value === null ? t("Add") : t("Edit")}
                </ThemedText>
                <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                    <FormField label={t("Field Key")} required sensitiveMakerChecker style={{ flex: "1 1 180px" }}>
                        <VTextField
                            modelValue={fieldForm.value.code}
                            onUpdate:modelValue={(v: string) => (fieldForm.value.code = v)}
                        />
                    </FormField>
                    <FormField label={t("Label (English)")} required style={{ flex: "1 1 200px" }}>
                        <VTextField
                            modelValue={fieldForm.value.label}
                            onUpdate:modelValue={(v: string) => (fieldForm.value.label = v)}
                        />
                    </FormField>
                    <FormField label={t("Input Type")} style={{ flex: "1 1 160px" }}>
                        <VSelect
                            items={PUBLIC_TYPES}
                            modelValue={fieldForm.value.type}
                            onUpdate:modelValue={(v: string) => (fieldForm.value.type = v)}
                        />
                    </FormField>
                </ThemedView>
                <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
                    <FormField label={t("Regex")} style={{ flex: "1 1 200px" }}>
                        <VTextField
                            modelValue={fieldForm.value.pattern}
                            onUpdate:modelValue={(v: string) => (fieldForm.value.pattern = v)}
                        />
                    </FormField>
                    <FormField label={t("Min")} style={{ flex: "0 1 120px" }}>
                        <VTextField
                            type="number"
                            modelValue={fieldForm.value.minLength}
                            onUpdate:modelValue={(v: string) => (fieldForm.value.minLength = v)}
                        />
                    </FormField>
                    <FormField label={t("Max")} style={{ flex: "0 1 120px" }}>
                        <VTextField
                            type="number"
                            modelValue={fieldForm.value.maxLength}
                            onUpdate:modelValue={(v: string) => (fieldForm.value.maxLength = v)}
                        />
                    </FormField>
                    <VSwitch
                        label={t("Required")}
                        modelValue={fieldForm.value.required}
                        onUpdate:modelValue={(v: any) => (fieldForm.value.required = !!v)}
                    />
                    <VSwitch
                        label={t("Sensitive")}
                        modelValue={fieldForm.value.sensitive}
                        onUpdate:modelValue={(v: any) => (fieldForm.value.sensitive = !!v)}
                    />
                </ThemedView>
                <FormChecklist
                    checks={[...RAIL_FIELD_CHECKS]}
                    modelValue={railFieldChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (railFieldChecklist.value = value)}
                    show={showChecklists}
                    title={t("Rail field checklist")}
                    complete={railFieldChecklistComplete.value}
                    incompleteMessage={t("Complete all rail field checklist items before saving")}
                />
            </FormModal>

            {/* Update rail */}
            <FormModal
                modelValue={editOpen.value}
                onUpdate:modelValue={(v: any) => (editOpen.value = v)}
                title={[t("Edit"), editingRail.value?.code].filter(Boolean).join(" · ")}
                size="md"
                onSubmit={() => void saveRail()}
                submitLabel={t("Save")}
                loading={savingRail.value}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={savingRail.value} onClick={() => (editOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={savingRail.value}
                                disabled={(!railEditForm.value.nameEn.trim() && !railEditForm.value.nameAr.trim()) || !railEditChecklistComplete.value}
                            >
                                {t("Save")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px" }}>
                    <FormField label={t("Label (English)")}>
                        <VTextField
                            modelValue={railEditForm.value.nameEn}
                            onUpdate:modelValue={(v: string) => (railEditForm.value.nameEn = v)}
                        />
                    </FormField>
                    <FormField label={t("Label (Arabic)")}>
                        <VTextField
                            modelValue={railEditForm.value.nameAr}
                            onUpdate:modelValue={(v: string) => (railEditForm.value.nameAr = v)}
                        />
                    </FormField>
                    <FormField label={t("Minimum amount")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={railEditForm.value.minAmount}
                            onUpdate:modelValue={(v: string) => (railEditForm.value.minAmount = v)}
                        />
                    </FormField>
                    <FormField label={t("Maximum amount")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={railEditForm.value.maxAmount}
                            onUpdate:modelValue={(v: string) => (railEditForm.value.maxAmount = v)}
                        />
                    </FormField>
                    <FormField label={t("Display order")}>
                        <VTextField
                            type="number"
                            modelValue={railEditForm.value.displayOrder}
                            onUpdate:modelValue={(v: string) => (railEditForm.value.displayOrder = v)}
                        />
                    </FormField>
                    <div style={{ display: "flex", alignItems: "center" }}>
                        <VSwitch
                            label={t("Active")}
                            modelValue={railEditForm.value.active}
                            onUpdate:modelValue={(v: any) => (railEditForm.value.active = !!v)}
                        />
                    </div>
                    <FormField label={t("Instructions (English)")} style={{ gridColumn: "span 2" }}>
                        <VTextarea
                            rows={2}
                            modelValue={railEditForm.value.instructionsEn}
                            onUpdate:modelValue={(v: string) => (railEditForm.value.instructionsEn = v)}
                        />
                    </FormField>
                    <FormField label={t("Instructions (Arabic)")} style={{ gridColumn: "span 2" }}>
                        <VTextarea
                            rows={2}
                            modelValue={railEditForm.value.instructionsAr}
                            onUpdate:modelValue={(v: string) => (railEditForm.value.instructionsAr = v)}
                        />
                    </FormField>
                </div>
                <FormChecklist
                    checks={[...RAIL_EDIT_CHECKS]}
                    modelValue={railEditChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (railEditChecklist.value = value)}
                    show={showChecklists}
                    title={t("Rail edit checklist")}
                    complete={railEditChecklistComplete.value}
                    incompleteMessage={t("Complete all rail checklist items before saving")}
                />
            </FormModal>

            {/* Add rail */}
            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(v: any) => (createOpen.value = v)}
                title={t("Add Rail")}
                size="sm"
                onSubmit={() => void createRail()}
                submitLabel={t("Create")}
                loading={creating.value}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={creating.value} onClick={() => (createOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={creating.value}
                                disabled={!railForm.value.code.trim() || !railForm.value.name.trim()}
                            >
                                {t("Create")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <FormField label={t("Rail Code")} hint="lowercase letters, digits, - and _" required sensitiveMakerChecker>
                    <VTextField
                        modelValue={railForm.value.code}
                        onUpdate:modelValue={(v: string) => (railForm.value.code = v)}
                    />
                </FormField>
                <FormField label={t("Label (English)")} required>
                    <VTextField
                        modelValue={railForm.value.name}
                        onUpdate:modelValue={(v: string) => (railForm.value.name = v)}
                    />
                </FormField>
                <FormField label={t("Type")}>
                    <VSelect
                        items={["REDIRECT", "EMBEDDED", "QR", "PUSH", "TRANSFER", "CASH"]}
                        modelValue={railForm.value.collectionMode}
                        onUpdate:modelValue={(v: string) => (railForm.value.collectionMode = v)}
                    />
                </FormField>
            </FormModal>
        </ScreenContainer>
    );
});

export default RailsPage;
