import Decimal from "decimal.js";
import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { VBtn } from "vuetify/components";
import { useLocale, useTheme } from "vuetify";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { EmptyState } from "@/components/ui/EmptyState";
import { StateView } from "@/components/StateView";
import { LazyEChart as EChart } from "@/components/EChart/lazy";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import {
    buildVolumeSeries,
    formatMs,
    formatPercent,
    latencyOption,
    successRateOption,
    successRateTone,
    volumeOption,
    type ChartPalette,
    type RouteHealth,
} from "../healthModel";

interface GatewayHealth {
    routes: RouteHealth[];
    summary: { successRate24h: number | null; p95Ms24h: number | null };
}

/**
 * Route health and telemetry of one gateway: success rate and latency per route from the health
 * samples, plus the 30-day route volume. Open when `gatewayId` is set; emits `close`.
 */
export const GatewayHealthDrawer = defineComponent({
    name: "GatewayHealthDrawer",
    props: {
        gatewayId: { type: String as PropType<string | null>, default: null },
        gatewayName: { type: String, default: "" },
    },
    emits: ["close"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const theme = useTheme();
        const data = ref<GatewayHealth | null>(null);
        const loading = ref(false);
        const error = ref<string | null>(null);
        const routeId = ref<string>("");
        let requestSeq = 0;

        const load = async (id: string) => {
            const seq = ++requestSeq;
            loading.value = true;
            error.value = null;
            data.value = null;
            try {
                const response = await api.get(urlsMap.gatewayHealth(id));
                if (seq !== requestSeq) return;
                const payload = (response.data?.data ?? response.data) as GatewayHealth;
                data.value = { routes: payload.routes ?? [], summary: payload.summary ?? { successRate24h: null, p95Ms24h: null } };
                routeId.value = data.value.routes[0]?.routeId ?? "";
            } catch (cause) {
                if (seq !== requestSeq) return;
                error.value = extractApiErrorMessage(cause);
            } finally {
                if (seq === requestSeq) loading.value = false;
            }
        };

        watch(
            () => props.gatewayId,
            (id) => {
                if (id) {
                    void load(id);
                } else {
                    requestSeq += 1;
                    data.value = null;
                    error.value = null;
                    loading.value = false;
                }
            },
            { immediate: true },
        );

        const palette = computed<ChartPalette>(() => {
            const colors = theme.current.value.colors as Record<string, string>;
            const ink = colors["on-surface"] ?? "#667085";
            return {
                ink,
                muted: ink,
                grid: "rgba(128, 128, 128, 0.35)",
                success: colors.success ?? "#12b76a",
                info: colors.info ?? "#2e90fa",
                warning: colors.warning ?? "#f79009",
                danger: colors.error ?? "#f04438",
            };
        });

        const route = computed(() => data.value?.routes.find((entry) => entry.routeId === routeId.value) ?? data.value?.routes[0] ?? null);
        const volume = computed(() => buildVolumeSeries(route.value?.dailyVolume ?? []));
        const volumeTotals = computed(() =>
            volume.value.currencies.map((currency) => ({
                currency,
                total: (volume.value.amountByCurrency[currency] ?? []).reduce((sum, value) => sum.plus(new Decimal(value)), new Decimal(0)).toFixed(4),
            })),
        );

        const tile = (label: string, value: VNodeChild, footer?: VNodeChild) => (
            <div style={{ padding: "14px 16px", backgroundColor: "var(--pg-bg-surface)", display: "flex", flexDirection: "column", gap: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--pg-ink-muted)" }}>{label}</span>
                <span class="pg-tabular" style={{ fontSize: "22px", fontWeight: 600 }}>{value}</span>
                {footer}
            </div>
        );

        const body = (): VNodeChild => {
            if (loading.value) return <StateView loading minHeight="220px" />;
            if (error.value) return <StateView error={error.value} minHeight="220px" onRetry={() => props.gatewayId && void load(props.gatewayId)} />;
            const health = data.value;
            if (!health) return null;
            if (health.routes.length === 0) {
                return <EmptyState title={t("No routes")} description={t("This gateway has no rail routes yet, so there is no telemetry to show.")} />;
            }
            const current = route.value!;
            const rate = health.summary.successRate24h;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                            gap: "1px",
                            backgroundColor: "var(--pg-border-subtle)",
                            border: "1px solid var(--pg-border-subtle)",
                            borderRadius: "var(--pg-radius-md)",
                            overflow: "hidden",
                        }}
                    >
                        {tile(
                            t("Success rate (24h)"),
                            formatPercent(rate),
                            <StatusBadge status="HEALTH" label={rate === null ? t("No traffic") : successRateTone(rate) === "success" ? t("Healthy") : successRateTone(rate) === "warning" ? t("Degraded") : t("Unhealthy")} toneOverride={successRateTone(rate) === "neutral" ? "neutral" : successRateTone(rate)} showDot={false} />,
                        )}
                        {tile(t("p95 latency (24h)"), formatMs(health.summary.p95Ms24h))}
                        {tile(t("Routes"), String(health.routes.length))}
                    </div>

                    {health.routes.length > 1 && (
                        <SegmentedTabs
                            modelValue={current.routeId}
                            onUpdate:modelValue={(value: string) => (routeId.value = value)}
                            ariaLabel={t("Routes")}
                            tabs={health.routes.map((entry) => ({ value: entry.routeId, label: entry.railCode }))}
                        />
                    )}

                    <SurfaceCard title={t("Success rate")} subtitle={`${current.railCode} · ${t("per health window")}`}>
                        {current.samples.length === 0 ? (
                            <EmptyState title={t("No health samples")} description={t("No traffic has been sampled for this route yet.")} />
                        ) : (
                            <EChart option={successRateOption(current.samples, palette.value, { successRate: t("Success rate") })} height="220px" />
                        )}
                    </SurfaceCard>

                    <SurfaceCard title={t("Latency")} subtitle={`${current.railCode} · p50 / p95 / p99`}>
                        {current.samples.length === 0 ? (
                            <EmptyState title={t("No health samples")} description={t("No traffic has been sampled for this route yet.")} />
                        ) : (
                            <EChart option={latencyOption(current.samples, palette.value, { p50: "p50", p95: "p95", p99: "p99" })} height="220px" />
                        )}
                    </SurfaceCard>

                    <SurfaceCard title={t("Volume, last 30 days")} subtitle={`${current.railCode} · ${volume.value.totalSuccesses} / ${volume.value.totalAttempts} ${t("succeeded / attempts")}`}>
                        {volume.value.days.length === 0 ? (
                            <EmptyState title={t("No volume")} description={t("This route processed no payments in the last 30 days.")} />
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                <EChart option={volumeOption(volume.value, palette.value, { attempts: t("Attempts"), successes: t("Succeeded") })} height="220px" />
                                <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
                                    {volumeTotals.value.map((entry) => (
                                        <div key={entry.currency} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                            <span style={{ fontSize: "11px", color: "var(--pg-ink-muted)" }}>{t("Processed volume")}</span>
                                            <MoneyDisplay amount={entry.total} currency={entry.currency} size="md" />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </SurfaceCard>
                </div>
            );
        };

        return (): VNodeChild => (
            <SlideOverDrawer
                modelValue={!!props.gatewayId}
                onUpdate:modelValue={(open: boolean) => {
                    if (!open) emit("close");
                }}
                title={t("Health & telemetry")}
                subtitle={props.gatewayName}
                width={760}
                v-slots={{
                    default: body,
                    footer: () => (
                        <>
                            <VBtn variant="text" prependIcon="mdi-refresh" onClick={() => props.gatewayId && void load(props.gatewayId)}>{t("Refresh")}</VBtn>
                            <VBtn variant="text" onClick={() => emit("close")}>{t("Close")}</VBtn>
                        </>
                    ),
                }}
            />
        );
    },
});

export default GatewayHealthDrawer;
