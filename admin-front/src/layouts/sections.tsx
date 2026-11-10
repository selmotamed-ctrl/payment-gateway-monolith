import { hasOneOfAuthorities } from "@/state/user";
import { resolveRouteRequirement } from "@/utils/routeAuthorities";

const canOpenRoute = (name: string): boolean => {
    const requirement = resolveRouteRequirement(name);
    return requirement.allowed && hasOneOfAuthorities(requirement.authorities);
};
import type { UserAuthorityType } from "@/utils/authorities";
import { useLocale } from "vuetify";

export type Route = {
    name: string;
    icon?: string;
    label: string;
    description?: string;
    if?: () => boolean;
};

export type Section = {
    title: string;
    icon?: string;
    routes: Route[];
    if?: () => boolean;
};

export { routesAuthorities } from "@/utils/routeAuthorities";

export const routesRoles: {
    [key: string]: undefined | null | string[];
} = {
    AmlCases: ["COMPLIANCE", "MLRO"],
    AmlScreenings: ["COMPLIANCE", "MLRO"],
    AmlRules: ["COMPLIANCE", "MLRO"],
    AmlReports: ["COMPLIANCE", "MLRO"],
    AmlReportingStudio: ["COMPLIANCE", "MLRO"],
    Incidents: ["COMPLIANCE", "MLRO"],
    FilingAdapters: ["COMPLIANCE", "MLRO"],
    AdminAcademyTeam: ["SECURITY_ADMIN"],
};

