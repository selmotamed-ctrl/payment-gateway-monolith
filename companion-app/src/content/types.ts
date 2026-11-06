export type Role =
    | "GATEWAY_ADMIN"
    | "SECURITY_ADMIN"
    | "FINANCE"
    | "OPERATOR"
    | "COMPLIANCE"
    | "MLRO"
    | "SUPPORT";

export type UiStatus = "AVAILABLE" | "PARTIAL" | "NOT_YET";

export interface Book {
    id: string;
    title: string;
    audience: string;
    summary: string;
}

export interface ArticleHeading {
    id: string;
    text: string;
    level: number;
}

export interface Article {
    id: string;
    book: number;
    order: number;
    title: string;
    roles: "ALL" | Role[];
    minutes: number;
    ui: UiStatus;
    related: string[];
    body: string;
    headings: ArticleHeading[];
    plainText: string;
}

export interface Term {
    slug: string;
    term: string;
    aliases: string[];
    ar?: string;
    related: string[];
    short: string;
}

export interface Card {
    id: string;
    title: string;
    screen: string;
    risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    irreversible: boolean;
    body: string;
    checklist: string[];
}

export interface Situation {
    id: string;
    title: string;
    screens: string[];
    cases: number[];
    articles: string[];
    body: string;
}

export interface EdgeCase {
    n: number;
    group: string;
    groupName: string;
    scenario: string;
    resolution: string;
    severity: "Low" | "Med" | "High";
}

export interface ErrorCode {
    code: string;
    where: string;
    meaning: string;
    action: string;
}

export interface ReadingPath {
    role: "ALL" | Role;
    title: string;
    articles: string[];
}

export interface QuickAnswer {
    id: string;
    article: string;
    question: string;
    answer: string;
}

export interface GuideMeta {
    contentVersion: string;
    generatedAt: string;
    counts: Record<string, number>;
    sourceSha256: string;
}

export interface LedgerEventLine {
    account: string;
    side: "DR" | "CR";
    amount: string;
    why: string;
}

export interface LedgerEventEntry {
    label: string;
    lines: LedgerEventLine[];
}

export interface LedgerEvent {
    id: string;
    title: string;
    entries: LedgerEventEntry[];
    showBalance?: { label: string; expr: string };
}

export interface LedgerData {
    defaults: Record<string, string>;
    derived: Record<string, string>;
    accounts: { id: string; class: string; normal: string }[];
    equation: string;
    events: LedgerEvent[];
}

export interface VisibleRailsRoute {
    id: string;
    status: string;
    health: string;
    min: string;
    max: string;
    dailyCap: string;
    dailyProcessed: string;
    maintenance: { from: string; to: string }[];
    scopeOk: boolean;
    credential: string;
}

export interface VisibleRailsRail {
    code: string;
    name: string;
    currency: string;
    blocked: boolean;
    commissionProfile: boolean;
    routes: VisibleRailsRoute[];
}

export interface VisibleRailsData {
    evaluationOrder: string[];
    predicates: { n: number; id: string; fails: string }[];
    rule: string;
    defaults: {
        amount: string;
        currency: string;
        applicationWhitelist: string[] | null;
        linkWhitelist: string[] | null;
        timeOfDay: string;
    };
    rails: VisibleRailsRail[];
    vectors: {
        id: string;
        input: Record<string, unknown>;
        expected: Record<string, string>;
    }[];
}

export interface AttemptStateRow {
    id: string;
    slot: string;
    money: string;
    human: string;
}

export interface AttemptTransition {
    id: string;
    label: string;
    from: string[];
    to: string;
    note?: string;
}

export interface AttemptTransitionsData {
    initial: string;
    states: AttemptStateRow[];
    events: AttemptTransition[];
}

export interface GuideData {
    "ledger-events": LedgerData;
    "visible-rails": VisibleRailsData;
    "attempt-transitions": AttemptTransitionsData;
}

export type TrackId =
    | "FOUNDATION"
    | "OPERATOR"
    | "SUPPORT"
    | "FINANCE"
    | "COMPLIANCE"
    | "MLRO"
    | "GATEWAY_ADMIN"
    | "SECURITY_ADMIN";

export const TRACK_ORDER: readonly TrackId[] = [
    "FOUNDATION",
    "OPERATOR",
    "SUPPORT",
    "FINANCE",
    "COMPLIANCE",
    "MLRO",
    "GATEWAY_ADMIN",
    "SECURITY_ADMIN",
];

