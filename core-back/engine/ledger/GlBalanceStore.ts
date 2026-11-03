import { Decimal } from "decimal.js";
import { ApiError } from "../../lib/error";
import type { DecimalInput, LedgerAccountType } from "./LedgerPoster";

export const GL_SHARD_COUNT = 32;
export const SHARD_COUNT = GL_SHARD_COUNT;

export type GlBalanceMode = "SYNC" | "SHARDED";

export interface GlBalanceStoreClient {
  glAccount?: any;
  glBalanceShard?: any;
  glPeriodTotal?: any;
  journalLine?: any;
  journalEntry?: any;
  $queryRawUnsafe?: (...args: any[]) => any;
  $executeRawUnsafe?: (...args: any[]) => any;
  $queryRaw?: any;
  $executeRaw?: any;
  $transaction?: any;
  [key: string]: any;
}

export interface GlBalanceDelta {
  glAccountId: string;
  delta: DecimalInput;
  accountType?: LedgerAccountType | string | null;
  balanceMode?: GlBalanceMode | string | null;
  balanceFloor?: DecimalInput | null;
  currentBalance?: DecimalInput | null;
  lineCount?: number | bigint;
  shardNo?: number;
}

export interface GlBalanceShardRecord {
  glAccountId: string;
  shardNo: number;
  balance: Decimal;
  lineCount: bigint;
}

export interface GlAccountBalance {
  accountId: string;
  accountType: LedgerAccountType | string;
  balanceMode: GlBalanceMode;
  balance: Decimal;
  currentBalance: Decimal;
  currency?: string | null;
  shards?: GlBalanceShardRecord[];
}

export interface GlPeriodTotalRecord {
  glAccountId: string;
  day: Date;
  debitTotal: Decimal;
  creditTotal: Decimal;
  lineCount: bigint;
}

export interface PeriodTotalOptions {
  day: Date | string;
  accountId?: string;
  accountIds?: readonly string[];
  overwrite?: boolean;
}

export interface ClosedPeriodAccountResult {
  accountId: string;
  expected: GlPeriodTotalRecord;
  actual: GlPeriodTotalRecord | null;
  matches: boolean;
}

export interface ClosedPeriodMismatch {
  accountId: string;
  field: "debitTotal" | "creditTotal" | "lineCount";
  expected: string;
  actual: string;
}

export interface ClosedPeriodVerification {
  ok: boolean;
  day: string;
  accounts: ClosedPeriodAccountResult[];
  mismatches: ClosedPeriodMismatch[];
  differences: ClosedPeriodMismatch[];
  expectedDrift: Decimal;
  actualDrift: Decimal;
  drift: Decimal;
}

export interface PostDeltasOptions {
  entryId?: string;
  shardCount?: number;
}

export interface AccountBalanceVerification {
  ok: boolean;
  accountId: string;
  storedBalance: Decimal;
  expectedBalance: Decimal;
  closedBalance: Decimal;
  openBalance: Decimal;
  drift: Decimal;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(value: string): number {
  const bytes = new TextEncoder().encode(value);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function shardNoForEntry(entryId: string, shardCount = GL_SHARD_COUNT): number {
  return crc32(entryId) % Math.max(1, shardCount);
}

export const shardForEntry = shardNoForEntry;

export function isSyncAccountType(accountType: string | null | undefined): boolean {
  return accountType === "MERCHANT_WALLET" || accountType === "COMMISSION_RECEIVABLE";
}

export function resolveBalanceMode(
  accountType: string | null | undefined,
  explicit?: string | null,
): GlBalanceMode {
  if (explicit === "SYNC" || explicit === "SHARDED") {
    return explicit;
  }
  return isSyncAccountType(accountType) ? "SYNC" : "SHARDED";
}

function toDecimal(value: unknown, fallback: DecimalInput = 0): Decimal {
  if (value === null || value === undefined) {
    return new Decimal(fallback.toString());
  }
  try {
    if (value instanceof Decimal) {
      return new Decimal(value.toString());
    }
    if (typeof value === "bigint") {
      return new Decimal(value.toString());
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? new Decimal(String(value)) : new Decimal(fallback.toString());
    }
    return new Decimal(String(value));
  } catch {
    return new Decimal(fallback.toString());
  }
}

function parseDecimal(value: unknown): Decimal | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    if (value instanceof Decimal) {
      return new Decimal(value.toString());
    }
    if (typeof value === "bigint") {
      return new Decimal(value.toString());
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? new Decimal(String(value)) : null;
    }
    return new Decimal(String(value));
  } catch {
    return null;
  }
}

function toBigInt(value: unknown, fallback = 0n): bigint {
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return BigInt(typeof value === "number" ? Math.trunc(value) : String(value));
  } catch {
    return fallback;
  }
}

function affectedRows(result: unknown): number {
  if (typeof result === "number") {
    return result;
  }
  if (typeof result === "bigint") {
    return Number(result);
  }
  if (result && typeof result === "object" && "count" in result) {
    const count = Number((result as { count?: unknown }).count);
    return Number.isFinite(count) ? count : 1;
  }
  return 1;
}

function field(row: any, camel: string, snake: string): unknown {
  if (!row) {
    return undefined;
  }
  const value = row[camel];
  return value === undefined ? row[snake] : value;
}

function isClientLike(value: unknown): value is GlBalanceStoreClient {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "$queryRawUnsafe" in value
    || "$executeRawUnsafe" in value
    || "glAccount" in value
    || "glBalanceShard" in value
    || "glPeriodTotal" in value
    || "journalLine" in value
    || "journalEntry" in value;
}

