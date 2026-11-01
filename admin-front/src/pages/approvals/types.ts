export type ApprovalRow = {
    id: string;
    subjectType: string;
    subjectId: string;
    domain: string;
    kind: string;
    state: string;
    mode: string;
    baseVersion: number | null;
    makerUserId: string;
    makerName: string;
    checkerName: string;
    makerReason: string | null;
    rejectionReason: string | null;
    riskAcceptanceNote: string | null;
    payloadDiff: unknown;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    ratifyDueAt: string | null;
    expired: boolean;
    ageHours: number;
    expiresInHours: number | null;
};

export type ApprovalSubjectContext = Record<string, unknown> & {
    contextType?: string;
    id?: string;
    legalName?: string;
    tradeName?: string;
    displayName?: string;
    status?: string;
    kybStatus?: string;
    riskTier?: string;
    merchant?: { id?: string; tradeName?: string; legalName?: string } | null;
};

export type ApprovalDetail = ApprovalRow & {
    subjectContext: ApprovalSubjectContext | null;
    canCheck: boolean;
    canApprove: boolean;
    checkBlockedReason: string | null;
};

export type ApprovalSummary = {
    totalPending: number;
    byState: Record<string, number>;
    bySubjectType: Array<{ subjectType: string; count: number }>;
    byDomain: Array<{ domain: string; count: number }>;
    expired: number;
    expiringSoon: number;
    emergencyDue: number;
    oldestAgeHours: number;
};
