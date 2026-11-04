/** Pure learner-path logic (no Vue). Order: lesson, then its module's labs, module by module, then the exam. */
import type { Lab, Lesson, Module, Track, TrackId } from "@/content/academy";
import type { AcademyProgress, Eligibility, EligibilityMissing } from "@/content/academy/apiTypes";

export type NextStepKind = "lesson" | "lab" | "exam" | "done";

export interface NextStepRoute {
    name: "AdminAcademyLesson" | "AdminAcademyLab" | "AdminAcademyExam" | "AdminAcademyTrack";
    params: Record<string, string>;
}

export interface NextStep {
    kind: NextStepKind;
    /** Lesson id, lab id, exam id or track id (for `done`). */
    id: string;
    /** Module the step belongs to (lessons/labs). */
    moduleId?: string;
    route: NextStepRoute;
    /** Exam step only: true when the server (or the client fallback) says it is not yet available. */
    locked?: boolean;
}

export interface NextStepInput {
    track: Track;
    modules: Module[];
    lessons: Lesson[];
    labs: Lab[];
    progress: AcademyProgress;
    /** Server eligibility for the track's exam; null/undefined when unknown. */
    eligibility?: Eligibility | null;
}

export interface TrackStats {
    lessonsDone: number;
    lessonsTotal: number;
    labsPassed: number;
    labsTotal: number;
    examPassed: boolean;
}

const trackModules = (track: Track, modules: Module[]): Module[] =>
    track.moduleIds.map((id) => modules.find((module) => module.id === id)).filter((m): m is Module => Boolean(m));

export const trackStats = (track: Track, progress: AcademyProgress): TrackStats => ({
    lessonsDone: track.lessonIds.filter((id) => progress.lessons[id]).length,
    lessonsTotal: track.lessonIds.length,
    labsPassed: track.labIds.filter((id) => progress.labs[id]?.passedAt).length,
    labsTotal: track.labIds.length,
    examPassed: Boolean(progress.exams[track.examId]?.passedAt),
});

export const nextStep = ({ track, modules, progress, eligibility }: NextStepInput): NextStep => {
    const lessonSet = new Set(track.lessonIds);
    const labSet = new Set(track.labIds);
    for (const module of trackModules(track, modules)) {
        for (const lessonId of module.lessonIds) {
            if (lessonSet.has(lessonId) && !progress.lessons[lessonId]) {
                return { kind: "lesson", id: lessonId, moduleId: module.id, route: { name: "AdminAcademyLesson", params: { lessonId } } };
            }
        }
        for (const labId of module.labIds) {
            if (labSet.has(labId) && !progress.labs[labId]?.passedAt) {
                return { kind: "lab", id: labId, moduleId: module.id, route: { name: "AdminAcademyLab", params: { labId } } };
            }
        }
    }
    // Lessons/labs not attached to a listed module (defensive).
    for (const lessonId of track.lessonIds) {
        if (!progress.lessons[lessonId]) {
            return { kind: "lesson", id: lessonId, route: { name: "AdminAcademyLesson", params: { lessonId } } };
        }
    }
    for (const labId of track.labIds) {
        if (!progress.labs[labId]?.passedAt) {
            return { kind: "lab", id: labId, route: { name: "AdminAcademyLab", params: { labId } } };
        }
    }
    if (progress.exams[track.examId]?.passedAt) {
        return { kind: "done", id: track.id, route: { name: "AdminAcademyTrack", params: { trackId: track.id } } };
    }
    const locked = Boolean(eligibility && !eligibility.eligible);
    return {
        kind: "exam",
        id: track.examId,
        locked,
        route: locked
            ? { name: "AdminAcademyTrack", params: { trackId: track.id } }
            : { name: "AdminAcademyExam", params: { examId: track.examId } },
    };
};

/** Client-side prerequisites list for when the eligibility endpoint is unreachable. */
export const fallbackMissing = (
    track: Track,
    lessons: Lesson[],
    labs: Lab[],
    progress: AcademyProgress,
    fmt: { lesson: (title: string) => string; lab: (title: string) => string },
): EligibilityMissing[] => {
    const out: EligibilityMissing[] = [];
    for (const id of track.lessonIds) {
        if (progress.lessons[id]) continue;
        out.push({ kind: "lesson", id, text: fmt.lesson(lessons.find((l) => l.id === id)?.title ?? id) });
    }
    for (const id of track.labIds) {
        if (progress.labs[id]?.passedAt) continue;
        out.push({ kind: "lab", id, text: fmt.lab(labs.find((l) => l.id === id)?.title ?? id) });
    }
    return out;
};

/** Default active track: the first of FOUNDATION and the role track whose badge is missing/expired. */
export const pickActiveTrack = (
    progress: AcademyProgress,
    roleTrack: TrackId | null,
    badgeState: (track: TrackId) => string,
): TrackId => {
    if (progress.activeTrack) return progress.activeTrack;
    const required: TrackId[] = roleTrack ? ["FOUNDATION", roleTrack] : ["FOUNDATION"];
    const open = required.find((id) => {
        const state = badgeState(id);
        return state === "none" || state === "expired" || state === "recertify";
    });
    return open ?? roleTrack ?? "FOUNDATION";
};
