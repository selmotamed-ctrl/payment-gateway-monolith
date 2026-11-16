import { dc } from "kt-dc";
import { onBeforeUnmount, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VBtn } from "vuetify/components";
import { StateView } from "@/components/StateView";
import { user } from "@/state/user";
import { openSseStream } from "@/utils/security/sseFetch";
import { sessionHeaders } from "@/utils/security/sessionToken";
import { urlsMap } from "@/constants/urlsMap";
import { sandboxMirrorAbsolute } from "@/state/sandbox";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
import { PageHeader } from "@/components/ui/PageHeader";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { EmptyState } from "@/components/ui/EmptyState";

type ScreenState = {
    screenCode: string;
    merchantName: string;
    linkKey: string | null;
    amount: string | null;
    currency: string | null;
    railCode: string | null;
    status: string | null;
    reference: string | null;
    updatedAt: string | null;
};

const PosScreenPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const state = ref<ScreenState | null>(null);
    const connected = ref(false);
    const error = ref<string | null>(null);
    const loading = ref(true);

    let source: { close: () => void } | null = null;
    let retryTimer: number | null = null;
    let retries = 0;

    const code = () => String(route.params.code ?? "");

    const applyFrame = (data: string) => {
        try {
            const payload = JSON.parse(data);
            if (payload?.screen) {
                state.value = payload.screen as ScreenState;
                error.value = null;
                return;
            }
            // The stream sends `event: attempts` with an array of attempt rows.
            const attempts = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.attempts)
                    ? payload.attempts
                    : [];
            const latest = attempts[0] ?? null;
            if (!latest) {
                error.value = null;
                return;
            }
            const previous = state.value;
            state.value = {
                screenCode: code(),
                merchantName: user.value?.userInfo?.merchantTradeName ?? previous?.merchantName ?? "",
                linkKey: previous?.linkKey ?? null,
                amount: latest.totalChargedAmount ?? latest.requestedAmount ?? previous?.amount ?? null,
                currency: latest.currency ?? previous?.currency ?? null,
                railCode: latest.railCode ?? previous?.railCode ?? null,
                status: latest.status ?? previous?.status ?? null,
                reference: latest.reference ?? previous?.reference ?? null,
                updatedAt: latest.updatedAt ?? latest.createdAt ?? previous?.updatedAt ?? null,
            };
            error.value = null;
        } catch {
            error.value = t("Something went wrong");
        }
    };

    // fetch-streaming (not EventSource) so the Authorization header is sent: the stream is authenticated.
    const connect = () => {
        source?.close();
        if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
        }
        loading.value = state.value === null;
        const token = user.value?.token;
        source = openSseStream({
            url: sandboxMirrorAbsolute(urlsMap.posScreenStream(code())),
            headers: token ? { ...sessionHeaders(token), "X-Client-Channel": "merchant" } : {},
            onOpen: () => {
                connected.value = true;
                loading.value = false;
                retries = 0;
            },
            onFrame: (frame) => applyFrame(frame.data),
            onClose: () => {
                connected.value = false;
                loading.value = false;
                retries += 1;
                if (retries > 8) {
                    error.value = t("Something went wrong");
                    return;
                }
                retryTimer = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** retries));
            },
        });
    };

    const load = async () => {
        error.value = null;
        retries = 0;
        connect();
    };

    void load();

    onBeforeUnmount(() => {
        if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
        }
        source?.close();
        source = null;
    });

    return () => (
        <div
            style={{
                minHeight: "100vh",
                padding: "24px",
                background: "var(--pg-bg-canvas)",
            }}
        >
            <div style={{ width: "100%", maxWidth: "720px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" }}>
                <PageHeader
                    title={t("POS Screen")}
                    subtitle={state.value?.merchantName ?? ""}
                    end={() => (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <StatusBadge
                                status={connected.value ? "LIVE" : "PENDING"}
                                label={connected.value ? t("Live") : t("Pending")}
                                toneOverride={connected.value ? "success" : "warning"}
                            />
                            <VBtn
                                variant="outlined"
                                size="small"
                                onClick={() => void load()}
                                style={{ height: "32px" }}
                            >
                                {t("Refresh")}
                            </VBtn>
                        </div>
                    )}
                />

                {error.value ? (
                    <SurfaceCard>
                        <StateView error={error.value} onRetry={() => void load()} />
                    </SurfaceCard>
                ) : loading.value ? (
                    <SurfaceCard>
                        <StateView loading={true} />
                    </SurfaceCard>
                ) : state.value ? (
                    <SurfaceCard>
                        <SurfaceCardText>
                            <DescriptionList
                                columns={1}
                                items={[
                                    {
                                        label: t("Amount"),
                                        value: (
                                            <MoneyDisplay
                                                amount={state.value?.amount}
                                                currency={state.value?.currency || "LYD"}
                                                size="xl"
                                            />
                                        ),
                                    },
                                    {
                                        label: t("Status"),
                                        value: state.value?.status ? (
                                            <StatusBadge status={state.value.status} />
                                        ) : (
                                            "—"
                                        ),
                                    },
                                    {
                                        label: t("Rail Code"),
                                        value: state.value?.railCode ? (
                                            <StatusBadge
                                                status={state.value.railCode}
                                                label={state.value.railCode}
                                                toneOverride="neutral"
                                                showDot={false}
                                            />
                                        ) : (
                                            "—"
                                        ),
                                    },
                                    {
                                        label: t("Screen Code"),
                                        value: code() || "—",
                                        mono: true,
                                    },
                                    {
                                        label: t("Reference"),
                                        value: state.value?.reference || "—",
                                        mono: true,
                                    },
                                    {
                                        label: t("Updated At"),
                                        value: state.value?.updatedAt || "—",
                                    },
                                ]}
                            />
                            {state.value?.linkKey && (
                                <div style={{ marginTop: "16px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{t("Link")}</span>
                                    <MonoRef value={state.value.linkKey} truncate={42} />
                                </div>
                            )}
                        </SurfaceCardText>
                    </SurfaceCard>
                ) : (
                    <SurfaceCard>
                        <EmptyState
                            icon="mdi-monitor-off"
                            title={t("No Data Found")}
                            description={t("Waiting For Customer")}
                        />
                    </SurfaceCard>
                )}
            </div>
        </div>
    );
});

export default PosScreenPage;
