/**
 * Employee Academy API contract (frontend side). `core-back/engine/academy/types.ts` mirrors
 * these shapes EXACTLY; change both together. Routes are under `/api/v1/admin/academy/` in
 * `admin-back` (a proxy) and `/internal/admin/academy/` in `core-back` (owner + grader).
 */
import type { QType, TrackId } from "./index";

// ---------------------------------------------------------------------------------------
// Progress record (spec §A-3 / II-5). `rev` is incremented by the server on every write.
// ---------------------------------------------------------------------------------------

export interface ExamAttemptSummary {
    at: string;
    scorePercent: number;
    passed: boolean;
    criticalMissed: number;
    moduleScores: Record<string, number>;
    durationSeconds: number;
}

/** Question ids and option mappings live only on the server (`_server`, never serialised). */
export interface OpenExamSession {
    sessionId: string;
    startedAt: string;
    expiresAt: string;
}

export interface AcademyBadge {
    id: string;
    track: TrackId;
    earnedAt: string;
    expiresAt: string;
    v: string;
}

export interface AcademyProgress {
    schema: 1;
    rev: number;
    startedAt: string;
    updatedAt: string;
    contentVersion: string;
    activeTrack?: TrackId;
    /** Set by the server when the learner accepts the integrity statement (first exam start). */
    integrityAcceptedAt?: string;
    guideRead: Record<string, { v: string; at: string }>;
    lessons: Record<string, { at: string; v: string; checkScore: 0 | 1 | 2 }>;
    labs: Record<
        string,
        { bestScore: number; attempts: number; passedAt?: string; criticalErrors: number; v: string }
    >;
    exams: Record<
        string,
        { attempts: ExamAttemptSummary[]; open?: OpenExamSession; passedAt?: string; v: string }
    >;
    badges: AcademyBadge[];
}

/** What the browser may write (everything else in a patch is ignored by the server). */
export interface ProgressPatch {
    activeTrack?: TrackId;
    guideRead?: AcademyProgress["guideRead"];
    lessons?: AcademyProgress["lessons"];
    labs?: AcademyProgress["labs"];
}

export interface ProgressEnvelope {
    progress: AcademyProgress;
    rev: number;
}

export interface PutProgressBody {
    baseRev: number;
    patch: ProgressPatch;
}

// ---------------------------------------------------------------------------------------
// Exams (graded and recorded ONLY by core-back)
// ---------------------------------------------------------------------------------------

export type EligibilityMissingKind =
    | "foundation_badge"
    | "foundation_expired"
    | "lesson"
    | "lab"
    | "lab_critical"
    | "cooldown"
    | "review_lesson"
    | "open_session";

export interface EligibilityMissing {
    kind: EligibilityMissingKind;
    id: string;
    /** Plain-English sentence for the learner ("Complete lesson …"). */
    text: string;
}

export interface Eligibility {
    eligible: boolean;
    missing: EligibilityMissing[];
    cooldownUntil?: string;
    /** Modules (ids) whose lessons must be re-opened after three consecutive failures. */
    reviewRequired?: string[];
}

export interface ExamStartBody {
    /** Must be true; the server records `integrityAcceptedAt` (spec III-H integrity statement). */
    integrityAccepted: true;
}

/** No `correct`, no `critical`, no explanation: the browser never sees the key before submit. */
export interface ExamQuestionPublic {
    qid: string;
    type: QType;
    stem: string;
    options: { oid: string; text: string }[];
}

export interface ExamStartResponse {
    examId: string;
    sessionId: string;
    startedAt: string;
    expiresAt: string;
    questionCount: number;
    /** True when the caller re-opened an existing unexpired session (same questions). */
    resumed: boolean;
    questions: ExamQuestionPublic[];
}

/** single/truefalse: option id · multi: option ids · order: option ids in the chosen sequence · number: decimal string. */
export type ExamAnswer = string | string[];

export interface ExamSubmitBody {
    sessionId: string;
    answers: Record<string, ExamAnswer>;
}

export interface ExamResultItem {
    qid: string;
    module: string;
    type: QType;
    stem: string;
    critical: boolean;
    correct: boolean;
    answered: boolean;
    why: string;
    refs: string[];
    /** single / multi / truefalse */
    options?: { oid: string; text: string; correct: boolean; selected: boolean; note?: string }[];
    /** order */
    order?: { items: { oid: string; text: string }[]; yourOrder: string[]; correctOrder: string[] };
    /** number */
    number?: { yourAnswer?: string; correctAnswer: string; tolerance?: string };
}

export interface ExamResult {
    examId: string;
    track: TrackId;
    attemptNumber: number;
    passed: boolean;
    scorePercent: number;
    passPercent: number;
    criticalMissed: number;
    moduleScores: Record<string, number>;
    durationSeconds: number;
    /** True when the submit arrived after the grace period and was scored 0. */
    expired: boolean;
    items: ExamResultItem[];
    /** Modules (ids) below 70 %. */
    reviewRequired: string[];
    badge?: AcademyBadge;
    cooldownUntil?: string;
}

// ---------------------------------------------------------------------------------------
// Team view (SECURITY_ADMIN only)
// ---------------------------------------------------------------------------------------

export type TeamStatus =
    | "NOT_STARTED"
    | "IN_PROGRESS"
    | "EXAM_READY"
    | "CERTIFIED"
    | "EXPIRING_SOON"
    | "RECERTIFICATION_REQUIRED";

export interface TeamRow {
    userId: string;
    email: string;
    name: string;
    role: string;
    isMaker: boolean;
    isChecker: boolean;
    /** The user's own role track plus Foundation. */
    requiredTracks: TrackId[];
    activeTrack: TrackId | null;
    lessonsCompleted: number;
    lessonsRequired: number;
    labsPassed: number;
    labsRequired: number;
    badges: { id: string; track: TrackId; expiresAt: string; expired: boolean }[];
    lastActivityAt: string | null;
    status: TeamStatus;
}

export interface TeamResponse {
    generatedAt: string;
    contentVersion: string;
    rows: TeamRow[];
}
