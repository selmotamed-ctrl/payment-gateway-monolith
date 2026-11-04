import Decimal from "decimal.js";
import type { VisibleRailsData, VisibleRailsRail, VisibleRailsRoute } from "@/content/guide";

export interface VisibleRailsInput {
    amount?: string;
    currency?: string;
    applicationWhitelist?: string[] | null;
    linkWhitelist?: string[] | null;
    timeOfDay?: string;
    routeOverrides?: Record<string, Partial<VisibleRailsRoute>>;
}

export interface RailVisibility {
    code: string;
    name: string;
    visible: boolean;
    reason?: {
        predicate: number;
        message: string;
    };
    routes: {
        id: string;
        passed: boolean;
        failedPredicate?: number;
    }[];
}

const withinWindow = (time: string, from: string, to: string): boolean => {
    const toMinutes = (value: string): number => {
        const [hours, minutes] = value.split(":").map((part) => Number(part));
        return (hours || 0) * 60 + (minutes || 0);
    };
    const current = toMinutes(time);
    const start = toMinutes(from);
    const end = toMinutes(to);
    if (start === end) return true;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
};

const overrideRoutes = (
    routes: VisibleRailsRoute[],
    overrides: Record<string, Partial<VisibleRailsRoute>>,
): VisibleRailsRoute[] =>
    routes.map((route) => (overrides[route.id] ? { ...route, ...overrides[route.id] } : route));

const routePredicateFailure = (
    route: VisibleRailsRoute,
    amount: Decimal,
): number | undefined => {
    if (route.status !== "ACTIVE") return 4;
    if (route.health !== "HEALTHY") return 5;
    if (amount.lt(new Decimal(route.min)) || amount.gt(new Decimal(route.max))) return 6;
    const after = new Decimal(route.dailyProcessed).plus(amount);
    if (after.gt(new Decimal(route.dailyCap))) return 6;
    return undefined;
};

const routeScopeAndMaintenance = (
    route: VisibleRailsRoute,
    timeOfDay: string,
): number | undefined => {
    if (!route.scopeOk) return 7;
    if (route.maintenance.some((window) => withinWindow(timeOfDay, window.from, window.to))) return 7;
    if (route.credential !== "VERIFIED") return 8;
    return undefined;
};

const passedCount = (
    route: VisibleRailsRoute,
    amount: Decimal,
    timeOfDay: string,
): number => {
    let passed = 0;
    if (route.status === "ACTIVE") passed += 1;
    if (route.health === "HEALTHY") passed += 1;
    if (
        !amount.lt(new Decimal(route.min)) &&
        !amount.gt(new Decimal(route.max)) &&
        !new Decimal(route.dailyProcessed).plus(amount).gt(new Decimal(route.dailyCap))
    ) {
        passed += 1;
    }
    if (
        route.scopeOk &&
        !route.maintenance.some((window) => withinWindow(timeOfDay, window.from, window.to))
    ) {
        passed += 1;
    }
    if (route.credential === "VERIFIED") passed += 1;
    return passed;
};

export const evaluateRail = (
    data: VisibleRailsData,
    rail: VisibleRailsRail,
    input: VisibleRailsInput,
): RailVisibility => {
    const amount = new Decimal(input.amount ?? data.defaults.amount);
    const currency = input.currency ?? data.defaults.currency;
    const applicationWhitelist = input.applicationWhitelist ?? data.defaults.applicationWhitelist;
    const linkWhitelist = input.linkWhitelist ?? data.defaults.linkWhitelist;
    const timeOfDay = input.timeOfDay ?? data.defaults.timeOfDay;
    const routes = overrideRoutes(rail.routes, input.routeOverrides ?? {});

    const baseFailure = (predicate: number): RailVisibility => ({
        code: rail.code,
        name: rail.name,
        visible: false,
        reason: {
            predicate,
            message: data.predicates.find((entry) => entry.n === predicate)?.fails ?? "Hidden.",
        },
        routes: [],
    });

    if (applicationWhitelist && !applicationWhitelist.includes(rail.code)) {
        return baseFailure(1);
    }
    if (linkWhitelist && !linkWhitelist.includes(rail.code)) {
        return baseFailure(2);
    }
    if (!rail.commissionProfile) {
        return baseFailure(3);
    }

    const routeResults = routes.map((route) => {
        const basic = routePredicateFailure(route, amount);
        const failedPredicate = basic ?? routeScopeAndMaintenance(route, timeOfDay);
        return {
            id: route.id,
            route,
            passed: failedPredicate === undefined,
            failedPredicate,
        };
    });

    if (routeResults.some((result) => result.passed)) {
        return {
            code: rail.code,
            name: rail.name,
            visible: rail.currency === currency && !rail.blocked,
            ...(rail.currency === currency && !rail.blocked
                ? {}
                : {
                      reason: {
                          predicate: 9,
                          message: data.predicates.find((entry) => entry.n === 9)?.fails ?? "Hidden.",
                      },
                  }),
            routes: routeResults.map((result) => ({
                id: result.id,
                passed: result.passed,
                failedPredicate: result.failedPredicate,
            })),
        };
    }

    const best = routeResults
        .map((result) => ({
            ...result,
            count: passedCount(result.route, amount, timeOfDay),
        }))
        .sort((left, right) => right.count - left.count)[0];
    const routeFailure = best?.failedPredicate ?? 4;
    return {
        code: rail.code,
        name: rail.name,
        visible: false,
        reason: {
            predicate: routeFailure,
            message: data.predicates.find((entry) => entry.n === routeFailure)?.fails ?? "Hidden.",
        },
        routes: routeResults.map((result) => ({
            id: result.id,
            passed: result.passed,
            failedPredicate: result.failedPredicate,
        })),
    };
};

export const evaluateVisibleRails = (
    data: VisibleRailsData,
    input: VisibleRailsInput = {},
): RailVisibility[] => data.rails.map((rail) => evaluateRail(data, rail, input));

export const visibleRailsVector = (
    data: VisibleRailsData,
    vectorId: string,
): RailVisibility[] | undefined => {
    const vector = data.vectors.find((entry) => entry.id === vectorId);
    if (!vector) return undefined;
    return evaluateVisibleRails(data, vector.input as VisibleRailsInput);
};
