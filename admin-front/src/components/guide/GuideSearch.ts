import MiniSearch, { type SearchResult } from "minisearch";
import {
    loadArticles,
    loadCards,
    loadEdgeCases,
    loadErrorCodes,
    loadFaq,
    loadGlossary,
    loadPlaybook,
    type Article,
    type Card,
    type EdgeCase,
    type ErrorCode,
    type QuickAnswer,
    type Situation,
    type Term,
} from "@/content/guide";
import { normalizeArabicText, toAsciiDigits } from "@/utils/arabic";

export type GuideSearchType =
    | "article"
    | "term"
    | "card"
    | "situation"
    | "edge-case"
    | "faq"
    | "error-code";

export interface GuideSearchDocument {
    id: string;
    type: GuideSearchType;
    title: string;
    headings: string;
    aliases: string;
    plainText: string;
    route: string;
    subtitle: string;
}

export interface GuideSearchHit extends GuideSearchDocument {
    score: number;
}

export interface GuideSearchGroup {
    type: GuideSearchType;
    label: string;
    hits: GuideSearchHit[];
}

const TYPE_LABELS: Record<GuideSearchType, string> = {
    article: "Articles",
    term: "Glossary",
    card: "Checklists",
    situation: "Playbook",
    "edge-case": "Edge cases",
    faq: "Quick answers",
    "error-code": "Error codes",
};

const TYPE_ORDER: GuideSearchType[] = [
    "article",
    "term",
    "card",
    "situation",
    "edge-case",
    "faq",
    "error-code",
];

const MAX_PER_TYPE = 8;

