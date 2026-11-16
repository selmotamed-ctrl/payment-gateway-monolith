import { Router, type NextFunction, type Request, type Response } from "express";
import { resolveRail } from "../../engine/chaos/DefaultRailScenarios";
import { updateTransaction } from "../../engine/db";
import { getScenario } from "../../engine/chaos/scenarioStore";
import { ApiError } from "../../lib/error";
import {
  captureAccountHoldForTransaction,
  refundAccountForTransaction,
  releaseAccountHoldForTransaction,
  reserveAccountFundsForTransaction,
} from "../../engine/accounts/AccountLedgerService";
import {
  applyFault,
  applyLatency,
  asRecord,
  evaluateFor,
  extractCustomer,
  finalizeFault,
  recordRailEvent,
  resolveOrCreateTransaction,
  type RailRequestContext,
  type RailResponse,
} from "./common";
import { otpPullRoutes } from "./otpPullRouter";
import { embeddedRoutes } from "./embeddedRouter";
import { qrAndPushRoutes } from "./qrAndPushRouter";
import { redirectRoutes } from "./redirectRouter";
import { internalNeomPayRoutes } from "./internalNeomPayRouter";
import { statementRoutes } from "./statementRouter";
import type { RailRouteDefinition } from "./types";

export const RAIL_ROUTES: RailRouteDefinition[] = [
  ...otpPullRoutes,
  ...embeddedRoutes,
  ...qrAndPushRoutes,
  ...redirectRoutes,
  ...internalNeomPayRoutes,
  ...statementRoutes,
];

const segmentMatches = (pattern: string, actual: string): boolean => {
  const patternParts = pattern.split("/").filter(Boolean);
  const actualParts = actual.split("/").filter(Boolean);
  if (patternParts.length !== actualParts.length) return false;
  return patternParts.every((part, index) =>
    part.startsWith(":") || part === actualParts[index] || part === "*",
  );
};

export const matchRailRoute = (
  gatewayCode: string,
  method: string,
  path: string,
): RailRouteDefinition | undefined =>
  RAIL_ROUTES.find(
    (route) =>
      route.gatewayCodes.includes(gatewayCode)
      && route.method === method
      && segmentMatches(route.path, path),
  );

const ACTION_CODE: Record<string, string> = {
  ACCOUNT_FROZEN: "62",
  ACCOUNT_EXPIRED: "54",
  ACCOUNT_BLOCKED: "62",
  INSUFFICIENT_FUNDS: "51",
  LIMIT_EXCEEDED: "61",
};

const accountDecline = (
  context: RailRequestContext,
  code: string,
  message: string,
): RailResponse => ({
  status: 200,
  body: {
    reference: context.reference,
    our_reference: context.transaction.our_reference,
    provider_reference: context.transaction.provider_reference,
    transaction_id: context.transaction.provider_reference,
    amount: context.transaction.normalized_amount_lyd,
    currency: context.transaction.currency,
    status: "FAILED",
    success: false,
    error: code,
    error_code: code,
    message,
    ActionCode: ACTION_CODE[code] ?? "05",
  },
});

/**
 * Applies the stateful account outcome of a rail answer. The hold is placed at
 * INITIATE, captured when the switch answers PAID, released on a decline or a
 * cancel, and credited back on a refund.
 */
const applyAccountOutcome = (
  context: RailRequestContext,
  body: Record<string, unknown>,
): void => {
  const status = typeof body.status === "string" ? body.status.toUpperCase() : "";
  if (status === "PAID" || status === "SUCCEEDED") {
    captureAccountHoldForTransaction(context.transaction.id);
    return;
  }
  if (status === "REFUNDED") {
    try {
      refundAccountForTransaction(
        context.transaction.id,
        undefined,
        "Refund returned to the test customer account",
      );
    } catch {
      // An over-refund is rejected by the handler before this point; a
      // transaction without a capture has nothing to credit.
    }
    return;
  }
  if (status === "FAILED" || status === "CANCELLED") {
    releaseAccountHoldForTransaction(context.transaction.id, `Rail answered ${status}`);
  }
};

