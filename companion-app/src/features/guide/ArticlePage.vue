<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import MarkdownView from "@/components/MarkdownView.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useI18n } from "@/lib/i18n";
import { successFeedback, tapFeedback } from "@/lib/haptics";
import {
    addHighlight,
    isBookmarked,
    isGuideRead,
    readingPosition,
    recordGuideRead,
    recordLastRead,
    recordReadingDay,
    setReadingPosition,
    toggleBookmark,
    useCompanionData,
} from "@/lib/data";
import {
    articleById,
    bookById,
    nextArticle,
    previousArticle,
    useContent,
} from "@/content/store";

const route = useRoute();
const { L } = useI18n();
const { bundle } = useContent();
const { data } = useCompanionData();

const articleId = computed(() => String(route.params.articleId ?? ""));
const article = computed(() => articleById(articleId.value));
const book = computed(() => (article.value ? bookById(article.value.book) : undefined));
const previous = computed(() => (article.value ? previousArticle(article.value) : undefined));
const next = computed(() => (article.value ? nextArticle(article.value) : undefined));
const related = computed(() =>
    (article.value?.related ?? [])
        .map((id) => articleById(id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
);
const targetKey = computed(() => `article:${articleId.value}`);
const read = computed(() => isGuideRead(articleId.value));
const bookmarked = computed(() => isBookmarked("article", articleId.value));
const focusMode = ref(false);
const showToc = ref(false);
const copied = ref(false);
const highlighted = ref(false);
const hasSelection = ref(false);
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let lastPercent = 0;

const savePosition = (): void => {
    if (!article.value) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    const percent = max > 0 ? Math.max(0, Math.min(100, (window.scrollY / max) * 100)) : 0;
    lastPercent = percent;
    setReadingPosition(targetKey.value, percent);
};

const onSelectionChange = (): void => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    const anchor = selection?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    hasSelection.value = Boolean(text) && Boolean(element?.closest(".reader-sheet"));
};

const highlightSelection = (): void => {
    if (!article.value) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!text) return;
    addHighlight({
        kind: "article",
        targetId: article.value.id,
        title: article.value.title,
        text: text.slice(0, 4000),
        color: "yellow",
    });
    selection?.removeAllRanges();
    hasSelection.value = false;
    highlighted.value = true;
    void successFeedback();
    window.setTimeout(() => (highlighted.value = false), 1800);
};

const onScroll = (): void => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(savePosition, 700);
};

const restorePosition = async (): Promise<void> => {
    await nextTick();
    const hash = String(route.hash ?? "").replace(/^#/, "");
    if (hash) {
        window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ block: "start" }), 180);
        return;
    }
    const position = readingPosition(targetKey.value);
    if (!position) {
        window.scrollTo({ top: 0 });
        return;
    }
    window.setTimeout(() => {
        if (position.headingId) {
            const element = document.getElementById(position.headingId);
            if (element) {
                element.scrollIntoView({ block: "start" });
                return;
            }
        }
        const doc = document.documentElement;
        const max = doc.scrollHeight - window.innerHeight;
        window.scrollTo({ top: (max * position.percent) / 100 });
    }, 180);
};

const enter = (): void => {
    if (!article.value) return;
    recordLastRead("article", article.value.id, article.value.title, route.fullPath);
    recordReadingDay();
    void restorePosition();
};

const toggleRead = (): void => {
    if (!article.value) return;
    recordGuideRead(article.value.id, bundle.value?.meta.contentVersion ?? "0.0.0", !read.value);
    if (read.value) void successFeedback();
    else void tapFeedback();
};

const toggleArticleBookmark = (): void => {
    if (!article.value) return;
    void tapFeedback();
    toggleBookmark({
        kind: "article",
        targetId: article.value.id,
        title: article.value.title,
    });
};

const toggleSectionBookmark = (headingId: string, headingText: string): void => {
    if (!article.value) return;
    void tapFeedback();
    toggleBookmark({
        kind: "article",
        targetId: article.value.id,
        title: article.value.title,
        headingId,
        label: headingText,
    });
};

const scrollToHeading = (id: string): void => {
    showToc.value = false;
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
};

const toggleFocus = (): void => {
    focusMode.value = !focusMode.value;
    document.documentElement.classList.toggle("focus-reading", focusMode.value);
};

const copyReference = async (): Promise<void> => {
    if (!article.value) return;
    const text = `${article.value.id} | content ${bundle.value?.meta.contentVersion ?? ""}`;
    try {
        await navigator.clipboard?.writeText(text);
        copied.value = true;
        window.setTimeout(() => (copied.value = false), 1800);
    } catch {
        copied.value = false;
    }
};

onMounted(() => {
    enter();
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
});
onBeforeUnmount(() => {
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("selectionchange", onSelectionChange);
    if (scrollTimer) clearTimeout(scrollTimer);
    savePosition();
    document.documentElement.classList.remove("focus-reading");
});

watch(articleId, () => {
    enter();
    window.scrollTo({ top: 0 });
});

watch(article, (value) => {
    if (!value) return;
    if (lastPercent > 0) savePosition();
});
</script>

