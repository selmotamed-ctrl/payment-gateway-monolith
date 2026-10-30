import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import {
  VBtn, VCard, VCardText, VCardTitle, VChip, VRow, VCol, VAlert, VDivider,
} from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import LiveTransactionFeed from "@/components/LiveTransactionFeed";
import { api } from "@/utils/api";

interface PendingAction {
  id: string;
  rail_code: string;
  gateway_code: string;
  our_reference: string;
  provider_reference: string;
  expected_otp: string | null;
  normalized_amount_lyd: string;
  collection_mode: string;
  created_at: string;
}

interface Summary {
  totals: Array<{ status: string; count: number; amount: number }>;
  rails: Array<{ rail_code: string; count: number }>;
  pendingActions: PendingAction[];
}

const DashboardPage = dc(() => {
  const summary = ref<Summary | null>(null);
  const error = ref("");

  const load = async () => {
    try {
      summary.value = await api<Summary>("/portal-api/transactions/summary");
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "Failed to load";
    }
  };

  const act = async (id: string, action: string) => {
    await api(`/portal-api/transactions/${encodeURIComponent(id)}/action`, { method: "POST", body: { action } });
    await load();
  };

  onMounted(load);

  const totalFor = (statuses: string[]): number =>
    (summary.value?.totals ?? [])
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + Number(row.count), 0);

  return () => (
    <PortalLayout>
      {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
      <VRow>
        <VCol cols={12} md={3}>
          <VCard color="surface"><VCardText>
            <div class="text-caption text-medium-emphasis">Total transactions</div>
            <div class="text-h4 font-weight-bold">{(summary.value?.totals ?? []).reduce((sum, row) => sum + Number(row.count), 0)}</div>
          </VCardText></VCard>
        </VCol>
        <VCol cols={12} md={3}>
          <VCard color="surface"><VCardText>
            <div class="text-caption text-medium-emphasis">Paid</div>
            <div class="text-h4 font-weight-bold text-success">{totalFor(["PAID", "SUCCEEDED"])}</div>
          </VCardText></VCard>
        </VCol>
        <VCol cols={12} md={3}>
          <VCard color="surface"><VCardText>
            <div class="text-caption text-medium-emphasis">Awaiting customer</div>
            <div class="text-h4 font-weight-bold text-warning">{totalFor(["AWAITING_ACTION", "INITIATED"])}</div>
          </VCardText></VCard>
        </VCol>
        <VCol cols={12} md={3}>
          <VCard color="surface"><VCardText>
            <div class="text-caption text-medium-emphasis">Failed</div>
            <div class="text-h4 font-weight-bold text-error">{totalFor(["FAILED", "CANCELLED"])}</div>
          </VCardText></VCard>
        </VCol>
      </VRow>

      <VRow class="mt-2">
        <VCol cols={12} lg={7}>
          <LiveTransactionFeed max={60} />
        </VCol>
        <VCol cols={12} lg={5}>
          <VCard color="surface">
            <VCardTitle class="d-flex align-center">
              Pending customer actions
              <VChip size="small" class="ml-3" variant="tonal">{summary.value?.pendingActions.length ?? 0}</VChip>
            </VCardTitle>
            <VCardText style={{ maxHeight: "520px", overflowY: "auto" }}>
              {(summary.value?.pendingActions ?? []).length === 0
                ? <div class="text-medium-emphasis">No pending OTP, QR or push requests.</div>
                : null}
              {(summary.value?.pendingActions ?? []).map((action) => (
                <div key={action.id} class="mb-4">
                  <div class="d-flex align-center">
                    <VChip size="small" color="warning" variant="tonal">{action.rail_code}</VChip>
                    <span class="ml-2 pg-mono">{action.our_reference}</span>
                    <div style={{ flex: 1 }} />
                    <strong>{action.normalized_amount_lyd} LYD</strong>
                  </div>
                  {action.expected_otp ? (
                    <VAlert type="info" variant="tonal" density="compact" class="my-2">
                      OTP: <strong class="pg-mono">{action.expected_otp}</strong>
                      <VBtn size="x-small" variant="text" onClick={() => navigator.clipboard?.writeText(action.expected_otp ?? "")}>Copy</VBtn>
                    </VAlert>
                  ) : null}
                  <div class="d-flex ga-1 mt-2">
                    <VBtn size="small" color="success" onClick={() => act(action.id, "APPROVE")}>Approve</VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => act(action.id, "APPROVE_MISMATCH")}>Amount mismatch</VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => act(action.id, "APPROVE_LATE")}>Approve late</VBtn>
                    <VBtn size="small" color="error" variant="tonal" onClick={() => act(action.id, "REJECT")}>Reject</VBtn>
                  </div>
                  <VDivider class="mt-3" />
                </div>
              ))}
            </VCardText>
          </VCard>
        </VCol>
      </VRow>
    </PortalLayout>
  );
});

export default DashboardPage;
