import { Router } from "express";
import { z } from "zod";
import {
  adjustFakeAccountBalance,
  ensureDefaultFakeAccountsSeeded,
  listAccountMovements,
  listFakeAccounts,
  releaseAccountHoldForTransaction,
  resetFakeAccountsToDefaults,
  settleAccountForTransaction,
} from "../../engine/accounts/AccountLedgerService";
import {
  findTransactionAnyReference,
  getDb,
  nowIso,
  updateTransaction,
  uuidv7,
} from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import { webhookDispatcher } from "../../engine/webhooks/WebhookDispatcher";
import { broadcast } from "./eventHub";

const accountIdSchema = z.string().min(1).max(128);

const createAccountSchema = z.object({
  railCode: z.string().min(2).max(64),
  gatewayCode: z.string().min(2).max(64),
  merchantId: z.string().uuid().optional().nullable(),
  instrumentType: z.enum(["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"]).default("MOBILE_WALLET"),
  identifier: z.string().min(3).max(64),
  holderName: z.string().min(2).max(120),
  secretPin: z.string().min(3).max(16).default("1234"),
  expiry: z.string().max(16).optional().nullable(),
  availableBalanceLyd: z.string().regex(/^[+-]?\d+(\.\d{1,4})?$/).default("5000.0000"),
  dailyLimitLyd: z.string().regex(/^[+-]?\d+(\.\d{1,4})?$/).default("10000.0000"),
  status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).default("ACTIVE"),
  staticOtp: z.string().regex(/^\d{4,8}$/).optional().nullable(),
  presetFault: z.string().max(64).optional().nullable(),
  notes: z.string().max(255).optional().nullable(),
});

const patchAccountSchema = z.object({
  availableBalanceLyd: z.string().regex(/^[+-]?\d+(\.\d{1,4})?$/).optional(),
  dailyLimitLyd: z.string().regex(/^[+-]?\d+(\.\d{1,4})?$/).optional(),
  dailySpentLyd: z.string().regex(/^[+-]?\d+(\.\d{1,4})?$/).optional(),
  status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).optional(),
  staticOtp: z.string().regex(/^\d{4,8}$/).optional().nullable(),
  presetFault: z.string().max(64).optional().nullable(),
  quickPreset: z.enum(["SET_ZERO", "SET_LINK_AMOUNT", "TOP_UP_5000", "RESET_DAILY_SPENT"]).optional(),
  linkAmountLyd: z.string().optional(),
  reason: z.string().max(255).optional(),
});

const simulateActionSchema = z.object({
  action: z.enum([
    "APPROVE_PUSH_OR_QR",
    "DECLINE_PUSH_OR_QR",
    "APPROVE_WITH_VARIANCE",
    "FIRE_WEBHOOK_NOW",
    "REPLAY_DUPLICATE_WEBHOOK",
    "FIRE_TAMPERED_WEBHOOK",
  ]),
});

const resetSchema = z.object({
  merchantId: z.string().uuid().optional().nullable(),
});

const asyncModes = new Set(["QR_DISPLAY", "PUSH_APPROVAL", "PAY_CODE", "DEEP_LINK", "REDIRECT", "EMBEDDED"]);

const accountPayload = (transaction: NonNullable<ReturnType<typeof findTransactionAnyReference>>) => ({
  reference: transaction.our_reference,
  our_reference: transaction.our_reference,
  provider_reference: transaction.provider_reference,
  transaction_id: transaction.provider_reference,
  amount: transaction.normalized_amount_lyd,
  currency: transaction.currency,
  status: "PAID",
});

const publicBaseUrl = (): string => (process.env.FAKE_RAILS_PUBLIC_BASE_URL ?? "http://127.0.0.1:8444").replace(/\/+$/, "");

const holdRows = (transactionId: string) =>
  getDb().prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?").get(transactionId) as
    | { account_id: string; amount_lyd: string; state: string }
    | undefined;

const accountRow = (accountId: string) =>
  getDb().prepare("SELECT * FROM fake_accounts WHERE id = ?").get(accountId) as
    | (Record<string, unknown> & { id: string; available_balance_lyd: string })
    | undefined;

