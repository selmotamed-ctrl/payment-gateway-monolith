import { dc } from "@/utils/dc";
import { ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {PgTextField, PgTextarea, PgStack} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import {PageHeader} from "@pg/ui";
import {StateView} from "@pg/ui";
import { DataTable } from "@/tables/DataTable";
import {TableRowActions} from "@pg/ui";
import type { TableHeader } from "@pg/ui";
import {SectionFields} from "@pg/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import {FormModal} from "@pg/ui";
import {FormField} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {MoneyDisplay} from "@pg/ui";
import {MonoRef} from "@pg/ui";
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
    const formError = ref("");

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
        formError.value = "";
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
        formError.value = "";
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
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<Application>[] = [
        { key: "name", label: "Application Name", value: (row) => row.name },
        { key: "businessUseDescription", label: "Sales Channel Description", value: (row) => row.businessUseDescription },
        {
            key: "expectedMonthlyVolume",
            label: "Expected Monthly Volume",
            Value: ({ row }: { row: Application }) => (
                <MoneyDisplay amount={row.expectedMonthlyVolume} currency={row.currency} size="sm" />
            ),
        },
        {
            key: "assignedWalletId",
            label: "Wallet",
            Value: ({ row }: { row: Application }) => <MonoRef value={row.assignedWalletId} truncate={14} />,
        },
        {
            key: "railWhitelist",
            label: "Rail Whitelist",
            value: (row) => (row.railWhitelist?.length ? row.railWhitelist.join(", ") : t("All")),
        },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Application }) => (
                <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        {
            key: "pendingChange",
            label: "Pending",
            Value: ({ row }: { row: Application }) =>
                row.pendingChange ? (
                    <StatusBadge status="PENDING" label={t("Pending")} />
                ) : (
                    <StatusBadge status="APPROVED" label={t("Approved")} />
                ),
        },
        { key: "pendingApprovalReason", label: "Reason", value: (row) => row.pendingApprovalReason ?? "-" },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Application }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Edit"),
                        icon: "mdi-pencil-outline",
                        onClick: () => openDialog(row, "DESCRIPTIVE"),
                    }}
                    items={[
                        {
                            key: "propose",
                            label: t("Propose"),
                            icon: "mdi-file-edit-outline",
                            onClick: () => openDialog(row, "SENSITIVE"),
                        },
                    ]}
                />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <PgStack gap="lg">
                <PageHeader
                    title={t("Applications")}
                    subtitle={t("Payment applications, environments, and configuration.")}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
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
                )}
            </PgStack>

            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={selected.value?.name ?? t("Application")}
                size="md"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={mode.value === "DESCRIPTIVE" ? t("Save Changes") : t("Propose")}
                onSubmit={() => void submit()}
            >
                {mode.value === "DESCRIPTIVE" ? (
                    <SectionFields title={t("Profile")}>
                        <FormField label={t("Application Name")} required>
                            <PgTextField
                                modelValue={descriptive.value.name}
                                onUpdate:modelValue={(v: string) => (descriptive.value.name = v)}
                                hideDetails
                            />
                        </FormField>
                        <FormField label={t("Sales Channel Description")}>
                            <PgTextarea
                                modelValue={descriptive.value.businessUseDescription}
                                onUpdate:modelValue={(v: string) => (descriptive.value.businessUseDescription = v)}
                                rows={3}
                                hideDetails
                            />
                        </FormField>
                        <FormField label={t("Expected Monthly Volume")}>
                            <PgTextField
                                modelValue={descriptive.value.expectedMonthlyVolume}
                                onUpdate:modelValue={(v: string) => (descriptive.value.expectedMonthlyVolume = v)}
                                hideDetails
                            />
                        </FormField>
                    </SectionFields>
                ) : (
                    <SectionFields title={t("Details")}>
                        <FormField label={t("Assigned Wallet ID")} hint={t("Wallet that receives settlements for this application.")}>
                            <PgTextField
                                modelValue={sensitive.value.assignedWalletId}
                                onUpdate:modelValue={(v: string) => (sensitive.value.assignedWalletId = v)}
                                hideDetails
                            />
                        </FormField>
                        <FormField label={t("Rail Whitelist")} hint={t("Comma separated, empty means all rails.")}>
                            <PgTextField
                                modelValue={sensitive.value.railWhitelist}
                                onUpdate:modelValue={(v: string) => (sensitive.value.railWhitelist = v)}
                                hideDetails
                            />
                        </FormField>
                        <FormField label={t("Redirect Domain Allowlist")} hint={t("Comma separated domains.")}>
                            <PgTextField
                                modelValue={sensitive.value.redirectDomainAllowlist}
                                onUpdate:modelValue={(v: string) => (sensitive.value.redirectDomainAllowlist = v)}
                                hideDetails
                            />
                        </FormField>
                        <FormField label={t("Reason")}>
                            <PgTextarea
                                modelValue={sensitive.value.reason}
                                onUpdate:modelValue={(v: string) => (sensitive.value.reason = v)}
                                rows={2}
                                hideDetails
                            />
                        </FormField>
                    </SectionFields>
                )}
            </FormModal>
        </ScreenContainer>
    );
});

export default ApplicationsPage;
