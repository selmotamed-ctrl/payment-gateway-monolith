import { onMounted, ref, computed } from "vue";
import { defineComponent } from "@/utils/dc";
import { RouterLink } from "vue-router/experimental/vapor";
import {PageHeader} from "@pg/ui";
import {PgPage as ScreenContainer} from "@pg/ui";
import { BookCard } from "@/components/guide/BookCard";
import { ReadingPath } from "@/components/guide/ReadingPath";
import { StuckPanel } from "@/components/guide/StuckPanel";
import { useGuideProgress } from "@/components/guide/useGuideProgress";
import { useGuideSearchPalette } from "@/components/guide/useGuideSearchPalette";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import {
    loadArticles,
    loadBooks,
    loadMeta,
    loadPaths,
    loadPlaybook,
    type Article,
    type Book,
    type ReadingPath as ReadingPathType,
    type Situation,
} from "@/content/guide";
import { user } from "@/state/user";

const TOOLS = [
    { id: "transform-sandbox", title: "Transform pipeline", titleAr: "مسار التحويل", description: "See how an amount and a phone number are converted." },
    { id: "crypto-lab", title: "Signature lab", titleAr: "مختبر التوقيع", description: "Build the exact string a partner signs." },
    { id: "ledger-explorer", title: "Ledger explorer", titleAr: "مستكشف دفتر الأستاذ", description: "Read the two sides of every journal entry." },
    { id: "visible-rails", title: "Visible rails", titleAr: "الوسائل الظاهرة", description: "Find the first reason a payment method is hidden." },
    { id: "attempt-states", title: "Payment states", titleAr: "حالات الدفع", description: "Walk a payment through UNKNOWN, success and failure." },
];

