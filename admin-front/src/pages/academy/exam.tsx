import { dc } from "kt-dc";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useLocale } from "vuetify";
import { AcademyShell } from "@/components/academy/AcademyShell";
import { useAcademyProgress } from "@/components/academy/useAcademyProgress";
import { useEligibility } from "@/components/academy/useEligibility";
import { ExamBriefing } from "@/components/academy/exam/ExamBriefing";
import { ExamRunner, clearExamDraft } from "@/components/academy/exam/ExamRunner";
import { ExamResult } from "@/components/academy/exam/ExamResult";
import { loadExamBlueprints, loadModules, loadPages, loadTracks, type ExamBlueprintPublic } from "@/content/academy";
import type { ExamAnswer, ExamResult as ExamResultPayload, ExamStartResponse } from "@/content/academy/apiTypes";
import { loadArticles } from "@/content/guide";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";

type Stage = "briefing" | "runner" | "result";

const unwrap = <T,>(body: unknown): T => {
    const rec = body as { data?: unknown } | null;
    return (rec && typeof rec === "object" && "data" in rec && rec.data && typeof rec.data === "object" ? rec.data : body) as T;
};

const errorCode = (error: unknown): string => {
    const data = (error as { response?: { data?: unknown } })?.response?.data;
    let text = "";
    try {
        text = typeof data === "string" ? data : JSON.stringify(data ?? {});
    } catch {
        text = "";
    }
    return text.match(/ACADEMY_[A-Z_]+/)?.[0] ?? "";
};

const ExamPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const examId = computed(() => String(route.params.examId ?? ""));
    const academy = useAcademyProgress();
    const { eligibility, loading: eligibilityLoading, error: eligibilityError, refresh } = useEligibility(examId);

    const stage = ref<Stage>("briefing");
    const initialising = ref(true);
    const blueprint = ref<ExamBlueprintPublic | null>(null);
    const trackId = ref<string>("");
    const trackTitle = ref("");
    const moduleTitles = ref<Record<string, string>>({});
    const articleTitles = ref<Record<string, string>>({});
    const integrityText = ref("");
    const session = ref<ExamStartResponse | null>(null);
    const result = ref<ExamResultPayload | null>(null);
    const starting = ref(false);
    const startError = ref<string | null>(null);
    const submitting = ref(false);
    const submitError = ref<string | null>(null);

    const openSession = computed(() => {
        const open = academy.progress.value.exams[examId.value]?.open;
        return open && Date.parse(open.expiresAt) > Date.now() ? open : null;
    });

    const startExam = async () => {
        starting.value = true;
        startError.value = null;
        try {
            const response = await api.post(urlsMap.academyExamStart(examId.value), { integrityAccepted: true });
            const payload = unwrap<ExamStartResponse>(response.data);
            if (!payload || !Array.isArray(payload.questions) || !payload.sessionId) throw new Error("bad-response");
            session.value = payload;
            stage.value = "runner";
            void academy.load(true);
        } catch (error) {
            const code = errorCode(error);
            if (code === "ACADEMY_NOT_ELIGIBLE") startError.value = t("You do not meet the requirements for this exam yet. The list above shows what is left.");
            else if (!(error as { response?: unknown }).response) startError.value = t("We could not reach the server. Please check your connection and try again.");
            else startError.value = t("The exam could not be started. Please try again in a moment.");
            void refresh();
            void academy.load(true);
        } finally {
            starting.value = false;
        }
    };

    const submit = async (answers: Record<string, ExamAnswer>) => {
        if (!session.value || submitting.value) return;
        const current = session.value;
        submitting.value = true;
        submitError.value = null;
        try {
            const response = await api.post(urlsMap.academyExamSubmit(examId.value), { sessionId: current.sessionId, answers });
            const payload = unwrap<ExamResultPayload>(response.data);
            if (!payload || !Array.isArray(payload.items)) throw new Error("bad-response");
            result.value = payload;
            clearExamDraft(current.sessionId);
            session.value = null;
            stage.value = "result";
            void academy.load(true);
            void loadArticles()
                .then((articles) => {
                    articleTitles.value = Object.fromEntries(articles.map((a) => [a.id, a.title]));
                })
                .catch(() => undefined);
        } catch (error) {
            const code = errorCode(error);
            const closed = {
                ACADEMY_SESSION_EXPIRED: t("This exam session has expired, so these answers could not be graded. That is not a judgement on you: start again when you are ready."),
                ACADEMY_SESSION_USED: t("This exam session was already submitted, so it cannot be submitted again. Your result is in your progress record."),
                ACADEMY_NOT_ELIGIBLE: t("You are not eligible to take this exam right now. The list shows what is left to do."),
            }[code];
            if (closed) {
                clearExamDraft(current.sessionId);
                session.value = null;
                stage.value = "briefing";
                startError.value = closed;
                void refresh();
                void academy.load(true);
            } else if (!(error as { response?: unknown }).response) {
                submitError.value = t("We could not reach the server.");
            } else {
                submitError.value = t("The submission did not go through.");
            }
        } finally {
            submitting.value = false;
        }
    };

    onMounted(async () => {
        try {
            const [blueprints, modules, pages, tracks] = await Promise.all([loadExamBlueprints(), loadModules(), loadPages(), loadTracks(), academy.load()]);
            blueprint.value = blueprints.find((b) => b.id === examId.value) ?? null;
            moduleTitles.value = Object.fromEntries(modules.map((m) => [m.id, m.title]));
            integrityText.value = pages.find((p) => p.id === "page-integrity")?.markdown ?? "";
            const track = tracks.find((tr) => tr.examId === examId.value || tr.id === blueprint.value?.track);
            trackId.value = track?.id ?? "";
            trackTitle.value = track?.title ?? "";
        } finally {
            initialising.value = false;
        }
        // Reload / new tab: the server returns the same session while it is open.
        if (blueprint.value && openSession.value && academy.progress.value.integrityAcceptedAt) void startExam();
    });

    return () => {
        const title = trackTitle.value ? `${trackTitle.value} — ${t("certification exam")}` : t("Certification exam");
        return (
            <AcademyShell
                title={title}
                backTo={trackId.value ? { name: "AdminAcademyTrack", params: { trackId: trackId.value }, label: t("Back to track") } : { name: "AdminAcademy", label: t("Back to Academy") }}
            >
                {initialising.value || (starting.value && stage.value === "briefing" && !startError.value && openSession.value && academy.progress.value.integrityAcceptedAt && !session.value) ? (
                    <div role="status" aria-busy="true" style={{ blockSize: "120px", borderRadius: "12px", background: "var(--pg-bg-surface-subtle)", maxInlineSize: "860px", display: "grid", placeItems: "center" }}>
                        {t("Loading")}…
                    </div>
                ) : stage.value === "runner" && session.value ? (
                    <ExamRunner key={session.value.sessionId} session={session.value} submitting={submitting.value} submitError={submitError.value} onSubmit={submit} />
                ) : stage.value === "result" && result.value ? (
                    <ExamResult result={result.value} trackTitle={trackTitle.value} moduleTitles={moduleTitles.value} articleTitles={articleTitles.value} />
                ) : (
                    <ExamBriefing
                        blueprint={blueprint.value}
                        trackTitle={trackTitle.value}
                        moduleTitles={moduleTitles.value}
                        eligibility={eligibility.value}
                        eligibilityLoading={eligibilityLoading.value}
                        eligibilityError={eligibilityError.value}
                        onRetryEligibility={() => void refresh()}
                        integrityText={integrityText.value}
                        open={openSession.value}
                        starting={starting.value}
                        startError={startError.value}
                        onStart={() => void startExam()}
                    />
                )}
            </AcademyShell>
        );
    };
});

export default ExamPage;
