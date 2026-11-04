import { computed, defineComponent } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PageHeader } from "@/components/ui/PageHeader";
import ScreenContainer from "@/components/ScreenContainer";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import { TransformSandbox } from "@/components/guide/widgets/TransformSandbox";
import { CryptoLab } from "@/components/guide/widgets/CryptoLab";
import { LedgerExplorer } from "@/components/guide/widgets/LedgerExplorer";
import { VisibleRailsExplainer } from "@/components/guide/widgets/VisibleRailsExplainer";
import { AttemptStateExplorer } from "@/components/guide/widgets/AttemptStateExplorer";

const TOOLS = [
    {
        id: "transform-sandbox",
        title: "Transform pipeline",
        titleAr: "مسار التحويل",
        description: "Amounts, phone numbers, masks and hashes, one operation at a time.",
        component: TransformSandbox,
    },
    {
        id: "crypto-lab",
        title: "Signature lab",
        titleAr: "مختبر التوقيع",
        description: "Show the exact canonical string and compare an HMAC-SHA256 signature.",
        component: CryptoLab,
    },
    {
        id: "ledger-explorer",
        title: "Ledger explorer",
        titleAr: "مستكشف دفتر الأستاذ",
        description: "Read the 16 worked journal events as T-accounts.",
        component: LedgerExplorer,
    },
    {
        id: "visible-rails",
        title: "Visible rails",
        titleAr: "الوسائل الظاهرة",
        description: "Find the first of the nine predicates that hides a payment method.",
        component: VisibleRailsExplainer,
    },
    {
        id: "attempt-states",
        title: "Payment states",
        titleAr: "حالات الدفع",
        description: "Walk the teaching transition table, including UNKNOWN and late success.",
        component: AttemptStateExplorer,
    },
];

export const AdminGuideToolsPage = defineComponent({
    name: "AdminGuideToolsPage",
    setup() {
        const route = useRoute();
        const { L, isArabic } = useGuideLocale();
        const selectedId = computed(() => String(route.params.tool ?? ""));
        const selected = computed(() => TOOLS.find((tool) => tool.id === selectedId.value));
        const SelectedComponent = computed(() => selected.value?.component);

        return () => (
            <ScreenContainer>
                <PageHeader
                    title={L("Tools and simulators", "الأدوات والمحاكيات")}
                    subtitle={L(
                        "Safe, client-only teaching tools. They are not connected to any real system.",
                        "أدوات تعليمية آمنة تعمل في المتصفح فقط. غير متصلة بأي نظام حقيقي.",
                    )}
                    breadcrumbs={[{ label: L("Guide", "الدليل"), to: "/guide" }, { label: L("Tools", "الأدوات") }]}
                />
                <div class="guide-tools-page">
                    <nav class="guide-tool-picker" aria-label={L("Choose a tool", "اختر أداة")}>
                        {TOOLS.map((tool) => (
                            <RouterLink
                                key={tool.id}
                                class={selectedId.value === tool.id ? "is-active" : ""}
                                to={{ name: "AdminGuideTools", params: { tool: tool.id } }}
                            >
                                <strong>{isArabic.value ? tool.titleAr : tool.title}</strong>
                                <span>{tool.description}</span>
                            </RouterLink>
                        ))}
                    </nav>
                    <div class="guide-tool-stage">
                        {SelectedComponent.value ? (
                            <SelectedComponent.value />
                        ) : (
                            <section class="guide-empty">
                                <h2>{L("Choose a simulator", "اختر محاكياً")}</h2>
                                <p>
                                    {L(
                                        "Each tool opens with example data, a Reset button, and an explanation of the result.",
                                        "تفتح كل أداة ببيانات مثال وزر إعادة تعيين وشرح للنتيجة.",
                                    )}
                                </p>
                            </section>
                        )}
                    </div>
                </div>
            </ScreenContainer>
        );
    },
});

export default AdminGuideToolsPage;
