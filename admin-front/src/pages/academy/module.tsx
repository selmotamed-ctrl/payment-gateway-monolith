import { computed, defineComponent, onMounted } from "vue";
import { useRoute } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton, useAcademyData, userRole } from "@/components/academy/AcademyShell";
import { ModuleList } from "@/components/academy/ModuleList";
import { pickActiveTrack } from "@/components/academy/nextStep";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { roleTrackFor } from "@/content/academy";

export const AdminAcademyModulePage = defineComponent({
    name: "AdminAcademyModulePage",
    setup() {
        const { t } = useLocale();
        const route = useRoute();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        onMounted(() => void data.loadCore());
        const module = computed(() => data.modules.value.find((m) => m.id === String(route.params.moduleId ?? "")));
        const active = computed(() => {
            const id = pickActiveTrack(academy.progress.value, roleTrackFor(userRole()), (x) => academy.badgeState(x, data.meta.value?.recertifyFrom ?? "0.0"));
            return data.tracks.value.find((tr) => tr.id === id);
        });
        const owner = computed(() => data.tracks.value.find((tr) => module.value && tr.moduleIds.includes(module.value.id)));

        return () => {
            const m = module.value;
            return (
                <AcademyShell
                    title={m?.title ?? t("Module")}
                    subtitle={m?.objective}
                    backTo={owner.value ? { name: "AdminAcademyTrack", params: { trackId: owner.value.id }, label: owner.value.title } : { name: "AdminAcademyTracks", label: t("Tracks") }}
                >
                    {data.failed.value ? (
                        <p class="ac-card">{t("The Academy content could not be loaded. Reload the page.")}</p>
                    ) : !data.ready.value ? (
                        <Skeleton rows={3} />
                    ) : !m ? (
                        <p class="ac-card">{t("This module does not exist.")}</p>
                    ) : (
                        <>
                            <p class="ac-muted">{m.minutes} {t("min")} · {t("Labs outside your active track are marked.")}</p>
                            <ModuleList modules={[m]} lessons={data.lessons.value} labs={data.labs.value} showObjective={false} activeLabIds={active.value?.labIds} />
                        </>
                    )}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyModulePage;
