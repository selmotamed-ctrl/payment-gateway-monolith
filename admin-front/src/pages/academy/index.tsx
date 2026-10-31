import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VChip,
    VExpansionPanel,
    VExpansionPanelText,
    VExpansionPanelTitle,
    VExpansionPanels,
    VProgressLinear,
    VRadio,
    VRadioGroup,
    VSelect,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { GuideMarkdown } from "@/components/guide/GuideMarkdown";
import {
    ACADEMY_MODULES,
    ACADEMY_TRACKS,
    earnedBadges,
    emptyAcademyProgress,
    findAcademyModule,
    moduleLabPassed,
    moduleLessonsComplete,
    moduleMastered,
    moduleQuizPerfect,
    moduleQuizId,
    normalizeAcademyProgress,
    trackProgressPercent,
    type AcademyBadge,
    type AcademyModule,
    type AcademyTrack,
    type EmployeeAcademyProgress,
} from "@/content/academy";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type SubmittedQuiz = {
    correct: number;
    total: number;
    pct: number;
    passed: boolean;
};

type Incident = {
    moduleId: string;
    scenarioId: string;
    message: string;
};

const BADGE_LABELS: Record<AcademyBadge, string> = {
    CERTIFIED_SUPPORT_SPECIALIST: "Certified Support Specialist",
    CERTIFIED_OPERATIONS_OFFICER: "Certified Operations Officer",
    CERTIFIED_COMPLIANCE_ANALYST: "Certified Compliance Analyst",
    CERTIFIED_FINANCE_CONTROLLER: "Certified Finance Controller",
    CERTIFIED_GATEWAY_ARCHITECT: "Certified Gateway Architect",
    CERTIFIED_MASTER_OPERATOR: "Certified Master Operator",
};

const BADGE_LABELS_AR: Record<AcademyBadge, string> = {
    CERTIFIED_SUPPORT_SPECIALIST: "أخصائي دعم معتمد",
    CERTIFIED_OPERATIONS_OFFICER: "ضابط عمليات معتمد",
    CERTIFIED_COMPLIANCE_ANALYST: "محلل امتثال معتمد",
    CERTIFIED_FINANCE_CONTROLLER: "مراقب مالي معتمد",
    CERTIFIED_GATEWAY_ARCHITECT: "مهندس بوابات معتمد",
    CERTIFIED_MASTER_OPERATOR: "مشغّل رئيسي معتمد",
};

const TRACK_LABELS_AR: Record<AcademyTrack, string> = {
    SUPPORT: "الدعم",
    OPERATIONS: "العمليات",
    COMPLIANCE: "الامتثال",
    FINANCE: "المالية",
    GATEWAY_ARCHITECT: "هندسة البوابات",
    MASTER_OPERATOR: "المشغّل الرئيسي",
};

const asLegacyProgress = (input: unknown): EmployeeAcademyProgress | null => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const source = input as Record<string, unknown>;
    if (Array.isArray(source.completedLessonIds) || source.completedLabIds !== undefined) return null;
    const legacyModules = Array.isArray(source.completedModules)
        ? source.completedModules.filter((entry): entry is string => typeof entry === "string")
        : [];
    if (legacyModules.length === 0) return null;
    const progress = emptyAcademyProgress();
    for (const moduleId of legacyModules) {
        const normalized = moduleId.startsWith("M") ? moduleId : `M${moduleId}`;
        const module = findAcademyModule(normalized);
        if (!module) continue;
        progress.completedLessonIds.push(...module.lessons.map((lesson) => lesson.id));
        progress.completedLabIds[module.lab.id] = {
            passed: true,
            attempts: 1,
            mistakesMade: [],
            completedAt: new Date().toISOString(),
        };
        progress.quizScores[moduleQuizId(module)] = {
            scorePercent: 100,
            passed: true,
            completedAt: new Date().toISOString(),
        };
    }
    return progress;
};

