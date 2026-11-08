<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import AppIcon from "@/components/AppIcon.vue";
import type { Lab, LabTask } from "@/content/types";
import {
    ledgerTotals,
    parseDecimal,
    scoreLab,
    scoreTask,
    type ChecklistAnswer,
    type ChoiceAnswer,
    type LabScore,
    type LedgerAnswer,
    type MultiAnswer,
    type NumericAnswer,
    type OrderAnswer,
    type TaskAnswer,
    type TaskScore,
} from "./labScoring";
import { useI18n } from "@/lib/i18n";
import LabPanel from "./LabPanel.vue";

const props = defineProps<{ lab: Lab; best?: { bestScore: number; attempts: number; passedAt?: string } }>();
const emit = defineEmits<{ finish: [result: LabScore] }>();
const { L } = useI18n();

const stage = ref<"brief" | "task" | "result">("brief");
const index = ref(0);
const draft = reactive<Record<string, TaskAnswer | undefined>>({});
const submitted = reactive<Record<string, TaskAnswer | undefined>>({});
const checked = reactive<Record<string, TaskScore>>({});
const hintShown = reactive<Record<string, boolean>>({});
const result = ref<LabScore | null>(null);
const justChecked = ref(false);

const task = computed<LabTask>(() => props.lab.tasks[index.value] as LabTask);
const total = computed(() => props.lab.tasks.length);
const currentChecked = computed(() => checked[task.value.id]);
const possible = computed(() => props.lab.tasks.reduce((sum, entry) => sum + entry.points, 0));
const earned = computed(() => Object.values(checked).reduce((sum, entry) => sum + entry.score, 0));
const hintText = computed(() => (typeof task.value.hint === "string" ? task.value.hint : ""));
const answer = computed(() => draft[task.value.id]);

const initialOrder = (current: Extract<LabTask, { kind: "order" }>): string[] => {
    const ids = current.items.map((item) => item.id);
    const solved = ids.length === current.correctOrder.length && ids.every((id, i) => id === current.correctOrder[i]);
    return solved ? [...ids].reverse() : ids;
};

const ensureDraft = (): void => {
    const current = task.value;
    if (current.kind === "order" && !draft[current.id]) {
        draft[current.id] = { order: initialOrder(current) } as OrderAnswer;
    }
    if (current.kind === "choice" && !draft[current.id]) {
        draft[current.id] = { selected: null } as ChoiceAnswer;
    }
    if (current.kind === "multi" && !draft[current.id]) {
        draft[current.id] = { selected: [] } as MultiAnswer;
    }
    if (current.kind === "checklist" && !draft[current.id]) {
        draft[current.id] = { ticked: [] } as ChecklistAnswer;
    }
    if (current.kind === "ledger" && !draft[current.id]) {
        draft[current.id] = { cells: {} } as LedgerAnswer;
    }
    if (current.kind === "numeric" && !draft[current.id]) {
        draft[current.id] = { value: "" } as NumericAnswer;
    }
};

const canCheck = computed(() => {
    const current = task.value;
    const value = answer.value as any;
    if (current.kind === "choice") return Boolean(value?.selected);
    if (current.kind === "numeric") return parseDecimal(value?.value) !== null;
    return true;
});

const check = (): void => {
    ensureDraft();
    const current = task.value;
    const value = (draft[current.id] ?? {}) as TaskAnswer;
    const hintUsed = Boolean(hintShown[current.id]);
    submitted[current.id] = { ...value, hintUsed } as TaskAnswer;
    checked[current.id] = scoreTask(current, value, { hintUsed });
    justChecked.value = true;
};

const next = (): void => {
    justChecked.value = false;
    if (index.value + 1 < total.value) {
        index.value += 1;
        ensureDraft();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
    }
    const hints: Record<string, boolean> = {};
    for (const key of Object.keys(hintShown)) hints[key] = Boolean(hintShown[key]);
    result.value = scoreLab(props.lab, submitted, hints);
    stage.value = "result";
    emit("finish", result.value);
};

const start = (): void => {
    stage.value = "task";
    ensureDraft();
};

