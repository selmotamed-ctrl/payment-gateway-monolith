import { computed, defineComponent, onMounted, ref, type VNodeChild } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import { AcademyShell, Skeleton, useAcademyData, userRole } from "@/components/academy/AcademyShell";
import { BadgeChip } from "@/components/academy/BadgeChip";
import { ProgressRing } from "@/components/academy/ProgressRing";
import { fmtDateShort, isolate } from "@/components/academy/format";
import { nextStep, pickActiveTrack, trackStats, type NextStep } from "@/components/academy/nextStep";
import { Callout } from "@/components/academy/ui/Callout";
import { IconTile } from "@/components/academy/ui/IconTile";
import { ProgressBar } from "@/components/academy/ui/ProgressBar";
import { trackIcon } from "@/components/academy/ui/trackMeta";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { useEligibility } from "@/components/academy/useEligibility";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetaPill } from "@/components/ui/MetaPill";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { roleTrackFor, type TrackId } from "@/content/academy";
import type { AcademyBadge } from "@/content/academy/apiTypes";

/** "n / m" as an isolated left-to-right run so it stays readable inside Arabic text. */
const fraction = (done: number, total: number): VNodeChild => (
    <bdi class="ac-ltr ac-num">
        {done} / {total}
    </bdi>
);

