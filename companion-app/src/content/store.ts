import { computed, shallowRef } from "vue";
import { Capacitor } from "@capacitor/core";
import type {
    Article,
    Book,
    Card,
    CompanionBundle,
    EdgeCase,
    Lesson,
    ReadingPath,
    Role,
    Situation,
    Term,
    Track,
    TrackId,
} from "./types";
import { readActiveBundleText } from "@/lib/offlineBundle";

const bundleRef = shallowRef<CompanionBundle | null>(null);
const loadingRef = shallowRef(false);
const errorRef = shallowRef("");
let loadPromise: Promise<CompanionBundle> | null = null;

const REQUIRED_ARRAYS: Array<[unknown, string]> = [];

export const validateBundle = (value: unknown): CompanionBundle => {
    const bundle = value as CompanionBundle;
    const fail = (message: string): never => {
        throw new Error(`invalid content bundle: ${message}`);
    };
    if (!bundle || typeof bundle !== "object") fail("not an object");
    if (bundle.schema !== 1) fail(`unsupported schema ${String(bundle.schema)}`);
    if (!bundle.meta?.contentHash) fail("missing content hash");
    if (!bundle.guide || !bundle.academy) fail("missing guide or academy content");
    const arrays: Array<[unknown, string]> = [
        [bundle.guide.books, "guide.books"],
        [bundle.guide.articles, "guide.articles"],
        [bundle.guide.glossary, "guide.glossary"],
        [bundle.guide.cards, "guide.cards"],
        [bundle.guide.playbook, "guide.playbook"],
        [bundle.guide.paths, "guide.paths"],
        [bundle.guide.faq, "guide.faq"],
        [bundle.guide.errorCodes, "guide.errorCodes"],
        [bundle.guide.edgeCases, "guide.edgeCases"],
        [bundle.academy.tracks, "academy.tracks"],
        [bundle.academy.modules, "academy.modules"],
        [bundle.academy.lessons, "academy.lessons"],
        [bundle.academy.checks, "academy.checks"],
        [bundle.academy.labs, "academy.labs"],
        [bundle.academy.drills, "academy.drills"],
        [bundle.academy.pages, "academy.pages"],
        [bundle.academy.examBlueprints, "academy.examBlueprints"],
    ];
    for (const [array, name] of arrays) {
        if (!Array.isArray(array) || array.length === 0) fail(`${name} is empty`);
    }
    return bundle;
};

const fetchBundled = async (): Promise<CompanionBundle> => {
    const url = new URL("content/bundle.json", document.baseURI).toString();
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`could not load bundled content (${response.status})`);
    return validateBundle(await response.json());
};

const load = async (): Promise<CompanionBundle> => {
    loadingRef.value = true;
    errorRef.value = "";
    try {
        if (Capacitor.isNativePlatform()) {
            const active = await readActiveBundleText();
            if (active) {
                try {
                    const parsed = validateBundle(JSON.parse(active.text));
                    bundleRef.value = parsed;
                    return parsed;
                } catch {
                    // A corrupt update must never brick the app; fall back to the APK bundle.
                }
            }
        }
        const bundled = await fetchBundled();
        bundleRef.value = bundled;
        return bundled;
    } catch (error) {
        errorRef.value = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        loadingRef.value = false;
    }
};

export const ensureContent = (): Promise<CompanionBundle> => {
    if (bundleRef.value) return Promise.resolve(bundleRef.value);
    if (!loadPromise) loadPromise = load();
    return loadPromise;
};

export const setBundleForTests = (bundle: CompanionBundle | null): void => {
    bundleRef.value = bundle;
    loadPromise = bundle ? Promise.resolve(bundle) : null;
    errorRef.value = "";
    loadingRef.value = false;
};

export const useContent = () => ({
    bundle: computed(() => bundleRef.value),
    loading: computed(() => loadingRef.value),
    error: computed(() => errorRef.value),
    meta: computed(() => bundleRef.value?.meta ?? null),
    guide: computed(() => bundleRef.value?.guide ?? null),
    academy: computed(() => bundleRef.value?.academy ?? null),
});

/* ------------------------------------------------------------------ selectors */

const maps = computed(() => {
    const bundle = bundleRef.value;
    if (!bundle) {
        return {
            articles: new Map<string, Article>(),
            books: new Map<string, Book>(),
            terms: new Map<string, Term>(),
            cards: new Map<string, Card>(),
            situations: new Map<string, Situation>(),
            lessons: new Map<string, Lesson>(),
            tracks: new Map<string, Track>(),
            edgeCases: new Map<number, EdgeCase>(),
        };
    }
    return {
        articles: new Map(bundle.guide.articles.map((article) => [article.id, article])),
        books: new Map(bundle.guide.books.map((book) => [book.id, book])),
        terms: new Map(bundle.guide.glossary.map((term) => [term.slug, term])),
        cards: new Map(bundle.guide.cards.map((card) => [card.id, card])),
        situations: new Map(bundle.guide.playbook.map((situation) => [situation.id, situation])),
        lessons: new Map(bundle.academy.lessons.map((lesson) => [lesson.id, lesson])),
        tracks: new Map(bundle.academy.tracks.map((track) => [track.id, track])),
        edgeCases: new Map(bundle.guide.edgeCases.map((entry) => [entry.n, entry])),
    };
});

export const articleById = (id: string): Article | undefined => maps.value.articles.get(id);
export const bookById = (id: string | number): Book | undefined => maps.value.books.get(String(id));
export const termBySlug = (slug: string): Term | undefined => maps.value.terms.get(slug);
export const cardById = (id: string): Card | undefined => maps.value.cards.get(id);
export const situationById = (id: string): Situation | undefined => maps.value.situations.get(id);
export const lessonById = (id: string): Lesson | undefined => maps.value.lessons.get(id);
export const trackById = (id: string): Track | undefined => maps.value.tracks.get(id);
export const edgeCaseByNumber = (number: number): EdgeCase | undefined => maps.value.edgeCases.get(number);

export const articlesInBook = (bookId: string | number): Article[] =>
    (bundleRef.value?.guide.articles ?? [])
        .filter((article) => article.book === Number(bookId))
        .sort((left, right) => left.order - right.order);

export const previousArticle = (article: Article): Article | undefined => {
    const list = articlesInBook(article.book);
    const index = list.findIndex((entry) => entry.id === article.id);
    return index > 0 ? list[index - 1] : undefined;
};

export const nextArticle = (article: Article): Article | undefined => {
    const list = articlesInBook(article.book);
    const index = list.findIndex((entry) => entry.id === article.id);
    return index >= 0 && index < list.length - 1 ? list[index + 1] : undefined;
};

export const readingPathFor = (role: Role | "" | undefined): ReadingPath | undefined => {
    const paths = bundleRef.value?.guide.paths ?? [];
    const exact = paths.find((path) => path.role === role);
    return exact ?? paths.find((path) => path.role === "ALL") ?? paths[0];
};

export const trackForRole = (role: string | undefined | null): TrackId | null => {
    const value = String(role ?? "");
    return value && value !== "FOUNDATION" ? (value as TrackId) : null;
};

export const lessonsForTrack = (trackId: string): Lesson[] => {
    const track = trackById(trackId);
    if (!track) return [];
    const order = new Map(track.lessonIds.map((id, index) => [id, index]));
    return (bundleRef.value?.academy.lessons ?? [])
        .filter((lesson) => track.lessonIds.includes(lesson.id))
        .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
};
