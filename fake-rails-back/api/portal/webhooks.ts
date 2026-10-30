import { Router } from "express";
import { z } from "zod";
import { findTransactionAnyReference } from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import { webhookDispatcher } from "../../engine/webhooks/WebhookDispatcher";
import { broadcast } from "./eventHub";

const fireSchema = z.object({
  event: z.string().trim().min(1).max(120).default("payment.paid"),
  delaySeconds: z.number().min(0).max(3600).default(0),
  duplicateCount: z.number().min(1).max(5).default(1),
  outOfOrderPendingAfterPaid: z.boolean().default(false),
  corruptSignatureChancePercent: z.number().min(0).max(100).default(0),
  status: z.string().trim().max(40).default("PAID"),
});

export const createWebhooksRouter = (): Router => {
  const router = Router();

  router.get("/", (request, response) => {
    response.json({ deliveries: webhookDispatcher.list(request.query.transactionId as string | undefined) });
  });

  router.post("/:transactionId/fire", (request, response) => {
    const transaction = findTransactionAnyReference(request.params.transactionId ?? "");
    if (!transaction) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "Unknown transaction");
    const body = parseOrThrow(fireSchema, request.body);
    const deliveries = webhookDispatcher.dispatch({
      transaction,
      event: body.event,
      payload: {
        reference: transaction.our_reference,
        provider_reference: transaction.provider_reference,
        amount: transaction.settled_amount_lyd ?? transaction.normalized_amount_lyd,
        currency: transaction.currency,
        status: body.status,
      },
      behavior: {
        delaySeconds: body.delaySeconds,
        duplicateCount: body.duplicateCount,
        outOfOrderPendingAfterPaid: body.outOfOrderPendingAfterPaid,
        corruptSignatureChancePercent: body.corruptSignatureChancePercent,
      },
    });
    broadcast("webhook.queued", { transactionId: transaction.id, count: deliveries.length });
    response.status(202).json({ deliveries });
  });

  router.post("/:deliveryId/replay", (request, response) => {
    const tamper = request.query.tamper === "true";
    const delivery = webhookDispatcher.replay(request.params.deliveryId ?? "", tamper);
    if (!delivery) throw new ApiError(404, "DELIVERY_NOT_FOUND", "Unknown delivery");
    broadcast("webhook.replayed", { deliveryId: delivery.id, tamper });
    response.json({ delivery });
  });

  router.post("/:deliveryId/send-now", async (request, response) => {
    const delivery = await webhookDispatcher.send(request.params.deliveryId ?? "");
    if (!delivery) throw new ApiError(404, "DELIVERY_NOT_FOUND", "Unknown delivery");
    response.json({ delivery });
  });

  router.post("/:transactionId/dispute", (request, response) => {
    const transaction = findTransactionAnyReference(request.params.transactionId ?? "");
    if (!transaction) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "Unknown transaction");
    const deliveries = webhookDispatcher.dispatch({
      transaction,
      event: "DISPUTE_OPENED",
      payload: {
        reference: transaction.our_reference,
        provider_reference: transaction.provider_reference,
        external_dispute_ref: `DSP-${transaction.provider_reference}`,
        amount: transaction.settled_amount_lyd ?? transaction.normalized_amount_lyd,
        currency: transaction.currency,
        status: "DISPUTE_OPENED",
        reason_code: "FRAUD",
      },
    });
    broadcast("webhook.dispute", { transactionId: transaction.id, count: deliveries.length });
    response.status(202).json({ deliveries });
  });

  return router;
};
