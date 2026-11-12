import { getBaseUrl } from "../baseUrl";

export const urlsMap = {
    options: (kind: string) => `v1/merchant/options/${kind}`,
    authLogin: "v1/merchant/auth/login",
    authLogout: "v1/merchant/auth/logout",
    authRegister: "v1/merchant/auth/register",
    authVerifyIdentity: "v1/merchant/auth/verify-identity",
    authGoogle: "v1/merchant/auth/google",
    authMfaVerify: "v1/merchant/auth/mfa/verify",
    profileMe: "v1/merchant/auth/me",

    onboardingJoinRequest: "v1/merchant/onboarding/join-request",
    onboardingKybDocuments: "v1/merchant/onboarding/kyb-documents",
    onboardingKybRevalidations: "v1/merchant/onboarding/kyb-revalidations",
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
    // Opened with fetch() (not axios), so it must be an absolute path under the API base.
    posScreenStream: (code: string) => `${getBaseUrl()}/v1/merchant/pos/screens/${encodeURIComponent(code)}/stream`,

    paymentsList: "v1/merchant/payments",

    disputesList: "v1/merchant/disputes",
    disputeEvidence: (id: string) => `v1/merchant/disputes/${id}/evidence`,

    cashoutsList: "v1/merchant/cashouts",

    tokensList: "v1/merchant/tokens",
    tokenDetail: (id: string) => `v1/merchant/tokens/${id}`,
    tokenIps: (id: string) => `v1/merchant/tokens/${id}/ips`,

    webhookEventTypes: "v1/merchant/webhooks/event-types",
    webhookEndpoints: "v1/merchant/webhooks/endpoints",
    webhookEndpoint: (id: string) => `v1/merchant/webhooks/endpoints/${id}`,
    webhookRotateSecret: (id: string) => `v1/merchant/webhooks/endpoints/${id}/rotate-secret`,
    webhookTest: (id: string) => `v1/merchant/webhooks/endpoints/${id}/test`,
    webhookDeliveries: "v1/merchant/webhooks/deliveries",
    webhookRedeliver: (id: string) => `v1/merchant/webhooks/deliveries/${id}/redeliver`,

    credentialSetsList: "v1/merchant/credential-sets",
    credentialSetDetail: (id: string) => `v1/merchant/credential-sets/${id}`,

    usersList: "v1/merchant/users",
    userDetail: (id: string) => `v1/merchant/users/${id}`,

    reportEngineCatalog: "v1/merchant/report-engine/catalog",
    reportEngineAutocomplete: (sourceKey: string) => `v1/merchant/report-engine/autocomplete/${encodeURIComponent(sourceKey)}`,
    reportEngineExecute: (code: string) => `v1/merchant/report-engine/catalog/${encodeURIComponent(code)}/execute`,
    reportEngineStudioTranscript: "v1/merchant/report-engine/studio/transcript",
    reportEngineStudioVerify: "v1/merchant/report-engine/studio/verify",
    reportEngineStudioPreview: "v1/merchant/report-engine/studio/preview",
    reportEngineStudioSpecs: "v1/merchant/report-engine/studio/specs",
    reportEngineStudioSpec: (id: string) => `v1/merchant/report-engine/studio/specs/${encodeURIComponent(id)}`,
    reportEngineStudioSpecMigrationPrompt: (id: string) => `v1/merchant/report-engine/studio/specs/${encodeURIComponent(id)}/migration-prompt`,
    reportEngineStudioNeedsMigration: "v1/merchant/report-engine/studio/needs-migration",
    reportEngineStudioChrome: "v1/merchant/report-engine/studio/chrome",
    reportEngineStudioChromeTranscript: "v1/merchant/report-engine/studio/chrome/transcript",
    reportEngineStudioChromeNeedsMigration: "v1/merchant/report-engine/studio/chrome/needs-migration",
    reportEngineStudioChromeDetail: (id: string) => `v1/merchant/report-engine/studio/chrome/${encodeURIComponent(id)}`,
    reportEngineStudioChromeArchive: (id: string) => `v1/merchant/report-engine/studio/chrome/${encodeURIComponent(id)}/archive`,
    reportEngineStudioChromeDefault: (id: string) => `v1/merchant/report-engine/studio/chrome/${encodeURIComponent(id)}/set-default`,
    reportEngineStudioChromeMigrationPrompt: (id: string) => `v1/merchant/report-engine/studio/chrome/${encodeURIComponent(id)}/migration-prompt`,
    reportEngineStudioPublish: (id: string) => `v1/merchant/report-engine/studio/specs/${encodeURIComponent(id)}/publish`,
    reportEngineStudioArchive: (id: string) => `v1/merchant/report-engine/studio/specs/${encodeURIComponent(id)}/archive`,
    reportEngineStudioUsage: "v1/merchant/report-engine/studio/usage",
    reportEngineStudioClone: (code: string) => `v1/merchant/report-engine/studio/templates/${encodeURIComponent(code)}/clone`,

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
