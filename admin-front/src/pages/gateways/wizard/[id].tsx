import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn, VChip, VStepper, VStepperHeader, VStepperItem, VStepperWindow, VStepperWindowItem } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { emptyDraft, type WizardDraft } from "@/components/gateway-wizard/types";
import { StepIdentity } from "@/components/gateway-wizard/StepIdentity";
import { StepEnvironments } from "@/components/gateway-wizard/StepEnvironments";
import { StepCustomerCatalog } from "@/components/gateway-wizard/StepCustomerCatalog";
import { StepCryptoProfile } from "@/components/gateway-wizard/StepCryptoProfile";
import { StepFlowBuilder } from "@/components/gateway-wizard/StepFlowBuilder";
import { StepClientAction } from "@/components/gateway-wizard/StepClientAction";
import { StepStatusRules } from "@/components/gateway-wizard/StepStatusRules";
import { StepSimulator } from "@/components/gateway-wizard/StepSimulator";

const STEPS = [
    { key: "identity", title: "Identity & Basics" },
    { key: "environments", title: "Environments & Auth" },
    { key: "catalog", title: "Customer Catalog" },
    { key: "crypto", title: "Crypto Profiles" },
    { key: "flows", title: "Flow Builder" },
    { key: "channels", title: "Client Action & Channels" },
    { key: "status", title: "Status Rules & Costs" },
    { key: "simulator", title: "Simulator & Approval" },
];

const mergeDraft = (base: WizardDraft, payload: any): WizardDraft => {
    const next: WizardDraft = { ...base };
    const source = payload?.draft ?? payload?.version ?? payload ?? {};
    if (source.identity) {
        next.identity = { ...base.identity, ...source.identity };
    }
    if (source.environments) {
        next.environments = source.environments;
    }
    if (source.auth) {
        next.auth = { ...base.auth, ...source.auth };
    }
    if (source.credentialSets) {
        next.credentialSets = source.credentialSets;
    }
    if (source.rails) {
        next.rails = source.rails;
    }
    if (source.cryptoProfiles) {
        next.cryptoProfiles = source.cryptoProfiles;
    }
    if (source.flows) {
        next.flows = source.flows;
    }
    if (source.clientActions) {
        next.clientActions = source.clientActions;
    }
    if (source.confirmationChannels) {
        next.confirmationChannels = source.confirmationChannels;
    }
    if (source.pollPolicies) {
        next.pollPolicies = source.pollPolicies;
    }
    if (source.statusRules) {
        next.statusRules = source.statusRules;
    }
    if (source.errorMaps) {
        next.errorMaps = source.errorMaps;
    }
    if (source.amountPipeline) {
        next.amountPipeline = { ...base.amountPipeline, ...source.amountPipeline };
    }
    if (source.costModel) {
        next.costModel = { ...base.costModel, ...source.costModel };
    }
    if (source.statementMapping) {
        next.statementMapping = { ...base.statementMapping, ...source.statementMapping };
    }
    if (source.rollbackVersionId !== undefined) {
        next.rollbackVersionId = source.rollbackVersionId;
    }
    return next;
};

const GatewayWizardPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();

    const draft = ref<WizardDraft>(emptyDraft());
    const step = ref(1);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const saving = ref(false);
    const saveError = ref<string | null>(null);

    const versionId = computed(() => String(route.params.id ?? ""));

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.gatewayVersionDetail(versionId.value));
            const payload = response.data?.data ?? response.data ?? {};
            draft.value = mergeDraft(emptyDraft(), payload);
            draft.value.versionId = payload?.versionId ?? payload?.id ?? versionId.value;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    watch(versionId, () => {
        void load();
    });

    const saveStep = async (stepNumber: number) => {
        const vid = draft.value.versionId ?? versionId.value;
        saving.value = true;
        saveError.value = null;
        try {
            if (stepNumber === 1) {
                await api.put(urlsMap.gatewayVersionSettings(vid), { identity: draft.value.identity });
            } else if (stepNumber === 2) {
                await api.put(urlsMap.gatewayVersionEnvironments(vid), {
                    environments: draft.value.environments,
                    credentialSets: draft.value.credentialSets.map((credential) => ({
                        label: credential.label,
                        ownerType: credential.ownerType,
                        settlementTarget: credential.settlementTarget,
                        env: credential.env,
                        secret: credential.secret,
                        secretRef: credential.secretRef,
                    })),
                });
                await api.put(urlsMap.gatewayVersionAuth(vid), { auth: draft.value.auth });
            } else if (stepNumber === 3) {
                await api.put(urlsMap.gatewayVersionSettings(vid), { rails: draft.value.rails });
            } else if (stepNumber === 4) {
                await api.put(urlsMap.gatewayVersionCryptoProfiles(vid), {
                    cryptoProfiles: draft.value.cryptoProfiles,
                });
            } else if (stepNumber === 5) {
                await api.put(urlsMap.gatewayVersionFlows(vid), { flows: draft.value.flows });
            } else if (stepNumber === 6) {
                await api.put(urlsMap.gatewayVersionChannels(vid), {
                    clientActions: draft.value.clientActions,
                    confirmationChannels: draft.value.confirmationChannels,
                    pollPolicies: draft.value.pollPolicies,
                });
            } else if (stepNumber === 7) {
                await api.put(urlsMap.gatewayVersionStatusRules(vid), { statusRules: draft.value.statusRules });
                await api.put(urlsMap.gatewayVersionErrorMaps(vid), { errorMaps: draft.value.errorMaps });
                await api.put(urlsMap.gatewayVersionSettings(vid), {
                    amountPipeline: draft.value.amountPipeline,
                    costModel: draft.value.costModel,
                    statementMapping: draft.value.statementMapping,
                });
            }
            showSnackBar({ type: "success", message: t("Saved") });
            return true;
        } catch (e) {
            saveError.value = extractApiErrorMessage(e);
            showSnackBar({ type: "error", message: saveError.value });
            return false;
        } finally {
            saving.value = false;
        }
    };

    const onChange = (next: WizardDraft) => {
        draft.value = next;
    };

    const goNext = async () => {
        if (step.value < STEPS.length) {
            const ok = await saveStep(step.value);
            if (ok) {
                step.value += 1;
            }
        }
    };

    const goBack = () => {
        if (step.value > 1) {
            step.value -= 1;
        }
    };

    const stepProps = () => ({
        model: draft.value,
        onChange,
        onSave: () => saveStep(step.value),
        saving: saving.value,
        error: saveError.value,
    });

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Gateway Wizard")}
                    end={() => (
                        <VChip color="primary" variant="tonal" size="small">
                            {t("Step")} {step.value} {t("of Steps")} {STEPS.length}
                        </VChip>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <VStepper modelValue={step.value} onUpdate:modelValue={(v: any) => (step.value = v)} flat style={{ background: "transparent" }}>
                            <VStepperHeader>
                                {STEPS.map((item) => (
                                    <VStepperItem key={item.key} title={t(item.title)} value={STEPS.indexOf(item) + 1} />
                                ))}
                            </VStepperHeader>
                            <VStepperWindow>
                                <VStepperWindowItem value={1}>
                                    <StepIdentity {...stepProps()} />
                                </VStepperWindowItem>
                                <VStepperWindowItem value={2}>
                                    <StepEnvironments {...stepProps()} />
                                </VStepperWindowItem>
                                <VStepperWindowItem value={3}>
                                    <StepCustomerCatalog {...stepProps()} />
                                </VStepperWindowItem>
                                <VStepperWindowItem value={4}>
                                    <StepCryptoProfile {...stepProps()} />
                                </VStepperWindowItem>
                                <VStepperWindowItem value={5}>
                                    <StepFlowBuilder {...stepProps()} />
                                </VStepperWindowItem>
                                <VStepperWindowItem value={6}>
                                    <StepClientAction {...stepProps()} />
                                </VStepperWindowItem>
                                <VStepperWindowItem value={7}>
                                    <StepStatusRules {...stepProps()} />
                                </VStepperWindowItem>
                                <VStepperWindowItem value={8}>
                                    <StepSimulator {...stepProps()} />
                                </VStepperWindowItem>
                            </VStepperWindow>
                        </VStepper>

                        {saveError.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {saveError.value}
                            </VAlert>
                        )}

                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
                            <VBtn variant="tonal" disabled={step.value <= 1} onClick={goBack}>
                                {t("Back")}
                            </VBtn>
                            <ThemedView style={{ flexDirection: "row", gap: "10px" }}>
                                <VBtn
                                    variant="text"
                                    loading={saving.value}
                                    onClick={async () => {
                                        const ok = await saveStep(step.value);
                                        if (ok) {
                                            showSnackBar({ type: "success", message: t("Saved") });
                                        }
                                    }}
                                >
                                    {t("Save")}
                                </VBtn>
                                {step.value < STEPS.length && (
                                    <VBtn color="primary" loading={saving.value} onClick={() => void goNext()}>
                                        {t("Continue")}
                                    </VBtn>
                                )}
                                {step.value === STEPS.length && (
                                    <VBtn variant="text" onClick={() => void router.push({ name: "Gateways" })}>
                                        {t("Close")}
                                    </VBtn>
                                )}
                            </ThemedView>
                        </ThemedView>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default GatewayWizardPage;
