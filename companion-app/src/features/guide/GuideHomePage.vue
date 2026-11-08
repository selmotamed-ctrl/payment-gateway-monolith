<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import { useCompanionData, isGuideRead } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { articlesInBook, articleById, readingPathFor, useContent } from "@/content/store";

const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const guide = computed(() => bundle.value?.guide);
const path = computed(() => readingPathFor(data.value.role));
const pathArticles = computed(() =>
    (path.value?.articles ?? []).map((id) => articleById(id)).filter((article): article is NonNullable<typeof article> => Boolean(article)),
);
const pathRead = computed(() => pathArticles.value.filter((article) => isGuideRead(article.id)).length);
const continueTarget = computed(() => data.value.lastRead?.route ?? "/guide/article/b00-01");
const continueTitle = computed(() => data.value.lastRead?.title ?? "Welcome: what this system is and why this guide exists");

const referenceLinks = computed(() => [
    { to: "/guide/glossary", icon: "book", title: L("guide.glossary"), note: `${guide.value?.glossary.length ?? 0} terms` },
    { to: "/guide/cards", icon: "check", title: L("guide.cards"), note: `${guide.value?.cards.length ?? 0} cards` },
    { to: "/guide/playbook", icon: "help", title: L("guide.playbook"), note: `${guide.value?.playbook.length ?? 0} situations` },
    { to: "/guide/edge-cases", icon: "alert", title: L("guide.edgeCases"), note: `${guide.value?.edgeCases.length ?? 0} cases` },
    { to: "/guide/reference", icon: "note", title: L("guide.faq"), note: `${guide.value?.faq.length ?? 0} answers` },
    { to: "/guide/tools", icon: "tools", title: L("guide.tools"), note: "5 simulators" },
]);

const bookCount = (bookId: string): number => articlesInBook(bookId).length;
const bookRead = (bookId: string): number =>
    articlesInBook(bookId).filter((article) => isGuideRead(article.id)).length;
</script>

<template>
    <div class="page guide-home">
        <PageHeader :title="L('guide.title')" :subtitle="L('guide.subtitle')" :show-back="false">
            <template #actions>
                <RouterLink to="/search" class="icon-button" aria-label="Search">
                    <AppIcon name="search" />
                </RouterLink>
            </template>
        </PageHeader>

        <section class="hero-card">
            <p class="eyebrow">{{ L("guide.continue") }}</p>
            <h2 dir="auto">{{ continueTitle }}</h2>
            <p class="muted">The guide is complete offline. Open a bookmark, follow a path, or look up a rule.</p>
            <div class="hero-actions">
                <RouterLink :to="continueTarget" class="btn btn--primary">
                    <AppIcon name="play" :size="17" />
                    {{ L("common.continue") }}
                </RouterLink>
                <RouterLink to="/guide/reference" class="btn btn--ghost">{{ L("guide.reference") }}</RouterLink>
            </div>
        </section>

        <section class="section">
            <div class="section-head">
                <div>
                    <p class="eyebrow">{{ L("guide.path") }}</p>
                    <h2>{{ path?.title ?? L("guide.title") }}</h2>
                </div>
                <span class="muted">{{ pathRead }} / {{ pathArticles.length }}</span>
            </div>
            <ProgressBar :value="pathRead" :max="pathArticles.length" :label="L('guide.path')" />
            <ol class="path-list">
                <li v-for="article in pathArticles.slice(0, 6)" :key="article.id">
                    <RouterLink :to="`/guide/article/${article.id}`" class="path-row">
                        <span class="check-dot" :class="{ 'is-done': isGuideRead(article.id) }">
                            <AppIcon v-if="isGuideRead(article.id)" name="check" :size="13" />
                        </span>
                        <span>
                            <strong dir="auto">{{ article.title }}</strong>
                            <small>{{ L("common.minutes", { n: article.minutes }) }} · {{ L("common.book", { n: article.book }) }}</small>
                        </span>
                        <AppIcon name="chevron-right" :size="18" />
                    </RouterLink>
                </li>
            </ol>
            <RouterLink to="/settings" class="text-link">{{ data.role ? "Change reading path" : L("today.pickRole") }} →</RouterLink>
        </section>

        <section class="section">
            <div class="section-head">
                <h2>{{ L("guide.books") }}</h2>
                <span class="muted">{{ guide?.books.length }} books</span>
            </div>
            <div class="book-grid">
                <RouterLink
                    v-for="book in guide?.books ?? []"
                    :key="book.id"
                    :to="`/guide/book/${book.id}`"
                    class="book-card"
                >
                    <span class="book-number">{{ book.id }}</span>
                    <strong dir="auto">{{ book.title }}</strong>
                    <small>{{ bookRead(book.id) }} / {{ bookCount(book.id) }} read</small>
                    <ProgressBar :value="bookRead(book.id)" :max="bookCount(book.id)" :label="book.title" />
                </RouterLink>
            </div>
        </section>

        <section class="section">
            <div class="section-head">
                <h2>{{ L("guide.reference") }}</h2>
            </div>
            <div class="quick-grid">
                <RouterLink v-for="link in referenceLinks" :key="link.to" :to="link.to" class="quick-card">
                    <span class="quick-icon"><AppIcon :name="link.icon" :size="19" /></span>
                    <span>
                        <strong>{{ link.title }}</strong>
                        <small>{{ link.note }}</small>
                    </span>
                    <AppIcon name="chevron-right" :size="17" />
                </RouterLink>
            </div>
        </section>
    </div>
</template>
