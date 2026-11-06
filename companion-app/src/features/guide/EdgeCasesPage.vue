<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useI18n } from "@/lib/i18n";
import { useContent } from "@/content/store";

const route = useRoute();
const router = useRouter();
const { L } = useI18n();
const { bundle } = useContent();
const query = ref("");
const group = ref("");
const severity = ref("");

const cases = computed(() => bundle.value?.guide.edgeCases ?? []);
const groups = computed(() => {
    const map = new Map<string, string>();
    for (const entry of cases.value) map.set(entry.group, entry.groupName);
    return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
});
const filtered = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase();
    return cases.value.filter((entry) => {
        if (group.value && entry.group !== group.value) return false;
        if (severity.value && entry.severity !== severity.value) return false;
        if (!needle) return true;
        return `${entry.scenario} ${entry.resolution} ${entry.groupName}`.toLocaleLowerCase().includes(needle);
    });
});
const selected = computed(() => Number(route.query.case ?? 0));
const select = async (n: number): Promise<void> => {
    await router.replace({ query: { ...route.query, case: String(n) } });
    await nextTick();
    document.getElementById(`case-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
};
watch(
    () => route.query.case,
    async () => {
        await nextTick();
        if (selected.value) document.getElementById(`case-${selected.value}`)?.scrollIntoView({ block: "center" });
    },
    { immediate: true },
);
</script>

<template>
    <div class="page">
        <PageHeader
            :title="L('guide.edgeCases')"
            :subtitle="`The plain-language catalogue of ${cases.length} known edge cases and their deterministic resolution.`"
            back-to="/guide"
        />
        <div class="filter-bar filter-bar--wrap">
            <input v-model="query" class="input" type="search" placeholder="Search scenarios and resolutions…" aria-label="Search edge cases" />
            <select v-model="group" class="select" aria-label="Group">
                <option value="">All groups</option>
                <option v-for="[letter, name] in groups" :key="letter" :value="letter">{{ letter }} — {{ name }}</option>
            </select>
            <select v-model="severity" class="select" aria-label="Severity">
                <option value="">All severities</option>
                <option value="Low">Low</option>
                <option value="Med">Med</option>
                <option value="High">High</option>
            </select>
            <span class="result-count">{{ filtered.length }} / {{ cases.length }}</span>
        </div>

        <ul class="case-list">
            <li v-for="entry in filtered" :id="`case-${entry.n}`" :key="entry.n">
                <button
                    type="button"
                    class="case-card"
                    :class="{ 'is-active': selected === entry.n }"
                    @click="select(entry.n)"
                >
                    <span class="case-number">{{ entry.n }}</span>
                    <span class="case-main">
                        <strong dir="auto">{{ entry.scenario }}</strong>
                        <small>{{ entry.group }} — {{ entry.groupName }}</small>
                        <span class="case-resolution" dir="auto">{{ entry.resolution }}</span>
                    </span>
                    <span class="chip" :class="`chip--severity-${entry.severity.toLowerCase()}`">{{ entry.severity }}</span>
                </button>
            </li>
        </ul>
        <p v-if="filtered.length === 0" class="empty-state empty-state--small">
            <AppIcon name="search" :size="24" />
            {{ L("guide.noResults") }}
        </p>
    </div>
</template>
