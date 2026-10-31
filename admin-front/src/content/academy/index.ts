import { ACADEMY_MODULES_TRACK_A } from "./modulesTrackA";
import { ACADEMY_MODULES_TRACK_B } from "./modulesTrackB";
import type {
    AcademyBadge,
    AcademyModule,
    AcademyTrack,
    AcademyTrackDefinition,
    EmployeeAcademyProgress,
} from "./types";

export * from "./types";
export { ACADEMY_MODULES_TRACK_A, ACADEMY_MODULES_TRACK_B };

export const ACADEMY_MODULES: AcademyModule[] = [...ACADEMY_MODULES_TRACK_A, ...ACADEMY_MODULES_TRACK_B];

export const ACADEMY_TRACKS: AcademyTrackDefinition[] = [
    {
        id: "SUPPORT",
        badge: "CERTIFIED_SUPPORT_SPECIALIST",
        titleEn: "Support Specialist",
        titleAr: "أخصائي دعم",
        moduleIds: ["M1", "M2", "M6"],
    },
    {
        id: "OPERATIONS",
        badge: "CERTIFIED_OPERATIONS_OFFICER",
        titleEn: "Operations Officer",
        titleAr: "ضابط عمليات",
        moduleIds: ["M1", "M2", "M3", "M6"],
    },
    {
        id: "COMPLIANCE",
        badge: "CERTIFIED_COMPLIANCE_ANALYST",
        titleEn: "Compliance Analyst",
        titleAr: "محلل امتثال",
        moduleIds: ["M1", "M2", "M3", "M7"],
    },
    {
        id: "FINANCE",
        badge: "CERTIFIED_FINANCE_CONTROLLER",
        titleEn: "Finance Controller",
        titleAr: "مراقب مالي",
        moduleIds: ["M1", "M2", "M4", "M8"],
    },
    {
        id: "GATEWAY_ARCHITECT",
        badge: "CERTIFIED_GATEWAY_ARCHITECT",
        titleEn: "Gateway Architect",
        titleAr: "مهندس بوابات",
        moduleIds: ["M1", "M2", "M5", "M6", "M8"],
    },
    {
        id: "MASTER_OPERATOR",
        badge: "CERTIFIED_MASTER_OPERATOR",
        titleEn: "Master Operator",
        titleAr: "مشغّل رئيسي",
        moduleIds: ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"],
        requiresAllLabs: true,
        requiresPerfectQuiz: true,
    },
];

export const findAcademyModule = (id: string): AcademyModule | undefined =>
    ACADEMY_MODULES.find((module) => module.id === id);

export const emptyAcademyProgress = (): EmployeeAcademyProgress => ({
    completedLessonIds: [],
    completedLabIds: {},
    quizScores: {},
    earnedBadges: [],
});

export const moduleLessonIds = (module: AcademyModule): string[] => module.lessons.map((lesson) => lesson.id);

export const moduleQuizId = (module: AcademyModule): string => `QUIZ-${module.id}`;

export const moduleLessonsComplete = (progress: EmployeeAcademyProgress, module: AcademyModule): boolean =>
    moduleLessonIds(module).every((id) => progress.completedLessonIds.includes(id));

export const moduleLabPassed = (progress: EmployeeAcademyProgress, module: AcademyModule): boolean =>
    progress.completedLabIds[module.lab.id]?.passed === true;

export const moduleQuizPerfect = (progress: EmployeeAcademyProgress, module: AcademyModule): boolean =>
    progress.quizScores[moduleQuizId(module)]?.scorePercent === 100;

export const moduleMastered = (progress: EmployeeAcademyProgress, module: AcademyModule): boolean =>
    moduleLessonsComplete(progress, module) && moduleLabPassed(progress, module) && moduleQuizPerfect(progress, module);

export const earnedBadges = (progress: EmployeeAcademyProgress): AcademyBadge[] => {
    const result = new Set<AcademyBadge>(progress.earnedBadges);
    for (const track of ACADEMY_TRACKS) {
        const modules = track.moduleIds
            .map((id) => findAcademyModule(id))
            .filter((module): module is AcademyModule => Boolean(module));
        const allMastered = modules.every((module) => moduleMastered(progress, module));
        if (!allMastered) {
            continue;
        }
        if (track.requiresAllLabs && !ACADEMY_MODULES.every((module) => moduleLabPassed(progress, module))) {
            continue;
        }
        if (track.requiresPerfectQuiz && !ACADEMY_MODULES.every((module) => moduleQuizPerfect(progress, module))) {
            continue;
        }
        result.add(track.badge);
    }
    return [...result];
};

export const trackProgressPercent = (progress: EmployeeAcademyProgress, track: AcademyTrackDefinition): number => {
    const modules = track.moduleIds
        .map((id) => findAcademyModule(id))
        .filter((module): module is AcademyModule => Boolean(module));
    if (modules.length === 0) {
        return 0;
    }
    const completed = modules.filter((module) => moduleMastered(progress, module)).length;
    return Math.round((completed / modules.length) * 100);
};

export const normalizeAcademyProgress = (input: unknown): EmployeeAcademyProgress => {
    const source = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const completedLessonIds = Array.isArray(source.completedLessonIds)
        ? source.completedLessonIds.filter((entry): entry is string => typeof entry === "string")
        : [];
    const completedLabIds: EmployeeAcademyProgress["completedLabIds"] = {};
    if (source.completedLabIds !== null && typeof source.completedLabIds === "object" && !Array.isArray(source.completedLabIds)) {
        for (const [key, value] of Object.entries(source.completedLabIds as Record<string, unknown>)) {
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const row = value as Record<string, unknown>;
                completedLabIds[key] = {
                    passed: row.passed === true,
                    attempts: typeof row.attempts === "number" ? row.attempts : 0,
                    mistakesMade: Array.isArray(row.mistakesMade)
                        ? row.mistakesMade.filter((entry): entry is string => typeof entry === "string")
                        : [],
                    completedAt: typeof row.completedAt === "string" ? row.completedAt : "",
                };
            }
        }
    }
    const quizScores: EmployeeAcademyProgress["quizScores"] = {};
    if (source.quizScores !== null && typeof source.quizScores === "object" && !Array.isArray(source.quizScores)) {
        for (const [key, value] of Object.entries(source.quizScores as Record<string, unknown>)) {
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const row = value as Record<string, unknown>;
                quizScores[key] = {
                    scorePercent: typeof row.scorePercent === "number" ? Math.max(0, Math.min(100, row.scorePercent)) : 0,
                    passed: row.passed === true,
                    completedAt: typeof row.completedAt === "string" ? row.completedAt : "",
                    answers:
                        row.answers !== null && typeof row.answers === "object" && !Array.isArray(row.answers)
                            ? (row.answers as Record<string, number>)
                            : undefined,
                };
            }
        }
    }
    const earned = Array.isArray(source.earnedBadges)
        ? source.earnedBadges.filter((entry): entry is AcademyBadge => typeof entry === "string")
        : [];
    return {
        completedLessonIds,
        completedLabIds,
        quizScores,
        earnedBadges: earned,
        lastModuleId: typeof source.lastModuleId === "string" ? source.lastModuleId : undefined,
        updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : undefined,
    };
};

export const academyTracksForModule = (module: AcademyModule): AcademyTrack[] => module.tracks;
