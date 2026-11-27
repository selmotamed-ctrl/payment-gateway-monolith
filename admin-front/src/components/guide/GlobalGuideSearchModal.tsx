import { dc } from "@/utils/dc";
import { computed, nextTick, ref, watch } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {PgCard, PgCardText, PgChip, PgDialog, PgList, PgListItem, PgStack, PgTextField} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {StatusChip} from "@pg/ui";
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

const INPUT_ID = "pg-global-guide-search-input";
const HANDLED_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]);

export const GlobalGuideSearchModal = dc(
    (props: GlobalGuideSearchModalProps) => {
        const { current } = useLocale();
        const query = ref("");
        const selected = ref(0);
        const isArabic = () => current.value === "ar";

        const results = computed(() => searchGuide(query.value, 60));
        const setOpen = (value: boolean) => props["onUpdate:modelValue"]?.(value);
        const close = () => setOpen(false);

        const choose = (entry: GuideSearchEntry | undefined) => {
            if (!entry) return;
            props.onSelect?.(entry);
            close();
        };

        watch(
            () => props.modelValue,
            (open) => {
                if (!open) return;
                query.value = "";
                selected.value = 0;
                void nextTick(() => document.getElementById(INPUT_ID)?.focus());
            },
        );

        watch(results, () => {
            if (selected.value >= results.value.length) {
                selected.value = Math.max(0, results.value.length - 1);
            }
        });

        const move = (delta: number) => {
            if (results.value.length === 0) return;
            selected.value = (selected.value + delta + results.value.length) % results.value.length;
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            // Printable keys only reach the input; an IME commit (Arabic)
            // must not be treated as Enter.
            if (event.isComposing || event.keyCode === 229) return;
            if (
                event.key.length === 1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
            ) {
                return;
            }
            if (!HANDLED_KEYS.has(event.key)) return;

            if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
            } else if (event.key === "Home") {
                event.preventDefault();
                selected.value = 0;
            } else if (event.key === "End") {
                event.preventDefault();
                selected.value = Math.max(0, results.value.length - 1);
            } else if (event.key === "Enter") {
                event.preventDefault();
                choose(results.value[selected.value]);
            } else if (event.key === "Escape") {
                event.preventDefault();
                close();
            }
        };

        return () => (
            <PgDialog
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => setOpen(value)}
                title={isArabic() ? "ابحث في الدليل" : "Search the guide"}
                maxWidth="820px"
                scrollable
                transition="dialog-top-transition"
            >
                <PgCard>
                    <PgCardText>
                        <PgStack>
                            <PgTextField
                                id={INPUT_ID}
                                modelValue={query.value}
                                onUpdate:modelValue={(value: string) => {
                                    query.value = value ?? "";
                                    selected.value = 0;
                                }}
                                label={isArabic() ? "ابحث في كل الكتب والقاموس والأخطاء والسيناريوهات" : "Search every book, glossary term, error code, runbook, and edge case"}
                                aria-label={isArabic() ? "ابحث في كل الكتب والقاموس والأخطاء والسيناريوهات" : "Search every book, glossary term, error code, runbook, and edge case"}
                                prependInnerIcon="mdi-magnify"
                                autofocus
                                clearable
                                hideDetails
                                role="combobox"
                                aria-expanded={props.modelValue ? "true" : "false"}
                                aria-controls="pg-global-guide-search-listbox"
                                aria-autocomplete="list"
                                aria-activedescendant={
                                    results.value[selected.value]
                                        ? `pg-global-guide-search-${selected.value}`
                                        : undefined
                                }
                                onKeydown={onKeydown}
                            />
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                    {`${results.value.length} ${isArabic() ? "نتيجة" : "results"}`}
                                </ThemedText>
                                <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center" }}>
                                    <StatusChip label="↑ ↓" tone="neutral" size="x-small" />
                                    <StatusChip label="Enter" tone="neutral" size="x-small" />
                                    <StatusChip label="Esc" tone="neutral" size="x-small" />
                                </ThemedView>
                            </ThemedView>
                            <div
                                id="pg-global-guide-search-listbox"
                                role="listbox"
                                aria-label={isArabic() ? "نتائج البحث في الدليل" : "Guide search results"}
                                style={{ maxHeight: "62vh", overflowY: "auto" }}
                            >
                                <PgList density="compact">
                                    {results.value.map((entry, index) => (
                                        <div key={entry.id} onMouseenter={() => (selected.value = index)}>
                                            <PgListItem
                                                id={`pg-global-guide-search-${index}`}
                                                role="option"
                                                class={index === selected.value ? "pg-list-item--active" : ""}
                                                onClick={() => choose(entry)}
                                            >
                                                <ThemedView style={{ gap: "4px" }}>
                                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                        <PgChip size="x-small" color={KIND_TONE[entry.kind] ?? "primary"} variant="tonal">
                                                            {entry.kind}
                                                        </PgChip>
                                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                                            {isArabic() ? entry.titleAr : entry.titleEn}
                                                        </ThemedText>
                                                    </ThemedView>
                                                    <ThemedText style={{ fontSize: "12px", opacity: 0.72, lineHeight: 1.5 }}>
                                                        {(isArabic() && entry.bodyAr ? entry.bodyAr : entry.bodyEn).replace(/\s+/g, " ").slice(0, 190)}
                                                    </ThemedText>
                                                </ThemedView>
                                            </PgListItem>
                                        </div>
                                    ))}
                                    {results.value.length === 0 ? (
                                        <PgListItem>
                                            <ThemedText style={{ opacity: 0.7 }}>
                                                {isArabic() ? "لا نتائج. جرّب UNKNOWN أو GATEWAY_CLEARING أو RB-03 أو EC-126." : "No results. Try UNKNOWN, GATEWAY_CLEARING, RB-03, or EC-126."}
                                            </ThemedText>
                                        </PgListItem>
                                    ) : null}
                                </PgList>
                            </div>
                        </PgStack>
                    </PgCardText>
                </PgCard>
            </PgDialog>
        );
    },
    { props: ["modelValue", "onUpdate:modelValue", "onSelect"] as any },
);

export default GlobalGuideSearchModal;