<template>
    <div class="page reader-page" :class="{ 'reader-page--focus': focusMode }">
        <PageHeader
            :title="article?.title ?? 'Article not found'"
            :subtitle="article && book ? `Book ${article.book}: ${book.title} · ${article.minutes} min` : undefined"
            :back-to="article ? `/guide/book/${article.book}` : '/guide'"
        >
            <template #actions>
                <button
                    type="button"
                    class="icon-button"
                    :class="{ 'is-on': bookmarked }"
                    :aria-label="L('guide.bookmark')"
                    @click="toggleArticleBookmark"
                >
                    <AppIcon name="bookmark" :size="20" />
                </button>
                <button type="button" class="icon-button" aria-label="Table of contents" @click="showToc = true">
                    <AppIcon name="menu" :size="20" />
                </button>
            </template>
        </PageHeader>

        <template v-if="article">
            <div class="reader-meta">
                <span class="chip">{{ L("common.minutes", { n: article.minutes }) }}</span>
                <span class="chip">{{ L("common.book", { n: article.book }) }}</span>
                <span v-if="article.ui !== 'AVAILABLE'" class="chip chip--warning">{{ article.ui }}</span>
                <span v-if="read" class="chip chip--success">{{ L("guide.read") }}</span>
                <button type="button" class="chip chip--action" @click="toggleFocus">
                    <AppIcon name="book" :size="14" />
                    {{ focusMode ? "Exit focus" : "Focus" }}
                </button>
            </div>

            <article class="reader-sheet">
                <MarkdownView :source="article.body" :article-id="article.id" />
            </article>

            <div class="reader-actions">
                <button type="button" class="btn" :class="read ? 'btn--ghost' : 'btn--primary'" @click="toggleRead">
                    <AppIcon name="check" :size="17" />
                    {{ read ? L("guide.markUnread") : L("guide.markRead") }}
                </button>
                <button type="button" class="btn btn--ghost" @click="toggleArticleBookmark">
                    <AppIcon name="bookmark" :size="17" />
                    {{ bookmarked ? "Bookmarked" : L("guide.bookmark") }}
                </button>
                <button type="button" class="btn btn--ghost" @click="copyReference">
                    <AppIcon name="share" :size="17" />
                    {{ copied ? "Copied" : L("guide.reportProblem") }}
                </button>
            </div>

            <section v-if="related.length" class="section related-section">
                <h2>{{ L("guide.related") }}</h2>
                <ul class="simple-list">
                    <li v-for="entry in related" :key="entry.id">
                        <RouterLink :to="`/guide/article/${entry.id}`" class="simple-row">
                            <span dir="auto">{{ entry.title }}</span>
                            <AppIcon name="chevron-right" :size="17" />
                        </RouterLink>
                    </li>
                </ul>
            </section>

            <nav class="pager" aria-label="Article navigation">
                <RouterLink v-if="previous" :to="`/guide/article/${previous.id}`" class="pager__link">
                    <AppIcon name="arrow-left" :size="17" />
                    <span>
                        <small>{{ L("guide.previous") }}</small>
                        <strong dir="auto">{{ previous.title }}</strong>
                    </span>
                </RouterLink>
                <span v-else />
                <RouterLink v-if="next" :to="`/guide/article/${next.id}`" class="pager__link pager__link--next">
                    <span>
                        <small>{{ L("guide.next") }}</small>
                        <strong dir="auto">{{ next.title }}</strong>
                    </span>
                    <AppIcon name="arrow-right" :size="17" />
                </RouterLink>
            </nav>
            <p class="content-footnote">
                {{ L("guide.contentVersion") }} {{ bundle?.meta.contentVersion }} · {{ bundle?.meta.contentHash.slice(0, 10) }}
            </p>
        </template>
        <div v-else class="empty-state">
            <h2>This article does not exist.</h2>
            <RouterLink to="/guide" class="btn btn--primary">{{ L("nav.guide") }}</RouterLink>
        </div>

        <Teleport to="body">
            <div v-if="showToc && article" class="sheet-backdrop" @click.self="showToc = false">
                <section class="sheet" role="dialog" aria-modal="true" aria-label="Table of contents">
                    <header class="sheet__header">
                        <div>
                            <p class="eyebrow">{{ L("guide.continue") }}</p>
                            <h2>Table of contents</h2>
                        </div>
                        <button type="button" class="icon-button" @click="showToc = false">
                            <AppIcon name="close" />
                        </button>
                    </header>
                    <ul class="toc-list">
                        <li v-for="heading in article.headings" :key="heading.id" class="toc-row">
                            <button type="button" class="toc-jump" @click="scrollToHeading(heading.id)">
                                <span :class="`toc-level-${heading.level}`">{{ heading.text }}</span>
                            </button>
                            <button
                                type="button"
                                class="icon-button icon-button--tiny"
                                :class="{ 'is-on': isBookmarked('article', article.id, heading.id) }"
                                aria-label="Bookmark section"
                                @click="toggleSectionBookmark(heading.id, heading.text)"
                            >
                                <AppIcon name="bookmark" :size="15" />
                            </button>
                        </li>
                    </ul>
                </section>
            </div>
        </Teleport>

        <button
            v-if="hasSelection"
            type="button"
            class="selection-action"
            @mousedown.prevent
            @click="highlightSelection"
        >
            <AppIcon name="highlight" :size="18" />
            Highlight selection
        </button>
        <div v-if="highlighted" class="toast" role="status">Highlight saved.</div>
    </div>
</template>
