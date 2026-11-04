import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { VDialog } from "vuetify/components";
import { loadCards, type Card } from "@/content/guide";
import { MarkdownView } from "./MarkdownView";
import { useSafeguardState } from "./useSafeguard";

export const SafeguardDialog = defineComponent({
    name: "SafeguardDialog",
    setup() {
        const { open, cardId, resolveSafeguard } = useSafeguardState();
        const cards = ref<Card[]>([]);
        const ticks = ref<boolean[]>([]);
        const card = computed(() => cards.value.find((entry) => entry.id === cardId.value) ?? null);
        const allTicked = computed(
            () => Boolean(card.value) && ticks.value.length === card.value!.checklist.length && ticks.value.every(Boolean),
        );

        onMounted(async () => {
            cards.value = await loadCards().catch(() => []);
        });

        watch(
            () => [open.value, cardId.value] as const,
            () => {
                if (!open.value || !card.value) return;
                ticks.value = card.value.checklist.map(() => false);
            },
            { immediate: true },
        );

        const toggle = (index: number) => {
            const next = [...ticks.value];
            next[index] = !next[index];
            ticks.value = next;
        };

        return () => (
            <VDialog
                modelValue={open.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) resolveSafeguard(false);
                }}
                maxWidth={640}
                persistent
                scrollable
                contentClass="guide-safeguard-dialog"
            >
                <div class="guide-safeguard" role="document">
                    {card.value ? (
                        <>
                            <div class="guide-safeguard__header">
                                <div>
                                    <p class="guide-context-drawer__eyebrow">Safety check before you continue</p>
                                    <h2>{card.value.title}</h2>
                                </div>
                                <span class={`guide-risk-badge guide-risk-${card.value.risk.toLowerCase()}`}>
                                    {card.value.risk}
                                </span>
                            </div>
                            <div class="guide-safeguard__body">
                                <MarkdownView source={card.value.body} compact disableGlossaryLinks />
                                <div class="guide-safeguard__checks" role="group" aria-label="Required checks">
                                    {card.value.checklist.map((item, index) => (
                                        <label key={`${card.value!.id}-${index}`} class="guide-safeguard-check">
                                            <input
                                                type="checkbox"
                                                checked={ticks.value[index] ?? false}
                                                onChange={() => toggle(index)}
                                            />
                                            <span>{item}</span>
                                        </label>
                                    ))}
                                </div>
                                {card.value.irreversible ? (
                                    <p class="guide-irreversible">
                                        This action cannot be undone. If you are unsure, cancel and ask.
                                    </p>
                                ) : null}
                            </div>
                            <div class="guide-safeguard__footer">
                                <button
                                    type="button"
                                    class="guide-secondary-button"
                                    onClick={() => resolveSafeguard(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    class="guide-primary-button"
                                    disabled={!allTicked.value}
                                    onClick={() => resolveSafeguard(true)}
                                >
                                    Continue
                                </button>
                            </div>
                        </>
                    ) : (
                        <div class="guide-safeguard__body">
                            <p>Loading the safety check…</p>
                            <button type="button" class="guide-secondary-button" onClick={() => resolveSafeguard(false)}>
                                Cancel
                            </button>
                        </div>
                    )}
                </div>
            </VDialog>
        );
    },
});

export default SafeguardDialog;