function normalizeShard(row: any, fallbackAccountId: string): GlBalanceShardRecord {
  return {
    glAccountId: String(field(row, "glAccountId", "gl_account_id") ?? fallbackAccountId),
    shardNo: Number(field(row, "shardNo", "shard_no") ?? 0),
    balance: toDecimal(field(row, "balance", "balance")),
    lineCount: toBigInt(field(row, "lineCount", "line_count")),
  };
}

function normalizePeriodTotal(row: any, fallbackDay: Date): GlPeriodTotalRecord {
  const dayValue = field(row, "day", "day");
  const parsed = dayValue instanceof Date ? dayValue : new Date(String(dayValue ?? fallbackDay.toISOString()));
  return {
    glAccountId: String(field(row, "glAccountId", "gl_account_id") ?? ""),
    day: Number.isNaN(parsed.getTime()) ? fallbackDay : parsed,
    debitTotal: toDecimal(field(row, "debitTotal", "debit_total")),
    creditTotal: toDecimal(field(row, "creditTotal", "credit_total")),
    lineCount: toBigInt(field(row, "lineCount", "line_count")),
  };
}

function startOfDay(value: Date | string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, "INVALID_PERIOD_DAY", `Invalid period day: ${String(value)}`);
  }
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function nextDay(day: Date): Date {
  return new Date(day.getTime() + 24 * 60 * 60 * 1000);
}

function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

function ceilingError(accountId: string): ApiError {
  return new ApiError(
    409,
    "INSUFFICIENT_BALANCE_OR_CEILING",
    `Posting to GL account '${accountId}' would breach its balance floor`,
  );
}

interface AggregatedDelta {
  glAccountId: string;
  delta: Decimal;
  lineCount: bigint;
  accountType?: string | null;
  balanceMode?: string | null;
  balanceFloor?: DecimalInput | null;
  currentBalance?: DecimalInput | null;
  shardNo?: number;
}

export class GlBalanceStore {
  private readonly defaultClient?: GlBalanceStoreClient;

  constructor(client?: GlBalanceStoreClient) {
    this.defaultClient = client;
  }

  async postDeltas(
    clientOrDeltas: GlBalanceStoreClient | readonly GlBalanceDelta[],
    deltasOrOptions?: readonly GlBalanceDelta[] | PostDeltasOptions,
    maybeOptions?: PostDeltasOptions,
  ): Promise<void> {
    const client = Array.isArray(clientOrDeltas)
      ? this.defaultClient
      : clientOrDeltas as GlBalanceStoreClient;
    const deltas = (Array.isArray(clientOrDeltas)
      ? clientOrDeltas
      : deltasOrOptions ?? []) as readonly GlBalanceDelta[];
    const rawOptions = Array.isArray(clientOrDeltas)
      ? deltasOrOptions ?? {}
      : maybeOptions ?? {};
    const options: PostDeltasOptions = typeof rawOptions === "string"
      ? { entryId: rawOptions }
      : rawOptions as PostDeltasOptions;

    if (deltas.length === 0) {
      return;
    }
    if (!client) {
      throw new ApiError(500, "GL_BALANCE_STORE_UNAVAILABLE", "No database client was supplied to the balance store");
    }

    const grouped = new Map<string, AggregatedDelta>();
    for (const delta of deltas) {
      const accountId = String(delta.glAccountId);
      const amount = toDecimal(delta.delta);
      const lineCount = delta.lineCount === undefined ? 1n : toBigInt(delta.lineCount, 1n);
      const existing = grouped.get(accountId);
      if (existing) {
        existing.delta = existing.delta.plus(amount);
        existing.lineCount += lineCount;
        if (existing.accountType === undefined && delta.accountType !== undefined) {
          existing.accountType = delta.accountType;
        }
        if (existing.balanceMode === undefined && delta.balanceMode !== undefined) {
          existing.balanceMode = delta.balanceMode;
        }
        if (existing.balanceFloor === undefined && delta.balanceFloor !== undefined) {
          existing.balanceFloor = delta.balanceFloor;
        }
        if (existing.currentBalance === undefined && delta.currentBalance !== undefined) {
          existing.currentBalance = delta.currentBalance;
        }
        if (existing.shardNo === undefined && delta.shardNo !== undefined) {
          existing.shardNo = delta.shardNo;
        }
      } else {
        grouped.set(accountId, {
          glAccountId: accountId,
          delta: amount,
          lineCount,
          accountType: delta.accountType,
          balanceMode: delta.balanceMode,
          balanceFloor: delta.balanceFloor,
          currentBalance: delta.currentBalance,
          shardNo: delta.shardNo,
        });
      }
    }

    const accounts = new Map<string, any>();
    for (const aggregate of grouped.values()) {
      if (aggregate.balanceMode === undefined || aggregate.balanceFloor === undefined) {
        const account = await this.loadAccount(client, aggregate.glAccountId);
        if (account) {
          accounts.set(aggregate.glAccountId, account);
        }
      }
    }

    const ordered = [...grouped.values()].sort((left, right) =>
      left.glAccountId < right.glAccountId ? -1 : left.glAccountId > right.glAccountId ? 1 : 0,
    );

    for (const aggregate of ordered) {
      const account = accounts.get(aggregate.glAccountId);
      const accountType = aggregate.accountType ?? (field(account, "accountType", "account_type") as string | null);
      const balanceMode = resolveBalanceMode(
        accountType,
        aggregate.balanceMode ?? (field(account, "balanceMode", "balance_mode") as string | null),
      );
      const balanceFloor = aggregate.balanceFloor === undefined
        ? (field(account, "balanceFloor", "balance_floor") as DecimalInput | null | undefined)
        : aggregate.balanceFloor;
      const currentBalance = aggregate.currentBalance === undefined
        ? (field(account, "currentBalance", "current_balance") as DecimalInput | null | undefined)
        : aggregate.currentBalance;

      if (balanceMode === "SYNC") {
        await this.applySyncDelta(
          client,
          aggregate.glAccountId,
          aggregate.delta,
          balanceFloor,
          currentBalance,
          options.entryId,
        );
      } else {
        const shardNo = aggregate.shardNo ?? (options.entryId ? shardNoForEntry(options.entryId, options.shardCount) : 0);
        await this.applyShardDelta(client, aggregate.glAccountId, shardNo, aggregate.delta, aggregate.lineCount);
      }
    }
  }

