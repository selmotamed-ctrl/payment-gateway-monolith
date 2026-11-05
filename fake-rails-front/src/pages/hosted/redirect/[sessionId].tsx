import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { VAlert, VDivider } from "vuetify/components";
import HostedLayout from "@/layouts/hosted";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { api, HOSTED_ACTION_HEADER } from "@/utils/api";
import { isSafeRedirectUrl } from "@/utils/security";

interface HostedSession {
  action_token?: string;
  transaction: {
    id: string;
    rail_code: string;
    gateway_code: string;
    our_reference: string;
    provider_reference: string;
    normalized_amount_lyd: string;
    currency: string;
    status: string;
    return_url: string | null;
    cancel_url: string | null;
  };
  rail: { name: string; collectionModes: string[] } | null;
}

const HostedRedirectPage = dc(() => {
  const route = useRoute();
  const session = ref<HostedSession | null>(null);
  const error = ref("");
  const busy = ref(false);

  const load = async () => {
    try {
      session.value = await api<HostedSession>(`/portal-api/hosted/session/${encodeURIComponent(String(route.params.sessionId))}`);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "Session not found";
    }
  };

  const act = async (action: string) => {
    busy.value = true;
    try {
      const result = await api<{ redirect_url: string }>(
        `/portal-api/hosted/session/${encodeURIComponent(String(route.params.sessionId))}/action`,
        {
          method: "POST",
          body: { action },
          headers: session.value?.action_token ? { [HOSTED_ACTION_HEADER]: session.value.action_token } : {},
        },
      );
      if (result.redirect_url && isSafeRedirectUrl(result.redirect_url)) {
        window.location.assign(result.redirect_url);
      } else if (result.redirect_url) {
        error.value = "Refusing to follow an unsafe redirect URL";
      } else {
        await load();
      }
    } finally {
      busy.value = false;
    }
  };

  onMounted(load);

  return () => (
    <HostedLayout title={session.value?.rail?.name ?? "Secure checkout"}>
      {error.value ? <VAlert type="error" variant="tonal">{error.value}</VAlert> : null}
      {session.value ? (
        <div>
          <div class="d-flex justify-space-between align-center mb-1">
            <span>Merchant reference</span>
            <MonoRef value={session.value.transaction.our_reference} />
          </div>
          <div class="d-flex justify-space-between mb-1">
            <span>Amount</span>
            <strong class="pg-money pg-tabular">{session.value.transaction.normalized_amount_lyd} {session.value.transaction.currency}</strong>
          </div>
          <div class="d-flex justify-space-between align-center mb-3">
            <span>Status</span>
            <StatusBadge status={session.value.transaction.status} />
          </div>
          <VDivider class="mb-3" />
          <div class="text-caption text-medium-emphasis mb-2">
            Tester controls (this page emulates the upstream gateway checkout)
          </div>
          <div class="d-flex justify-end">
            <TableRowActions
              primaryAction={{
                label: "Approve & redirect",
                icon: "mdi-check",
                loading: busy.value,
                onClick: () => act("APPROVE"),
              }}
              items={[
                { key: "tampered", label: "Approve with tampered return URL", icon: "mdi-link-variant", disabled: busy.value, onClick: () => act("APPROVE_TAMPERED") },
                { key: "drop", label: "Browser return only — drop webhook", icon: "mdi-web-off", disabled: busy.value, onClick: () => act("DROP_WEBHOOK") },
                { key: "abandon", label: "Close tab / abandon — webhook in 30s", icon: "mdi-timer-sand", disabled: busy.value, onClick: () => act("ABANDON") },
                { key: "decline", label: "Decline (insufficient funds)", icon: "mdi-credit-card-off-outline", danger: true, disabled: busy.value, dividerBefore: true, onClick: () => act("DECLINE") },
                { key: "cancel", label: "Customer cancel", icon: "mdi-close", disabled: busy.value, onClick: () => act("CANCEL") },
              ]}
            />
          </div>
        </div>
      ) : null}
    </HostedLayout>
  );
});

export default HostedRedirectPage;
