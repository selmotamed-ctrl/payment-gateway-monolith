import { dc } from "kt-dc";
import { ref } from "vue";
import { VAlert, VBtn, VSelect, VSwitch, VTextField } from "vuetify/components";
import { FormModal } from "@/components/ui/FormModal";
import { SectionFields } from "@/components/SectionFields";
import { api } from "@/utils/api";

export const WebhookComposerModal = dc(
  (props: { transactionId: string | null; modelValue: boolean; onClose?: () => void }, _expose, _ctx) => {
    const event = ref("payment.paid");
    const delaySeconds = ref(0);
    const duplicateCount = ref(1);
    const corrupt = ref(false);
    const outOfOrder = ref(false);
    const message = ref("");
    const busy = ref(false);

    const close = () => props.onClose?.();

    const fire = async () => {
      if (!props.transactionId) return;
      busy.value = true;
      try {
        await api(`/portal-api/webhooks/${encodeURIComponent(props.transactionId)}/fire`, {
          method: "POST",
          body: {
            event: event.value,
            delaySeconds: delaySeconds.value,
            duplicateCount: duplicateCount.value,
            corruptSignatureChancePercent: corrupt.value ? 100 : 0,
            outOfOrderPendingAfterPaid: outOfOrder.value,
          },
        });
        message.value = "Webhook queued";
        setTimeout(close, 700);
      } finally {
        busy.value = false;
      }
    };

    const dispute = async () => {
      if (!props.transactionId) return;
      busy.value = true;
      try {
        await api(`/portal-api/webhooks/${encodeURIComponent(props.transactionId)}/dispute`, { method: "POST", body: {} });
        message.value = "Dispute webhook queued";
        setTimeout(close, 700);
      } finally {
        busy.value = false;
      }
    };

    return () => (
      <FormModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean) => { if (!value) close(); }}
        title="Webhook composer"
        size="md"
        loading={busy.value}
        onSubmit={fire}
        v-slots={{
          footer: () => (
            <>
              <VBtn variant="text" disabled={busy.value} onClick={close}>Cancel</VBtn>
              <VBtn variant="outlined" color="warning" disabled={busy.value} onClick={dispute}>Open dispute</VBtn>
              <VBtn variant="flat" loading={busy.value} disabled={busy.value} onClick={fire}>Fire webhook</VBtn>
            </>
          ),
        }}
      >
        {message.value ? <VAlert type="success" variant="tonal" density="compact">{message.value}</VAlert> : null}
        <SectionFields title="Payload" columns={2}>
          <div class="pg-field-wrapper">
            <label>Event</label>
            <VSelect
              density="compact"
              variant="outlined"
              hideDetails
              items={["payment.paid", "payment.failed", "payment.refunded", "transaction.pending", "DISPUTE_OPENED"]}
              modelValue={event.value}
              onUpdate:modelValue={(value: string) => { event.value = value; }}
            />
          </div>
          <div class="pg-field-wrapper">
            <label>Delay (s)</label>
            <VTextField
              type="number"
              density="compact"
              variant="outlined"
              hideDetails
              modelValue={delaySeconds.value}
              onUpdate:modelValue={(value: string) => { delaySeconds.value = Number(value); }}
            />
          </div>
          <div class="pg-field-wrapper">
            <label>Duplicates</label>
            <VTextField
              type="number"
              density="compact"
              variant="outlined"
              hideDetails
              modelValue={duplicateCount.value}
              onUpdate:modelValue={(value: string) => { duplicateCount.value = Number(value); }}
            />
          </div>
          <div class="pg-field-wrapper">
            <label>Signature</label>
            <VSwitch
              label="Forge signature"
              density="compact"
              hideDetails
              modelValue={corrupt.value}
              onUpdate:modelValue={(value: boolean | null) => { corrupt.value = value === true; }}
            />
            <VSwitch
              label="Send PENDING after PAID"
              density="compact"
              hideDetails
              modelValue={outOfOrder.value}
              onUpdate:modelValue={(value: boolean | null) => { outOfOrder.value = value === true; }}
            />
          </div>
        </SectionFields>
      </FormModal>
    );
  },
  { props: ["transactionId", "modelValue", "onClose"] },
);

export default WebhookComposerModal;
