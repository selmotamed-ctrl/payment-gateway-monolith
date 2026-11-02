import type { RouteLocationRaw } from "vue-router";
import type { GuideSearchEntry } from "@/content/guide/types";

export interface LocalSearchCommandItem {
    id: string;
    source: "pages" | "guide";
    title: string;
    subtitle?: string;
    icon: string;
    kindLabel: string;
    target: RouteLocationRaw;
    score: number;
}

export interface NavigationSectionItem {
    title?: string;
    routeName?: string;
    name?: string;
    label?: string;
    icon?: string;
    sectionTitle?: string;
    keywords?: string[];
    routes?: NavigationSectionItem[];
}

export type GuideSearchFn = (query: string) => GuideSearchEntry[];

const GUIDE_KIND_LABELS: Record<
    GuideSearchEntry["kind"],
    { en: string; ar: string }
> = {
    book: { en: "Guide book", ar: "كتاب الدليل" },
    chapter: { en: "Guide chapter", ar: "فصل الدليل" },
    glossary: { en: "Glossary", ar: "مصطلحات" },
    error: { en: "Error code", ar: "رمز خطأ" },
    gl: { en: "Ledger account", ar: "حساب دفتر" },
    status: { en: "Status", ar: "حالة" },
    collection: { en: "Collection mode", ar: "نمط تحصيل" },
    channel: { en: "Confirmation channel", ar: "قناة تأكيد" },
    runbook: { en: "Runbook", ar: "دليل إجراء" },
    "edge-case": { en: "Edge case", ar: "حالة استثنائية" },
    simulator: { en: "Simulator", ar: "محاكي" },
};

function kindLabelFor(kind: GuideSearchEntry["kind"], locale: "en" | "ar"): string {
    const label = GUIDE_KIND_LABELS[kind];
    if (!label) {
        return locale === "ar" ? "الدليل" : "Guide";
    }
    return locale === "ar" ? label.ar : label.en;
}

function summarizeBody(text: string, maxLength = 160): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= maxLength) {
        return clean;
    }
    return `${clean.slice(0, maxLength).trimEnd()}…`;
}

function flattenNavigationItems(
    items: NavigationSectionItem[],
    inheritedSectionTitle?: string,
): NavigationSectionItem[] {
    const flattened: NavigationSectionItem[] = [];

    for (const item of items) {
        if (item.routes && item.routes.length > 0) {
            const sectionTitle =
                item.sectionTitle ??
                inheritedSectionTitle ??
                item.title ??
                item.label;
            flattened.push(
                ...flattenNavigationItems(
                    item.routes.map((route) => ({
                        ...route,
                        sectionTitle: route.sectionTitle ?? sectionTitle,
                    })),
                    sectionTitle,
                ),
            );
            continue;
        }

        flattened.push({
            ...item,
            sectionTitle: item.sectionTitle ?? inheritedSectionTitle,
        });
    }

    return flattened;
}

function normalizeNavigationItem(item: NavigationSectionItem): {
    title: string;
    routeName: string;
    icon?: string;
    sectionTitle?: string;
    keywords: string[];
} | null {
    const routeName = String(item.routeName ?? item.name ?? "").trim();
    const title = String(item.title ?? item.label ?? routeName).trim();
    if (!routeName || !title) {
        return null;
    }
    return {
        title,
        routeName,
        icon: item.icon,
        sectionTitle: item.sectionTitle,
        keywords: item.keywords ?? [],
    };
}

function pageCommand(
    item: NonNullable<ReturnType<typeof normalizeNavigationItem>>,
    locale: "en" | "ar",
    score: number,
): LocalSearchCommandItem {
    return {
        id: `page:${item.routeName}`,
        source: "pages",
        title: item.title,
        subtitle: item.sectionTitle,
        icon: item.icon || "mdi-compass-outline",
        kindLabel: locale === "ar" ? "صفحة" : "Page",
        target: { name: item.routeName },
        score,
    };
}

export function searchLocalPages(
    sections: NavigationSectionItem[],
    query: string,
    locale: "en" | "ar",
    limit = 6,
): LocalSearchCommandItem[] {
    const normalized = flattenNavigationItems(sections)
        .map((section) => normalizeNavigationItem(section))
        .filter(
            (
                section,
            ): section is NonNullable<ReturnType<typeof normalizeNavigationItem>> =>
                section !== null,
        );

    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) {
        return normalized
            .slice(0, limit)
            .map((section, index) => pageCommand(section, locale, 100 - index));
    }

    const scored: LocalSearchCommandItem[] = [];
    for (const section of normalized) {
        const titleLower = section.title.toLowerCase();
        const sectionLower = (section.sectionTitle ?? "").toLowerCase();
        const routeLower = section.routeName.toLowerCase();
        const keywordMatch = section.keywords.some((keyword) =>
            keyword.toLowerCase().includes(cleanQuery),
        );

        let score = 0;
        if (titleLower === cleanQuery || routeLower === cleanQuery) {
            score = 1000;
        } else if (titleLower.startsWith(cleanQuery)) {
            score = 800;
        } else if (titleLower.includes(cleanQuery)) {
            score = 600;
        } else if (sectionLower.includes(cleanQuery) || keywordMatch) {
            score = 400;
        }

        if (score > 0) {
            scored.push(pageCommand(section, locale, score));
        }
    }

    return scored.sort((left, right) => right.score - left.score).slice(0, limit);
}

export function searchLocalGuides(
    searchGuideFn: GuideSearchFn,
    query: string,
    locale: "en" | "ar",
    limit = 5,
): LocalSearchCommandItem[] {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
        return [];
    }

    let entries: GuideSearchEntry[];
    try {
        entries = searchGuideFn(cleanQuery).slice(0, limit);
    } catch {
        return [];
    }

    return entries.map((entry, index) => {
        const title =
            locale === "ar"
                ? entry.titleAr || entry.titleEn
                : entry.titleEn || entry.titleAr;
        const body =
            locale === "ar"
                ? entry.bodyAr || entry.bodyEn
                : entry.bodyEn || entry.bodyAr || "";
        const kindLabel = kindLabelFor(entry.kind, locale);
        const summary = summarizeBody(body);

        return {
            id: `guide:${entry.id}`,
            source: "guide",
            title,
            subtitle: summary || kindLabel,
            icon: "mdi-book-open-page-variant-outline",
            kindLabel,
            target: { name: "AdminGuide", query: { entry: entry.id } },
            score: 500 - index,
        };
    });
}
