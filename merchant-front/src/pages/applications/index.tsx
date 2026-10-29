import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Application = {
    id: string;
    name: string;
    businessUseDescription: string;
    expectedMonthlyVolume: string;
    currency: string;
    assignedWalletId: string;
    railWhitelist: string[] | null;
    redirectDomainAllowlist: string[];
    status: string;
    pendingChange: boolean;
    pendingApprovalId: string | null;
    pendingApprovalReason: string | null;
    createdAt: string;
};

const ApplicationsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Application[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Application | null>(null);
    const mode = ref<"DESCRIPTIVE" | "SENSITIVE">("DESCRIPTIVE");
    const descriptive = ref({ name: "", businessUseDescription: "", expectedMonthlyVolume: "" });
    const sensitive = ref({ assignedWalletId: "", railWhitelist: "", redirectDomainAllowlist: "", reason: "" });
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.applicationsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.applications ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openDialog = (row: Application, nextMode: "DESCRIPTIVE" | "SENSITIVE") => {
        selected.value = row;
        mode.value = nextMode;
        descriptive.value = {
            name: row.name,
            businessUseDescription: row.businessUseDescription,
            expectedMonthlyVolume: row.expectedMonthlyVolume,
        };
        sensitive.value = {
            assignedWalletId: row.assignedWalletId ?? "",
            railWhitelist: (row.railWhitelist ?? []).join(", "),
            redirectDomainAllowlist: (row.redirectDomainAllowlist ?? []).join(", "),
            reason: "",
        };
        dialogOpen.value = true;
    };

    const submit = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            if (mode.value === "DESCRIPTIVE") {
                await api.patch(urlsMap.applicationPatch(selected.value.id), descriptive.value);
            } else {
                await api.patch(urlsMap.applicationPatch(selected.value.id), {
                    sensitive: {
                        assignedWalletId: sensitive.value.assignedWalletId,
                        railWhitelist: sensitive.value.railWhitelist
                            .split(",")
                            .map((entry) => entry.trim())
                            .filter((entry) => !!entry),
                        redirectDomainAllowlist: sensitive.value.redirectDomainAllowlist
                            .split(",")
                            .map((entry) => entry.trim())
                            .filter((entry) => !!entry),
                    },
                    reason: sensitive.value.reason,
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

    const headers: TableHeader<Application>[] = [
        { key: "name", label: "Merchant Name", value: (row) => row.name },
        { key: "businessUseDescription", label: "Sales Channel Description", value: (row) => row.businessUseDescription },
        {
            key: "expectedMonthlyVolume",
            label: "Expected Monthly Volume",
            value: (row) => `${row.expectedMonthlyVolume ?? ""} ${row.currency ?? ""}`,
        },
        { key: "assignedWalletId", label: "Wallet Balance", value: (row) => row.assignedWalletId ?? "-" },
        {
            key: "railWhitelist",
            label: "Rail Whitelist",
            value: (row) => (row.railWhitelist?.length ? row.railWhitelist.join(", ") : t("All")),
        },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Application }) => (
                <StatusChip label={row.status} tone={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        {
            key: "pendingChange",
            label: "Pending",
            Value: ({ row }: { row: Application }) =>
                row.pendingChange ? (
                    <StatusChip label={t("Pending")} tone="warning" />
                ) : (
                    <StatusChip label={t("Approved")} tone="success" />
                ),
        },
        { key: "pendingApprovalReason", label: "Reason", value: (row) => row.pendingApprovalReason ?? "-" },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Application }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                    <VBtn size="small" variant="tonal" onClick={() => openDialog(row, "DESCRIPTIVE")}>
                        {t("Edit")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" color="warning" onClick={() => openDialog(row, "SENSITIVE")}>
                        {t("Propose")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Applications")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Applications")}
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

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="620px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {selected.value?.name}
                        </ThemedText>

                        {mode.value === "DESCRIPTIVE" ? (
                            <>
                                <VTextField
                                    label={t("Merchant Name")}
                                    modelValue={descriptive.value.name}
                                    onUpdate:modelValue={(v: string) => (descriptive.value.name = v)}
                                />
                                <VTextarea
                                    label={t("Sales Channel Description")}
                                    modelValue={descriptive.value.businessUseDescription}
                                    onUpdate:modelValue={(v: string) => (descriptive.value.businessUseDescription = v)}
                                    rows={3}
                                />
                                <VTextField
                                    label={t("Expected Monthly Volume")}
                                    modelValue={descriptive.value.expectedMonthlyVolume}
                                    onUpdate:modelValue={(v: string) => (descriptive.value.expectedMonthlyVolume = v)}
                                />
                            </>
                        ) : (
                            <>
                                <VTextField
                                    label="assigned_wallet_id"
                                    modelValue={sensitive.value.assignedWalletId}
                                    onUpdate:modelValue={(v: string) => (sensitive.value.assignedWalletId = v)}
                                />
                                <VTextField
                                    label={t("Rail Whitelist")}
                                    modelValue={sensitive.value.railWhitelist}
                                    onUpdate:modelValue={(v: string) => (sensitive.value.railWhitelist = v)}
                                    hint="Comma separated, empty means all rails"
                                    persistentHint
                                />
                                <VTextField
                                    label="redirect_domain_allowlist"
                                    modelValue={sensitive.value.redirectDomainAllowlist}
                                    onUpdate:modelValue={(v: string) => (sensitive.value.redirectDomainAllowlist = v)}
                                    hint="Comma separated domains"
                                    persistentHint
                                />
                                <VTextarea
                                    label={t("Reason")}
                                    modelValue={sensitive.value.reason}
                                    onUpdate:modelValue={(v: string) => (sensitive.value.reason = v)}
                                    rows={2}
                                />
                            </>
                        )}

                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void submit()}>
                            {mode.value === "DESCRIPTIVE" ? t("Save Changes") : t("Propose")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default ApplicationsPage;
