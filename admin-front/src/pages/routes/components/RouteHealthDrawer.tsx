import { computed, ref, watch, type PropType, type VNodeChild } from "vue";
import { defineComponent } from "@/utils/dc";
import { VAlert, VBtn, VSelect, VTextarea, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField } from "@/components/ui/FormField";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SectionFields } from "@/components/SectionFields";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type HealthState = "HEALTHY" | "DEGRADED" | "OPEN_BREAKER";

interface RouteHealthData {
    routeId: string;
    rail?: { code?: string; name?: string };
    gateway?: { code?: string; name?: string };
    health: {
        effectiveState: HealthState;
        computedState: HealthState;
        computedReason?: string | null;
        computedAt?: string | null;
        overrideState?: HealthState | null;
        overrideReason?: string | null;
        overrideSetAt?: string | null;
        overrideSetBy?: string | null;
        overrideSetByName?: string | null;
        overrideExpiresAt?: string | null;
        overrideApprovalId?: string | null;
        reason?: string | null;
        changedAt?: string | null;
        consecutiveFailures: number;
        probeSuccesses: number;
        probeFailures: number;
        lastProbeAt?: string | null;
        nextProbeAt?: string | null;
    };
    canary: { percent: number; maxAmount: string | null };
    policy?: {
        sampleBucketSeconds: number;
        overrideDefaultExpiryDays: number;
        overrideMaxExpiryDays: number;
        overrideReviewHours: number;
    };
    samples: Array<{
        windowStart: string;
        successes: number;
        definitiveFailures: number;
        ambiguousUnknowns: number;
        rateLimits429: number;
        ignoredOutcomes: number;
        p50Ms: number | null;
        p95Ms: number | null;
        p99Ms: number | null;
    }>;
    probes: Array<{
        id: string;
        createdAt: string;
        method: string;
        status: string;
        reason?: string | null;
        httpStatus?: number | null;
        latencyMs?: number | null;
    }>;
    events: Array<{
        id: string;
        createdAt: string;
        fromState?: string | null;
        toState: string;
        source: string;
        reason?: string | null;
    }>;
}

const tone = (state: HealthState | null | undefined): "success" | "warning" | "danger" | "neutral" =>
    state === "HEALTHY" ? "success" : state === "DEGRADED" ? "warning" : state === "OPEN_BREAKER" ? "danger" : "neutral";

const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : "—");

/**
 * The health of one route: effective/computed/override state, canary settings,
 * the sampled outcome buckets, probes and state history. Force HEALTHY is a
 * maker-checker approval; DEGRADED/OPEN_BREAKER apply immediately.
 */