  async readBalance(
    clientOrAccount: GlBalanceStoreClient | string | any,
    accountOrId?: string | any,
  ): Promise<GlAccountBalance> {
    let client: GlBalanceStoreClient | undefined;
    let target: any;
    if (typeof clientOrAccount === "string") {
      client = this.defaultClient;
      target = clientOrAccount;
    } else if (isClientLike(clientOrAccount)) {
      client = clientOrAccount as GlBalanceStoreClient;
      target = accountOrId;
    } else {
      client = this.defaultClient;
      target = clientOrAccount;
    }
    if (!client) {
      throw new ApiError(500, "GL_BALANCE_STORE_UNAVAILABLE", "No database client was supplied to the balance store");
    }

    const account = typeof target === "string" ? await this.loadAccount(client, target) : target;
    const accountId = typeof target === "string"
      ? target
      : String(field(account, "id", "id") ?? target?.accountId ?? target?.id ?? "");
    const accountType = String(
      field(account, "accountType", "account_type") ?? target?.accountType ?? target?.account_type ?? "UNKNOWN",
    ) as LedgerAccountType | string;
    const balanceMode = resolveBalanceMode(
      accountType,
      (field(account, "balanceMode", "balance_mode") as string | null) ?? target?.balanceMode ?? null,
    );

    let balance: Decimal;
    let shards: GlBalanceShardRecord[] | undefined;
    if (balanceMode === "SYNC") {
      const raw = field(account, "currentBalance", "current_balance")
        ?? target?.currentBalance
        ?? target?.current_balance;
      const parsed = parseDecimal(raw);
      balance = parsed === null
        ? await this.sumLines(client, accountId)
        : parsed;
    } else {
      shards = await this.listShards(client, accountId);
      if (client.glBalanceShard || typeof client.$queryRawUnsafe === "function") {
        balance = shards.reduce((total, shard) => total.plus(shard.balance), new Decimal(0));
      } else {
        balance = await this.sumLines(client, accountId);
      }
    }

    return {
      accountId,
      accountType,
      balanceMode,
      balance,
      currentBalance: balance,
      currency: (field(account, "currency", "currency") ?? target?.currency ?? null) as string | null,
      shards,
    };
  }

  async getBalance(clientOrAccount: GlBalanceStoreClient | string | any, accountOrId?: string | any): Promise<Decimal> {
    const snapshot = await this.readBalance(clientOrAccount, accountOrId);
    return snapshot.balance;
  }

  async readBalances(
    clientOrIds?: GlBalanceStoreClient | readonly string[],
    idsMaybe?: readonly string[],
  ): Promise<GlAccountBalance[]> {
    let client: GlBalanceStoreClient | undefined;
    let ids: readonly string[] | undefined;
    if (Array.isArray(clientOrIds)) {
      client = this.defaultClient;
      ids = clientOrIds;
    } else if (isClientLike(clientOrIds)) {
      client = clientOrIds as GlBalanceStoreClient;
      ids = idsMaybe;
    } else {
      client = this.defaultClient;
      ids = idsMaybe;
    }
    if (!client) {
      throw new ApiError(500, "GL_BALANCE_STORE_UNAVAILABLE", "No database client was supplied to the balance store");
    }

    if (ids) {
      const accounts = await this.loadAccounts(client, ids);
      const byId = new Map(accounts.map((account) => [String(field(account, "id", "id")), account]));
      const balances: GlAccountBalance[] = [];
      for (const id of ids) {
        balances.push(await this.readBalance(client, byId.get(String(id)) ?? String(id)));
      }
      return balances;
    }

    const accounts = await this.loadAllAccounts(client);
    const balances: GlAccountBalance[] = [];
    for (const account of accounts) {
      balances.push(await this.readBalance(client, account));
    }
    return balances;
  }

  async getBalances(
    clientOrIds?: GlBalanceStoreClient | readonly string[],
    idsMaybe?: readonly string[],
  ): Promise<GlAccountBalance[]> {
    return this.readBalances(clientOrIds, idsMaybe);
  }

