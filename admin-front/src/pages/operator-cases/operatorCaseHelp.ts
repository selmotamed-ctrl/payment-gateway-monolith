import type { OperatorCaseDetail, OperatorCaseSummary } from "./types";

export type TermHelp = {
    label: string;
    meaning: string;
    action?: string;
    source: string;
};

export const CASE_KIND_HELP: Record<string, TermHelp> = {
    UNKNOWN: {
        label: "Unknown outcome",
        meaning:
            "The platform sent a money-moving request but the gateway did not return a definitive answer (timeout, connection reset, 5xx or unreadable response). The link slot stays locked until the truth is established.",
        action:
            "Run an inquiry. If the gateway has no inquiry API, use the statement or a Maker-Checker manual outcome. Never guess.",
        source: "operator_cases.kind",
    },
    HELD: {
        label: "Held for review",
        meaning:
            "The payment triggered a hold (for example an AML or risk rule) and the money is parked in an internal hold account.",
        action: "Review the hold and use the appropriate compliance or finance workflow.",
        source: "operator_cases.kind",
    },
    CONFLICT: {
        label: "Conflicting signals",
        meaning:
            "Two trusted sources disagree (for example a webhook says paid while an inquiry says failed). Nothing is posted to the ledger until a human decides.",
        action:
            "Inspect the webhook payload and inquiry response, then verify against the settlement statement before proposing an outcome.",
        source: "operator_cases.kind",
    },
    MISMATCH: {
        label: "Amount mismatch",
        meaning:
            "The amount reported by the gateway or statement differs from the amount expected by the platform beyond the configured tolerance.",
        action:
            "Resolve the difference through reconciliation and a Maker-Checker adjustment. The money remains in SUSPENSE until then.",
        source: "operator_cases.kind",
    },
    LATE_SUCCESS: {
        label: "Late success",
        meaning:
            "A success was confirmed after the attempt had already reached a terminal state, or after the link slot was no longer available.",
        action:
            "Check whether the settlement was booked normally or routed to SUSPENSE, and close the case after verifying the ledger.",
        source: "operator_cases.kind",
    },
    MANUAL_REVIEW: {
        label: "Manual review",
        meaning:
            "The platform deliberately paused this item for a human decision. The reason is in the case notes and the linked evidence.",
        action: "Review the evidence, then propose a documented resolution.",
        source: "operator_cases.kind",
    },
    UNMATCHED_STATEMENT: {
        label: "Unmatched statement line",
        meaning:
            "A statement line could not be matched to a local payment attempt during reconciliation.",
        action:
            "Inspect the statement references and resolve through reconciliation. Do not invent a payment attempt.",
        source: "operator_cases.kind",
    },
};

export const CASE_STATE_HELP: Record<string, TermHelp> = {
    OPEN: {
        label: "Open",
        meaning: "The case is queued and nobody has started the investigation yet.",
        source: "operator_cases.state",
    },
    IN_PROGRESS: {
        label: "In progress",
        meaning: "An operator has started the investigation or an inquiry has been scheduled.",
        source: "operator_cases.state",
    },
    PENDING_CHECKER: {
        label: "Waiting for checker",
        meaning:
            "A maker proposed a resolution. No attempt or ledger change happens until a different checker approves it.",
        source: "operator_cases.state",
    },
    RESOLVED: {
        label: "Resolved",
        meaning: "A checker approved the resolution and the case is closed.",
        source: "operator_cases.state",
    },
};

export const PRIORITY_HELP: Record<string, TermHelp> = {
    P1: {
        label: "P1 — Critical",
        meaning:
            "Highest urgency: conflicting money signals, a large exposure, or a breach that can affect customer funds. The design target is a 4-hour SLA.",
        source: "operator_cases.priority",
    },
    P2: {
        label: "P2 — High",
        meaning:
            "Important but not immediately fund-threatening. The design target is a 24-hour SLA.",
        source: "operator_cases.priority",
    },
    P3: {
        label: "P3 — Normal",
        meaning:
            "Routine operational review with no immediate fund exposure.",
        source: "operator_cases.priority",
    },
};

