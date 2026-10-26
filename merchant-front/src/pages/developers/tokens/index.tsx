import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VTextField } from "vuetify/components";
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
import { copyToClipboard } from "@/utils/common";

type AccessToken = {
    id: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    ipWhitelistEnabled: boolean;
    ipAllowlist: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
};

const DeveloperTokensPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<AccessToken[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const createOpen = ref(false);
    const form = ref({ name: "", scopes: "", ipWhitelistEnabled: false, ipAllowlist: "" });
    const createdSecret = ref<string | null>(null);
    const actionLoading = ref(false);

    const ipOpen = ref(false);
    const activeToken = ref<AccessToken | null>(null);
    const ipList = ref("");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.tokensList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.tokens ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const createToken = async () => {
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.tokensList, {
                name: form.value.name,
                scopes: form.value.scopes
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => !!entry),
                ipWhitelistEnabled: form.value.ipWhitelistEnabled,
                ipAllowlist: form.value.ipAllowlist
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => !!entry),
            });
            const payload = response.data?.data ?? response.data ?? {};
            createdSecret.value = payload.token ?? payload.secret ?? null;
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Created") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const revoke = async (token: AccessToken) => {
        try {
            await api.delete(urlsMap.tokenDetail(token.id));
            showSnackBar({ type: "success", message: t("Revoke") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const saveIps = async () => {
        if (!activeToken.value) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.put(urlsMap.tokenIps(activeToken.value.id), {
                ipAllowlist: ipList.value
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => !!entry),
            });
            ipOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<AccessToken>[] = [
        { key: "name", label: "Token Name", value: (row) => row.name },
        { key: "tokenPrefix", label: "Token Prefix", value: (row) => row.tokenPrefix },
        { key: "scopes", label: "Scopes", value: (row) => (row.scopes ?? []).join(", ") },
        {
            key: "ipWhitelistEnabled",
            label: "IP Whitelist",
            Value: ({ row }: { row: AccessToken }) => (
                <StatusChip label={row.ipWhitelistEnabled ? t("On") : t("Off")} tone={row.ipWhitelistEnabled ? "success" : "neutral"} />
            ),
        },
        { key: "ipAllowlist", label: "CIDR", value: (row) => (row.ipAllowlist ?? []).join(", ") || "-" },
        { key: "lastUsedAt", label: "Last Used", value: (row) => row.lastUsedAt ?? t("Never") },
        { key: "expiresAt", label: "Expires", value: (row) => row.expiresAt ?? t("Never") },
        {
            key: "revokedAt",
            label: "Status",
            Value: ({ row }: { row: AccessToken }) => (
                <StatusChip label={row.revokedAt ? t("Inactive") : t("Active")} tone={row.revokedAt ? "neutral" : "success"} />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: AccessToken }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                    <VBtn
                        size="small"
                        variant="tonal"
                        onClick={() => {
                            activeToken.value = row;
                            ipList.value = (row.ipAllowlist ?? []).join(", ");
                            ipOpen.value = true;
                        }}
                    >
                        {t("IP Whitelist")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" color="error" disabled={!!row.revokedAt} onClick={() => void revoke(row)}>
                        {t("Revoke")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Developer Tokens")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                form.value = { name: "", scopes: "", ipWhitelistEnabled: false, ipAllowlist: "" };
                                createOpen.value = true;
                            }}
                        >
                            {t("Create Token")}
                        </VBtn>
                    )}
                />

                {createdSecret.value && (
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Secret")}</ThemedText>
                            <ThemedText style={{ direction: "ltr", wordBreak: "break-all" }}>{createdSecret.value}</ThemedText>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>
                                {t("This secret is shown once. Store it securely.")}
                            </ThemedText>
                            <VBtn
                                variant="tonal"
                                size="small"
                                style={{ alignSelf: "flex-start" }}
                                onClick={() => {
                                    copyToClipboard(createdSecret.value!);
                                    showSnackBar({ type: "success", message: t("Copied") });
                                }}
                            >
                                {t("Copy")}
                            </VBtn>
                        </VCardText>
                    </VCard>
                )}

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Developer Tokens")}
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

            <VDialog v-model={createOpen.value} maxWidth="560px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <VTextField
                            label={t("Token Name")}
                            modelValue={form.value.name}
                            onUpdate:modelValue={(v: string) => (form.value.name = v)}
                        />
                        <VTextField
                            label={t("Scopes")}
                            modelValue={form.value.scopes}
                            onUpdate:modelValue={(v: string) => (form.value.scopes = v)}
                            hint="Comma separated, e.g. links.create,payments.read"
                            persistentHint
                        />
                        <VTextField
                            label={t("IP Whitelist")}
                            modelValue={form.value.ipAllowlist}
                            onUpdate:modelValue={(v: string) => (form.value.ipAllowlist = v)}
                            hint="Comma separated CIDR ranges"
                            persistentHint
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void createToken()}>
                            {t("Create Token")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog v-model={ipOpen.value} maxWidth="520px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{activeToken.value?.name}</ThemedText>
                        <VTextField
                            label="CIDR"
                            modelValue={ipList.value}
                            onUpdate:modelValue={(v: string) => (ipList.value = v)}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void saveIps()}>
                            {t("Save")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default DeveloperTokensPage;