export const AdminAcademyPage = defineComponent({
    name: "AdminAcademyPage",
    setup() {
        const { t } = useLocale();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        const roleTrack = roleTrackFor(userRole());
        const examId = ref("");

        const recertifyFrom = computed(() => data.meta.value?.recertifyFrom ?? "0.0");
        const activeId = computed<TrackId>(() =>
            pickActiveTrack(academy.progress.value, roleTrack, (id) => academy.badgeState(id, recertifyFrom.value)),
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
        /** Latest certificate per track, newest first. */
        const certificates = computed(() => {
            const tracksWithBadge = [...new Set(academy.progress.value.badges.map((badge) => badge.track))];
            const time = (value: string): number => Date.parse(value) || 0;
            return tracksWithBadge
                .map((id) => academy.badgeFor(id))
                .filter((badge): badge is AcademyBadge => Boolean(badge))
                .sort((a, b) => time(b.earnedAt) - time(a.earnedAt));
        });

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
            kind === "lesson" ? t("Continue: lesson {title}", { title: isolate(title) }) : kind === "lab" ? t("Continue: lab {title}", { title: isolate(title) }) : kind === "exam" ? t("Go to the exam") : t("Track complete");

        const trackTitle = (id: string): string => data.tracks.value.find((entry) => entry.id === id)?.title ?? id;

        /** One sentence about the next step: kind, minutes and module (lesson/lab), or the exam/done state. */
        const nextLine = (s: NextStep): VNodeChild => {
            if (s.kind === "lesson" || s.kind === "lab") {
                const minutes = s.kind === "lesson" ? data.lessons.value.find((l) => l.id === s.id)?.minutes : data.labs.value.find((l) => l.id === s.id)?.minutes;
                const moduleTitle = data.modules.value.find((m) => m.id === s.moduleId)?.title;
                return (
                    <p class="ac-learner-next">
                        <span class="ac-learner-next__kind">{s.kind === "lesson" ? t("Next lesson") : t("Next lab")}</span>
                        {minutes !== undefined && (
                            <>
                                {" · "}
                                <span class="ac-num">
                                    {minutes} {t("min")}
                                </span>
                            </>
                        )}
                        {moduleTitle && (
                            <>
                                {" · "}
                                <bdi>{moduleTitle}</bdi>
                            </>
                        )}
                    </p>
                );
            }
            if (s.kind === "exam") return s.locked ? null : <p class="ac-learner-next">{t("Everything else is done — the exam is next.")}</p>;
            return <p class="ac-learner-next">{t("You have passed this track's exam.")}</p>;
        };

        return () => {
            const body = (): VNodeChild => {
                if (data.failed.value) return <Callout tone="danger">{t("The Academy content could not be loaded. Reload the page.")}</Callout>;
                if (!data.ready.value) return <Skeleton rows={3} split />;
                if (!track.value || !step.value || !stats.value) {
                    return <Callout tone="danger">{t("The Academy content could not be loaded. Reload the page.")}</Callout>;
                }
                const active = track.value;
                const s = step.value;
                const st = stats.value;
                const title =
                    s.kind === "lesson"
                        ? (data.lessons.value.find((l) => l.id === s.id)?.title ?? s.id)
                        : s.kind === "lab"
                          ? (data.labs.value.find((l) => l.id === s.id)?.title ?? s.id)
                          : "";
                const badge = academy.badgeFor(active.id);
                const state = academy.badgeState(active.id, recertifyFrom.value);
                const required: TrackId[] = roleTrack ? ["FOUNDATION", roleTrack] : ["FOUNDATION"];
                const others = data.tracks.value.filter((entry) => entry.id !== active.id);
                const yourTracks = [active, ...others.filter((o) => required.includes(o.id))];
                return (
                    <div class="ac-stack ac-stack--lg">
                        <section class="ac-card ac-hero" aria-labelledby="ac-active-h">
                            <div class="ac-learner-hero__main">
                                <div>
                                    <p class="ac-eyebrow">{t("Active track")}</p>
                                    <div class="ac-learner-hero__head">
                                        <IconTile icon={trackIcon(active.id)} large />
                                        <h2 id="ac-active-h" class="ac-title">
                                            {active.title}
                                        </h2>
                                        <BadgeChip track={active.id} state={state} expiresAt={badge?.expiresAt} />
                                    </div>
                                </div>
                                {nextLine(s)}
                                {(state === "expired" || state === "recertify") && (
                                    <Callout tone="danger" role="status">
                                        <strong>{t("Recertification required")}</strong>: {t("repeat the exam to renew this badge.")}
                                    </Callout>
                                )}
                                <div class="ac-learner-cta">
                                    <VBtn class="ac-learner-cta__btn" color="primary" variant="flat" size="large" height="auto" to={{ name: s.route.name, params: s.route.params }}>
                                        {label(s.kind, title)}
                                        <VIcon end class="ac-flip" icon="mdi-arrow-right" size={18} aria-hidden="true" />
                                    </VBtn>
                                    {s.kind === "exam" && s.locked && <span class="ac-muted">{t("The exam is locked: see what is missing on the track page.")}</span>}
                                </div>
                            </div>
                            <div class="ac-learner-hero__rings">
                                <ProgressRing value={st.lessonsDone} max={st.lessonsTotal} label={t("Lessons")} size={80} />
                                <ProgressRing value={st.labsPassed} max={st.labsTotal} label={t("Labs")} size={80} />
                                <ProgressRing value={st.examPassed ? 1 : 0} max={1} label={t("Exam")} size={80} />
                            </div>
                        </section>

                        <div class="ac-split">
                            <SurfaceCard class="ac-card" title={t("Your tracks")} noPadding>
                                <ul class="ac-steps ac-steps--flush">
                                    {yourTracks.map((entry) => {
                                        const entryStats = trackStats(entry, academy.progress.value);
                                        const isActive = entry.id === active.id;
                                        const done = entryStats.lessonsDone + entryStats.labsPassed;
                                        const total = entryStats.lessonsTotal + entryStats.labsTotal;
                                        return (
                                            <li key={entry.id} class={["ac-step", "ac-learner-track-row", isActive ? "ac-step--current" : ""]}>
                                                <IconTile icon={trackIcon(entry.id)} />
                                                <div class="ac-step__main">
                                                    <RouterLink class="ac-step__title" to={{ name: "AdminAcademyTrack", params: { trackId: entry.id } }}>
                                                        {entry.title}
                                                    </RouterLink>
                                                    <span class="ac-step__sub">
                                                        {fraction(entryStats.lessonsDone, entryStats.lessonsTotal)} {t("lessons")} · {fraction(entryStats.labsPassed, entryStats.labsTotal)} {t("labs")}
                                                    </span>
                                                    <ProgressBar value={done} max={total} label={`${entry.title}: ${t("Lessons and labs completed")}`} />
                                                </div>
                                                <div class="ac-learner-track-row__end">
                                                    <BadgeChip track={entry.id} state={academy.badgeState(entry.id, recertifyFrom.value)} expiresAt={academy.badgeFor(entry.id)?.expiresAt} />
                                                    {isActive ? (
                                                        <MetaPill color="info">{t("Active")}</MetaPill>
                                                    ) : (
                                                        <VBtn size="small" variant="outlined" height={32} aria-label={`${t("Make active")}: ${entry.title}`} onClick={() => switchTrack(entry.id)}>
                                                            {t("Make active")}
                                                        </VBtn>
                                                    )}
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </SurfaceCard>

                            <aside class="ac-aside">
                                <SurfaceCard class="ac-card" title={t("Certificates")} noPadding>
                                    {certificates.value.length === 0 ? (
                                        <EmptyState icon="mdi-certificate-outline" title={t("No certificates yet")} description={t("Pass a certification exam to earn one.")} />
                                    ) : (
                                        <ul class="ac-steps ac-steps--flush">
                                            {certificates.value.map((cert) => {
                                                const certState = academy.badgeState(cert.track, recertifyFrom.value);
                                                const lapsed = certState === "expired" || certState === "recertify";
                                                return (
                                                    <li key={cert.id} class="ac-step ac-learner-cert">
                                                        <IconTile icon={trackIcon(cert.track)} />
                                                        <span class="ac-step__main">
                                                            <span class="ac-step__title">{trackTitle(cert.track)}</span>
                                                            <span class="ac-learner-cert__status">
                                                                <BadgeChip track={cert.track} state={certState} expiresAt={cert.expiresAt} compact />
                                                                <span class="ac-step__sub">
                                                                    {lapsed ? t("expired") : t("valid until")} <span class="ac-num">{fmtDateShort(cert.expiresAt)}</span>
                                                                </span>
                                                            </span>
                                                        </span>
                                                        <RouterLink class="ac-link ac-learner-nowrap" to={{ name: "AdminAcademyCertificate", params: { badgeId: cert.id } }} aria-label={`${t("View certificate")}: ${trackTitle(cert.track)}`}>
                                                            {t("View certificate")}
                                                        </RouterLink>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </SurfaceCard>

                                <SurfaceCard class="ac-card" title={t("Guide reading")} bodyGap="12px">
                                    <p class="ac-text" aria-live="polite">
                                        {t("Articles read: {x} of {y} recommended for your track", { x: readCount.value, y: readingIds.value.length })}
                                    </p>
                                    <ProgressBar value={readCount.value} max={readingIds.value.length} label={t("Guide articles read")} />
                                    <RouterLink class="ac-link" to={{ name: "AdminGuide" }}>
                                        {t("Open the Guide")}
                                    </RouterLink>
                                </SurfaceCard>

                                <SurfaceCard class="ac-card" title={t("Academy")} noPadding>
                                    <nav aria-label={t("Academy links")}>
                                        <ul class="ac-steps ac-steps--flush">
                                            {[
                                                { name: "AdminAcademyTracks", text: t("All tracks") },
                                                { name: "AdminAcademyHelp", text: t("How the Academy works") },
                                                ...(userRole() === "SECURITY_ADMIN" ? [{ name: "AdminAcademyTeam", text: t("Team") }] : []),
                                            ].map((link) => (
                                                <li key={link.name} class="ac-step ac-learner-linkrow">
                                                    <RouterLink class="ac-step__title ac-learner-linkrow__a" to={{ name: link.name }}>
                                                        <span>{link.text}</span>
                                                        <VIcon class="ac-flip" icon="mdi-chevron-right" size={18} aria-hidden="true" />
                                                    </RouterLink>
                                                </li>
                                            ))}
                                        </ul>
                                    </nav>
                                </SurfaceCard>
                            </aside>
                        </div>
                    </div>
                );
            };
            return (
                <AcademyShell
                    header={() => <PageHeader title={t("My learning")} subtitle={t("Learn, check, do, prove: one next step at a time.")} />}
                >
                    {body()}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyPage;
