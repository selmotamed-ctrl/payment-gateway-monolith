import { Decimal } from "decimal.js";
import { ApiError } from "../../lib/error";
import {
  GlBalanceStore,
  isSyncAccountType,
  type GlBalanceDelta,
  type GlBalanceMode,
  type GlBalanceStoreClient,
} from "./GlBalanceStore";

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
  balanceMode?: GlBalanceMode | string | null;
  currentBalance?: DecimalInput;
  balanceFloor?: DecimalInput | null;
  ownerId?: string | null;
  gatewayId?: string | null;
  credentialSetId?: string | null;
  env?: string | null;
  currency?: string | null;
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
}

export interface LedgerPrismaClient extends GlBalanceStoreClient {
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
    create?(args: { data: Record<string, unknown> }): Promise<JournalLineRecord>;
    createMany?(args: { data: Record<string, unknown>[] }): Promise<unknown>;
    findMany?(args?: Record<string, unknown>): Promise<JournalLineRecord[]>;
  };
  $transaction?<R>(callback: (transaction: LedgerPrismaClient) => Promise<R>): Promise<R>;
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
  COMMISSION_RECEIVABLE: "MERCHANT",
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

interface ResolvedLedgerAccount {
  id: string;
  accountType: LedgerAccountType;
  balanceMode: GlBalanceMode;
  balanceFloor: Decimal | null;
  currentBalance?: Decimal;
}

export class LedgerPoster {
  private readonly client: LedgerPrismaClient;
  private readonly transactionRunner: LedgerTransactionRunner;
  private readonly balanceStore: GlBalanceStore;

  constructor(client: LedgerPrismaClient, transactionRunner?: LedgerTransactionRunner) {
    this.client = client;
    this.transactionRunner = transactionRunner
      ?? (client.$transaction
        ? <R>(callback: (transaction: LedgerPrismaClient) => Promise<R>) => client.$transaction!(callback)
        : async <R>(callback: (transaction: LedgerPrismaClient) => Promise<R>) => callback(client));
    this.balanceStore = new GlBalanceStore();
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
      const resolved: Array<{ line: LedgerLineTemplate; account: ResolvedLedgerAccount }> = [];
      for (const line of template.lines) {
        const account = await this.resolveAccount(runner, line.account, context);
        resolved.push({ line, account });
      }

      // A journal-line insert takes a shared FK lock on its gl_accounts row.
      // Taking the exclusive lock on every SYNC account first, in id order,
      // prevents the shared-to-exclusive upgrade deadlock when many payments
      // for the same merchant wallet are confirmed concurrently.
      await this.lockSyncAccounts(runner, resolved);

      const lines = await this.insertJournalLines(
        runner,
        entry.id,
        resolved.map(({ line, account }) => ({
          entryId: entry.id,
          glAccountId: account.id,
          direction: line.direction,
          amount: decimal(line.amount),
        })),
      );

      const deltas = new Map<string, GlBalanceDelta>();
      for (const { line, account } of resolved) {
        const amount = decimal(line.amount);
        const delta = line.direction === "DEBIT" ? amount : amount.negated();
        const existing = deltas.get(account.id);
        if (existing) {
          existing.delta = decimal(existing.delta).plus(delta);
          existing.lineCount = BigInt(existing.lineCount ?? 1n) + 1n;
        } else {
          deltas.set(account.id, {
            glAccountId: account.id,
            accountType: account.accountType,
            balanceMode: account.balanceMode,
            balanceFloor: account.balanceFloor,
            currentBalance: account.currentBalance,
            delta,
            lineCount: 1n,
          });
        }
      }
      const orderedDeltas = [...deltas.values()].sort((left, right) =>
        left.glAccountId < right.glAccountId ? -1 : left.glAccountId > right.glAccountId ? 1 : 0,
      );
      await this.balanceStore.postDeltas(runner, orderedDeltas, { entryId: entry.id });

      return { entry, lines, created: true, idempotent: false };
    };
    return transaction ? write(transaction) : this.transactionRunner(write);
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

