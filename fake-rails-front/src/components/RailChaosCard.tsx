import { dc } from "kt-dc";
import { ref } from "vue";
import {
  VBtn, VCard, VCardText, VChip, VSlider, VSwitch, VSelect, VTextField, VDivider,
} from "vuetify/components";
import { api } from "@/utils/api";

interface Scenario {
  railCode: string;
  gatewayCode: string;
  enabled: boolean;
  overallFailureChancePercent: number;
  latencyMs: { min: number; max: number };
  webhookBehavior: {
    delaySeconds: number;
    duplicateCount: number;
    outOfOrderPendingAfterPaid: boolean;
    corruptSignatureChancePercent: number;
  };
  phaseBreakdown: Record<string, number>;
  failureModeWeights: Record<string, number>;
}

interface Descriptor {
  railCode: string;
  gatewayCode: string;
  name: string;
  collectionModes: string[];
}

const FAILURE_MODES = [
  "TERMINAL_DECLINE_INSUFFICIENT_FUNDS",
  "LIMIT_EXCEEDED_CUSTOMER_CEILING",
  "WRONG_OTP_RETRYABLE",
  "HTTP_500_GATEWAY_FAULT",
  "TIMEOUT_HANG_ABOVE_STEP_TTL",
  "SOCKET_RESET_MID_STREAM",
  "MALFORMED_OR_UNMAPPED_200_BODY",
  "RATE_LIMIT_HTTP_429",
  "AMOUNT_ROUNDING_MISMATCH",
  "CONFLICTING_WEBHOOK_VS_INQUIRY",
];

export const RailChaosCard = dc(
  (props: { descriptor: Descriptor; scenario: Scenario; onChanged?: (scenario: Scenario) => void }, expose, ctx) => {
    const draft = ref<Scenario>(JSON.parse(JSON.stringify(props.scenario)));
    const saving = ref(false);
    const saved = ref("");

    const sync = () => {
      draft.value = JSON.parse(JSON.stringify(props.scenario));
    };
    sync();

    const save = async () => {
      saving.value = true;
      try {
        const result = await api<{ scenario: Scenario }>(
          `/portal-api/scenarios/${encodeURIComponent(props.descriptor.railCode)}`,
          {
            method: "PUT",
            body: {
              enabled: draft.value.enabled,
              overallFailureChancePercent: draft.value.overallFailureChancePercent,
              latencyMs: draft.value.latencyMs,
              phaseBreakdown: draft.value.phaseBreakdown,
              failureModeWeights: draft.value.failureModeWeights,
              webhookBehavior: draft.value.webhookBehavior,
            },
          },
        );
        draft.value = result.scenario;
        saved.value = "saved";
        props.onChanged?.(result.scenario);
      } finally {
        saving.value = false;
        setTimeout(() => { saved.value = ""; }, 1500);
      }
    };

    const preset = async (name: string) => {
      const result = await api<{ scenario: Scenario }>(
        `/portal-api/scenarios/preset/${encodeURIComponent(props.descriptor.railCode)}/${name}`,
        { method: "POST", body: {} },
      );
      draft.value = result.scenario;
      props.onChanged?.(result.scenario);
    };

    expose({ sync });

    return () => (
      <VCard color="surface" class="pa-1">
        <VCardText>
          <div class="d-flex align-center mb-2">
            <strong>{props.descriptor.name}</strong>
            <VChip size="x-small" class="ml-2" variant="tonal">{props.descriptor.railCode}</VChip>
            <div style={{ flex: 1 }} />
            <VChip size="x-small" color={draft.value.enabled ? "success" : "error"} variant="tonal">
              {draft.value.enabled ? "enabled" : "outage 503"}
            </VChip>
          </div>
          <div class="text-caption text-medium-emphasis mb-2">{props.descriptor.collectionModes.join(" · ")}</div>

          <div class="d-flex justify-space-between">
            <span>Failure chance</span><strong>{draft.value.overallFailureChancePercent}%</strong>
          </div>
          <VSlider
            modelValue={draft.value.overallFailureChancePercent}
            onUpdate:modelValue={(value: number) => { draft.value.overallFailureChancePercent = value; }}
            min={0} max={100} step={1} hideDetails
          />

          <div class="d-flex ga-2 mb-2">
            <VTextField
              label="Latency min ms" type="number" density="compact" hideDetails
              modelValue={draft.value.latencyMs.min}
              onUpdate:modelValue={(value: string) => { draft.value.latencyMs.min = Number(value); }}
            />
            <VTextField
              label="Latency max ms" type="number" density="compact" hideDetails
              modelValue={draft.value.latencyMs.max}
              onUpdate:modelValue={(value: string) => { draft.value.latencyMs.max = Number(value); }}
            />
          </div>

          <VSelect
            label="Primary failure mode"
            density="compact"
            hideDetails
            items={FAILURE_MODES}
            modelValue={Object.entries(draft.value.failureModeWeights).sort((a, b) => b[1] - a[1])[0]?.[0]}
            onUpdate:modelValue={(value: string) => {
              draft.value.failureModeWeights = Object.fromEntries(
                FAILURE_MODES.map((mode) => [mode, mode === value ? 100 : 0]),
              );
            }}
          />

          <div class="d-flex ga-2 my-2">
            <VSwitch
              label="Duplicates" density="compact" hideDetails
              modelValue={draft.value.webhookBehavior.duplicateCount > 1}
              onUpdate:modelValue={(value: boolean | null) => { draft.value.webhookBehavior.duplicateCount = value === true ? 3 : 1; }}
            />
            <VSwitch
              label="Out of order" density="compact" hideDetails
              modelValue={draft.value.webhookBehavior.outOfOrderPendingAfterPaid}
              onUpdate:modelValue={(value: boolean | null) => { draft.value.webhookBehavior.outOfOrderPendingAfterPaid = value === true; }}
            />
          </div>

          <div class="d-flex justify-space-between">
            <span>Corrupt signature</span><strong>{draft.value.webhookBehavior.corruptSignatureChancePercent}%</strong>
          </div>
          <VSlider
            modelValue={draft.value.webhookBehavior.corruptSignatureChancePercent}
            onUpdate:modelValue={(value: number) => { draft.value.webhookBehavior.corruptSignatureChancePercent = value; }}
            min={0} max={100} step={5} hideDetails
          />

          <VDivider class="my-3" />
          <div class="d-flex ga-1 flex-wrap">
            <VBtn size="small" variant="tonal" onClick={() => preset("healthy")}>Healthy</VBtn>
            <VBtn size="small" variant="tonal" onClick={() => preset("flaky")}>25% flaky</VBtn>
            <VBtn size="small" variant="tonal" onClick={() => preset("timeout_on_confirm")}>Timeout confirm</VBtn>
            <VBtn size="small" variant="tonal" color="error" onClick={() => preset("outage")}>Outage</VBtn>
            <VBtn size="small" loading={saving.value} onClick={save}>Save</VBtn>
            {saved.value ? <VChip size="small" color="success" variant="tonal">{saved.value}</VChip> : null}
          </div>
        </VCardText>
      </VCard>
    );
  },
  { props: ["descriptor", "scenario", "onChanged"] },
);

export default RailChaosCard;
