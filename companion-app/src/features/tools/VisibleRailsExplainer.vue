<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@/lib/i18n";
import { useContent } from "@/content/store";
import { evaluateVisibleRails, type VisibleRailsInput } from "./engine/visibleRails";

const { L } = useI18n();
const { bundle } = useContent();
const data = computed(() => bundle.value?.guide.data["visible-rails"]);
const amount = ref("");
const currency = ref("");
const time = ref("");
const results = computed(() => {
    if (!data.value) return [];
    const input: VisibleRailsInput = {
        amount: amount.value || data.value.defaults.amount,
        currency: currency.value || data.value.defaults.currency,
        timeOfDay: time.value || data.value.defaults.timeOfDay,
    };
    return evaluateVisibleRails(data.value, input);
});
const reset = (): void => {
    amount.value = "";
    currency.value = "";
    time.value = "";
};
</script>

<template>
    <section class="tool-card">
        <header class="tool-card__head">
            <div>
                <p class="eyebrow">{{ L("tool.title") }}</p>
                <h3>{{ L("tool.rails") }}</h3>
            </div>
            <button type="button" class="btn btn--small btn--ghost" @click="reset">{{ L("tool.reset") }}</button>
        </header>
        <p class="tool-note">{{ L("tool.teaching") }}</p>
        <div v-if="data" class="field-row">
            <label class="field"><span>Amount</span><input v-model="amount" class="input" :placeholder="data.defaults.amount" dir="ltr" /></label>
            <label class="field"><span>Currency</span><input v-model="currency" class="input" :placeholder="data.defaults.currency" dir="ltr" /></label>
            <label class="field"><span>Time (HH:MM)</span><input v-model="time" class="input" :placeholder="data.defaults.timeOfDay" dir="ltr" /></label>
        </div>
        <p v-if="data" class="muted small">{{ data.rule }}</p>
        <ul class="rail-list">
            <li v-for="rail in results" :key="rail.code" class="rail-row" :class="{ 'is-hidden': !rail.visible }">
                <span class="rail-code">{{ rail.code }}</span>
                <span class="rail-main">
                    <strong>{{ rail.name }}</strong>
                    <small v-if="rail.visible">Visible</small>
                    <small v-else>Hidden at predicate {{ rail.reason?.predicate }} — {{ rail.reason?.message }}</small>
                </span>
                <span class="chip" :class="rail.visible ? 'chip--success' : 'chip--muted'">
                    {{ rail.visible ? "VISIBLE" : "HIDDEN" }}
                </span>
            </li>
        </ul>
        <details v-if="data" class="helper-details">
            <summary>Predicate order</summary>
            <ol>
                <li v-for="predicate in data.evaluationOrder" :key="predicate">{{ predicate }}</li>
            </ol>
        </details>
    </section>
</template>
