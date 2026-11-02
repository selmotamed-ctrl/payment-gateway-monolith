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
type CredentialSet = {
    id: string;
    label: string;
    gatewayCode: string;
    env: "SANDBOX" | "LIVE";
    ownerType: "PLATFORM" | "MERCHANT";
    settlementTarget: "PLATFORM_CLEARING" | "MERCHANT_DIRECT" | "PROVIDER_HELD";
    status: string;
    lastCheckedAt: string | null;
    checkResult: string | null;
    hasSecret: boolean;
};

const CredentialsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<CredentialSet[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const editing = ref<CredentialSet | null>(null);
    const form = ref({
        label: "",
        gatewayCode: "",
        env: "SANDBOX" as "SANDBOX" | "LIVE",
        settlementTarget: "MERCHANT_DIRECT" as CredentialSet["settlementTarget"],
        username: "",
        secret: "",
        secretRef: "",
    });
    const actionLoading = ref(false);
    const formError = ref("");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.credentialSetsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.credentialSets ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openDialog = (row: CredentialSet | null) => {
        editing.value = row;
        formError.value = "";
        form.value = {
            label: row?.label ?? "",
            gatewayCode: row?.gatewayCode ?? "",
            env: row?.env ?? "SANDBOX",
            settlementTarget: row?.settlementTarget ?? "MERCHANT_DIRECT",
            username: "",
            secret: "",
            secretRef: "",
        };
        dialogOpen.value = true;
    };

    const save = async () => {
        actionLoading.value = true;
        formError.value = "";
        try {
            const entries = [
                ...(form.value.username
                    ? [{ key: "username", type: "BODY", value: form.value.username, isSecret: false }]
                    : []),
                ...(form.value.secret
                    ? [{ key: "secret", type: "BODY", value: form.value.secret, isSecret: true }]
                    : []),
                ...(form.value.secretRef
                    ? [{ key: "secretRef", type: "BODY", value: form.value.secretRef, isSecret: true }]
                    : []),
            ];
            const entryFields = entries.length ? { entries } : {};
            if (editing.value) {
                await api.put(urlsMap.credentialSetDetail(editing.value.id), entryFields);
            } else {
                await api.post(urlsMap.credentialSetsList, {
                    name: form.value.label,
                    gatewayCode: form.value.gatewayCode,
                    env: form.value.env,
                    settlementTarget: form.value.settlementTarget,
                    ...entryFields,
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

    const headers: TableHeader<CredentialSet>[] = [
        { key: "label", label: "Credential Name", value: (row) => row.label },
        { key: "gatewayCode", label: "Gateway Code", value: (row) => row.gatewayCode },
        { key: "env", label: "Environment", value: (row) => row.env },
        { key: "settlementTarget", label: "Settlement Target", value: (row) => row.settlementTarget },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: CredentialSet }) => (
                <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        {
            key: "hasSecret",
            label: "Secret",
            Value: ({ row }: { row: CredentialSet }) => (
                <StatusBadge
                    status={row.hasSecret ? "WRITE_ONLY" : "NONE"}
                    label={row.hasSecret ? t("Write Only") : "-"}
                    toneOverride={row.hasSecret ? "warning" : "neutral"}
                />
            ),
        },
        { key: "lastCheckedAt", label: "Last Used", value: (row) => row.lastCheckedAt ?? "-" },
        { key: "checkResult", label: "Credential Check", value: (row) => row.checkResult ?? "-" },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: CredentialSet }) => (
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

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Merchant Credentials")}
                    subtitle={t("Gateway credential sets and rotation posture.")}
                    end={() => (
                        <VBtn variant="tonal" onClick={() => openDialog(null)}>
                            {t("Create")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Merchant Credentials")}
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
                title={editing.value ? t("Edit Credential") : t("Create Credential")}
                size="md"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Save")}
                onSubmit={() => void save()}
            >
                <SectionFields title={t("Details")}>
                    <FormField label={t("Credential Name")} required>
                        <VTextField
                            modelValue={form.value.label}
                            onUpdate:modelValue={(v: string) => (form.value.label = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Gateway Code")} required>
                        <VTextField
                            modelValue={form.value.gatewayCode}
                            onUpdate:modelValue={(v: string) => (form.value.gatewayCode = v)}
                            disabled={!!editing.value}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Environment")} required>
                        <VSelect
                            items={["SANDBOX", "LIVE"]}
                            modelValue={form.value.env}
                            onUpdate:modelValue={(v: any) => (form.value.env = v)}
                            disabled={!!editing.value}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Settlement Target")} required>
                        <VSelect
                            items={["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]}
                            modelValue={form.value.settlementTarget}
                            onUpdate:modelValue={(v: any) => (form.value.settlementTarget = v)}
                            disabled={!!editing.value}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Secret")}>
                    <FormField label={t("Username")}>
                        <VTextField
                            modelValue={form.value.username}
                            onUpdate:modelValue={(v: string) => (form.value.username = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Secret")} hint={t("Write Only")}>
                        <VTextField
                            type="password"
                            modelValue={form.value.secret}
                            onUpdate:modelValue={(v: string) => (form.value.secret = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Secret Reference")}>
                        <VTextField
                            modelValue={form.value.secretRef}
                            onUpdate:modelValue={(v: string) => (form.value.secretRef = v)}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default CredentialsPage;