export const RouteHealthDrawer = defineComponent({
    name: "RouteHealthDrawer",
    props: {
        modelValue: { type: Boolean, required: true },
        routeId: { type: String as PropType<string | null>, default: null },
        routeLabel: { type: String, default: "" },
    },
    emits: ["update:modelValue", "changed"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const data = ref<RouteHealthData | null>(null);
        const loading = ref(false);
        const busy = ref(false);
        const error = ref<string | null>(null);
        const tab = ref("health");
        const overrideState = ref<HealthState>("DEGRADED");
        const overrideReason = ref("");
        const overrideExpiry = ref("");
        const clearReason = ref("");
        let requestSeq = 0;

        const load = async () => {
            if (!props.routeId) return;
            const seq = ++requestSeq;
            loading.value = true;
            error.value = null;
            try {
                const response = await api.get(urlsMap.routeHealth(props.routeId));
                if (seq !== requestSeq) return;
                data.value = (response.data?.data ?? response.data) as RouteHealthData;
            } catch (cause) {
                if (seq !== requestSeq) return;
                error.value = extractApiErrorMessage(cause);
            } finally {
                if (seq === requestSeq) loading.value = false;
            }
        };

        watch(
            () => [props.modelValue, props.routeId] as const,
            ([open]) => {
                if (open) {
                    overrideReason.value = "";
                    overrideExpiry.value = "";
                    clearReason.value = "";
                    tab.value = "health";
                    void load();
                } else {
                    requestSeq += 1;
                    data.value = null;
                    error.value = null;
                    loading.value = false;
                }
            },
            { immediate: true },
        );

        const health = computed(() => data.value?.health ?? null);
        const activeOverride = computed(() => {
            const current = health.value;
            if (!current?.overrideState) return false;
            return !current.overrideExpiresAt || new Date(current.overrideExpiresAt).getTime() > Date.now();
        });

        const runProbe = async () => {
            if (!props.routeId || busy.value) return;
            busy.value = true;
            try {
                const response = await api.post(urlsMap.routeHealthProbe(props.routeId));
                const result = (response.data?.data ?? response.data) as { status?: string; reason?: string | null };
                showSnackBar({
                    type: result.status === "PASSED" ? "success" : "warning",
                    message: result.status === "SKIPPED"
                        ? `${t("Probe skipped")}: ${result.reason ?? t("No probe is available")}`
                        : `${t("Probe")} ${result.status}`,
                });
                emit("changed");
                await load();
            } catch (cause) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
            } finally {
                busy.value = false;
            }
        };

        const applyOverride = async () => {
            if (!props.routeId || busy.value) return;
            if (overrideReason.value.trim().length < 10) {
                showSnackBar({ type: "warning", message: t("Enter a reason of at least 10 characters") });
                return;
            }
            busy.value = true;
            try {
                const response = await api.post(urlsMap.routeHealthOverride(props.routeId), {
                    state: overrideState.value,
                    reason: overrideReason.value.trim(),
                    ...(overrideExpiry.value ? { expiresAt: new Date(overrideExpiry.value).toISOString() } : {}),
                });
                const payload = (response.data?.data ?? response.data) as { status?: string; approvalRequestId?: string };
                showSnackBar({
                    type: "success",
                    message: payload.approvalRequestId
                        ? t("The force-healthy request was sent for a second approval")
                        : t("The route health override was applied"),
                });
                overrideReason.value = "";
                emit("changed");
                await load();
            } catch (cause) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
            } finally {
                busy.value = false;
            }
        };

        const clearOverride = async () => {
            if (!props.routeId || busy.value) return;
            if (clearReason.value.trim().length < 10) {
                showSnackBar({ type: "warning", message: t("Enter a reason of at least 10 characters") });
                return;
            }
            busy.value = true;
            try {
                const response = await api.post(urlsMap.routeHealthOverrideClear(props.routeId), {
                    reason: clearReason.value.trim(),
                });
                const payload = (response.data?.data ?? response.data) as { status?: string; approvalRequestId?: string };
                showSnackBar({
                    type: "success",
                    message: payload.approvalRequestId
                        ? t("Clearing this override needs a second approval")
                        : t("The route health override was cleared"),
                });
                clearReason.value = "";
                emit("changed");
                await load();
            } catch (cause) {
                showSnackBar({ type: "error", message: extractApiErrorMessage(cause) });
            } finally {
                busy.value = false;
            }
        };

        const header = (): VNodeChild => {
            if (!health.value) return null;
            return (
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    <StatusBadge status={health.value.effectiveState} toneOverride={tone(health.value.effectiveState)} />
                    {activeOverride.value && (
                        <StatusBadge status="ADMIN_OVERRIDE" label={t("Admin override active")} toneOverride="warning" showDot={false} />
                    )}
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                        {t("Computed")}: {health.value.computedState}
                    </span>
                </div>
            );
        };

        const healthTab = (): VNodeChild => {
            if (!data.value || !health.value) return null;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <DescriptionList
                        columns={2}
                        items={[
                            { label: t("Effective state"), value: <StatusBadge status={health.value.effectiveState} toneOverride={tone(health.value.effectiveState)} /> },
                            { label: t("Computed state"), value: <StatusBadge status={health.value.computedState} toneOverride={tone(health.value.computedState)} /> },
                            { label: t("Computed reason"), value: health.value.computedReason ?? "—" },
                            { label: t("Computed at"), value: when(health.value.computedAt) },
                            { label: t("Override state"), value: health.value.overrideState ?? "—" },
                            { label: t("Override reason"), value: health.value.overrideReason ?? "—" },
                            { label: t("Override expires"), value: when(health.value.overrideExpiresAt) },
                            { label: t("Override set by"), value: health.value.overrideSetByName ?? health.value.overrideSetBy ?? "—" },
                            { label: t("Consecutive failures"), value: String(health.value.consecutiveFailures) },
                            { label: t("Probe successes / failures"), value: `${health.value.probeSuccesses} / ${health.value.probeFailures}` },
                            { label: t("Last probe"), value: when(health.value.lastProbeAt) },
                            { label: t("Next probe"), value: when(health.value.nextProbeAt) },
                            { label: t("Degraded canary"), value: `${data.value.canary.percent}%${data.value.canary.maxAmount ? ` · ≤ ${data.value.canary.maxAmount}` : ""}` },
                            { label: t("Last changed"), value: when(health.value.changedAt) },
                        ]}
                    />

                    <SectionFields title={t("Run a recovery probe")} subtitle={t("The probe is read-only and is recorded as evidence. It never changes a credential-set verdict.")}>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-access-point-check" loading={busy.value} onClick={() => void runProbe()}>
                                {t("Run probe now")}
                            </VBtn>
                        </div>
                    </SectionFields>

                    <SectionFields title={t("Admin override")} subtitle={t("Force HEALTHY is approved by a second officer. DEGRADED and OPEN_BREAKER apply immediately.")}>
                        <FormField label={t("Target state")}>
                            <VSelect
                                items={["HEALTHY", "DEGRADED", "OPEN_BREAKER"]}
                                modelValue={overrideState.value}
                                onUpdate:modelValue={(value: HealthState) => (overrideState.value = value)}
                            />
                        </FormField>
                        <FormField label={t("Reason")} hint={t("At least 10 characters; this is written to the audit log and the approval.")}>
                            <VTextarea
                                rows={3}
                                modelValue={overrideReason.value}
                                onUpdate:modelValue={(value: string) => (overrideReason.value = value)}
                            />
                        </FormField>
                        <FormField
                                label={t("Expires at")}
                                hint={`${t("Optional")}. ${t("Default")}: ${data.value?.policy?.overrideDefaultExpiryDays ?? 7} ${t("days")}; ${t("maximum")}: ${data.value?.policy?.overrideMaxExpiryDays ?? 30} ${t("days")}.`}
                            >
                            <VTextField
                                type="datetime-local"
                                modelValue={overrideExpiry.value}
                                onUpdate:modelValue={(value: string) => (overrideExpiry.value = value)}
                            />
                        </FormField>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn color="primary" variant="flat" loading={busy.value} onClick={() => void applyOverride()}>
                                {overrideState.value === "HEALTHY" ? t("Request force healthy") : t("Apply override")}
                            </VBtn>
                        </div>
                    </SectionFields>

                    {activeOverride.value && (
                        <SectionFields title={t("Clear the override")} subtitle={t("If the computed state is healthier than the override, clearing needs a second approval.")}>
                            <FormField label={t("Reason")} hint={t("At least 10 characters.")}>
                                <VTextarea
                                    rows={2}
                                    modelValue={clearReason.value}
                                    onUpdate:modelValue={(value: string) => (clearReason.value = value)}
                                />
                            </FormField>
                            <div>
                                <VBtn variant="outlined" color="warning" loading={busy.value} onClick={() => void clearOverride()}>
                                    {t("Clear override")}
                                </VBtn>
                            </div>
                        </SectionFields>
                    )}
                </div>
            );
        };

        const historyTab = (): VNodeChild => {
            if (!data.value) return null;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <SectionFields title={t("Recent probes")} subtitle={t("The newest 20 read-only probes.")}>
                        {data.value.probes.length === 0 ? (
                            <EmptyState title={t("No probes yet")} description={t("A probe runs when the route is degraded or open and the next probe is due.")} />
                        ) : (
                            <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                <table>
                                    <thead>
                                        <tr><th>{t("When")}</th><th>{t("Method")}</th><th>{t("Status")}</th><th>{t("Latency")}</th><th>{t("Reason")}</th></tr>
                                    </thead>
                                    <tbody>
                                        {data.value.probes.map((probe) => (
                                            <tr key={probe.id}>
                                                <td>{when(probe.createdAt)}</td>
                                                <td>{probe.method}</td>
                                                <td><StatusBadge status={probe.status} toneOverride={probe.status === "PASSED" ? "success" : probe.status === "FAILED" ? "danger" : "neutral"} showDot={false} /></td>
                                                <td>{probe.latencyMs === null || probe.latencyMs === undefined ? "—" : `${probe.latencyMs} ms`}</td>
                                                <td>{probe.reason ?? "—"}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </SectionFields>

                    <SectionFields title={t("State history")} subtitle={t("Every computed, probe, override and expiry transition.")}>
                        {data.value.events.length === 0 ? (
                            <EmptyState title={t("No transitions")} description={t("This route has not changed health state yet.")} />
                        ) : (
                            <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                <table>
                                    <thead>
                                        <tr><th>{t("When")}</th><th>{t("From")}</th><th>{t("To")}</th><th>{t("Source")}</th><th>{t("Reason")}</th></tr>
                                    </thead>
                                    <tbody>
                                        {data.value.events.map((event) => (
                                            <tr key={event.id}>
                                                <td>{when(event.createdAt)}</td>
                                                <td>{event.fromState ?? "—"}</td>
                                                <td>{event.toState}</td>
                                                <td>{event.source}</td>
                                                <td>{event.reason ?? "—"}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </SectionFields>

                    <SectionFields title={t("Recent sample windows")} subtitle={`${data.value.policy?.sampleBucketSeconds ?? 300}s ${t("buckets rebuilt from real payment outcomes.")}`}>
                        {data.value.samples.length === 0 ? (
                            <EmptyState title={t("No samples")} description={t("No terminal payment outcome has been recorded for this route yet.")} />
                        ) : (
                            <div class="pg-unified-table" style={{ overflowX: "auto" }}>
                                <table>
                                    <thead>
                                        <tr><th>{t("Window")}</th><th>{t("Success")}</th><th>{t("Failures")}</th><th>{t("Unknown")}</th><th>{t("429")}</th><th>{t("Ignored")}</th><th>p95</th></tr>
                                    </thead>
                                    <tbody>
                                        {data.value.samples.slice(0, 12).map((sample) => (
                                            <tr key={sample.windowStart}>
                                                <td>{when(sample.windowStart)}</td>
                                                <td>{sample.successes}</td>
                                                <td>{sample.definitiveFailures}</td>
                                                <td>{sample.ambiguousUnknowns}</td>
                                                <td>{sample.rateLimits429}</td>
                                                <td>{sample.ignoredOutcomes}</td>
                                                <td>{sample.p95Ms === null ? "—" : `${sample.p95Ms} ms`}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </SectionFields>
                </div>
            );
        };

        const body = (): VNodeChild => {
            if (loading.value) return <StateView loading minHeight="260px" />;
            if (error.value) return <StateView error={error.value} minHeight="260px" onRetry={() => void load()} />;
            if (!data.value) return null;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {header()}
                    <VAlert type="info" variant="tonal">
                        {t("Health is operational evidence. Forcing a state never hides the computed state, and probes keep running while an override is active.")}
                    </VAlert>
                    <SegmentedTabs
                        modelValue={tab.value}
                        onUpdate:modelValue={(value: string) => (tab.value = value)}
                        ariaLabel={t("Route health")}
                        tabs={[
                            { value: "health", label: t("Health") },
                            { value: "history", label: t("Evidence") },
                        ]}
                    />
                    {tab.value === "health" ? healthTab() : historyTab()}
                </div>
            );
        };

        return (): VNodeChild => (
            <SlideOverDrawer
                modelValue={props.modelValue}
                onUpdate:modelValue={(open: boolean) => emit("update:modelValue", open)}
                title={t("Route health")}
                subtitle={props.routeLabel}
                width={760}
                v-slots={{
                    default: body,
                    footer: () => (
                        <>
                            <VBtn variant="text" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>{t("Refresh")}</VBtn>
                            <VBtn variant="text" onClick={() => emit("update:modelValue", false)}>{t("Close")}</VBtn>
                        </>
                    ),
                }}
            />
        );
    },
});

export default RouteHealthDrawer;
