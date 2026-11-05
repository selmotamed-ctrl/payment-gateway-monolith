import { computed, defineComponent, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton } from "@/components/academy/AcademyShell";
import { LabRunner } from "@/components/academy/lab/LabRunner";
import type { LabScore } from "@/components/academy/labScoring";
import { Callout } from "@/components/academy/ui/Callout";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader, type BreadcrumbItem } from "@/components/ui/PageHeader";
import { loadLabs, loadMeta, loadModules, type Lab, type Module } from "@/content/academy";

export const AdminAcademyLabPage = defineComponent({
    name: "AdminAcademyLabPage",
    setup() {
        const { t } = useLocale();
        const route = useRoute();
        const router = useRouter();
        const academy = useAcademyProgress();
        const labs = ref<Lab[]>([]);
        const modules = ref<Module[]>([]);
        const contentVersion = ref("");
        const loading = ref(true);
        const failed = ref(false);

        onMounted(async () => {
            try {
                // The module title only decorates the breadcrumb: its failure must not fail the lab.
                const [loadedLabs, meta, loadedModules] = await Promise.all([
                    loadLabs(),
                    loadMeta(),
                    loadModules().catch((): Module[] => []),
                ]);
                labs.value = loadedLabs;
                modules.value = loadedModules;
                contentVersion.value = meta.contentVersion;
            } catch {
                failed.value = true;
            } finally {
                loading.value = false;
            }
            void academy.load().catch(() => undefined);
        });

        const lab = computed(() => labs.value.find((entry) => entry.id === String(route.params.labId ?? "")));
        const parentModule = computed(() => modules.value.find((entry) => entry.id === lab.value?.module));

        const onFinish = (result: LabScore) => {
            if (!lab.value) return;
            academy.recordLab(lab.value.id, contentVersion.value, {
                score: result.score,
                passed: result.passed,
                criticalErrors: result.criticalErrors,
            });
            void academy.flush().catch(() => undefined);
        };

        const breadcrumbs = (): BreadcrumbItem[] => {
            const current = lab.value;
            if (!current) {
                return [{ label: t("Tracks"), to: router.resolve({ name: "AdminAcademyTracks" }).fullPath }, { label: t("Lab") }];
            }
            return [
                {
                    label: parentModule.value?.title ?? t("Back to the module"),
                    to: router.resolve({ name: "AdminAcademyModule", params: { moduleId: current.module } }).fullPath,
                },
                { label: current.title },
            ];
        };

        return () => {
            const current = lab.value;
            return (
                <AcademyShell
                    header={() => (
                        <PageHeader
                            title={current?.title ?? t("Lab")}
                            subtitle={current ? `${current.minutes} ${t("min")}` : ""}
                            breadcrumbs={breadcrumbs()}
                        />
                    )}
                >
                    {loading.value ? (
                        <Skeleton rows={3} split />
                    ) : failed.value ? (
                        <Callout tone="danger" role="alert">
                            {t("The Academy content could not be loaded. Reload the page.")}
                        </Callout>
                    ) : !current ? (
                        <EmptyState
                            icon="mdi-flask-empty-outline"
                            title={t("This lab does not exist. Go back and pick another lab.")}
                            actionLabel={t("Tracks")}
                            onAction={() => void router.push({ name: "AdminAcademyTracks" })}
                        />
                    ) : (
                        <LabRunner key={current.id} lab={current} best={academy.labBest(current.id)} onFinish={onFinish} />
                    )}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyLabPage;
