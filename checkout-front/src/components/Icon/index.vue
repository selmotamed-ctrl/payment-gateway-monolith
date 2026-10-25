<template>
    <v-icon v-bind="attrs"></v-icon>
</template>
<script setup lang="ts">
import { useAttrs } from "vue";
import type { VIcon } from "vuetify/components";
const attrs = useAttrs();
defineProps<
    /* @vue-ignore */ InstanceType<typeof VIcon>["$props"] & {
        onClick?: () => void | Promise<void>;
    }
>();
</script>
