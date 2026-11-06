<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import MarkdownView from "@/components/MarkdownView.vue";
import PageHeader from "@/components/PageHeader.vue";
import { lessonProse } from "@/lib/markdown";
import { useI18n } from "@/lib/i18n";
import { successFeedback, tapFeedback } from "@/lib/haptics";
import {
    addHighlight,
    completeLesson,
    isBookmarked,
    isGuideRead,
    recordGuideRead,
    recordLastRead,
    recordReadingDay,
    toggleBookmark,
    useCompanionData,
} from "@/lib/data";
import { articleById, lessonById, useContent } from "@/content/store";
import LessonCheck from "./LessonCheck.vue";

const route = useRoute();
const router = useRouter();
const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const lessonId = computed(() => String(route.params.lessonId ?? ""));
const lesson = computed(() => lessonById(lessonId.value));
const module = computed(() => bundle.value?.academy.modules.find((entry) => entry.id === lesson.value?.module));
const checks = computed(() =>
    (lesson.value?.checkIds ?? [])
        .map((id) => bundle.value?.academy.checks.find((check) => check.id === id))
        .filter((check): check is NonNullable<typeof check> => Boolean(check)),
);
const answered = ref<Record<string, boolean>>({});
const justCompleted = ref(false);
const hasSelection = ref(false);
const highlighted = ref(false);
const reading = computed(() =>
    (lesson.value?.reading ?? [])
        .map((id) => articleById(id))
        .filter((article): article is NonNullable<typeof article> => Boolean(article)),
);
const readCount = computed(() => reading.value.filter((article) => isGuideRead(article.id)).length);
const done = computed(() => Boolean(data.value.lessons[lessonId.value]) || justCompleted.value);
const bookmarked = computed(() => isBookmarked("lesson", lessonId.value));
const answeredAll = computed(() => checks.value.length > 0 && checks.value.every((check) => check.id in answered.value));
const canComplete = computed(() => answeredAll.value && !done.value);
const score = computed(() => checks.value.filter((check) => answered.value[check.id]).length);
const siblings = computed(() => module.value?.lessonIds ?? []);
const index = computed(() => siblings.value.indexOf(lessonId.value));
const previous = computed(() => (index.value > 0 ? lessonById(siblings.value[index.value - 1]!) : undefined));
const next = computed(() =>
    index.value >= 0 && index.value < siblings.value.length - 1
        ? lessonById(siblings.value[index.value + 1]!)
        : undefined,
);

const enter = (): void => {
    if (!lesson.value) return;
    recordLastRead("lesson", lesson.value.id, lesson.value.title, route.fullPath);
    recordReadingDay();
    answered.value = {};
    justCompleted.value = false;
};

const onSelectionChange = (): void => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    const anchor = selection?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    hasSelection.value = Boolean(text) && Boolean(element?.closest(".lesson-sheet"));
};

const highlightSelection = (): void => {
    if (!lesson.value) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!text) return;
    addHighlight({
        kind: "lesson",
        targetId: lesson.value.id,
        title: lesson.value.title,
        text: text.slice(0, 4000),
        color: "green",
    });
    selection?.removeAllRanges();
    hasSelection.value = false;
    highlighted.value = true;
    void successFeedback();
    window.setTimeout(() => (highlighted.value = false), 1800);
};

onMounted(() => {
    enter();
    document.addEventListener("selectionchange", onSelectionChange);
});
onBeforeUnmount(() => document.removeEventListener("selectionchange", onSelectionChange));
watch(lessonId, () => {
    enter();
    window.scrollTo({ top: 0 });
});

const markReading = (articleId: string): void => {
    recordGuideRead(articleId, bundle.value?.meta.contentVersion ?? "0.0.0", true);
    void tapFeedback();
};

const toggleLessonBookmark = (): void => {
    if (!lesson.value) return;
    void tapFeedback();
    toggleBookmark({ kind: "lesson", targetId: lesson.value.id, title: lesson.value.title });
};

const complete = (): void => {
    if (!lesson.value || !canComplete.value) return;
    completeLesson(lesson.value.id, bundle.value?.meta.contentVersion ?? "0.0.0", score.value);
    justCompleted.value = true;
    void successFeedback();
};

const nextLesson = (): void => {
    if (next.value) void router.push(`/academy/lesson/${next.value.id}`);
};
</script>