  async listShards(clientOrAccountId: GlBalanceStoreClient | string, accountIdMaybe?: string): Promise<GlBalanceShardRecord[]> {
    let client: GlBalanceStoreClient | undefined;
    let accountId: string;
    if (typeof clientOrAccountId === "string") {
      client = this.defaultClient;
      accountId = clientOrAccountId;
    } else {
      client = clientOrAccountId;
      accountId = String(accountIdMaybe ?? "");
    }
    if (!client) {
      throw new ApiError(500, "GL_BALANCE_STORE_UNAVAILABLE", "No database client was supplied to the balance store");
    }

    const delegate = client.glBalanceShard;
    let rows: any[] = [];
    if (delegate && typeof delegate.findMany === "function") {
      rows = await delegate.findMany({
        where: { glAccountId: accountId },
        orderBy: { shardNo: "asc" },
      }) ?? [];
    } else if (typeof client.$queryRawUnsafe === "function") {
      rows = await client.$queryRawUnsafe(
        "SELECT `gl_account_id`, `shard_no`, `balance`, `line_count` FROM `gl_balance_shards` WHERE `gl_account_id` = ? ORDER BY `shard_no` ASC",
        accountId,
      ) ?? [];
    }
    return Array.isArray(rows) ? rows.map((row) => normalizeShard(row, accountId)) : [];
  }

  async rebuildPeriodTotals(
    clientOrOptions: GlBalanceStoreClient | PeriodTotalOptions | Date | string,
    optionsMaybe?: PeriodTotalOptions,
    accountIdMaybe?: string,
  ): Promise<GlPeriodTotalRecord[]> {
    const client = clientOrOptions instanceof Date || typeof clientOrOptions === "string" || !isClientLike(clientOrOptions)
      ? this.defaultClient
      : clientOrOptions as GlBalanceStoreClient;
    const options = clientOrOptions instanceof Date || typeof clientOrOptions === "string"
      ? { day: clientOrOptions } as PeriodTotalOptions
      : !isClientLike(clientOrOptions)
        ? (clientOrOptions ?? {}) as PeriodTotalOptions
        : optionsMaybe instanceof Date || typeof optionsMaybe === "string"
          ? { day: optionsMaybe } as PeriodTotalOptions
          : (optionsMaybe ?? {}) as PeriodTotalOptions;
    if (!client) {
      throw new ApiError(500, "GL_BALANCE_STORE_UNAVAILABLE", "No database client was supplied to the balance store");
    }
    if (!options.day) {
      throw new ApiError(400, "PERIOD_DAY_REQUIRED", "A day is required to rebuild period totals");
    }
    const resolvedAccountId = accountIdMaybe ?? (typeof optionsMaybe === "string" ? optionsMaybe : undefined);
    if (resolvedAccountId && !options.accountId && !options.accountIds) {
      options.accountId = resolvedAccountId;
    }

    const day = startOfDay(options.day);
    const end = nextDay(day);
    const accountIds = options.accountIds ?? (options.accountId ? [options.accountId] : undefined);
    const expected = await this.computeDayTotals(client, day, end, accountIds);
    const records = [...expected.values()].sort((left, right) =>
      left.glAccountId < right.glAccountId ? -1 : left.glAccountId > right.glAccountId ? 1 : 0,
    );

    for (const record of records) {
      if (options.overwrite === false && await this.findPeriodTotal(client, record.glAccountId, day)) {
        continue;
      }
      await this.writePeriodTotal(client, record);
    }
    return records;
  }

  async verifyClosedPeriod(
    clientOrOptions: GlBalanceStoreClient | PeriodTotalOptions | Date | string,
    optionsMaybe?: PeriodTotalOptions,
    accountIdMaybe?: string,
  ): Promise<ClosedPeriodVerification> {
    const client = clientOrOptions instanceof Date || typeof clientOrOptions === "string" || !isClientLike(clientOrOptions)
      ? this.defaultClient
      : clientOrOptions as GlBalanceStoreClient;
    const options = clientOrOptions instanceof Date || typeof clientOrOptions === "string"
      ? { day: clientOrOptions } as PeriodTotalOptions
      : !isClientLike(clientOrOptions)
        ? (clientOrOptions ?? {}) as PeriodTotalOptions
        : optionsMaybe instanceof Date || typeof optionsMaybe === "string"
          ? { day: optionsMaybe } as PeriodTotalOptions
          : (optionsMaybe ?? {}) as PeriodTotalOptions;
    if (!client) {
      throw new ApiError(500, "GL_BALANCE_STORE_UNAVAILABLE", "No database client was supplied to the balance store");
    }
    if (!options.day) {
      throw new ApiError(400, "PERIOD_DAY_REQUIRED", "A day is required to verify a closed period");
    }
    const resolvedAccountId = accountIdMaybe ?? (typeof optionsMaybe === "string" ? optionsMaybe : undefined);
    if (resolvedAccountId && !options.accountId && !options.accountIds) {
      options.accountId = resolvedAccountId;
    }

    const day = startOfDay(options.day);
    const end = nextDay(day);
    const accountIds = options.accountIds ?? (options.accountId ? [options.accountId] : undefined);
    const expected = await this.computeDayTotals(client, day, end, accountIds);
    const actualRows = await this.loadPeriodTotals(client, day, accountIds);
    const actual = new Map(actualRows.map((row) => [row.glAccountId, row]));
    const accountKeys = [...new Set([...expected.keys(), ...actual.keys()])].sort();

    const accounts: ClosedPeriodAccountResult[] = [];
    const mismatches: ClosedPeriodMismatch[] = [];
    let expectedDrift = new Decimal(0);
    let actualDrift = new Decimal(0);

    for (const accountId of accountKeys) {
      const expectedRecord = expected.get(accountId) ?? {
        glAccountId: accountId,
        day,
        debitTotal: new Decimal(0),
        creditTotal: new Decimal(0),
        lineCount: 0n,
      };
      const actualRecord = actual.get(accountId) ?? null;
      const debitMatches = actualRecord !== null && actualRecord.debitTotal.equals(expectedRecord.debitTotal);
      const creditMatches = actualRecord !== null && actualRecord.creditTotal.equals(expectedRecord.creditTotal);
      const countMatches = actualRecord !== null && actualRecord.lineCount === expectedRecord.lineCount;
      const matches = debitMatches && creditMatches && countMatches;
      accounts.push({ accountId, expected: expectedRecord, actual: actualRecord, matches });

      expectedDrift = expectedDrift.plus(expectedRecord.debitTotal).minus(expectedRecord.creditTotal);
      if (actualRecord) {
        actualDrift = actualDrift.plus(actualRecord.debitTotal).minus(actualRecord.creditTotal);
      }

      if (!debitMatches) {
        mismatches.push({
          accountId,
          field: "debitTotal",
          expected: expectedRecord.debitTotal.toFixed(4),
          actual: actualRecord?.debitTotal.toFixed(4) ?? "MISSING",
        });
      }
      if (!creditMatches) {
        mismatches.push({
          accountId,
          field: "creditTotal",
          expected: expectedRecord.creditTotal.toFixed(4),
          actual: actualRecord?.creditTotal.toFixed(4) ?? "MISSING",
        });
      }
      if (!countMatches) {
        mismatches.push({
          accountId,
          field: "lineCount",
          expected: expectedRecord.lineCount.toString(),
          actual: actualRecord?.lineCount.toString() ?? "MISSING",
        });
      }
    }

    return {
      ok: mismatches.length === 0,
      day: dayKey(day),
      accounts,
      mismatches,
      differences: mismatches,
      expectedDrift,
      actualDrift,
      drift: actualDrift.minus(expectedDrift),
    };
  }

