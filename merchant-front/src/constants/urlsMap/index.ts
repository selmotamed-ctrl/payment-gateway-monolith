export const urlsMap = {
    options: (kind: string) => `v1/merchant/options/${kind}`,
    authLogin: "v1/merchant/auth/login",
    authRegister: "v1/merchant/auth/register",
    authVerifyIdentity: "v1/merchant/auth/verify-identity",
    authGoogle: "v1/merchant/auth/google",
    authMfaVerify: "v1/merchant/auth/mfa/verify",
    profileMe: "v1/merchant/auth/me",

    onboardingJoinRequest: "v1/merchant/onboarding/join-request",
    onboardingKybDocuments: "v1/merchant/onboarding/kyb-documents",
    onboardingBeneficialOwners: "v1/merchant/onboarding/beneficial-owners",
    onboardingSubmit: "v1/merchant/onboarding/submit",

    walletsList: "v1/merchant/wallets",
    walletBalance: (id: string) => `v1/merchant/wallets/${id}/balance`,
    walletStatements: (id: string) => `v1/merchant/wallets/${id}/statements`,
    walletStatementExport: (id: string, month: string) =>
        `v1/merchant/wallets/${id}/statements/${month}/export`,

    applicationsList: "v1/merchant/applications",
    applicationDetail: (id: string) => `v1/merchant/applications/${id}`,
    applicationPatch: (id: string) => `v1/merchant/applications/${id}`,

    linksList: "v1/merchant/links",
    linkDetail: (id: string) => `v1/merchant/links/${id}`,
    linkCancel: (id: string) => `v1/merchant/links/${id}/cancel`,
    linkAttempts: (id: string) => `v1/merchant/links/${id}/attempts`,

    posTerminals: "v1/merchant/pos/terminals",
    posTerminalDetail: (id: string) => `v1/merchant/pos/terminals/${id}`,
    posScreens: (id: string) => `v1/merchant/pos/terminals/${id}/screens`,
    posScreenStream: (code: string) => `v1/merchant/pos/screens/${code}/stream`,

    paymentsList: "v1/merchant/payments",

    disputesList: "v1/merchant/disputes",
    disputeEvidence: (id: string) => `v1/merchant/disputes/${id}/evidence`,

    cashoutsList: "v1/merchant/cashouts",

    tokensList: "v1/merchant/tokens",
    tokenDetail: (id: string) => `v1/merchant/tokens/${id}`,
    tokenIps: (id: string) => `v1/merchant/tokens/${id}/ips`,

    credentialSetsList: "v1/merchant/credential-sets",
    credentialSetDetail: (id: string) => `v1/merchant/credential-sets/${id}`,

    usersList: "v1/merchant/users",
    userDetail: (id: string) => `v1/merchant/users/${id}`,

    statsOverview: "v1/merchant/stats/overview",
    statsMetric: "v1/merchant/stats/metrics/:mk",

    externalCreateLink: "v1/external/links",
    externalGetLink: (key: string) => `v1/external/links/${key}`,
    externalCancelLink: (key: string) => `v1/external/links/${key}/cancel`,
    externalGetPayment: (reference: string) => `v1/external/payments/${reference}`,

    branchListAll: "v1/merchant/reference/branches",
    currenciesList: "v1/merchant/reference/currencies",
} as const;

export type UrlsMap = typeof urlsMap;
