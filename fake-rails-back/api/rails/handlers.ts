import { env } from "../../lib/env";
import { updateTransaction } from "../../engine/db";
import {
  creditRefundToAccount,
  releaseAccountHoldForTransaction,
  reserveAccountFundsForTransaction,
  type FakeAccountRow,
} from "../../engine/accounts/AccountLedgerService";
import {
  declineBody,
  dispatchSuccessWebhook,
  extractOtp,
  successResponse,
  type RailHandler,
  type RailRequestContext,
  type RailResponse,
} from "./common";

const otpMatches = (context: RailRequestContext): boolean => {
  const provided = extractOtp(context.body);
  if (!provided) return true;
  return provided === context.transaction.expected_otp;
};

const awaitingBody = (context: RailRequestContext, extra: Record<string, unknown> = {}): RailResponse => {
  updateTransaction(context.transaction.id, { status: "AWAITING_ACTION" });
  return {
    status: 200,
    body: {
      reference: context.reference,
      our_reference: context.transaction.our_reference,
      provider_reference: context.transaction.provider_reference,
      process_id: context.transaction.provider_reference,
      transaction_id: context.transaction.provider_reference,
      status: "AWAITING_CUSTOMER",
      amount: context.transaction.normalized_amount_lyd,
      currency: context.transaction.currency,
      // The tester portal shows the OTP; it is also returned on the sandbox
      // wire so an automated sandbox runner can complete the flow.
      otp: context.transaction.expected_otp,
      expected_otp: context.transaction.expected_otp,
      expires_in_seconds: 300,
      ...extra,
    },
  };
};

const reserveOrDecline = (
  context: RailRequestContext,
): { declined: RailResponse } | { account: FakeAccountRow } => {
  const hold = reserveAccountFundsForTransaction({
    railCode: context.descriptor.railCode,
    gatewayCode: context.descriptor.gatewayCode,
    identifier: context.customerRaw,
    transactionId: context.transaction.id,
    amountLyd: context.transaction.normalized_amount_lyd,
  });
  if (!hold.allowed) {
    updateTransaction(context.transaction.id, { status: "FAILED" });
    return {
      declined: {
        status: 200,
        body: declineBody(
          context,
          hold.declineCode ?? "INSUFFICIENT_FUNDS",
          hold.declineMessage ?? "Declined by account balance/limit check",
        ),
      },
    };
  }
  if (hold.account.static_otp) {
    updateTransaction(context.transaction.id, { expected_otp: hold.account.static_otp });
    context.transaction.expected_otp = hold.account.static_otp;
  }
  return { account: hold.account };
};

const accountWire = (account: FakeAccountRow): Record<string, unknown> => ({
  account_identifier: account.identifier,
  account_holder_name: account.holder_name,
  available_balance_after_hold_lyd: account.available_balance_lyd,
  reserved_balance_lyd: account.reserved_balance_lyd,
  daily_spent_lyd: account.daily_spent_lyd,
  daily_limit_lyd: account.daily_limit_lyd,
});

/** OTP initiation: checks the account balance and returns the process id + OTP. */
export const otpInitiate: RailHandler = (context) => {
  const reservation = reserveOrDecline(context);
  if ("declined" in reservation) return reservation.declined;
  return awaitingBody(context, accountWire(reservation.account));
};

/** OTP confirmation: verifies the OTP then settles. */
export const otpConfirm: RailHandler = async (context) => {
  if (!otpMatches(context)) {
    updateTransaction(context.transaction.id, { status: "AWAITING_ACTION" });
    return {
      status: 200,
      body: {
        reference: context.reference,
        status: "AWAITING_CUSTOMER",
        success: false,
        error: "WRONG_OTP",
        message: "The OTP is incorrect",
        retryable: true,
      },
    };
  }
  const response = successResponse(context, "PAID", {
    bank_reference: context.transaction.provider_reference,
    transaction_id: context.transaction.provider_reference,
  });
  await dispatchSuccessWebhook(context, "payment.paid");
  return response;
};

/** QR / push / pay-code initiation: awaits a customer action. */
export const asyncInitiate: RailHandler = (context) => {
  const reservation = reserveOrDecline(context);
  if ("declined" in reservation) return reservation.declined;
  const base = `${env.FAKE_RAILS_PUBLIC_BASE_URL.replace(/\/$/, "")}`;
  const qrPayload = `EMVCO|${context.descriptor.railCode}|${context.transaction.provider_reference}|${context.transaction.normalized_amount_lyd}|LYD`;
  return awaitingBody(context, {
    qr_code: qrPayload,
    qr_payload: qrPayload,
    deep_link: `${base}/hosted/redirect/${context.transaction.id}`,
    push_reference: context.transaction.provider_reference,
    pay_code: context.transaction.expected_otp,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...accountWire(reservation.account),
  });
};

