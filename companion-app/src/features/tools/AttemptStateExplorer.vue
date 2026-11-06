<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@/lib/i18n";
import { useContent } from "@/content/store";
import { applyAttemptEvent, availableEvents, attemptStateById } from "./engine/attemptStates";

const { L } = useI18n();
const { bundle } = useContent();
const data = computed(() => bundle.value?.guide.data["attempt-transitions"]);
const stateId = ref("");
const path = ref<{ event: string; state: string; note?: string }[]>([]);

const currentId = computed(() => stateId.value || data.value?.initial || "");
const state = computed(() => (data.value ? attemptStateById(data.value, currentId.value) : undefined));
const events = computed(() => (data.value ? availableEvents(data.value, currentId.value) : []));
const reset = (): void => {
    stateId.value = "";
    path.value = [];
};
const apply = (eventId: string): void => {
    if (!data.value) return;
    const result = applyAttemptEvent(data.value, currentId.value, eventId);
    if (!result) return;
    stateId.value = result.state.stateId;
    path.value.push({
        event: result.event.label,
        state: result.state.id,
        ...(result.note ? { note: result.note } : {}),
    });
};
</script>

<template>
    <section v-if="data" class="tool-card">
        <header class="tool-card__head">
            <div>
                <p class="eyebrow">{{ L("tool.title") }}</p>
                <h3>{{ L("tool.states") }}</h3>
            </div>
            <button type="button" class="btn btn--small btn--ghost" @click="reset">{{ L("tool.reset") }}</button>
        </header>
        <p class="tool-note">{{ L("tool.teaching") }}</p>
        <div class="state-banner">
            <div>
                <p class="eyebrow">Current state</p>
                <h4>{{ state?.id ?? data.initial }}</h4>
                <p class="muted">{{ state?.human }} · {{ state?.slot }} · {{ state?.money }}</p>
            </div>
            <span class="chip">{{ currentId }}</span>
        </div>
        <div class="event-grid">
            <button v-for="event in events" :key="event.id" type="button" class="event-button" @click="apply(event.id)">
                <strong>{{ event.label }}</strong>
                <small>→ {{ event.to }}</small>
            </button>
            <p v-if="events.length === 0" class="muted">No further teaching transition from this state.</p>
        </div>
        <ol v-if="path.length" class="state-path">
            <li v-for="(step, index) in path" :key="index">
                <span class="mono">{{ index + 1 }}</span>
                <span>{{ step.event }} → <strong>{{ step.state }}</strong></span>
                <small v-if="step.note">{{ step.note }}</small>
            </li>
        </ol>
    </section>
</template>
