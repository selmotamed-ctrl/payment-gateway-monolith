import { defineComponent, onMounted } from "vue";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton, useAcademyData } from "@/components/academy/AcademyShell";
import { TrackCard } from "@/components/academy/TrackCard";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";

export const AdminAcademyTracksPage = defineComponent({
    name: "AdminAcademyTracksPage",
    setup() {
        const { t } = useLocale();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        onMounted(() => void data.loadCore(false, false));
        return () => (
            <AcademyShell title={t("Tracks")} subtitle={t("Everyone starts with Foundation, then takes the track for their role.")}>
                {data.failed.value ? (
                    <p class="ac-card">{t("The Academy content could not be loaded. Reload the page.")}</p>
                ) : !data.ready.value ? (
                    <Skeleton rows={4} />
                ) : (
                    data.tracks.value.map((track) => (
                        <TrackCard
                            key={track.id}
                            track={track}
                            state={academy.badgeState(track.id, data.meta.value?.recertifyFrom ?? "0.0")}
                            expiresAt={academy.badgeFor(track.id)?.expiresAt}
                            requiresTitles={track.requires.map((id) => data.tracks.value.find((x) => x.id === id)?.title ?? id)}
                            active={academy.progress.value.activeTrack === track.id}
                        />
                    ))
                )}
            </AcademyShell>
        );
    },
});

export default AdminAcademyTracksPage;
