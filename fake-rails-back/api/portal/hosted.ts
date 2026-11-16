import { Router } from "express";
import { z } from "zod";
import { findTransactionAnyReference, updateTransaction } from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import { webhookDispatcher } from "../../engine/webhooks/WebhookDispatcher";
import { resolveRail } from "../../engine/chaos/DefaultRailScenarios";
import { broadcast } from "./eventHub";
import { issueHostedActionToken, verifyHostedActionToken } from "../../lib/tickets";
import {
  captureAccountHoldForTransaction,
  releaseAccountHoldForTransaction,
} from "../../engine/accounts/AccountLedgerService";

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

/**
 * What the PUBLIC hosted pages may see of a transaction. The session id is a reference anyone who
 * holds the payer link knows, so the secret the payer must prove knowledge of (`expected_otp`) and
 * the merchant callback target (`webhook_url`) are never part of it; testers read both on the
 * authenticated portal routes.
 */
export const publicHostedTransaction = <T extends { expected_otp?: unknown; webhook_url?: unknown }>(
  transaction: T | null | undefined,
): Omit<T, "expected_otp" | "webhook_url"> | null => {
  if (!transaction) return null;
  const { expected_otp: _otp, webhook_url: _webhook, ...visible } = transaction;
  return visible;
};

export const createHostedRouter = (): Router => {
  const router = Router();

  router.get("/session/:id", (request, response) => {
    const transaction = findTransactionAnyReference(request.params.id ?? "");
    if (!transaction) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown hosted session");
    response.json({
      transaction: publicHostedTransaction(transaction),
      rail: resolveRail(transaction.rail_code) ?? null,
      // GAP-024: the approve/decline POST must present this transaction-bound token.
      action_token: issueHostedActionToken(transaction.id),
    });
  });

  router.post("/session/:id/action", (request, response) => {
    const transaction = findTransactionAnyReference(request.params.id ?? "");
    if (!transaction) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown hosted session");
    if (!verifyHostedActionToken(request.header("x-hosted-action-token"), transaction.id)) {
      throw new ApiError(401, "HOSTED_ACTION_TOKEN_REQUIRED", "A valid X-Hosted-Action-Token for this session is required");
    }
    const body = parseOrThrow(actionSchema, request.body);
    const base = process.env.FAKE_RAILS_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
    let redirectUrl = transaction.return_url ?? `${base}/hosted/done`;

    switch (body.action) {
      case "APPROVE": {
        captureAccountHoldForTransaction(transaction.id);
        updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: transaction.normalized_amount_lyd });
        webhookDispatcher.dispatch({
          transaction: { ...transaction, status: "PAID" },
          event: "payment.paid",
          payload: payloadFor(transaction),
        });
        break;
      }
      case "APPROVE_TAMPERED": {
        captureAccountHoldForTransaction(transaction.id);
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
        releaseAccountHoldForTransaction(transaction.id, "Customer declined on the hosted page");
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
        releaseAccountHoldForTransaction(transaction.id, "Customer cancelled on the hosted page");
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
      transaction: publicHostedTransaction(findTransactionAnyReference(transaction.id)),
    });
  });

  return router;
};
