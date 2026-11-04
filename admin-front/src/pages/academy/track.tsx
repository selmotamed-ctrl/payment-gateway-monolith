import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton, fmt, useAcademyData } from "@/components/academy/AcademyShell";
import { BadgeChip } from "@/components/academy/BadgeChip";
import { ModuleList } from "@/components/academy/ModuleList";
import { ProgressRing } from "@/components/academy/ProgressRing";
import { fallbackMissing, trackStats } from "@/components/academy/nextStep";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { useEligibility } from "@/components/academy/useEligibility";

export const AdminAcademyTrackPage = defineComponent({
    name: "AdminAcademyTrackPage",
    setup() {
        const { t } = useLocale();
        const route = useRoute();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        const trackId = computed(() => String(route.params.trackId ?? ""));
        const track = computed(() => data.tracks.value.find((entry) => entry.id === trackId.value));
        const examId = ref("");
        const eligibility = useEligibility(examId);
        watch([track], () => (examId.value = track.value?.examId ?? ""), { immediate: true });
        onMounted(() => void data.loadCore());

        const missing = computed(() => {
            if (eligibility.eligibility.value) return eligibility.eligibility.value.missing;
            if (!track.value) return [];
            return fallbackMissing(track.value, data.lessons.value, data.labs.value, academy.progress.value, {
                lesson: (title) => fmt(t("Complete lesson: {title}"), { title }),
                lab: (title) => fmt(t("Pass lab: {title}"), { title }),
            });
        });
        const ready = computed(() =>
            eligibility.eligibility.value ? eligibility.eligibility.value.eligible : missing.value.length === 0,
        );

        return () => {
            const tr = track.value;
            const body = () => {
                if (data.failed.value) return <p class="ac-card">{t("The Academy content could not be loaded. Reload the page.")}</p>;
                if (!data.ready.value) return <Skeleton rows={4} />;
                if (!tr) return <p class="ac-card">{t("This track does not exist.")}</p>;
                const stats = trackStats(tr, academy.progress.value);
                const blueprint = data.blueprints.value.find((b) => b.id === tr.examId);
                const badge = academy.badgeFor(tr.id);
                const passed = stats.examPassed;
                return (
                    <>
                        <section class="ac-card">
                            <p>{tr.description}</p>
                            <div class="ac-between">
                                <span class="ac-muted">{tr.hours} {t("hours")}</span>
                                <BadgeChip track={tr.id} state={academy.badgeState(tr.id, data.meta.value?.recertifyFrom ?? "0.0")} expiresAt={badge?.expiresAt} />
                            </div>
                            <div class="ac-rings">
                                <ProgressRing value={stats.lessonsDone} max={stats.lessonsTotal} label={t("Lessons")} />
                                <ProgressRing value={stats.labsPassed} max={stats.labsTotal} label={t("Labs")} />
                                <ProgressRing value={passed ? 1 : 0} max={1} label={t("Exam")} />
                            </div>
                            <button type="button" class="ac-btn ac-btn--secondary" onClick={() => academy.setActiveTrack(tr.id)}>
                                {academy.progress.value.activeTrack === tr.id ? `✓ ${t("This is your active track")}` : t("Make this my active track")}
                            </button>
                        </section>

                        <ModuleList modules={tr.moduleIds.flatMap((id) => data.modules.value.filter((m) => m.id === id))} lessons={data.lessons.value} labs={data.labs.value} lessonIds={tr.lessonIds} labIds={tr.labIds} />

                        <section class="ac-card" aria-labelledby="ac-exam-h">
                            <div class="ac-between">
                                <h2 id="ac-exam-h" class="ac-h2">{t("Exam")}</h2>
                                {passed ? (
                                    <span class="ac-chip ac-chip--success"><span aria-hidden="true">✓</span> {t("Passed")}</span>
                                ) : eligibility.loading.value && !eligibility.eligibility.value ? (
                                    <span class="ac-chip">{t("Checking…")}</span>
                                ) : ready.value ? (
                                    <span class="ac-chip ac-chip--success"><span aria-hidden="true">✓</span> {t("Ready")}</span>
                                ) : (
                                    <span class="ac-chip ac-chip--warning"><span aria-hidden="true">🔒</span> {t("Locked")}</span>
                                )}
                            </div>
                            {blueprint && (
                                <p class="ac-muted">
                                    {fmt(t("{n} questions · pass mark {p}% · {m} minutes"), { n: blueprint.questionCount, p: blueprint.passPercent, m: blueprint.timeLimitMinutes })}
                                </p>
                            )}
                            <div aria-live="polite">
                                {!ready.value && missing.value.length > 0 && (
                                    <>
                                        <p>{t("To unlock the exam you still need to:")}</p>
                                        <ul class="ac-missing">
                                            {missing.value.map((item) => (
                                                <li key={`${item.kind}-${item.id}`}>{item.text}</li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                                {eligibility.error.value && (
                                    <p class="ac-muted">{t("Could not reach the server; this list is worked out from your saved progress.")}</p>
                                )}
                            </div>
                            <RouterLink
                                class="ac-btn"
                                aria-disabled={!ready.value}
                                tabindex={ready.value ? undefined : -1}
                                to={{ name: "AdminAcademyExam", params: { examId: tr.examId } }}
                            >
                                {passed ? t("Retake the exam") : t("Go to the exam")}
                            </RouterLink>
                        </section>
                    </>
                );
            };
            return (
                <AcademyShell
                    title={tr?.title ?? t("Track")}
                    backTo={{ name: "AdminAcademyTracks", label: t("Tracks") }}
                >
                    {body()}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyTrackPage;
