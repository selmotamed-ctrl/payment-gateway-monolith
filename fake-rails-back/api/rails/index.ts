import { Router, type NextFunction, type Request, type Response } from "express";
import { resolveRail } from "../../engine/chaos/DefaultRailScenarios";
import { getScenario } from "../../engine/chaos/scenarioStore";
import { ApiError } from "../../lib/error";
import {
  applyFault,
  applyLatency,
  asRecord,
  evaluateFor,
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
          recordRailEvent(context, business, startedAt);
          send(response, business);
          return;
        }
      }

      const result = await route.handler(context);
      recordRailEvent(context, result, startedAt);
      send(response, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
