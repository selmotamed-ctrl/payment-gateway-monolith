import { computed, defineComponent, onMounted, ref, watch, type VNodeChild } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import { AcademyShell, Skeleton, useAcademyData } from "@/components/academy/AcademyShell";
import { BadgeChip } from "@/components/academy/BadgeChip";
import { ModuleList } from "@/components/academy/ModuleList";
import { ProgressRing } from "@/components/academy/ProgressRing";
import { TrackFacts } from "@/components/academy/TrackCard";
import { fmtDateShort, isolate } from "@/components/academy/format";
import { fallbackMissing, nextStep, trackStats } from "@/components/academy/nextStep";
import { Callout } from "@/components/academy/ui/Callout";
import { StateIcon } from "@/components/academy/ui/StateIcon";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { useEligibility } from "@/components/academy/useEligibility";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

/** Requirements shown in the exam-readiness card before collapsing the rest into "and n more". */
const MISSING_SHOWN = 6;

export const AdminAcademyTrackPage = defineComponent({
    name: "AdminAcademyTrackPage",
    setup() {
        const { t } = useLocale();
        const route = useRoute();
        const router = useRouter();
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
                lesson: (title) => t("Complete lesson: {title}", { title: isolate(title) }),
                lab: (title) => t("Pass lab: {title}", { title: isolate(title) }),
            });
        });
        const ready = computed(() =>
            eligibility.eligibility.value ? eligibility.eligibility.value.eligible : missing.value.length === 0,
        );
        /** The lesson or lab the learner would do next on this track (marked "Up next" in the module list). */
        const nextId = computed(() => {
            if (!track.value || !data.ready.value) return undefined;
            const step = nextStep({
                track: track.value,
                modules: data.modules.value,
                lessons: data.lessons.value,
                labs: data.labs.value,
                progress: academy.progress.value,
            });
            return step.kind === "lesson" || step.kind === "lab" ? step.id : undefined;
        });

        return () => {
            const tr = track.value;
            const body = (): VNodeChild => {
                if (data.failed.value) return <Callout tone="danger">{t("The Academy content could not be loaded. Reload the page.")}</Callout>;
                if (!data.ready.value) return <Skeleton rows={4} split />;
                if (!tr) {
                    return (
                        <SurfaceCard class="ac-card">
                            <EmptyState icon="mdi-school-outline" title={t("This track does not exist.")} />
                        </SurfaceCard>
                    );
                }
                const stats = trackStats(tr, academy.progress.value);
                const blueprint = data.blueprints.value.find((b) => b.id === tr.examId);
                const badge = academy.badgeFor(tr.id);
                const badgeState = academy.badgeState(tr.id, data.meta.value?.recertifyFrom ?? "0.0");
                const passed = stats.examPassed;
                const isActive = academy.progress.value.activeTrack === tr.id;
                const checking = eligibility.loading.value && !eligibility.eligibility.value;
                const missingList = missing.value;
                return (
                    <div class="ac-split">
                        <div class="ac-stack">
                            <SurfaceCard
                                class="ac-card"
                                title={t("Your progress")}
                                v-slots={{ headerActions: () => <BadgeChip track={tr.id} state={badgeState} expiresAt={badge?.expiresAt} compact /> }}
                            >
                                <div class="ac-learner-summary">
                                    <div class="ac-learner-summary__facts">
                                        <TrackFacts track={tr} />
                                        {badge && badgeState !== "none" && (
                                            <p class="ac-muted">
                                                {badgeState === "expired" || badgeState === "recertify" ? t("expired") : t("valid until")}{" "}
                                                <span class="ac-num">{fmtDateShort(badge.expiresAt)}</span>
                                            </p>
                                        )}
                                        <div>
                                            <VBtn
                                                variant={isActive ? "tonal" : "outlined"}
                                                prependIcon={isActive ? "mdi-check" : undefined}
                                                onClick={() => academy.setActiveTrack(tr.id)}
                                            >
                                                {isActive ? t("This is your active track") : t("Make this my active track")}
                                            </VBtn>
                                        </div>
                                    </div>
                                    <div class="ac-learner-summary__rings">
                                        <ProgressRing value={stats.lessonsDone} max={stats.lessonsTotal} label={t("Lessons")} />
                                        <ProgressRing value={stats.labsPassed} max={stats.labsTotal} label={t("Labs")} />
                                        <ProgressRing value={passed ? 1 : 0} max={1} label={t("Exam")} />
                                    </div>
                                </div>
                            </SurfaceCard>

                            <h2 class="ac-h2 ac-learner-section">{t("Modules")}</h2>
                            <ModuleList
                                modules={tr.moduleIds.flatMap((id) => data.modules.value.filter((m) => m.id === id))}
                                lessons={data.lessons.value}
                                labs={data.labs.value}
                                lessonIds={tr.lessonIds}
                                labIds={tr.labIds}
                                nextId={nextId.value}
                                numbered
                            />
                        </div>

                        <aside class="ac-aside">
                            <SurfaceCard
                                class="ac-card"
                                title={t("Exam readiness")}
                                bodyGap="16px"
                                v-slots={{
                                    headerActions: () =>
                                        passed ? (
                                            <StatusBadge status="passed" label={t("Passed")} toneOverride="success" />
                                        ) : checking ? (
                                            <StatusBadge status="checking" label={t("Checking…")} toneOverride="neutral" />
                                        ) : ready.value ? (
                                            <StatusBadge status="ready" label={t("Ready")} toneOverride="success" />
                                        ) : (
                                            <StatusBadge status="locked" label={t("Locked")} toneOverride="warning" />
                                        ),
                                }}
                            >
                                {blueprint && (
                                    <DescriptionList
                                        items={[
                                            { label: t("Questions"), value: <span class="ac-num">{blueprint.questionCount}</span> },
                                            { label: t("Pass mark"), value: <span class="ac-num">{blueprint.passPercent}%</span> },
                                            { label: t("Time limit"), value: t("{m} minutes", { m: blueprint.timeLimitMinutes }) },
                                        ]}
                                    />
                                )}
                                <VBtn
                                    class="ac-learner-cta__btn"
                                    block
                                    color={passed ? undefined : "primary"}
                                    variant={passed ? "outlined" : "flat"}
                                    disabled={!ready.value}
                                    to={{ name: "AdminAcademyExam", params: { examId: tr.examId } }}
                                >
                                    {passed ? t("Retake the exam") : t("Go to the exam")}
                                    <VIcon end class="ac-flip" icon="mdi-arrow-right" size={18} aria-hidden="true" />
                                </VBtn>
                                <div class="ac-stack ac-stack--sm" aria-live="polite">
                                    {!ready.value && missingList.length > 0 && (
                                        <>
                                            <p class="ac-h3">{t("To unlock the exam you still need to:")}</p>
                                            <ul class="ac-steps">
                                                {missingList.slice(0, MISSING_SHOWN).map((item) => (
                                                    <li key={`${item.kind}-${item.id}`} class="ac-step">
                                                        <StateIcon state="todo" lab={item.kind === "lab"} />
                                                        <span class="ac-step__main">
                                                            <span class="ac-step__title">{item.text}</span>
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                            {missingList.length > MISSING_SHOWN && (
                                                <p class="ac-muted">{t("and {n} more", { n: missingList.length - MISSING_SHOWN })}</p>
                                            )}
                                        </>
                                    )}
                                    {ready.value && !passed && !checking && (
                                        <Callout tone="success" role="none">
                                            {t("You have completed every requirement.")}
                                        </Callout>
                                    )}
                                    {eligibility.error.value && (
                                        <p class="ac-muted">{t("Could not reach the server; this list is worked out from your saved progress.")}</p>
                                    )}
                                </div>
                            </SurfaceCard>
                        </aside>
                    </div>
                );
            };
            return (
                <AcademyShell
                    header={() => (
                        <PageHeader
                            title={tr?.title ?? t("Track")}
                            subtitle={tr?.description ?? ""}
                            breadcrumbs={[
                                { label: t("Tracks"), to: router.resolve({ name: "AdminAcademyTracks" }).fullPath },
                                { label: tr?.title ?? t("Track") },
                            ]}
                        />
                    )}
                >
                    {body()}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyTrackPage;
