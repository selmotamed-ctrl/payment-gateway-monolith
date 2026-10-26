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
}

export interface LedgerPrismaClient {
  glAccount: {
    findFirst(args: { where: Record<string, unknown>; select?: Record<string, boolean> }): Promise<LedgerAccountRecord | null>;
    findUnique?(args: { where: { id: string } }): Promise<LedgerAccountRecord | null>;
  };
  journalEntry: {
    findFirst(args: { where: Record<string, unknown> }): Promise<JournalEntryRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<JournalEntryRecord>;
  };
  journalLine: {
    create(args: { data: Record<string, unknown> }): Promise<JournalLineRecord>;
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
  | "CHARGEBACK_INSUFFICIENT";

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
    : requirePositive(input.commissionAmount, "Commission amount");
  const providerFee = input.providerFeeAmount === undefined
    ? new Decimal("1")
    : requireNonNegative(input.providerFeeAmount, "Provider fee amount");
  const gatewayFee = input.gatewayFeeAmount === undefined
    ? new Decimal("0.8")
    : requireNonNegative(input.gatewayFeeAmount, "Gateway fee amount");
  const merchantAmount = input.merchantAmount === undefined
    ? amount.minus(commission)
    : requirePositive(input.merchantAmount, "Merchant amount");
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
          { direction: "CREDIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
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
          { direction: "CREDIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
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
          { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
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
          { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
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
            { direction: "DEBIT", amount: commission, account: account("MERCHANT_WALLET") },
            { direction: "CREDIT", amount: commission, account: account("COMMISSION_RECEIVABLE") },
          ],
        };
      }
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "Merchant-owned direct settlement commission recognition",
        lines: [
          { direction: "DEBIT", amount: commission, account: account("COMMISSION_RECEIVABLE") },
          { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
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
            { direction: "CREDIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
            { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
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
          { direction: "DEBIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          { direction: "DEBIT", amount: commission, account: account("PLATFORM_INCOME") },
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
          { direction: "DEBIT", amount: commission, account: account("PLATFORM_INCOME") },
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
          { direction: "CREDIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
        ],
      };
    case "INTERNAL_CONFIRMATION":
      return {
        refType: "PAYMENT_ATTEMPT",
        refId: reference,
        description: "NeomPay internal confirmation under INTERNAL-1",
        lines: [
          { direction: "DEBIT", amount, account: account("TREASURY") },
          { direction: "CREDIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          { direction: "CREDIT", amount: commission, account: account("PLATFORM_INCOME") },
        ],
      };
    case "INTERNAL_REFUND":
      return {
        refType: "ADJUSTMENT",
        refId: reference,
        description: "NeomPay internal refund",
        lines: [
          { direction: "DEBIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          { direction: "DEBIT", amount: commission, account: account("PLATFORM_INCOME") },
          { direction: "CREDIT", amount, account: account("TREASURY") },
        ],
      };
    case "CHARGEBACK_INSUFFICIENT":
      return {
        refType: "DISPUTE_OUTCOME",
        refId: reference,
        description: "Chargeback against insufficient merchant wallet",
        lines: [
          { direction: "DEBIT", amount: merchantAmount, account: account("MERCHANT_WALLET") },
          { direction: "DEBIT", amount: commission, account: account("PLATFORM_INCOME") },
          { direction: "CREDIT", amount, account: account("CHARGEBACK_RESERVE") },
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

  async post(
    template: JournalTemplate,
    context: LedgerPostContext = {},
  ): Promise<LedgerPostResult> {
    this.validateTemplate(template);
    return this.transactionRunner(async (transaction) => {
      const existing = await transaction.journalEntry.findFirst({
        where: { refType: template.refType, refId: template.refId },
      });
      if (existing) {
        return { entry: existing, lines: [], created: false, idempotent: true };
      }
      let entry: JournalEntryRecord;
      try {
        entry = await transaction.journalEntry.create({
          data: {
            refType: template.refType,
            refId: template.refId,
            description: template.description,
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const raced = await transaction.journalEntry.findFirst({
            where: { refType: template.refType, refId: template.refId },
          });
          if (raced) {
            return { entry: raced, lines: [], created: false, idempotent: true };
          }
        }
        throw error;
      }
      const lines: JournalLineRecord[] = [];
      for (const line of template.lines) {
        const accountId = await this.resolveAccountId(transaction, line.account, context);
        const created = await transaction.journalLine.create({
          data: {
            entryId: entry.id,
            glAccountId: accountId,
            direction: line.direction,
            amount: decimal(line.amount),
          },
        });
        lines.push(created);
      }
      return { entry, lines, created: true, idempotent: false };
    });
  }

  async postScenario(
    scenario: LedgerScenario,
    refId: string,
    input: LedgerScenarioInput,
    context: LedgerPostContext = {},
  ): Promise<LedgerPostResult> {
    const template = buildLedgerTemplate(scenario, input);
    template.refId = refId;
    return this.post(template, context);
  }

  async postPaymentConfirmation(
    refId: string,
    input: PaymentConfirmationInput,
    context: LedgerPostContext = {},
  ): Promise<LedgerPostResult> {
    const template = buildPaymentConfirmationTemplate(input);
    template.refId = refId;
    return this.post(template, context);
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
    const ownerId = selector.ownerId ?? context.merchantId;
    const gatewayId = selector.gatewayId ?? context.gatewayId;
    const credentialSetId = selector.credentialSetId ?? context.credentialSetId;
    const env = selector.env ?? context.env;
    const currency = selector.currency ?? context.currency;
    const record = await transaction.glAccount.findFirst({
      where: {
        accountType: selector.accountType,
        ...(ownerId ? { ownerId: ownerId } : {}),
        ...(gatewayId ? { gatewayId: gatewayId } : {}),
        ...(credentialSetId ? { credentialSetId: credentialSetId } : {}),
        ...(env ? { env } : {}),
        ...(currency ? { currency } : {}),
      },
      select: { id: true },
    });
    if (!record) {
      throw moneyError("GL_ACCOUNT_NOT_FOUND", `No ${selector.accountType} account matched the posting context`);
    }
    return record.id;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2002" || code === "UNIQUE_CONSTRAINT_VIOLATION";
}
