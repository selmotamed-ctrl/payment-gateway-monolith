import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { areChecklistsVisible } from "@/constants/env";
import {PgAlert, PgButton, PgAutocomplete, PgSwitch, PgTextField} from "@pg/ui";
import {SurfaceCard, SurfaceCardText} from "@pg/ui";
import {FormField} from "@pg/ui";
import {FormChecklist} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { WizardSection } from "./WizardSection";
import type { WizardStepProps } from "./StepIdentity";

const CREDENTIAL_CHECKLIST = [
    { key: "CREDENTIAL_REFS_VERIFIED", label: "Credential references verified" },
    { key: "ENVIRONMENT_MATCH_REVIEWED", label: "Environment match reviewed" },
    { key: "SECRET_STORAGE_VERIFIED", label: "Secret storage verified" },
    { key: "CREDENTIAL_CHECK_APPROVED", label: "Credential check approved" },
] as const;

const listToString = (list: string[]) => (list ?? []).join(", ");
const stringToList = (value: string) =>
    value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => !!entry);

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "14px",
} as const;

export const StepEnvironments = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const showChecklists = areChecklistsVisible();
        const checking = ref(false);
        const credentialChecklist = ref<Record<string, boolean>>({});
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

        const credentialChecklistComplete = computed(() => !showChecklists || CREDENTIAL_CHECKLIST.every((check) => credentialChecklist.value[check.key] === true));

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
                    checklist: CREDENTIAL_CHECKLIST.filter((check) => credentialChecklist.value[check.key]).map((check) => check.key),
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
            <SurfaceCard title={t("Environments & Auth")}>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    {props.model.environments.map((environment, index) => (
                        <WizardSection
                            key={environment.env}
                            title={environment.env}
                            divider={index > 0}
                            v-slots={{
                                actions: () => (
                                    <StatusBadge
                                        status={environment.enabled ? "ACTIVE" : "DISABLED"}
                                        label={environment.enabled ? t("Enabled") : t("Inactive")}
                                    />
                                ),
                            }}
                        >
                            <div style={gridStyle}>
                                <FormField label={t("Base URL")}>
                                    <PgTextField
                                        modelValue={environment.baseUrl}
                                        onUpdate:modelValue={(v: string) => updateEnvironment(index, { baseUrl: v })}
                                    />
                                </FormField>
                                <FormField label={t("Allowed Hosts")}>
                                    <PgTextField
                                        modelValue={listToString(environment.allowedHosts)}
                                        onUpdate:modelValue={(v: string) =>
                                            updateEnvironment(index, { allowedHosts: stringToList(v) })
                                        }
                                    />
                                </FormField>
                                <FormField label={t("Inbound IP Allowlist")}>
                                    <PgTextField
                                        modelValue={listToString(environment.inboundIpAllowlist)}
                                        onUpdate:modelValue={(v: string) =>
                                            updateEnvironment(index, { inboundIpAllowlist: stringToList(v) })
                                        }
                                    />
                                </FormField>
                                <FormField label={t("Enabled")}>
                                    <PgSwitch
                                        modelValue={environment.enabled}
                                        onUpdate:modelValue={(v: boolean | null) => updateEnvironment(index, { enabled: !!v })}
                                        density="compact"
                                        hideDetails
                                    />
                                </FormField>
                            </div>
                        </WizardSection>
                    ))}

                    <WizardSection title={t("Auth Method")} divider>
                        <div style={gridStyle}>
                            <FormField label={t("Auth Method")}>
                                <PgAutocomplete
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
                                />
                            </FormField>
                            <FormField label="username">
                                <PgTextField
                                    modelValue={props.model.auth.username}
                                    onUpdate:modelValue={(v: string) => updateAuth({ username: v })}
                                />
                            </FormField>
                            <FormField label="key_ref" sensitiveMakerChecker>
                                <PgTextField
                                    modelValue={props.model.auth.keyRef}
                                    onUpdate:modelValue={(v: string) => updateAuth({ keyRef: v })}
                                />
                            </FormField>
                            <FormField label="token_url">
                                <PgTextField
                                    modelValue={props.model.auth.tokenUrl}
                                    onUpdate:modelValue={(v: string) => updateAuth({ tokenUrl: v })}
                                />
                            </FormField>
                            <FormField label="client_id_ref">
                                <PgTextField
                                    modelValue={props.model.auth.clientIdRef}
                                    onUpdate:modelValue={(v: string) => updateAuth({ clientIdRef: v })}
                                />
                            </FormField>
                            <FormField label="client_secret_ref" sensitiveMakerChecker>
                                <PgTextField
                                    modelValue={props.model.auth.clientSecretRef}
                                    onUpdate:modelValue={(v: string) => updateAuth({ clientSecretRef: v })}
                                />
                            </FormField>
                        </div>
                    </WizardSection>

                    <WizardSection
                        title={t("Write Only")}
                        divider
                        v-slots={{
                            actions: () => (
                                <PgButton variant="tonal" size="small" onClick={addCredential}>
                                    {t("Add")}
                                </PgButton>
                            ),
                        }}
                    >
                        {props.model.credentialSets.map((credential, index) => (
                            <WizardSection
                                key={index}
                                title={credential.label || `${t("Write Only")} ${index + 1}`}
                                divider={index > 0}
                                v-slots={{
                                    actions: () => (
                                        <StatusBadge
                                            status={credential.env}
                                            toneOverride={credential.env === "LIVE" ? "warning" : "info"}
                                        />
                                    ),
                                }}
                            >
                                <div style={gridStyle}>
                                    <FormField label={t("Token Name")}>
                                        <PgTextField
                                            modelValue={credential.label}
                                            onUpdate:modelValue={(v: string) => updateCredential(index, { label: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Owner")}>
                                        <PgAutocomplete
                                            items={["PLATFORM", "MERCHANT"]}
                                            modelValue={credential.ownerType}
                                            onUpdate:modelValue={(v: any) => updateCredential(index, { ownerType: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Settlement Target")}>
                                        <PgAutocomplete
                                            items={["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"]}
                                            modelValue={credential.settlementTarget}
                                            onUpdate:modelValue={(v: any) => updateCredential(index, { settlementTarget: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Environment")}>
                                        <PgAutocomplete
                                            items={["SANDBOX", "LIVE"]}
                                            modelValue={credential.env}
                                            onUpdate:modelValue={(v: any) => updateCredential(index, { env: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("Secret")} sensitiveMakerChecker>
                                        <PgTextField
                                            type="password"
                                            modelValue={credential.secret}
                                            onUpdate:modelValue={(v: string) => updateCredential(index, { secret: v })}
                                        />
                                    </FormField>
                                    <FormField label="secret_ref" sensitiveMakerChecker>
                                        <PgTextField
                                            modelValue={credential.secretRef}
                                            onUpdate:modelValue={(v: string) => updateCredential(index, { secretRef: v })}
                                        />
                                    </FormField>
                                </div>
                            </WizardSection>
                        ))}

                        <FormChecklist
                            checks={CREDENTIAL_CHECKLIST.map((check) => ({ key: check.key, label: check.label }))}
                            modelValue={credentialChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (credentialChecklist.value = value)}
                            show={showChecklists}
                            title={t("Credential check checklist")}
                            incompleteMessage={t("Complete all credential check items before running the check")}
                            complete={credentialChecklistComplete.value}
                        />

                        <div style={{ display: "flex", flexDirection: "row", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                            <PgButton color="primary" loading={checking.value} disabled={!credentialChecklistComplete.value} onClick={() => void runCredentialCheck()}>
                                {t("Credential Check")}
                            </PgButton>
                            {checkResult.value && (
                                <PgAlert tone="success" density="compact" style={{ flex: 1, minWidth: "220px" }}>
                                    {checkResult.value}
                                </PgAlert>
                            )}
                            {checkError.value && (
                                <PgAlert tone="danger" density="compact" style={{ flex: 1, minWidth: "220px" }}>
                                    {checkError.value}
                                </PgAlert>
                            )}
                        </div>
                    </WizardSection>
                </SurfaceCardText>
            </SurfaceCard>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepEnvironments;
