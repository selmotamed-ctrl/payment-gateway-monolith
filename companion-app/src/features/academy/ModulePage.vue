<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useCompanionData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { useContent } from "@/content/store";

const route = useRoute();
const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const moduleId = computed(() => String(route.params.moduleId ?? ""));
const module = computed(() => bundle.value?.academy.modules.find((entry) => entry.id === moduleId.value));
const track = computed(() =>
    bundle.value?.academy.tracks.find((entry) => module.value && entry.moduleIds.includes(module.value.id)),
);
const lessons = computed(() => bundle.value?.academy.lessons ?? []);
const labs = computed(() => bundle.value?.academy.labs ?? []);
const lessonTitle = (id: string): string => lessons.value.find((lesson) => lesson.id === id)?.title ?? id;
const labTitle = (id: string): string => labs.value.find((lab) => lab.id === id)?.title ?? id;
const neighbours = computed(() => {
    if (!track.value || !module.value) return { previous: undefined, next: undefined };
    const index = track.value.moduleIds.indexOf(module.value.id);
    const find = (id: string | undefined) => (id ? bundle.value?.academy.modules.find((entry) => entry.id === id) : undefined);
    return { previous: find(track.value.moduleIds[index - 1]), next: find(track.value.moduleIds[index + 1]) };
});
</script>

<template>
    <div class="page">
        <PageHeader
            v-if="module"
            :title="module.title"
            :subtitle="module.objective"
            :back-to="track ? `/academy/track/${track.id}` : '/academy'"
            tone="academy"
        />
        <template v-if="module">
            <p class="muted"><span class="mono">{{ module.minutes }}</span> min · {{ module.lessonIds.length }} lessons · {{ module.labIds.length }} labs</p>
            <ul class="simple-list">
                <li v-for="lessonId in module.lessonIds" :key="lessonId">
                    <RouterLink :to="`/academy/lesson/${lessonId}`" class="lesson-row">
                        <span class="check-dot" :class="{ 'is-done': data.lessons[lessonId] }">
                            <AppIcon v-if="data.lessons[lessonId]" name="check" :size="13" />
                        </span>
                        <span><strong dir="auto">{{ lessonTitle(lessonId) }}</strong><small>Lesson</small></span>
                        <AppIcon name="chevron-right" :size="17" />
                    </RouterLink>
                </li>
                <li v-for="labId in module.labIds" :key="labId">
                    <RouterLink :to="`/academy/lab/${labId}`" class="lesson-row">
                        <span class="check-dot check-dot--lab" :class="{ 'is-done': data.labs[labId]?.passedAt }">
                            <AppIcon v-if="data.labs[labId]?.passedAt" name="check" :size="13" />
                        </span>
                        <span><strong dir="auto">{{ labTitle(labId) }}</strong><small>Lab · {{ data.labs[labId]?.bestScore ?? 0 }}% best</small></span>
                        <AppIcon name="chevron-right" :size="17" />
                    </RouterLink>
                </li>
            </ul>

            <nav class="pager" aria-label="Module navigation">
                <RouterLink v-if="neighbours.previous" :to="`/academy/module/${neighbours.previous.id}`" class="pager__link">
                    <AppIcon name="arrow-left" :size="17" />
                    <span><small>Previous module</small><strong dir="auto">{{ neighbours.previous.title }}</strong></span>
                </RouterLink>
                <span v-else />
                <RouterLink v-if="neighbours.next" :to="`/academy/module/${neighbours.next.id}`" class="pager__link pager__link--next">
                    <span><small>Next module</small><strong dir="auto">{{ neighbours.next.title }}</strong></span>
                    <AppIcon name="arrow-right" :size="17" />
                </RouterLink>
            </nav>
        </template>
        <div v-else class="empty-state">
            <h2>This module does not exist.</h2>
            <RouterLink to="/academy" class="btn btn--primary">{{ L("nav.academy") }}</RouterLink>
        </div>
    </div>
</template>
