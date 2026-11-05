import { dc } from "kt-dc";
import { computed, ref, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { ExamBlueprintPublic } from "@/content/academy";
import type { Eligibility, OpenExamSession } from "@/content/academy/apiTypes";
import { fmtDateTime } from "../format";
import { Callout } from "../ui/Callout";
import { ProgressBar } from "../ui/ProgressBar";
import { StateIcon } from "../ui/StateIcon";

/** Date helpers moved to `components/academy/format.ts`; re-exported here until every importer migrates. */
export { fmtDate, fmtDateTime } from "../format";

type Props = {
    blueprint: ExamBlueprintPublic | null;
    trackTitle: string;
    moduleTitles: Record<string, string>;
    eligibility: Eligibility | null;
    eligibilityLoading: boolean;
    eligibilityError: string | null;
    onRetryEligibility: () => void;
    integrityText: string;
    open: OpenExamSession | null;
    starting: boolean;
    startError: string | null;
    onStart: () => void;
};

export const ExamBriefing = dc((props: Props) => {
    const { t } = useLocale();
    const accepted = ref(false);

    const blockers = computed(() => (props.eligibility?.missing ?? []).filter((item) => item.kind !== "open_session" && item.kind !== "cooldown"));
    const cooldownMs = computed(() => {
        const until = props.eligibility?.cooldownUntil ? Date.parse(props.eligibility.cooldownUntil) : 0;
        return until > Date.now() ? until - Date.now() : 0;
    });
    const canStart = computed(() => Boolean(props.open) || (props.eligibility !== null && blockers.value.length === 0 && cooldownMs.value === 0));

    /** One requirement row: state icon, the text, and the state in words (colour and icon are never the only signal). */
    const requirementRow = (key: string, state: "done" | "current" | "todo" | "locked", word: string, body: VNodeChild) => (
        <li key={key} class="ac-step">
            <StateIcon state={state} />
            <div class="ac-step__main">
                <span class="ac-step__title">{body}</span>
            </div>
            <span class="ac-step__meta">{word}</span>
        </li>
    );

    const renderRequirements = () => {
        if (props.eligibilityLoading && !props.eligibility) {
            return (
                <div role="status" aria-busy="true">
                    <div class="ac-skel ac-exam-skel" />
                    <span class="ac-sr-only">{t("Loading…")}</span>
                </div>
            );
        }
        if (props.eligibilityError) {
            return (
                <Callout tone="danger">
                    <div class="ac-between">
                        <span>
                            {t("We could not check your requirements.")} {props.eligibilityError}
                        </span>
                        <VBtn size="small" variant="outlined" onClick={props.onRetryEligibility}>
                            {t("Retry")}
                        </VBtn>
                    </div>
                </Callout>
            );
        }
        if (props.open) {
            return (
                <ul class="ac-steps">
                    {requirementRow(
                        "open",
                        "current",
                        t("In progress"),
                        <>
                            {t("You have an exam in progress. Resume it to carry on with the same questions. It closes at")} <strong>{fmtDateTime(props.open.expiresAt)}</strong>.
                        </>,
                    )}
                </ul>
            );
        }
        if (blockers.value.length === 0 && cooldownMs.value === 0) {
            return <ul class="ac-steps">{requirementRow("met", "done", t("Done"), t("You meet every requirement for this exam."))}</ul>;
        }
        const minutesLeft = Math.ceil(cooldownMs.value / 60000);
        return (
            <div class="ac-stack ac-stack--sm">
                <p class="ac-text">{t("Please finish these first. Nothing is lost, and you can come back any time.")}</p>
                <ul class="ac-steps">
                    {blockers.value.map((item) => requirementRow(`${item.kind}-${item.id}`, "todo", t("To do"), item.text))}
                    {cooldownMs.value > 0 &&
                        requirementRow(
                            "cooldown",
                            "locked",
                            t("Locked"),
                            <>
                                {t("You can try again at")} <span class="ac-num">{fmtDateTime(props.eligibility?.cooldownUntil)}</span> (<span class="ac-num">{minutesLeft}</span> {t("minutes from now")}).
                            </>,
                        )}
                </ul>
            </div>
        );
    };

    const renderCoverage = (bp: ExamBlueprintPublic) => {
        const largest = Math.max(1, ...bp.composition.map((entry) => entry.count));
        return (
            <ul class="ac-steps ac-exam-cover">
                {bp.composition.map((entry) => {
                    const title = props.moduleTitles[entry.module] ?? entry.module;
                    return (
                        <li key={entry.module} class="ac-step">
                            <div class="ac-step__main">
                                <span class="ac-step__title">{title}</span>
                                <ProgressBar value={entry.count} max={largest} tone="info" label={`${title}: ${entry.count} ${t("questions")}`} />
                            </div>
                            <span class="ac-step__meta">
                                {entry.count} {t("questions")}
                            </span>
                        </li>
                    );
                })}
            </ul>
        );
    };

    return () => {
        const bp = props.blueprint;
        const reviewRequired = props.eligibility?.reviewRequired ?? [];
        return (
            <>
                {bp && (
                    <MetricStrip
                        items={[
                            { key: "questions", label: t("Questions"), value: bp.questionCount },
                            { key: "pass", label: t("Pass mark"), value: `${bp.passPercent}%` },
                            { key: "time", label: t("Time limit"), value: `${bp.timeLimitMinutes} ${t("minutes")}` },
                            { key: "wait", label: t("Wait after a failed attempt"), value: `${bp.cooldownMinutes} ${t("minutes")}` },
                        ]}
                    />
                )}
                <div class="ac-split">
                    <div class="ac-stack">
                        <SurfaceCard class="ac-card" title={t("Before you start")}>
                            <div class="ac-stack ac-stack--sm" aria-live="polite">
                                {renderRequirements()}
                                {reviewRequired.length > 0 && (
                                    <Callout tone="warning" role="none" icon="mdi-book-open-page-variant-outline">
                                        {t("Please re-read these modules before the next attempt")}: {reviewRequired.map((id) => props.moduleTitles[id] ?? id).join(", ")}.
                                    </Callout>
                                )}
                            </div>
                        </SurfaceCard>

                        <SurfaceCard class="ac-card" title={t("Integrity statement")}>
                            <div class="ac-stack">
                                <div class="ac-prose" dir="auto">
                                    <GuideMarkdown source={props.integrityText} />
                                </div>
                                <label class={["ac-choice", "ac-exam-accept", accepted.value ? "ac-choice--selected" : ""]}>
                                    <input
                                        type="checkbox"
                                        checked={accepted.value}
                                        onChange={(event: Event) => (accepted.value = (event.target as HTMLInputElement).checked)}
                                    />
                                    <span class="ac-choice__label">{t("I have read and I agree to this integrity statement.")}</span>
                                </label>
                                {props.startError && <Callout tone="danger">{props.startError}</Callout>}
                                <div>
                                    <VBtn color="primary" disabled={!accepted.value || !canStart.value || props.starting} loading={props.starting} onClick={props.onStart}>
                                        {props.open ? t("Resume exam") : t("Start exam")}
                                    </VBtn>
                                </div>
                            </div>
                        </SurfaceCard>
                    </div>

                    <aside class="ac-aside">
                        <SurfaceCard class="ac-card" title={t("About this exam")}>
                            {bp ? (
                                <div class="ac-stack">
                                    <p class="ac-text">
                                        {t(
                                            "Missing any question marked critical fails the exam, whatever your percentage. Questions come one at a time and you can go back, flag questions for review and change answers until you submit. Only the server grades your answers.",
                                        )}
                                    </p>
                                    <div class="ac-stack ac-stack--sm">
                                        <h3 class="ac-h3">{t("What is covered")}</h3>
                                        {renderCoverage(bp)}
                                    </div>
                                </div>
                            ) : (
                                <p class="ac-text">{t("This exam could not be found.")}</p>
                            )}
                        </SurfaceCard>
                    </aside>
                </div>
            </>
        );
    };
}, { props: ["blueprint", "trackTitle", "moduleTitles", "eligibility", "eligibilityLoading", "eligibilityError", "onRetryEligibility", "integrityText", "open", "starting", "startError", "onStart"] });
