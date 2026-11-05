import { computed, defineComponent, onMounted, ref, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton, useAcademyData, userRole } from "@/components/academy/AcademyShell";
import { TrackCard } from "@/components/academy/TrackCard";
import { trackStats } from "@/components/academy/nextStep";
import { Callout } from "@/components/academy/ui/Callout";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { roleTrackFor, type TrackId } from "@/content/academy";

type TrackFilter = "all" | "role" | "certified";

export const AdminAcademyTracksPage = defineComponent({
    name: "AdminAcademyTracksPage",
    setup() {
        const { t } = useLocale();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        const filter = ref<TrackFilter>("all");
        const roleTrack = roleTrackFor(userRole());
        const required: TrackId[] = roleTrack ? ["FOUNDATION", roleTrack] : ["FOUNDATION"];
        const recertifyFrom = computed(() => data.meta.value?.recertifyFrom ?? "0.0");
        /** Certified = a badge that is still valid (including "expires soon"). */
        const isCertified = (id: TrackId): boolean => {
            const state = academy.badgeState(id, recertifyFrom.value);
            return state === "valid" || state === "expiring";
        };
        const visible = computed(() => {
            if (filter.value === "role") return data.tracks.value.filter((track) => required.includes(track.id));
            if (filter.value === "certified") return data.tracks.value.filter((track) => isCertified(track.id));
            return data.tracks.value;
        });

        onMounted(() => void data.loadCore(false, false));

        return () => {
            const body = (): VNodeChild => {
                if (data.failed.value) return <Callout tone="danger">{t("The Academy content could not be loaded. Reload the page.")}</Callout>;
                if (!data.ready.value) return <Skeleton rows={4} />;
                const tabs = [
                    { value: "all", label: t("All tracks"), count: data.tracks.value.length },
                    { value: "role", label: t("For my role"), count: data.tracks.value.filter((track) => required.includes(track.id)).length },
                    { value: "certified", label: t("Certified"), count: data.tracks.value.filter((track) => isCertified(track.id)).length },
                ];
                return (
                    <div class="ac-stack">
                        <div class="ac-learner-toolbar">
                            <SegmentedTabs
                                modelValue={filter.value}
                                tabs={tabs}
                                ariaLabel={t("Filter tracks")}
                                onUpdate:modelValue={(value: string) => (filter.value = value as TrackFilter)}
                            />
                        </div>
                        {visible.value.length === 0 ? (
                            <SurfaceCard class="ac-card">
                                <EmptyState icon="mdi-school-outline" title={t("No tracks match this filter")} description={t("Choose another filter to see more tracks.")} />
                            </SurfaceCard>
                        ) : (
                            <div class="ac-grid" style={{ "--ac-min": "340px" }}>
                                {visible.value.map((track) => (
                                    <TrackCard
                                        key={track.id}
                                        track={track}
                                        state={academy.badgeState(track.id, recertifyFrom.value)}
                                        expiresAt={academy.badgeFor(track.id)?.expiresAt}
                                        requiresTitles={track.requires.map((id) => data.tracks.value.find((x) => x.id === id)?.title ?? id)}
                                        active={academy.progress.value.activeTrack === track.id}
                                        required={required.includes(track.id)}
                                        stats={trackStats(track, academy.progress.value)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                );
            };
            return (
                <AcademyShell
                    header={() => <PageHeader title={t("Tracks")} subtitle={t("Everyone starts with Foundation, then takes the track for their role.")} />}
                >
                    {body()}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyTracksPage;
