/**
 * Employee Academy types. The public shapes mirror
 * `admin-front/src/content/academy/apiTypes.ts` EXACTLY (change both together); the server-only
 * shapes (`_server` state, exam bank, catalog) never leave core-back.
 */

export type TrackId =
  | "FOUNDATION"
  | "OPERATOR"
  | "SUPPORT"
  | "FINANCE"
  | "COMPLIANCE"
  | "MLRO"
  | "GATEWAY_ADMIN"
  | "SECURITY_ADMIN";

export type QType = "single" | "multi" | "order" | "number" | "truefalse";

// ---- Public contract (mirror of apiTypes.ts) -------------------------------------------

export interface ExamAttemptSummary {
  at: string;
  scorePercent: number;
  passed: boolean;
  criticalMissed: number;
  moduleScores: Record<string, number>;
  durationSeconds: number;
}

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
  text: string;
}

export interface Eligibility {
  eligible: boolean;
  missing: EligibilityMissing[];
  cooldownUntil?: string;
  reviewRequired?: string[];
}

export interface ExamStartBody {
  integrityAccepted: true;
}

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
  resumed: boolean;
  questions: ExamQuestionPublic[];
}

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
  options?: { oid: string; text: string; correct: boolean; selected: boolean; note?: string }[];
  order?: { items: { oid: string; text: string }[]; yourOrder: string[]; correctOrder: string[] };
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
  expired: boolean;
  items: ExamResultItem[];
  reviewRequired: string[];
  badge?: AcademyBadge;
  cooldownUntil?: string;
}

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

// ---- Server-only ------------------------------------------------------------------------

/** One question inside an open session: ids in DISPLAY order; `oid` is the opaque per-session id. */
export interface OpenQuestionState {
  qid: string;
  opts: { oid: string; id: string }[];
}

export interface OpenExamServerState {
  sessionId: string;
  attemptNumber: number;
  startedAt: string;
  expiresAt: string;
  questions: OpenQuestionState[];
}

/** Reserved key `_server` inside the stored JSON. NEVER returned by any endpoint. */
export interface ServerState {
  open: Record<string, OpenExamServerState>;
  /** Question ids of the previous attempt per exam ("prefer unseen"). */
  lastQids: Record<string, string[]>;
  /** Total recorded attempts per exam (the public `attempts` array is capped at 20). */
  attemptCount: Record<string, number>;
  /** Last session ids already submitted per exam (to answer "already used"). */
  used: Record<string, string[]>;
}

export type StoredProgress = AcademyProgress & { _server: ServerState };

export interface BankOption {
  id: string;
  text: string;
  correct?: boolean;
  note?: string;
}

export interface BankQuestion {
  id: string;
  module: string;
  type: QType;
  difficulty: number;
  critical: boolean;
  tracks: string[];
  refs: string[];
  stem: string;
  options: BankOption[];
  answer?: string;
  tolerance?: string;
  why: string;
}

export interface ExamBlueprint {
  id: string;
  track: TrackId;
  questionCount: number;
  passPercent: number;
  timeLimitMinutes: number;
  composition: { module: string; count: number }[];
  criticalPick: number;
  cooldownMinutes: number;
}

export interface ExamBank {
  contentVersion: string;
  blueprints: ExamBlueprint[];
  questions: BankQuestion[];
}

export interface CatalogTrack {
  id: TrackId;
  badge: string;
  requires: TrackId[];
  moduleIds: string[];
  lessonIds: string[];
  labIds: string[];
  examId: string;
}

export interface Catalog {
  contentVersion: string;
  recertifyFrom: string;
  tracks: CatalogTrack[];
  modules: { id: string; title: string; lessonIds: string[]; labIds: string[] }[];
  lessons: { id: string; module: string; title: string }[];
  labs: { id: string; module: string; title: string; passPercent: number }[];
}

/** Persistence port: the router wires it to Prisma `client.user`. */
export interface AcademyStore {
  /** `null` when the user does not exist. `version` is an opaque compare-and-swap token. */
  load(userId: string): Promise<{ json: unknown; version: unknown } | null>;
  /** Writes only if the row still has `version`; returns false when it lost the race. */
  save(userId: string, json: unknown, version: unknown): Promise<boolean>;
}

export interface AcademyContext {
  now: () => Date;
  /** Opaque ids (8 hex chars). */
  randomId: () => string;
  /** Session id generator. */
  sessionId: () => string;
}

export interface AcademyEvent {
  action: string;
  afterJson: Record<string, unknown>;
}

export interface Outcome<T> {
  value: T;
  events: AcademyEvent[];
}
