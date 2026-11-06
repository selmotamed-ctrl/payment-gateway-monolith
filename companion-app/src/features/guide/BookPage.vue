<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import { useI18n } from "@/lib/i18n";
import { isGuideRead } from "@/lib/data";
import { articlesInBook, bookById, useContent } from "@/content/store";

const route = useRoute();
const { L } = useI18n();
const { bundle } = useContent();

const bookId = computed(() => String(route.params.bookId ?? ""));
const book = computed(() => bookById(bookId.value));
const articles = computed(() => articlesInBook(bookId.value));
const read = computed(() => articles.value.filter((article) => isGuideRead(article.id)).length);
const books = computed(() => bundle.value?.guide.books ?? []);
const index = computed(() => books.value.findIndex((entry) => entry.id === bookId.value));
const previous = computed(() => (index.value > 0 ? books.value[index.value - 1] : undefined));
const next = computed(() => (index.value >= 0 ? books.value[index.value + 1] : undefined));
</script>

<template>
    <div class="page">
        <PageHeader
            :title="book ? `Book ${book.id}: ${book.title}` : 'Book not found'"
            :subtitle="book?.audience"
            back-to="/guide"
        >
            <template #actions>
                <RouterLink to="/search" class="icon-button" aria-label="Search">
                    <AppIcon name="search" />
                </RouterLink>
            </template>
        </PageHeader>

        <template v-if="book">
            <section class="summary-card">
                <p dir="auto">{{ book.summary }}</p>
                <div class="progress-row">
                    <ProgressBar :value="read" :max="articles.length" :label="book.title" />
                    <span>{{ L("guide.bookProgress", { done: read, total: articles.length }) }}</span>
                </div>
            </section>

            <ol class="article-list">
                <li v-for="article in articles" :key="article.id">
                    <RouterLink :to="`/guide/article/${article.id}`" class="article-row">
                        <span class="article-order">{{ article.id }}</span>
                        <span class="article-row__main">
                            <strong dir="auto">{{ article.title }}</strong>
                            <small>
                                {{ L("common.minutes", { n: article.minutes }) }}
                                <span v-if="article.ui !== 'AVAILABLE'"> · {{ article.ui }}</span>
                            </small>
                        </span>
                        <span class="check-dot" :class="{ 'is-done': isGuideRead(article.id) }">
                            <AppIcon v-if="isGuideRead(article.id)" name="check" :size="13" />
                        </span>
                    </RouterLink>
                </li>
            </ol>

            <nav class="pager" aria-label="Book navigation">
                <RouterLink v-if="previous" :to="`/guide/book/${previous.id}`" class="pager__link">
                    <AppIcon name="arrow-left" :size="17" />
                    <span>
                        <small>Previous book</small>
                        <strong dir="auto">{{ previous.title }}</strong>
                    </span>
                </RouterLink>
                <span v-else />
                <RouterLink v-if="next" :to="`/guide/book/${next.id}`" class="pager__link pager__link--next">
                    <span>
                        <small>Next book</small>
                        <strong dir="auto">{{ next.title }}</strong>
                    </span>
                    <AppIcon name="arrow-right" :size="17" />
                </RouterLink>
            </nav>
        </template>
        <div v-else class="empty-state">
            <h2>This book does not exist.</h2>
            <RouterLink to="/guide" class="btn btn--primary">{{ L("nav.guide") }}</RouterLink>
        </div>
    </div>
</template>
