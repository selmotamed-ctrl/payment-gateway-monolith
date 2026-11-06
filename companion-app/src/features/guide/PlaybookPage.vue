<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import MarkdownView from "@/components/MarkdownView.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useI18n } from "@/lib/i18n";
import { articleById, edgeCaseByNumber, situationById, useContent } from "@/content/store";

const route = useRoute();
const router = useRouter();
const { L } = useI18n();
const { bundle } = useContent();
const query = ref("");
const screen = ref("");

const situations = computed(() => bundle.value?.guide.playbook ?? []);
const screens = computed(() => {
    const set = new Set<string>();
    for (const situation of situations.value) for (const entry of situation.screens) set.add(entry);
    return [...set].sort();
});
const filtered = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase();
    return situations.value.filter((situation) => {
        if (screen.value && !situation.screens.includes(screen.value)) return false;
        if (!needle) return true;
        return `${situation.title} ${situation.body} ${situation.screens.join(" ")}`.toLocaleLowerCase().includes(needle);
    });
});
const selectedId = computed(() => String(route.params.id ?? ""));
const selected = computed(() => situationById(selectedId.value));
const selectedArticles = computed(() =>
    (selected.value?.articles ?? [])
        .map((id) => articleById(id))
        .filter((article): article is NonNullable<typeof article> => Boolean(article)),
);
const selectedCases = computed(() =>
    (selected.value?.cases ?? [])
        .map((number) => edgeCaseByNumber(number))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
);
const open = (id: string): void => {
    void router.push(`/guide/playbook/${id}`);
};
</script>

<template>
    <div class="page">
        <PageHeader
            :title="L('guide.playbook')"
            subtitle="What you may see, what it means, what to do and what not to do."
            back-to="/guide"
        />
        <div class="filter-bar">
            <input v-model="query" class="input" type="search" :placeholder="L('guide.searchPlaceholder')" :aria-label="L('guide.searchPlaceholder')" />
            <select v-model="screen" class="select" aria-label="Screen">
                <option value="">All screens</option>
                <option v-for="entry in screens" :key="entry" :value="entry">{{ entry }}</option>
            </select>
        </div>

        <div class="split-glossary">
            <ul class="term-list">
                <li v-for="situation in filtered" :key="situation.id">
                    <button
                        type="button"
                        class="term-row"
                        :class="{ 'is-active': situation.id === selectedId }"
                        @click="open(situation.id)"
                    >
                        <span>
                            <strong dir="auto">{{ situation.title }}</strong>
                            <small>{{ situation.screens.join(", ") }} · cases {{ situation.cases.join(", ") }}</small>
                        </span>
                    </button>
                </li>
                <li v-if="filtered.length === 0" class="empty-inline">{{ L("guide.noResults") }}</li>
            </ul>

            <article v-if="selected" class="term-detail">
                <h2 dir="auto">{{ selected.title }}</h2>
                <MarkdownView :source="selected.body" />
                <section v-if="selectedArticles.length" class="related-section">
                    <p class="eyebrow">Read next</p>
                    <ul class="simple-list">
                        <li v-for="article in selectedArticles" :key="article.id">
                            <RouterLink :to="`/guide/article/${article.id}`" class="simple-row">
                                <span dir="auto">{{ article.title }}</span>
                                <AppIcon name="chevron-right" :size="16" />
                            </RouterLink>
                        </li>
                    </ul>
                </section>
                <section v-if="selectedCases.length" class="related-section">
                    <p class="eyebrow">Edge cases</p>
                    <ul class="simple-list">
                        <li v-for="entry in selectedCases" :key="entry.n">
                            <RouterLink :to="`/guide/edge-cases?case=${entry.n}`" class="simple-row">
                                <span dir="auto">Case {{ entry.n }}: {{ entry.scenario }}</span>
                                <AppIcon name="chevron-right" :size="16" />
                            </RouterLink>
                        </li>
                    </ul>
                </section>
            </article>
            <div v-else class="term-detail empty-state empty-state--small">
                <AppIcon name="help" :size="26" />
                <p>Choose a situation from the list.</p>
            </div>
        </div>
    </div>
</template>
