import { createLedgerShardWriter, lockShardsForLines } from "../../lib/storageEngine/ledgerShardWriter";
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
  /** The shard the line was posted to and its place in that shard's gapless sequence (>= 1 for real lines). */
  shardId?: number;
  shardSeq?: bigint;
}

export interface LedgerPrismaClient {
  glAccount: {
    findFirst(args: { where: Record<string, unknown>; select?: Record<string, boolean> }): Promise<LedgerAccountRecord | null>;
    findUnique?(args: { where: { id: string } }): Promise<LedgerAccountRecord | null>;
    /** When present, every selector of a posting is resolved in ONE query. */
    findMany?(args: { where: Record<string, unknown>; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> }): Promise<LedgerAccountRecord[]>;
  };
  journalEntry: {
    findFirst(args: { where: Record<string, unknown> }): Promise<JournalEntryRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<JournalEntryRecord>;
    /**
     * When present the entry is inserted with `ON CONFLICT DO NOTHING`
     * (`skipDuplicates`). That is one round trip on the common path and, unlike
     * catching a unique violation, it does not abort the surrounding
     * PostgreSQL transaction when two posters race on the same reference.
     */
    // Typed loosely: the generated Prisma signature is generic.
    createManyAndReturn?(args: any): Promise<JournalEntryRecord[]>;
  };
  journalLine: {
    create(args: { data: Record<string, unknown> }): Promise<JournalLineRecord>;
    /** When present all lines of an entry are inserted in one statement. */
    // Typed loosely: the generated Prisma signature is generic.
    createManyAndReturn?(args: any): Promise<JournalLineRecord[]>;
  };
  $transaction?<R>(callback: (transaction: LedgerPrismaClient) => Promise<R>): Promise<R>;
}

export interface LedgerTransactionRunner {
  <R>(callback: (transaction: LedgerPrismaClient) => Promise<R>): Promise<R>;
}

export interface LedgerShardLine {
  entryId: string;
  refType: LedgerRefType | string;
  refId: string;
  glAccountId: string;
  accountType: LedgerAccountType;
  direction: LedgerDirection;
  amount: DecimalInput;
}

/** Where one journal line is posted: its shard and its number in that shard's sequence. */
export interface LedgerShardAssignment {
  shardId: number;
  shardSeq: bigint;
}

/**
 * Reserves the shard and sequence number of every line and projects the lines onto `gl_account_shards`.
 * It runs inside the SAME transaction as the journal lines and BEFORE they are inserted (the sequence is
 * part of each line), so shard balances can never drift from the ledger. The result is aligned with the
 * input lines. The default writer (`createLedgerShardWriter`) does nothing against test doubles that
 * cannot run raw SQL.
 */
export type LedgerShardWriter = (
  transaction: LedgerPrismaClient,
  lines: readonly LedgerShardLine[],
) => Promise<LedgerShardAssignment[]>;

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

/**
 * Emits the transactional ledger outbox event inside the same transaction as
 * the journal entry. The callback is optional so focused unit tests keep
 * using the in-memory ledger without a database.
 */
export type LedgerPostedOutboxWriter = (
  transaction: LedgerPrismaClient,
  entry: JournalEntryRecord,
  lines: readonly JournalLineRecord[],
) => Promise<void>;

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

type AccountLookupPlan =
  | { kind: "direct"; id: string }
  | {
      kind: "lookup";
      key: string;
      accountType: LedgerAccountType;
      scoped: Record<string, unknown>;
      fallback: Record<string, unknown>;
    };

export class LedgerPoster {
  private readonly client: LedgerPrismaClient;
  private readonly transactionRunner: LedgerTransactionRunner;

