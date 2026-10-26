import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VSelect, VTextField, VSwitch } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import type { WizardStepProps } from "./StepIdentity";

const listToString = (list: string[]) => (list ?? []).join(", ");
const stringToList = (value: string) =>
    value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => !!entry);

export const StepEnvironments = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const checking = ref(false);
        const checkResult = ref<string | null>(null);
        const checkError = ref<string | null>(null);

        const updateEnvironment = (index: number, patch: Partial<WizardStepProps["model"]["environments"][number]>) => {
            const environments = props.model.environments.map((environment, envIndex) =>
                envIndex === index ? { ...environment, ...patch } : environment,
            );
            props.onChange({ ...props.model, environments });
        };

        const updateAuth = (patch: Partial<WizardStepProps["model"]["auth"]>) => {
            props.onChange({ ...props.model, auth: { ...props.model.auth, ...patch } });
        };

        const updateCredential = (index: number, patch: Partial<WizardStepProps["model"]["credentialSets"][number]>) => {
            const credentialSets = props.model.credentialSets.map((credential, credentialIndex) =>
                credentialIndex === index ? { ...credential, ...patch } : credential,
            );
            props.onChange({ ...props.model, credentialSets });
        };

        const addCredential = () => {
            props.onChange({
                ...props.model,
                credentialSets: [
                    ...props.model.credentialSets,
                    {
                        label: "",
                        ownerType: "PLATFORM",
                        settlementTarget: "PLATFORM_CLEARING",
                        env: "SANDBOX",
                        secret: "",
                        secretRef: "",
                    },
                ],
            });
        };

        const runCredentialCheck = async () => {
            checking.value = true;
            checkResult.value = null;
            checkError.value = null;
            try {
                const response = await api.post(urlsMap.gatewayVersionDryRun(props.model.versionId ?? ""), {
                    phase: "CREDENTIAL_CHECK",
                    credentialSets: props.model.credentialSets.map((credential) => ({
                        label: credential.label,
                        env: credential.env,
                        ownerType: credential.ownerType,
                        secretRef: credential.secretRef,
                    })),
                });
                const payload = response.data?.data ?? response.data ?? {};
                checkResult.value = payload.message ?? "CREDENTIAL_CHECK completed";
            } catch (e) {
                checkError.value = extractApiErrorMessage(e);
            } finally {
                checking.value = false;
            }
        };

        return () => (
            <ThemedView style={{ gap: "16px" }}>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Environments & Auth")}
                        </ThemedText>

                        {props.model.environments.map((environment, index) => (
                            <ThemedView
                                key={environment.env}
                                style={{
                                    flexDirection: "row",
                                    gap: "14px",
                                    flexWrap: "wrap",
                                    border: "1px solid rgba(100,116,139,0.2)",
                                    borderRadius: "12px",
                                    padding: "14px",
                                }}
                            >
                                <ThemedView style={{ gap: "10px", minWidth: "180px" }}>
                                    <ThemedText type="defaultSemiBold">{environment.env}</ThemedText>
                                    <VSwitch
                                        label={t("Enabled")}
                                        modelValue={environment.enabled}
                                        onUpdate:modelValue={(v: boolean | null) => updateEnvironment(index, { enabled: !!v })}
                                        density="compact"
                                        hideDetails
                                    />
                                </ThemedView>
                                <VTextField
                                    label={t("Base URL")}
                                    modelValue={environment.baseUrl}
                                    onUpdate:modelValue={(v: string) => updateEnvironment(index, { baseUrl: v })}
                                    style={{ minWidth: "280px" }}
                                />
                                <VTextField
                                    label={t("Allowed Hosts")}
                                    modelValue={listToString(environment.allowedHosts)}
                                    onUpdate:modelValue={(v: string) =>
                                        updateEnvironment(index, { allowedHosts: stringToList(v) })
                                    }
                                    style={{ minWidth: "240px" }}
                                />
                                <VTextField
                                    label={t("Inbound IP Allowlist")}
                                    modelValue={listToString(environment.inboundIpAllowlist)}
                                    onUpdate:modelValue={(v: string) =>
                                        updateEnvironment(index, { inboundIpAllowlist: stringToList(v) })
                                    }
                                    style={{ minWidth: "240px" }}
                                />
                            </ThemedView>
                        ))}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold">{t("Auth Method")}</ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "14px", flexWrap: "wrap" }}>
                            <VSelect
                                items={[
                                    "NONE",
                                    "API_KEY",
                                    "PERMANENT_TOKEN",
                                    "TOKEN_ENDPOINT",
                                    "REFRESH_TOKEN",
                                    "USERNAME_PASSWORD",
                                    "BASIC",
                                    "REQUEST_SIGNATURE",
                                    "OAUTH2_CLIENT_CREDENTIALS",
                                    "MUTUAL_TLS",
                                ]}
                                modelValue={props.model.auth.method}
                                onUpdate:modelValue={(v: any) => updateAuth({ method: v })}
                                label={t("Auth Method")}
                                style={{ minWidth: "260px" }}
                            />
                            <VTextField
                                label="username"
                                modelValue={props.model.auth.username}
                                onUpdate:modelValue={(v: string) => updateAuth({ username: v })}
                                style={{ minWidth: "200px" }}
                            />
                            <VTextField
                                label="key_ref"
                                modelValue={props.model.auth.keyRef}
                                onUpdate:modelValue={(v: string) => updateAuth({ keyRef: v })}
                                style={{ minWidth: "200px" }}
                            />
                            <VTextField
                                label="token_url"
                                modelValue={props.model.auth.tokenUrl}
                                onUpdate:modelValue={(v: string) => updateAuth({ tokenUrl: v })}
                                style={{ minWidth: "260px" }}
                            />
                            <VTextField
                                label="client_id_ref"
                                modelValue={props.model.auth.clientIdRef}
                                onUpdate:modelValue={(v: string) => updateAuth({ clientIdRef: v })}
                                style={{ minWidth: "200px" }}
                            />
                            <VTextField
                                label="client_secret_ref"
                                modelValue={props.model.auth.clientSecretRef}
                                onUpdate:modelValue={(v: string) => updateAuth({ clientSecretRef: v })}
                                style={{ minWidth: "200px" }}
                            />
                        </ThemedView>
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                            <ThemedText type="defaultSemiBold">{t("Write Only")}</ThemedText>
                            <VBtn variant="tonal" size="small" onClick={addCredential}>
                                {t("Add")}
                            </VBtn>
                        </ThemedView>

                        {props.model.credentialSets.map((credential, index) => (
                            <ThemedView
                                key={index}
                                style={{
                                    flexDirection: "row",
                                    gap: "12px",
                                    flexWrap: "wrap",
                                    alignItems: "center",
                                    borderBottom: "1px solid rgba(100,116,139,0.18)",
                                    paddingBottom: "10px",
                                }}
                            >
                                <StatusChip label={t("Write Only")} tone="warning" />
                                <VTextField
                                    label={t("Token Name")}
                                    modelValue={credential.label}
                                    onUpdate:modelValue={(v: string) => updateCredential(index, { label: v })}
                                    style={{ minWidth: "180px" }}
                                />
                                <VSelect
                                    items={["PLATFORM", "MERCHANT"]}
                                    modelValue={credential.ownerType}
                                    onUpdate:modelValue={(v: any) => updateCredential(index, { ownerType: v })}
                                    label={t("Owner")}
                                    style={{ minWidth: "160px" }}
                                />
                                <VSelect
                                    items={["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]}
                                    modelValue={credential.settlementTarget}
                                    onUpdate:modelValue={(v: any) => updateCredential(index, { settlementTarget: v })}
                                    label={t("Settlement Target")}
                                    style={{ minWidth: "200px" }}
                                />
                                <VSelect
                                    items={["SANDBOX", "LIVE"]}
                                    modelValue={credential.env}
                                    onUpdate:modelValue={(v: any) => updateCredential(index, { env: v })}
                                    label={t("Environment")}
                                    style={{ minWidth: "150px" }}
                                />
                                <VTextField
                                    label={t("Secret")}
                                    type="password"
                                    modelValue={credential.secret}
                                    onUpdate:modelValue={(v: string) => updateCredential(index, { secret: v })}
                                    style={{ minWidth: "220px" }}
                                />
                                <VTextField
                                    label="secret_ref"
                                    modelValue={credential.secretRef}
                                    onUpdate:modelValue={(v: string) => updateCredential(index, { secretRef: v })}
                                    style={{ minWidth: "180px" }}
                                />
                            </ThemedView>
                        ))}

                        <ThemedView style={{ flexDirection: "row", gap: "12px", alignItems: "center" }}>
                            <VBtn color="primary" loading={checking.value} onClick={() => void runCredentialCheck()}>
                                {t("Credential Check")}
                            </VBtn>
                            {checkResult.value && (
                                <VAlert type="success" variant="tonal" density="compact" style={{ flex: 1 }}>
                                    {checkResult.value}
                                </VAlert>
                            )}
                            {checkError.value && (
                                <VAlert type="error" variant="tonal" density="compact" style={{ flex: 1 }}>
                                    {checkError.value}
                                </VAlert>
                            )}
                        </ThemedView>
                    </VCardText>
                </VCard>
            </ThemedView>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepEnvironments;
