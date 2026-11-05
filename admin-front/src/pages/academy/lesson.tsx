import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import { AcademyShell, Skeleton, useAcademyData, userRole } from "@/components/academy/AcademyShell";
import { LessonCheck } from "@/components/academy/LessonCheck";
import { ReadingList } from "@/components/academy/ReadingList";
import { percent } from "@/components/academy/format";
import { nextStep, pickActiveTrack, type NextStep } from "@/components/academy/nextStep";
import { lessonProse } from "@/components/academy/lessonBody";
import { isArticleOpened } from "@/components/academy/readingOpened";
import { Callout } from "@/components/academy/ui/Callout";
import { ProgressBar } from "@/components/academy/ui/ProgressBar";
import { StateIcon, type StepState } from "@/components/academy/ui/StateIcon";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { MarkdownView } from "@/components/guide/MarkdownView";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { loadChecks, roleTrackFor, type Question } from "@/content/academy";
import { loadArticles } from "@/content/guide";

export const AdminAcademyLessonPage = defineComponent({
    name: "AdminAcademyLessonPage",
    setup() {
        const { t } = useLocale();
        const route = useRoute();
        const router = useRouter();
        const academy = useAcademyProgress();
        const data = useAcademyData();
        const checks = ref<Question[]>([]);
        const titles = ref<Record<string, string>>({});
        // first-try result per check id, set once the learner has answered it
        const answered = ref<Record<string, boolean>>({});
        const justCompleted = ref(false);

        const lessonId = computed(() => String(route.params.lessonId ?? ""));
        const lesson = computed(() => data.lessons.value.find((l) => l.id === lessonId.value));
        const module = computed(() => data.modules.value.find((m) => m.id === lesson.value?.module));
        const lessonChecks = computed(() =>
            (lesson.value?.checkIds ?? []).map((id) => checks.value.find((c) => c.id === id)).filter((c): c is Question => Boolean(c)),
        );

        onMounted(async () => {
            await data.loadCore(true, true);
            const [loadedChecks, articles] = await Promise.all([loadChecks(), loadArticles("en").catch(() => [])]);
            checks.value = loadedChecks;
            titles.value = Object.fromEntries(articles.map((a) => [a.id, a.title]));
        });
        watch(lessonId, () => {
            answered.value = {};
            justCompleted.value = false;
            window.scrollTo({ top: 0, behavior: "auto" });
        });

        const done = computed(() => academy.lessonDone(lessonId.value));
        const isDone = computed(() => done.value || justCompleted.value);
        const answeredAll = computed(() => checks.value.length > 0 && lessonChecks.value.every((c) => c.id in answered.value));
        const readingOk = computed(() => (lesson.value?.reading ?? []).every((id) => isArticleOpened(id) || academy.guideRead(id)));
        const canComplete = computed(() => answeredAll.value && readingOk.value);
        const visibleChecks = computed(() => {
            const count = Object.keys(answered.value).length;
            return lessonChecks.value.slice(0, count + 1);
        });

        // Numbers behind the "Lesson checklist" aside. A lesson that is already complete counts as fully met.
        const readingTotal = computed(() => lesson.value?.reading.length ?? 0);
        const readingCount = computed(() =>
            isDone.value ? readingTotal.value : (lesson.value?.reading ?? []).filter((id) => isArticleOpened(id) || academy.guideRead(id)).length,
        );
        // Counted from the lesson's own check ids, so the aside is right before the check content has loaded.
        const checkIds = computed(() => lesson.value?.checkIds ?? []);
        const checksTotal = computed(() => checkIds.value.length);
        const checksCount = computed(() => (isDone.value ? checksTotal.value : checkIds.value.filter((id) => id in answered.value).length));
        const stepsTotal = computed(() => readingTotal.value + checksTotal.value + 1);
        const stepsDone = computed(() => readingCount.value + checksCount.value + (isDone.value ? 1 : 0));

        const upcoming = computed<NextStep | null>(() => {
            const id = pickActiveTrack(academy.progress.value, roleTrackFor(userRole()), (x) => academy.badgeState(x, data.meta.value?.recertifyFrom ?? "0.0"));
            const preferred = data.tracks.value.find((tr) => tr.lessonIds.includes(lessonId.value)) ?? data.tracks.value.find((tr) => tr.id === id);
            if (!preferred) return null;
            return nextStep({ track: preferred, modules: data.modules.value, lessons: data.lessons.value, labs: data.labs.value, progress: academy.progress.value });
        });

        const complete = async () => {
            if (!lesson.value || !data.meta.value) return;
            const score = lessonChecks.value.filter((c) => answered.value[c.id]).length as 0 | 1 | 2;
            academy.completeLesson(lesson.value.id, data.meta.value.contentVersion, score);
            justCompleted.value = true;
            await academy.flush();
        };

        /** done / in progress / to do from a "x of y" pair (nothing to do counts as done). */
        const progressState = (x: number, y: number): StepState => (x >= y ? "done" : x > 0 ? "partial" : "todo");

        return () => {
            const l = lesson.value;
            const m = module.value;
            const siblings = m?.lessonIds ?? [];
            const idx = siblings.indexOf(lessonId.value);
            const prevId = idx > 0 ? siblings[idx - 1] : undefined;
            const nextId = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : undefined;
            const lessonTitle = (id?: string) => data.lessons.value.find((x) => x.id === id)?.title ?? "";
            const step = upcoming.value;
            const finished = isDone.value;
            const stateWord = (state: StepState) => (state === "done" ? t("Done") : state === "partial" ? t("In progress") : t("To do"));

            const stepRow = (state: StepState, label: string) => (
                <li class="ac-step">
                    <StateIcon state={state} />
                    <span class="ac-step__main">
                        <span class="ac-step__title">{label}</span>
                    </span>
                    <span class="ac-step__meta">{stateWord(state)}</span>
                </li>
            );

            const header = () => (
                <PageHeader
                    title={l?.title ?? t("Lesson")}
                    subtitle={l ? [m?.title, t("{m} minutes", { m: l.minutes })].filter(Boolean).join(" · ") : ""}
                    breadcrumbs={[
                        m
                            ? { label: m.title, to: router.resolve({ name: "AdminAcademyModule", params: { moduleId: m.id } }).fullPath }
                            : { label: t("My learning"), to: router.resolve({ name: "AdminAcademy" }).fullPath },
                        { label: l?.title ?? t("Lesson") },
                    ]}
                    badge={l && finished ? "COMPLETED" : ""}
                    badgeLabel={t("Completed")}
                    badgeTone="success"
                />
            );

            const tile = (id: string, direction: "prev" | "next") => (
                <RouterLink
                    class={["ac-card", "ac-card--link", "ac-lesson-tile", direction === "next" ? "ac-lesson-tile--next" : ""]}
                    to={{ name: "AdminAcademyLesson", params: { lessonId: id } }}
                >
                    <span class="ac-lesson-tile__dir">
                        {direction === "prev" && <VIcon class="ac-flip" icon="mdi-arrow-left" size={16} aria-hidden="true" />}
                        {direction === "prev" ? t("Previous lesson") : t("Next lesson")}
                        {direction === "next" && <VIcon class="ac-flip" icon="mdi-arrow-right" size={16} aria-hidden="true" />}
                    </span>
                    <span class="ac-lesson-tile__title" dir="auto">
                        {lessonTitle(id)}
                    </span>
                </RouterLink>
            );

            const aside = () => (
                <aside class="ac-aside ac-lesson-aside" aria-label={t("Lesson progress")}>
                    <SurfaceCard class="ac-card" title={t("Lesson checklist")} noPadding>
                        <div class="ac-lesson-progress">
                            <div class="ac-between">
                                <span class="ac-muted">{t("Lesson progress")}</span>
                                <span class="ac-muted ac-num ac-ltr">{percent(stepsDone.value, stepsTotal.value)}%</span>
                            </div>
                            <ProgressBar value={stepsDone.value} max={stepsTotal.value} label={t("Lesson progress")} />
                        </div>
                        <ul class="ac-steps ac-steps--flush" role="list">
                            {readingTotal.value > 0 ? (
                                stepRow(progressState(readingCount.value, readingTotal.value), t("Articles opened: {x} of {y}", { x: readingCount.value, y: readingTotal.value }))
                            ) : (
                                stepRow("done", t("No reading for this lesson."))
                            )}
                            {stepRow(progressState(checksCount.value, checksTotal.value), t("Practice checks answered: {x} of {y}", { x: checksCount.value, y: checksTotal.value }))}
                            {stepRow(finished ? "done" : "todo", t("Lesson complete"))}
                        </ul>
                    </SurfaceCard>
                    {m && m.lessonIds.length > 0 && (
                        <SurfaceCard class="ac-card" title={t("In this module")} subtitle={m.title} noPadding>
                            <ol class="ac-steps ac-steps--flush ac-lesson-outline" role="list">
                                {m.lessonIds.map((id) => {
                                    const sibling = data.lessons.value.find((x) => x.id === id);
                                    const current = id === lessonId.value;
                                    const siblingDone = academy.lessonDone(id) || (current && finished);
                                    const state: StepState = siblingDone ? "done" : current ? "current" : "todo";
                                    return (
                                        <li key={id} class={["ac-step", current ? "ac-step--current" : ""]}>
                                            <StateIcon state={state} />
                                            <span class="ac-step__main">
                                                <RouterLink
                                                    class="ac-step__title"
                                                    to={{ name: "AdminAcademyLesson", params: { lessonId: id } }}
                                                    aria-current={current ? "page" : undefined}
                                                    dir="auto"
                                                >
                                                    {sibling?.title ?? id}
                                                </RouterLink>
                                                <span class="ac-sr-only">{siblingDone ? t("Done") : current ? t("Current lesson") : t("To do")}</span>
                                            </span>
                                            {sibling && (
                                                <span class="ac-step__meta">
                                                    {sibling.minutes} {t("min")}
                                                </span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ol>
                        </SurfaceCard>
                    )}
                </aside>
            );

            const body = () => {
                if (data.failed.value) {
                    return (
                        <SurfaceCard class="ac-card">
                            <EmptyState icon="mdi-alert-circle-outline" title={t("The Academy content could not be loaded. Reload the page.")} />
                        </SurfaceCard>
                    );
                }
                if (!data.ready.value) return <Skeleton rows={3} split />;
                if (!l) {
                    return (
                        <SurfaceCard class="ac-card">
                            <EmptyState icon="mdi-school-outline" title={t("This lesson does not exist.")} />
                        </SurfaceCard>
                    );
                }
                const missing = !answeredAll.value || !readingOk.value;
                return (
                    <div class="ac-split ac-split--reading">
                        <div class="ac-stack ac-lesson-main">
                            <SurfaceCard class="ac-card" noPadding>
                                <article class="ac-lesson-article">
                                    <div class="ac-prose" dir="auto">
                                        <MarkdownView source={lessonProse(l.body)} />
                                    </div>
                                </article>
                            </SurfaceCard>

                            <ReadingList ids={l.reading} titles={titles.value} isRead={(id) => academy.guideRead(id)} />

                            {visibleChecks.value.map((q) => (
                                <LessonCheck
                                    key={q.id}
                                    question={q}
                                    index={lessonChecks.value.indexOf(q)}
                                    total={lessonChecks.value.length}
                                    titles={titles.value}
                                    onAnswered={(firstTry) => (answered.value = { ...answered.value, [q.id]: firstTry })}
                                />
                            ))}

                            <section class="ac-card ac-lesson-finish" aria-labelledby="ac-complete-h">
                                <h2 id="ac-complete-h" class="ac-h2">
                                    {t("Finish this lesson")}
                                </h2>
                                <div aria-live="polite">
                                    {finished ? (
                                        <Callout tone="success" role="none" title={t("Lesson complete.")}>
                                            {academy.unsaved.value ? t("Saved on this device; it will sync when you are online.") : t("Progress saved.")}
                                        </Callout>
                                    ) : missing ? (
                                        <ul class="ac-lesson-missing" role="list">
                                            {!answeredAll.value && (
                                                <li>
                                                    <StateIcon state="todo" />
                                                    <span>{t("Answer both practice checks (any outcome counts).")}</span>
                                                </li>
                                            )}
                                            {!readingOk.value && (
                                                <li>
                                                    <StateIcon state="todo" />
                                                    <span>{t("Open every article in the Read now list.")}</span>
                                                </li>
                                            )}
                                        </ul>
                                    ) : (
                                        <p class="ac-text">{t("Everything is done. Mark the lesson complete to save your progress.")}</p>
                                    )}
                                </div>
                                {(!finished || step) && (
                                    <div class="ac-lesson-finish__actions">
                                        {!finished && (
                                            <VBtn color="primary" prependIcon="mdi-check" disabled={!canComplete.value} onClick={() => void complete()}>
                                                {t("Mark lesson complete")}
                                            </VBtn>
                                        )}
                                        {finished && step && (
                                            <VBtn color="primary" to={{ name: step.route.name, params: step.route.params }}>
                                                {t("Next")}
                                                <VIcon class="ac-flip" icon="mdi-arrow-right" size={18} end aria-hidden="true" />
                                            </VBtn>
                                        )}
                                    </div>
                                )}
                            </section>

                            {(prevId || nextId) && (
                                <nav class="ac-lesson-pager" aria-label={t("Lesson navigation")}>
                                    {prevId && tile(prevId, "prev")}
                                    {nextId && tile(nextId, "next")}
                                </nav>
                            )}
                        </div>
                        {aside()}
                    </div>
                );
            };

            return <AcademyShell header={header}>{body()}</AcademyShell>;
        };
    },
});

export default AdminAcademyLessonPage;
