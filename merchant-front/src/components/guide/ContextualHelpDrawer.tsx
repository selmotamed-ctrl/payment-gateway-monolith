import { computed, defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { MetaPill } from "@/components/ui/MetaPill";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { MERCHANT_DEVELOPER_CHAPTERS } from "@/content/guide/merchantDeveloperApiGuide";
import { MERCHANT_OPERATIONS_CHAPTERS } from "@/content/guide/merchantOperationsGuide";

type HelpChapter = {
    id: string;
    role: string;
    titleEn: string;
    titleAr?: string;
    bodyEn: string;
    bodyAr?: string;
    developer: boolean;
};

const ROUTE_HELP: Record<string, string> = {
    Dashboard: "M-02",
    Onboarding: "M-01",
    Wallets: "M-07",
    Statements: "M-07",
    Cashouts: "M-07",
    Links: "M-03",
    Applications: "M-02",
    PosTerminals: "M-05",
    PosScreen: "M-05",
    Payments: "M-06",
    Disputes: "M-08",
    DeveloperTokens: "D-02",
    Credentials: "M-09",
    Team: "M-10",
    MerchantGuide: "M-01",
    MerchantDeveloperGuide: "D-01",
};

const CHAPTERS: HelpChapter[] = [
    ...MERCHANT_OPERATIONS_CHAPTERS.map((chapter) => ({
        id: chapter.id,
        role: chapter.role,
        titleEn: chapter.titleEn,
        titleAr: chapter.titleAr,
        bodyEn: chapter.bodyEn,
        bodyAr: chapter.bodyAr,
        developer: false,
    })),
    ...MERCHANT_DEVELOPER_CHAPTERS.map((chapter) => ({
        id: chapter.id,
        role: "DEVELOPER",
        titleEn: chapter.titleEn,
        titleAr: chapter.titleAr,
        bodyEn: chapter.bodyEn,
        bodyAr: chapter.bodyAr,
        developer: true,
    })),
];

const ROLE_LABELS: Record<string, string> = {
    MERCHANT_ADMIN: "Business Owner",
    MERCHANT_STAFF: "Manager / Accountant",
    MERCHANT_CASHIER: "In-Store Cashier",
    DEVELOPER: "Developer",
    ALL: "All roles",
};

export const ContextualHelpDrawer = defineComponent({
    name: "ContextualHelpDrawer",
    props: {
        modelValue: { type: Boolean, required: true },
        routeName: { type: String, default: "" },
        onOpenFullGuide: { type: Function as PropType<() => void>, default: undefined },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const { current } = useLocale();
        const isArabic = computed(() => current.value === "ar");
        const chapter = computed<HelpChapter | undefined>(() => {
            const id = ROUTE_HELP[props.routeName];
            return id ? CHAPTERS.find((entry) => entry.id === id) : undefined;
        });
        const title = computed(() => {
            if (!chapter.value) return "";
            return isArabic.value && chapter.value.titleAr ? chapter.value.titleAr : chapter.value.titleEn;
        });
        const body = computed(() => {
            if (!chapter.value) return "";
            return isArabic.value && chapter.value.bodyAr ? chapter.value.bodyAr : chapter.value.bodyEn;
        });

        return (): VNodeChild => (
            <SlideOverDrawer
                modelValue={props.modelValue}
                onUpdate:modelValue={(value: boolean) => emit("update:modelValue", value)}
                title={isArabic.value ? "إجراءات التشغيل والمساعدة" : "Help & SOP"}
                subtitle={title.value}
                v-slots={{
                    footer: () => (
                        <VBtn
                            variant="tonal"
                            prependIcon="mdi-book-open-variant"
                            onClick={() => props.onOpenFullGuide?.()}
                        >
                            {isArabic.value ? "فتح الدليل الكامل" : "Open the full guide"}
                        </VBtn>
                    ),
                }}
            >
                {chapter.value ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                            <StatusBadge status={chapter.value.id} label={chapter.value.id} toneOverride="info" showDot={false} />
                            <MetaPill size="x-small">{ROLE_LABELS[chapter.value.role] ?? chapter.value.role}</MetaPill>
                            <MetaPill size="x-small" variant="outlined">
                                {chapter.value.developer ? (isArabic.value ? "دليل المطوّر" : "Developer guide") : isArabic.value ? "دليل التشغيل" : "Operations guide"}
                            </MetaPill>
                        </div>
                        <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "var(--pg-ink-primary)", lineHeight: 1.4 }}>
                            {title.value}
                        </h2>
                        <GuideMarkdown source={body.value} compact />
                    </div>
                ) : (
                    <p style={{ margin: 0, fontSize: "13px", color: "var(--pg-ink-muted)", lineHeight: 1.6 }}>
                        {isArabic.value
                            ? "لا يوجد فصل مرتبط بهذه الشاشة بعد. استخدم البحث Ctrl+K للوصول إلى كل الفصول."
                            : "No chapter is mapped to this screen yet. Use Ctrl+K to search every chapter."}
                    </p>
                )}
            </SlideOverDrawer>
        );
    },
});

export default ContextualHelpDrawer;
