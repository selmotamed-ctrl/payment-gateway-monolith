import { Router } from "express";
import { issueSseTicket, SSE_TICKET_TTL_SECONDS } from "../../lib/tickets";
import { z } from "zod";
import {
  findTransactionAnyReference,
  getDb,
  listStepEvents,
  listTransactions,
  nowIso,
  updateTransaction,
} from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import { webhookDispatcher } from "../../engine/webhooks/WebhookDispatcher";
import { broadcast, subscribe } from "./eventHub";
import {
  captureAccountHoldForTransaction,
  fromMicros,
  releaseAccountHoldForTransaction,
  toMicros,
} from "../../engine/accounts/AccountLedgerService";

const actionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "APPROVE_MISMATCH", "APPROVE_LATE", "FORCE_OUTCOME", "CANCEL"]),
  phase: z.enum(["INITIATE", "SUBMIT", "VERIFY", "WEBHOOK", "REFUND"]).optional(),
  failureMode: z.string().max(80).optional(),
});

const transactionFor = (id: string) => {
  const row = findTransactionAnyReference(id);
  if (!row) throw new ApiError(404, "TRANSACTION_NOT_FOUND", `No fake transaction '${id}'`);
  return row;
};

const TERMINAL = new Set(["PAID", "REFUNDED", "CANCELLED"]);
const assertOpen = (transaction: { status: string }, action: string): void => {
  if (TERMINAL.has(transaction.status) && !(action === "APPROVE" && transaction.status === "PAID")) {
    throw new ApiError(
      409,
      "TRANSACTION_STATE_INVALID",
      `Cannot ${action.toLowerCase().replaceAll("_", " ")} a transaction in status ${transaction.status}`,
    );
  }
};

const captureIfHeld = (transactionId: string, settledOverrideLyd?: string): void => {
  try {
    captureAccountHoldForTransaction(transactionId, settledOverrideLyd);
  } catch (error) {
    // A manually seeded/non-account transaction has no hold; the tester action
    // still moves its status. A real capture error must surface.
    if ((error as { code?: string }).code === "CAPTURE_EXCEEDS_AVAILABLE") throw error;
  }
};

const releaseIfHeld = (transactionId: string, reason: string): void => {
  releaseAccountHoldForTransaction(transactionId, reason);
};