  constructor(
    client: LedgerPrismaClient,
    transactionRunner?: LedgerTransactionRunner,
    private readonly shardWriter: LedgerShardWriter = createLedgerShardWriter(),
    private readonly postedOutboxWriter?: LedgerPostedOutboxWriter,
  ) {
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
      const entryData = {
        refType: template.refType,
        refId: template.refId,
        description: template.description,
      };
      let entry: JournalEntryRecord;
      if (typeof runner.journalEntry.createManyAndReturn === "function") {
        const inserted = await runner.journalEntry.createManyAndReturn({
          data: [entryData],
          skipDuplicates: true,
        });
        if (inserted.length === 0) {
          const existing = await runner.journalEntry.findFirst({
            where: { refType: template.refType, refId: template.refId },
          });
          if (!existing) {
            throw moneyError("JOURNAL_ENTRY_CONFLICT", "The journal entry conflicted but could not be read back");
          }
          return { entry: existing, lines: [], created: false, idempotent: true };
        }
        entry = inserted[0]!;
      } else {
        const existing = await runner.journalEntry.findFirst({
          where: { refType: template.refType, refId: template.refId },
        });
        if (existing) {
          return { entry: existing, lines: [], created: false, idempotent: true };
        }
        try {
          entry = await runner.journalEntry.create({ data: entryData });
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
      }
      const accountIds = await this.resolveAccountIds(runner, template.lines, context);
      // The shard (and its sequence) is reserved BEFORE the lines are inserted: the sequence number is part of
      // each line, and the shard row lock taken here is held until commit.
      const assignments = await this.shardWriter(
        runner,
        template.lines.map((line, index) => ({
          entryId: entry.id,
          refType: template.refType,
          refId: template.refId,
          glAccountId: accountIds[index]!,
          accountType: line.account.accountType,
          direction: line.direction,
          amount: line.amount,
        })),
      );
      const lineData = template.lines.map((line, index) => ({
        entryId: entry.id,
        glAccountId: accountIds[index]!,
        direction: line.direction,
        amount: decimal(line.amount),
        shardId: assignments[index]!.shardId,
        shardSeq: assignments[index]!.shardSeq,
      }));
      let lines: JournalLineRecord[];
      if (typeof runner.journalLine.createManyAndReturn === "function") {
        lines = await runner.journalLine.createManyAndReturn({ data: lineData });
      } else {
        lines = [];
        for (const data of lineData) {
          lines.push(await runner.journalLine.create({ data }));
        }
      }
      if (this.postedOutboxWriter) {
        await this.postedOutboxWriter(runner, entry, lines);
      }
      return { entry, lines, created: true, idempotent: false };
    };
    return transaction ? write(transaction) : this.transactionRunner(write);
  }

