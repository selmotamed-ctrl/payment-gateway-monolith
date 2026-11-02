import { randomBytes } from "node:crypto";
import { Decimal } from "decimal.js";
import { ApiError } from "../../lib/error";

export type LedgerAccountType =
  | "TREASURY"
  | "GATEWAY_CLEARING"
  | "MERCHANT_WALLET"
  | "PLATFORM_INCOME"
  | "PROVIDER_FEE_EXPENSE"
  | "GATEWAY_FEE_EXPENSE"
  | "GATEWAY_FEE_ACCRUAL"
  | "COMMISSION_RECEIVABLE"
  | "AML_HOLD"
  | "CHARGEBACK_RESERVE"
  | "SUSPENSE";

export type LedgerDirection = "DEBIT" | "CREDIT";
export type LedgerRefType =
  | "PAYMENT_ATTEMPT"
  | "ADJUSTMENT"
  | "AML_RELEASE"
  | "AML_VOID"
  | "SETTLEMENT_SWEEP"
  | "FEE_VARIANCE"
  | "COMMISSION_NETTING"
  | "DISPUTE_OUTCOME";

export interface DecimalLike {
  toString(): string;
}

export type DecimalInput = Decimal | DecimalLike | string | number | bigint;

export interface LedgerAccountRecord {
  id: string;
  accountType: LedgerAccountType;
  ownerId?: string | null;
  gatewayId?: string | null;
  credentialSetId?: string | null;
  env?: string | null;
  currency?: string | null;
  checkpointBalance?: DecimalInput;
  checkpointAt?: Date | null;
  lastCheckpointId?: string | null;
  currentBalance?: DecimalInput | null;
  linesSinceCheckpoint?: number | null;
}

export interface JournalEntryRecord {
  id: string;
  refType: LedgerRefType | string;
  refId: string;
  description?: string | null;
  created_at?: Date;
}

