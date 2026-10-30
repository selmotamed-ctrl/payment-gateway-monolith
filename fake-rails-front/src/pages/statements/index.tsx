import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import {
  VBtn, VCard, VCardText, VCardTitle, VRow, VCol, VTextField, VSelect, VSwitch, VAlert,
} from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import { api, download } from "@/utils/api";

const StatementsPage = dc(() => {
  const gatewayCode = ref("moamalat");
  const format = ref("csv");
  const from = ref(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const to = ref(new Date().toISOString().slice(0, 10));
  const feeVariancePercent = ref(0);
  const omitOne = ref(false);
  const addUnrecorded = ref(false);
  const message = ref("");
  const statements = ref<Array<Record<string, any>>>([]);

  const load = async () => {
    const result = await api<{ statements: Array<Record<string, any>> }>("/portal-api/statements");
    statements.value = result.statements;
  };

  const generate = async () => {
    await download(
      "/portal-api/statements/generate",
      {
        gatewayCode: gatewayCode.value,
        from: `${from.value}T00:00:00.000Z`,
        to: `${to.value}T23:59:59.999Z`,
        format: format.value,
        anomalies: {
          feeVariancePercent: feeVariancePercent.value,
          feeVarianceAmount: 0.15,
          omitOne: omitOne.value,
          addUnrecorded: addUnrecorded.value,
        },
      },
      `${gatewayCode.value}-statement.${format.value}`,
    );
    message.value = "Statement generated";
    await load();
    setTimeout(() => { message.value = ""; }, 2000);
  };

  onMounted(load);

  return () => (
    <PortalLayout>
      <VRow>
        <VCol cols={12} lg={6}>
          <VCard color="surface">
            <VCardTitle>Settlement statement generator</VCardTitle>
            <VCardText>
              {message.value ? <VAlert type="success" variant="tonal" class="mb-3">{message.value}</VAlert> : null}
              <VSelect
                label="Gateway" items={["edfali", "sadad", "mobicash", "moamalat", "ly_pay", "onepay", "tlync", "mypay", "dpay", "plutu", "yussor", "sahara", "masrefy", "hawelli", "gpay_libya", "numo_pay", "libyana", "mpgs", "evopay", "neompay"]}
                modelValue={gatewayCode.value} onUpdate:modelValue={(value: string) => { gatewayCode.value = value; }}
              />
              <div class="d-flex ga-3">
                <VTextField label="From" type="date" modelValue={from.value} onUpdate:modelValue={(value: string) => { from.value = value; }} />
                <VTextField label="To" type="date" modelValue={to.value} onUpdate:modelValue={(value: string) => { to.value = value; }} />
                <VSelect label="Format" items={["csv", "xlsx", "json"]} modelValue={format.value} onUpdate:modelValue={(value: string) => { format.value = value; }} />
              </div>
              <div class="d-flex justify-space-between mt-3">
                <span>Inject fee variance (+0.150 LYD)</span><strong>{feeVariancePercent.value}%</strong>
              </div>
              <input
                type="range" min="0" max="100" step="5" value={feeVariancePercent.value}
                style={{ width: "100%" }}
                onInput={(event: Event) => { feeVariancePercent.value = Number((event.target as HTMLInputElement).value); }}
              />
              <VSwitch label="Omit one transaction (MISSING_AT_GATEWAY)" modelValue={omitOne.value} onUpdate:modelValue={(value: boolean | null) => { omitOne.value = value === true; }} />
              <VSwitch label="Add one unrecorded transaction (MISSING_LOCALLY)" modelValue={addUnrecorded.value} onUpdate:modelValue={(value: boolean | null) => { addUnrecorded.value = value === true; }} />
              <VBtn class="mt-3" onClick={generate}>Generate & download</VBtn>
            </VCardText>
          </VCard>
        </VCol>
        <VCol cols={12} lg={6}>
          <VCard color="surface">
            <VCardTitle>Recent statements</VCardTitle>
            <VCardText>
              {statements.value.length === 0 ? <div class="text-medium-emphasis">No statements generated yet.</div> : null}
              {statements.value.map((statement) => (
                <div key={statement.id} class="d-flex justify-space-between py-2">
                  <span class="pg-mono">{statement.gateway_code} · {statement.format}</span>
                  <span class="pg-mono">{statement.row_count} rows</span>
                </div>
              ))}
            </VCardText>
          </VCard>
        </VCol>
      </VRow>
    </PortalLayout>
  );
});

export default StatementsPage;
