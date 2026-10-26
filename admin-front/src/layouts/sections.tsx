import { hasOneOfAuthorities } from "@/state/user";
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

export const routesAuthorities: {
    [key: string]: undefined | null | UserAuthorityType[];
} = {
    Dashboard: [],
    JoinRequests: ["joinrequests.review"],
    KybReview: ["kyb.review"],
    Merchants: ["merchants.read", "support.read_merchant"],
    Approvals: ["approvals.approve", "approvals.reject"],
    AmlCases: ["aml.read_confidential"],
    AmlScreenings: ["aml.read_confidential"],
    AmlRules: ["aml.read_confidential"],
    AmlReports: ["aml.read_confidential"],
    OperatorCases: [],
    Disputes: [],
    Adjustments: ["adjustments.propose"],
    CashOuts: ["cashout.process"],
    Reconciliation: ["reconciliation.run", "reconciliation.resolve"],
    Profitability: ["profit.read"],
    Liquidity: ["liquidity.read"],
    Invariant: ["profit.read", "liquidity.read"],
    Gateways: ["gateways.edit"],
    GatewayWizard: ["gateways.edit"],
    Rails: ["gateways.edit"],
    GatewayRoutes: ["gateways.edit"],
};

export const routesRoles: {
    [key: string]: undefined | null | string[];
} = {
    AmlCases: ["COMPLIANCE", "MLRO"],
    AmlScreenings: ["COMPLIANCE", "MLRO"],
    AmlRules: ["COMPLIANCE", "MLRO"],
    AmlReports: ["COMPLIANCE", "MLRO"],
};

export const useSections = () => {
    const locale = useLocale();
    const { t } = locale;
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
            ],
        },
        {
            title: t("Operations"),
            icon: "mdi-cog-outline",
            routes: [
                {
                    label: t("Operator Cases"),
                    name: "OperatorCases",
                    icon: "mdi-lifebuoy",
                },
                {
                    label: t("Disputes"),
                    name: "Disputes",
                    icon: "mdi-scale-unbalanced",
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
            ],
        },
        {
            title: t("Finance"),
            icon: "mdi-finance",
            routes: [
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
                    label: t("Invariant"),
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
    ];
    return sections.filter((section) => !section.if || section.if()).map((section) => ({
        ...section,
        routes: section.routes.filter((route) => !route.if || route.if()),
    }));
};
