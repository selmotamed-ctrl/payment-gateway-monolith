import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

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
        form.value = {
            name: member?.name ?? "",
            username: member?.username ?? "",
            email: member?.email ?? "",
            phone: member?.phone ?? "",
            password: "",
            status: member?.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
            role: member?.role ?? "MERCHANT_STAFF",
            appScopeIds: [...(member?.appScopeIds ?? [])],
            authorities: Object.entries(member?.authoritiesMap ?? {})
                .filter(([, enabled]) => !!enabled)
                .map(([authority]) => authority),
        };
        dialogOpen.value = true;
    };

    const save = async () => {
        actionLoading.value = true;
        try {
            const authoritiesMap: Record<string, boolean> = {};
            for (const authority of form.value.authorities) {
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
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
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
            value: (row) =>
                Object.entries(row.authoritiesMap ?? {})
                    .filter(([, enabled]) => !!enabled)
                    .map(([authority]) => authority)
                    .join(", ") || "-",
        },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: TeamMember }) => (
                <StatusChip label={row.status} tone={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: TeamMember }) => (
                <VBtn size="small" variant="tonal" onClick={() => openDialog(row)}>
                    {t("Edit")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Team & Roles")}
                    end={() => (
                        <VBtn variant="tonal" onClick={() => openDialog(null)}>
                            {t("Invite Member")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
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
                        </VCardText>
                    </VCard>
                )}
            </ThemedView>

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="640px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{editing.value ? t("Edit") : t("Invite Member")}</ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField
                                label={t("Full Name")}
                                modelValue={form.value.name}
                                onUpdate:modelValue={(v: string) => (form.value.name = v)}
                                style={{ minWidth: "200px" }}
                            />
                            {editing.value ? (
                                <VSelect
                                    items={["ACTIVE", "SUSPENDED"]}
                                    modelValue={form.value.status}
                                    onUpdate:modelValue={(v: string) => (form.value.status = v)}
                                    label={t("Status")}
                                    style={{ minWidth: "180px" }}
                                />
                            ) : (
                                <VTextField
                                    label={t("Temporary password")}
                                    type="password"
                                    hint="at least 10 characters"
                                    modelValue={form.value.password}
                                    onUpdate:modelValue={(v: string) => (form.value.password = v)}
                                    style={{ minWidth: "200px" }}
                                />
                            )}
                            <VTextField
                                label={t("Email")}
                                modelValue={form.value.email}
                                onUpdate:modelValue={(v: string) => (form.value.email = v)}
                                style={{ minWidth: "200px" }}
                            />
                            <VTextField
                                label={t("Phone")}
                                modelValue={form.value.phone}
                                onUpdate:modelValue={(v: string) => (form.value.phone = v)}
                                style={{ minWidth: "180px" }}
                            />
                            <VSelect
                                items={ROLES}
                                modelValue={form.value.role}
                                onUpdate:modelValue={(v: string) => (form.value.role = v)}
                                label={t("Role")}
                                style={{ minWidth: "220px" }}
                            />
                        </ThemedView>
                        <VSelect
                            items={SCOPES.map((scope) => ({ title: scope, value: scope }))}
                            modelValue={form.value.appScopeIds}
                            onUpdate:modelValue={(v: string[]) => (form.value.appScopeIds = v)}
                            label={t("Scopes")}
                            multiple
                            chips
                            closable-chips
                        />
                        <VSelect
                            items={SCOPES.map((scope) => ({ title: `${scope}.*`, value: scope }))}
                            modelValue={form.value.authorities}
                            onUpdate:modelValue={(v: string[]) => (form.value.authorities = v)}
                            label={t("Authorities")}
                            multiple
                            chips
                            closable-chips
                        />
                        <VBtn
                            color="primary"
                            loading={actionLoading.value}
                            disabled={
                                !editing.value &&
                                (!form.value.email.trim() || form.value.password.trim().length < 10)
                            }
                            onClick={() => void save()}
                        >
                            {t("Save")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default TeamPage;
