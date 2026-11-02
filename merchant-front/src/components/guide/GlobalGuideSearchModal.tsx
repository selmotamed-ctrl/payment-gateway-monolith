import { computed, defineComponent, nextTick, ref, watch, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VList, VListItem, VTextField } from "vuetify/components";
import { FormModal } from "@/components/ui/FormModal";
import { MetaPill } from "@/components/ui/MetaPill";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MERCHANT_DEVELOPER_CHAPTERS } from "@/content/guide/merchantDeveloperApiGuide";
import { MERCHANT_OPERATIONS_CHAPTERS } from "@/content/guide/merchantOperationsGuide";
import type { MerchantChapterRole } from "@/content/guide/types";

export type MerchantGuideSearchEntry = {
    id: string;
    kind: "operations" | "developer";
    role: MerchantChapterRole | "DEVELOPER";
    routeName: "MerchantGuide" | "MerchantDeveloperGuide";
    titleEn: string;
    titleAr?: string;
    bodyEn: string;
    bodyAr?: string;
    tags: string[];
};

const GUIDE_INDEX: MerchantGuideSearchEntry[] = [
    ...MERCHANT_OPERATIONS_CHAPTERS.map((chapter) => ({
        id: chapter.id,
        kind: "operations" as const,
        role: chapter.role,
        routeName: "MerchantGuide" as const,
        titleEn: chapter.titleEn,
        titleAr: chapter.titleAr,
        bodyEn: chapter.bodyEn,
        bodyAr: chapter.bodyAr,
        tags: chapter.tags,
    })),
    ...MERCHANT_DEVELOPER_CHAPTERS.map((chapter) => ({
        id: chapter.id,
        kind: "developer" as const,
        role: "DEVELOPER" as const,
        routeName: "MerchantDeveloperGuide" as const,
        titleEn: chapter.titleEn,
        titleAr: chapter.titleAr,
        bodyEn: chapter.bodyEn,
        bodyAr: chapter.bodyAr,
        tags: chapter.tags,
    })),
];

const ROLE_LABELS: Record<string, string> = {
    MERCHANT_ADMIN: "Business Owner",
    MERCHANT_STAFF: "Manager / Accountant",
    MERCHANT_CASHIER: "In-Store Cashier",
    DEVELOPER: "Developer",
    ALL: "All roles",
};

const searchEntries = (query: string): MerchantGuideSearchEntry[] => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = terms.length
        ? GUIDE_INDEX.filter((entry) => {
              const haystack = [
                  entry.id,
                  entry.titleEn,
                  entry.titleAr ?? "",
                  entry.bodyEn,
                  entry.bodyAr ?? "",
                  entry.tags.join(" "),
              ]
                  .join(" ")
                  .toLowerCase();
              return terms.every((term) => haystack.includes(term));
          })
        : GUIDE_INDEX;
    return matches.slice(0, 40);
};

export const GlobalGuideSearchModal = defineComponent({
    name: "GlobalGuideSearchModal",
    props: {
        modelValue: { type: Boolean, required: true },
        onSelect: { type: Function as PropType<(entry: MerchantGuideSearchEntry) => void>, default: undefined },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { current } = useLocale();
        const query = ref("");
        const selected = ref(0);
        const inputId = "pg-guide-search-input";
        const isArabic = computed(() => current.value === "ar");
        const results = computed(() => searchEntries(query.value));

        watch(
            () => props.modelValue,
            (open) => {
                if (open) {
                    query.value = "";
                    selected.value = 0;
                    void nextTick(() => document.getElementById(inputId)?.focus());
                }
            },
        );

        watch(results, () => {
            selected.value = 0;
        });

        const close = () => emit("update:modelValue", false);
        const choose = (entry: MerchantGuideSearchEntry) => {
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
            }
        };

        const entryTitle = (entry: MerchantGuideSearchEntry): string =>
            isArabic.value && entry.titleAr ? entry.titleAr : entry.titleEn;
        const entryBody = (entry: MerchantGuideSearchEntry): string =>
            (isArabic.value && entry.bodyAr ? entry.bodyAr : entry.bodyEn).replace(/[#>*`|]/g, " ").replace(/\s+/g, " ").slice(0, 190);

        return (): VNodeChild => (
            <FormModal
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                title={isArabic.value ? "ابحث في دليل التاجر" : "Search the merchant guide"}
                subtitle={
                    isArabic.value
                        ? "ابحث في فصول التشغيل وواجهة API. استخدم الأسهم وEnter للفتح."
                        : "Search operations and API chapters. Use arrows and Enter to open."
                }
                size="lg"
            >
                <VTextField
                    id={inputId}
                    modelValue={query.value}
                    onUpdate:modelValue={(value: string | null) => (query.value = value ?? "")}
                    onKeydown={onKeydown}
                    placeholder={isArabic.value ? "ابحث بالعنوان أو الوسم أو النص" : "Search by title, tag, or body text"}
                    prependInnerIcon="mdi-magnify"
                    clearable
                    hideDetails
                />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                        {`${results.value.length} ${isArabic.value ? "نتيجة" : "results"}`}
                    </span>
                    <span style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <MetaPill size="x-small" variant="outlined">Ctrl / Cmd + K</MetaPill>
                        <MetaPill size="x-small" variant="outlined">↑ ↓</MetaPill>
                        <MetaPill size="x-small" variant="outlined">Enter</MetaPill>
                    </span>
                </div>
                <div style={{ maxHeight: "58vh", overflowY: "auto" }}>
                    <VList density="compact">
                        {results.value.map((entry, index) => (
                            <VListItem
                                key={entry.id}
                                active={index === selected.value}
                                onClick={() => choose(entry)}
                                onMouseEnter={() => (selected.value = index)}
                            >
                                <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <MetaPill size="x-small">{entry.id}</MetaPill>
                                        <StatusBadge
                                            status={entry.kind === "developer" ? "DEVELOPER" : entry.role}
                                            label={ROLE_LABELS[entry.kind === "developer" ? "DEVELOPER" : entry.role]}
                                            toneOverride={entry.kind === "developer" ? "info" : "neutral"}
                                            showDot={false}
                                        />
                                        <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--pg-ink-primary)" }}>
                                            {entryTitle(entry)}
                                        </span>
                                    </div>
                                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)", lineHeight: 1.5 }}>
                                        {entryBody(entry)}
                                    </span>
                                </div>
                            </VListItem>
                        ))}
                        {results.value.length === 0 && (
                            <VListItem>
                                <span style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                                    {isArabic.value
                                        ? "لا نتائج. جرّب KYB أو POS أو pg_live_ أو M-03."
                                        : "No results. Try KYB, POS, pg_live_, or M-03."}
                                </span>
                            </VListItem>
                        )}
                    </VList>
                </div>
            </FormModal>
        );
    },
});

export default GlobalGuideSearchModal;
