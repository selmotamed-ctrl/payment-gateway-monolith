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
    Dashboard: ["stats.read"],
    Onboarding: [],
    Wallets: ["wallets.read"],
    Applications: ["applications.read"],
    Links: ["links.read"],
    PosTerminals: ["pos.manage", "pos.operate"],
    PosScreen: ["pos.manage", "pos.operate"],
    Payments: ["payments.read"],
    Disputes: ["payments.read"],
    Cashouts: ["cashout.read", "cashout.request"],
    DeveloperTokens: ["tokens.read"],
    Credentials: ["credentials.manage"],
    Team: ["users.manage"],
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
                    if: () => hasOneOfAuthorities(["stats.read"]),
                },
                {
                    label: t("Merchant Onboarding"),
                    name: "Onboarding",
                    icon: "mdi-clipboard-account-outline",
                },
                {
                    label: t("Merchant Guide"),
                    name: "MerchantGuide",
                    icon: "mdi-book-open-variant",
                },
            ],
        },
        {
            title: t("Money"),
            icon: "mdi-wallet-outline",
            routes: [
                {
                    label: t("Wallets"),
                    name: "Wallets",
                    icon: "mdi-wallet-outline",
                    if: () => hasOneOfAuthorities(["wallets.read", "statements.read"]),
                },
                {
                    label: t("Cash-Outs"),
                    name: "Cashouts",
                    icon: "mdi-cash-fast",
                    if: () => hasOneOfAuthorities(["cashout.read", "cashout.request"]),
                },
                {
                    label: t("Statements"),
                    name: "Statements",
                    icon: "mdi-file-table-outline",
                    if: () => hasOneOfAuthorities(["statements.read", "statements.export"]),
                },
            ],
        },
        {
            title: t("Commerce"),
            icon: "mdi-storefront-outline",
            routes: [
                {
                    label: t("Payment Links"),
                    name: "Links",
                    icon: "mdi-link-variant",
                    if: () => hasOneOfAuthorities(["links.read", "links.create"]),
                },
                {
                    label: t("Applications"),
                    name: "Applications",
                    icon: "mdi-apps",
                    if: () => hasOneOfAuthorities(["applications.read"]),
                },
                {
                    label: t("POS Terminals"),
                    name: "PosTerminals",
                    icon: "mdi-point-of-sale",
                    if: () => hasOneOfAuthorities(["pos.manage", "pos.operate"]),
                },
                {
                    label: t("Payments"),
                    name: "Payments",
                    icon: "mdi-credit-card-outline",
                    if: () => hasOneOfAuthorities(["payments.read"]),
                },
                {
                    label: t("Disputes"),
                    name: "Disputes",
                    icon: "mdi-scale-unbalanced",
                    if: () => hasOneOfAuthorities(["payments.read"]),
                },
            ],
        },
        {
            title: t("Developer"),
            icon: "mdi-code-braces",
            routes: [
                {
                    label: t("Developer Tokens"),
                    name: "DeveloperTokens",
                    icon: "mdi-key-variant",
                    if: () => hasOneOfAuthorities(["tokens.read"]),
                },
                {
                    label: t("Merchant Credentials"),
                    name: "Credentials",
                    icon: "mdi-key-chain",
                    if: () => hasOneOfAuthorities(["credentials.manage"]),
                },
                {
                    label: t("Team & Roles"),
                    name: "Team",
                    icon: "mdi-account-group",
                    if: () => hasOneOfAuthorities(["users.manage"]),
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
};