/** Redirect initiation: returns the hosted checkout URL. */
export const redirectInitiate: RailHandler = (context) => {
  const reservation = reserveOrDecline(context);
  if ("declined" in reservation) return reservation.declined;
  const base = env.FAKE_RAILS_PUBLIC_BASE_URL.replace(/\/$/, "");
  updateTransaction(context.transaction.id, { status: "AWAITING_ACTION" });
  return {
    status: 200,
    body: {
      reference: context.reference,
      our_reference: context.transaction.our_reference,
      provider_reference: context.transaction.provider_reference,
      transaction_id: context.transaction.provider_reference,
      status: "AWAITING_CUSTOMER",
      redirect_url: `${base}/hosted/redirect/${context.transaction.id}`,
      return_url: context.transaction.return_url,
      cancel_url: context.transaction.cancel_url,
      expires_in_seconds: 900,
      ...accountWire(reservation.account),
    },
  };
};

/** Status / inquiry endpoint. A conflicting override wins over the webhook. */
export const inquiry: RailHandler = (context) => {
  const override = context.transaction.inquiry_override_status;
  const status = override ?? context.transaction.status;
  const paid = status === "PAID" || status === "SUCCEEDED";
  return {
    status: 200,
    body: {
      reference: context.reference,
      our_reference: context.transaction.our_reference,
      provider_reference: context.transaction.provider_reference,
      transaction_id: context.transaction.provider_reference,
      network_reference: context.transaction.network_reference,
      status: paid ? "PAID" : status === "FAILED" ? "FAILED" : "PENDING",
      result: paid ? "SUCCESS" : status === "FAILED" ? "FAILED" : "PENDING",
      payment: {
        status: paid ? "Captured" : status === "FAILED" ? "Declined" : "Pending",
      },
      amount: context.transaction.settled_amount_lyd ?? context.transaction.normalized_amount_lyd,
      currency: context.transaction.currency,
      ActionCode: paid ? "00" : status === "FAILED" ? "05" : "09",
    },
  };
};

/** Refund endpoint: succeeds when the transaction is PAID and credits the customer account. */
export const refund: RailHandler = async (context) => {
  if (context.transaction.status !== "PAID" && context.transaction.status !== "SUCCEEDED") {
    return {
      status: 200,
      body: {
        reference: context.reference,
        status: "FAILED",
        success: false,
        error: "NOT_REFUNDABLE",
        message: "The transaction is not in a refundable state",
      },
    };
  }
  creditRefundToAccount(
    context.transaction.id,
    context.transaction.settled_amount_lyd ?? context.transaction.normalized_amount_lyd,
    "Merchant refund",
  );
  updateTransaction(context.transaction.id, { status: "REFUNDED", settled_amount_lyd: "0.0000" });
  await dispatchSuccessWebhook(context, "payment.refunded");
  return {
    status: 200,
    body: {
      reference: context.reference,
      provider_reference: context.transaction.provider_reference,
      provider_refund_ref: `RF-${context.transaction.provider_reference}`,
      status: "REFUNDED",
      success: true,
      amount: context.transaction.normalized_amount_lyd,
      currency: context.transaction.currency,
    },
  };
};

/** Cancel endpoint: releases any reservation. */
export const cancel: RailHandler = (context) => {
  releaseAccountHoldForTransaction(context.transaction.id, "Payment cancelled by customer");
  updateTransaction(context.transaction.id, { status: "CANCELLED" });
  return {
    status: 200,
    body: {
      reference: context.reference,
      provider_reference: context.transaction.provider_reference,
      status: "CANCELLED",
      success: true,
    },
  };
};

/** A generic "approve/confirm" for push and QR rails. */
export const asyncConfirm: RailHandler = async (context) => {
  const response = successResponse(context, "PAID", {
    transaction_id: context.transaction.provider_reference,
  });
  await dispatchSuccessWebhook(context, "payment.paid");
  return response;
};

export const tokenEndpoint: RailHandler = (context) => ({
  status: 200,
  body: {
    access_token: `fake-access-${context.descriptor.gatewayCode}-${Date.now()}`,
    token_type: "Bearer",
    expires_in: context.descriptor.gatewayCode === "mypay" ? 600 : 3600,
    scope: "payments",
  },
});
