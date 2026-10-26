import { createHash } from "node:crypto";
import { ApiError } from "../../lib/error";
import { moneyFromDecimal, moneyToString, type Money } from "../db/money";
import type { PrismaLike, Repositories, Tx } from "../db/ports";

export type StatementFormat = "CSV" | "XLSX" | "JSON";
export type StatementRowType = "SETTLEMENT" | "CHARGEBACK" | "FEE" | "REVERSAL" | "UNKNOWN";

export interface StatementColumnMap {
  ourReference?: string;
  providerReference?: string;
  batchReference?: string;
  amount?: string;
  fee?: string;
  currency?: string;
  occurredAt?: string;
  type?: string;
}

export interface StatementParserConfig {
  format: StatementFormat;
  encoding?: BufferEncoding;
  delimiter?: string;
  headerRow?: boolean;
  columnsMap: StatementColumnMap;
  dateFormat?: string;
  timezone?: string;
  supportsBatchNet?: boolean;
}

export interface StatementRow {
  ourReference: string | null;
  providerReference: string | null;
  batchReference: string | null;
  amount: Money;
  fee: Money;
  currency: string;
  occurredAt: Date | null;
  type: StatementRowType;
  raw: Record<string, unknown>;
}

export type ReconciliationResult =
  | "MATCHED"
  | "AMOUNT_MISMATCH"
  | "MISSING_AT_GATEWAY"
  | "MISSING_LOCALLY"
  | "DUPLICATE";

export interface XlsxParser {
  parse(content: Buffer): Promise<Record<string, unknown>[]>;
}

export interface FeeVariancePosting {
  gatewayId: string;
  statementSourceId: string;
  attemptId: string | null;
  statementFee: Money;
  accruedFee: Money;
  variance: Money;
  occurredAt: Date | null;
}

export interface FeeVariancePoster {
  postFeeVariance(posting: FeeVariancePosting): Promise<{ journalEntryId: string | null }>;
}

export interface StatementIngestorDeps {
  db: PrismaLike;
  repositories: Repositories;
  feeVariancePoster?: FeeVariancePoster;
  xlsxParser?: XlsxParser;
  clock?: () => Date;
}

export interface IngestRequest {
  statementSourceId: string;
  content: Buffer | Uint8Array | string;
  fileName?: string;
  windowStart?: Date;
  windowEnd?: Date;
}

export interface IngestResult {
  runId: string;
  fileHash: string;
  idempotent: boolean;
  totalRows: number;
  matched: number;
  amountMismatch: number;
  missingAtGateway: number;
  missingLocally: number;
  duplicates: number;
  feeVariances: number;
  items: { id: string; result: ReconciliationResult; ourReference: string | null; providerReference: string | null }[];
}