export const createTransactionsRouter = (): Router => {
  const router = Router();

  router.get("/", (request, response) => {
    const query = request.query as Record<string, string | undefined>;
    const result = listTransactions({
      railCode: query.railCode,
      gatewayCode: query.gatewayCode,
      status: query.status,
      reference: query.reference,
      from: query.from,
      to: query.to,
      limit: query.limit ? Number(query.limit) : 100,
      offset: query.offset ? Number(query.offset) : 0,
    });
    response.json({ total: result.total, rows: result.rows });
  });

  /** Issues the single-use ticket EventSource presents in the query string. */
  router.post("/stream-ticket", (request, response) => {
    response.json({ ticket: issueSseTicket(String(request.tester?.sub ?? "tester")), expiresInSeconds: SSE_TICKET_TTL_SECONDS });
  });

  router.get("/stream", (request, response) => {
    const unsubscribe = subscribe(response);
    request.on("close", unsubscribe);
  });

  router.get("/summary", (_request, response) => {
    const db = getDb();
    const totals = db
      .prepare(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(CAST(normalized_amount_lyd AS REAL)), 0) AS amount
         FROM fake_transactions GROUP BY status`,
      )
      .all() as Array<{ status: string; count: number; amount: number }>;
    const rails = db
      .prepare(
        `SELECT rail_code, COUNT(*) AS count FROM fake_transactions GROUP BY rail_code ORDER BY count DESC`,
      )
      .all() as Array<{ rail_code: string; count: number }>;
    const pendingActions = db
      .prepare(
        `SELECT id, rail_code, gateway_code, our_reference, provider_reference, expected_otp,
                normalized_amount_lyd, collection_mode, created_at
         FROM fake_transactions WHERE status IN ('AWAITING_ACTION','INITIATED')
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all();
    response.json({
      totals,
      rails,
      pendingActions,
      sseClients: undefined,
      at: nowIso(),
    });
  });

  router.get("/:id", (request, response) => {
    const transaction = transactionFor(request.params.id ?? "");
    response.json({
      transaction,
      events: listStepEvents(transaction.id),
      deliveries: webhookDispatcher.list(transaction.id),
    });
  });

  router.post("/:id/action", async (request, response) => {
    const transaction = transactionFor(request.params.id ?? "");
    const body = parseOrThrow(actionSchema, request.body);
    const actor = request.tester?.sub ?? "tester";

    switch (body.action) {
      case "APPROVE": {
        assertOpen(transaction, body.action);
        captureIfHeld(transaction.id);
        updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: transaction.normalized_amount_lyd });
        webhookDispatcher.dispatch({
          transaction: { ...transaction, status: "PAID" },
          event: "payment.paid",
          payload: {
            reference: transaction.our_reference,
            provider_reference: transaction.provider_reference,
            amount: transaction.normalized_amount_lyd,
            currency: transaction.currency,
            status: "PAID",
          },
        });
        break;
      }
      case "APPROVE_MISMATCH": {
        assertOpen(transaction, body.action);
        const settled = fromMicros(toMicros(transaction.normalized_amount_lyd) + 500n);
        captureIfHeld(transaction.id, settled);
        updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: settled });
        webhookDispatcher.dispatch({
          transaction: { ...transaction, status: "PAID" },
          event: "payment.paid",
          payload: {
            reference: transaction.our_reference,
            provider_reference: transaction.provider_reference,
            amount: settled,
            currency: transaction.currency,
            status: "PAID",
          },
        });
        break;
      }
      case "APPROVE_LATE": {
        assertOpen(transaction, body.action);
        captureIfHeld(transaction.id);
        updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: transaction.normalized_amount_lyd });
        webhookDispatcher.dispatch({
          transaction: { ...transaction, status: "PAID" },
          event: "payment.paid",
          payload: {
            reference: transaction.our_reference,
            provider_reference: transaction.provider_reference,
            amount: transaction.normalized_amount_lyd,
            currency: transaction.currency,
            status: "PAID",
            late: true,
          },
          behavior: { delaySeconds: 1 },
        });
        break;
      }
      case "REJECT": {
        assertOpen(transaction, body.action);
        releaseIfHeld(transaction.id, "Rejected by the Fake Rails tester");
        updateTransaction(transaction.id, { status: "FAILED" });
        webhookDispatcher.dispatch({
          transaction,
          event: "payment.failed",
          payload: {
            reference: transaction.our_reference,
            provider_reference: transaction.provider_reference,
            status: "FAILED",
            error: "DECLINED_BY_CUSTOMER",
          },
        });
        break;
      }
      case "CANCEL": {
        assertOpen(transaction, body.action);
        releaseIfHeld(transaction.id, "Cancelled by the Fake Rails tester");
        updateTransaction(transaction.id, { status: "CANCELLED" });
        break;
      }
      case "FORCE_OUTCOME": {
        updateTransaction(transaction.id, {
          assigned_fail_phase: body.phase ?? "SUBMIT",
          assigned_failure_mode: body.failureMode ?? "TERMINAL_DECLINE_INSUFFICIENT_FUNDS",
        });
        break;
      }
    }

    getDb()
      .prepare("INSERT INTO fake_portal_audit (id, actor, action, target, payload_json, created_at) VALUES (?,?,?,?,?,?)")
      .run(crypto.randomUUID(), actor, body.action, transaction.id, JSON.stringify(body), nowIso());
    broadcast("transaction.action", { transactionId: transaction.id, action: body.action, actor });
    response.json({ ok: true, transaction: transactionFor(transaction.id) });
  });

  router.get("/:id/events", (request, response) => {
    const transaction = transactionFor(request.params.id ?? "");
    response.json({ events: listStepEvents(transaction.id) });
  });

  return router;
};
