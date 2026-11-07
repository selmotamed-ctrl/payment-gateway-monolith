/**
 * Route -> authority table for the admin router guard (pure TS, unit-tested).
 *
 * The core/edge enforce the real authorities; this table is advisory UI gating.
 * The server projects its coarse `resource:action` names into portal `resource.action`
 * keys and always keeps the raw names in `authoritiesMap` (core-back/lib/auth/uiAuthorities.ts),
 * so entries may use either vocabulary. `AUTHORITY_ALIASES` normalises the raw colon names to
 * their portal equivalents so the guard accepts both without renaming anything server-side.
 *
 * Default-deny: an authenticated route name that is neither in `routesAuthorities` nor in
 * `PUBLIC_FOR_AUTHENTICATED` is refused by the guard.
 */
export const routesAuthorities: Record<string, string[]> = {
    JoinRequests: ["joinrequests.review"],
    JoinRequestNew: ["joinrequests.review"],
    JoinRequestDetail: ["joinrequests.review"],
    KybReview: ["kyb.review"],
    KybReviewDetail: ["kyb.review"],
    Merchants: ["merchants.read", "support.read_merchant"],
    MerchantDetail: ["merchants.read", "support.read_merchant"],
    Wallets: ["merchants.read", "support.read_merchant"],
    WalletDetail: ["merchants.read", "support.read_merchant"],
    Applications: ["merchants.read", "support.read_merchant"],
    Transactions: ["merchants.read", "support.read_merchant", "attempt:read"],
    Approvals: ["approvals.approve", "approvals.reject"],
    AdminUsers: ["security:read", "user:read", "user:write", "security:write", "users_admin.propose"],
    AdminUserDetail: ["security:read", "user:read", "user:write", "security:write", "users_admin.propose"],
    AuditLog: ["security:read"],
    AmlCases: ["aml.read_confidential"],
    AmlScreenings: ["aml.read_confidential"],
    AmlRules: ["aml.read_confidential"],
    AmlReports: ["aml.read_confidential"],
    OperatorCases: ["case:read", "operator:read"],
    OperatorCaseDetail: ["case:read", "operator:read"],
    GatewayInquirySchedules: ["case:read", "operator:read"],
    Disputes: ["dispute:read"],
    Adjustments: ["adjustments.propose"],
    CashOuts: ["cashout.process"],
    Reconciliation: ["reconciliation.run", "reconciliation.resolve"],
    PricingControls: ["commission.propose", "velocity.propose", "profit.read", "liquidity.read"],
    Profitability: ["profit.read"],
    Liquidity: ["liquidity.read"],
    Invariant: ["profit.read", "liquidity.read"],
    JournalEntries: ["profit.read", "liquidity.read"],
    CredentialSets: ["credentials.manage", "gateways.edit"],
    JobsOutbox: ["security:read"],
    Gateways: ["gateways.edit"],
    GatewayAiImport: ["gateways.edit"],
    GatewayWizard: ["gateways.edit"],
    Rails: ["gateways.edit"],
    GatewayRoutes: ["gateways.edit"],
    AdminPlatformSettings: ["settings:read", "settings:write", "security:read", "security:write"],
    AdminCheckoutHelp: ["settings:read", "settings:write", "gateways.edit", "security:write"],
    SystemBackups: ["security:read", "gateway:read"],
};

/** Authenticated routes that intentionally need login only (content has its own role checks). */
export const PUBLIC_FOR_AUTHENTICATED: readonly string[] = [
    "Dashboard",
    "AdminGuide",
    "AdminGuideBook",
    "AdminGuideArticle",
    "AdminGuideGlossary",
    "AdminGuideTools",
    "AdminGuidePlaybook",
    "AdminGuideCards",
    "AdminGuideEdgeCases",
    "AdminAcademy",
    "AdminAcademyTracks",
    "AdminAcademyTrack",
    "AdminAcademyModule",
    "AdminAcademyLesson",
    "AdminAcademyLab",
    "AdminAcademyExam",
    "AdminAcademyCertificate",
    "AdminAcademyTeam",
    "AdminAcademyHelp",
];

/** Raw backend (colon) authority -> equivalent portal (dotted) keys. Mirrors the server projection. */
export const AUTHORITY_ALIASES: Record<string, string[]> = {
    "gateway:read": ["gateways.edit"],
    "gateway:write": ["gateways.edit"],
    "case:read": ["support.read_merchant"],
    "operator:read": ["support.read_merchant"],
    "user:write": ["users_admin.propose"],
    "user:read": ["users_admin.read"],
    "settings:read": ["settings.read"],
    "settings:write": ["settings.write"],
    // `attempt:read` has no portal equivalent: the Transactions route also lists the portal keys.
    "attempt:read": [],
    "security:read": [],
    "security:write": [],
    "dispute:read": [],
};

export const normalizeAuthorities = (list: readonly string[]): string[] => {
    const out = new Set<string>();
    for (const authority of list) {
        out.add(authority);
        for (const alias of AUTHORITY_ALIASES[authority] ?? []) {
            out.add(alias);
        }
    }
    return [...out];
};

export type RouteRequirement = { allowed: boolean; authorities: string[] };

/** Resolves what the guard must check for a named route (default-deny when unlisted). */
export const resolveRouteRequirement = (routeName: string): RouteRequirement => {
    if (PUBLIC_FOR_AUTHENTICATED.includes(routeName)) {
        return { allowed: true, authorities: [] };
    }
    const listed = routesAuthorities[routeName];
    if (!listed || !listed.length) {
        return { allowed: false, authorities: [] };
    }
    return { allowed: true, authorities: normalizeAuthorities(listed) };
};
