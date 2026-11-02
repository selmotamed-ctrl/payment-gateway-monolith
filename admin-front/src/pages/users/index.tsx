import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCheckbox, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { user as currentUser } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { ADMIN_ROLES } from "@/utils/authorities";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { MetaPill } from "@/components/ui/MetaPill";
type UserRow = {
    id: string;
    email: string;
    phone: string | null;
    role: string;
    merchantId: string | null;
    authoritiesMap: unknown;
    status: string;
    isMaker: boolean;
    isChecker: boolean;
    mfaRequired: boolean;
    invitationExpiresAt: string | null;
    createdAt: string;
    updatedAt: string;
};

type UserSummary = {
    total: number;
    active: number;
    invited: number;
    suspended: number;
    disabled: number;
    makers: number;
    checkers: number;
    fourEyes: number;
    byRole: Record<string, number>;
    byStatus: Record<string, number>;
};

type UserDetail = UserRow & {
    invitedById: string | null;
    academyProgressJson: unknown;
};

const USER_STATUSES = ["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"];

const authorityKeys = (map: unknown): string[] => {
    if (Array.isArray(map)) {
        return map.filter((value): value is string => typeof value === "string").filter(Boolean);
    }
    if (!map || typeof map !== "object") return [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
        if (value === true) {
            keys.push(key);
        } else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === "string" && item.length > 0) {
                    keys.push(key.includes(":") ? key : `${key}:${item}`);
                }
            }
        } else if (typeof value === "string" && value.length > 0) {
            keys.push(key.includes(":") ? key : `${key}:${value}`);
        }
    }
    return keys;
};

const parseAuthorities = (value: string): string[] =>
    Array.from(
        new Set(
            value
                .split(/[,\n]/)
                .map((item) => item.trim())
                .filter((item) => item.length >= 2 && item.length <= 64),
        ),
    );

const authorityRecord = (keys: string[]): Record<string, string[]> =>
    Object.fromEntries(keys.map((key) => [key, [] as string[]]));

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

