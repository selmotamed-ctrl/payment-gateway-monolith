import type {
    AttemptStateRow,
    AttemptTransitionsData,
    AttemptTransition,
} from "@/content/types";

export interface AttemptSnapshot extends AttemptStateRow {
    stateId: string;
}

export interface AttemptStepResult {
    event: AttemptTransition;
    state: AttemptSnapshot;
    note?: string;
    unchanged: boolean;
    error?: string;
}

export const attemptStateById = (
    data: AttemptTransitionsData,
    stateId: string,
): AttemptStateRow | undefined => data.states.find((state) => state.id === stateId);

export const availableEvents = (
    data: AttemptTransitionsData,
    stateId: string,
): AttemptTransition[] => data.events.filter((event) => event.from.includes(stateId));

export const applyAttemptEvent = (
    data: AttemptTransitionsData,
    stateId: string,
    eventId: string,
): AttemptStepResult | undefined => {
    const event = data.events.find((entry) => entry.id === eventId);
    if (!event) return undefined;
    if (!event.from.includes(stateId)) {
        const state = attemptStateById(data, stateId);
        return state
            ? {
                  event,
                  state: { ...state, stateId: state.id },
                  note: event.note,
                  unchanged: true,
                  error: `This event is not possible from ${stateId}.`,
              }
            : undefined;
    }
    const nextId = event.to === "SAME" ? stateId : event.to;
    const state = attemptStateById(data, nextId);
    if (!state) return undefined;
    return {
        event,
        state: { ...state, stateId: state.id },
        note: event.note,
        unchanged: nextId === stateId,
    };
};

export const reachableStateIds = (data: AttemptTransitionsData): Set<string> => {
    const reachable = new Set<string>([data.initial]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const event of data.events) {
            if (event.from.some((state) => reachable.has(state)) && event.to !== "SAME") {
                if (!reachable.has(event.to)) {
                    reachable.add(event.to);
                    changed = true;
                }
            }
        }
    }
    return reachable;
};

export const attemptStateLabel = (state: AttemptStateRow): string => state.id;

export const runAttemptPath = (
    data: AttemptTransitionsData,
    eventIds: string[],
): AttemptStepResult[] => {
    const results: AttemptStepResult[] = [];
    let state = data.initial;
    for (const eventId of eventIds) {
        const result = applyAttemptEvent(data, state, eventId);
        if (!result) break;
        results.push(result);
        state = result.state.stateId;
    }
    return results;
};
