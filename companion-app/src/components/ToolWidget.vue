<script setup lang="ts">
import { computed } from "vue";
import TransformSandbox from "@/features/tools/TransformSandbox.vue";
import CryptoLab from "@/features/tools/CryptoLab.vue";
import LedgerExplorer from "@/features/tools/LedgerExplorer.vue";
import VisibleRailsExplainer from "@/features/tools/VisibleRailsExplainer.vue";
import AttemptStateExplorer from "@/features/tools/AttemptStateExplorer.vue";

const props = defineProps<{ tool: string }>();

const component = computed(() => {
    switch (props.tool) {
        case "transform-sandbox":
            return TransformSandbox;
        case "crypto-lab":
            return CryptoLab;
        case "ledger-explorer":
            return LedgerExplorer;
        case "visible-rails":
            return VisibleRailsExplainer;
        case "attempt-states":
            return AttemptStateExplorer;
        default:
            return null;
    }
});
</script>

<template>
    <component :is="component" v-if="component" />
</template>
