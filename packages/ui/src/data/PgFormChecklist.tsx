import { computed } from "vue";
import { dc } from "../lib/dc";
import { useLocale } from "../lib/locale";
import { PgCheckbox } from "../inputs/PgCheckbox";
import { PgIcon } from "../actions/PgIcon";

export type PgChecklistStatus = "done" | "pending" | "error";

export interface PgChecklistItem {
    /** Canonical 2026 identifier. */
    id?: string;
    /** Legacy identifier used by every pre-2026 checklist. */
    key?: string;
    label: string;
    hint?: string;
    status?: PgChecklistStatus;
    disabled?: boolean;
}

type ChecklistModel = string[] | Record<string, boolean>;

const itemId = (item: PgChecklistItem, index: number): string => item.id ?? item.key ?? `check-${index}`;
const itemKey = (item: PgChecklistItem, index: number): string => item.key ?? item.id ?? `check-${index}`;
const isSelected = (model: ChecklistModel | undefined, id: string, key: string): boolean => {
    if (Array.isArray(model)) return model.includes(id) || model.includes(key);
    return Boolean(model?.[key] === true || model?.[id] === true);
};

const statusIcon = (status: PgChecklistStatus): string => {
    if (status === "done") return "mdi-check-circle";
    if (status === "error") return "mdi-alert-circle";
    return "mdi-circle-outline";
};

/**
 * Verification / export checklist.
 *
 * `interactive` (the default) renders real `PgCheckbox` rows and emits the
 * selected ids. Read-only status mode never renders disabled inputs: it shows
 * semantic done / pending / blocked icons instead. A select-all row appears
 * once the list reaches four items.
 */