export const createAccountsRouter = (): Router => {
  const router = Router();

  router.get("/accounts", (request, response) => {
    ensureDefaultFakeAccountsSeeded();
    const railCode = typeof request.query.railCode === "string" ? request.query.railCode : undefined;
    const gatewayCode = typeof request.query.gatewayCode === "string" ? request.query.gatewayCode : undefined;
    const merchantId = typeof request.query.merchantId === "string" ? request.query.merchantId : undefined;
    response.json({ accounts: listFakeAccounts({ railCode, gatewayCode, merchantId }) });
  });

  router.post("/accounts", (request, response) => {
    ensureDefaultFakeAccountsSeeded();
    const body = parseOrThrow(createAccountSchema, request.body);
    const db = getDb();
    const id = uuidv7();
    const now = nowIso();
    try {
      db.prepare(`
        INSERT INTO fake_accounts (
          id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
          holder_name, secret_pin, expiry, currency, available_balance_lyd,
          reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, status,
          static_otp, preset_fault, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'LYD', ?, '0.0000', ?, '0.0000', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        body.railCode,
        body.gatewayCode,
        body.merchantId ?? null,
        body.instrumentType,
        body.identifier.trim(),
        body.holderName.trim(),
        body.secretPin,
        body.expiry ?? "12/28",
        Number(body.availableBalanceLyd).toFixed(4),
        Number(body.dailyLimitLyd).toFixed(4),
        body.status,
        body.staticOtp ?? null,
        body.presetFault ?? null,
        body.notes ?? null,
        now,
        now,
      );
    } catch (error) {
      if (String((error as { code?: string }).code ?? "").includes("CONSTRAINT")) {
        throw new ApiError(409, "FAKE_ACCOUNT_EXISTS", "A test account with this rail and identifier already exists");
      }
      throw error;
    }
    response.status(201).json({ account: accountRow(id) });
  });

  router.post("/accounts/reset", (request, response) => {
    const body = parseOrThrow(resetSchema, request.body ?? {});
    const result = resetFakeAccountsToDefaults(body.merchantId ?? undefined);
    broadcast("account.reset", result);
    response.json({ ok: true, ...result });
  });

  router.patch("/accounts/:accountId", (request, response) => {
    const accountId = parseOrThrow(accountIdSchema, request.params.accountId);
    const body = parseOrThrow(patchAccountSchema, request.body);
    const current = accountRow(accountId);
    if (!current) {
      throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
    }

    let availableBalanceLyd = body.availableBalanceLyd;
    let dailySpentLyd = body.dailySpentLyd;
    if (body.quickPreset === "SET_ZERO") {
      availableBalanceLyd = "0.0000";
    } else if (body.quickPreset === "SET_LINK_AMOUNT" && body.linkAmountLyd) {
      availableBalanceLyd = Number(body.linkAmountLyd).toFixed(4);
    } else if (body.quickPreset === "TOP_UP_5000") {
      availableBalanceLyd = (Number(current.available_balance_lyd) + 5000).toFixed(4);
    } else if (body.quickPreset === "RESET_DAILY_SPENT") {
      dailySpentLyd = "0.0000";
    }

    const updated = adjustFakeAccountBalance({
      accountId,
      availableBalanceLyd,
      dailyLimitLyd: body.dailyLimitLyd,
      dailySpentLyd,
      status: body.status,
      staticOtp: body.staticOtp,
      presetFault: body.presetFault,
      reason: body.reason ?? `Quick preset: ${body.quickPreset ?? "manual edit"}`,
    });
    broadcast("account.updated", { account: updated });
    response.json({ account: updated });
  });

  router.get("/accounts/:accountId/movements", (request, response) => {
    const accountId = parseOrThrow(accountIdSchema, request.params.accountId);
    if (!accountRow(accountId)) {
      throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
    }
    response.json({ movements: listAccountMovements(accountId) });
  });

  router.get("/checkout-helper/:reference", (request, response) => {
    const reference = String(request.params.reference ?? "");
    const transaction = findTransactionAnyReference(reference);
    if (!transaction) {
      response.json({ activeAttemptSecrets: null });
      return;
    }
    const db = getDb();
    const hold = holdRows(transaction.id);
    const account = hold ? accountRow(hold.account_id) : null;
    const events = db
      .prepare(
        `SELECT phase, response_status AS status, injected_fault AS fault,
                duration_ms AS durationMs, created_at AS createdAt
           FROM fake_step_events WHERE transaction_id = ?
          ORDER BY created_at DESC LIMIT 10`,
      )
      .all(transaction.id);

    response.json({
      activeAttemptSecrets: {
        ourReference: transaction.our_reference,
        providerReference: transaction.provider_reference,
        expectedOtp: transaction.expected_otp,
        collectionMode: transaction.collection_mode,
        boundAccountId: account?.id ?? null,
        boundAccountIdentifier: account?.identifier ?? transaction.customer_identifier_masked ?? null,
        boundAccountBalanceAfterHoldLyd: account?.available_balance_lyd ?? null,
        heldAmountLyd: hold?.amount_lyd ?? null,
        qrPayload: asyncModes.has(transaction.collection_mode)
          ? `EMVCO|${transaction.rail_code}|${transaction.provider_reference}|${transaction.normalized_amount_lyd}|LYD`
          : null,
        deepLinkUrl: asyncModes.has(transaction.collection_mode)
          ? `${publicBaseUrl()}/hosted/redirect/${transaction.id}`
          : null,
        redirectUrl: transaction.return_url ?? null,
        canSimulateMobilePushOrQrApproval: asyncModes.has(transaction.collection_mode)
          && transaction.status !== "PAID"
          && transaction.status !== "REFUNDED",
        recentWireEvents: events,
      },
    });
  });

  router.post("/checkout-helper/:reference/simulate-action", (request, response) => {
    const reference = String(request.params.reference ?? "");
    const transaction = findTransactionAnyReference(reference);
    if (!transaction) {
      throw new ApiError(404, "FAKE_TX_NOT_FOUND", `Transaction ${reference} not found`);
    }
    const { action } = parseOrThrow(simulateActionSchema, request.body);
    const basePayload = accountPayload(transaction);

    if (action === "APPROVE_PUSH_OR_QR" || action === "FIRE_WEBHOOK_NOW") {
      settleAccountForTransaction({
        railCode: transaction.rail_code,
        gatewayCode: transaction.gateway_code,
        identifier: transaction.customer_identifier,
        transactionId: transaction.id,
        amountLyd: transaction.normalized_amount_lyd,
        settledAmountLyd: transaction.normalized_amount_lyd,
      });
      updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: transaction.normalized_amount_lyd });
      webhookDispatcher.dispatch({
        transaction: { ...transaction, status: "PAID" },
        event: "payment.paid",
        payload: { ...basePayload, status: "PAID" },
      });
    } else if (action === "APPROVE_WITH_VARIANCE") {
      const varianceSettled = (Number(transaction.normalized_amount_lyd) + 0.05).toFixed(4);
      settleAccountForTransaction({
        railCode: transaction.rail_code,
        gatewayCode: transaction.gateway_code,
        identifier: transaction.customer_identifier,
        transactionId: transaction.id,
        amountLyd: transaction.normalized_amount_lyd,
        settledAmountLyd: varianceSettled,
      });
      updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: varianceSettled });
      webhookDispatcher.dispatch({
        transaction: { ...transaction, status: "PAID", settled_amount_lyd: varianceSettled },
        event: "payment.paid",
        payload: { ...basePayload, amount: varianceSettled, settled_amount: varianceSettled, status: "PAID" },
      });
    } else if (action === "DECLINE_PUSH_OR_QR") {
      releaseAccountHoldForTransaction(transaction.id, "Customer rejected push/QR on simulated mobile app");
      updateTransaction(transaction.id, { status: "FAILED" });
      webhookDispatcher.dispatch({
        transaction: { ...transaction, status: "FAILED" },
        event: "payment.failed",
        payload: { ...basePayload, status: "FAILED", error: "CUSTOMER_REJECTED" },
      });
    } else if (action === "REPLAY_DUPLICATE_WEBHOOK") {
      webhookDispatcher.dispatch({
        transaction: { ...transaction, status: "PAID" },
        event: "payment.paid",
        payload: { ...basePayload, status: "PAID" },
        behavior: { duplicateCount: 2 },
      });
    } else if (action === "FIRE_TAMPERED_WEBHOOK") {
      webhookDispatcher.dispatch({
        transaction: { ...transaction, status: "PAID" },
        event: "payment.paid",
        payload: { ...basePayload, status: "PAID" },
        behavior: { corruptSignatureChancePercent: 100 },
      });
    }

    broadcast("checkout.simulate", { transactionId: transaction.id, action });
    response.json({ ok: true, action, transactionId: transaction.id });
  });

  return router;
};