const reset = (): void => {
    for (const bag of [draft, submitted, checked, hintShown]) {
        for (const key of Object.keys(bag)) delete (bag as Record<string, unknown>)[key];
    }
    stage.value = "brief";
    index.value = 0;
    result.value = null;
    justChecked.value = false;
};

const choose = (id: string): void => {
    if (justChecked.value) return;
    draft[task.value.id] = { selected: id } as ChoiceAnswer;
};

const toggleMulti = (id: string): void => {
    if (justChecked.value) return;
    const current = (draft[task.value.id] as MultiAnswer | undefined)?.selected ?? [];
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    draft[task.value.id] = { selected: next } as MultiAnswer;
};

const toggleChecklist = (id: string): void => {
    if (justChecked.value) return;
    const current = (draft[task.value.id] as ChecklistAnswer | undefined)?.ticked ?? [];
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    draft[task.value.id] = { ticked: next } as ChecklistAnswer;
};

const ledgerCell = (account: string, side: "DR" | "CR"): string => {
    const current = draft[task.value.id] as LedgerAnswer | undefined;
    return current?.cells[account]?.[side] ?? "";
};

const setLedgerCell = (account: string, side: "DR" | "CR", value: string): void => {
    if (justChecked.value) return;
    if (value !== "" && !/^-?\d*\.?\d*$/.test(value)) return;
    const current = (draft[task.value.id] as LedgerAnswer | undefined)?.cells ?? {};
    draft[task.value.id] = {
        cells: { ...current, [account]: { ...(current[account] ?? {}), [side]: value } },
    } as LedgerAnswer;
};

const ledgerBalance = computed(() => {
    const current = draft[task.value.id] as LedgerAnswer | undefined;
    const totals = ledgerTotals(current?.cells ?? {});
    return { ...totals, balanced: totals.debit.eq(totals.credit) && totals.debit.gt(0) };
});

const orderIds = computed(() => {
    const current = task.value;
    if (current.kind !== "order") return [];
    const value = draft[current.id] as OrderAnswer | undefined;
    return value?.order ?? initialOrder(current);
});

const move = (position: number, delta: -1 | 1): void => {
    if (justChecked.value || task.value.kind !== "order") return;
    const order = [...orderIds.value];
    const target = position + delta;
    if (target < 0 || target >= order.length) return;
    const moved = order[position];
    const other = order[target];
    if (!moved || !other) return;
    order[position] = other;
    order[target] = moved;
    draft[task.value.id] = { order } as OrderAnswer;
};

const numericValue = computed(() => (answer.value as NumericAnswer | undefined)?.value ?? "");
const setNumeric = (value: string): void => {
    draft[task.value.id] = { value } as NumericAnswer;
};

const outcomeLabel = (outcome: TaskScore | undefined): string => {
    if (!outcome) return "";
    if (outcome.correct) return "Correct";
    return outcome.score > 0 ? "Partly correct" : "Not correct";
};
</script>

