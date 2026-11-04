import { computed, defineComponent, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton, fmt, useAcademyData, userRole } from "@/components/academy/AcademyShell";
import { BadgeChip } from "@/components/academy/BadgeChip";
import { ProgressRing } from "@/components/academy/ProgressRing";
import { nextStep, pickActiveTrack, trackStats } from "@/components/academy/nextStep";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { useEligibility } from "@/components/academy/useEligibility";
import { roleTrackFor, type TrackId } from "@/content/academy";

export const AdminAcademyPage = defineComponent({
    name: "AdminAcademyPage",
    setup() {
        const { t } = useLocale();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        const roleTrack = roleTrackFor(userRole());
        const examId = ref("");

        const activeId = computed<TrackId>(() =>
            pickActiveTrack(academy.progress.value, roleTrack, (id) => academy.badgeState(id, data.meta.value?.recertifyFrom ?? "0.0")),
        );
        const track = computed(() => data.tracks.value.find((entry) => entry.id === activeId.value));
        const eligibility = useEligibility(examId);
        const readingIds = computed(() => {
            const ids = new Set<string>();
            for (const lesson of data.lessons.value) {
                if (track.value?.lessonIds.includes(lesson.id)) lesson.reading.forEach((id) => ids.add(id));
            }
            return [...ids];
        });
        const readCount = computed(() => readingIds.value.filter((id) => academy.guideRead(id)).length);
        const step = computed(() =>
            track.value
                ? nextStep({
                      track: track.value,
                      modules: data.modules.value,
                      lessons: data.lessons.value,
                      labs: data.labs.value,
                      progress: academy.progress.value,
                      eligibility: eligibility.eligibility.value,
                  })
                : null,
        );
        const stats = computed(() => (track.value ? trackStats(track.value, academy.progress.value) : null));

        onMounted(async () => {
            await data.loadCore();
            await academy.load();
            examId.value = track.value?.examId ?? "";
        });

        const switchTrack = (id: TrackId) => {
            academy.setActiveTrack(id);
            examId.value = data.tracks.value.find((entry) => entry.id === id)?.examId ?? "";
        };

        const label = (kind: string, title: string): string =>
            kind === "lesson" ? fmt(t("Continue: lesson {title}"), { title }) : kind === "lab" ? fmt(t("Continue: lab {title}"), { title }) : kind === "exam" ? t("Go to the exam") : t("Track complete");

        return () => {
            const meta = data.meta.value;
            const body = () => {
                if (data.failed.value) return <p class="ac-card">{t("The Academy content could not be loaded. Reload the page.")}</p>;
                if (!data.ready.value || !track.value || !step.value || !stats.value) return <Skeleton rows={3} />;
                const s = step.value;
                const title =
                    s.kind === "lesson"
                        ? (data.lessons.value.find((l) => l.id === s.id)?.title ?? s.id)
                        : s.kind === "lab"
                          ? (data.labs.value.find((l) => l.id === s.id)?.title ?? s.id)
                          : "";
                const badge = academy.badgeFor(track.value.id);
                const state = academy.badgeState(track.value.id, meta?.recertifyFrom ?? "0.0");
                const required: TrackId[] = roleTrack ? ["FOUNDATION", roleTrack] : ["FOUNDATION"];
                const others = data.tracks.value.filter((entry) => entry.id !== track.value!.id);
                return (
                    <>
                        <section class="ac-card ac-card--active" aria-labelledby="ac-active-h">
                            <div class="ac-between">
                                <h2 id="ac-active-h" class="ac-h2">{track.value.title}</h2>
                                <BadgeChip track={track.value.id} state={state} expiresAt={badge?.expiresAt} />
                            </div>
                            {(state === "expired" || state === "recertify") && (
                                <p class="ac-chip ac-chip--danger" role="status">
                                    ⟳ {t("Recertification required")}: {t("repeat the exam to renew this badge.")}
                                </p>
                            )}
                            <div class="ac-rings">
                                <ProgressRing value={stats.value.lessonsDone} max={stats.value.lessonsTotal} label={t("Lessons")} />
                                <ProgressRing value={stats.value.labsPassed} max={stats.value.labsTotal} label={t("Labs")} />
                                <ProgressRing value={stats.value.examPassed ? 1 : 0} max={1} label={t("Exam")} />
                            </div>
                            <div class="ac-actions">
                                <RouterLink class="ac-btn ac-btn--big" to={{ name: s.route.name, params: s.route.params }}>
                                    {label(s.kind, title)} →
                                </RouterLink>
                                {s.kind === "exam" && s.locked && (
                                    <span class="ac-muted">{t("The exam is locked: see what is missing on the track page.")}</span>
                                )}
                            </div>
                        </section>

                        <section class="ac-card" aria-labelledby="ac-tracks-h">
                            <h2 id="ac-tracks-h" class="ac-h2">{t("Your tracks")}</h2>
                            <ul class="ac-list">
                                {[track.value, ...others.filter((o) => required.includes(o.id))].map((entry) => {
                                    const entryBadge = academy.badgeFor(entry.id);
                                    return (
                                        <li key={entry.id} class="ac-row">
                                            <RouterLink to={{ name: "AdminAcademyTrack", params: { trackId: entry.id } }}>{entry.title}</RouterLink>
                                            <BadgeChip
                                                track={entry.id}
                                                state={academy.badgeState(entry.id, meta?.recertifyFrom ?? "0.0")}
                                                expiresAt={entryBadge?.expiresAt}
                                            />
                                            {entry.id !== track.value!.id && (
                                                <button type="button" class="ac-btn ac-btn--secondary ac-grow-end" onClick={() => switchTrack(entry.id)}>
                                                    {t("Make active")}
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>

                        <section class="ac-card" aria-labelledby="ac-guide-h">
                            <h2 id="ac-guide-h" class="ac-h2">{t("Guide reading")}</h2>
                            <p aria-live="polite">
                                {fmt(t("Articles read: {x} of {y} recommended for your track"), { x: readCount.value, y: readingIds.value.length })}
                            </p>
                            <p class="ac-muted">
                                <RouterLink to={{ name: "AdminGuide" }}>{t("Open the Guide")}</RouterLink>
                            </p>
                        </section>

                        <nav class="ac-actions" aria-label={t("Academy links")}>
                            <RouterLink class="ac-btn ac-btn--secondary" to={{ name: "AdminAcademyTracks" }}>{t("All tracks")}</RouterLink>
                            <RouterLink class="ac-btn ac-btn--secondary" to={{ name: "AdminAcademyHelp" }}>{t("How the Academy works")}</RouterLink>
                            {userRole() === "SECURITY_ADMIN" && (
                                <RouterLink class="ac-btn ac-btn--secondary" to={{ name: "AdminAcademyTeam" }}>{t("Team")}</RouterLink>
                            )}
                        </nav>
                    </>
                );
            };
            return (
                <AcademyShell title={t("My learning")} subtitle={t("Learn, check, do, prove: one next step at a time.")}>
                    {body()}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyPage;
