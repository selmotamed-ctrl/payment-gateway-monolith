import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VCard, VCardText, VChip, VDialog, VList, VListItem, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { searchGuide } from "@/content/guide/search";
import type { GuideSearchEntry } from "@/content/guide/types";

type GlobalGuideSearchModalProps = {
    modelValue: boolean;
    "onUpdate:modelValue"?: (value: boolean) => void;
    onSelect?: (entry: GuideSearchEntry) => void;
};

const KIND_TONE: Record<string, "primary" | "success" | "warning" | "error" | "info" | "neutral"> = {
    book: "primary",
    chapter: "info",
    glossary: "success",
    error: "error",
    gl: "warning",
    status: "info",
    collection: "primary",
    channel: "warning",
    runbook: "error",
    "edge-case": "neutral",
    simulator: "success",
};

export const GlobalGuideSearchModal = dc(
    (props: GlobalGuideSearchModalProps) => {
        const { current } = useLocale();
        const query = ref("");
        const selected = ref(0);
        const isArabic = () => current.value === "ar";

        const results = computed(() => searchGuide(query.value, 60));
        const setOpen = (value: boolean) => props["onUpdate:modelValue"]?.(value);
        const close = () => setOpen(false);

        const choose = (entry: GuideSearchEntry) => {
            props.onSelect?.(entry);
            close();
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                selected.value = Math.min(results.value.length - 1, selected.value + 1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                selected.value = Math.max(0, selected.value - 1);
            } else if (event.key === "Enter") {
                const entry = results.value[selected.value];
                if (entry) choose(entry);
            } else if (event.key === "Escape") {
                close();
            }
        };

        return () => (
            <VDialog
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => setOpen(value)}
                maxWidth="820px"
                scrollable
                transition="dialog-top-transition"
            >
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                        <VTextField
                            modelValue={query.value}
                            onUpdate:modelValue={(value: string) => {
                                query.value = value ?? "";
                                selected.value = 0;
                            }}
                            label={isArabic() ? "ابحث في كل الكتب والقاموس والأخطاء والسيناريوهات" : "Search every book, glossary term, error code, runbook, and edge case"}
                            prependInnerIcon="mdi-magnify"
                            autofocus
                            clearable
                            hideDetails
                            onKeydown={onKeydown}
                        />
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                {`${results.value.length} ${isArabic() ? "نتيجة" : "results"}`}
                            </ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center" }}>
                                <StatusChip label="Ctrl / Cmd + K" tone="neutral" size="x-small" />
                                <StatusChip label="↑ ↓" tone="neutral" size="x-small" />
                                <StatusChip label="Enter" tone="neutral" size="x-small" />
                                <StatusChip label="Esc" tone="neutral" size="x-small" />
                            </ThemedView>
                        </ThemedView>
                        <div style={{ maxHeight: "62vh", overflowY: "auto" }}>
                            <VList density="compact">
                                {results.value.map((entry, index) => (
                                    <VListItem
                                        key={entry.id}
                                        active={index === selected.value}
                                        onClick={() => choose(entry)}
                                        onMouseEnter={() => (selected.value = index)}
                                    >
                                        <ThemedView style={{ gap: "4px" }}>
                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                <VChip size="x-small" color={KIND_TONE[entry.kind] ?? "primary"} variant="tonal">
                                                    {entry.kind}
                                                </VChip>
                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                                    {isArabic() ? entry.titleAr : entry.titleEn}
                                                </ThemedText>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.72, lineHeight: 1.5 }}>
                                                {(isArabic() && entry.bodyAr ? entry.bodyAr : entry.bodyEn).replace(/\s+/g, " ").slice(0, 190)}
                                            </ThemedText>
                                        </ThemedView>
                                    </VListItem>
                                ))}
                                {results.value.length === 0 ? (
                                    <VListItem>
                                        <ThemedText style={{ opacity: 0.7 }}>
                                            {isArabic() ? "لا نتائج. جرّب UNKNOWN أو GATEWAY_CLEARING أو RB-03 أو EC-126." : "No results. Try UNKNOWN, GATEWAY_CLEARING, RB-03, or EC-126."}
                                        </ThemedText>
                                    </VListItem>
                                ) : null}
                            </VList>
                        </div>
                    </VCardText>
                </VCard>
            </VDialog>
        );
    },
    { props: ["modelValue", "onUpdate:modelValue", "onSelect"] as any },
);

export default GlobalGuideSearchModal;
