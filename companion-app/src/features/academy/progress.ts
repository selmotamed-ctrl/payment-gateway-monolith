import type { Track } from "@/content/types";
import type { CompanionData } from "@/lib/data";

export interface TrackStats {
    lessonsTotal: number;
    lessonsDone: number;
    labsTotal: number;
    labsPassed: number;
    lessonsPercent: number;
    labsPercent: number;
}

export const trackStats = (track: Track, data: CompanionData): TrackStats => {
    const lessonsDone = track.lessonIds.filter((id) => Boolean(data.lessons[id])).length;
    const labsPassed = track.labIds.filter((id) => Boolean(data.labs[id]?.passedAt)).length;
    return {
        lessonsTotal: track.lessonIds.length,
        lessonsDone,
        labsTotal: track.labIds.length,
        labsPassed,
        lessonsPercent: track.lessonIds.length ? Math.round((lessonsDone / track.lessonIds.length) * 100) : 100,
        labsPercent: track.labIds.length ? Math.round((labsPassed / track.labIds.length) * 100) : 100,
    };
};

export type NextStep =
    | { kind: "lesson"; id: string; moduleId: string }
    | { kind: "lab"; id: string; moduleId: string }
    | { kind: "exam"; id: string };

export const nextTrackStep = (
    track: Track,
    modules: { id: string; lessonIds: string[]; labIds: string[] }[],
    data: CompanionData,
): NextStep => {
    for (const lessonId of track.lessonIds) {
        if (!data.lessons[lessonId]) {
            const module = modules.find((entry) => entry.lessonIds.includes(lessonId));
            return { kind: "lesson", id: lessonId, moduleId: module?.id ?? "" };
        }
    }
    for (const labId of track.labIds) {
        if (!data.labs[labId]?.passedAt) {
            const module = modules.find((entry) => entry.labIds.includes(labId));
            return { kind: "lab", id: labId, moduleId: module?.id ?? "" };
        }
    }
    return { kind: "exam", id: track.examId };
};

export const nextStepTitle = (
    step: NextStep,
    lessons: { id: string; title: string }[],
    labs: { id: string; title: string }[],
): string => {
    if (step.kind === "lesson") return lessons.find((lesson) => lesson.id === step.id)?.title ?? step.id;
    if (step.kind === "lab") return labs.find((lab) => lab.id === step.id)?.title ?? step.id;
    return "Practice exam";
};
