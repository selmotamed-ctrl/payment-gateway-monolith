import { defineComponent, nextTick, ref, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import type { OrderTask as OrderTaskType } from "@/content/academy";
import type { OrderAnswer } from "../labScoring";
import { choiceTag, plainInline, renderInline } from "./PanelView";

/** Deterministic starting order: authored order, reversed when the authored order is already the answer. */
export const initialOrder = (task: OrderTaskType): string[] => {
    const ids = task.items.map((item) => item.id);
    const solved = ids.length === task.correctOrder.length && ids.every((id, index) => id === task.correctOrder[index]);
    return solved ? [...ids].reverse() : ids;
};

export const OrderTask = defineComponent({
    name: "AcademyLabOrderTask",
    props: {
        task: { type: Object as PropType<OrderTaskType>, required: true },
        answer: { type: Object as PropType<OrderAnswer | undefined>, default: undefined },
        locked: { type: Boolean, default: false },
        onChange: { type: Function as PropType<(answer: OrderAnswer) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const announcement = ref("");
        const root = ref<HTMLElement | null>(null);
        const currentOrder = (): string[] => props.answer?.order ?? initialOrder(props.task);
        const labelOf = (id: string) => props.task.items.find((item) => item.id === id)?.label ?? id;

        /** A moved row is re-inserted by the renderer, which drops focus: put it back on the same item. */
        const refocus = (id: string, direction: "up" | "down") => {
            const buttons = Array.from(root.value?.querySelectorAll<HTMLButtonElement>("button[data-order-id]") ?? []).filter(
                (button) => button.dataset.orderId === id,
            );
            const preferred = buttons.find((button) => button.dataset.orderDir === direction && !button.disabled);
            (preferred ?? buttons.find((button) => !button.disabled))?.focus();
        };

        const move = (index: number, delta: -1 | 1) => {
            const order = [...currentOrder()];
            const target = index + delta;
            if (target < 0 || target >= order.length) return;
            const moved = order[index];
            const other = order[target];
            if (moved === undefined || other === undefined) return;
            order[index] = other;
            order[target] = moved;
            announcement.value = `${plainInline(labelOf(moved))}: ${t("position")} ${target + 1} / ${order.length}`;
            props.onChange({ ...(props.answer ?? {}), order });
            void nextTick(() => refocus(moved, delta < 0 ? "up" : "down"));
        };
        return () => {
            const order = currentOrder();
            return (
                <div class="ac-lab-order" ref={root}>
                    <p class="ac-muted ac-lab-hintline">{t("Use the Up and Down buttons to put the steps in order.")}</p>
                    <ol class="ac-choices ac-lab-order__list">
                        {order.map((id, index) => {
                            const right = props.task.correctOrder[index] === id;
                            const label = labelOf(id);
                            const state = props.locked ? (right ? "good" : "bad") : "";
                            return (
                                <li key={id} class={["ac-choice", "ac-choice--locked", "ac-lab-order__item", state ? `ac-choice--${state}` : ""]}>
                                    <span class="ac-lab-order__pos ac-ltr" aria-hidden="true">
                                        {index + 1}
                                    </span>
                                    <span class="ac-choice__label" dir="auto">
                                        {renderInline(label)}
                                    </span>
                                    {props.locked ? (
                                        choiceTag(right ? "good" : "bad", right ? t("Right place") : t("Wrong place"))
                                    ) : (
                                        <span class="ac-lab-order__moves">
                                            <VBtn
                                                size="small"
                                                variant="outlined"
                                                icon="mdi-arrow-up"
                                                disabled={index === 0}
                                                aria-label={`${t("Move up")}: ${plainInline(label)}`}
                                                data-order-id={id}
                                                data-order-dir="up"
                                                onClick={() => move(index, -1)}
                                            />
                                            <VBtn
                                                size="small"
                                                variant="outlined"
                                                icon="mdi-arrow-down"
                                                disabled={index === order.length - 1}
                                                aria-label={`${t("Move down")}: ${plainInline(label)}`}
                                                data-order-id={id}
                                                data-order-dir="down"
                                                onClick={() => move(index, 1)}
                                            />
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                    <div aria-live="polite" role="status" class="ac-sr-only">
                        {announcement.value}
                    </div>
                    {props.locked ? (
                        <div class="ac-lab-order__solution">
                            <strong class="ac-h3">{t("Correct order")}:</strong>
                            <ol class="ac-lab-ol">
                                {props.task.correctOrder.map((id) => (
                                    <li key={id} dir="auto">
                                        {renderInline(labelOf(id))}
                                    </li>
                                ))}
                            </ol>
                        </div>
                    ) : null}
                </div>
            );
        };
    },
});
export default OrderTask;
