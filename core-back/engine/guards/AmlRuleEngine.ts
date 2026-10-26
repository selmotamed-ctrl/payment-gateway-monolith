import { moneyFromDecimal, type Money } from "../db/money";
import type {
  AmlAction,
  AmlRuleRow,
  AmlRuleType,
  RiskRepository,
  Severity,
  SettlementTarget,
  Tx,
} from "../db/ports";
import type { ScreeningListType, ScreeningResultCode } from "./ScreeningProvider";

export interface AmlRuleDefinition {
  id: string;
  code: string;
  name: string;
  ruleType: AmlRuleType;
  scope: Record<string, unknown>;
  params: Record<string, unknown>;
  action: AmlAction;
  baseSeverity: Severity;
  active: boolean;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface AmlWindowStats {
  count: number;
  totalAmount: Money;
  amounts: Money[];
}

export interface AmlEvaluationContext {
  subjectType: "MERCHANT" | "END_CLIENT" | "PAYMENT_ATTEMPT";
  subjectId: string;
  merchantId: string;
  amount: Money;
  currency: string;
  railCode: string | null;
  riskTier: "LOW" | "STANDARD" | "HIGH";
  settlementTarget: SettlementTarget;
  counterpartyCountry: string | null;
  windowStats: AmlWindowStats;
  expectedMonthlyVolume: Money | null;
  openCaseCount: number;
  velocityFlagged: boolean;
  screeningResult: ScreeningResultCode | null;
  screeningListType: ScreeningListType | null;
  now: Date;
}

export interface AmlRuleHit {
  ruleId: string;
  ruleCode: string;
  ruleName: string;
  ruleVersion: number;
  ruleType: AmlRuleType;
  action: AmlAction;
  severity: Severity;
  reason: string;
  details: Record<string, unknown>;
}

export interface SeverityInput {
  source: string;
  effect: string;
  from: Severity | null;
  to: Severity;
}

export interface AmlEvaluationResult {
  hits: AmlRuleHit[];
  action: AmlAction | null;
  effectiveAction: AmlAction | null;
  severity: Severity | null;
  severityInputs: SeverityInput[];
  correlatedEscalation: boolean;
  requiresCase: boolean;
  requiresHold: boolean;
  blocks: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const RISK_TIER_ORDER: Record<"LOW" | "STANDARD" | "HIGH", number> = { LOW: 0, STANDARD: 1, HIGH: 2 };
const ACTION_ORDER: Record<AmlAction, number> = { FLAG: 0, CASE_ONLY: 1, HOLD: 2, BLOCK: 3 };

export const raiseSeverity = (severity: Severity, steps = 1): Severity => {
  const index = Math.min(SEVERITY_ORDER[severity] + steps, SEVERITY_ORDER.CRITICAL);
  return (Object.keys(SEVERITY_ORDER) as Severity[]).find((key) => SEVERITY_ORDER[key] === index) ?? "CRITICAL";
};

export const maxSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b);

export const slaHoursForSeverity = (severity: Severity): number => {
  switch (severity) {
    case "CRITICAL":
      return 4;
    case "HIGH":
      return 24;
    case "MEDIUM":
      return 72;
    default:
      return 120;
  }
};

export const slaDueAt = (severity: Severity, from: Date): Date =>
  new Date(from.getTime() + slaHoursForSeverity(severity) * 60 * 60 * 1000);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const paramMoney = (params: Record<string, unknown>, key: string): Money | null => {
  const raw = params[key];
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return moneyFromDecimal(raw);
  } catch {
    return null;
  }
};

