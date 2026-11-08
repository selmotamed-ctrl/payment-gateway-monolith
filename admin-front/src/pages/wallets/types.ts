import type { PendingApprovalRow } from "@/pages/merchants/components/commerceBits";

/** One wallet as the list and the detail page receive it. Money fields are `null` for roles without financial visibility. */
export type WalletDetail = {
    id: string;
    merchantId: string;
    merchant: { id: string; legalName: string; tradeName: string };
    currency: string;
    status: string;
    glAccountId: string;
    /** Natural sign: positive when the merchant is owed money. */
    liveBalance: string | null;
    /** Natural sign too, so live minus checkpoint is what was posted since the last rollup. */
    checkpointBalance: string | null;
    applicationCount: number;
    paymentLinkCount: number;
    pendingCashoutCount: number;
    createdAt: string;
    redactedFields: string[];
    glAccount: { id: string; accountType: string; currency: string; checkpointBalance: string | null; checkpointAt: string | null; shardCount?: number; pendingLines?: string | null };
    /** Debit-positive, as stored. */
    shards: Array<{ shardId: number | string; currentBalance: string; updatedAt: string }>;
    applications: Array<{ id: string; name: string; status: string }>;
    cashouts: Array<{ id: string; state: string; amount: string; currency: string; createdAt: string }>;
    pendingApprovals: PendingApprovalRow[];
};

export type WalletAuditEvent = {
    id: string;
    action: string;
    role: string;
    actorEmail: string;
    approvalRequestId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    createdAt: string;
    redacted: boolean;
};