export interface JournalLineRecord {
  id: string;
  entryId: string;
  glAccountId: string;
  direction: LedgerDirection;
  amount: DecimalInput;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface LedgerPrismaClient {
  glAccount: {
    findFirst(args: { where: Record<string, unknown>; select?: Record<string, boolean> }): Promise<LedgerAccountRecord | null>;
    findUnique?(args: { where: { id: string } }): Promise<LedgerAccountRecord | null>;
    update?(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    updateMany?(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  };
  journalEntry: {
    findFirst(args: { where: Record<string, unknown> }): Promise<JournalEntryRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<JournalEntryRecord>;
  };
  journalLine: {
    create(args: { data: Record<string, unknown> }): Promise<JournalLineRecord>;
    createMany?(args: { data: Array<Record<string, unknown>> }): Promise<unknown>;
  };
  $transaction?<R>(callback: (transaction: LedgerPrismaClient) => Promise<R>): Promise<R>;
  $executeRaw?(query: TemplateStringsArray | unknown, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe?(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface LedgerTransactionRunner {
  <R>(callback: (transaction: LedgerPrismaClient) => Promise<R>): Promise<R>;
}

export interface LedgerAccountSelector {
  accountType: LedgerAccountType;
  accountId?: string;
  ownerId?: string;
  gatewayId?: string;
  credentialSetId?: string;
  env?: string;
  currency?: string;
}

export interface LedgerLineTemplate {
  direction: LedgerDirection;
  amount: DecimalInput;
  account: LedgerAccountSelector;
}

export interface JournalTemplate {
  refType: LedgerRefType | string;
  refId: string;
  description: string;
  lines: readonly LedgerLineTemplate[];
}

export interface LedgerPostContext {
  accounts?: Partial<Record<LedgerAccountType, string>>;
  merchantId?: string;
  gatewayId?: string;
  credentialSetId?: string;
  env?: string;
  currency?: string;
}

export interface LedgerPostResult {
  entry: JournalEntryRecord;
  lines: JournalLineRecord[];
  created: boolean;
  idempotent: boolean;
}

export type LedgerScenario =
  | "PLATFORM_HELD_CONFIRMATION"
  | "PLATFORM_HELD_FEE_ACCRUAL"
  | "SETTLEMENT_SWEEP"
  | "FEE_VARIANCE_TRUE_UP"
  | "PAYER_SURCHARGE_CONFIRMATION"
  | "SPLIT_SURCHARGE_CONFIRMATION"
  | "MERCHANT_DIRECT_CONFIRMATION"
  | "AML_HOLD_AND_RELEASE"
  | "CASHOUT"
  | "FULL_REFUND"
  | "CHARGEBACK_RESERVE_AND_LOST"
  | "AML_VOID"
  | "CHARGEBACK_WON"
  | "INTERNAL_CONFIRMATION"
  | "INTERNAL_REFUND"
  | "CHARGEBACK_INSUFFICIENT"
  | "SUSPENSE_SETTLEMENT";

export type LedgerScenarioStage =
  | "HOLD"
  | "RELEASE"
  | "CONFIRM"
  | "NETTING"
  | "RESERVE"
  | "LOST";

export interface LedgerScenarioInput {
  amount: DecimalInput;
  commissionAmount?: DecimalInput;
  providerFeeAmount?: DecimalInput;
  gatewayFeeAmount?: DecimalInput;
  settledAmount?: DecimalInput;
  varianceAmount?: DecimalInput;
  surchargeAmount?: DecimalInput;
  merchantAmount?: DecimalInput;
  stage?: LedgerScenarioStage;
  /**
   * The ownership mode of the attempt that is being settled. It decides
   * whether the money that could not be applied to a slot already sits in the
   * platform clearing account or in treasury (the internal rails clear through
   * treasury).
   */
  ownershipMode?: LedgerOwnershipMode;
}

export type LedgerOwnershipMode = "INTERNAL" | "PLATFORM_CLEARING" | "MERCHANT_DIRECT";

export interface PaymentConfirmationInput extends LedgerScenarioInput {
  ownershipMode: LedgerOwnershipMode;
  feeBearer?: "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";
  feeAccrual?: boolean;
}

export function decimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal) {
    return new Decimal(value.toString());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Money value must be finite");
    }
    return new Decimal(String(value));
  }
  return new Decimal(value.toString());
}

export function decimalString(value: DecimalInput, places = 4): string {
  return decimal(value).toFixed(places);
}

let lastUuidV7Timestamp = -1;
let uuidV7Sequence = 0;

function uuidv7(): string {
  let timestamp = Date.now();
  if (timestamp < lastUuidV7Timestamp) {
    timestamp = lastUuidV7Timestamp;
  }
  if (timestamp === lastUuidV7Timestamp) {
    uuidV7Sequence += 1;
    if (uuidV7Sequence > 0x0fff) {
      lastUuidV7Timestamp += 1;
      timestamp = lastUuidV7Timestamp;
      uuidV7Sequence = 0;
    }
  } else {
    lastUuidV7Timestamp = timestamp;
    uuidV7Sequence = 0;
  }
  const bytes = randomBytes(16);
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = 0x70 | ((uuidV7Sequence >> 8) & 0x0f);
  bytes[7] = uuidV7Sequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function moneyError(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

function requirePositive(value: DecimalInput, label: string): Decimal {
  const amount = decimal(value);
  if (!amount.isFinite() || amount.lte(0)) {
    throw moneyError("INVALID_LEDGER_AMOUNT", `${label} must be greater than zero`);
  }
  return amount;
}

function requireNonNegative(value: DecimalInput, label: string): Decimal {
  const amount = decimal(value);
  if (!amount.isFinite() || amount.lt(0)) {
    throw moneyError("INVALID_LEDGER_AMOUNT", `${label} must not be negative`);
  }
  return amount;
}

/**
 * Builds the optional legs of a journal template.
 *
 * A zero amount is never booked: a journal line always carries a strictly
 * positive amount. When a leg is not applicable (no commission on a manual
 * credit, no commission reversal on a refund) the leg is simply absent, which
 * is the same convention the provider and gateway fee legs already use.
 */
function optionalLine(
  direction: LedgerDirection,
  amount: Decimal,
  account: LedgerAccountSelector,
): LedgerLineTemplate[] {
  return amount.isZero() ? [] : [{ direction, amount, account }];
}

/**
 * How each account of the chart of accounts is scoped (design §7.1).
 */
const ACCOUNT_SCOPING: Record<LedgerAccountType, "GLOBAL" | "MERCHANT" | "GATEWAY"> = {
  TREASURY: "GLOBAL",
  GATEWAY_CLEARING: "GATEWAY",
  MERCHANT_WALLET: "MERCHANT",
  PLATFORM_INCOME: "GLOBAL",
  PROVIDER_FEE_EXPENSE: "GLOBAL",
  GATEWAY_FEE_EXPENSE: "GLOBAL",
  GATEWAY_FEE_ACCRUAL: "GLOBAL",
  COMMISSION_RECEIVABLE: "GLOBAL",
  AML_HOLD: "GLOBAL",
  CHARGEBACK_RESERVE: "GLOBAL",
  SUSPENSE: "GLOBAL",
};

function account(accountType: LedgerAccountType, overrides: Partial<LedgerAccountSelector> = {}): LedgerAccountSelector {
  return { accountType, ...overrides };
}

function defaultCommission(amount: Decimal): Decimal {
  return amount.mul("0.03");
}

export function buildLedgerTemplate(
  scenario: LedgerScenario,
  input: LedgerScenarioInput,
): JournalTemplate {
  const amount = requirePositive(input.amount, "Transaction amount");
  const commission = input.commissionAmount === undefined
    ? defaultCommission(amount)
    : requireNonNegative(input.commissionAmount, "Commission amount");
  const providerFee = input.providerFeeAmount === undefined
    ? new Decimal("1")
    : requireNonNegative(input.providerFeeAmount, "Provider fee amount");
  const gatewayFee = input.gatewayFeeAmount === undefined
    ? new Decimal("0.8")
    : requireNonNegative(input.gatewayFeeAmount, "Gateway fee amount");
  const merchantAmount = input.merchantAmount === undefined
    ? amount.minus(commission)
    : requireNonNegative(input.merchantAmount, "Merchant amount");
  const reference = "scenario";

  switch (scenario) {
    case "PLATFORM_HELD_CONFIRMATION": {
      const treasuryAmount = amount.minus(providerFee);
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "Platform-held confirmation with fee deducted at source",
        lines: [
          { direction: "DEBIT", amount: treasuryAmount, account: account("TREASURY") },
          ...(providerFee.isZero()
            ? []
            : [{ direction: "DEBIT" as const, amount: providerFee, account: account("PROVIDER_FEE_EXPENSE") }]),
          ...optionalLine("CREDIT", merchantAmount, account("MERCHANT_WALLET")),
          ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
        ],
      };
    }
    case "PLATFORM_HELD_FEE_ACCRUAL":
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "Platform-held confirmation with gateway fee accrual",
        lines: [
          { direction: "DEBIT", amount, account: account("GATEWAY_CLEARING") },
          ...(gatewayFee.isZero()
            ? []
            : [{ direction: "DEBIT" as const, amount: gatewayFee, account: account("GATEWAY_FEE_EXPENSE") }]),
          ...optionalLine("CREDIT", merchantAmount, account("MERCHANT_WALLET")),
          ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
          ...(gatewayFee.isZero()
            ? []
            : [{ direction: "CREDIT" as const, amount: gatewayFee, account: account("GATEWAY_FEE_ACCRUAL") }]),
        ],
      };
    case "SETTLEMENT_SWEEP": {
      const settled = input.settledAmount === undefined
        ? amount.minus(gatewayFee)
        : requirePositive(input.settledAmount, "Settled amount");
      return {
        refType: "SETTLEMENT_SWEEP",
        refId: reference,
        description: "Gateway settlement sweep",
        lines: [
          { direction: "DEBIT", amount: settled, account: account("TREASURY") },
          ...(gatewayFee.isZero()
            ? []
            : [{ direction: "DEBIT" as const, amount: gatewayFee, account: account("GATEWAY_FEE_ACCRUAL") }]),
          { direction: "CREDIT", amount, account: account("GATEWAY_CLEARING") },
        ],
      };
    }
    case "FEE_VARIANCE_TRUE_UP": {
      const variance = input.varianceAmount === undefined
        ? new Decimal("0.1")
        : requirePositive(input.varianceAmount, "Fee variance amount");
      return {
        refType: "FEE_VARIANCE",
        refId: reference,
        description: "Gateway settlement fee variance true-up",
        lines: [
          { direction: "DEBIT", amount: variance, account: account("GATEWAY_FEE_EXPENSE") },
          { direction: "CREDIT", amount: variance, account: account("GATEWAY_FEE_ACCRUAL") },
        ],
      };
    }
    case "PAYER_SURCHARGE_CONFIRMATION": {
      const surcharge = input.surchargeAmount === undefined
        ? commission
        : requirePositive(input.surchargeAmount, "Payer surcharge amount");
      const charged = amount.plus(surcharge);
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "Payment confirmation with payer surcharge",
        lines: [
          { direction: "DEBIT", amount: charged, account: account("GATEWAY_CLEARING") },
          ...(gatewayFee.isZero()
            ? []
            : [{ direction: "DEBIT" as const, amount: gatewayFee, account: account("GATEWAY_FEE_EXPENSE") }]),
          { direction: "CREDIT", amount, account: account("MERCHANT_WALLET") },
          ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
          ...(gatewayFee.isZero()
            ? []
            : [{ direction: "CREDIT" as const, amount: gatewayFee, account: account("GATEWAY_FEE_ACCRUAL") }]),
        ],
      };
    }
    case "SPLIT_SURCHARGE_CONFIRMATION": {
      const surcharge = input.surchargeAmount === undefined
        ? commission
        : requirePositive(input.surchargeAmount, "Payer surcharge amount");
      const charged = amount.plus(surcharge);
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "Payment confirmation with a split fee bearer",
        lines: [
          { direction: "DEBIT", amount: charged, account: account("GATEWAY_CLEARING") },
          ...(gatewayFee.isZero()
            ? []
            : [{ direction: "DEBIT" as const, amount: gatewayFee, account: account("GATEWAY_FEE_EXPENSE") }]),
          { direction: "CREDIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
          ...(gatewayFee.isZero()
            ? []
            : [{ direction: "CREDIT" as const, amount: gatewayFee, account: account("GATEWAY_FEE_ACCRUAL") }]),
        ],
      };
    }
    case "MERCHANT_DIRECT_CONFIRMATION": {
      if (input.stage === "NETTING") {
        return {
          refType: "COMMISSION_NETTING",
          refId: reference,
          description: "Merchant-direct commission netting",
          lines: [
            ...optionalLine("DEBIT", commission, account("MERCHANT_WALLET")),
            ...optionalLine("CREDIT", commission, account("COMMISSION_RECEIVABLE")),
          ],
        };
      }
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "Merchant-owned direct settlement commission recognition",
        lines: [
          ...optionalLine("DEBIT", commission, account("COMMISSION_RECEIVABLE")),
          ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
        ],
      };
    }
    case "AML_HOLD_AND_RELEASE": {
      if (input.stage === "RELEASE") {
        return {
          refType: "AML_RELEASE",
          refId: reference,
          description: "AML hold checker release",
          lines: [
            { direction: "DEBIT", amount, account: account("AML_HOLD") },
            ...optionalLine("CREDIT", merchantAmount, account("MERCHANT_WALLET")),
            ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
          ],
        };
      }
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "AML threshold hold",
        lines: [
          { direction: "DEBIT", amount, account: account("GATEWAY_CLEARING") },
          { direction: "CREDIT", amount, account: account("AML_HOLD") },
        ],
      };
    }
    case "CASHOUT":
      return {
        refType: "ADJUSTMENT",
        refId: reference,
        description: "Merchant cash-out execution",
        lines: [
          { direction: "DEBIT", amount, account: account("MERCHANT_WALLET") },
          { direction: "CREDIT", amount, account: account("TREASURY") },
        ],
      };
    case "FULL_REFUND":
      return {
        refType: "ADJUSTMENT",
        refId: reference,
        description: "Full refund with commission reversal",
        lines: [
          ...optionalLine("DEBIT", merchantAmount, account("MERCHANT_WALLET")),
          ...optionalLine("DEBIT", commission, account("PLATFORM_INCOME")),
          { direction: "CREDIT", amount, account: account("TREASURY") },
        ],
      };
    case "CHARGEBACK_RESERVE_AND_LOST": {
      if (input.stage === "LOST") {
        return {
          refType: "DISPUTE_OUTCOME",
          refId: reference,
          description: "Chargeback reserve lost",
          lines: [
            { direction: "DEBIT", amount, account: account("CHARGEBACK_RESERVE") },
            { direction: "CREDIT", amount, account: account("TREASURY") },
          ],
        };
      }
      return {
        refType: "DISPUTE_OUTCOME",
        refId: reference,
        description: "Chargeback reserve",
        lines: [
          { direction: "DEBIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          ...optionalLine("DEBIT", commission, account("PLATFORM_INCOME")),
          { direction: "CREDIT", amount, account: account("CHARGEBACK_RESERVE") },
        ],
      };
    }
    case "AML_VOID":
      return {
        refType: "AML_VOID",
        refId: reference,
        description: "AML hold void and funds return",
        lines: [
          { direction: "DEBIT", amount, account: account("AML_HOLD") },
          { direction: "CREDIT", amount, account: account("TREASURY") },
        ],
      };
    case "CHARGEBACK_WON":
      return {
        refType: "DISPUTE_OUTCOME",
        refId: reference,
        description: "Chargeback won and reserve released",
        lines: [
          { direction: "DEBIT", amount, account: account("CHARGEBACK_RESERVE") },
          ...optionalLine("CREDIT", merchantAmount, account("MERCHANT_WALLET")),
          ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
        ],
      };
    case "INTERNAL_CONFIRMATION":
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "NeomPay internal confirmation under INTERNAL-1",
        lines: [
          { direction: "DEBIT", amount, account: account("TREASURY") },
          ...optionalLine("CREDIT", merchantAmount, account("MERCHANT_WALLET")),
          ...optionalLine("CREDIT", commission, account("PLATFORM_INCOME")),
        ],
      };
    case "INTERNAL_REFUND":
      return {
        refType: "ADJUSTMENT",
        refId: reference,
        description: "NeomPay internal refund",
        lines: [
          ...optionalLine("DEBIT", merchantAmount, account("MERCHANT_WALLET")),
          ...optionalLine("DEBIT", commission, account("PLATFORM_INCOME")),
          { direction: "CREDIT", amount, account: account("TREASURY") },
        ],
      };
    case "CHARGEBACK_INSUFFICIENT":
      return {
        refType: "DISPUTE_OUTCOME",
        refId: reference,
        description: "Chargeback against insufficient merchant wallet",
        lines: [
          ...optionalLine("DEBIT", merchantAmount, account("MERCHANT_WALLET")),
          ...optionalLine("DEBIT", commission, account("PLATFORM_INCOME")),
          { direction: "CREDIT", amount, account: account("CHARGEBACK_RESERVE") },
        ],
      };
    case "SUSPENSE_SETTLEMENT":
      // The settlement could not be applied to a payment link slot (a second
      // settlement on a single-use link, an overpayment, or a duplicate
      // settlement). The money is real, so it must not disappear from the
      // books: it is parked in SUSPENSE until the automatic refund adjustment
      // is reviewed and executed (design §9.1 rule 6, edge cases 13/38/41).
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "Settlement routed to SUSPENSE because the link slot was already used",
        lines: [
          {
            direction: "DEBIT",
            amount,
            account: account(input.ownershipMode === "INTERNAL" ? "TREASURY" : "GATEWAY_CLEARING"),
          },
          { direction: "CREDIT", amount, account: account("SUSPENSE") },
        ],
      };
  }
}

