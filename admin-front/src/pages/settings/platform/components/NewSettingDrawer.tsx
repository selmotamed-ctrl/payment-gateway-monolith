import { computed, defineComponent, ref, watch, type PropType, type VNodeChild } from "vue";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SETTING_STATUS_META, settingTitle, type SettingEntry } from "@/components/builders/model";

export const NewSettingDrawer = defineComponent({
    name: "NewSettingDrawer",
    props: {
        modelValue: { type: Boolean, required: true },
        entries: { type: Array as PropType<SettingEntry[]>, required: true },
    },
    emits: ["update:modelValue", "select", "createCustom"],
    setup(props, { emit }) {
        const { t } = useLocale();
        const search = ref("");
        const customKey = ref("");
        const error = ref("");
        const filtered = computed(() => {
            const query = search.value.trim().toLowerCase();
            if (!query) return props.entries;
            return props.entries.filter((entry) =>
                [entry.key, settingTitle(entry), entry.definition.summary, entry.definition.description, ...entry.definition.keywords]
                    .join(" ")
                    .toLowerCase()
                    .includes(query),
            );
        });
        watch(
            () => props.modelValue,
            (open) => {
                if (open) {
                    search.value = "";
                    customKey.value = "";
                    error.value = "";
                }
            },
        );
        const createCustom = () => {
            const key = customKey.value.trim();
            if (!/^[A-Za-z0-9._:-]{2,120}$/.test(key)) {
                error.value = t("Use 2-120 letters, digits, dots, colons, underscores or hyphens.");
                return;
            }
            if (props.entries.some((entry) => entry.key === key)) {
                error.value = t("This setting is already in the list.");
                return;
            }
            emit("createCustom", key);
        };
        return (): VNodeChild => (
            <SlideOverDrawer
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                title={t("Add a setting")}
                subtitle={t("Choose a known runtime setting that has no stored value, or add an advanced custom key.")}
                width={680}
            >
                {props.modelValue ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    <VTextField
                        modelValue={search.value}
                        onUpdate:modelValue={(value: string) => (search.value = value)}
                        prependInnerIcon="mdi-magnify"
                        label={t("Search known settings")}
                        density="compact"
                        hideDetails
                        clearable
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {filtered.value.length === 0 && <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)" }}>{t("No known settings match this search. Use the advanced custom key below.")}</span>}
                        {filtered.value.map((entry) => {
                            const status = SETTING_STATUS_META[entry.displayStatus];
                            return (
                                <button
                                    key={entry.key}
                                    type="button"
                                    class="pg-settings-new__row"
                                    onClick={() => emit("select", entry)}
                                >
                                    <span style={{ minInlineSize: 0, flex: 1 }}>
                                        <span style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <strong style={{ fontSize: "13px" }}>{t(settingTitle(entry))}</strong>
                                            <span class="pg-mono-ref" style={{ fontSize: "11px", color: "var(--pg-ink-muted)" }}>{entry.key}</span>
                                            <StatusBadge status={entry.displayStatus} label={t(status.label)} toneOverride={status.tone} showDot={false} />
                                        </span>
                                        <span style={{ display: "block", fontSize: "12px", color: "var(--pg-ink-muted)", marginTop: "3px", lineHeight: 1.4 }}>{t(entry.definition.summary)}</span>
                                    </span>
                                    <span style={{ fontSize: "12px", color: "var(--pg-ink-secondary)" }}>{t("Set up")}</span>
                                </button>
                            );
                        })}
                    </div>
                    <VAlert type="info" variant="tonal" density="compact">
                        {t("A custom key is only a stored value. The platform will not read it until a core reader and a catalog entry exist.")}
                    </VAlert>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 600 }}>{t("Advanced: custom key")}</span>
                        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", flexWrap: "wrap" }}>
                            <VTextField
                                modelValue={customKey.value}
                                onUpdate:modelValue={(value: string) => (customKey.value = value)}
                                label={t("Setting key")}
                                hint={t("Use a domain.name key, for example my_feature.enabled. Existing OD-* keys are decision records.")}
                                density="compact"
                                hideDetails={false}
                                style={{ flex: 1, minInlineSize: "220px" }}
                            />
                            <VBtn variant="tonal" prependIcon="mdi-plus" onClick={createCustom}>{t("Continue")}</VBtn>
                        </div>
                        {error.value && <span style={{ fontSize: "12px", color: "var(--pg-status-danger-text)" }}>{error.value}</span>}
                    </div>
                </div>
                ) : null}
            </SlideOverDrawer>
        );
    },
});

export default NewSettingDrawer;
