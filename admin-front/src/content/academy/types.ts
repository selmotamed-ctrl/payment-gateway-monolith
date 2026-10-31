export type AcademyTrack =
    | "SUPPORT"
    | "OPERATIONS"
    | "COMPLIANCE"
    | "FINANCE"
    | "GATEWAY_ARCHITECT"
    | "MASTER_OPERATOR";

export type AcademyBadge =
    | "CERTIFIED_SUPPORT_SPECIALIST"
    | "CERTIFIED_OPERATIONS_OFFICER"
    | "CERTIFIED_COMPLIANCE_ANALYST"
    | "CERTIFIED_FINANCE_CONTROLLER"
    | "CERTIFIED_GATEWAY_ARCHITECT"
    | "CERTIFIED_MASTER_OPERATOR";

export type AcademyLesson = {
    id: string;
    titleEn: string;
    titleAr?: string;
    bodyEn: string;
    bodyAr?: string;
};

export type LabOption = {
    id: string;
    labelEn: string;
    labelAr?: string;
    fatal?: boolean;
    feedbackEn: string;
    feedbackAr?: string;
};

export type LabScenario = {
    id: string;
    titleEn: string;
    titleAr?: string;
    promptEn: string;
    promptAr?: string;
    options: LabOption[];
};

export type AcademyLab = {
    id: string;
    titleEn: string;
    titleAr?: string;
    descriptionEn: string;
    descriptionAr?: string;
    scenarios: LabScenario[];
};

export type AcademyQuizOption = {
    text: string;
    correct: boolean;
    explanation: string;
};

export type AcademyQuizQuestion = {
    id: string;
    questionEn: string;
    questionAr?: string;
    options: AcademyQuizOption[];
    explanation: string;
    critical?: boolean;
};

export type AcademyModule = {
    id: string;
    code: string;
    letter: string;
    titleEn: string;
    titleAr: string;
    summaryEn: string;
    summaryAr?: string;
    tracks: AcademyTrack[];
    lessons: AcademyLesson[];
    lab: AcademyLab;
    quiz: AcademyQuizQuestion[];
};

export type EmployeeAcademyProgress = {
    completedLessonIds: string[];
    completedLabIds: Record<
        string,
        {
            passed: boolean;
            attempts: number;
            mistakesMade: string[];
            completedAt: string;
        }
    >;
    quizScores: Record<
        string,
        {
            scorePercent: number;
            passed: boolean;
            completedAt: string;
            answers?: Record<string, number>;
        }
    >;
    earnedBadges: AcademyBadge[];
    lastModuleId?: string;
    updatedAt?: string;
};

export type AcademyTrackDefinition = {
    id: AcademyTrack;
    badge: AcademyBadge;
    titleEn: string;
    titleAr: string;
    moduleIds: string[];
    requiresAllLabs?: boolean;
    requiresPerfectQuiz?: boolean;
};