  async verifyPeriodTotals(
    clientOrOptions: GlBalanceStoreClient | PeriodTotalOptions | Date | string,
    optionsMaybe?: PeriodTotalOptions,
    accountIdMaybe?: string,
  ): Promise<ClosedPeriodVerification> {
    return this.verifyClosedPeriod(clientOrOptions, optionsMaybe, accountIdMaybe);
  }

  async verifyAccountBalance(
    clientOrAccountId: GlBalanceStoreClient | string,
    accountIdOrFirstOpenDay?: string | Date,
    firstOpenDayMaybe?: Date | string,
  ): Promise<AccountBalanceVerification> {
    let client: GlBalanceStoreClient | undefined;
    let accountId: string;
    let firstOpenDay: Date | string | undefined;
    if (typeof clientOrAccountId === "string") {
      client = this.defaultClient;
      accountId = clientOrAccountId;
      firstOpenDay = accountIdOrFirstOpenDay;
    } else {
      client = clientOrAccountId;
      accountId = String(accountIdOrFirstOpenDay ?? "");
      firstOpenDay = firstOpenDayMaybe;
    }
    if (!client) {
      throw new ApiError(500, "GL_BALANCE_STORE_UNAVAILABLE", "No database client was supplied to the balance store");
    }

    const snapshot = await this.readBalance(client, accountId);
    const closedStart = firstOpenDay === undefined ? undefined : startOfDay(firstOpenDay);
    const closedBalance = await this.sumClosedPeriodTotals(client, accountId, closedStart);
    const openBalance = closedStart === undefined
      ? new Decimal(0)
      : await this.sumLinesFrom(client, accountId, closedStart);
    const expectedBalance = closedBalance.plus(openBalance);
    return {
      ok: snapshot.balance.equals(expectedBalance),
      accountId,
      storedBalance: snapshot.balance,
      expectedBalance,
      closedBalance,
      openBalance,
      drift: snapshot.balance.minus(expectedBalance),
    };
  }

  private async applySyncDelta(
    client: GlBalanceStoreClient,
    accountId: string,
    delta: Decimal,
    floor: unknown,
    currentBalance: unknown,
    entryId?: string,
  ): Promise<void> {
    if (delta.isZero()) {
      return;
    }
    const floorValue = floor === null || floor === undefined ? null : toDecimal(floor);
    const deltaText = delta.toFixed(4);

    if (typeof client.$executeRawUnsafe === "function") {
      const result = await client.$executeRawUnsafe(
        "UPDATE `gl_accounts` SET `current_balance` = `current_balance` + ? WHERE `id` = ? AND (? >= 0 OR `balance_floor` IS NULL OR `current_balance` + ? >= `balance_floor`)",
        deltaText,
        accountId,
        deltaText,
        deltaText,
      );
      if (affectedRows(result) === 0) {
        throw ceilingError(accountId);
      }
      return;
    }

    const delegate = client.glAccount;
    if (delegate && typeof delegate.update === "function") {
      let base = currentBalance === null || currentBalance === undefined
        ? undefined
        : toDecimal(currentBalance);
      let effectiveFloor = floorValue;
      if (base === undefined) {
        const account = await this.loadAccount(client, accountId);
        const parsedCurrent = parseDecimal(field(account, "currentBalance", "current_balance"));
        base = parsedCurrent ?? (entryId ? await this.sumLinesExcludingEntry(client, accountId, entryId) : new Decimal(0));
        if (floor === undefined) {
          const loadedFloor = field(account, "balanceFloor", "balance_floor");
          effectiveFloor = loadedFloor === null || loadedFloor === undefined ? null : toDecimal(loadedFloor);
        }
      }
      const next = base.plus(delta);
      if (delta.lt(0) && effectiveFloor !== null && next.lt(effectiveFloor)) {
        throw ceilingError(accountId);
      }
      await delegate.update({
        where: { id: accountId },
        data: { currentBalance: next },
      });
      return;
    }

    if (delegate && typeof delegate.updateMany === "function") {
      const where: Record<string, unknown> = { id: accountId };
      const knownCurrent = currentBalance === null || currentBalance === undefined
        ? undefined
        : toDecimal(currentBalance);
      if (delta.lt(0) && floorValue !== null) {
        if (knownCurrent !== undefined && knownCurrent.plus(delta).lt(floorValue)) {
          throw ceilingError(accountId);
        }
        if (knownCurrent === undefined) {
          where.currentBalance = { gte: floorValue.minus(delta) };
        }
      }
      const result = await delegate.updateMany({
        where,
        data: { currentBalance: { increment: delta } },
      });
      if (affectedRows(result) === 0) {
        throw ceilingError(accountId);
      }
    }
  }

