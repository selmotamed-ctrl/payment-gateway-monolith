import { dc } from "kt-dc";
import { ref, watch } from "vue";
import { VBtn, VDivider, VNavigationDrawer } from "vuetify/components";
import { DataTable } from "@/components/Table/DataTable";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/utils/api";

interface InspectorData {
  transaction: Record<string, any>;
  events: Array<Record<string, any>>;
  deliveries: Array<Record<string, any>>;
}

export const WireInspectorDrawer = dc(
  (props: { transactionId: string | null; modelValue: boolean; onClose?: () => void }, expose, _ctx) => {
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

    const deliveryHeaders: TableHeader<Record<string, any>>[] = [
      {
        key: "event",
        label: "Event",
        Value: ({ row }) => (
          <MonoRef value={String(row.request_headers_json ?? "").includes("payment.paid") ? "payment.paid" : "webhook"} />
        ),
      },
      {
        key: "state",
        label: "State",
        Value: ({ row }) => <StatusBadge status={String(row.state ?? "")} />,
      },
      {
        key: "signature_valid",
        label: "Signature",
        Value: ({ row }) => (
          <StatusBadge
            status={row.signature_valid ? "VALID" : "FORGED"}
            label={row.signature_valid ? "valid" : "FORGED"}
            toneOverride={row.signature_valid ? "success" : "danger"}
            showDot={false}
          />
        ),
      },
      { key: "response_status", label: "Status" },
    ];

    return () => (
      <VNavigationDrawer
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean | null) => { if (value === false) props.onClose?.(); }}
        location="right"
        width={720}
        temporary
        class="pg-slide-over"
      >
        <div class="pa-4 d-flex align-center ga-3">
          <strong>Wire inspector</strong>
          <StatusBadge status={props.transactionId ?? ""} label={props.transactionId ?? ""} toneOverride="neutral" showDot={false} />
          <div style={{ flex: 1 }} />
          <VBtn variant="text" onClick={close}>Close</VBtn>
        </div>
        <VDivider />
        {loading.value ? <div class="pa-4">Loading…</div> : null}
        {data.value ? (
          <div class="pa-4 d-flex flex-column ga-4">
            <SurfaceCard subtle>
              <div class="pg-mono d-flex flex-column ga-2">
                <div>our_reference: <MonoRef value={String(data.value.transaction.our_reference ?? "")} /></div>
                <div>provider_reference: <MonoRef value={String(data.value.transaction.provider_reference ?? "")} /></div>
                <div>rail: {data.value.transaction.rail_code} · status: {data.value.transaction.status}</div>
                <div>amount: <span class="pg-money pg-tabular">{data.value.transaction.normalized_amount_lyd} {data.value.transaction.currency}</span></div>
                <div>expected OTP: {data.value.transaction.expected_otp ?? "-"}</div>
                <div>assigned fate: {data.value.transaction.assigned_fail_phase ?? "-"} / {data.value.transaction.assigned_failure_mode ?? "-"}</div>
              </div>
            </SurfaceCard>

            <h3 class="pg-heading">Step events</h3>
            {data.value.events.map((event) => (
              <SurfaceCard key={event.id} subtle>
                <div class="d-flex ga-2 mb-2 flex-wrap">
                  <StatusBadge status={String(event.phase ?? "")} toneOverride="neutral" showDot={false} />
                  <StatusBadge status={String(event.method ?? "")} label={`${event.method ?? ""} ${event.path ?? ""}`} toneOverride="info" showDot={false} />
                  <StatusBadge
                    status={event.response_status >= 400 ? "FAILED" : "SUCCEEDED"}
                    label={String(event.response_status)}
                    toneOverride={event.response_status >= 400 ? "danger" : "success"}
                    showDot={false}
                  />
                  {event.injected_fault ? (
                    <StatusBadge status="FAULT" label={String(event.injected_fault)} toneOverride="warning" showDot={false} />
                  ) : null}
                </div>
                <div class="pg-mono">request: {String(event.request_body_raw).slice(0, 400)}</div>
                <div class="pg-mono">response: {String(event.response_body_raw).slice(0, 400)}</div>
              </SurfaceCard>
            ))}

            <h3 class="pg-heading">Webhook deliveries</h3>
            <DataTable
              data={data.value.deliveries}
              headers={deliveryHeaders}
              title="Deliveries"
              numberOfItemsPerPage={10}
            />
          </div>
        ) : null}
      </VNavigationDrawer>
    );
  },
  { props: ["transactionId", "modelValue", "onClose"] },
);

export default WireInspectorDrawer;
