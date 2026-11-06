import MiniSearch, { type SearchResult } from "minisearch";
import { ensureContent } from "./store";
import type { CompanionBundle } from "./types";

export type SearchType =
    | "article"
    | "term"
    | "card"
    | "situation"
    | "edge-case"
    | "faq"
    | "error-code"
    | "lesson"
    | "lab"
    | "track"
    | "page"
    | "drill";

export interface SearchDoc {
    id: string;
    type: SearchType;
    title: string;
    subtitle: string;
    headings: string;
    aliases: string;
    text: string;
    route: string;
}

export interface SearchHit extends SearchDoc {
    score: number;
}

export interface SearchGroup {
    type: SearchType;
    label: string;
    hits: SearchHit[];
}

const LABELS: Record<SearchType, string> = {
    article: "Guide articles",
    term: "Glossary",
    card: "Checklists",
    situation: "Playbook",
    "edge-case": "Edge cases",
    faq: "Quick answers",
    "error-code": "Error codes",
    lesson: "Academy lessons",
    lab: "Labs",
    track: "Tracks",
    page: "Academy help",
    drill: "Drills",
};

const ORDER: SearchType[] = [
    "article",
    "lesson",
    "lab",
    "term",
    "card",
    "situation",
    "edge-case",
    "faq",
    "error-code",
    "track",
    "page",
    "drill",
];

const MAX_PER_GROUP = 8;

