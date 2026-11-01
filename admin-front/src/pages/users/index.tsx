import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VChip,
    VDialog,
    VDivider,
    VSelect,
    VTextField,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { ADMIN_ROLES } from "@/utils/authorities";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

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

const UsersPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<UserRow[]>([]);
    const total = ref(0);
    const summary = ref<UserSummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const pageSize = ref(20);
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
    const saving = ref(false);

    const createOpen = ref(false);
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

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Admin users"), value: String(data.total), tone: "info" as const },
            { label: t("Active"), value: String(data.active), tone: "success" as const },
            { label: t("Invited"), value: String(data.invited), tone: data.invited > 0 ? "warning" as const : "success" as const },
            { label: t("Suspended"), value: String(data.suspended + data.disabled), tone: data.suspended + data.disabled > 0 ? "error" as const : "success" as const },
            { label: t("Makers"), value: String(data.makers), tone: "primary" as const },
            { label: t("Checkers"), value: String(data.checkers), tone: "primary" as const },
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
        } catch (e) {
            detailError.value = extractApiErrorMessage(e);
        } finally {
            detailLoading.value = false;
        }
    };

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
        saving.value = true;
        try {
            let pendingApproval = false;
            if (roleChanged || authoritiesChanged) {
                const response = await api.patch(urlsMap.usersList, {
                    userIds: [user.id],
                    ...(roleChanged ? { role: editForm.value.role } : {}),
                    ...(authoritiesChanged ? { authorities: authorityRecord(nextAuthorities) } : {}),
                    reason: "admin user update from users console",
                });
                pendingApproval = response.status === 202;
            }
            if (statusChanged) {
                await api.patch(urlsMap.userDetail(user.id), {
                    status: editForm.value.status,
                    reason: "admin user status update from users console",
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
        createOpen.value = true;
    };

    const createUser = async () => {
        if (creating.value) return;
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
            key: "user",
            label: "User",
            sortKey: "email",
            value: (row) => `${row.email} ${row.phone ?? ""}`,
            Value: ({ row }: { row: UserRow }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{row.email}</ThemedText>
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
            Value: ({ row }: { row: UserRow }) => <StatusChip label={row.role.replaceAll("_", " ")} tone="info" size="small" />,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: UserRow }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="small" />,
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
                <StatusChip label={row.mfaRequired ? t("Required") : t("Optional")} tone={row.mfaRequired ? "success" : "warning"} size="small" />
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
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn color="primary" variant="flat" prependIcon="mdi-account-plus-outline" onClick={openCreate}>{t("Invite user")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Role and authority changes require a different checker. Status-only changes apply immediately. MFA is enforced for every internal user.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Access governance")}</ThemedText>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
                                {summaryItems.value.map((item) => (
                                    <VCard key={item.label} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px" }}>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                {Object.entries(summary.value.byRole ?? {}).map(([role, count]) => (
                                    <StatusChip key={role} label={`${role.replaceAll("_", " ")}: ${count}`} tone="neutral" size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
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
                    rowColor={(row) => (row.status === "SUSPENDED" || row.status === "DISABLED" ? "#dc2626" : row.status === "INVITED" ? "#d97706" : undefined)}
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

            <VDialog modelValue={detailOpen.value} onUpdate:modelValue={(value: boolean) => (detailOpen.value = value)} maxWidth="760px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        {detailLoading.value ? (
                            <StateView loading={true} />
                        ) : detailError.value ? (
                            <StateView error={detailError.value} onRetry={() => detail.value && void openDetail(detail.value)} />
                        ) : detail.value ? (
                            <>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "2px", flex: 1 }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>{detail.value.email}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.6, direction: "ltr" }}>{detail.value.id}</ThemedText>
                                    </ThemedView>
                                    <StatusChip label={detail.value.status} tone={statusTone(detail.value.status)} />
                                    {detail.value.isMaker && <VChip size="small" variant="tonal" color="primary">{t("Maker")}</VChip>}
                                    {detail.value.isChecker && <VChip size="small" variant="tonal" color="secondary">{t("Checker")}</VChip>}
                                </ThemedView>

                                <VDivider />

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
                                    <ThemedView style={{ gap: "2px" }}>
                                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{t("Phone")}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px" }}>{detail.value.phone ?? "—"}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ gap: "2px" }}>
                                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{t("MFA")}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px" }}>{detail.value.mfaRequired ? t("Required") : t("Optional")}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ gap: "2px" }}>
                                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{t("Created")}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(detail.value.createdAt)}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ gap: "2px" }}>
                                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{t("Invitation expires")}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(detail.value.invitationExpiresAt)}</ThemedText>
                                    </ThemedView>
                                </ThemedView>

                                <VDivider />

                                <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                                    <VSelect
                                        label={t("Role")}
                                        items={[...ADMIN_ROLES] as string[]}
                                        modelValue={editForm.value.role}
                                        onUpdate:modelValue={(value: string | null) => (editForm.value.role = value ?? "OPERATOR")}
                                        style={{ flex: "1 1 240px" }}
                                    />
                                    <VSelect
                                        label={t("Status")}
                                        items={USER_STATUSES}
                                        modelValue={editForm.value.status}
                                        onUpdate:modelValue={(value: string) => (editForm.value.status = value)}
                                        style={{ flex: "1 1 240px" }}
                                    />
                                </ThemedView>

                                <VTextField
                                    label={t("Authority keys")}
                                    modelValue={editForm.value.authorities}
                                    onUpdate:modelValue={(value: string) => (editForm.value.authorities = value)}
                                    placeholder="user:read, user:write, merchant:read"
                                    hint={t("Comma-separated keys. Any role or authority change waits for a checker.")}
                                    persistentHint
                                />

                                <VAlert type="warning" variant="tonal" density="compact">
                                    {t("You cannot approve your own change. A different checker must review role and authority updates.")}
                                </VAlert>

                                <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                                    <VBtn variant="text" onClick={() => (detailOpen.value = false)}>{t("Cancel")}</VBtn>
                                    <VBtn color="primary" loading={saving.value} onClick={() => void saveDetail()}>{t("Save changes")}</VBtn>
                                </ThemedView>
                            </>
                        ) : null}
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(value: boolean) => (createOpen.value = value)} maxWidth="620px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>{t("Invite internal user")}</ThemedText>
                        <VAlert type="info" variant="tonal" density="compact">
                            {t("The user starts in INVITED state. Set a temporary password only when hand-delivering credentials.")}
                        </VAlert>
                        {createError.value && <VAlert type="error" variant="tonal" density="compact">{createError.value}</VAlert>}
                        <VTextField label={t("Email")} type="email" modelValue={createForm.value.email} onUpdate:modelValue={(value: string) => (createForm.value.email = value)} />
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                            <VTextField label={t("Display name")} modelValue={createForm.value.fullName} onUpdate:modelValue={(value: string) => (createForm.value.fullName = value)} style={{ flex: "1 1 220px" }} />
                            <VTextField label={t("Phone")} modelValue={createForm.value.phone} onUpdate:modelValue={(value: string) => (createForm.value.phone = value)} style={{ flex: "1 1 220px" }} />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "12px" }}>
                            <VSelect label={t("Role")} items={[...ADMIN_ROLES] as string[]} modelValue={createForm.value.role} onUpdate:modelValue={(value: string | null) => (createForm.value.role = value ?? "OPERATOR")} style={{ flex: "1 1 220px" }} />
                            <VTextField label={t("Temporary password")} type="password" modelValue={createForm.value.temporaryPassword} onUpdate:modelValue={(value: string) => (createForm.value.temporaryPassword = value)} style={{ flex: "1 1 220px" }} />
                        </ThemedView>
                        <VTextField
                            label={t("Authority keys")}
                            modelValue={createForm.value.authorities}
                            onUpdate:modelValue={(value: string) => (createForm.value.authorities = value)}
                            placeholder="user:read, merchant:read"
                            hint={t("Optional. Comma-separated authority keys.")}
                            persistentHint
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn
                                color="primary"
                                loading={creating.value}
                                disabled={!createForm.value.email.trim() || !createForm.value.email.includes("@")}
                                onClick={() => void createUser()}
                            >
                                {t("Invite")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default UsersPage;