/**
 * Builds the confirmation posting for a settled attempt.
 *
 * Unlike the raw scenario builder this function is strict about money: every
 * fee that the selected template books MUST be supplied by the caller. The
 * engine resolves the real gateway fee from the pinned route cost model, so a
 * confirmation can never be posted with an invented fee.
 */
export function buildPaymentConfirmationTemplate(input: PaymentConfirmationInput): JournalTemplate {
  if (input.ownershipMode === "INTERNAL") {
    return buildLedgerTemplate("INTERNAL_CONFIRMATION", input);
  }
  if (input.ownershipMode === "MERCHANT_DIRECT") {
    return buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", input);
  }
  if (input.commissionAmount === undefined) {
    throw moneyError(
      "MISSING_COMMISSION_AMOUNT",
      "The platform commission must be resolved from the pinned commission profile",
    );
  }
  if (input.feeBearer === "PAYER_SURCHARGE") {
    requireFee(input.gatewayFeeAmount, "Gateway fee amount");
    requireFee(input.surchargeAmount, "Payer surcharge amount");
    return buildLedgerTemplate("PAYER_SURCHARGE_CONFIRMATION", input);
  }
  if (input.feeBearer === "SPLIT") {
    requireFee(input.gatewayFeeAmount, "Gateway fee amount");
    requireFee(input.surchargeAmount, "Payer surcharge amount");
    return buildLedgerTemplate("SPLIT_SURCHARGE_CONFIRMATION", input);
  }
  if (input.feeAccrual === true) {
    requireFee(input.gatewayFeeAmount, "Gateway fee amount");
    return buildLedgerTemplate("PLATFORM_HELD_FEE_ACCRUAL", input);
  }
  requireFee(input.providerFeeAmount, "Provider fee amount");
  return buildLedgerTemplate("PLATFORM_HELD_CONFIRMATION", input);
}

