import { dc } from "kt-dc";
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { VBtn, VChip, VAlert, VDivider } from "vuetify/components";
import HostedLayout from "@/layouts/hosted";
import { api } from "@/utils/api";

interface HostedSession {
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
        { method: "POST", body: { action } },
      );
      if (result.redirect_url) {
        window.location.assign(result.redirect_url);
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
          <div class="d-flex justify-space-between mb-1">
            <span>Merchant reference</span>
            <strong class="pg-mono">{session.value.transaction.our_reference}</strong>
          </div>
          <div class="d-flex justify-space-between mb-1">
            <span>Amount</span>
            <strong>{session.value.transaction.normalized_amount_lyd} {session.value.transaction.currency}</strong>
          </div>
          <div class="d-flex justify-space-between mb-3">
            <span>Status</span>
            <VChip size="small" variant="tonal">{session.value.transaction.status}</VChip>
          </div>
          <VDivider class="mb-3" />
          <div class="text-caption text-medium-emphasis mb-2">
            Tester controls (this page emulates the upstream gateway checkout)
          </div>
          <div class="d-flex flex-column ga-2">
            <VBtn color="success" disabled={busy.value} onClick={() => act("APPROVE")}>1. Approve &amp; redirect normally</VBtn>
            <VBtn color="warning" variant="tonal" disabled={busy.value} onClick={() => act("APPROVE_TAMPERED")}>2. Approve with tampered return URL</VBtn>
            <VBtn variant="tonal" disabled={busy.value} onClick={() => act("DROP_WEBHOOK")}>3. Send browser return only — drop webhook</VBtn>
            <VBtn variant="tonal" disabled={busy.value} onClick={() => act("ABANDON")}>4. Close tab / abandon — webhook in 30s</VBtn>
            <VBtn color="error" variant="tonal" disabled={busy.value} onClick={() => act("DECLINE")}>5. Decline (insufficient funds)</VBtn>
            <VBtn variant="text" disabled={busy.value} onClick={() => act("CANCEL")}>6. Customer cancel</VBtn>
          </div>
        </div>
      ) : null}
    </HostedLayout>
  );
});

export default HostedRedirectPage;
