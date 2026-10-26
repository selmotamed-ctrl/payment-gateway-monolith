import { dc } from "kt-dc";
import { ref, watch } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VProgressCircular } from "vuetify/components";
import QRCode from "qrcode";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import type { QrOrCodeClientAction } from "./types";

export type QrOrCodeRendererProps = {
    action: QrOrCodeClientAction;
    error?: string | null;
};

export const QrOrCodeRenderer = dc(
    (props: QrOrCodeRendererProps) => {
        const { t, current } = useLocale();
        const qrDataUrl = ref<string | null>(null);
        const qrError = ref<string | null>(null);

        const build = async () => {
            qrError.value = null;
            try {
                qrDataUrl.value = await QRCode.toDataURL(props.action.qr_payload ?? "", {
                    width: 260,
                    margin: 2,
                    errorCorrectionLevel: "M",
                });
            } catch (e) {
                qrError.value = e instanceof Error ? e.message : String(e);
            }
        };

        watch(
            () => props.action.qr_payload,
            () => {
                void build();
            },
            { immediate: true },
        );

        const instructions = () =>
            current.value === "ar" ? props.action.instructions_ar : props.action.instructions_en;

        return () => (
            <ThemedView style={{ gap: "16px", width: "100%", alignItems: "center" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                    {t("Scan The QR Code")}
                </ThemedText>

                {(props.error || qrError.value) && (
                    <VAlert type="error" variant="tonal" density="compact">
                        {props.error || qrError.value}
                    </VAlert>
                )}

                {qrDataUrl.value ? (
                    <div
                        style={{
                            padding: "12px",
                            background: "#ffffff",
                            borderRadius: "14px",
                            border: "1px solid rgba(100,116,139,0.25)",
                        }}
                    >
                        <img src={qrDataUrl.value} alt="qr" width={"240px"} height={"240px"} />
                    </div>
                ) : (
                    <VProgressCircular indeterminate size={"40px"} color="primary" />
                )}

                {props.action.pay_code && (
                    <ThemedView style={{ alignItems: "center", gap: "4px" }}>
                        <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{t("Pay Code")}</ThemedText>
                        <ThemedText
                            type="defaultSemiBold"
                            style={{ fontSize: "22px", letterSpacing: "3px", direction: "ltr" }}
                        >
                            {props.action.pay_code}
                        </ThemedText>
                    </ThemedView>
                )}

                {instructions() && (
                    <ThemedText style={{ fontSize: "13px", opacity: 0.8, textAlign: "center" }}>
                        {instructions()}
                    </ThemedText>
                )}

                {props.action.deep_link_url && (
                    <a href={props.action.deep_link_url} class="text-primary" style={{ fontSize: "13px" }}>
                        {t("Deep Link")}
                    </a>
                )}

                {props.action.expires_at && (
                    <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                        {t("Expires At")}: {props.action.expires_at}
                    </ThemedText>
                )}
            </ThemedView>
        );
    },
    {
        props: ["action", "error"],
    },
);

export default QrOrCodeRenderer;
