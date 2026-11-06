<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import { recordLab, useCompanionData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { successFeedback, tapFeedback } from "@/lib/haptics";
import { useContent } from "@/content/store";
import type { LabScore } from "./labScoring";
import LabRunner from "./LabRunner.vue";

const route = useRoute();
const { bundle } = useContent();
const { data } = useCompanionData();
const { L } = useI18n();

const labId = computed(() => String(route.params.labId ?? ""));
const lab = computed(() => bundle.value?.academy.labs.find((entry) => entry.id === labId.value));
const parent = computed(() => bundle.value?.academy.modules.find((entry) => entry.id === lab.value?.module));
const best = computed(() => data.value.labs[labId.value]);

const finish = (result: LabScore): void => {
    if (!lab.value) return;
    recordLab(lab.value.id, bundle.value?.meta.contentVersion ?? "0.0.0", result);
    if (result.passed) void successFeedback();
    else void tapFeedback();
};
</script>

<template>
    <div class="page">
        <PageHeader
            v-if="lab"
            :title="lab.title"
            :subtitle="parent ? `${parent.title} · ${lab.minutes} min` : `${lab.minutes} min`"
            :back-to="parent ? `/academy/module/${parent.id}` : '/academy'"
            tone="academy"
        />
        <LabRunner v-if="lab" :lab="lab" :best="best" @finish="finish" />
        <div v-else class="empty-state">
            <h2>This lab does not exist.</h2>
            <RouterLink to="/academy" class="btn btn--primary">{{ L("nav.academy") }}</RouterLink>
        </div>
    </div>
</template>
