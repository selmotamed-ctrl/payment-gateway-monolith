import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PageHeader } from "@/components/ui/PageHeader";
import ScreenContainer from "@/components/ScreenContainer";
import { MarkdownView } from "@/components/guide/MarkdownView";
import { ArticleToc } from "@/components/guide/ArticleToc";
import { ReadToggle } from "@/components/guide/ReadToggle";
import { UiStatusBanner } from "@/components/guide/UiStatusBanner";
import { useGuideProgress } from "@/components/guide/useGuideProgress";
import { markArticleOpened } from "@/components/academy/readingOpened";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import { TransformSandbox } from "@/components/guide/widgets/TransformSandbox";
import { CryptoLab } from "@/components/guide/widgets/CryptoLab";
import { LedgerExplorer } from "@/components/guide/widgets/LedgerExplorer";
import { VisibleRailsExplainer } from "@/components/guide/widgets/VisibleRailsExplainer";
import { AttemptStateExplorer } from "@/components/guide/widgets/AttemptStateExplorer";
import {
    hasArabicArticles,
    loadArticles,
    loadBooks,
    loadMeta,
    type Article,
    type Book,
} from "@/content/guide";

const renderWidget = (widgetId: string) => {
    if (widgetId === "transform-sandbox") return <TransformSandbox />;
    if (widgetId === "crypto-lab") return <CryptoLab />;
    if (widgetId === "ledger-explorer") return <LedgerExplorer />;
    if (widgetId === "visible-rails") return <VisibleRailsExplainer />;
    if (widgetId === "attempt-states") return <AttemptStateExplorer />;
    return null;
};

