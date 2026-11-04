import { computed, defineComponent, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PageHeader } from "@/components/ui/PageHeader";
import ScreenContainer from "@/components/ScreenContainer";
import { MarkdownView } from "@/components/guide/MarkdownView";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import { loadCards, type Card } from "@/content/guide";
import { normalizeArabicText } from "@/utils/arabic";

export const AdminGuideCardsPage = defineComponent({
    name: "AdminGuideCardsPage",
    setup() {
        const route = useRoute();
        const { L } = useGuideLocale();
        const cards = ref<Card[]>([]);
        const loading = ref(true);
        const query = ref("");
        const risk = ref("");

        onMounted(async () => {
            cards.value = await loadCards().catch(() => []);
            loading.value = false;
        });

        const filtered = computed(() => {
            const needle = normalizeArabicText(query.value);
            return cards.value.filter((card) => {
                if (risk.value && card.risk !== risk.value) return false;
                if (!needle) return true;
                return normalizeArabicText(`${card.title} ${card.screen} ${card.body}`).includes(needle);
            });
        });

        const selectedId = computed(() => String(route.params.id ?? ""));
        const selected = computed(() => cards.value.find((card) => card.id === selectedId.value));

        return () => (
            <ScreenContainer>
                <PageHeader
                    title={L("Safeguard cards", "بطاقات السلامة")}
                    subtitle={L(
                        "The checklist to read at the moment of a risky action. Every box must be ticked before the action.",
                        "قائمة التحقق التي تُقرأ عند إجراء خطير. يجب تحديد كل صندوق قبل الإجراء.",
                    )}
                    breadcrumbs={[{ label: L("Guide", "الدليل"), to: "/guide" }, { label: L("Safeguard cards", "بطاقات السلامة") }]}
                />
                {loading.value ? (
                    <p class="guide-page-loading">{L("Loading cards…", "جارٍ تحميل البطاقات…")}</p>
                ) : (
                    <div class="guide-cards-page">
                        <div class="guide-cards-tools">
                            <input
                                type="search"
                                value={query.value}
                                placeholder={L("Search cards…", "ابحث في البطاقات…")}
                                aria-label={L("Search cards", "البحث في البطاقات")}
                                onInput={(event) => (query.value = (event.target as HTMLInputElement).value)}
                            />
                            <select value={risk.value} onChange={(event) => (risk.value = (event.target as HTMLSelectElement).value)}>
                                <option value="">{L("All risk levels", "كل مستويات الخطورة")}</option>
                                {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((level) => (
                                    <option key={level} value={level}>{level}</option>
                                ))}
                            </select>
                        </div>
                        <div class="guide-cards-layout">
                            <ul class="guide-card-list">
                                {filtered.value.map((card) => (
                                    <li key={card.id} class={card.id === selectedId.value ? "is-active" : ""}>
                                        <RouterLink to={{ name: "AdminGuideCards", params: { id: card.id } }}>
                                            <span class={`guide-risk-dot guide-risk-${card.risk.toLowerCase()}`} aria-hidden="true" />
                                            <span>
                                                <strong>{card.title}</strong>
                                                <small>{card.screen} · {card.risk}{card.irreversible ? ` · ${L("irreversible", "غير قابل للتراجع")}` : ""}</small>
                                            </span>
                                        </RouterLink>
                                    </li>
                                ))}
                            </ul>
                            <article class="guide-card-detail" aria-live="polite">
                                {selected.value ? (
                                    <>
                                        <div class="guide-card-detail__header">
                                            <div>
                                                <p class="guide-eyebrow">{selected.value.screen}</p>
                                                <h2>{selected.value.title}</h2>
                                            </div>
                                            <span class={`guide-risk-badge guide-risk-${selected.value.risk.toLowerCase()}`}>
                                                {selected.value.risk}
                                            </span>
                                        </div>
                                        <MarkdownView source={selected.value.body} />
                                    </>
                                ) : (
                                    <div class="guide-empty">
                                        <p>{L("Choose a card to read the four sections.", "اختر بطاقة لقراءة الأقسام الأربعة.")}</p>
                                    </div>
                                )}
                            </article>
                        </div>
                    </div>
                )}
            </ScreenContainer>
        );
    },
});

export default AdminGuideCardsPage;
