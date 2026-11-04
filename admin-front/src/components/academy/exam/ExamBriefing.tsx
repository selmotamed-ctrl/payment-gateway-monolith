import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import type { Eligibility, OpenExamSession } from "@/content/academy/apiTypes";
import type { ExamBlueprintPublic } from "@/content/academy";

export const fmtDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

export const fmtDate = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(date);
};

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

const cardStyle = { display: "flex", flexDirection: "column", gap: "10px" } as const;
const factStyle = { display: "flex", flexDirection: "column", gap: "2px", minInlineSize: "120px" } as const;

export const ExamBriefing = dc((props: Props) => {
    const { t } = useLocale();
    const accepted = ref(false);

    const blockers = computed(() => (props.eligibility?.missing ?? []).filter((item) => item.kind !== "open_session" && item.kind !== "cooldown"));
    const cooldownMs = computed(() => {
        const until = props.eligibility?.cooldownUntil ? Date.parse(props.eligibility.cooldownUntil) : 0;
        return until > Date.now() ? until - Date.now() : 0;
    });
    const canStart = computed(() => Boolean(props.open) || (props.eligibility !== null && blockers.value.length === 0 && cooldownMs.value === 0));

    return () => {
        const bp = props.blueprint;
        const minutesLeft = Math.ceil(cooldownMs.value / 60000);
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxInlineSize: "860px" }}>
                <SurfaceCard>
                    <SurfaceCardText style={cardStyle}>
                        <h2 style={{ fontSize: "18px", margin: 0 }}>{t("About this exam")}</h2>
                        {bp ? (
                            <>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "20px" }}>
                                    <div style={factStyle}><span style={{ opacity: 0.65, fontSize: "12px" }}>{t("Questions")}</span><strong>{bp.questionCount}</strong></div>
                                    <div style={factStyle}><span style={{ opacity: 0.65, fontSize: "12px" }}>{t("Pass mark")}</span><strong>{bp.passPercent}%</strong></div>
                                    <div style={factStyle}><span style={{ opacity: 0.65, fontSize: "12px" }}>{t("Time limit")}</span><strong>{bp.timeLimitMinutes} {t("minutes")}</strong></div>
                                    <div style={factStyle}><span style={{ opacity: 0.65, fontSize: "12px" }}>{t("Wait after a failed attempt")}</span><strong>{bp.cooldownMinutes} {t("minutes")}</strong></div>
                                </div>
                                <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.6 }}>
                                    {t("Missing any question marked critical fails the exam, whatever your percentage. Questions come one at a time and you can go back, flag questions for review and change answers until you submit. Only the server grades your answers.")}
                                </p>
                                <div>
                                    <strong style={{ fontSize: "13px" }}>{t("What is covered")}</strong>
                                    <ul style={{ margin: "6px 0 0", paddingInlineStart: "20px", fontSize: "13px", lineHeight: 1.7 }}>
                                        {bp.composition.map((entry) => (
                                            <li key={entry.module}>{props.moduleTitles[entry.module] ?? entry.module} — {entry.count} {t("questions")}</li>
                                        ))}
                                    </ul>
                                </div>
                            </>
                        ) : (
                            <p style={{ margin: 0 }}>{t("This exam could not be found.")}</p>
                        )}
                    </SurfaceCardText>
                </SurfaceCard>

                <SurfaceCard>
                    <SurfaceCardText style={cardStyle}>
                        <h2 style={{ fontSize: "18px", margin: 0 }}>{t("Before you start")}</h2>
                        <div aria-live="polite">
                            {props.eligibilityLoading && !props.eligibility ? (
                                <div style={{ blockSize: "48px", borderRadius: "8px", background: "var(--pg-bg-surface-subtle)" }} aria-busy="true">
                                    <span style={{ position: "absolute", insetInlineStart: "-9999px" }}>{t("Loading")}</span>
                                </div>
                            ) : props.eligibilityError ? (
                                <div role="alert" style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                                    <span>{t("We could not check your requirements.")} {props.eligibilityError}</span>
                                    <VBtn size="small" variant="outlined" onClick={props.onRetryEligibility}>{t("Retry")}</VBtn>
                                </div>
                            ) : props.open ? (
                                <p style={{ margin: 0 }}>✓ {t("You have an exam in progress. Resume it to carry on with the same questions. It closes at")} <strong>{fmtDateTime(props.open.expiresAt)}</strong>.</p>
                            ) : blockers.value.length === 0 && cooldownMs.value === 0 ? (
                                <p style={{ margin: 0 }}>✓ {t("You meet every requirement for this exam.")}</p>
                            ) : (
                                <div>
                                    <p style={{ margin: "0 0 6px" }}>{t("Please finish these first. Nothing is lost, and you can come back any time.")}</p>
                                    <ul style={{ margin: 0, paddingInlineStart: "20px", lineHeight: 1.7 }}>
                                        {blockers.value.map((item) => (
                                            <li key={`${item.kind}-${item.id}`}><span aria-hidden="true">✗ </span>{item.text}</li>
                                        ))}
                                        {cooldownMs.value > 0 && (
                                            <li><span aria-hidden="true">✗ </span>{t("You can try again at")} {fmtDateTime(props.eligibility?.cooldownUntil)} ({minutesLeft} {t("minutes from now")}).</li>
                                        )}
                                    </ul>
                                </div>
                            )}
                            {(props.eligibility?.reviewRequired ?? []).length > 0 && (
                                <p style={{ margin: "8px 0 0" }}>
                                    {t("Please re-read these modules before the next attempt")}: {(props.eligibility?.reviewRequired ?? []).map((id) => props.moduleTitles[id] ?? id).join(", ")}.
                                </p>
                            )}
                        </div>
                    </SurfaceCardText>
                </SurfaceCard>

                <SurfaceCard>
                    <SurfaceCardText style={cardStyle}>
                        <h2 style={{ fontSize: "18px", margin: 0 }}>{t("Integrity statement")}</h2>
                        <GuideMarkdown source={props.integrityText} />
                        <label style={{ display: "flex", gap: "10px", alignItems: "flex-start", cursor: "pointer", fontWeight: 600 }}>
                            <input
                                type="checkbox"
                                checked={accepted.value}
                                style={{ inlineSize: "20px", blockSize: "20px", marginBlockStart: "2px" }}
                                onChange={(event: Event) => (accepted.value = (event.target as HTMLInputElement).checked)}
                            />
                            <span>{t("I have read and I agree to this integrity statement.")}</span>
                        </label>
                        {props.startError && <div role="alert" style={{ color: "var(--pg-status-danger-text)" }}>{props.startError}</div>}
                        <div>
                            <VBtn color="primary" disabled={!accepted.value || !canStart.value || props.starting} loading={props.starting} onClick={props.onStart}>
                                {props.open ? t("Resume exam") : t("Start exam")}
                            </VBtn>
                        </div>
                    </SurfaceCardText>
                </SurfaceCard>
            </div>
        );
    };
});