export const useSections = () => {
    const { t, current } = useLocale();
    // A computed so the labels are re-translated when the locale changes; the
    // `current.value` read registers the dependency explicitly.
    return computed<Section[]>(() => {
        void current.value;
        const sections: Section[] = [
        {
            title: t("Overview"),
            icon: "mdi-view-dashboard-outline",
            routes: [
                {
                    label: t("Dashboard"),
                    name: "Dashboard",
                    icon: "mdi-view-dashboard-outline",
                },
            ],
        },
        {
            title: t("Reporting"),
            icon: "mdi-file-chart-outline",
            routes: [
                {
                    label: t("Report Catalog"),
                    name: "ReportsCatalog",
                    icon: "mdi-file-chart-outline",
                    if: () => hasOneOfAuthorities(["reports.draft", "report_engine:run", "report_engine:author", "report:review", "report:approve", "security:write"]),
                },
                {
                    label: t("Report Studio"),
                    name: "ReportsStudio",
                    icon: "mdi-robot-outline",
                    if: () => hasOneOfAuthorities(["reports.studio", "reports.draft", "report_engine:author", "report:review", "report:approve", "security:write"]),
                },
                {
                    label: t("Report Headers & Footers"),
                    name: "ReportsChrome",
                    icon: "mdi-page-layout-header-footer",
                    if: () => hasOneOfAuthorities(["reports.studio", "security:write"]),
                },
                {
                    label: t("Merchant Reports"),
                    name: "ReportsMerchantReports",
                    icon: "mdi-account-file-text-outline",
                    if: () => hasOneOfAuthorities(["report:review", "report:approve", "security:read", "security:write"]),
                },
            ],
        },
        {
            title: t("Onboarding"),
            icon: "mdi-account-convert-outline",
            routes: [
                {
                    label: t("Join Requests"),
                    name: "JoinRequests",
                    icon: "mdi-clipboard-account-outline",
                    if: () => hasOneOfAuthorities(["joinrequests.review"]),
                },
                {
                    label: t("KYB Review"),
                    name: "KybReview",
                    icon: "mdi-file-certificate-outline",
                    if: () => hasOneOfAuthorities(["kyb.review"]),
                },
                {
                    label: t("Merchants"),
                    name: "Merchants",
                    icon: "mdi-storefront-outline",
                    if: () => hasOneOfAuthorities(["merchants.read", "support.read_merchant"]),
                },
                {
                    label: t("Wallets"),
                    name: "Wallets",
                    icon: "mdi-wallet-outline",
                    if: () => canOpenRoute("Wallets"),
                },
                {
                    label: t("Applications & Channels"),
                    name: "Applications",
                    icon: "mdi-application-cog-outline",
                    if: () => canOpenRoute("Applications"),
                },
            ],
        },
        {
            title: t("Governance"),
            icon: "mdi-shield-check-outline",
            routes: [
                {
                    label: t("Approvals"),
                    name: "Approvals",
                    icon: "mdi-clipboard-check-outline",
                    if: () => hasOneOfAuthorities(["approvals.approve", "approvals.reject"]),
                },
                {
                    label: t("Audit Log"),
                    name: "AuditLog",
                    icon: "mdi-history",
                    if: () => hasOneOfAuthorities(["security:read"]),
                },
                {
                    label: t("Admin Users"),
                    name: "AdminUsers",
                    icon: "mdi-account-cog-outline",
                    if: () => canOpenRoute("AdminUsers"),
                },
                {
                    label: t("AML Cases"),
                    name: "AmlCases",
                    icon: "mdi-scale-balance",
                    if: () => hasOneOfAuthorities(["aml.read_confidential"]),
                },
                {
                    label: t("AML Screenings"),
                    name: "AmlScreenings",
                    icon: "mdi-magnify-scan",
                    if: () => hasOneOfAuthorities(["aml.read_confidential"]),
                },
                {
                    label: t("AML Rules"),
                    name: "AmlRules",
                    icon: "mdi-tune-variant",
                    if: () => hasOneOfAuthorities(["aml.read_confidential"]),
                },
                {
                    label: t("AML Reports"),
                    name: "AmlReports",
                    icon: "mdi-file-report-outline",
                    if: () => hasOneOfAuthorities(["aml.read_confidential"]),
                },
                {
                    label: t("Reporting Studio"),
                    name: "AmlReportingStudio",
                    icon: "mdi-xml",
                    if: () => hasOneOfAuthorities(["aml.read_confidential"]),
                },
                {
                    label: t("Incidents"),
                    name: "Incidents",
                    icon: "mdi-alert-decagram-outline",
                    if: () => hasOneOfAuthorities(["aml.read_confidential"]),
                },
                {
                    label: t("Filing Adapters"),
                    name: "FilingAdapters",
                    icon: "mdi-send-check-outline",
                    if: () => hasOneOfAuthorities(["aml.read_confidential"]),
                },
            ],
        },
        {
            title: t("Operations"),
            icon: "mdi-cog-outline",
            routes: [
                {
                    label: t("Transactions & Webhooks"),
                    name: "Transactions",
                    icon: "mdi-swap-horizontal-circle-outline",
                    if: () => canOpenRoute("Transactions"),
                },
                {
                    label: t("Operator Cases"),
                    name: "OperatorCases",
                    icon: "mdi-lifebuoy",
                    if: () => hasOneOfAuthorities(["case:read", "operator:read"]),
                },
                {
                    label: t("Inquiry Schedule"),
                    name: "GatewayInquirySchedules",
                    icon: "mdi-radar",
                    if: () => hasOneOfAuthorities(["case:read", "operator:read"]),
                },
                {
                    label: t("Disputes"),
                    name: "Disputes",
                    icon: "mdi-scale-unbalanced",
                    if: () => hasOneOfAuthorities(["dispute:read"]),
                },
                {
                    label: t("Adjustments"),
                    name: "Adjustments",
                    icon: "mdi-swap-horizontal-bold",
                    if: () => hasOneOfAuthorities(["adjustments.propose"]),
                },
                {
                    label: t("Cash-Outs"),
                    name: "CashOuts",
                    icon: "mdi-cash-fast",
                    if: () => hasOneOfAuthorities(["cashout.process"]),
                },
                {
                    label: t("Reconciliation"),
                    name: "Reconciliation",
                    icon: "mdi-file-table-outline",
                    if: () => hasOneOfAuthorities(["reconciliation.run", "reconciliation.resolve"]),
                },
                {
                    label: t("Backups"),
                    name: "SystemBackups",
                    icon: "mdi-backup-restore",
                    if: () => hasOneOfAuthorities(["security:read", "gateway:read"]),
                },
                {
                    label: t("Jobs & Outbox"),
                    name: "JobsOutbox",
                    icon: "mdi-tray-full",
                    if: () => canOpenRoute("JobsOutbox"),
                },
                {
                    label: t("Platform Settings"),
                    name: "AdminPlatformSettings",
                    icon: "mdi-cog-transfer-outline",
                    if: () => canOpenRoute("AdminPlatformSettings"),
                },
                {
                    label: t("Checkout Help"),
                    name: "AdminCheckoutHelp",
                    icon: "mdi-help-circle-outline",
                    if: () => canOpenRoute("AdminCheckoutHelp"),
                },
            ],
        },
        {
            title: t("Finance"),
            icon: "mdi-finance",
            routes: [
                {
                    label: t("Pricing & Limits"),
                    name: "PricingControls",
                    icon: "mdi-tune-variant",
                    if: () => canOpenRoute("PricingControls"),
                },
                {
                    label: t("Profitability"),
                    name: "Profitability",
                    icon: "mdi-chart-line",
                    if: () => hasOneOfAuthorities(["profit.read"]),
                },
                {
                    label: t("Liquidity"),
                    name: "Liquidity",
                    icon: "mdi-water",
                    if: () => hasOneOfAuthorities(["liquidity.read"]),
                },
                {
                    label: t("Journal Entries"),
                    name: "JournalEntries",
                    icon: "mdi-book-open-page-variant-outline",
                    if: () => canOpenRoute("JournalEntries"),
                },
                {
                    label: t("Ledger Audit & Invariant"),
                    name: "Invariant",
                    icon: "mdi-scale-balance",
                    if: () => hasOneOfAuthorities(["profit.read", "liquidity.read"]),
                },
            ],
        },
        {
            title: t("Gateways"),
            icon: "mdi-connection",
            routes: [
                {
                    label: t("Gateways"),
                    name: "Gateways",
                    icon: "mdi-router",
                    if: () => hasOneOfAuthorities(["gateways.edit"]),
                },
                {
                    label: t("Credential Sets"),
                    name: "CredentialSets",
                    icon: "mdi-key-chain-variant",
                    if: () => canOpenRoute("CredentialSets"),
                },
                {
                    label: t("Rails"),
                    name: "Rails",
                    icon: "mdi-transit-connection-variant",
                    if: () => hasOneOfAuthorities(["gateways.edit"]),
                },
                {
                    label: t("Routes"),
                    name: "GatewayRoutes",
                    icon: "mdi-map-marker-path",
                    if: () => hasOneOfAuthorities(["gateways.edit"]),
                },
            ],
        },
        {
            title: t("Learning"),
            icon: "mdi-school-outline",
            routes: [
                {
                    label: t("Interactive Guide"),
                    name: "AdminGuide",
                    icon: "mdi-book-open-variant",
                },
                {
                    label: t("Employee Academy"),
                    name: "AdminAcademy",
                    icon: "mdi-school-outline",
                },
            ],
        },
    ];
        return sections
            .filter((section) => !section.if || section.if())
            .map((section) => ({
                ...section,
                routes: section.routes.filter((route) => !route.if || route.if()),
            }))
            // A section whose every route is hidden must not render an empty header.
            .filter((section) => section.routes.length > 0);
    });
};
