/**
 * Pure, framework-free model for the public merchant landing page.
 *
 * Everything here is deterministic so it can be unit-tested with `bun test`
 * (see `src/content/__tests__/landing-content.test.ts`) and so the landing
 * components stay presentational. Money arithmetic uses decimal.js through
 * `@/utils/money`; never floating point.
 */
import Decimal from "decimal.js";
import { toDecimal } from "../../utils/money";

/* -------------------------------------------------------------------------- */
/* Fee-bearer preview (mirrors MerchantFeeCalculator and the M-04 chapter)    */
/* -------------------------------------------------------------------------- */

export type LandingFeeBearer = "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";

export const LANDING_FEE_BEARERS: LandingFeeBearer[] = ["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"];

export type LandingFeeResult = {
    /** What the payer is charged on the hosted checkout. */
    customerTotal: Decimal;
    /** Platform commission for the attempt. */
    commission: Decimal;
    /** Portion of the commission paid by the payer (surcharge / split). */
    payerShare: Decimal;
    /** Exact credit to the merchant wallet. */
    netToWallet: Decimal;
};

const LYD_DP = 3;

const clampPercent = (value: Decimal, max: number): Decimal => {
    if (value.isNaN() || value.isNegative()) return new Decimal(0);
    if (value.greaterThan(max)) return new Decimal(max);
    return value;
};

/**
 * Same formulas as `components/guide/MerchantFeeCalculator.tsx` and guide chapter M-04:
 * - MERCHANT_ABSORBS: customer pays amount, wallet gets amount − commission.
 * - PAYER_SURCHARGE: customer pays amount + commission, wallet gets amount.
 * - SPLIT: payer covers `payerSharePercent`% of the commission.
 * Results are rounded half-up to LYD's 3 decimal places for display.
 */
export const computeLandingFees = (input: {
    amount: string;
    commissionPercent: string;
    feeBearer: LandingFeeBearer;
    payerSharePercent?: string;
}): LandingFeeResult => {
    const rawAmount = toDecimal(input.amount);
    const amount = rawAmount.isNaN() || rawAmount.isNegative() ? new Decimal(0) : rawAmount;
    const rate = clampPercent(toDecimal(input.commissionPercent), 100);
    const share = clampPercent(toDecimal(input.payerSharePercent ?? "50"), 100);
    const round = (value: Decimal) => value.toDecimalPlaces(LYD_DP, Decimal.ROUND_HALF_UP);

    const commission = round(amount.times(rate).dividedBy(100));
    let payerShare = new Decimal(0);
    if (input.feeBearer === "PAYER_SURCHARGE") {
        payerShare = commission;
    } else if (input.feeBearer === "SPLIT") {
        payerShare = round(commission.times(share).dividedBy(100));
    }
    const customerTotal = amount.plus(payerShare);
    const netToWallet = amount.minus(commission.minus(payerShare));
    return { customerTotal, commission, payerShare, netToWallet };
};

/* -------------------------------------------------------------------------- */
/* Hero simulator: one payment link travelling through a rail to the ledger   */
/* -------------------------------------------------------------------------- */

/**
 * The five client actions the checkout renders (core-back RENDER step:
 * SHOW_OTP_FORM, SHOW_QR_OR_CODE, HTTP_REDIRECT, SHOW_PUSH_OR_TRANSFER, RENDER_EMBEDDED).
 */
export type LandingRailMode = "OTP" | "QR" | "REDIRECT" | "PUSH" | "CARD";

export const LANDING_RAIL_MODES: { mode: LandingRailMode; label: string; icon: string; action: string }[] = [
    { mode: "OTP", label: "One-time code", icon: "mdi-cellphone-message", action: "SHOW_OTP_FORM" },
    { mode: "QR", label: "Scan QR", icon: "mdi-qrcode-scan", action: "SHOW_QR_OR_CODE" },
    { mode: "PUSH", label: "Approve in app", icon: "mdi-gesture-tap-button", action: "SHOW_PUSH_OR_TRANSFER" },
    { mode: "REDIRECT", label: "Bank redirect", icon: "mdi-open-in-new", action: "HTTP_REDIRECT" },
    { mode: "CARD", label: "Card form", icon: "mdi-credit-card-outline", action: "RENDER_EMBEDDED" },
];

/** Attempt statuses used by the simulator, in order. They are real core-back statuses. */
export type LandingDemoStatus = "AWAITING_CUSTOMER" | "VERIFYING" | "SUCCEEDED";

export type LandingDemoStep = {
    index: number;
    status: LandingDemoStatus;
    /** Catalogue key describing what is happening. */
    caption: string;
    /** Milliseconds to hold this step during autoplay. */
    holdMs: number;
};

export const LANDING_DEMO_STEPS: LandingDemoStep[] = [
    { index: 0, status: "AWAITING_CUSTOMER", caption: "Payer opens your link and picks a rail", holdMs: 1900 },
    { index: 1, status: "AWAITING_CUSTOMER", caption: "The rail asks the payer to act", holdMs: 2300 },
    { index: 2, status: "VERIFYING", caption: "The gateway verifies with the provider", holdMs: 1700 },
    { index: 3, status: "SUCCEEDED", caption: "Trusted success: confirmed server-side", holdMs: 1600 },
    { index: 4, status: "SUCCEEDED", caption: "Double-entry journal posted, wallet credited", holdMs: 3600 },
];

