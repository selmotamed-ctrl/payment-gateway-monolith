import { computed, defineComponent, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton } from "@/components/academy/AcademyShell";
import { LabRunner } from "@/components/academy/lab/LabRunner";
import type { LabScore } from "@/components/academy/labScoring";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { loadLabs, loadMeta, type Lab } from "@/content/academy";

export const AdminAcademyLabPage = defineComponent({
    name: "AdminAcademyLabPage",
    setup() {
        const { t } = useLocale();
        const route = useRoute();
        const academy = useAcademyProgress();
        const labs = ref<Lab[]>([]);
        const contentVersion = ref("");
        const loading = ref(true);
        const failed = ref(false);

        onMounted(async () => {
            try {
                const [loadedLabs, meta] = await Promise.all([loadLabs(), loadMeta()]);
                labs.value = loadedLabs;
                contentVersion.value = meta.contentVersion;
            } catch {
                failed.value = true;
            } finally {
                loading.value = false;
            }
            void academy.load().catch(() => undefined);
        });

        const lab = computed(() => labs.value.find((entry) => entry.id === String(route.params.labId ?? "")));

        const onFinish = (result: LabScore) => {
            if (!lab.value) return;
            academy.recordLab(lab.value.id, contentVersion.value, {
                score: result.score,
                passed: result.passed,
                criticalErrors: result.criticalErrors,
            });
            void academy.flush().catch(() => undefined);
        };

        return () => {
            const current = lab.value;
            return (
                <AcademyShell
                    title={current?.title ?? t("Lab")}
                    subtitle={current ? `${current.minutes} ${t("min")}` : undefined}
                    backTo={current ? { name: "AdminAcademyModule", params: { moduleId: current.module }, label: t("Back to the module") } : { name: "AdminAcademyTracks", label: t("Tracks") }}
                >
                    {loading.value ? (
                        <Skeleton rows={3} />
                    ) : failed.value ? (
                        <p role="alert">{t("The Academy content could not be loaded. Reload the page.")}</p>
                    ) : !current ? (
                        <p role="status">{t("This lab does not exist. Go back and pick another lab.")}</p>
                    ) : (
                        <LabRunner key={current.id} lab={current} best={academy.labBest(current.id)} onFinish={onFinish} />
                    )}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyLabPage;
