import { listTransactions } from "../../engine/db";
import type { RailHandler } from "./common";
import type { RailRouteDefinition } from "./types";

const statement: RailHandler = (context) => {
  const query = context.request.query as Record<string, string | undefined>;
  const from = query.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const to = query.to ?? new Date().toISOString();
  const format = (query.format ?? "csv").toLowerCase();
  const { rows } = listTransactions({
    gatewayCode: context.descriptor.gatewayCode,
    from,
    to,
    limit: 1000,
  });
  const settled = rows.filter((row) => ["PAID", "SUCCEEDED", "REFUNDED"].includes(row.status));
  if (format === "json") {
    return {
      status: 200,
      body: {
        gateway: context.descriptor.gatewayCode,
        window_start: from,
        window_end: to,
        currency: "LYD",
        lines: settled.map((row) => ({
          provider_reference: row.provider_reference,
          our_reference: row.our_reference,
          amount: row.settled_amount_lyd ?? row.normalized_amount_lyd,
          fee: row.gateway_fee_lyd,
          currency: row.currency,
          status: row.status,
          settled_at: row.updated_at,
        })),
      },
    };
  }
  const header = "provider_reference,our_reference,amount,fee,currency,status,settled_at";
  const lines = settled.map((row) =>
    [
      row.provider_reference,
      row.our_reference,
      row.settled_amount_lyd ?? row.normalized_amount_lyd,
      row.gateway_fee_lyd,
      row.currency,
      row.status,
      row.updated_at,
    ].join(","),
  );
  return {
    status: 200,
    contentType: "text/csv",
    body: `${header}\n${lines.join("\n")}\n`,
  };
};

const STATEMENT_GATEWAYS = [
  "edfali", "sadad", "mobicash", "moamalat", "ly_pay", "onepay", "tlync", "mypay", "dpay",
  "plutu", "yussor", "sahara", "masrefy", "hawelli", "gpay_libya", "numo_pay", "libyana",
  "mpgs", "evopay", "neompay",
] as const;

/** Every gateway exposes a settlement statement endpoint. */
export const statementRoutes: RailRouteDefinition[] = STATEMENT_GATEWAYS.map((gatewayCode) => ({
  gatewayCodes: [gatewayCode],
  method: "GET" as const,
  path: "/statement",
  phase: "VERIFY" as const,
  handler: statement,
}));
