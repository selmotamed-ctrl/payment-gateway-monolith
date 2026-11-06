<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import type { Question } from "@/content/types";

const props = defineProps<{ question: Question; index: number; total: number }>();
const emit = defineEmits<{ answered: [firstTry: boolean] }>();

const picked = ref<string[]>([]);
const solved = ref(false);
let reported = false;

const options = computed(() => props.question.options);
const lastWrong = computed(() => !solved.value && picked.value.length > 0);

const choose = (id: string): void => {
    if (solved.value || picked.value.includes(id)) return;
    const correct = Boolean(props.question.options.find((option) => option.id === id)?.correct);
    picked.value = [...picked.value, id];
    if (correct) solved.value = true;
    if (!reported) {
        reported = true;
        emit("answered", correct);
    }
};
</script>

<template>
    <section class="lesson-check" :aria-labelledby="`check-${question.id}`">
        <div class="section-head">
            <div>
                <p class="eyebrow">Practice check {{ index + 1 }} / {{ total }}</p>
                <h3 :id="`check-${question.id}`">{{ question.stem }}</h3>
            </div>
            <span class="chip" :class="{ 'chip--success': solved }">{{ solved ? "Done" : "Try" }}</span>
        </div>
        <ul class="choice-list">
            <li v-for="option in options" :key="option.id">
                <button
                    type="button"
                    class="choice-button"
                    :class="{
                        'is-correct': picked.includes(option.id) && option.correct,
                        'is-wrong': picked.includes(option.id) && !option.correct,
                        'is-dim': solved && !picked.includes(option.id),
                    }"
                    :disabled="solved || picked.includes(option.id)"
                    @click="choose(option.id)"
                >
                    <span class="choice-mark">
                        <AppIcon v-if="picked.includes(option.id) && option.correct" name="check" :size="15" />
                        <AppIcon v-else-if="picked.includes(option.id) && !option.correct" name="close" :size="15" />
                        <span v-else class="choice-dot" />
                    </span>
                    <span dir="auto">{{ option.text }}</span>
                    <small v-if="picked.includes(option.id)" class="choice-note" dir="auto">
                        {{ option.correct ? "Correct" : "Not correct" }}
                    </small>
                </button>
                <p v-if="picked.includes(option.id) && option.note" class="choice-explanation" dir="auto">{{ option.note }}</p>
            </li>
        </ul>
        <div class="check-feedback" aria-live="polite">
            <p v-if="solved" class="feedback feedback--good">
                <AppIcon name="check" :size="16" />
                <span dir="auto">{{ question.why || "Correct." }}</span>
            </p>
            <p v-else-if="lastWrong" class="feedback feedback--warn">
                <AppIcon name="alert" :size="16" />
                <span>Read the note and try another option.</span>
            </p>
            <p v-if="solved && question.refs.length" class="muted small">
                More in the guide:
                <RouterLink v-for="(ref, i) in question.refs" :key="ref" :to="`/guide/article/${ref}`" class="text-link">
                    {{ i > 0 ? ", " : "" }}{{ ref }}
                </RouterLink>
            </p>
        </div>
    </section>
</template>
