import { computed, defineComponent, onMounted, ref } from "vue";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton } from "@/components/academy/AcademyShell";
import { MarkdownView } from "@/components/guide/MarkdownView";
import { loadDrills, loadPages, type AcademyPage, type Drill } from "@/content/academy";

const PAGE_IDS = ["page-how-it-works", "page-scoring", "page-integrity", "page-learner-faq", "page-trainer"];

export const AdminAcademyHelpPage = defineComponent({
    name: "AdminAcademyHelpPage",
    setup() {
        const { t } = useLocale();
        const pages = ref<AcademyPage[]>([]);
        const drills = ref<Drill[]>([]);
        const ready = ref(false);
        const failed = ref(false);
        onMounted(async () => {
            try {
                [pages.value, drills.value] = await Promise.all([loadPages(), loadDrills()]);
                ready.value = true;
            } catch {
                failed.value = true;
            }
        });
        const shown = computed(() => PAGE_IDS.map((id) => pages.value.find((p) => p.id === id)).filter((p): p is AcademyPage => Boolean(p)));

        return () => (
            <AcademyShell title={t("Help")} subtitle={t("How the Academy works, how scoring works, and common questions.")}>
                {failed.value ? (
                    <p class="ac-card">{t("The Academy content could not be loaded. Reload the page.")}</p>
                ) : !ready.value ? (
                    <Skeleton rows={4} />
                ) : (
                    <>
                        {shown.value.map((page) => (
                            <details key={page.id} class="ac-card ac-details" open={page.id === "page-how-it-works"}>
                                <summary>{page.title}</summary>
                                <MarkdownView source={page.markdown} compact />
                            </details>
                        ))}
                        {drills.value.length > 0 && (
                            <section class="ac-card" aria-labelledby="ac-drills-h">
                                <h2 id="ac-drills-h" class="ac-h2">{t("Optional live drills")}</h2>
                                <p class="ac-chip ac-chip--warning">{t("Staging only — trainer-led")}</p>
                                {drills.value.map((drill) => (
                                    <details key={drill.id} class="ac-details">
                                        <summary>{drill.title} · {drill.minutes} {t("min")}</summary>
                                        <MarkdownView source={drill.markdown} compact />
                                    </details>
                                ))}
                            </section>
                        )}
                    </>
                )}
            </AcademyShell>
        );
    },
});

export default AdminAcademyHelpPage;
