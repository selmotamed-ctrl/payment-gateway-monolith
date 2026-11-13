import { ref } from "vue";

/**
 * True while the user is inside the Sandbox Studio or one of its Live-parity
 * mirror routes. The API interceptor uses this flag to rewrite Live portal
 * paths to the isolated Sandbox namespace; a Live route never inherits it.
 */
export const sandboxMode = ref(false);

export const setSandboxMode = (value: boolean): void => {
    sandboxMode.value = value;
};

export const SANDBOX_PATH_PREFIX = "/sandbox";

export const isSandboxPath = (path: string): boolean =>
    path === SANDBOX_PATH_PREFIX || path.startsWith(`${SANDBOX_PATH_PREFIX}/`);

/** Rewrites a relative merchant API path to the sandbox mirror namespace. */
export const sandboxMirrorPath = (url: string): string => {
    const raw = String(url ?? "");
    if (!sandboxMode.value) return raw;
    const leading = raw.startsWith("/") ? "/" : "";
    const path = raw.replace(/^\/?/, "");
    if (path.startsWith("v1/merchant/sandbox/")) return raw;
    if (path.startsWith("v1/merchant/")) return `${leading}v1/merchant/sandbox/mirror/${path.slice("v1/merchant/".length)}`;
    return raw;
};

export const sandboxMirrorAbsolute = (url: string): string => {
    const raw = String(url ?? "");
    if (!sandboxMode.value) return raw;
    return raw.replace(/\/v1\/merchant\//, "/v1/merchant/sandbox/mirror/");
};


/** Live route name -> Sandbox mirror route name. Used when a mirror page links to another Live page. */
export const SANDBOX_ROUTE_ALIASES: Record<string, string> = {
    Dashboard: "SandboxOverview",
    Wallets: "SandboxWallets",
    WalletDetail: "SandboxWalletDetail",
    Applications: "SandboxApplications",
    Links: "SandboxLinks",
    Payments: "SandboxPayments",
    Cashouts: "SandboxMirrorCashouts",
    Disputes: "SandboxMirrorDisputes",
    PosTerminals: "SandboxMirrorPos",
    PosScreen: "SandboxMirrorPosScreen",
    Credentials: "SandboxMirrorCredentials",
    Team: "SandboxMirrorTeam",
    Webhooks: "SandboxMirrorWebhooks",
    DeveloperTokens: "SandboxMirrorTokens",
    Statements: "SandboxMirrorStatements",
    MerchantReports: "SandboxMirrorReports",
    MerchantReportsStudio: "SandboxMirrorReportsStudio",
    MerchantReportsChrome: "SandboxMirrorReportsChrome",
    MerchantReportsNeedsMigration: "SandboxMirrorReportsNeedsMigration",
    MerchantReportsChromeNeedsMigration: "SandboxMirrorReportsChromeNeedsMigration",
    SandboxMirrorCashouts: "SandboxMirrorCashouts",
    SandboxMirrorDisputes: "SandboxMirrorDisputes",
    SandboxMirrorPos: "SandboxMirrorPos",
    SandboxMirrorCredentials: "SandboxMirrorCredentials",
    SandboxMirrorTeam: "SandboxMirrorTeam",
    SandboxMirrorWebhooks: "SandboxMirrorWebhooks",
    SandboxMirrorTokens: "SandboxMirrorTokens",
    SandboxMirrorStatements: "SandboxMirrorStatements",
    SandboxMirrorReports: "SandboxMirrorReports",
    SandboxMirrorReportsStudio: "SandboxMirrorReportsStudio",
};
