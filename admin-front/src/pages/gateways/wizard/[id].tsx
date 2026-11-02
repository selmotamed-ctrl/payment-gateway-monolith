import { dc } from "kt-dc";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { VAlert, VBtn } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { emptyDraft, type WizardDraft } from "@/components/gateway-wizard/types";
import { StepBar } from "@/components/gateway-wizard/StepBar";
import { StepIdentity } from "@/components/gateway-wizard/StepIdentity";
import { StepEnvironments } from "@/components/gateway-wizard/StepEnvironments";
import { StepCustomerCatalog } from "@/components/gateway-wizard/StepCustomerCatalog";
import { StepCryptoProfile } from "@/components/gateway-wizard/StepCryptoProfile";
import { StepFlowBuilder } from "@/components/gateway-wizard/StepFlowBuilder";
import { StepClientAction } from "@/components/gateway-wizard/StepClientAction";
import { StepStatusRules } from "@/components/gateway-wizard/StepStatusRules";
import { StepSimulator } from "@/components/gateway-wizard/StepSimulator";

import { MetaPill } from "@/components/ui/MetaPill";
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
    if (Array.isArray(source.environments) && source.environments.length > 0) {
        next.environments = source.environments;
    }
    if (source.auth) {
        next.auth = { ...base.auth, ...source.auth };
    }
    if (Array.isArray(source.credentialSets) && source.credentialSets.length > 0) {
        next.credentialSets = source.credentialSets;
    }
    if (Array.isArray(source.rails) && source.rails.length > 0) {
        next.rails = source.rails;
    }
    if (Array.isArray(source.cryptoProfiles) && source.cryptoProfiles.length > 0) {
        next.cryptoProfiles = source.cryptoProfiles;
    }
    if (Array.isArray(source.flows) && source.flows.length > 0) {
        next.flows = source.flows;
    }
    if (Array.isArray(source.clientActions) && source.clientActions.length > 0) {
        next.clientActions = source.clientActions;
    }
    if (Array.isArray(source.confirmationChannels) && source.confirmationChannels.length > 0) {
        next.confirmationChannels = source.confirmationChannels;
    }
    if (Array.isArray(source.pollPolicies) && source.pollPolicies.length > 0) {
        next.pollPolicies = source.pollPolicies;
    }
    if (Array.isArray(source.statusRules) && source.statusRules.length > 0) {
        next.statusRules = source.statusRules;
    }
    if (Array.isArray(source.errorMaps) && source.errorMaps.length > 0) {
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
    const dirty = ref(false);
    const gatewayCode = ref("");
    const gatewayName = ref("");
    const versionNumber = ref<number | null>(null);
    const versionState = ref("");

    const gatewayId = computed(() => String(route.params.id ?? ""));
    const versionId = ref("");

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!dirty.value) return;
        event.preventDefault();
        event.returnValue = "";
    };

    onMounted(() => window.addEventListener("beforeunload", warnBeforeUnload));
    onUnmounted(() => window.removeEventListener("beforeunload", warnBeforeUnload));

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const gatewayResponse = await api.get(urlsMap.gatewayDetail(gatewayId.value));
            const gatewayPayload = gatewayResponse.data?.data ?? gatewayResponse.data ?? {};
            const gateway = gatewayPayload.gateway ?? gatewayPayload;
            gatewayCode.value = String(gateway.code ?? "");
            gatewayName.value = String(gateway.name ?? "");
            const versions: any[] = Array.isArray(gateway.versions) ? gateway.versions : [];
            const newestFirst = [...versions].sort(
                (left, right) => (right.versionNumber ?? 0) - (left.versionNumber ?? 0),
            );
            let version = newestFirst.find((entry) => entry.state === "DRAFT");
            const sourceVersion =
                versions.find((entry) => entry.id === gateway.activeVersionId) ?? newestFirst[0];

            if (!version?.id && sourceVersion?.id) {
                const cloned = await api.post(urlsMap.gatewayVersionClone(String(sourceVersion.id)), {
                    changelog: `Wizard draft cloned from v${sourceVersion.versionNumber ?? "?"}`,
                });
                const clonedPayload = cloned.data?.data ?? cloned.data ?? {};
                version = {
                    id: clonedPayload.id,
                    versionNumber: clonedPayload.versionNumber,
                    state: clonedPayload.state ?? "DRAFT",
                };
            }

            if (!version?.id) {
                const created = await api.post(urlsMap.gatewayVersions(gatewayId.value), {
                    version: 1,
                    changelog: "Initial wizard draft",
                });
                const createdPayload = created.data?.data ?? created.data ?? {};
                version = {
                    id: createdPayload.id ?? createdPayload.versionId,
                    versionNumber: createdPayload.versionNumber,
                };
            }
            if (!version?.id) {
                throw new Error("The gateway version could not be resolved");
            }
            versionId.value = String(version.id);
            versionNumber.value = typeof version.versionNumber === "number" ? version.versionNumber : null;
            versionState.value = String(version.state ?? "");

            const response = await api.get(urlsMap.gatewayVersionDetail(versionId.value));
            const payload = response.data?.data ?? response.data ?? {};
            const merged = mergeDraft(emptyDraft(), payload);
            merged.versionId = payload?.versionId ?? payload?.id ?? versionId.value;
            merged.id = gateway.id ?? gatewayId.value;
            if (gateway.code) {
                merged.identity = {
                    ...merged.identity,
                    code: gateway.code,
                    name: gateway.name ?? merged.identity.name,
                    operator: gateway.operator ?? merged.identity.operator,
                    country: gateway.country ?? merged.identity.country,
                    aliases: gateway.aliases ?? merged.identity.aliases,
                    kind: gateway.kind ?? merged.identity.kind,
                    verificationState: gateway.verificationState ?? merged.identity.verificationState,
                    riskClass: gateway.riskClass ?? merged.identity.riskClass,
                };
            }
            draft.value = merged;
            dirty.value = false;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    watch(gatewayId, () => {
        void load();
    });

    const amountOrUndefined = (value: string) => {
        const trimmed = (value ?? "").trim();
        return trimmed.length > 0 ? trimmed : undefined;
    };

    const saveStep = async (stepNumber: number) => {
        const vid = draft.value.versionId ?? versionId.value;
        const gid = draft.value.id ?? gatewayId.value;
        saving.value = true;
        saveError.value = null;
        try {
            if (stepNumber === 1) {
                await api.patch(urlsMap.gatewayDetail(gid), {
                    code: draft.value.identity.code,
                    name: draft.value.identity.name,
                    operator: draft.value.identity.operator,
                    country: draft.value.identity.country,
                    kind: draft.value.identity.kind,
                    aliases: draft.value.identity.aliases,
                    riskClass: draft.value.identity.riskClass,
                    evidenceLevel: draft.value.identity.verificationState === "VERIFIED" ? "VERIFIED" : "PARTIAL",
                });
            } else if (stepNumber === 2) {
                for (const environment of draft.value.environments) {
                    await api.put(urlsMap.gatewayVersionEnvironments(vid), {
                        environments: [
                            {
                                code: environment.env,
                                env: environment.env,
                                baseUrl: environment.baseUrl,
                                allowedHosts: environment.allowedHosts,
                                inboundIpAllowlist: environment.inboundIpAllowlist,
                                active: environment.enabled,
                                enabled: environment.enabled,
                            },
                        ],
                        env: environment.env,
                    });
                }
                await api.put(urlsMap.gatewayVersionAuth(vid), {
                    env: "LIVE",
                    authMethod: draft.value.auth.method,
                    authApply: "HEADER",
                    settings: {
                        username: draft.value.auth.username,
                        keyRef: draft.value.auth.keyRef,
                        tokenUrl: draft.value.auth.tokenUrl,
                        clientIdRef: draft.value.auth.clientIdRef,
                        clientSecretRef: draft.value.auth.clientSecretRef,
                        extraHeaders: draft.value.auth.extraHeaders,
                    },
                });
                for (const credential of draft.value.credentialSets) {
                    const secret = credential.secret || credential.secretRef;
                    if (!secret) continue;
                    const entries = [
                        {
                            key: credential.label || "secret",
                            type: "HEADER" as const,
                            value: secret,
                            isSecret: true,
                        },
                    ];
                    if (credential.id) {
                        await api.put(urlsMap.credentialSetDetail(credential.id), { entries });
                    } else if (credential.ownerType === "PLATFORM") {
                        const response = await api.post(urlsMap.credentialSetsList, {
                            gatewayCode: draft.value.identity.code,
                            env: credential.env,
                            ownerType: credential.ownerType,
                            settlementTarget: credential.settlementTarget,
                            externalMerchantId: credential.label || "PLATFORM",
                            entries,
                        });
                        const created = response.data?.data ?? response.data ?? {};
                        if (created.id) credential.id = created.id;
                    }
                }
            } else if (stepNumber === 3) {
                for (const rail of draft.value.rails) {
                    const code = rail.code?.trim().toLowerCase();
                    if (!code) continue;
                    const capabilities: Record<string, boolean> = {};
                    for (const capability of rail.capabilities ?? []) capabilities[capability] = true;
                    let railId = rail.id;
                    if (railId) {
                        await api.patch(urlsMap.railDetail(railId), {
                            nameAr: rail.nameAr || rail.nameEn || code,
                            nameEn: rail.nameEn || rail.nameAr || code,
                            minAmount: amountOrUndefined(rail.minAmount) ?? "0",
                            maxAmount: amountOrUndefined(rail.maxAmount),
                            capabilities,
                            active: true,
                        });
                    } else {
                        const response = await api.post(urlsMap.railsList, {
                            code,
                            nameAr: rail.nameAr || rail.nameEn || code,
                            nameEn: rail.nameEn || rail.nameAr || code,
                            collectionMode: rail.collectionMode,
                            currency: (rail.currency || "LYD").toUpperCase(),
                            minAmount: amountOrUndefined(rail.minAmount) ?? "0",
                            maxAmount: amountOrUndefined(rail.maxAmount),
                            capabilities,
                        });
                        railId = response.data?.data?.id ?? response.data?.id;
                        if (railId) rail.id = railId;
                    }
                    if (railId && rail.fields.length > 0) {
                        await api.put(urlsMap.railFields(railId), {
                            fields: rail.fields.map((field, index) => ({
                                code: field.fieldKey || `field_${index + 1}`,
                                labelAr: field.labelAr || field.labelEn || field.fieldKey || `field_${index + 1}`,
                                labelEn: field.labelEn || field.labelAr || field.fieldKey || `field_${index + 1}`,
                                type: field.inputType,
                                required: field.required,
                                regex: field.regex || undefined,
                                minLength: field.minLength ?? undefined,
                                maxLength: field.maxLength ?? undefined,
                                sensitivity: field.sensitivity,
                                normalizer: field.normalizer,
                                options: field.options,
                                order: index,
                            })),
                        });
                    }
                    if (railId && !rail.routeId) {
                        const routeResponse = await api.post(urlsMap.routesList, {
                            railId,
                            gatewayId: gid,
                            environment: "sandbox",
                            priority: 0,
                            credentialPolicy: "PLATFORM",
                        });
                        const route = routeResponse.data?.data ?? routeResponse.data ?? {};
                        if (route.id) rail.routeId = route.id;
                    }
                }
            } else if (stepNumber === 4) {
                if (draft.value.cryptoProfiles.length > 0) {
                    await api.put(urlsMap.gatewayVersionCryptoProfiles(vid), {
                        cryptoProfiles: draft.value.cryptoProfiles,
                    });
                }
            } else if (stepNumber === 5) {
                await api.put(urlsMap.gatewayVersionFlows(vid), { flows: draft.value.flows });
            } else if (stepNumber === 6) {
                if (draft.value.confirmationChannels.length > 0 || draft.value.pollPolicies.length > 0) {
                    await api.put(urlsMap.gatewayVersionChannels(vid), {
                        clientActions: draft.value.clientActions,
                        confirmationChannels: draft.value.confirmationChannels,
                        pollPolicies: draft.value.pollPolicies,
                    });
                }
            } else if (stepNumber === 7) {
                if (draft.value.statusRules.length > 0) {
                    await api.put(urlsMap.gatewayVersionStatusRules(vid), {
                        statusRules: draft.value.statusRules,
                    });
                }
                if (draft.value.errorMaps.length > 0) {
                    await api.put(urlsMap.gatewayVersionErrorMaps(vid), { errorMaps: draft.value.errorMaps });
                }
                await api.put(urlsMap.gatewayVersionSettings(vid), {
                    amountPipeline: draft.value.amountPipeline,
                });
                const routeId = draft.value.rails.find((rail) => rail.routeId)?.routeId;
                if (routeId) {
                    await api.patch(urlsMap.routeDetail(routeId), {
                        costModel: {
                            model: draft.value.costModel.model,
                            flatFee: draft.value.costModel.flatFee,
                            percentFee: draft.value.costModel.percentFee,
                            minFee: draft.value.costModel.minFee,
                            maxFee: draft.value.costModel.maxFee,
                            currency: draft.value.costModel.currency,
                        },
                    });
                }
            }
            dirty.value = false;
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
        dirty.value = true;
    };

    const goToStep = async (target: number) => {
        if (target === step.value) return;
        if (dirty.value && !(await saveStep(step.value))) return;
        step.value = target;
    };

    const goNext = async () => {
        if (step.value < STEPS.length) await goToStep(step.value + 1);
    };

    const goBack = async () => {
        if (step.value > 1) await goToStep(step.value - 1);
    };

    const stepProps = () => ({
        model: draft.value,
        onChange,
        onSave: () => saveStep(step.value),
        saving: saving.value,
        error: saveError.value,
    });

    const renderStep = () => {
        switch (step.value) {
            case 1:
                return <StepIdentity {...stepProps()} />;
            case 2:
                return <StepEnvironments {...stepProps()} />;
            case 3:
                return <StepCustomerCatalog {...stepProps()} />;
            case 4:
                return <StepCryptoProfile {...stepProps()} />;
            case 5:
                return <StepFlowBuilder {...stepProps()} />;
            case 6:
                return <StepClientAction {...stepProps()} />;
            case 7:
                return <StepStatusRules {...stepProps()} />;
            case 8:
                return <StepSimulator {...stepProps()} />;
            default:
                return null;
        }
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Gateway Wizard")}
                    subtitle={t("Eight steps from identity to a governed live release.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                            {gatewayCode.value && <MonoRef value={gatewayCode.value} />}
                            {versionNumber.value !== null && (
                                <StatusBadge
                                    status={versionState.value || "DRAFT"}
                                    label={`v${versionNumber.value} · ${versionState.value || t("Draft")}`}
                                />
                            )}
                            <MetaPill color={dirty.value ? "warning" : "primary"} variant="tonal" size="small">
                                {dirty.value ? t("Unsaved changes") : `${t("Step")} ${step.value} ${t("of Steps")} ${STEPS.length}`}
                            </MetaPill>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        {versionState.value === "LIVE" && (
                            <VAlert type="warning" variant="tonal">
                                {t("You are editing the version that is currently LIVE. Review each change carefully before saving.")}
                            </VAlert>
                        )}
                        <SurfaceCard noPadding>
                            <StepBar
                                modelValue={step.value}
                                steps={STEPS.map((item) => ({ key: item.key, label: t(item.title) }))}
                                ariaLabel={t("Step")}
                                onSelect={(value: number) => void goToStep(value)}
                            />
                        </SurfaceCard>

                        {renderStep()}

                        {saveError.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {saveError.value}
                            </VAlert>
                        )}

                        <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "12px" }}>
                            <VBtn variant="tonal" disabled={step.value <= 1 || saving.value} onClick={() => void goBack()}>
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
