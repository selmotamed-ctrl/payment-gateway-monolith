import { getDb, nowIso } from "../../engine/db";
import { asyncConfirm, asyncInitiate, inquiry, refund } from "./handlers";
import type { RailHandler } from "./common";
import type { RailRouteDefinition } from "./types";

const ledgerExport: RailHandler = (context) => {
  const rows = getDb()
    .prepare(
      `SELECT provider_reference, our_reference, normalized_amount_lyd, settled_amount_lyd,
              gateway_fee_lyd, status, created_at
       FROM fake_transactions WHERE gateway_code = 'neompay'
       ORDER BY created_at DESC LIMIT 5000`,
    )
    .all() as Array<Record<string, string>>;
  return {
    status: 200,
    body: {
      gateway: "neompay",
      exported_at: nowIso(),
      currency: "LYD",
      entries: rows.map((row) => ({
        provider_reference: row.provider_reference,
        our_reference: row.our_reference,
        amount: row.normalized_amount_lyd,
        settled_amount: row.settled_amount_lyd,
        fee: row.gateway_fee_lyd,
        status: row.status,
        created_at: row.created_at,
      })),
      reference: context.reference,
    },
  };
};

/** NeomPay first-party wallet: reserve -> capture -> release + ledger export. */
export const internalNeomPayRoutes: RailRouteDefinition[] = [
  { gatewayCodes: ["neompay"], method: "POST", path: "/payments/requests", phase: "INITIATE", handler: asyncInitiate },
  { gatewayCodes: ["neompay"], method: "POST", path: "/payments/:id/confirm", phase: "SUBMIT", handler: asyncConfirm },
  { gatewayCodes: ["neompay"], method: "GET", path: "/payments/by-reference/:ref", phase: "VERIFY", handler: inquiry },
  { gatewayCodes: ["neompay"], method: "POST", path: "/payments/:id/refund", phase: "REFUND", handler: refund },
  { gatewayCodes: ["neompay"], method: "GET", path: "/ledger-export", phase: "VERIFY", handler: ledgerExport },
];
