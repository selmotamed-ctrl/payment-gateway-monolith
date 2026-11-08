import { dc } from "kt-dc";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import type { EmbeddedClientAction } from "./types";
import {
    createBridgeHandler,
    getEmbedAllowlist,
    isAllowedEmbedUrl,
    isNonProductionBuild,
    normalizeOrigins,
    planEmbedScripts,
    sanitizeSandbox,
} from "@/utils/security/embedPolicy";

export type EmbeddedWidgetRendererProps = {
    action: EmbeddedClientAction;
    error?: string | null;
    onReady?: () => void;
    onCallback?: (payload: { event: string; data: Record<string, unknown> }) => void;
    onError?: (message: string) => void;
};

const embedAllowlist = getEmbedAllowlist(isNonProductionBuild());

export const EmbeddedWidgetRenderer = dc(
    (props: EmbeddedWidgetRendererProps) => {
        const { t } = useLocale();
        const loading = ref(true);
        const localError = ref<string | null>(null);
        const iframeRef = ref<HTMLIFrameElement | null>(null);
        // The server-configured widget origins extend (never replace) the
        // built-in provider allow-list.
        const widgetAllowlist = computed(
            () => new Set([...embedAllowlist, ...normalizeOrigins(props.action.allowed_origins)]),
        );
        const scriptPlan = computed(() =>
            planEmbedScripts(props.action.script_urls, props.action.script_sri_hashes, widgetAllowlist.value),
        );
        const iframeSrc = computed(() =>
            isAllowedEmbedUrl(props.action.iframe_src, widgetAllowlist.value) ? (props.action.iframe_src as string) : null,
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

        const bridgeHandler = (event: MessageEvent) =>
            createBridgeHandler({
                allowedOrigins: props.action.allowed_origins,
                getIframeWindow: () => iframeRef.value?.contentWindow ?? null,
                onCallback: (payload) => props.onCallback?.(payload),
            })(event);

        onBeforeUnmount(() => {
            window.removeEventListener("message", bridgeHandler);
            document.querySelectorAll("script[data-checkout-embed]").forEach((node) => node.remove());
        });

        onMounted(() => {
            window.addEventListener("message", bridgeHandler);
            if (props.action.iframe_src && !iframeSrc.value) {
                loading.value = false;
                localError.value = t("Security Policy");
                return;
            }
            if (iframeSrc.value) {
                loading.value = false;
                return;
            }
            if (!scriptPlan.value.length) {
                loading.value = false;
                localError.value = t("Security Policy");
                return;
            }
            scriptPlan.value.forEach(({ url, integrity }) => {
                const script = document.createElement("script");
                script.src = url;
                script.async = true;
                script.referrerPolicy = "no-referrer";
                script.integrity = integrity;
                script.crossOrigin = "anonymous";
                script.setAttribute("data-checkout-embed", "1");
                script.addEventListener("load", onScriptLoad);
                script.addEventListener("error", onScriptError);
                document.head.appendChild(script);
            });
        });

        return () => (
            <ThemedView style={{ gap: "14px", width: "100%" }}>
                <ThemedText
                    type="defaultSemiBold"
                    style={{ fontSize: "17px", color: "var(--pg-ink-primary)" }}
                >
                    {t("Embedded Widget")}
                </ThemedText>

                {(props.error || localError.value) && (
                    <VAlert type="error" variant="tonal" density="compact">
                        {props.error || localError.value}
                    </VAlert>
                )}

                {props.action.iframe_src ? (
                    iframeSrc.value && (
                    <iframe
                        ref={iframeRef}
                        src={iframeSrc.value}
                        sandbox={sanitizeSandbox(props.action.iframe_sandbox)}
                        referrerpolicy="no-referrer"
                        title={t("Embedded Widget")}
                        style={{
                            width: "100%",
                            minHeight: "420px",
                            border: "1px solid var(--pg-border-subtle)",
                            borderRadius: "var(--pg-radius-md)",
                            backgroundColor: "var(--pg-bg-surface)",
                        }}
                    ></iframe>
                    )
                ) : (
                    <div
                        id={`checkout-embed-${props.action.sdk_driver}`}
                        data-sdk-driver={props.action.sdk_driver}
                        style={{
                            width: "100%",
                            minHeight: "260px",
                            border: "1px dashed var(--pg-border-strong)",
                            borderRadius: "var(--pg-radius-md)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: "var(--pg-bg-surface-subtle)",
                        }}
                    >
                        <ThemedText style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                            {t("Loading")}
                        </ThemedText>
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
