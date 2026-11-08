import type { GovernanceMode } from "@/pages/merchants/commerceGovernance";

export type WalletActionKey = "freeze" | "unfreeze";

export interface WalletAction {
    key: WalletActionKey;
    /** English label key (catalogued). */
    label: string;
    icon: string;
    targetStatus: "FROZEN" | "ACTIVE";
    /** `immediate` restricts at once (audited); `approval` is submitted for four-eyes review (HTTP 202). */
    mode: GovernanceMode;
    danger: boolean;
    disabled: boolean;
    /** English message key explaining why the action is disabled. */
    disabledReason: string | null;
}

export interface WalletActionContext {
    canWrite: boolean;
    hasPendingApproval?: boolean;
}

/**
 * Which containment / restoration actions an operator can take on a wallet.
 * ACTIVE -> FROZEN is immediate (more restrictive); FROZEN -> ACTIVE needs a
 * checker (less restrictive). PENDING and CLOSED wallets have no operator action.
 */
export const walletActionsFor = (status: string, context: WalletActionContext): WalletAction[] => {
    if (!context.canWrite) return [];
    if (status === "ACTIVE") {
        return [
            {
                key: "freeze",
                label: "Freeze wallet",
                icon: "mdi-snowflake",
                targetStatus: "FROZEN",
                mode: "immediate",
                danger: true,
                disabled: false,
                disabledReason: null,
            },
        ];
    }
    if (status === "FROZEN") {
        const pending = context.hasPendingApproval === true;
        return [
            {
                key: "unfreeze",
                label: "Request unfreeze",
                icon: "mdi-lock-open-variant-outline",
                targetStatus: "ACTIVE",
                mode: "approval",
                danger: false,
                disabled: pending,
                disabledReason: pending ? "A change to this wallet is already awaiting approval." : null,
            },
        ];
    }
    return [];
};

export const pendingApprovalCount = (approvals: ReadonlyArray<{ state?: string }> | null | undefined): number =>
    (approvals ?? []).length;
