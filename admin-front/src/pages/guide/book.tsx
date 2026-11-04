import { computed, defineComponent, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PageHeader } from "@/components/ui/PageHeader";
import ScreenContainer from "@/components/ScreenContainer";
import { useGuideProgress } from "@/components/guide/useGuideProgress";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import {
    loadArticles,
    loadBooks,
    articleAllowsRole,
    type Article,
    type Book,
} from "@/content/guide";
import { user } from "@/state/user";

export const AdminGuideBookPage = defineComponent({
    name: "AdminGuideBookPage",
    setup() {
        const route = useRoute();
        const { L } = useGuideLocale();
        const progress = useGuideProgress();
        const books = ref<Book[]>([]);
        const articles = ref<Article[]>([]);
        const loading = ref(true);

        onMounted(async () => {
            const [loadedBooks, loadedArticles] = await Promise.all([loadBooks(), loadArticles("en")]);
            books.value = loadedBooks;
            articles.value = loadedArticles;
            await progress.loadGuideProgress();
            loading.value = false;
        });

        const bookId = computed(() => Number(route.params.bookId));
        const book = computed(() => books.value.find((entry) => Number(entry.id) === bookId.value));
        const bookIndex = computed(() => books.value.findIndex((entry) => Number(entry.id) === bookId.value));
        const bookArticles = computed(() =>
            articles.value
                .filter((article) => article.book === bookId.value)
                .sort((left, right) => left.order - right.order),
        );
        const readCount = computed(() => progress.readCount(bookArticles.value.map((article) => article.id)));
        const percent = computed(() =>
            bookArticles.value.length > 0 ? Math.round((readCount.value / bookArticles.value.length) * 100) : 0,
        );
        const previousBook = computed(() => (bookIndex.value > 0 ? books.value[bookIndex.value - 1] : null));
        const nextBook = computed(() =>
            bookIndex.value >= 0 && bookIndex.value < books.value.length - 1
                ? books.value[bookIndex.value + 1]
                : null,
        );
        const role = computed(() => String(user.value?.userInfo?.role ?? ""));

        return () => (
            <ScreenContainer>
                <PageHeader
                    title={book.value ? `Book ${book.value.id}: ${book.value.title}` : L("Book not found", "الكتاب غير موجود")}
                    subtitle={book.value?.audience}
                    breadcrumbs={[
                        { label: L("Guide", "الدليل"), to: "/guide" },
                        { label: book.value ? `Book ${book.value.id}` : String(route.params.bookId) },
                    ]}
                />
                {loading.value ? (
                    <p class="guide-page-loading">{L("Loading…", "جارٍ التحميل…")}</p>
                ) : !book.value ? (
                    <div class="guide-empty">
                        <p>{L("This book does not exist. Open the guide home to choose a book.", "هذا الكتاب غير موجود. افتح صفحة الدليل لاختيار كتاب.")}</p>
                        <RouterLink class="guide-primary-button" to={{ name: "AdminGuide" }}>
                            {L("Guide home", "صفحة الدليل")}
                        </RouterLink>
                    </div>
                ) : (
                    <div class="guide-book-page">
                        <section class="guide-book-summary">
                            <p>{book.value.summary}</p>
                            <div class="guide-book-progress">
                                <div class="guide-progress-track" role="progressbar" aria-valuenow={percent.value} aria-valuemin={0} aria-valuemax={100}>
                                    <span style={{ width: `${percent.value}%` }} />
                                </div>
                                <span>{percent.value}% · {readCount.value}/{bookArticles.value.length} {L("read", "مقروء")}</span>
                            </div>
                        </section>
                        <ol class="guide-article-list">
                            {bookArticles.value.map((article) => {
                                const read = progress.isRead(article.id);
                                const recommended =
                                    article.roles === "ALL" || article.roles.includes(role.value as never);
                                return (
                                    <li key={article.id} class={read ? "guide-article-row guide-article-row--read" : "guide-article-row"}>
                                        <span class="guide-article-order">{article.id}</span>
                                        <div class="guide-article-main">
                                            <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: article.id } }}>
                                                {article.title}
                                            </RouterLink>
                                            <span class="guide-article-meta">
                                                {article.minutes} {L("min", "دقيقة")}
                                                {recommended ? ` · ${L("Recommended for you", "موصى به لك")}` : ""}
                                                {article.ui !== "AVAILABLE" ? ` · ${article.ui}` : ""}
                                            </span>
                                        </div>
                                        <span class="guide-article-read">{read ? "✓" : "○"}</span>
                                    </li>
                                );
                            })}
                        </ol>
                        <nav class="guide-book-nav" aria-label={L("Book navigation", "تنقل الكتب")}>
                            {previousBook.value ? (
                                <RouterLink to={{ name: "AdminGuideBook", params: { bookId: previousBook.value.id } }}>
                                    ← {L("Previous book", "الكتاب السابق")}: {previousBook.value.title}
                                </RouterLink>
                            ) : <span />}
                            {nextBook.value ? (
                                <RouterLink to={{ name: "AdminGuideBook", params: { bookId: nextBook.value.id } }}>
                                    {L("Next book", "الكتاب التالي")}: {nextBook.value.title} →
                                </RouterLink>
                            ) : null}
                        </nav>
                    </div>
                )}
            </ScreenContainer>
        );
    },
});

export default AdminGuideBookPage;
