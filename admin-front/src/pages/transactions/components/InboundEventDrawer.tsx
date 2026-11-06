import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { formatDateTime } from "@/components/ledger/format";
import { flattenPayload } from "../payloadRows";
import { PayloadRows, payloadPropsOfText } from "./PayloadRows";

export interface InboundEventDetail {
    id: string;
    receivedAt: string;
    gatewayId: string;
    gateway: { id: string; code: string; name: string };
    channelId: string;
    env: string;
    sourceIp: string;
    verified: boolean;
    verificationError: string | null;
    attemptId: string | null;
    processedAt: string | null;
    processingResult: string | null;
    dedupeKey: string;
    redactedHeaders?: unknown;
    bodyPreview?: string;
    bodySize?: number;
    bodySha256?: string;
}

/** Inbound provider webhook inspector: verification verdict, redacted headers, body preview as fields. */
export const InboundEventDrawer = defineComponent({
    name: "InboundEventDrawer",
    props: {
        eventId: { type: String as PropType<string | null>, default: null },
    },
    emits: ["close", "openAttempt"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const detail = ref<InboundEventDetail | null>(null);
        const loading = ref(false);
        const error = ref<string | null>(null);
        let seq = 0;

        const load = async (id: string) => {
            const current = ++seq;
            loading.value = true;
            error.value = null;
            detail.value = null;
            try {
                const response = await api.get(urlsMap.inboundEventDetail(id));
                if (current !== seq) return;
                detail.value = (response.data?.data ?? response.data) as InboundEventDetail;
            } catch (cause) {
                if (current !== seq) return;
                error.value = extractApiErrorMessage(cause);
            } finally {
                if (current === seq) loading.value = false;
            }
        };

        watch(
            () => props.eventId,
            (id) => {
                if (id) void load(id);
                else {
                    seq += 1;
                    detail.value = null;
                    error.value = null;
                    loading.value = false;
                }
            },
            { immediate: true },
        );

        const headerRows = computed(() => flattenPayload(detail.value?.redactedHeaders ?? {}));
        const bodyProps = computed(() => payloadPropsOfText(detail.value?.bodyPreview));

        const body = (): VNodeChild => {
            if (loading.value) return <StateView loading minHeight="200px" />;
            if (error.value) return <StateView error={error.value} minHeight="200px" onRetry={() => props.eventId && void load(props.eventId)} />;
            const event = detail.value;
            if (!event) return null;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                        <StatusBadge status={event.verified ? "VERIFIED" : "UNVERIFIED"} label={event.verified ? t("Signature verified") : t("Signature not verified")} toneOverride={event.verified ? "success" : "danger"} />
                        <StatusBadge status={event.attemptId ? "MATCHED" : "UNMATCHED"} label={event.attemptId ? t("Matched to attempt") : t("Unmatched")} toneOverride={event.attemptId ? "success" : "warning"} />
                        <StatusBadge status={event.env} label={event.env} toneOverride={event.env === "LIVE" ? "warning" : "info"} showDot={false} />
                    </div>
                    {event.verificationError && (
                        <div role="alert" style={{ padding: "10px 12px", borderRadius: "var(--pg-radius-sm)", backgroundColor: "var(--pg-status-danger-bg)", border: "1px solid var(--pg-status-danger-border)", color: "var(--pg-status-danger-text)", fontSize: "13px" }}>
                            {event.verificationError}
                        </div>
                    )}
                    <DescriptionList
                        items={[
                            { label: t("Event ID"), value: <MonoRef value={event.id} truncate={22} /> },
                            { label: t("Received at"), value: formatDateTime(event.receivedAt) },
                            { label: t("Gateway"), value: `${event.gateway.code} · ${event.gateway.name}` },
                            { label: t("Channel"), value: <MonoRef value={event.channelId} truncate={22} /> },
                            { label: t("Source IP"), value: event.sourceIp, mono: true },
                            { label: t("Attempt"), value: event.attemptId ? <MonoRef value={event.attemptId} truncate={22} /> : "—" },
                            { label: t("Processed at"), value: formatDateTime(event.processedAt) },
                            { label: t("Processing result"), value: event.processingResult || "—" },
                            { label: t("Deduplication key"), value: <MonoRef value={event.dedupeKey} truncate={22} /> },
                        ]}
                    />
                    <SurfaceCard title={t("Headers")} subtitle={t("Secrets are redacted before they leave the server")}>
                        <PayloadRows rows={headerRows.value.rows} truncated={headerRows.value.truncated} emptyLabel={t("No headers recorded")} />
                    </SurfaceCard>
                    <SurfaceCard
                        title={t("Body preview")}
                        subtitle={event.bodySize !== undefined ? `${event.bodySize} ${t("bytes")} · SHA-256 ${String(event.bodySha256 ?? "").slice(0, 16)}…` : undefined}
                    >
                        <PayloadRows rows={bodyProps.value.rows} truncated={bodyProps.value.truncated} text={bodyProps.value.text} emptyLabel={t("Empty body")} />
                    </SurfaceCard>
                </div>
            );
        };

        return (): VNodeChild => (
            <SlideOverDrawer
                modelValue={!!props.eventId}
                onUpdate:modelValue={(open: boolean) => {
                    if (!open) emit("close");
                }}
                title={t("Inbound webhook")}
                subtitle={detail.value ? formatDateTime(detail.value.receivedAt) : ""}
                width={640}
                v-slots={{
                    default: body,
                    footer: () => (
                        <>
                            {detail.value?.attemptId && (
                                <VBtn variant="tonal" prependIcon="mdi-credit-card-outline" onClick={() => emit("openAttempt", detail.value!.attemptId)}>{t("Open attempt")}</VBtn>
                            )}
                            <VBtn variant="text" onClick={() => emit("close")}>{t("Close")}</VBtn>
                        </>
                    ),
                }}
            />
        );
    },
});

export default InboundEventDrawer;
