export type KybExpiryState = "EXPIRED" | "DUE_SOON" | "VALID" | "NONE";

export type KybDocumentStatus = "UPLOADED" | "ACCEPTED" | "REJECTED" | "EXPIRED";
export type KybAvStatus = "PENDING" | "CLEAN" | "INFECTED";

export type KybMerchantSummary = {
    id: string;
    legalName: string;
    tradeName: string | null;
    status: string;
    kybStatus: string;
    riskTier: string;
    businessCategory: string | null;
    country: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    payoutBankDetailsJson: Record<string, unknown> | null;
};

export type KybJoinRequestSummary = {
    id: string;
    status: string;
    onboardingChannel: string;
    proposedRiskTier: string;
    slaDueAt: string;
    slaPausedAt: string | null;
    slaRemainingSeconds: number | null;
    assignedReviewer: { id: string; email: string } | null;
};

export type KybUserSummary = {
    id: string;
    email: string;
};

export type KybDocumentSummary = {
    id: string;
    createdAt: string;
    updatedAt: string;
    merchantId: string;
    joinRequestId: string | null;
    subjectType: string;
    subjectId: string;
    docType: string;
    originalFileName: string | null;
    sha256: string;
    mime: string;
    sizeBytes: number;
    avStatus: KybAvStatus;
    status: KybDocumentStatus;
    reviewedById: string | null;
    uploadedBy: KybUserSummary | null;
    reviewedBy: KybUserSummary | null;
    reviewedAt: string | null;
    expiresOn: string | null;
    rejectionReasonCode: string | null;
    reviewNotes: string | null;
    duplicateJustification: string | null;
    statusChangedAt: string | null;
    expiredAt: string | null;
    merchant: KybMerchantSummary;
    joinRequest: KybJoinRequestSummary | null;
    merchantName: string;
    merchantLegalName: string;
    merchantStatus: string | null;
    merchantKybStatus: string | null;
    reviewer: string;
    uploader: string;
    subjectName: string | null;
    contentAvailable: boolean;
    duplicateMerchantCount: number;
    duplicateDocumentCount: number;
    expiryState: KybExpiryState;
    daysUntilExpiry: number | null;
    canReview: boolean;
    canRequestReplacement: boolean;
    canRequestRevalidation: boolean;
    openJoinRequest: { id: string; status: string } | null;
};

export type KybDuplicateMatch = {
    id: string;
    merchantId: string;
    joinRequestId: string | null;
    docType: string;
    status: string;
    avStatus: string;
    createdAt: string;
    reviewedAt: string | null;
    merchant: {
        id: string;
        legalName: string;
        tradeName: string | null;
        status: string;
        kybStatus: string;
    };
    joinRequest: { id: string; status: string } | null;
};

export type KybReadiness = {
    ready: boolean;
    blockers: string[];
    checklistComplete: boolean;
    requiredDocuments: string[];
    acceptedDocuments: string[];
    missingDocuments: string[];
    expiredDocuments: string[];
    ownersTotal: number;
    ownerThreshold: number;
    ownersReady: boolean;
    screeningResult: string | null;
    screeningBlocked: boolean;
    duplicateFlags: Array<Record<string, unknown>>;
    approvalPending: boolean;
    payoutBankReady: boolean;
};

export type KybRevalidationRequest = {
    id: string;
    createdAt: string;
    updatedAt: string;
    merchantId: string;
    joinRequestId: string | null;
    documentId: string | null;
    docType: string;
    reasonCode: string;
    message: string;
    status: string;
    requestedById: string;
    requestedAt: string;
    dueAt: string | null;
    fulfilledAt: string | null;
    fulfilledDocumentId: string | null;
    resolutionNotes: string | null;
};

export type KybDocumentDetail = KybDocumentSummary & {
    subjectOwner: {
        id: string;
        fullNameAr: string;
        fullNameEn: string | null;
        screeningStatus: string;
        active: boolean;
    } | null;
    duplicateMatches: KybDuplicateMatch[];
    readiness: KybReadiness | null;
    openRevalidations: KybRevalidationRequest[];
    reviewReasonCodes: string[];
    canRequestRevalidation: boolean;
};
