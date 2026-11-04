export type Role =
    | "GATEWAY_ADMIN"
    | "SECURITY_ADMIN"
    | "FINANCE"
    | "OPERATOR"
    | "COMPLIANCE"
    | "MLRO"
    | "SUPPORT";

export type UiStatus = "AVAILABLE" | "PARTIAL" | "NOT_YET";

export interface Book {
    id: string;
    title: string;
    audience: string;
    summary: string;
}

export interface ArticleHeading {
    id: string;
    text: string;
    level: number;
}

export interface Article {
    id: string;
    book: number;
    order: number;
    title: string;
    roles: "ALL" | Role[];
    minutes: number;
    ui: UiStatus;
    related: string[];
    body: string;
    headings: ArticleHeading[];
    plainText: string;
}

export interface Term {
    slug: string;
    term: string;
    aliases: string[];
    ar?: string;
    related: string[];
    short: string;
}

export interface Card {
    id: string;
    title: string;
    screen: string;
    risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    irreversible: boolean;
    body: string;
    checklist: string[];
}

export interface Situation {
    id: string;
    title: string;
    screens: string[];
    cases: number[];
    articles: string[];
    body: string;
}

export interface ContextScreen {
    screenId: string;
    routeNames: string[];
    pageDir: string;
    summary: string;
    articles: string[];
    cards: string[];
    situations: string[];
}

export interface ContextMap {
    fallbackScreenId: string;
    screens: ContextScreen[];
}

export interface EdgeCase {
    n: number;
    group: string;
    groupName: string;
    scenario: string;
    resolution: string;
    severity: "Low" | "Med" | "High";
}

export interface ErrorCode {
    code: string;
    where: string;
    meaning: string;
    action: string;
}

export interface ReadingPath {
    role: "ALL" | Role;
    title: string;
    articles: string[];
}

export interface QuickAnswer {
    id: string;
    article: string;
    question: string;
    answer: string;
}

export interface GuideMeta {
    contentVersion: string;
    generatedAt: string;
    counts: {
        books: number;
        articles: number;
        glossaryTerms: number;
        safeguardCards: number;
        safeguardChecklistItems: number;
        situations: number;
        readingPaths: number;
        quickAnswers: number;
        dataBlocks: number;
        contextMapScreens: number;
        errorCodes: number;
        edgeCases: number;
    };
    sourceSha256: string;
}

export interface LedgerEventLine {
    account: string;
    side: "DR" | "CR";
    amount: string;
    why: string;
}

export interface LedgerEventEntry {
    label: string;
    lines: LedgerEventLine[];
}

export interface LedgerEvent {
    id: string;
    title: string;
    entries: LedgerEventEntry[];
    showBalance?: { label: string; expr: string };
}

export interface LedgerData {
    defaults: Record<string, string>;
    derived: Record<string, string>;
    accounts: { id: string; class: string; normal: string }[];
    equation: string;
    events: LedgerEvent[];
}

export interface VisibleRailsRoute {
    id: string;
    status: string;
    health: string;
    min: string;
    max: string;
    dailyCap: string;
    dailyProcessed: string;
    maintenance: { from: string; to: string }[];
    scopeOk: boolean;
    credential: string;
}

export interface VisibleRailsRail {
    code: string;
    name: string;
    currency: string;
    blocked: boolean;
    commissionProfile: boolean;
    routes: VisibleRailsRoute[];
}

export interface VisibleRailsData {
    evaluationOrder: string[];
    predicates: { n: number; id: string; fails: string }[];
    rule: string;
    defaults: {
        amount: string;
        currency: string;
        applicationWhitelist: string[] | null;
        linkWhitelist: string[] | null;
        timeOfDay: string;
    };
    rails: VisibleRailsRail[];
    vectors: {
        id: string;
        input: Record<string, unknown>;
        expected: Record<string, string>;
    }[];
}

export interface AttemptStateRow {
    id: string;
    slot: string;
    money: string;
    human: string;
}

export interface AttemptTransition {
    id: string;
    label: string;
    from: string[];
    to: string;
    note?: string;
}

export interface AttemptTransitionsData {
    initial: string;
    states: AttemptStateRow[];
    events: AttemptTransition[];
}

export interface GuideData {
    "ledger-events": LedgerData;
    "visible-rails": VisibleRailsData;
    "attempt-transitions": AttemptTransitionsData;
}

const articleLoaders = import.meta.glob("./generated/articles.*.json") as Record<
    string,
    () => Promise<{ default: Article[] }>
>;

const loadJson = async <T>(path: string, loader?: () => Promise<{ default: T }>): Promise<T> => {
    if (!loader) {
        throw new Error(`Missing generated guide content: ${path}`);
    }
    const module = await loader();
    return module.default;
};

export const loadBooks = (): Promise<Book[]> =>
    import("./generated/books.json").then((module) => module.default as Book[]);

export const loadArticles = async (lang: "en" | "ar" = "en"): Promise<Article[]> => {
    const requested = articleLoaders[`./generated/articles.${lang}.json`];
    const fallback = articleLoaders["./generated/articles.en.json"];
    const articles = await loadJson(
        `articles.${lang}.json`,
        requested ?? (lang === "en" ? fallback : undefined),
    );
    if (lang !== "en" && (!Array.isArray(articles) || articles.length === 0)) {
        return loadJson("articles.en.json", fallback);
    }
    return articles;
};

export const hasArabicArticles = (): boolean =>
    Boolean(articleLoaders["./generated/articles.ar.json"]);

export const loadGlossary = (): Promise<Term[]> =>
    import("./generated/glossary.en.json").then((module) => module.default as Term[]);

export const loadCards = (): Promise<Card[]> =>
    import("./generated/cards.en.json").then((module) => module.default as Card[]);

export const loadPlaybook = (): Promise<Situation[]> =>
    import("./generated/playbook.en.json").then((module) => module.default as Situation[]);

export const loadPaths = (): Promise<ReadingPath[]> =>
    import("./generated/paths.json").then((module) => module.default as ReadingPath[]);

export const loadFaq = (): Promise<QuickAnswer[]> =>
    import("./generated/faq.en.json").then((module) => module.default as QuickAnswer[]);

export const loadData = (): Promise<GuideData> =>
    import("./generated/data.json").then((module) => module.default as unknown as GuideData);

export const loadContextMap = (): Promise<ContextMap> =>
    import("./generated/context-map.json").then((module) => module.default as ContextMap);

export const loadMeta = (): Promise<GuideMeta> =>
    import("./generated/meta.json").then((module) => module.default as GuideMeta);

export const loadErrorCodes = (): Promise<ErrorCode[]> =>
    import("./generated/error-codes.en.json").then((module) => module.default as ErrorCode[]);

export const loadEdgeCases = (): Promise<EdgeCase[]> =>
    import("./generated/edge-cases.en.json").then((module) => module.default as EdgeCase[]);

export const articleAllowsRole = (article: Article, role: string | undefined): boolean =>
    article.roles === "ALL" || (Boolean(role) && article.roles.includes(role as Role));

export const articlePath = (articleId: string): string => `/guide/a/${articleId}`;

export const bookPath = (bookId: string | number): string => `/guide/book/${bookId}`;

export const termPath = (slug: string): string => `/guide/glossary/${slug}`;

export const cardPath = (cardId: string): string => `/guide/cards/${cardId}`;

export const situationPath = (situationId: string): string => `/guide/playbook/${situationId}`;

export const toolPath = (toolId: string): string => `/guide/tools/${toolId}`;
