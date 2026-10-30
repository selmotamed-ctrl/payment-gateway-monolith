import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import {
  VBtn, VCard, VCardText, VChip, VRow, VCol, VTextField, VSelect,
} from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import WireInspectorDrawer from "@/components/WireInspectorDrawer";
import WebhookComposerModal from "@/components/WebhookComposerModal";
import { api } from "@/utils/api";

interface TransactionRow {
  id: string;
  rail_code: string;
  gateway_code: string;
  our_reference: string;
  provider_reference: string;
  normalized_amount_lyd: string;
  status: string;
  collection_mode: string;
  expected_otp: string | null;
  created_at: string;
}

const TransactionsPage = dc(() => {
  const rows = ref<TransactionRow[]>([]);
  const total = ref(0);
  const reference = ref("");
  const status = ref("");
  const selected = ref<string | null>(null);
  const drawer = ref(false);
  const webhookOpen = ref(false);

  const load = async () => {
    const params = new URLSearchParams();
    if (reference.value) params.set("reference", reference.value);
    if (status.value) params.set("status", status.value);
    const result = await api<{ total: number; rows: TransactionRow[] }>(
      `/portal-api/transactions?${params.toString()}`,
    );
    rows.value = result.rows;
    total.value = result.total;
  };

  const inspect = (id: string) => {
    selected.value = id;
    drawer.value = true;
  };

  onMounted(load);

  return () => (
    <PortalLayout>
      <VCard color="surface" class="mb-4">
        <VCardText class="d-flex ga-3 align-center flex-wrap">
          <VTextField
            label="Reference" density="compact" hideDetails style={{ maxWidth: "280px" }}
            modelValue={reference.value} onUpdate:modelValue={(value: string) => { reference.value = value; }}
          />
          <VSelect
            label="Status" density="compact" hideDetails clearable style={{ maxWidth: "220px" }}
            items={["INITIATED", "AWAITING_ACTION", "PAID", "FAILED", "CANCELLED", "REFUNDED", "UNKNOWN_SIMULATED"]}
            modelValue={status.value} onUpdate:modelValue={(value: string) => { status.value = value; }}
          />
          <VBtn onClick={load}>Search</VBtn>
          <VChip variant="tonal">{total.value} rows</VChip>
        </VCardText>
      </VCard>

      <VCard color="surface">
        <table class="w-100">
          <thead>
            <tr>
              <th>Rail</th><th>Our reference</th><th>Provider</th>
              <th>Amount</th><th>Mode</th><th>Status</th><th>Created</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.value.map((row) => (
              <tr key={row.id}>
                <td><VChip size="x-small" variant="tonal">{row.rail_code}</VChip></td>
                <td class="pg-mono">{row.our_reference}</td>
                <td class="pg-mono">{row.provider_reference}</td>
                <td>{row.normalized_amount_lyd}</td>
                <td>{row.collection_mode}</td>
                <td>
                  <VChip size="x-small" color={row.status === "PAID" ? "success" : row.status === "FAILED" ? "error" : "warning"} variant="tonal">
                    {row.status}
                  </VChip>
                </td>
                <td class="pg-mono">{new Date(row.created_at).toLocaleString()}</td>
                <td>
                  <VBtn size="x-small" variant="text" onClick={() => inspect(row.id)}>Inspect</VBtn>
                  <VBtn size="x-small" variant="text" onClick={() => { selected.value = row.id; webhookOpen.value = true; }}>Webhook</VBtn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </VCard>

      <WireInspectorDrawer
        transactionId={selected.value}
        modelValue={drawer.value}
        onClose={() => { drawer.value = false; }}
      />
      <WebhookComposerModal
        transactionId={selected.value}
        modelValue={webhookOpen.value}
        onClose={() => { webhookOpen.value = false; }}
      />
    </PortalLayout>
  );
});

export default TransactionsPage;
