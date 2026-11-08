/**
 * Governance helpers shared by the wallet, application, POS and payment-link
 * surfaces (contract section 1): a MORE restrictive state is immediate and
 * needs a reason of at least 10 characters; a LESS restrictive state (or a
 * change of what an entity may accept) is submitted as an approval request and
 * the API answers HTTP 202. Pure functions only, so they are unit-testable.
 */

/** Matches `COMMERCE_REASON_MIN_LENGTH` in core-back/api/internal/adminCommerce.ts. */
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 500;

export type GovernanceMode = "immediate" | "approval";

export type ReasonProblem = "required" | "too_short" | "too_long";

export const reasonProblem = (reason: string | null | undefined): ReasonProblem | null => {
    const value = (reason ?? "").trim();
    if (value.length === 0) return "required";
    if (value.length < REASON_MIN_LENGTH) return "too_short";
    if (value.length > REASON_MAX_LENGTH) return "too_long";
    return null;
};

export const isReasonValid = (reason: string | null | undefined): boolean => reasonProblem(reason) === null;

/** English message keys (all catalogued in `constants/i18n/commerce.ts`). */
export const reasonProblemMessage = (problem: ReasonProblem | null): string => {
    if (problem === "required") return "A reason is required";
    if (problem === "too_short") return "The reason must be at least 10 characters";
    if (problem === "too_long") return "The reason must be at most 500 characters";
    return "";
};

export type MutationOutcome =
    | { kind: "applied" }
    | { kind: "approval"; approvalRequestId: string | null; state: string | null };

/**
 * HTTP 202 means "submitted for four-eyes approval": the change has NOT been
 * applied. Anything else that succeeded was applied immediately.
 */
export const outcomeOfResponse = (status: number, data: unknown): MutationOutcome => {
    if (status !== 202) return { kind: "applied" };
    const body = (data && typeof data === "object" ? ((data as { data?: unknown }).data ?? data) : {}) as Record<string, unknown>;
    return {
        kind: "approval",
        approvalRequestId: typeof body.approvalRequestId === "string" ? body.approvalRequestId : null,
        state: typeof body.state === "string" ? body.state : null,
    };
};

/** Friendly hints for the stable error codes of the commerce endpoints. */
export const COMMERCE_ERROR_HINTS: Record<string, string> = {
    WALLET_INVALID_TRANSITION: "The wallet is not in a state that allows this change. Refresh and try again.",
    WALLET_APPROVAL_PENDING: "A change to this wallet is already awaiting approval.",
    WALLET_NOT_ACTIVE: "The wallet must be active for this change.",
    APPLICATION_SUSPEND_MUST_BE_ALONE: "Suspending is immediate and cannot be combined with a configuration change.",
    APPLICATION_INVALID_TRANSITION: "The application is not in a state that allows this change. Refresh and try again.",
    APPLICATION_NO_CHANGE: "Nothing changed: the request matches the current configuration.",
    APPLICATION_APPROVAL_PENDING: "A change to this application is already awaiting approval.",
    RAIL_NOT_FOUND: "One of the selected rails no longer exists.",
    REDIRECT_DOMAIN_INVALID: "A redirect domain must be a hostname or an https origin without a path.",
    WALLET_CURRENCY_MISMATCH: "The new wallet must use the same currency as the current one.",
    TOKEN_ALREADY_REVOKED: "This access token is already revoked.",
    PAYMENT_LINK_INVALID_TRANSITION: "Only a pending payment link can be cancelled.",
    POS_TERMINAL_INVALID_TRANSITION: "The POS terminal is not in a state that allows this change.",
    POS_TERMINAL_APPROVAL_PENDING: "A change to this POS terminal is already awaiting approval.",
    OWNERSHIP_PERCENT_EXCEEDED: "The active beneficial owners cannot hold more than 100 percent in total.",
    KYB_REVALIDATION_ALREADY_OPEN: "A revalidation request is already open for this document type.",
    KYB_REVALIDATION_DUE_IN_PAST: "The due date must be in the future.",
    BENEFICIAL_OWNER_INACTIVE: "A deactivated beneficial owner cannot be edited.",
    MERCHANT_CLOSED: "A closed merchant cannot be changed.",
};

export const errorCodeOf = (error: unknown): string | null => {
    const source = error as {
        code?: unknown;
        response?: { data?: { code?: unknown; CODE?: unknown } };
    } | null;
    const fromResponse = source?.response?.data?.code ?? source?.response?.data?.CODE;
    const code = typeof fromResponse === "string" ? fromResponse : typeof source?.code === "string" ? source.code : null;
    return code && code.length > 0 ? code : null;
};

/** Message key for a known error code, or null when the server message should be shown. */
export const errorHintFor = (error: unknown): string | null => {
    const code = errorCodeOf(error);
    return code ? COMMERCE_ERROR_HINTS[code] ?? null : null;
};

/** "Restricted" placeholder rule: a field is restricted when the server lists it (or sent null). */
export const isRestricted = (redactedFields: readonly string[] | null | undefined, field: string, value?: unknown): boolean =>
    (redactedFields ?? []).includes(field) || value === null;
