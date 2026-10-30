import { Router } from "express";
import { z } from "zod";
import { getDb, listTransactions, nowIso, uuidv7 } from "../../engine/db";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildXlsx } from "../../engine/statements/xlsx";
import { Prng } from "../../engine/chaos/prng";
import { broadcast } from "./eventHub";

const generateSchema = z.object({
  gatewayCode: z.string().trim().min(1).max(60),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  format: z.enum(["csv", "json", "xlsx"]).default("csv"),
  anomalies: z
    .object({
      feeVariancePercent: z.number().min(0).max(100).default(0),
      feeVarianceAmount: z.number().min(0).default(0.15),
      omitOne: z.boolean().default(false),
      addUnrecorded: z.boolean().default(false),
    })
    .default({ feeVariancePercent: 0, feeVarianceAmount: 0.15, omitOne: false, addUnrecorded: false }),
});

interface StatementLine {
  provider_reference: string;
  our_reference: string;
  amount: string;
  fee: string;
  currency: string;
  status: string;
  settled_at: string;
}

const toLines = (gatewayCode: string, from: string, to: string): StatementLine[] => {
  const { rows } = listTransactions({ gatewayCode, from, to, limit: 1000 });
  return rows
    .filter((row) => ["PAID", "SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(row.status))
    .map((row) => ({
      provider_reference: row.provider_reference,
      our_reference: row.our_reference,
      amount: row.settled_amount_lyd ?? row.normalized_amount_lyd,
      fee: row.gateway_fee_lyd,
      currency: row.currency,
      status: row.status,
      settled_at: row.updated_at,
    }));
};

const applyAnomalies = (
  lines: StatementLine[],
  anomalies: z.infer<typeof generateSchema>["anomalies"],
  seed: string,
): StatementLine[] => {
  let output = [...lines];
  if (anomalies.feeVariancePercent > 0) {
    const prng = new Prng(seed);
    output = output.map((line) =>
      prng.chance(anomalies.feeVariancePercent)
        ? { ...line, fee: (Number(line.fee) + anomalies.feeVarianceAmount).toFixed(4) }
        : line,
    );
  }
  if (anomalies.omitOne && output.length > 0) {
    output = output.slice(0, -1);
  }
  if (anomalies.addUnrecorded) {
    output.push({
      provider_reference: `FK-UNRECORDED-${Date.now()}`,
      our_reference: `UNRECORDED-${Date.now()}`,
      amount: "10.0000",
      fee: "0.0000",
      currency: "LYD",
      status: "PAID",
      settled_at: nowIso(),
    });
  }
  return output;
};

const toCsv = (lines: StatementLine[]): string => {
  const header = "provider_reference,our_reference,amount,fee,currency,status,settled_at";
  return `${header}\n${lines.map((line) => Object.values(line).join(",")).join("\n")}\n`;
};

export const createStatementsRouter = (): Router => {
  const router = Router();

  router.get("/", (_request, response) => {
    const rows = getDb()
      .prepare("SELECT * FROM fake_statements ORDER BY created_at DESC LIMIT 100")
      .all();
    response.json({ statements: rows });
  });

  router.post("/generate", (request, response) => {
    const body = parseOrThrow(generateSchema, request.body);
    const from = body.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const to = body.to ?? new Date().toISOString();
    if (new Date(from) > new Date(to)) {
      throw new ApiError(400, "INVALID_WINDOW", "from must be before to");
    }
    const base = toLines(body.gatewayCode, from, to);
    const lines = applyAnomalies(base, body.anomalies, `${body.gatewayCode}:${from}:${to}`);
    const id = uuidv7();
    getDb()
      .prepare(
        `INSERT INTO fake_statements (id, gateway_code, format, window_start, window_end, anomaly_json, row_count, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, body.gatewayCode, body.format, from, to, JSON.stringify(body.anomalies), lines.length, nowIso());
    broadcast("statement.generated", { id, gatewayCode: body.gatewayCode, format: body.format, rows: lines.length });

    if (body.format === "json") {
      response.json({ id, gatewayCode: body.gatewayCode, from, to, lines });
      return;
    }
    if (body.format === "xlsx") {
      const rows: Array<Array<string | number>> = [
        ["provider_reference", "our_reference", "amount", "fee", "currency", "status", "settled_at"],
        ...lines.map((line) => [
          line.provider_reference,
          line.our_reference,
          Number(line.amount),
          Number(line.fee),
          line.currency,
          line.status,
          line.settled_at,
        ]),
      ];
      const buffer = buildXlsx(`${body.gatewayCode} settlement`, rows);
      response
        .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .setHeader("content-disposition", `attachment; filename="${body.gatewayCode}-statement.xlsx"`)
        .send(buffer);
      return;
    }
    response
      .type("text/csv")
      .setHeader("content-disposition", `attachment; filename="${body.gatewayCode}-statement.csv"`)
      .send(toCsv(lines));
  });

  return router;
};
