export type UserAuthorityType = string;

export type UserAuthoritiesMapType = Record<string, boolean>;

export type UserAuthorityDetail = {
    authorityKey: string;
    title: string;
    description: string;
    group: string;
};

export type AuthorityGroup = {
    group: string;
    icon: string;
    authorities: {
        authorityKey: string;
        title: string;
        description: string;
    }[];
};

export const ADMIN_AUTHORITY_GROUPS: AuthorityGroup[] = [
    {
        group: "Onboarding",
        icon: "mdi-account-check-outline",
        authorities: [
            { authorityKey: "joinrequests.review", title: "Review Join Requests", description: "Open and review join request queues" },
            { authorityKey: "joinrequests.decide", title: "Decide Join Requests", description: "Approve or reject join requests" },
            { authorityKey: "kyb.review", title: "Review KYB Documents", description: "Inspect and disposition KYB documents" },
            { authorityKey: "merchants.read", title: "Read Merchants", description: "View merchant records" },
            { authorityKey: "merchants.edit_descriptive", title: "Edit Merchant Descriptive Fields", description: "Edit descriptive merchant fields" },
            { authorityKey: "merchants.propose_sensitive", title: "Propose Sensitive Merchant Edits", description: "Raise maker-checker proposals for sensitive fields" },
            { authorityKey: "merchants.suspend", title: "Suspend Merchants", description: "Emergency suspend a merchant" },
            { authorityKey: "merchants.reinstate", title: "Reinstate Merchants", description: "Reinstate a suspended merchant" },
        ],
    },
    {
        group: "Governance",
        icon: "mdi-shield-check-outline",
        authorities: [
            { authorityKey: "approvals.approve", title: "Approve Requests", description: "Act as checker on maker-checker requests" },
            { authorityKey: "approvals.reject", title: "Reject Requests", description: "Reject maker-checker requests" },
            { authorityKey: "users_admin.propose", title: "Propose Admin User Changes", description: "Propose admin user and authority changes" },
            { authorityKey: "reports.draft", title: "Draft Reports", description: "Draft regulatory reports" },
        ],
    },
    {
        group: "Compliance",
        icon: "mdi-scale-balance",
        authorities: [
            { authorityKey: "aml.review", title: "Review AML", description: "Review screening matches and cases" },
            { authorityKey: "aml.propose", title: "Propose AML Resolutions", description: "Propose case release, void, freeze or escalation" },
            { authorityKey: "aml.read_confidential", title: "Read Confidential AML", description: "Access AML-CONFIDENTIAL records" },
        ],
    },
    {
        group: "Finance",
        icon: "mdi-cash-multiple",
        authorities: [
            { authorityKey: "adjustments.propose", title: "Propose Adjustments", description: "Propose refunds, chargebacks and corrections" },
            { authorityKey: "cashout.process", title: "Process Cash-Outs", description: "Process and subtract merchant cash-outs" },
            { authorityKey: "commission.propose", title: "Propose Commission Profiles", description: "Propose commission profile changes" },
            { authorityKey: "velocity.propose", title: "Propose Velocity Rules", description: "Propose velocity rule changes" },
            { authorityKey: "reconciliation.run", title: "Run Reconciliation", description: "Upload and run statement reconciliation" },
            { authorityKey: "reconciliation.resolve", title: "Resolve Reconciliation", description: "Resolve reconciliation variances" },
            { authorityKey: "profit.read", title: "Read Profitability", description: "Read profitability reports" },
            { authorityKey: "liquidity.read", title: "Read Liquidity", description: "Read liquidity and solvency panels" },
        ],
    },
    {
        group: "Gateways",
        icon: "mdi-connection",
        authorities: [
            { authorityKey: "gateways.edit", title: "Edit Gateways", description: "Configure gateways, rails and routes" },
            { authorityKey: "gateways.submit", title: "Submit Gateway Versions", description: "Submit gateway versions for checker approval" },
        ],
    },
    {
        group: "Support",
        icon: "mdi-lifebuoy",
        authorities: [
            { authorityKey: "support.read_merchant", title: "Read Merchant Support Data", description: "Read merchant records for support purposes" },
        ],
    },
];

