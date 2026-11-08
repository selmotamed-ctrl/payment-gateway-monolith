<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import MarkdownView from "@/components/MarkdownView.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useI18n } from "@/lib/i18n";
import { cardById, useContent } from "@/content/store";

const route = useRoute();
const router = useRouter();
const { L } = useI18n();
const { bundle } = useContent();
const query = ref("");
const risk = ref("");
const ticked = ref<Record<string, boolean>>({});

const cards = computed(() => bundle.value?.guide.cards ?? []);
const filtered = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase();
    return cards.value.filter((card) => {
        if (risk.value && card.risk !== risk.value) return false;
        if (!needle) return true;
        return `${card.title} ${card.screen} ${card.body}`.toLocaleLowerCase().includes(needle);
    });
});
const selectedId = computed(() => String(route.params.id ?? ""));
const selected = computed(() => cardById(selectedId.value));
const open = (id: string): void => {
    void router.push(`/guide/cards/${id}`);
};
const toggle = (key: string): void => {
    ticked.value = { ...ticked.value, [key]: !ticked.value[key] };
};
watch(selectedId, () => {
    ticked.value = {};
});
</script>

<template>
    <div class="page">
        <PageHeader
            :title="L('guide.cards')"
            subtitle="The checklist to read at the moment of a risky action."
            back-to="/guide"
        />
        <div class="filter-bar">
            <input v-model="query" class="input" type="search" :placeholder="L('guide.searchPlaceholder')" :aria-label="L('guide.searchPlaceholder')" />
            <select v-model="risk" class="select" aria-label="Risk level">
                <option value="">All risks</option>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
            </select>
        </div>

        <div class="split-glossary">
            <ul class="term-list">
                <li v-for="card in filtered" :key="card.id">
                    <button
                        type="button"
                        class="term-row"
                        :class="{ 'is-active': card.id === selectedId }"
                        @click="open(card.id)"
                    >
                        <span class="risk-dot" :class="`risk-${card.risk.toLowerCase()}`" aria-hidden="true" />
                        <span>
                            <strong dir="auto">{{ card.title }}</strong>
                            <small>{{ card.screen }} · {{ card.risk }}<template v-if="card.irreversible"> · irreversible</template></small>
                        </span>
                    </button>
                </li>
                <li v-if="filtered.length === 0" class="empty-inline">{{ L("guide.noResults") }}</li>
            </ul>

            <article v-if="selected" class="term-detail card-detail">
                <p class="eyebrow">{{ selected.screen }}</p>
                <div class="section-head">
                    <h2 dir="auto">{{ selected.title }}</h2>
                    <span class="chip" :class="`chip--risk-${selected.risk.toLowerCase()}`">{{ selected.risk }}</span>
                </div>
                <MarkdownView :source="selected.body" />
                <section class="checklist">
                    <p class="eyebrow">Checklist</p>
                    <label v-for="(item, index) in selected.checklist" :key="index" class="check-row">
                        <input type="checkbox" :checked="Boolean(ticked[`${selected.id}:${index}`])" @change="toggle(`${selected.id}:${index}`)" />
                        <span dir="auto">{{ item }}</span>
                    </label>
                </section>
            </article>
            <div v-else class="term-detail empty-state empty-state--small">
                <AppIcon name="check" :size="26" />
                <p>Choose a card to read the four sections.</p>
            </div>
        </div>
    </div>
</template>
