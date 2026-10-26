import { dc } from "kt-dc";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import type { EmbeddedClientAction } from "./types";

export type EmbeddedWidgetRendererProps = {
    action: EmbeddedClientAction;
    error?: string | null;
    onReady?: () => void;
    onCallback?: (payload: { event: string; data: Record<string, unknown> }) => void;
    onError?: (message: string) => void;
};

const SCRIPT_ALLOWLIST_HOSTS = [
    "https://payments.moamalat.ly",
    "https://secure.moamalat.ly",
    "https://test.mpgmerchant.test",
    "https://pay.evowallet.net",
    "https://js.numo-pay.com",
];

const isAllowlistedScript = (url: string): boolean => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") {
            return false;
        }
        return SCRIPT_ALLOWLIST_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    } catch {
        return false;
    }
};

const buildIntegrityAttributes = (url: string, sriHashes: string[]): string[] => {
    const index = SCRIPT_ALLOWLIST_HOSTS.findIndex((host) => {
        try {
            return new URL(url).hostname.endsWith(host);
        } catch {
            return false;
        }
    });
    const hash = sriHashes[index] ?? sriHashes[0];
    return hash ? [hash] : [];
};

export const EmbeddedWidgetRenderer = dc(
    (props: EmbeddedWidgetRendererProps) => {
        const { t } = useLocale();
        const loading = ref(true);
        const localError = ref<string | null>(null);
        const allowedScripts = computed(() =>
            (props.action.script_urls ?? []).filter((url) => isAllowlistedScript(url)),
        );

        const onScriptLoad = () => {
            loading.value = false;
            props.onReady?.();
        };

        const onScriptError = () => {
            loading.value = false;
            localError.value = t("Something went wrong");
            props.onError?.(t("Something went wrong"));
        };

        const bridgeHandler = (event: MessageEvent) => {
            const origin = String(event.origin ?? "");
            const allowedOrigins = props.action.allowed_origins ?? [];
            if (allowedOrigins.length && !allowedOrigins.includes(origin)) {
                return;
            }
            const data = (event.data ?? {}) as Record<string, unknown>;
            const eventName = String(data.event ?? data.type ?? "callback");
            props.onCallback?.({ event: eventName, data });
        };

        onBeforeUnmount(() => {
            window.removeEventListener("message", bridgeHandler);
            document.querySelectorAll("script[data-checkout-embed]").forEach((node) => node.remove());
        });

        onMounted(() => {
            window.addEventListener("message", bridgeHandler);
            if (!allowedScripts.value.length) {
                loading.value = false;
                localError.value = t("Security Policy");
                return;
            }
            allowedScripts.value.forEach((url, index) => {
                const script = document.createElement("script");
                script.src = url;
                script.async = true;
                script.referrerPolicy = "no-referrer";
                const integrity = buildIntegrityAttributes(url, props.action.script_sri_hashes ?? []);
                if (integrity.length) {
                    script.integrity = integrity[0]!;
                    script.crossOrigin = "anonymous";
                }
                script.addEventListener("load", onScriptLoad);
                script.addEventListener("error", onScriptError);
                document.head.appendChild(script);
                void index;
            });
        });

        return () => (
            <ThemedView style={{ gap: "14px", width: "100%" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                    {t("Embedded Widget")}
                </ThemedText>

                {(props.error || localError.value) && (
                    <VAlert type="error" variant="tonal" density="compact">
                        {props.error || localError.value}
                    </VAlert>
                )}

                {props.action.iframe_src ? (
                    <iframe
                        src={props.action.iframe_src}
                        sandbox={props.action.iframe_sandbox || "allow-scripts allow-forms"}
                        referrerpolicy="no-referrer"
                        title={t("Embedded Widget")}
                        style={{
                            width: "100%",
                            minHeight: "420px",
                            border: "1px solid rgba(100,116,139,0.3)",
                            borderRadius: "12px",
                        }}
                    ></iframe>
                ) : (
                    <div
                        id={`checkout-embed-${props.action.sdk_driver}`}
                        data-sdk-driver={props.action.sdk_driver}
                        style={{
                            width: "100%",
                            minHeight: "260px",
                            border: "1px dashed rgba(100,116,139,0.4)",
                            borderRadius: "12px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                        }}
                    >
                        <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>{t("Loading")}</ThemedText>
                    </div>
                )}

                {!loading.value && !props.action.iframe_src && (
                    <VBtn variant="tonal" onClick={() => props.onReady?.()}>
                        {t("Continue To Payment")}
                    </VBtn>
                )}
            </ThemedView>
        );
    },
    {
        props: ["action", "error", "onReady", "onCallback", "onError"],
    },
);

export default EmbeddedWidgetRenderer;