export const normalizeGuideSearchText = (value: string): string => {
    const ascii = toAsciiDigits(String(value ?? ""));
    return normalizeArabicText(ascii)
        .toLocaleLowerCase()
        .replace(/_/g, " _ ")
        .replace(/[^\p{L}\p{N}_]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const searchableText = (value: string): string =>
    `${normalizeGuideSearchText(value)} ${normalizeGuideSearchText(value.replace(/_/g, " "))}`.trim();

const toDocument = (
    type: GuideSearchType,
    id: string,
    title: string,
    headings: string,
    aliases: string,
    plainText: string,
    route: string,
    subtitle: string,
): GuideSearchDocument => ({
    id: `${type}:${id}`,
    type,
    title,
    headings: searchableText(headings),
    aliases: searchableText(aliases),
    plainText: searchableText(plainText),
    route,
    subtitle,
});

const buildDocuments = async (): Promise<GuideSearchDocument[]> => {
    const [articles, terms, cards, situations, edgeCases, faqs, errorCodes] =
        await Promise.all([
            loadArticles("en"),
            loadGlossary(),
            loadCards(),
            loadPlaybook(),
            loadEdgeCases(),
            loadFaq(),
            loadErrorCodes(),
        ]);

    const articlesById = new Map(articles.map((article) => [article.id, article]));
    const termBySlug = new Map(terms.map((term) => [term.slug, term]));
    const cardById = new Map(cards.map((card) => [card.id, card]));
    const situationById = new Map(situations.map((situation) => [situation.id, situation]));

    const documents: GuideSearchDocument[] = [];

    for (const article of articles) {
        documents.push(
            toDocument(
                "article",
                article.id,
                article.title,
                article.headings.map((heading) => heading.text).join(" "),
                article.related.map((id) => articlesById.get(id)?.title ?? id).join(" "),
                article.plainText,
                `/guide/a/${article.id}`,
                `Book ${article.book} · ${article.minutes} min read`,
            ),
        );
    }
    for (const term of terms) {
        documents.push(
            toDocument(
                "term",
                term.slug,
                term.term,
                "",
                [term.aliases.join(" "), term.ar ?? ""].join(" "),
                [term.short, term.ar ?? ""].join(" "),
                `/guide/glossary/${term.slug}`,
                term.aliases.length > 0 ? `Also: ${term.aliases.join(", ")}` : "Glossary",
            ),
        );
    }
    for (const card of cards) {
        documents.push(
            toDocument(
                "card",
                card.id,
                card.title,
                "",
                card.screen,
                `${card.body} ${card.checklist.join(" ")}`,
                `/guide/cards/${card.id}`,
                `${card.risk} risk · ${card.screen}`,
            ),
        );
    }
    for (const situation of situations) {
        documents.push(
            toDocument(
                "situation",
                situation.id,
                situation.title,
                "",
                situation.screens.join(" "),
                situation.body,
                `/guide/playbook/${situation.id}`,
                `Cases ${situation.cases.join(", ")}`,
            ),
        );
    }
    for (const edgeCase of edgeCases) {
        documents.push(
            toDocument(
                "edge-case",
                String(edgeCase.n),
                `Case ${edgeCase.n}: ${edgeCase.scenario}`,
                "",
                `${edgeCase.groupName} ${edgeCase.group} ${edgeCase.severity}`,
                `${edgeCase.scenario} ${edgeCase.resolution}`,
                `/guide/edge-cases?case=${edgeCase.n}`,
                `${edgeCase.groupName} · ${edgeCase.severity}`,
            ),
        );
    }
    for (const faq of faqs) {
        documents.push(
            toDocument(
                "faq",
                faq.id,
                faq.question,
                "",
                articlesById.get(faq.article)?.title ?? "",
                faq.answer,
                `/guide/a/${faq.article}#quick-answer-${faq.id}`,
                "Quick answer",
            ),
        );
    }
    for (const errorCode of errorCodes) {
        documents.push(
            toDocument(
                "error-code",
                errorCode.code,
                errorCode.code,
                "",
                `${errorCode.where} ${errorCode.meaning}`,
                `${errorCode.meaning} ${errorCode.action}`,
                `/guide/a/b13-01#${errorCode.code.toLowerCase()}`,
                errorCode.where,
            ),
        );
    }

    // Keep the unused lookups referenced so tree-shaking cannot drop the
    // collections that generated the documents above.
    void termBySlug;
    void cardById;
    void situationById;
    return documents;
};

interface IndexState {
    index: MiniSearch<GuideSearchDocument>;
    documentsById: Map<string, GuideSearchDocument>;
    documents: GuideSearchDocument[];
}

let indexPromise: Promise<IndexState> | null = null;
let builtIndex: IndexState | null = null;
let lastBuildMs = 0;

export const buildGuideSearchIndex = async (): Promise<IndexState> => {
    if (indexPromise) return indexPromise;
    indexPromise = (async () => {
        const started = performance.now();
        const documents = await buildDocuments();
        const index = new MiniSearch<GuideSearchDocument>({
            fields: ["title", "headings", "aliases", "plainText"],
            storeFields: ["type", "title", "subtitle", "route"],
            idField: "id",
            searchOptions: {
                boost: { title: 5, headings: 3, aliases: 4, plainText: 1 },
                prefix: true,
                fuzzy: 0.2,
                combineWith: "AND",
            },
        });
        index.addAll(documents);
        const state = {
            index,
            documents,
            documentsById: new Map(documents.map((document) => [document.id, document])),
        };
        builtIndex = state;
        lastBuildMs = performance.now() - started;
        return state;
    })();
    return indexPromise;
};

export const getGuideSearchBuildMs = (): number => lastBuildMs;

export const getGuideSearchDocument = (documentId: string): GuideSearchDocument | undefined =>
    builtIndex?.documentsById.get(documentId);

const toHit = (document: GuideSearchDocument, score: number): GuideSearchHit => ({
    ...document,
    score,
});

const runSearch = (
    state: IndexState,
    query: string,
    combineWith: "AND" | "OR",
): SearchResult[] =>
    state.index.search(query, {
        boost: { title: 5, headings: 3, aliases: 4, plainText: 1 },
        prefix: true,
        fuzzy: 0.2,
        combineWith,
    });

export const searchGuideDocuments = async (query: string): Promise<GuideSearchHit[]> => {
    const normalized = normalizeGuideSearchText(query);
    if (!normalized) return [];
    const state = await buildGuideSearchIndex();
    let results = runSearch(state, normalized, "AND");
    if (results.length === 0) {
        results = runSearch(state, normalized, "OR");
    }
    return results
        .map((result) => {
            const document = state.documentsById.get(String(result.id));
            return document ? toHit(document, result.score) : null;
        })
        .filter((hit): hit is GuideSearchHit => Boolean(hit));
};

export const searchGuideGroups = async (query: string): Promise<GuideSearchGroup[]> => {
    const hits = await searchGuideDocuments(query);
    const byType = new Map<GuideSearchType, GuideSearchHit[]>();
    for (const type of TYPE_ORDER) {
        byType.set(type, []);
    }
    for (const hit of hits) {
        const bucket = byType.get(hit.type);
        if (bucket && bucket.length < MAX_PER_TYPE) {
            bucket.push(hit);
        }
    }
    return TYPE_ORDER.map((type) => ({
        type,
        label: TYPE_LABELS[type],
        hits: byType.get(type) ?? [],
    })).filter((group) => group.hits.length > 0);
};

export const GUIDE_GOLDEN_RULE_ARTICLE_IDS = [
    "b00-03",
    "b04-01",
    "b07-03",
    "b09-08",
    "b11-03",
] as const;

export const getGoldenRuleArticles = async (): Promise<GuideSearchDocument[]> => {
    const state = await buildGuideSearchIndex();
    return GUIDE_GOLDEN_RULE_ARTICLE_IDS.map((id) =>
        state.documentsById.get(`article:${id}`),
    ).filter((document): document is GuideSearchDocument => Boolean(document));
};

export const resolveSearchRoute = (document: GuideSearchDocument): string => document.route;

export type { Article, Card, EdgeCase, ErrorCode, QuickAnswer, Situation, Term };
