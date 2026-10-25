import { hasOneOfAuthorities, type UserAuthorityType } from "@/pages/user/core/users/roles/authorities";
import { operations } from "@/pages/user/ubs/operations";
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
    routes: Route[];
    if?: () => boolean;
};

export const routesAuthorities: {
    [key: string]: undefined | null | UserAuthorityType[];
} = {

    // example 
    // Dashboard: ["clients.view"],
    // ClientsList: ["clients.view"],
    // Accounts: ["accounts.view"],
    // Reports: ["clients.view"],
    // Settings: ["system-info.edit"],
};

export const useSections = () => {
    const locale = useLocale();
    const { t } = locale;
    const sections: Section[] = [
        // example
        // {
        //     if() {
        //         return allowedToAccessCore.value && hasOneOfAuthorities(["clients.view"]);
        //     },
        //     title: "Dashboard",
        //     routes: [
        //         {
        //             label: "Overview",
        //             name: "Dashboard",
        //             icon: "mdi-view-dashboard",
        //         },
        //         {
        //             label: "Quick Search",
        //             name: "QuickSearch",
        //             icon: "mdi-magnify",
        //         },
        //         {
        //             label: "Top Clients",
        //             name: "TopClients",
        //             icon: "mdi-trophy",
        //         },
        //         {
        //             label: "Pricing",
        //             name: "Pricing",
        //             icon: "mdi-currency-usd",
        //         },
        //         {
        //             label: "Currencies",
        //             name: "CurrenciesPage",
        //             icon: "mdi-currency-usd",
        //         },
        //     ],
        // },
    ];
    return sections;
};
