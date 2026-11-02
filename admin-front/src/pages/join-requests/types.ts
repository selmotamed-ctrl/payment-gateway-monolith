export type JoinRequestStatus =
    | "DRAFT"
    | "SUBMITTED"
    | "IN_REVIEW"
    | "INFO_REQUESTED"
    | "PENDING_CHECKER"
    | "APPROVED"
    | "REJECTED"
    | "WITHDRAWN"
    | "EXPIRED";

export type MerchantSummary = {
    id: string;
    legalName: string;
    tradeName: string;
    country: string;
    businessCategory: string | null;
    registrationNo: string | null;
    taxId: string | null;
    status: string;
    kybStatus: string;
    riskTier: string;
    contactPhone: string | null;
    contactEmail: string | null;
    payoutBankDetailsJson: Record<string, unknown> | null;
    payoutAccountHash: string | null;
    activatedAt: string | null;
};

export type KybDocument = {
    id: string;
    docType: string;
    originalFileName: string | null;
    status: string;
    avStatus: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
    expiresOn: string | null;
    reviewedAt: string | null;
    reviewNotes: string | null;
    rejectionReasonCode: string | null;
    uploadedBy: { id: string; email: string } | null;
    reviewedBy: { id: string; email: string } | null;
};

export type BeneficialOwner = {
    id: string;
    fullNameAr: string;
    fullNameEn: string | null;
    nationality: string;
    dateOfBirth: string;
    ownershipPercent: string | null;
    role: string;
    pepDeclared: boolean;
    screeningStatus: string;
    active: boolean;
    nationalIdHash: string | null;
    createdAt: string;
};

export type JoinReadiness = {
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
    duplicateFlags: DuplicateFlag[];
    approvalPending: boolean;
    payoutBankReady: boolean;
};

export type DuplicateFlag = {
    type: string;
    field: string;
    matchedMerchantId?: string;
    matchedDocumentId?: string;
    matchedOwnerId?: string;
};

export type ScreeningMatch = {
    id: string;
    listType: string;
    listName: string;
    listEntryRef: string;
    matchedName: string;
    score: string;
    disposition: string;
    dispositionNotes: string | null;
    suppressFuture: boolean;
};

export type JoinScreening = {
    id: string;
    result: string;
    matchCount: number;
    highestScore: string | null;
    requestedAt: string;
    completedAt: string | null;
    matches: ScreeningMatch[];
    amlCases: { id: string; status: string; severity: string; triggerReason: string }[];
};

export type ApprovalSummary = {
    id: string;
    subjectType: string;
    subjectId: string;
    state: string;
    makerUserId: string;
    checkerUserId: string | null;
    rejectionReason: string | null;
    createdAt: string;
};

export type JoinRequestSummary = {
    id: string;
    merchantId: string;
    merchantName: string;
    status: JoinRequestStatus;
    riskTier: string;
    proposedRiskTier: string;
    onboardingChannel: string;
    submittedAt: string | null;
    createdAt: string;
    slaDueAt: string;
    slaPausedAt: string | null;
    slaRemainingSeconds: number | null;
    reviewer: string;
    assignedReviewerId: string | null;
    fourEyesRequired: boolean;
    fourEyesReasons: string[] | null;
    profileJson: Record<string, unknown> | null;
    merchant: MerchantSummary;
    kybDocuments?: KybDocument[];
    decision?: string | null;
    decisionReasonCode?: string | null;
};

export type JoinAuditEntry = {
    id: string;
    createdAt: string;
    action: string;
    role: string;
    beforeJson: Record<string, unknown> | null;
    afterJson: Record<string, unknown> | null;
    approvalRequestId: string | null;
    actor: { id: string; email: string } | null;
};

export type JoinRequestDetail = JoinRequestSummary & {
    profileJson: Record<string, unknown> | null;
    reviewChecklistJson: Record<string, boolean> | null;
    duplicateFlagsJson: DuplicateFlag[] | null;
    infoRequestJson: { field: string; message: string }[] | null;
    decision: string | null;
    decisionReasonCode: string | null;
    decisionNotes: string | null;
    submittedBy: { id: string; email: string } | null;
    assignedReviewer: { id: string; email: string } | null;
    approvalRequest: ApprovalSummary | null;
    screening: JoinScreening | null;
    beneficialOwners: BeneficialOwner[];
    kybDocuments: KybDocument[];
    readiness: JoinReadiness;
    checklistKeys: string[];
    amlDetailsRedacted: boolean;
    auditTrail: JoinAuditEntry[];
};

export type KybUploadResult = {
    id: string;
    docType: string;
    originalFileName: string | null;
    status: string;
    avStatus: string;
    sha256: string;
    duplicateFlags: DuplicateFlag[];
};
