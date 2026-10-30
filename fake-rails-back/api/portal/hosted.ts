import { Router } from "express";
import { z } from "zod";
import { findTransactionAnyReference, updateTransaction } from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import { webhookDispatcher } from "../../engine/webhooks/WebhookDispatcher";
import { resolveRail } from "../../engine/chaos/DefaultRailScenarios";
import { broadcast } from "./eventHub";

const actionSchema = z.object({
  action: z.enum([
    "APPROVE",
    "APPROVE_TAMPERED",
    "DROP_WEBHOOK",
    "ABANDON",
    "DECLINE",
    "CANCEL",
  ]),
});

const payloadFor = (transaction: NonNullable<ReturnType<typeof findTransactionAnyReference>>) => ({
  reference: transaction.our_reference,
  our_reference: transaction.our_reference,
  provider_reference: transaction.provider_reference,
  transaction_id: transaction.provider_reference,
  amount: transaction.normalized_amount_lyd,
  currency: transaction.currency,
  status: "PAID",
});

export const createHostedRouter = (): Router => {
  const router = Router();

  router.get("/session/:id", (request, response) => {
    const transaction = findTransactionAnyReference(request.params.id ?? "");
    if (!transaction) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown hosted session");
    response.json({
      transaction,
      rail: resolveRail(transaction.rail_code) ?? null,
    });
  });

  router.post("/session/:id/action", (request, response) => {
    const transaction = findTransactionAnyReference(request.params.id ?? "");
    if (!transaction) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown hosted session");
    const body = parseOrThrow(actionSchema, request.body);
    const base = process.env.FAKE_RAILS_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
    let redirectUrl = transaction.return_url ?? `${base}/hosted/done`;

    switch (body.action) {
      case "APPROVE": {
        updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: transaction.normalized_amount_lyd });
        webhookDispatcher.dispatch({
          transaction: { ...transaction, status: "PAID" },
          event: "payment.paid",
          payload: payloadFor(transaction),
        });
        break;
      }
      case "APPROVE_TAMPERED": {
        updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: transaction.normalized_amount_lyd });
        webhookDispatcher.dispatch({
          transaction: { ...transaction, status: "PAID" },
          event: "payment.paid",
          payload: payloadFor(transaction),
        });
        const separator = redirectUrl.includes("?") ? "&" : "?";
        redirectUrl = `${redirectUrl}${separator}status=failed&amount=0.01`;
        break;
      }
      case "DROP_WEBHOOK": {
        updateTransaction(transaction.id, { status: "AWAITING_ACTION" });
        break;
      }
      case "ABANDON": {
        updateTransaction(transaction.id, { status: "AWAITING_ACTION" });
        webhookDispatcher.dispatch({
          transaction: { ...transaction, status: "PAID" },
          event: "payment.paid",
          payload: payloadFor(transaction),
          behavior: { delaySeconds: 30 },
        });
        break;
      }
      case "DECLINE": {
        updateTransaction(transaction.id, { status: "FAILED" });
        webhookDispatcher.dispatch({
          transaction,
          event: "payment.failed",
          payload: { ...payloadFor(transaction), status: "FAILED", error: "INSUFFICIENT_FUNDS" },
        });
        redirectUrl = transaction.cancel_url ?? redirectUrl;
        break;
      }
      case "CANCEL": {
        updateTransaction(transaction.id, { status: "CANCELLED" });
        redirectUrl = transaction.cancel_url ?? redirectUrl;
        break;
      }
    }
    broadcast("hosted.action", { transactionId: transaction.id, action: body.action });
    response.json({
      ok: true,
      action: body.action,
      redirect_url: redirectUrl,
      transaction: findTransactionAnyReference(transaction.id),
    });
  });

  return router;
};
