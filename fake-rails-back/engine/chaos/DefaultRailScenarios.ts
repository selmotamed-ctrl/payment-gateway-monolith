/**
 * The 20 emulated rails and the default (healthy) chaos baseline.
 *
 * A freshly started service is 100% healthy on every rail. The tester raises
 * the failure chance from the portal; the baseline is persisted in SQLite so
 * it survives a restart.
 */

export type FailureMode =
  | "TERMINAL_DECLINE_INSUFFICIENT_FUNDS"
  | "LIMIT_EXCEEDED_CUSTOMER_CEILING"
  | "WRONG_OTP_RETRYABLE"
  | "HTTP_500_GATEWAY_FAULT"
  | "TIMEOUT_HANG_ABOVE_STEP_TTL"
  | "SOCKET_RESET_MID_STREAM"
  | "MALFORMED_OR_UNMAPPED_200_BODY"
  | "RATE_LIMIT_HTTP_429"
  | "AMOUNT_ROUNDING_MISMATCH"
  | "CONFLICTING_WEBHOOK_VS_INQUIRY";

export type FailPhase = "INITIATE" | "SUBMIT" | "VERIFY" | "WEBHOOK" | "REFUND";

export interface RailChaosScenarioConfig {
  railCode: string;
  gatewayCode: string;
  enabled: boolean;
  overallFailureChancePercent: number;
  phaseBreakdown: {
    initiateFailWeight: number;
    submitFailWeight: number;
    verifyFailWeight: number;
    webhookFailWeight: number;
    refundFailWeight: number;
  };
  failureModeWeights: Record<FailureMode, number>;
  latencyMs: { min: number; max: number };
  autoApproveAsyncAfterSec: number | null;
  webhookBehavior: {
    delaySeconds: number;
    duplicateCount: number;
    outOfOrderPendingAfterPaid: boolean;
    corruptSignatureChancePercent: number;
  };
}

export interface RailDescriptor {
  railCode: string;
  gatewayCode: string;
  name: string;
  collectionModes: string[];
  aliases: string[];
  defaultOtp: string;
  otpLength: number;
}

export const FAILURE_MODES: FailureMode[] = [
  "TERMINAL_DECLINE_INSUFFICIENT_FUNDS",
  "LIMIT_EXCEEDED_CUSTOMER_CEILING",
  "WRONG_OTP_RETRYABLE",
  "HTTP_500_GATEWAY_FAULT",
  "TIMEOUT_HANG_ABOVE_STEP_TTL",
  "SOCKET_RESET_MID_STREAM",
  "MALFORMED_OR_UNMAPPED_200_BODY",
  "RATE_LIMIT_HTTP_429",
  "AMOUNT_ROUNDING_MISMATCH",
  "CONFLICTING_WEBHOOK_VS_INQUIRY",
];