export const AdminGuideArticlePage = defineComponent({
    name: "AdminGuideArticlePage",
    setup() {
        const route = useRoute();
        const { L, isArabic } = useGuideLocale();
        const progress = useGuideProgress();
        const articles = ref<Article[]>([]);
        const books = ref<Book[]>([]);
        const contentVersion = ref("");
        const loading = ref(true);
        const saving = ref(false);
        const copied = ref(false);
        const startedAt = ref(Date.now());
        let autoMarked = false;

        const load = async () => {
            loading.value = true;
            const [loadedArticles, loadedBooks, meta] = await Promise.all([
                loadArticles("en"),
                loadBooks(),
                loadMeta(),
            ]);
            articles.value = loadedArticles;
            books.value = loadedBooks;
            contentVersion.value = meta.contentVersion;
            await progress.loadGuideProgress();
            loading.value = false;
            startedAt.value = Date.now();
            autoMarked = false;
        };

        onMounted(() => {
            markArticleOpened(String(route.params.articleId ?? ""));
            void load();
            window.addEventListener("scroll", onScroll, { passive: true });
        });
        onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));

        const articleId = computed(() => String(route.params.articleId ?? ""));
        const article = computed(() => articles.value.find((entry) => entry.id === articleId.value));
        const book = computed(() =>
            article.value ? books.value.find((entry) => Number(entry.id) === article.value!.book) : undefined,
        );
        const bookArticles = computed(() =>
            article.value
                ? articles.value
                      .filter((entry) => entry.book === article.value!.book)
                      .sort((left, right) => left.order - right.order)
                : [],
        );
        const articleIndex = computed(() =>
            bookArticles.value.findIndex((entry) => entry.id === articleId.value),
        );
        const previous = computed(() =>
            articleIndex.value > 0 ? bookArticles.value[articleIndex.value - 1] : undefined,
        );
        const next = computed(() =>
            articleIndex.value >= 0 && articleIndex.value < bookArticles.value.length - 1
                ? bookArticles.value[articleIndex.value + 1]
                : undefined,
        );
        const related = computed(() =>
            (article.value?.related ?? [])
                .map((id) => articles.value.find((entry) => entry.id === id))
                .filter((entry): entry is Article => Boolean(entry)),
        );
        const read = computed(() => progress.isRead(articleId.value));
        const arabicReady = hasArabicArticles();

        watch(
            () => route.params.articleId,
            async () => {
                markArticleOpened(articleId.value);
                await load();
                window.scrollTo({ top: 0, behavior: "auto" });
            },
        );

        const toggleRead = async (value: boolean) => {
            if (!article.value) return;
            saving.value = true;
            try {
                await progress.setGuideRead(article.value.id, contentVersion.value, value);
            } finally {
                saving.value = false;
            }
        };

        const onScroll = () => {
            if (!article.value || autoMarked || read.value) return;
            const elapsed = Date.now() - startedAt.value;
            const minimum = Math.max(3_000, article.value.minutes * 60_000 * 0.25);
            if (elapsed < minimum) return;
            const atBottom =
                window.innerHeight + window.scrollY >=
                document.documentElement.scrollHeight - 48;
            if (!atBottom) return;
            autoMarked = true;
            void toggleRead(true);
        };

        const reportProblem = async () => {
            if (!article.value) return;
            const text = `${article.value.id} | content ${contentVersion.value} | ${window.location.href}`;
            try {
                await navigator.clipboard?.writeText(text);
                copied.value = true;
                window.setTimeout(() => (copied.value = false), 2500);
            } catch {
                copied.value = false;
            }
        };

        return () => (
            <ScreenContainer>
                <PageHeader
                    title={article.value?.title ?? L("Article not found", "المقال غير موجود")}
                    subtitle={
                        article.value
                            ? `${L("Book", "الكتاب")} ${article.value.book} · ${article.value.minutes} ${L("min read", "دقيقة قراءة")}`
                            : undefined
                    }
                    breadcrumbs={[
                        { label: L("Guide", "الدليل"), to: "/guide" },
                        ...(book.value
                            ? [{ label: `Book ${book.value.id}: ${book.value.title}`, to: `/guide/book/${book.value.id}` }]
                            : []),
                        { label: article.value?.title ?? articleId.value },
                    ]}
                    end={() => (
                        <div class="guide-article-actions">
                            {article.value ? (
                                <>
                                    <span class="guide-content-version">
                                        {L("Version", "الإصدار")} {contentVersion.value}
                                    </span>
                                    <button type="button" class="guide-secondary-button" onClick={() => void reportProblem()}>
                                        {copied.value ? L("Copied", "تم النسخ") : L("Report a problem", "أبلغ عن مشكلة")}
                                    </button>
                                    <ReadToggle read={read.value} saving={saving.value} onToggle={(value) => void toggleRead(value)} />
                                </>
                            ) : null}
                        </div>
                    )}
                />
                {loading.value ? (
                    <p class="guide-page-loading">{L("Loading the article…", "جارٍ تحميل المقال…")}</p>
                ) : !article.value ? (
                    <div class="guide-empty">
                        <p>{L("This article does not exist. Search the guide or open a book.", "هذا المقال غير موجود. ابحث في الدليل أو افتح كتاباً.")}</p>
                        <RouterLink class="guide-primary-button" to={{ name: "AdminGuide" }}>
                            {L("Guide home", "صفحة الدليل")}
                        </RouterLink>
                    </div>
                ) : (
                    <>
                        {isArabic.value && !arabicReady ? (
                            <div class="guide-arabic-pending" role="status">
                                {L("Arabic version pending", "النسخة العربية قيد الإعداد")}
                            </div>
                        ) : null}
                        <div class="guide-article-layout">
                            <aside class="guide-article-book-outline" aria-label={L("Book outline", "فهرس الكتاب")}>
                                <p class="guide-eyebrow">
                                    {book.value ? `Book ${book.value.id}` : L("Book", "الكتاب")}
                                </p>
                                <ol>
                                    {bookArticles.value.map((entry) => (
                                        <li key={entry.id} class={entry.id === article.value?.id ? "is-current" : ""}>
                                            <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: entry.id } }}>
                                                {progress.isRead(entry.id) ? "✓ " : ""}
                                                {entry.title}
                                            </RouterLink>
                                        </li>
                                    ))}
                                </ol>
                            </aside>
                            <main class="guide-article-main" lang={isArabic.value && !arabicReady ? "en" : undefined} dir={isArabic.value && !arabicReady ? "ltr" : undefined}>
                                <div class="guide-article-meta-row">
                                    <span class="guide-role-chips">
                                        {article.value.roles === "ALL"
                                            ? L("Everyone", "للجميع")
                                            : article.value.roles.join(" · ")}
                                    </span>
                                    <span>{article.value.minutes} {L("min", "دقيقة")}</span>
                                </div>
                                <UiStatusBanner status={article.value.ui} />
                                <MarkdownView
                                    source={article.value.body}
                                    articleId={article.value.id}
                                    renderWidget={renderWidget}
                                />
                                <div class="guide-article-footer">
                                    <ReadToggle read={read.value} saving={saving.value} onToggle={(value) => void toggleRead(value)} />
                                    <nav class="guide-article-pager" aria-label={L("Article navigation", "تنقل المقالات")}>
                                        {previous.value ? (
                                            <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: previous.value.id } }}>
                                                ← {previous.value.title}
                                            </RouterLink>
                                        ) : null}
                                        {next.value ? (
                                            <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: next.value.id } }}>
                                                {next.value.title} →
                                            </RouterLink>
                                        ) : null}
                                    </nav>
                                </div>
                                {related.value.length > 0 ? (
                                    <section class="guide-related">
                                        <h2>{L("Related", "ذات صلة")}</h2>
                                        <ul>
                                            {related.value.map((entry) => (
                                                <li key={entry.id}>
                                                    <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: entry.id } }}>
                                                        {entry.title}
                                                    </RouterLink>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                ) : null}
                            </main>
                            <aside class="guide-article-toc">
                                <ArticleToc headings={article.value.headings} />
                            </aside>
                        </div>
                    </>
                )}
            </ScreenContainer>
        );
    },
});

export default AdminGuideArticlePage;
