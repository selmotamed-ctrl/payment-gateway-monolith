import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetaPill } from "@/components/ui/MetaPill";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { ExamResult as ExamResultPayload, ExamResultItem } from "@/content/academy/apiTypes";
import { fmtDate, fmtDateTime } from "../format";
import { Callout } from "../ui/Callout";
import { IconTile } from "../ui/IconTile";
import { ProgressBar } from "../ui/ProgressBar";

type Props = {
    result: ExamResultPayload;
    trackTitle: string;
    moduleTitles: Record<string, string>;
    articleTitles: Record<string, string>;
};

type Filter = "all" | "incorrect" | "critical";

/** Module scores below this are "worth a second look" (same threshold the server uses for `reviewRequired`). */
const MODULE_PASS = 70;

export const ExamResult = dc((props: Props) => {
    const { t } = useLocale();
    const filter = ref<Filter>("all");

    const indexed = computed(() => props.result.items.map((item, index) => ({ item, index })));
    const counts = computed(() => ({
        all: props.result.items.length,
        incorrect: props.result.items.filter((item) => !item.correct).length,
        critical: props.result.items.filter((item) => item.critical).length,
    }));
    const visible = computed(() =>
        indexed.value.filter(({ item }) => (filter.value === "incorrect" ? !item.correct : filter.value === "critical" ? item.critical : true)),
    );

    const renderItem = (item: ExamResultItem, index: number) => {
        const optionText = (oid: string) => item.order?.items.find((o) => o.oid === oid)?.text ?? oid;
        const verdict = item.correct ? "good" : item.answered ? "bad" : "muted";
        const verdictIcon = item.correct ? "mdi-check-circle" : item.answered ? "mdi-close-circle" : "mdi-minus-circle-outline";
        const verdictWord = item.correct ? t("Correct") : item.answered ? t("Incorrect") : t("Not answered");
        return (
            <li key={item.qid}>
                <SurfaceCard class="ac-card">
                    <div class="ac-stack ac-stack--sm">
                        <div class="ac-row ac-row--wrap ac-exam-rev__head">
                            <span class={["ac-exam-rev__verdict", `ac-exam-rev__verdict--${verdict}`]}>
                                <VIcon icon={verdictIcon} size={18} />
                                {verdictWord}
                            </span>
                            {item.critical && (
                                <MetaPill color="warning" prependIcon="mdi-alert-outline">
                                    {t("Critical")}
                                </MetaPill>
                            )}
                            <span class="ac-muted">{props.moduleTitles[item.module] ?? item.module}</span>
                        </div>
                        <p class="ac-exam-rev__stem" dir="auto">
                            <span class="ac-num ac-exam-rev__n">{index + 1}.</span> {item.stem}
                        </p>

                        {item.options && (
                            <ul class="ac-choices">
                                {item.options.map((o) => {
                                    const tone = o.correct ? "good" : o.selected ? "bad" : "";
                                    return (
                                        <li key={o.oid} class={["ac-choice", "ac-choice--locked", tone ? `ac-choice--${tone}` : ""]}>
                                            <VIcon class="ac-exam-rev__mark" icon={o.correct ? "mdi-check-circle-outline" : o.selected ? "mdi-close-circle-outline" : "mdi-circle-small"} size={18} />
                                            <div class="ac-choice__label">
                                                <span dir="auto">{o.text}</span>
                                                {(o.selected || o.correct) && (
                                                    <span class="ac-exam-rev__tags">
                                                        {o.selected && <span class="ac-exam-rev__tag">{t("your answer")}</span>}
                                                        {o.correct && <span class="ac-exam-rev__tag">{t("correct answer")}</span>}
                                                    </span>
                                                )}
                                                {o.note && <p class="ac-choice__note" dir="auto">{o.note}</p>}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {item.order && (
                            <div class="ac-exam-rev__orders">
                                <div class="ac-stack ac-stack--sm">
                                    <h3 class="ac-h3">{t("Your order")}</h3>
                                    {item.order.yourOrder.length === 0 ? (
                                        <span class="ac-muted">{t("Not answered")}</span>
                                    ) : (
                                        <ol class="ac-exam-rev__ol" dir="auto">
                                            {item.order.yourOrder.map((oid) => (
                                                <li key={oid}>{optionText(oid)}</li>
                                            ))}
                                        </ol>
                                    )}
                                </div>
                                <div class="ac-stack ac-stack--sm">
                                    <h3 class="ac-h3">{t("Correct order")}</h3>
                                    <ol class="ac-exam-rev__ol" dir="auto">
                                        {item.order.correctOrder.map((oid) => (
                                            <li key={oid}>{optionText(oid)}</li>
                                        ))}
                                    </ol>
                                </div>
                            </div>
                        )}

                        {item.number && (
                            <div class="ac-stack ac-stack--sm ac-exam-rev__numbers">
                                <div class="ac-row ac-row--wrap">
                                    <span class="ac-muted">{t("Your answer")}</span>
                                    <strong class="ac-ltr ac-num">{item.number.yourAnswer ?? "—"}</strong>
                                </div>
                                <div class="ac-row ac-row--wrap">
                                    <span class="ac-muted">{t("Correct answer")}</span>
                                    <strong class="ac-ltr ac-num">{item.number.correctAnswer}</strong>
                                    {item.number.tolerance ? (
                                        <span class="ac-muted">
                                            ({t("tolerance")} <span class="ac-ltr ac-num">{item.number.tolerance}</span>)
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        )}

                        {item.why && (
                            <p class="ac-exam-rev__why" dir="auto">
                                <strong>{t("Why")}: </strong>
                                {item.why}
                            </p>
                        )}
                        {item.refs.length > 0 && (
                            <p class="ac-text">
                                <strong>{t("Guide references")}: </strong>
                                {item.refs.map((ref, i) => (
                                    <span key={ref}>
                                        {i > 0 ? ", " : ""}
                                        <RouterLink class="ac-link" to={{ name: "AdminGuideArticle", params: { articleId: ref } }}>
                                            {props.articleTitles[ref] ?? ref}
                                        </RouterLink>
                                    </span>
                                ))}
                            </p>
                        )}
                    </div>
                </SurfaceCard>
            </li>
        );
    };

    return () => {
        const r = props.result;
        const modules = Object.entries(r.moduleScores);
        const tone = r.passed ? "pass" : "fail";
        const emptyText = filter.value === "incorrect" ? t("You answered every question correctly.") : t("No questions in this view.");
        return (
            <div class="ac-exam-result">
                <div class={["ac-exam-verdict", `ac-exam-verdict--${tone}`]} role="status" aria-live="polite">
                    <VIcon class="ac-exam-verdict__icon" icon={r.passed ? "mdi-check-circle" : "mdi-close-circle"} size={32} />
                    <div class="ac-exam-verdict__body">
                        <p class="ac-exam-verdict__title">{`${r.passed ? t("You passed") : t("Not passed this time")} — ${r.scorePercent}%`}</p>
                        <p class="ac-exam-verdict__sub">
                            {t("Pass mark")}: {r.passPercent}% · {t("Attempt")} {r.attemptNumber} · {props.trackTitle}
                        </p>
                        {r.expired && <p class="ac-exam-verdict__sub">{t("This submission arrived after the time limit, so it was not scored.")}</p>}
                        {!r.passed && !r.expired && r.scorePercent >= r.passPercent && r.criticalMissed > 0 && (
                            <p class="ac-exam-verdict__sub">{t("Your percentage was high enough, but a critical question was missed.")}</p>
                        )}
                        {!r.passed && <p class="ac-exam-verdict__sub">{t("This is part of learning. Review the topics below and try again when you are ready.")}</p>}
                    </div>
                </div>

                <MetricStrip
                    items={[
                        { key: "score", label: t("Score"), value: `${r.scorePercent}%` },
                        { key: "pass", label: t("Pass mark"), value: `${r.passPercent}%` },
                        { key: "critical", label: t("Critical questions missed"), value: r.criticalMissed },
                        { key: "time", label: t("Time taken"), value: `${Math.floor(r.durationSeconds / 60)} ${t("min")} ${r.durationSeconds % 60} ${t("sec")}` },
                    ]}
                />

                <div class="ac-split">
                    <section aria-labelledby="exam-review-heading" class="ac-stack">
                        <div class="ac-stack ac-stack--sm">
                            <h2 id="exam-review-heading" class="ac-title">
                                {t("Your answers, question by question")}
                            </h2>
                            <p class="ac-muted">{t("These answers are shown only to you, only now. Please do not share them.")}</p>
                            <p class="ac-muted">
                                {t("Critical questions cover things that could cause real harm if misunderstood. Missing any one of them fails the exam regardless of the percentage.")}
                            </p>
                            <div>
                                <SegmentedTabs
                                    modelValue={filter.value}
                                    ariaLabel={t("Filter your answers")}
                                    tabs={[
                                        { value: "all", label: t("All"), count: counts.value.all },
                                        { value: "incorrect", label: t("Incorrect"), count: counts.value.incorrect },
                                        { value: "critical", label: t("Critical"), count: counts.value.critical },
                                    ]}
                                    onUpdate:modelValue={(value: string) => (filter.value = value as Filter)}
                                />
                            </div>
                        </div>
                        {visible.value.length === 0 ? (
                            <SurfaceCard class="ac-card">
                                <EmptyState icon="mdi-check-circle-outline" title={emptyText} />
                            </SurfaceCard>
                        ) : (
                            <ol class="ac-stack ac-exam-rev__list">{visible.value.map(({ item, index }) => renderItem(item, index))}</ol>
                        )}
                    </section>

                    <aside class="ac-aside">
                        {r.passed && r.badge && (
                            <SurfaceCard class="ac-card">
                                <div class="ac-stack">
                                    <div class="ac-row">
                                        <IconTile icon="mdi-certificate-outline" tone="success" large />
                                        <div class="ac-grow">
                                            <h2 class="ac-h2">{props.trackTitle}</h2>
                                            <StatusBadge status="valid" label={t("Certified")} toneOverride="success" />
                                        </div>
                                    </div>
                                    <DescriptionList
                                        items={[
                                            { label: t("Issued"), value: fmtDate(r.badge.earnedAt) },
                                            { label: t("Valid until"), value: fmtDate(r.badge.expiresAt) },
                                        ]}
                                    />
                                    <VBtn color="primary" block prependIcon="mdi-certificate-outline" to={{ name: "AdminAcademyCertificate", params: { badgeId: r.badge.id } }}>
                                        {t("View certificate")}
                                    </VBtn>
                                </div>
                            </SurfaceCard>
                        )}

                        <SurfaceCard class="ac-card" title={t("Score by module")}>
                            <div class="ac-stack">
                                <ul class="ac-steps ac-exam-mods">
                                    {modules.map(([id, value]) => {
                                        const title = props.moduleTitles[id] ?? id;
                                        return (
                                            <li key={id} class="ac-step">
                                                <div class="ac-step__main">
                                                    <span class="ac-step__title">{title}</span>
                                                    <ProgressBar value={value} max={100} tone={value >= MODULE_PASS ? "success" : "danger"} label={`${title}: ${value}%`} />
                                                </div>
                                                <span class="ac-step__meta ac-exam-mods__value">{value}%</span>
                                            </li>
                                        );
                                    })}
                                </ul>
                                {r.reviewRequired.length > 0 && (
                                    <div class="ac-stack ac-stack--sm ac-exam-review-links">
                                        <h3 class="ac-h3">{t("Worth a second look (below 70%)")}</h3>
                                        <ul class="ac-exam-linklist">
                                            {r.reviewRequired.map((id) => (
                                                <li key={id}>
                                                    <RouterLink class="ac-link" to={{ name: "AdminAcademyModule", params: { moduleId: id } }}>
                                                        {props.moduleTitles[id] ?? id}
                                                    </RouterLink>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </SurfaceCard>

                        {!r.passed && r.cooldownUntil && (
                            <Callout tone="info" icon="mdi-timer-sand">
                                {t("You can try again at")} <strong class="ac-num">{fmtDateTime(r.cooldownUntil)}</strong>.
                            </Callout>
                        )}
                    </aside>
                </div>
            </div>
        );
    };
}, { props: ["result", "trackTitle", "moduleTitles", "articleTitles"] });
