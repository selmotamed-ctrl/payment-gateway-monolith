import { dc } from "kt-dc";
import { onBeforeUnmount, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VBtn, VCard, VCardText } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";

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
                background: "linear-gradient(160deg, #0b1524 0%, #123a6b 60%, #0b7d72 100%)",
            }}
        >
            <div style={{ width: "100%", maxWidth: "680px", display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <ThemedText style={{ color: "#ffffff", fontSize: "18px", fontWeight: "800" }}>
                        {t("POS Screen")} · {code()}
                    </ThemedText>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <StatusChip label={connected.value ? t("Live") : t("Pending")} tone={connected.value ? "success" : "warning"} />
                        <VBtn variant="tonal" size="small" onClick={() => void load()}>
                            {t("Refresh")}
                        </VBtn>
                    </div>
                </div>

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <VCard style={{ background: "rgba(255,255,255,0.96)" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px", alignItems: "center" }}>
                            <ThemedText style={{ fontSize: "22px", fontWeight: "800" }}>
                                {state.value?.merchantName ?? "-"}
                            </ThemedText>
                            {state.value?.amount != null && (
                                <MoneyText value={state.value.amount} currency={state.value.currency} bold />
                            )}
                            {state.value?.status && <StatusChip label={state.value.status} tone="info" />}
                            {state.value?.railCode && (
                                <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>{state.value.railCode}</ThemedText>
                            )}
                            {state.value?.reference && (
                                <ThemedText style={{ fontSize: "12px", opacity: 0.6, direction: "ltr" }}>
                                    {state.value.reference}
                                </ThemedText>
                            )}
                        </VCardText>
                    </VCard>
                )}
            </div>
        </div>
    );
});

export default PosScreenPage;
