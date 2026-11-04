import { computed, defineComponent, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell, Skeleton, fmt, useAcademyData, userRole } from "@/components/academy/AcademyShell";
import { LessonCheck } from "@/components/academy/LessonCheck";
import { ReadingList } from "@/components/academy/ReadingList";
import { nextStep, pickActiveTrack, type NextStep } from "@/components/academy/nextStep";
import { isArticleOpened } from "@/components/academy/readingOpened";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { MarkdownView } from "@/components/guide/MarkdownView";
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
        const answeredAll = computed(() => checks.value.length > 0 && lessonChecks.value.every((c) => c.id in answered.value));
        const readingOk = computed(() => (lesson.value?.reading ?? []).every((id) => isArticleOpened(id) || academy.guideRead(id)));
        const canComplete = computed(() => answeredAll.value && readingOk.value);
        const visibleChecks = computed(() => {
            const count = Object.keys(answered.value).length;
            return lessonChecks.value.slice(0, count + 1);
        });

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

        return () => {
            const l = lesson.value;
            const siblings = module.value?.lessonIds ?? [];
            const idx = siblings.indexOf(lessonId.value);
            const prevId = idx > 0 ? siblings[idx - 1] : undefined;
            const nextId = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : undefined;
            const lessonTitle = (id?: string) => data.lessons.value.find((x) => x.id === id)?.title ?? "";
            const step = upcoming.value;

            const body = () => {
                if (data.failed.value) return <p class="ac-card">{t("The Academy content could not be loaded. Reload the page.")}</p>;
                if (!data.ready.value) return <Skeleton rows={3} />;
                if (!l) return <p class="ac-card">{t("This lesson does not exist.")}</p>;
                return (
                    <>
                        <article class="ac-card">
                            <MarkdownView source={l.body} compact />
                        </article>
                        <ReadingList ids={l.reading} titles={titles.value} isRead={(id) => academy.guideRead(id)} />
                        {lessonChecks.value.length > 0 && (
                            <>
                                {visibleChecks.value.map((q) => (
                                    <LessonCheck
                                        key={q.id}
                                        question={q}
                                        index={lessonChecks.value.indexOf(q)}
                                        titles={titles.value}
                                        onAnswered={(firstTry) => (answered.value = { ...answered.value, [q.id]: firstTry })}
                                    />
                                ))}
                            </>
                        )}
                        <section class="ac-card" aria-labelledby="ac-complete-h">
                            <h2 id="ac-complete-h" class="ac-h2">{t("Finish this lesson")}</h2>
                            <div aria-live="polite">
                                {done.value || justCompleted.value ? (
                                    <p class="ac-result--good"><strong>✓ {t("Lesson complete.")}</strong> {academy.unsaved.value ? t("Saved on this device; it will sync when you are online.") : t("Progress saved.")}</p>
                                ) : (
                                    <ul class="ac-missing">
                                        {!answeredAll.value && <li>{t("Answer both practice checks (any outcome counts).")}</li>}
                                        {!readingOk.value && <li>{t("Open every article in the Read now list.")}</li>}
                                    </ul>
                                )}
                            </div>
                            <div class="ac-actions">
                                {!(done.value || justCompleted.value) && (
                                    <button type="button" class="ac-btn" disabled={!canComplete.value} onClick={() => void complete()}>
                                        {t("Mark lesson complete")}
                                    </button>
                                )}
                                {(done.value || justCompleted.value) && step && (
                                    <RouterLink class="ac-btn" to={{ name: step.route.name, params: step.route.params }}>
                                        {t("Next")} →
                                    </RouterLink>
                                )}
                            </div>
                        </section>
                        <nav class="ac-pager" aria-label={t("Lesson navigation")}>
                            {prevId ? (
                                <RouterLink to={{ name: "AdminAcademyLesson", params: { lessonId: prevId } }}>← {lessonTitle(prevId)}</RouterLink>
                            ) : <span />}
                            {nextId ? (
                                <RouterLink to={{ name: "AdminAcademyLesson", params: { lessonId: nextId } }}>{lessonTitle(nextId)} →</RouterLink>
                            ) : <span />}
                        </nav>
                    </>
                );
            };
            return (
                <AcademyShell
                    title={l?.title ?? t("Lesson")}
                    subtitle={l ? fmt(t("{m} minutes"), { m: l.minutes }) : undefined}
                    backTo={module.value ? { name: "AdminAcademyModule", params: { moduleId: module.value.id }, label: module.value.title } : { name: "AdminAcademy", label: t("My learning") }}
                >
                    {body()}
                </AcademyShell>
            );
        };
    },
});

export default AdminAcademyLessonPage;
