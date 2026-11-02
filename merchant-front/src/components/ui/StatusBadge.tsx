import { defineComponent, type PropType, type VNodeChild } from "vue";

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const STATUS_TO_TONE: Record<string, BadgeTone> = {
    LIVE: "success",
    ACTIVE: "success",
    SUCCEEDED: "success",
    APPROVED: "success",
    EXECUTED: "success",
    VERIFIED: "success",
    HEALTHY: "success",
    CLEAR: "success",
    CLEAN: "success",
    ACCEPTED: "success",
    MATCHED: "success",
    COMPLETE: "success",
    COMPLETED: "success",
    SUBTRACTED: "success",
    CONFIRMED: "success",
    WON: "success",
    RELEASED: "success",
    DELIVERED: "success",
    SETTLED: "success",
    PROCESSED: "success",
    RESOLVED: "success",
    FALSE_POSITIVE: "neutral",

    PENDING: "warning",
    PENDING_REVIEW: "warning",
    PENDING_CHECKER: "warning",
    PENDING_APPROVAL: "warning",
    IN_REVIEW: "warning",
    IN_PROGRESS: "warning",
    INFO_REQUESTED: "warning",
    AWAITING_CUSTOMER: "warning",
    DRAFT: "warning",
    UNVERIFIED: "warning",
    PARTIAL: "warning",
    DRAINING: "warning",
    DEGRADED: "warning",
    POTENTIAL_MATCH: "warning",
    UNREVIEWED: "warning",
    PROVISIONAL: "warning",
    EVIDENCE_REQUESTED: "warning",
    MEDIUM: "warning",
    HIGH: "warning",
    P2: "warning",
    SUBMITTED: "warning",
    QUEUED: "warning",
    RETRYING: "warning",
    AMOUNT_MISMATCH: "warning",
    MISSING_LOCALLY: "warning",
    DUPLICATE: "warning",
    OVERDUE: "danger",

    VERIFYING: "info",
    AUTHORIZING: "info",
    INITIATING: "info",
    PROCESSING: "info",
    EXECUTING: "info",
    SANDBOX_VERIFIED: "info",
    EVIDENCE_SUBMITTED: "info",
    SCHEDULED: "info",
    RUNNING: "info",
    OPERATOR_CASE: "info",
    AUTOMATIC: "info",

    UNKNOWN: "danger",
    FAILED: "danger",
    BLOCKED: "danger",
    SUSPENDED: "danger",
    REJECTED: "danger",
    REJECTED_VOID: "danger",
    REJECTED_BY_AUTHORITY: "danger",
    REVOKED: "danger",
    FAILING: "danger",
    OPEN_BREAKER: "danger",
    CONFIRMED_MATCH: "danger",
    TRUE_MATCH: "danger",
    ESCALATED: "danger",
    ESCALATED_STR: "danger",
    FROZEN: "danger",
    DISPUTED: "danger",
    LOST: "danger",
    INFECTED: "danger",
    MISSING_AT_GATEWAY: "danger",
    CONFLICT: "danger",
    HIGH_RISK: "danger",
    CRITICAL: "danger",
    P1: "danger",
    EXPIRED: "danger",
    CANCELLED: "danger",
    ERROR: "danger",
};

const TONE_STYLES: Record<BadgeTone, { bg: string; text: string; border: string; dot: string }> = {
    success: {
        bg: "var(--pg-status-success-bg)",
        text: "var(--pg-status-success-text)",
        border: "var(--pg-status-success-border)",
        dot: "var(--pg-status-success-dot)",
    },
    warning: {
        bg: "var(--pg-status-warning-bg)",
        text: "var(--pg-status-warning-text)",
        border: "var(--pg-status-warning-border)",
        dot: "var(--pg-status-warning-dot)",
    },
    danger: {
        bg: "var(--pg-status-danger-bg)",
        text: "var(--pg-status-danger-text)",
        border: "var(--pg-status-danger-border)",
        dot: "var(--pg-status-danger-dot)",
    },
    info: {
        bg: "var(--pg-status-info-bg)",
        text: "var(--pg-status-info-text)",
        border: "var(--pg-status-info-border)",
        dot: "var(--pg-status-info-dot)",
    },
    neutral: {
        bg: "var(--pg-status-neutral-bg)",
        text: "var(--pg-status-neutral-text)",
        border: "var(--pg-status-neutral-border)",
        dot: "var(--pg-status-neutral-dot)",
    },
};

export function formatHumanStatus(raw: string): string {
    if (!raw) return "—";
    const upper = raw.toUpperCase();
    if (upper === "AML_HOLD") return "AML Hold";
    if (["KYC", "KYB", "OTP", "P1", "P2", "P3", "AML", "LYD"].includes(upper)) return upper;
    return raw
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function statusToTone(raw: string | null | undefined): BadgeTone {
    return STATUS_TO_TONE[String(raw ?? "").trim().toUpperCase()] ?? "neutral";
}

export const StatusBadge = defineComponent({
    name: "StatusBadge",
    props: {
        status: { type: String, required: true },
        label: { type: String, default: "" },
        toneOverride: { type: String as PropType<BadgeTone>, default: undefined },
        showDot: { type: Boolean, default: true },
    },
    setup(props) {
        return (): VNodeChild => {
            const normalized = (props.status ?? "").trim().toUpperCase();
            const tone = props.toneOverride ?? STATUS_TO_TONE[normalized] ?? "neutral";
            const palette = TONE_STYLES[tone];
            const displayLabel = props.label || formatHumanStatus(props.status);
            return (
                <span
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        height: "22px",
                        padding: "0 8px",
                        borderRadius: "var(--pg-radius-sm)",
                        backgroundColor: palette.bg,
                        color: palette.text,
                        border: `1px solid ${palette.border}`,
                        fontSize: "12px",
                        fontWeight: 500,
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                        userSelect: "none",
                    }}
                >
                    {props.showDot && (
                        <span
                            aria-hidden="true"
                            style={{
                                width: "6px",
                                height: "6px",
                                borderRadius: "9999px",
                                backgroundColor: palette.dot,
                                flexShrink: 0,
                            }}
                        />
                    )}
                    <span>{displayLabel}</span>
                </span>
            );
        };
    },
});

export default StatusBadge;