export const LANDING_DEMO_AMOUNT = "250.000";
export const LANDING_DEMO_COMMISSION_PERCENT = "2.5";

export type LandingJournalLine = {
    account: "GATEWAY_CLEARING" | "MERCHANT_WALLET" | "PLATFORM_INCOME";
    side: "DR" | "CR";
    amount: Decimal;
};

/**
 * Illustrative PLATFORM_CLEARING confirmation journal (merchant absorbs the fee).
 * Gateway/provider fee lines are omitted for clarity; the demo labels it as illustrative.
 */
export const landingDemoJournal = (): LandingJournalLine[] => {
    const fees = computeLandingFees({
        amount: LANDING_DEMO_AMOUNT,
        commissionPercent: LANDING_DEMO_COMMISSION_PERCENT,
        feeBearer: "MERCHANT_ABSORBS",
    });
    return [
        { account: "GATEWAY_CLEARING", side: "DR", amount: fees.customerTotal },
        { account: "MERCHANT_WALLET", side: "CR", amount: fees.netToWallet },
        { account: "PLATFORM_INCOME", side: "CR", amount: fees.commission },
    ];
};

export const journalImbalance = (lines: LandingJournalLine[]): Decimal =>
    lines.reduce(
        (total, line) => (line.side === "DR" ? total.plus(line.amount) : total.minus(line.amount)),
        new Decimal(0),
    );

/** Next step index for autoplay; wraps to 0 after the last step. */
export const nextDemoStep = (index: number): number => (index + 1) % LANDING_DEMO_STEPS.length;

/* -------------------------------------------------------------------------- */
/* Developer snippet: matches core-back linkCreateSchema (strict)             */
/* -------------------------------------------------------------------------- */

export type LandingSnippetLanguage = "curl" | "typescript" | "python";

/**
 * Field names here MUST stay inside core-back `linkCreateSchema` (it is `.strict()`):
 * title (required), amount, currency, applicationId and maxUses are all accepted.
 */
export const LANDING_SNIPPET_REQUEST_FIELDS = ["title", "amount", "currency", "applicationId", "maxUses"];

export const LANDING_SNIPPETS: Record<LandingSnippetLanguage, string> = {
    curl: `curl -X POST https://merchant.example.ly/api/v1/external/links \\
  -H "Authorization: Bearer $PG_LIVE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Order #4092",
    "amount": "250.000",
    "currency": "LYD",
    "applicationId": "$PG_APPLICATION_ID",
    "maxUses": 1
  }'`,
    typescript: `const res = await fetch(\`\${PG_BASE}/api/v1/external/links\`, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.PG_LIVE_TOKEN}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: "Order #4092",
    amount: "250.000", // decimal string, never a float
    currency: "LYD",
    applicationId: process.env.PG_APPLICATION_ID,
    maxUses: 1,
  }),
});
const link = await res.json(); // { key, amount, state, visibleRails }`,
    python: `res = httpx.post(
    f"{PG_BASE}/api/v1/external/links",
    headers={"Authorization": f"Bearer {os.environ['PG_LIVE_TOKEN']}"},
    json={
        "title": "Order #4092",
        "amount": "250.000",  # decimal string, never a float
        "currency": "LYD",
        "applicationId": os.environ["PG_APPLICATION_ID"],
        "maxUses": 1,
    },
)
link = res.json()  # { key, amount, state, visibleRails }`,
};

/** Shape of the real `201` body returned by core-back for `POST /external/links`. */
export const LANDING_SNIPPET_RESPONSE = `{
  "key": "lnk_…",
  "amount": "250.0000",
  "currency": "LYD",
  "feeBearer": "MERCHANT_ABSORBS",
  "state": "PENDING",
  "visibleRails": ["…"],
  "excludedRails": []
}`;

/* -------------------------------------------------------------------------- */
/* Ledger ticker arithmetic (BigInt; no floating point touches a money value) */
/* -------------------------------------------------------------------------- */
const SCALE = 10_000n;
/** Opening value of the decorative ledger ticker: 1,284,903.4210 (count of 1/10,000). */
export const LEDGER_START = 12_849_034_210n;

/** Formats a count of 1/10,000 as `1,284,903.4210` (LTR digits, grouped). */
export const formatScaled = (value: bigint): string => {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const whole = (abs / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const fraction = (abs % SCALE).toString().padStart(4, "0");
    return `${negative ? "-" : ""}${whole}.${fraction}`;
};

/** Deterministic next amount (120.0000 – 9,800.0000) from a tiny LCG. */
export const nextAmount = (seed: number): { amount: bigint; seed: number } => {
    const nextSeed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const amount = 1_200_000n + BigInt(nextSeed % 96_800_000);
    return { amount, seed: nextSeed };
};
