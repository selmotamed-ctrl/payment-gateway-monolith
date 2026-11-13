import { Router } from "express";
import { z } from "zod";
import {
  adjustFakeAccountBalance,
  businessDate,
  captureAccountHoldForTransaction,
  ensureDefaultFakeAccountsSeeded,
  generateClearingStatement,
  markStatementIncluded,
  getFakeAccount,
  listAccountHolds,
  listAccountMovements,
  listClearingPools,
  listFakeAccounts,
  listFakeAccountsPage,
  restorePresetAccount,
  markClearingSettled,
  releaseAccountHoldForTransaction,
  resetFakeAccounts,
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

const amountSchema = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);

const createAccountSchema = z.object({
  railCode: z.string().min(2).max(64),
  gatewayCode: z.string().min(2).max(64),
  merchantId: z.string().uuid().optional().nullable(),
  instrumentType: z.enum(["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"]).default("MOBILE_WALLET"),
  identifier: z.string().min(3).max(64),
  holderName: z.string().min(2).max(120),
  secretPin: z.string().min(3).max(16).default("1234"),
  expiry: z.string().max(16).optional().nullable(),
  availableBalanceLyd: amountSchema.default("5000.0000"),
  dailyLimitLyd: amountSchema.default("10000.0000"),
  status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).default("ACTIVE"),
  staticOtp: z.string().regex(/^\d{4,8}$/).optional().nullable(),
  notes: z.string().max(255).optional().nullable(),
});

