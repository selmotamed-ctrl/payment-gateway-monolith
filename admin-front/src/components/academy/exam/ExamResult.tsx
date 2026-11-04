import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { RouterLink } from "vue-router";
import { VBtn } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import type { ExamResult as ExamResultPayload, ExamResultItem } from "@/content/academy/apiTypes";
import { fmtDate, fmtDateTime } from "./ExamBriefing";

type Props = {
    result: ExamResultPayload;
    trackTitle: string;
    moduleTitles: Record<string, string>;
    articleTitles: Record<string, string>;
};

const mark = (ok: boolean) => (ok ? "✓" : "✗");
const tone = (ok: boolean) => (ok ? "success" : "danger");

const Bar = ({ value, label }: { value: number; label: string }) => (
    <div style={{ flex: 1, minInlineSize: "120px", blockSize: "10px", borderRadius: "5px", background: "var(--pg-bg-surface-subtle)", border: "1px solid var(--pg-border-subtle)", overflow: "hidden" }} role="img" aria-label={label}>
        <div style={{ inlineSize: `${Math.min(100, Math.max(0, value))}%`, blockSize: "100%", background: value >= 70 ? "var(--pg-status-success-text)" : "var(--pg-status-danger-text)" }} />
    </div>
);

export const ExamResult = dc((props: Props) => {
    const { t } = useLocale();

    const renderItem = (item: ExamResultItem, index: number) => {
        const optionText = (oid: string) => item.order?.items.find((o) => o.oid === oid)?.text ?? oid;
        return (
            <li key={item.qid} style={{ listStyle: "none", padding: "14px", border: "1px solid var(--pg-border-subtle)", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    <strong style={{ color: `var(--pg-status-${tone(item.correct)}-text)` }}>
                        {mark(item.correct)} {item.correct ? t("Correct") : item.answered ? t("Incorrect") : t("Not answered")}
                    </strong>
                    {item.critical && <span style={{ padding: "1px 8px", border: "1px solid var(--pg-status-warning-border)", background: "var(--pg-status-warning-bg)", color: "var(--pg-status-warning-text)", borderRadius: "999px", fontSize: "12px" }}>⚠ {t("critical")}</span>}
                    <span style={{ fontSize: "12px", opacity: 0.7 }}>{props.moduleTitles[item.module] ?? item.module}</span>
                </div>
                <div style={{ fontWeight: 600, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{index + 1}. {item.stem}</div>

                {item.options && (
                    <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
                        {item.options.map((o) => (
                            <li key={o.oid} style={{ listStyle: "none", padding: "8px 10px", borderRadius: "8px", border: `1px solid ${o.correct ? "var(--pg-status-success-border)" : o.selected ? "var(--pg-status-danger-border)" : "var(--pg-border-subtle)"}` }}>
                                <div>
                                    <span aria-hidden="true">{o.correct ? "✓" : o.selected ? "✗" : "•"} </span>
                                    {o.text}
                                    {o.selected && <em style={{ opacity: 0.75 }}> — {t("your answer")}</em>}
                                    {o.correct && <em style={{ opacity: 0.75 }}> — {t("correct answer")}</em>}
                                </div>
                                {o.note && <div style={{ fontSize: "12px", opacity: 0.8, marginBlockStart: "4px" }}>{o.note}</div>}
                            </li>
                        ))}
                    </ul>
                )}

                {item.order && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "24px" }}>
                        <div>
                            <strong style={{ fontSize: "13px" }}>{t("Your order")}</strong>
                            {item.order.yourOrder.length === 0 ? <div style={{ opacity: 0.7 }}>{t("Not answered")}</div> : (
                                <ol style={{ margin: "4px 0 0", paddingInlineStart: "22px" }}>{item.order.yourOrder.map((oid) => <li key={oid}>{optionText(oid)}</li>)}</ol>
                            )}
                        </div>
                        <div>
                            <strong style={{ fontSize: "13px" }}>{t("Correct order")}</strong>
                            <ol style={{ margin: "4px 0 0", paddingInlineStart: "22px" }}>{item.order.correctOrder.map((oid) => <li key={oid}>{optionText(oid)}</li>)}</ol>
                        </div>
                    </div>
                )}

                {item.number && (
                    <div style={{ lineHeight: 1.7 }}>
                        <div>{t("Your answer")}: <strong dir="ltr">{item.number.yourAnswer ?? "—"}</strong></div>
                        <div>{t("Correct answer")}: <strong dir="ltr">{item.number.correctAnswer}</strong>{item.number.tolerance ? <span> ({t("tolerance")} <span dir="ltr">{item.number.tolerance}</span>)</span> : null}</div>
                    </div>
                )}

                {item.why && <div style={{ fontSize: "13px", lineHeight: 1.6 }}><strong>{t("Why")}: </strong>{item.why}</div>}
                {item.refs.length > 0 && (
                    <div style={{ fontSize: "13px" }}>
                        <strong>{t("Guide references")}: </strong>
                        {item.refs.map((ref, i) => (
                            <span key={ref}>
                                {i > 0 ? ", " : ""}
                                <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: ref } }}>{props.articleTitles[ref] ?? ref}</RouterLink>
                            </span>
                        ))}
                    </div>
                )}
            </li>
        );
    };

    return () => {
        const r = props.result;
        const modules = Object.entries(r.moduleScores);
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxInlineSize: "900px" }}>
                <div
                    role="status"
                    aria-live="polite"
                    style={{ padding: "16px", borderRadius: "12px", border: `1px solid var(--pg-status-${tone(r.passed)}-border)`, background: `var(--pg-status-${tone(r.passed)}-bg)`, color: `var(--pg-status-${tone(r.passed)}-text)` }}
                >
                    <div style={{ fontSize: "20px", fontWeight: 700 }}>
                        {mark(r.passed)} {r.passed ? t("You passed") : t("Not passed this time")} — {r.scorePercent}%
                    </div>
                    <div style={{ marginBlockStart: "4px" }}>
                        {t("Pass mark")}: {r.passPercent}% · {t("Attempt")} {r.attemptNumber} · {props.trackTitle}
                    </div>
                    {r.expired && <div style={{ marginBlockStart: "6px" }}>{t("This submission arrived after the time limit, so it was not scored.")}</div>}
                    {!r.passed && !r.expired && r.scorePercent >= r.passPercent && r.criticalMissed > 0 && (
                        <div style={{ marginBlockStart: "6px" }}>{t("Your percentage was high enough, but a critical question was missed.")}</div>
                    )}
                    {!r.passed && <div style={{ marginBlockStart: "6px" }}>{t("This is part of learning. Review the topics below and try again when you are ready.")}</div>}
                </div>

                <SurfaceCard>
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
                            <div><div style={{ fontSize: "12px", opacity: 0.65 }}>{t("Score")}</div><strong>{r.scorePercent}%</strong></div>
                            <div><div style={{ fontSize: "12px", opacity: 0.65 }}>{t("Pass mark")}</div><strong>{r.passPercent}%</strong></div>
                            <div><div style={{ fontSize: "12px", opacity: 0.65 }}>{t("Critical questions missed")}</div><strong>{r.criticalMissed}</strong></div>
                            <div><div style={{ fontSize: "12px", opacity: 0.65 }}>{t("Time taken")}</div><strong>{Math.floor(r.durationSeconds / 60)} {t("min")} {r.durationSeconds % 60} {t("sec")}</strong></div>
                        </div>
                        <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.6 }}>
                            {t("Critical questions cover things that could cause real harm if misunderstood. Missing any one of them fails the exam regardless of the percentage.")}
                        </p>
                        {!r.passed && r.cooldownUntil && (
                            <p style={{ margin: 0, fontWeight: 600 }}>{t("You can try again at")} {fmtDateTime(r.cooldownUntil)}.</p>
                        )}
                    </SurfaceCardText>
                </SurfaceCard>

                {r.passed && r.badge && (
                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                            <h2 style={{ fontSize: "18px", margin: 0 }}>🏅 {props.trackTitle}</h2>
                            <div>{t("Badge earned")} {fmtDate(r.badge.earnedAt)} · {t("valid until")} {fmtDate(r.badge.expiresAt)}</div>
                            <div><VBtn color="primary" to={{ name: "AdminAcademyCertificate", params: { badgeId: r.badge.id } }}>{t("View certificate")}</VBtn></div>
                        </SurfaceCardText>
                    </SurfaceCard>
                )}

                <SurfaceCard>
                    <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                        <h2 style={{ fontSize: "18px", margin: 0 }}>{t("Score by module")}</h2>
                        {modules.map(([id, value]) => (
                            <div key={id} style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                                <span style={{ flex: "0 1 280px", minInlineSize: "140px" }}>{props.moduleTitles[id] ?? id}</span>
                                <Bar value={value} label={`${props.moduleTitles[id] ?? id}: ${value}%`} />
                                <strong style={{ minInlineSize: "48px" }}>{value}%</strong>
                            </div>
                        ))}
                        {r.reviewRequired.length > 0 && (
                            <div>
                                <strong>{t("Worth a second look (below 70%)")}</strong>
                                <ul style={{ margin: "4px 0 0", paddingInlineStart: "20px", lineHeight: 1.8 }}>
                                    {r.reviewRequired.map((id) => (
                                        <li key={id}><RouterLink to={{ name: "AdminAcademyModule", params: { moduleId: id } }}>{props.moduleTitles[id] ?? id}</RouterLink></li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </SurfaceCardText>
                </SurfaceCard>

                <section aria-labelledby="exam-review-heading" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <h2 id="exam-review-heading" style={{ fontSize: "18px", margin: 0 }}>{t("Your answers, question by question")}</h2>
                    <p style={{ margin: 0, fontSize: "13px", opacity: 0.8 }}>{t("These answers are shown only to you, only now. Please do not share them.")}</p>
                    <ol style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "10px" }}>{r.items.map(renderItem)}</ol>
                </section>
            </div>
        );
    };
});
