import { dc } from "kt-dc";
import { ref } from "vue";
import { VSelect, VSlider, VSwitch, VTextField } from "vuetify/components";
import { SectionFields } from "@/components/SectionFields";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TableRowActions } from "@/components/Table/TableRowActions";
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
  (props: { descriptor: Descriptor; scenario: Scenario; onChanged?: (scenario: Scenario) => void }, expose, _ctx) => {
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
      <SectionFields
        title={props.descriptor.name}
        subtitle={`${props.descriptor.railCode} · ${props.descriptor.collectionModes.join(" · ")}`}
        columns={1}
        v-slots={{
          headerActions: () => (
            <div class="d-flex align-center ga-2">
              {saved.value ? <StatusBadge status="SAVED" label="Saved" toneOverride="success" showDot={false} /> : null}
              <StatusBadge
                status={draft.value.enabled ? "ENABLED" : "OUTAGE"}
                label={draft.value.enabled ? "enabled" : "outage 503"}
                toneOverride={draft.value.enabled ? "success" : "danger"}
                showDot={false}
              />
            </div>
          ),
          footer: () => (
            <TableRowActions
              primaryAction={{
                label: "Save",
                icon: "mdi-content-save-outline",
                loading: saving.value,
                onClick: save,
              }}
              items={[
                { key: "healthy", label: "Healthy preset", icon: "mdi-heart-pulse", onClick: () => preset("healthy") },
                { key: "flaky", label: "25% flaky", icon: "mdi-pulse", onClick: () => preset("flaky") },
                { key: "timeout", label: "Timeout confirm", icon: "mdi-timer-sand", onClick: () => preset("timeout_on_confirm") },
                { key: "outage", label: "Outage", icon: "mdi-power-plug-off", danger: true, dividerBefore: true, onClick: () => preset("outage") },
              ]}
            />
          ),
        }}
      >
        <div class="pg-field-wrapper">
          <label>Failure chance</label>
          <div class="d-flex align-center ga-3">
            <VSlider
              class="flex-grow-1"
              modelValue={draft.value.overallFailureChancePercent}
              onUpdate:modelValue={(value: number) => { draft.value.overallFailureChancePercent = value; }}
              min={0}
              max={100}
              step={1}
              hideDetails
            />
            <strong class="pg-tabular">{draft.value.overallFailureChancePercent}%</strong>
          </div>
        </div>

        <div class="pg-field-wrapper">
          <label>Latency range (ms)</label>
          <div class="d-flex ga-2">
            <VTextField
              density="compact"
              variant="outlined"
              hideDetails
              type="number"
              placeholder="Min"
              modelValue={draft.value.latencyMs.min}
              onUpdate:modelValue={(value: string) => { draft.value.latencyMs.min = Number(value); }}
            />
            <VTextField
              density="compact"
              variant="outlined"
              hideDetails
              type="number"
              placeholder="Max"
              modelValue={draft.value.latencyMs.max}
              onUpdate:modelValue={(value: string) => { draft.value.latencyMs.max = Number(value); }}
            />
          </div>
        </div>

        <div class="pg-field-wrapper">
          <label>Primary failure mode</label>
          <VSelect
            density="compact"
            variant="outlined"
            hideDetails
            items={FAILURE_MODES}
            modelValue={Object.entries(draft.value.failureModeWeights).sort((a, b) => b[1] - a[1])[0]?.[0]}
            onUpdate:modelValue={(value: string) => {
              draft.value.failureModeWeights = Object.fromEntries(
                FAILURE_MODES.map((mode) => [mode, mode === value ? 100 : 0]),
              );
            }}
          />
        </div>

        <div class="pg-field-wrapper">
          <label>Webhook behavior</label>
          <VSwitch
            label="Duplicates"
            density="compact"
            hideDetails
            modelValue={draft.value.webhookBehavior.duplicateCount > 1}
            onUpdate:modelValue={(value: boolean | null) => { draft.value.webhookBehavior.duplicateCount = value === true ? 3 : 1; }}
          />
          <VSwitch
            label="Out of order"
            density="compact"
            hideDetails
            modelValue={draft.value.webhookBehavior.outOfOrderPendingAfterPaid}
            onUpdate:modelValue={(value: boolean | null) => { draft.value.webhookBehavior.outOfOrderPendingAfterPaid = value === true; }}
          />
        </div>

        <div class="pg-field-wrapper">
          <label>Corrupt signature</label>
          <div class="d-flex align-center ga-3">
            <VSlider
              class="flex-grow-1"
              modelValue={draft.value.webhookBehavior.corruptSignatureChancePercent}
              onUpdate:modelValue={(value: number) => { draft.value.webhookBehavior.corruptSignatureChancePercent = value; }}
              min={0}
              max={100}
              step={5}
              hideDetails
            />
            <strong class="pg-tabular">{draft.value.webhookBehavior.corruptSignatureChancePercent}%</strong>
          </div>
        </div>
      </SectionFields>
    );
  },
  { props: ["descriptor", "scenario", "onChanged"] },
);

export default RailChaosCard;
