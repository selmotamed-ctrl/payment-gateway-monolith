import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { VAlert, VCol, VDivider, VRow } from "vuetify/components";
import PortalLayout from "@/layouts/portal";
import LiveTransactionFeed from "@/components/LiveTransactionFeed";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { TableRowActions } from "@/components/Table/TableRowActions";
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

  const metrics = () => [
    { label: "Total transactions", value: (summary.value?.totals ?? []).reduce((sum, row) => sum + Number(row.count), 0), tone: "neutral" as const },
    { label: "Paid", value: totalFor(["PAID", "SUCCEEDED"]), tone: "success" as const },
    { label: "Awaiting customer", value: totalFor(["AWAITING_ACTION", "INITIATED"]), tone: "warning" as const },
    { label: "Failed", value: totalFor(["FAILED", "CANCELLED"]), tone: "danger" as const },
  ];

  return () => (
    <PortalLayout>
      {error.value ? <VAlert type="error" variant="tonal" class="mb-4">{error.value}</VAlert> : null}
      <VRow>
        {metrics().map((metric) => (
          <VCol key={metric.label} cols={12} md={3}>
            <SurfaceCard>
              <div class="text-caption text-medium-emphasis">{metric.label}</div>
              <div class="d-flex align-center justify-space-between mt-2">
                <span class="text-h4 font-weight-bold pg-tabular">{metric.value}</span>
                <StatusBadge status={metric.tone.toUpperCase()} label={metric.tone} toneOverride={metric.tone} showDot={false} />
              </div>
            </SurfaceCard>
          </VCol>
        ))}
      </VRow>

      <VRow class="mt-2">
        <VCol cols={12} lg={7}>
          <LiveTransactionFeed max={60} />
        </VCol>
        <VCol cols={12} lg={5}>
          <SurfaceCard
            title="Pending customer actions"
            v-slots={{
              headerActions: () => (
                <StatusBadge
                  status="PENDING"
                  label={String(summary.value?.pendingActions.length ?? 0)}
                  toneOverride="warning"
                  showDot={false}
                />
              ),
            }}
          >
            <div style={{ maxHeight: "520px", overflowY: "auto" }}>
              {(summary.value?.pendingActions ?? []).length === 0 ? (
                <div class="text-medium-emphasis">No pending OTP, QR or push requests.</div>
              ) : null}
              {(summary.value?.pendingActions ?? []).map((action) => (
                <div key={action.id} class="mb-4">
                  <div class="d-flex align-center flex-wrap ga-2">
                    <StatusBadge status={action.rail_code} label={action.rail_code} toneOverride="neutral" showDot={false} />
                    <MonoRef value={action.our_reference} />
                    <div style={{ flex: 1 }} />
                    <strong class="pg-money pg-tabular">{action.normalized_amount_lyd} LYD</strong>
                  </div>
                  {action.expected_otp ? (
                    <VAlert type="info" variant="tonal" density="compact" class="my-2">
                      OTP: <MonoRef value={action.expected_otp} />
                    </VAlert>
                  ) : null}
                  <div class="d-flex justify-end mt-2">
                    <TableRowActions
                      primaryAction={{
                        label: "Approve",
                        icon: "mdi-check",
                        onClick: () => act(action.id, "APPROVE"),
                      }}
                      items={[
                        {
                          key: "mismatch",
                          label: "Approve amount mismatch",
                          icon: "mdi-scale-balance",
                          onClick: () => act(action.id, "APPROVE_MISMATCH"),
                        },
                        {
                          key: "late",
                          label: "Approve late",
                          icon: "mdi-clock-check-outline",
                          onClick: () => act(action.id, "APPROVE_LATE"),
                        },
                        {
                          key: "reject",
                          label: "Reject",
                          icon: "mdi-close-circle-outline",
                          danger: true,
                          dividerBefore: true,
                          onClick: () => act(action.id, "REJECT"),
                        },
                      ]}
                    />
                  </div>
                  <VDivider class="mt-3" />
                </div>
              ))}
            </div>
          </SurfaceCard>
        </VCol>
      </VRow>
    </PortalLayout>
  );
});

export default DashboardPage;