const paramNumber = (params: Record<string, unknown>, key: string, fallback: number): number => {
  const raw = params[key];
  if (raw === null || raw === undefined || raw === "") return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const paramStrings = (params: Record<string, unknown>, key: string): string[] => {
  const raw = params[key];
  if (Array.isArray(raw)) return raw.map((entry) => String(entry).toUpperCase());
  if (typeof raw === "string" && raw.length > 0) return [raw.toUpperCase()];
  return [];
};

export const isRuleEffective = (rule: AmlRuleDefinition, now: Date): boolean => {
  if (!rule.active) return false;
  if (rule.effectiveFrom && rule.effectiveFrom.getTime() > now.getTime()) return false;
  if (rule.effectiveTo && rule.effectiveTo.getTime() <= now.getTime()) return false;
  return true;
};

export const toAmlRuleDefinition = (row: AmlRuleRow): AmlRuleDefinition => ({
  id: row.id,
  code: row.code,
  name: row.name,
  ruleType: row.ruleType,
  scope: asRecord(row.scope),
  params: asRecord(row.params),
  action: row.action,
  baseSeverity: row.baseSeverity,
  active: row.active,
  version: row.version,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
});

const evaluateRule = (
  rule: AmlRuleDefinition,
  context: AmlEvaluationContext,
): AmlRuleHit | null => {
  const params = rule.params;
  const base = {
    ruleId: rule.id,
    ruleCode: rule.code,
    ruleName: rule.name,
    ruleVersion: rule.version,
    ruleType: rule.ruleType,
    action: rule.action,
    severity: rule.baseSeverity,
  };
  switch (rule.ruleType) {
    case "SINGLE_AMOUNT": {
      const minAmount = paramMoney(params, "min_amount");
      const currency = typeof params.currency === "string" ? params.currency.toUpperCase() : null;
      if (minAmount === null) return null;
      if (currency && currency !== context.currency.toUpperCase()) return null;
      if (context.amount < minAmount) return null;
      return {
        ...base,
        reason: `Single amount ${context.currency} ${minAmount.toString()} threshold reached`,
        details: { min_amount: minAmount.toString(), amount: context.amount.toString(), currency: context.currency },
      };
    }
    case "CUMULATIVE_WINDOW": {
      const maxAmount = paramMoney(params, "max_amount");
      const maxCount = params.max_count === undefined || params.max_count === null ? null : paramNumber(params, "max_count", 0);
      const exceededAmount = maxAmount !== null && context.windowStats.totalAmount > maxAmount;
      const exceededCount = maxCount !== null && context.windowStats.count > maxCount;
      if (!exceededAmount && !exceededCount) return null;
      return {
        ...base,
        reason: "Cumulative window threshold exceeded",
        details: {
          window_seconds: paramNumber(params, "window_seconds", 0),
          observed_count: context.windowStats.count,
          observed_amount: context.windowStats.totalAmount.toString(),
          max_count: maxCount,
          max_amount: maxAmount === null ? null : maxAmount.toString(),
        },
      };
    }
    case "STRUCTURING": {
      const threshold = paramMoney(params, "threshold");
      if (threshold === null) return null;
      const bandPercent = paramNumber(params, "band_percent", 10);
      const minCount = paramNumber(params, "min_count", 2);
      const lowerBound = (threshold * BigInt(Math.max(0, 100 - Math.floor(bandPercent)))) / 100n;
      const clustered = context.windowStats.amounts.filter((amount) => amount >= lowerBound && amount < threshold);
      if (clustered.length < minCount) return null;
      return {
        ...base,
        reason: "Structuring pattern detected: repeated amounts just below the reporting threshold",
        details: {
          threshold: threshold.toString(),
          band_percent: bandPercent,
          observed_count: clustered.length,
          min_count: minCount,
          window_seconds: paramNumber(params, "window_seconds", 0),
        },
      };
    }
    case "RISK_TIER": {
      const tier = typeof params.tier === "string" ? (params.tier.toUpperCase() as "LOW" | "STANDARD" | "HIGH") : null;
      if (!tier || !(tier in RISK_TIER_ORDER)) return null;
      const minAmount = paramMoney(params, "min_amount");
      if (minAmount !== null && context.amount < minAmount) return null;
      if (RISK_TIER_ORDER[context.riskTier] < RISK_TIER_ORDER[tier]) return null;
      return {
        ...base,
        reason: `Merchant risk tier ${context.riskTier} matched rule tier ${tier}`,
        details: { tier, min_amount: minAmount === null ? null : minAmount.toString(), amount: context.amount.toString() },
      };
    }
    case "COUNTERPARTY_COUNTRY": {
      const countries = paramStrings(params, "countries");
      const mode = typeof params.mode === "string" ? params.mode.toUpperCase() : "DENY";
      const country = context.counterpartyCountry ? context.counterpartyCountry.toUpperCase() : null;
      if (!country) return null;
      const listed = countries.includes(country);
      if (mode === "ALLOW") {
        if (listed) return null;
        return {
          ...base,
          reason: `Counterparty country ${country} is outside the allowed list`,
          details: { country, mode, countries },
        };
      }
      if (!listed) return null;
      return {
        ...base,
        reason: `Counterparty country ${country} is denied by rule`,
        details: { country, mode, countries },
      };
    }
    case "RAIL": {
      const railCodes = paramStrings(params, "rail_codes");
      if (railCodes.length === 0) return null;
      const rail = context.railCode ? context.railCode.toUpperCase() : null;
      if (!rail || !railCodes.includes(rail)) return null;
      const minAmount = paramMoney(params, "min_amount");
      if (minAmount !== null && context.amount < minAmount) return null;
      return {
        ...base,
        reason: `Rail ${rail} matched a rail specific AML rule`,
        details: { rail, min_amount: minAmount === null ? null : minAmount.toString() },
      };
    }
    case "MERCHANT_DIRECT_AMOUNT": {
      const minAmount = paramMoney(params, "min_amount");
      if (minAmount === null) return null;
      if (context.settlementTarget !== "MERCHANT_DIRECT") return null;
      if (context.amount < minAmount) return null;
      return {
        ...base,
        action: "CASE_ONLY",
        reason: "Merchant direct settlement threshold reached; platform holds no cash",
        details: { min_amount: minAmount.toString(), amount: context.amount.toString() },
      };
    }
    default:
      return null;
  }
};

export const resolveEffectiveAction = (hits: AmlRuleHit[], settlementTarget: SettlementTarget): AmlAction | null => {
  if (hits.length === 0) return null;
  let action: AmlAction | null = null;
  for (const hit of hits) {
    if (action === null || ACTION_ORDER[hit.action] > ACTION_ORDER[action]) {
      action = hit.action;
    }
  }
  if (action === null) return null;
  if (action === "HOLD" && settlementTarget === "MERCHANT_DIRECT") {
    return "CASE_ONLY";
  }
  return action;
};

export const evaluateAmlRules = (
  rules: AmlRuleDefinition[],
  context: AmlEvaluationContext,
): AmlEvaluationResult => {
  const effectiveRules = rules.filter((rule) => isRuleEffective(rule, context.now));
  const hits: AmlRuleHit[] = [];
  for (const rule of effectiveRules) {
    const hit = evaluateRule(rule, context);
    if (hit) hits.push(hit);
  }

  const severityInputs: SeverityInput[] = [];
  let severity: Severity | null = hits.length > 0 ? "LOW" : null;
  for (const hit of hits) {
    severity = severity === null ? hit.severity : maxSeverity(severity, hit.severity);
  }

  const correlatedEscalation = context.velocityFlagged && hits.length > 0;
  if (correlatedEscalation && severity) {
    severityInputs.push({
      source: "VELOCITY_FLAG_CORRELATION",
      effect: "Velocity FLAG correlated with an AML rule hit",
      from: severity,
      to: "CRITICAL",
    });
    severity = "CRITICAL";
  }

  if (severity && context.riskTier === "HIGH") {
    const raised = raiseSeverity(severity);
    if (raised !== severity) {
      severityInputs.push({ source: "MERCHANT_RISK_TIER_HIGH", effect: "Merchant risk tier HIGH", from: severity, to: raised });
      severity = raised;
    }
  }

  const volumeMultiple = 3;
  if (severity && context.expectedMonthlyVolume !== null && context.expectedMonthlyVolume > 0n) {
    const threshold = context.expectedMonthlyVolume * BigInt(volumeMultiple);
    if (context.amount > threshold) {
      const raised = raiseSeverity(severity);
      severityInputs.push({
        source: "VOLUME_MULTIPLE_EXCEEDED",
        effect: `Amount exceeds ${volumeMultiple}x declared expected monthly volume`,
        from: severity,
        to: raised,
      });
      severity = raised;
    }
  }

  if (severity && context.openCaseCount > 0) {
    const raised = raiseSeverity(severity);
    severityInputs.push({
      source: "OPEN_CASE_EXISTS",
      effect: "Subject already has an open compliance case",
      from: severity,
      to: raised,
    });
    severity = raised;
  }

  if (severity && context.screeningResult === "CONFIRMED_MATCH" && context.screeningListType === "SANCTIONS") {
    severityInputs.push({
      source: "SCREENING_CONFIRMED_SANCTIONS",
      effect: "Confirmed sanctions match",
      from: severity,
      to: "CRITICAL",
    });
    severity = "CRITICAL";
  }

  if (severity && context.screeningResult === "POTENTIAL_MATCH" && context.screeningListType === "PEP") {
    if (SEVERITY_ORDER[severity] < SEVERITY_ORDER.HIGH) {
      severityInputs.push({
        source: "SCREENING_POTENTIAL_PEP",
        effect: "Potential PEP match",
        from: severity,
        to: "HIGH",
      });
      severity = "HIGH";
    }
  }

  const action = hits.length > 0 ? resolveEffectiveAction(hits, context.settlementTarget) : null;
  return {
    hits,
    action,
    effectiveAction: action,
    severity,
    severityInputs,
    correlatedEscalation,
    requiresCase: hits.length > 0,
    requiresHold: action === "HOLD",
    blocks: action === "BLOCK",
  };
};

export interface AmlRuleEngineDeps {
  risk: RiskRepository;
  tx: Tx;
  clock?: () => Date;
}

export class AmlRuleEngine {
  private readonly risk: RiskRepository;
  private readonly tx: Tx;
  private readonly clock: () => Date;

  constructor(deps: AmlRuleEngineDeps) {
    this.risk = deps.risk;
    this.tx = deps.tx;
    this.clock = deps.clock ?? (() => new Date());
  }

  async loadRules(): Promise<AmlRuleDefinition[]> {
    const rows = await this.risk.listActiveAmlRules(this.tx);
    return rows.map(toAmlRuleDefinition);
  }

  async evaluate(context: AmlEvaluationContext): Promise<AmlEvaluationResult> {
    const rules = await this.loadRules();
    return evaluateAmlRules(rules, { ...context, now: context.now ?? this.clock() });
  }
}