export const RAIL_DESCRIPTORS: RailDescriptor[] = [
  { railCode: "edfali", gatewayCode: "edfali", name: "Edfali", collectionModes: ["OTP_PULL"], aliases: ["edfali"], defaultOtp: "1234", otpLength: 4 },
  { railCode: "sadad", gatewayCode: "sadad", name: "Sadad", collectionModes: ["OTP_PULL"], aliases: ["sadad"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "mobicash", gatewayCode: "mobicash", name: "MobiCash", collectionModes: ["OTP_PULL", "QR_DISPLAY"], aliases: ["mobicash"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "moamalat", gatewayCode: "moamalat", name: "Moamalat NPG", collectionModes: ["EMBEDDED", "REDIRECT"], aliases: ["moamalat", "moamalat_card"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "ly_pay", gatewayCode: "cbl_lypay", name: "CBL LYPay", collectionModes: ["QR_DISPLAY", "PUSH_APPROVAL"], aliases: ["ly_pay", "lypay", "cbl_lypay"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "onepay", gatewayCode: "onepay", name: "OnePay", collectionModes: ["QR_DISPLAY", "PAY_CODE", "OTP_PULL"], aliases: ["onepay"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "tlync", gatewayCode: "tlync", name: "Tadawul T-LYNC", collectionModes: ["REDIRECT"], aliases: ["tlync"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "mypay", gatewayCode: "mypay", name: "MyPay", collectionModes: ["REDIRECT"], aliases: ["mypay"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "dpay", gatewayCode: "dpay", name: "DPay", collectionModes: ["REDIRECT", "OTP_PULL", "EMBEDDED"], aliases: ["dpay"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "plutu", gatewayCode: "plutu", name: "Plutu", collectionModes: ["OTP_PULL", "REDIRECT"], aliases: ["plutu"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "yussor_pay", gatewayCode: "yussor", name: "Yussor Pay", collectionModes: ["HYBRID", "OTP_PULL", "QR_DISPLAY", "PAY_CODE"], aliases: ["yussor_pay", "yussor"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "sahara_pay", gatewayCode: "sahara", name: "Sahara Pay", collectionModes: ["HYBRID", "OTP_PULL", "QR_DISPLAY", "PAY_CODE"], aliases: ["sahara_pay", "sahara"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "masrefy_pay", gatewayCode: "masrefy", name: "Masrefy Pay", collectionModes: ["HYBRID", "OTP_PULL", "QR_DISPLAY", "PAY_CODE"], aliases: ["masrefy_pay", "masrefy"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "hawelli", gatewayCode: "hawelli", name: "Hawelli", collectionModes: ["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"], aliases: ["hawelli"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "gpay_libya", gatewayCode: "gpay_libya", name: "GPay Libya", collectionModes: ["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"], aliases: ["gpay_libya", "gpay"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "numo_pay", gatewayCode: "numo_pay", name: "Numo Pay", collectionModes: ["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"], aliases: ["numo_pay", "numo"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "libyana", gatewayCode: "libyana", name: "Libyana", collectionModes: ["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"], aliases: ["libyana"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "mpgs", gatewayCode: "mpgs", name: "MPGS (Visa/Mastercard)", collectionModes: ["EMBEDDED", "REDIRECT"], aliases: ["mpgs"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "evopay", gatewayCode: "evo_pay", name: "Evo Pay", collectionModes: ["QR_DISPLAY", "PUSH_APPROVAL"], aliases: ["evopay", "evo_pay"], defaultOtp: "123456", otpLength: 6 },
  { railCode: "neompay", gatewayCode: "neompay", name: "NeomPay", collectionModes: ["HYBRID"], aliases: ["neompay", "neompay_wallet"], defaultOtp: "123456", otpLength: 6 },
];

const defaultWeights = (): Record<FailureMode, number> => ({
  TERMINAL_DECLINE_INSUFFICIENT_FUNDS: 18,
  LIMIT_EXCEEDED_CUSTOMER_CEILING: 8,
  WRONG_OTP_RETRYABLE: 12,
  HTTP_500_GATEWAY_FAULT: 14,
  TIMEOUT_HANG_ABOVE_STEP_TTL: 14,
  SOCKET_RESET_MID_STREAM: 8,
  MALFORMED_OR_UNMAPPED_200_BODY: 8,
  RATE_LIMIT_HTTP_429: 6,
  AMOUNT_ROUNDING_MISMATCH: 6,
  CONFLICTING_WEBHOOK_VS_INQUIRY: 6,
});

export const defaultScenario = (rail: RailDescriptor): RailChaosScenarioConfig => ({
  railCode: rail.railCode,
  gatewayCode: rail.gatewayCode,
  enabled: true,
  overallFailureChancePercent: 0,
  phaseBreakdown: {
    initiateFailWeight: 20,
    submitFailWeight: 40,
    verifyFailWeight: 15,
    webhookFailWeight: 15,
    refundFailWeight: 10,
  },
  failureModeWeights: defaultWeights(),
  latencyMs: { min: 40, max: 250 },
  autoApproveAsyncAfterSec: null,
  webhookBehavior: {
    delaySeconds: 0,
    duplicateCount: 1,
    outOfOrderPendingAfterPaid: false,
    corruptSignatureChancePercent: 0,
  },
});

export const DEFAULT_SCENARIOS: RailChaosScenarioConfig[] = RAIL_DESCRIPTORS.map(defaultScenario);

const aliasMap = new Map<string, RailDescriptor>();
for (const rail of RAIL_DESCRIPTORS) {
  for (const alias of rail.aliases) {
    aliasMap.set(alias.toLowerCase(), rail);
  }
  aliasMap.set(rail.railCode.toLowerCase(), rail);
  aliasMap.set(rail.gatewayCode.toLowerCase(), rail);
}

export const resolveRail = (code: string): RailDescriptor | undefined =>
  aliasMap.get(code.trim().toLowerCase());

export const canonicalRailCode = (code: string): string =>
  resolveRail(code)?.railCode ?? code.trim().toLowerCase();
