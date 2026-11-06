<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
    defineProps<{ name: string; size?: number | string; stroke?: number }>(),
    { size: 22, stroke: 1.8 },
);

const paths: Record<string, string> = {
    today: "M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16.5H6.5A2.5 2.5 0 0 0 4 22V5.5ZM4 19.5A2.5 2.5 0 0 1 6.5 17H20M8 7h8M8 10.5h5",
    academy: "M3 9.5 12 5l9 4.5-9 4.5-9-4.5ZM6.5 12v4.2c0 1.6 2.5 3.3 5.5 3.3s5.5-1.7 5.5-3.3V12M21 9.5v6",
    saved: "M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1Z",
    search: "M10.8 18a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4ZM16.2 16.2 21 21",
    settings:
        "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4.04v-.04A1.7 1.7 0 0 0 8.9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.5 15a1.7 1.7 0 0 0-1.56-1.03H3v-4.04h.04A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06L7.06 4.1l.06.06A1.7 1.7 0 0 0 9 4.5a1.7 1.7 0 0 0 1.03-1.56V3h4.04v.04A1.7 1.7 0 0 0 15.1 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.5 9v.04A1.7 1.7 0 0 0 21 10.04V14h-.04A1.7 1.7 0 0 0 19.4 15Z",
    "arrow-left": "M19 12H5M11 18l-6-6 6-6",
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    "chevron-left": "M15 18l-6-6 6-6",
    "chevron-right": "M9 18l6-6-6-6",
    check: "M4 12.5 9.5 18 20 6.5",
    alert: "M12 3 2.8 20h18.4L12 3ZM12 9v5M12 17.2v.2",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
    tools: "M14.5 6.5 17.5 3.5l3 3-3 3M4 20l6.5-6.5M3 3l5 2 8.5 8.5-3 3L5 8 3 3ZM14 14l3 3",
    flask: "M9 3h6M10 3v5.5L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 8.5V3M8 15h8",
    help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.8 9a2.3 2.3 0 1 1 3.6 1.9c-.9.6-1.4 1.1-1.4 2.3M12 17.2v.2",
    download: "M12 3v12M7 10l5 5 5-5M4 20h16",
    share: "M12 16V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16Z",
    close: "M6 6l12 12M18 6 6 18",
    menu: "M4 7h16M4 12h16M4 17h16",
    play: "M8 5.5v13l11-6.5-11-6.5Z",
    lock: "M6 10V8a6 6 0 0 1 12 0v2M5 10h14v11H5V10ZM12 14v3",
    refresh: "M20 7v5h-5M4 17v-5h5M6.1 9A7 7 0 0 1 18.7 7M4.3 15A7 7 0 0 0 17.9 17",
    note: "M5 4h14v16H5V4ZM8 8h8M8 12h8M8 16h5",
    highlight: "M4 20h16M6 16l9-9 3 3-9 9H6v-3ZM14 5l3 3",
    certificate: "M6 3h12v12H6V3ZM9 21l3-3 3 3M12 9l1 2 2 .3-1.5 1.5.4 2-1.9-1-1.9 1 .4-2L9 11.3 11 11l1-2Z",
    external: "M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
};

const path = computed(() => paths[props.name] ?? paths.today);
const size = computed(() => (typeof props.size === "number" ? `${props.size}px` : props.size));
</script>

<template>
    <svg
        :width="size"
        :height="size"
        viewBox="0 0 24 24"
        fill="none"
        :stroke-width="stroke"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <path :d="path" />
    </svg>
</template>
