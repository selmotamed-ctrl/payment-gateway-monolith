import { defineComponent, ref, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import type { OrderTask as OrderTaskType } from "@/content/academy";
import type { OrderAnswer } from "../labScoring";
import { labBorder, renderInline, srOnly } from "./PanelView";

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
        const currentOrder = (): string[] => props.answer?.order ?? initialOrder(props.task);
        const labelOf = (id: string) => props.task.items.find((item) => item.id === id)?.label ?? id;
        const move = (index: number, delta: -1 | 1) => {
            const order = [...currentOrder()];
            const target = index + delta;
            if (target < 0 || target >= order.length) return;
            const moved = order[index];
            const other = order[target];
            if (moved === undefined || other === undefined) return;
            order[index] = other;
            order[target] = moved;
            announcement.value = `${labelOf(moved).replace(/\*\*/g, "")}: ${t("position")} ${target + 1} / ${order.length}`;
            props.onChange({ ...(props.answer ?? {}), order });
        };
        return () => {
            const order = currentOrder();
            return (
                <div style={{ display: "grid", gap: "8px" }}>
                    <p style={{ margin: 0, opacity: 0.8 }}>{t("Use the Up and Down buttons to put the steps in order.")}</p>
                    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "8px" }}>
                        {order.map((id, index) => {
                            const right = props.task.correctOrder[index] === id;
                            const label = labelOf(id);
                            return (
                                <li
                                    style={{
                                        display: "flex",
                                        gap: "10px",
                                        alignItems: "center",
                                        border: labBorder,
                                        borderRadius: "8px",
                                        padding: "8px 12px",
                                    }}
                                >
                                    <span style={{ fontWeight: 700, minWidth: "1.5em" }}>{index + 1}.</span>
                                    <span style={{ flex: 1 }}>{renderInline(label)}</span>
                                    {props.locked ? (
                                        <span style={{ whiteSpace: "nowrap" }}>
                                            <VIcon icon={right ? "mdi-check-circle" : "mdi-close-circle"} color={right ? "success" : "error"} size={18} aria-hidden="true" />{" "}
                                            {right ? t("Right place") : t("Wrong place")}
                                        </span>
                                    ) : (
                                        <span style={{ display: "inline-flex", gap: "4px" }}>
                                            <VBtn
                                                size="small"
                                                variant="outlined"
                                                icon="mdi-arrow-up"
                                                disabled={index === 0}
                                                aria-label={`${t("Move up")}: ${label.replace(/\*\*/g, "")}`}
                                                onClick={() => move(index, -1)}
                                            />
                                            <VBtn
                                                size="small"
                                                variant="outlined"
                                                icon="mdi-arrow-down"
                                                disabled={index === order.length - 1}
                                                aria-label={`${t("Move down")}: ${label.replace(/\*\*/g, "")}`}
                                                onClick={() => move(index, 1)}
                                            />
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                    <div aria-live="polite" role="status" style={srOnly}>
                        {announcement.value}
                    </div>
                    {props.locked ? (
                        <div>
                            <strong>{t("Correct order")}:</strong>
                            <ol style={{ margin: "4px 0 0", paddingInlineStart: "1.5em" }}>
                                {props.task.correctOrder.map((id) => (
                                    <li>{renderInline(labelOf(id))}</li>
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