export const PgFormChecklist = dc(
    (
        props: {
            items?: PgChecklistItem[];
            checks?: PgChecklistItem[];
            modelValue?: ChecklistModel;
            interactive?: boolean;
            show?: boolean;
            title?: string;
            complete?: boolean;
            incompleteMessage?: string;
        },
        _expose,
        { attrs, emit },
    ) => {
        const { t } = useLocale();

        const items = computed<PgChecklistItem[]>(() => (props.items?.length ? props.items : (props.checks ?? [])));
        const interactive = computed(() => props.interactive !== false);
        const visible = computed(() => props.show !== false);
        const selectedIds = computed<string[]>(() => {
            const model = props.modelValue;
            if (Array.isArray(model)) return [...model];
            return items.value
                .map((item, index) => ({ item, index }))
                .filter(({ item, index }) => isSelected(model, itemId(item, index), itemKey(item, index)))
                .map(({ item, index }) => itemId(item, index));
        });
        const selectedCount = computed(() =>
            items.value.filter((item, index) => isSelected(props.modelValue, itemId(item, index), itemKey(item, index))).length,
        );
        const enabledEntries = computed(() =>
            items.value
                .map((item, index) => ({ item, index, id: itemId(item, index), key: itemKey(item, index) }))
                .filter((entry) => !entry.item.disabled),
        );
        const allSelected = computed(
            () =>
                enabledEntries.value.length > 0 &&
                enabledEntries.value.every((entry) => isSelected(props.modelValue, entry.id, entry.key)),
        );
        const someSelected = computed(() =>
            items.value.some((item, index) => isSelected(props.modelValue, itemId(item, index), itemKey(item, index))),
        );
        const showSelectAll = computed(() => interactive.value && items.value.length >= 4);

        const emitModel = (ids: string[], nextItem?: PgChecklistItem, nextIndex = 0, checked?: boolean) => {
            if (Array.isArray(props.modelValue)) {
                emit?.("update:modelValue", ids);
            } else {
                const record: Record<string, boolean> = { ...(props.modelValue ?? {}) };
                for (const [index, item] of items.value.entries()) {
                    const id = itemId(item, index);
                    const key = itemKey(item, index);
                    record[key] = ids.includes(id) || ids.includes(key);
                    if (id !== key) record[id] = record[key];
                }
                emit?.("update:modelValue", record);
            }
            if (nextItem) emit?.("toggle", itemId(nextItem, nextIndex), checked);
        };
        const setSelected = (item: PgChecklistItem, index: number, checked: boolean) => {
            if (item.disabled) return;
            const id = itemId(item, index);
            const key = itemKey(item, index);
            const ids = selectedIds.value.filter((value) => value !== id && value !== key);
            if (checked) ids.push(id);
            emitModel(ids, item, index, checked);
        };
        const setAll = (checked: boolean) => {
            const entries = enabledEntries.value;
            const current = selectedIds.value;
            const ids = current.filter((value) => !entries.some((entry) => entry.id === value || entry.key === value));
            if (checked) ids.push(...entries.map((entry) => entry.id));
            emitModel(ids);
            for (const entry of entries) emit?.("toggle", entry.id, checked);
        };

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-checklist",
                    interactive.value ? "pg-checklist--interactive" : "pg-checklist--readonly",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                hidden={!visible.value}
            >
                {visible.value && props.title && <div class="pg-checklist__title">{t(props.title)}</div>}
                {visible.value && showSelectAll.value && (
                    <div class="pg-checklist__select-all">
                        <PgCheckbox
                            modelValue={allSelected.value}
                            indeterminate={someSelected.value && !allSelected.value}
                            label={allSelected.value ? t("Deselect all") : t("Select all")}
                            density="compact"
                            hideDetails
                            onUpdate:modelValue={(checked: unknown) => setAll(Boolean(checked))}
                        />
                        <span class="pg-checklist__count">
                            {selectedCount.value}/{items.value.length}
                        </span>
                    </div>
                )}
                {visible.value && (
                    <ul class="pg-checklist__list" role="list">
                        {items.value.map((item, index) => {
                            const id = itemId(item, index);
                            const key = itemKey(item, index);
                            const checked = isSelected(props.modelValue, id, key);
                            const status: PgChecklistStatus = item.status ?? (checked ? "done" : "pending");
                            return (
                                <li
                                    key={id}
                                    class={[
                                        "pg-checklist__row",
                                        interactive.value ? "pg-checklist__row--interactive" : "pg-checklist__row--readonly",
                                        checked ? "pg-checklist__row--on" : "",
                                        item.disabled ? "pg-checklist__row--disabled" : "",
                                        !interactive.value ? `pg-checklist__row--${status}` : "",
                                    ]
                                        .filter(Boolean)
                                        .join(" ")}
                                    onClick={
                                        interactive.value
                                            ? (event: MouseEvent) => {
                                                  const target = event.target as HTMLElement | null;
                                                  if (target?.closest("input, label, .pg-checkbox-field")) return;
                                                  setSelected(item, index, !checked);
                                              }
                                            : undefined
                                    }
                                >
                                    {interactive.value ? (
                                        <PgCheckbox
                                            modelValue={checked}
                                            label={t(item.label)}
                                            disabled={Boolean(item.disabled)}
                                            density="compact"
                                            hideDetails
                                            onUpdate:modelValue={(value: unknown) => setSelected(item, index, Boolean(value))}
                                        />
                                    ) : (
                                        <span class={`pg-checklist__status pg-checklist__status--${status}`}>
                                            <PgIcon
                                                icon={statusIcon(status)}
                                                size={16}
                                                color={status === "done" ? "success" : status === "error" ? "danger" : "muted"}
                                            />
                                            <span class="pg-sr-only">{t(status === "done" ? "Done" : status === "error" ? "Blocked" : "Pending")}</span>
                                        </span>
                                    )}
                                    {!interactive.value && <span class="pg-checklist__label">{t(item.label)}</span>}
                                    {item.hint && <span class="pg-checklist__item-hint">{t(item.hint)}</span>}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {visible.value && !props.complete && props.incompleteMessage && (
                    <div class="pg-checklist__hint">{t(props.incompleteMessage)}</div>
                )}
            </div>
        );
    },
    {
        props: {
            items: { type: Array as () => PgChecklistItem[], default: () => [] },
            checks: { type: Array as () => PgChecklistItem[], default: () => [] },
            modelValue: { type: [Array, Object] as unknown as () => ChecklistModel, default: () => [] },
            interactive: { type: Boolean, default: true },
            show: { type: Boolean, default: true },
            title: { type: String, default: "" },
            complete: { type: Boolean, default: true },
            incompleteMessage: { type: String, default: "" },
        },
        emits: ["update:modelValue", "toggle"],
        inheritAttrs: true,
    },
);

export const FormChecklist = PgFormChecklist;