const AcademyPage = dc(() => {
    const { t, current } = useLocale();
    const isArabic = computed(() => current.value === "ar");

    const progress = ref<EmployeeAcademyProgress>(emptyAcademyProgress());
    const loading = ref(true);
    const loadError = ref<string | null>(null);
    const persistWarning = ref<string | null>(null);
    const saving = ref(false);
    const selectedTrack = ref<AcademyTrack>("SUPPORT");
    const selectedModuleId = ref<string>("M1");
    const answers = ref<Record<string, Record<number, number | undefined>>>({});
    const submitted = ref<Record<string, SubmittedQuiz>>({});
    const incident = ref<Incident | null>(null);
    const labFeedback = ref<string | null>(null);
    const labScenarioIndex = ref(0);
    const labMistakes = ref<string[]>([]);
    const labAttempts = ref(0);

    const selectedModule = computed<AcademyModule>(() => findAcademyModule(selectedModuleId.value) ?? ACADEMY_MODULES[0]!);
    const trackModules = computed(() =>
        ACADEMY_MODULES.filter((module) => module.tracks.includes(selectedTrack.value) || selectedTrack.value === "MASTER_OPERATOR"),
    );

    const moduleTitle = (module: AcademyModule): string => (isArabic.value ? module.titleAr : module.titleEn);
    const moduleSummary = (module: AcademyModule): string => (isArabic.value && module.summaryAr ? module.summaryAr : module.summaryEn);
    const trackTitle = (trackId: AcademyTrack): string => {
        const track = ACADEMY_TRACKS.find((candidate) => candidate.id === trackId);
        return isArabic.value ? (track ? TRACK_LABELS_AR[track.id] : trackId) : track?.titleEn ?? trackId;
    };

    const completedModules = computed(() => ACADEMY_MODULES.filter((module) => moduleMastered(progress.value, module)).length);
    const overallPercent = computed(() => Math.round((completedModules.value / ACADEMY_MODULES.length) * 100));
    const selectedLessonsComplete = computed(() => moduleLessonsComplete(progress.value, selectedModule.value));
    const selectedLabPassed = computed(() => moduleLabPassed(progress.value, selectedModule.value));
    const selectedMastered = computed(() => moduleMastered(progress.value, selectedModule.value));

    const selectedLab = computed(() => selectedModule.value.lab);
    const currentScenario = computed(() => selectedLab.value.scenarios[labScenarioIndex.value]);

    const refreshBadges = () => {
        progress.value.earnedBadges = earnedBadges(progress.value);
    };

    const loadProgress = async () => {
        loading.value = true;
        loadError.value = null;
        try {
            const response = await api.get(urlsMap.academyProgress);
            const payload = response.data?.data ?? response.data ?? {};
            const source = payload?.progress ?? payload;
            const legacy = asLegacyProgress(source);
            progress.value = legacy ?? normalizeAcademyProgress(source);
            refreshBadges();
            if (progress.value.lastModuleId && findAcademyModule(progress.value.lastModuleId)) {
                selectedModuleId.value = progress.value.lastModuleId;
            }
        } catch (error) {
            loadError.value = extractApiErrorMessage(error);
            persistWarning.value = t("Progress could not be loaded. The academy still works, but progress will not persist until the API is reachable.");
        } finally {
            loading.value = false;
        }
    };

    const persist = async () => {
        saving.value = true;
        try {
            await api.put(urlsMap.academyProgress, {
                progress: {
                    completedLessonIds: progress.value.completedLessonIds,
                    completedLabIds: progress.value.completedLabIds,
                    quizScores: progress.value.quizScores,
                    earnedBadges: progress.value.earnedBadges,
                    lastModuleId: progress.value.lastModuleId,
                },
            });
            persistWarning.value = null;
        } catch (error) {
            const message = extractApiErrorMessage(error);
            persistWarning.value = `${t("Progress will not persist")}: ${message}`;
            showSnackBar({ type: "error", message });
        } finally {
            saving.value = false;
        }
    };

    void loadProgress();

    const selectModule = (moduleId: string) => {
        selectedModuleId.value = moduleId;
        progress.value.lastModuleId = moduleId;
        incident.value = null;
        labFeedback.value = null;
        labScenarioIndex.value = 0;
        labMistakes.value = [];
        labAttempts.value = 0;
        void persist();
    };

    const markLessonRead = (lessonId: string) => {
        if (!progress.value.completedLessonIds.includes(lessonId)) {
            progress.value.completedLessonIds = [...progress.value.completedLessonIds, lessonId];
            refreshBadges();
            void persist();
        }
    };

    const resetLab = () => {
        incident.value = null;
        labFeedback.value = null;
        labScenarioIndex.value = 0;
        labMistakes.value = [];
        labAttempts.value = 0;
    };

    const chooseLabOption = (optionId: string) => {
        const scenario = currentScenario.value;
        if (!scenario) return;
        const option = scenario.options.find((candidate) => candidate.id === optionId);
        if (!option) return;
        labAttempts.value += 1;
        if (option.fatal) {
            labMistakes.value = [...labMistakes.value, `${scenario.id}:${option.id}`];
            incident.value = {
                moduleId: selectedModule.value.id,
                scenarioId: scenario.id,
                message: isArabic.value && option.feedbackAr ? option.feedbackAr : option.feedbackEn,
            };
            return;
        }
        incident.value = null;
        labFeedback.value = isArabic.value && option.feedbackAr ? option.feedbackAr : option.feedbackEn;
        if (labScenarioIndex.value < selectedLab.value.scenarios.length - 1) {
            labScenarioIndex.value += 1;
            return;
        }
        const now = new Date().toISOString();
        progress.value.completedLabIds[selectedLab.value.id] = {
            passed: true,
            attempts: Math.max(1, labAttempts.value),
            mistakesMade: labMistakes.value,
            completedAt: now,
        };
        refreshBadges();
        showSnackBar({ type: "success", message: t("Lab passed") });
        void persist();
    };

    const setAnswer = (moduleId: string, questionIndex: number, value: number | null) => {
        const existing = answers.value[moduleId] ?? {};
        answers.value = {
            ...answers.value,
            [moduleId]: { ...existing, [questionIndex]: value ?? undefined },
        };
    };

    const allAnswered = (module: AcademyModule): boolean =>
        module.quiz.every((_, index) => answers.value[module.id]?.[index] !== undefined);

    const submitQuiz = async (module: AcademyModule) => {
        if (!moduleLessonsComplete(progress.value, module) || !moduleLabPassed(progress.value, module)) {
            showSnackBar({ type: "warning", message: t("Complete the lessons and the lab before the quiz") });
            return;
        }
        const moduleAnswers = answers.value[module.id] ?? {};
        let correct = 0;
        module.quiz.forEach((question, index) => {
            const chosen = moduleAnswers[index];
            if (chosen !== undefined && question.options[chosen]?.correct) {
                correct += 1;
            }
        });
        const total = module.quiz.length;
        const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
        const passed = total > 0 && correct === total;
        const quizId = moduleQuizId(module);
        progress.value.quizScores[quizId] = {
            scorePercent: pct,
            passed,
            completedAt: new Date().toISOString(),
            answers: moduleAnswers as Record<string, number>,
        };
        submitted.value = { ...submitted.value, [module.id]: { correct, total, pct, passed } };
        refreshBadges();
        showSnackBar({
            type: passed ? "success" : "warning",
            message: passed ? t("Quiz passed") : t("Quiz needs 100% to pass"),
        });
        await persist();
    };

    const retryQuiz = (moduleId: string) => {
        answers.value = { ...answers.value, [moduleId]: {} };
        const next = { ...submitted.value };
        delete next[moduleId];
        submitted.value = next;
    };

    const badgeEarned = (badge: AcademyBadge): boolean => progress.value.earnedBadges.includes(badge);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "16px" }}>
                <PageHeader
                    title={isArabic.value ? "أكاديمية الموظفين" : "Employee Academy"}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <StatusChip label={`${completedModules.value} / ${ACADEMY_MODULES.length} ${isArabic.value ? "وحدات" : "modules"}`} tone="info" />
                            <StatusChip label={`${overallPercent.value}%`} tone={overallPercent.value === 100 ? "success" : "primary"} />
                        </ThemedView>
                    )}
                />

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                            <ThemedText type="defaultSemiBold">{isArabic.value ? "التقدم الكلي" : "Overall progress"}</ThemedText>
                            <ThemedText type="defaultSemiBold">{`${overallPercent.value}%`}</ThemedText>
                        </ThemedView>
                        <VProgressLinear modelValue={overallPercent.value} color="success" height="10px" rounded />
                        <VSelect
                            modelValue={selectedTrack.value}
                            onUpdate:modelValue={(value: AcademyTrack | null) => (selectedTrack.value = value ?? "SUPPORT")}
                            items={ACADEMY_TRACKS.map((track) => ({ title: isArabic.value ? TRACK_LABELS_AR[track.id] : track.titleEn, value: track.id }))}
                            label={isArabic.value ? "مسار الدور" : "Role track"}
                            hideDetails
                            style={{ maxWidth: "360px" }}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            {ACADEMY_TRACKS.map((track) => {
                                const earned = badgeEarned(track.badge);
                                return (
                                    <VChip
                                        key={track.badge}
                                        color={earned ? "success" : undefined}
                                        variant={earned ? "flat" : "outlined"}
                                        prependIcon={earned ? "mdi-certificate" : "mdi-lock-outline"}
                                        size="small"
                                        onClick={() => (selectedTrack.value = track.id)}
                                        style={{ cursor: "pointer" }}
                                    >
                                        {`${isArabic.value ? BADGE_LABELS_AR[track.badge] : BADGE_LABELS[track.badge]} · ${trackProgressPercent(progress.value, track)}%`}
                                    </VChip>
                                );
                            })}
                        </ThemedView>
                        {saving.value ? <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("Saving progress")}</ThemedText> : null}
                    </VCardText>
                </VCard>

                {persistWarning.value ? (
                    <VAlert type="warning" variant="tonal" density="compact">
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                            <ThemedText style={{ fontSize: "13px" }}>{persistWarning.value}</ThemedText>
                            <VBtn size="small" variant="text" onClick={() => void loadProgress()}>{t("Retry")}</VBtn>
                        </ThemedView>
                    </VAlert>
                ) : null}

                {loading.value ? (
                    <StateView loading />
                ) : (
                    <>
                        {loadError.value ? (
                            <VAlert type="warning" variant="tonal" density="compact">
                                <ThemedText style={{ fontSize: "13px" }}>{`${t("Progress could not be loaded")}: ${loadError.value}`}</ThemedText>
                            </VAlert>
                        ) : null}

                        <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" }}>
                            <ThemedView style={{ flex: "1 1 300px", gap: "10px", maxWidth: "380px" }}>
                                {trackModules.value.map((module) => {
                                    const active = module.id === selectedModule.value.id;
                                    const mastered = moduleMastered(progress.value, module);
                                    return (
                                        <VCard
                                            key={module.id}
                                            onClick={() => selectModule(module.id)}
                                            style={{
                                                cursor: "pointer",
                                                border: active ? "2px solid var(--v-theme-primary)" : "1px solid rgba(100,116,139,0.18)",
                                            }}
                                        >
                                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                    <StatusChip label={module.letter || module.id} tone={active ? "primary" : "neutral"} size="x-small" />
                                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "14px", flex: "1 1 180px" }}>
                                                        {moduleTitle(module)}
                                                    </ThemedText>
                                                    {mastered ? <StatusChip label={t("Mastered")} tone="success" size="x-small" /> : null}
                                                </ThemedView>
                                                <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{moduleSummary(module)}</ThemedText>
                                                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                                    <StatusChip
                                                        label={`${module.lessons.filter((lesson) => progress.value.completedLessonIds.includes(lesson.id)).length}/${module.lessons.length} lessons`}
                                                        tone={moduleLessonsComplete(progress.value, module) ? "success" : "neutral"}
                                                        size="x-small"
                                                    />
                                                    <StatusChip label={moduleLabPassed(progress.value, module) ? "Lab passed" : "Lab locked"} tone={moduleLabPassed(progress.value, module) ? "success" : "neutral"} size="x-small" />
                                                    <StatusChip label={moduleQuizPerfect(progress.value, module) ? "Quiz 100%" : "Quiz locked"} tone={moduleQuizPerfect(progress.value, module) ? "success" : "neutral"} size="x-small" />
                                                </ThemedView>
                                            </VCardText>
                                        </VCard>
                                    );
                                })}
                            </ThemedView>

                            <ThemedView style={{ flex: "3 1 620px", minWidth: "320px", gap: "14px" }}>
                                <VCard>
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <StatusChip label={selectedModule.value.id} tone="primary" />
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "20px" }}>{moduleTitle(selectedModule.value)}</ThemedText>
                                            {selectedMastered.value ? <StatusChip label={t("Mastered")} tone="success" /> : null}
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "13px", opacity: 0.8 }}>{moduleSummary(selectedModule.value)}</ThemedText>
                                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                            {selectedModule.value.tracks.map((track) => (
                                                <VChip key={`${selectedModule.value.id}-${track}`} size="x-small" variant="tonal">{trackTitle(track)}</VChip>
                                            ))}
                                        </ThemedView>
                                    </VCardText>
                                </VCard>

                                <VCard>
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                        <ThemedText type="defaultSemiBold">{isArabic.value ? "الخطوة 1 — الدروس" : "Step 1 — Lessons"}</ThemedText>
                                        <VExpansionPanels multiple>
                                            {selectedModule.value.lessons.map((lesson) => {
                                                const read = progress.value.completedLessonIds.includes(lesson.id);
                                                return (
                                                    <VExpansionPanel key={lesson.id} value={lesson.id}>
                                                        <VExpansionPanelTitle>
                                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                                <StatusChip label={lesson.id} tone={read ? "success" : "neutral"} size="x-small" />
                                                                <span>{isArabic.value && lesson.titleAr ? lesson.titleAr : lesson.titleEn}</span>
                                                            </ThemedView>
                                                        </VExpansionPanelTitle>
                                                        <VExpansionPanelText>
                                                            <ThemedView style={{ gap: "10px", paddingTop: "4px" }}>
                                                                <GuideMarkdown source={isArabic.value && lesson.bodyAr ? lesson.bodyAr : lesson.bodyEn} compact />
                                                                <VBtn size="small" color={read ? "success" : "primary"} variant={read ? "tonal" : "flat"} onClick={() => markLessonRead(lesson.id)}>
                                                                    {read ? (isArabic.value ? "مقروء" : "Read") : (isArabic.value ? "تحديد كمقروء" : "Mark as read")}
                                                                </VBtn>
                                                            </ThemedView>
                                                        </VExpansionPanelText>
                                                    </VExpansionPanel>
                                                );
                                            })}
                                        </VExpansionPanels>
                                    </VCardText>
                                </VCard>

                                <VCard>
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                            <ThemedText type="defaultSemiBold">{isArabic.value ? "الخطوة 2 — المختبر التفاعلي" : "Step 2 — Interactive lab"}</ThemedText>
                                            <StatusChip label={selectedLab.value.id} tone="info" size="x-small" />
                                            {selectedLabPassed.value ? <StatusChip label={t("Passed")} tone="success" size="x-small" /> : null}
                                        </ThemedView>
                                        <GuideMarkdown source={selectedLab.value.descriptionEn} compact />
                                        {!selectedLessonsComplete.value ? (
                                            <VAlert type="info" variant="tonal" density="compact">
                                                {isArabic.value ? "أكمل قراءة كل الدروس أولاً لفتح المختبر." : "Complete every lesson first to unlock the lab."}
                                            </VAlert>
                                        ) : (
                                            <>
                                                {incident.value ? (
                                                    <VAlert type="error" variant="flat" border="start">
                                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "14px", marginBottom: "4px" }}>
                                                            {isArabic.value ? "حادث إنتاج محاكى!" : "Simulated Production Incident!"}
                                                        </ThemedText>
                                                        <ThemedText style={{ fontSize: "13px", lineHeight: 1.65 }}>{incident.value.message}</ThemedText>
                                                        <VBtn size="small" variant="text" onClick={() => { incident.value = null; labFeedback.value = null; }}>
                                                            {isArabic.value ? "إعادة المحاولة" : "Retry scenario"}
                                                        </VBtn>
                                                    </VAlert>
                                                ) : null}
                                                {currentScenario.value ? (
                                                    <VCard variant="outlined">
                                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                                                    {isArabic.value && currentScenario.value.titleAr ? currentScenario.value.titleAr : currentScenario.value.titleEn}
                                                                </ThemedText>
                                                                <StatusChip
                                                                    label={`${labScenarioIndex.value + 1} / ${selectedLab.value.scenarios.length}`}
                                                                    tone="neutral"
                                                                    size="x-small"
                                                                />
                                                            </ThemedView>
                                                            <ThemedText style={{ fontSize: "13px", lineHeight: 1.65 }}>
                                                                {isArabic.value && currentScenario.value.promptAr ? currentScenario.value.promptAr : currentScenario.value.promptEn}
                                                            </ThemedText>
                                                            <ThemedView style={{ gap: "6px" }}>
                                                                {currentScenario.value.options.map((option) => (
                                                                    <VBtn
                                                                        key={option.id}
                                                                        variant="tonal"
                                                                        color={option.fatal ? "error" : "primary"}
                                                                        style={{ justifyContent: "flex-start", textAlign: "start", whiteSpace: "normal", height: "auto", padding: "10px 12px" }}
                                                                        onClick={() => chooseLabOption(option.id)}
                                                                    >
                                                                        {isArabic.value && option.labelAr ? option.labelAr : option.labelEn}
                                                                    </VBtn>
                                                                ))}
                                                            </ThemedView>
                                                            {labFeedback.value ? (
                                                                <VAlert type="success" variant="tonal" density="compact">
                                                                    <ThemedText style={{ fontSize: "13px" }}>{labFeedback.value}</ThemedText>
                                                                </VAlert>
                                                            ) : null}
                                                        </VCardText>
                                                    </VCard>
                                                ) : (
                                                    <VAlert type="success" variant="tonal" density="compact">
                                                        {isArabic.value ? "اكتمل المختبر بنجاح." : "Lab completed successfully."}
                                                    </VAlert>
                                                )}
                                                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                                                    <VBtn size="small" variant="text" onClick={resetLab}>{isArabic.value ? "إعادة المختبر" : "Restart lab"}</VBtn>
                                                    {labMistakes.value.length > 0 ? (
                                                        <StatusChip label={`${labMistakes.value.length} mistakes`} tone="error" size="x-small" />
                                                    ) : null}
                                                </ThemedView>
                                            </>
                                        )}
                                    </VCardText>
                                </VCard>

                                <VCard>
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                                        <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                                <ThemedText type="defaultSemiBold">{isArabic.value ? "الخطوة 3 — الاختبار" : "Step 3 — Verification quiz"}</ThemedText>
                                                <StatusChip label={moduleQuizId(selectedModule.value)} tone="primary" size="x-small" />
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                                {isArabic.value ? "100% مطلوب للنجاح (8 من 8)" : "100% required to pass (8 of 8)"}
                                            </ThemedText>
                                        </ThemedView>
                                        {!selectedLabPassed.value ? (
                                            <VAlert type="info" variant="tonal" density="compact">
                                                {isArabic.value ? "اجتز المختبر أولاً لفتح الاختبار." : "Pass the lab first to unlock the quiz."}
                                            </VAlert>
                                        ) : null}
                                        {selectedModule.value.quiz.map((question, index) => {
                                            const result = submitted.value[selectedModule.value.id];
                                            const chosen = answers.value[selectedModule.value.id]?.[index];
                                            return (
                                                <ThemedView key={question.id} style={{ gap: "6px" }}>
                                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                                        {`${index + 1}. ${isArabic.value && question.questionAr ? question.questionAr : question.questionEn}`}
                                                    </ThemedText>
                                                    <VRadioGroup
                                                        modelValue={chosen}
                                                        onUpdate:modelValue={(value: number | null) => setAnswer(selectedModule.value.id, index, value)}
                                                        disabled={!selectedLabPassed.value}
                                                    >
                                                        {question.options.map((option, optionIndex) => (
                                                            <VRadio
                                                                key={`${question.id}-${optionIndex}`}
                                                                value={optionIndex}
                                                                label={option.text}
                                                                color={
                                                                    result
                                                                        ? option.correct
                                                                            ? "success"
                                                                            : optionIndex === chosen
                                                                              ? "error"
                                                                              : undefined
                                                                        : undefined
                                                                }
                                                            />
                                                        ))}
                                                    </VRadioGroup>
                                                    {result ? (
                                                        <ThemedText style={{ fontSize: "12px", opacity: 0.72, lineHeight: 1.6 }}>
                                                            {question.explanation}
                                                        </ThemedText>
                                                    ) : null}
                                                </ThemedView>
                                            );
                                        })}
                                        {submitted.value[selectedModule.value.id] ? (
                                            <VAlert type={submitted.value[selectedModule.value.id]?.passed ? "success" : "warning"} variant="tonal" density="compact">
                                                <ThemedText style={{ fontSize: "13px" }}>
                                                    {`${submitted.value[selectedModule.value.id]?.correct ?? 0} / ${submitted.value[selectedModule.value.id]?.total ?? 0} · ${submitted.value[selectedModule.value.id]?.pct ?? 0}% ${submitted.value[selectedModule.value.id]?.passed ? `— ${t("passed")}` : `— ${t("needs 8/8 to pass")}`}`}
                                                </ThemedText>
                                            </VAlert>
                                        ) : null}
                                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                                            <VBtn
                                                disabled={!selectedLabPassed.value || !allAnswered(selectedModule.value)}
                                                loading={saving.value}
                                                onClick={() => void submitQuiz(selectedModule.value)}
                                            >
                                                {t("Submit quiz")}
                                            </VBtn>
                                            <VBtn variant="tonal" disabled={!submitted.value[selectedModule.value.id]} onClick={() => retryQuiz(selectedModule.value.id)}>
                                                {t("Retry")}
                                            </VBtn>
                                        </ThemedView>
                                    </VCardText>
                                </VCard>
                            </ThemedView>
                        </ThemedView>
                    </>
                )}
            </ThemedView>
        </ScreenContainer>
    );
});

export default AcademyPage;