export const AdminGuidePage = defineComponent({
    name: "AdminGuidePage",
    setup() {
        const { L, isArabic } = useGuideLocale();
        const { openGuideSearch } = useGuideSearchPalette();
        const progress = useGuideProgress();
        const books = ref<Book[]>([]);
        const articles = ref<Article[]>([]);
        const paths = ref<ReadingPathType[]>([]);
        const situations = ref<Situation[]>([]);
        const contentVersion = ref("");
        const loading = ref(true);

        onMounted(async () => {
            const [loadedBooks, loadedArticles, loadedPaths, loadedSituations, meta] =
                await Promise.all([
                    loadBooks(),
                    loadArticles("en"),
                    loadPaths(),
                    loadPlaybook(),
                    loadMeta(),
                ]);
            books.value = loadedBooks;
            articles.value = loadedArticles;
            paths.value = loadedPaths;
            situations.value = loadedSituations;
            contentVersion.value = meta.contentVersion;
            await progress.loadGuideProgress();
            loading.value = false;
        });

        const articlesById = computed(
            () => new Map(articles.value.map((article) => [article.id, article])),
        );
        const articlesByBook = computed(() => {
            const map = new Map<number, Article[]>();
            for (const article of articles.value) {
                const list = map.get(article.book) ?? [];
                list.push(article);
                map.set(article.book, list);
            }
            for (const list of map.values()) {
                list.sort((left, right) => left.order - right.order);
            }
            return map;
        });
        const currentRole = computed(() => String(user.value?.userInfo?.role ?? ""));
        const myPath = computed(() => {
            const exact = paths.value.find((path) => path.role === currentRole.value);
            return exact ?? paths.value.find((path) => path.role === "ALL") ?? paths.value[0];
        });
        const continueArticle = computed(() => {
            const lastId = progress.lastRead.value;
            if (lastId && articlesById.value.has(lastId)) {
                return articlesById.value.get(lastId)!;
            }
            return articlesById.value.get("b00-01") ?? articles.value[0];
        });
        const startHere = computed(() => articlesById.value.get("b00-01"));
        const bookArticleIds = (book: Book): string[] =>
            (articlesByBook.value.get(Number(book.id)) ?? []).map((article) => article.id);
        const totalArticleCount = computed(() => articles.value.length);
        const readArticleCount = computed(() =>
            progress.readCount(articles.value.map((article) => article.id), contentVersion.value || undefined),
        );
        const progressPercent = computed(() =>
            totalArticleCount.value === 0 ? 0 : Math.round((readArticleCount.value / totalArticleCount.value) * 100),
        );
        const completedBookCount = computed(() =>
            books.value.filter((book) => {
                const ids = bookArticleIds(book);
                return ids.length > 0 && progress.readCount(ids, contentVersion.value || undefined) === ids.length;
            }).length,
        );

        return () => (
            <ScreenContainer>
                <PageHeader title={L("Interactive Guide", "الدليل التفاعلي")} subtitle={L(
                        "Learn the platform from zero, look up a rule, or find what to do when something goes wrong.",
                        "تعلّم المنصة من الصفر، أو ابحث عن قاعدة، أو اعرف ما يجب فعله عند حدوث مشكلة.",
                    )}>
                        <button type="button" class="guide-primary-button" onClick={openGuideSearch}>
                            {L("Search the guide", "ابحث في الدليل")}
                        </button>
                </PageHeader>
                {loading.value ? (
                    <p class="guide-page-loading">{L("Loading the guide…", "جارٍ تحميل الدليل…")}</p>
                ) : (
                    <div class="guide-home">
                        <section class="guide-hero">
                            <div>
                                <p class="guide-eyebrow">{L("Start here", "ابدأ هنا")}</p>
                                <h2>{startHere.value?.title ?? L("Welcome", "مرحباً")}</h2>
                                <p>
                                    {L(
                                        "No payments, accounting, compliance or software knowledge is assumed. Read Book 0 first, then Book 1.",
                                        "لا تُفترض أي معرفة بالمدفوعات أو المحاسبة أو الامتثال أو البرمجيات. اقرأ الكتاب 0 أولاً ثم الكتاب 1.",
                                    )}
                                </p>
                                <div class="guide-hero__actions">
                                    {startHere.value ? (
                                        <RouterLink
                                            class="guide-primary-button"
                                            to={{ name: "AdminGuideArticle", params: { articleId: startHere.value.id } }}
                                        >
                                            {L("Open the first article", "افتح المقال الأول")}
                                        </RouterLink>
                                    ) : null}
                                    {continueArticle.value ? (
                                        <RouterLink
                                            class="guide-secondary-button"
                                            to={{ name: "AdminGuideArticle", params: { articleId: continueArticle.value.id } }}
                                        >
                                            {L("Continue reading", "تابع القراءة")}: {continueArticle.value.title}
                                        </RouterLink>
                                    ) : null}
                                </div>
                                <div
                                    class="guide-progress"
                                    role="progressbar"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={progressPercent.value}
                                    aria-label={L("Guide reading progress", "تقدم قراءة الدليل")}
                                >
                                    <div class="guide-progress__track">
                                        <span class="guide-progress__fill" style={{ inlineSize: `${progressPercent.value}%` }} />
                                    </div>
                                    <small>
                                        {L(
                                            `${readArticleCount.value} of ${totalArticleCount.value} articles read · ${completedBookCount.value} books completed`,
                                            `تمت قراءة ${readArticleCount.value} من ${totalArticleCount.value} مقالاً · ${completedBookCount.value} كتب مكتملة`,
                                        )}
                                    </small>
                                </div>
                                <small class="guide-content-version">
                                    {L("Content version", "إصدار المحتوى")} {contentVersion.value}
                                </small>
                            </div>
                            <div class="guide-hero__quick">
                                <RouterLink to={{ name: "AdminGuideGlossary" }}>{L("Glossary A–Z", "قاموس من أ إلى ي")}</RouterLink>
                                <RouterLink to={{ name: "AdminGuidePlaybook" }}>{L("Situation playbook", "دليل المواقف")}</RouterLink>
                                <RouterLink to={{ name: "AdminGuideCards" }}>{L("Safety checklists", "قوائم السلامة")}</RouterLink>
                                <RouterLink to={{ name: "AdminGuideEdgeCases" }}>{L("140 edge cases", "140 حالة حافة")}</RouterLink>
                                <RouterLink to={{ name: "AdminGuideTools" }}>{L("Tools and simulators", "الأدوات والمحاكيات")}</RouterLink>
                            </div>
                        </section>

                        {myPath.value ? (
                            <ReadingPath
                                path={myPath.value}
                                articles={articlesById.value}
                                readIds={progress.readIds.value}
                            />
                        ) : null}

                        <StuckPanel situations={situations.value} />

                        <section class="guide-books">
                            <header>
                                <h2>{L("All books", "كل الكتب")}</h2>
                                <span>{L("14 books, from zero to reference", "14 كتاباً من الصفر إلى المرجع")}</span>
                            </header>
                            <div class="guide-book-grid">
                                {books.value.map((book) => (
                                    <BookCard
                                        key={book.id}
                                        book={book}
                                        articleCount={bookArticleIds(book).length}
                                        readCount={progress.readCount(bookArticleIds(book))}
                                    />
                                ))}
                            </div>
                        </section>

                        <section class="guide-tools-gallery">
                            <header>
                                <h2>{L("Tools and simulators", "الأدوات والمحاكيات")}</h2>
                                <RouterLink to={{ name: "AdminGuideTools" }}>{L("Open all tools", "افتح كل الأدوات")}</RouterLink>
                            </header>
                            <div class="guide-tool-grid">
                                {TOOLS.map((tool) => (
                                    <RouterLink
                                        key={tool.id}
                                        class="guide-tool-card"
                                        to={{ name: "AdminGuideTools", params: { tool: tool.id } }}
                                    >
                                        <strong>{isArabic.value ? tool.titleAr : tool.title}</strong>
                                        <span>{tool.description}</span>
                                    </RouterLink>
                                ))}
                            </div>
                        </section>
                    </div>
                )}
            </ScreenContainer>
        );
    },
});

export default AdminGuidePage;