export const RECONCILIATION_RESULT_HELP: Record<string, TermHelp> = {
    MATCHED: {
        label: "Matched",
        meaning: "The statement line matched the local attempt on reference, amount and date.",
        source: "reconciliation_items.result",
    },
    AMOUNT_MISMATCH: {
        label: "Amount mismatch",
        meaning: "The statement amount differs from the attempt amount beyond tolerance.",
        source: "reconciliation_items.result",
    },
    MISSING_AT_GATEWAY: {
        label: "Missing at gateway",
        meaning: "The platform has a successful attempt, but the statement does not contain it.",
        source: "reconciliation_items.result",
    },
    MISSING_LOCALLY: {
        label: "Missing locally",
        meaning: "The statement contains a line that has no matching local attempt.",
        source: "reconciliation_items.result",
    },
    DUPLICATE: {
        label: "Duplicate",
        meaning: "The statement contains the same provider reference more than once.",
        source: "reconciliation_items.result",
    },
};

export const CASE_REFERENCE_SOURCE_HELP: Record<string, string> = {
    ATTEMPT_REFERENCE: "Derived from payment_attempts.reference.",
    RECONCILIATION_OUR_REFERENCE: "Derived from reconciliation_items.our_reference.",
    RECONCILIATION_PROVIDER_REFERENCE: "Derived from reconciliation_items.provider_reference.",
    CASE_ID: "No attempt or reconciliation reference exists, so operator_cases.id is shown.",
};

export const INQUIRY_REASON_HELP: Record<string, string> = {
    ELIGIBLE: "The attempt is UNKNOWN or VERIFYING and the pinned gateway version supports status inquiry.",
    CASE_RESOLVED: "The case is already resolved.",
    CASE_PENDING_CHECKER: "A resolution is already waiting for a checker.",
    NO_ATTEMPT: "This case is not linked to a payment attempt.",
    ATTEMPT_TERMINAL: "The attempt is already in a terminal state; inquiry is no longer meaningful.",
    ATTEMPT_NOT_INQUIRABLE: "Only UNKNOWN or VERIFYING attempts can be inquired.",
    GATEWAY_HAS_NO_STATUS_INQUIRY:
        "The pinned gateway version has supports_status_check = false. Use the statement or a Maker-Checker manual outcome instead.",
};

export const COLUMN_HELP = {
    caseRef:
        "Display reference for this case. It is derived from the attempt reference, then the reconciliation reference, then the case id. The exact source is shown in the detail page.",
    caseType:
        "operator_cases.kind. The value determines which runbook applies and what evidence must be inspected.",
    priority:
        "operator_cases.priority. P1 is the most urgent, P2 next, P3 routine.",
    state:
        "operator_cases.state. This is the case workflow state, not the payment attempt status.",
    merchant:
        "Merchant trade name and legal name via payment_attempts.merchant_id. Statement-only cases have no merchant.",
    route:
        "Rail and gateway of the linked attempt. The gateway is the one pinned on the attempt version, not the gateway's current version.",
    amount:
        "payment_attempts.total_charged_amount when an attempt exists; reconciliation_items.statement_amount when the case is statement-only.",
    attempt:
        "payment_attempts.reference plus its status and substatus. This is the payment lifecycle, separate from the case state.",
    slot:
        "payment_links counters: confirmed/use tells how many slots are consumed, and active-lock tells how many attempts still hold a reservation.",
    providerReference:
        "payment_attempts.provider_reference or reconciliation_items.provider_reference: the reference the gateway or statement uses.",
    reconciliation:
        "reconciliation_items.result. It says whether the statement line matched, mismatched, or is missing on either side.",
    approval:
        "approval_requests.state for the current Maker-Checker proposal. No money moves until it is EXECUTED.",
    openedAt: "operator_cases.created_at: when the case entered the operator queue.",
    slaDueAt:
        "operator_cases.sla_due_at: the deadline for the first resolution. It is a business deadline, not a payment expiry.",
    assignee:
        "users.email of operator_cases.assignee_user_id. The user id is shown in the detail page.",
    actions: "Open the full case or schedule a gateway inquiry when the attempt is eligible.",
} as const;

