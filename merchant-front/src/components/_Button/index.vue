<template>
    <v-btn v-bind="{ ...props, ...attrs }">
        <slot></slot>
    </v-btn>
</template>

<script setup lang="ts">
import { defineProps, useAttrs } from "vue";
import { VBtn } from "vuetify/components";

const attrs = useAttrs();
const props = defineProps<
    /* @vue-ignore */ InstanceType<typeof VBtn>["$props"] & {
        onClick: (e: PointerEvent) => void | Promise<void>;
    }
>();
</script>
