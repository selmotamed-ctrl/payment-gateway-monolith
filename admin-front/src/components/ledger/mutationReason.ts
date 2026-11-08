/** Governance rule: every containment/ledger mutation carries a human reason of at least 10 characters. */
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

export const normalizeReason = (value: string | null | undefined): string => String(value ?? "").trim();

export const isValidReason = (value: string | null | undefined): boolean => {
    const reason = normalizeReason(value);
    return reason.length >= MIN_REASON_LENGTH && reason.length <= MAX_REASON_LENGTH;
};
