<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useCompanionData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { trackById, useContent } from "@/content/store";
import type { Question } from "@/content/types";

const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const track = computed(() => trackById(data.value.activeTrack));
const stage = ref<"intro" | "running" | "result">("intro");
const questions = ref<Question[]>([]);
const index = ref(0);
const answers = ref<Record<string, string>>({});
const pool = computed(() => {
    if (!bundle.value || !track.value) return [];
    return bundle.value.academy.checks.filter((check) => track.value!.moduleIds.includes(check.module));
});
const current = computed(() => questions.value[index.value]);
const score = computed(() => {
    const total = questions.value.length;
    const correct = questions.value.filter((question) => answers.value[question.id] === question.options.find((option) => option.correct)?.id).length;
    return { correct, total, percent: total ? Math.round((correct / total) * 100) : 0 };
});

const shuffle = <T>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
};

const start = (): void => {
    const source = pool.value.length >= 10 ? pool.value : bundle.value?.academy.checks ?? [];
    questions.value = shuffle(source).slice(0, 10);
    answers.value = {};
    index.value = 0;
    stage.value = "running";
};

const choose = (optionId: string): void => {
    if (!current.value) return;
    answers.value = { ...answers.value, [current.value.id]: optionId };
};

const next = (): void => {
    if (index.value + 1 < questions.value.length) index.value += 1;
    else stage.value = "result";
};

const reset = (): void => {
    stage.value = "intro";
    questions.value = [];
    answers.value = {};
    index.value = 0;
};
</script>

<template>
    <div class="page">
        <PageHeader
            :title="L('academy.practiceExam')"
            :subtitle="track ? track.title : L('academy.title')"
            back-to="/academy"
            tone="academy"
        />
        <section class="notice-card">
            <AppIcon name="alert" :size="20" />
            <div>
                <strong>Practice only</strong>
                <p>{{ L("academy.officialExamNote") }}</p>
            </div>
        </section>

        <section v-if="stage === 'intro'" class="hero-card">
            <p class="eyebrow">{{ track?.title }}</p>
            <h2>Ten questions from your practice bank</h2>
            <p class="muted">This is a self-check built from lesson checks. It does not issue a badge and is not sent anywhere.</p>
            <div class="lab-facts">
                <div><span>Questions</span><strong>10</strong></div>
                <div><span>Source</span><strong>Practice checks</strong></div>
                <div><span>Saved</span><strong>This device</strong></div>
            </div>
            <button type="button" class="btn btn--primary" @click="start">
                <AppIcon name="play" :size="17" />
                Start practice
            </button>
        </section>

        <section v-else-if="stage === 'running' && current" class="practice-runner">
            <div class="lab-progress">
                <div>
                    <p class="eyebrow">Question {{ index + 1 }} / {{ questions.length }}</p>
                    <h2 dir="auto">{{ current.stem }}</h2>
                </div>
                <span class="chip">{{ Object.keys(answers).length }} answered</span>
            </div>
            <div class="choice-list">
                <button
                    v-for="option in current.options"
                    :key="option.id"
                    type="button"
                    class="choice-button"
                    :class="{ 'is-selected': answers[current.id] === option.id }"
                    @click="choose(option.id)"
                >
                    <span class="choice-mark"><span class="choice-dot" /></span>
                    <span dir="auto">{{ option.text }}</span>
                </button>
            </div>
            <div class="lab-actions">
                <button type="button" class="btn btn--primary" :disabled="!answers[current.id]" @click="next">
                    {{ index + 1 < questions.length ? "Next question" : "See result" }}
                    <AppIcon name="arrow-right" :size="17" />
                </button>
                <button type="button" class="btn btn--ghost" @click="reset">Stop</button>
            </div>
        </section>

        <section v-else-if="stage === 'result'" class="lab-result">
            <div class="result-ring" :class="{ 'is-passed': score.percent >= 80 }">
                <strong>{{ score.percent }}%</strong>
                <small>{{ score.correct }} / {{ score.total }}</small>
            </div>
            <h2>{{ score.percent >= 80 ? "Nice work" : "A little more practice" }}</h2>
            <p class="muted">This practice result is saved only on this device. Official certification remains in the live Admin Academy.</p>
            <ol class="result-list review-list">
                <li v-for="(question, questionIndex) in questions" :key="question.id">
                    <span>
                        <small>Question {{ questionIndex + 1 }}</small>
                        <strong dir="auto">{{ question.stem }}</strong>
                        <small class="muted">{{ answers[question.id] === question.options.find((option) => option.correct)?.id ? "Correct" : "Review this one" }}</small>
                    </span>
                    <span class="chip" :class="answers[question.id] === question.options.find((option) => option.correct)?.id ? 'chip--success' : 'chip--danger'">
                        {{ answers[question.id] === question.options.find((option) => option.correct)?.id ? "OK" : "Review" }}
                    </span>
                </li>
            </ol>
            <div class="hero-actions">
                <button type="button" class="btn btn--primary" @click="start">Try another set</button>
                <button type="button" class="btn btn--ghost" @click="reset">Back</button>
            </div>
        </section>
    </div>
</template>