export interface AcademyMeta {
    contentVersion: string;
    recertifyFrom: string;
    generatedAt: string;
    contentHash: string;
    counts: Record<string, number>;
}

export interface Track {
    id: TrackId;
    title: string;
    badge: string;
    hours: string;
    requires: TrackId[];
    description: string;
    moduleIds: string[];
    lessonIds: string[];
    labIds: string[];
    examId: string;
}

export interface Module {
    id: string;
    title: string;
    minutes: number;
    objective: string;
    lessonIds: string[];
    labIds: string[];
}

export interface Lesson {
    id: string;
    module: string;
    order: number;
    title: string;
    minutes: number;
    tracks: string[];
    reading: string[];
    body: string;
    html: string;
    plainText: string;
    checkIds: string[];
}

export type QType = "single" | "multi" | "order" | "number" | "truefalse";

export interface QOption {
    id: string;
    text: string;
    correct?: boolean;
    note?: string;
}

export interface Question {
    id: string;
    module: string;
    type: QType;
    difficulty: 1 | 2 | 3;
    critical: boolean;
    lesson?: string;
    refs: string[];
    stem: string;
    options: QOption[];
    answer?: string;
    tolerance?: string;
    why?: string;
}

export interface ExamBlueprintPublic {
    id: string;
    track: TrackId;
    questionCount: number;
    passPercent: number;
    timeLimitMinutes: number;
    cooldownMinutes: number;
    composition: { module: string; count: number }[];
}

export type Panel = { title: string } & (
    | { rows: [string, string][] }
    | { table: { columns: string[]; rows: string[][] } }
    | { timeline: { t: string; text: string; flag?: "warn" | "ok" | "bad" }[] }
    | { text: string }
    | Record<string, never>
);

interface TaskBase {
    id: string;
    title: string;
    panels: Panel[];
    prompt: string;
    points: number;
    hint?: string;
    refs?: string[];
}

export interface ChoiceTask extends TaskBase {
    kind: "choice";
    options: { id: string; label: string; correct: boolean; critical?: boolean; feedback: string }[];
}

export interface MultiTask extends TaskBase {
    kind: "multi";
    options: { id: string; label: string; correct: boolean; feedback: string }[];
    criticalWrong?: string[];
}

export interface LedgerTask extends TaskBase {
    kind: "ledger";
    accounts: string[];
    expected: { account: string; side: "DR" | "CR"; amount: string }[];
    feedback: string;
}

export interface OrderTask extends TaskBase {
    kind: "order";
    items: { id: string; label: string }[];
    correctOrder: string[];
    feedback: string;
}

export interface ChecklistTask extends TaskBase {
    kind: "checklist";
    items: { id: string; label: string; shouldTick: boolean; why: string }[];
    criticalWrong?: string[];
}

export interface NumericTask extends TaskBase {
    kind: "numeric";
    answer: string;
    tolerance: string;
    unit?: string;
    feedback: string;
}

export type LabTask = ChoiceTask | MultiTask | LedgerTask | OrderTask | ChecklistTask | NumericTask;

export interface Lab {
    id: string;
    module: string;
    title: string;
    minutes: number;
    tracks: string[];
    refs: string[];
    briefing: string;
    passPercent: number;
    tasks: LabTask[];
}

export interface Drill {
    id: string;
    title: string;
    rail: string;
    minutes: number;
    refs: string[];
    markdown: string;
    html: string;
    plainText: string;
}

export interface AcademyPage {
    id: string;
    title: string;
    markdown: string;
    html: string;
    plainText: string;
}

export interface CompanionManifest {
    schema: number;
    appId: string;
    contentVersion: string;
    contentHash: string;
    bundleSha256: string;
    bundleBytes: number;
    guideSourceSha256: string;
    academyContentHash: string;
    generatedAt: string;
    counts: Record<string, number>;
    bundlePath: string;
}

export interface CompanionBundle {
    schema: number;
    meta: CompanionManifest & {
        counts: Record<string, number>;
    };
    guide: {
        books: Book[];
        articles: Article[];
        glossary: Term[];
        cards: Card[];
        playbook: Situation[];
        paths: ReadingPath[];
        faq: QuickAnswer[];
        data: GuideData;
        errorCodes: ErrorCode[];
        edgeCases: EdgeCase[];
    };
    academy: {
        meta: AcademyMeta;
        tracks: Track[];
        modules: Module[];
        lessons: Lesson[];
        checks: Question[];
        labs: Lab[];
        drills: Drill[];
        pages: AcademyPage[];
        examBlueprints: ExamBlueprintPublic[];
    };
}