function requireFee(value: DecimalInput | undefined, label: string): Decimal {
  if (value === undefined) {
    throw moneyError("MISSING_FEE_AMOUNT", `${label} must be resolved before posting`);
  }
  const amount = decimal(value);
  if (!amount.isFinite() || amount.lt(0)) {
    throw moneyError("INVALID_LEDGER_AMOUNT", `${label} must not be negative`);
  }
  return amount;
}

export class LedgerPoster {
  private readonly client: LedgerPrismaClient;
  private readonly transactionRunner: LedgerTransactionRunner;

  constructor(client: LedgerPrismaClient, transactionRunner?: LedgerTransactionRunner) {
    this.client = client;
    this.transactionRunner = transactionRunner
      ?? (client.$transaction
        ? <R>(callback: (transaction: LedgerPrismaClient) => Promise<R>) => client.$transaction!(callback)
        : async <R>(callback: (transaction: LedgerPrismaClient) => Promise<R>) => callback(client));
  }

  /**
   * Posts a journal template.
   *
   * When a transaction is supplied the posting joins that transaction, so the
   * money movement and the state change that authorises it commit together.
   * Without a transaction the poster opens its own, exactly as before.
   */
  async post(
    template: JournalTemplate,
    context: LedgerPostContext = {},
    transaction?: LedgerPrismaClient,
  ): Promise<LedgerPostResult> {
    this.validateTemplate(template);
    const write = async (runner: LedgerPrismaClient): Promise<LedgerPostResult> => {
      const existing = await runner.journalEntry.findFirst({
        where: { refType: template.refType, refId: template.refId },
      });
      if (existing) {
        return { entry: existing, lines: [], created: false, idempotent: true };
      }
      let entry: JournalEntryRecord;
      try {
        entry = await runner.journalEntry.create({
          data: {
            refType: template.refType,
            refId: template.refId,
            description: template.description,
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const raced = await runner.journalEntry.findFirst({
            where: { refType: template.refType, refId: template.refId },
          });
          if (raced) {
            return { entry: raced, lines: [], created: false, idempotent: true };
          }
        }
        throw error;
      }
      if (this.canUseFastPath(runner)) {
        return this.writeFast(runner, template, context, entry);
      }
      const lines: JournalLineRecord[] = [];
      const fallbackDeltas = new Map<string, { delta: Decimal; count: number }>();
      for (const line of template.lines) {
        const accountId = await this.resolveAccountId(runner, line.account, context);
        const amount = decimal(line.amount);
        const created = await runner.journalLine.create({
          data: {
            entryId: entry.id,
            glAccountId: accountId,
            direction: line.direction,
            amount,
          },
        });
        lines.push(created);
        const current = fallbackDeltas.get(accountId) ?? { delta: new Decimal(0), count: 0 };
        fallbackDeltas.set(accountId, {
          delta: current.delta.plus(line.direction === "DEBIT" ? amount : amount.negated()),
          count: current.count + 1,
        });
      }
      if (fallbackDeltas.size > 0 && typeof runner.journalLine.createMany === "function") {
        await this.applyBalanceDeltas(runner, fallbackDeltas, new Date());
      }
      return { entry, lines, created: true, idempotent: false };
    };
    return transaction ? write(transaction) : this.transactionRunner(write);
  }

  private canUseFastPath(transaction: LedgerPrismaClient): boolean {
    return typeof transaction.journalLine.createMany === "function"
      && (
        typeof transaction.$executeRawUnsafe === "function"
        || typeof transaction.$executeRaw === "function"
        || typeof transaction.glAccount.update === "function"
        || typeof transaction.glAccount.updateMany === "function"
      );
  }

  /**
   * Batched posting for clients that expose `createMany` and raw/update
   * capabilities. Journal lines are inserted in one statement and every
   * touched GL account receives its net signed delta plus its line count.
   * The account ids are processed in sorted order so concurrent postings
   * acquire the same GL rows in the same order (no AB-BA deadlocks).
   */
  private async writeFast(
    transaction: LedgerPrismaClient,
    template: JournalTemplate,
    context: LedgerPostContext,
    entry: JournalEntryRecord,
  ): Promise<LedgerPostResult> {
    const now = new Date();
    const resolved: Array<{ line: LedgerLineTemplate; accountId: string; lineId: string }> = [];
    for (const line of template.lines) {
      const accountId = await this.resolveAccountId(transaction, line.account, context);
      resolved.push({ line, accountId, lineId: uuidv7() });
    }

    const deltas = new Map<string, { delta: Decimal; count: number }>();
    const rows = resolved.map(({ line, accountId, lineId }) => {
      const amount = decimal(line.amount);
      const signed = line.direction === "DEBIT" ? amount : amount.negated();
      const current = deltas.get(accountId) ?? { delta: new Decimal(0), count: 0 };
      deltas.set(accountId, {
        delta: current.delta.plus(signed),
        count: current.count + 1,
      });
      return {
        id: lineId,
        entryId: entry.id,
        glAccountId: accountId,
        direction: line.direction,
        amount,
        createdAt: now,
        updatedAt: now,
      };
    });

    await transaction.journalLine.createMany!({ data: rows });
    await this.applyBalanceDeltas(transaction, deltas, now);

    return {
      entry,
      lines: rows.map((row) => ({ ...row })),
      created: true,
      idempotent: false,
    };
  }

  private async applyBalanceDeltas(
    transaction: LedgerPrismaClient,
    deltas: Map<string, { delta: Decimal; count: number }>,
    now: Date,
  ): Promise<void> {
    if (deltas.size === 0) {
      return;
    }
    const sorted = [...deltas.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    const update = transaction.glAccount.update;
    if (typeof update === "function") {
      for (const [accountId, { delta, count }] of sorted) {
        await update.call(transaction.glAccount, {
          where: { id: accountId },
          data: {
            currentBalance: { increment: delta },
            linesSinceCheckpoint: { increment: count },
            updatedAt: now,
          },
        });
      }
      return;
    }

    if (typeof transaction.$executeRawUnsafe === "function") {
      const balanceCases: string[] = [];
      const countCases: string[] = [];
      const params: unknown[] = [];
      for (const [accountId, { delta, count }] of sorted) {
        balanceCases.push("WHEN ? THEN ?");
        params.push(accountId, delta.toFixed(4));
        countCases.push("WHEN ? THEN ?");
        params.push(accountId, count);
      }
      const placeholders = sorted.map(() => "?").join(", ");
      params.push(now, ...sorted.map(([accountId]) => accountId));
      await transaction.$executeRawUnsafe(
        `UPDATE gl_accounts
            SET current_balance = current_balance + CASE id ${balanceCases.join(" ")} ELSE 0 END,
                lines_since_checkpoint = lines_since_checkpoint + CASE id ${countCases.join(" ")} ELSE 0 END,
                updated_at = ?
          WHERE id IN (${placeholders})`,
        ...params,
      );
      return;
    }

    const updateMany = transaction.glAccount.updateMany;
    if (typeof updateMany === "function") {
      for (const [accountId, { delta, count }] of sorted) {
        await updateMany.call(transaction.glAccount, {
          where: { id: accountId },
          data: {
            currentBalance: { increment: delta },
            linesSinceCheckpoint: { increment: count },
            updatedAt: now,
          },
        });
      }
      return;
    }

    if (typeof transaction.$executeRaw === "function") {
      for (const [accountId, { delta, count }] of sorted) {
        const sql = "UPDATE gl_accounts SET current_balance = current_balance + ?, lines_since_checkpoint = lines_since_checkpoint + ?, updated_at = ? WHERE id = ?";
        const strings = [sql] as unknown as TemplateStringsArray;
        (strings as unknown as { raw: string[] }).raw = [sql];
        await transaction.$executeRaw.call(transaction, strings, delta.toFixed(4), count, now, accountId);
      }
    }
  }

  async postScenario(
    scenario: LedgerScenario,
    refId: string,
    input: LedgerScenarioInput,
    context: LedgerPostContext = {},
    transaction?: LedgerPrismaClient,
  ): Promise<LedgerPostResult> {
    const template = buildLedgerTemplate(scenario, input);
    template.refId = refId;
    return this.post(template, context, transaction);
  }

  async postPaymentConfirmation(
    refId: string,
    input: PaymentConfirmationInput,
    context: LedgerPostContext = {},
    transaction?: LedgerPrismaClient,
  ): Promise<LedgerPostResult> {
    const template = buildPaymentConfirmationTemplate(input);
    template.refId = refId;
    return this.post(template, context, transaction);
  }

  validateTemplate(template: JournalTemplate): void {
    if (!template.refType || !template.refId || template.lines.length === 0) {
      throw moneyError("INVALID_JOURNAL_TEMPLATE", "Journal template requires a reference and at least one line");
    }
    let debits = new Decimal(0);
    let credits = new Decimal(0);
    for (const line of template.lines) {
      const amount = requirePositive(line.amount, "Journal line amount");
      if (line.direction === "DEBIT") {
        debits = debits.plus(amount);
      } else if (line.direction === "CREDIT") {
        credits = credits.plus(amount);
      } else {
        throw moneyError("INVALID_JOURNAL_DIRECTION", "Journal line direction must be DEBIT or CREDIT");
      }
    }
    if (!debits.equals(credits) || debits.lte(0)) {
      throw moneyError(
        "UNBALANCED_JOURNAL_ENTRY",
        `Journal debits ${debits.toFixed(4)} must equal credits ${credits.toFixed(4)} and be greater than zero`,
      );
    }
  }

  private async resolveAccountId(
    transaction: LedgerPrismaClient,
    selector: LedgerAccountSelector,
    context: LedgerPostContext,
  ): Promise<string> {
    if (selector.accountId) {
      return selector.accountId;
    }
    const mapped = context.accounts?.[selector.accountType];
    if (mapped) {
      return mapped;
    }
    const currency = selector.currency ?? context.currency;
    // The chart of accounts has three kinds of account (design §7.1):
    //   - a merchant wallet belongs to ONE merchant,
    //   - a gateway clearing account belongs to ONE (gateway, env, credential set),
    //   - every other account (treasury, income, the two fee accounts, the fee
    //     accrual, the commission receivable, the AML hold, the chargeback
    //     reserve and suspense) is platform wide.
    // The resolver therefore only narrows a lookup by the dimensions the
    // account type actually carries, and it falls back to the platform wide
    // account when no dedicated one has been configured.
    const scoping = ACCOUNT_SCOPING[selector.accountType] ?? "GLOBAL";
    const ownerId = selector.ownerId ?? (scoping === "MERCHANT" ? context.merchantId : undefined);
    const gatewayId = selector.gatewayId ?? (scoping === "GATEWAY" ? context.gatewayId : undefined);
    const credentialSetId = selector.credentialSetId
      ?? (scoping === "GATEWAY" ? context.credentialSetId : undefined);
    const env = selector.env ?? (scoping === "GATEWAY" ? context.env : undefined);

    const scopedWhere = {
      accountType: selector.accountType,
      ...(ownerId ? { ownerId } : {}),
      ...(gatewayId ? { gatewayId } : {}),
      ...(credentialSetId ? { credentialSetId } : {}),
      ...(env ? { env } : {}),
      ...(currency ? { currency } : {}),
    };
    const record = await transaction.glAccount.findFirst({
      where: scopedWhere,
      select: { id: true },
    });
    if (record) {
      return record.id;
    }
    // Fall back to the platform wide account of the same type and currency.
    const fallback = await transaction.glAccount.findFirst({
      where: {
        accountType: selector.accountType,
        ownerId: null,
        gatewayId: null,
        credentialSetId: null,
        env: null,
        ...(currency ? { currency } : {}),
      },
      select: { id: true },
    });
    if (!fallback) {
      throw moneyError("GL_ACCOUNT_NOT_FOUND", `No ${selector.accountType} account matched the posting context`);
    }
    return fallback.id;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "UNIQUE_CONSTRAINT_VIOLATION";
}
