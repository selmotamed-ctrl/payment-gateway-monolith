import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { VAlert, VBtn, VCol, VRow, VSelect, VSlider, VSwitch, VTextField } from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import { SectionFields } from "@/components/SectionFields";
import { DataTable } from "@/components/Table/DataTable";
import { MonoRef } from "@/components/ui/MonoRef";
import type { TableHeader } from "@/components/Table/types";
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

  const headers: TableHeader<Record<string, any>>[] = [
    {
      key: "gateway_code",
      label: "Gateway",
      Value: ({ row }) => <MonoRef value={String(row.gateway_code ?? "")} />,
    },
    { key: "format", label: "Format" },
    { key: "row_count", label: "Rows" },
    { key: "created_at", label: "Created" },
  ];

  return () => (
    <PortalLayout>
      <VRow>
        <VCol cols={12} lg={6}>
          <SectionFields
            title="Settlement statement generator"
            subtitle="Produce a synthetic gateway statement with controlled anomalies."
            v-slots={{
              footer: () => <VBtn size="small" onClick={generate}>Generate &amp; download</VBtn>,
            }}
          >
            {message.value ? <VAlert type="success" variant="tonal" density="compact">{message.value}</VAlert> : null}
            <div class="pg-field-wrapper">
              <label>Gateway</label>
              <VSelect
                density="compact"
                variant="outlined"
                hideDetails
                items={["edfali", "sadad", "mobicash", "moamalat", "ly_pay", "onepay", "tlync", "mypay", "dpay", "plutu", "yussor", "sahara", "masrefy", "hawelli", "gpay_libya", "numo_pay", "libyana", "mpgs", "evopay", "neompay"]}
                modelValue={gatewayCode.value}
                onUpdate:modelValue={(value: string) => { gatewayCode.value = value; }}
              />
            </div>
            <div class="pg-field-wrapper">
              <label>From</label>
              <VTextField
                type="date"
                density="compact"
                variant="outlined"
                hideDetails
                modelValue={from.value}
                onUpdate:modelValue={(value: string) => { from.value = value; }}
              />
            </div>
            <div class="pg-field-wrapper">
              <label>To</label>
              <VTextField
                type="date"
                density="compact"
                variant="outlined"
                hideDetails
                modelValue={to.value}
                onUpdate:modelValue={(value: string) => { to.value = value; }}
              />
            </div>
            <div class="pg-field-wrapper">
              <label>Format</label>
              <VSelect
                density="compact"
                variant="outlined"
                hideDetails
                items={["csv", "xlsx", "json"]}
                modelValue={format.value}
                onUpdate:modelValue={(value: string) => { format.value = value; }}
              />
            </div>
            <div class="pg-field-wrapper">
              <label>Fee variance (+0.150 LYD)</label>
              <div class="d-flex align-center ga-3">
                <VSlider
                  class="flex-grow-1"
                  modelValue={feeVariancePercent.value}
                  onUpdate:modelValue={(value: number) => { feeVariancePercent.value = value; }}
                  min={0}
                  max={100}
                  step={5}
                  hideDetails
                />
                <strong class="pg-tabular">{feeVariancePercent.value}%</strong>
              </div>
            </div>
            <div class="pg-field-wrapper">
              <label>Anomalies</label>
              <VSwitch
                label="Omit one transaction (MISSING_AT_GATEWAY)"
                density="compact"
                hideDetails
                modelValue={omitOne.value}
                onUpdate:modelValue={(value: boolean | null) => { omitOne.value = value === true; }}
              />
              <VSwitch
                label="Add one unrecorded transaction (MISSING_LOCALLY)"
                density="compact"
                hideDetails
                modelValue={addUnrecorded.value}
                onUpdate:modelValue={(value: boolean | null) => { addUnrecorded.value = value === true; }}
              />
            </div>
          </SectionFields>
        </VCol>
        <VCol cols={12} lg={6}>
          <DataTable
            data={statements.value}
            headers={headers}
            title="Recent statements"
            numberOfItemsPerPage={10}
          />
        </VCol>
      </VRow>
    </PortalLayout>
  );
});

export default StatementsPage;
