import { dc } from "kt-dc";
import { computed } from "vue";
import { VAlert } from "vuetify/components";
import { TableRowActions } from "@/components/Table/TableRowActions";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { postHostedAction } from "@/utils/api";
import { resolveCheckoutOrigin } from "@/utils/security";

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
    // Never "*": post only to the known checkout origin (VITE_CHECKOUT_ORIGIN, else the embedding parent).
    const targetOrigin = resolveCheckoutOrigin(
      import.meta.env.VITE_CHECKOUT_ORIGIN,
      window.location.ancestorOrigins?.[0],
      document.referrer,
    );
    if (!targetOrigin) {
      return;
    }
    window.parent?.postMessage({ type, payload }, targetOrigin);
  };

  const complete = async (serverPayment: boolean) => {
    if (serverPayment && reference) {
      try {
        await postHostedAction(reference, "APPROVE");
      } catch {
        // The widget still reports completion so the T-06 spoof test is possible.
      }
    }
    post("fake-rails:complete", { reference, amount, status: "PAID" });
  };

  const decline = async () => {
    if (reference) {
      try {
        await postHostedAction(reference, "DECLINE");
      } catch {
        // ignore
      }
    }
    post("fake-rails:error", { reference, status: "FAILED", error: "INSUFFICIENT_FUNDS" });
  };

  const cancel = () => post("fake-rails:cancel", { reference, status: "CANCELLED" });

  const badge = computed(() => (rail === "mpgs" ? "MPGS 3-D Secure" : "Moamalat Lightbox"));

  return () => (
    <div style={{ padding: "18px", fontFamily: "system-ui, sans-serif", color: "var(--pg-ink-primary)" }}>
      <div class="d-flex align-center mb-3 ga-2">
        <strong>{badge.value}</strong>
        <StatusBadge status={rail} label={rail} toneOverride="neutral" showDot={false} />
      </div>
      <div class="d-flex justify-space-between mb-1">
        <span>Reference</span><span class="pg-mono">{reference || "-"}</span>
      </div>
      <div class="d-flex justify-space-between mb-4">
        <span>Amount</span><strong class="pg-money pg-tabular">{amount}</strong>
      </div>
      <VAlert type="info" variant="tonal" density="compact" class="mb-3">
        Sandbox card: 4111 1111 1111 1111 · any future expiry · CVV 123
      </VAlert>
      <div class="d-flex justify-end">
        <TableRowActions
          primaryAction={{
            label: "Complete card payment",
            icon: "mdi-credit-card-check-outline",
            onClick: () => complete(true),
          }}
          items={[
            { key: "spoof", label: "Spoof browser callback without server payment", icon: "mdi-call-split", onClick: () => complete(false) },
            { key: "decline", label: "Trigger card decline", icon: "mdi-credit-card-off-outline", danger: true, dividerBefore: true, onClick: decline },
            { key: "cancel", label: "Cancel", icon: "mdi-close", onClick: cancel },
          ]}
        />
      </div>
    </div>
  );
});

export default WidgetFramePage;
