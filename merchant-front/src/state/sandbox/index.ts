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

/**
 * Portal routes are nested under the `/portal` parent, so a Vue Router path is
 * `/portal/sandbox/...` in the running app. Accept both the bare path (used by
 * tests and route definitions) and the mounted path, otherwise `sandboxMode`
 * never turns on and the mirror pages call Live API paths.
 */
const SANDBOX_PATH_PREFIXES = [SANDBOX_PATH_PREFIX, `/portal${SANDBOX_PATH_PREFIX}`] as const;

export const isSandboxPath = (path: string): boolean =>
    SANDBOX_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

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