  private async resolveAccount(
    transaction: LedgerPrismaClient,
    selector: LedgerAccountSelector,
    context: LedgerPostContext,
  ): Promise<ResolvedLedgerAccount> {
    const pinned = selector.accountId ?? context.accounts?.[selector.accountType];
    if (pinned) {
      const record = await this.findAccountById(transaction, pinned);
      return this.toResolvedAccount(record, pinned, selector.accountType);
    }

    const currency = selector.currency ?? context.currency;
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
      select: this.accountSelect(),
    });
    if (record) {
      return this.toResolvedAccount(record, String(record.id), selector.accountType);
    }

    const fallback = await transaction.glAccount.findFirst({
      where: {
        accountType: selector.accountType,
        ownerId: null,
        gatewayId: null,
        credentialSetId: null,
        env: null,
        ...(currency ? { currency } : {}),
      },
      select: this.accountSelect(),
    });
    if (!fallback) {
      throw moneyError("GL_ACCOUNT_NOT_FOUND", `No ${selector.accountType} account matched the posting context`);
    }
    return this.toResolvedAccount(fallback, String(fallback.id), selector.accountType);
  }

  private async lockSyncAccounts(
    transaction: LedgerPrismaClient,
    resolved: ReadonlyArray<{ account: ResolvedLedgerAccount }>,
  ): Promise<void> {
    const syncIds = [...new Set(
      resolved
        .filter(({ account }) => account.balanceMode === "SYNC")
        .map(({ account }) => account.id),
    )].sort();
    if (syncIds.length === 0 || typeof transaction.$queryRawUnsafe !== "function") {
      return;
    }
    const placeholders = syncIds.map(() => "?").join(", ");
    await transaction.$queryRawUnsafe(
      `SELECT id FROM \`gl_accounts\` WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`,
      ...syncIds,
    );
  }

  private accountSelect(): Record<string, boolean> {
    return {
      id: true,
      accountType: true,
      balanceMode: true,
      currentBalance: true,
      balanceFloor: true,
    };
  }

  private async findAccountById(
    transaction: LedgerPrismaClient,
    accountId: string,
  ): Promise<LedgerAccountRecord | null> {
    try {
      if (transaction.glAccount.findUnique) {
        const record = await transaction.glAccount.findUnique({ where: { id: accountId } });
        if (record) {
          return record;
        }
      }
      return await transaction.glAccount.findFirst({
        where: { id: accountId },
        select: this.accountSelect(),
      });
    } catch {
      return null;
    }
  }

  private toResolvedAccount(
    record: LedgerAccountRecord | null,
    accountId: string,
    fallbackType: LedgerAccountType,
  ): ResolvedLedgerAccount {
    const accountType = (record?.accountType as LedgerAccountType | undefined) ?? fallbackType;
    const explicitMode = record?.balanceMode;
    const balanceMode = explicitMode === "SYNC" || explicitMode === "SHARDED"
      ? explicitMode
      : isSyncAccountType(accountType) ? "SYNC" : "SHARDED";
    const floor = record?.balanceFloor;
    return {
      id: accountId,
      accountType,
      balanceMode,
      balanceFloor: floor === null || floor === undefined ? null : decimal(floor),
      currentBalance: record?.currentBalance === null || record?.currentBalance === undefined
        ? undefined
        : decimal(record.currentBalance),
    };
  }

  private async insertJournalLines(
    transaction: LedgerPrismaClient,
    entryId: string,
    data: Array<Record<string, unknown>>,
  ): Promise<JournalLineRecord[]> {
    const journalLine = transaction.journalLine;
    if (journalLine.createMany) {
      const created = await journalLine.createMany({ data });
      if (Array.isArray(created) && created.length > 0) {
        return created.map((row, index) => {
          const fallbackRow = data[index] ?? {};
          return this.normalizeLine(row, { ...fallbackRow, id: index + 1 }, entryId);
        });
      }
      const persisted = await this.loadJournalLines(transaction, entryId);
      if (persisted.length > 0) {
        return persisted;
      }
      return data.map((row, index) => this.syntheticLine(row, entryId, index));
    }

    if (transaction.$executeRawUnsafe) {
      const placeholders = data.map(() => "(?, ?, ?, ?)").join(", ");
      const params: unknown[] = [];
      for (const row of data) {
        params.push(entryId, row.glAccountId, row.direction, decimal(row.amount as DecimalInput).toFixed(4));
      }
      await transaction.$executeRawUnsafe(
        `INSERT INTO \`journal_lines\` (\`entry_id\`, \`gl_account_id\`, \`direction\`, \`amount\`) VALUES ${placeholders}`,
        ...params,
      );
      const persisted = await this.loadJournalLines(transaction, entryId);
      if (persisted.length > 0) {
        return persisted;
      }
    }

    if (journalLine.create) {
      const lines: JournalLineRecord[] = [];
      for (const row of data) {
        const created = await journalLine.create({ data: row });
        lines.push(this.normalizeLine(created, row, entryId));
      }
      return lines;
    }

    return data.map((row, index) => this.syntheticLine(row, entryId, index));
  }

  private async loadJournalLines(
    transaction: LedgerPrismaClient,
    entryId: string,
  ): Promise<JournalLineRecord[]> {
    const journalLine = transaction.journalLine;
    if (journalLine.findMany) {
      const rows = await journalLine.findMany({
        where: { entryId },
        orderBy: { id: "asc" },
        select: {
          id: true,
          entryId: true,
          glAccountId: true,
          direction: true,
          amount: true,
          createdAt: true,
        },
      });
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => {
          const source = row as unknown as Record<string, unknown>;
          const rowEntryId = source.entryId ?? source.entry_id;
          return rowEntryId === undefined || String(rowEntryId) === entryId;
        })
        .map((row, index) => this.normalizeLine(row, { id: index + 1 }, entryId));
    }
    if (transaction.$queryRawUnsafe) {
      const rows = await transaction.$queryRawUnsafe(
        "SELECT `id`, `entry_id`, `gl_account_id`, `direction`, `amount`, `created_at` FROM `journal_lines` WHERE `entry_id` = ? ORDER BY `id` ASC",
        entryId,
      );
      return (Array.isArray(rows) ? rows : []).map((row, index) => this.normalizeLine(row, { id: index + 1 }, entryId));
    }
    return [];
  }

  private normalizeLine(
    row: JournalLineRecord | Record<string, unknown>,
    fallback: Record<string, unknown>,
    entryId: string,
  ): JournalLineRecord {
    const source = row as Record<string, unknown>;
    const rawId = source.id ?? fallback.id;
    return {
      id: rawId === undefined || rawId === null ? "" : String(rawId),
      entryId: String(source.entryId ?? source.entry_id ?? fallback.entryId ?? entryId),
      glAccountId: String(source.glAccountId ?? source.gl_account_id ?? fallback.glAccountId ?? ""),
      direction: String(source.direction ?? fallback.direction ?? "DEBIT") as LedgerDirection,
      amount: decimal((source.amount ?? fallback.amount ?? 0) as DecimalInput),
      createdAt: (source.createdAt ?? source.created_at ?? fallback.createdAt) as Date | undefined,
    };
  }

  private syntheticLine(
    row: Record<string, unknown>,
    entryId: string,
    index: number,
  ): JournalLineRecord {
    return {
      id: String(index + 1),
      entryId,
      glAccountId: String(row.glAccountId ?? ""),
      direction: String(row.direction ?? "DEBIT") as LedgerDirection,
      amount: decimal((row.amount ?? 0) as DecimalInput),
    };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "UNIQUE_CONSTRAINT_VIOLATION";
}
