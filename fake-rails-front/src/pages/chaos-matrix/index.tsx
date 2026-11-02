import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { VAlert, VCol, VRow } from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import RailChaosCard from "@/components/RailChaosCard";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { api } from "@/utils/api";

interface Descriptor {
  railCode: string;
  gatewayCode: string;
  name: string;
  collectionModes: string[];
}

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

const ChaosMatrixPage = dc(() => {
  const rails = ref<Descriptor[]>([]);
  const scenarios = ref<Record<string, Scenario>>({});
  const message = ref("");

  const load = async () => {
    const result = await api<{ rails: Descriptor[]; scenarios: Scenario[] }>("/portal-api/scenarios");
    rails.value = result.rails;
    scenarios.value = Object.fromEntries(result.scenarios.map((scenario) => [scenario.railCode, scenario]));
  };

  const globalPreset = async (preset: string) => {
    const result = await api<{ scenarios: Scenario[] }>(`/portal-api/scenarios/global/${preset}`, { method: "POST", body: {} });
    scenarios.value = Object.fromEntries(result.scenarios.map((scenario) => [scenario.railCode, scenario]));
    message.value = `Applied global preset: ${preset}`;
    setTimeout(() => { message.value = ""; }, 2000);
  };

  onMounted(load);

  return () => (
    <PortalLayout>
      <div class="d-flex ga-2 mb-4 flex-wrap align-center justify-space-between">
        <TableRowActions
          primaryAction={{
            label: "Reset all rails",
            icon: "mdi-restore",
            onClick: () => globalPreset("healthy"),
          }}
          items={[
            { key: "flaky", label: "National switch instability (25%)", icon: "mdi-pulse", onClick: () => globalPreset("flaky") },
            { key: "timeout", label: "Timeout on confirm", icon: "mdi-timer-sand", onClick: () => globalPreset("timeout_on_confirm") },
            { key: "outage", label: "Full outage", icon: "mdi-power-plug-off", danger: true, dividerBefore: true, onClick: () => globalPreset("outage") },
          ]}
        />
        {message.value ? <VAlert type="success" variant="tonal" density="compact">{message.value}</VAlert> : null}
      </div>
      <VRow>
        {rails.value.map((rail) => (
          <VCol key={rail.railCode} cols={12} md={6} lg={4}>
            {scenarios.value[rail.railCode]
              ? (
                <RailChaosCard
                  descriptor={rail}
                  scenario={scenarios.value[rail.railCode]!}
                  onChanged={(scenario: Scenario) => {
                    scenarios.value = { ...scenarios.value, [rail.railCode]: scenario };
                  }}
                />
              )
              : null}
          </VCol>
        ))}
      </VRow>
    </PortalLayout>
  );
});

export default ChaosMatrixPage;
