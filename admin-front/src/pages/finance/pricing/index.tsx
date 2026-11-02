import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VAlert, VBtn, VBtnToggle, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { statusTone } from "@/components/Table/statusTone";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetaPill } from "@/components/ui/MetaPill";
type CommissionProfile = {
    id: string;
    merchantId: string | null;
    applicationId: string | null;
    railCode: string;
    calcType: string;
    flatFee: string;
    percentageRate: string;
    minFee: string;
    maxFee: string | null;
    feeBearerDefault: string;
    roundingMode: string;
    version: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    pendingApprovalId: string | null;
};

type PricingAuditEntry = {
    id: string;
    createdAt: string;
    action: string;
    role: string;
    beforeJson: Record<string, unknown> | null;
    afterJson: Record<string, unknown> | null;
    approvalRequestId: string | null;
    actor: { id: string; email: string } | null;
};

type VelocityRule = {
    id: string;
    scopeType: string;
    scopeValue: string | null;
    windowSeconds: number;
    maxCount: number;
    maxAmount: string | null;
    action: string;
    active: boolean;
    version: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    pendingApprovalId: string | null;
};

type CommissionSummary = {
    total: number;
    merchantScoped: number;
    applicationScoped: number;
    globalScoped: number;
    withMaxFee: number;
    pendingLifecycle: number;
    byCalcType: Record<string, number>;
    byRail: Record<string, number>;
};

type VelocitySummary = {
    total: number;
    reject: number;
    flag: number;
    withAmountCap: number;
    pendingLifecycle: number;
    longestWindowSeconds: number;
    byScopeType: Record<string, number>;
    byAction: Record<string, number>;
};

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(date);
};

const PricingControlsPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const tab = ref<"COMMISSION" | "VELOCITY">(route.query.tab === "VELOCITY" ? "VELOCITY" : "COMMISSION");
    const loading = ref(true);
    const error = ref<string | null>(null);
    const profiles = ref<CommissionProfile[]>([]);
    const rules = ref<VelocityRule[]>([]);
    const commissionSummary = ref<CommissionSummary | null>(null);
    const velocitySummary = ref<VelocitySummary | null>(null);

    const commissionOpen = ref(false);
    const commissionSaving = ref(false);
    const commissionError = ref<string | null>(null);
    const commissionForm = ref({
        code: "",
        name: "",
        railCode: "",
        model: "PERCENTAGE",
        percentage: "0.0000",
        flatAmount: "0.0000",
        tiers: "[]",
    });

    const lifecycleOpen = ref(false);
    const lifecycleKind = ref<"COMMISSION" | "VELOCITY">("COMMISSION");
    const lifecycleTargetId = ref("");
    const lifecycleReason = ref("");
    const lifecycleEffectiveTo = ref("");
    const lifecycleSaving = ref(false);
    const lifecycleError = ref<string | null>(null);
    const historyOpen = ref(false);
    const historyLoading = ref(false);
    const historyError = ref<string | null>(null);
    const historyTitle = ref("");
    const historyEntries = ref<PricingAuditEntry[]>([]);

    const velocityOpen = ref(false);
    const velocitySaving = ref(false);
    const velocityError = ref<string | null>(null);
    const velocityForm = ref({
        code: "",
        name: "",
        scope: "MERCHANT",
        windowSeconds: "60",
        maxAttempts: "10",
        maxAmount: "",
        action: "BLOCK",
    });

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [profilesResponse, rulesResponse, commissionSummaryResponse, velocitySummaryResponse] = await Promise.all([
                api.get(urlsMap.commissionProfiles),
                api.get(urlsMap.velocityRules),
                api.get(urlsMap.commissionProfilesSummary),
                api.get(urlsMap.velocityRulesSummary),
            ]);
            const profilesPayload = profilesResponse.data?.data ?? profilesResponse.data ?? {};
            const rulesPayload = rulesResponse.data?.data ?? rulesResponse.data ?? {};
            const commissionPayload = commissionSummaryResponse.data?.data ?? commissionSummaryResponse.data ?? {};
            const velocityPayload = velocitySummaryResponse.data?.data ?? velocitySummaryResponse.data ?? {};
            profiles.value = (profilesPayload.profiles ?? []) as CommissionProfile[];
            rules.value = (rulesPayload.rules ?? []) as VelocityRule[];
            commissionSummary.value = (commissionPayload.summary ?? commissionPayload) as CommissionSummary;
            velocitySummary.value = (velocityPayload.summary ?? velocityPayload) as VelocitySummary;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const metricItems = computed<MetricItem[]>(() => {
        const commissions = commissionSummary.value;
        const velocity = velocitySummary.value;
        if (!commissions || !velocity) return [];
        const pending = commissions.pendingLifecycle + velocity.pendingLifecycle;
        return [
            { key: "profiles", label: t("Commission profiles"), value: String(commissions.total) },
            { key: "scoped", label: t("Scoped profiles"), value: String(commissions.merchantScoped + commissions.applicationScoped) },
            { key: "rules", label: t("Velocity rules"), value: String(velocity.total) },
            { key: "reject", label: t("Reject rules"), value: String(velocity.reject), badge: velocity.reject > 0 ? t("Watch") : t("Clear"), badgeTone: velocity.reject > 0 ? "warning" : "success" },
            { key: "pending", label: t("Pending lifecycle"), value: String(pending), badge: pending > 0 ? t("Review") : t("Clear"), badgeTone: pending > 0 ? "warning" : "success" },
        ];
    });

    const tabItems = computed(() => [
        { value: "COMMISSION", label: t("Commission profiles"), count: commissionSummary.value?.total },
        { value: "VELOCITY", label: t("Velocity rules"), count: velocitySummary.value?.total },
    ]);

    const openCommission = () => {
        commissionError.value = null;
        commissionForm.value = {
            code: "",
            name: "",
            railCode: "",
            model: "PERCENTAGE",
            percentage: "0.0000",
            flatAmount: "0.0000",
            tiers: "[]",
        };
        commissionOpen.value = true;
    };

    const saveCommission = async () => {
        if (commissionSaving.value) return;
        const form = commissionForm.value;
        if (!/^[A-Za-z0-9_-]{2,64}$/.test(form.code.trim())) {
            commissionError.value = t("Code must be 2-64 letters, digits, underscores or hyphens.");
            return;
        }
        if (form.name.trim().length < 2 || !form.railCode.trim()) {
            commissionError.value = t("Name and rail code are required.");
            return;
        }
        let tiers: unknown = [];
        if (form.model === "TIERED" || form.model === "MIXED") {
            try {
                tiers = JSON.parse(form.tiers || "[]");
            } catch {
                commissionError.value = t("Tiers must be a valid JSON array.");
                return;
            }
            if (!Array.isArray(tiers)) {
                commissionError.value = t("Tiers must be a valid JSON array.");
                return;
            }
        }
        commissionSaving.value = true;
        commissionError.value = null;
        try {
            await api.post(urlsMap.commissionProfiles, {
                code: form.code.trim(),
                name: form.name.trim(),
                railCode: form.railCode.trim(),
                model: form.model,
                ...(form.model === "PERCENTAGE" || form.model === "MIXED" ? { percentage: form.percentage.trim() } : {}),
                ...(form.model === "FLAT" || form.model === "MIXED" ? { flatAmount: form.flatAmount.trim() } : {}),
                ...((form.model === "TIERED" || form.model === "MIXED") && (tiers as unknown[]).length > 0 ? { tiers } : {}),
            });
            showSnackBar({ type: "success", message: t("Commission profile created") });
            commissionOpen.value = false;
            await load();
        } catch (e) {
            commissionError.value = extractApiErrorMessage(e);
        } finally {
            commissionSaving.value = false;
        }
    };

    const openVelocity = () => {
        velocityError.value = null;
        velocityForm.value = {
            code: "",
            name: "",
            scope: "MERCHANT",
            windowSeconds: "60",
            maxAttempts: "10",
            maxAmount: "",
            action: "BLOCK",
        };
        velocityOpen.value = true;
    };

    const saveVelocity = async () => {
        if (velocitySaving.value) return;
        const form = velocityForm.value;
        if (!/^[A-Za-z0-9_-]{2,64}$/.test(form.code.trim()) || form.name.trim().length < 2) {
            velocityError.value = t("Code and name are required.");
            return;
        }
        const windowSeconds = Number(form.windowSeconds);
        const maxAttempts = Number(form.maxAttempts);
        if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400) {
            velocityError.value = t("Window must be between 1 and 86400 seconds.");
            return;
        }
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100000) {
            velocityError.value = t("Max attempts must be between 1 and 100000.");
            return;
        }
        velocitySaving.value = true;
        velocityError.value = null;
        try {
            await api.post(urlsMap.velocityRules, {
                code: form.code.trim(),
                name: form.name.trim(),
                scope: form.scope,
                windowSeconds,
                maxAttempts,
                action: form.action,
                ...(form.maxAmount.trim() ? { maxAmount: form.maxAmount.trim() } : {}),
            });
            showSnackBar({ type: "success", message: t("Velocity rule created") });
            velocityOpen.value = false;
            await load();
        } catch (e) {
            velocityError.value = extractApiErrorMessage(e);
        } finally {
            velocitySaving.value = false;
        }
    };

    const openHistory = async (kind: "COMMISSION" | "VELOCITY", id: string, label: string) => {
        historyOpen.value = true;
        historyLoading.value = true;
        historyError.value = null;
        historyEntries.value = [];
        historyTitle.value = `${t("Audit history")} · ${label}`;
        try {
            const response = await api.get(
                kind === "COMMISSION" ? urlsMap.commissionProfileHistory(id) : urlsMap.velocityRuleHistory(id),
            );
            const payload = response.data?.data ?? response.data ?? {};
            historyEntries.value = (payload.history ?? []) as PricingAuditEntry[];
        } catch (e) {
            historyError.value = extractApiErrorMessage(e);
        } finally {
            historyLoading.value = false;
        }
    };

    const openLifecycle = (kind: "COMMISSION" | "VELOCITY", id: string) => {
        lifecycleKind.value = kind;
        lifecycleTargetId.value = id;
        lifecycleReason.value = "";
        lifecycleEffectiveTo.value = new Date().toISOString().slice(0, 10);
        lifecycleError.value = null;
        lifecycleOpen.value = true;
    };

    const saveLifecycle = async () => {
        if (lifecycleSaving.value) return;
        if (!lifecycleTargetId.value) return;
        lifecycleSaving.value = true;
        lifecycleError.value = null;
        try {
            if (lifecycleKind.value === "COMMISSION") {
                await api.post(urlsMap.commissionProfileExpire(lifecycleTargetId.value), {
                    ...(lifecycleEffectiveTo.value ? { effectiveTo: new Date(`${lifecycleEffectiveTo.value}T00:00:00Z`).toISOString() } : {}),
                    ...(lifecycleReason.value.trim() ? { reason: lifecycleReason.value.trim() } : {}),
                });
            } else {
                await api.post(urlsMap.velocityRuleDeactivate(lifecycleTargetId.value), {
                    ...(lifecycleReason.value.trim() ? { reason: lifecycleReason.value.trim() } : {}),
                });
            }
            showSnackBar({ type: "success", message: t("Lifecycle change submitted for checker approval") });
            lifecycleOpen.value = false;
            await load();
        } catch (e) {
            lifecycleError.value = extractApiErrorMessage(e);
        } finally {
            lifecycleSaving.value = false;
        }
    };

    const profileScope = (profile: CommissionProfile): string => {
        if (profile.applicationId) return "APPLICATION";
        if (profile.merchantId) return "MERCHANT";
        return "GLOBAL";
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Pricing & Limits")}
                    subtitle={t("Commission profiles and velocity controls under four-eyes governance.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                            <VBtn color="primary" variant="flat" prependIcon="mdi-plus" onClick={() => (tab.value === "COMMISSION" ? openCommission() : openVelocity())}>
                                {tab.value === "COMMISSION" ? t("New commission profile") : t("New velocity rule")}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="warning" variant="tonal">
                    {t("These records apply immediately. There is no update or delete endpoint: create a new record with the corrected values instead.")}
                </VAlert>

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <MetricStrip items={metricItems.value} />

                        <SegmentedTabs
                            modelValue={tab.value}
                            tabs={tabItems.value}
                            onUpdate:modelValue={(value: string) => (tab.value = value as "COMMISSION" | "VELOCITY")}
                        />

                        {tab.value === "COMMISSION" && (
                            <ThemedView style={{ gap: "10px" }}>
                                {profiles.value.length === 0 && <EmptyState title={t("No commission profiles")} description={t("Create a profile to price a rail.")} icon="mdi-tune-variant" />}
                                {profiles.value.map((profile) => (
                                    <SurfaceCard key={profile.id}>
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                <ThemedText type="defaultSemiBold" style={{ direction: "ltr" }}>{profile.railCode}</ThemedText>
                                                <StatusChip label={profile.calcType} tone="info" size="x-small" />
                                                <StatusChip label={profileScope(profile)} tone={profileScope(profile) === "GLOBAL" ? "neutral" : "primary"} size="x-small" />
                                                <MetaPill size="x-small" variant="tonal">v{profile.version}</MetaPill>
                                                {profile.effectiveTo && <StatusChip label={t("Expires")} tone="warning" size="x-small" />}
                                                {profile.pendingApprovalId && <StatusChip label={t("Pending checker")} tone="warning" size="x-small" />}
                                                <div style={{ flex: 1 }} />
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Effective")}: {formatDateTime(profile.effectiveFrom)}</ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap", fontSize: "12px" }}>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Flat")}: {profile.flatFee}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Rate")}: {profile.percentageRate}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Min")}: {profile.minFee}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Max")}: {profile.maxFee ?? "—"}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Fee bearer")}: {profile.feeBearerDefault}</ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "6px", flexWrap: "wrap" }}>
                                                <VBtn size="small" variant="text" onClick={() => void openHistory("COMMISSION", profile.id, profile.railCode)}>{t("History")}</VBtn>
                                                {!profile.effectiveTo && !profile.pendingApprovalId && (
                                                    <VBtn size="small" variant="text" color="warning" onClick={() => openLifecycle("COMMISSION", profile.id)}>{t("Expire profile")}</VBtn>
                                                )}
                                            </ThemedView>
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                ))}
                            </ThemedView>
                        )}

                        {tab.value === "VELOCITY" && (
                            <ThemedView style={{ gap: "10px" }}>
                                {rules.value.length === 0 && <EmptyState title={t("No velocity rules")} description={t("Create a rule to cap attempts or amount.")} icon="mdi-speedometer" />}
                                {rules.value.map((rule) => (
                                    <SurfaceCard key={rule.id}>
                                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                <ThemedText type="defaultSemiBold" style={{ direction: "ltr" }}>{rule.scopeType}</ThemedText>
                                                <StatusChip label={rule.action} tone={statusTone(rule.action)} size="x-small" />
                                                <StatusChip label={rule.active ? t("Active") : t("Inactive")} tone={rule.active ? "success" : "neutral"} size="x-small" />
                                                {rule.pendingApprovalId && <StatusChip label={t("Pending checker")} tone="warning" size="x-small" />}
                                                <MetaPill size="x-small" variant="tonal">v{rule.version}</MetaPill>
                                                {rule.scopeValue && <ThemedText style={{ fontSize: "11px", opacity: 0.65, direction: "ltr" }}>{rule.scopeValue}</ThemedText>}
                                                <div style={{ flex: 1 }} />
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Effective")}: {formatDateTime(rule.effectiveFrom)}</ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Window")}: {rule.windowSeconds}s</ThemedText>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Max count")}: {rule.maxCount}</ThemedText>
                                                <ThemedText style={{ fontSize: "12px" }}>{t("Max amount")}: {rule.maxAmount ?? "—"}</ThemedText>
                                            </ThemedView>
                                            <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "6px", flexWrap: "wrap" }}>
                                                <VBtn size="small" variant="text" onClick={() => void openHistory("VELOCITY", rule.id, rule.scopeType)}>{t("History")}</VBtn>
                                                {rule.active && !rule.pendingApprovalId && (
                                                    <VBtn size="small" variant="text" color="warning" onClick={() => openLifecycle("VELOCITY", rule.id)}>{t("Deactivate rule")}</VBtn>
                                                )}
                                            </ThemedView>
                                        </SurfaceCardText>
                                    </SurfaceCard>
                                ))}
                            </ThemedView>
                        )}
                    </>
                )}
            </ThemedView>

            <FormModal
                modelValue={historyOpen.value}
                onUpdate:modelValue={(value: boolean) => (historyOpen.value = value)}
                title={historyTitle.value}
                size="lg"
            >
{historyLoading.value && <StateView loading={true} minHeight="120px" />}
                        {historyError.value && <VAlert type="error" variant="tonal" density="compact">{historyError.value}</VAlert>}
                        {!historyLoading.value && !historyError.value && historyEntries.value.length === 0 && (
                            <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No audit events recorded yet.")}</ThemedText>
                        )}
                        {historyEntries.value.map((entry) => (
                            <ThemedView key={entry.id} style={{ gap: "4px", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(100,116,139,0.2)" }}>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>{entry.action.replaceAll("_", " ")}</ThemedText>
                                    <StatusChip label={entry.role} tone="info" size="x-small" />
                                    {entry.approvalRequestId && <StatusChip label={t("Approval linked")} tone="warning" size="x-small" />}
                                    <div style={{ flex: 1 }} />
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(entry.createdAt)}</ThemedText>
                                </ThemedView>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{entry.actor?.email ?? "—"}</ThemedText>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.7, direction: "ltr", wordBreak: "break-word" }}>
                                    {JSON.stringify(entry.afterJson ?? {}).slice(0, 240)}
                                </ThemedText>
                            </ThemedView>
                        ))}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (historyOpen.value = false)}>{t("Close")}</VBtn>
                        </ThemedView>
            </FormModal>

            <FormModal
                modelValue={commissionOpen.value}
                onUpdate:modelValue={(value: boolean) => (commissionOpen.value = value)}
                title={t("New commission profile")}
                size="md"
            >