<template>
    <div class="page">
        <PageHeader
            v-if="lesson"
            :title="lesson.title"
            :subtitle="module ? `${module.title} · ${lesson.minutes} min` : `${lesson.minutes} min`"
            :back-to="module ? `/academy/module/${module.id}` : '/academy'"
            tone="academy"
        >
            <template #actions>
                <button
                    type="button"
                    class="icon-button"
                    :class="{ 'is-on': bookmarked }"
                    :aria-label="L('guide.bookmark')"
                    @click="toggleLessonBookmark"
                >
                    <AppIcon name="bookmark" :size="20" />
                </button>
                <span v-if="done" class="chip chip--success">Completed</span>
            </template>
        </PageHeader>

        <template v-if="lesson">
            <section class="lesson-progress-strip">
                <div><span class="eyebrow">Reading</span><strong>{{ readCount }} / {{ reading.length }}</strong></div>
                <div><span class="eyebrow">Checks</span><strong>{{ Object.keys(answered).length }} / {{ checks.length }}</strong></div>
                <div><span class="eyebrow">Status</span><strong>{{ done ? "Complete" : "In progress" }}</strong></div>
            </section>

            <article class="reader-sheet lesson-sheet">
                <MarkdownView :source="lessonProse(lesson.body)" :article-id="lesson.id" />
            </article>

            <section class="section">
                <div class="section-head">
                    <div>
                        <p class="eyebrow">Read now</p>
                        <h2>Guide reading</h2>
                    </div>
                    <span class="muted">{{ readCount }} / {{ reading.length }}</span>
                </div>
                <ul class="simple-list">
                    <li v-for="article in reading" :key="article.id">
                        <div class="reading-row">
                            <RouterLink :to="`/guide/article/${article.id}`" class="reading-row__link" @click="markReading(article.id)">
                                <span class="check-dot" :class="{ 'is-done': isGuideRead(article.id) }">
                                    <AppIcon v-if="isGuideRead(article.id)" name="check" :size="13" />
                                </span>
                                <span><strong dir="auto">{{ article.title }}</strong><small>{{ article.minutes }} min</small></span>
                            </RouterLink>
                            <button
                                v-if="!isGuideRead(article.id)"
                                type="button"
                                class="btn btn--tiny btn--ghost"
                                @click="markReading(article.id)"
                            >
                                Mark read
                            </button>
                        </div>
                    </li>
                </ul>
            </section>

            <section class="section">
                <div class="section-head">
                    <div>
                        <p class="eyebrow">Check yourself</p>
                        <h2>{{ L("academy.practice") }}</h2>
                    </div>
                </div>
                <LessonCheck
                    v-for="(check, checkIndex) in checks"
                    :key="check.id"
                    :question="check"
                    :index="checkIndex"
                    :total="checks.length"
                    @answered="(firstTry) => (answered[check.id] = firstTry)"
                />
            </section>

            <section class="section finish-card">
                <template v-if="done">
                    <div class="state-icon state-icon--success"><AppIcon name="check" :size="24" /></div>
                    <h2>{{ L("academy.lessonComplete") }}</h2>
                    <p class="muted">Saved on this device. Nothing is synced to a server.</p>
                    <RouterLink v-if="next" :to="`/academy/lesson/${next.id}`" class="btn btn--primary" @click="nextLesson">
                        {{ L("academy.continue") }}
                        <AppIcon name="arrow-right" :size="17" />
                    </RouterLink>
                </template>
                <template v-else>
                    <div class="state-icon"><AppIcon name="academy" :size="24" /></div>
                    <h2>Finish this lesson</h2>
                    <p v-if="!answeredAll" class="muted">{{ L("academy.answerAll") }}</p>
                    <button type="button" class="btn btn--primary" :disabled="!canComplete" @click="complete">
                        <AppIcon name="check" :size="17" />
                        {{ L("academy.completeLesson") }}
                    </button>
                </template>
            </section>

            <nav class="pager" aria-label="Lesson navigation">
                <RouterLink v-if="previous" :to="`/academy/lesson/${previous.id}`" class="pager__link">
                    <AppIcon name="arrow-left" :size="17" />
                    <span><small>Previous lesson</small><strong dir="auto">{{ previous.title }}</strong></span>
                </RouterLink>
                <span v-else />
                <RouterLink v-if="next" :to="`/academy/lesson/${next.id}`" class="pager__link pager__link--next">
                    <span><small>Next lesson</small><strong dir="auto">{{ next.title }}</strong></span>
                    <AppIcon name="arrow-right" :size="17" />
                </RouterLink>
            </nav>
        </template>
        <div v-else class="empty-state">
            <h2>This lesson does not exist.</h2>
            <RouterLink to="/academy" class="btn btn--primary">{{ L("nav.academy") }}</RouterLink>
        </div>

        <button
            v-if="hasSelection"
            type="button"
            class="selection-action"
            @mousedown.prevent
            @click="highlightSelection"
        >
            <AppIcon name="highlight" :size="18" />
            Highlight selection
        </button>
        <div v-if="highlighted" class="toast" role="status">Highlight saved.</div>
    </div>
</template>
