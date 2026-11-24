import { computed, defineComponent, onMounted, type VNodeChild } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import { AcademyShell, Skeleton, useAcademyData, userRole } from "@/components/academy/AcademyShell";
import { ModuleList } from "@/components/academy/ModuleList";
import { nextStep, pickActiveTrack } from "@/components/academy/nextStep";
import { Callout } from "@/components/academy/ui/Callout";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { showSnackBar } from "@/utils/snackBar";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { roleTrackFor } from "@/content/academy";

export const AdminAcademyModulePage = defineComponent({
    name: "AdminAcademyModulePage",
    setup() {
        const { t } = useLocale();
        const route = useRoute();
        const router = useRouter();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        onMounted(() => void data.loadCore());
        const module = computed(() => data.modules.value.find((m) => m.id === String(route.params.moduleId ?? "")));
        const active = computed(() => {
            const id = pickActiveTrack(academy.progress.value, roleTrackFor(userRole()), (x) => academy.badgeState(x, data.meta.value?.recertifyFrom ?? "0.0"));
            return data.tracks.value.find((tr) => tr.id === id);
        });
        const owner = computed(() => data.tracks.value.find((tr) => module.value && tr.moduleIds.includes(module.value.id)));
        /** Previous / next module inside the owning track (the learning order). */
        const neighbours = computed(() => {
            const tr = owner.value;
            const current = module.value;
            if (!tr || !current) return { prev: undefined, next: undefined };
            const index = tr.moduleIds.indexOf(current.id);
            const find = (id: string | undefined) => (id ? data.modules.value.find((m) => m.id === id) : undefined);
            return { prev: find(tr.moduleIds[index - 1]), next: find(tr.moduleIds[index + 1]) };
        });
        /** The learner's next lesson/lab on the owning track (or the active track): that row is marked "Up next". */
        const nextId = computed(() => {
            const tr = owner.value ?? active.value;
            if (!tr || !data.ready.value) return undefined;
            const step = nextStep({
                track: tr,
                modules: data.modules.value,
                lessons: data.lessons.value,
                labs: data.labs.value,
                progress: academy.progress.value,
            });
            return step.kind === "lesson" || step.kind === "lab" ? step.id : undefined;
        });

        const copyModuleSummary = async () => {
            const m = module.value;
            if (!m) return;
            const lessonsDone = m.lessonIds.filter((id) => academy.lessonDone(id)).length;
            const labsPassed = m.labIds.filter((id) => Boolean(academy.labBest(id)?.passedAt)).length;
            const summary = {
                module: m.id,
                title: m.title,
                track: owner.value?.id ?? null,
                lessons: `${lessonsDone}/${m.lessonIds.length}`,
                labs: `${labsPassed}/${m.labIds.length}`,
                upNext: nextId.value ?? null,
                nextModule: neighbours.value.next?.id ?? null,
                url: window.location.href,
            };
            try {
                await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
                showSnackBar({ type: "success", message: t("Module summary copied") });
            } catch {
                showSnackBar({ type: "error", message: t("Could not copy to the clipboard") });
            }
        };

        return () => {
            const m = module.value;
            const body = (): VNodeChild => {
                if (data.failed.value) return <Callout tone="danger">{t("The Academy content could not be loaded. Reload the page.")}</Callout>;
                if (!data.ready.value) return <Skeleton rows={3} />;
                if (!m) {
                    return (
                        <SurfaceCard class="ac-card">
                            <EmptyState icon="mdi-book-open-page-variant-outline" title={t("This module does not exist.")} />
                        </SurfaceCard>
                    );
                }
                const { prev, next } = neighbours.value;
                return (
                    <div class="ac-stack">
                        <p class="ac-muted ac-learner-meta">
                            <span class="ac-num">{m.minutes}</span> {t("min")} · {t("Labs outside your active track are marked.")}
                        </p>
                        <ModuleList
                            modules={[m]}
                            lessons={data.lessons.value}
                            labs={data.labs.value}
                            showObjective={false}
                            activeLabIds={active.value?.labIds}
                            nextId={nextId.value}
                            linkTitles={false}
                            headingLevel={2}
                        />
                        {(prev || next) && (
                            <nav class="ac-learner-pager" aria-label={t("Module navigation")}>
                                {prev ? (
                                    <VBtn class="ac-learner-pager__btn" variant="outlined" height="auto" to={{ name: "AdminAcademyModule", params: { moduleId: prev.id } }}>
                                        <VIcon start class="ac-flip" icon="mdi-arrow-left" size={18} aria-hidden="true" />
                                        <span class="ac-learner-pager__text">
                                            <span class="ac-learner-pager__dir">{t("Previous module")}</span>
                                            <span class="ac-learner-pager__title">{prev.title}</span>
                                        </span>
                                    </VBtn>
                                ) : (
                                    <span />
                                )}
                                {next && (
                                    <VBtn class="ac-learner-pager__btn ac-learner-pager__btn--next" variant="outlined" height="auto" to={{ name: "AdminAcademyModule", params: { moduleId: next.id } }}>
                                        <span class="ac-learner-pager__text">
                                            <span class="ac-learner-pager__dir">{t("Next module")}</span>
                                            <span class="ac-learner-pager__title">{next.title}</span>
                                        </span>
                                        <VIcon end class="ac-flip" icon="mdi-arrow-right" size={18} aria-hidden="true" />
                                    </VBtn>
                                )}
                            </nav>
                        )}
                    </div>
                );
            };
            return (
                <AcademyShell
                    header={() => (
                        <PageHeader
                            title={m?.title ?? t("Module")}
                            subtitle={m?.objective ?? ""}
                            breadcrumbs={
                                owner.value
                                    ? [
                                          { label: owner.value.title, to: router.resolve({ name: "AdminAcademyTrack", params: { trackId: owner.value.id } }).fullPath },
                                          { label: m?.title ?? t("Module") },
                                      ]
                                    : [
                                          { label: t("Tracks"), to: router.resolve({ name: "AdminAcademyTracks" }).fullPath },
                                          { label: m?.title ?? t("Module") },
                                      ]
                            }
                            end={() => (
                                <VBtn variant="tonal" prependIcon="mdi-content-copy" onClick={() => void copyModuleSummary()}>
                                    {t("Copy module summary")}
                                </VBtn>
                            )}
                        />
                    )}
                >
                    {body()}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyModulePage;