const SUMMARY_EXPORT_CHECKS = [
    { key: "ACCESS_SCOPE_VERIFIED", label: "Access scope verified" },
    { key: "ROLE_STATUS_REVIEWED", label: "Role and status breakdown reviewed" },
    { key: "MAKER_CHECKER_REVIEWED", label: "Maker/checker coverage reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const USER_EDIT_CHECKS = [
    { key: "SELECTION_REVIEWED", label: "User and requested changes reviewed" },
    { key: "STATUS_IMPACT_REVIEWED", label: "Status and access impact reviewed" },
    { key: "NOTIFICATION_PLANNED", label: "User notification planned" },
    { key: "AUTHORITY_CONFIRMED", label: "Authority to make the change confirmed" },
] as const;

const BULK_STATUS_CHECKS = [
    { key: "SELECTION_REVIEWED", label: "Selected users reviewed" },
    { key: "STATUS_IMPACT_REVIEWED", label: "Status impact reviewed" },
    { key: "NOTIFICATION_PLANNED", label: "User notification planned" },
    { key: "AUTHORITY_CONFIRMED", label: "Authority to change status confirmed" },
] as const;

const INVITE_CHECKS = [
    { key: "EMAIL_VERIFIED", label: "Email identity verified" },
    { key: "ROLE_SCOPE_CONFIRMED", label: "Role scope confirmed" },
    { key: "AUTHORITIES_REVIEWED", label: "Authorities reviewed" },
    { key: "MFA_REQUIREMENT_CONFIRMED", label: "MFA requirement confirmed" },
] as const;

const UsersPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const showChecklists = areChecklistsVisible();
    const toneColor = (tone: "error" | "warning"): string =>
        (theme.current.value.colors as Record<string, string>)[tone] ?? "";
    const router = useRouter();
    const rows = ref<UserRow[]>([]);
    const total = ref(0);
    const summary = ref<UserSummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const pageSize = ref(20);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const selectedUsers = ref<Record<string, UserRow>>({});
    const bulkOpen = ref(false);
    const bulkStatus = ref("SUSPENDED");
    const bulkReason = ref("");
    const bulkLoading = ref(false);
    const bulkError = ref<string | null>(null);
    const bulkStatusChecklist = ref<Record<string, boolean>>({});
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailOpen = ref(false);
    const detailLoading = ref(false);
    const detailError = ref<string | null>(null);
    const detail = ref<UserDetail | null>(null);
    const editForm = ref({ role: "OPERATOR", status: "ACTIVE", authorities: "" });
    const detailChecklist = ref<Record<string, boolean>>({});
    const saving = ref(false);

    const createOpen = ref(false);
    const inviteChecklist = ref<Record<string, boolean>>({});
    const creating = ref(false);
    const createError = ref<string | null>(null);
    const createForm = ref({
        email: "",
        fullName: "",
        phone: "",
        role: "OPERATOR",
        temporaryPassword: "",
        authorities: "",
    });

    const filterDefinitions = computed(() => tableRegistry.Users?.filters ?? []);
    const currentUserId = computed(() => String(currentUser.value?.userInfo?.id ?? ""));
    const selectedList = computed(() => Object.values(selectedUsers.value));
    const selectedCount = computed(() => selectedList.value.length);
    const selectableRows = computed(() => rows.value.filter((row) => row.id !== currentUserId.value));
    const allVisibleSelected = computed(
        () => selectableRows.value.length > 0 && selectableRows.value.every((row) => Boolean(selectedUsers.value[row.id])),
    );
    const someVisibleSelected = computed(
        () => selectableRows.value.some((row) => Boolean(selectedUsers.value[row.id])) && !allVisibleSelected.value,
    );
    const clearSelection = () => {
        selectedUsers.value = {};
    };
    const toggleRow = (row: UserRow, value: boolean | null) => {
        if (row.id === currentUserId.value) return;
        if (value) selectedUsers.value = { ...selectedUsers.value, [row.id]: row };
        else {
            const next = { ...selectedUsers.value };
            delete next[row.id];
            selectedUsers.value = next;
        }
    };
    const toggleVisible = (value: boolean | null) => {
        if (!value) {
            const next = { ...selectedUsers.value };
            for (const row of rows.value) delete next[row.id];
            selectedUsers.value = next;
            return;
        }
        const next = { ...selectedUsers.value };
        for (const row of selectableRows.value) next[row.id] = row;
        selectedUsers.value = next;
    };
    const openBulk = () => {
        if (selectedCount.value === 0) return;
        bulkStatus.value = "SUSPENDED";
        bulkReason.value = "";
        bulkError.value = null;
        bulkStatusChecklist.value = {};
        bulkOpen.value = true;
    };
    const bulkStatusChecklistComplete = computed(() => !showChecklists || BULK_STATUS_CHECKS.every((check) => bulkStatusChecklist.value[check.key] === true));

    const applyBulkStatus = async () => {
        if (selectedCount.value === 0 || bulkLoading.value) return;
        if (!bulkStatusChecklistComplete.value) {
            bulkError.value = t("Complete all status checklist items before applying");
            return;
        }
        bulkLoading.value = true;
        bulkError.value = null;
        try {
            await api.patch(urlsMap.usersList, {
                userIds: Object.keys(selectedUsers.value),
                status: bulkStatus.value,
                ...(bulkReason.value.trim() ? { reason: bulkReason.value.trim() } : {}),
                checklist: BULK_STATUS_CHECKS.filter((check) => bulkStatusChecklist.value[check.key]).map((check) => check.key),
            });
            showSnackBar({ type: "success", message: `${t("Users updated")}: ${selectedCount.value}` });
            bulkOpen.value = false;
            clearSelection();
            refreshAll();
        } catch (e) {
            bulkError.value = extractApiErrorMessage(e);
        } finally {
            bulkLoading.value = false;
        }
    };

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.usersSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as UserSummary;
        } catch {
            summary.value = null;
        }
    };

    void loadSummary();

    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.usersSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as UserSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["active", snapshot.active],
                ["invited", snapshot.invited],
                ["suspended", snapshot.suspended],
                ["disabled", snapshot.disabled],
                ["makers", snapshot.makers],
                ["checkers", snapshot.checkers],
                ["four_eyes", snapshot.fourEyes],
            ];
            for (const [role, count] of Object.entries(snapshot.byRole ?? {})) rows.push([`role.${role}.count`, count]);
            for (const [status, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${status}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `admin-user-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Admin user summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        const suspended = data.suspended + data.disabled;
        return [
            { key: "total", label: t("Admin users"), value: String(data.total) },
            { key: "active", label: t("Active"), value: String(data.active), badge: t("Active"), badgeTone: "success" },
            { key: "invited", label: t("Invited"), value: String(data.invited), badge: data.invited > 0 ? t("Watch") : t("Clear"), badgeTone: data.invited > 0 ? "warning" : "success" },
            { key: "suspended", label: t("Suspended"), value: String(suspended), badge: suspended > 0 ? t("Critical") : t("Clear"), badgeTone: suspended > 0 ? "danger" : "success" },
            { key: "makers", label: t("Makers"), value: String(data.makers) },
            { key: "checkers", label: t("Checkers"), value: String(data.checkers) },
        ];
    });

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.usersExport, {
                params: {
                    scope: "admin",
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.users ?? []) as UserRow[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No users match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "email", "phone", "role", "status", "isMaker", "isChecker", "mfaRequired", "authorities", "invitationExpiresAt", "createdAt", "updatedAt"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.email,
                        row.phone ?? "",
                        row.role,
                        row.status,
                        row.isMaker,
                        row.isChecker,
                        row.mfaRequired,
                        authorityKeys(row.authoritiesMap).join(";"),
                        row.invitationExpiresAt ?? "",
                        row.createdAt,
                        row.updatedAt,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `admin-users-${new Date().toISOString().slice(0, 10)}.xlsx`,
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
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const openDetail = async (row: UserRow) => {
        detailOpen.value = true;
        detailLoading.value = true;
        detailError.value = null;
        detail.value = null;
        try {
            const response = await api.get(urlsMap.userDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            const user = (payload.user ?? payload) as UserDetail;
            detail.value = user;
            editForm.value = {
                role: user.role,
                status: user.status,
                authorities: authorityKeys(user.authoritiesMap).join(", "),
            };
            detailChecklist.value = {};
        } catch (e) {
            detailError.value = extractApiErrorMessage(e);
        } finally {
            detailLoading.value = false;
        }
    };

    const detailChecklistComplete = computed(() => !showChecklists || USER_EDIT_CHECKS.every((check) => detailChecklist.value[check.key] === true));

    const saveDetail = async () => {
        const user = detail.value;
        if (!user || saving.value) return;
        const nextAuthorities = parseAuthorities(editForm.value.authorities);
        const roleChanged = editForm.value.role !== user.role;
        const statusChanged = editForm.value.status !== user.status;
        const authoritiesChanged =
            nextAuthorities.slice().sort().join("|") !== authorityKeys(user.authoritiesMap).slice().sort().join("|");
        if (!roleChanged && !statusChanged && !authoritiesChanged) {
            detailOpen.value = false;
            return;
        }
        if (!detailChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all edit checklist items before saving") });
            return;
        }
        saving.value = true;
        try {
            let pendingApproval = false;
            if (roleChanged || authoritiesChanged) {
                const response = await api.patch(urlsMap.usersList, {
                    userIds: [user.id],
                    ...(roleChanged ? { role: editForm.value.role } : {}),
                    ...(authoritiesChanged ? { authorities: authorityRecord(nextAuthorities) } : {}),
                    reason: "admin user update from users console",
                    checklist: USER_EDIT_CHECKS.filter((check) => detailChecklist.value[check.key]).map((check) => check.key),
                });
                pendingApproval = response.status === 202;
            }
            if (statusChanged) {
                await api.patch(urlsMap.userDetail(user.id), {
                    status: editForm.value.status,
                    reason: "admin user status update from users console",
                    checklist: USER_EDIT_CHECKS.filter((check) => detailChecklist.value[check.key]).map((check) => check.key),
                });
            }
            showSnackBar({
                type: "success",
                message: pendingApproval
                    ? t("Role or authority changes were submitted for checker approval.")
                    : t("User updated"),
            });
            detailOpen.value = false;
            refreshAll();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            saving.value = false;
        }
    };

    const openCreate = () => {
        createError.value = null;
        createForm.value = {
            email: "",
            fullName: "",
            phone: "",
            role: "OPERATOR",
            temporaryPassword: "",
            authorities: "",
        };
        inviteChecklist.value = {};
        createOpen.value = true;
    };

    const inviteChecklistComplete = computed(() => !showChecklists || INVITE_CHECKS.every((check) => inviteChecklist.value[check.key] === true));

    const createUser = async () => {
        if (creating.value) return;
        if (!inviteChecklistComplete.value) {
            createError.value = t("Complete all invite checklist items before inviting");
            return;
        }
        creating.value = true;
        createError.value = null;
        try {
            const authorities = parseAuthorities(createForm.value.authorities);
            await api.post(urlsMap.usersList, {
                email: createForm.value.email.trim().toLowerCase(),
                fullName: createForm.value.fullName.trim() || createForm.value.email.split("@")[0],
                role: createForm.value.role,
                ...(createForm.value.phone.trim() ? { phone: createForm.value.phone.trim() } : {}),
                ...(createForm.value.temporaryPassword ? { temporaryPassword: createForm.value.temporaryPassword } : {}),
                ...(authorities.length > 0 ? { authorities: authorityRecord(authorities) } : {}),
                checklist: INVITE_CHECKS.filter((check) => inviteChecklist.value[check.key]).map((check) => check.key),
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("User invited") });
            refreshAll();
        } catch (e) {
            createError.value = extractApiErrorMessage(e);
        } finally {
            creating.value = false;
        }
    };

    const headers = computed<TableHeader<UserRow>[]>(() => [
        {
            key: "select",
            label: "",
            sortable: false,
            headerCellStyle: { justifyContent: "center" },
            Header: () => (
                <span style={{ width: "28px", height: "40px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <VCheckbox
                        modelValue={allVisibleSelected.value}
                        indeterminate={someVisibleSelected.value}
                        onUpdate:modelValue={(value: boolean | null) => toggleVisible(value)}
                        density="compact"
                        hideDetails
                        aria-label="Select all users on this page"
                    />
                </span>
            ),
            Value: ({ row }: { row: UserRow }) => (
                <ThemedView style={{ width: "28px", height: "40px", alignItems: "center", justifyContent: "center" }}>
                    <VCheckbox
                        modelValue={Boolean(selectedUsers.value[row.id])}
                        onUpdate:modelValue={(value: boolean | null) => toggleRow(row, value)}
                        disabled={row.id === currentUserId.value}
                        density="compact"
                        hideDetails
                        aria-label={`Select user ${row.email}`}
                    />
                </ThemedView>
            ),
        },
        {
            key: "user",
            label: "User",
            sortKey: "email",
            value: (row) => `${row.email} ${row.phone ?? ""}`,
            Value: ({ row }: { row: UserRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.email}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                        {row.phone ?? t("No phone")}
                        {row.isMaker ? ` · ${t("maker")}` : ""}
                        {row.isChecker ? ` · ${t("checker")}` : ""}
                    </ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "role",
            label: "Role",
            sortKey: "role",
            value: (row) => row.role,
            Value: ({ row }: { row: UserRow }) => <StatusBadge status={row.role} label={row.role.replaceAll("_", " ")} toneOverride="info" showDot={false} />,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: UserRow }) => <StatusBadge status={row.status} toneOverride={statusTone(row.status) === "error" ? "danger" : (statusTone(row.status) as any)} />,
        },
        {
            key: "authorities",
            label: "Authorities",
            value: (row) => String(authorityKeys(row.authoritiesMap).length),
            Value: ({ row }: { row: UserRow }) => {
                const keys = authorityKeys(row.authoritiesMap);
                return (
                    <ThemedView style={{ gap: "2px" }}>
                        <ThemedText style={{ fontSize: "12px" }}>{keys.length}</ThemedText>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55, maxWidth: "260px" }}>
                            {keys.slice(0, 3).join(", ")}
                            {keys.length > 3 ? ` +${keys.length - 3}` : ""}
                        </ThemedText>
                    </ThemedView>
                );
            },
        },
        {
            key: "mfa",
            label: "MFA",
            value: (row) => (row.mfaRequired ? "Required" : "Optional"),
            Value: ({ row }: { row: UserRow }) => (
                <StatusBadge status={row.mfaRequired ? "REQUIRED" : "OPTIONAL"} label={row.mfaRequired ? t("Required") : t("Optional")} toneOverride={row.mfaRequired ? "success" : "warning"} showDot={false} />
            ),
        },
        {
            key: "createdAt",
            label: "Created",
            sortKey: "createdAt",
            value: (row) => row.createdAt,
            Value: ({ row }: { row: UserRow }) => <ThemedText style={{ fontSize: "10px" }}>{formatDateTime(row.createdAt)}</ThemedText>,
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }: { row: UserRow }) => (
                <VBtn size="small" variant="tonal" color="primary" onClick={() => void openDetail(row)}>
                    {t("Open")}
                </VBtn>
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Admin Users")}
                    subtitle={t("Platform operators, makers, checkers, and access posture.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                            <VBtn color="primary" variant="flat" prependIcon="mdi-account-plus-outline" onClick={openCreate}>{t("Invite user")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Role and authority changes require a different checker. Status-only changes apply immediately. MFA is enforced for every internal user.")}
                </VAlert>

                {summary.value && (
                    <SummaryExportCard
                        title={t("Access governance")}
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
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byRole ?? {}).map(([role, count]) => (
                                <MetaPill key={role} size="x-small" variant="tonal">{role.replaceAll("_", " ")}: {count}</MetaPill>
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}

                {selectedCount.value > 0 && (
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            gap: "10px",
                            alignItems: "center",
                            flexWrap: "wrap",
                            padding: "10px 14px",
                            borderRadius: "var(--pg-radius-md)",
                            border: "1px solid var(--pg-border-subtle)",
                            background: "var(--pg-bg-surface-subtle)",
                        }}
                    >
                        <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>{selectedCount.value} {t("selected")}</ThemedText>
                        <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("Status-only changes apply immediately. Your own account cannot be selected.")}</ThemedText>
                        <div style={{ flex: 1 }} />
                        <VBtn size="small" variant="text" onClick={clearSelection}>{t("Clear selection")}</VBtn>
                        <VBtn size="small" color="warning" variant="flat" prependIcon="mdi-account-cog-outline" onClick={openBulk}>{t("Change status")}</VBtn>
                    </ThemedView>
                )}

                <ApiTable<UserRow>
                    title={t("Internal users")}
                    url={urlsMap.adminUsers}
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
                    headers={headers.value}
                    rowColor={(row) => (row.status === "SUSPENDED" || row.status === "DISABLED" ? toneColor("error") : row.status === "INVITED" ? toneColor("warning") : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { users?: UserRow[]; rows?: UserRow[] };
                        return payload.users ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(nextRows, nextTotal) => {
                        rows.value = nextRows;
                        total.value = nextTotal;
                    }}
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
                            total={total.value}
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )}
                />
            </ThemedView>

            <FormModal
                modelValue={bulkOpen.value}
                onUpdate:modelValue={(value: boolean) => (bulkOpen.value = value)}
                title={t("Change status for selected users")}
                size="md"
                onSubmit={() => void applyBulkStatus()}
                submitLabel={`${t("Apply")} (${selectedCount.value})`}
                loading={bulkLoading.value}
                errorMessage={bulkError.value ?? ""}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={bulkLoading.value} onClick={() => (bulkOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="warning"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={bulkLoading.value}
                                disabled={!bulkStatusChecklistComplete.value}
                            >
                                {t("Apply")} ({selectedCount.value})
                            </VBtn>
                        </>
                    ),
                }}
            >
                <VAlert type="info" variant="tonal">
                    {t("This changes account status only. Role and authority changes still require checker approval.")}
                </VAlert>
                <FormField label={t("Status")} sensitiveMakerChecker>
                    <VSelect
                        items={["ACTIVE", "SUSPENDED", "DISABLED"]}
                        modelValue={bulkStatus.value}
                        onUpdate:modelValue={(value: string | null) => (bulkStatus.value = value ?? "SUSPENDED")}
                    />
                </FormField>
                <FormField label={t("Reason (optional)")} sensitiveMakerChecker>
                    <VTextField
                        modelValue={bulkReason.value}
                        onUpdate:modelValue={(value: string) => (bulkReason.value = value)}
                    />
                </FormField>
                <FormChecklist
                    checks={[...BULK_STATUS_CHECKS]}
                    modelValue={bulkStatusChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (bulkStatusChecklist.value = value)}
                    show={showChecklists}
                    title={t("Status change checklist")}
                    complete={bulkStatusChecklistComplete.value}
                    incompleteMessage={t("Complete all status checklist items before applying")}
                />
            </FormModal>

            <FormModal
                modelValue={detailOpen.value}
                onUpdate:modelValue={(value: boolean) => (detailOpen.value = value)}
                title={detail.value?.email ?? t("User detail")}
                size="lg"
                onSubmit={() => void saveDetail()}
                submitLabel={t("Save changes")}
                loading={saving.value}
                errorMessage={detail.value ? (detailError.value ?? "") : ""}
                v-slots={{
                    footer: () =>
                        detail.value ? (
                            <>
                                <VBtn
                                    variant="text"
                                    onClick={() => {
                                        detailOpen.value = false;
                                        void router.push({ name: "AdminUserDetail", params: { id: detail.value?.id ?? "" } });
                                    }}
                                >
                                    {t("Full profile")}
                                </VBtn>
                                <VBtn variant="outlined" disabled={saving.value} onClick={() => (detailOpen.value = false)}>{t("Cancel")}</VBtn>
                                <VBtn color="primary" variant="flat" {...{ type: "submit" }} loading={saving.value} disabled={!detailChecklistComplete.value}>
                                    {t("Save changes")}
                                </VBtn>
                            </>
                        ) : null,
                }}
            >
                {detailLoading.value ? (
                    <StateView loading={true} />
                ) : detailError.value && !detail.value ? (
                    <StateView error={detailError.value} onRetry={() => detail.value && void openDetail(detail.value)} />
                ) : detail.value ? (
                    <>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                            <ThemedView style={{ gap: "2px", flex: 1 }}>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.6, direction: "ltr" }}><MonoRef value={detail.value.id} /></ThemedText>
                            </ThemedView>
                            <StatusBadge status={detail.value.status} toneOverride={statusTone(detail.value.status) === "error" ? "danger" : (statusTone(detail.value.status) as any)} />
                            {detail.value.isMaker && <StatusBadge status="MAKER" label={t("Maker")} toneOverride="info" showDot={false} />}
                            {detail.value.isChecker && <StatusBadge status="CHECKER" label={t("Checker")} toneOverride="neutral" showDot={false} />}
                        </ThemedView>

                        <DescriptionList
                            columns={2}
                            items={[
                                { label: t("Phone"), value: detail.value.phone ?? "—" },
                                { label: t("MFA"), value: detail.value.mfaRequired ? t("Required") : t("Optional") },
                                { label: t("Created"), value: formatDateTime(detail.value.createdAt) },
                                { label: t("Invitation expires"), value: formatDateTime(detail.value.invitationExpiresAt) },
                            ]}
                        />

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                            <FormField label={t("Role")} sensitiveMakerChecker style={{ flex: "1 1 240px" }}>
                                <VSelect
                                    items={[...ADMIN_ROLES] as string[]}
                                    modelValue={editForm.value.role}
                                    onUpdate:modelValue={(value: string | null) => (editForm.value.role = value ?? "OPERATOR")}
                                />
                            </FormField>
                            <FormField label={t("Status")} sensitiveMakerChecker style={{ flex: "1 1 240px" }}>
                                <VSelect
                                    items={USER_STATUSES}
                                    modelValue={editForm.value.status}
                                    onUpdate:modelValue={(value: string) => (editForm.value.status = value)}
                                />
                            </FormField>
                        </ThemedView>

                        <FormField
                            label={t("Authority keys")}
                            hint={t("Comma-separated keys. Any role or authority change waits for a checker.")}
                            sensitiveMakerChecker
                        >
                            <VTextField
                                modelValue={editForm.value.authorities}
                                onUpdate:modelValue={(value: string) => (editForm.value.authorities = value)}
                                placeholder="user:read, user:write, merchant:read"
                            />
                        </FormField>

                        <FormChecklist
                            checks={[...USER_EDIT_CHECKS]}
                            modelValue={detailChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (detailChecklist.value = value)}
                            show={showChecklists}
                            title={t("Edit checklist")}
                            complete={detailChecklistComplete.value}
                            incompleteMessage={t("Complete all edit checklist items before saving")}
                        />
                        <VAlert type="warning" variant="tonal" density="compact">
                            {t("You cannot approve your own change. A different checker must review role and authority updates.")}
                        </VAlert>
                    </>
                ) : null}
            </FormModal>

            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(value: boolean) => (createOpen.value = value)}
                title={t("Invite internal user")}
                size="md"
                onSubmit={() => void createUser()}
                submitLabel={t("Invite")}
                loading={creating.value}
                errorMessage={createError.value ?? ""}
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
                                disabled={!createForm.value.email.trim() || !createForm.value.email.includes("@") || !inviteChecklistComplete.value}
                            >
                                {t("Invite")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <VAlert type="info" variant="tonal" density="compact">
                    {t("The user starts in INVITED state. Set a temporary password only when hand-delivering credentials.")}
                </VAlert>
                <FormField label={t("Email")} required>
                    <VTextField type="email" modelValue={createForm.value.email} onUpdate:modelValue={(value: string) => (createForm.value.email = value)} />
                </FormField>
                <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                    <FormField label={t("Display name")} style={{ flex: "1 1 220px" }}>
                        <VTextField modelValue={createForm.value.fullName} onUpdate:modelValue={(value: string) => (createForm.value.fullName = value)} />
                    </FormField>
                    <FormField label={t("Phone")} style={{ flex: "1 1 220px" }}>
                        <VTextField modelValue={createForm.value.phone} onUpdate:modelValue={(value: string) => (createForm.value.phone = value)} />
                    </FormField>
                </ThemedView>
                <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                    <FormField label={t("Role")} sensitiveMakerChecker style={{ flex: "1 1 220px" }}>
                        <VSelect items={[...ADMIN_ROLES] as string[]} modelValue={createForm.value.role} onUpdate:modelValue={(value: string | null) => (createForm.value.role = value ?? "OPERATOR")} />
                    </FormField>
                    <FormField label={t("Temporary password")} sensitiveMakerChecker style={{ flex: "1 1 220px" }}>
                        <VTextField type="password" modelValue={createForm.value.temporaryPassword} onUpdate:modelValue={(value: string) => (createForm.value.temporaryPassword = value)} />
                    </FormField>
                </ThemedView>
                <FormField
                    label={t("Authority keys")}
                    hint={t("Optional. Comma-separated authority keys.")}
                    sensitiveMakerChecker
                >
                    <VTextField
                        modelValue={createForm.value.authorities}
                        onUpdate:modelValue={(value: string) => (createForm.value.authorities = value)}
                        placeholder="user:read, merchant:read"
                    />
                </FormField>
                <FormChecklist
                    checks={[...INVITE_CHECKS]}
                    modelValue={inviteChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (inviteChecklist.value = value)}
                    show={showChecklists}
                    title={t("Invite checklist")}
                    complete={inviteChecklistComplete.value}
                    incompleteMessage={t("Complete all invite checklist items before inviting")}
                />
            </FormModal>
        </ScreenContainer>
    );
});

export default UsersPage;
