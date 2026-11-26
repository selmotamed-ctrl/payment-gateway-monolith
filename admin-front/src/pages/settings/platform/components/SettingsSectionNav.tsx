import { defineComponent, useId, type PropType, type VNodeChild } from "vue";
import { VIcon } from "vuetify/components";
import { useLocale } from "vuetify";
import { SETTING_SECTIONS, type SettingSectionCount, type SettingsViewId } from "@/components/builders/model";

export const SettingsSectionNav = defineComponent({
    name: "SettingsSectionNav",
    props: {
        modelValue: { type: String as PropType<SettingsViewId>, required: true },
        counts: { type: Array as PropType<SettingSectionCount[]>, required: true },
        ariaLabel: { type: String, default: "" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const baseId = useId();
        const items: Array<{ id: SettingsViewId; title: string; description: string; icon: string }> = [
            {
                id: "all",
                title: t("All settings"),
                description: t("Every setting, grouped by section."),
                icon: "mdi-view-grid-outline",
            },
            ...SETTING_SECTIONS.map((section) => ({
                id: section.id as SettingsViewId,
                title: t(section.title),
                description: t(section.description),
                icon: section.icon,
            })),
        ];
        const countFor = (id: SettingsViewId) => props.counts.find((count) => count.id === id) ?? { id, count: 0, needsSetup: 0, attention: 0 };

        const select = (index: number) => {
            const item = items[index];
            if (!item) return;
            emit("update:modelValue", item.id);
            requestAnimationFrame(() => document.getElementById(`${baseId}-${item.id}`)?.focus());
        };

        const onKeydown = (event: KeyboardEvent, index: number) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                select((index + 1) % items.length);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                select((index - 1 + items.length) % items.length);
            } else if (event.key === "Home") {
                event.preventDefault();
                select(0);
            } else if (event.key === "End") {
                event.preventDefault();
                select(items.length - 1);
            }
        };

        return (): VNodeChild => (
            <nav class="pg-settings-rail" role="tablist" aria-label={props.ariaLabel || t("Settings sections")} aria-orientation="vertical">
                {items.map((item, index) => {
                    const active = item.id === props.modelValue;
                    const count = countFor(item.id);
                    return (
                        <button
                            key={item.id}
                            id={`${baseId}-${item.id}`}
                            type="button"
                            role="tab"
                            class="pg-settings-rail__item"
                            aria-selected={active ? "true" : "false"}
                            aria-controls="pg-settings-results"
                            tabindex={active ? 0 : -1}
                            data-section={item.id}
                            onClick={() => emit("update:modelValue", item.id)}
                            onKeydown={(event: KeyboardEvent) => onKeydown(event, index)}
                        >
                            <span class="pg-settings-rail__icon" aria-hidden="true">
                                <VIcon icon={item.icon} size={17} />
                            </span>
                            <span class="pg-settings-rail__body">
                                <span class="pg-settings-rail__title">{item.title}</span>
                                <span class="pg-settings-rail__description">{item.description}</span>
                            </span>
                            <span class="pg-settings-rail__meta">
                                <span class="pg-settings-rail__count" aria-label={t("{count} settings", { count: count.count })}>{count.count}</span>
                                {count.needsSetup > 0 && (
                                    <span class="pg-settings-rail__dot" title={t("{count} using defaults", { count: count.needsSetup })} aria-label={t("{count} using defaults", { count: count.needsSetup })} />
                                )}
                            </span>
                        </button>
                    );
                })}
            </nav>
        );
    },
});

export default SettingsSectionNav;
