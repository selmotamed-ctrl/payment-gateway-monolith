import { computed, defineComponent, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import { AcademyShell, Skeleton } from "@/components/academy/AcademyShell";
import { Callout } from "@/components/academy/ui/Callout";
import { MarkdownView } from "@/components/guide/MarkdownView";
import { MetaPill } from "@/components/ui/MetaPill";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { loadDrills, loadPages, type AcademyPage, type Drill } from "@/content/academy";

const PAGE_IDS = ["page-how-it-works", "page-scoring", "page-integrity", "page-learner-faq", "page-trainer"];
const DEFAULT_PAGE_ID = "page-how-it-works";

export const AdminAcademyHelpPage = defineComponent({
    name: "AdminAcademyHelpPage",
    setup() {
        const { t } = useLocale();
        const pages = ref<AcademyPage[]>([]);
        const drills = ref<Drill[]>([]);
        const ready = ref(false);
        const failed = ref(false);
        const selectedId = ref(DEFAULT_PAGE_ID);
        onMounted(async () => {
            try {
                [pages.value, drills.value] = await Promise.all([loadPages(), loadDrills()]);
                ready.value = true;
            } catch {
                failed.value = true;
            }
        });
        const shown = computed(() => PAGE_IDS.map((id) => pages.value.find((p) => p.id === id)).filter((p): p is AcademyPage => Boolean(p)));
        const current = computed(() => shown.value.find((p) => p.id === selectedId.value) ?? shown.value[0]);

        const header = () => <PageHeader title={t("Help")} subtitle={t("How the Academy works, how scoring works, and common questions.")} />;

        const rail = () => (
            <nav class="ac-help__rail" aria-label={t("Help topics")}>
                <p class="ac-eyebrow ac-help__eyebrow">{t("Help topics")}</p>
                <ul class="ac-help__list">
                    {shown.value.map((page) => {
                        const on = page.id === current.value?.id;
                        return (
                            <li key={page.id}>
                                <button
                                    type="button"
                                    class={["ac-help__link", on ? "ac-help__link--on" : ""]}
                                    aria-current={on ? "true" : undefined}
                                    onClick={() => (selectedId.value = page.id)}
                                >
                                    {page.title}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </nav>
        );

        const drillsSection = () => (
            <section class="ac-stack ac-stack--sm" aria-labelledby="ac-help-drills-h">
                <h2 id="ac-help-drills-h" class="ac-h2">
                    {t("Optional live drills")}
                </h2>
                <Callout tone="warning">{t("Staging only — trainer-led")}</Callout>
                <div class="ac-grid ac-help-drills" style="--ac-min:360px">
                    {drills.value.map((drill) => (
                        <details key={drill.id} class="ac-card ac-help-drill">
                            <summary class="ac-help-drill__summary">
                                <span class="ac-help-drill__title" dir="auto">
                                    {drill.title}
                                </span>
                                <MetaPill size="x-small" prependIcon="mdi-clock-outline">
                                    <span class="ac-num">
                                        {drill.minutes} {t("min")}
                                    </span>
                                </MetaPill>
                                <VIcon class="ac-help-drill__chev" icon="mdi-chevron-down" size={20} aria-hidden="true" />
                            </summary>
                            <div class="ac-help-drill__body" dir="auto">
                                <MarkdownView source={drill.markdown} compact />
                            </div>
                        </details>
                    ))}
                </div>
            </section>
        );

        return () => (
            <AcademyShell header={header}>
                {failed.value ? (
                    <Callout tone="danger">{t("The Academy content could not be loaded. Reload the page.")}</Callout>
                ) : !ready.value ? (
                    <Skeleton rows={4} />
                ) : (
                    <div class="ac-help">
                        {rail()}
                        <div class="ac-help__main ac-stack ac-stack--lg">
                            {current.value && (
                                <SurfaceCard class="ac-card" title={current.value.title}>
                                    <div class="ac-prose" dir="auto">
                                        <MarkdownView key={current.value.id} source={current.value.markdown} />
                                    </div>
                                </SurfaceCard>
                            )}
                            {drills.value.length > 0 && drillsSection()}
                        </div>
                    </div>
                )}
            </AcademyShell>
        );
    },
});

export default AdminAcademyHelpPage;