<VAlert type="warning" variant="tonal" density="compact">
                            {t("Commission changes take effect immediately and are audited.")}
                        </VAlert>
                        {commissionError.value && <VAlert type="error" variant="tonal" density="compact">{commissionError.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField label={t("Code")} modelValue={commissionForm.value.code} onUpdate:modelValue={(value: string) => (commissionForm.value.code = value)} style={{ flex: "1 1 220px" }} />
                            <VTextField label={t("Name")} modelValue={commissionForm.value.name} onUpdate:modelValue={(value: string) => (commissionForm.value.name = value)} style={{ flex: "1 1 220px" }} />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField label={t("Rail code")} modelValue={commissionForm.value.railCode} onUpdate:modelValue={(value: string) => (commissionForm.value.railCode = value)} style={{ flex: "1 1 220px" }} />
                            <VSelect label={t("Model")} items={["FLAT", "PERCENTAGE", "TIERED", "MIXED"]} modelValue={commissionForm.value.model} onUpdate:modelValue={(value: string | null) => (commissionForm.value.model = value ?? "PERCENTAGE")} style={{ flex: "1 1 220px" }} />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            {(commissionForm.value.model === "PERCENTAGE" || commissionForm.value.model === "MIXED") && (
                                <VTextField label={t("Percentage rate")} modelValue={commissionForm.value.percentage} onUpdate:modelValue={(value: string) => (commissionForm.value.percentage = value)} style={{ flex: "1 1 220px" }} />
                            )}
                            {(commissionForm.value.model === "FLAT" || commissionForm.value.model === "MIXED") && (
                                <VTextField label={t("Flat amount")} modelValue={commissionForm.value.flatAmount} onUpdate:modelValue={(value: string) => (commissionForm.value.flatAmount = value)} style={{ flex: "1 1 220px" }} />
                            )}
                        </ThemedView>
                        {(commissionForm.value.model === "TIERED" || commissionForm.value.model === "MIXED") && (
                            <VTextarea label={t("Tiers JSON")} modelValue={commissionForm.value.tiers} onUpdate:modelValue={(value: string) => (commissionForm.value.tiers = value)} rows={5} style={{ fontFamily: "ui-monospace, monospace", direction: "ltr" }} />
                        )}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (commissionOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={commissionSaving.value} onClick={() => void saveCommission()}>{t("Create")}</VBtn>
                        </ThemedView>
            </FormModal>

            <FormModal
                modelValue={lifecycleOpen.value}
                onUpdate:modelValue={(value: boolean) => (lifecycleOpen.value = value)}
                title={lifecycleKind.value === "COMMISSION" ? t("Expire commission profile") : t("Deactivate velocity rule")}
                size="md"
            >
<VAlert type="info" variant="tonal" density="compact">
                            {t("This creates a maker-checker request. The change applies only after a different checker approves it.")}
                        </VAlert>
                        {lifecycleKind.value === "COMMISSION" && (
                            <VTextField
                                label={t("Effective to")}
                                type="date"
                                modelValue={lifecycleEffectiveTo.value}
                                onUpdate:modelValue={(value: string) => (lifecycleEffectiveTo.value = value)}
                            />
                        )}
                        <VTextField label={t("Reason (optional)")} modelValue={lifecycleReason.value} onUpdate:modelValue={(value: string) => (lifecycleReason.value = value)} />
                        {lifecycleError.value && <VAlert type="error" variant="tonal" density="compact">{lifecycleError.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (lifecycleOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="warning" loading={lifecycleSaving.value} onClick={() => void saveLifecycle()}>{t("Submit for approval")}</VBtn>
                        </ThemedView>
            </FormModal>

            <FormModal
                modelValue={velocityOpen.value}
                onUpdate:modelValue={(value: boolean) => (velocityOpen.value = value)}
                title={t("New velocity rule")}
                size="md"
            >
<VAlert type="warning" variant="tonal" density="compact">
                            {t("Velocity rules take effect immediately and are audited.")}
                        </VAlert>
                        {velocityError.value && <VAlert type="error" variant="tonal" density="compact">{velocityError.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField label={t("Code")} modelValue={velocityForm.value.code} onUpdate:modelValue={(value: string) => (velocityForm.value.code = value)} style={{ flex: "1 1 220px" }} />
                            <VTextField label={t("Name")} modelValue={velocityForm.value.name} onUpdate:modelValue={(value: string) => (velocityForm.value.name = value)} style={{ flex: "1 1 220px" }} />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VSelect label={t("Scope")} items={["MERCHANT", "APPLICATION", "LINK", "IP"]} modelValue={velocityForm.value.scope} onUpdate:modelValue={(value: string | null) => (velocityForm.value.scope = value ?? "MERCHANT")} style={{ flex: "1 1 220px" }} />
                            <VSelect label={t("Action")} items={["BLOCK", "REVIEW", "THROTTLE", "CHALLENGE"]} modelValue={velocityForm.value.action} onUpdate:modelValue={(value: string | null) => (velocityForm.value.action = value ?? "BLOCK")} style={{ flex: "1 1 220px" }} />
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField label={t("Window seconds")} modelValue={velocityForm.value.windowSeconds} onUpdate:modelValue={(value: string) => (velocityForm.value.windowSeconds = value)} style={{ flex: "1 1 220px" }} />
                            <VTextField label={t("Max attempts")} modelValue={velocityForm.value.maxAttempts} onUpdate:modelValue={(value: string) => (velocityForm.value.maxAttempts = value)} style={{ flex: "1 1 220px" }} />
                        </ThemedView>
                        <VTextField label={t("Max amount (optional)")} modelValue={velocityForm.value.maxAmount} onUpdate:modelValue={(value: string) => (velocityForm.value.maxAmount = value)} />
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (velocityOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={velocitySaving.value} onClick={() => void saveVelocity()}>{t("Create")}</VBtn>
                        </ThemedView>
            </FormModal>
        </ScreenContainer>
    );
});

export default PricingControlsPage;