const normalize = (value: string): string =>
    value
        .toLocaleLowerCase()
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/\u0640/g, "")
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
        .replace(/[^\p{L}\p{N}_]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

const makeDoc = (
    type: SearchType,
    id: string,
    title: string,
    subtitle: string,
    headings: string,
    aliases: string,
    text: string,
    route: string,
): SearchDoc => ({
    id: `${type}:${id}`,
    type,
    title,
    subtitle,
    headings: normalize(headings),
    aliases: normalize(aliases),
    text: normalize(text),
    route,
});

const buildDocs = (bundle: CompanionBundle): SearchDoc[] => {
    const docs: SearchDoc[] = [];
    const articleTitles = new Map(bundle.guide.articles.map((article) => [article.id, article.title]));
    for (const article of bundle.guide.articles) {
        docs.push(
            makeDoc(
                "article",
                article.id,
                article.title,
                `Book ${article.book} · ${article.minutes} min read`,
                article.headings.map((heading) => heading.text).join(" "),
                article.related.map((id) => articleTitles.get(id) ?? id).join(" "),
                article.plainText,
                `/guide/article/${article.id}`,
            ),
        );
    }
    for (const term of bundle.guide.glossary) {
        docs.push(
            makeDoc(
                "term",
                term.slug,
                term.term,
                term.aliases.length ? `Also: ${term.aliases.join(", ")}` : "Glossary",
                "",
                [term.aliases.join(" "), term.ar ?? ""].join(" "),
                [term.short, term.ar ?? ""].join(" "),
                `/guide/glossary/${term.slug}`,
            ),
        );
    }
    for (const card of bundle.guide.cards) {
        docs.push(
            makeDoc(
                "card",
                card.id,
                card.title,
                `${card.risk} risk · ${card.screen}`,
                "",
                card.screen,
                `${card.body} ${card.checklist.join(" ")}`,
                `/guide/cards/${card.id}`,
            ),
        );
    }
    for (const situation of bundle.guide.playbook) {
        docs.push(
            makeDoc(
                "situation",
                situation.id,
                situation.title,
                situation.screens.join(", "),
                "",
                situation.screens.join(" "),
                situation.body,
                `/guide/playbook/${situation.id}`,
            ),
        );
    }
    for (const entry of bundle.guide.edgeCases) {
        docs.push(
            makeDoc(
                "edge-case",
                String(entry.n),
                `Case ${entry.n}: ${entry.scenario}`,
                `${entry.groupName} · ${entry.severity}`,
                "",
                `${entry.groupName} ${entry.group} ${entry.severity}`,
                `${entry.scenario} ${entry.resolution}`,
                `/guide/edge-cases?case=${entry.n}`,
            ),
        );
    }
    for (const answer of bundle.guide.faq) {
        docs.push(
            makeDoc(
                "faq",
                answer.id,
                answer.question,
                "Quick answer",
                "",
                articleTitles.get(answer.article) ?? "",
                answer.answer,
                `/guide/article/${answer.article}`,
            ),
        );
    }
    for (const code of bundle.guide.errorCodes) {
        docs.push(
            makeDoc(
                "error-code",
                code.code,
                code.code,
                code.where,
                "",
                `${code.where} ${code.meaning}`,
                `${code.meaning} ${code.action}`,
                "/guide/reference",
            ),
        );
    }
    for (const lesson of bundle.academy.lessons) {
        docs.push(
            makeDoc(
                "lesson",
                lesson.id,
                lesson.title,
                `${lesson.minutes} min · lesson`,
                "",
                lesson.tracks.join(" "),
                lesson.plainText,
                `/academy/lesson/${lesson.id}`,
            ),
        );
    }
    for (const lab of bundle.academy.labs) {
        docs.push(
            makeDoc(
                "lab",
                lab.id,
                lab.title,
                `${lab.minutes} min · lab`,
                "",
                lab.tracks.join(" "),
                [lab.briefing, ...lab.tasks.map((task) => `${task.title} ${task.prompt}`)].join(" "),
                `/academy/lab/${lab.id}`,
            ),
        );
    }
    for (const track of bundle.academy.tracks) {
        docs.push(
            makeDoc("track", track.id, track.title, `${track.hours} hours · track`, "", track.description, track.description, `/academy/track/${track.id}`),
        );
    }
    for (const page of bundle.academy.pages) {
        docs.push(
            makeDoc("page", page.id, page.title, "Academy help", "", "", page.plainText, `/academy/help?page=${page.id}`),
        );
    }
    for (const drill of bundle.academy.drills) {
        docs.push(
            makeDoc("drill", drill.id, drill.title, `${drill.rail} · ${drill.minutes} min`, "", drill.rail, drill.plainText, `/academy/help?drill=${drill.id}`),
        );
    }
    return docs;
};

interface IndexState {
    index: MiniSearch<SearchDoc>;
    docs: Map<string, SearchDoc>;
}

let indexPromise: Promise<IndexState> | null = null;

const buildIndex = async (): Promise<IndexState> => {
    const bundle = await ensureContent();
    const docs = buildDocs(bundle);
    const index = new MiniSearch<SearchDoc>({
        fields: ["title", "headings", "aliases", "text"],
        storeFields: ["type", "title", "subtitle", "route"],
        idField: "id",
        searchOptions: {
            boost: { title: 6, headings: 3, aliases: 4, text: 1 },
            prefix: true,
            fuzzy: 0.2,
            combineWith: "AND",
        },
    });
    index.addAll(docs);
    return { index, docs: new Map(docs.map((doc) => [doc.id, doc])) };
};

const ensureIndex = (): Promise<IndexState> => {
    if (!indexPromise) indexPromise = buildIndex();
    return indexPromise;
};

const run = (state: IndexState, query: string, combineWith: "AND" | "OR"): SearchResult[] =>
    state.index.search(query, {
        boost: { title: 6, headings: 3, aliases: 4, text: 1 },
        prefix: true,
        fuzzy: 0.2,
        combineWith,
    });

export const searchContent = async (rawQuery: string): Promise<SearchHit[]> => {
    const query = normalize(rawQuery);
    if (!query) return [];
    const state = await ensureIndex();
    let hits = run(state, query, "AND");
    if (hits.length === 0) hits = run(state, query, "OR");
    return hits
        .map((hit) => {
            const doc = state.docs.get(String(hit.id));
            return doc ? { ...doc, score: hit.score } : null;
        })
        .filter((hit): hit is SearchHit => Boolean(hit));
};

export const searchGroups = async (query: string): Promise<SearchGroup[]> => {
    const hits = await searchContent(query);
    const groups: SearchGroup[] = [];
    for (const type of ORDER) {
        const bucket = hits.filter((hit) => hit.type === type).slice(0, MAX_PER_GROUP);
        if (bucket.length > 0) groups.push({ type, label: LABELS[type], hits: bucket });
    }
    return groups;
};

export const resetSearchIndexForTests = (): void => {
    indexPromise = null;
};
