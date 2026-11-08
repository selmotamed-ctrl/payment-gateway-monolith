<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useI18n } from "@/lib/i18n";
import { useContent } from "@/content/store";

const { L } = useI18n();
const { bundle } = useContent();
const query = ref("");

const faq = computed(() => bundle.value?.guide.faq ?? []);
const codes = computed(() => bundle.value?.guide.errorCodes ?? []);
const articles = computed(() => new Map((bundle.value?.guide.articles ?? []).map((article) => [article.id, article])));
const needle = computed(() => query.value.trim().toLocaleLowerCase());
const filteredFaq = computed(() =>
    faq.value.filter((entry) => !needle.value || `${entry.question} ${entry.answer}`.toLocaleLowerCase().includes(needle.value)),
);
const filteredCodes = computed(() =>
    codes.value.filter((entry) => !needle.value || `${entry.code} ${entry.where} ${entry.meaning} ${entry.action}`.toLocaleLowerCase().includes(needle.value)),
);
</script>

<template>
    <div class="page">
        <PageHeader
            :title="L('guide.reference')"
            subtitle="Quick answers, error codes and the other lookup surfaces."
            back-to="/guide"
        />
        <div class="filter-bar">
            <input v-model="query" class="input" type="search" placeholder="Search answers and error codes…" aria-label="Search reference" />
        </div>

        <section class="section">
            <div class="section-head">
                <h2>{{ L("guide.faq") }}</h2>
                <span class="muted">{{ filteredFaq.length }}</span>
            </div>
            <div class="faq-list">
                <details v-for="entry in filteredFaq" :key="entry.id" class="faq-card">
                    <summary dir="auto">{{ entry.question }}</summary>
                    <p dir="auto">{{ entry.answer }}</p>
                    <RouterLink :to="`/guide/article/${entry.article}`" class="text-link">
                        {{ articles.get(entry.article)?.title ?? "Open article" }} →
                    </RouterLink>
                </details>
                <p v-if="filteredFaq.length === 0" class="empty-inline">{{ L("guide.noResults") }}</p>
            </div>
        </section>

        <section class="section">
            <div class="section-head">
                <h2>{{ L("guide.errorCodes") }}</h2>
                <span class="muted">{{ filteredCodes.length }}</span>
            </div>
            <ul class="code-list">
                <li v-for="entry in filteredCodes" :key="entry.code" class="code-card">
                    <code>{{ entry.code }}</code>
                    <small>{{ entry.where }}</small>
                    <p dir="auto">{{ entry.meaning }}</p>
                    <p class="muted" dir="auto">{{ entry.action }}</p>
                </li>
            </ul>
        </section>

        <section class="section">
            <div class="quick-grid">
                <RouterLink to="/guide/glossary" class="quick-card">
                    <span class="quick-icon"><AppIcon name="book" :size="19" /></span>
                    <span><strong>{{ L("guide.glossary") }}</strong><small>Definitions and aliases</small></span>
                    <AppIcon name="chevron-right" :size="17" />
                </RouterLink>
                <RouterLink to="/guide/cards" class="quick-card">
                    <span class="quick-icon"><AppIcon name="check" :size="19" /></span>
                    <span><strong>{{ L("guide.cards") }}</strong><small>Before a risky action</small></span>
                    <AppIcon name="chevron-right" :size="17" />
                </RouterLink>
                <RouterLink to="/guide/edge-cases" class="quick-card">
                    <span class="quick-icon"><AppIcon name="alert" :size="19" /></span>
                    <span><strong>{{ L("guide.edgeCases") }}</strong><small>Deterministic resolutions</small></span>
                    <AppIcon name="chevron-right" :size="17" />
                </RouterLink>
            </div>
        </section>
    </div>
</template>
