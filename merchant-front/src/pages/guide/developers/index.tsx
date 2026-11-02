import { dc } from "kt-dc";
import { computed, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { GuideCodeBlock } from "@/components/guide/GuideCodeBlock";
import { MERCHANT_DEVELOPER_CHAPTERS } from "@/content/guide/merchantDeveloperApiGuide";
import type { DeveloperCodeLanguage } from "@/content/guide/types";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MetaPill } from "@/components/ui/MetaPill";

const LANGUAGES: { value: DeveloperCodeLanguage; label: string }[] = [
    { value: "typescript", label: "TypeScript / Node / Bun" },
    { value: "php", label: "PHP (Laravel)" },
    { value: "python", label: "Python (httpx)" },
    { value: "curl", label: "cURL" },
];

const MerchantDeveloperGuidePage = dc(() => {
    const { current, t } = useLocale();
    const route = useRoute();
    const isArabic = computed(() => current.value === "ar");
    const selectedId = ref(MERCHANT_DEVELOPER_CHAPTERS[0]?.id ?? "D-01");
    const language = ref<DeveloperCodeLanguage>("typescript");
    const selected = computed(() => MERCHANT_DEVELOPER_CHAPTERS.find((chapter) => chapter.id === selectedId.value) ?? MERCHANT_DEVELOPER_CHAPTERS[0]);

    const applyRouteQuery = () => {
        const chapterId = typeof route.query.chapter === "string" ? route.query.chapter : "";
        if (chapterId && MERCHANT_DEVELOPER_CHAPTERS.some((chapter) => chapter.id === chapterId)) {
            selectedId.value = chapterId;
        }
    };

    watch(() => route.query, () => applyRouteQuery(), { deep: true, immediate: true });

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "16px" }}>
                <PageHeader
                    title={isArabic.value ? "دليل المطوّر وواجهة API" : "Developer & API Integration Guide"}
                    subtitle={isArabic.value ? "التكامل الآمن وواجهات API وأمثلة الشيفرة." : "Secure integration patterns, API reference, and code examples."}
                />
                <SurfaceCard>
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>
                            {isArabic.value
                                ? "مرجع كامل من الصفر إلى الإنتاج: المصادقة، دقة المبالغ، نقاط النهاية، والـ webhooks."
                                : "A complete zero-to-production reference: authentication, money precision, endpoints, and webhooks."}
                        </ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {MERCHANT_DEVELOPER_CHAPTERS.map((chapter) => (
                                <MetaPill
                                    key={chapter.id}
                                    color={selectedId.value === chapter.id ? "primary" : undefined}
                                    variant={selectedId.value === chapter.id ? "flat" : "tonal"}
                                    onClick={() => (selectedId.value = chapter.id)}
                                    style={{ cursor: "pointer" }}
                                >
                                    {`${chapter.id} · ${isArabic.value && chapter.titleAr ? chapter.titleAr : chapter.titleEn}`}
                                </MetaPill>
                            ))}
                        </ThemedView>
                    </SurfaceCardText>
                </SurfaceCard>

                {selected.value ? (
                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <StatusBadge status={selected.value.id} label={selected.value.id} toneOverride="info" showDot={false} />
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>
                                    {isArabic.value && selected.value.titleAr ? selected.value.titleAr : selected.value.titleEn}
                                </ThemedText>
                            </ThemedView>
                            <GuideMarkdown source={isArabic.value && selected.value.bodyAr ? selected.value.bodyAr : selected.value.bodyEn} />
                            {selected.value.codeTemplates ? (
                                <ThemedView style={{ gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{isArabic.value ? "قوالب كود جاهزة للتشغيل" : "Ready-to-run code templates"}</ThemedText>
                                    <SegmentedTabs
                                        modelValue={language.value}
                                        tabs={LANGUAGES}
                                        ariaLabel={isArabic.value ? "لغة الشيفرة" : "Code language"}
                                        onUpdate:modelValue={(value: string) => (language.value = value as DeveloperCodeLanguage)}
                                    />
                                    <GuideCodeBlock code={selected.value?.codeTemplates?.[language.value] ?? ""} />
                                </ThemedView>
                            ) : null}
                        </SurfaceCardText>
                    </SurfaceCard>
                ) : null}
            </ThemedView>
        </ScreenContainer>
    );
});

export default MerchantDeveloperGuidePage;