export const parseCsvRows = (input: string, delimiter = ","): string[][] => {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  while (index < input.length) {
    const char = input[index] ?? "";
    if (inQuotes) {
      if (char === '"') {
        const next = input[index + 1];
        if (next === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      current.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows.filter((row) => row.some((cell) => cell.trim().length > 0));
};

export const parseStatementDate = (value: string, dateFormat?: string): Date | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!dateFormat) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const pattern = dateFormat.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => `(?<${token}>\\d{2,4})`);
  const match = new RegExp(`^${pattern}$`).exec(trimmed);
  const groups = match?.groups;
  if (!groups) {
    return null;
  }
  const read = (token: string, fallback: number): number => {
    const raw = groups[token];
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const date = new Date(
    Date.UTC(
      read("YYYY", 1970),
      read("MM", 1) - 1,
      read("DD", 1),
      read("HH", 0),
      read("mm", 0),
      read("ss", 0),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
};

const detectRowType = (raw: string | undefined): StatementRowType => {
  const value = (raw ?? "").trim().toUpperCase();
  if (value.includes("CHARGEBACK") || value.includes("CHARGE_BACK") || value.includes("DEBIT")) {
    return "CHARGEBACK";
  }
  if (value.includes("REVERSAL") || value.includes("REFUND")) {
    return "REVERSAL";
  }
  if (value.includes("FEE")) {
    return "FEE";
  }
  if (value.includes("SETTLE") || value.includes("PAYMENT") || value.includes("CREDIT")) {
    return "SETTLEMENT";
  }
  return "UNKNOWN";
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const cell = (record: Record<string, unknown>, key: string | undefined): string => {
  if (!key) {
    return "";
  }
  const value = record[key];
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
};

const COLUMN_MAP_KEYS: readonly (keyof StatementColumnMap)[] = [
  "ourReference",
  "providerReference",
  "batchReference",
  "amount",
  "fee",
  "currency",
  "occurredAt",
  "type",
];

const COLUMN_MAP_ALIASES: Record<keyof StatementColumnMap, readonly string[]> = {
  ourReference: ["ourReference", "our_reference"],
  providerReference: ["providerReference", "provider_reference"],
  batchReference: ["batchReference", "batch_reference"],
  amount: ["amount"],
  fee: ["fee"],
  currency: ["currency"],
  occurredAt: ["occurredAt", "occurred_at"],
  type: ["type"],
};

const normalizeColumnMap = (raw: Record<string, unknown>): StatementColumnMap => {
  const output: Record<string, unknown> = {};
  for (const key of COLUMN_MAP_KEYS) {
    for (const alias of COLUMN_MAP_ALIASES[key]) {
      const value = raw[alias];
      if (typeof value === "string" && value.length > 0) {
        output[key] = value;
        break;
      }
    }
  }
  return output as StatementColumnMap;
};

export class StatementIngestor {
  private readonly db: PrismaLike;
  private readonly repositories: Repositories;
  private readonly feeVariancePoster: FeeVariancePoster | undefined;
  private readonly xlsxParser: XlsxParser | undefined;
  private readonly clock: () => Date;

  constructor(deps: StatementIngestorDeps) {
    this.db = deps.db;
    this.repositories = deps.repositories;
    this.feeVariancePoster = deps.feeVariancePoster;
    this.xlsxParser = deps.xlsxParser;
    this.clock = deps.clock ?? (() => new Date());
  }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const source = await this.repositories.reconciliation.findStatementSourceById(
      this.db as Tx,
      request.statementSourceId,
    );
    if (!source) {
      throw new ApiError(404, "STATEMENT_SOURCE_NOT_FOUND", "Statement source not found");
    }
    const content = this.toBuffer(request.content);
    const fileHash = createHash("sha256").update(content).digest("hex");
    const existing = await this.repositories.reconciliation.findRunByFileHash(this.db as Tx, fileHash);
    if (existing) {
      return this.resultFromExistingRun(existing.id, fileHash);
    }

    const config = this.parseConfig(source.parserConfig);
    const rows = await this.parseRows(config, content);
    const normalized = rows.map((row) => this.normalizeRow(row, config));
    const now = this.clock();
    const windowStart = request.windowStart ?? new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const windowEnd = request.windowEnd ?? now;

    return this.db.$transaction(async (tx: Tx) => {
      const duplicateRun = await this.repositories.reconciliation.findRunByFileHash(tx, fileHash);
      if (duplicateRun) {
        return this.resultFromExistingRun(duplicateRun.id, fileHash);
      }
      const run = await this.repositories.reconciliation.createRun(tx, {
        statementSourceId: source.id,
        windowStart: windowStart,
        windowEnd: windowEnd,
        fileHash: fileHash,
        statsJson: { totalRows: normalized.length },
      });

      const seen = new Set<string>();
      const items: IngestResult["items"] = [];
      let matched = 0;
      let amountMismatch = 0;
      let missingAtGateway = 0;
      let missingLocally = 0;
      let duplicates = 0;
      let feeVariances = 0;

      for (const row of normalized) {
        const dedupeKey = row.ourReference
          ?? row.providerReference
          ?? row.batchReference
          ?? `${row.amount.toString()}|${row.occurredAt?.toISOString() ?? ""}`;
        if (seen.has(dedupeKey)) {
          duplicates += 1;
          const item = await this.repositories.reconciliation.createItem(tx, {
            runId: run.id,
            attemptId: null,
            ourReference: row.ourReference ?? "",
            providerReference: row.providerReference ?? "",
            batchReference: row.batchReference,
            statementAmount: moneyToString(row.amount),
            statementFee: moneyToString(row.fee),
            result: "DUPLICATE",
          });
          items.push({
            id: item.id,
            result: "DUPLICATE",
            ourReference: row.ourReference,
            providerReference: row.providerReference,
          });
          continue;
        }
        seen.add(dedupeKey);

        const attempt = await this.resolveAttempt(tx, row);
        if (!attempt) {
          missingAtGateway += 1;
          const item = await this.repositories.reconciliation.createItem(tx, {
            runId: run.id,
            attemptId: null,
            ourReference: row.ourReference ?? "",
            providerReference: row.providerReference ?? "",
            batchReference: row.batchReference,
            statementAmount: moneyToString(row.amount),
            statementFee: moneyToString(row.fee),
            result: "MISSING_AT_GATEWAY",
          });
          items.push({
            id: item.id,
            result: "MISSING_AT_GATEWAY",
            ourReference: row.ourReference,
            providerReference: row.providerReference,
          });
          continue;
        }

        const expected = attempt.settledAmount ?? attempt.totalChargedAmount ?? attempt.requestedAmount ?? 0;
        const expectedAmount = moneyFromDecimal(expected);
        const amountMatches = expectedAmount === row.amount;
        const result: ReconciliationResult = amountMatches ? "MATCHED" : "AMOUNT_MISMATCH";
        const item = await this.repositories.reconciliation.createItem(tx, {
          runId: run.id,
          attemptId: attempt.id,
          ourReference: row.ourReference ?? attempt.reference,
          providerReference: row.providerReference ?? attempt.providerReference ?? "",
          batchReference: row.batchReference,
          statementAmount: moneyToString(row.amount),
          statementFee: moneyToString(row.fee),
          result,
        });
        items.push({
          id: item.id,
          result,
          ourReference: row.ourReference ?? attempt.reference,
          providerReference: row.providerReference ?? attempt.providerReference,
        });
        if (amountMatches) {
          matched += 1;
        } else {
          amountMismatch += 1;
        }

        const accruedFee = attempt.gatewayFeeAmount === null || attempt.gatewayFeeAmount === undefined
          ? 0n
          : moneyFromDecimal(attempt.gatewayFeeAmount);
        const variance = row.fee - accruedFee;
        if (variance !== 0n && this.feeVariancePoster) {
          await this.feeVariancePoster.postFeeVariance({
            gatewayId: source.gatewayId,
            statementSourceId: source.id,
            attemptId: attempt.id,
            statementFee: row.fee,
            accruedFee,
            variance,
            occurredAt: row.occurredAt,
          });
          feeVariances += 1;
        }
      }

      const unmatched = await this.findUnmatchedLocalAttempts(tx, source.id, windowStart, windowEnd, seen);
      for (const attempt of unmatched) {
        missingLocally += 1;
        const item = await this.repositories.reconciliation.createItem(tx, {
          runId: run.id,
          attemptId: attempt.id,
          ourReference: attempt.reference,
          providerReference: attempt.providerReference ?? "",
          batchReference: null,
          statementAmount: moneyToString(0n),
          statementFee: moneyToString(0n),
          result: "MISSING_LOCALLY",
        });
        items.push({
          id: item.id,
          result: "MISSING_LOCALLY",
          ourReference: attempt.reference,
          providerReference: attempt.providerReference,
        });
      }

      const stats = {
        totalRows: normalized.length,
        matched,
        amountMismatch,
        missingAtGateway,
        missingLocally,
        duplicates,
        feeVariances,
      };
      await this.repositories.reconciliation.updateRunStats(tx, run.id, stats);
      return {
        runId: run.id,
        fileHash,
        idempotent: false,
        totalRows: normalized.length,
        matched,
        amountMismatch,
        missingAtGateway,
        missingLocally,
        duplicates,
        feeVariances,
        items,
      };
    }) as Promise<IngestResult>;
  }

  private async resultFromExistingRun(runId: string, fileHash: string): Promise<IngestResult> {
    const run = await this.repositories.reconciliation.findRunByFileHash(this.db as Tx, fileHash);
    const items = await this.repositories.reconciliation.listItemsByRun(this.db as Tx, runId);
    const stats = asRecord(run?.statsJson);
    return {
      runId,
      fileHash,
      idempotent: true,
      totalRows: Number(stats.totalRows ?? items.length),
      matched: Number(stats.matched ?? 0),
      amountMismatch: Number(stats.amountMismatch ?? 0),
      missingAtGateway: Number(stats.missingAtGateway ?? 0),
      missingLocally: Number(stats.missingLocally ?? 0),
      duplicates: Number(stats.duplicates ?? 0),
      feeVariances: Number(stats.feeVariances ?? 0),
      items: items.map((item) => ({
        id: item.id,
        result: item.result,
        ourReference: item.ourReference,
        providerReference: item.providerReference,
      })),
    };
  }

  private toBuffer(content: Buffer | Uint8Array | string): Buffer {
    if (typeof content === "string") {
      return Buffer.from(content, "utf8");
    }
    if (Buffer.isBuffer(content)) {
      return content;
    }
    return Buffer.from(content);
  }

  private parseConfig(raw: unknown): StatementParserConfig {
    const config = asRecord(raw);
    const format = (typeof config.format === "string" ? config.format.toUpperCase() : "CSV") as StatementFormat;
    const columnsMap = normalizeColumnMap(asRecord(config.columnsMap ?? config.columns_map));
    const encoding = typeof config.encoding === "string" ? config.encoding : "utf8";
    const headerRow = config.headerRow ?? config.header_row;
    const dateFormat = config.dateFormat ?? config.date_format;
    const supportsBatchNet = config.supportsBatchNet ?? config.supports_batch_net;
    return {
      format,
      encoding: isBufferEncoding(encoding) ? encoding : "utf8",
      delimiter: typeof config.delimiter === "string" ? config.delimiter : ",",
      headerRow: headerRow === undefined ? true : Boolean(headerRow),
      columnsMap,
      dateFormat: typeof dateFormat === "string" ? dateFormat : undefined,
      timezone: typeof config.timezone === "string" ? config.timezone : "Africa/Tripoli",
      supportsBatchNet: Boolean(supportsBatchNet),
    };
  }

  private async parseRows(config: StatementParserConfig, content: Buffer): Promise<Record<string, unknown>[]> {
    switch (config.format) {
      case "CSV": {
        const text = content.toString(config.encoding ?? "utf8");
        const rows = parseCsvRows(text, config.delimiter ?? ",");
        if (rows.length === 0) {
          return [];
        }
        if (config.headerRow === false) {
          const headers = Object.keys(config.columnsMap);
          return rows.map((row) => {
            const record: Record<string, unknown> = {};
            headers.forEach((header, index) => {
              record[header] = row[index] ?? "";
            });
            return record;
          });
        }
        const header = rows[0] ?? [];
        return rows.slice(1).map((row) => {
          const record: Record<string, unknown> = {};
          header.forEach((column, index) => {
            record[column] = row[index] ?? "";
          });
          return record;
        });
      }
      case "JSON": {
        const text = content.toString(config.encoding ?? "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch (error) {
          throw new ApiError(400, "STATEMENT_PARSE_FAILED", "Statement file is not valid JSON", {
            reason: error instanceof Error ? error.message : "Invalid JSON",
          });
        }
        const list = Array.isArray(parsed)
          ? parsed
          : asRecord(parsed).records ?? asRecord(parsed).rows;
        if (!Array.isArray(list)) {
          throw new ApiError(400, "STATEMENT_PARSE_FAILED", "JSON statement must contain a records or rows array");
        }
        return list.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
      }
      case "XLSX": {
        if (!this.xlsxParser) {
          throw new ApiError(400, "XLSX_PARSER_UNAVAILABLE", "XLSX statement parsing requires a registered XLSX parser adapter");
        }
        return this.xlsxParser.parse(content);
      }
    }
  }

  private normalizeRow(raw: Record<string, unknown>, config: StatementParserConfig): StatementRow {
    const logicalValue = (logical: keyof StatementColumnMap): string => {
      const mapped = config.columnsMap[logical];
      if (mapped && Object.hasOwn(raw, mapped)) {
        return cell(raw, mapped);
      }
      return cell(raw, logical);
    };
    const amountText = logicalValue("amount");
    const feeText = logicalValue("fee");
    const amount = amountText ? moneyFromDecimal(amountText) : 0n;
    const fee = feeText ? moneyFromDecimal(feeText) : 0n;
    const occurredText = logicalValue("occurredAt");
    return {
      ourReference: logicalValue("ourReference") || null,
      providerReference: logicalValue("providerReference") || null,
      batchReference: logicalValue("batchReference") || null,
      amount,
      fee,
      currency: logicalValue("currency").toUpperCase() || "LYD",
      occurredAt: occurredText ? parseStatementDate(occurredText, config.dateFormat) : null,
      type: detectRowType(logicalValue("type")),
      raw,
    };
  }

  private async resolveAttempt(tx: Tx, row: StatementRow) {
    if (row.ourReference) {
      const byReference = await this.repositories.payments.findAttemptByReference(tx, row.ourReference);
      if (byReference) {
        return byReference;
      }
    }
    if (row.providerReference) {
      return this.repositories.payments.findAttemptByProviderReference(tx, row.providerReference);
    }
    return null;
  }

  private async findUnmatchedLocalAttempts(
    tx: Tx,
    gatewayId: string,
    windowStart: Date,
    windowEnd: Date,
    seen: Set<string>,
  ) {
    const attempts = await this.repositories.payments.listSettledAttemptsInWindow(tx, {
      gatewayId,
      since: windowStart,
      until: windowEnd,
    });
    return attempts.filter((attempt) => {
      const key = attempt.reference ?? attempt.providerReference;
      return key ? !seen.has(key) : false;
    });
  }
}

function isBufferEncoding(value: string): value is BufferEncoding {
  return ["ascii", "utf8", "utf-8", "utf16le", "ucs2", "base64", "base64url", "latin1", "binary", "hex"].includes(value);
}
