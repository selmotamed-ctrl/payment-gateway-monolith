/**
 * Pure decisions of the transaction lifecycle drawer: which quick actions the footer offers for an
 * attempt, and how the checkout retry group reads. The server stays the authority (it re-checks
 * every status and authority); this only avoids offering actions that can never apply.
 */

export type AttemptFooterAction = "inquire" | "adjustment" | "dispute";

/** Statuses in which a gateway status inquiry can still change the outcome. */
export const INQUIRABLE_STATUSES: readonly string[] = ["UNKNOWN", "VERIFYING"];
/** Statuses in which money was captured, so a refund/adjustment or a dispute can exist. */
export const CAPTURED_STATUSES: readonly string[] = ["SUCCEEDED", "PARTIALLY_REFUNDED", "DISPUTED"];
/** Statuses that count as a final failure of the attempt. */
export const FAILED_STATUSES: readonly string[] = ["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"];
export const IN_FLIGHT_STATUSES: readonly string[] = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"];

export const ATTEMPT_STATUSES: readonly string[] = [
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
];

export interface FooterActionInput {
    status: string | null | undefined;
    canInquire: boolean;
    canAdjust: boolean;
    canDispute: boolean;
    /** Server hint from the merchant list (`inquiryEligible`); only an explicit false hides the action. */
    inquiryEligible?: boolean | null;
}

export const footerActionsFor = (input: FooterActionInput): AttemptFooterAction[] => {
    const status = String(input.status ?? "").toUpperCase();
    const actions: AttemptFooterAction[] = [];
    if (input.canInquire && INQUIRABLE_STATUSES.includes(status) && input.inquiryEligible !== false) {
        actions.push("inquire");
    }
    if (input.canAdjust && CAPTURED_STATUSES.includes(status)) {
        actions.push("adjustment");
    }
    if (input.canDispute && CAPTURED_STATUSES.includes(status)) {
        actions.push("dispute");
    }
    return actions;
};

export type OutcomeGroup = "settled" | "inFlight" | "failed" | "other";

export const outcomeGroupOf = (status: string | null | undefined): OutcomeGroup => {
    const value = String(status ?? "").toUpperCase();
    if (value === "SUCCEEDED") return "settled";
    if (IN_FLIGHT_STATUSES.includes(value)) return "inFlight";
    if (FAILED_STATUSES.includes(value)) return "failed";
    return "other";
};

export interface RetryGroupAttempt {
    id: string;
    status: string;
    railId?: string | null;
    gatewayId?: string | null;
    requestedAmount?: string | null;
    createdAt: string;
}

export interface RetryGroupView {
    /** Attempts of the same payer on the same link, oldest first. */
    attempts: RetryGroupAttempt[];
    siblings: number;
    anySucceeded: boolean;
    /** The customer failed somewhere and paid on another attempt. */
    recoveredAfterFailure: boolean;
    currentIndex: number;
}

/** The API returns the group newest first; the timeline reads oldest first. */
export const buildRetryGroupView = (attempts: readonly RetryGroupAttempt[], currentId: string): RetryGroupView => {
    const ordered = [...attempts].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const anySucceeded = ordered.some((attempt) => outcomeGroupOf(attempt.status) === "settled");
    const firstSuccess = ordered.findIndex((attempt) => outcomeGroupOf(attempt.status) === "settled");
    const failedBefore = firstSuccess > 0 && ordered.slice(0, firstSuccess).some((attempt) => outcomeGroupOf(attempt.status) === "failed");
    return {
        attempts: ordered,
        siblings: Math.max(0, ordered.length - 1),
        anySucceeded,
        recoveredAfterFailure: failedBefore,
        currentIndex: ordered.findIndex((attempt) => attempt.id === currentId),
    };
};
