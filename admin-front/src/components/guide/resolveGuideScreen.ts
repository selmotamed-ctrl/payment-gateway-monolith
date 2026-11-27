import type { ContextMap, ContextScreen } from "@/content/guide";

/**
 * Minimal shape of a Vue Router record used by the resolver. Keeping it local
 * avoids importing `vue-router` into the pure unit test.
 */
export interface GuideRouteRecord {
    path: string;
    name?: string | symbol | null;
}

export interface GuideScreenLookupInput {
    /** Current location path (`/transactions?open=...` is accepted). */
    path?: string | null;
    /** Current route name (`route.meta.parentName ?? route.name`). */
    routeName?: string | null;
    /** `router.getRoutes()` result. Optional: page directories are enough. */
    routes?: readonly GuideRouteRecord[];
}

interface Candidate {
    screen: ContextScreen;
    path: string;
    segments: string[];
    literalSegments: number;
}

const QUERY_OR_HASH = /[?#].*$/;

const normalizePath = (value: string): string => {
    let path = String(value ?? "").trim().replace(QUERY_OR_HASH, "");
    if (!path) return "";
    if (!path.startsWith("/")) path = `/${path}`;
    path = path.replace(/\/{2,}/g, "/").toLowerCase();
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return path;
};

const toSegments = (path: string): string[] =>
    normalizePath(path)
        .split("/")
        .filter(Boolean);

const isDynamicSegment = (segment: string): boolean =>
    segment.startsWith(":") || (segment.startsWith("{") && segment.endsWith("}"));

/** `pages/aml/cases` -> `/aml/cases`; `(any other page)` -> `""`. */
const pageDirToPath = (pageDir: string | undefined): string => {
    const value = String(pageDir ?? "").trim();
    if (!value.startsWith("pages/")) return "";
    return normalizePath(value.slice("pages/".length));
};

const patternMatches = (pattern: string, path: string): boolean => {
    const patternSegments = toSegments(pattern);
    const pathSegments = toSegments(path);
    if (patternSegments.length === 0 || patternSegments.length !== pathSegments.length) return false;
    return patternSegments.every(
        (segment, index) => isDynamicSegment(segment) || segment === pathSegments[index],
    );
};

/** Segment-aligned prefix: `/operator-cases` never matches `/transactions`. */
const prefixMatches = (prefix: string, path: string): boolean => {
    const prefixSegments = toSegments(prefix);
    const pathSegments = toSegments(path);
    if (prefixSegments.length === 0 || prefixSegments.length > pathSegments.length) return false;
    return prefixSegments.every(
        (segment, index) => isDynamicSegment(segment) || segment === pathSegments[index],
    );
};

const bySpecificity = (left: Candidate, right: Candidate): number =>
    right.segments.length - left.segments.length ||
    right.literalSegments - left.literalSegments ||
    right.path.length - left.path.length;

const mostSpecific = (candidates: Candidate[]): ContextScreen | null => {
    const [first] = [...candidates].sort(bySpecificity);
    return first?.screen ?? null;
};

const screenForName = (
    map: ContextMap,
    name: string,
    path: string,
    candidates: Candidate[],
): ContextScreen | null => {
    const matches = map.screens.filter((screen) => screen.routeNames.includes(name));
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0] ?? null;
    // A router name can be listed twice while a screen is being split. Prefer
    // the screen whose path is the longest segment-aligned match.
    const narrowed = candidates.filter(
        (candidate) => matches.includes(candidate.screen) && prefixMatches(candidate.path, path),
    );
    return (narrowed.length > 0 ? mostSpecific(narrowed) : null) ?? matches[0] ?? null;
};

/**
 * Resolve the Guide context-map screen for a route.
 *
 * Matching order:
 * 1. exact path (`/transactions`),
 * 2. exact dynamic route (`/wallets/:id` or `/wallets/abc`),
 * 3. exact route name (`WalletDetail`),
 * 4. longest segment-aligned path prefix (`/finance/pricing` -> `/finance`),
 * 5. the map's fallback screen.
 *
 * Route paths come from `routes` when supplied, otherwise from each screen's
 * `pageDir`. Prefixes are segment-aligned, so a broad `/operator-cases` entry
 * can never capture `/transactions`.
 */
export const resolveGuideScreenForPath = (
    map: ContextMap | null | undefined,
    input: GuideScreenLookupInput,
): ContextScreen | null => {
    if (!map) return null;
    const path = normalizePath(input.path ?? "");
    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    const add = (screen: ContextScreen, rawPath: string): void => {
        const candidatePath = normalizePath(rawPath);
        if (!candidatePath) return;
        const key = `${screen.screenId}:${candidatePath}`;
        if (seen.has(key)) return;
        seen.add(key);
        const segments = toSegments(candidatePath);
        candidates.push({
            screen,
            path: candidatePath,
            segments,
            literalSegments: segments.filter((segment) => !isDynamicSegment(segment)).length,
        });
    };

    const routes = input.routes ?? [];
    for (const screen of map.screens) {
        for (const route of routes) {
            const name = typeof route.name === "string" ? route.name : "";
            if (name && screen.routeNames.includes(name)) add(screen, route.path);
        }
        add(screen, pageDirToPath(screen.pageDir));
    }

    if (path) {
        const exact = candidates.filter((candidate) => candidate.path === path);
        if (exact.length > 0) return mostSpecific(exact);

        const dynamic = candidates.filter((candidate) => patternMatches(candidate.path, path));
        if (dynamic.length > 0) return mostSpecific(dynamic);
    }

    const routeName = String(input.routeName ?? "").trim();
    if (routeName) {
        const matched = screenForName(map, routeName, path, candidates);
        if (matched) return matched;
    }

    if (path) {
        const prefixed = candidates.filter((candidate) => prefixMatches(candidate.path, path));
        if (prefixed.length > 0) return mostSpecific(prefixed);
    }

    return map.screens.find((screen) => screen.screenId === map.fallbackScreenId) ?? null;
};