export const MERCHANT_AUTHORITY_GROUPS: AuthorityGroup[] = [
    {
        group: "Links",
        icon: "mdi-link-variant",
        authorities: [
            { authorityKey: "links.create", title: "Create Links", description: "Create payment links" },
            { authorityKey: "links.read", title: "Read Links", description: "View payment links and attempts" },
            { authorityKey: "links.cancel", title: "Cancel Links", description: "Cancel active payment links" },
        ],
    },
    {
        group: "Payments",
        icon: "mdi-credit-card-outline",
        authorities: [
            { authorityKey: "payments.read", title: "Read Payments", description: "View payment attempts" },
            { authorityKey: "payments.export", title: "Export Payments", description: "Export payment data" },
        ],
    },
    {
        group: "Wallets",
        icon: "mdi-wallet-outline",
        authorities: [
            { authorityKey: "wallets.read", title: "Read Wallets", description: "View wallet balances" },
            { authorityKey: "statements.read", title: "Read Statements", description: "View monthly statements" },
            { authorityKey: "statements.export", title: "Export Statements", description: "Export monthly statements" },
        ],
    },
    {
        group: "Operations",
        icon: "mdi-cash-fast",
        authorities: [
            { authorityKey: "cashout.request", title: "Request Cash-Out", description: "Request a payout" },
            { authorityKey: "cashout.read", title: "Read Cash-Outs", description: "View cash-out requests" },
            { authorityKey: "applications.read", title: "Read Applications", description: "View application configuration" },
            { authorityKey: "applications.edit_descriptive", title: "Edit Application Descriptive Fields", description: "Edit descriptive application fields" },
            { authorityKey: "applications.propose_sensitive", title: "Propose Sensitive Application Changes", description: "Raise maker-checker proposals" },
            { authorityKey: "pos.manage", title: "Manage POS", description: "Manage terminals and screens" },
            { authorityKey: "pos.operate", title: "Operate POS", description: "Operate assigned POS screens" },
        ],
    },
    {
        group: "Developer",
        icon: "mdi-code-braces",
        authorities: [
            { authorityKey: "tokens.create", title: "Create Tokens", description: "Create API access tokens" },
            { authorityKey: "tokens.revoke", title: "Revoke Tokens", description: "Revoke API access tokens" },
            { authorityKey: "tokens.read", title: "Read Tokens", description: "View API access tokens" },
            { authorityKey: "credentials.manage", title: "Manage Credentials", description: "Manage merchant-owned gateway credentials" },
            { authorityKey: "users.manage", title: "Manage Team", description: "Manage merchant team members" },
            { authorityKey: "stats.read", title: "Read Statistics", description: "View dashboard statistics" },
        ],
    },
];

export const UserAuthorityDetails: UserAuthorityDetail[] = [
    ...ADMIN_AUTHORITY_GROUPS.flatMap((g) =>
        g.authorities.map((a) => ({
            authorityKey: a.authorityKey,
            title: a.title,
            description: a.description,
            group: g.group,
        })),
    ),
    ...MERCHANT_AUTHORITY_GROUPS.flatMap((g) =>
        g.authorities.map((a) => ({
            authorityKey: a.authorityKey,
            title: a.title,
            description: a.description,
            group: g.group,
        })),
    ),
];

export const ADMIN_ROLES = [
    "GATEWAY_ADMIN",
    "SECURITY_ADMIN",
    "FINANCE",
    "OPERATOR",
    "COMPLIANCE",
    "MLRO",
    "SUPPORT",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const MERCHANT_ROLES = ["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"] as const;

export type MerchantRole = (typeof MERCHANT_ROLES)[number];

export const isAdminRole = (value: string): value is AdminRole =>
    (ADMIN_ROLES as readonly string[]).includes(value);

export const isMerchantRole = (value: string): value is MerchantRole =>
    (MERCHANT_ROLES as readonly string[]).includes(value);

export const mapHasAuthority = (
    map: UserAuthoritiesMapType | null | undefined,
    required: UserAuthorityType[] | null | undefined,
): boolean => {
    if (!required || !required.length) {
        return true;
    }
    if (!map) {
        return false;
    }
    return required.some((authority) => !!map[authority]);
};

export const mapHasAllAuthorities = (
    map: UserAuthoritiesMapType | null | undefined,
    required: UserAuthorityType[] | null | undefined,
): boolean => {
    if (!required || !required.length) {
        return true;
    }
    if (!map) {
        return false;
    }
    return required.every((authority) => !!map[authority]);
};
