<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useCompanionData, setActiveTrack, setRole, todayKey, readingDatesThisWeek, readingDaysThisWeek } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { readingPathFor, trackForRole, useContent } from "@/content/store";
import type { Role } from "@/content/types";

const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const guide = computed(() => bundle.value?.guide);
const path = computed(() => readingPathFor(data.value.role));
const pathArticles = computed(() =>
    (path.value?.articles ?? [])
        .map((id) => guide.value?.articles.find((article) => article.id === id))
        .filter((article): article is NonNullable<typeof article> => Boolean(article)),
);
const fallbackArticle = computed(() => guide.value?.articles.find((article) => article.id === "b00-01") ?? guide.value?.articles[0]);
const continueArticle = computed(() => {
    const last = data.value.lastRead;
    if (last?.kind === "article") {
        return guide.value?.articles.find((article) => article.id === last.targetId) ?? fallbackArticle.value;
    }
    return fallbackArticle.value;
});
const continueRoute = computed(() => data.value.lastRead?.route ?? (continueArticle.value ? `/guide/article/${continueArticle.value.id}` : "/guide"));
const continueTitle = computed(() => data.value.lastRead?.title ?? continueArticle.value?.title ?? "Welcome to the guide");
const seed = computed(() => Number(todayKey().replace(/-/g, "")));
const briefArticle = computed(() => {
    const list = pathArticles.value.length ? pathArticles.value : guide.value?.articles ?? [];
    return list[seed.value % Math.max(1, list.length)];
});
const briefTerm = computed(() => {
    const list = guide.value?.glossary ?? [];
    return list[(seed.value * 7) % Math.max(1, list.length)];
});
const briefCard = computed(() => {
    const list = guide.value?.cards ?? [];
    return list[(seed.value * 13) % Math.max(1, list.length)];
});
const rhythmDays = computed(() => readingDaysThisWeek());
const rhythmRead = computed(() => readingDatesThisWeek());
const today = todayKey();
const dayLabels = ["M", "T", "W", "T", "F", "S", "S"];
const greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning.";
    if (hour < 18) return "Good afternoon.";
    return "Good evening.";
});
const roles: { value: Role; label: string }[] = [
    { value: "OPERATOR", label: "Operator" },
    { value: "SUPPORT", label: "Support" },
    { value: "FINANCE", label: "Finance" },
    { value: "COMPLIANCE", label: "Compliance" },
    { value: "MLRO", label: "MLRO" },
    { value: "GATEWAY_ADMIN", label: "Gateway admin" },
    { value: "SECURITY_ADMIN", label: "Security admin" },
];
const chooseRole = (role: Role | ""): void => {
    setRole(role);
    const track = trackForRole(role);
    if (track) setActiveTrack(track);
};
</script>

<template>
    <div class="page today-page">
        <PageHeader :title="L('today.title')" :subtitle="greeting" :show-back="false" />

        <section class="hero-card hero-card--today">
            <div class="today-hero-main">
                <p class="eyebrow">{{ L("today.continue") }}</p>
                <h2 dir="auto">{{ continueTitle }}</h2>
                <p class="muted">{{ L("today.greeting") }}</p>
                <div class="hero-actions">
                    <RouterLink :to="continueRoute" class="btn btn--primary">
                        <AppIcon name="play" :size="17" />
                        {{ L("common.continue") }}
                    </RouterLink>
                    <RouterLink to="/guide" class="btn btn--ghost">{{ L("nav.guide") }}</RouterLink>
                </div>
            </div>
            <div class="today-hero-note">
                <AppIcon name="sparkle" :size="20" />
                <p>{{ L("today.rhythmNote") }}</p>
            </div>
        </section>

        <section class="section">
            <div class="section-head">
                <div>
                    <p class="eyebrow">{{ L("today.brief") }}</p>
                    <h2>{{ L("today.briefNote") }}</h2>
                </div>
            </div>
            <div class="brief-grid">
                <RouterLink v-if="briefArticle" :to="`/guide/article/${briefArticle.id}`" class="brief-card brief-card--article">
                    <span class="eyebrow">Article · {{ briefArticle.minutes }} min</span>
                    <strong dir="auto">{{ briefArticle.title }}</strong>
                    <small>Book {{ briefArticle.book }}</small>
                    <AppIcon name="arrow-right" :size="18" />
                </RouterLink>
                <RouterLink v-if="briefTerm" :to="`/guide/glossary/${briefTerm.slug}`" class="brief-card">
                    <span class="eyebrow">Term</span>
                    <strong dir="auto">{{ briefTerm.term }}</strong>
                    <small dir="auto">{{ briefTerm.short }}</small>
                    <AppIcon name="arrow-right" :size="18" />
                </RouterLink>
                <RouterLink v-if="briefCard" :to="`/guide/cards/${briefCard.id}`" class="brief-card">
                    <span class="eyebrow">Safeguard · {{ briefCard.risk }}</span>
                    <strong dir="auto">{{ briefCard.title }}</strong>
                    <small dir="auto">{{ briefCard.screen }}</small>
                    <AppIcon name="arrow-right" :size="18" />
                </RouterLink>
            </div>
        </section>

        <section class="section rhythm-card">
            <div class="section-head">
                <div>
                    <p class="eyebrow">{{ L("today.rhythm") }}</p>
                    <h2>{{ L("today.readDays", { n: rhythmRead.size }) }}</h2>
                </div>
                <RouterLink to="/settings" class="text-link">{{ L("settings.title") }}</RouterLink>
            </div>
            <div class="rhythm-days" role="list" aria-label="Days read this week">
                <div
                    v-for="(day, index) in rhythmDays"
                    :key="day"
                    class="rhythm-day"
                    :class="{ 'is-read': rhythmRead.has(day), 'is-today': day === today }"
                    role="listitem"
                >
                    <span>{{ dayLabels[index] }}</span>
                    <span class="rhythm-dot">
                        <AppIcon v-if="rhythmRead.has(day)" name="check" :size="13" />
                    </span>
                </div>
            </div>
            <p class="muted">{{ L("today.rhythmNote") }}</p>
        </section>

        <section class="section">
            <div class="section-head">
                <h2>{{ L("today.pickRole") }}</h2>
            </div>
            <p class="muted">{{ L("today.roleNote") }}</p>
            <div class="role-picker">
                <button
                    type="button"
                    class="chip"
                    :class="{ 'is-active': data.role === '' }"
                    @click="chooseRole('')"
                >
                    Everyone
                </button>
                <button
                    v-for="role in roles"
                    :key="role.value"
                    type="button"
                    class="chip"
                    :class="{ 'is-active': data.role === role.value }"
                    @click="chooseRole(role.value)"
                >
                    {{ role.label }}
                </button>
            </div>
            <p v-if="path" class="muted small">{{ path.title }}</p>
        </section>
    </div>
</template>
