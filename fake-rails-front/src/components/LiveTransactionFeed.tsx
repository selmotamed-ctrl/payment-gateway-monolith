import { dc } from "kt-dc";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { VCard, VCardText, VChip, VList, VListItem, VListItemTitle, VListItemSubtitle } from "vuetify/components";
import { streamUrl } from "@/utils/api";

export interface LiveEvent {
  type: string;
  at: string;
  payload: Record<string, any>;
}

export const LiveTransactionFeed = dc(
  (props: { max?: number; compact?: boolean }, _expose, _ctx) => {
    const events = ref<LiveEvent[]>([]);
    const connected = ref(false);
    let source: EventSource | undefined;

    const push = (type: string, data: string) => {
      try {
        const parsed = JSON.parse(data) as LiveEvent;
        events.value = [parsed, ...events.value].slice(0, props.max ?? 50);
      } catch {
        // ignore malformed frames
      }
    };

    onMounted(() => {
      source = new EventSource(streamUrl());
      source.addEventListener("ready", () => { connected.value = true; });
      source.addEventListener("rail.request", (event) => push("rail.request", (event as MessageEvent).data));
      source.addEventListener("webhook.sent", (event) => push("webhook.sent", (event as MessageEvent).data));
      source.addEventListener("webhook.failed", (event) => push("webhook.failed", (event as MessageEvent).data));
      source.addEventListener("transaction.action", (event) => push("transaction.action", (event as MessageEvent).data));
      source.onerror = () => { connected.value = false; };
    });

    onBeforeUnmount(() => source?.close());

    return () => (
      <VCard color="surface">
        <VCardText class="d-flex align-center">
          <strong>Live wire feed</strong>
          <VChip size="small" class="ml-3" color={connected.value ? "success" : "error"} variant="tonal">
            {connected.value ? "SSE connected" : "reconnecting"}
          </VChip>
        </VCardText>
        <VList density="compact" style={{ maxHeight: props.compact ? "240px" : "520px", overflowY: "auto" }}>
          {events.value.length === 0 ? (
            <VListItem><VListItemTitle class="text-medium-emphasis">Waiting for gateway calls…</VListItemTitle></VListItem>
          ) : null}
          {events.value.map((event, index) => (
            <VListItem key={`${event.at}-${index}`}>
              <VListItemTitle class="pg-mono">
                {event.payload?.method ?? event.type} {event.payload?.path ?? event.payload?.gatewayCode ?? ""}
              </VListItemTitle>
              <VListItemSubtitle class="pg-mono">
                {event.payload?.gatewayCode ?? event.payload?.gateway_code ?? ""} · {event.payload?.status ?? event.payload?.state ?? ""} · {event.payload?.ourReference ?? event.payload?.transactionId ?? ""}
              </VListItemSubtitle>
            </VListItem>
          ))}
        </VList>
      </VCard>
    );
  },
  { props: ["max", "compact"] },
);

export default LiveTransactionFeed;
