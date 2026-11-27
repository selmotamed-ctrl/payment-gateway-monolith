import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { ContextMap, ContextScreen } from "@/content/guide";
import { resolveGuideScreenForPath } from "@/components/guide/resolveGuideScreen";

const REPO_ROOT = resolve(process.cwd(), "..");
const CONTEXT_MAP_PATH = resolve(
    REPO_ROOT,
    "admin-front/src/content/guide/generated/context-map.json",
);

const screen = (
    screenId: string,
    pageDir: string,
    routeNames: string[] = [],
): ContextScreen => ({
    screenId,
    routeNames,
    pageDir,
    summary: `${screenId} summary`,
    articles: [],
    cards: [],
    situations: [],
});

const fixtureMap = (): ContextMap => ({
    fallbackScreenId: "General",
    screens: [
        screen("Dashboard", "pages/dashboard", ["Dashboard", "Home"]),
        screen("Merchants", "pages/merchants", ["Merchants", "MerchantDetail"]),
        screen("Wallets", "pages/wallets", ["Wallets", "WalletDetail"]),
        screen("Transactions", "pages/transactions", ["Transactions"]),
        screen("OperatorCases", "pages/operator-cases", [
            "OperatorCases",
            "OperatorCaseDetail",
            "GatewayInquirySchedules",
        ]),
        screen("Finance", "pages/finance", ["Profitability", "PricingControls"]),
        screen("Reports", "pages/reports", [
            "ReportsCatalog",
            "ReportsStudio",
            "ReportsChrome",
        ]),
        screen("General", "(any other page)", ["Users", "JobsOutbox"]),
    ],
});

const routerRoutes = [
    { path: "/dashboard", name: "Dashboard" },
    { path: "/merchants", name: "Merchants" },
    { path: "/merchants/:id", name: "MerchantDetail" },
    { path: "/wallets", name: "Wallets" },
    { path: "/wallets/:id", name: "WalletDetail" },
    { path: "/transactions", name: "Transactions" },
    { path: "/operator-cases", name: "OperatorCases" },
    { path: "/operator-cases/:id", name: "OperatorCaseDetail" },
    { path: "/finance/pricing", name: "PricingControls" },
    { path: "/reports/catalog", name: "ReportsCatalog" },
    { path: "/reports/studio", name: "ReportsStudio" },
];

describe("resolveGuideScreenForPath", () => {
    test.each([
        ["/transactions", "Transactions"],
        ["/merchants", "Merchants"],
        ["/reports/catalog", "Reports"],
        ["/operator-cases", "OperatorCases"],
        ["/wallets/:id", "Wallets"],
    ])("resolves %s to the %s screen", (path, screenId) => {
        const resolved = resolveGuideScreenForPath(fixtureMap(), { path });
        expect(resolved?.screenId).toBe(screenId);
    });

    test("an exact router path wins over a stale route name", () => {
        const resolved = resolveGuideScreenForPath(fixtureMap(), {
            path: "/transactions",
            routeName: "OperatorCases",
            routes: routerRoutes,
        });
        expect(resolved?.screenId).toBe("Transactions");
    });

    test("dynamic router paths resolve through their route record", () => {
        const map = fixtureMap();
        expect(
            resolveGuideScreenForPath(map, {
                path: "/wallets/4b81051d",
                routes: routerRoutes,
            })?.screenId,
        ).toBe("Wallets");
        expect(
            resolveGuideScreenForPath(map, {
                path: "/operator-cases/CASE-2026-00001",
                routes: routerRoutes,
            })?.screenId,
        ).toBe("OperatorCases");
        expect(
            resolveGuideScreenForPath(map, {
                path: "/merchants/42",
                routes: routerRoutes,
            })?.screenId,
        ).toBe("Merchants");
    });

    test("route names remain the fallback when the path has no page directory", () => {
        const resolved = resolveGuideScreenForPath(fixtureMap(), {
            path: "/system/jobs-outbox",
            routeName: "JobsOutbox",
        });
        expect(resolved?.screenId).toBe("General");
    });

    test("prefix matching is segment-aligned and longest match wins", () => {
        const map = fixtureMap();
        expect(
            resolveGuideScreenForPath(map, { path: "/operator-cases/inquiries" })?.screenId,
        ).toBe("OperatorCases");
        expect(
            resolveGuideScreenForPath(map, { path: "/operator-cases-archive" })?.screenId,
        ).toBe("General");
        expect(
            resolveGuideScreenForPath(map, { path: "/finance/pricing" })?.screenId,
        ).toBe("Finance");
        expect(
            resolveGuideScreenForPath(map, { path: "/transactions?open=abc#top" })?.screenId,
        ).toBe("Transactions");
    });

    test("unknown paths and a missing map use the fallback screen", () => {
        expect(
            resolveGuideScreenForPath(fixtureMap(), { path: "/does-not-exist" })?.screenId,
        ).toBe("General");
        expect(resolveGuideScreenForPath(null, { path: "/transactions" })).toBeNull();
    });

    test("the committed context map gives Transactions its own screen", () => {
        const map = JSON.parse(readFileSync(CONTEXT_MAP_PATH, "utf8")) as ContextMap;
        expect(map.screens).toHaveLength(32);
        const transactions = map.screens.find((entry) => entry.screenId === "Transactions");
        expect(transactions?.routeNames).toEqual(["Transactions"]);
        const operatorCases = map.screens.find((entry) => entry.screenId === "OperatorCases");
        expect(operatorCases?.routeNames).not.toContain("Transactions");

        expect(
            resolveGuideScreenForPath(map, { path: "/transactions" })?.screenId,
        ).toBe("Transactions");
        expect(
            resolveGuideScreenForPath(map, { path: "/operator-cases" })?.screenId,
        ).toBe("OperatorCases");
        expect(
            resolveGuideScreenForPath(map, { path: "/reports/catalog" })?.screenId,
        ).toBe("Reports");
        expect(
            resolveGuideScreenForPath(map, { path: "/wallets/123" })?.screenId,
        ).toBe("Wallets");
    });
});
