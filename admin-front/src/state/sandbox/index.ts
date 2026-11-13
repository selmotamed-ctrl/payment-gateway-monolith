import { ref } from "vue";

export const sandboxMode = ref(false);

export const setSandboxMode = (value: boolean): void => {
    sandboxMode.value = value;
};

export const SANDBOX_PATH_PREFIX = "/sandbox";

export const isSandboxPath = (path: string): boolean =>
    path === SANDBOX_PATH_PREFIX || path.startsWith(`${SANDBOX_PATH_PREFIX}/`);

export const sandboxMirrorPath = (url: string): string => {
    const raw = String(url ?? "");
    if (!sandboxMode.value) return raw;
    const leading = raw.startsWith("/") ? "/" : "";
    const path = raw.replace(/^\/?/, "");
    if (path.startsWith("v1/admin/sandbox/")) return raw;
    if (path.startsWith("v1/admin/")) return `${leading}v1/admin/sandbox/mirror/${path.slice("v1/admin/".length)}`;
    return raw;
};

export const sandboxMirrorAbsolute = (url: string): string => {
    const raw = String(url ?? "");
    if (!sandboxMode.value) return raw;
    return raw.replace(/\/v1\/admin\//, "/v1/admin/sandbox/mirror/");
};


export const SANDBOX_ROUTE_ALIASES: Record<string, string> = {
    Dashboard: "SandboxMirrorDashboard",
    Merchants: "SandboxMirrorMerchants",
    MerchantDetail: "SandboxMirrorMerchantDetail",
    Wallets: "SandboxMirrorWallets",
    WalletDetail: "SandboxMirrorWalletDetail",
    Applications: "SandboxMirrorApplications",
    Transactions: "SandboxMirrorTransactions",
    Approvals: "SandboxMirrorApprovals",
    AuditLog: "SandboxMirrorAuditLog",
    OperatorCases: "SandboxMirrorOperatorCases",
    OperatorCaseDetail: "SandboxMirrorOperatorCaseDetail",
    Disputes: "SandboxMirrorDisputes",
    Adjustments: "SandboxMirrorAdjustments",
    CashOuts: "SandboxMirrorCashOuts",
    Reconciliation: "SandboxMirrorReconciliation",
    PricingControls: "SandboxMirrorPricing",
    Profitability: "SandboxMirrorProfitability",
    Liquidity: "SandboxMirrorLiquidity",
    JournalEntries: "SandboxMirrorJournalEntries",
    Invariant: "SandboxMirrorInvariant",
    CredentialSets: "SandboxMirrorCredentialSets",
    Gateways: "SandboxMirrorGateways",
    GatewayWizard: "SandboxMirrorGatewayWizard",
    Rails: "SandboxMirrorRails",
    GatewayRoutes: "SandboxMirrorGatewayRoutes",
    ReportsCatalog: "SandboxMirrorReportsCatalog",
    ReportsStudio: "SandboxMirrorReportsStudio",
    ReportsChrome: "SandboxMirrorReportsChrome",
    ReportsNeedsMigration: "SandboxMirrorReportsNeedsMigration",
    ReportsChromeNeedsMigration: "SandboxMirrorReportsChromeNeedsMigration",
    ReportsMerchantReports: "SandboxMirrorReportsMerchantReports",
    AdminPlatformSettings: "SandboxMirrorPlatformSettings",
    JobsOutbox: "SandboxMirrorJobsOutbox",
    SystemObjectStorage: "SandboxMirrorObjectStorage",
};
