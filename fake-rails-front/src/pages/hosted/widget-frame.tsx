import { dc } from "kt-dc";
import { computed } from "vue";
import { VBtn, VChip, VAlert } from "vuetify/components";
import { api } from "@/utils/api";

const WidgetFramePage = dc(() => {
  const params = new URLSearchParams(window.location.search);
  const reference =
    params.get("MerchantReference")
    ?? params.get("merchant_reference")
    ?? params.get("reference")
    ?? params.get("our_reference")
    ?? params.get("merchantTransInfo")
    ?? "";
  const amount = params.get("AmountTrxn") ?? params.get("amount") ?? "0.00";
  const rail = params.get("rail") ?? "moamalat";

  const post = (type: string, payload: Record<string, unknown>) => {
    window.parent?.postMessage({ type, payload }, "*");
  };

  const complete = async (serverPayment: boolean) => {
    if (serverPayment && reference) {
      try {
        await api(`/portal-api/hosted/session/${encodeURIComponent(reference)}/action`, {
          method: "POST",
          body: { action: "APPROVE" },
        });
      } catch {
        // The widget still reports completion so the T-06 spoof test is possible.
      }
    }
    post("fake-rails:complete", { reference, amount, status: "PAID" });
  };

  const decline = async () => {
    if (reference) {
      try {
        await api(`/portal-api/hosted/session/${encodeURIComponent(reference)}/action`, {
          method: "POST",
          body: { action: "DECLINE" },
        });
      } catch {
        // ignore
      }
    }
    post("fake-rails:error", { reference, status: "FAILED", error: "INSUFFICIENT_FUNDS" });
  };

  const cancel = () => post("fake-rails:cancel", { reference, status: "CANCELLED" });

  const badge = computed(() => (rail === "mpgs" ? "MPGS 3-D Secure" : "Moamalat Lightbox"));

  return () => (
    <div style={{ padding: "18px", fontFamily: "system-ui, sans-serif", color: "#111827" }}>
      <div class="d-flex align-center mb-3">
        <strong>{badge.value}</strong>
        <VChip size="small" class="ml-2" variant="tonal">{rail}</VChip>
      </div>
      <div class="d-flex justify-space-between mb-1">
        <span>Reference</span><span class="pg-mono">{reference || "-"}</span>
      </div>
      <div class="d-flex justify-space-between mb-4">
        <span>Amount</span><strong>{amount}</strong>
      </div>
      <VAlert type="info" variant="tonal" density="compact" class="mb-3">
        Sandbox card: 4111 1111 1111 1111 · any future expiry · CVV 123
      </VAlert>
      <div class="d-flex flex-column ga-2">
        <VBtn color="success" onClick={() => complete(true)}>Complete card payment</VBtn>
        <VBtn variant="tonal" onClick={() => complete(false)}>Spoof browser callback without server payment</VBtn>
        <VBtn color="error" variant="tonal" onClick={decline}>Trigger card decline</VBtn>
        <VBtn variant="text" onClick={cancel}>Cancel</VBtn>
      </div>
    </div>
  );
});

export default WidgetFramePage;