const patchAccountSchema = z.object({
  availableBalanceLyd: amountSchema.optional(),
  deltaLyd: amountSchema.optional(),
  dailyLimitLyd: amountSchema.optional(),
  dailySpentLyd: amountSchema.optional(),
  status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).optional(),
  staticOtp: z.string().regex(/^\d{4,8}$/).optional().nullable(),
  presetFault: z.string().max(64).optional().nullable(),
  quickPreset: z
    .enum(["SET_ZERO", "SET_LINK_AMOUNT", "TOP_UP_5000", "RESET_DAILY_SPENT"])
    .optional(),
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

export const createAccountsRouter = (): Router => {
  const router = Router();
  ensureDefaultFakeAccountsSeeded();

  router.get("/accounts", (request, response) => {
    const railCode = typeof request.query.railCode === "string" ? request.query.railCode : undefined;
    const gatewayCode = typeof request.query.gatewayCode === "string" ? request.query.gatewayCode : undefined;
    const merchantId = typeof request.query.merchantId === "string" ? request.query.merchantId : undefined;
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const instrumentType = typeof request.query.instrumentType === "string" ? request.query.instrumentType : undefined;
    const scope = typeof request.query.scope === "string" ? request.query.scope : undefined;
    const createdFrom = typeof request.query.from === "string" ? request.query.from : undefined;
    const createdTo = typeof request.query.to === "string" ? request.query.to : undefined;
    const search = typeof request.query.search === "string" ? request.query.search : undefined;
    const includeGlobal = String(request.query.includeGlobal ?? "") === "true";
    const page = request.query.page ? Number(request.query.page) : undefined;
    const pageSize = request.query.pageSize ? Number(request.query.pageSize) : undefined;
    if (page !== undefined || pageSize !== undefined || search) {
      response.json(listFakeAccountsPage({ railCode, gatewayCode, merchantId, status, instrumentType, scope, createdFrom, createdTo, search, includeGlobal, page, pageSize }));
      return;
    }
    response.json({ accounts: listFakeAccounts({ railCode, gatewayCode, merchantId, status, search, includeGlobal }) });
  });

  router.get("/accounts/:accountId", (request, response) => {
    const account = getFakeAccount(String(request.params.accountId ?? ""));
    if (!account) throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", `Account ${request.params.accountId} not found`);
    response.json({ account });
  });

  router.post("/accounts", (request, response) => {
    ensureDefaultFakeAccountsSeeded();
    const body = parseOrThrow(createAccountSchema, request.body);
    const db = getDb();
    const id = uuidv7();
    const now = nowIso();
    const existing = db
      .prepare(
        body.merchantId
          ? "SELECT id FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND (merchant_id = ? OR merchant_id IS NULL)"
          : "SELECT id FROM fake_accounts WHERE rail_code = ? AND identifier = ? AND merchant_id IS NULL",
      )
      .get(...(body.merchantId ? [body.railCode, body.identifier.trim(), body.merchantId] : [body.railCode, body.identifier.trim()]) as never[]);
    if (existing) {
      throw new ApiError(409, "FAKE_ACCOUNT_EXISTS", "An account with this rail and identifier already exists");
    }
    db.prepare(`
      INSERT INTO fake_accounts (
        id, rail_code, gateway_code, merchant_id, instrument_type, identifier,
        holder_name, secret_pin, expiry, currency, available_balance_lyd,
        reserved_balance_lyd, daily_limit_lyd, daily_spent_lyd, daily_spent_date, status,
        static_otp, preset_fault, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'LYD',?,'0.0000',?,'0.0000',?,?,?,NULL,?,?,?)
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
      businessDate(),
      body.status,
      body.staticOtp ?? null,
      body.notes ?? null,
      now,
      now,
    );
    response.status(201).json({ account: getFakeAccount(id) });
  });

  router.patch("/accounts/:accountId", (request, response) => {
    const accountId = String(request.params.accountId ?? "");
    const body = parseOrThrow(patchAccountSchema, request.body);
    const current = getFakeAccount(accountId);
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
    const accountId = String(request.params.accountId ?? "");
    if (!getFakeAccount(accountId)) {
      throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
    }
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    response.json({ movements: listAccountMovements(accountId, limit) });
  });

  router.get("/accounts/:accountId/holds", (request, response) => {
    const accountId = String(request.params.accountId ?? "");
    if (!getFakeAccount(accountId)) {
      throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);
    }
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    response.json({ holds: listAccountHolds(accountId, limit) });
  });

  router.post("/accounts/:accountId/restore", (request, response) => {
    const accountId = String(request.params.accountId ?? "");
    try {
      const restored = restorePresetAccount(accountId);
      broadcast("account.updated", { account: restored });
      response.json({ account: restored });
    } catch (error) {
      throw new ApiError(
        (error as { code?: string }).code === "FAKE_ACCOUNT_NOT_FOUND" ? 404 : 409,
        (error as { code?: string }).code ?? "FAKE_ACCOUNT_RESTORE_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  router.post("/accounts/reset", (request, response) => {
    const merchantId = typeof request.body?.merchantId === "string" ? request.body.merchantId : null;
    const removed = resetFakeAccounts({ merchantId });
    response.json({ ok: true, removed, merchantId });
  });

  router.get("/checkout-helper/:reference", (request, response) => {
    const reference = String(request.params.reference ?? "");
    const transaction = findTransactionAnyReference(reference);
    if (!transaction) {
      response.json({ activeAttemptSecrets: null });
      return;
    }
    const db = getDb();
    const hold = db
      .prepare("SELECT * FROM fake_account_holds WHERE transaction_id = ?")
      .get(transaction.id) as { account_id: string; amount_lyd: string; state: string } | undefined;
    const account = hold ? getFakeAccount(hold.account_id) : null;
    const events = db
      .prepare(`
        SELECT phase, response_status as status, injected_fault as fault,
               duration_ms as durationMs, created_at as createdAt
          FROM fake_step_events WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 10
      `)
      .all(transaction.id);
    const asyncModes = new Set(["QR_DISPLAY", "PUSH_APPROVAL", "PAY_CODE", "DEEP_LINK", "REDIRECT", "EMBEDDED"]);

    response.json({
      activeAttemptSecrets: {
        ourReference: transaction.our_reference,
        providerReference: transaction.provider_reference,
        expectedOtp: transaction.expected_otp,
        collectionMode: transaction.collection_mode,
        boundAccountIdentifier: account?.identifier ?? transaction.customer_identifier_masked ?? null,
        boundAccountBalanceAfterHoldLyd: account?.available_balance_lyd ?? null,
        heldAmountLyd: hold?.amount_lyd ?? transaction.held_amount_lyd ?? null,
        canSimulateMobilePushOrQrApproval:
          asyncModes.has(transaction.collection_mode) && transaction.status !== "PAID",
        qrPayload: transaction.qr_payload ?? null,
        deepLinkUrl: transaction.deep_link_url ?? null,
        redirectUrl: transaction.redirect_url ?? null,
        expiresAt: transaction.updated_at ?? null,
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
    const basePayload = {
      reference: transaction.our_reference,
      our_reference: transaction.our_reference,
      provider_reference: transaction.provider_reference,
      transaction_id: transaction.provider_reference,
      amount: transaction.normalized_amount_lyd,
      currency: transaction.currency,
    };

    if (action === "APPROVE_PUSH_OR_QR" || action === "FIRE_WEBHOOK_NOW") {
      captureAccountHoldForTransaction(transaction.id);
      updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: transaction.normalized_amount_lyd });
      webhookDispatcher.dispatch({
        transaction: { ...transaction, status: "PAID" },
        event: "payment.paid",
        payload: { ...basePayload, status: "PAID" },
      });
    } else if (action === "APPROVE_WITH_VARIANCE") {
      const varianceSettled = (Number(transaction.normalized_amount_lyd) + 0.05).toFixed(4);
      captureAccountHoldForTransaction(transaction.id, varianceSettled);
      updateTransaction(transaction.id, { status: "PAID", settled_amount_lyd: varianceSettled });
      webhookDispatcher.dispatch({
        transaction: { ...transaction, status: "PAID", settled_amount_lyd: varianceSettled },
        event: "payment.paid",
        payload: { ...basePayload, amount: varianceSettled, settled_amount: varianceSettled, status: "PAID" },
      });
    } else if (action === "DECLINE_PUSH_OR_QR") {
      releaseAccountHoldForTransaction(transaction.id, "Customer rejected push/QR on the simulated mobile app");
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

    response.json({ ok: true, action, transactionId: transaction.id });
  });

  router.get("/clearing/pools", (_request, response) => {
    response.json({ pools: listClearingPools() });
  });

  router.post("/clearing/generate-statement", (request, response) => {
    const from = typeof request.body?.from === "string" ? request.body.from : undefined;
    const to = typeof request.body?.to === "string" ? request.body.to : undefined;
    const gatewayCode = typeof request.body?.gatewayCode === "string" ? request.body.gatewayCode : undefined;
    const merchantId = typeof request.body?.merchantId === "string" ? request.body.merchantId : undefined;
    const includeSettled = request.body?.includeSettled === true;
    const includeIncluded = request.body?.includeIncluded === true;
    response.json(generateClearingStatement({ from, to, gatewayCode, merchantId, includeSettled, includeIncluded }));
  });

  router.post("/clearing/mark-included", (request, response) => {
    const entryIds = Array.isArray(request.body?.entryIds) ? request.body.entryIds.map(String) : [];
    const runId = typeof request.body?.runId === "string" ? request.body.runId : "";
    if (!runId) {
      response.status(400).json({ code: "RUN_ID_REQUIRED", message: "runId is required" });
      return;
    }
    response.json({ ok: true, updated: markStatementIncluded({ entryIds, runId }) });
  });

  router.post("/clearing/settle", (request, response) => {
    const gatewayCode = typeof request.body?.gatewayCode === "string" ? request.body.gatewayCode : undefined;
    response.json({ ok: true, settled: markClearingSettled({ gatewayCode }) });
  });

  return router;
};
