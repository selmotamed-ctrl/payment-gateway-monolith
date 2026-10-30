import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { VBtn, VAlert, VRow, VCol } from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import RailChaosCard from "@/components/RailChaosCard";
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
      <div class="d-flex ga-2 mb-4 flex-wrap align-center">
        <VBtn variant="tonal" onClick={() => globalPreset("healthy")}>Reset all rails to 0%</VBtn>
        <VBtn variant="tonal" onClick={() => globalPreset("flaky")}>National switch instability (25%)</VBtn>
        <VBtn variant="tonal" color="error" onClick={() => globalPreset("outage")}>Full outage</VBtn>
        <VBtn variant="tonal" onClick={() => globalPreset("timeout_on_confirm")}>Timeout on confirm</VBtn>
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
                    scenarios.value = { ...scenarios.value, [scenario.railCode]: scenario };
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
