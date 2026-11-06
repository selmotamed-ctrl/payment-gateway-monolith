<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import { setActiveTrack, useCompanionData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { trackById, useContent } from "@/content/store";
import { nextStepTitle, nextTrackStep, trackStats } from "./progress";

const route = useRoute();
const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const trackId = computed(() => String(route.params.trackId ?? ""));
const track = computed(() => trackById(trackId.value));
const modules = computed(() =>
    (bundle.value?.academy.modules ?? []).filter((module) => track.value?.moduleIds.includes(module.id)),
);
const lessons = computed(() => bundle.value?.academy.lessons ?? []);
const labs = computed(() => bundle.value?.academy.labs ?? []);
const stats = computed(() => (track.value ? trackStats(track.value, data.value) : null));
const next = computed(() =>
    track.value && bundle.value ? nextTrackStep(track.value, bundle.value.academy.modules, data.value) : null,
);
const nextTitle = computed(() =>
    next.value && bundle.value ? nextStepTitle(next.value, lessons.value, labs.value) : "",
);
const lessonTitle = (id: string): string => lessons.value.find((lesson) => lesson.id === id)?.title ?? id;
const labTitle = (id: string): string => labs.value.find((lab) => lab.id === id)?.title ?? id;
const labPassed = (id: string): boolean => Boolean(data.value.labs[id]?.passedAt);
const makeActive = (): void => {
    if (track.value) setActiveTrack(track.value.id);
};
</script>

<template>
    <div class="page">
        <PageHeader
            v-if="track"
            :title="track.title"
            :subtitle="track.description"
            back-to="/academy"
            tone="academy"
        >
            <template #actions>
                <button
                    v-if="data.activeTrack !== track.id"
                    type="button"
                    class="chip chip--action"
                    @click="makeActive"
                >
                    {{ L("academy.makeActive") }}
                </button>
            </template>
        </PageHeader>

        <template v-if="track && stats">
            <section class="summary-card">
                <div class="ring-grid">
                    <div class="mini-ring"><strong>{{ stats.lessonsDone }}/{{ stats.lessonsTotal }}</strong><small>Lessons</small></div>
                    <div class="mini-ring"><strong>{{ stats.labsPassed }}/{{ stats.labsTotal }}</strong><small>Labs</small></div>
                    <div class="mini-ring"><strong>{{ track.hours }}h</strong><small>Track</small></div>
                </div>
                <ProgressBar :value="stats.lessonsDone + stats.labsPassed" :max="stats.lessonsTotal + stats.labsTotal" label="Track progress" />
                <p v-if="next" class="next-step">
                    <span class="eyebrow">{{ next.kind === "exam" ? L("academy.trackComplete") : L("academy.continue") }}</span>
                    <strong dir="auto">{{ nextTitle }}</strong>
                </p>
            </section>

            <section v-for="(module, index) in modules" :key="module.id" class="section">
                <div class="section-head">
                    <div>
                        <p class="eyebrow">Module {{ index + 1 }} · {{ module.minutes }} min</p>
                        <h2>{{ module.title }}</h2>
                    </div>
                    <RouterLink :to="`/academy/module/${module.id}`" class="text-link">Open</RouterLink>
                </div>
                <p class="muted" dir="auto">{{ module.objective }}</p>
                <ul class="simple-list">
                    <li v-for="lessonId in module.lessonIds.filter((id) => track?.lessonIds.includes(id))" :key="lessonId">
                        <RouterLink :to="`/academy/lesson/${lessonId}`" class="lesson-row">
                            <span class="check-dot" :class="{ 'is-done': data.lessons[lessonId] }">
                                <AppIcon v-if="data.lessons[lessonId]" name="check" :size="13" />
                            </span>
                            <span>
                                <strong dir="auto">{{ lessonTitle(lessonId) }}</strong>
                                <small>Lesson</small>
                            </span>
                            <AppIcon name="chevron-right" :size="17" />
                        </RouterLink>
                    </li>
                    <li v-for="labId in module.labIds.filter((id) => track?.labIds.includes(id))" :key="labId">
                        <RouterLink :to="`/academy/lab/${labId}`" class="lesson-row">
                            <span class="check-dot check-dot--lab" :class="{ 'is-done': labPassed(labId) }">
                                <AppIcon v-if="labPassed(labId)" name="check" :size="13" />
                            </span>
                            <span>
                                <strong dir="auto">{{ labTitle(labId) }}</strong>
                                <small>Lab · {{ data.labs[labId]?.bestScore ?? 0 }}% best</small>
                            </span>
                            <AppIcon name="chevron-right" :size="17" />
                        </RouterLink>
                    </li>
                </ul>
            </section>

            <section class="section exam-card">
                <div>
                    <p class="eyebrow">{{ L("academy.officialExam") }}</p>
                    <h2>Certification stays online</h2>
                    <p class="muted">{{ L("academy.officialExamNote") }}</p>
                </div>
                <RouterLink to="/academy/practice-exam" class="btn btn--primary">
                    {{ L("academy.practiceExam") }}
                    <AppIcon name="arrow-right" :size="17" />
                </RouterLink>
            </section>
        </template>
        <div v-else class="empty-state">
            <h2>This track does not exist.</h2>
            <RouterLink to="/academy" class="btn btn--primary">{{ L("nav.academy") }}</RouterLink>
        </div>
    </div>
</template>