  /**
   * Locks the shard rows that posting `template` will update, in the global (account, shard) order, WITHOUT posting
   * anything. Call it before reading a balance you must act on (a cash-out check) so the shard locks are acquired in
   * the same order as every posting does; locking the wallet first and letting the posting lock the rest afterwards
   * is the classic opposite-order deadlock with a concurrent posting. The locks last until the transaction ends.
   */
  async lockShardsFor(
    template: JournalTemplate,
    context: LedgerPostContext,
    transaction: LedgerPrismaClient,
  ): Promise<void> {
    this.validateTemplate(template);
    const accountIds = await this.resolveAccountIds(transaction, template.lines, context);
    await lockShardsForLines(
      transaction,
      template.lines.map((line, index) => ({
        entryId: "",
        refType: template.refType,
        refId: template.refId,
        glAccountId: accountIds[index]!,
        accountType: line.account.accountType,
        direction: line.direction,
        amount: line.amount,
      })),
    );
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

  /**
   * Resolves the account of every line. Selectors that are not mapped by id
   * are resolved with ONE `findMany` over the OR of their scoped and
   * platform-wide fallback predicates (instead of one or two `findFirst` per
   * line), then matched in memory with the same precedence as
   * `resolveAccountId`. Clients without `findMany` (in-memory test doubles)
   * keep the per-line path. Identical selectors are resolved once.
   */
  private async resolveAccountIds(
    transaction: LedgerPrismaClient,
    lines: readonly LedgerLineTemplate[],
    context: LedgerPostContext,
  ): Promise<string[]> {
    const plans = lines.map((line) => this.accountLookupPlan(line.account, context));
    const pending = plans.filter((plan): plan is Extract<AccountLookupPlan, { kind: "lookup" }> => plan.kind === "lookup");
    if (pending.length === 0 || typeof transaction.glAccount.findMany !== "function") {
      // Sequential on purpose: the queries share one transaction connection.
      const memo = new Map<string, string>();
      const ids: string[] = [];
      for (const [index, line] of lines.entries()) {
        const plan = plans[index]!;
        if (plan.kind === "direct") {
          ids.push(plan.id);
          continue;
        }
        const known = memo.get(plan.key) ?? (await this.resolveAccountId(transaction, line.account, context));
        memo.set(plan.key, known);
        ids.push(known);
      }
      return ids;
    }
    const predicates = new Map<string, Record<string, unknown>>();
    for (const plan of pending) {
      predicates.set(JSON.stringify(plan.scoped), plan.scoped);
      predicates.set(JSON.stringify(plan.fallback), plan.fallback);
    }
    const candidates = await transaction.glAccount.findMany({
      where: { OR: [...predicates.values()] },
      select: {
        id: true,
        accountType: true,
        ownerId: true,
        gatewayId: true,
        credentialSetId: true,
        env: true,
        currency: true,
      },
      orderBy: { id: "asc" },
    });
    const matches = (record: LedgerAccountRecord, predicate: Record<string, unknown>): boolean =>
      Object.entries(predicate).every(([field, expected]) => {
        const actual = (record as unknown as Record<string, unknown>)[field];
        return expected === null ? actual === null || actual === undefined : actual === expected;
      });
    return plans.map((plan) => {
      if (plan.kind === "direct") {
        return plan.id;
      }
      const scoped = candidates.find((record) => matches(record, plan.scoped));
      if (scoped) {
        return scoped.id;
      }
      const fallback = candidates.find((record) => matches(record, plan.fallback));
      if (!fallback) {
        throw moneyError("GL_ACCOUNT_NOT_FOUND", `No ${plan.accountType} account matched the posting context`);
      }
      return fallback.id;
    });
  }

  private accountLookupPlan(selector: LedgerAccountSelector, context: LedgerPostContext): AccountLookupPlan {
    if (selector.accountId) {
      return { kind: "direct", id: selector.accountId };
    }
    const mapped = context.accounts?.[selector.accountType];
    if (mapped) {
      return { kind: "direct", id: mapped };
    }
    const { scopedWhere, fallbackWhere } = this.accountPredicates(selector, context);
    return {
      kind: "lookup",
      key: JSON.stringify(scopedWhere),
      accountType: selector.accountType,
      scoped: scopedWhere,
      fallback: fallbackWhere,
    };
  }

  private accountPredicates(
    selector: LedgerAccountSelector,
    context: LedgerPostContext,
  ): { scopedWhere: Record<string, unknown>; fallbackWhere: Record<string, unknown> } {
    const currency = selector.currency ?? context.currency;
    const scoping = ACCOUNT_SCOPING[selector.accountType] ?? "GLOBAL";
    const ownerId = selector.ownerId ?? (scoping === "MERCHANT" ? context.merchantId : undefined);
    const gatewayId = selector.gatewayId ?? (scoping === "GATEWAY" ? context.gatewayId : undefined);
    const credentialSetId = selector.credentialSetId
      ?? (scoping === "GATEWAY" ? context.credentialSetId : undefined);
    const env = selector.env ?? (scoping === "GATEWAY" ? context.env : undefined);
    return {
      scopedWhere: {
        accountType: selector.accountType,
        ...(ownerId ? { ownerId } : {}),
        ...(gatewayId ? { gatewayId } : {}),
        ...(credentialSetId ? { credentialSetId } : {}),
        ...(env ? { env } : {}),
        ...(currency ? { currency } : {}),
      },
      fallbackWhere: {
        accountType: selector.accountType,
        ownerId: null,
        gatewayId: null,
        credentialSetId: null,
        env: null,
        ...(currency ? { currency } : {}),
      },
    };
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
    // The chart of accounts has three kinds of account (design §7.1):
    //   - a merchant wallet belongs to ONE merchant,
    //   - a gateway clearing account belongs to ONE (gateway, env, credential set),
    //   - every other account is platform wide.
    // The resolver only narrows a lookup by the dimensions the account type
    // actually carries, and it falls back to the platform wide account when
    // no dedicated one has been configured.
    const { scopedWhere, fallbackWhere } = this.accountPredicates(selector, context);
    const record = await transaction.glAccount.findFirst({
      where: scopedWhere,
      select: { id: true },
    });
    if (record) {
      return record.id;
    }
    // Fall back to the platform wide account of the same type and currency.
    const fallback = await transaction.glAccount.findFirst({
      where: fallbackWhere,
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
