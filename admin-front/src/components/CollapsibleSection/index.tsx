import { defineComponent, ref, watch, type PropType } from "vue";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { VCard, VCardText, VIcon } from "vuetify/components";
import { ThemedText } from "../ThemedText";
import { ThemedView } from "../ThemedView";
import { StatusChip, type StatusTone } from "../StatusChip";

export type SectionCommand = { id: number; open: boolean };

const readOpenState = (key: string | undefined, fallback: boolean): boolean => {
    if (!key || typeof window === "undefined") return fallback;
    try {
        const stored = window.sessionStorage.getItem(key);
        if (stored === "1") return true;
        if (stored === "0") return false;
    } catch {
        return fallback;
    }
    return fallback;
};

const CollapsibleSection = defineComponent({
    name: "CollapsibleSection",
    props: {
        title: { type: String, required: true },
        subtitle: { type: String, default: "" },
        defaultOpen: { type: Boolean, default: false },
        storageKey: { type: String, default: "" },
        count: { type: [Number, String], default: null },
        tone: { type: String as () => StatusTone | null, default: null },
        command: { type: Object as PropType<SectionCommand | null>, default: null },
        alwaysOpen: { type: Boolean, default: false },
    },
    setup(props, { slots }) {
        const { t } = useLocale();
        const theme = useTheme();
        const display = useDisplay();
        const open = ref(readOpenState(props.storageKey, props.defaultOpen));

        const persist = () => {
            if (!props.storageKey || typeof window === "undefined") return;
            try {
                window.sessionStorage.setItem(props.storageKey, open.value ? "1" : "0");
            } catch {
                return;
            }
        };

        watch(() => props.storageKey, () => {
            open.value = readOpenState(props.storageKey, props.defaultOpen);
        });

        watch(open, persist);

        watch(
            () => props.command?.id,
            () => {
                if (props.command) open.value = props.command.open;
            },
        );

        watch(
            () => props.alwaysOpen,
            (value) => {
                if (value) open.value = true;
            },
            { immediate: true },
        );

        return () => {
            const colors = theme.current.value.colors;
            return (
                <VCard
                    variant="flat"
                    style={{
                        border: `1px solid ${colors.outlineVariant}30`,
                        borderRadius: "16px",
                        overflow: "hidden",
                    }}
                >
                    <VCardText style={{ padding: "0" }}>
                        <button
                            type="button"
                            aria-expanded={open.value ? "true" : "false"}
                            onClick={() => {
                                if (!props.alwaysOpen) open.value = !open.value;
                            }}
                            style={{
                                width: "100%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "12px",
                                padding: display.mobile.value ? "16px" : "18px 22px",
                                background: "transparent",
                                border: "0",
                                cursor: props.alwaysOpen ? "default" : "pointer",
                                textAlign: "left",
                                color: "inherit",
                            }}
                        >
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flex: "1", minWidth: "0" }}>
                                {!props.alwaysOpen && (
                                    <VIcon icon={open.value ? "mdi-chevron-down" : "mdi-chevron-right"} size="20" style={{ opacity: 0.65, flex: "0 0 auto" }} />
                                )}
                                <ThemedView style={{ gap: "3px", minWidth: "0" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t(props.title)}</ThemedText>
                                    {props.subtitle && (
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.62, lineHeight: 1.5 }}>{t(props.subtitle)}</ThemedText>
                                    )}
                                </ThemedView>
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flex: "0 0 auto" }}>
                                {props.count !== null && props.count !== "" && (
                                    <StatusChip label={String(props.count)} tone={props.tone ?? "neutral"} size="small" />
                                )}
                            </ThemedView>
                        </button>
                        {open.value && (
                            <div style={{ padding: display.mobile.value ? "0 12px 16px" : "0 16px 18px" }}>
                                {slots.default?.()}
                            </div>
                        )}
                    </VCardText>
                </VCard>
            );
        };
    },
});

export default CollapsibleSection;