  private async applyShardDelta(
    client: GlBalanceStoreClient,
    accountId: string,
    shardNo: number,
    delta: Decimal,
    lineCount: bigint,
  ): Promise<void> {
    if (typeof client.$executeRawUnsafe === "function") {
      await client.$executeRawUnsafe(
        "INSERT INTO `gl_balance_shards` (`gl_account_id`, `shard_no`, `balance`, `line_count`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `balance` = `balance` + VALUES(`balance`), `line_count` = `line_count` + VALUES(`line_count`)",
        accountId,
        shardNo,
        delta.toFixed(4),
        lineCount.toString(),
      );
      return;
    }

    const delegate = client.glBalanceShard;
    const where = { glAccountId_shardNo: { glAccountId: accountId, shardNo } };
    if (delegate && typeof delegate.upsert === "function") {
      await delegate.upsert({
        where,
        create: {
          glAccountId: accountId,
          shardNo,
          balance: delta,
          lineCount,
        },
        update: {
          balance: { increment: delta },
          lineCount: { increment: lineCount },
        },
      });
      return;
    }
    if (delegate && typeof delegate.findUnique === "function" && typeof delegate.update === "function" && typeof delegate.create === "function") {
      const existing = await delegate.findUnique({ where });
      if (existing) {
        await delegate.update({
          where,
          data: { balance: { increment: delta }, lineCount: { increment: lineCount } },
        });
      } else {
        await delegate.create({
          data: { glAccountId: accountId, shardNo, balance: delta, lineCount },
        });
      }
    }
  }

  private async loadAccount(client: GlBalanceStoreClient, accountId: string): Promise<any | null> {
    const delegate = client.glAccount;
    if (delegate && typeof delegate.findUnique === "function") {
      const row = await delegate.findUnique({ where: { id: accountId } });
      if (row) {
        return row;
      }
    }
    if (delegate && typeof delegate.findFirst === "function") {
      const row = await delegate.findFirst({ where: { id: accountId } });
      if (row) {
        return row;
      }
    }
    if (typeof client.$queryRawUnsafe === "function") {
      const rows = await client.$queryRawUnsafe(
        "SELECT `id`, `account_type`, `balance_mode`, `currency`, `current_balance`, `balance_floor` FROM `gl_accounts` WHERE `id` = ? LIMIT 1",
        accountId,
      );
      if (Array.isArray(rows) && rows[0]) {
        return rows[0];
      }
    }
    return null;
  }

  private async loadAccounts(client: GlBalanceStoreClient, ids: readonly string[]): Promise<any[]> {
    if (ids.length === 0) {
      return [];
    }
    const delegate = client.glAccount;
    if (delegate && typeof delegate.findMany === "function") {
      const rows = await delegate.findMany({ where: { id: { in: [...ids] } } });
      if (Array.isArray(rows) && rows.length > 0) {
        return rows;
      }
    }
    if (typeof client.$queryRawUnsafe === "function") {
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await client.$queryRawUnsafe(
        `SELECT \`id\`, \`account_type\`, \`balance_mode\`, \`currency\`, \`current_balance\`, \`balance_floor\` FROM \`gl_accounts\` WHERE \`id\` IN (${placeholders})`,
        ...ids,
      );
      if (Array.isArray(rows)) {
        return rows;
      }
    }
    const accounts: any[] = [];
    for (const id of ids) {
      const account = await this.loadAccount(client, id);
      if (account) {
        accounts.push(account);
      }
    }
    return accounts;
  }

  private async loadAllAccounts(client: GlBalanceStoreClient): Promise<any[]> {
    const delegate = client.glAccount;
    if (delegate && typeof delegate.findMany === "function") {
      const rows = await delegate.findMany({
        select: {
          id: true,
          accountType: true,
          balanceMode: true,
          currency: true,
          currentBalance: true,
          balanceFloor: true,
        },
      });
      return Array.isArray(rows) ? rows : [];
    }
    if (typeof client.$queryRawUnsafe === "function") {
      const rows = await client.$queryRawUnsafe(
        "SELECT `id`, `account_type`, `balance_mode`, `currency`, `current_balance`, `balance_floor` FROM `gl_accounts`",
      );
      return Array.isArray(rows) ? rows : [];
    }
    return [];
  }

  private async sumLinesExcludingEntry(
    client: GlBalanceStoreClient,
    accountId: string,
    entryId: string,
  ): Promise<Decimal> {
    const delegate = client.journalLine;
    if (!delegate || typeof delegate.findMany !== "function") {
      return new Decimal(0);
    }
    const rows = await delegate.findMany({
      where: { glAccountId: accountId },
      select: { entryId: true, direction: true, amount: true },
    });
    let total = new Decimal(0);
    for (const row of Array.isArray(rows) ? rows : []) {
      const rowAccountId = field(row, "glAccountId", "gl_account_id");
      if (rowAccountId !== undefined && String(rowAccountId) !== accountId) {
        continue;
      }
      const rowEntryId = field(row, "entryId", "entry_id");
      if (rowEntryId !== undefined && String(rowEntryId) === entryId) {
        continue;
      }
      const amount = toDecimal(field(row, "amount", "amount"));
      total = field(row, "direction", "direction") === "DEBIT" ? total.plus(amount) : total.minus(amount);
    }
    return total;
  }

