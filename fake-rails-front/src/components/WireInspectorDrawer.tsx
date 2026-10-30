import { dc } from "kt-dc";
import { ref, watch } from "vue";
import {
  VBtn, VCard, VCardText, VChip, VDivider, VNavigationDrawer,
} from "vuetify/components";
import { api } from "@/utils/api";

interface InspectorData {
  transaction: Record<string, any>;
  events: Array<Record<string, any>>;
  deliveries: Array<Record<string, any>>;
}

export const WireInspectorDrawer = dc(
  (props: { transactionId: string | null; modelValue: boolean; onClose?: () => void }, expose, ctx) => {
    const data = ref<InspectorData | null>(null);
    const loading = ref(false);

    const load = async (id: string) => {
      loading.value = true;
      try {
        data.value = await api<InspectorData>(`/portal-api/transactions/${encodeURIComponent(id)}`);
      } finally {
        loading.value = false;
      }
    };

    watch(
      () => props.transactionId,
      (id) => {
        if (id && props.modelValue) void load(id);
      },
      { immediate: true },
    );

    expose({ reload: () => props.transactionId && load(props.transactionId) });

    const close = () => props.onClose?.();

    return () => (
      <VNavigationDrawer
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean | null) => { if (value === false) props.onClose?.(); }}
        location="right"
        width={720}
        temporary
        color="surface"
      >
        <div class="pa-4 d-flex align-center">
          <strong>Wire inspector</strong>
          <VChip size="small" class="ml-3" variant="tonal">{props.transactionId ?? ""}</VChip>
          <div style={{ flex: 1 }} />
          <VBtn variant="text" onClick={close}>Close</VBtn>
        </div>
        <VDivider />
        {loading.value ? <div class="pa-4">Loading…</div> : null}
        {data.value ? (
          <div class="pa-4">
            <VCard color="surface-variant" class="mb-4">
              <VCardText class="pg-mono">
                <div>our_reference: {data.value.transaction.our_reference}</div>
                <div>provider_reference: {data.value.transaction.provider_reference}</div>
                <div>rail: {data.value.transaction.rail_code} · status: {data.value.transaction.status}</div>
                <div>amount: {data.value.transaction.normalized_amount_lyd} {data.value.transaction.currency}</div>
                <div>expected OTP: {data.value.transaction.expected_otp ?? "-"}</div>
                <div>assigned fate: {data.value.transaction.assigned_fail_phase ?? "-"} / {data.value.transaction.assigned_failure_mode ?? "-"}</div>
              </VCardText>
            </VCard>

            <h3>Step events</h3>
            {data.value.events.map((event) => (
              <VCard key={event.id} color="surface-variant" class="mb-3">
                <VCardText>
                  <div class="d-flex ga-2 mb-2">
                    <VChip size="x-small">{event.phase}</VChip>
                    <VChip size="x-small" variant="tonal">{event.method} {event.path}</VChip>
                    <VChip size="x-small" color={event.response_status >= 400 ? "error" : "success"} variant="tonal">
                      {event.response_status}
                    </VChip>
                    {event.injected_fault ? <VChip size="x-small" color="warning">{event.injected_fault}</VChip> : null}
                  </div>
                  <div class="pg-mono">request: {String(event.request_body_raw).slice(0, 400)}</div>
                  <div class="pg-mono">response: {String(event.response_body_raw).slice(0, 400)}</div>
                </VCardText>
              </VCard>
            ))}

            <h3>Webhook deliveries</h3>
            <table class="w-100">
              <thead><tr><th>Event</th><th>State</th><th>Signature</th><th>Status</th></tr></thead>
              <tbody>
                {data.value.deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td class="pg-mono">{delivery.request_headers_json?.includes("payment.paid") ? "payment.paid" : "webhook"}</td>
                    <td>{delivery.state}</td>
                    <td>{delivery.signature_valid ? "valid" : "FORGED"}</td>
                    <td>{delivery.response_status ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </VNavigationDrawer>
    );
  },
  { props: ["transactionId", "modelValue", "onClose"] },
);

export default WireInspectorDrawer;
