import { dc } from "kt-dc";
import { onBeforeUnmount, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VBtn } from "vuetify/components";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";

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

    let source: EventSource | null = null;

    const code = () => String(route.params.code ?? "");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.posScreenStream(code()));
            const payload = response.data?.data ?? response.data ?? {};
            state.value = payload.screen ?? payload;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const connect = () => {
        if (typeof EventSource === "undefined") {
            error.value = "realtime streaming is not available in this browser";
            return;
        }
        source?.close();
        source = new EventSource(`${urlsMap.posScreenStream(code())}`);
        source.onopen = () => {
            connected.value = true;
        };
        source.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                state.value = payload.screen ?? payload;
            } catch {
                error.value = "received an unreadable realtime frame";
            }
        };
        source.onerror = () => {
            connected.value = false;
        };
    };

    void load().then(() => connect());

    onBeforeUnmount(() => {
        source?.close();
        source = null;
    });

    return () => (
        <div
            style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px",
                background: "var(--pg-bg-canvas)",
            }}
        >
            <div style={{ width: "100%", maxWidth: "680px", display: "flex", flexDirection: "column", gap: "16px" }}>
                <header
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "12px",
                        flexWrap: "wrap",
                    }}
                >
                    <h1
                        style={{
                            margin: 0,
                            color: "var(--pg-ink-primary)",
                            fontSize: "18px",
                            fontWeight: 600,
                            letterSpacing: "-0.02em",
                        }}
                    >
                        {t("POS Screen")} · <span class="pg-mono">{code()}</span>
                    </h1>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                        <StatusBadge
                            status={connected.value ? "LIVE" : "PENDING"}
                            label={connected.value ? t("Live") : t("Pending")}
                            toneOverride={connected.value ? "success" : "warning"}
                        />
                        <VBtn variant="outlined" size="small" onClick={() => void load()} style={{ height: "32px" }}>
                            {t("Refresh")}
                        </VBtn>
                    </div>
                </header>

                {error.value ? (
                    <SurfaceCard>
                        <StateView error={error.value} onRetry={() => void load()} />
                    </SurfaceCard>
                ) : loading.value ? (
                    <SurfaceCard>
                        <StateView loading={true} />
                    </SurfaceCard>
                ) : (
                    <SurfaceCard>
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: "20px",
                                textAlign: "center",
                            }}
                        >
                            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                <span
                                    style={{
                                        color: "var(--pg-ink-muted)",
                                        fontSize: "11.5px",
                                        fontWeight: 600,
                                        letterSpacing: "0.05em",
                                        textTransform: "uppercase",
                                    }}
                                >
                                    {t("Merchant Name")}
                                </span>
                                <span
                                    style={{
                                        color: "var(--pg-ink-primary)",
                                        fontSize: "22px",
                                        fontWeight: 600,
                                        letterSpacing: "-0.02em",
                                    }}
                                >
                                    {state.value?.merchantName ?? "—"}
                                </span>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                                <span
                                    style={{
                                        color: "var(--pg-ink-muted)",
                                        fontSize: "11.5px",
                                        fontWeight: 600,
                                        letterSpacing: "0.05em",
                                        textTransform: "uppercase",
                                    }}
                                >
                                    {t("Amount")}
                                </span>
                                {state.value?.amount != null ? (
                                    <MoneyDisplay
                                        amount={state.value.amount}
                                        currency={state.value.currency || "LYD"}
                                        size="xl"
                                    />
                                ) : (
                                    <span style={{ color: "var(--pg-ink-faint)", fontSize: "24px" }}>—</span>
                                )}
                            </div>

                            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
                                {state.value?.status && <StatusBadge status={state.value.status} />}
                                {state.value?.railCode && (
                                    <StatusBadge
                                        status={state.value.railCode}
                                        label={state.value.railCode}
                                        toneOverride="neutral"
                                        showDot={false}
                                    />
                                )}
                            </div>

                            {state.value?.reference && (
                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "center",
                                        gap: "5px",
                                        paddingTop: "16px",
                                        borderTop: "1px solid var(--pg-border-subtle)",
                                        width: "100%",
                                    }}
                                >
                                    <span
                                        style={{
                                            color: "var(--pg-ink-muted)",
                                            fontSize: "11.5px",
                                            fontWeight: 600,
                                            letterSpacing: "0.05em",
                                            textTransform: "uppercase",
                                        }}
                                    >
                                        {t("Reference")}
                                    </span>
                                    <MonoRef value={state.value?.reference ?? ""} />
                                </div>
                            )}
                        </div>
                    </SurfaceCard>
                )}
            </div>
        </div>
    );
});

export default PosScreenPage;
