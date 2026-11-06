<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import { searchGroups, type SearchGroup } from "@/content/search";
import { useCompanionData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";

const router = useRouter();
const { data } = useCompanionData();
const { L } = useI18n();
const query = ref("");
const groups = ref<SearchGroup[]>([]);
const loading = ref(false);
const input = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

const recent = computed(() => data.value.lastRead);
const hasQuery = computed(() => query.value.trim().length > 0);

const run = async (): Promise<void> => {
    if (!hasQuery.value) {
        groups.value = [];
        return;
    }
    loading.value = true;
    try {
        groups.value = await searchGroups(query.value);
    } finally {
        loading.value = false;
    }
};

watch(query, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), 120);
});

onMounted(() => {
    input.value?.focus();
});

const open = (route: string): void => {
    void router.push(route);
};

const quickLinks = [
    { to: "/guide", icon: "book", title: "Guide", note: "Books, articles and reference" },
    { to: "/academy", icon: "academy", title: "Academy", note: "Tracks, lessons and labs" },
    { to: "/guide/glossary", icon: "book", title: "Glossary", note: "Every term A–Z" },
    { to: "/guide/edge-cases", icon: "alert", title: "Edge cases", note: "140 deterministic resolutions" },
];
</script>

<template>
    <div class="page search-page">
        <PageHeader :title="L('search.title')" :show-back="false">
            <div class="search-box">
                <AppIcon name="search" :size="19" />
                <input
                    ref="input"
                    v-model="query"
                    type="search"
                    :placeholder="L('search.placeholder')"
                    :aria-label="L('search.placeholder')"
                    autocomplete="off"
                    spellcheck="false"
                />
                <button v-if="query" type="button" class="icon-button icon-button--tiny" aria-label="Clear" @click="query = ''">
                    <AppIcon name="close" :size="16" />
                </button>
            </div>
        </PageHeader>

        <div v-if="loading" class="app-state app-state--inline">
            <p>{{ L("common.loading") }}</p>
        </div>

        <template v-else-if="hasQuery">
            <section v-for="group in groups" :key="group.type" class="search-group">
                <div class="section-head">
                    <h2>{{ group.label }}</h2>
                    <span class="muted">{{ group.hits.length }}</span>
                </div>
                <ul class="simple-list">
                    <li v-for="hit in group.hits" :key="hit.id">
                        <button type="button" class="search-hit" @click="open(hit.route)">
                            <span class="search-hit__icon"><AppIcon :name="group.type === 'lesson' || group.type === 'lab' ? 'academy' : group.type === 'term' ? 'book' : 'note'" :size="17" /></span>
                            <span class="search-hit__main">
                                <strong dir="auto">{{ hit.title }}</strong>
                                <small dir="auto">{{ hit.subtitle }}</small>
                            </span>
                            <AppIcon name="chevron-right" :size="17" />
                        </button>
                    </li>
                </ul>
            </section>
            <div v-if="groups.length === 0" class="empty-state empty-state--small">
                <AppIcon name="search" :size="26" />
                <h2>{{ L("guide.noResults") }}</h2>
                <p class="muted">Try UNKNOWN, LIMIT_EXCEEDED, or maker checker.</p>
            </div>
        </template>

        <template v-else>
            <section v-if="recent" class="section">
                <div class="section-head"><h2>{{ L("search.recent") }}</h2></div>
                <button type="button" class="recent-card" @click="open(recent.route)">
                    <AppIcon name="clock" :size="18" />
                    <span><strong dir="auto">{{ recent.title }}</strong><small>{{ recent.kind === "lesson" ? "Academy lesson" : "Guide article" }}</small></span>
                    <AppIcon name="chevron-right" :size="17" />
                </button>
            </section>
            <section class="section">
                <div class="quick-grid">
                    <RouterLink v-for="link in quickLinks" :key="link.to" :to="link.to" class="quick-card">
                        <span class="quick-icon"><AppIcon :name="link.icon" :size="19" /></span>
                        <span><strong>{{ link.title }}</strong><small>{{ link.note }}</small></span>
                        <AppIcon name="chevron-right" :size="17" />
                    </RouterLink>
                </div>
            </section>
            <p class="muted search-note">{{ L("search.empty") }}</p>
        </template>
    </div>
</template>
