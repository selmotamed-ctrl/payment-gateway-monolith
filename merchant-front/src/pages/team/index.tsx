import { dc } from "kt-dc";
import { ref } from "vue";
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
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
type TeamMember = {
    id: string;
    name: string;
    username: string;
    email: string | null;
    phone: string | null;
    role: string;
    appScopeIds: string[];
    authoritiesMap: Record<string, boolean>;
    status: string;
    createdAt: string;
};

const ROLES = ["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"];
const SCOPES = ["links", "payments", "wallets", "cashout", "applications", "pos", "tokens", "credentials", "users", "stats", "statements"];
// The portal groups map to the closed core authority catalogue. Sending the
// group names themselves is rejected by core (unknown authority) and would let
// the UI drift from the server-enforced vocabulary.
const AUTHORITY_GROUPS: Record<string, string[]> = {
    links: ["link:read", "link:write"],
    payments: ["payment:read"],
    wallets: ["wallet:create"],
    cashout: ["cashout:read", "cashout:request"],
    applications: ["application:manage"],
    pos: ["pos:manage"],
    tokens: ["token:manage"],
    credentials: ["credential:manage"],
    users: ["user:manage"],
    stats: ["merchant:read"],
    statements: ["merchant:read"],
    onboarding: ["onboarding:write"],
    disputes: ["dispute:respond"],
};
const AUTHORITY_GROUP_BY_VALUE = new Map<string, string>(
    Object.entries(AUTHORITY_GROUPS).flatMap(([group, authorities]) =>
        authorities.map((authority) => [authority, group] as [string, string]),
    ),
);
const expandAuthorities = (groups: string[]): string[] => [
    ...new Set(
        groups.flatMap((group) => AUTHORITY_GROUPS[group] ?? (group.includes(":") ? [group] : [])),
    ),
];
const authorityGroups = (authoritiesMap: Record<string, boolean> | undefined): string[] => [
    ...new Set(
        Object.entries(authoritiesMap ?? {})
            .filter(([, enabled]) => !!enabled)
            .map(([authority]) => AUTHORITY_GROUP_BY_VALUE.get(authority) ?? authority),
    ),
];

const TeamPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<TeamMember[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const editing = ref<TeamMember | null>(null);
    const form = ref({
        name: "",
        username: "",
        email: "",
        phone: "",
        password: "",
        status: "ACTIVE",
        role: "MERCHANT_STAFF",
        appScopeIds: [] as string[],
        authorities: [] as string[],
    });
    const actionLoading = ref(false);
    const formError = ref("");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.usersList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.users ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openDialog = (member: TeamMember | null) => {
        editing.value = member;
        formError.value = "";
        form.value = {
            name: member?.name ?? "",
            username: member?.username ?? "",
            email: member?.email ?? "",
            phone: member?.phone ?? "",
            password: "",
            status: member?.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
            role: member?.role ?? "MERCHANT_STAFF",
            appScopeIds: [...(member?.appScopeIds ?? [])],
            authorities: authorityGroups(member?.authoritiesMap),
        };
        dialogOpen.value = true;
    };

    const save = async () => {
        actionLoading.value = true;
        formError.value = "";
        try {
            const authoritiesMap: Record<string, boolean> = {};
            for (const authority of expandAuthorities(form.value.authorities)) {
                authoritiesMap[authority] = true;
            }
            if (editing.value) {
                await api.patch(urlsMap.userDetail(editing.value.id), {
                    fullName: form.value.name,
                    role: form.value.role,
                    status: form.value.status,
                    authoritiesMap,
                });
            } else {
                await api.post(urlsMap.usersList, {
                    email: form.value.email,
                    ...(form.value.phone ? { phone: form.value.phone } : {}),
                    fullName: form.value.name,
                    ...(form.value.password ? { password: form.value.password } : {}),
                    role: form.value.role,
                    authoritiesMap,
                });
            }
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<TeamMember>[] = [
        { key: "name", label: "Full Name", value: (row) => row.name },
        { key: "username", label: "Username", value: (row) => row.username },
        { key: "email", label: "Email", value: (row) => row.email ?? "-" },
        { key: "role", label: "Role", value: (row) => row.role },
        { key: "appScopeIds", label: "Scopes", value: (row) => (row.appScopeIds ?? []).join(", ") || "-" },
        {
            key: "authorities",
            label: "Authorities",
            value: (row) => authorityGroups(row.authoritiesMap).join(", ") || "-",
        },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: TeamMember }) => (
                <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: TeamMember }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Edit"),
                        icon: "mdi-pencil-outline",
                        onClick: () => openDialog(row),
                    }}
                    items={[]}
                />
            ),
        },
    ];

    const submitDisabled = () =>
        !editing.value && (!form.value.email.trim() || form.value.password.trim().length < 10);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Team & Roles")}
                    subtitle={t("Merchant users, authorities, and access posture.")}
                    end={() => (
                        <VBtn variant="tonal" onClick={() => openDialog(null)}>
                            {t("Invite Member")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Team & Roles")}
                        data={rows.value}
                        headers={headers}
                        loading={loading.value}
                        showNumber={true}
                        xlsx={false}
                        noElevation={true}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                    />
                )}
            </ThemedView>

            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={editing.value ? t("Edit") : t("Invite Member")}
                size="md"
                loading={actionLoading.value}
                errorMessage={formError.value}
                onSubmit={() => void save()}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={actionLoading.value} onClick={() => (dialogOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={actionLoading.value}
                                disabled={submitDisabled()}
                            >
                                {editing.value ? t("Save") : t("Invite Member")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <SectionFields title={t("Profile")}>
                    <FormField label={t("Full Name")} required style={{ minWidth: "200px" }}>
                        <VTextField
                            modelValue={form.value.name}
                            onUpdate:modelValue={(v: string) => (form.value.name = v)}
                            hideDetails
                        />
                    </FormField>
                    {editing.value ? (
                        <FormField label={t("Status")} style={{ minWidth: "180px" }}>
                            <VSelect
                                items={["ACTIVE", "SUSPENDED"]}
                                modelValue={form.value.status}
                                onUpdate:modelValue={(v: string) => (form.value.status = v)}
                                hideDetails
                            />
                        </FormField>
                    ) : (
                        <FormField
                            label={t("Temporary password")}
                            hint={t("At least 10 characters.")}
                            required
                            style={{ minWidth: "200px" }}
                        >
                            <VTextField
                                type="password"
                                modelValue={form.value.password}
                                onUpdate:modelValue={(v: string) => (form.value.password = v)}
                                hideDetails
                            />
                        </FormField>
                    )}
                    <FormField label={t("Email")} required style={{ minWidth: "200px" }}>
                        <VTextField
                            modelValue={form.value.email}
                            onUpdate:modelValue={(v: string) => (form.value.email = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Phone")} style={{ minWidth: "180px" }}>
                        <VTextField
                            modelValue={form.value.phone}
                            onUpdate:modelValue={(v: string) => (form.value.phone = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Role")} required style={{ minWidth: "220px" }}>
                        <VSelect
                            items={ROLES}
                            modelValue={form.value.role}
                            onUpdate:modelValue={(v: string) => (form.value.role = v)}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Authorities")}>
                    <FormField label={t("Scopes")}>
                        <VSelect
                            items={SCOPES.map((scope) => ({ title: scope, value: scope }))}
                            modelValue={form.value.appScopeIds}
                            onUpdate:modelValue={(v: string[]) => (form.value.appScopeIds = v)}
                            multiple
                            chips
                            closable-chips
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Authorities")}>
                        <VSelect
                            items={Object.keys(AUTHORITY_GROUPS).map((scope) => ({ title: `${scope}.*`, value: scope }))}
                            modelValue={form.value.authorities}
                            onUpdate:modelValue={(v: string[]) => (form.value.authorities = v)}
                            multiple
                            chips
                            closable-chips
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default TeamPage;
