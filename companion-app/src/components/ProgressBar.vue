<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ value: number; max?: number; label?: string }>(), {
    max: 100,
    label: "Progress",
});

const percent = computed(() =>
    props.max > 0 ? Math.max(0, Math.min(100, Math.round((props.value / props.max) * 100))) : 0,
);
</script>

<template>
    <div
        class="progress-bar"
        role="progressbar"
        :aria-label="label"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
    >
        <span :style="{ width: `${percent}%` }" />
    </div>
</template>
