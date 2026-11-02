import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { VBtn, VSelect, VTextField } from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import WireInspectorDrawer from "@/components/WireInspectorDrawer";
import WebhookComposerModal from "@/components/WebhookComposerModal";
import { DataTable } from "@/components/Table/DataTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { SectionFields } from "@/components/SectionFields";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
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

  const openWebhook = (id: string) => {
    selected.value = id;
    webhookOpen.value = true;
  };

  onMounted(load);

  const headers: TableHeader<TransactionRow>[] = [
    {
      key: "rail_code",
      label: "Rail",
      Value: ({ row }) => <StatusBadge status={row.rail_code} label={row.rail_code} toneOverride="neutral" showDot={false} />,
    },
    {
      key: "our_reference",
      label: "Our reference",
      Value: ({ row }) => <MonoRef value={row.our_reference} />,
    },
    {
      key: "provider_reference",
      label: "Provider",
      Value: ({ row }) => <MonoRef value={row.provider_reference} />,
    },
    {
      key: "normalized_amount_lyd",
      label: "Amount",
      Value: ({ row }) => <span class="pg-money pg-tabular">{row.normalized_amount_lyd}</span>,
    },
    {
      key: "collection_mode",
      label: "Mode",
    },
    {
      key: "status",
      label: "Status",
      Value: ({ row }) => <StatusBadge status={row.status} />,
    },
    {
      key: "created_at",
      label: "Created",
      Value: ({ row }) => <span class="pg-mono">{new Date(row.created_at).toLocaleString()}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      Value: ({ row }) => (
        <TableRowActions
          primaryAction={{
            label: "Inspect",
            icon: "mdi-eye-outline",
            onClick: () => inspect(row.id),
          }}
          items={[
            {
              key: "webhook",
              label: "Compose webhook",
              icon: "mdi-webhook",
              onClick: () => openWebhook(row.id),
            },
          ]}
        />
      ),
    },
  ];

  return () => (
    <PortalLayout>
      <SectionFields
        title="Filter transactions"
        subtitle={`${total.value} matching records`}
        v-slots={{
          footer: () => <VBtn size="small" onClick={load}>Search</VBtn>,
        }}
      >
        <div class="pg-field-wrapper">
          <label>Reference</label>
          <VTextField
            density="compact"
            variant="outlined"
            hideDetails
            clearable
            placeholder="Search by reference"
            modelValue={reference.value}
            onUpdate:modelValue={(value: string) => { reference.value = value; }}
          />
        </div>
        <div class="pg-field-wrapper">
          <label>Status</label>
          <VSelect
            density="compact"
            variant="outlined"
            hideDetails
            clearable
            placeholder="Any status"
            items={["INITIATED", "AWAITING_ACTION", "PAID", "FAILED", "CANCELLED", "REFUNDED", "UNKNOWN_SIMULATED"]}
            modelValue={status.value}
            onUpdate:modelValue={(value: string) => { status.value = value; }}
          />
        </div>
      </SectionFields>

      <DataTable
        data={rows.value}
        headers={headers}
        title="Transactions"
        numberOfItemsPerPage={20}
      />

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