  private async sumLines(client: GlBalanceStoreClient, accountId: string): Promise<Decimal> {
    const delegate = client.journalLine;
    if (!delegate || typeof delegate.findMany !== "function") {
      return new Decimal(0);
    }
    const rows = await delegate.findMany({
      where: { glAccountId: accountId },
      select: { direction: true, amount: true },
    });
    let total = new Decimal(0);
    for (const row of Array.isArray(rows) ? rows : []) {
      const rowAccountId = field(row, "glAccountId", "gl_account_id");
      if (rowAccountId !== undefined && String(rowAccountId) !== accountId) {
        continue;
      }
      const amount = toDecimal(field(row, "amount", "amount"));
      total = field(row, "direction", "direction") === "DEBIT" ? total.plus(amount) : total.minus(amount);
    }
    return total;
  }

  private async computeDayTotals(
    client: GlBalanceStoreClient,
    day: Date,
    end: Date,
    accountIds?: readonly string[],
  ): Promise<Map<string, GlPeriodTotalRecord>> {
    const totals = new Map<string, GlPeriodTotalRecord>();

    if (typeof client.$queryRawUnsafe === "function") {
      const filter = accountIds && accountIds.length > 0
        ? ` AND \`gl_account_id\` IN (${accountIds.map(() => "?").join(", ")})`
        : "";
      const rows = await client.$queryRawUnsafe(
        `SELECT \`gl_account_id\`, SUM(CASE WHEN \`direction\` = 'DEBIT' THEN \`amount\` ELSE 0 END) AS \`debit_total\`, SUM(CASE WHEN \`direction\` = 'CREDIT' THEN \`amount\` ELSE 0 END) AS \`credit_total\`, COUNT(*) AS \`line_count\` FROM \`journal_lines\` WHERE \`created_at\` >= ? AND \`created_at\` < ?${filter} GROUP BY \`gl_account_id\``,
        day,
        end,
        ...(accountIds ?? []),
      );
      for (const row of Array.isArray(rows) ? rows : []) {
        const record = normalizePeriodTotal(row, day);
        totals.set(record.glAccountId, record);
      }
      return totals;
    }

    const delegate = client.journalLine;
    if (!delegate || typeof delegate.findMany !== "function") {
      return totals;
    }
    const where: Record<string, unknown> = { createdAt: { gte: day, lt: end } };
    if (accountIds && accountIds.length > 0) {
      where.glAccountId = { in: [...accountIds] };
    }
    const rows = await delegate.findMany({
      where,
      select: { glAccountId: true, direction: true, amount: true, createdAt: true },
    });
    for (const row of Array.isArray(rows) ? rows : []) {
      const createdAt = field(row, "createdAt", "created_at");
      if (createdAt !== undefined && createdAt !== null) {
        const timestamp = createdAt instanceof Date ? createdAt : new Date(String(createdAt));
        if (!Number.isNaN(timestamp.getTime()) && (timestamp.getTime() < day.getTime() || timestamp.getTime() >= end.getTime())) {
          continue;
        }
      }
      const accountId = String(field(row, "glAccountId", "gl_account_id") ?? "");
      const amount = toDecimal(field(row, "amount", "amount"));
      const current = totals.get(accountId) ?? {
        glAccountId: accountId,
        day,
        debitTotal: new Decimal(0),
        creditTotal: new Decimal(0),
        lineCount: 0n,
      };
      if (field(row, "direction", "direction") === "DEBIT") {
        current.debitTotal = current.debitTotal.plus(amount);
      } else {
        current.creditTotal = current.creditTotal.plus(amount);
      }
      current.lineCount += 1n;
      totals.set(accountId, current);
    }
    return totals;
  }

