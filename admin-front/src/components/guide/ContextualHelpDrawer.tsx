import { dc } from "kt-dc";
import { computed } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VNavigationDrawer } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { findBookByNumber, findChapter, GUIDE_ROUTE_HELP } from "@/content/guide";

type ContextualHelpDrawerProps = {
    modelValue: boolean;
    routeName?: string;
    "onUpdate:modelValue"?: (value: boolean) => void;
    onOpenFullGuide?: () => void;
};

export const ContextualHelpDrawer = dc(
    (props: ContextualHelpDrawerProps) => {
        const { current } = useLocale();
        const isArabic = () => current.value === "ar";
        const setOpen = (value: boolean) => props["onUpdate:modelValue"]?.(value);

        const mapping = computed(() => (props.routeName ? GUIDE_ROUTE_HELP[props.routeName] : undefined));
        const book = computed(() => (mapping.value ? findBookByNumber(mapping.value.bookNumber) : undefined));
        const chapter = computed(() => {
            if (!mapping.value) return undefined;
            if (mapping.value.chapterNumber) {
                return findChapter(mapping.value.bookNumber, mapping.value.chapterNumber);
            }
            return book.value?.chapters[0];
        });

        return () => (
            <VNavigationDrawer
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => setOpen(value)}
                location="end"
                temporary
                width={560}
            >
                <ThemedView style={{ padding: "20px", gap: "14px", height: "100%", overflowY: "auto" }}>
                    <ThemedView style={{ flexDirection: "row", alignItems: "flex-start", gap: "8px" }}>
                        <VBtn icon="mdi-close" variant="text" aria-label={isArabic() ? "إغلاق" : "Close"} onClick={() => setOpen(false)} />
                        <ThemedView style={{ flex: 1, gap: "6px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <StatusChip label={isArabic() ? "المساعدة وإجراءات التشغيل" : "Help & SOP"} tone="primary" size="x-small" />
                                {book.value ? <StatusChip label={`Book ${book.value.number}`} tone="info" size="x-small" /> : null}
                                {chapter.value ? <StatusChip label={chapter.value.number} tone="neutral" size="x-small" /> : null}
                            </ThemedView>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "19px", lineHeight: 1.3 }}>
                                {mapping.value?.titleEn ?? (isArabic() ? "الدليل التشغيلي" : "Operational guide")}
                            </ThemedText>
                            {book.value ? (
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                    {isArabic() ? book.value.titleAr : book.value.titleEn}
                                </ThemedText>
                            ) : null}
                        </ThemedView>
                    </ThemedView>

                    {chapter.value ? (
                        <>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>
                                {isArabic() ? chapter.value.titleAr ?? chapter.value.titleEn : chapter.value.titleEn}
                            </ThemedText>
                            <GuideMarkdown source={isArabic() && chapter.value.bodyAr ? chapter.value.bodyAr : chapter.value.bodyEn} compact />
                        </>
                    ) : (
                        <ThemedText style={{ opacity: 0.7 }}>
                            {isArabic()
                                ? "لا يوجد فصل مرتبط بهذه الشاشة بعد. استخدم البحث Ctrl+K للوصول إلى كل الكتب."
                                : "No chapter is mapped to this screen yet. Use Ctrl+K to search every book."}
                        </ThemedText>
                    )}

                    {book.value && book.value.sopChecklist.length > 0 ? (
                        <VCard variant="outlined">
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <ThemedText type="defaultSemiBold">{isArabic() ? "قائمة SOP لهذا الكتاب" : "Book SOP checklist"}</ThemedText>
                                <ol style={{ margin: 0, paddingInlineStart: "22px", lineHeight: 1.7, fontSize: "13px" }}>
                                    {book.value.sopChecklist.map((step, index) => (
                                        <li key={`sop-${index}`}>{step}</li>
                                    ))}
                                </ol>
                            </VCardText>
                        </VCard>
                    ) : null}

                    {book.value && book.value.humanErrorWarning ? (
                        <div
                            style={{
                                padding: "12px 14px",
                                borderRadius: "10px",
                                background: "rgba(239,68,68,0.08)",
                                borderInlineStart: "5px solid #ef4444",
                                whiteSpace: "pre-wrap",
                                fontSize: "13px",
                                lineHeight: 1.65,
                            }}
                        >
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px", marginBottom: "4px" }}>
                                {isArabic() ? "تحذير خطأ بشري حرج" : "CRITICAL HUMAN ERROR WARNING"}
                            </ThemedText>
                            {book.value.humanErrorWarning}
                        </div>
                    ) : null}

                    <VBtn variant="tonal" prependIcon="mdi-book-open-variant" onClick={() => props.onOpenFullGuide?.()}>
                        {isArabic() ? "فتح الدليل الكامل" : "Open the full guide"}
                    </VBtn>
                    <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>
                        {isArabic()
                            ? "هذا الدرج لا يغلق النموذج أو يعيد تعيينه. يمكنك القراءة ثم العودة إلى العمل."
                            : "This drawer never closes or resets the form you are working on. Read, then return to work."}
                    </ThemedText>
                </ThemedView>
            </VNavigationDrawer>
        );
    },
    { props: ["modelValue", "routeName", "onUpdate:modelValue", "onOpenFullGuide"] as any },
);

export default ContextualHelpDrawer;
