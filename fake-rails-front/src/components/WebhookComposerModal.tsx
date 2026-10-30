import { dc } from "kt-dc";
import { ref } from "vue";
import {
  VBtn, VDialog, VCard, VCardText, VCardTitle, VTextField, VSelect, VSwitch, VAlert,
} from "vuetify/components";
import { api } from "@/utils/api";

export const WebhookComposerModal = dc(
  (props: { transactionId: string | null; modelValue: boolean; onClose?: () => void }, _expose, ctx) => {
    const event = ref("payment.paid");
    const delaySeconds = ref(0);
    const duplicateCount = ref(1);
    const corrupt = ref(false);
    const outOfOrder = ref(false);
    const message = ref("");

    const close = () => props.onClose?.();

    const fire = async () => {
      if (!props.transactionId) return;
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
    };

    const dispute = async () => {
      if (!props.transactionId) return;
      await api(`/portal-api/webhooks/${encodeURIComponent(props.transactionId)}/dispute`, { method: "POST", body: {} });
      message.value = "Dispute webhook queued";
      setTimeout(close, 700);
    };

    return () => (
      <VDialog
        modelValue={props.modelValue}
        onUpdate:modelValue={(value: boolean | null) => { if (value === false) props.onClose?.(); }}
        maxWidth={560}
      >
        <VCard color="surface">
          <VCardTitle>Webhook composer</VCardTitle>
          <VCardText>
            {message.value ? <VAlert type="success" variant="tonal" class="mb-3">{message.value}</VAlert> : null}
            <VSelect
              label="Event" items={["payment.paid", "payment.failed", "payment.refunded", "transaction.pending", "DISPUTE_OPENED"]}
              modelValue={event.value} onUpdate:modelValue={(value: string) => { event.value = value; }}
            />
            <div class="d-flex ga-3">
              <VTextField label="Delay (s)" type="number" modelValue={delaySeconds.value}
                onUpdate:modelValue={(value: string) => { delaySeconds.value = Number(value); }} />
              <VTextField label="Duplicates" type="number" modelValue={duplicateCount.value}
                onUpdate:modelValue={(value: string) => { duplicateCount.value = Number(value); }} />
            </div>
            <VSwitch label="Forge signature" modelValue={corrupt.value}
              onUpdate:modelValue={(value: boolean | null) => { corrupt.value = value === true; }} />
            <VSwitch label="Send PENDING after PAID" modelValue={outOfOrder.value}
              onUpdate:modelValue={(value: boolean | null) => { outOfOrder.value = value === true; }} />
            <div class="d-flex ga-2 mt-3">
              <VBtn onClick={fire}>Fire webhook</VBtn>
              <VBtn color="warning" variant="tonal" onClick={dispute}>Open dispute</VBtn>
              <VBtn variant="text" onClick={close}>Cancel</VBtn>
            </div>
          </VCardText>
        </VCard>
      </VDialog>
    );
  },
  { props: ["transactionId", "modelValue", "onClose"] },
);

export default WebhookComposerModal;
