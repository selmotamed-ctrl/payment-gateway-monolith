<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useI18n } from "@/lib/i18n";
import { termBySlug, useContent } from "@/content/store";

const route = useRoute();
const router = useRouter();
const { L } = useI18n();
const { bundle } = useContent();
const query = ref("");
const letter = ref("");

const terms = computed(() => bundle.value?.guide.glossary ?? []);
const normalized = (value: string): string => value.toLocaleLowerCase().replace(/[\u064B-\u065F]/g, "");
const filtered = computed(() => {
    const needle = normalized(query.value.trim());
    return terms.value
        .filter((term) => {
            if (letter.value && term.term.trim().charAt(0).toLocaleUpperCase() !== letter.value) return false;
            if (!needle) return true;
            return normalized([term.term, term.aliases.join(" "), term.ar ?? "", term.short].join(" ")).includes(needle);
        })
        .sort((left, right) => left.term.localeCompare(right.term));
});
const letters = computed(() => {
    const set = new Set<string>();
    for (const term of terms.value) {
        const first = term.term.trim().charAt(0).toLocaleUpperCase();
        if (first) set.add(first);
    }
    return [...set].sort((left, right) => left.localeCompare(right));
});
const selectedSlug = computed(() => String(route.params.slug ?? ""));
const selected = computed(() => termBySlug(selectedSlug.value));
const related = computed(() =>
    (selected.value?.related ?? [])
        .map((slug) => termBySlug(slug))
        .filter((term): term is NonNullable<typeof term> => Boolean(term)),
);
const open = (slug: string): void => {
    void router.push(`/guide/glossary/${slug}`);
};
</script>

<template>
    <div class="page">
        <PageHeader :title="L('guide.glossary')" subtitle="Every unfamiliar word, explained in plain language." back-to="/guide">
            <template #actions>
                <RouterLink to="/search" class="icon-button" aria-label="Search">
                    <AppIcon name="search" />
                </RouterLink>
            </template>
        </PageHeader>

        <div class="filter-bar">
            <input v-model="query" class="input" type="search" :placeholder="L('guide.searchPlaceholder')" :aria-label="L('guide.searchPlaceholder')" />
        </div>
        <div class="letter-bar" role="group" aria-label="Jump to letter">
            <button type="button" class="chip" :class="{ 'is-active': letter === '' }" @click="letter = ''">{{ L("common.all") }}</button>
            <button
                v-for="entry in letters"
                :key="entry"
                type="button"
                class="chip"
                :class="{ 'is-active': letter === entry }"
                @click="letter = letter === entry ? '' : entry"
            >
                {{ entry }}
            </button>
        </div>

        <div class="split-glossary">
            <ul class="term-list">
                <li v-for="term in filtered" :key="term.slug">
                    <button
                        type="button"
                        class="term-row"
                        :class="{ 'is-active': term.slug === selectedSlug }"
                        @click="open(term.slug)"
                    >
                        <span>
                            <strong dir="auto">{{ term.term }}</strong>
                            <small dir="auto">{{ term.short }}</small>
                        </span>
                        <span v-if="term.ar" class="arabic-inline" dir="rtl" lang="ar">{{ term.ar }}</span>
                    </button>
                </li>
                <li v-if="filtered.length === 0" class="empty-inline">{{ L("guide.noResults") }}</li>
            </ul>

            <article class="term-detail">
                <template v-if="selected">
                    <p class="eyebrow">Term</p>
                    <h2 dir="auto">{{ selected.term }}</h2>
                    <p v-if="selected.ar" class="arabic-term" dir="rtl" lang="ar">{{ selected.ar }}</p>
                    <p class="term-short" dir="auto">{{ selected.short }}</p>
                    <p v-if="selected.aliases.length" class="muted" dir="auto">Also called: {{ selected.aliases.join(", ") }}</p>
                    <div v-if="related.length" class="related-terms">
                        <p class="eyebrow">Related terms</p>
                        <button v-for="term in related" :key="term.slug" type="button" class="chip" @click="open(term.slug)">
                            {{ term.term }}
                        </button>
                    </div>
                </template>
                <div v-else class="empty-state empty-state--small">
                    <AppIcon name="book" :size="24" />
                    <p>Choose a term to read its definition.</p>
                </div>
            </article>
        </div>
    </div>
</template>
