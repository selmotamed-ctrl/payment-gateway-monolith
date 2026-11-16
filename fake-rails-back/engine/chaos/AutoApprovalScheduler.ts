import { getDb, nowIso, type FakeTransactionRow } from "../db";
import { captureAccountHoldForTransaction } from "../accounts/AccountLedgerService";
import { getScenario } from "./scenarioStore";
import { webhookDispatcher } from "../webhooks/WebhookDispatcher";

/**
 * Async rails become real once the tester configures
 * `autoApproveAsyncAfterSec`: the customer's pending push/QR/deep-link is
 * approved after the configured delay exactly as a mobile banking app would.
 *
 * The scheduler is deliberately process-local and disabled in tests unless the
 * timer is started explicitly; it never runs in the request path.
 */
let timer: ReturnType<typeof setInterval> | undefined;

const payloadFor = (transaction: FakeTransactionRow) => ({
  reference: transaction.our_reference,
  our_reference: transaction.our_reference,
  provider_reference: transaction.provider_reference,
  transaction_id: transaction.provider_reference,
  amount: transaction.settled_amount_lyd ?? transaction.normalized_amount_lyd,
  currency: transaction.currency,
  status: "PAID",
});

export const runAutoApprovalTick = (now = Date.now()): number => {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM fake_transactions WHERE status IN ('AWAITING_ACTION','INITIATED') ORDER BY created_at ASC LIMIT 200")
    .all() as FakeTransactionRow[];
  let approved = 0;
  for (const transaction of rows) {
    const scenario = getScenario(transaction.rail_code);
    if (!scenario.autoApproveAsyncAfterSec || scenario.autoApproveAsyncAfterSec <= 0) continue;
    const createdAt = Date.parse(transaction.created_at);
    if (!Number.isFinite(createdAt)) continue;
    if (now < createdAt + scenario.autoApproveAsyncAfterSec * 1000) continue;
    captureAccountHoldForTransaction(transaction.id, transaction.normalized_amount_lyd);
    const updated = {
      ...transaction,
      status: "PAID",
      settled_amount_lyd: transaction.normalized_amount_lyd,
      updated_at: nowIso(),
    };
    db.prepare("UPDATE fake_transactions SET status = 'PAID', settled_amount_lyd = ?, updated_at = ? WHERE id = ?")
      .run(updated.settled_amount_lyd, updated.updated_at, transaction.id);
    webhookDispatcher.dispatch({
      transaction: updated,
      event: "payment.paid",
      payload: payloadFor(updated),
      behavior: { delaySeconds: scenario.webhookBehavior?.delaySeconds ?? 0 },
    });
    approved += 1;
  }
  return approved;
};

export const startAutoApprovalScheduler = (): (() => void) => {
  if (timer) return () => undefined;
  const interval = Math.max(
    250,
    Number(process.env.FAKE_RAILS_AUTO_APPROVE_INTERVAL_MS ?? "1000") || 1000,
  );
  timer = setInterval(() => {
    try {
      runAutoApprovalTick();
    } catch {
      // A scheduler failure must not crash the emulator; the next tick retries.
    }
  }, interval);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
};
