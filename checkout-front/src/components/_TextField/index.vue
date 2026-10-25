<template>
    <!-- bind all incoming attrs (props + listeners) -->
    <component :is="VTextField" v-bind="attrs">
        <!-- for each slot the parent passed in... -->
        <template v-for="(_, slotName) in slots" :key="slotName" #[slotName]="slotProps">
            <slot :name="slotName as Slots" v-bind="slotProps" />
        </template>
    </component>
</template>

<script setup lang="ts">
import { useSlots, useAttrs } from "vue";
import { VTextField } from "vuetify/components";
const props = defineProps<
    /* @vue-ignore */ InstanceType<typeof VTextField>["$props"] & {
        onKeydown?: ((payload: KeyboardEvent) => void) | undefined;
        onKeyup?: ((payload: KeyboardEvent) => void) | undefined;
        onClick?: ((event: MouseEvent) => void) | undefined;
    }
>();
type Slots = InstanceType<typeof VTextField>["$slots"];
defineSlots</* @vue-ignore */ InstanceType<typeof VTextField>["$slots"]>();
const slots = useSlots(); // { default: fn, header: fn, footer: fn, ... }
const attrs = useAttrs(); // all props + v-on listeners not declared
</script>
