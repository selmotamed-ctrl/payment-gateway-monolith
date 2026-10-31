import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import {
    VBtn,
    VCard,
    VCardText,
    VChip,
    VTab,
    VTabs,
    VWindow,
    VWindowItem,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { MERCHANT_DEVELOPER_CHAPTERS } from "@/content/guide/merchantDeveloperApiGuide";
import type { DeveloperCodeLanguage } from "@/content/guide/types";
import { showSnackBar } from "@/utils/snackBar";

const LANGUAGES: { value: DeveloperCodeLanguage; label: string }[] = [
    { value: "typescript", label: "TypeScript / Node / Bun" },
    { value: "php", label: "PHP (Laravel)" },
    { value: "python", label: "Python (httpx)" },
    { value: "curl", label: "cURL" },
];

const codeStyle = {
    direction: "ltr" as const,
    textAlign: "left" as const,
    background: "rgba(100,116,139,0.12)",
    borderRadius: "10px",
    padding: "12px",
    overflowX: "auto" as const,
    fontSize: "12px",
    lineHeight: 1.6,
    margin: 0,
    whiteSpace: "pre" as const,
};

const MerchantDeveloperGuidePage = dc(() => {
    const { current, t } = useLocale();
    const isArabic = computed(() => current.value === "ar");
    const selectedId = ref(MERCHANT_DEVELOPER_CHAPTERS[0]?.id ?? "D-01");
    const language = ref<DeveloperCodeLanguage>("typescript");
    const selected = computed(() => MERCHANT_DEVELOPER_CHAPTERS.find((chapter) => chapter.id === selectedId.value) ?? MERCHANT_DEVELOPER_CHAPTERS[0]);

    const copy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            showSnackBar({ type: "success", message: t("Copied") });
        } catch {
            showSnackBar({ type: "error", message: t("Unable to copy") });
        }
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "16px" }}>
                <PageHeader title={isArabic.value ? "دليل المطوّر وواجهة API" : "Developer & API Integration Guide"} />
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.72 }}>
                            {isArabic.value
                                ? "مرجع كامل من الصفر إلى الإنتاج: المصادقة، دقة المبالغ، نقاط النهاية، والـ webhooks."
                                : "A complete zero-to-production reference: authentication, money precision, endpoints, and webhooks."}
                        </ThemedText>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {MERCHANT_DEVELOPER_CHAPTERS.map((chapter) => (
                                <VChip
                                    key={chapter.id}
                                    color={selectedId.value === chapter.id ? "primary" : undefined}
                                    variant={selectedId.value === chapter.id ? "flat" : "tonal"}
                                    onClick={() => (selectedId.value = chapter.id)}
                                    style={{ cursor: "pointer" }}
                                >
                                    {`${chapter.id} · ${isArabic.value && chapter.titleAr ? chapter.titleAr : chapter.titleEn}`}
                                </VChip>
                            ))}
                        </ThemedView>
                    </VCardText>
                </VCard>

                {selected.value ? (
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <StatusChip label={selected.value.id} tone="primary" />
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>
                                    {isArabic.value && selected.value.titleAr ? selected.value.titleAr : selected.value.titleEn}
                                </ThemedText>
                            </ThemedView>
                            <GuideMarkdown source={isArabic.value && selected.value.bodyAr ? selected.value.bodyAr : selected.value.bodyEn} />
                            {selected.value.codeTemplates ? (
                                <ThemedView style={{ gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{isArabic.value ? "قوالب كود جاهزة للتشغيل" : "Ready-to-run code templates"}</ThemedText>
                                    <VTabs modelValue={language.value} onUpdate:modelValue={(value: any) => (language.value = value)} density="compact">
                                        {LANGUAGES.map((entry) => (
                                            <VTab key={entry.value} value={entry.value}>{entry.label}</VTab>
                                        ))}
                                    </VTabs>
                                    <VWindow modelValue={language.value} onUpdate:modelValue={(value: any) => (language.value = value)}>
                                        {LANGUAGES.map((entry) => (
                                            <VWindowItem key={`window-${entry.value}`} value={entry.value}>
                                                <ThemedView style={{ gap: "8px" }}>
                                                    <VBtn size="small" variant="tonal" style={{ alignSelf: "flex-end" }} onClick={() => void copy(selected.value?.codeTemplates?.[entry.value] ?? "")}>
                                                        {isArabic.value ? "نسخ" : "Copy"}
                                                    </VBtn>
                                                    <pre style={codeStyle}>{selected.value?.codeTemplates?.[entry.value] ?? ""}</pre>
                                                </ThemedView>
                                            </VWindowItem>
                                        ))}
                                    </VWindow>
                                </ThemedView>
                            ) : null}
                        </VCardText>
                    </VCard>
                ) : null}
            </ThemedView>
        </ScreenContainer>
    );
});

export default MerchantDeveloperGuidePage;