export const caseHelp = (kind: string | null | undefined): TermHelp =>
    CASE_KIND_HELP[String(kind ?? "").toUpperCase()] ?? {
        label: String(kind ?? "Unknown"),
        meaning: "No help text is registered for this case type.",
        source: "operator_cases.kind",
    };

export const caseStateHelp = (state: string | null | undefined): TermHelp =>
    CASE_STATE_HELP[String(state ?? "").toUpperCase()] ?? {
        label: String(state ?? "Unknown"),
        meaning: "No help text is registered for this case state.",
        source: "operator_cases.state",
    };

export const priorityHelp = (priority: string | null | undefined): TermHelp =>
    PRIORITY_HELP[String(priority ?? "").toUpperCase()] ?? {
        label: String(priority ?? "Unknown"),
        meaning: "No help text is registered for this priority.",
        source: "operator_cases.priority",
    };

export const reconciliationHelp = (result: string | null | undefined): TermHelp | null =>
    result ? RECONCILIATION_RESULT_HELP[String(result).toUpperCase()] ?? null : null;

const amountText = (value: string | null | undefined, currency: string | null | undefined): string =>
    value === null || value === undefined ? "—" : `${value} ${currency ?? ""}`.trim();

export const caseNarrative = (entry: OperatorCaseSummary | OperatorCaseDetail): {
    title: string;
    happened: string;
    matters: string;
    next: string;
} => {
    const help = caseHelp(entry.kind);
    const amount = amountText(entry.chargedAmount ?? entry.statementAmount, entry.currency);
    const attempt = entry.attemptStatus ? `The linked attempt is ${entry.attemptStatus}${entry.attemptSubstatus ? ` (${entry.attemptSubstatus})` : ""}.` : "No payment attempt is linked.";
    const slot = entry.linkSlot
        ? `The link has ${entry.linkSlot.confirmedCount ?? 0}/${entry.linkSlot.useCount ?? 0} confirmed slot(s) and ${entry.linkSlot.activeLockedCount ?? 0} active lock(s).`
        : "No payment link is linked.";
    const reconstruct = entry.reconciliationResult
        ? `The reconciliation result is ${entry.reconciliationResult}.`
        : "No reconciliation result is attached.";
    const next =
        entry.inquiryEligibility?.eligible
            ? "A gateway inquiry is available. Run it first; if the gateway returns a definitive status the attempt resolves automatically."
            : `Gateway inquiry is not available right now (${entry.inquiryEligibility?.reason ?? "unknown reason"}). Use the statement or a Maker-Checker manual outcome, with evidence.`;
    return {
        title: help.label,
        happened: `${help.meaning} ${attempt}`,
        matters: `Exposure: ${amount}. ${slot} ${reconstruct}`,
        next: `${next} ${help.action ?? ""}`.trim(),
    };
};

export const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
};

export const slaInfo = (dueAt: string | null | undefined): { tone: "success" | "warning" | "error" | "neutral"; label: string } => {
    if (!dueAt) return { tone: "neutral", label: "—" };
    const due = new Date(dueAt).getTime();
    if (Number.isNaN(due)) return { tone: "neutral", label: String(dueAt) };
    const diff = due - Date.now();
    const abs = Math.abs(diff);
    const hours = Math.round(abs / 3_600_000);
    const days = Math.round(abs / 86_400_000);
    const amount = hours >= 48 ? `${days}d` : `${Math.max(1, hours)}h`;
    if (diff < 0) return { tone: "error", label: `Overdue ${amount}` };
    if (diff < 4 * 3_600_000) return { tone: "warning", label: `Due in ${amount}` };
    return { tone: "success", label: `Due in ${amount}` };
};