const send = (response: Response, result: RailResponse): void => {
  response.status(result.status ?? 200);
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(key, value);
  }
  if (result.contentType) {
    response.type(result.contentType);
    response.send(String(result.body));
    return;
  }
  response.json(result.body);
};

/**
 * The gateway protocol dispatcher.
 *
 * One router serves all twenty emulated switches: the wire shape and the
 * endpoint are selected by the gateway code in the URL, while the shared
 * transaction/chaos/webhook machinery stays identical.
 */
export const createRailsRouter = (): Router => {
  const router = Router({ mergeParams: true });

  router.use(async (request: Request, response: Response, next: NextFunction) => {
    const startedAt = Date.now();
    try {
      const rawCode = String((request.params as Record<string, string>).gatewayCode ?? "");
      const descriptor = resolveRail(rawCode);
      if (!descriptor) {
        throw new ApiError(404, "UNKNOWN_GATEWAY", `No emulated gateway '${rawCode}'`);
      }
      const relativePath = request.path || "/";
      const route = matchRailRoute(descriptor.gatewayCode, request.method, relativePath)
        ?? matchRailRoute(descriptor.gatewayCode, request.method, relativePath.replace(/\/$/, ""));
      if (!route) {
        throw new ApiError(
          404,
          "UNKNOWN_RAIL_ENDPOINT",
          `No emulated endpoint ${request.method} ${relativePath} for gateway '${descriptor.gatewayCode}'`,
        );
      }

      const body = asRecord(request.body);
      const scenario = getScenario(descriptor.railCode);
      const { transaction } = resolveOrCreateTransaction({
        descriptor,
        request,
        body,
        phase: route.phase,
        scenario,
        mode: descriptor.collectionModes[0],
      });

      const context: RailRequestContext = {
        request,
        response,
        descriptor,
        scenario,
        transaction,
        phase: route.phase,
        body,
        reference: transaction.our_reference,
        amountWire: transaction.requested_amount_wire,
        amountLyd: transaction.normalized_amount_lyd,
        currency: transaction.currency,
        customer: transaction.customer_identifier_masked,
        mode: transaction.collection_mode,
        fault: null,
      };
      context.fault = evaluateFor({
        request,
        scenario,
        phase: route.phase,
        transaction,
      });

      // Stateful account reservation: INITIATE checks the customer account
      // (status, balance, daily limit) and holds the amount atomically.
      if (route.phase === "INITIATE" && !context.transaction.account_id) {
        const hold = reserveAccountFundsForTransaction({
          railCode: descriptor.railCode,
          gatewayCode: descriptor.gatewayCode,
          identifier: extractCustomer(context.body) ?? context.customer,
          transactionId: context.transaction.id,
          amountLyd: context.transaction.normalized_amount_lyd,
          merchantId: context.transaction.merchant_id ?? context.request.header("x-pg-merchant-id") ?? null,
        });
        if (!hold.allowed) {
          updateTransaction(context.transaction.id, { status: "FAILED" });
          const declined = accountDecline(
            context,
            hold.declineCode ?? "INSUFFICIENT_FUNDS",
            hold.declineMessage ?? "Declined by the test customer account",
          );
          recordRailEvent(context, declined, startedAt);
          send(response, declined);
          return;
        }
        if (hold.account.static_otp) {
          updateTransaction(context.transaction.id, { expected_otp: hold.account.static_otp });
          context.transaction.expected_otp = hold.account.static_otp;
        }
      }

      await applyLatency(context);

      const hardFault = await applyFault(context);
      if (hardFault) {
        if (hardFault.status === 499) return;
        recordRailEvent(context, hardFault, startedAt);
        send(response, hardFault);
        return;
      }
      if (context.fault) {
        const business = finalizeFault(context, context.fault);
        if (business) {
          applyAccountOutcome(context, asRecord(business.body));
          recordRailEvent(context, business, startedAt);
          send(response, business);
          return;
        }
      }

      const result = await route.handler(context);
      applyAccountOutcome(context, asRecord(result.body));
      recordRailEvent(context, result, startedAt);
      send(response, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