<template>
    <section v-if="stage === 'brief'" class="lab-brief">
        <div class="training-strip">
            <AppIcon name="flask" :size="17" />
            <strong>{{ L("academy.training") }}</strong>
            <span class="chip">SANDBOX</span>
        </div>
        <h2>{{ lab.title }}</h2>
        <p class="lead" dir="auto">{{ lab.briefing }}</p>
        <div class="lab-facts">
            <div><span>Tasks</span><strong>{{ lab.tasks.length }}</strong></div>
            <div><span>Duration</span><strong>{{ lab.minutes }} min</strong></div>
            <div><span>Pass mark</span><strong>{{ lab.passPercent }}%</strong></div>
        </div>
        <p v-if="best?.attempts" class="muted">
            Best score: {{ best.bestScore }}% · {{ best.attempts }} attempts
            <span v-if="best.passedAt"> · passed</span>
        </p>
        <p v-else class="muted">You have not tried this lab yet.</p>
        <button type="button" class="btn btn--primary" @click="start">
            <AppIcon name="play" :size="17" />
            Start lab
        </button>
        <p class="small muted">Pass mark {{ lab.passPercent }}% with no critical error.</p>
    </section>

    <section v-else-if="stage === 'task'" class="lab-runner">
        <div class="training-strip">
            <AppIcon name="flask" :size="17" />
            <strong>{{ L("academy.training") }}</strong>
            <span class="chip">SANDBOX</span>
        </div>
        <div class="lab-progress">
            <div>
                <span class="eyebrow">Task {{ index + 1 }} / {{ total }}</span>
                <h2>{{ task.title }}</h2>
            </div>
            <span class="chip">{{ earned }} / {{ possible }} pts</span>
        </div>
        <div class="lab-panels">
            <LabPanel v-for="(panel, panelIndex) in task.panels" :key="panelIndex" :panel="panel" />
        </div>
        <p class="lab-prompt" dir="auto">{{ task.prompt }}</p>

        <div v-if="task.kind === 'choice'" class="choice-list">
            <button
                v-for="option in task.options"
                :key="option.id"
                type="button"
                class="choice-button"
                :class="{
                    'is-selected': (answer as any)?.selected === option.id,
                    'is-correct': justChecked && currentChecked && option.correct,
                    'is-wrong': justChecked && (answer as any)?.selected === option.id && !option.correct,
                }"
                :disabled="Boolean(currentChecked)"
                @click="choose(option.id)"
            >
                <span class="choice-mark"><span class="choice-dot" /></span>
                <span dir="auto">{{ option.label }}</span>
                <small v-if="justChecked && (answer as any)?.selected === option.id" class="choice-note">
                    {{ option.feedback }}
                </small>
            </button>
        </div>

        <div v-else-if="task.kind === 'multi'" class="choice-list">
            <label v-for="option in task.options" :key="option.id" class="check-row" :class="{ 'is-checked': ((answer as any)?.selected ?? []).includes(option.id) }">
                <input
                    type="checkbox"
                    :checked="((answer as any)?.selected ?? []).includes(option.id)"
                    :disabled="Boolean(currentChecked)"
                    @change="toggleMulti(option.id)"
                />
                <span><strong dir="auto">{{ option.label }}</strong><small v-if="justChecked">{{ option.feedback }}</small></span>
            </label>
        </div>

        <div v-else-if="task.kind === 'checklist'" class="choice-list">
            <label v-for="item in task.items" :key="item.id" class="check-row" :class="{ 'is-checked': ((answer as any)?.ticked ?? []).includes(item.id) }">
                <input
                    type="checkbox"
                    :checked="((answer as any)?.ticked ?? []).includes(item.id)"
                    :disabled="Boolean(currentChecked)"
                    @change="toggleChecklist(item.id)"
                />
                <span><strong dir="auto">{{ item.label }}</strong><small v-if="justChecked">{{ item.why }}</small></span>
            </label>
        </div>

        <div v-else-if="task.kind === 'numeric'" class="field">
            <span>Your answer</span>
            <input
                class="input"
                type="text"
                inputmode="decimal"
                dir="ltr"
                :value="numericValue"
                :disabled="Boolean(currentChecked)"
                @input="setNumeric(($event.target as HTMLInputElement).value)"
            />
            <small v-if="task.unit" class="muted">{{ task.unit }}</small>
        </div>

        <div v-else-if="task.kind === 'ledger'" class="ledger-grid">
            <div class="table-wrap">
                <table class="data-table">
                    <thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
                    <tbody>
                        <tr v-for="account in task.accounts" :key="account">
                            <th scope="row">{{ account }}</th>
                            <td><input class="input input--cell" inputmode="decimal" dir="ltr" :value="ledgerCell(account, 'DR')" :disabled="Boolean(currentChecked)" @input="setLedgerCell(account, 'DR', ($event.target as HTMLInputElement).value)" /></td>
                            <td><input class="input input--cell" inputmode="decimal" dir="ltr" :value="ledgerCell(account, 'CR')" :disabled="Boolean(currentChecked)" @input="setLedgerCell(account, 'CR', ($event.target as HTMLInputElement).value)" /></td>
                        </tr>
                    </tbody>
                    <tfoot>
                        <tr><th>Total</th><td>{{ ledgerBalance.debit.toFixed() }}</td><td>{{ ledgerBalance.credit.toFixed() }}</td></tr>
                    </tfoot>
                </table>
            </div>
            <span class="chip" :class="ledgerBalance.balanced ? 'chip--success' : 'chip--danger'">
                {{ ledgerBalance.balanced ? "Balanced" : "NOT BALANCED" }}
            </span>
        </div>

        <div v-else-if="task.kind === 'order'" class="order-list">
            <p class="muted small">Use the up and down buttons to put the steps in order.</p>
            <ol>
                <li v-for="(id, position) in orderIds" :key="id" class="order-row">
                    <span class="order-position mono">{{ position + 1 }}</span>
                    <span dir="auto">{{ task.items.find((item) => item.id === id)?.label }}</span>
                    <span class="order-moves">
                        <button type="button" class="icon-button icon-button--tiny" :disabled="position === 0 || Boolean(currentChecked)" @click="move(position, -1)">
                            <AppIcon name="arrow-left" :size="15" class="rotate-up" />
                        </button>
                        <button type="button" class="icon-button icon-button--tiny" :disabled="position === orderIds.length - 1 || Boolean(currentChecked)" @click="move(position, 1)">
                            <AppIcon name="arrow-right" :size="15" class="rotate-down" />
                        </button>
                    </span>
                </li>
            </ol>
        </div>

        <div v-if="hintText && !currentChecked" class="hint-box">
            <button v-if="!hintShown[task.id]" type="button" class="btn btn--small btn--ghost" @click="hintShown[task.id] = true">
                Show hint (−1 point)
            </button>
            <p v-else class="muted" dir="auto">{{ hintText }}</p>
        </div>

        <div v-if="currentChecked" class="task-feedback" aria-live="polite">
            <p class="feedback" :class="currentChecked.correct ? 'feedback--good' : currentChecked.criticalError ? 'feedback--bad' : 'feedback--warn'">
                <AppIcon :name="currentChecked.correct ? 'check' : 'alert'" :size="16" />
                {{ outcomeLabel(currentChecked) }}
                <span v-if="currentChecked.criticalError"> · critical error</span>
            </p>
            <p v-if="task.kind === 'choice' || task.kind === 'multi' || task.kind === 'checklist'" class="muted" dir="auto">
                {{ task.kind === "choice" ? task.options.find((option) => option.id === (answer as any)?.selected)?.feedback : (task as any).feedback }}
            </p>
            <p v-else class="muted" dir="auto">{{ task.feedback }}</p>
        </div>

        <div class="lab-actions">
            <button v-if="!currentChecked" type="button" class="btn btn--primary" :disabled="!canCheck" @click="check">
                Check answer
            </button>
            <button v-else type="button" class="btn btn--primary" @click="next">
                {{ index + 1 < total ? "Next task" : "Finish lab" }}
                <AppIcon name="arrow-right" :size="17" />
            </button>
            <button type="button" class="btn btn--ghost" @click="reset">Restart</button>
        </div>
    </section>

    <section v-else-if="stage === 'result' && result" class="lab-result">
        <div class="result-ring" :class="{ 'is-passed': result.passed }">
            <strong>{{ result.score }}%</strong>
            <small>{{ result.passed ? "Passed" : "Not passed" }}</small>
        </div>
        <h2>{{ result.passed ? "Lab complete" : "Keep practising" }}</h2>
        <p class="muted">{{ result.earned }} / {{ result.possible }} points · {{ result.criticalErrors }} critical errors</p>
        <p class="muted">Pass mark {{ lab.passPercent }}% with no critical error.</p>
        <ol class="result-list">
            <li v-for="taskResult in result.tasks" :key="taskResult.taskId">
                <span>{{ lab.tasks.find((entry) => entry.id === taskResult.taskId)?.title }}</span>
                <span class="chip" :class="taskResult.correct ? 'chip--success' : taskResult.criticalError ? 'chip--danger' : 'chip--muted'">
                    {{ taskResult.score }} / {{ taskResult.maxScore }}
                </span>
            </li>
        </ol>
        <div class="hero-actions">
            <button type="button" class="btn btn--primary" @click="reset">Try the lab again</button>
        </div>
    </section>
</template>
