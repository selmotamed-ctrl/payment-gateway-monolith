-- AUTO-20: durable follow-up of refunds stuck in EXECUTING.
-- A REFUND_INQUIRY background job asks the gateway again with backoff and
-- finalises or fails the adjustment, or opens an operator case when the
-- inquiry window elapses. The value is only added here; nothing in this
-- migration uses it, so it is safe inside the migration transaction.
ALTER TYPE "BackgroundJobType" ADD VALUE IF NOT EXISTS 'REFUND_INQUIRY';