  private async sumClosedPeriodTotals(
    client: GlBalanceStoreClient,
    accountId: string,
    beforeDay?: Date,
  ): Promise<Decimal> {
    const delegate = client.glPeriodTotal;
    let rows: any[] = [];
    if (delegate && typeof delegate.findMany === "function") {
      const where: Record<string, unknown> = { glAccountId: accountId };
      if (beforeDay) {
        where.day = { lt: beforeDay };
      }
      rows = await delegate.findMany({ where }) ?? [];
    } else if (typeof client.$queryRawUnsafe === "function") {
      const filter = beforeDay ? " AND `day` < ?" : "";
      rows = await client.$queryRawUnsafe(
        `SELECT \`gl_account_id\`, \`day\`, \`debit_total\`, \`credit_total\`, \`line_count\` FROM \`gl_period_totals\` WHERE \`gl_account_id\` = ?${filter}`,
        accountId,
        ...(beforeDay ? [beforeDay] : []),
      ) ?? [];
    }
    let total = new Decimal(0);
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = normalizePeriodTotal(row, beforeDay ?? new Date(0));
      total = total.plus(record.debitTotal).minus(record.creditTotal);
    }
    return total;
  }

  private async sumLinesFrom(
    client: GlBalanceStoreClient,
    accountId: string,
    from: Date,
  ): Promise<Decimal> {
    if (typeof client.$queryRawUnsafe === "function") {
      const rows = await client.$queryRawUnsafe(
        "SELECT COALESCE(SUM(CASE WHEN `direction` = 'DEBIT' THEN `amount` ELSE -`amount` END), 0) AS `balance` FROM `journal_lines` WHERE `gl_account_id` = ? AND `created_at` >= ?",
        accountId,
        from,
      );
      const first = Array.isArray(rows) ? rows[0] : undefined;
      return toDecimal(field(first, "balance", "balance"));
    }
    const delegate = client.journalLine;
    if (!delegate || typeof delegate.findMany !== "function") {
      return new Decimal(0);
    }
    const rows = await delegate.findMany({
      where: { glAccountId: accountId, createdAt: { gte: from } },
      select: { direction: true, amount: true, createdAt: true },
    });
    let total = new Decimal(0);
    for (const row of Array.isArray(rows) ? rows : []) {
      const createdAt = field(row, "createdAt", "created_at");
      if (createdAt !== undefined && createdAt !== null) {
        const timestamp = createdAt instanceof Date ? createdAt : new Date(String(createdAt));
        if (!Number.isNaN(timestamp.getTime()) && timestamp.getTime() < from.getTime()) {
          continue;
        }
      }
      const amount = toDecimal(field(row, "amount", "amount"));
      total = field(row, "direction", "direction") === "DEBIT" ? total.plus(amount) : total.minus(amount);
    }
    return total;
  }

  private async loadPeriodTotals(
    client: GlBalanceStoreClient,
    day: Date,
    accountIds?: readonly string[],
  ): Promise<GlPeriodTotalRecord[]> {
    const delegate = client.glPeriodTotal;
    if (delegate && typeof delegate.findMany === "function") {
      const where: Record<string, unknown> = { day };
      if (accountIds && accountIds.length > 0) {
        where.glAccountId = { in: [...accountIds] };
      }
      const rows = await delegate.findMany({ where });
      return Array.isArray(rows) ? rows.map((row) => normalizePeriodTotal(row, day)) : [];
    }
    if (typeof client.$queryRawUnsafe === "function") {
      const filter = accountIds && accountIds.length > 0
        ? ` AND \`gl_account_id\` IN (${accountIds.map(() => "?").join(", ")})`
        : "";
      const rows = await client.$queryRawUnsafe(
        `SELECT \`gl_account_id\`, \`day\`, \`debit_total\`, \`credit_total\`, \`line_count\` FROM \`gl_period_totals\` WHERE \`day\` = ?${filter}`,
        day,
        ...(accountIds ?? []),
      );
      return Array.isArray(rows) ? rows.map((row) => normalizePeriodTotal(row, day)) : [];
    }
    return [];
  }

  private async findPeriodTotal(
    client: GlBalanceStoreClient,
    accountId: string,
    day: Date,
  ): Promise<GlPeriodTotalRecord | null> {
    const delegate = client.glPeriodTotal;
    if (delegate && typeof delegate.findUnique === "function") {
      const row = await delegate.findUnique({
        where: { glAccountId_day: { glAccountId: accountId, day } },
      });
      return row ? normalizePeriodTotal(row, day) : null;
    }
    const rows = await this.loadPeriodTotals(client, day, [accountId]);
    return rows[0] ?? null;
  }

  private async writePeriodTotal(client: GlBalanceStoreClient, record: GlPeriodTotalRecord): Promise<void> {
    const delegate = client.glPeriodTotal;
    if (delegate && typeof delegate.upsert === "function") {
      await delegate.upsert({
        where: { glAccountId_day: { glAccountId: record.glAccountId, day: record.day } },
        create: {
          glAccountId: record.glAccountId,
          day: record.day,
          debitTotal: record.debitTotal,
          creditTotal: record.creditTotal,
          lineCount: record.lineCount,
        },
        update: {
          debitTotal: record.debitTotal,
          creditTotal: record.creditTotal,
          lineCount: record.lineCount,
        },
      });
      return;
    }
    if (typeof client.$executeRawUnsafe === "function") {
      await client.$executeRawUnsafe(
        "INSERT INTO `gl_period_totals` (`gl_account_id`, `day`, `debit_total`, `credit_total`, `line_count`) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `debit_total` = VALUES(`debit_total`), `credit_total` = VALUES(`credit_total`), `line_count` = VALUES(`line_count`)",
        record.glAccountId,
        dayKey(record.day),
        record.debitTotal.toFixed(4),
        record.creditTotal.toFixed(4),
        record.lineCount.toString(),
      );
      return;
    }
    if (delegate && typeof delegate.create === "function") {
      const existing = await this.findPeriodTotal(client, record.glAccountId, record.day);
      if (existing && typeof delegate.update === "function") {
        await delegate.update({
          where: { glAccountId_day: { glAccountId: record.glAccountId, day: record.day } },
          data: {
            debitTotal: record.debitTotal,
            creditTotal: record.creditTotal,
            lineCount: record.lineCount,
          },
        });
      } else {
        await delegate.create({
          data: {
            glAccountId: record.glAccountId,
            day: record.day,
            debitTotal: record.debitTotal,
            creditTotal: record.creditTotal,
            lineCount: record.lineCount,
          },
        });
      }
      return;
    }
    if (delegate && typeof delegate.createMany === "function") {
      await delegate.createMany({
        data: [{
          glAccountId: record.glAccountId,
          day: record.day,
          debitTotal: record.debitTotal,
          creditTotal: record.creditTotal,
          lineCount: record.lineCount,
        }],
        skipDuplicates: true,
      });
    }
  }
}
