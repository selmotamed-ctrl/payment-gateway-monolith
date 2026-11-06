<script setup lang="ts">
import { computed, ref } from "vue";
import { applyTransforms, TRANSFORM_LIBRARY, type TransformResult } from "./engine/transforms";
import { useI18n } from "@/lib/i18n";

const { L } = useI18n();
const input = ref("100.000");
const operation = ref("scale");
const arg1 = ref("1000");
const arg2 = ref("");
const result = ref<TransformResult | null>(null);
const running = ref(false);

const operations = computed(() => [...TRANSFORM_LIBRARY]);

const run = async (): Promise<void> => {
    running.value = true;
    try {
        const args = [arg1.value, arg2.value].filter((entry) => entry.trim() !== "");
        result.value = await applyTransforms(input.value, [{ op: operation.value, args }]);
    } finally {
        running.value = false;
    }
};

const reset = (): void => {
    input.value = "100.000";
    operation.value = "scale";
    arg1.value = "1000";
    arg2.value = "";
    result.value = null;
};
</script>

<template>
    <section class="tool-card">
        <header class="tool-card__head">
            <div>
                <p class="eyebrow">{{ L("tool.title") }}</p>
                <h3>{{ L("tool.transform") }}</h3>
            </div>
            <button type="button" class="btn btn--small btn--ghost" @click="reset">{{ L("tool.reset") }}</button>
        </header>
        <p class="tool-note">{{ L("tool.teaching") }}</p>
        <label class="field"><span>Input</span><input v-model="input" class="input" /></label>
        <div class="field-row">
            <label class="field">
                <span>Operation</span>
                <select v-model="operation" class="select">
                    <option v-for="entry in operations" :key="entry" :value="entry">{{ entry }}</option>
                </select>
            </label>
            <label class="field"><span>Argument 1</span><input v-model="arg1" class="input" /></label>
            <label class="field"><span>Argument 2</span><input v-model="arg2" class="input" /></label>
        </div>
        <button type="button" class="btn btn--primary" :disabled="running" @click="run">
            {{ running ? L("common.loading") : "Run pipeline" }}
        </button>
        <div v-if="result" class="tool-output" aria-live="polite">
            <p class="eyebrow">Result</p>
            <p class="mono break" dir="ltr">{{ result.value }}</p>
            <p v-if="result.error" class="error-text">{{ result.error }}</p>
            <ol v-if="result.steps.length" class="tool-steps">
                <li v-for="(step, index) in result.steps" :key="index">
                    <code>{{ step.operation }}</code>
                    <span class="mono" dir="ltr">{{ step.value }}</span>
                </li>
            </ol>
        </div>
    </section>
</template>
