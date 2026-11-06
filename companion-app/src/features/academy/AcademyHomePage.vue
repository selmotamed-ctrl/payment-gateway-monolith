<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import { setActiveTrack, useCompanionData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { trackForRole, trackById, useContent } from "@/content/store";
import { nextStepTitle, nextTrackStep, trackStats } from "./progress";

const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const academy = computed(() => bundle.value?.academy);
const tracks = computed(() => academy.value?.tracks ?? []);
const activeTrack = computed(
    () => trackById(data.value.activeTrack) ?? tracks.value[0],
);
const roleTrack = computed(() => trackForRole(data.value.role));
const requiredIds = computed(() => {
    const ids = new Set<string>(["FOUNDATION"]);
    if (roleTrack.value) ids.add(roleTrack.value);
    return ids;
});
const stats = computed(() => (activeTrack.value ? trackStats(activeTrack.value, data.value) : null));
const next = computed(() =>
    activeTrack.value && academy.value
        ? nextTrackStep(activeTrack.value, academy.value.modules, data.value)
        : null,
);
const nextTitle = computed(() =>
    next.value && academy.value
        ? nextStepTitle(next.value, academy.value.lessons, academy.value.labs)
        : "",
);
const nextRoute = computed(() => {
    const step = next.value;
    if (!step) return "/academy";
    if (step.kind === "lesson") return `/academy/lesson/${step.id}`;
    if (step.kind === "lab") return `/academy/lab/${step.id}`;
    return "/academy/practice-exam";
});
const labs = computed(() => academy.value?.labs ?? []);
const lessons = computed(() => academy.value?.lessons ?? []);
const totalLessonsDone = computed(() => Object.keys(data.value.lessons).length);
const totalLabsPassed = computed(() => Object.values(data.value.labs).filter((entry) => entry.passedAt).length);
const setActive = (id: string): void => {
    if (activeTrack.value?.id === id) return;
    setActiveTrack(id as typeof data.value.activeTrack);
};
</script>

<template>
    <div class="page academy-home">
        <PageHeader
            :title="L('academy.title')"
            :subtitle="L('academy.subtitle')"
            :show-back="false"
            tone="academy"
        >
            <template #actions>
                <RouterLink to="/academy/help" class="icon-button" aria-label="Help">
                    <AppIcon name="help" />
                </RouterLink>
            </template>
        </PageHeader>

        <section v-if="activeTrack && stats" class="hero-card hero-card--academy">
            <div class="hero-card__head">
                <div>
                    <p class="eyebrow">{{ L("academy.active") }}</p>
                    <h2>{{ activeTrack.title }}</h2>
                    <p class="muted">{{ activeTrack.description }}</p>
                </div>
                <span class="chip chip--academy">{{ activeTrack.hours }} h</span>
            </div>
            <div class="ring-grid">
                <div class="mini-ring">
                    <strong>{{ stats.lessonsDone }}/{{ stats.lessonsTotal }}</strong>
                    <small>Lessons</small>
                </div>
                <div class="mini-ring">
                    <strong>{{ stats.labsPassed }}/{{ stats.labsTotal }}</strong>
                    <small>Labs</small>
                </div>
                <div class="mini-ring">
                    <strong>{{ totalLessonsDone }}</strong>
                    <small>All lessons</small>
                </div>
                <div class="mini-ring">
                    <strong>{{ totalLabsPassed }}</strong>
                    <small>All labs</small>
                </div>
            </div>
            <ProgressBar :value="stats.lessonsDone + stats.labsPassed" :max="stats.lessonsTotal + stats.labsTotal" label="Track progress" />
            <p v-if="next" class="next-step">
                <span class="eyebrow">{{ next?.kind === "exam" ? L("academy.trackComplete") : L("academy.continue") }}</span>
                <strong dir="auto">{{ nextTitle }}</strong>
            </p>
            <RouterLink :to="nextRoute" class="btn btn--primary">
                <AppIcon name="play" :size="17" />
                {{ next?.kind === "exam" ? L("academy.practiceExam") : L("common.continue") }}
            </RouterLink>
        </section>

        <section class="section">
            <div class="section-head">
                <h2>{{ L("academy.tracks") }}</h2>
                <span class="muted">{{ tracks.length }}</span>
            </div>
            <div class="track-grid">
                <article
                    v-for="track in tracks"
                    :key="track.id"
                    class="track-card"
                    :class="{ 'is-active': track.id === activeTrack?.id, 'is-required': requiredIds.has(track.id) }"
                >
                    <div class="track-card__head">
                        <span class="track-icon"><AppIcon name="academy" :size="20" /></span>
                        <span v-if="track.id === activeTrack?.id" class="chip chip--success">{{ L("academy.active") }}</span>
                        <span v-else-if="requiredIds.has(track.id)" class="chip">Required</span>
                    </div>
                    <h3>{{ track.title }}</h3>
                    <p class="muted">{{ track.description }}</p>
                    <ProgressBar
                        :value="trackStats(track, data).lessonsDone + trackStats(track, data).labsPassed"
                        :max="track.lessonIds.length + track.labIds.length"
                        :label="track.title"
                    />
                    <div class="track-card__actions">
                        <RouterLink :to="`/academy/track/${track.id}`" class="btn btn--small btn--ghost">
                            {{ L("common.open") }}
                        </RouterLink>
                        <button
                            v-if="track.id !== activeTrack?.id"
                            type="button"
                            class="btn btn--small btn--ghost"
                            @click="setActive(track.id)"
                        >
                            {{ L("academy.makeActive") }}
                        </button>
                    </div>
                </article>
            </div>
        </section>

        <section class="section">
            <div class="quick-grid">
                <RouterLink to="/academy/practice-exam" class="quick-card">
                    <span class="quick-icon"><AppIcon name="certificate" :size="19" /></span>
                    <span><strong>{{ L("academy.practiceExam") }}</strong><small>Offline practice, no certification</small></span>
                    <AppIcon name="chevron-right" :size="17" />
                </RouterLink>
                <RouterLink to="/academy/help" class="quick-card">
                    <span class="quick-icon"><AppIcon name="help" :size="19" /></span>
                    <span><strong>{{ L("academy.help") }}</strong><small>How scoring works and optional drills</small></span>
                    <AppIcon name="chevron-right" :size="17" />
                </RouterLink>
                <RouterLink to="/academy/lab/lab-flow-tracer" class="quick-card">
                    <span class="quick-icon"><AppIcon name="flask" :size="19" /></span>
                    <span><strong>{{ lessons.length }} lessons · {{ labs.length }} labs</strong><small>All learner content is offline</small></span>
                    <AppIcon name="chevron-right" :size="17" />
                </RouterLink>
            </div>
        </section>
    </div>
</template>
