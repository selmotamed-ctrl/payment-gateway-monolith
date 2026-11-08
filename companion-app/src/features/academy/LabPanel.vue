<script setup lang="ts">
import type { Panel } from "@/content/types";

defineProps<{ panel: Panel }>();
</script>

<template>
    <section class="lab-panel">
        <h3 v-if="!('rows' in panel) && !('table' in panel) && !('timeline' in panel) && !('text' in panel)" class="lab-panel__lead">
            {{ panel.title }}
        </h3>
        <template v-else>
            <h3>{{ panel.title }}</h3>
            <dl v-if="'rows' in panel && panel.rows" class="kv-list">
                <div v-for="row in panel.rows" :key="row[0]">
                    <dt>{{ row[0] }}</dt>
                    <dd dir="auto">{{ row[1] }}</dd>
                </div>
            </dl>
            <div v-if="'table' in panel && panel.table" class="table-wrap">
                <table class="data-table">
                    <thead><tr><th v-for="column in panel.table.columns" :key="column">{{ column }}</th></tr></thead>
                    <tbody>
                        <tr v-for="(row, index) in panel.table.rows" :key="index">
                            <td v-for="(cell, cellIndex) in row" :key="cellIndex" dir="auto">{{ cell }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <ol v-if="'timeline' in panel && panel.timeline" class="lab-timeline">
                <li v-for="entry in panel.timeline" :key="`${entry.t}-${entry.text}`">
                    <span class="mono">{{ entry.t }}</span>
                    <span class="check-dot" :class="{ 'is-done': entry.flag === 'ok', 'is-warn': entry.flag === 'warn', 'is-bad': entry.flag === 'bad' }" />
                    <span dir="auto">{{ entry.text }}</span>
                </li>
            </ol>
            <p v-if="'text' in panel && panel.text" dir="auto">{{ panel.text }}</p>
        </template>
    </section>
</template>
