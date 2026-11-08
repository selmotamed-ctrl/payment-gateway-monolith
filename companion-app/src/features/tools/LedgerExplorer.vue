<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@/lib/i18n";
import { useContent } from "@/content/store";
import { simulateLedgerEvent } from "./engine/ledger";

const { L } = useI18n();
const { bundle } = useContent();
const ledger = computed(() => bundle.value?.guide.data["ledger-events"]);
const eventId = ref("");
const selectedEventId = computed(() => eventId.value || ledger.value?.events[0]?.id || "");
const result = computed(() => {
    if (!ledger.value) return undefined;
    return simulateLedgerEvent(ledger.value, selectedEventId.value);
});
const reset = (): void => {
    eventId.value = "";
};
</script>

<template>
    <section class="tool-card">
        <header class="tool-card__head">
            <div>
                <p class="eyebrow">{{ L("tool.title") }}</p>
                <h3>{{ L("tool.ledger") }}</h3>
            </div>
            <button type="button" class="btn btn--small btn--ghost" @click="reset">{{ L("tool.reset") }}</button>
        </header>
        <p class="tool-note">{{ L("tool.teaching") }}</p>
        <label v-if="ledger" class="field">
            <span>Journal event</span>
            <select v-model="eventId" class="select">
                <option value="">{{ ledger.events[0]?.title }}</option>
                <option v-for="event in ledger.events.slice(1)" :key="event.id" :value="event.id">{{ event.title }}</option>
            </select>
        </label>
        <template v-if="result">
            <div v-for="entry in result.entries" :key="entry.label" class="ledger-entry">
                <p class="eyebrow">{{ entry.label }}</p>
                <div class="table-wrap">
                    <table class="data-table">
                        <thead>
                            <tr><th>Account</th><th>Dr</th><th>Cr</th><th>Why</th></tr>
                        </thead>
                        <tbody>
                            <tr v-for="(line, index) in entry.lines" :key="index">
                                <td>{{ line.account }}</td>
                                <td>{{ line.side === "DR" ? line.value : "" }}</td>
                                <td>{{ line.side === "CR" ? line.value : "" }}</td>
                                <td class="muted">{{ line.why }}</td>
                            </tr>
                        </tbody>
                        <tfoot>
                            <tr>
                                <th>Total</th>
                                <th>{{ entry.debitTotal }}</th>
                                <th>{{ entry.creditTotal }}</th>
                                <th>
                                    <span class="chip" :class="entry.balanced ? 'chip--success' : 'chip--danger'">
                                        {{ entry.balanced ? "Balanced" : "NOT BALANCED" }}
                                    </span>
                                </th>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
            <div class="tool-output">
                <p class="eyebrow">Accounting equation</p>
                <p class="mono">{{ result.equation.left }} = {{ result.equation.rightPlus }} − {{ result.equation.rightMinus }} = {{ result.equation.right }}</p>
                <p v-if="result.showBalance" class="muted">{{ result.showBalance.label }}: <strong>{{ result.showBalance.value }}</strong></p>
            </div>
        </template>
    </section>
</template>
